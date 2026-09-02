/**
 * Off-heap duplicate detection.
 *
 * ## What was wrong
 *
 * The parse session kept every source record identity it had seen so it could
 * report a repeat. DF-0F used `Map<string, number>`; DF-0H replaced it with
 * `Set<number>` of 53-bit fingerprints, which helped and did not fix the shape
 * of the problem: **measured at 37 bytes of JS heap per row**, so 100 MB for
 * Minnesota's 2.7 million parcels and 204 MB for New York's 5.5 million. That is
 * proportional to source size, which is the thing DF-0I exists to end.
 *
 * ## What this does instead
 *
 * Fingerprints and the identity text live in `BigUint64Array`s and `Buffer`s.
 * Those bytes are **external** memory, not V8 heap — measured at ~0 bytes of
 * `heapUsed` per row — so the structure that grows with the dataset no longer
 * grows in the place the 1 GB limit applies.
 *
 * The index is **segmented**. A segment is a fixed-size open-addressed table
 * plus a key arena, allocated whole and never resized or copied. When a segment
 * fills, the next one is allocated at **twice** the capacity, up to a cap;
 * membership is "present in any segment". A source that declares its row count
 * gets a right-sized first segment and allocates exactly once. A caller that
 * cannot know its size — the contact plane's dedup ledger, for instance —
 * starts small and reaches millions of keys in about a dozen allocations, so the
 * per-lookup cost of walking the segments stays negligible and nothing is ever
 * copied.
 *
 * ## What this does not claim
 *
 * Memory is **flat on the heap, linear off it**: roughly 40 bytes of external
 * memory per distinct identity. It is not magic, and an earlier draft of this
 * file pretended otherwise — it spilled overflow to disk while keeping a
 * `Set<string>` of the spilled keys in memory, which is a heap-proportional
 * structure wearing a disk-backed comment. Segments are the honest version:
 * the growth is real, it is off-heap, it is bounded per allocation, and the
 * stats report it.
 *
 * ## Exactness
 *
 * A 64-bit fingerprint is not the identity; it is a filter. Every hit is
 * confirmed against the **full identity string**, held in the same external
 * buffer, so a fingerprint collision produces a confirmed non-match rather than
 * a false duplicate. Approximate structures assist and never decide — the phase
 * brief is explicit and it is the right rule: a false duplicate silently drops a
 * real parcel.
 */
import { createHash } from 'node:crypto';
import { fail } from '../core/errors.ts';

/** Slots are 16 bytes: 8 for the fingerprint, 8 for the key's byte offset. */
const SLOT_BYTES = 16;
/** Open addressing degrades sharply past this; segments are cheap, so stop early. */
const MAX_LOAD = 0.7;
const EMPTY = 0n;

/**
 * Largest single allocation, and the size used when the row count is unknown.
 *
 * 96 MB of external memory holds roughly 2.4 million identities of typical
 * parcel-key length. Bigger sources allocate more segments rather than one
 * enormous buffer, which keeps any single failed allocation survivable.
 */
export const DEFAULT_SEGMENT_BYTES = 96 * 1024 * 1024;

/** Assumed identity length when the caller does not say. County-scoped parcel keys run ~25. */
const ASSUMED_KEY_BYTES = 32;

/**
 * Rows the first segment holds when the caller cannot say how many there will
 * be. Small enough that an index holding three keys costs nothing, and doubling
 * reaches ten million in twelve allocations.
 */
const UNDECLARED_FIRST_SEGMENT_ROWS = 4096;

export type IdentityIndexOptions = {
  /**
   * Rows the source declares. Sizes the first segment, capped at `segmentBytes`
   * so one wrong header cannot ask for a gigabyte. Omit it and the index starts
   * small and doubles.
   */
  readonly expectedRows?: number;
  /** Average identity length in bytes, if the caller knows better than the default. */
  readonly averageKeyBytes?: number;
  /** Largest single segment allocation, in bytes. */
  readonly segmentBytes?: number;
  /**
   * Fingerprint function, overridable so tests can force collisions.
   *
   * The exactness claim in this file's header is only worth making if something
   * proves it, and a sha256 prefix collision cannot be produced on demand. A
   * test substitutes a deliberately weak function and asserts that colliding
   * identities are still reported as distinct.
   */
  readonly fingerprint?: (value: string) => bigint;
};

