/**
 * ArcGIS REST FeatureServer / MapServer snapshot transport.
 *
 * The naive approach — `resultOffset` paging until a short page comes back — is
 * wrong for a 448,000-feature layer. Offsets are evaluated against the live
 * table, so a single edit mid-crawl silently shifts every later page: rows get
 * skipped, rows get duplicated, and nothing in the output says so.
 *
 * This client instead does what the service is actually good at:
 *
 *   1. Capture service and layer metadata, and digest it. A provider-side schema
 *      change between snapshots becomes a visible digest change.
 *   2. Ask for the total count. Without it, "we ingested the whole county" is an
 *      assertion rather than a measurement.
 *   3. Fetch the complete OBJECTID list in one request (`returnIdsOnly`). That
 *      pins the snapshot's membership at a single instant.
 *   4. Fetch attributes in explicit `objectIds=` batches. Every batch names
 *      exactly the rows it wants, so a concurrent edit can cause a row to be
 *      *missing* — which is detected and reported — but never silently swapped
 *      for a different one.
 *   5. Reconcile: ids requested vs features returned vs count reported.
 *
 * The assembled artifact is deterministic NDJSON ordered by OBJECTID, so the
 * same source state always digests to the same artifact.
 */
import { fail } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import type { Logger } from '../core/logging.ts';
import { type RateLimiter, type RetryPolicy, type Sleep, noRateLimit, withRetry } from './retry.ts';
import type { FetchedPayload, FetchRequest, Transport, TransportContext } from './transport.ts';

export const SNAPSHOT_BUNDLE_KIND = 'df.arcgis.snapshot/1';

export type ArcGisField = {
  readonly name: string;
  readonly type: string;
  readonly alias?: string;
  readonly length?: number;
};

export type ArcGisLayerMetadata = {
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly name: string;
  readonly geometryType: string | null;
  readonly objectIdField: string;
  readonly maxRecordCount: number;
  readonly supportsPagination: boolean;
  readonly fields: readonly ArcGisField[];
  readonly spatialReferenceWkid: number | null;
  readonly copyrightText: string | null;
};

/** Header line of the artifact: everything needed to interpret and replay it. */
export type SnapshotBundleHeader = {
  readonly kind: typeof SNAPSHOT_BUNDLE_KIND;
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly capturedAt: string;
  readonly objectIdField: string;
  readonly outFields: readonly string[];
  /** Count the service reported for the same `where` clause. */
  readonly sourceReportedCount: number | null;
  readonly requestedIdCount: number;
  readonly retrievedFeatureCount: number;
  /** Ids we asked for and the service did not return. Empty on a clean crawl. */
  readonly missingObjectIds: readonly number[];
  /** Digest of the layer's field definitions: the source schema fingerprint. */
  readonly sourceSchemaDigest: string;
  readonly layerMetadata: ArcGisLayerMetadata;
  /** Set when the crawl was deliberately bounded, e.g. a live smoke proof. */
  readonly boundedTo: number | null;
  readonly whereClause: string;
};

export type ArcGisTransportOptions = {
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly outFields?: readonly string[];
  readonly whereClause?: string;
  /** Hard cap on features retrieved. Used to keep live proofs small and polite. */
  readonly maxFeatures?: number;
  /** Overrides the layer's own maxRecordCount downward, never upward. */
  readonly pageSize?: number;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
};

type ArcGisJson = Record<string, unknown>;

