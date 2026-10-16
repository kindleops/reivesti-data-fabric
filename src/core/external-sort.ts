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
import { gzipLineWriter, readLines, type LineWriter } from './lines.ts';

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
let sortSequence = 0;

function nextSortId(): number {
  sortSequence += 1;
  return sortSequence;
}

export async function* externalSort(
  source: AsyncIterable<string>,
  keyOf: (line: string) => string,
  options: SortOptions = {},
): AsyncGenerator<string> {
  const chunkLines = options.chunkLines ?? DEFAULT_CHUNK_LINES;
  if (chunkLines < 1) fail('CONFIG', `chunkLines must be at least 1, got ${chunkLines}`);

  // A counter, not just a timestamp. Two sorts started in the same millisecond
  // used to share a directory and clobber each other's `run-N.ndjson` spills —
  // which only happens when one sort feeds another, as the organization-link
  // join does, and which surfaced as a JSON parse error a million rows in.
  const scratch = options.scratchDir
    ? await ensureDir(join(options.scratchDir, `sort-${process.pid}-${Date.now()}-${nextSortId()}`))
    : await mkdtemp(join(tmpdir(), 'df-sort-'));

  const runFiles: string[] = [];
  let chunk: { key: string; line: string }[] = [];

  const spill = async (): Promise<void> => {
    if (chunk.length === 0) return;
    chunk.sort(compareEntries);
    const path = join(scratch, `run-${runFiles.length}.ndjson.gz`);
    const writer = spillWriter(path);
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
    yield* mergeSortedFiles(runFiles, keyOf, scratch, { consumeInputs: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Opens a spill file: owner-only, gzip level 1.
 *
 * 0600: a spill run holds source rows verbatim, including any contact-shaped
 * columns the connector has not yet routed to the restricted plane.
 *
 * Compressed because a sort's scratch is a copy of its input, and a sort that
 * merges in passes holds two (the runs, then the passes) beside the input
 * itself. DF-0M's Florida roll made that concrete: ~12 million contribution
 * lines, ~3.7 GB as plain NDJSON, so ~11 GB at the peak of one distribution —
 * more than a worker's disk. Contribution lines compress about sixfold at
 * level 1. `readLines` decompresses a `.gz` path on the fly, and ordering is
 * untouched: the bytes a sort yields are the same either way.
 */
function spillWriter(path: string): LineWriter {
  return gzipLineWriter(createWriteStream(path, { mode: 0o600 }));
}

function compareEntries(a: { key: string; line: string }, b: { key: string; line: string }): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  if (a.line < b.line) return -1;
  if (a.line > b.line) return 1;
  return 0;
}

/**
 * Read buffering the merge is allowed in total, across every open run file.
 *
 * `readLines` defaults to a 1 MiB buffer, which is right for one file and wrong
 * for eighty: the run count grows linearly with the dataset, so a fixed
 * per-file buffer makes merge memory grow linearly too. DF-0I measured the
 * organization fold — two nested sorts over a million observations, ~80 run
 * files each — peaking at 473 MB of heap and dying under a 256 MB cap, with
 * almost nothing retained afterwards. That is this, and it is the same
 * "bounded by a count rather than by bytes" shape the repository has now been
 * bitten by three times.
 */
const MERGE_BUFFER_BUDGET = 32 * 1024 * 1024;
const MIN_MERGE_BUFFER = 64 * 1024;
/** `readLines`' own default: the most one input is ever worth. */
const MAX_MERGE_BUFFER = 1024 * 1024;
/**
 * Run files merged at once. Beyond this the merge runs in passes.
 *
 * Even at the minimum buffer, an unbounded fan-in is unbounded memory — and
 * unbounded open file descriptors, which fails in a less legible way.
 */
const MAX_MERGE_FANIN = 64;

/**
 * K-way merge of already-sorted line files. Holds exactly one line per input.
 *
 * A linear scan picks the smallest head. With the handful of run files a
 * county-sized sort produces that beats a heap on constant factors, and it keeps
 * the code short enough to be obviously correct.
 *
 * Above `MAX_MERGE_FANIN` inputs it merges in passes, writing intermediate runs,
 * so both memory and open descriptors stay bounded however large the sort gets.
 */
export async function* mergeSortedFiles(
  paths: readonly string[],
  keyOf: (line: string) => string,
  scratch?: string,
  options: {
    /**
     * The inputs are the sort's own spill files: once a group has been merged
     * into a pass file it is never read again, so it is deleted there and then
     * instead of when the sort finishes. Without this a multi-pass merge holds
     * its whole input twice over. Never set for files the caller owns.
     */
    readonly consumeInputs?: boolean;
  } = {},
): AsyncGenerator<string> {
  if (paths.length > MAX_MERGE_FANIN && scratch !== undefined) {
    const merged: string[] = [];
    for (let at = 0; at < paths.length; at += MAX_MERGE_FANIN) {
      const group = paths.slice(at, at + MAX_MERGE_FANIN);
      // The same counter the spill directories use. A timestamp alone collides
      // across recursion levels, where `merged.length` restarts at zero — which
      // is precisely the shape of the DF-0F bug this counter was added for.
      const path = join(scratch, `pass-${nextSortId()}.ndjson.gz`);
      const writer = spillWriter(path);
      for await (const line of mergeSortedFiles(group, keyOf)) await writer.write(line);
      await writer.close();
      merged.push(path);
      if (options.consumeInputs === true) {
        for (const input of group) await rm(input, { force: true });
      }
    }
    // The pass files are the sort's own, inside its scratch directory, which the
    // caller removes when the sort finishes; each is released as soon as it is merged.
    yield* mergeSortedFiles(merged, keyOf, scratch, { consumeInputs: true });
    return;
  }

  // Never more than one file would have got on its own, never less than the
  // floor, and never more than the budget in total. Taking the budget as the
  // only rule made a 16-file merge allocate 2 MiB per file where it used to take
  // 1 MiB — a regression at the small end while fixing the large one.
  const highWaterMark = Math.min(
    MAX_MERGE_BUFFER,
    Math.max(MIN_MERGE_BUFFER, Math.floor(MERGE_BUFFER_BUDGET / Math.max(1, paths.length))),
  );
  const iterators = paths.map((p) => readLines(p, { highWaterMark })[Symbol.asyncIterator]());
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

/**
 * Groups an already-sorted line stream, yielding each group as a **stream**.
 *
 * `groupSorted` holds one whole group, which is fine when a key is one parcel
 * and fatal when a key is a placeholder owner name that appears on a hundred
 * thousand of them. This variant holds one line.
 *
 * The caller must fully drain each group's `items` before advancing the outer
 * iterator; the groups share one underlying cursor, so a partially consumed
 * group would leave its remaining lines in front of the next one.
 */
export async function* groupSortedStreaming<T>(
  sorted: AsyncIterable<string>,
  keyOf: (line: string) => string,
  parse: (line: string) => T,
): AsyncGenerator<{ key: string; items: AsyncGenerator<T> }> {
  const cursor = sorted[Symbol.asyncIterator]();
  let pending = await cursor.next();

  while (!pending.done) {
    const key = keyOf(pending.value);
    async function* items(): AsyncGenerator<T> {
      while (!pending.done && keyOf(pending.value) === key) {
        const line = pending.value;
        pending = await cursor.next();
        yield parse(line);
      }
    }
    const group = items();
    yield { key, items: group };
    // Drain anything the caller left, so the next group starts where it should.
    for await (const _ of group) { /* discard */ }
  }
}

async function ensureDir(path: string): Promise<string> {
  // 0700, matching what mkdtemp gives the no-scratchDir path. A caller-supplied
  // scratch directory must not be the reason spill files become readable.
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
