/**
 * Off-heap identity indexing.
 *
 * DF-0H's replay of 2.7 million Minnesota parcels died at row 2,625,000 under a
 * 1 GB heap. The cause was state that grew with the dataset in the one place a
 * heap limit applies. These tests hold the fix to two promises: the growth moved
 * off the heap, and it stayed exact while it moved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { isFabricError } from '../src/core/errors.ts';
import { createIdentityIndex, fingerprint64 } from '../src/runtime/identity-index.ts';

/**
 * A real collection, because `heapUsed` without one measures garbage.
 *
 * The first draft of these tests read `heapUsed` directly and got -37 MB for the
 * smaller of two runs: a scavenge had happened in between. A number that can
 * come out negative cannot distinguish retention from churn, which is the only
 * thing this file is here to do.
 */
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
setFlagsFromString('--no-expose-gc');

const heapUsed = (): number => {
  collect();
  collect();
  return process.memoryUsage().heapUsed;
};
const arrayBuffers = (): number => process.memoryUsage().arrayBuffers;
const MB = 1024 * 1024;

// ===========================================================================
// Exactness — the property that must survive the optimisation
// ===========================================================================

test('every distinct identity is distinct, and every repeat is a repeat', async () => {
  const index = createIdentityIndex({ expectedRows: 50_000, averageKeyBytes: 24 });
  const ids = Array.from({ length: 50_000 }, (_, i) => `parcel 27053:${String(i).padStart(13, '0')}`);

  for (const id of ids) assert.equal(index.add(id), false, `${id} was reported as a duplicate on first sight`);
  for (const id of ids) assert.equal(index.add(id), true, `${id} was not recognised on second sight`);

  const stats = index.stats();
  assert.equal(stats.inserted, 50_000);
  assert.equal(stats.duplicates, 50_000);
  index.close();
});

test('a fingerprint collision is a non-match, never a false duplicate', async () => {
  // A deliberately terrible fingerprint: every identity of the same length
  // collides. If the index trusted fingerprints, all 500 of these would be
  // reported as one parcel and 499 real properties would vanish.
  const index = createIdentityIndex({
    expectedRows: 1000,
    fingerprint: (value) => BigInt(value.length) + 1n,
  });

  for (let i = 0; i < 500; i += 1) {
    assert.equal(index.add(`parcel 27053:${String(i).padStart(6, '0')}`), false);
  }
  assert.equal(index.add('parcel 27053:000123'), true, 'a genuine repeat must still be caught');

  const stats = index.stats();
  assert.equal(stats.inserted, 500, 'no parcel was silently dropped');
  assert.ok(stats.fingerprintCollisions > 0, 'the collisions really happened, so the check really ran');
  index.close();
});

test('near-miss identities are not confused', async () => {
  const index = createIdentityIndex({ expectedRows: 100 });
  // Leading zeros, trailing space, case: all different identities.
  for (const id of ['0102724110003', '102724110003', '0102724110003 ', '0102724110003a']) {
    assert.equal(index.add(id), false, `${JSON.stringify(id)} collided with an earlier key`);
  }
  index.close();
});

test('multi-byte identities round-trip through the arena', async () => {
  const index = createIdentityIndex({ expectedRows: 100 });
  assert.equal(index.add('parcel Ståle:Ø-001'), false);
  assert.equal(index.add('parcel Ståle:Ø-001'), true);
  assert.equal(index.add('parcel Stale:O-001'), false);
  index.close();
});

test('has() answers without recording', async () => {
  const index = createIdentityIndex({ expectedRows: 100 });
  assert.equal(index.has('a'), false);
  index.add('a');
  assert.equal(index.has('a'), true);
  assert.equal(index.stats().inserted, 1);
  index.close();
});

// ===========================================================================
// Where the memory lives
// ===========================================================================

