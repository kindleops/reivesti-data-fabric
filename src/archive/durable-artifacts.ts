/**
 * The durability lifecycle: how an artifact on execution disk becomes one that
 * survives the execution machine, and how a fresh machine gets it back.
 *
 *   STAGING        bytes on local disk, in the workspace artifact store
 *   HASH_VERIFIED  the local file re-hashed and equal to its content id
 *   DURABLE        uploaded to the durable backend, size-checked, and (for
 *                  certification) re-read end to end and re-hashed
 *   REGISTERED     write-once manifest stored beside it, keyed by the digest
 *
 * Only DURABLE + REGISTERED satisfies replay provenance. A release whose raw
 * bytes are only STAGING is never activated when durability is required.
 *
 * ## Where metadata lives, and why
 *
 *   object store   the bytes; a write-once manifest per digest; a write-once
 *                  release record per (source, release, fingerprint). What a
 *                  fresh worker needs to find and verify an artifact with
 *                  nothing but credentials.
 *   Postgres       `data_fabric.source_artifacts` + `artifact_storage_copies`
 *                  (migration 0011): the searchable registry and the durability
 *                  state of every copy. The object store is never the only index.
 *   Git            the pinned expectations — known digests, including the
 *                  historical ones whose bytes are gone — in
 *                  `reference/artifact-catalog.json`, and the code that reads
 *                  everything else.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fail } from '../core/errors.ts';
import type { ArchivedArtifact, RetrievalManifest, StreamingArtifactStore } from './artifact-store.ts';
import {
  DEFAULT_PREFIX,
  artifactKey,
  createLocalBackend,
  hashObject,
  manifestKey,
  releaseKey,
  releasePrefix,
  type ArtifactBackend,
  type CommitPhase,
} from './artifact-backend.ts';
import { createS3Backend } from './s3-backend.ts';

/** What the bytes ARE, so a digest is never ambiguous about what it hashes. */
export type ArtifactRole =
  /** The publisher's exact bytes. The evidence. Never recompressed. */
  | 'publisher_raw'
  /** A deterministic derivation (e.g. a snapshot bundle). Regenerable. */
  | 'derived_bundle';

export type DurableManifest = {
  readonly manifestVersion: 1;
  readonly sha256: string;
  readonly bytes: number;
  readonly role: ArtifactRole;
  /** `identity` — the sha256 is of the stored bytes as-is, with no transfer or storage encoding. */
  readonly contentEncoding: 'identity' | 'gzip';
  readonly contentType: string;
  /** For derived artifacts: the raw artifact they are a function of. */
  readonly derivedFrom: string | null;
  /** The workspace retrieval manifest: source, release, URL, filename, times, access terms. */
  readonly retrieval: RetrievalManifest;
};

export type ReleaseRecord = {
  readonly recordVersion: 1;
  readonly sourceId: string;
  readonly referencePeriod: string;
  readonly releaseId: string;
  readonly releaseFingerprint: string;
  readonly publisherSha256: string;
  readonly publisherBytes: number;
  readonly publisherUrl: string | null;
  readonly publisherFilename: string;
  readonly retrievedAt: string;
  readonly publicationAt: string | null;
  readonly schemaDigest: string | null;
  readonly parserVersion: string;
  readonly normalizationContract: string;
  readonly acquisitionClass: string;
  readonly termsStatus: string;
  readonly licenseStatus: string;
  readonly jurisdictionIds: readonly string[];
  readonly finality: 'final' | 'provisional' | 'unknown';
};

export type DurableCommit = {
  readonly sha256: string;
  readonly bytes: number;
  readonly key: string;
  readonly created: boolean;
  readonly phases: readonly { readonly phase: CommitPhase; readonly at: string; readonly ms: number }[];
  readonly verifiedByReread: boolean;
};