export function createArcGisSnapshotTransport(options: ArcGisTransportOptions): Transport {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const layerUrl = `${options.serviceUrl.replace(/\/+$/, '')}/${options.layerId}`;
  const where = options.whereClause ?? '1=1';

  return {
    accessType: 'api',
    reachesPublisher: true,

    async fetch(_request: FetchRequest, ctx: TransportContext): Promise<FetchedPayload> {
      const limiter = ctx.rateLimiter ?? noRateLimit;
      // Metadata is a GET; every /query call is a POST. An explicit objectIds
      // batch plus ~120 outFields is several kilobytes, which overruns the URL
      // length limits proxies and IIS enforce — the service answers 404 rather
      // than 414, so the failure is not self-explanatory when it happens.
      const get = (url: string, params: Record<string, string>): Promise<ArcGisJson> =>
        arcgisRequest(doFetch, url, params, 'GET', ctx, limiter, options.userAgent);
      const query = (params: Record<string, string>): Promise<ArcGisJson> =>
        arcgisRequest(doFetch, `${layerUrl}/query`, params, 'POST', ctx, limiter, options.userAgent);

      // 1. Layer metadata, and its digest.
      const rawLayer = await get(layerUrl, { f: 'json' });
      const layer = readLayerMetadata(rawLayer, options.serviceUrl, options.layerId);
      const outFields = options.outFields ?? layer.fields.map((f) => f.name);
      const sourceSchemaDigest = sha256(canonicalJson(
        layer.fields.map((f) => ({ name: f.name, type: f.type, length: f.length ?? null })),
      ));

      // 2. The count the source reports for this query.
      const countJson = await query({ where, returnCountOnly: 'true', f: 'json' });
      const sourceReportedCount = typeof countJson['count'] === 'number' ? (countJson['count'] as number) : null;

      // 3. The complete id list, pinning snapshot membership at one instant.
      const idsJson = await query({ where, returnIdsOnly: 'true', f: 'json' });
      const allIds = readObjectIds(idsJson);
      const bounded = options.maxFeatures !== undefined && options.maxFeatures < allIds.length;
      const ids = bounded ? allIds.slice(0, options.maxFeatures) : allIds;

      ctx.logger.info('arcgis.snapshot_planned', {
        layer: layer.name,
        sourceReportedCount,
        idsReturned: allIds.length,
        idsRequested: ids.length,
        bounded,
        maxRecordCount: layer.maxRecordCount,
      });

      // 4. Attributes in explicit id batches.
      const pageSize = Math.min(options.pageSize ?? layer.maxRecordCount, layer.maxRecordCount);
      if (pageSize < 1) fail('CONFIG', `layer ${layerUrl} reports an unusable maxRecordCount`);

      const features = new Map<number, Record<string, unknown>>();
      for (let i = 0; i < ids.length; i += pageSize) {
        const batch = ids.slice(i, i + pageSize);
        const page = await query({
          objectIds: batch.join(','),
          outFields: outFields.join(','),
          returnGeometry: 'false',
          f: 'json',
        });
        for (const feature of readFeatures(page)) {
          const oid = feature[layer.objectIdField];
          if (typeof oid !== 'number') {
            fail('PARSE', `ArcGIS feature is missing its ${layer.objectIdField}`, { layerUrl });
          }
          // Explicit id batches make this impossible unless the service
          // misbehaves; asserting it means we would find out if it did.
          if (features.has(oid)) {
            fail('PARSE', `ArcGIS returned ${layer.objectIdField}=${oid} more than once`, { layerUrl });
          }
          features.set(oid, feature);
        }
        ctx.logger.debug('arcgis.page', { from: i, size: batch.length, total: features.size });
      }

      // 5. Reconcile.
      const missingObjectIds = ids.filter((id) => !features.has(id));
      if (missingObjectIds.length > 0) {
        ctx.logger.warn('arcgis.incomplete_snapshot', {
          requested: ids.length,
          retrieved: features.size,
          missing: missingObjectIds.length,
        });
      }

      const header: SnapshotBundleHeader = {
        kind: SNAPSHOT_BUNDLE_KIND,
        serviceUrl: options.serviceUrl,
        layerId: options.layerId,
        // The service is the clock here: the snapshot is as of when we asked it.
        capturedAt: new Date(0).toISOString(),
        objectIdField: layer.objectIdField,
        outFields: [...outFields].sort(),
        sourceReportedCount,
        requestedIdCount: ids.length,
        retrievedFeatureCount: features.size,
        missingObjectIds,
        sourceSchemaDigest,
        layerMetadata: layer,
        boundedTo: bounded ? (options.maxFeatures as number) : null,
        whereClause: where,
      };

      return {
        bytes: encodeSnapshotBundle(header, [...features.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f)),
        originalUrl: `${layerUrl}/query`,
        originalFilename: `${slug(layer.name)}-snapshot.ndjson`,
        mimeType: 'application/x-ndjson',
        effectiveAt: null,
      };
    },
  };
}

/**
 * Deterministic NDJSON: a header line then one canonical-JSON feature per line,
 * ordered by OBJECTID. Identical source state produces identical bytes, which is
 * what makes the artifact digest meaningful.
 *
 * `capturedAt` is deliberately excluded from the encoded header (it is written
 * as the epoch) so that two crawls of an unchanged layer dedupe to one artifact
 * instead of creating a new one per run. The real capture time lives on the run
 * and on the retrieval manifest, where a changing value is correct.
 */
export function encodeSnapshotBundle(
  header: SnapshotBundleHeader,
  features: readonly Record<string, unknown>[],
): Uint8Array {
  const lines = [canonicalJson(header), ...features.map((f) => canonicalJson(f))];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

export type DecodedSnapshotBundle = {
  readonly header: SnapshotBundleHeader;
  readonly features: readonly Record<string, unknown>[];
};

export function decodeSnapshotBundle(bytes: Uint8Array, origin: string): DecodedSnapshotBundle {
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.split('\n').filter((l) => l.length > 0);
  const first = lines[0];
  if (!first) fail('PARSE', `${origin}: snapshot bundle is empty`);

  let header: SnapshotBundleHeader;
  try {
    header = JSON.parse(first) as SnapshotBundleHeader;
  } catch (e) {
    return fail('PARSE', `${origin}: snapshot bundle header is not JSON: ${(e as Error).message}`);
  }
  if (header.kind !== SNAPSHOT_BUNDLE_KIND) {
    fail('PARSE', `${origin}: unexpected bundle kind "${String(header.kind)}"`);
  }

  const features = lines.slice(1).map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      return fail('PARSE', `${origin}: feature ${index + 1} is not JSON: ${(e as Error).message}`);
    }
  });
  return { header, features };
}

