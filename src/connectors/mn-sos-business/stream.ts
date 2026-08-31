/**
 * Streaming parse session for a Minnesota SOS bulk delivery.
 *
 * The delivered CSV may exceed 2.5 GB uncompressed and contains roughly a
 * million businesses spread over many millions of rows. Two facts make the naive
 * approach impossible and shape everything here:
 *
 *  1. **One business spans several rows** — a master, its filings, its names and
 *     addresses — so records cannot be emitted row by row.
 *  2. **The guide never promises the rows are grouped or sorted.** Assuming
 *     adjacency would produce a different estate for the same bytes depending on
 *     how the publisher happened to order the export.
 *
 * So rows are spilled to a disk-backed external sort keyed by Master ID and read
 * back as complete groups. Peak memory is one chunk of the sort plus one
 * business, never the register. This is the DF-0D machinery unchanged, and it
 * buys order-independence for free: any permutation of the input file yields
 * byte-identical canonical output.
 *
 * Bad rows are never dropped. A row that cannot be parsed, a filing whose master
 * is missing, and a Master ID that appears twice all become **quarantined
 * records** with a stated reason, so the run report accounts for every row in
 * the delivery.
 */
import { readCsvFromLines } from '../../core/csv.ts';
import { fail, FabricError } from '../../core/errors.ts';
import { externalSort, groupSorted, type SortOptions } from '../../core/external-sort.ts';
import { contentDigest, MultisetDigest, sha256 } from '../../core/hash.ts';
import type {
  StreamSummary,
  StreamedRecord,
  StreamingParseSession,
} from '../../runtime/connector.ts';
import type { ValidationIssue } from '../../schema/xsd.ts';
import { addressType, businessType, layoutSignature, partyNameType } from './domain.ts';
import { parseSosRow, type SosRow } from './parse.ts';
import {
  SOS_DELIVERY_KIND,
  type SosDeliveryManifest,
  type SosEntityRecord,
  type SosFilingFields,
  type SosMasterFields,
  type SosNameAddressFields,
} from './record.ts';
import { sosFieldGroups } from './normalize.ts';

/**
 * Rows whose Master ID could not be read sort here, after every GUID, one group
 * each. A GUID cannot contain U+FFFF, so a real record can never land in this
 * range.
 */
const MALFORMED_PREFIX = '￿malformed￿';

/** Unknown domain codes retained for the report. Bounded so a broken file cannot grow it without limit. */
const MAX_REPORTED_UNKNOWN_CODES = 200;

export type SosStreamOptions = {
  readonly schemaVersion: string;
  /** Digest of the pinned column layout and vocabularies. Drift is checked against it. */
  readonly pinnedLayoutDigest: string;
  /** Implementation-guide version this connector was written against. */
  readonly pinnedGuideVersion: string;
  readonly sort?: SortOptions;
};

export type SosStreamSession = StreamingParseSession & {
  readonly manifest: SosDeliveryManifest;
};

