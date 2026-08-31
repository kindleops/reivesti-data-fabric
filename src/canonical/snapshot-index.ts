/**
 * Bounded-memory snapshot key index.
 *
 * Snapshot diffing needs two things while a county streams past:
 *   1. for each incoming row, "have we seen this key, and with what content?"
 *   2. afterwards, "which keys did earlier snapshots have that this one lacks?"
 *
 * DF-0C answered both by loading every prior observation into a `Map` of
 * JavaScript strings. At 448,000 parcels that is roughly 70 MB of string
 * objects, and it grows with every source added to the estate.
 *
 * This replaces it with one fixed-width binary array:
 *
 *   bytes  0..7   key hash        (first 8 bytes of sha256 of the source record key)
 *   bytes  8..15  content digest  (first 8 bytes of the record's content digest)
 *   bytes 16..23  group digest    (first 8 bytes of a digest over the field groups)
 *
 * 24 bytes per row — 10.7 MB for the whole of Hennepin, and flat in the number
 * of canonical rows those parcels produce. Entries are sorted by key hash, so
 * lookup is a binary search, and a parallel bit set records which entries the
 * current snapshot matched, making absence a single scan at the end.
 *
 * On truncation: a 64-bit key hash over 448k keys has a birthday collision
 * probability around 5e-9. A collision would compare a row against the wrong
 * predecessor's digest, which almost certainly differs, so the row is classified
 * `changed` — the safe direction — and the real key is then also marked seen.
 * `ENTRY_BYTES` is exported so the width can be raised if a source ever needs it.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fail } from '../core/errors.ts';

export const ENTRY_BYTES = 24;
const MAGIC = 0x44465831; // "DFX1"
const HEADER_BYTES = 16;

export type IndexEntry = {
  readonly keyHash: bigint;
  readonly contentDigest: bigint;
  readonly groupDigest: bigint;
};

export type KeyComparison =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly groupsChanged: boolean };

/** Truncating hash used for all three columns. Not a security primitive. */
export function shortHash(value: string): bigint {
  const digest = createHash('sha256').update(value).digest();
  return digest.readBigUInt64BE(0);
}

/**
 * Accumulates entries for the snapshot being written, then sorts once at the
 * end. Peak memory is the entry array alone.
 */
export class SnapshotIndexBuilder {
  private buffer: BigUint64Array;
  private count = 0;

  constructor(expectedRows = 1024) {
    this.buffer = new BigUint64Array(Math.max(3, expectedRows * 3));
  }

