/**
 * Wisconsin statewide parcel connector — 72 counties from one source.
 *
 * **Live retrieval status: PERMITTED, and unattended.** The Wisconsin State
 * Cartographer's Office publishes the Statewide Parcel Map as a free public
 * download — "This data is provided free of charge" — with a public
 * FeatureServer beside it. Neither needs an account, a session, a token or a
 * CAPTCHA; both were re-verified anonymously on 2026-09-28. DF-0J.1A's
 * activation evaluator returns `CORE_ELIGIBLE` from the registry facts alone.
 *
 * ## Acquisition is not this module's job
 *
 * A scheduler runs `pipeline.ts`: discover → plan (NOOP if already ingested) →
 * download the archive into the artifact store → derive the bundle from the
 * retained archive → hand the bundle to the streaming runtime. By the time this
 * connector sees a byte, the publisher's archive is already retained and
 * verified. Its job is the semantics: parse, route, normalise.
 *
 * ## What this source is, and is not
 *
 * It is 72 county and municipal assessment rolls, aggregated annually by the
 * state under one schema. It is authoritative for parcel identity and carries
 * assessment, tax, ownership-of-record and situs detail.
 *
 * It is **not** a transfer source and carries no sale echo at all: the V12
 * schema has no sale date or sale price. Wisconsin transfer coverage remains a
 * gap — see docs/WISCONSIN-RETR.md — and nothing here pretends otherwise.
 */
import { fail } from '../../core/errors.ts';
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
import { fieldSetDigestOf, openArcGisSnapshotStream } from '../../runtime/arcgis-session.ts';
import { createLocalFileTransport } from '../../runtime/transport.ts';
import { WI_STATEWIDE_ADAPTER_KEY, WI_STATEWIDE_SOURCE_ID } from '../../registry/sources.ts';
import { WI_STATEWIDE_FIELD_MAP, wiStatewideKnownFields } from './field-map.ts';
import { parseWiStatewideFeature, type WiStatewideParcelRecord } from './parse.ts';
import {
  WI_STATEWIDE_NORMALIZATION_VERSION,
  normalizeWiStatewideParcel,
  wiStatewideFieldGroups,
} from './normalize.ts';
import { FILEGDB_BUNDLE_KIND } from './bundle.ts';

export { WI_STATEWIDE_ADAPTER_KEY, WI_STATEWIDE_SOURCE_ID };

export const WI_STATEWIDE_CONNECTOR_VERSION = 'wi_statewide_connector_1';
export const WI_STATEWIDE_PARSER_VERSION = 'wi_statewide_parser_1';
/** The SCO statewide parcel schema this connector was written against. */
export const WI_STATEWIDE_SCHEMA_VERSION = 'wi_sco_statewide_parcels_v12';
/** The release the field map was captured from. A different one must pass the drift check. */
export const WI_PINNED_REFERENCE_PERIOD = 'V12.0.0-2026';

/**
 * Digest of the geodatabase field set the field map was written against,
 * captured from the V12 archive on 2026-09-28. A publisher schema change makes
 * the bundle's digest differ, which quarantines the run before a row is read.
 */
export const WI_PINNED_FIELD_SET_DIGEST = fieldSetDigestOf(
  WI_STATEWIDE_FIELD_MAP.map((f) => ({ name: f.field, type: f.sourceType, ...(f.maxLength !== undefined ? { length: f.maxLength } : {}) })),
);

export type WiStatewideConnectorOptions = {
  /** A snapshot bundle derived from the retained archive. */
  readonly localFile?: string;
  readonly referencePeriod?: string;
  readonly sourceId?: string;
};

