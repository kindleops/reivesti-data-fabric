/**
 * Hennepin County recorded-instrument connector.
 *
 * **Live retrieval status: BLOCKED_ON_SANCTIONED_ACCESS.**
 *
 * Hennepin's RecordEASE subscription agreement — the "Technology and Information
 * Subscription Agreement" a subscriber signs — states verbatim:
 *
 *   "SUBSCRIBER shall not access the Information by any means other than the
 *    Application including but not limited to scraping, robots, wanderers,
 *    crawlers, spiders, etc"
 *
 * and separately forbids redistribution of the Information. The county's own
 * land-title-records page repeats it: "Multiple parcel data downloads, screen
 * scraping programs or other computer extraction techniques are strictly
 * prohibited."
 *
 * That is not a rate limit or a technical obstacle. It is an explicit
 * contractual prohibition on exactly the access this connector would need, and
 * it applies to RecordEASE Public and RecordEASE Pro alike. Hennepin publishes
 * no recorded-document layer in its ArcGIS open data (verified: the LAND_PROPERTY
 * service exposes address points, parcels and PLS points only), and RecordEASE
 * offers no API, feed or index export.
 *
 * So this connector has **no network transport at all**. It cannot be pointed at
 * the county even by mistake: the registry records `automationStatus:
 * 'prohibited'`, and the only transport wired up reads a file an operator has
 * lawfully obtained. Everything after acquisition — parsing, the instrument
 * graph, ownership, mortgage lifecycle, convergence, replay — is complete and
 * exercised against synthetic fixtures, and will run unchanged on a lawful
 * delivery.
 *
 * The activation path is a Minn. Stat. ch. 13 data-practices request for the
 * recording index (recordsrequest@hennepin.us). See
 * docs/HENNEPIN-RECORDED-INSTRUMENTS.md.
 */
import { fail } from '../../core/errors.ts';
import { contentDigest, canonicalJson, sha256 } from '../../core/hash.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import { fieldGroupDigests } from '../../canonical/snapshot.ts';
import type {
  ChangeContext,
  Connector,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  SourceRelease,
  StreamSummary,
  StreamedRecord,
  StreamingConnector,
  StreamingParseSession,
  BatchValidation,
} from '../../runtime/connector.ts';
import { createLocalFileTransport, type Transport } from '../../runtime/transport.ts';
import type { ValidationIssue } from '../../schema/xsd.ts';
import {
  HENNEPIN_RECORDER_ADAPTER_KEY,
  HENNEPIN_RECORDER_SOURCE_ID,
} from '../../registry/sources.ts';
import {
  RECORDER_BUNDLE_KIND,
  RECORDER_TRAILER_KIND,
  type RecorderBundleHeader,
  type RecorderBundleTrailer,
  type RecorderIndexRow,
  type RecorderRecord,
} from './record.ts';
import { HENNEPIN_COUNTY_FIPS, parseRecorderRow, recorderSourceRecordId } from './parse.ts';
import { RECORDER_NORMALIZATION_VERSION, normalizeRecorderRecord } from './normalize.ts';
import { classifyDocumentType } from './taxonomy.ts';

export const RECORDER_CONNECTOR_VERSION = 'mn_hennepin_recorder_connector_1';
export const RECORDER_PARSER_VERSION = 'mn_hennepin_recorder_parser_1';
export const RECORDER_SCHEMA_VERSION = 'hennepin_recorder_index_v1';

/** The index fields this adapter is written against. */
export const EXPECTED_FIELDS: readonly string[] = [
  'documentNumber', 'registrationSystem', 'certificateOfTitleNumber', 'documentType',
  'recordedAt', 'documentDate', 'parties', 'parcelIds', 'legalDescriptions',
  'referencedDocuments', 'considerationAmount', 'principalAmount', 'maturityDate', 'bookPage',
];

export const PINNED_FIELD_SET_DIGEST = sha256([...EXPECTED_FIELDS].sort().join('\n'));

export type RecorderConnectorOptions = {
  /** An index delivery an operator has lawfully obtained. The only input. */
  readonly localFile?: string;
  readonly referencePeriod?: string;
  readonly sourceId?: string;
  /**
   * Present so the "no sanctioned transport" refusal can be exercised in tests.
   * Supplying a publisher-reaching transport is refused by the runtime, because
   * the registry records automation as prohibited.
   */
  readonly transport?: Transport;
};

