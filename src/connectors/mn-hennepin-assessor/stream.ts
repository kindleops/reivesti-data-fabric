/**
 * Streaming parse session for Hennepin snapshot bundles.
 *
 * DF-0H found that almost all of this was generic ArcGIS snapshot handling
 * rather than anything about Hennepin, so the body moved to
 * `src/runtime/arcgis-session.ts` and what remains is the county's own four
 * contributions: its field set, its feature parser, its field groups and what a
 * duplicate parcel is called.
 *
 * Behaviour is unchanged — the v2 format (header, features, trailer) and the v1
 * format DF-0C wrote are both still accepted, and a v1 bundle still reports no
 * end-of-crawl reconciliation, which is exactly what it knows.
 */
import type { StreamingParseSession } from '../../runtime/connector.ts';
import { openArcGisSnapshotStream } from '../../runtime/arcgis-session.ts';
import { HENNEPIN_FIELD_MAP } from './field-map.ts';
import { parseHennepinFeature, type ParsedParcel, HENNEPIN_COUNTY_FIPS } from './parse.ts';
import { fieldGroupsOf } from './groups.ts';

const KNOWN_FIELDS: ReadonlySet<string> = new Set(HENNEPIN_FIELD_MAP.map((f) => f.field));

export type HennepinStreamOptions = {
  readonly pinnedFieldSetDigest: string;
  readonly schemaVersion: string;
};

export async function openHennepinStream(
  lines: AsyncIterable<string>,
  options: HennepinStreamOptions,
): Promise<StreamingParseSession> {
  return openArcGisSnapshotStream<ParsedParcel['record']>(lines, {
    schemaVersion: options.schemaVersion,
    pinnedFieldSetDigest: options.pinnedFieldSetDigest,
    knownFields: KNOWN_FIELDS,
    parseFeature: (attributes, origin) => parseHennepinFeature(attributes, origin),
    fieldGroups: (record) => fieldGroupsOf(record),
    identityPath: '/PID',
    identityOf: (record) => `parcel ${record.pid}`,
    // One county, and it is this one. Naming it keeps the index in the same
    // per-county layout as every other parcel source rather than making
    // single-county sources a special case.
    partitionOf: () => HENNEPIN_COUNTY_FIPS,
  });
}
