import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createArtifactStore } from '../src/archive/artifact-store.ts';
import { createFilesystemObjectStore } from '../src/archive/object-store.ts';
import { createContactPlane } from '../src/contact/contact-plane.ts';
import { fixedClock } from '../src/core/clock.ts';
import { isFabricError } from '../src/core/errors.ts';
import { captureLogger } from '../src/core/logging.ts';
import { createMnEcrvConnector } from '../src/connectors/mn-ecrv/index.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { createMemoryFabricStore } from '../src/runtime/fabric-store.ts';
import { DEFAULT_RETRY, backoffDelay, createRateLimiter, withRetry } from '../src/runtime/retry.ts';
import { runConnector, runReport } from '../src/runtime/run.ts';
import { assertAutomationPermitted, createHttpTransport, createLocalFileTransport } from '../src/runtime/transport.ts';
import { MAPPING_ID, RUN_INSTANT, fixture, harness, tempRoot } from './helpers.ts';

// --- lifecycle ---------------------------------------------------------------

test('a successful run reports the full lifecycle and a complete metric set', async () => {
  const h = harness();
  const result = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const report = runReport(result.run);

  assert.equal(report.status, 'completed');
  assert.equal(result.run.stage, 'emit');
  assert.ok(report.startedAt && report.completedAt);
  assert.deepEqual(report.metrics, {
    rowsDiscovered: 1,
    rowsParsed: 3,
    rowsValid: 3,
    rowsQuarantined: 0,
    rowsEmitted: 3,
    rowsUnchanged: 0,
    rowsRevised: 0,
    rowsNew: 3,
    // 2 phones, 2 emails and 1 submitter comment across the three filings.
    contactObservations: 5,
    canonicalEvents: 9,
    // eCRV is a feed, not a snapshot, so absence detection does not apply.
    rowsMissingFromSnapshot: 0,
  });
  // Everything an operator needs to judge the run, with no UI.
  for (const field of ['runId', 'artifactSha256', 'schemaVersion', 'schemaDigest', 'normalizedDigest'] as const) {
    assert.ok(report[field], `run report is missing ${field}`);
  }
});

test('the run log carries the run id, artifact digest and metrics', async () => {
  const { logger, records } = captureLogger();
  const h = harness();
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip'], { logger });

  const finished = records.find((r) => r.event === 'run.finished');
  assert.ok(finished);
  assert.equal(finished['status'], 'completed');
  assert.ok(finished['artifactSha256']);
  assert.ok(records.some((r) => r.event === 'run.archived'));
  assert.ok(records.some((r) => r.event === 'run.parsed'));
  // Structured throughout: every record is JSON-serialisable with a level and event.
  assert.ok(records.every((r) => typeof r.event === 'string' && typeof r.level === 'string'));
});

test('a failure records the stage it failed at and the classified kind', async () => {
  const result = await harness().run([fixture('94-malformed.xml')]);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.stage, 'parse');
  assert.equal(result.run.failureKind, 'PARSE');
  assert.ok(result.run.failureMessage);
  // The artifact was still retained before the parse was attempted.
  assert.ok(result.run.artifactSha256);
});

// --- idempotency and immutability at run level --------------------------------

test('the run id is a function of the evidence and the code that read it', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const a = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const b = await harness({ root: h.root, fabricStore }).run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.equal(a.run.runId, b.run.runId);
  assert.equal((await fabricStore.runs()).length, 1);
});

test('a different reference period for the same bytes is a different run', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const a = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip'], { period: '2026-W31' });
  const b = await harness({ root: h.root, fabricStore }).run(['fixtures/mn-ecrv/weekly-extract-sample.zip'], { period: '2026-W32' });
  assert.notEqual(a.run.runId, b.run.runId);
  assert.equal(a.run.artifactSha256, b.run.artifactSha256);
  assert.equal((await fabricStore.runs()).length, 2);
});

