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
 *
 * ## Lifecycle
 *
 * An index is the memory of what the last accepted snapshot contained, so the
 * next run can say which parcels vanished. Activating one from a run that was
 * quarantined would make the *following* run diff against a snapshot nobody
 * accepted, and report a county's worth of parcels as absent. The ordering in
 * `stream-run.ts` already prevented that; `IndexLifecycle` makes it a rule the
 * type system helps enforce rather than a property of statement order:
 *
 *     BUILDING ──build()──▶ COMPLETE ──activate()──▶ ACTIVATED
 *        │                     │
 *        └──────fail()─────────┴──▶ FAILED ──▶ (never written)
 *                              └──discard()──▶ DISCARDED
 *
 * A FAILED or DISCARDED index cannot be written, and a COMPLETE one cannot take
 * more entries.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail } from '../core/errors.ts';

export const ENTRY_BYTES = 24;
const MAGIC = 0x44465831; // "DFX1"
const HEADER_BYTES = 16;

export type IndexEntry = {
  readonly keyHash: bigint;
  readonly contentDigest: bigint;
  readonly groupDigest: bigint;
};

/**
 * Where an index is in its life.
 *
 * `DISCARDED` is distinct from `FAILED` on purpose: a discarded index was
 * correct and is simply no longer wanted (a dry run, a superseded generation),
 * while a failed one is not known to be correct at all. Collapsing them would
 * lose the ability to tell "we threw this away" from "this went wrong".
 */
export type IndexLifecycleState = 'BUILDING' | 'COMPLETE' | 'ACTIVATED' | 'FAILED' | 'DISCARDED';

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
  private state: IndexLifecycleState = 'BUILDING';

  /**
   * @param expectedRows rows the source declares. Sizing from it avoids the
   *   doubling reallocations: a 2.7-million-row delivery starting from the old
   *   1,024-entry default copied the whole array twelve times on the way up.
   */
  constructor(expectedRows = 1024) {
    this.buffer = new BigUint64Array(Math.max(3, expectedRows * 3));
  }

  get lifecycle(): IndexLifecycleState {
    return this.state;
  }

  add(sourceRecordKey: string, contentDigestHex: string, groupDigestHex: string): void {
    if (this.state !== 'BUILDING') fail('CONFIG', `a ${this.state} snapshot index cannot take more entries`);
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
    if (this.state !== 'BUILDING') fail('CONFIG', `a ${this.state} snapshot index cannot be built again`);
    const entries = new BigUint64Array(this.count * 3);
    entries.set(this.buffer.subarray(0, this.count * 3));
    sortTriples(entries, this.count);
    this.state = 'COMPLETE';
    return new SnapshotIndex(entries, this.count, 'COMPLETE');
  }

  /**
   * Abandons the index because the run did not succeed.
   *
   * Returns the index so a caller can record what it was going to be, but it can
   * never be written: the next run must keep diffing against the last snapshot
   * anybody accepted.
   */
  fail(): SnapshotIndex {
    this.state = 'FAILED';
    return new SnapshotIndex(new BigUint64Array(0), 0, 'FAILED');
  }
}

export class SnapshotIndex {
  /** Flat [keyHash, contentDigest, groupDigest] triples, sorted by keyHash. */
  private readonly entries: BigUint64Array;
  private readonly count: number;
  private readonly seen: Uint8Array;

  private state: IndexLifecycleState;

  constructor(entries: BigUint64Array, count: number, state: IndexLifecycleState = 'COMPLETE') {
    this.entries = entries;
    this.count = count;
    this.seen = new Uint8Array(Math.ceil(Math.max(count, 1) / 8));
    this.state = state;
  }

  static empty(): SnapshotIndex {
    // An absent index is ACTIVATED and empty, not FAILED: a source's first run
    // legitimately has no predecessor, and every key it sees is new.
    return new SnapshotIndex(new BigUint64Array(0), 0, 'ACTIVATED');
  }

  get lifecycle(): IndexLifecycleState {
    return this.state;
  }

  /** Marks the index live. Called by `activateSnapshotIndex` after the rename. */
  markActivated(): void {
    if (this.state !== 'COMPLETE') fail('CONFIG', `a ${this.state} snapshot index cannot be activated`);
    this.state = 'ACTIVATED';
  }