test('200,000 identities cost external memory, not heap', async () => {
  const index = createIdentityIndex({ expectedRows: 200_000, averageKeyBytes: 24 });

  // Measured after allocation, so the segment itself is not counted as growth:
  // what is under test is whether inserting rows adds heap.
  const heapBefore = heapUsed();
  const buffersBefore = arrayBuffers();

  for (let i = 0; i < 200_000; i += 1) index.add(`parcel 27053:${String(i).padStart(13, '0')}`);

  const heapGrowth = heapUsed() - heapBefore;
  const bufferGrowth = arrayBuffers() - buffersBefore;
  const stats = index.stats();

  // The old Set<number> measured 37 bytes of heap per row: 200,000 rows would
  // have been ~7 MB and rising linearly. After a real collection nothing
  // per-row should survive at all, so 3 MB is already generous.
  assert.ok(
    heapGrowth < 3 * MB,
    `inserting 200,000 identities grew the heap by ${(heapGrowth / MB).toFixed(1)} MB; something is retaining per row`,
  );
  // The bytes exist; they are simply somewhere the heap limit does not apply.
  assert.ok(stats.externalBytes > 5 * MB, 'the index should be holding real bytes');
  assert.ok(bufferGrowth <= 0 || bufferGrowth < stats.externalBytes + MB);
  index.close();
});

test('heap cost per identity does not grow with the row count', async () => {
  // The failing shape is a linear slope: 10x rows for 10x retained heap. Two
  // runs an order of magnitude apart make that visible without needing a
  // multi-million-row test in the unit suite.
  const measure = async (rows: number): Promise<number> => {
    const index = createIdentityIndex({ expectedRows: rows, averageKeyBytes: 24 });
    const before = heapUsed();
    for (let i = 0; i < rows; i += 1) index.add(`parcel 27053:${String(i).padStart(13, '0')}`);
    const growth = heapUsed() - before;
    index.close();
    return growth;
  };

  const small = await measure(20_000);
  const large = await measure(200_000);

  // 10x the rows must not be 10x the heap. Both are measured after a
  // collection, so what is left is retention.
  assert.ok(
    large < Math.max(3 * MB, small * 4),
    `heap grew from ${(small / MB).toFixed(1)} MB at 20k to ${(large / MB).toFixed(1)} MB at 200k — that is a row-sized slope`,
  );
});

test('external cost per identity is reported, not hidden', async () => {
  const index = createIdentityIndex({ expectedRows: 100_000, averageKeyBytes: 24 });
  for (let i = 0; i < 100_000; i += 1) index.add(`parcel 27053:${String(i).padStart(13, '0')}`);
  const stats = index.stats();
  // ~23 bytes of slot at the load factor, plus 2 + 24 of arena, plus headroom.
  assert.ok(stats.bytesPerIdentity > 0 && stats.bytesPerIdentity < 120, `bytesPerIdentity=${stats.bytesPerIdentity}`);
  assert.equal(stats.bytesPerIdentity, Math.round(stats.externalBytes / stats.inserted));
  index.close();
});

// ===========================================================================
// Segmentation
// ===========================================================================

test('a declared row count buys a single allocation', async () => {
  const index = createIdentityIndex({ expectedRows: 100_000, averageKeyBytes: 24 });
  for (let i = 0; i < 100_000; i += 1) index.add(`parcel 27053:${String(i).padStart(13, '0')}`);
  assert.equal(index.stats().segments, 1);
  index.close();
});

test('an undersized first segment grows without losing anything', async () => {
  // A header that under-reports, or a source with no count at all.
  const index = createIdentityIndex({ expectedRows: 500, averageKeyBytes: 24, segmentBytes: 1 << 16 });
  const ids = Array.from({ length: 20_000 }, (_, i) => `parcel 27053:${String(i).padStart(13, '0')}`);
  for (const id of ids) assert.equal(index.add(id), false);

  const stats = index.stats();
  assert.ok(stats.segments > 1, 'the index should have needed more than one segment');
  assert.equal(stats.inserted, 20_000);

  // Everything written into an earlier segment is still findable.
  for (const id of ids) assert.equal(index.has(id), true, `${id} was lost across a segment boundary`);
  index.close();
});

