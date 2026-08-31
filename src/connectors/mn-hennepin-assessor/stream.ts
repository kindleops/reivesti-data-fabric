/**
 * Streaming parse session for Hennepin snapshot bundles.
 *
 * Reads the v2 format — header line, feature lines, trailer line — with one line
 * of lookahead so the trailer is recognised without needing to know the row
 * count in advance and without buffering the file.
 *
 * The v1 format DF-0C wrote (header + features, no trailer) is still accepted:
 * a v1 bundle simply reports no end-of-crawl reconciliation, which is exactly
 * what it knows.
 */
import { fail } from '../../core/errors.ts';
import { contentDigest, sha256 } from '../../core/hash.ts';
import type {
  StreamSummary,
  StreamedRecord,
  StreamingParseSession,
} from '../../runtime/connector.ts';
import {
  SNAPSHOT_BUNDLE_KIND_V2,
  SNAPSHOT_TRAILER_KIND,
  type StreamingSnapshotHeader,
  type StreamingSnapshotTrailer,
} from '../../runtime/arcgis-stream.ts';
import { SNAPSHOT_BUNDLE_KIND } from '../../runtime/arcgis.ts';
import type { ValidationIssue } from '../../schema/xsd.ts';
import { HENNEPIN_FIELD_MAP } from './field-map.ts';
import { parseHennepinFeature } from './parse.ts';
import { fieldGroupsOf } from './groups.ts';

type AnyHeader = Partial<StreamingSnapshotHeader> & {
  kind?: string;
  sourceSchemaDigest?: string;
  layerMetadata?: { fields?: { name: string; type: string; length?: number }[] };
  sourceReportedCount?: number | null;
  requestedIdCount?: number;
  retrievedFeatureCount?: number;
  missingObjectIds?: number[];
};

const KNOWN_FIELDS: ReadonlySet<string> = new Set(HENNEPIN_FIELD_MAP.map((f) => f.field));

export type HennepinStreamOptions = {
  readonly pinnedFieldSetDigest: string;
  readonly schemaVersion: string;
};

export async function openHennepinStream(
  lines: AsyncIterable<string>,
  options: HennepinStreamOptions,
): Promise<StreamingParseSession> {
  const iterator = lines[Symbol.asyncIterator]();

  const firstLine = await iterator.next();
  if (firstLine.done) fail('PARSE', 'snapshot bundle is empty');

  let header: AnyHeader;
  try {
    header = JSON.parse(firstLine.value) as AnyHeader;
  } catch (e) {
    return fail('PARSE', `snapshot bundle header is not JSON: ${(e as Error).message}`);
  }
  if (header.kind !== SNAPSHOT_BUNDLE_KIND_V2 && header.kind !== SNAPSHOT_BUNDLE_KIND) {
    fail('PARSE', `unexpected bundle kind "${String(header.kind)}"`);
  }

  // Drift is checked from the header before any record is read: there is no
  // point streaming a county through a parser that is about to be told the
  // publisher changed the schema.
  const earlyDriftReasons = fieldSetDrift(header, options.pinnedFieldSetDigest);

  const unknownFields = new Set<string>();
  const seen = new Map<string, number>();
  let duplicateCount = 0;
  let recordCount = 0;
  let trailer: StreamingSnapshotTrailer | null = null;
  let exhausted = false;

  async function* records(): AsyncGenerator<StreamedRecord> {
    // One line of lookahead: the last line of a v2 bundle is the trailer, and
    // it is only identifiable as "the one with nothing after it".
    let pending = await iterator.next();
    let index = 0;

    while (!pending.done) {
      const line = pending.value;
      const next = await iterator.next();

      if (next.done && isTrailer(line)) {
        trailer = JSON.parse(line) as StreamingSnapshotTrailer;
        break;
      }
      // A trailer anywhere but the end means the file was concatenated or
      // truncated; either way it is not the artifact it claims to be.
      if (isTrailer(line)) fail('PARSE', `snapshot trailer appears at line ${index + 2}, before the end of the bundle`);

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

    for (const key of Object.keys(attributes)) if (!KNOWN_FIELDS.has(key)) unknownFields.add(key);

    const parsed = parseHennepinFeature(attributes, origin);
    const issues: ValidationIssue[] = [];

    const previous = seen.get(parsed.sourceRecordId);
    if (previous !== undefined) {
      duplicateCount += 1;
      issues.push({
        code: 'cardinality',
        path: '/PID',
        message: `duplicate parcel ${parsed.record.pid}, already read at feature[${previous}]`,
      });
    }
    seen.set(parsed.sourceRecordId, index);
    recordCount += 1;

    return {
      parsed: {
        sourceRecordId: parsed.sourceRecordId,
        record: parsed.record as unknown as Readonly<Record<string, unknown>>,
        contentDigest: contentDigest(parsed.record),
        rawFragmentDigest: sha256(line),
        fieldGroupDigests: fieldGroupsOf(parsed.record),
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
      if (unknownFields.size > 0) {
        driftReasons.push(
          `unknown_field: the source returned ${unknownFields.size} field(s) with no mapping decision: `
          + `${[...unknownFields].sort().slice(0, 5).join(', ')}`,
        );
      }

      // v1 bundles put reconciliation in the header; v2 puts it in the trailer.
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

/** True for the trailer line, which is the only line whose `kind` is the trailer kind. */
function isTrailer(line: string): boolean {
  // Cheap prefix rejection before parsing: feature lines never mention the kind.
  if (!line.includes(SNAPSHOT_TRAILER_KIND)) return false;
  try {
    return (JSON.parse(line) as { kind?: string }).kind === SNAPSHOT_TRAILER_KIND;
  } catch {
    return false;
  }
}

function fieldSetDrift(header: AnyHeader, pinned: string): readonly string[] {
  const fields = header.layerMetadata?.fields;
  if (!fields) return ['field_set_digest: the bundle header carries no layer metadata to check against'];
  const live = sha256(
    fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}:${f.length ?? ''}`).sort().join('\n'),
  );
  if (live === pinned) return [];
  return [
    `field_set_digest: the layer's field set no longer matches the pinned one `
    + `(pinned ${pinned.slice(0, 12)}, live ${live.slice(0, 12)})`,
  ];
}