// ---------------------------------------------------------------------------

async function arcgisRequest(
  doFetch: typeof fetch,
  url: string,
  params: Record<string, string>,
  method: 'GET' | 'POST',
  ctx: TransportContext,
  limiter: RateLimiter,
  userAgent: string | undefined,
): Promise<ArcGisJson> {
  const body = new URLSearchParams(params).toString();
  return withRetry(
    async () => {
      await limiter.acquire();
      const headers: Record<string, string> = userAgent ? { 'user-agent': userAgent } : {};
      if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
      const response = await doFetch(
        method === 'POST' ? url : `${url}?${body}`,
        method === 'POST' ? { method: 'POST', headers, body } : { headers },
      ).catch((e: unknown) => fail('TRANSPORT', `ArcGIS request failed: ${(e as Error).message}`, { url }));

      if (!response.ok) fail('TRANSPORT', `ArcGIS returned HTTP ${response.status} for ${url}`, { url, status: response.status });

      const text = await response.text();
      let json: ArcGisJson;
      try {
        json = JSON.parse(text) as ArcGisJson;
      } catch {
        return fail('TRANSPORT', `ArcGIS returned non-JSON from ${url}`, { url, body: text.slice(0, 200) });
      }
      // ArcGIS reports errors with HTTP 200 and an `error` body, so a status
      // check alone is not enough to know the request succeeded.
      if (json['error']) {
        const error = json['error'] as { code?: number; message?: string };
        fail('TRANSPORT', `ArcGIS error ${error.code ?? '?'}: ${error.message ?? 'unknown'}`, { url });
      }
      return json;
    },
    {
      logger: ctx.logger,
      label: `arcgis:${url}`,
      ...(ctx.retryPolicy ? { policy: ctx.retryPolicy } : {}),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    },
  );
}

function readLayerMetadata(json: ArcGisJson, serviceUrl: string, layerId: number): ArcGisLayerMetadata {
  const rawFields = Array.isArray(json['fields']) ? (json['fields'] as ArcGisJson[]) : [];
  if (rawFields.length === 0) fail('CONFIG', `ArcGIS layer ${serviceUrl}/${layerId} exposes no fields`);

  const fields: ArcGisField[] = rawFields.map((f) => ({
    name: String(f['name']),
    type: String(f['type']),
    ...(f['alias'] !== undefined ? { alias: String(f['alias']) } : {}),
    ...(typeof f['length'] === 'number' ? { length: f['length'] } : {}),
  }));

  // Some services omit `objectIdField`; the OID-typed field is authoritative.
  const declared = typeof json['objectIdField'] === 'string' ? (json['objectIdField'] as string) : null;
  const oidField = declared ?? fields.find((f) => f.type === 'esriFieldTypeOID')?.name;
  if (!oidField) fail('CONFIG', `ArcGIS layer ${serviceUrl}/${layerId} has no object id field`);

  const advanced = (json['advancedQueryCapabilities'] ?? {}) as ArcGisJson;
  const sr = (json['extent'] as ArcGisJson | undefined)?.['spatialReference'] as ArcGisJson | undefined;

  return {
    serviceUrl,
    layerId,
    name: String(json['name'] ?? `layer${layerId}`),
    geometryType: typeof json['geometryType'] === 'string' ? (json['geometryType'] as string) : null,
    objectIdField: oidField,
    maxRecordCount: typeof json['maxRecordCount'] === 'number' ? (json['maxRecordCount'] as number) : 1000,
    supportsPagination: advanced['supportsPagination'] === true,
    fields,
    spatialReferenceWkid: typeof sr?.['latestWkid'] === 'number'
      ? (sr['latestWkid'] as number)
      : typeof sr?.['wkid'] === 'number' ? (sr['wkid'] as number) : null,
    copyrightText: typeof json['copyrightText'] === 'string' ? (json['copyrightText'] as string) : null,
  };
}

function readObjectIds(json: ArcGisJson): readonly number[] {
  const ids = json['objectIds'];
  if (!Array.isArray(ids)) fail('TRANSPORT', 'ArcGIS returnIdsOnly response has no objectIds array');
  const numbers = (ids as unknown[]).map((v) => {
    if (typeof v !== 'number') fail('TRANSPORT', `ArcGIS returned a non-numeric object id: ${String(v)}`);
    return v;
  });
  // Sorted so the crawl order — and therefore any bounded slice — is stable.
  return [...numbers].sort((a, b) => a - b);
}

function readFeatures(json: ArcGisJson): readonly Record<string, unknown>[] {
  const features = json['features'];
  if (!Array.isArray(features)) fail('TRANSPORT', 'ArcGIS query response has no features array');
  return (features as ArcGisJson[]).map((f) => {
    const attributes = f['attributes'];
    if (!attributes || typeof attributes !== 'object') fail('TRANSPORT', 'ArcGIS feature has no attributes');
    return attributes as Record<string, unknown>;
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
}
