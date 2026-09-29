/**
 * Per-partition projection storage.
 *
 * The unit of work is a partition, so the unit of storage is a partition too.
 * Each one owns its inputs, its outputs, its generation pointer and its digests:
 *
 *   var/derived/partitions/property/us-county-27053/
 *     contributions/<runId>.ndjson    inputs, one immutable file per run
 *     CURRENT                          -> gen-...
 *     gen-.../resolutions.ndjson       outputs
 *            /conflicts.ndjson
 *            /manifest.json            digests, counts, resolver version
 *
 * Two properties follow from that layout, and both are load-bearing:
 *
 * **Recomputing a partition reads only that partition.** Its inputs are already
 * separated on disk, so "recompute Hennepin" never opens a Ramsey file. This is
 * the actual fix for the whole-estate fold — partitioning only the *output*
 * would have left the input scan O(estate).
 *
 * **Activation is per partition.** Generation directory, then one atomic rename
 * of CURRENT, exactly as DF-0D does for staged runs. A failure leaves the
 * previous projection of that partition intact and visible.
 *
 * ## Atomicity across several partitions
 *
 * There is none, and saying so plainly is better than implying otherwise. A run
 * touching three counties performs three independent activations. If the second
 * fails, the first is live and the third is not. The alternative — a global
 * two-phase commit across thousands of directories — buys a guarantee nothing in
 * the estate needs, because partitions are independent by construction: a
 * half-applied multi-partition run leaves every partition individually
 * consistent, just at different generations. `activationStates` reports exactly
 * which succeeded, and the run manifest records it.
 */
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { canonicalJson, MultisetDigest } from '../core/hash.ts';
import { readLines } from '../core/lines.ts';
import { fail } from '../core/errors.ts';
import {
  parsePartitionId,
  partitionId,
  type PartitionKey,
  type PartitionManifest,
} from '../canonical/partitions.ts';

export const CURRENT_POINTER = 'CURRENT';

/** Outputs a projection writes into a partition. */
export type PartitionTable = 'resolutions' | 'conflicts' | 'entity_links';

export type PartitionActivation = {
  readonly partitionId: string;
  readonly state: 'activated' | 'failed' | 'skipped';
  readonly generation: string | null;
  readonly reason: string | null;
};

export type PartitionWriter = {
  readonly key: PartitionKey;
  readonly generation: string;
  write(table: PartitionTable, row: unknown): Promise<void>;
  /** Activates this partition. Returns its manifest. */
  commit(manifest: Omit<PartitionManifest, 'generation' | 'partitionId' | 'domain' | 'scopeId'>): Promise<PartitionManifest>;
  abort(): Promise<void>;
};

export type PartitionStore = {
  /** Appends one run's contributions to a partition. Immutable once written. */
  writeContributions(key: PartitionKey, runId: string, lines: AsyncIterable<string>): Promise<number>;
  /** Every contribution the partition holds, across every run. */
  readContributions(key: PartitionKey): AsyncGenerator<string>;
  /**
   * The same lines, each prefixed with the run whose file it came from:
   * `<runId>\t<line>`. What a projection reads when a conflict must name the
   * run whose evidence produced it rather than the run recomputing it.
   */
  readContributionsTagged(key: PartitionKey): AsyncGenerator<string>;
  /** Order-independent digest over a partition's whole input. */
  contributionDigest(key: PartitionKey): Promise<{ digest: string; rowCount: number }>;
  beginProjection(key: PartitionKey, runId: string): Promise<PartitionWriter>;
  readTable(key: PartitionKey, table: PartitionTable): AsyncGenerator<string>;
  manifest(key: PartitionKey): Promise<PartitionManifest | null>;
  /** Every activated partition, sorted by id. */
  manifests(): Promise<readonly PartitionManifest[]>;
  listPartitions(): Promise<readonly PartitionKey[]>;
  /** Removes generation directories no CURRENT pointer names. */
  sweepAbandoned(): Promise<number>;
};

export type PartitionStoreOptions = {
  /**
   * gzip contributions and projection outputs as they are written
   * (`<name>.ndjson.gz`). Defaults to DF_DERIVED_GZIP=1, like the run tables.
   *
   * Every reader goes through `readLines`, which decompresses a `.gz` path on
   * the fly, and every digest is computed over LINES, never file bytes — so a
   * compressed partition has exactly the digests of an uncompressed one, and
   * both kinds of file can sit side by side in one estate.
   */
  readonly compress?: boolean;
};

