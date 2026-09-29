/**
 * Durable artifact backends — where authoritative bytes live when the
 * execution machine is disposable.
 *
 * DF-0K proved an unattended statewide acquisition end to end and left the
 * 760 MB publisher archive on the container's disk. A container can vanish. A
 * sha256 in Git proves which bytes existed; it does not keep them. This module
 * removes the execution machine from the durability model:
 *
 *   execution disk     staging, scratch, sorts, projections — disposable
 *   artifact backend   the only place an authoritative copy may count as kept
 *
 * ## Content addressing
 *
 * An object's key is derived from nothing but the sha256 of its bytes:
 *
 *   <prefix>/artifacts/sha256/<aa>/<sha256>          the bytes, exactly
 *   <prefix>/manifests/sha256/<aa>/<sha256>.json     write-once retrieval manifest
 *   <prefix>/releases/<sourceId>/<period>/<fingerprint>.json   release record
 *
 * No key depends on "latest", "current", a timestamp or a publisher filename.
 * The filename is metadata inside the manifest.
 *
 * ## Immutability
 *
 * A key names exactly one byte sequence. Writing different bytes to an existing
 * key is a hard failure, checked by the application on every write — object
 * store versioning or locks are welcome defence in depth, never the only one.
 *
 * ## Two backends, and no silent downgrade
 *
 *   LOCAL          a directory. Tests and development. NOT durable unless the
 *                  operator explicitly says the directory is durable storage.
 *   S3_COMPATIBLE  any S3-protocol private bucket (Supabase Storage, AWS S3,
 *                  R2, …). Durable.
 *
 * When durability is REQUIRED, a LOCAL backend on execution disk is refused —
 * it never quietly stands in for the cloud.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fail } from '../core/errors.ts';
import { canonicalJson } from '../core/hash.ts';

export type BackendKind = 'LOCAL' | 'S3_COMPATIBLE';

/** Where a copy of an artifact stands. Distinct states, never collapsed. */
export type DurabilityState =
  /** Only on execution disk. Can vanish with the machine. */
  | 'EPHEMERAL_ONLY'
  /** In a durable backend, uploaded, size-checked and hash-verified. */
  | 'DURABLE'
  /** Referenced by metadata, and not present where it should be. */
  | 'MISSING_BYTES'
  /** Exact bytes are gone; the publisher still serves the same release, to be proven by sha on re-download. */
  | 'REACQUIRABLE'
  /** Exact bytes are gone and cannot be recovered. The digest remains as evidence. */
  | 'LOST_EXACT_BYTES';

/** Lifecycle of one durable commit. Only DURABLE and REGISTERED satisfy provenance. */
export type CommitPhase = 'STAGING' | 'HASH_VERIFIED' | 'DURABLE' | 'REGISTERED';

export type ObjectHead = {
  readonly bytes: number;
  /** sha256 the writer declared in object metadata. A hint; never trusted alone. */
  readonly declaredSha256: string | null;
  readonly contentType: string | null;
};

export type BackendDescription = {
  readonly kind: BackendKind;
  readonly durable: boolean;
  /** Bucket and prefix, or directory. Never a credential. */
  readonly location: string;
};

