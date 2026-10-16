/**
 * Florida statewide cadastral connector — the 67 county PAR shapefiles.
 *
 * **Acquisition path: the Department's PAR files, not the FGIO service.** The
 * Florida Geographic Information Office's statewide polygon FeatureServer now
 * answers "Token Required", and its anonymous centroid layer still carries the
 * 2025 roll. The PAR files in the PTO Data Portal are what FGIO itself refreshes
 * from: the county appraisers' parcel shapefiles, joined by the Department to
 * the 2026 preliminary roll, posted 2026-08-07 as one coherent annual release.
 * Anonymous GETs; no account, no token, no fee.
 */
import { fail } from '../../core/errors.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import { SNAPSHOT_CHANGE_KIND } from '../../canonical/snapshot.ts';
import type {
  BatchValidation,
  ChangeContext,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  StreamingConnector,
  StreamingParseSession,
} from '../../runtime/connector.ts';
import { openArcGisSnapshotStream } from '../../runtime/arcgis-session.ts';
import { createLocalFileTransport } from '../../runtime/transport.ts';
import { FL_CADASTRAL_SOURCE_ID } from '../../registry/sources.ts';
import type { FlSourceSpec } from '../fl-dor/pipeline.ts';
import { discoverFlParcelShapefiles } from '../fl-dor/portal.ts';
import { FL_PAR_BUNDLE_KIND, FL_PAR_EMITTED_COLUMNS, FL_PAR_PINNED_FIELD_SET_DIGEST, FL_PAR_ROW_EXTRA_FIELDS, deriveFlParBundle } from './derive.ts';
import { flParContentOf, parseFlParRow, type FlParRecord } from './parse.ts';
import { FL_PAR_NORMALIZATION_VERSION, flParFieldGroups, normalizeFlParRecord } from './normalize.ts';

export const FL_CADASTRAL_ADAPTER_KEY = FL_CADASTRAL_SOURCE_ID;
export const FL_CADASTRAL_MAPPING_ID = 'fl_statewide_cadastral__all_fl_counties';
export const FL_CADASTRAL_CONNECTOR_VERSION = 'fl_cadastral_connector_1';
export const FL_CADASTRAL_PARSER_VERSION = 'fl_cadastral_parser_1';
export const FL_CADASTRAL_SCHEMA_VERSION = 'fl_dor_par_2026';

export function createFlCadastralConnector(options: { readonly sourceId?: string } = {}): StreamingConnector {
  const sourceId = options.sourceId ?? FL_CADASTRAL_SOURCE_ID;
  const refuse = (): never => fail('CONFIG', 'the Florida cadastral connector is streaming; the runtime must call openStream');
  return {
    adapterKey: FL_CADASTRAL_ADAPTER_KEY,
    connectorVersion: FL_CADASTRAL_CONNECTOR_VERSION,
    parserVersion: FL_CADASTRAL_PARSER_VERSION,
    normalizationVersion: FL_PAR_NORMALIZATION_VERSION,
    schemaVersion: FL_CADASTRAL_SCHEMA_VERSION,
    transport: createLocalFileTransport(),
    /** The fabric is redrawn each year; a polygon leaving it was retired, split or merged — never land ceasing to exist. */
    snapshotSource: true,
    streaming: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      return fail('CONFIG', 'the Florida cadastral connector reads what the Florida DOR pipeline derives', {
        sourceId, remedy: 'run `df auto fl_statewide_cadastral`, which discovers, acquires and derives unattended',
      });
    },
    parse(): ParsedBatch { return refuse(); },
    validate(): BatchValidation { return refuse(); },

    normalize(_ctx: ConnectorContext, parsed: ParsedRecord, evidence: SourceEvidence, change: ChangeContext): NormalizeResult {
      const bundle = normalizeFlParRecord(parsed.record as unknown as FlParRecord, evidence, {
        sourceId,
        snapshotId: change.snapshotId ?? `${sourceId}__unsnapshotted`,
        changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
        changedFieldGroups: change.changedFieldGroups,
      }, parsed.contentDigest);
      // Owner and mailing columns are the NAL's; they reach the restricted plane from there, once.
      return { bundle, contacts: [] };
    },

    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openArcGisSnapshotStream<FlParRecord>(lines, {
        schemaVersion: FL_CADASTRAL_SCHEMA_VERSION,
        pinnedFieldSetDigest: FL_PAR_PINNED_FIELD_SET_DIGEST,
        knownFields: new Set([...FL_PAR_EMITTED_COLUMNS, ...FL_PAR_ROW_EXTRA_FIELDS]),
        parseFeature: (attributes, origin) => parseFlParRow(attributes, origin),
        fieldGroups: (record) => flParFieldGroups(record),
        contentOf: (record) => flParContentOf(record),
        identityPath: '/PARCEL_ID',
        identityOf: (record) => `parcel ${record.countyFips}:${record.parcelId}`,
        partitionOf: (record) => record.countyFips,
        acceptedKinds: [FL_PAR_BUNDLE_KIND],
        // Unjoined polygons are a fraction of a percent of the fabric; each is
        // refused and counted, and a systematic failure still trips the ratio check.
        quarantineUnparseableRows: true,
      });
    },
  };
}

export const FL_CADASTRAL_SPEC: FlSourceSpec = {
  sourceId: FL_CADASTRAL_SOURCE_ID,
  mappingId: FL_CADASTRAL_MAPPING_ID,
  kind: 'PAR',
  discover: (http) => discoverFlParcelShapefiles(http),
  derive: (input) => deriveFlParBundle(input),
  connector: () => createFlCadastralConnector(),
};
