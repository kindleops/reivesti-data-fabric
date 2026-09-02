/**
 * DF-0I: retained bytes per row, per structure, measured in isolation.
 *
 * The phase brief is explicit that total heap is not evidence — "do not merely
 * infer from total heap" — and it was right to be: the DF-0H diagnosis blamed
 * the identity set and the snapshot index, and measuring them one at a time
 * showed the real cost was somewhere else entirely.
 *
 * Run:  node --expose-gc tools/memprofile.ts [rows]
 */
import { SnapshotIndexBuilder } from '../src/canonical/snapshot-index.ts';
import { createIdentityIndex } from '../src/runtime/identity-index.ts';

const N = Number(process.argv[2] ?? 1_000_000);
const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;
const snap = () => {
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss };
};
async function settle(): Promise<void> {
  if (global.gc) { global.gc(); global.gc(); }
  await new Promise((r) => setTimeout(r, 60));
}

/** The DF-0H fingerprint, kept so the comparison is against the real thing. */
function legacyFingerprint(value: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return (a % 0x200000) * 0x100000000 + b;
}

const key = (i: number): string => `parcel 27053:${String(i).padStart(13, '0')}`;
const rows: { structure: string; heapPerRow: number; heapMB: number; externalMB: number }[] = [];

async function measure(structure: string, build: () => Promise<{ keepAlive: unknown }>): Promise<void> {
  await settle();
  const before = snap();
  const { keepAlive } = await build();
  await settle();
  const after = snap();
  rows.push({
    structure,
    heapPerRow: Math.round((after.heap - before.heap) / N),
    heapMB: mb(after.heap - before.heap),
    externalMB: mb(after.external - before.external),
  });
  void keepAlive;
}

// A. The DF-0H identity structure, for the baseline it is being replaced by.
await measure('identity Set<number> (DF-0H)', async () => {
  const seen = new Set<number>();
  for (let i = 0; i < N; i++) seen.add(legacyFingerprint(key(i)));
  return { keepAlive: seen };
});

// B. The DF-0I replacement.
await measure('identity index (DF-0I, off-heap)', async () => {
  const index = await createIdentityIndex({ expectedRows: N, averageKeyBytes: 26 });
  for (let i = 0; i < N; i++) await index.add(key(i));
  return { keepAlive: index };
});

// C. The snapshot index while it accumulates.
await measure('SnapshotIndexBuilder', async () => {
  const builder = new SnapshotIndexBuilder(N);
  const digest = 'a'.repeat(64);
  for (let i = 0; i < N; i++) builder.add(key(i), digest, digest);
  return { keepAlive: builder };
});

// D. …and once built and sorted, which is when it is largest.
await measure('SnapshotIndex (built + sorted)', async () => {
  const builder = new SnapshotIndexBuilder(N);
  const digest = 'a'.repeat(64);
  for (let i = 0; i < N; i++) builder.add(key(i), digest, digest);
  return { keepAlive: builder.build() };
});

console.log(`rows: ${N.toLocaleString()}\n`);
console.log('structure                          heap/row    heap MB   external MB');
for (const r of rows) {
  console.log(
    `${r.structure.padEnd(34)}${String(r.heapPerRow).padStart(8)}${String(r.heapMB).padStart(11)}${String(r.externalMB).padStart(14)}`,
  );
}
