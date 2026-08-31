/**
 * Hennepin County assessor / parcel connector.
 *
 * Live retrieval status: PERMITTED. Unlike eCRV, this source is a public ArcGIS
 * REST service that Hennepin County publishes as open data with no licence and
 * no credentials, so `automationStatus` is `sanctioned` and the runtime will
 * reach the publisher. What the phase brief forbids is *bulk* ingestion, so the
 * connector takes a `maxFeatures` bound and the committed fixtures are synthetic.
 *
 * This is the Fabric's first snapshot source. It declares `snapshotSource`, which
 * turns on absence detection and count reconciliation in the shared runtime —
 * it does not fork the pipeline.
 */
import { fail } from '../../core/errors.ts';
import { contentDigest, sha256 } from '../../core/hash.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import { SNAPSHOT_CHANGE_KIND } from '../../canonical/snapshot.ts';
import {
  createArcGisSnapshotTransport,
  decodeSnapshotBundle,
  type SnapshotBundleHeader,
} from '../../runtime/arcgis.ts';
import type {
  BatchValidation,
  ChangeContext,
  Connector,
  StreamingConnector,
  StreamingParseSession,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  RecordValidation,
  SourceRelease,
} from '../../runtime/connector.ts';
import { createLocalFileTransport, type Transport } from '../../runtime/transport.ts';
import type { ValidationIssue } from '../../schema/xsd.ts';
import {
  HENNEPIN_ADAPTER_KEY,
  HENNEPIN_ASSESSOR_SOURCE_ID,
} from '../../registry/sources.ts';
import { HENNEPIN_FIELD_MAP, hennepinOutFields } from './field-map.ts';
import { HENNEPIN_COUNTY_FIPS, hennepinSourceRecordId, parseHennepinFeature } from './parse.ts';
import { HENNEPIN_NORMALIZATION_VERSION, normalizeHennepinParcel } from './normalize.ts';
import { openHennepinStream } from './stream.ts';
import { fieldGroupsOf } from './groups.ts';
import { createStreamingArcGisTransport } from '../../runtime/arcgis-stream.ts';

export const HENNEPIN_CONNECTOR_VERSION = 'mn_hennepin_connector_1';
export const HENNEPIN_PARSER_VERSION = 'mn_hennepin_parser_1';
export const HENNEPIN_SCHEMA_VERSION = 'hennepin_county_parcels_v1';

export const HENNEPIN_SERVICE_URL = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer';
export const HENNEPIN_LAYER_ID = 1;

/**
 * Digest of the field set this connector was written against, captured from the
 * service's own metadata on 2026-08-31. A provider-side schema change makes the
 * live digest differ from this one, which quarantines the run rather than
 * letting an unknown column flow through unclassified.
 */
export const PINNED_FIELD_SET_DIGEST = sha256(
  HENNEPIN_FIELD_MAP.map((f) => `${f.field}:${f.sourceType}:${f.maxLength ?? ''}`).sort().join('\n'),
);

const validations = new WeakMap<ParsedBatch, BatchValidation>();

export type HennepinLocalRelease = {
  readonly path: string;
  readonly referencePeriod: string;
  readonly releaseLabel?: string;
};

export type HennepinConnectorOptions = {
  /** Replay or fixture input: a snapshot bundle already on disk. */
  readonly localReleases?: readonly HennepinLocalRelease[];
  /** Live retrieval. `maxFeatures` keeps a proof small and the service unbothered. */
  readonly live?: {
    readonly referencePeriod: string;
    readonly maxFeatures?: number;
    readonly pageSize?: number;
    readonly fetchImpl?: typeof fetch;
  };
  readonly transport?: Transport;
  readonly sourceId?: string;
};

/**
 * The streaming Hennepin connector. Same adapter key, same versions, same
 * normalisation — only acquisition and parsing differ, so a bundle produced by
 * either path canonicalises identically.
 */