export type ArtifactBackend = {
  describe(): BackendDescription;
  /** Metadata for an object, or null when it does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /**
   * Stores a local file under `key`. The caller has already hashed it; the
   * backend is told the sha256 so the store can check the payload too.
   * Resolves `created: false` when identical bytes were already there.
   */
  putFile(key: string, path: string, meta: { sha256: string; bytes: number; contentType: string }): Promise<{ created: boolean }>;
  /**
   * Small write-once JSON document (manifests, release records). Never
   * overwrites: an existing document stands — it is the first, historical
   * record — and `identical` says whether the caller's version agreed.
   */
  putJson(key: string, value: unknown): Promise<{ created: boolean; identical: boolean }>;
  getJson<T>(key: string): Promise<T | null>;
  /** Streams an object's bytes. Throws if missing. */
  stream(key: string): Promise<AsyncIterable<Uint8Array>>;
  list(prefix: string): Promise<readonly string[]>;
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const DEFAULT_PREFIX = 'reivesti-data-fabric';

function assertSha(sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail('CONFIG', `not a sha256: ${sha256}`);
}

export function artifactKey(prefix: string, sha256: string): string {
  assertSha(sha256);
  return `${prefix}/artifacts/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function manifestKey(prefix: string, sha256: string): string {
  assertSha(sha256);
  return `${prefix}/manifests/sha256/${sha256.slice(0, 2)}/${sha256}.json`;
}

export function releaseKey(prefix: string, sourceId: string, referencePeriod: string, fingerprint: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${prefix}/releases/${safe(sourceId)}/${safe(referencePeriod)}/${safe(fingerprint)}.json`;
}

export function releasePrefix(prefix: string, sourceId: string): string {
  return `${prefix}/releases/${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}/`;
}

// ---------------------------------------------------------------------------
// Verification, shared by every backend
// ---------------------------------------------------------------------------

/** Re-reads an object end to end and returns its sha256 and length. Holds one chunk. */
export async function hashObject(backend: ArtifactBackend, key: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of await backend.stream(key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Streams an object to a local file, verifying sha256 and length before the file is usable. */
export async function downloadVerified(
  backend: ArtifactBackend,
  key: string,
  expected: { sha256: string; bytes: number },
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const source = await backend.stream(key);
  async function* tee() {
    for await (const chunk of source) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      yield chunk;
    }
  }
  try {
    await pipeline(Readable.from(tee()), createWriteStream(temp, { mode: 0o600 }));
    const sha256 = hash.digest('hex');
    if (sha256 !== expected.sha256 || bytes !== expected.bytes) {
      fail('REPLAY', 'durable object failed verification on download', {
        key, expectedSha256: expected.sha256, actualSha256: sha256, expectedBytes: expected.bytes, actualBytes: bytes,
      });
    }
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// LOCAL
// ---------------------------------------------------------------------------

/**
 * A directory. `durable` is a claim the OPERATOR makes about that directory —
 * a mounted persistent volume, say — and defaults to false, because the only
 * directory a fresh cloud worker is guaranteed to have is its own disposable disk.
 */
export function createLocalBackend(root: string, options: { durable?: boolean } = {}): ArtifactBackend {
  const pathOf = (key: string): string => {
    if (key.includes('..') || key.startsWith('/')) fail('CONFIG', `unsafe object key "${key}"`);
    return join(root, ...key.split('/'));
  };

  const fileSha = async (path: string): Promise<string> => {
    const h = createHash('sha256');
    for await (const c of createReadStream(path)) h.update(c as Buffer);
    return h.digest('hex');
  };

  const writeOnce = async (key: string, write: (temp: string) => Promise<void>, sha256: string): Promise<{ created: boolean }> => {
    const target = pathOf(key);
    const existing = await stat(target).catch(() => null);
    if (existing) {
      const retained = await fileSha(target);
      if (retained !== sha256) {
        fail('IMMUTABILITY', `refusing to overwrite "${key}" with different bytes`, { retainedSha256: retained, incomingSha256: sha256 });
      }
      return { created: false };
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.partial`;
    try {
      await write(temp);
      if ((await fileSha(temp)) !== sha256) fail('IMMUTABILITY', `bytes written for "${key}" do not match the declared sha256`);
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    return { created: true };
  };

  return {
    describe: () => ({ kind: 'LOCAL', durable: options.durable ?? false, location: root }),

    async head(key) {
      const s = await stat(pathOf(key)).catch(() => null);
      if (!s) return null;
      const meta = await readFile(`${pathOf(key)}.meta.json`, 'utf8').then((t) => JSON.parse(t) as { sha256?: string; contentType?: string }).catch(() => null);
      return { bytes: s.size, declaredSha256: meta?.sha256 ?? null, contentType: meta?.contentType ?? null };
    },

    async putFile(key, path, meta) {
      const result = await writeOnce(key, async (temp) => {
        await pipeline(createReadStream(path), createWriteStream(temp, { mode: 0o400 }));
      }, meta.sha256);
      if (result.created) {
        await writeFile(`${pathOf(key)}.meta.json`, canonicalJson({ sha256: meta.sha256, contentType: meta.contentType }), { mode: 0o400 });
      }
      return result;
    },

    async putJson(key, value) {
      const text = `${canonicalJson(value)}\n`;
      const existing = await readFile(pathOf(key), 'utf8').catch(() => null);
      if (existing !== null) return { created: false, identical: existing === text };
      const sha256 = createHash('sha256').update(text).digest('hex');
      await writeOnce(key, (temp) => writeFile(temp, text, { mode: 0o400 }), sha256);
      return { created: true, identical: true };
    },

    async getJson<T>(key: string): Promise<T | null> {
      try {
        return JSON.parse(await readFile(pathOf(key), 'utf8')) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    async stream(key) {
      const path = pathOf(key);
      if (!(await stat(path).catch(() => null))) fail('REPLAY', `object "${key}" does not exist`);
      return createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Uint8Array>;
    },

    async list(prefix) {
      // Key-prefix semantics, like S3: "abc" matches "abc/…" and "abcd/…".
      const cut = prefix.lastIndexOf('/');
      const dirPrefix = cut === -1 ? '' : prefix.slice(0, cut);
      const base = dirPrefix === '' ? root : pathOf(dirPrefix);
      const out: string[] = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(dir, e.name), r);
          else if (!e.name.endsWith('.meta.json') && !e.name.endsWith('.partial')) out.push(dirPrefix === '' ? r : `${dirPrefix}/${r}`);
        }
      };
      await walk(base, '');
      return out.filter((k) => k.startsWith(prefix)).sort();
    },
  };
}
