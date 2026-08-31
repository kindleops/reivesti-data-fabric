/**
 * Streaming ArcGIS snapshot transport.
 *
 * DF-0C's transport was correct and unscalable: it collected every feature into
 * a `Map`, copied that to an array, mapped it to N canonical-JSON strings,
 * joined them into one giant string and encoded that into one giant buffer —
 * four whole-county copies alive at the same moment.
 *
 * This version writes each batch to the artifact sink as it arrives and keeps
 * only a bounded window in memory. The deterministic strategy from DF-0C is
 * preserved exactly: metadata, count, OBJECTID inventory, explicit `objectIds`
 * batches, reconciliation.
 *
 * The artifact format gains a trailer, because reconciliation facts are not
 * known until the last byte:
 *
 *   line 1     header   service and layer metadata, schema digest, reported count
 *   lines 2..n features  one canonical-JSON attribute object, OBJECTID ascending
 *   last line  trailer   retrieved count, missing ids, end-of-crawl source count
 *
 * The reader takes the last line as the trailer using one line of lookahead, so
 * reconciliation evidence is inside the hashed artifact and cannot be edited
 * independently of the data it describes.
 */
import { fail } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import type { ByteSink } from '../archive/object-store.ts';
import type { ArcGisField, ArcGisLayerMetadata } from './arcgis.ts';
import { type RateLimiter, noRateLimit, withRetry } from './retry.ts';
import type { FetchRequest, Transport, TransportContext } from './transport.ts';

export const SNAPSHOT_BUNDLE_KIND_V2 = 'df.arcgis.snapshot/2';
export const SNAPSHOT_TRAILER_KIND = 'df.arcgis.snapshot.trailer/2';

export type StreamingSnapshotHeader = {
  readonly kind: typeof SNAPSHOT_BUNDLE_KIND_V2;
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly objectIdField: string;
  readonly outFields: readonly string[];
  readonly whereClause: string;
  /** Count the service reported before the crawl started. */
  readonly sourceReportedCount: number | null;
  readonly requestedIdCount: number;
  readonly sourceSchemaDigest: string;
  readonly layerMetadata: ArcGisLayerMetadata;
  readonly boundedTo: number | null;
};

export type StreamingSnapshotTrailer = {
  readonly kind: typeof SNAPSHOT_TRAILER_KIND;
  readonly retrievedFeatureCount: number;
  readonly missingObjectIds: readonly number[];
  /**
   * The count re-queried after the crawl. A layer that changed underneath a
   * long crawl is a real condition, not a rounding error, and it must not be
   * reported as a complete read.
   */
  readonly sourceReportedCountAtEnd: number | null;
  readonly sourceChangedDuringRead: boolean;
};

export type StreamingTransport = Transport & {
  readonly streaming: true;
  fetchStream(
    request: FetchRequest,
    ctx: TransportContext,
    sink: ByteSink,
  ): Promise<StreamedSnapshotResult>;
};

export type StreamedSnapshotResult = {
  readonly originalUrl: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly effectiveAt: string | null;
  readonly header: StreamingSnapshotHeader;
  readonly trailer: StreamingSnapshotTrailer;
};

export type StreamingArcGisOptions = {
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly outFields?: readonly string[];
  readonly whereClause?: string;
  readonly maxFeatures?: number;
  /** Rows per query. Clamped to the layer's own maxRecordCount. */
  readonly pageSize?: number;
  /**
   * Requests in flight at once. Output order is preserved regardless, so this
   * changes throughput and never results. Kept small by default: a county
   * open-data service is not a load-test target.
   */
  readonly maxConcurrentRequests?: number;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
};

export const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;

type ArcGisJson = Record<string, unknown>;