test('re-downloading identical bytes dedupes the artifact at run level', async () => {
  const h = harness();
  const a = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const b = await harness({ root: h.root }).run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.equal(a.artifact?.created, true);
  assert.equal(b.artifact?.created, false);
  assert.equal(a.artifact?.storagePath, b.artifact?.storagePath);
});

test('a changed file with the same name produces a second artifact, keeping the first', async () => {
  const staging = tempRoot('df-same-name-');
  const path = join(staging, 'weekly-extract.xml');
  const h = harness();

  copyFileSync(fixture('01-single-buyer-single-seller-mortgage.xml'), path);
  const first = await h.run([path]);

  copyFileSync(fixture('04-revision-of-1000001-price-changed.xml'), path);
  const second = await harness({ root: h.root }).run([path]);

  assert.notEqual(first.artifact?.sha256, second.artifact?.sha256);
  assert.equal(first.artifact?.manifest.originalFilename, 'weekly-extract.xml');
  assert.equal(second.artifact?.manifest.originalFilename, 'weekly-extract.xml');
  // Both are still readable and still verify.
  assert.ok(await h.artifactStore.read(first.artifact!));
  assert.ok(await h.artifactStore.read(second.artifact!));
});

// --- configuration and activation gates ----------------------------------------

test('a mapping that is only planned refuses to run', async () => {
  const result = await runConnector({
    registry: defaultRegistry(),
    connector: { ...createMnEcrvConnector(), adapterKey: 'hennepin_recorder' },
    mappingId: 'hennepin_recorder__hennepin',
    artifactStore: createArtifactStore(createFilesystemObjectStore(tempRoot())),
    fabricStore: createMemoryFabricStore(),
    contactPlane: createContactPlane(),
    clock: fixedClock(RUN_INSTANT),
    logger: captureLogger().logger,
  });
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failureKind, 'CONFIG');
  assert.match(result.run.failureMessage ?? '', /planned/);
});

test('a connector whose adapter key does not match the mapping refuses to run', async () => {
  const result = await runConnector({
    registry: defaultRegistry(),
    connector: { ...createMnEcrvConnector(), adapterKey: 'something_else' },
    mappingId: MAPPING_ID,
    artifactStore: createArtifactStore(createFilesystemObjectStore(tempRoot())),
    fabricStore: createMemoryFabricStore(),
    contactPlane: createContactPlane(),
    clock: fixedClock(RUN_INSTANT),
    logger: captureLogger().logger,
  });
  assert.equal(result.run.failureKind, 'CONFIG');
  assert.match(result.run.failureMessage ?? '', /expects adapter/);
});

test('with no extract available the run is blocked on access, not failed', async () => {
  const result = await harness().run([]);
  // A credential gap is an operational state with a remedy, not a defect.
  assert.equal(result.run.status, 'blocked_on_access');
  assert.equal(result.run.failureKind, 'ACCESS_BLOCKED');
  assert.match(result.run.failureMessage ?? '', /no eCRV Weekly Sales Extract/);
});

test('a transport that reaches the publisher is refused unless automation is sanctioned', () => {
  const http = createHttpTransport();
  for (const status of ['manual_only', 'prohibited', 'unknown'] as const) {
    assert.throws(
      () => assertAutomationPermitted(http, status, 'some_source'),
      (e: unknown) => isFabricError(e, 'ACCESS_BLOCKED'),
      status,
    );
  }
  assert.doesNotThrow(() => assertAutomationPermitted(http, 'sanctioned', 'some_source'));
  // A local file never touches the publisher, so the gate does not apply.
  assert.doesNotThrow(() => assertAutomationPermitted(createLocalFileTransport(), 'prohibited', 'some_source'));
});

test('the eCRV connector never reaches the publisher with the default transport', async () => {
  const h = harness();
  const result = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.artifact?.manifest.originalUrl, null);
  assert.equal(createMnEcrvConnector().transport.reachesPublisher, false);
});