export type IdentityIndexStats = {
  readonly inserted: number;
  readonly duplicates: number;
  /** Fingerprint hits that the full-key check rejected. Proof exactness matters. */
  readonly fingerprintCollisions: number;
  /** Segments allocated. One means the row count was declared and honoured. */
  readonly segments: number;
  readonly slots: number;
  /** Total external bytes held. Deliberately reported: this is the growth. */
  readonly externalBytes: number;
  /** External bytes per distinct identity, for the run report. */
  readonly bytesPerIdentity: number;
};

/**
 * Synchronous on purpose.
 *
 * The first version returned promises because it spilled to disk. It does not
 * any more, and an async signature on a function that never awaits anything
 * forces every caller into an async context for no reason — including the
 * contact plane's `record()`, which is called once per contact observation and
 * has no business being a promise.
 */
export type IdentityIndex = {
  /** True when this identity has been seen before. Exact. */
  has(identity: string): boolean;
  /** Records an identity. Returns true when it was already present. */
  add(identity: string): boolean;
  stats(): IdentityIndexStats;
  /** Releases every segment. Safe to call twice. */
  close(): void;
};

/** 64-bit fingerprint. sha256-derived so it is stable across processes. */
export function fingerprint64(value: string): bigint {
  const digest = createHash('sha256').update(value).digest();
  const fp = digest.readBigUInt64BE(0);
  // Zero marks an empty slot, so it is never a valid fingerprint.
  return fp === EMPTY ? 1n : fp;
}

type Segment = {
  readonly fingerprints: BigUint64Array;
  readonly offsets: BigUint64Array;
  readonly arena: Buffer;
  readonly slotCount: number;
  readonly mask: bigint;
  readonly capacity: number;
  arenaUsed: number;
  inserted: number;
};

