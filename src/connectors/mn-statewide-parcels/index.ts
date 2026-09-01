/**
 * Minnesota statewide parcel connector — 59 counties from one source.
 *
 * **Live retrieval status: PERMITTED.** MnGeo publishes this on the Minnesota
 * Geospatial Commons as open data: no credentials, no account, no fee, and a
 * licence that asks only that the publisher be acknowledged. DF-0G's activation
 * evaluator returns `CORE_ELIGIBLE`, and this is the first source to reach that
 * verdict through the doctrine rather than by predating it.
 *
 * ## Two sanctioned acquisition paths, and why the bulk file wins
 *
 * The publisher offers both a FeatureServer and a bulk GeoPackage of the same
 * dataset. Measured on 2026-08-31:
 *
 *   ArcGIS query    37.6 s per 2,000 rows → 1,356 pages → **14-19 hours**
 *   GeoPackage      2.62 GB in about two minutes, one request
 *
 * The bulk file is the default. Sustained querying of a state government's
 * service for most of a day, when that government also publishes the whole thing
 * as a file, is neither considerate nor reliable. The ArcGIS path stays wired up
 * and generic — it is right for sources with no bulk distribution, and it is the
 * verification path for this one.
 *
 * Both paths produce the same bundle contract, so a record ingested either way
 * normalises identically. Acquisition is pluggable; canonical output is not.
 *
 * ## What this source is, and is not
 *
 * It is 59 county assessment rolls, standardised to the MnGAC Parcel Data
 * Standard v1.1.3 and republished by the state. It is authoritative for parcel
 * identity, and it carries assessment, ownership-of-record, tax and structure
 * detail.
 *
 * It is **not** a transfer source. Its `sale_date`/`sale_value` fields are the
 * assessor's echo of a last sale — see `normalize.ts` for the measurements that
 * settle that — and they do not replace eCRV.
 */
import { fail } from '../../core/errors.ts';
import { sha256 } from '../../core/hash.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import { SNAPSHOT_CHANGE_KIND } from '../../canonical/snapshot.ts';
import type {
  BatchValidation,
  ChangeContext,
  Connector,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  StreamingConnector,
  StreamingParseSession,
} from '../../runtime/connector.ts';
import { createStreamingArcGisTransport } from '../../runtime/arcgis-stream.ts';
import { openArcGisSnapshotStream } from '../../runtime/arcgis-session.ts';
import { createLocalFileTransport, type Transport } from '../../runtime/transport.ts';
import { MN_STATEWIDE_ADAPTER_KEY, MN_STATEWIDE_SOURCE_ID } from '../../registry/sources.ts';
import {
  MN_STATEWIDE_FIELD_MAP,
  mnStatewideKnownFields,
  mnStatewideOutFields,
} from './field-map.ts';
import { parseMnStatewideFeature, type MnStatewideParcelRecord } from './parse.ts';
import {
  MN_STATEWIDE_NORMALIZATION_VERSION,
  mnStatewideFieldGroups,
  normalizeMnStatewideParcel,
} from './normalize.ts';
import { GPKG_BUNDLE_KIND } from './gpkg.ts';

export { MN_STATEWIDE_ADAPTER_KEY, MN_STATEWIDE_SOURCE_ID };

export const MN_STATEWIDE_CONNECTOR_VERSION = 'mn_statewide_connector_1';
export const MN_STATEWIDE_PARSER_VERSION = 'mn_statewide_parser_1';
export const MN_STATEWIDE_SCHEMA_VERSION = 'mngac_parcel_standard_1_1_3';

export const MN_STATEWIDE_SERVICE_URL =
  'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer';
/** Layer 1 is the parcels. Layer 0 is the per-county metadata. */
export const MN_STATEWIDE_LAYER_ID = 1;
export const MN_STATEWIDE_METADATA_LAYER_ID = 0;

export const MN_STATEWIDE_BULK_URL =
  'https://operations.gis.data.mn.gov/api/publicdownload/download/511/plan_parcels_open.gpkg';

/** GeoPackage table names inside the bulk distribution. */
export const GPKG_TABLE = 'plan_parcels_open';
export const GPKG_METADATA_TABLE = 'plan_parcels_open_metadata';

/**
 * Digest of the field set this connector was written against, captured from the
 * service's own metadata on 2026-08-31. A publisher-side schema change makes the
 * live digest differ, which quarantines the run rather than letting an unmapped
 * column flow through unclassified.
 */
export const PINNED_FIELD_SET_DIGEST = sha256(
  MN_STATEWIDE_FIELD_MAP.map((f) => `${f.field}:${f.sourceType}:${f.maxLength ?? ''}`).sort().join('\n'),
);

export type MnStatewideConnectorOptions = {
  /** A snapshot bundle on disk: the converted GeoPackage, or a fixture. */
  readonly localFile?: string;
  readonly referencePeriod?: string;
  readonly sourceId?: string;
  /**
   * Live ArcGIS retrieval. Available and deliberately not the default — see the
   * module header for the measurement that decided it.
   */
  readonly live?: {
    readonly referencePeriod: string;
    readonly maxFeatures?: number;
    readonly pageSize?: number;
    readonly fetchImpl?: typeof fetch;
  };
  readonly transport?: Transport;
  readonly fetchBatchSize?: number;
  readonly maxConcurrentRequests?: number;
};

