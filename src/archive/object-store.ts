/**
 * Write-once object storage.
 *
 * The filesystem driver is the only implementation in DF-0B, but the interface
 * is the one an S3 or Supabase Storage driver would satisfy, so the artifact
 * store above it never learns where bytes live. Every driver must enforce
 * write-once: `put` on an existing key with different bytes is an error, not an
 * overwrite. That single rule is what stops `latest.xml` from becoming history.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, relative, sep } from 'node:path';
import { fail } from '../core/errors.ts';

export type PutResult = {
  /** false when an identical object already existed: a safe, idempotent no-op. */
  readonly created: boolean;
  readonly sha256: string;
  readonly byteLength: number;
};

export type ObjectStore = {
  readonly describe: string;
  put(key: string, bytes: Uint8Array): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Keys under a prefix, sorted, so listings are deterministic. */
  list(prefix: string): Promise<readonly string[]>;
};

const KEY_RULE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export function assertValidKey(key: string): void {
  if (!KEY_RULE.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) {
    fail('CONFIG', `invalid object key "${key}"`);
  }
}

export function createFilesystemObjectStore(root: string): ObjectStore {
  const pathFor = (key: string): string => {
    assertValidKey(key);
    return join(root, ...key.split('/'));
  };

  return {
    describe: `file://${root}`,

    async put(key, bytes) {
      const path = pathFor(key);
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const existing = await readIfPresent(path);
      if (existing) {
        const existingSha = createHash('sha256').update(existing).digest('hex');
        if (existingSha === sha256) return { created: false, sha256, byteLength: bytes.byteLength };
        fail('IMMUTABILITY', `refusing to overwrite retained object "${key}"`, {
          key,
          retainedSha256: existingSha,
          incomingSha256: sha256,
        });
      }

      await mkdir(dirname(path), { recursive: true });
      // Write to a temp name then rename: a crash mid-write can never leave a
      // truncated object under a key that callers will later trust.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o444 });
      try {
        await rename(tmp, path);
      } catch (e) {
        // A concurrent writer may have landed first; accept it if identical.
        const now = await readIfPresent(path);
        if (now && createHash('sha256').update(now).digest('hex') === sha256) {
          return { created: false, sha256, byteLength: bytes.byteLength };
        }
        throw e;
      }
      await chmod(path, 0o444).catch(() => {}); // read-only is a guard rail, not a guarantee
      return { created: true, sha256, byteLength: bytes.byteLength };
    },

    async get(key) {
      const path = pathFor(key);
      const bytes = await readIfPresent(path);
      if (!bytes) fail('TRANSPORT', `object "${key}" is not present in ${root}`, { key });
      return bytes;
    },

    async exists(key) {
      try {
        await access(pathFor(key), constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },

    async list(prefix) {
      assertValidKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
      const base = join(root, ...prefix.split('/'));
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile() && !full.endsWith('.tmp')) out.push(relative(root, full).split(sep).join('/'));
        }
      };
      const info = await stat(base).catch(() => null);
      if (info?.isDirectory()) await walk(base);
      else if (info?.isFile()) out.push(prefix);
      return out.sort();
    },
  };
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Streaming: for objects too large to hold in memory
// ---------------------------------------------------------------------------

/** A backpressure-aware byte sink. Awaiting `write` is what bounds memory. */
export type ByteSink = {
  write(chunk: string | Uint8Array): Promise<void>;
};

/**
 * Bytes written to a staging location, digested on the way past.
 *
 * A content-addressed key cannot be known until the last byte has been seen, so
 * a large artifact is staged first and promoted afterwards. An interrupted
 * download leaves a staging file and never a valid artifact.
 */
export type StagedObject = {
  readonly sha256: string;
  readonly byteLength: number;
  /** Moves the staged bytes to `key`. Identical existing content is a no-op. */
  promote(key: string): Promise<PutResult>;
  discard(): Promise<void>;
};

export type StreamingObjectStore = ObjectStore & {
  /** Writes through `produce` to a staging file, hashing incrementally. */
  stage(produce: (sink: ByteSink) => Promise<void>): Promise<StagedObject>;
  /** Re-reads an object and returns its digest without materialising it. */
  digestOf(key: string): Promise<{ sha256: string; byteLength: number }>;
  /** Absolute path of an object, for streaming line readers. */
  pathOf(key: string): string;
};

export function createStreamingFilesystemObjectStore(root: string): StreamingObjectStore {
  const base = createFilesystemObjectStore(root);

  const pathFor = (key: string): string => {
    assertValidKey(key);
    return join(root, ...key.split('/'));
  };

  return {
    ...base,
    pathOf: pathFor,

    async stage(produce) {
      const stagingDir = join(root, '.staging');
      await mkdir(stagingDir, { recursive: true });
      const path = join(stagingDir, `stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

      const hash = createHash('sha256');
      let byteLength = 0;
      const stream = createWriteStream(path, { mode: 0o600, highWaterMark: 1 << 20 });

      const sink: ByteSink = {
        async write(chunk) {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
          hash.update(bytes);
          byteLength += bytes.byteLength;
          // Backpressure: without this the producer can queue the whole county
          // in the stream's internal buffer and the streaming is only notional.
          if (!stream.write(bytes)) await once(stream, 'drain');
        },
      };

      let failed = false;
      try {
        await produce(sink);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        stream.end();
        await once(stream, 'finish').catch(() => {});
        if (failed) await rm(path, { force: true });
      }

      const sha256 = hash.digest('hex');
      let settled = false;

      return {
        sha256,
        byteLength,
        async promote(key) {
          if (settled) fail('CONFIG', 'staged object has already been promoted or discarded');
          settled = true;
          const destination = pathFor(key);

          const existing = await stat(destination).catch(() => null);
          if (existing) {
            // Content addressing means a same-key collision is a same-content
            // collision, but it is verified rather than assumed.
            const retained = await digestFile(destination);
            await rm(path, { force: true });
            if (retained.sha256 !== sha256) {
              fail('IMMUTABILITY', `refusing to overwrite retained object "${key}"`, {
                key, retainedSha256: retained.sha256, incomingSha256: sha256,
              });
            }
            return { created: false, sha256, byteLength };
          }

          await mkdir(dirname(destination), { recursive: true });
          await rename(path, destination);
          await chmod(destination, 0o444).catch(() => {});
          return { created: true, sha256, byteLength };
        },
        async discard() {
          if (settled) return;
          settled = true;
          await rm(path, { force: true });
        },
      };
    },

    async digestOf(key) {
      const path = pathFor(key);
      const info = await stat(path).catch(() => null);
      if (!info) fail('TRANSPORT', `object "${key}" is not present in ${root}`, { key });
      return digestFile(path);
    },
  };
}

/** Streams a file through sha256 without holding it. */
async function digestFile(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  return { sha256: hash.digest('hex'), byteLength };
}
