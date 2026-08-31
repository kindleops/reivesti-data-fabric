/**
 * Staged, atomically activated canonical partitions.
 *
 * DF-0C wrote a run's canonical rows by replacing a partition file per table.
 * That was already enough to expose a half-written estate: a crash between the
 * bundles file and the events file leaves a run whose events do not match its
 * bundles, and nothing marks it as incomplete.
 *
 * Streaming makes it much worse, because a full-county write is minutes long.
 *
 * The fix is a generation pointer. A run's rows live at
 *
 *     runs/<runId>/<generation>/<table>.ndjson
 *
 * and `runs/<runId>/CURRENT` names the generation readers should use. A commit
 * writes an entirely new generation directory and then replaces CURRENT with a
 * single atomic rename. Until that rename, readers see the previous generation;
 * after it, they see the new one. There is no moment at which they see a mix.
 *
 * A crash therefore leaves the previous valid estate intact and an orphaned
 * generation directory, which `sweepAbandoned` removes.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { canonicalJson } from '../core/hash.ts';
import { fail } from '../core/errors.ts';
import { readLines } from '../core/lines.ts';

export const CURRENT_POINTER = 'CURRENT';

/** Tables a streaming run writes. Restricted rows are segregated on disk. */
export const STAGED_TABLES = [
  'bundles', 'events', 'absences',
  // Recorded-instrument rows (DF-0E). Segregated per table so the instrument
  // graph can be folded without reading canonical bundles it does not need.
  'instruments', 'instrument_parties', 'instrument_property_links',
  'legal_descriptions', 'instrument_references', 'recorded_financing',
  // State business-registry rows (DF-0F). Entities, their names, addresses and
  // filings, and the parties named on those filings. Party ADDRESSES are not
  // here: they are personal data and go to the restricted tables below.
  'business_entities', 'business_entity_names', 'business_entity_addresses',
  'business_entity_filings', 'business_filing_parties',
] as const;
export const RESTRICTED_TABLES = ['contacts'] as const;
export type StagedTable = (typeof STAGED_TABLES)[number] | (typeof RESTRICTED_TABLES)[number];

export type StagedRunWriter = {
  readonly runId: string;
  readonly generation: string;
  write(table: StagedTable, row: unknown): Promise<void>;
  counts(): Readonly<Record<string, number>>;
  /** Atomically activates everything written. */
  commit(): Promise<void>;
  /** Discards the generation. The previously active one is untouched. */
  abort(): Promise<void>;
};

export type GenerationStore = {
  beginRun(runId: string): Promise<StagedRunWriter>;
  /** Streams a table's rows for the active generation of every run. */
  readTable(table: StagedTable): AsyncGenerator<string>;
  readRunTable(runId: string, table: StagedTable): AsyncGenerator<string>;
  listRuns(): Promise<readonly string[]>;
  /** Removes generation directories no CURRENT pointer refers to. */
  sweepAbandoned(): Promise<number>;
};

