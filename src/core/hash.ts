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
