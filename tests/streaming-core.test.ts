import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStreamingArtifactStore } from '../src/archive/artifact-store.ts';
import { createStreamingFilesystemObjectStore } from '../src/archive/object-store.ts';
import { DEFAULT_CHUNK_LINES, externalSort, groupSorted } from '../src/core/external-sort.ts';
import { isFabricError } from '../src/core/errors.ts';
import { MultisetDigest, sha256 } from '../src/core/hash.ts';
import { inBatches, readLines, readLinesFromString, writeLinesAtomically } from '../src/core/lines.ts';
import {
  SnapshotIndexBuilder,
  readSnapshotIndex,
  shortHash,
  writeSnapshotIndex,
} from '../src/canonical/snapshot-index.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';
import { forEachOrdered } from '../src/runtime/arcgis-stream.ts';
import { tempRoot } from './helpers.ts';

// --- line I/O -------------------------------------------------------------------

test('readLines yields every line and skips the trailing newline', async () => {
  const root = tempRoot('df-lines-');
  const path = join(root, 'a.ndjson');
  writeFileSync(path, 'one\ntwo\nthree\n');
  const seen: string[] = [];
  for await (const line of readLines(path)) seen.push(line);
  assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('readLines reassembles lines that straddle the read buffer', async () => {
  const root = tempRoot('df-lines-');
  const path = join(root, 'big.ndjson');
  // Lines far longer than the buffer prove the carry logic, which is the only
  // subtle part of reading a file without holding it.
  const lines = Array.from({ length: 200 }, (_, i) => `${i}:${'x'.repeat(5000)}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const seen: string[] = [];
  for await (const line of readLines(path, { highWaterMark: 64 })) seen.push(line);
  assert.deepEqual(seen, lines);
});

test('a file with no trailing newline still yields its last line', async () => {
  const root = tempRoot('df-lines-');
  const path = join(root, 'notrail.ndjson');
  writeFileSync(path, 'a\nb');
  const seen: string[] = [];
  for await (const line of readLines(path)) seen.push(line);
  assert.deepEqual(seen, ['a', 'b']);
});

test('the string reader matches the file reader exactly', () => {
  assert.deepEqual([...readLinesFromString('a\nb\n\nc')], ['a', 'b', 'c']);
});

test('writeLinesAtomically leaves no file when the producer throws', async () => {
  const root = tempRoot('df-atomic-');
  const path = join(root, 'out.ndjson');
  await assert.rejects(() => writeLinesAtomically(path, async (w) => {
    await w.write('one');
    throw new Error('interrupted');
  }));
  assert.equal(existsSync(path), false, 'a partial file must never appear at the destination');
  assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('out.ndjson') && !f.endsWith('.tmp')), []);
});

test('inBatches never holds more than one batch', async () => {
  async function* source(): AsyncGenerator<number> {
    for (let i = 0; i < 10; i++) yield i;
  }
  const sizes: number[] = [];
  for await (const b of inBatches(source(), 3)) sizes.push(b.length);
  assert.deepEqual(sizes, [3, 3, 3, 1]);
  await assert.rejects(async () => {
    for await (const _ of inBatches(source(), 0)) break;
  }, (e: unknown) => isFabricError(e, 'CONFIG'));
});

// --- external sort ----------------------------------------------------------------

const keyOf = (line: string): string => line.split('|')[0] as string;

async function* shuffled(n: number): AsyncGenerator<string> {
  // A deterministic non-sorted order, so the test is repeatable.
  for (let i = 0; i < n; i++) yield `${String((i * 7919) % n).padStart(6, '0')}|row${i}`;
}

test('external sort produces the same order at every chunk size', async () => {
  const collect = async (chunkLines: number): Promise<string[]> => {
    const out: string[] = [];
    for await (const line of externalSort(shuffled(500), keyOf, { chunkLines })) out.push(line);
    return out;
  };
  // 1 forces a spill file per line; 10_000 keeps everything in memory. Identical
  // output at both ends is what lets batch size be an operational dial.
  const [one, tiny, big] = await Promise.all([collect(1), collect(17), collect(10_000)]);
  assert.equal(one.length, 500);
  assert.deepEqual(one, tiny);
  assert.deepEqual(one, big);
  assert.deepEqual(one.map(keyOf), [...one.map(keyOf)].sort());
});

test('external sort breaks ties deterministically', async () => {
  async function* duplicates(): AsyncGenerator<string> {
    yield 'k|b'; yield 'k|a'; yield 'k|c';
  }
  const out: string[] = [];
  for await (const line of externalSort(duplicates(), keyOf, { chunkLines: 1 })) out.push(line);
  assert.deepEqual(out, ['k|a', 'k|b', 'k|c']);
});

test('external sort cleans up its spill directory', async () => {
  const scratch = tempRoot('df-sort-');
  const out: string[] = [];
  for await (const line of externalSort(shuffled(200), keyOf, { chunkLines: 10, scratchDir: scratch })) out.push(line);
  assert.equal(out.length, 200);
  assert.deepEqual(readdirSync(scratch), [], 'spill files must not outlive the sort');
});

test('two concurrent sorts sharing a scratch directory do not clobber each other', async () => {
  // The organization-link join runs one sort inside another, so several are live
  // at once. Spill directories used to be named by pid and millisecond, which
  // meant two sorts started together shared one and overwrote each other's
  // `run-N.ndjson` files. Only fires above the chunk threshold — hence the tiny
  // chunk size — and only when the two sorts carry DIFFERENT data, which is why
  // they are tagged here: identical inputs would hide the clobbering entirely.
  const scratch = tempRoot('df-sort-shared-');
  const options = { chunkLines: 10, scratchDir: scratch };

  async function* tagged(tag: string): AsyncGenerator<string> {
    for await (const line of shuffled(200)) yield `${line}|${tag}`;
  }

  const left = externalSort(tagged('left'), keyOf, options)[Symbol.asyncIterator]();
  const right = externalSort(tagged('right'), keyOf, options)[Symbol.asyncIterator]();

  const a: string[] = [];
  const b: string[] = [];
  for (;;) {
    const [l, r] = await Promise.all([left.next(), right.next()]);
    if (!l.done) a.push(l.value);
    if (!r.done) b.push(r.value);
    if (l.done && r.done) break;
  }

  assert.equal(a.length, 200);
  assert.equal(b.length, 200);
  assert.ok(a.every((line) => line.endsWith('|left')), 'the left sort read the right sort\'s spill files');
  assert.ok(b.every((line) => line.endsWith('|right')), 'the right sort read the left sort\'s spill files');
  assert.deepEqual(readdirSync(scratch), [], 'both sorts must clean up after themselves');
});

test('groupSorted yields one group per key, holding only that group', async () => {
  async function* sorted(): AsyncGenerator<string> {
    yield 'a|1'; yield 'a|2'; yield 'b|3'; yield 'c|4'; yield 'c|5'; yield 'c|6';
  }
  const groups: { key: string; n: number }[] = [];
  for await (const g of groupSorted(sorted(), keyOf, (l) => l)) groups.push({ key: g.key, n: g.items.length });
  assert.deepEqual(groups, [{ key: 'a', n: 2 }, { key: 'b', n: 1 }, { key: 'c', n: 3 }]);
});

test('the default chunk size is a sane operational value', () => {
  assert.ok(DEFAULT_CHUNK_LINES >= 10_000 && DEFAULT_CHUNK_LINES <= 500_000);
});

// --- multiset digest ----------------------------------------------------------------

test('the streaming digest is order independent and duplicate sensitive', () => {
  const items = ['alpha', 'beta', 'gamma', 'delta'];
  const forward = new MultisetDigest();
  for (const i of items) forward.add(i);
  const reverse = new MultisetDigest();
  for (const i of [...items].reverse()) reverse.add(i);
  const withDuplicate = new MultisetDigest();
  for (const i of [...items, 'alpha']) withDuplicate.add(i);

  assert.equal(forward.value(), reverse.value());
  // XOR would make these equal, which is exactly why addition is used instead.
  assert.notEqual(forward.value(), withDuplicate.value());
  assert.equal(forward.size, 4);
  assert.equal(new MultisetDigest().value(), '0'.repeat(64));
});

test('the streaming digest accepts precomputed digests identically', () => {
  const direct = new MultisetDigest().add('x').add('y');
  const precomputed = new MultisetDigest().addDigest(sha256('x')).addDigest(sha256('y'));
  assert.equal(direct.value(), precomputed.value());
  assert.throws(() => new MultisetDigest().addDigest('nope'), TypeError);
});

// --- snapshot index -------------------------------------------------------------------

test('the key index classifies absent, unchanged and changed', () => {
  const builder = new SnapshotIndexBuilder();
  builder.add('key-a', sha256('a1'), sha256('ga'));
  builder.add('key-b', sha256('b1'), sha256('gb'));
  const index = builder.build();

  assert.deepEqual(index.compareAndMark('key-a', sha256('a1'), sha256('ga')), { kind: 'unchanged' });
  assert.deepEqual(index.compareAndMark('key-b', sha256('b2'), sha256('gb')), { kind: 'changed', groupsChanged: false });
  assert.deepEqual(index.compareAndMark('key-c', sha256('c1'), sha256('gc')), { kind: 'absent' });
});

test('the index reports which keys the current pass never saw', () => {
  const builder = new SnapshotIndexBuilder();
  for (const k of ['a', 'b', 'c']) builder.add(k, sha256(k), sha256(k));
  const index = builder.build();
  index.compareAndMark('a', sha256('a'), sha256('a'));
  index.compareAndMark('c', sha256('c'), sha256('c'));
  assert.deepEqual(index.unseenKeyHashes(), [shortHash('b')]);
});

test('the index is fixed width, so its memory is a function of rows not of content', () => {
  const build = (n: number, pad: string): number => {
    const b = new SnapshotIndexBuilder(n);
    for (let i = 0; i < n; i++) b.add(`key-${i}${pad}`, sha256(String(i)), sha256(String(i)));
    return b.build().byteLength;
  };
  // 24 bytes of entry plus one bit of seen-marker per row, and nothing else:
  // a thousand-character key costs exactly the same as a short one.
  assert.equal(build(1000, ''), build(1000, 'x'.repeat(1000)));
  assert.ok(build(1000, '') < 30_000, 'a thousand rows should cost well under 30 KB');
  assert.equal(build(2000, '') - build(1000, ''), 1000 * 24 + 125);
});

test('the index round-trips through disk', async () => {
  const root = tempRoot('df-idx-');
  const path = join(root, 'source.idx');
  const builder = new SnapshotIndexBuilder();
  for (const k of ['k1', 'k2', 'k3']) builder.add(k, sha256(k), sha256(k));
  await writeSnapshotIndex(path, builder.build());

  const reloaded = await readSnapshotIndex(path);
  assert.equal(reloaded.size, 3);
  assert.deepEqual(reloaded.compareAndMark('k2', sha256('k2'), sha256('k2')), { kind: 'unchanged' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a missing index reads as empty rather than failing a first run', async () => {
  const index = await readSnapshotIndex(join(tempRoot('df-idx-'), 'absent.idx'));
  assert.equal(index.size, 0);
  assert.deepEqual(index.compareAndMark('anything', sha256('x'), sha256('y')), { kind: 'absent' });
});

test('a corrupt index is refused rather than silently treated as empty', async () => {
  const root = tempRoot('df-idx-');
  const path = join(root, 'bad.idx');
  writeFileSync(path, Buffer.from('not an index at all, really not'));
  await assert.rejects(() => readSnapshotIndex(path), (e: unknown) => isFabricError(e, 'PARSE'));
});

// --- streaming artifact ------------------------------------------------------------------

test('a streamed artifact is hashed incrementally and lands at its digest', async () => {
  const root = tempRoot('df-stream-');
  const store = createStreamingArtifactStore(createStreamingFilesystemObjectStore(root));
  const lines = ['{"a":1}', '{"a":2}', '{"a":3}'];
  const body = `${lines.join('\n')}\n`;

  const artifact = await store.archiveStream(archiveInput(), async (sink) => {
    for (const line of lines) await sink.write(`${line}\n`);
  });

  assert.equal(artifact.sha256, sha256(body));
  assert.equal(artifact.byteLength, Buffer.byteLength(body));
  assert.ok(artifact.storagePath.includes(`sha256-${artifact.sha256}`));
  assert.equal(artifact.created, true);
  await store.verify(artifact);
});

test('identical streamed content dedupes to one artifact', async () => {
  const root = tempRoot('df-stream-');
  const store = createStreamingArtifactStore(createStreamingFilesystemObjectStore(root));
  const write = async (): Promise<void> => {};
  const first = await store.archiveStream(archiveInput(), async (s) => { await s.write('same\n'); await write(); });
  const second = await store.archiveStream(
    archiveInput({ retrievedAt: '2026-09-07T00:00:00.000Z' }),
    async (s) => { await s.write('same\n'); },
  );
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  // The first sighting's retrieval time is the historical fact.
  assert.equal(second.manifest.retrievedAt, first.manifest.retrievedAt);
});

test('the same filename with different content becomes a separate artifact', async () => {
  const root = tempRoot('df-stream-');
  const store = createStreamingArtifactStore(createStreamingFilesystemObjectStore(root));
  const a = await store.archiveStream(archiveInput(), async (s) => { await s.write('week 31\n'); });
  const b = await store.archiveStream(archiveInput(), async (s) => { await s.write('week 32\n'); });
  assert.notEqual(a.sha256, b.sha256);
  assert.notEqual(a.storagePath, b.storagePath);
  assert.equal(a.manifest.originalFilename, b.manifest.originalFilename);
  await store.verify(a);
  await store.verify(b);
});

test('an interrupted stream produces no artifact at all', async () => {
  const root = tempRoot('df-stream-');
  const store = createStreamingFilesystemObjectStore(root);
  const artifacts = createStreamingArtifactStore(store);

  await assert.rejects(() => artifacts.archiveStream(archiveInput(), async (sink) => {
    await sink.write('half a county\n');
    throw new Error('connection reset');
  }), /connection reset/);

  // Nothing under the content-addressed tree, and no staging file left behind.
  const listed = await store.list('data-fabric');
  assert.deepEqual(listed, [], 'a failed stream must not leave a valid artifact');
  const staging = join(root, '.staging');
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], []);
});

test('a tampered streamed artifact fails verification without being read', async () => {
  const root = tempRoot('df-stream-');
  const objects = createStreamingFilesystemObjectStore(root);
  const store = createStreamingArtifactStore(objects);
  const artifact = await store.archiveStream(archiveInput(), async (s) => { await s.write('authentic\n'); });

  const onDisk = objects.pathOf(artifact.storagePath);
  const { chmodSync } = await import('node:fs');
  chmodSync(onDisk, 0o644);
  writeFileSync(onDisk, 'tampered\n');

  await assert.rejects(() => store.verify(artifact), (e: unknown) => isFabricError(e, 'REPLAY'));
  // And the line reader verifies BEFORE yielding, so a consumer never sees a
  // single corrupt row.
  await assert.rejects(async () => {
    for await (const _ of store.readLinesVerified(artifact)) break;
  }, (e: unknown) => isFabricError(e, 'REPLAY'));
});

// --- staged activation ----------------------------------------------------------------

test('a committed generation is visible and an aborted one is not', async () => {
  const root = tempRoot('df-gen-');
  const store = createGenerationStore(root);

  const first = await store.beginRun('run_a');
  await first.write('bundles', { n: 1 });
  await first.commit();
  assert.deepEqual(await collect(store.readRunTable('run_a', 'bundles')), ['{"n":1}']);

  const aborted = await store.beginRun('run_a');
  await aborted.write('bundles', { n: 999 });
  await aborted.abort();
  // The previously activated generation is untouched.
  assert.deepEqual(await collect(store.readRunTable('run_a', 'bundles')), ['{"n":1}']);
});

test('an interrupted run leaves the previous estate intact', async () => {
  const root = tempRoot('df-gen-');
  const store = createGenerationStore(root);
  const first = await store.beginRun('run_a');
  await first.write('bundles', { n: 1 });
  await first.commit();

  // Simulate a crash: write a generation and never commit it.
  const crashed = await store.beginRun('run_a');
  await crashed.write('bundles', { n: 2 });
  await crashed.write('bundles', { n: 3 });

  assert.deepEqual(await collect(store.readRunTable('run_a', 'bundles')), ['{"n":1}']);
  assert.equal(await store.sweepAbandoned() >= 1, true);
  assert.deepEqual(await collect(store.readRunTable('run_a', 'bundles')), ['{"n":1}']);
});

test('a successful rerun atomically replaces the previous generation', async () => {
  const root = tempRoot('df-gen-');
  const store = createGenerationStore(root);
  const first = await store.beginRun('run_a');
  await first.write('bundles', { n: 1 });
  await first.commit();

  const second = await store.beginRun('run_a');
  await second.write('bundles', { n: 1 });
  await second.write('bundles', { n: 2 });
  await second.commit();

  assert.deepEqual(await collect(store.readRunTable('run_a', 'bundles')), ['{"n":1}', '{"n":2}']);
  assert.equal(await store.sweepAbandoned(), 2, 'the superseded generation is reclaimable');
});

test('restricted rows are written to a separate root with owner-only permissions', async () => {
  const root = tempRoot('df-gen-');
  const store = createGenerationStore(root);
  const run = await store.beginRun('run_a');
  await run.write('bundles', { n: 1 });
  await run.write('contacts', { value: '555-0100' });
  await run.commit();

  const derived = join(root, 'derived', 'runs', 'run_a');
  const restricted = join(root, 'restricted', 'runs', 'run_a');
  assert.ok(existsSync(derived) && existsSync(restricted));

  const generation = readFileSync(join(restricted, 'CURRENT'), 'utf8').trim();
  const contactsFile = join(restricted, generation, 'contacts.ndjson');
  assert.equal(statSync(contactsFile).mode & 0o777, 0o600);

  // No contact value anywhere under the non-restricted root.
  const scan = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of scan(join(root, 'derived'))) {
    assert.ok(!readFileSync(file, 'utf8').includes('555-0100'), `contact value leaked into ${file}`);
  }
});

// --- backpressure ------------------------------------------------------------------------

test('the ordered scheduler respects max concurrency and preserves order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const consumed: number[] = [];

  await forEachOrdered(20, 3,
    async (index) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Reverse-staggered delays: without ordering, output would be scrambled.
      await new Promise((r) => { setTimeout(r, (20 - index) % 5); });
      inFlight -= 1;
      return index;
    },
    async (_index, value) => { consumed.push(value); });

  assert.deepEqual(consumed, Array.from({ length: 20 }, (_, i) => i));
  assert.ok(maxInFlight <= 3, `expected at most 3 in flight, saw ${maxInFlight}`);
  assert.ok(maxInFlight > 1, 'concurrency should actually be used');
});

test('a failing batch rejects rather than being silently skipped', async () => {
  await assert.rejects(() => forEachOrdered(5, 2,
    async (index) => { if (index === 3) throw new Error('batch 3 failed'); return index; },
    async () => {}), /batch 3 failed/);
});

// ---------------------------------------------------------------------------

function archiveInput(overrides: Record<string, unknown> = {}): never {
  return {
    sourceAuthority: 'Hennepin County, Minnesota',
    sourceProgram: 'County Parcels',
    sourceFamily: 'county_assessor',
    sourceId: 'mn_hennepin_county_parcels',
    releaseId: 'rel-2026-08',
    referencePeriod: '2026-08',
    originalUrl: null,
    originalFilename: 'snapshot.ndjson',
    retrievedAt: '2026-08-31T12:00:00.000Z',
    effectiveAt: null,
    jurisdictionIds: ['us-county-27053'],
    access: {
      accessType: 'api',
      automationStatus: 'sanctioned',
      termsStatus: 'reviewed_permitted',
      licenseStatus: 'public_domain',
      carriesRestrictedContact: true,
    },
    ...overrides,
  } as never;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}