  add(sourceRecordKey: string, contentDigestHex: string, groupDigestHex: string): void {
    if ((this.count + 1) * 3 > this.buffer.length) {
      const grown = new BigUint64Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    const at = this.count * 3;
    this.buffer[at] = shortHash(sourceRecordKey);
    this.buffer[at + 1] = truncateHex(contentDigestHex);
    this.buffer[at + 2] = truncateHex(groupDigestHex);
    this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  /** Sorted, deduplicated-by-nothing snapshot of the accumulated entries. */
  build(): SnapshotIndex {
    const entries = new BigUint64Array(this.count * 3);
    entries.set(this.buffer.subarray(0, this.count * 3));
    sortTriples(entries, this.count);
    return new SnapshotIndex(entries, this.count);
  }
}

export class SnapshotIndex {
  /** Flat [keyHash, contentDigest, groupDigest] triples, sorted by keyHash. */
  private readonly entries: BigUint64Array;
  private readonly count: number;
  private readonly seen: Uint8Array;

  constructor(entries: BigUint64Array, count: number) {
    this.entries = entries;
    this.count = count;
    this.seen = new Uint8Array(Math.ceil(Math.max(count, 1) / 8));
  }

  static empty(): SnapshotIndex {
    return new SnapshotIndex(new BigUint64Array(0), 0);
  }

  get size(): number {
    return this.count;
  }

  /** Approximate resident bytes, for the memory report. */
  get byteLength(): number {
    return this.entries.byteLength + this.seen.byteLength;
  }

  /**
   * Classifies a key against this index and marks it seen.
   *
   * Marking happens here rather than in a separate call so a caller cannot
   * classify a row and then forget to mark it, which would report a present
   * parcel as absent.
   */
  compareAndMark(sourceRecordKey: string, contentDigestHex: string, groupDigestHex: string): KeyComparison {
    const key = shortHash(sourceRecordKey);
    const at = this.find(key);
    if (at === -1) return { kind: 'absent' };
    this.seen[at >>> 3] = (this.seen[at >>> 3] as number) | (1 << (at & 7));

    const previousContent = this.entries[at * 3 + 1] as bigint;
    if (previousContent === truncateHex(contentDigestHex)) return { kind: 'unchanged' };
    return { kind: 'changed', groupsChanged: (this.entries[at * 3 + 2] as bigint) !== truncateHex(groupDigestHex) };
  }

  /** Key hashes present in this index that were never marked by the current pass. */
  unseenKeyHashes(): readonly bigint[] {
    const out: bigint[] = [];
    for (let i = 0; i < this.count; i++) {
      if (((this.seen[i >>> 3] as number) & (1 << (i & 7))) === 0) out.push(this.entries[i * 3] as bigint);
    }
    return out;
  }

  private find(key: bigint): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = this.entries[mid * 3] as bigint;
      if (candidate === key) return mid;
      if (candidate < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  toBytes(): Uint8Array {
    const out = Buffer.allocUnsafe(HEADER_BYTES + this.count * ENTRY_BYTES);
    out.writeUInt32BE(MAGIC, 0);
    out.writeUInt32BE(ENTRY_BYTES, 4);
    out.writeBigUInt64BE(BigInt(this.count), 8);
    for (let i = 0; i < this.count * 3; i++) {
      out.writeBigUInt64BE(this.entries[i] as bigint, HEADER_BYTES + i * 8);
    }
    return out;
  }

  static fromBytes(bytes: Uint8Array): SnapshotIndex {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length < HEADER_BYTES || buf.readUInt32BE(0) !== MAGIC) {
      fail('PARSE', 'snapshot index file is not a Data Fabric key index');
    }
    if (buf.readUInt32BE(4) !== ENTRY_BYTES) {
      fail('PARSE', `snapshot index has entry width ${buf.readUInt32BE(4)}, expected ${ENTRY_BYTES}`);
    }
    const count = Number(buf.readBigUInt64BE(8));
    if (buf.length !== HEADER_BYTES + count * ENTRY_BYTES) {
      fail('PARSE', 'snapshot index file is truncated');
    }
    const entries = new BigUint64Array(count * 3);
    for (let i = 0; i < count * 3; i++) entries[i] = buf.readBigUInt64BE(HEADER_BYTES + i * 8);
    return new SnapshotIndex(entries, count);
  }
}

export async function writeSnapshotIndex(path: string, index: SnapshotIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, index.toBytes(), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readSnapshotIndex(path: string): Promise<SnapshotIndex> {
  try {
    return SnapshotIndex.fromBytes(await readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return SnapshotIndex.empty();
    throw e;
  }
}

function truncateHex(hex: string): bigint {
  if (hex.length < 16) fail('CONFIG', `digest "${hex}" is too short to index`);
  return BigInt(`0x${hex.slice(0, 16)}`);
}

/**
 * In-place sort of flat triples by the first element.
 *
 * Written by hand because `TypedArray.prototype.sort` cannot sort a strided
 * array, and building 448,000 wrapper objects to use `Array.sort` would put back
 * the allocation this whole file exists to remove.
 */
function sortTriples(entries: BigUint64Array, count: number): void {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  // Sorting an index permutation keeps the comparison cheap and the moves few.
  const indices = Array.from(order);
  indices.sort((a, b) => {
    const ka = entries[a * 3] as bigint;
    const kb = entries[b * 3] as bigint;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const sorted = new BigUint64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const from = (indices[i] as number) * 3;
    sorted[i * 3] = entries[from] as bigint;
    sorted[i * 3 + 1] = entries[from + 1] as bigint;
    sorted[i * 3 + 2] = entries[from + 2] as bigint;
  }
  entries.set(sorted);
}
