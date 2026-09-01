/**
 * Generic ArcGIS snapshot parse session.
 *
 * DF-0C and DF-0D built this against Hennepin. DF-0H needed the same thing for
 * the Minnesota statewide layer, and the honest finding on inspection was that
 * **almost none of it was Hennepin-specific**: reading a v2 bundle, finding the
 * trailer, checking the pinned field set, counting duplicates and reconciling a
 * crawl are properties of the ArcGIS snapshot *format*, not of a county.
 *
 * So the session is parameterised and the two connectors supply the four things
 * that genuinely differ. The split is deliberate and is the boundary the phase
 * brief asks for:
 *
 *   GENERIC (here)         bundle format, trailer detection, field-set drift,
 *                          duplicate detection, count reconciliation, unknown
 *                          field reporting, digests
 *
 *   SOURCE-SPECIFIC        which fields exist, how a feature parses, what a
 *                          parcel identifier means, which field groups matter
 *
 * What is deliberately NOT generalised is semantic normalisation. A generic
 * ArcGIS "guesser" that inferred owner names or parcel numbers from field-name
 * patterns would be wrong the first time a county called something else, and
 * wrong silently. Field maps stay hand-written per source.
 */
import { fail } from '../core/errors.ts';
import { contentDigest, sha256 } from '../core/hash.ts';
import type {
  StreamSummary,
  StreamedRecord,
  StreamingParseSession,
} from './connector.ts';
import {
  SNAPSHOT_BUNDLE_KIND_V2,
  SNAPSHOT_TRAILER_KIND,
  type StreamingSnapshotHeader,
  type StreamingSnapshotTrailer,
} from './arcgis-stream.ts';
import { SNAPSHOT_BUNDLE_KIND } from './arcgis.ts';
import type { ValidationIssue } from '../schema/xsd.ts';

/** Header shape tolerated across bundle versions and acquisition paths. */
export type AnyArcGisHeader = Partial<StreamingSnapshotHeader> & {
  kind?: string;
  sourceSchemaDigest?: string;
  layerMetadata?: { fields?: { name: string; type: string; length?: number }[] };
  sourceReportedCount?: number | null;
  requestedIdCount?: number;
  retrievedFeatureCount?: number;
  missingObjectIds?: number[];
};

/** What one source must supply to read its own features. */
export type ArcGisSessionOptions<R> = {
  readonly schemaVersion: string;
  /** Digest of the field set the connector was written against. */
  readonly pinnedFieldSetDigest: string;
  /** Fields the connector has a mapping decision for. Anything else is drift. */
  readonly knownFields: ReadonlySet<string>;
  /** Turns raw attributes into the connector's typed record. */
  parseFeature(attributes: Record<string, unknown>, origin: string): { sourceRecordId: string; record: R };
  /** Per-group digests, so a snapshot run can say what KIND of thing changed. */
  fieldGroups(record: R): Readonly<Record<string, string>>;
  /** Where a duplicate identity lives, for the validation issue's path. */
  readonly identityPath: string;
  /** Human-readable identity, for the duplicate message. */
  identityOf(record: R): string;
  /**
   * Accepts bundles produced by an acquisition path other than the live crawl —
   * a publisher's own bulk distribution, converted to the same bundle contract.
   */
  readonly acceptedKinds?: readonly string[];
  /**
   * Quarantine a row the parser refuses instead of failing the run.
   *
   * Off by default, because for a small curated delivery an unparseable row
   * usually means the whole file is wrong. On for large aggregations, where a
   * handful of rows with no parcel identifier is a fact about the data rather
   * than about the delivery — 18,462 of Minnesota's 2.7 million statewide rows
   * carry no county_pin, and failing the state because of them would be absurd.
   *
   * Quarantined rows are counted and reported, so a SYSTEMATIC parse failure is
   * still loud: it shows up as a quarantine count in the millions, not as silence.
   */
  readonly quarantineUnparseableRows?: boolean;
};