export function createHennepinRecorderConnector(options: RecorderConnectorOptions = {}): StreamingConnector {
  const sourceId = options.sourceId ?? HENNEPIN_RECORDER_SOURCE_ID;
  // Deliberately not configurable to anything that reaches Hennepin. There is no
  // ArcGIS transport here and no HTTP client, because there is nothing lawful to
  // point one at.
  const transport = options.transport ?? createLocalFileTransport();

  const base: Connector = {
    adapterKey: HENNEPIN_RECORDER_ADAPTER_KEY,
    connectorVersion: RECORDER_CONNECTOR_VERSION,
    parserVersion: RECORDER_PARSER_VERSION,
    normalizationVersion: RECORDER_NORMALIZATION_VERSION,
    schemaVersion: RECORDER_SCHEMA_VERSION,
    transport,
    // A recorder index delivery is a window of an append-only series, not a
    // state of the world. A document absent from a January delivery was not
    // withdrawn; it simply was not recorded in January.
    snapshotSource: false,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      if (!options.localFile) {
        fail(
          'ACCESS_BLOCKED',
          'no lawful Hennepin recorder index delivery is available to this connector',
          {
            sourceId,
            reason:
              'RecordEASE terms prohibit programmatic access: "SUBSCRIBER shall not access the Information by '
              + 'any means other than the Application including but not limited to scraping, robots, wanderers, '
              + 'crawlers, spiders". No API, feed or index export is published.',
            remedy:
              'request the recording index under Minn. Stat. ch. 13 (recordsrequest@hennepin.us), then pass the '
              + 'delivered file as localFile',
          },
        );
      }
      const referencePeriod = options.referencePeriod ?? 'unspecified';
      return [{
        release: {
          releaseId: `${sourceId}__${referencePeriod}`,
          sourceId,
          releaseLabel: `Hennepin recorder index ${referencePeriod}`,
          referencePeriod,
          publicationAt: null,
          finality: 'unknown',
          sourceVersion: RECORDER_SCHEMA_VERSION,
        },
        request: { locator: options.localFile, filename: options.localFile.split('/').pop() ?? 'index.ndjson' },
      }];
    },

    parse(): ParsedBatch {
      return fail('CONFIG', 'the recorder connector is streaming; the runtime must call openStream');
    },
    validate(): BatchValidation {
      return fail('CONFIG', 'the recorder connector is streaming; the runtime must call openStream');
    },

    normalize(_ctx: ConnectorContext, parsed: ParsedRecord, evidence: SourceEvidence, _change: ChangeContext): NormalizeResult {
      const result = normalizeRecorderRecord(parsed.record as unknown as RecorderRecord, evidence, sourceId);
      // The instrument graph travels alongside the bundle. The runtime persists
      // these verbatim; the folds in instrument-graph.ts read them back from the
      // estate, so nothing about the graph is held in memory during ingestion.
      return {
        bundle: result.bundle,
        contacts: [],
        extraRows: {
          instruments: [result.instrument],
          instrument_parties: result.instrumentParties,
          instrument_property_links: result.propertyLinks,
          legal_descriptions: result.legalDescriptions,
          instrument_references: result.references,
          recorded_financing: result.financing,
        },
      };
    },
  };

  return {
    ...base,
    streaming: true,
    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openRecorderStream(lines, sourceId);
    },
  };
}

// ---------------------------------------------------------------------------