export function createMnStatewideParcelConnector(
  options: MnStatewideConnectorOptions = {},
): StreamingConnector {
  const sourceId = options.sourceId ?? MN_STATEWIDE_SOURCE_ID;

  const transport = options.transport ?? (options.live
    ? createStreamingArcGisTransport({
      serviceUrl: MN_STATEWIDE_SERVICE_URL,
      layerId: MN_STATEWIDE_LAYER_ID,
      outFields: mnStatewideOutFields(),
      ...(options.live.maxFeatures !== undefined ? { maxFeatures: options.live.maxFeatures } : {}),
      ...(options.fetchBatchSize !== undefined ? { pageSize: options.fetchBatchSize } : {}),
      ...(options.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: options.maxConcurrentRequests } : {}),
      ...(options.live.fetchImpl !== undefined ? { fetchImpl: options.live.fetchImpl } : {}),
      userAgent: 'Reivesti-DataFabric/0.1 (+https://github.com/kindleops/reivesti-data-fabric)',
    })
    : createLocalFileTransport());

  const base: Connector = {
    adapterKey: MN_STATEWIDE_ADAPTER_KEY,
    connectorVersion: MN_STATEWIDE_CONNECTOR_VERSION,
    parserVersion: MN_STATEWIDE_PARSER_VERSION,
    normalizationVersion: MN_STATEWIDE_NORMALIZATION_VERSION,
    schemaVersion: MN_STATEWIDE_SCHEMA_VERSION,
    transport,
    /**
     * A state of the world, restated whenever the aggregation runs. Absence
     * detection applies — but a parcel leaving the layer means its county
     * stopped publishing or the parcel was retired, and NOT that the land
     * ceased to exist.
     */
    snapshotSource: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      if (!options.localFile && !options.live) {
        fail('ACCESS_BLOCKED', 'no Minnesota statewide parcel delivery is available to this connector', {
          sourceId,
          reason: 'the source is free and sanctioned; this run was given neither a local bundle nor live options',
          remedy: `download ${MN_STATEWIDE_BULK_URL}, convert it with the gpkg converter, and pass the bundle `
            + 'as localFile — or pass live options to crawl the FeatureServer instead',
        });
      }
      const referencePeriod = options.referencePeriod ?? options.live?.referencePeriod ?? 'unspecified';
      return [{
        release: {
          releaseId: `${sourceId}__${referencePeriod}`,
          sourceId,
          releaseLabel: `Minnesota statewide parcels ${referencePeriod}`,
          referencePeriod,
          publicationAt: null,
          // The aggregation is re-run; a given run's output is not amended.
          finality: 'final',
          sourceVersion: MN_STATEWIDE_SCHEMA_VERSION,
        },
        request: {
          locator: options.localFile ?? MN_STATEWIDE_SERVICE_URL,
          filename: 'plan_parcels_open.bundle',
        },
      }];
    },

    // 2.7 million rows must never be read into memory, so the buffered path is
    // refused rather than merely unimplemented.
    parse(): ParsedBatch {
      return fail('CONFIG', 'the MN statewide connector is streaming; the runtime must call openStream');
    },
    validate(): BatchValidation {
      return fail('CONFIG', 'the MN statewide connector is streaming; the runtime must call openStream');
    },

    normalize(
      _ctx: ConnectorContext,
      parsed: ParsedRecord,
      evidence: SourceEvidence,
      change: ChangeContext,
    ): NormalizeResult {
      const result = normalizeMnStatewideParcel(
        parsed.record as unknown as MnStatewideParcelRecord,
        evidence,
        {
          sourceId,
          snapshotId: change.snapshotId ?? `${sourceId}__unsnapshotted`,
          changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
          changedFieldGroups: change.changedFieldGroups,
        },
      );
      return {
        bundle: result.bundle,
        // Owner and taxpayer mailing lines. They exist only here; no canonical
        // type in this connector's output has a field that could hold one.
        contacts: result.contacts,
      };
    },
  };

  return {
    ...base,
    streaming: true,
    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openArcGisSnapshotStream<MnStatewideParcelRecord>(lines, {
        schemaVersion: MN_STATEWIDE_SCHEMA_VERSION,
        pinnedFieldSetDigest: PINNED_FIELD_SET_DIGEST,
        knownFields: mnStatewideKnownFields(),
        parseFeature: (attributes, origin) => parseMnStatewideFeature(attributes, origin),
        fieldGroups: (record) => mnStatewideFieldGroups(record),
        identityPath: '/county_pin',
        identityOf: (record) => `parcel ${record.countyFips}:${record.countyPin}`,
        // The publisher's bulk distribution, converted to the same contract.
        acceptedKinds: [GPKG_BUNDLE_KIND],
        // 18,462 of 2.7 million rows carry no county_pin, and a few counties
        // publish placeholder rows with junk identifiers. Those rows have no
        // parcel identity and are quarantined individually; failing the whole
        // state because of them would be the wrong trade.
        quarantineUnparseableRows: true,
      });
    },
  };
}