export async function openArcGisSnapshotStream<R>(
  lines: AsyncIterable<string>,
  options: ArcGisSessionOptions<R>,
): Promise<StreamingParseSession> {
  const iterator = lines[Symbol.asyncIterator]();

  const firstLine = await iterator.next();
  if (firstLine.done) fail('PARSE', 'snapshot bundle is empty');

  let header: AnyArcGisHeader;
  try {
    header = JSON.parse(firstLine.value) as AnyArcGisHeader;
  } catch (e) {
    return fail('PARSE', `snapshot bundle header is not JSON: ${(e as Error).message}`);
  }

  const accepted = new Set<string>([
    SNAPSHOT_BUNDLE_KIND_V2, SNAPSHOT_BUNDLE_KIND, ...(options.acceptedKinds ?? []),
  ]);
  if (header.kind === undefined || !accepted.has(header.kind)) {
    fail('PARSE', `unexpected bundle kind "${String(header.kind)}"`);
  }

  // Drift is decided from the header before a single record is read. There is no
  // point streaming millions of rows through a parser that is about to be told
  // the publisher changed the schema.
  const earlyDriftReasons = fieldSetDrift(header, options.pinnedFieldSetDigest);

  const unknownFields = new Set<string>();
  /**
   * Identities already seen, as 53-bit fingerprints rather than strings.
   *
   * The obvious implementation is `Map<sourceRecordId, firstIndex>`, and it was
   * the implementation until DF-0H ran 2.7 million rows through it: holding a
   * string key and a boxed index per row grew the heap from 180 MB at 400,000
   * rows to 402 MB at 1,175,000, on a trajectory to exhaust a 1 GB cap before
   * the end of the state.
   *
   * A numeric fingerprint costs about 16 bytes per row instead of ~120, which
   * turns "bounded by distinct record count" from approximately true into
   * actually true. The trade is the first-seen index in the duplicate message,
   * which is worth far less than the ability to finish.
   *
   * Two independent 32-bit hashes are combined, giving a 53-bit space. At 2.7
   * million identities the chance of a false duplicate is about one in 2,500 —
   * and a false duplicate quarantines one row with a stated reason rather than
   * corrupting anything, which is the right way round for a cheap guard.
   */
  const seen = new Set<number>();
  let duplicateCount = 0;
  let unparseableCount = 0;
  let recordCount = 0;
  let trailer: StreamingSnapshotTrailer | null = null;
  let exhausted = false;

  async function* records(): AsyncGenerator<StreamedRecord> {
    // One line of lookahead: the last line of a v2 bundle is the trailer, and it
    // is only identifiable as "the one with nothing after it".
    let pending = await iterator.next();
    let index = 0;

    while (!pending.done) {
      const line = pending.value;
      const next = await iterator.next();

      if (next.done && isTrailer(line)) {
        trailer = JSON.parse(line) as StreamingSnapshotTrailer;
        break;
      }
      if (isTrailer(line)) {
        fail('PARSE', `snapshot trailer appears at line ${index + 2}, before the end of the bundle`);
      }

      yield readFeature(line, index);
      index += 1;
      pending = next;
    }

    exhausted = true;
  }

  function readFeature(line: string, index: number): StreamedRecord {
    const origin = `feature[${index}]`;
    let attributes: Record<string, unknown>;
    try {
      attributes = JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      return fail('PARSE', `${origin}: not JSON: ${(e as Error).message}`);
    }

    for (const key of Object.keys(attributes)) {
      if (!options.knownFields.has(key)) unknownFields.add(key);
    }

    let parsed: { sourceRecordId: string; record: R };
    try {
      parsed = options.parseFeature(attributes, origin);
    } catch (e) {
      if (options.quarantineUnparseableRows !== true) throw e;
      unparseableCount += 1;
      const message = e instanceof Error ? e.message : String(e);
      return {
        parsed: {
          sourceRecordId: `unparseable-row:${index}`,
          record: { unparseable: true, reason: message },
          contentDigest: contentDigest({ unparseable: true, reason: message, index }),
          rawFragmentDigest: sha256(line),
        },
        issues: [{ code: 'type_violation', path: options.identityPath, message }],
      };
    }
    const issues: ValidationIssue[] = [];

    const fingerprint = fingerprintOf(parsed.sourceRecordId);
    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      issues.push({
        code: 'cardinality',
        path: options.identityPath,
        message: `duplicate ${options.identityOf(parsed.record)}, already read earlier in this bundle`,
      });
    }
    seen.add(fingerprint);
    recordCount += 1;

    return {
      parsed: {
        sourceRecordId: parsed.sourceRecordId,
        record: parsed.record as unknown as Readonly<Record<string, unknown>>,
        contentDigest: contentDigest(parsed.record),
        rawFragmentDigest: sha256(line),
        fieldGroupDigests: options.fieldGroups(parsed.record),
      },
      issues,
    };
  }

  return {
    schemaVersion: options.schemaVersion,
    schemaDigest: header.sourceSchemaDigest ?? '',
    earlyDriftReasons,
    records,

    finish(): StreamSummary {
      if (!exhausted) fail('CONFIG', 'finish() called before the record stream was exhausted');

      const driftReasons = [...earlyDriftReasons];
      // A few unparseable rows in millions is data; a large fraction is drift.
      // Both a floor and a ratio: two bad rows in four is not evidence of
      // anything, and calling it drift would fail deliveries that are simply
      // small. A run that parses NOTHING is caught separately by the runtime,
      // which quarantines when rows were quarantined and none were emitted.
      if (unparseableCount >= 50 && recordCount > 0 && unparseableCount > recordCount * 0.05) {
        driftReasons.push(
          `unparseable_rows: ${unparseableCount} of ${unparseableCount + recordCount} rows could not be parsed, `
          + 'which is too many to be individual bad records',
        );
      }
      if (unknownFields.size > 0) {
        driftReasons.push(
          `unknown_field: the source returned ${unknownFields.size} field(s) with no mapping decision: `
          + `${[...unknownFields].sort().slice(0, 5).join(', ')}`,
        );
      }

      const missing = trailer?.missingObjectIds ?? header.missingObjectIds ?? [];
      if (missing.length > 0) {
        driftReasons.push(`incomplete_crawl: ${missing.length} requested object id(s) were not returned`);
      }
      const changedDuringRead = trailer?.sourceChangedDuringRead ?? false;
      if (changedDuringRead) {
        driftReasons.push(
          `source_changed_during_read: the layer reported ${header.sourceReportedCount} rows before the crawl `
          + `and ${trailer?.sourceReportedCountAtEnd} after it`,
        );
      }

      return {
        driftReasons: [...new Set(driftReasons)].sort(),
        unknownFields: [...unknownFields].sort(),
        missingFields: [],
        snapshot: {
          sourceReportedCount: header.sourceReportedCount ?? null,
          retrievedCount: trailer?.retrievedFeatureCount ?? header.retrievedFeatureCount ?? recordCount,
          duplicateCount,
          sourceSchemaDigest: header.sourceSchemaDigest ?? null,
          sourceChangedDuringRead: changedDuringRead,
        },
      };
    },
  };
}