export function createIdentityIndex(options: IdentityIndexOptions = {}): IdentityIndex {
  const maxSegmentBytes = Math.max(1 << 16, options.segmentBytes ?? DEFAULT_SEGMENT_BYTES);
  const keyBytes = Math.max(1, options.averageKeyBytes ?? ASSUMED_KEY_BYTES);
  const fingerprintOf = options.fingerprint ?? fingerprint64;

  // Rows the first segment is built for: what the source declared, or a small
  // starter that doubles.
  const bytesPerRow = SLOT_BYTES / MAX_LOAD + 2 + keyBytes;
  const maxSegmentRows = Math.max(64, Math.floor(maxSegmentBytes / bytesPerRow));
  const firstSegmentRows = Math.min(
    maxSegmentRows,
    Math.max(64, options.expectedRows ?? UNDECLARED_FIRST_SEGMENT_ROWS),
  );
  let nextSegmentRows = firstSegmentRows;

  const segments: Segment[] = [allocate(firstSegmentRows, keyBytes, maxSegmentBytes)];

  let duplicates = 0;
  let fingerprintCollisions = 0;
  let closed = false;

  const readKey = (segment: Segment, offset: number): string => {
    const length = segment.arena.readUInt16BE(offset);
    return segment.arena.toString('utf8', offset + 2, offset + 2 + length);
  };

  /** Probes one segment. Returns the slot to write into, and whether it already holds this key. */
  const probe = (segment: Segment, identity: string, fp: bigint): { slot: number; found: boolean } => {
    let slot = Number(fp & segment.mask);
    for (;;) {
      const held = segment.fingerprints[slot] as bigint;
      if (held === EMPTY) return { slot, found: false };
      if (held === fp) {
        // A fingerprint match is a candidate, never a verdict.
        if (readKey(segment, Number(segment.offsets[slot] as bigint)) === identity) return { slot, found: true };
        fingerprintCollisions += 1;
      }
      slot = (slot + 1) & (segment.slotCount - 1);
    }
  };

  /**
   * Newest segment first: a repeat within the current batch is the common case,
   * and the newest segment is the one still being filled.
   */
  const find = (identity: string, fp: bigint): boolean => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (probe(segments[i] as Segment, identity, fp).found) return true;
    }
    return false;
  };

  const index: IdentityIndex = {
    has(identity) {
      if (closed) fail('CONFIG', 'the identity index was queried after close');
      return find(identity, fingerprintOf(identity));
    },

    add(identity) {
      if (closed) fail('CONFIG', 'the identity index was written after close');
      const bytes = Buffer.byteLength(identity, 'utf8');
      if (bytes > 0xffff) fail('CONFIG', 'a source record identity longer than 65535 bytes is not an identity');

      const fp = fingerprintOf(identity);
      if (find(identity, fp)) {
        duplicates += 1;
        return true;
      }

      let target = segments[segments.length - 1] as Segment;
      const full = target.inserted + 1 > target.capacity || target.arenaUsed + 2 + bytes > target.arena.byteLength;
      if (full) {
        // Grow by a whole segment, twice the size of the last, up to the cap.
        // Nothing already written is copied or moved, so the cost of having
        // guessed the size low is a handful of extra probes rather than a
        // rehash, and the segment count stays logarithmic in the row count.
        nextSegmentRows = Math.min(maxSegmentRows, nextSegmentRows * 2);
        target = allocate(nextSegmentRows, keyBytes, maxSegmentBytes);
        segments.push(target);
      }

      const offset = target.arenaUsed;
      target.arena.writeUInt16BE(bytes, offset);
      target.arena.write(identity, offset + 2, 'utf8');
      target.arenaUsed = offset + 2 + bytes;

      const { slot } = probe(target, identity, fp);
      target.fingerprints[slot] = fp;
      target.offsets[slot] = BigInt(offset);
      target.inserted += 1;
      return false;
    },

    stats() {
      let inserted = 0;
      let slots = 0;
      let externalBytes = 0;
      for (const segment of segments) {
        inserted += segment.inserted;
        slots += segment.slotCount;
        externalBytes += segment.fingerprints.byteLength + segment.offsets.byteLength + segment.arena.byteLength;
      }
      return {
        inserted,
        duplicates,
        fingerprintCollisions,
        segments: segments.length,
        slots,
        externalBytes,
        bytesPerIdentity: inserted === 0 ? 0 : Math.round(externalBytes / inserted),
      };
    },

    close() {
      closed = true;
      // Dropping the references is the release: these are ordinary allocations,
      // and holding a closed index alive is the caller's bug, not ours.
      segments.length = 0;
    },
  };

  return index;
}

/**
 * Allocates a segment sized for `rows` identities, never exceeding `maxBytes`.
 *
 * The table and the arena are sized from the row count rather than by splitting
 * a byte budget between them. An earlier version split the budget by ratio and
 * then rounded the slot count up to a power of two, which quietly ate up to half
 * the arena: 100,000 rows asked for 5 MB, got 1.2 MB of arena, filled it after
 * 45,000 and allocated a fresh 96 MB segment for the rest — 1,060 bytes per
 * identity. Sizing both from `rows` keeps them running out together.
 */
function allocate(rows: number, keyBytes: number, maxBytes: number): Segment {
  let planned = Math.max(64, Math.floor(rows));
  let slotCount = 1024;
  let arenaBytes = 1 << 12;

  for (;;) {
    slotCount = nextPowerOfTwo(Math.ceil(planned / MAX_LOAD));
    // A tenth of slack on the arena: `keyBytes` is an average, and running a
    // little long should not cost a whole extra segment.
    arenaBytes = Math.ceil(planned * (2 + keyBytes) * 1.1) + 4096;
    if (slotCount * SLOT_BYTES + arenaBytes <= maxBytes || planned <= 64) break;
    planned = Math.max(64, Math.floor(planned * 0.8));
  }

  return {
    fingerprints: new BigUint64Array(slotCount),
    offsets: new BigUint64Array(slotCount),
    // allocUnsafe is correct here: every byte read is behind a length prefix
    // this file wrote, so uninitialised bytes are never observable.
    arena: Buffer.allocUnsafe(arenaBytes),
    slotCount,
    mask: BigInt(slotCount - 1),
    capacity: Math.floor(slotCount * MAX_LOAD),
    arenaUsed: 0,
    inserted: 0,
  };
}

function nextPowerOfTwo(n: number): number {
  let p = 1024;
  while (p < n) p *= 2;
  return p;
}