export type DurableStore = {
  readonly backend: ArtifactBackend;
  readonly prefix: string;
  /** When true, a non-durable backend is refused and a failed commit blocks activation. */
  readonly required: boolean;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Every variable the durable store reads. Doctor reports presence, never values. */
export const DURABLE_ENV = {
  backend: 'DF_ARTIFACT_BACKEND',
  durability: 'DF_ARTIFACT_DURABILITY',
  prefix: 'DF_ARTIFACT_PREFIX',
  localRoot: 'DF_ARTIFACT_LOCAL_ROOT',
  localDurable: 'DF_ARTIFACT_LOCAL_DURABLE',
  endpoint: 'DF_ARTIFACT_S3_ENDPOINT',
  region: 'DF_ARTIFACT_S3_REGION',
  bucket: 'DF_ARTIFACT_BUCKET',
  accessKeyId: 'DF_ARTIFACT_ACCESS_KEY_ID',
  secretAccessKey: 'DF_ARTIFACT_SECRET_ACCESS_KEY',
} as const;

/**
 * The durable store this environment is configured for, or null when none is.
 *
 * Deliberately reads only DF_ARTIFACT_* names. Generic AWS_* variables are
 * not consulted: a sandbox or CI runner may inject placeholders there, and a
 * placeholder silently standing in for the evidence store is exactly the
 * failure this module exists to prevent.
 */
export function durableStoreFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): DurableStore | null {
  const kind = (env[DURABLE_ENV.backend] ?? '').toLowerCase();
  const prefix = env[DURABLE_ENV.prefix] || DEFAULT_PREFIX;
  const durability = (env[DURABLE_ENV.durability] ?? '').toLowerCase();
  if (kind === '' || kind === 'none') {
    if (durability === 'required') {
      fail('CONFIG', `${DURABLE_ENV.durability}=required but no durable backend is configured`, {
        remedy: `set ${DURABLE_ENV.backend}=s3 and the ${DURABLE_ENV.bucket}/${DURABLE_ENV.endpoint}/credential variables`,
      });
    }
    return null;
  }

  let backend: ArtifactBackend;
  if (kind === 'local') {
    const root = env[DURABLE_ENV.localRoot];
    if (!root) fail('CONFIG', `${DURABLE_ENV.backend}=local needs ${DURABLE_ENV.localRoot}`);
    backend = createLocalBackend(root, { durable: env[DURABLE_ENV.localDurable] === '1' });
  } else if (kind === 's3') {
    const missing = [DURABLE_ENV.endpoint, DURABLE_ENV.region, DURABLE_ENV.bucket, DURABLE_ENV.accessKeyId, DURABLE_ENV.secretAccessKey]
      .filter((name) => !env[name]);
    if (missing.length > 0) {
      // Names only. A value never appears in an error.
      fail('CONFIG', `the S3-compatible artifact backend is missing ${missing.join(', ')}`);
    }
    backend = createS3Backend({
      endpoint: env[DURABLE_ENV.endpoint] as string,
      region: env[DURABLE_ENV.region] as string,
      bucket: env[DURABLE_ENV.bucket] as string,
      accessKeyId: env[DURABLE_ENV.accessKeyId] as string,
      secretAccessKey: env[DURABLE_ENV.secretAccessKey] as string,
    });
  } else {
    return fail('CONFIG', `unknown ${DURABLE_ENV.backend} "${kind}" (expected local or s3)`);
  }

  // An S3 backend defaults to required: if you configured the cloud, you meant it.
  const required = durability === 'required' || (durability === '' && kind === 's3');
  return assertNoSilentDowngrade({ backend, prefix, required });
}