test('a duplicate spanning a segment boundary is still a duplicate', async () => {
  const index = createIdentityIndex({ expectedRows: 100, averageKeyBytes: 16, segmentBytes: 1 << 16 });
  index.add('first-identity-0');
  for (let i = 0; i < 20_000; i += 1) index.add(`filler-${i}`);
  assert.ok(index.stats().segments > 1);
  // The old spill design kept overflow in a heap Set; a segmented index must
  // look through every segment, not just the newest.
  assert.equal(index.add('first-identity-0'), true);
  index.close();
});

// ===========================================================================
// Contract edges
// ===========================================================================

test('the fingerprint is stable across processes and never zero', () => {
  assert.equal(fingerprint64('parcel 27053:0102724110003'), fingerprint64('parcel 27053:0102724110003'));
  assert.notEqual(fingerprint64('a'), fingerprint64('b'));
  assert.ok(fingerprint64('') > 0n);
});

test('an identity longer than the arena length prefix is refused', async () => {
  const index = createIdentityIndex({ expectedRows: 10 });
  assert.throws(() => index.add('x'.repeat(70_000)), (e: unknown) => isFabricError(e, 'CONFIG'));
  index.close();
});

test('using a closed index is an error, not a wrong answer', async () => {
  const index = createIdentityIndex({ expectedRows: 10 });
  index.add('a');
  index.close();
  index.close(); // idempotent
  assert.throws(() => index.has('a'), (e: unknown) => isFabricError(e, 'CONFIG'));
  assert.throws(() => index.add('b'), (e: unknown) => isFabricError(e, 'CONFIG'));
});

test('an empty index reports nothing rather than dividing by zero', async () => {
  const index = createIdentityIndex({ expectedRows: 10 });
  const stats = index.stats();
  assert.equal(stats.inserted, 0);
  assert.equal(stats.bytesPerIdentity, 0);
  assert.equal(stats.segments, 1);
  index.close();
});

// ===========================================================================
// The snapshot index and its lifecycle
//
// The index is the memory of what the last ACCEPTED snapshot held. Activating
// one from a quarantined run would make the next run diff against a snapshot
// nobody accepted and report every parcel the rejected delivery omitted as
// absent. The ordering in stream-run.ts already prevented that; these tests
// hold the rule itself.
// ===========================================================================

test('a snapshot index is BUILDING until it is built, and COMPLETE after', async () => {
  const { SnapshotIndexBuilder } = await import('../src/canonical/snapshot-index.ts');
  const builder = new SnapshotIndexBuilder(16);
  assert.equal(builder.lifecycle, 'BUILDING');
  builder.add('parcel-1', 'a'.repeat(64), 'b'.repeat(64));
  const index = builder.build();
  assert.equal(builder.lifecycle, 'COMPLETE');
  assert.equal(index.lifecycle, 'COMPLETE');
});

test('a built index takes no more entries, and is not built twice', async () => {
  const { SnapshotIndexBuilder } = await import('../src/canonical/snapshot-index.ts');
  const builder = new SnapshotIndexBuilder(16);
  builder.add('parcel-1', 'a'.repeat(64), 'b'.repeat(64));
  builder.build();
  assert.throws(() => builder.add('parcel-2', 'a'.repeat(64), 'b'.repeat(64)),
    (e: unknown) => isFabricError(e, 'CONFIG'));
  assert.throws(() => builder.build(), (e: unknown) => isFabricError(e, 'CONFIG'));
});

