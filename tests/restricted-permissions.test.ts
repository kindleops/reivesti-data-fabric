/**
 * Restricted data is owner-only all the way down (DF-0O).
 *
 * DF-0N found restricted FILES at 0600 under directories created 0755 by the
 * process umask: run ids, generation ids and table names were listable by any
 * local user. These tests pin the fix on every path that creates or recovers
 * such a directory — a fresh run, a nested generation, an interrupted run, a
 * recovered estate written by older code, the buffered store, the artifact
 * store (raw publisher bytes carry mailing fields), a rehydrated fresh worker
 * and a network-off replay — under the ordinary 022 umask.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { ensurePrivateDir, tightenTree } from '../src/core/private-fs.ts';
import { SnapshotIndex, activateSnapshotIndex, snapshotIndexPath } from '../src/canonical/snapshot-index.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';
import { createNdjsonFabricStore } from '../src/runtime/fabric-store.ts';
import { createFilesystemObjectStore, createStreamingFilesystemObjectStore } from '../src/archive/object-store.ts';
import { createLocalBackend } from '../src/archive/artifact-backend.ts';
import type { DurableStore } from '../src/archive/durable-artifacts.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { replayNyFromArchive, runNyStatewidePipeline, type NyPipelineOptions } from '../src/connectors/ny-statewide-parcels/pipeline.ts';
import { RUN_INSTANT, streamHarness, tempRoot } from './helpers.ts';
import { buildNyPolygonRelease, buildNyRelease, nyFakePublisher, nyParcel } from './support/ny-fixture.ts';

process.umask(0o022);

const mode = (p: string) => statSync(p).mode & 0o777;

function walk(dir: string): { dirs: string[]; files: string[] } {
  const out = { dirs: [dir], files: [] as string[] };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const sub = walk(p); out.dirs.push(...sub.dirs); out.files.push(...sub.files); } else out.files.push(p);
  }
  return out;
}

function assertOwnerOnlyTree(root: string, label: string): void {
  const { dirs, files } = walk(root);
  for (const d of dirs) assert.equal(mode(d) & 0o077, 0, `${label}: directory ${d} is ${mode(d).toString(8)}`);
  for (const f of files) assert.equal(mode(f) & 0o077, 0, `${label}: file ${f} is ${mode(f).toString(8)}`);
}

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

test('ensurePrivateDir creates nested directories 0700 and tightens wider ones below its root only', async () => {
  const base = tempRoot('df-priv-');
  const above = join(base, 'above');
  const root = join(above, 'restricted');
  mkdirSync(root, { recursive: true });
  chmodSync(above, 0o755);
  chmodSync(root, 0o755); // a recovered estate written by older code
  await ensurePrivateDir(join(root, 'runs', 'run_x', 'gen-1'), root);
  for (const d of [root, join(root, 'runs'), join(root, 'runs', 'run_x'), join(root, 'runs', 'run_x', 'gen-1')]) {
    assert.equal(mode(d), 0o700, d);
  }
  assert.equal(mode(above), 0o755, 'nothing above the root is touched');
  await assert.rejects(ensurePrivateDir(join(base, 'elsewhere'), root), /must lie under its root/);
});

test('tightenTree reports open entries and, with fix, keeps read-only evidence read-only', async () => {
  const root = tempRoot('df-tree-');
  mkdirSync(join(root, 'a'), { mode: 0o755 });
  chmodSync(join(root, 'a'), 0o755);
  writeFileSync(join(root, 'a', 'evidence'), 'x', { mode: 0o444 });
  writeFileSync(join(root, 'a', 'rows'), 'x', { mode: 0o644 });
  const before = await tightenTree(root, { fix: false });
  assert.ok(before.directoriesOpen >= 1 && before.filesOpen === 2);
  await tightenTree(root, { fix: true });
  assert.equal(mode(join(root, 'a')), 0o700);
  assert.equal(mode(join(root, 'a', 'evidence')), 0o400, 'still read-only');
  assert.equal(mode(join(root, 'a', 'rows')), 0o600);
  assert.equal((await tightenTree(root, { fix: false })).filesOpen, 0);
  assert.equal((await tightenTree(join(root, 'absent'), { fix: false })).present, false);
});

// ---------------------------------------------------------------------------
// The stores
// ---------------------------------------------------------------------------

test('a staged run writes restricted rows owner-only at every level, CURRENT included', async () => {
  const varRoot = tempRoot('df-staged-');
  const store = createGenerationStore(varRoot, { compress: false });
  const run = await store.beginRun('run_a');
  await run.write('contacts', { contactObservationId: 'c1', value: 'A FICTITIOUS ADDRESS' });
  await run.write('bundles', { b: 1 });
  await run.commit();
  assertOwnerOnlyTree(join(varRoot, 'restricted'), 'restricted');
  assert.equal(mode(join(varRoot, 'restricted', 'runs', 'run_a', 'CURRENT')), 0o600);
  assert.equal(mode(join(varRoot, 'derived', 'runs', 'run_a', 'CURRENT')), 0o644, 'the derived plane is unchanged');
});

test('a recovered estate with wide restricted directories is tightened by the next run', async () => {
  const varRoot = tempRoot('df-recover-');
  const old = join(varRoot, 'restricted', 'runs', 'run_old', 'gen-old');
  mkdirSync(old, { recursive: true });
  for (const d of [join(varRoot, 'restricted'), join(varRoot, 'restricted', 'runs')]) chmodSync(d, 0o755);
  const store = createGenerationStore(varRoot, { compress: false });
  const run = await store.beginRun('run_new');
  await run.write('contacts', { contactObservationId: 'c1' });
  await run.commit();
  assert.equal(mode(join(varRoot, 'restricted')), 0o700);
  assert.equal(mode(join(varRoot, 'restricted', 'runs')), 0o700);
  assertOwnerOnlyTree(join(varRoot, 'restricted', 'runs', 'run_new'), 'new run');
});

test('an interrupted run leaves no world-readable restricted directory, before or after recovery', async () => {
  const varRoot = tempRoot('df-interrupt-');
  const store = createGenerationStore(varRoot, { compress: false });
  const crashed = await store.beginRun('run_c');
  await crashed.write('contacts', { contactObservationId: 'c1' });
  // No commit, no abort: the process died here.
  assertOwnerOnlyTree(join(varRoot, 'restricted'), 'mid-run');
  await store.sweepAbandoned();
  const retry = await store.beginRun('run_c');
  await retry.write('contacts', { contactObservationId: 'c1' });
  await retry.commit();
  assertOwnerOnlyTree(join(varRoot, 'restricted'), 'after recovery');
  const aborted = await store.beginRun('run_d');
  await aborted.write('contacts', { contactObservationId: 'c2' });
  await aborted.abort();
  assertOwnerOnlyTree(join(varRoot, 'restricted'), 'after abort');
});

test('the buffered store writes restricted tables under owner-only directories', async () => {
  const root = tempRoot('df-fabric-');
  mkdirSync(join(root, 'restricted'), { recursive: true });
  chmodSync(join(root, 'restricted'), 0o755); // as older code left it
  const fabric = createNdjsonFabricStore(root);
  await fabric.putContacts('run_b', [{ contactObservationId: 'c1' } as never]);
  assertOwnerOnlyTree(join(root, 'restricted'), 'buffered restricted');
  assert.equal((await fabric.contacts('run_b')).length, 1, 'still readable by its owner');
});

test('retained publisher bytes are owner-read-only under owner-only directories, put or streamed', async () => {
  const root = tempRoot('df-objects-');
  const store = createFilesystemObjectStore(root);
  await store.put('data-fabric/src/p/sha256-a/source-original.zip', Buffer.from('raw bytes with a mailing field'));
  const streaming = createStreamingFilesystemObjectStore(root);
  const staged = await streaming.stage(async (sink) => { await sink.write('streamed raw bytes'); });
  await staged.promote('data-fabric/src/p/sha256-b/source-original.ndjson');
  assertOwnerOnlyTree(root, 'artifact store');
  assert.equal(mode(join(root, 'data-fabric', 'src', 'p', 'sha256-a', 'source-original.zip')), 0o400);
  assert.equal(mode(join(root, 'data-fabric', 'src', 'p', 'sha256-b', 'source-original.ndjson')), 0o400);
});

test('ensurePrivateDir refuses a symbolic link below its root, and never chmods through a linked root', async () => {
  const base = tempRoot('df-privlink-');
  const outside = join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  chmodSync(outside, 0o755);
  const root = join(base, 'restricted');
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, 'runs'));
  await assert.rejects(ensurePrivateDir(join(root, 'runs', 'run_x'), root), /symbolic link inside a private tree/);
  assert.equal(mode(outside), 0o755, 'the link target outside the root is untouched');
  assert.deepEqual(readdirSync(outside), [], 'nothing was created through the link');

  // A linked ROOT (an operator's scratch volume) is allowed, and not chmod-ed through.
  const linkedRoot = join(base, 'scratch');
  symlinkSync(outside, linkedRoot);
  await ensurePrivateDir(join(linkedRoot, 'run-1'), linkedRoot);
  assert.equal(mode(outside), 0o755, 'the operator-chosen target keeps its mode');
  assert.equal(mode(join(outside, 'run-1')), 0o700);
});

test('tightenTree reports a linked root as unaudited and propagates errors other than ENOENT', async () => {
  const base = tempRoot('df-treelink-');
  const target = join(base, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'open.ndjson'), '{}\n', { mode: 0o644 });
  symlinkSync(target, join(base, 'link'));
  const linked = await tightenTree(join(base, 'link'), { fix: true });
  assert.equal(linked.symlinkRoot, true);
  assert.equal(linked.files, 0, 'the target was not walked');
  assert.equal(mode(join(target, 'open.ndjson')), 0o644, 'nothing changed through the link');
  assert.equal((await tightenTree(join(base, 'absent'), { fix: false })).present, false);
  writeFileSync(join(base, 'file'), 'x');
  await assert.rejects(tightenTree(join(base, 'file', 'below'), { fix: false }), /ENOTDIR/);
});

test('an identical re-put or re-promote repairs a retained object left wide by older code', async () => {
  const root = tempRoot('df-objects-legacy-');
  const key = 'data-fabric/src/p/sha256-a/source-original.zip';
  const dir = join(root, 'data-fabric', 'src', 'p', 'sha256-a');
  mkdirSync(dir, { recursive: true });
  for (const d of [join(root, 'data-fabric'), join(root, 'data-fabric', 'src'), join(root, 'data-fabric', 'src', 'p'), dir]) chmodSync(d, 0o755);
  writeFileSync(join(dir, 'source-original.zip'), 'raw bytes', { mode: 0o444 });
  chmodSync(join(dir, 'source-original.zip'), 0o444);
  const put = await createFilesystemObjectStore(root).put(key, Buffer.from('raw bytes'));
  assert.equal(put.created, false);
  assertOwnerOnlyTree(root, 'after identical put');
  assert.equal(mode(join(dir, 'source-original.zip')), 0o400);

  const key2 = 'data-fabric/src/p/sha256-b/source-original.ndjson';
  const dir2 = join(root, 'data-fabric', 'src', 'p', 'sha256-b');
  mkdirSync(dir2, { recursive: true });
  chmodSync(dir2, 0o755);
  chmodSync(join(root, 'data-fabric', 'src', 'p'), 0o755);
  writeFileSync(join(dir2, 'source-original.ndjson'), 'streamed', { mode: 0o444 });
  chmodSync(join(dir2, 'source-original.ndjson'), 0o444);
  const staged = await createStreamingFilesystemObjectStore(root).stage(async (sink) => { await sink.write('streamed'); });
  assert.equal((await staged.promote(key2)).created, false);
  assertOwnerOnlyTree(join(root, 'data-fabric'), 'after identical promote');
  assert.equal(mode(join(dir2, 'source-original.ndjson')), 0o400);
});

test('activating a snapshot index under its root repairs wide index directories from an older estate', async () => {
  const indexRoot = join(tempRoot('df-idx-legacy-'), 'indexes');
  const path = snapshotIndexPath(indexRoot, 'src_x', 'county_1');
  mkdirSync(join(indexRoot, 'src_x'), { recursive: true });
  chmodSync(indexRoot, 0o755);
  chmodSync(join(indexRoot, 'src_x'), 0o755);
  const index = new SnapshotIndex(new BigUint64Array(0), 0);
  await activateSnapshotIndex(path, index, indexRoot);
  assertOwnerOnlyTree(indexRoot, 'index tree');
  assert.ok(lstatSync(path).isFile());
});

test('df auto refuses a --max that is not a positive integer before doing anything', () => {
  const varRoot = tempRoot('df-maxcli-');
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'df.ts');
  for (const bad of ['NaN', '0', '-5', '1.5']) {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--no-warnings', cli, 'auto', 'ny_statewide_parcels__all_ny_counties', '--max', bad],
        { env: { ...process.env, DF_VAR: varRoot, DF_ARCHIVE: join(varRoot, 'archive') }, stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
      stderr = String((e as { stderr: Buffer }).stderr);
    }
    assert.equal(status, 2, `--max ${bad}`);
    assert.match(stderr, /--max must be a positive integer/);
  }
  assert.deepEqual(readdirSync(varRoot), [], 'nothing was written');
});

// ---------------------------------------------------------------------------
// End to end: fresh worker, rehydrated worker, network-off replay
// ---------------------------------------------------------------------------

const rows = () => [
  nyParcel('Albany', '010100', '00100000010010000000'),
  nyParcel('Erie', '140100', '11100000010010000000', { ADD_OWNER: 'TEST CO-OWNER', ADD_MAIL_ADDR: '9 INVENTED WAY' }),
  nyParcel('Kings', '610100', '3012340056'),
];

function nyWorker(publisher: ReturnType<typeof nyFakePublisher>, durable: DurableStore | null) {
  const h = streamHarness();
  const run = (o: Partial<NyPipelineOptions> = {}) => runNyStatewidePipeline({
    registry: defaultRegistry(), artifactStore: h.artifactStore, contactPlane: h.contactPlane, varRoot: h.varRoot,
    clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger,
    http: { fetchImpl: publisher.fetchImpl, sleep: async () => {} }, batch: { sortChunkLines: 4 }, durable, ...o,
  });
  return { h, run };
}

function assertWorkerOwnerOnly(h: ReturnType<typeof streamHarness>, label: string): void {
  for (const sub of ['restricted', 'indexes']) assertOwnerOnlyTree(join(h.varRoot, sub), `${label} ${sub}`);
  assertOwnerOnlyTree(join(h.root, 'archive'), `${label} archive`);
}

test('a fresh cloud worker, a rehydrating worker and a network-off replay all leave restricted data owner-only', async () => {
  const publisher = nyFakePublisher();
  publisher.publish(buildNyRelease({ rollYear: 2025, build: '2605', rows: rows() }));
  publisher.publishPolygons(buildNyPolygonRelease(2025, '2605'));
  const durable: DurableStore = { backend: createLocalBackend(tempRoot('df-perm-durable-'), { durable: true }), prefix: 'p', required: true };

  const first = nyWorker(publisher, durable);
  const a = await first.run();
  assert.equal(a.outcome, 'INGESTED');
  assertWorkerOwnerOnly(first.h, 'fresh worker');

  const second = nyWorker(publisher, durable);
  const b = await second.run();
  assert.equal(b.ledger?.action, 'REHYDRATED_AND_INGESTED');
  assertWorkerOwnerOnly(second.h, 'rehydrated worker');

  const third = streamHarness();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network used during replay'); }) as typeof fetch;
  try {
    const replay = await replayNyFromArchive({
      registry: defaultRegistry(), artifactStore: third.artifactStore, contactPlane: third.contactPlane, varRoot: third.varRoot,
      clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger, durable,
      publisherSha256: a.publisherArtifact!.sha256, referencePeriod: '2025-2605', batch: { sortChunkLines: 4 },
    });
    assert.equal(replay.outcome, 'INGESTED');
  } finally {
    globalThis.fetch = realFetch;
  }
  assertWorkerOwnerOnly(third, 'network-off replay');
  // The derived bundle carries raw mailing fields too: owner-read-only.
  assert.equal(mode(third.artifactStore.localPath(a.bundleArtifact!)), 0o400);
});

test('df permissions finds wide entries, exits non-zero, and --fix makes the trees owner-only', () => {
  const varRoot = tempRoot('df-permcli-');
  const dir = join(varRoot, 'restricted', 'runs', 'run_z', 'gen-1');
  mkdirSync(dir, { recursive: true });
  for (const d of [join(varRoot, 'restricted'), join(varRoot, 'restricted', 'runs'), join(varRoot, 'restricted', 'runs', 'run_z'), dir]) chmodSync(d, 0o755);
  writeFileSync(join(dir, 'contacts.ndjson'), '{}\n', { mode: 0o644 });
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'df.ts');
  const env = { ...process.env, DF_VAR: varRoot };
  let failed = false;
  try { execFileSync(process.execPath, ['--no-warnings', cli, 'permissions'], { env, stdio: 'pipe' }); } catch { failed = true; }
  assert.ok(failed, 'an open tree fails the audit');
  const fixed = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'permissions', '--fix'], { env }).toString()) as { openEntries: number };
  assert.ok(fixed.openEntries > 0);
  const after = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'permissions'], { env }).toString()) as { openEntries: number };
  assert.equal(after.openEntries, 0);
  assertOwnerOnlyTree(join(varRoot, 'restricted'), 'after --fix');
});
