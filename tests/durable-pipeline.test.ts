/**
 * The execution machine is disposable: the Wisconsin pipeline with a durable
 * artifact store.
 *
 * "Worker" here means a completely separate workspace — its own var root, its
 * own local artifact store, an empty ledger — sharing nothing with another
 * worker except the durable store and the (fake) publisher. That is exactly
 * what a new cloud container has.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { createLocalBackend, artifactKey, manifestKey } from '../src/archive/artifact-backend.ts';
import { createS3Backend } from '../src/archive/s3-backend.ts';
import { findRelease, type DurableStore } from '../src/archive/durable-artifacts.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import {
  replayWiFromArchive,
  runWiStatewidePipeline,
  type WiPipelineOptions,
} from '../src/connectors/wi-statewide-parcels/pipeline.ts';
import { RUN_INSTANT, streamHarness, tempRoot } from './helpers.ts';
import { buildRelease, fakePublisher, parcel, type FakePublisher } from './support/wi-fixture.ts';
import { startTestS3, type TestS3 } from './support/s3-server.ts';

let s3: TestS3 | null = null;
before(async () => { s3 = await startTestS3('fabric-pipeline'); });
after(async () => { await s3?.stop(); });

const V12 = { major: 12, minor: 0, patch: 0, year: 2026 };
const rows = () => [
  parcel('ADAMS', '008002310010'), parcel('BROWN', '1-1109'), parcel('BROWN', '11-109'),
  parcel('BROWN', 'ROW'), parcel('DANE', '0608-123-4567-0'), parcel('MILWAUKEE', '008002310010'),
];

function durableStore(prefix: string): DurableStore {
  if (s3) {
    return {
      backend: createS3Backend({
        endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket,
        accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, sleep: async () => {},
      }),
      prefix, required: true,
    };
  }
  // Without moto the same assertions run against an explicitly durable directory.
  return { backend: createLocalBackend(tempRoot('df-durable-'), { durable: true }), prefix, required: true };
}

/** A worker: nothing shared with any other worker except `durable` and `publisher`. */
function worker(durable: DurableStore | null, publisher: FakePublisher) {
  const h = streamHarness();
  const run = (overrides: Partial<WiPipelineOptions> = {}) => runWiStatewidePipeline({
    registry: defaultRegistry(), artifactStore: h.artifactStore, contactPlane: h.contactPlane, varRoot: h.varRoot,
    clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger,
    http: { fetchImpl: publisher.fetchImpl, sleep: async () => {} }, batch: { sortChunkLines: 4 },
    durable, ...overrides,
  });
  return { h, run };
}

const prefixOf = () => `p${Date.now()}${Math.random().toString(36).slice(2)}`;

test('raw publisher bytes are durable and registered before anything is activated', async () => {
  const publisher = fakePublisher();
  const built = buildRelease({ version: V12, rows: rows() });
  publisher.publish(built);
  const durable = durableStore(prefixOf());
  const w = worker(durable, publisher);
  const result = await w.run();
  assert.equal(result.outcome, 'INGESTED');
  assert.deepEqual(result.durability?.commit?.phases.map((p) => p.phase), ['STAGING', 'HASH_VERIFIED', 'DURABLE', 'REGISTERED']);
  assert.equal(result.durability?.commit?.verifiedByReread, true);
  assert.equal(result.durability?.releaseRegistered, true);
  assert.ok(result.durability?.receiptKey, 'a durable run receipt exists');
  assert.equal((await durable.backend.head(artifactKey(durable.prefix, built.sha256)))?.bytes, built.archive.length);
  const release = await findRelease(durable, 'wi_statewide_parcels', 'V12.0.0-2026', result.discovered!.releaseFingerprint);
  assert.equal(release?.publisherSha256, built.sha256);
  assert.equal(release?.publisherFilename, built.filename);
  assert.equal(release?.acquisitionClass, 'AUTOMATED_BULK_DOWNLOAD');
  assert.ok(release?.schemaDigest);
  // The derived bundle is regenerable and deliberately NOT uploaded.
  assert.equal(await durable.backend.head(artifactKey(durable.prefix, result.bundleArtifact!.sha256)), null);
});

test('a fresh worker finds the durable release and never asks the publisher for the archive', async () => {
  const publisher = fakePublisher();
  publisher.publish(buildRelease({ version: V12, rows: rows() }));
  const durable = durableStore(prefixOf());
  const first = await worker(durable, publisher).run();
  assert.equal(publisher.archiveGets(), 1);

  const fresh = worker(durable, publisher);
  const second = await fresh.run();
  assert.equal(publisher.archiveGets(), 1, 'the second worker rehydrated from the durable store');
  assert.equal(second.durability?.source, 'durable_store');
  assert.equal(second.ledger?.action, 'REHYDRATED_AND_INGESTED');
  assert.equal(second.publisherArtifact?.sha256, first.publisherArtifact?.sha256);
  assert.equal(second.bundleArtifact?.sha256, first.bundleArtifact?.sha256);
  assert.equal(second.run?.run.runId, first.run?.run.runId);
  assert.equal(second.run?.run.normalizedDigest, first.run?.run.normalizedDigest);
  assert.equal(second.run?.globalDigest, first.run?.globalDigest);
  // And its own next scheduled tick is a NOOP.
  assert.equal((await fresh.run()).outcome, 'NOOP');
});