export function createWiStatewideParcelConnector(
  options: WiStatewideConnectorOptions = {},
): StreamingConnector {
  const sourceId = options.sourceId ?? WI_STATEWIDE_SOURCE_ID;

  const base: Connector = {
    adapterKey: WI_STATEWIDE_ADAPTER_KEY,
    connectorVersion: WI_STATEWIDE_CONNECTOR_VERSION,
    parserVersion: WI_STATEWIDE_PARSER_VERSION,
    normalizationVersion: WI_STATEWIDE_NORMALIZATION_VERSION,
    schemaVersion: WI_STATEWIDE_SCHEMA_VERSION,
    // Bytes reach this connector from the artifact store only. The pipeline
    // performs the one sanctioned network acquisition, before this runs.
    transport: createLocalFileTransport(),
    /**
     * A state of the world restated once a year. A parcel leaving the layer
     * means it was retired, merged or renumbered by its county — never that the
     * land ceased to exist — and absence is recorded as exactly that.
     */
    snapshotSource: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      if (!options.localFile) {
        fail('CONFIG', 'the Wisconsin statewide connector reads bundles derived by the acquisition pipeline', {
          sourceId,
          remedy: 'run `df auto wi_statewide_parcels__all_wi_counties`, which discovers, acquires and derives unattended',
        });
      }
      const referencePeriod = options.referencePeriod ?? WI_PINNED_REFERENCE_PERIOD;
      return [{
        release: {
          releaseId: `${sourceId}__${referencePeriod}`,
          sourceId,
          releaseLabel: `Wisconsin Statewide Parcel Map ${referencePeriod}`,
          referencePeriod,
          publicationAt: null,
          finality: 'final',
          sourceVersion: WI_STATEWIDE_SCHEMA_VERSION,
        },
        request: { locator: options.localFile, filename: 'wi-statewide-parcels.bundle.ndjson' },
      }];
    },

    // 3.5 million rows are never read into memory; the buffered path is refused.
    parse(): ParsedBatch {
      return fail('CONFIG', 'the WI statewide connector is streaming; the runtime must call openStream');
    },
    validate(): BatchValidation {
      return fail('CONFIG', 'the WI statewide connector is streaming; the runtime must call openStream');
    },

    normalize(
      _ctx: ConnectorContext,
      parsed: ParsedRecord,
      evidence: SourceEvidence,
      change: ChangeContext,
    ): NormalizeResult {
      const result = normalizeWiStatewideParcel(
        parsed.record as unknown as WiStatewideParcelRecord,
        evidence,
        {
          sourceId,
          snapshotId: change.snapshotId ?? `${sourceId}__unsnapshotted`,
          changeKind: SNAPSHOT_CHANGE_KIND[change.kind],
          changedFieldGroups: change.changedFieldGroups,
        },
      );
      return { bundle: result.bundle, contacts: result.contacts };
    },
  };

  return {
    ...base,
    streaming: true,
    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      return openArcGisSnapshotStream<WiStatewideParcelRecord>(lines, {
        schemaVersion: WI_STATEWIDE_SCHEMA_VERSION,
        pinnedFieldSetDigest: WI_PINNED_FIELD_SET_DIGEST,
        knownFields: wiStatewideKnownFields(),
        parseFeature: (attributes, origin) => parseWiStatewideFeature(attributes, origin),
        fieldGroups: (record) => wiStatewideFieldGroups(record),
        // OBJECTID is the row's position in the geodatabase and is reassigned by
        // every release; it is retained on the row and excluded from change
        // detection, or every parcel would read as revised every year.
        contentOf: ({ sourceObjectId: _volatile, ...stable }) => stable,
        identityPath: '/PARCELID',
        identityOf: (record) => `parcel ${record.countyFips}:${record.parcelId}`,
        // County-scoped identity, county-scoped snapshot indexes: one statewide
        // release touches 72 small indexes, and a county's absences are answered
        // from that county's own prior state.
        partitionOf: (record) => record.countyFips,
        acceptedKinds: [FILEGDB_BUNDLE_KIND],
        // 58,203 of 3.57 million rows are feature labels, an empty id or an
        // uncatalogued county. Each is quarantined individually and counted;
        // failing the state because of them would be the wrong trade.
        quarantineUnparseableRows: true,
      });
    },
  };
}