/** A required durable store must actually be durable. Local scratch never passes. */
export function assertNoSilentDowngrade(store: DurableStore): DurableStore {
  if (store.required && !store.backend.describe().durable) {
    fail('CONFIG', 'durability is required and the configured artifact backend is not durable', {
      backend: store.backend.describe().kind,
      remedy: 'configure the S3-compatible backend, or declare a mounted persistent volume durable explicitly',
    });
  }
  return store;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Makes one workspace artifact durable. Every phase is timed and recorded; a
 * failure at any phase throws, and nothing downstream may treat the artifact as
 * retained.
 */
export async function commitDurable(
  store: DurableStore,
  workspace: StreamingArtifactStore,
  artifact: ArchivedArtifact,
  options: {
    readonly role: ArtifactRole;
    readonly contentType: string;
    readonly derivedFrom?: string | null;
    readonly contentEncoding?: 'identity' | 'gzip';
    /** Re-read the stored object end to end and re-hash it. Always on for certification. */
    readonly verifyByReread?: boolean;
    readonly now?: () => Date;
  },
): Promise<DurableCommit> {
  const now = options.now ?? (() => new Date());
  const phases: { phase: CommitPhase; at: string; ms: number }[] = [];
  let t = Date.now();
  const mark = (phase: CommitPhase) => {
    phases.push({ phase, at: now().toISOString(), ms: Date.now() - t });
    t = Date.now();
  };

  const path = workspace.localPath(artifact);
  mark('STAGING');

  const local = await sha256OfFile(path);
  if (local.sha256 !== artifact.sha256 || local.bytes !== artifact.byteLength) {
    fail('REPLAY', 'the staged artifact does not match its content id; refusing to make it durable', {
      expected: artifact.sha256, actual: local.sha256,
    });
  }
  mark('HASH_VERIFIED');

  const key = artifactKey(store.prefix, artifact.sha256);
  const put = await store.backend.putFile(key, path, {
    sha256: artifact.sha256, bytes: artifact.byteLength, contentType: options.contentType,
  });
  let verifiedByReread = false;
  if (options.verifyByReread ?? true) {
    const stored = await hashObject(store.backend, key);
    if (stored.sha256 !== artifact.sha256 || stored.bytes !== artifact.byteLength) {
      fail('IMMUTABILITY', 'the durable object does not hash to its key', {
        key, expected: artifact.sha256, actual: stored.sha256,
      });
    }
    verifiedByReread = true;
  }
  mark('DURABLE');

  const manifest: DurableManifest = {
    manifestVersion: 1,
    sha256: artifact.sha256,
    bytes: artifact.byteLength,
    role: options.role,
    contentEncoding: options.contentEncoding ?? 'identity',
    contentType: options.contentType,
    derivedFrom: options.derivedFrom ?? null,
    retrieval: artifact.manifest,
  };
  await store.backend.putJson(manifestKey(store.prefix, artifact.sha256), manifest);
  mark('REGISTERED');

  return { sha256: artifact.sha256, bytes: artifact.byteLength, key, created: put.created, phases, verifiedByReread };
}

export async function registerRelease(store: DurableStore, record: ReleaseRecord): Promise<{ created: boolean }> {
  const key = releaseKey(store.prefix, record.sourceId, record.referencePeriod, record.releaseFingerprint);
  return store.backend.putJson(key, record);
}

export async function findRelease(
  store: DurableStore,
  sourceId: string,
  referencePeriod: string,
  fingerprint: string,
): Promise<ReleaseRecord | null> {
  return store.backend.getJson<ReleaseRecord>(releaseKey(store.prefix, sourceId, referencePeriod, fingerprint));
}

export async function listReleases(store: DurableStore, sourceId: string): Promise<readonly ReleaseRecord[]> {
  const out: ReleaseRecord[] = [];
  for (const key of await store.backend.list(releasePrefix(store.prefix, sourceId))) {
    const record = await store.backend.getJson<ReleaseRecord>(key);
    if (record) out.push(record);
  }
  return out;
}

export async function readDurableManifest(store: DurableStore, sha256: string): Promise<DurableManifest | null> {
  return store.backend.getJson<DurableManifest>(manifestKey(store.prefix, sha256));
}

// ---------------------------------------------------------------------------
// Rehydration
// ---------------------------------------------------------------------------

/**
 * Brings an artifact back from the durable store into this machine's workspace,
 * by digest alone, and proves it is the same bytes.
 *
 * The workspace copy is written through the ordinary streaming archive, which
 * hashes as it stages; the result is accepted only if that hash is the digest
 * that was asked for. Object-store integrity metadata is never trusted alone.
 * The retrieval manifest travels with it, so the original retrieval time and
 * publisher URL are restored — not replaced by the time of this download.
 */
export async function rehydrate(
  store: DurableStore,
  workspace: StreamingArtifactStore,
  sha256: string,
): Promise<{ artifact: ArchivedArtifact; manifest: DurableManifest; ms: number }> {
  const started = Date.now();
  const manifest = await readDurableManifest(store, sha256);
  if (manifest === null) {
    fail('REPLAY', `no durable manifest for ${sha256}`, { remedy: 'the artifact was never registered, or the prefix is wrong' });
  }
  const source = await store.backend.stream(artifactKey(store.prefix, sha256));
  const artifact = await workspace.archiveStream(
    { ...manifest.retrieval },
    async (sink) => {
      for await (const chunk of source) await sink.write(chunk);
    },
  );
  if (artifact.sha256 !== sha256 || artifact.byteLength !== manifest.bytes) {
    fail('REPLAY', 'rehydrated bytes do not match the requested digest', {
      requested: sha256, received: artifact.sha256, bytes: artifact.byteLength,
    });
  }
  return { artifact, manifest, ms: Date.now() - started };
}