test('publisher-off replay on a fresh worker, from the durable store alone', async () => {
  const publisher = fakePublisher();
  publisher.publish(buildRelease({ version: V12, rows: rows() }));
  const durable = durableStore(prefixOf());
  const firstWorker = worker(durable, publisher);
  const first = await firstWorker.run();

  const fresh = worker(durable, publisher);
  const realFetch = globalThis.fetch;
  // Every host but the durable store is unreachable: a publisher request fails.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (s3 && url.startsWith(s3.endpoint)) return realFetch(input, init);
    throw new Error(`publisher network used during replay: ${url}`);
  }) as typeof fetch;
  try {
    const replay = await replayWiFromArchive({
      registry: defaultRegistry(), artifactStore: fresh.h.artifactStore, contactPlane: fresh.h.contactPlane,
      varRoot: fresh.h.varRoot, clock: fixedClock('2031-01-01T00:00:00.000Z'), logger: captureLogger().logger,
      publisherSha256: first.publisherArtifact!.sha256, referencePeriod: 'V12.0.0-2026',
      batch: { sortChunkLines: 4 }, durable,
    });
    assert.equal(replay.durability?.source, 'durable_store');
    assert.equal(replay.bundleArtifact?.sha256, first.bundleArtifact?.sha256);
    assert.equal(replay.run?.run.normalizedDigest, first.run?.run.normalizedDigest);
    assert.equal(replay.run?.globalDigest, first.run?.globalDigest);
    const digests = async (varRoot: string) => (await createPartitionStore(varRoot).manifests())
      .map((m) => [m.partitionId, m.inputDigest, m.outputDigest]);
    assert.deepEqual(await digests(fresh.h.varRoot), await digests(firstWorker.h.varRoot));
    assert.equal(publisher.archiveGets(), 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a worker lost after acquisition but before projection: the next worker resumes from durable bytes', async () => {
  const publisher = fakePublisher();
  publisher.publish(buildRelease({ version: V12, rows: rows() }));
  const durable = durableStore(prefixOf());
  // The first worker acquires, commits and registers — then its projection
  // dies (an impossible sort chunk makes the runtime fail mid-projection).
  const doomed = await worker(durable, publisher).run({ batch: { sortChunkLines: 0 } });
  assert.equal(doomed.outcome, 'FAILED');
  assert.equal(doomed.durability?.releaseRegistered, true, 'the raw evidence survived the failure');

  // Its container is gone. A new one starts from nothing but the durable store.
  const recovered = await worker(durable, publisher).run();
  assert.equal(recovered.outcome, 'INGESTED');
  assert.equal(recovered.durability?.source, 'durable_store');
  assert.equal(publisher.archiveGets(), 1, 'no second publisher download');
});

test('a replay with the bytes on local disk touches neither the publisher nor the durable store', async () => {
  const publisher = fakePublisher();
  publisher.publish(buildRelease({ version: V12, rows: rows() }));
  const w = worker(durableStore(prefixOf()), publisher);
  const first = await w.run();
  // The store is now unreachable (a network namespace with no interfaces).
  const unreachable = async () => { throw new Error('fetch failed'); };
  const offline: DurableStore = {
    prefix: 'p', required: true,
    backend: {
      ...createLocalBackend(tempRoot('df-offline-'), { durable: true }),
      head: unreachable, putFile: unreachable, putJson: unreachable, getJson: unreachable, stream: unreachable, list: unreachable,
    },
  };
  const replay = await replayWiFromArchive({
    registry: defaultRegistry(), artifactStore: w.h.artifactStore, contactPlane: w.h.contactPlane,
    varRoot: w.h.varRoot, clock: fixedClock('2031-01-01T00:00:00.000Z'), logger: captureLogger().logger,
    publisherSha256: first.publisherArtifact!.sha256, referencePeriod: 'V12.0.0-2026',
    batch: { sortChunkLines: 4 }, durable: offline,
  });
  assert.equal(replay.outcome, 'INGESTED');
  assert.equal(replay.durability?.source, 'workspace');
  assert.equal(replay.durability?.commit, null);
  assert.equal(replay.durability?.receiptKey, null);
  assert.equal(replay.run?.globalDigest, first.run?.globalDigest);
  assert.equal(publisher.archiveGets(), 1);
});

test('when durability is required and the store refuses the bytes, nothing is activated', async () => {
  const publisher = fakePublisher();
  publisher.publish(buildRelease({ version: V12, rows: rows() }));
  const refusing: DurableStore = {
    prefix: 'p', required: true,
    backend: {
      ...createLocalBackend(tempRoot('df-refuse-'), { durable: true }),
      putFile: async () => { throw Object.assign(new Error('403 AccessDenied'), { kind: 'ACCESS_BLOCKED' }); },
    },
  };
  const w = worker(refusing, publisher);
  await assert.rejects(w.run(), /AccessDenied/);
  assert.deepEqual(await createPartitionStore(w.h.varRoot).listPartitions(), [], 'no partition was activated');
});

test('the durable manifest says which bytes the digest is of', async () => {
  const publisher = fakePublisher();
  const built = buildRelease({ version: V12, rows: rows() });
  publisher.publish(built);
  const durable = durableStore(prefixOf());
  await worker(durable, publisher).run();
  const manifest = await durable.backend.getJson<{ role: string; contentEncoding: string; retrieval: { originalUrl: string } }>(
    manifestKey(durable.prefix, built.sha256),
  );
  assert.equal(manifest?.role, 'publisher_raw');
  assert.equal(manifest?.contentEncoding, 'identity');
  assert.equal(manifest?.retrieval.originalUrl, built.url);
});