export async function openSosStream(
  lines: AsyncIterable<string>,
  options: SosStreamOptions,
): Promise<SosStreamSession> {
  const iterator = lines[Symbol.asyncIterator]();

  const first = await iterator.next();
  if (first.done) fail('PARSE', 'SOS delivery bundle is empty');

  let manifest: SosDeliveryManifest;
  try {
    manifest = JSON.parse(first.value) as SosDeliveryManifest;
  } catch (e) {
    return fail('PARSE', `SOS delivery manifest is not JSON: ${(e as Error).message}`);
  }
  if (manifest.kind !== SOS_DELIVERY_KIND) {
    fail('PARSE', `unexpected delivery kind "${String(manifest.kind)}"`);
  }

  // Drift is decided from the manifest before a single row is read. A register
  // whose layout moved must not be streamed through a parser that reads columns
  // by position.
  const earlyDriftReasons = manifestDrift(manifest, options);

  const unknownCodes = new Set<string>();
  const recordTypeCounts: Record<string, number> = { master: 0, filing: 0, name_address: 0 };
  let malformedRows = 0;
  let orphanGroups = 0;
  let duplicateMasters = 0;
  let entityCount = 0;
  let rowCount = 0;
  let exhausted = false;

  /** The remaining lines of the bundle, i.e. the CSV itself. */
  async function* body(): AsyncGenerator<string> {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  /**
   * One CSV row as a sortable line.
   *
   * `m` is written first so the sort key can be extracted with an index scan
   * rather than a JSON parse of every one of tens of millions of lines.
   */
  async function* sortableRows(): AsyncGenerator<string> {
    for await (const { cells, rowNumber } of readCsvFromLines(body())) {
      rowCount += 1;
      // The raw text is not carried through the sort — a 2.5 GB spill would
      // become 5 GB. Its digest is, which is what provenance actually needs.
      const rawDigest = sha256(cells.join(''));

      let row: SosRow;
      try {
        row = parseSosRow(cells, `row ${rowNumber}`);
      } catch (e) {
        malformedRows += 1;
        const reason = e instanceof FabricError ? e.message : String(e);
        yield JSON.stringify({
          m: `${MALFORMED_PREFIX}${String(rowNumber).padStart(12, '0')}`,
          t: 'malformed', n: rowNumber, h: rawDigest, reason,
        });
        continue;
      }

      recordTypeCounts[row.kind] = (recordTypeCounts[row.kind] ?? 0) + 1;
      noteUnknownCodes(row, unknownCodes);
      yield JSON.stringify({ m: row.masterId, t: row.kind, n: rowNumber, h: rawDigest, r: row });
    }
  }

  async function* records(): AsyncGenerator<StreamedRecord> {
    const sorted = externalSort(sortableRows(), keyOfMaster, options.sort ?? {});
    const groups = groupSorted(sorted, keyOfMaster, (line) => JSON.parse(line) as StoredRow);

    for await (const { key, items } of groups) {
      if (key.startsWith(MALFORMED_PREFIX)) {
        const bad = items[0] as StoredRow;
        yield quarantined(
          `malformed-row:${bad.n}`,
          { rowNumber: bad.n, reason: bad.reason ?? 'unparseable row' },
          bad.h,
          [{ code: 'type_violation', path: `row[${bad.n}]`, message: bad.reason ?? 'unparseable row' }],
        );
        continue;
      }

      const masters = items.filter((i) => i.t === 'master');
      const rawDigest = new MultisetDigest();
      for (const i of items) rawDigest.addDigest(i.h);

      if (masters.length === 0) {
        // A filing or a name row whose master is absent. Attaching it to a guess
        // would fabricate a corporate history, and dropping it would hide an
        // incomplete delivery, so it is quarantined and counted.
        orphanGroups += 1;
        yield quarantined(
          key,
          { masterId: key, orphanRows: items.length, rowNumbers: items.map((i) => i.n).sort((a, b) => a - b) },
          rawDigest.value(),
          [{
            code: 'missing_element',
            path: `master[${key}]`,
            message: `${items.length} row(s) reference a Master ID with no master record in this delivery`,
          }],
        );
        continue;
      }

      if (masters.length > 1) {
        // The guide states a Master ID is unique and never recycled. Two master
        // rows means the delivery contradicts its own documentation; picking one
        // would be arbitrary.
        duplicateMasters += 1;
        yield quarantined(
          key,
          { masterId: key, masterRowCount: masters.length },
          rawDigest.value(),
          [{
            code: 'cardinality',
            path: `master[${key}]`,
            message: `Master ID appears on ${masters.length} master records; the guide states it is unique`,
          }],
        );
        continue;
      }

      const record = assemble(key, items);
      entityCount += 1;
      yield {
        parsed: {
          sourceRecordId: key,
          record: record as unknown as Readonly<Record<string, unknown>>,
          contentDigest: contentDigest(record),
          rawFragmentDigest: rawDigest.value(),
          fieldGroupDigests: sosFieldGroups(record),
        },
        issues: [],
      };
    }

    exhausted = true;
  }

  return {
    manifest,
    schemaVersion: options.schemaVersion,
    schemaDigest: options.pinnedLayoutDigest,
    earlyDriftReasons,
    records,
    finish(): StreamSummary {
      if (!exhausted) fail('PARSE', 'finish() called before the SOS row stream was exhausted');
      return {
        driftReasons: [],
        unknownFields: [...unknownCodes].sort().slice(0, MAX_REPORTED_UNKNOWN_CODES),
        missingFields: [],
        snapshot: {
          // The delivery states no record count of its own; the register does
          // not publish a denominator. Claiming one would be an invention.
          sourceReportedCount: null,
          retrievedCount: entityCount,
          duplicateCount: duplicateMasters,
          sourceSchemaDigest: options.pinnedLayoutDigest,
          sourceChangedDuringRead: false,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------

type StoredRow = {
  readonly m: string;
  readonly t: 'master' | 'filing' | 'name_address' | 'malformed';
  readonly n: number;
  readonly h: string;
  readonly r?: SosRow;
  readonly reason?: string;
};

/** Index scan for the sort key. `m` is the first member of every stored row. */
function keyOfMaster(line: string): string {
  const at = line.indexOf('"m":"');
  if (at === -1) return '';
  const from = at + 5;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}

function assemble(masterId: string, items: readonly StoredRow[]): SosEntityRecord {
  let master: SosMasterFields | null = null;
  const filings: SosFilingFields[] = [];
  const names: SosNameAddressFields[] = [];

  for (const item of items) {
    const row = item.r;
    if (row === undefined) continue;
    if (row.kind === 'master') {
      master = {
        businessTypeCode: row.businessTypeCode,
        originalFilingNumber: row.originalFilingNumber,
        minnesotaBusinessName: row.minnesotaBusinessName,
        businessFilingStatus: row.businessFilingStatus,
        filingDate: row.filingDate,
        expirationDate: row.expirationDate,
        nextRenewalDueDate: row.nextRenewalDueDate,
        homeJurisdiction: row.homeJurisdiction,
        governingStatute: row.governingStatute,
        isLlcNonProfit: row.isLlcNonProfit,
        isLllp: row.isLllp,
        isProfessional: row.isProfessional,
        homeBusinessName: row.homeBusinessName,
        numberOfShares: row.numberOfShares,
        businessMarkType: row.businessMarkType,
        markFirstUseDate: row.markFirstUseDate,
        markClassificationNumber: row.markClassificationNumber,
        exportDate: row.exportDate,
      };
    } else if (row.kind === 'filing') {
      filings.push({
        filingNumber: row.filingNumber,
        filingActionRaw: row.filingActionRaw,
        filingRank: row.filingRank,
        filingDate: row.filingDate,
        effectiveDate: row.effectiveDate,
      });
    } else {
      names.push({
        filingNumber: row.filingNumber,
        nameTypeCode: row.nameTypeCode,
        addressTypeCode: row.addressTypeCode,
        partyName: row.partyName,
        streetAddressLine1: row.streetAddressLine1,
        streetAddressLine2: row.streetAddressLine2,
        cityName: row.cityName,
        regionCode: row.regionCode,
        postalCode: row.postalCode,
        postalCodeExtension: row.postalCodeExtension,
        countryName: row.countryName,
      });
    }
  }

  // Sorted so the assembled record depends on the delivery's *content*, not on
  // the order the publisher happened to write the rows in. Without this, the
  // same register would produce different digests on two exports.
  filings.sort(compareFilings);
  names.sort(compareNames);

  return { masterId, master, filings, names };
}

function compareFilings(a: SosFilingFields, b: SosFilingFields): number {
  return cmp(
    `${a.filingNumber} ${a.filingActionRaw} ${a.filingRank} ${a.filingDate ?? ''} ${a.effectiveDate ?? ''}`,
    `${b.filingNumber} ${b.filingActionRaw} ${b.filingRank} ${b.filingDate ?? ''} ${b.effectiveDate ?? ''}`,
  );
}

function compareNames(a: SosNameAddressFields, b: SosNameAddressFields): number {
  return cmp(nameKey(a), nameKey(b));
}

function nameKey(r: SosNameAddressFields): string {
  return [
    r.nameTypeCode ?? '', r.addressTypeCode ?? '', r.partyName ?? '', r.filingNumber ?? '',
    r.streetAddressLine1 ?? '', r.streetAddressLine2 ?? '', r.cityName ?? '',
    r.regionCode ?? '', r.postalCode ?? '', r.postalCodeExtension ?? '', r.countryName ?? '',
  ].join(' ');
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function quarantined(
  sourceRecordId: string,
  record: Readonly<Record<string, unknown>>,
  rawFragmentDigest: string,
  issues: readonly ValidationIssue[],
): StreamedRecord {
  return {
    parsed: { sourceRecordId, record, contentDigest: contentDigest(record), rawFragmentDigest },
    issues,
  };
}

/**
 * Records domain codes the pinned vocabularies do not know.
 *
 * Reported, never mapped to a neighbour and never a reason to fail: Appendix II
 * is a snapshot of a live register that adds codes, and an unknown code is
 * information for the operator rather than a defect in the delivery.
 */
function noteUnknownCodes(row: SosRow, into: Set<string>): void {
  if (into.size >= MAX_REPORTED_UNKNOWN_CODES) return;
  if (businessType(row.businessTypeCode) === undefined) {
    into.add(`business_type:${row.businessTypeCode}`);
  }
  if (row.kind === 'name_address') {
    if (row.nameTypeCode !== null && partyNameType(row.nameTypeCode) === undefined) {
      into.add(`name_type:${row.nameTypeCode}`);
    }
    if (row.addressTypeCode !== null && addressType(row.addressTypeCode) === undefined) {
      into.add(`address_type:${row.addressTypeCode}`);
    }
  }
}

function manifestDrift(manifest: SosDeliveryManifest, options: SosStreamOptions): readonly string[] {
  const reasons: string[] = [];

  if (manifest.implementationGuideVersion !== options.pinnedGuideVersion) {
    reasons.push(
      `implementation guide version changed: delivery declares "${manifest.implementationGuideVersion}", `
      + `the connector is pinned to "${options.pinnedGuideVersion}"`,
    );
  }
  if (sha256(layoutSignature()) !== options.pinnedLayoutDigest) {
    reasons.push('the connector\'s own pinned layout digest does not match its column tables');
  }

  // A licence is part of the delivery's identity. Ingesting bytes whose terms
  // are unknown, or whose terms have changed, is exactly what must not happen
  // silently — so it quarantines rather than warns.
  const licence = manifest.license;
  if (!licence || typeof licence.agreementName !== 'string' || licence.agreementName === '') {
    reasons.push('the delivery manifest states no licence agreement');
  } else if (licence.mayServeCustomers !== true) {
    reasons.push(
      `the delivery's licence ("${licence.agreementName}") does not permit making records available to `
      + 'customers; activation is blocked until the terms are re-reviewed',
    );
  }

  return reasons;
}
