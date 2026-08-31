// Content identity primitives. Every digest in the Data Fabric is produced here
// so that "same bytes => same id" is a property of one auditable function.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Order-independent, key-sorted JSON serialisation. Two structurally equal
 * values always serialise to identical text, so digests are stable across
 * parser runs, machines and Node versions. Values JSON cannot round-trip
 * honestly (NaN, Infinity, bigint) are rejected rather than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number is not canonicalisable: ${value}`);
    return value;
  }
  if (typeof value === 'bigint') throw new TypeError('bigint is not canonicalisable');
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue; // absent and undefined must not produce different digests
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical JSON form: the content identity of a parsed record. */
export function contentDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Deterministic, namespaced surrogate id. Stable across re-runs and independent
 * of ingestion order, which is what makes replay and re-ingestion idempotent.
 * Parts are length-prefixed so ('a','bc') and ('ab','c') cannot collide.
 */
export function deterministicId(
  namespace: string,
  ...parts: readonly (string | number | null | undefined)[]
): string {
  const joined = parts.map((p) => {
    const s = String(p ?? '');
    return `${s.length}:${s}`;
  }).join('|');
  return `${namespace}_${sha256(`${namespace}|${joined}`).slice(0, 32)}`;
}

/**
 * Order-independent digest of a *set* of items, computed incrementally.
 *
 * DF-0C digested a run by collecting every per-record digest into an array,
 * sorting it and hashing the join. That needs the whole dataset in memory, which
 * is exactly what streaming exists to avoid.
 *
 * This accumulates instead: each item's sha256 is treated as a big-endian
 * 256-bit integer and added modulo 2^256. Addition is commutative, so ingestion
 * order cannot change the result, and unlike XOR it does not cancel duplicates —
 * two identical records digest differently from one. Memory is 32 bytes
 * regardless of how many items pass through.
 *
 * This is a set/multiset checksum for change detection, not a collision-
 * resistant commitment: an adversary who chooses inputs can construct a
 * collision, which is not a threat model that applies to a county parcel file.
 */
export class MultisetDigest {
  private readonly acc = new Uint8Array(32);
  private count = 0;

  /** Adds one item, digesting it first. */
  add(value: string | Uint8Array): this {
    return this.addDigest(createHash('sha256').update(value).digest());
  }

  /** Adds an item whose sha256 has already been computed (hex or bytes). */
  addDigest(digest: string | Uint8Array): this {
    const bytes = typeof digest === 'string' ? hexToBytes(digest) : digest;
    if (bytes.length !== 32) throw new TypeError(`expected a 32-byte digest, got ${bytes.length}`);
    let carry = 0;
    for (let i = 31; i >= 0; i--) {
      const sum = (this.acc[i] as number) + (bytes[i] as number) + carry;
      this.acc[i] = sum & 0xff;
      carry = sum >>> 8;
    }
    this.count += 1;
    return this;
  }

  get size(): number {
    return this.count;
  }

  /** The accumulated digest, hex encoded. Empty sets digest to all zeroes. */
  value(): string {
    return Buffer.from(this.acc).toString('hex');
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) throw new TypeError(`not a sha256 hex digest: ${hex}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