/** Opens a line sink on `path`, gzip level 1 when asked. Level 1: the point is disk, not ratio. */
function lineSink(path: string, compress: boolean): { stream: Writable; done: Promise<unknown> } {
  const file = createWriteStream(path, { highWaterMark: 1 << 20 });
  if (!compress) return { stream: file, done: once(file, 'finish') };
  const gzip = createGzip({ level: 1 });
  gzip.pipe(file);
  gzip.on('error', (e) => file.destroy(e));
  return { stream: gzip, done: once(file, 'finish') };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export function createPartitionStore(root: string, options: PartitionStoreOptions = {}): PartitionStore {
  const compress = options.compress ?? process.env['DF_DERIVED_GZIP'] === '1';
  const suffix = compress ? '.ndjson.gz' : '.ndjson';
  const base = join(root, 'derived', 'partitions');
  const dirOf = (key: PartitionKey): string => join(base, ...partitionId(key).split('/'));
  const contributionsDir = (key: PartitionKey): string => join(dirOf(key), 'contributions');

  const currentGeneration = async (key: PartitionKey): Promise<string | null> => {
    try {
      return (await readFile(join(dirOf(key), CURRENT_POINTER), 'utf8')).trim() || null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };

  const contributionFiles = async (key: PartitionKey): Promise<readonly string[]> => {
    try {
      return (await readdir(contributionsDir(key))).filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz')).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  };

  const store: PartitionStore = {
    async writeContributions(key, runId, lines) {
      const dir = contributionsDir(key);
      await mkdir(dir, { recursive: true });
      const target = join(dir, `${safe(runId)}${suffix}`);
      // Written to a temp file and renamed, so a crash mid-write can never leave
      // a partition holding half a run's evidence — which would recompute into a
      // wrong-but-plausible projection rather than an obvious failure.
      const temp = `${target}.${process.pid}.tmp`;
      const { stream, done } = lineSink(temp, compress);
      let count = 0;
      for await (const line of lines) {
        if (!stream.write(`${line}\n`)) await once(stream, 'drain');
        count += 1;
      }
      stream.end();
      await done;
      await rename(temp, target);
      return count;
    },

    async *readContributions(key) {
      const dir = contributionsDir(key);
      for (const file of await contributionFiles(key)) {
        yield* readLines(join(dir, file));
      }
    },

    async *readContributionsTagged(key) {
      const dir = contributionsDir(key);
      for (const file of await contributionFiles(key)) {
        const runId = file.replace(/\.ndjson(\.gz)?$/, '');
        for await (const line of readLines(join(dir, file))) yield `${runId}\t${line}`;
      }
    },

    async contributionDigest(key) {
      const digest = new MultisetDigest();
      for await (const line of store.readContributions(key)) digest.add(line);
      return { digest: digest.value(), rowCount: digest.size };
    },

    async beginProjection(key, runId) {
      const generation = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = join(dirOf(key), generation);
      await mkdir(dir, { recursive: true });

      const streams = new Map<PartitionTable, { write(l: string): Promise<void>; end(): Promise<void> }>();
      let settled = false;

      const open = async (table: PartitionTable) => {
        const existing = streams.get(table);
        if (existing) return existing;
        const { stream, done } = lineSink(join(dir, `${table}${suffix}`), compress);
        const handle = {
          async write(line: string): Promise<void> {
            if (!stream.write(`${line}\n`)) await once(stream, 'drain');
          },
          async end(): Promise<void> {
            stream.end();
            await done;
          },
        };
        streams.set(table, handle);
        return handle;
      };

      return {
        key,
        generation,
        async write(table, row) {
          if (settled) fail('CONFIG', 'write after commit/abort on a partition projection');
          await (await open(table)).write(canonicalJson(row));
        },
        async commit(partial) {
          if (settled) fail('CONFIG', 'partition projection already settled');
          settled = true;
          for (const handle of streams.values()) await handle.end();
          // Every table exists in every generation, so a reader never finds a
          // generation with a table missing and has to guess whether that means
          // "empty" or "not written yet".
          for (const table of ['resolutions', 'conflicts', 'entity_links'] as PartitionTable[]) {
            if (!streams.has(table)) await writeFile(join(dir, `${table}${suffix}`), compress ? gzipSync('') : '');
          }

          const manifest: PartitionManifest = {
            ...partial,
            partitionId: partitionId(key),
            domain: key.domain,
            scopeId: key.scopeId,
            generation,
          };
          await writeFile(join(dir, 'manifest.json'), `${canonicalJson(manifest)}\n`);

          const temp = join(dirOf(key), `${CURRENT_POINTER}.${process.pid}.tmp`);
          await writeFile(temp, generation, 'utf8');
          await rename(temp, join(dirOf(key), CURRENT_POINTER));
          return manifest;
        },
        async abort() {
          if (settled) return;
          settled = true;
          for (const handle of streams.values()) await handle.end().catch(() => {});
          await rm(dir, { recursive: true, force: true });
        },
      };
    },

    async *readTable(key, table) {
      const generation = await currentGeneration(key);
      if (!generation) return;
      // A generation is written whole in one encoding; either file may exist.
      const zipped = join(dirOf(key), generation, `${table}.ndjson.gz`);
      const path = (await exists(zipped)) ? zipped : join(dirOf(key), generation, `${table}.ndjson`);
      try {
        yield* readLines(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    },

    async manifest(key) {
      const generation = await currentGeneration(key);
      if (!generation) return null;
      try {
        return JSON.parse(await readFile(join(dirOf(key), generation, 'manifest.json'), 'utf8')) as PartitionManifest;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    async manifests() {
      const out: PartitionManifest[] = [];
      for (const key of await store.listPartitions()) {
        const m = await store.manifest(key);
        if (m) out.push(m);
      }
      return out.sort((a, b) => (a.partitionId < b.partitionId ? -1 : a.partitionId > b.partitionId ? 1 : 0));
    },

    async listPartitions() {
      const out: PartitionKey[] = [];
      let domains: string[];
      try {
        domains = (await readdir(base)).sort();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      for (const domain of domains) {
        let scopes: string[];
        try {
          scopes = (await readdir(join(base, domain))).sort();
        } catch {
          continue;
        }
        for (const scope of scopes) out.push(parsePartitionId(`${domain}/${scope}`));
      }
      return out;
    },

    async sweepAbandoned() {
      let removed = 0;
      for (const key of await store.listPartitions()) {
        const keep = await currentGeneration(key);
        const dir = dirOf(key);
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.startsWith('gen-')) continue;
          if (entry === keep) continue;
          await rm(join(dir, entry), { recursive: true, force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };

  return store;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
