/**
 * Unattended acquisition of a publisher's bulk archive.
 *
 * DF-0H proved a bulk file beats a crawl, and then had an operator download the
 * GeoPackage and run a converter by hand. That is exactly the dependency DF-0J.1A
 * ruled out of production: a pipeline whose input arrives by hand cannot tell
 * "nothing changed" from "nobody ran it". This module is the missing half — the
 * part a scheduler runs with nobody watching:
 *
 *   discover   the connector says what the publisher is offering right now
 *   plan       the ledger says whether that exact release was already ingested
 *   acquire    one streamed GET into the content-addressed artifact store
 *   record     the ledger remembers what was done, so the next tick is a NOOP
 *
 * It is generic on purpose. Nothing here knows about Wisconsin, parcels or
 * geodatabases: a release is a fingerprint and a reference period, and an
 * archive is bytes at a URL. The next state with a bulk archive reuses all of it.
 *
 * ## Why a fingerprint and not a date
 *
 * "Latest" is not a release. A release is identified by what the publisher's
 * server says about the exact bytes it will serve — URL, ETag, length,
 * Last-Modified, object version — so a republished archive under the same name
 * is detected as new, and an unchanged one is recognised without downloading a
 * byte. The sha256 of the bytes, once downloaded, is the artifact's identity; the
 * fingerprint is only the cheap question asked before deciding to download.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArchivedArtifact, StreamingArchiveInput, StreamingArtifactStore } from '../archive/artifact-store.ts';
import { fail } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import { DEFAULT_RETRY, realSleep, withRetry, type RetryPolicy, type Sleep } from './retry.ts';

function retryOptions(deps: HttpDeps, label: string): Parameters<typeof withRetry>[1] {
  return { policy: deps.retryPolicy ?? DEFAULT_RETRY, sleep: deps.sleep ?? realSleep, label };
}

/** What a publisher says about the archive it is serving, before any download. */
export type ArchiveHead = {
  readonly url: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentLength: number | null;
  /** S3-style object version, where the host exposes one. */
  readonly versionId: string | null;
  readonly acceptRanges: boolean;
};

/** A release as discovery sees it. */
export type DiscoveredArchiveRelease = {
  readonly sourceId: string;
  /** The publisher's own version label, e.g. `V12.0.0-2026`. Never "latest". */
  readonly referencePeriod: string;
  /** Hash over the archive head: changes whenever the served bytes could have. */
  readonly releaseFingerprint: string;
  readonly head: ArchiveHead;
};

export function releaseFingerprintOf(head: ArchiveHead): string {
  return sha256(canonicalJson({
    url: head.url, etag: head.etag, lastModified: head.lastModified,
    contentLength: head.contentLength, versionId: head.versionId,
  }));
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  readonly at: string;
  readonly sourceId: string;
  readonly referencePeriod: string;
  readonly releaseFingerprint: string;
  /**
   * Only ACQUIRED_AND_INGESTED with a completed run makes a later tick a NOOP.
   * A truncated smoke run is recorded as what it is, so it can never stand in
   * for an ingestion of the release it sampled.
   */
  readonly action:
    | 'ACQUIRED_AND_INGESTED'
    /** A fresh worker found the release durable and ingested it without touching the publisher. */
    | 'REHYDRATED_AND_INGESTED'
    | 'NOOP_SAME_RELEASE' | 'REPLAYED' | 'TRUNCATED_SMOKE_RUN' | 'FAILED';
  readonly publisherSha256: string | null;
  readonly publisherBytes: number | null;
  readonly bundleSha256: string | null;
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly normalizedDigest: string | null;
  readonly estateDigest: string | null;
  readonly note: string | null;
};

const INGESTED: ReadonlySet<LedgerEntry['action']> = new Set(['ACQUIRED_AND_INGESTED', 'REHYDRATED_AND_INGESTED']);

export type AcquisitionLedger = {
  entries(): Promise<readonly LedgerEntry[]>;
  append(entry: LedgerEntry): Promise<void>;
  /** The last successful ingestion of exactly this release, if any. */
  completedFor(fingerprint: string): Promise<LedgerEntry | null>;
};

/**
 * Append-only, one file per source. Small by construction — one line per
 * scheduler tick — so reading it whole is fine; it never holds source data.
 */