/**
 * A 53-bit fingerprint of a record identity.
 *
 * Two FNV-1a variants with different offset bases, combined. Cheap enough to run
 * on every one of 2.7 million rows without showing up in the profile.
 */
function fingerprintOf(value: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  // 21 bits from one hash, 32 from the other: 53 bits, which is every integer a
  // JavaScript number represents exactly.
  return (a % 0x200000) * 0x100000000 + b;
}

/** True for the trailer line, which is the only line whose `kind` is the trailer kind. */
function isTrailer(line: string): boolean {
  if (!line.includes(SNAPSHOT_TRAILER_KIND)) return false;
  try {
    return (JSON.parse(line) as { kind?: string }).kind === SNAPSHOT_TRAILER_KIND;
  } catch {
    return false;
  }
}

/** Digest over the publisher's own declared field set. A change quarantines the run. */
export function fieldSetDigestOf(
  fields: readonly { name: string; type: string; length?: number }[],
): string {
  return sha256(
    fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}:${f.length ?? ''}`).sort().join('\n'),
  );
}

function fieldSetDrift(header: AnyArcGisHeader, pinned: string): readonly string[] {
  const fields = header.layerMetadata?.fields;
  if (!fields) return ['field_set_digest: the bundle header carries no layer metadata to check against'];
  const live = fieldSetDigestOf(fields);
  if (live === pinned) return [];
  return [
    `field_set_digest: the layer's field set no longer matches the pinned one `
    + `(pinned ${pinned.slice(0, 12)}, live ${live.slice(0, 12)})`,
  ];
}