test('an unreadable local file is a transport failure with the path named', async () => {
  const result = await harness().run(['/nonexistent/weekly.zip']);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failureKind, 'TRANSPORT');
  assert.equal(result.run.stage, 'fetch');
});

// --- retry and rate limiting ------------------------------------------------------

test('retry backs off and only retries transport faults', async () => {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => { delays.push(ms); };

  let attempts = 0;
  const value = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('flaky'), { kind: 'TRANSPORT' });
    return 'ok';
  }, { sleep });
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);

  // A schema-drift failure is deterministic: retrying repeats the same answer.
  let driftAttempts = 0;
  await assert.rejects(() => withRetry(async () => {
    driftAttempts += 1;
    throw Object.assign(new Error('drift'), { kind: 'SCHEMA_DRIFT' });
  }, { sleep }));
  assert.equal(driftAttempts, 1);
});

test('retry gives up after the configured attempts and rethrows the last error', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error('down'), { kind: 'TRANSPORT' });
    }, { sleep: async () => {} }),
    /down/,
  );
  assert.equal(attempts, DEFAULT_RETRY.maxAttempts);
});

test('backoff is capped', () => {
  assert.equal(backoffDelay(DEFAULT_RETRY, 1), 500);
  assert.equal(backoffDelay(DEFAULT_RETRY, 10), DEFAULT_RETRY.maxDelayMs);
});

test('the rate limiter enforces a minimum interval between acquisitions', async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = createRateLimiter(1000, {
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(waits, [1000, 1000]);
});

// --- store semantics ---------------------------------------------------------------

test('the NDJSON store replaces a run partition rather than appending duplicates', async () => {
  const root = tempRoot('df-ndjson-');
  const { createNdjsonFabricStore } = await import('../src/runtime/fabric-store.ts');
  const store = createNdjsonFabricStore(root);
  const h = harness({ fabricStore: store });

  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const first = await store.bundles();
  await harness({ root: h.root, fabricStore: store }).run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const second = await store.bundles();

  // A run's partition holds the complete canonical reading of its artifact, so
  // re-ingesting identical bytes rewrites an identical partition: nothing
  // accumulates, and — importantly — nothing is deleted either. Persisting only
  // the delta would have emptied this partition, because the second run found
  // every record unchanged.
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.deepEqual(
    second.map((b) => b.transaction.transactionId).sort(),
    first.map((b) => b.transaction.transactionId).sort(),
  );
  assert.equal((await store.runs()).length, 1);
});

test('source observations are append-only across runs', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  await harness({ root: h.root, fabricStore }).run([fixture('04-revision-of-1000001-price-changed.xml')], { period: '2026-W32' });
  await harness({ root: h.root, fabricStore }).run([fixture('01-single-buyer-single-seller-mortgage.xml')]);

  // Three runs, two distinct contents, and no observation was ever removed.
  const observations = await fabricStore.sourceObservations();
  assert.equal(observations.length, 2);
});

test('an invalid object key is refused rather than escaping the store root', async () => {
  const objects = createFilesystemObjectStore(tempRoot());
  for (const key of ['../escape', '/absolute', 'trailing/', 'double//slash', '']) {
    await assert.rejects(() => objects.put(key, new Uint8Array([1])), (e: unknown) => isFabricError(e, 'CONFIG'), key);
  }
});

test('a truncated write cannot be observed under a trusted key', async () => {
  const root = tempRoot('df-atomic-');
  const objects = createFilesystemObjectStore(root);
  await objects.put('data-fabric/a/b/c.bin', new TextEncoder().encode('complete'));
  // A stray temp file left by a crashed writer is never listed as an object.
  writeFileSync(join(root, 'data-fabric', 'a', 'b', 'c.bin.999.tmp'), 'partial');
  assert.deepEqual(await objects.list('data-fabric/a'), ['data-fabric/a/b/c.bin']);
});
