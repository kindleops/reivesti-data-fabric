/**
 * Bounded-memory line I/O.
 *
 * Every large source artifact in the Fabric is line-delimited, and the DF-0C
 * code read them with `readFileSync` + `split('\n')` + `map(JSON.parse)` — three
 * simultaneous whole-dataset copies. At 448,000 parcels that is roughly 1.1 GB
 * of bytes, a 448,000-element string array, and a 448,000-element object array
 * alive at once.
 *
 * These helpers replace all three with a fixed-size read buffer.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { fail } from './errors.ts';

const DEFAULT_HIGH_WATER_MARK = 1 << 20; // 1 MiB

/**
 * Yields one line at a time from a file. The only memory retained is the read
 * buffer plus the partial line currently being assembled.
 *
 * A final line without a trailing newline is yielded; blank lines are skipped,
 * because a trailing newline at EOF is formatting rather than a record.
 */
export async function* readLines(
  path: string,
  options: { highWaterMark?: number } = {},
): AsyncGenerator<string> {
  // A `.gz` path is decompressed on the fly: the derived plane can be stored
  // compressed (DF-0K) without any reader knowing or caring.
  const raw = createReadStream(path, { highWaterMark: options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK });
  const stream: Readable = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  stream.setEncoding('utf8');
  if (stream !== raw) raw.on('error', (e) => stream.destroy(e));
  let carry = '';
  try {
    for await (const chunk of stream) {
      let start = 0;
      const text = carry + (chunk as string);
      carry = '';
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl === -1) {
          carry = text.slice(start);
          break;
        }
        const line = text.slice(start, nl);
        start = nl + 1;
        if (line.length > 0) yield line;
      }
    }
    if (carry.length > 0) yield carry;
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

/** Same, over an in-memory buffer. Used by small fixtures and tests. */
export function* readLinesFromString(text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      const tail = text.slice(start);
      if (tail.length > 0) yield tail;
      return;
    }
    const line = text.slice(start, nl);
    start = nl + 1;
    if (line.length > 0) yield line;
  }
}

/**
 * A line writer that applies backpressure.
 *
 * `write()` returning false means the OS buffer is full; awaiting `drain` is
 * what stops a fast producer (an ArcGIS crawl) from queueing the whole county
 * in the stream's internal buffer, which would defeat the point of streaming.
 */
export type LineWriter = {
  write(line: string): Promise<void>;
  /** Flushes and closes. Returns the number of lines written. */
  close(): Promise<number>;
  readonly lineCount: number;
};

export function createLineWriter(stream: Writable): LineWriter {
  let lineCount = 0;
  let closed = false;
  return {
    get lineCount() {
      return lineCount;
    },
    async write(line) {
      if (closed) fail('CONFIG', 'write() after close() on a line writer');
      lineCount += 1;
      if (!stream.write(`${line}\n`)) await once(stream, 'drain');
    },
    async close() {
      if (closed) return lineCount;
      closed = true;
      stream.end();
      await once(stream, 'finish');
      return lineCount;
    },
  };
}

/**
 * Opens a line writer on a file, owner-only by default.
 *
 * 0600 is the default rather than an option callers remember to pass. Every file
 * written through here so far holds either raw source rows or staged canonical
 * rows, and raw rows from an assessor's parcel layer carry owner names and
 * taxpayer mailing lines before the contact plane has separated them out. A
 * caller that genuinely wants a readable file says so.
 */
export async function createFileLineWriter(
  path: string,
  options: { readonly mode?: number } = {},
): Promise<LineWriter> {
  await mkdir(dirname(path), { recursive: true });
  return createLineWriter(createWriteStream(path, {
    mode: options.mode ?? 0o600,
    highWaterMark: DEFAULT_HIGH_WATER_MARK,
  }));
}

/**
 * Writes to a temporary sibling and renames on success.
 *
 * A crash or a thrown error leaves the temporary file and never the destination,
 * so a partially written file can never be mistaken for a complete one.
 */
export async function writeLinesAtomically(
  path: string,
  produce: (writer: LineWriter) => Promise<void>,
): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const writer = createLineWriter(createWriteStream(temp, {
    mode: 0o600, highWaterMark: DEFAULT_HIGH_WATER_MARK,
  }));
  try {
    await produce(writer);
    const count = await writer.close();
    await rename(temp, path);
    return count;
  } catch (error) {
    await writer.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
}

/** Consumes an async iterable in fixed-size batches without buffering the rest. */
export async function* inBatches<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  if (size < 1) fail('CONFIG', `batch size must be at least 1, got ${size}`);
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
