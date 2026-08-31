/**
 * External-memory sort and k-way merge over line files.
 *
 * The property projection has to group every identifier observation by the
 * property it points at, across every source and every prior run. DF-0C did
 * that by loading the entire canonical estate into memory and grouping with a
 * `Map`, which is fine for three parcels and fatal for 448,000.
 *
 * The textbook answer is external sorting: sort bounded chunks in memory, spill
 * each to a run file, then merge the run files with one line from each held at a
 * time. Peak memory is `chunkSize` lines, not `n` lines, and the result is
 * byte-identical regardless of chunk size — which is what lets the tests assert
 * that batch size never changes output.
 *
 * Sorting is by an extracted string key, compared with plain `<`/`>` rather than
 * `localeCompare`, so ordering does not depend on the machine's locale.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail } from './errors.ts';
import { createLineWriter, readLines } from './lines.ts';

export const DEFAULT_CHUNK_LINES = 50_000;

export type SortOptions = {
  /** Lines held in memory per chunk. Bounds peak memory; never changes output. */
  readonly chunkLines?: number;
  /** Directory for spill files. Defaults to an OS temp directory. */
  readonly scratchDir?: string;
};

/**
 * Sorts `source` by `keyOf` and yields the lines in ascending key order.
 *
 * Ties are broken by the line itself, so the total order is deterministic even
 * when two records share a key.
 */
export async function* externalSort(
  source: AsyncIterable<string>,
  keyOf: (line: string) => string,
  options: SortOptions = {},
): AsyncGenerator<string> {
  const chunkLines = options.chunkLines ?? DEFAULT_CHUNK_LINES;
  if (chunkLines < 1) fail('CONFIG', `chunkLines must be at least 1, got ${chunkLines}`);

  const scratch = options.scratchDir
    ? await ensureDir(join(options.scratchDir, `sort-${process.pid}-${Date.now()}`))
    : await mkdtemp(join(tmpdir(), 'df-sort-'));

  const runFiles: string[] = [];
  let chunk: { key: string; line: string }[] = [];

  const spill = async (): Promise<void> => {
    if (chunk.length === 0) return;
    chunk.sort(compareEntries);
    const path = join(scratch, `run-${runFiles.length}.ndjson`);
    const writer = createLineWriter(createWriteStream(path));
    for (const entry of chunk) await writer.write(entry.line);
    await writer.close();
    runFiles.push(path);
    chunk = [];
  };

  try {
    for await (const line of source) {
      chunk.push({ key: keyOf(line), line });
      if (chunk.length >= chunkLines) await spill();
    }

    // The common case by far: everything fits in one chunk, so no file is ever
    // written and the sort is a plain in-memory sort of a bounded array.
    if (runFiles.length === 0) {
      chunk.sort(compareEntries);
      for (const entry of chunk) yield entry.line;
      return;
    }

    await spill();
    yield* mergeSortedFiles(runFiles, keyOf);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function compareEntries(a: { key: string; line: string }, b: { key: string; line: string }): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  if (a.line < b.line) return -1;
  if (a.line > b.line) return 1;
  return 0;
}

/**
 * K-way merge of already-sorted line files. Holds exactly one line per input.
 *
 * A linear scan picks the smallest head. With the handful of run files a
 * county-sized sort produces that beats a heap on constant factors, and it keeps
 * the code short enough to be obviously correct.
 */
export async function* mergeSortedFiles(
  paths: readonly string[],
  keyOf: (line: string) => string,
): AsyncGenerator<string> {
  const iterators = paths.map((p) => readLines(p)[Symbol.asyncIterator]());
  const heads: ({ key: string; line: string } | null)[] = [];

  for (const it of iterators) {
    const first = await it.next();
    heads.push(first.done ? null : { key: keyOf(first.value), line: first.value });
  }

  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (!head) continue;
      const current = heads[best];
      if (best === -1 || !current || compareEntries(head, current) < 0) best = i;
    }
    if (best === -1) return;

    const chosen = heads[best] as { key: string; line: string };
    yield chosen.line;

    const it = iterators[best];
    if (!it) return;
    const next = await it.next();
    heads[best] = next.done ? null : { key: keyOf(next.value), line: next.value };
  }
}

/**
 * Groups an already-sorted line stream by key, yielding one group at a time.
 *
 * Only the current group is held, so this is bounded as long as no single key
 * has an unbounded number of rows. For property resolution a key is one parcel,
 * which carries a handful of identifier observations.
 */
export async function* groupSorted<T>(
  sorted: AsyncIterable<string>,
  keyOf: (line: string) => string,
  parse: (line: string) => T,
): AsyncGenerator<{ key: string; items: T[] }> {
  let currentKey: string | null = null;
  let items: T[] = [];

  for await (const line of sorted) {
    const key = keyOf(line);
    if (currentKey !== null && key !== currentKey) {
      yield { key: currentKey, items };
      items = [];
    }
    currentKey = key;
    items.push(parse(line));
  }
  if (currentKey !== null) yield { key: currentKey, items };
}

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}