async function openRecorderStream(
  lines: AsyncIterable<string>,
  sourceId: string,
): Promise<StreamingParseSession> {
  const iterator = lines[Symbol.asyncIterator]();
  const firstLine = await iterator.next();
  if (firstLine.done) fail('PARSE', 'recorder index delivery is empty');

  let header: RecorderBundleHeader;
  try {
    header = JSON.parse(firstLine.value) as RecorderBundleHeader;
  } catch (e) {
    return fail('PARSE', `recorder index header is not JSON: ${(e as Error).message}`);
  }
  if (header.kind !== RECORDER_BUNDLE_KIND) {
    fail('PARSE', `unexpected delivery kind "${String(header.kind)}"`);
  }

  // Drift is checked from the header before any row is read: a delivery whose
  // declared field set has moved is quarantined rather than partly ingested.
  const earlyDriftReasons: string[] = [];
  const declared = [...(header.declaredFields ?? [])].sort();
  const liveDigest = sha256(declared.join('\n'));
  if (liveDigest !== PINNED_FIELD_SET_DIGEST) {
    const added = declared.filter((f) => !EXPECTED_FIELDS.includes(f));
    const removed = EXPECTED_FIELDS.filter((f) => !declared.includes(f));
    earlyDriftReasons.push(
      `field_set_digest: the delivery's declared fields differ from the pinned set`
      + `${added.length ? `; added: ${added.join(', ')}` : ''}`
      + `${removed.length ? `; missing: ${removed.join(', ')}` : ''}`,
    );
  }

  const unknownTypes = new Set<string>();
  const seen = new Map<string, number>();
  let duplicateCount = 0;
  let rowCount = 0;
  let trailer: RecorderBundleTrailer | null = null;
  let exhausted = false;

  async function* records(): AsyncGenerator<StreamedRecord> {
    let pending = await iterator.next();
    let index = 0;

    while (!pending.done) {
      const line = pending.value;
      const next = await iterator.next();

      if (next.done && isTrailer(line)) {
        trailer = JSON.parse(line) as RecorderBundleTrailer;
        break;
      }
      if (isTrailer(line)) fail('PARSE', `recorder trailer appears at row ${index + 1}, before the end of the delivery`);

      yield readRow(line, index);
      index += 1;
      pending = next;
    }
    exhausted = true;
  }

  function readRow(line: string, index: number): StreamedRecord {
    const origin = `row[${index}]`;
    let raw: RecorderIndexRow;
    try {
      raw = JSON.parse(line) as RecorderIndexRow;
    } catch (e) {
      return fail('PARSE', `${origin}: not JSON: ${(e as Error).message}`);
    }

    const parsed = parseRecorderRow(raw, origin);
    const issues: ValidationIssue[] = [];

    // A document number repeated within one registration system inside one
    // delivery is ambiguous source state: the recorder numbers consecutively,
    // so a repeat means the delivery is wrong, not that the document is.
    const previous = seen.get(parsed.sourceRecordId);
    if (previous !== undefined) {
      duplicateCount += 1;
      issues.push({
        code: 'cardinality',
        path: '/documentNumber',
        message: `duplicate document ${parsed.record.documentNumber} (${parsed.record.registrationSystem}), already read at row[${previous}]`,
      });
    }
    seen.set(parsed.sourceRecordId, index);

    // An unrecognised type is recorded and reported, never guessed at. It is
    // not a drift failure: recorders add document types routinely, and the row
    // is still a perfectly good recorded document in family OTHER.
    if (!classifyDocumentType(parsed.record.documentTypeRaw).recognised) {
      unknownTypes.add(parsed.record.documentTypeRaw);
    }
    rowCount += 1;

    return {
      parsed: {
        sourceRecordId: parsed.sourceRecordId,
        record: parsed.record as unknown as Readonly<Record<string, unknown>>,
        contentDigest: contentDigest(parsed.record),
        rawFragmentDigest: sha256(line),
        fieldGroupDigests: groupsOf(parsed.record),
      },
      issues,
    };
  }

  return {
    schemaVersion: RECORDER_SCHEMA_VERSION,
    schemaDigest: header.schemaDigest ?? liveDigest,
    earlyDriftReasons,
    records,

    finish(): StreamSummary {
      if (!exhausted) fail('CONFIG', 'finish() called before the record stream was exhausted');

      const driftReasons = [...earlyDriftReasons];
      const expected = header.expectedRecordCount;
      const delivered = trailer?.deliveredRecordCount ?? rowCount;

      // A window without a stated denominator is ingested, not complete. Saying
      // so is the whole point of the reconciliation fields.
      if (expected !== null && expected !== undefined && expected !== delivered) {
        driftReasons.push(`incomplete_delivery: the office stated ${expected} records for this window; ${delivered} arrived`);
      }
      if (trailer?.truncated === true) {
        driftReasons.push('truncated_delivery: the delivery declares itself truncated');
      }

      return {
        driftReasons: [...new Set(driftReasons)].sort(),
        // Unrecognised document types are reported here so the taxonomy can be
        // extended by a human who has seen real data, without failing the run.
        unknownFields: [...unknownTypes].sort().map((t) => `documentType:${t}`),
        missingFields: [],
        snapshot: {
          sourceReportedCount: expected ?? null,
          retrievedCount: delivered,
          duplicateCount,
          sourceSchemaDigest: header.schemaDigest ?? liveDigest,
          sourceChangedDuringRead: false,
        },
      };
    },
  };
}

function isTrailer(line: string): boolean {
  if (!line.includes(RECORDER_TRAILER_KIND)) return false;
  try {
    return (JSON.parse(line) as { kind?: string }).kind === RECORDER_TRAILER_KIND;
  } catch {
    return false;
  }
}

function groupsOf(record: RecorderRecord): Readonly<Record<string, string>> {
  return fieldGroupDigests({
    identity: { n: record.documentNumber, s: record.registrationSystem, c: record.certificateOfTitleNumber },
    type: record.documentTypeRaw,
    parties: record.parties,
    property: record.parcelIds,
    legal: record.legalDescriptions,
    references: record.referencedDocuments,
    financing: { p: record.principalMinor, m: record.maturityDate, k: record.considerationMinor },
  }, contentDigest);
}

export { HENNEPIN_COUNTY_FIPS, recorderSourceRecordId, canonicalJson };