export function createStreamingHennepinConnector(
  options: HennepinConnectorOptions & {
    readonly fetchBatchSize?: number;
    readonly maxConcurrentRequests?: number;
  } = {},
): StreamingConnector {
  const base = createHennepinAssessorConnector(options);
  const transport = options.transport ?? (options.live
    ? createStreamingArcGisTransport({
      serviceUrl: HENNEPIN_SERVICE_URL,
      layerId: HENNEPIN_LAYER_ID,
      outFields: hennepinOutFields(),
      ...(options.live.maxFeatures !== undefined ? { maxFeatures: options.live.maxFeatures } : {}),
      ...(options.fetchBatchSize !== undefined ? { pageSize: options.fetchBatchSize } : {}),
      ...(options.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: options.maxConcurrentRequests } : {}),
      ...(options.live.fetchImpl !== undefined ? { fetchImpl: options.live.fetchImpl } : {}),
      userAgent: 'Reivesti-DataFabric/0.1 (+https://github.com/kindleops/reivesti-data-fabric)',
    })
    : base.transport);

  return {
    ...base,
    transport,
    streaming: true,
    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openHennepinStream(lines, {
        pinnedFieldSetDigest: PINNED_FIELD_SET_DIGEST,
        schemaVersion: HENNEPIN_SCHEMA_VERSION,
      });
    },
  };
}

export function createHennepinAssessorConnector(options: HennepinConnectorOptions = {}): Connector {
  const sourceId = options.sourceId ?? HENNEPIN_ASSESSOR_SOURCE_ID;

  const transport = options.transport ?? (options.live
    ? createArcGisSnapshotTransport({
      serviceUrl: HENNEPIN_SERVICE_URL,
      layerId: HENNEPIN_LAYER_ID,
      outFields: hennepinOutFields(),
      ...(options.live.maxFeatures !== undefined ? { maxFeatures: options.live.maxFeatures } : {}),
      ...(options.live.pageSize !== undefined ? { pageSize: options.live.pageSize } : {}),
      ...(options.live.fetchImpl !== undefined ? { fetchImpl: options.live.fetchImpl } : {}),
      userAgent: 'Reivesti-DataFabric/0.1 (+https://github.com/kindleops/reivesti-data-fabric)',
    })
    : createLocalFileTransport());

  return {
    adapterKey: HENNEPIN_ADAPTER_KEY,
    connectorVersion: HENNEPIN_CONNECTOR_VERSION,
    parserVersion: HENNEPIN_PARSER_VERSION,
    normalizationVersion: HENNEPIN_NORMALIZATION_VERSION,
    schemaVersion: HENNEPIN_SCHEMA_VERSION,
    transport,
    snapshotSource: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      const releases: DiscoveredRelease[] = [];

      for (const local of options.localReleases ?? []) {
        releases.push({
          release: makeRelease(sourceId, local.referencePeriod, local.releaseLabel),
          request: { locator: local.path, filename: local.path.split('/').pop() ?? 'snapshot.ndjson' },
        });
      }

      if (options.live) {
        releases.push({
          release: makeRelease(sourceId, options.live.referencePeriod),
          // The ArcGIS transport builds its own query; the locator is descriptive.
          request: { locator: `${HENNEPIN_SERVICE_URL}/${HENNEPIN_LAYER_ID}` },
        });
      }

      if (releases.length === 0) {
        fail('CONFIG', 'Hennepin connector has neither a local snapshot nor live retrieval configured', {
          sourceId,
          remedy: 'pass localReleases for a fixture/replay run, or live: { referencePeriod, maxFeatures } for a bounded live proof',
        });
      }
      return releases;
    },

    parse(ctx: ConnectorContext, bytes: Uint8Array): ParsedBatch {
      const { header, features } = decodeSnapshotBundle(bytes, 'hennepin-snapshot');
      const driftReasons = detectSchemaDrift(header);

      const records: ParsedRecord[] = [];
      const recordValidations: RecordValidation[] = [];
      const seen = new Map<string, string>();
      let duplicateCount = 0;

      features.forEach((attributes, index) => {
        const origin = `feature[${index}]`;
        const parsed = parseHennepinFeature(attributes, origin);
        const issues: ValidationIssue[] = [];

        // Two rows for one canonical PID is ambiguous source state. The layer
        // documents stacked multi-tax parcels as having *different* PIDs, so a
        // repeat is not something to silently deduplicate.
        const previous = seen.get(parsed.sourceRecordId);
        if (previous !== undefined) {
          duplicateCount += 1;
          issues.push({
            code: 'cardinality',
            path: '/PID',
            message: `duplicate parcel ${parsed.record.pid}, already read from ${previous}`,
          });
        }
        seen.set(parsed.sourceRecordId, origin);

        const groups = fieldGroupsOf(parsed.record);

        records.push({
          sourceRecordId: parsed.sourceRecordId,
          record: parsed.record as unknown as Readonly<Record<string, unknown>>,
          contentDigest: contentDigest(parsed.record),
          rawFragmentDigest: sha256(JSON.stringify(attributes)),
          fieldGroupDigests: groups,
        });
        recordValidations.push({ sourceRecordId: parsed.sourceRecordId, issues });
      });

      const batch: ParsedBatch = {
        records,
        schemaDigest: header.sourceSchemaDigest,
        schemaVersion: HENNEPIN_SCHEMA_VERSION,
        unknownFields: unknownFieldsIn(features),
        missingFields: [],
        snapshot: {
          sourceReportedCount: header.sourceReportedCount,
          retrievedCount: header.retrievedFeatureCount,
          duplicateCount,
          sourceSchemaDigest: header.sourceSchemaDigest,
        },
      };

      const unknown = batch.unknownFields;
      if (unknown.length > 0) {
        driftReasons.push(`unknown_field: the service returned ${unknown.length} field(s) with no mapping decision: ${unknown.slice(0, 5).join(', ')}`);
      }

      validations.set(batch, {
        schemaDrift: driftReasons.length > 0,
        driftReasons: [...new Set(driftReasons)].sort(),
        records: recordValidations,
      });

      ctx.logger.debug('hennepin.parsed', {
        features: features.length,
        records: records.length,
        duplicateCount,
        sourceReportedCount: header.sourceReportedCount,
      });
      return batch;
    },

    validate(_ctx: ConnectorContext, batch: ParsedBatch): BatchValidation {
      const v = validations.get(batch);
      if (!v) fail('CONFIG', 'validate() called with a batch this connector did not produce');
      return v;
    },

    normalize(
      _ctx: ConnectorContext,
      parsed: ParsedRecord,
      evidence: SourceEvidence,
      change: ChangeContext,
    ): NormalizeResult {
      const result = normalizeHennepinParcel(parsed.record as never, evidence, {
        sourceId,
        snapshotId: change.snapshotId ?? 'unsnapshotted',
        changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
        changedFieldGroups: change.changedFieldGroups,
      });
      return { bundle: result.bundle, contacts: result.contacts };
    },
  };
}