export function createAcquisitionLedger(varRoot: string, sourceId: string): AcquisitionLedger {
  const path = join(varRoot, 'acquisition', `${sourceId}.ledger.ndjson`);
  const entries = async (): Promise<readonly LedgerEntry[]> => {
    const text = await readFile(path, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
  };
  return {
    entries,
    async append(entry) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, `${canonicalJson(entry)}\n`, { mode: 0o600 });
    },
    async completedFor(fingerprint) {
      const done = (await entries()).filter((e) =>
        e.releaseFingerprint === fingerprint && INGESTED.has(e.action) && e.runStatus === 'completed');
      return done.at(-1) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type AcquisitionPlan =
  | { readonly action: 'NOOP'; readonly reason: string; readonly previous: LedgerEntry }
  | {
    readonly action: 'ACQUIRE';
    readonly reason: 'FIRST_RELEASE' | 'NEW_RELEASE' | 'REPUBLISHED_RELEASE';
    /** A release the connector was not written against must pass schema validation before activation. */
    readonly schemaValidationRequired: boolean;
  };

/**
 * NOOP when this exact release was already ingested successfully; otherwise
 * ACQUIRE, saying why. A scheduler tick that finds nothing new does no work —
 * no download, no parse, no projection.
 */
export async function planAcquisition(
  release: DiscoveredArchiveRelease,
  ledger: AcquisitionLedger,
  pinnedReferencePeriod: string,
): Promise<AcquisitionPlan> {
  const previous = await ledger.completedFor(release.releaseFingerprint);
  if (previous) {
    return {
      action: 'NOOP',
      reason: `release ${release.referencePeriod} (fingerprint ${release.releaseFingerprint.slice(0, 12)}) was `
        + `already ingested by run ${previous.runId ?? '?'}`,
      previous,
    };
  }
  const all = await ledger.entries();
  const seenPeriod = all.some((e) => e.referencePeriod === release.referencePeriod && INGESTED.has(e.action));
  const anyIngested = all.some((e) => INGESTED.has(e.action));
  return {
    action: 'ACQUIRE',
    reason: seenPeriod ? 'REPUBLISHED_RELEASE' : anyIngested ? 'NEW_RELEASE' : 'FIRST_RELEASE',
    // The pinned field set still gates activation either way; this flag is the
    // operator-visible statement that the run is not a routine refresh.
    schemaValidationRequired: release.referencePeriod !== pinnedReferencePeriod,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type HttpDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: Sleep;
  readonly userAgent?: string;
};

export const FABRIC_USER_AGENT = 'Reivesti-DataFabric/0.1 (+https://github.com/kindleops/reivesti-data-fabric)';

/** HEAD an archive. One request; no body. */
export async function headArchive(url: string, deps: HttpDeps = {}): Promise<ArchiveHead> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await withRetry(
    async () => {
      const r = await fetchImpl(url, { method: 'HEAD', headers: { 'user-agent': deps.userAgent ?? FABRIC_USER_AGENT } });
      if (r.status >= 500 || r.status === 429) throw new Error(`HEAD ${url} → ${r.status}`);
      return r;
    },
    retryOptions(deps, 'bulk.http'),
  );
  // A 4xx is an answer, not a fault: retrying it asks the same question again.
  if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'ACCESS_BLOCKED' : 'CONFIG', `HEAD ${url} returned ${response.status}`);
  const length = response.headers.get('content-length');
  return {
    url,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    contentLength: length === null ? null : Number(length),
    versionId: response.headers.get('x-amz-version-id'),
    acceptRanges: (response.headers.get('accept-ranges') ?? '').includes('bytes'),
  };
}

/** GET a small document (a landing page, a layer's metadata, a folder listing) as text. */
export async function getText(url: string, deps: HttpDeps = {}, headers: Readonly<Record<string, string>> = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return withRetry(
    async () => {
      const r = await fetchImpl(url, { headers: { ...headers, 'user-agent': deps.userAgent ?? FABRIC_USER_AGENT } });
      if (r.status >= 500 || r.status === 429) throw new Error(`GET ${url} → ${r.status}`);
      if (!r.ok) fail(r.status === 401 || r.status === 403 ? 'ACCESS_BLOCKED' : 'CONFIG', `GET ${url} returned ${r.status}`);
      return r.text();
    },
    retryOptions(deps, 'bulk.http'),
  );
}

export type ArchiveDownload = {
  readonly artifact: ArchivedArtifact;
  readonly head: ArchiveHead;
  readonly ms: number;
};

/**
 * Streams one archive straight into the artifact store.
 *
 * One request, publisher bytes preserved exactly, sha256 computed as they pass.
 * A short body, or bytes that change identity mid-flight (an ETag that differs
 * from the one discovery saw), fails the acquisition and leaves no artifact —
 * the staging area discards it.
 */
export async function downloadArchive(
  release: DiscoveredArchiveRelease,
  artifactStore: StreamingArtifactStore,
  archiveInput: Omit<StreamingArchiveInput, 'originalUrl' | 'originalFilename'> & { readonly originalFilename: string },
  deps: HttpDeps = {},
): Promise<ArchiveDownload> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = Date.now();
  let served: ArchiveHead | null = null;

  const artifact = await withRetry(
    () => artifactStore.archiveStream(
      { ...archiveInput, originalUrl: release.head.url },
      async (sink) => {
        const response = await fetchImpl(release.head.url, {
          headers: { 'user-agent': deps.userAgent ?? FABRIC_USER_AGENT },
        });
        if (!response.ok || response.body === null) {
          throw new Error(`GET ${release.head.url} returned ${response.status}`);
        }
        const etag = response.headers.get('etag');
        if (release.head.etag !== null && etag !== null && etag !== release.head.etag) {
          fail('TRANSPORT', 'the archive changed between discovery and download', {
            discovered: release.head.etag, served: etag,
            remedy: 'rediscover; the publisher replaced the file mid-acquisition',
          });
        }
        let bytes = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          await sink.write(chunk);
        }
        if (release.head.contentLength !== null && bytes !== release.head.contentLength) {
          throw new Error(`short body: expected ${release.head.contentLength} bytes, received ${bytes}`);
        }
        served = { ...release.head, etag: etag ?? release.head.etag };
      },
    ),
    retryOptions(deps, 'bulk.http'),
  );

  return { artifact, head: served ?? release.head, ms: Date.now() - started };
}