  /** Abandons a correct index that is no longer wanted. Distinct from failure. */
  discard(): void {
    this.state = 'DISCARDED';
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

  /** True when this index holds `keyHash`. Does not mark it seen. */
  hasKeyHash(keyHash: bigint): boolean {
    return this.find(keyHash) !== -1;
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
    // Read back from disk means it was activated by whichever run wrote it.
    return new SnapshotIndex(entries, count, 'ACTIVATED');
  }
}

/**
 * Writes an index and marks it live.
 *
 * Refuses anything that is not COMPLETE. That is the whole safety property: a
 * quarantined run's index would make the next run diff against a snapshot that
 * was never accepted, and every parcel the rejected delivery happened to omit
 * would be reported absent.
 */
export async function activateSnapshotIndex(path: string, index: SnapshotIndex): Promise<void> {
  if (index.lifecycle !== 'COMPLETE') {
    fail('CONFIG', `refusing to activate a ${index.lifecycle} snapshot index`, { path });
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, index.toBytes(), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  index.markActivated();
}

/** Former name. Kept as an alias so callers read one way of saying this. */
export const writeSnapshotIndex = activateSnapshotIndex;

/**
 * Where a source's snapshot index for one identity partition lives.
 *
 * Parcel identity is county-scoped, so the index is too: a delivery covering
 * five counties reads and rewrites five small files rather than one national
 * one, a failure is isolated to the counties it touched, and a county's absence
 * detection is answered from that county's own prior state. `null` is the
 * single index of a source whose identity is genuinely nation-scoped —
 * organizations, for instance, where partitioning would be a lie about the
 * identity space rather than a decomposition of it.
 */
export function snapshotIndexPath(root: string, sourceId: string, partitionKey: string | null): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (partitionKey === null) return join(root, `${safe(sourceId)}.idx`);
  // The filename IS the partition key: `listIndexedPartitions` reads it back to
  // work out which partitions a delivery did not cover. A key that had to be
  // rewritten to be a filename would not round-trip, and the mismatch would
  // report a covered partition as uncovered. County FIPS are already safe; a
  // connector inventing something else has to say so.
  if (safe(partitionKey) !== partitionKey) {
    fail('CONFIG', `partition key "${partitionKey}" is not usable as a file name`, {
      remedy: 'use only letters, digits, dot, underscore and hyphen in a partition key',
    });
  }
  return join(root, safe(sourceId), `${partitionKey}.idx`);
}

/**
 * Partitions this source already has an index for.
 *
 * Used to notice a partition that had prior state and produced no rows in the
 * current delivery. Returns `[null]` for a source stored as a single index.
 */
export async function listIndexedPartitions(root: string, sourceId: string): Promise<(string | null)[]> {
  const safe = sourceId.replace(/[^A-Za-z0-9._-]/g, '_');
  const out: (string | null)[] = [];
  try {
    await stat(join(root, `${safe}.idx`));
    out.push(null);
  } catch { /* no single index; the source is partitioned or new */ }
  try {
    for (const name of await readdir(join(root, safe))) {
      if (name.endsWith('.idx')) out.push(name.slice(0, -4));
    }
  } catch { /* no partition directory; the source is unpartitioned or new */ }
  return out.sort((a, b) => String(a).localeCompare(String(b)));
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
  // Sorted in place in the Uint32Array: an earlier version copied it into a
  // plain Array first, which for 2.7 million rows is ~22 MB of boxed numbers on
  // the heap this module exists to keep empty.
  const indices = order;
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

// ---------------------------------------------------------------------------
// Absence tombstones (DF-0K)
// ---------------------------------------------------------------------------

const TOMBSTONE_MAGIC = 0x44465431; // "DFT1"

/**
 * Keys this partition has seen in some accepted snapshot and not in the latest.
 *
 * The snapshot index remembers only the previous snapshot, so a parcel that
 * vanished from one release and came back in the next looked exactly like a
 * brand-new parcel. For an annual statewide roll that is a real distinction —
 * a county re-submitting a parcel it had dropped is not a new parcel — and it
 * needs memory of more than one release.
 *
 * Stored off-heap and sorted, beside the index, one file per partition. Size is
 * bounded by how many parcels a partition has dropped, not by the partition.
 */
export class TombstoneSet {
  private readonly keys: BigUint64Array;

  constructor(sortedUniqueKeys: BigUint64Array) {
    this.keys = sortedUniqueKeys;
  }

  static empty(): TombstoneSet {
    return new TombstoneSet(new BigUint64Array(0));
  }

  static fromUnsorted(keys: readonly bigint[] | BigUint64Array): TombstoneSet {
    const sorted = BigUint64Array.from(keys).sort();
    let unique = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i] as bigint;
    }
    return new TombstoneSet(sorted.slice(0, unique));
  }

  get size(): number {
    return this.keys.length;
  }

  has(keyHash: bigint): boolean {
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = this.keys[mid] as bigint;
      if (candidate === keyHash) return true;
      if (candidate < keyHash) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /**
   * The next tombstone set: prior tombstones not seen again, plus the keys the
   * prior snapshot held that this one did not.
   */
  next(seenNow: SnapshotIndex, newlyAbsent: readonly bigint[]): TombstoneSet {
    const carried: bigint[] = [];
    for (const key of this.keys) if (!seenNow.hasKeyHash(key)) carried.push(key);
    return TombstoneSet.fromUnsorted([...carried, ...newlyAbsent]);
  }

  toBytes(): Uint8Array {
    const out = Buffer.allocUnsafe(HEADER_BYTES + this.keys.length * 8);
    out.writeUInt32BE(TOMBSTONE_MAGIC, 0);
    out.writeUInt32BE(8, 4);
    out.writeBigUInt64BE(BigInt(this.keys.length), 8);
    for (let i = 0; i < this.keys.length; i++) out.writeBigUInt64BE(this.keys[i] as bigint, HEADER_BYTES + i * 8);
    return out;
  }
}

export function tombstonePath(indexPath: string): string {
  return indexPath.replace(/\.idx$/, '.absent');
}

export async function readTombstones(path: string): Promise<TombstoneSet> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return TombstoneSet.empty();
    throw e;
  }
  if (bytes.length < HEADER_BYTES || bytes.readUInt32BE(0) !== TOMBSTONE_MAGIC) {
    fail('PARSE', 'tombstone file is not a Data Fabric absence set', { path });
  }
  const count = Number(bytes.readBigUInt64BE(8));
  if (bytes.length !== HEADER_BYTES + count * 8) fail('PARSE', 'tombstone file is truncated', { path });
  const keys = new BigUint64Array(count);
  for (let i = 0; i < count; i++) keys[i] = bytes.readBigUInt64BE(HEADER_BYTES + i * 8);
  return new TombstoneSet(keys);
}

/** Written only beside an activated index; an empty set removes the file. */
export async function writeTombstones(path: string, set: TombstoneSet): Promise<void> {
  if (set.size === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, set.toBytes(), { mode: 0o600 });
  await rename(temp, path);
}