export function createStreamingArcGisTransport(options: StreamingArcGisOptions): StreamingTransport {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const layerUrl = `${options.serviceUrl.replace(/\/+$/, '')}/${options.layerId}`;
  const where = options.whereClause ?? '1=1';
  const concurrency = Math.max(1, options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS);

  const transport: StreamingTransport = {
    accessType: 'api',
    reachesPublisher: true,
    streaming: true,

    async fetch() {
      return fail('CONFIG', 'this transport is streaming; the runtime must call fetchStream');
    },

    async fetchStream(_request, ctx, sink) {
      const limiter = ctx.rateLimiter ?? noRateLimit;
      const get = (url: string, params: Record<string, string>): Promise<ArcGisJson> =>
        request(doFetch, url, params, 'GET', ctx, limiter, options.userAgent);
      const query = (params: Record<string, string>): Promise<ArcGisJson> =>
        request(doFetch, `${layerUrl}/query`, params, 'POST', ctx, limiter, options.userAgent);

      // 1. Layer metadata and its digest.
      const layer = readLayerMetadata(await get(layerUrl, { f: 'json' }), options.serviceUrl, options.layerId);
      const outFields = options.outFields ?? layer.fields.map((f) => f.name);
      const sourceSchemaDigest = sha256(canonicalJson(
        layer.fields.map((f) => ({ name: f.name, type: f.type, length: f.length ?? null })),
      ));

      // 2. Count before the crawl.
      const countBefore = readCount(await query({ where, returnCountOnly: 'true', f: 'json' }));

      // 3. OBJECTID inventory, pinning membership at one instant.
      //
      // This is the one whole-dataset structure that stays in memory, and it is
      // deliberate: the service offers no cursor, so the id list is how the
      // snapshot's membership is fixed. As an Int32Array it costs 4 bytes per
      // feature — about 1.8 MB for Hennepin — which is bounded and negligible
      // next to the 1.1 GB of attribute data it governs.
      const allIds = readObjectIds(await query({ where, returnIdsOnly: 'true', f: 'json' }));
      const bounded = options.maxFeatures !== undefined && options.maxFeatures < allIds.length;
      const ids = bounded ? allIds.subarray(0, options.maxFeatures) : allIds;

      const pageSize = Math.min(options.pageSize ?? layer.maxRecordCount, layer.maxRecordCount);
      if (pageSize < 1) fail('CONFIG', `layer ${layerUrl} reports an unusable maxRecordCount`);

      const header: StreamingSnapshotHeader = {
        kind: SNAPSHOT_BUNDLE_KIND_V2,
        serviceUrl: options.serviceUrl,
        layerId: options.layerId,
        objectIdField: layer.objectIdField,
        outFields: [...outFields].sort(),
        whereClause: where,
        sourceReportedCount: countBefore,
        requestedIdCount: ids.length,
        sourceSchemaDigest,
        layerMetadata: layer,
        boundedTo: bounded ? (options.maxFeatures as number) : null,
      };
      await sink.write(`${canonicalJson(header)}\n`);

      ctx.logger.info('arcgis.stream_planned', {
        layer: layer.name,
        sourceReportedCount: countBefore,
        idsRequested: ids.length,
        pageSize,
        concurrency,
        idIndexBytes: ids.byteLength,
      });

      // 4. Crawl with a bounded in-flight window, writing in OBJECTID order.
      const batchCount = Math.ceil(ids.length / pageSize);
      const fetchBatch = async (index: number): Promise<Record<string, unknown>[]> => {
        const from = index * pageSize;
        const batch = Array.from(ids.subarray(from, Math.min(from + pageSize, ids.length)));
        const page = await query({
          objectIds: batch.join(','),
          outFields: outFields.join(','),
          returnGeometry: 'false',
          f: 'json',
        });
        const features = readFeatures(page, layer.objectIdField);
        // Sorting within the batch, combined with ascending batch order, gives
        // global OBJECTID order without ever sorting the whole county.
        features.sort((a, b) => (a[layer.objectIdField] as number) - (b[layer.objectIdField] as number));
        return features;
      };

      let retrievedFeatureCount = 0;
      const seenIds = new Set<number>();
      const missingObjectIds: number[] = [];

      await forEachOrdered(batchCount, concurrency, fetchBatch, async (index, features) => {
        const from = index * pageSize;
        const expected = ids.subarray(from, Math.min(from + pageSize, ids.length));

        for (const feature of features) {
          const oid = feature[layer.objectIdField] as number;
          if (seenIds.has(oid)) {
            fail('PARSE', `ArcGIS returned ${layer.objectIdField}=${oid} more than once`, { layerUrl });
          }
          seenIds.add(oid);
          await sink.write(`${canonicalJson(feature)}\n`);
          retrievedFeatureCount += 1;
        }

        // Reconcile per batch and release the batch's ids from the seen set:
        // membership only has to be checked within the window that could still
        // produce a duplicate, so `seenIds` stays bounded rather than growing to
        // the size of the county.
        for (const id of expected) {
          if (!seenIds.has(id)) missingObjectIds.push(id);
          seenIds.delete(id);
        }
        ctx.logger.debug('arcgis.batch', { index, of: batchCount, retrieved: retrievedFeatureCount });
      });

      // 5. Count again. A layer that moved under a long crawl must not be
      //    reported as a complete read of a stable snapshot.
      const countAfter = readCount(await query({ where, returnCountOnly: 'true', f: 'json' }));
      const trailer: StreamingSnapshotTrailer = {
        kind: SNAPSHOT_TRAILER_KIND,
        retrievedFeatureCount,
        missingObjectIds,
        sourceReportedCountAtEnd: countAfter,
        sourceChangedDuringRead: countBefore !== null && countAfter !== null && countBefore !== countAfter,
      };
      await sink.write(`${canonicalJson(trailer)}\n`);

      if (trailer.sourceChangedDuringRead) {
        ctx.logger.warn('arcgis.source_changed_during_read', {
          countBefore, countAfter, retrieved: retrievedFeatureCount,
        });
      }

      return {
        originalUrl: `${layerUrl}/query`,
        originalFilename: `${slug(layer.name)}-snapshot.ndjson`,
        mimeType: 'application/x-ndjson',
        effectiveAt: null,
        header,
        trailer,
      };
    },
  };

  return transport;
}