export function createGenerationStore(root: string): GenerationStore {
  // Restricted rows live under a sibling root so a deployment has one directory
  // to lock down, exactly as in the buffered store.
  const dirFor = (table: StagedTable): string =>
    (RESTRICTED_TABLES as readonly string[]).includes(table) ? join(root, 'restricted') : join(root, 'derived');

  const runDir = (runId: string): string => join(root, 'derived', 'runs', safe(runId));
  const restrictedRunDir = (runId: string): string => join(root, 'restricted', 'runs', safe(runId));
  const dirOfRun = (table: StagedTable, runId: string): string =>
    (RESTRICTED_TABLES as readonly string[]).includes(table) ? restrictedRunDir(runId) : runDir(runId);

  const currentGeneration = async (base: string): Promise<string | null> => {
    try {
      return (await readFile(join(base, CURRENT_POINTER), 'utf8')).trim() || null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };

  return {
    async beginRun(runId) {
      const generation = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const streams = new Map<StagedTable, { write(line: string): Promise<void>; end(): Promise<void> }>();
      const counts: Record<string, number> = {};
      let settled = false;

      const open = async (table: StagedTable): Promise<{ write(line: string): Promise<void>; end(): Promise<void> }> => {
        const existing = streams.get(table);
        if (existing) return existing;
        const dir = join(dirOfRun(table, runId), generation);
        await mkdir(dir, { recursive: true });
        const restricted = (RESTRICTED_TABLES as readonly string[]).includes(table);
        const stream = createWriteStream(join(dir, `${table}.ndjson`), {
          mode: restricted ? 0o600 : 0o644,
          highWaterMark: 1 << 20,
        });
        const handle = {
          async write(line: string): Promise<void> {
            if (!stream.write(`${line}\n`)) await once(stream, 'drain');
          },
          async end(): Promise<void> {
            stream.end();
            await once(stream, 'finish');
          },
        };
        streams.set(table, handle);
        return handle;
      };

      return {
        runId,
        generation,
        async write(table, row) {
          if (settled) fail('CONFIG', 'write after commit/abort on a staged run');
          const handle = await open(table);
          await handle.write(canonicalJson(row));
          counts[table] = (counts[table] ?? 0) + 1;
        },
        counts: () => ({ ...counts }),

        async commit() {
          if (settled) fail('CONFIG', 'staged run already settled');
          settled = true;
          for (const handle of streams.values()) await handle.end();

          // Every table the run touched must exist before activation, so a
          // reader never finds a generation with a missing table.
          for (const table of [...STAGED_TABLES, ...RESTRICTED_TABLES] as StagedTable[]) {
            if (!streams.has(table)) {
              const dir = join(dirOfRun(table, runId), generation);
              await mkdir(dir, { recursive: true });
              await writeFile(join(dir, `${table}.ndjson`), '', {
                mode: (RESTRICTED_TABLES as readonly string[]).includes(table) ? 0o600 : 0o644,
              });
            }
          }

          // The activation itself: write the pointer beside its target and
          // rename over the old one. POSIX rename is atomic, so a reader sees
          // exactly one generation, never a partial swap.
          for (const base of [runDir(runId), restrictedRunDir(runId)]) {
            const temp = join(base, `${CURRENT_POINTER}.${process.pid}.tmp`);
            await writeFile(temp, generation, 'utf8');
            await rename(temp, join(base, CURRENT_POINTER));
          }
        },

        async abort() {
          if (settled) return;
          settled = true;
          for (const handle of streams.values()) await handle.end().catch(() => {});
          for (const base of [runDir(runId), restrictedRunDir(runId)]) {
            await rm(join(base, generation), { recursive: true, force: true });
          }
        },
      };
    },

    async *readTable(table) {
      const base = join(dirFor(table), 'runs');
      let runs: string[];
      try {
        runs = (await readdir(base)).sort();
      } catch {
        return;
      }
      for (const runId of runs) {
        yield* this.readRunTable(runId, table);
      }
    },

    async *readRunTable(runId, table) {
      const base = dirOfRun(table, runId);
      const generation = await currentGeneration(base);
      if (!generation) return;
      const path = join(base, generation, `${table}.ndjson`);
      try {
        yield* readLines(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    },

    async listRuns() {
      try {
        return (await readdir(join(root, 'derived', 'runs'))).sort();
      } catch {
        return [];
      }
    },

    async sweepAbandoned() {
      let removed = 0;
      for (const base of [join(root, 'derived', 'runs'), join(root, 'restricted', 'runs')]) {
        let runs: string[];
        try {
          runs = await readdir(base);
        } catch {
          continue;
        }
        for (const runId of runs) {
          const runBase = join(base, runId);
          const active = await currentGeneration(runBase);
          const entries = await readdir(runBase).catch(() => [] as string[]);
          for (const entry of entries) {
            if (entry === CURRENT_POINTER || entry === active) continue;
            if (!entry.startsWith('gen-')) continue;
            await rm(join(runBase, entry), { recursive: true, force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
  };
}

function safe(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) fail('CONFIG', `unsafe run id for a path segment: ${value}`);
  return value;
}