// ---------------------------------------------------------------------------

function makeRelease(sourceId: string, referencePeriod: string, label?: string): SourceRelease {
  return {
    releaseId: `${sourceId}__${referencePeriod}`,
    sourceId,
    releaseLabel: label ?? `Hennepin County Parcels ${referencePeriod}`,
    referencePeriod,
    publicationAt: null,
    // The county compiles the layer monthly and overwrites it; a given month's
    // extract is not reissued, but nothing in the service says so.
    finality: 'unknown',
    sourceVersion: HENNEPIN_SCHEMA_VERSION,
  };
}

function detectSchemaDrift(header: SnapshotBundleHeader): string[] {
  const reasons: string[] = [];
  const liveDigest = sha256(
    header.layerMetadata.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}:${f.length ?? ''}`).sort().join('\n'),
  );
  if (liveDigest !== PINNED_FIELD_SET_DIGEST) {
    reasons.push(
      `field_set_digest: the layer's field set no longer matches the pinned one `
      + `(pinned ${PINNED_FIELD_SET_DIGEST.slice(0, 12)}, live ${liveDigest.slice(0, 12)})`,
    );
  }
  if (header.missingObjectIds.length > 0) {
    reasons.push(`incomplete_crawl: ${header.missingObjectIds.length} requested object id(s) were not returned`);
  }
  return reasons;
}

/** Any attribute the service returned that has no mapping decision. */
function unknownFieldsIn(features: readonly Record<string, unknown>[]): readonly string[] {
  const known = new Set(HENNEPIN_FIELD_MAP.map((f) => f.field));
  const unknown = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature)) if (!known.has(key)) unknown.add(key);
  }
  return [...unknown].sort();
}

export { HENNEPIN_COUNTY_FIPS, hennepinSourceRecordId };