export function isStreamingTransport(transport: Transport): transport is StreamingTransport {
  return (transport as StreamingTransport).streaming === true;
}

/**
 * Runs `produce` for indices 0..n with at most `concurrency` in flight, and
 * hands results to `consume` in strict index order.
 *
 * Out-of-order results wait in a map that can never hold more than
 * `concurrency` entries, so the buffer is bounded by concurrency and not by n.
 * This is the backpressure boundary: no `Promise.all` over every batch.
 */
export async function forEachOrdered<T>(
  count: number,
  concurrency: number,
  produce: (index: number) => Promise<T>,
  consume: (index: number, value: T) => Promise<void>,
): Promise<void> {
  const inFlight = new Map<number, Promise<T>>();
  let next = 0;
  let consumed = 0;

  const start = (): void => {
    while (inFlight.size < concurrency && next < count) {
      const index = next++;
      inFlight.set(index, produce(index));
    }
  };

  start();
  while (consumed < count) {
    const pending = inFlight.get(consumed);
    if (!pending) fail('CONFIG', `ordered scheduler lost batch ${consumed}`);
    const value = await pending;
    inFlight.delete(consumed);
    await consume(consumed, value);
    consumed += 1;
    start();
  }
}

// ---------------------------------------------------------------------------

async function request(
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
      // ArcGIS reports errors with HTTP 200 and an `error` body.
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

function readCount(json: ArcGisJson): number | null {
  return typeof json['count'] === 'number' ? (json['count'] as number) : null;
}

function readObjectIds(json: ArcGisJson): Int32Array {
  const ids = json['objectIds'];
  if (!Array.isArray(ids)) fail('TRANSPORT', 'ArcGIS returnIdsOnly response has no objectIds array');
  const out = new Int32Array((ids as unknown[]).length);
  for (let i = 0; i < out.length; i++) {
    const value = (ids as unknown[])[i];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      fail('TRANSPORT', `ArcGIS returned a non-integer object id: ${String(value)}`);
    }
    out[i] = value;
  }
  out.sort();
  return out;
}

function readFeatures(json: ArcGisJson, objectIdField: string): Record<string, unknown>[] {
  const features = json['features'];
  if (!Array.isArray(features)) fail('TRANSPORT', 'ArcGIS query response has no features array');
  return (features as ArcGisJson[]).map((f) => {
    const attributes = f['attributes'];
    if (!attributes || typeof attributes !== 'object') fail('TRANSPORT', 'ArcGIS feature has no attributes');
    const row = attributes as Record<string, unknown>;
    if (typeof row[objectIdField] !== 'number') {
      fail('PARSE', `ArcGIS feature is missing its ${objectIdField}`);
    }
    return row;
  });
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
}
