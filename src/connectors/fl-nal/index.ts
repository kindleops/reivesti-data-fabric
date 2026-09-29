/**
 * Florida DOR NAL connector — the 67 county real property rolls.
 *
 * **Live retrieval status: PERMITTED, and unattended.** The Department posts
 * the rolls in its public PTO Data Portal library; the library's own REST
 * listing names every file, and each is a plain anonymous GET. No account, no
 * token, no CAPTCHA, no fee; re-verified 2026-09-29.
 *
 * Acquisition, derivation and ledger live in `../fl-dor/pipeline.ts`, shared
 * with the SDF and the cadastral files. This module is the semantics: which
 * layouts are pinned, how a row parses, and what it means canonically.
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
import { FL_NAL_SOURCE_ID } from '../../registry/sources.ts';
import type { FlReleaseManifest } from '../fl-dor/acquire.ts';
import {
  FL_CSV_BUNDLE_KIND,
  FL_ROW_PROVENANCE_FIELDS,
  deriveFlCsvBundle,
  flCsvFieldSetDigest,
  type FlCsvLayout,
} from '../fl-dor/csv-bundle.ts';
import type { FlSourceSpec } from '../fl-dor/pipeline.ts';
import { discoverFlRoll } from '../fl-dor/portal.ts';
import { FL_NAL_FIELD_MAP, FL_NAL_LAYOUTS } from './field-map.ts';
import { flNalContentOf, parseFlNalRow, type FlNalRecord } from './parse.ts';
import { FL_NAL_NORMALIZATION_VERSION, flNalFieldGroups, normalizeFlNalRecord } from './normalize.ts';

export const FL_NAL_ADAPTER_KEY = FL_NAL_SOURCE_ID;
export const FL_NAL_MAPPING_ID = 'fl_dor_nal__all_fl_counties';
export const FL_NAL_CONNECTOR_VERSION = 'fl_nal_connector_1';
export const FL_NAL_PARSER_VERSION = 'fl_nal_parser_1';
export const FL_NAL_SCHEMA_VERSION = 'fl_dor_nal_2026';

export const FL_NAL_PINNED_LAYOUTS: readonly FlCsvLayout[] = Object.entries(FL_NAL_LAYOUTS)
  .map(([id, columns]) => ({ id, columns }));

const FIELDS = FL_NAL_FIELD_MAP.map((f) => ({ name: f.field, type: f.sourceType, ...(f.maxLength !== undefined ? { length: f.maxLength } : {}) }));

/** Digest of the union field set both 2026 layouts draw from. */
export const FL_NAL_PINNED_FIELD_SET_DIGEST = flCsvFieldSetDigest(FIELDS);

export function flNalKnownFieldsWithProvenance(): ReadonlySet<string> {
  return new Set([...FL_NAL_FIELD_MAP.map((f) => f.field), ...FL_ROW_PROVENANCE_FIELDS, '__malformed']);
}

export function createFlNalConnector(options: { readonly sourceId?: string } = {}): StreamingConnector {
  const sourceId = options.sourceId ?? FL_NAL_SOURCE_ID;
  const refuse = (): never => fail('CONFIG', 'the Florida NAL connector is streaming; the runtime must call openStream');
  return {
    adapterKey: FL_NAL_ADAPTER_KEY,
    connectorVersion: FL_NAL_CONNECTOR_VERSION,
    parserVersion: FL_NAL_PARSER_VERSION,
    normalizationVersion: FL_NAL_NORMALIZATION_VERSION,
    schemaVersion: FL_NAL_SCHEMA_VERSION,
    // Bytes reach this connector from retained artifacts only.
    transport: createLocalFileTransport(),
    /** The roll restates every parcel; absence means the county dropped it, never that the land is gone. */
    snapshotSource: true,
    streaming: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      return fail('CONFIG', 'the Florida NAL connector reads what the Florida DOR pipeline derives', {
        sourceId, remedy: 'run `df auto fl_dor_nal`, which discovers, acquires and derives unattended',
      });
    },
    parse(): ParsedBatch { return refuse(); },
    validate(): BatchValidation { return refuse(); },

    normalize(_ctx: ConnectorContext, parsed: ParsedRecord, evidence: SourceEvidence, change: ChangeContext): NormalizeResult {
      const result = normalizeFlNalRecord(parsed.record as unknown as FlNalRecord, evidence, {
        sourceId,
        snapshotId: change.snapshotId ?? `${sourceId}__unsnapshotted`,
        changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
        changedFieldGroups: change.changedFieldGroups,
      }, parsed.contentDigest);
      return { bundle: result.bundle, contacts: result.contacts };
    },

    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openArcGisSnapshotStream<FlNalRecord>(lines, {
        schemaVersion: FL_NAL_SCHEMA_VERSION,
        pinnedFieldSetDigest: FL_NAL_PINNED_FIELD_SET_DIGEST,
        knownFields: flNalKnownFieldsWithProvenance(),
        parseFeature: (attributes, origin) => parseFlNalRow(attributes, origin),
        fieldGroups: (record) => flNalFieldGroups(record),
        contentOf: (record) => flNalContentOf(record),
        identityPath: '/PARCEL_ID',
        identityOf: (record) => `parcel ${record.countyFips}:${record.parcelId}`,
        partitionOf: (record) => record.countyFips,
        acceptedKinds: [FL_CSV_BUNDLE_KIND],
        // A handful of refused rows in eleven million is data, not drift; each
        // is counted, and a systematic failure still trips the ratio check.
        quarantineUnparseableRows: true,
      });
    },
  };
}

/** The NAL as the Florida DOR engine drives it. */
export const FL_NAL_SPEC: FlSourceSpec = {
  sourceId: FL_NAL_SOURCE_ID,
  mappingId: FL_NAL_MAPPING_ID,
  kind: 'NAL',
  discover: (http) => discoverFlRoll('NAL', http),
  derive: (input) => deriveFlCsvBundle(input, { layouts: FL_NAL_PINNED_LAYOUTS, fields: FIELDS }),
  connector: (_manifest: FlReleaseManifest) => createFlNalConnector(),
};
