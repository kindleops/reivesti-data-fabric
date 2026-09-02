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
import { createIdentityIndex, type IdentityIndex, type IdentityIndexStats } from './identity-index.ts';
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
   * The identity partition a record belongs to — a county FIPS for parcels.
   *
   * Omit it for a source whose identity is not county-scoped; its snapshot
   * index then stays a single one, which is the honest representation of a
   * single identity space.
   */
  partitionOf?(record: R): string | null;
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
  /** Largest single identity-index allocation. Segments, not a total budget. */
  readonly identitySegmentBytes?: number;
  /**
   * Rows the caller expects.
   *
   * Sizes the identity index's first segment. Defaults to the count the bundle
   * header declares, so most sources never need to pass it.
   */
  readonly expectedRows?: number;
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
   * Identities already seen, in an off-heap index.
   *
   * Two earlier shapes both scaled with the source on the JS heap:
   * `Map<recordId, index>` in DF-0F, then `Set<number>` of fingerprints in
   * DF-0H, measured at 37 bytes of heap per row — 100 MB for Minnesota and
   * 204 MB projected for New York. The index now keeps fingerprints and keys in
   * ArrayBuffers, which V8 accounts as external rather than heap.
   *
   * Exactness is unchanged: a fingerprint hit is confirmed against the full key,
   * so a collision reports a non-match rather than a false duplicate.
   */
  // The header already declares how many features the publisher reported, so a
  // caller does not have to know its own size to get a single allocation.
  const declaredRows = options.expectedRows
    ?? (typeof header.sourceReportedCount === 'number' && header.sourceReportedCount > 0
      ? header.sourceReportedCount
      : undefined);
  const seen: IdentityIndex = await createIdentityIndex({
    ...(declaredRows !== undefined ? { expectedRows: declaredRows } : {}),
    ...(options.identitySegmentBytes !== undefined ? { segmentBytes: options.identitySegmentBytes } : {}),
  });
  let duplicateCount = 0;
  let unparseableCount = 0;
  let recordCount = 0;
  let trailer: StreamingSnapshotTrailer | null = null;
  let exhausted = false;
  let identityStats: IdentityIndexStats | null = null;

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

      yield await readFeature(line, index);
      index += 1;
      pending = next;
    }

    exhausted = true;
    identityStats = seen.stats();
    // The spill is scratch state, not evidence. Released as soon as the stream
    // is done with it, on the success path and on the failure path alike.
    await seen.close();
  }

  async function readFeature(line: string, index: number): Promise<StreamedRecord> {
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

    if (await seen.add(parsed.sourceRecordId)) {
      duplicateCount += 1;
      issues.push({
        code: 'cardinality',
        path: options.identityPath,
        message: `duplicate ${options.identityOf(parsed.record)}, already read earlier in this bundle`,
      });
    }
    recordCount += 1;

    const partitionKey = options.partitionOf?.(parsed.record) ?? null;
    return {
      parsed: {
        sourceRecordId: parsed.sourceRecordId,
        record: parsed.record as unknown as Readonly<Record<string, unknown>>,
        contentDigest: contentDigest(parsed.record),
        rawFragmentDigest: sha256(line),
        fieldGroupDigests: options.fieldGroups(parsed.record),
      },
      ...(partitionKey !== null ? { partitionKey } : {}),
      issues,
    };
  }

  return {
    ...(declaredRows !== undefined ? { declaredRowCount: declaredRows } : {}),
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
        // Reported, never a drift reason. A collision the full-key check
        // rejected is the exactness guarantee working; quarantining a
        // multi-million-row delivery because two sha256 prefixes matched would
        // be a manufactured failure. An earlier draft of this file pushed it
        // onto `driftReasons`, which does exactly that.
        identityFingerprintCollisions: identityStats?.fingerprintCollisions ?? 0,
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
