/**
 * New York statewide parcel connector — 62 counties from one source.
 *
 * **Live retrieval status: PERMITTED, and unattended.** NYS ITS Geospatial
 * Services publishes the Statewide Tax Parcel Centroid Points as a public
 * download beside a public FeatureServer ("This map service is available to the
 * public"). Neither needs an account, a session, a token or a CAPTCHA; both
 * were re-verified anonymously on 2026-09-29. The activation evaluator returns
 * `CORE_ELIGIBLE` from the registry facts alone.
 *
 * ## Acquisition is not this module's job
 *
 * A scheduler runs `pipeline.ts`: discover (through the 2026 GeoHub migration)
 * → plan (NOOP if already ingested) → download the archive into the artifact
 * store → derive the bundle from the retained archive → hand the bundle to the
 * streaming runtime. By the time this connector sees a byte, the publisher's
 * archive is retained and verified. Its job is the semantics: parse, route,
 * normalise.
 *
 * ## What this source is, and is not
 *
 * It is 62 counties' assessment rolls — ORPTS roll attributes on the Statewide
 * Parcel Map program's parcels, and NYC MapPLUTO for the five boroughs —
 * aggregated annually by the state under one schema. It is authoritative for
 * parcel identity and carries assessed and full market values, property class,
 * residential inventory, owner names and owner mailing addresses.
 *
 * It is **not** a transfer source and carries no tax amount: no sale date, no
 * sale price, no levy. Its deed book/page is a pointer, not a transfer.
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
import { NY_STATEWIDE_ADAPTER_KEY, NY_STATEWIDE_SOURCE_ID } from '../../registry/sources.ts';
import { NY_STATEWIDE_FIELD_MAP, nyStatewideKnownFields } from './field-map.ts';
import { parseNyStatewideFeature, type NyStatewideParcelRecord } from './parse.ts';
import {
  NY_STATEWIDE_NORMALIZATION_VERSION,
  normalizeNyStatewideParcel,
  nyStatewideFieldGroups,
} from './normalize.ts';
import { NY_BUNDLE_FILENAME, NY_FILEGDB_BUNDLE_KIND } from './bundle.ts';

export { NY_STATEWIDE_ADAPTER_KEY, NY_STATEWIDE_SOURCE_ID };

export const NY_STATEWIDE_CONNECTOR_VERSION = 'ny_statewide_connector_1';
export const NY_STATEWIDE_PARSER_VERSION = 'ny_statewide_parser_1';
/** The NYS standardized tax parcel schema this connector was written against. */
export const NY_STATEWIDE_SCHEMA_VERSION = 'nys_tax_parcel_centroid_points_2025';
/** The release the field map was captured from. A different one must pass the drift check. */
export const NY_PINNED_REFERENCE_PERIOD = '2025-2605';

/**
 * Digest of the geodatabase field set the field map was written against,
 * captured from the 2025-roll archive on 2026-09-29 (equal to the GeoHub
 * FeatureServer's). A publisher schema change makes the bundle's digest differ,
 * which quarantines the run before a row is read.
 */
export const NY_PINNED_FIELD_SET_DIGEST = fieldSetDigestOf(
  NY_STATEWIDE_FIELD_MAP.map((f) => ({ name: f.field, type: f.sourceType, ...(f.maxLength !== undefined ? { length: f.maxLength } : {}) })),
);

export type NyStatewideConnectorOptions = {
  /** A snapshot bundle derived from the retained archive. */
  readonly localFile?: string;
  readonly referencePeriod?: string;
  readonly sourceId?: string;
};

export function createNyStatewideParcelConnector(
  options: NyStatewideConnectorOptions = {},
): StreamingConnector {
  const sourceId = options.sourceId ?? NY_STATEWIDE_SOURCE_ID;

  const base: Connector = {
    adapterKey: NY_STATEWIDE_ADAPTER_KEY,
    connectorVersion: NY_STATEWIDE_CONNECTOR_VERSION,
    parserVersion: NY_STATEWIDE_PARSER_VERSION,
    normalizationVersion: NY_STATEWIDE_NORMALIZATION_VERSION,
    schemaVersion: NY_STATEWIDE_SCHEMA_VERSION,
    // Bytes reach this connector from the artifact store only. The pipeline
    // performs the one sanctioned network acquisition, before this runs.
    transport: createLocalFileTransport(),
    /**
     * A state of the world restated once a year. A parcel leaving the roll
     * means it was merged, split or renumbered — never that the land ceased to
     * exist — and absence is recorded as exactly that.
     */
    snapshotSource: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      if (!options.localFile) {
        fail('CONFIG', 'the New York statewide connector reads bundles derived by the acquisition pipeline', {
          sourceId,
          remedy: 'run `df auto ny_statewide_parcels__all_ny_counties`, which discovers, acquires and derives unattended',
        });
      }
      const referencePeriod = options.referencePeriod ?? NY_PINNED_REFERENCE_PERIOD;
      return [{
        release: {
          releaseId: `${sourceId}__${referencePeriod}`,
          sourceId,
          releaseLabel: `NYS Tax Parcel Centroid Points ${referencePeriod}`,
          referencePeriod,
          publicationAt: null,
          finality: 'final',
          sourceVersion: NY_STATEWIDE_SCHEMA_VERSION,
        },
        request: { locator: options.localFile, filename: NY_BUNDLE_FILENAME },
      }];
    },

    // 5.5 million rows are never read into memory; the buffered path is refused.
    parse(): ParsedBatch {
      return fail('CONFIG', 'the NY statewide connector is streaming; the runtime must call openStream');
    },
    validate(): BatchValidation {
      return fail('CONFIG', 'the NY statewide connector is streaming; the runtime must call openStream');
    },

    normalize(
      _ctx: ConnectorContext,
      parsed: ParsedRecord,
      evidence: SourceEvidence,
      change: ChangeContext,
    ): NormalizeResult {
      const result = normalizeNyStatewideParcel(
        parsed.record as unknown as NyStatewideParcelRecord,
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
      return openArcGisSnapshotStream<NyStatewideParcelRecord>(lines, {
        schemaVersion: NY_STATEWIDE_SCHEMA_VERSION,
        pinnedFieldSetDigest: NY_PINNED_FIELD_SET_DIGEST,
        knownFields: nyStatewideKnownFields(),
        parseFeature: (attributes, origin) => parseNyStatewideFeature(attributes, origin),
        fieldGroups: (record) => nyStatewideFieldGroups(record),
        // OBJECTID and ORIG_FID are row positions in this build and the one it
        // was generated from; both are reassigned every year. Retained on the
        // row, excluded from change detection, or every parcel would read as
        // revised every release.
        contentOf: ({ sourceObjectId: _row, sourceOrigFid: _origin, ...stable }) => stable,
        identityPath: '/SBL',
        identityOf: (record) => `parcel ${record.countyFips}:${record.swis}/${record.sbl}`,
        // County-scoped identity, county-scoped snapshot indexes: one statewide
        // release touches 62 indexes, and a county's absences are answered from
        // that county's own prior state.
        partitionOf: (record) => record.countyFips,
        acceptedKinds: [NY_FILEGDB_BUNDLE_KIND],
        // ~6,600 of 5.5 million rows have no SBL, a label for one, or no roll
        // record behind them. Each is quarantined individually and counted;
        // failing the state because of them would be the wrong trade.
        quarantineUnparseableRows: true,
      });
    },
  };
}