test('an index from a failed run cannot be activated', async () => {
  const { SnapshotIndexBuilder, activateSnapshotIndex } = await import('../src/canonical/snapshot-index.ts');
  const { join } = await import('node:path');
  const { tempRoot } = await import('./helpers.ts');
  const builder = new SnapshotIndexBuilder(16);
  builder.add('parcel-1', 'a'.repeat(64), 'b'.repeat(64));
  const abandoned = builder.fail();
  assert.equal(abandoned.lifecycle, 'FAILED');
  await assert.rejects(
    () => activateSnapshotIndex(join(tempRoot('df-idxfail-'), 'x.idx'), abandoned),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
});

test('a discarded index cannot be activated either, and says it was discarded', async () => {
  const { SnapshotIndexBuilder, activateSnapshotIndex } = await import('../src/canonical/snapshot-index.ts');
  const { join } = await import('node:path');
  const { tempRoot } = await import('./helpers.ts');
  const builder = new SnapshotIndexBuilder(16);
  builder.add('parcel-1', 'a'.repeat(64), 'b'.repeat(64));
  const index = builder.build();
  index.discard();
  assert.equal(index.lifecycle, 'DISCARDED');
  await assert.rejects(
    () => activateSnapshotIndex(join(tempRoot('df-idxdisc-'), 'x.idx'), index),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
});

test('activation marks the index live, and a reload is already live', async () => {
  const { SnapshotIndexBuilder, activateSnapshotIndex, readSnapshotIndex } =
    await import('../src/canonical/snapshot-index.ts');
  const { join } = await import('node:path');
  const { tempRoot } = await import('./helpers.ts');
  const path = join(tempRoot('df-idxok-'), 'x.idx');
  const builder = new SnapshotIndexBuilder(16);
  builder.add('parcel-1', 'a'.repeat(64), 'b'.repeat(64));
  const index = builder.build();
  await activateSnapshotIndex(path, index);
  assert.equal(index.lifecycle, 'ACTIVATED');
  assert.equal((await readSnapshotIndex(path)).lifecycle, 'ACTIVATED');
  // A source's first run has no predecessor, and every key it sees is new. That
  // is an activated empty index, not a failed one.
  assert.equal((await readSnapshotIndex(join(tempRoot('df-idxnone-'), 'absent.idx'))).lifecycle, 'ACTIVATED');
});

// ===========================================================================
// The contact plane's dedup ledger
// ===========================================================================

test('the contact plane counts exactly without holding a dataset', async () => {
  const { createContactPlane, contactObservationId } = await import('../src/contact/contact-plane.ts');
  const plane = createContactPlane({ maxRetained: 100, expectedObservations: 50_000 });

  const observation = (i: number) => ({
    contactObservationId: contactObservationId('synthetic', `rec-${i}`, `party-${i}`, 'mailing_address', `${i} GENERATED WAY`),
    partyObservationId: `party-${i}`,
    sourceId: 'synthetic',
    sourceRecordId: `rec-${i}`,
    contactType: 'mailing_address' as const,
    value: `${i} GENERATED WAY`,
    observedAt: '2026-08-31T12:00:00.000Z',
    usePermission: 'record_only' as const,
    protectedParty: false,
  });

  const before = heapUsed();
  for (let i = 0; i < 50_000; i += 1) plane.record(observation(i) as never);
  const growth = heapUsed() - before;

  // Exact, even though only 100 rows are retained for reading.
  assert.equal(plane.size(), 50_000);
  assert.equal(plane.read('operator').length, 100);

  // Recording the same observations again must not double-count: the ids are
  // deterministic, and a replay is not new evidence.
  for (let i = 0; i < 50_000; i += 1) plane.record(observation(i) as never);
  assert.equal(plane.size(), 50_000);

  // The old ledger was a Set<string> of 64-character ids, which maxRetained did
  // not bound: 50,000 of them is several megabytes and 2.7 million is not
  // survivable.
  assert.ok(
    growth < 6 * MB,
    `recording 50,000 contact observations grew the heap by ${(growth / MB).toFixed(1)} MB`,
  );
});

test('fingerprint collisions are a reported count, not a drift reason', async () => {
  // The exactness check rejecting a collision is the system working: no false
  // duplicate reached the estate. An earlier draft pushed the count onto the
  // session's `driftReasons`, which quarantines the run — so two sha256
  // prefixes matching would have failed a multi-million-row delivery whose
  // output was entirely correct.
  const { streamHarness, mnStatewideFixture } = await import('./helpers.ts');
  const harness = streamHarness();
  const result = await harness.runStatewide(mnStatewideFixture('five-county-2026-08.bundle'));

  assert.equal(result.run.status, 'completed');
  // Whatever the count is, it is carried as a number and never as a reason to
  // reject the delivery.
  assert.equal(result.run.failureKind, null);
  assert.ok(!/fingerprint/i.test(result.run.failureMessage ?? ''));
});
