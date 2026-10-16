/**
 * Florida DOR SDF connector — the 67 county sale data files.
 *
 * Same library, same anonymous GETs, same engine as the NAL (`../fl-dor`).
 * This module is the sale semantics: every row one FL_DOR_SALE_OBSERVATION,
 * converged with the roll's echoes of it in TRANSACTION_RESOLUTION.
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
import { FL_SDF_SOURCE_ID } from '../../registry/sources.ts';
import {
  FL_CSV_BUNDLE_KIND,
  FL_ROW_PROVENANCE_FIELDS,
  deriveFlCsvBundle,
  flCsvFieldSetDigest,
} from '../fl-dor/csv-bundle.ts';
import type { FlSourceSpec } from '../fl-dor/pipeline.ts';
import { discoverFlRoll } from '../fl-dor/portal.ts';
import { FL_SDF_FIELD_MAP, FL_SDF_LAYOUT_2026 } from './field-map.ts';
import { flSdfContentOf, parseFlSdfRow, type FlSdfRecord } from './parse.ts';
import { FL_SDF_NORMALIZATION_VERSION, flSdfFieldGroups, normalizeFlSdfRecord } from './normalize.ts';

export const FL_SDF_ADAPTER_KEY = FL_SDF_SOURCE_ID;
export const FL_SDF_MAPPING_ID = 'fl_dor_sdf__all_fl_counties';
export const FL_SDF_CONNECTOR_VERSION = 'fl_sdf_connector_1';
export const FL_SDF_PARSER_VERSION = 'fl_sdf_parser_1';
export const FL_SDF_SCHEMA_VERSION = 'fl_dor_sdf_2026';

const FIELDS = FL_SDF_FIELD_MAP.map((f) => ({ name: f.field, type: f.sourceType, ...(f.maxLength !== undefined ? { length: f.maxLength } : {}) }));
export const FL_SDF_PINNED_FIELD_SET_DIGEST = flCsvFieldSetDigest(FIELDS);

export function createFlSdfConnector(options: { readonly sourceId?: string } = {}): StreamingConnector {
  const sourceId = options.sourceId ?? FL_SDF_SOURCE_ID;
  const refuse = (): never => fail('CONFIG', 'the Florida SDF connector is streaming; the runtime must call openStream');
  return {
    adapterKey: FL_SDF_ADAPTER_KEY,
    connectorVersion: FL_SDF_CONNECTOR_VERSION,
    parserVersion: FL_SDF_PARSER_VERSION,
    normalizationVersion: FL_SDF_NORMALIZATION_VERSION,
    schemaVersion: FL_SDF_SCHEMA_VERSION,
    transport: createLocalFileTransport(),
    /**
     * Each file restates the current sale window. A sale absent from a later
     * release fell out of the window or was withdrawn — "missing from the
     * latest source", never "did not happen".
     */
    snapshotSource: true,
    streaming: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      return fail('CONFIG', 'the Florida SDF connector reads what the Florida DOR pipeline derives', {
        sourceId, remedy: 'run `df auto fl_dor_sdf`, which discovers, acquires and derives unattended',
      });
    },
    parse(): ParsedBatch { return refuse(); },
    validate(): BatchValidation { return refuse(); },

    normalize(_ctx: ConnectorContext, parsed: ParsedRecord, evidence: SourceEvidence, change: ChangeContext): NormalizeResult {
      const result = normalizeFlSdfRecord(parsed.record as unknown as FlSdfRecord, evidence, {
        sourceId,
        snapshotId: change.snapshotId ?? `${sourceId}__unsnapshotted`,
        changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
        changedFieldGroups: change.changedFieldGroups,
      }, parsed.contentDigest);
      // The SDF names no party and no address: nothing for the restricted plane.
      return { bundle: result.bundle, contacts: [], extraRows: result.extraRows };
    },

    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openArcGisSnapshotStream<FlSdfRecord>(lines, {
        schemaVersion: FL_SDF_SCHEMA_VERSION,
        pinnedFieldSetDigest: FL_SDF_PINNED_FIELD_SET_DIGEST,
        knownFields: new Set([...FL_SDF_LAYOUT_2026, ...FL_ROW_PROVENANCE_FIELDS, '__malformed']),
        parseFeature: (attributes, origin) => parseFlSdfRow(attributes, origin),
        fieldGroups: (record) => flSdfFieldGroups(record),
        contentOf: (record) => flSdfContentOf(record),
        identityPath: '/SALE_ID_CD',
        identityOf: (record) => `sale ${record.countyFips}:${record.parcelId}#${record.saleId}`,
        partitionOf: (record) => record.countyFips,
        acceptedKinds: [FL_CSV_BUNDLE_KIND],
        quarantineUnparseableRows: true,
      });
    },
  };
}

export const FL_SDF_SPEC: FlSourceSpec = {
  sourceId: FL_SDF_SOURCE_ID,
  mappingId: FL_SDF_MAPPING_ID,
  kind: 'SDF',
  discover: (http) => discoverFlRoll('SDF', http),
  derive: (input) => deriveFlCsvBundle(input, { layouts: [{ id: 'fl_sdf_2026', columns: FL_SDF_LAYOUT_2026 }], fields: FIELDS }),
  connector: () => createFlSdfConnector(),
};
