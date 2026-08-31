import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRevisionLedger } from '../src/canonical/revision.ts';
import { contentDigest } from '../src/core/hash.ts';
import { createMemoryFabricStore } from '../src/runtime/fabric-store.ts';
import { fixture, harness } from './helpers.ts';

// --- the ledger in isolation ------------------------------------------------------

test('the ledger classifies first sighting, identical resend and changed content', () => {
  const ledger = createRevisionLedger();
  const base = { sourceId: 's', sourceRecordId: 'r1', artifactId: 'a1', runId: 'run1', observedAt: '2026-01-01T00:00:00Z', parserVersion: 'p1' };

  const first = ledger.classify({ ...base, contentDigest: 'digest-a' });
  assert.equal(first.kind, 'new');
  assert.equal(first.observation.revisionOrdinal, 0);
  assert.equal(first.observation.supersedesObservationId, null);

  const same = ledger.classify({ ...base, artifactId: 'a2', contentDigest: 'digest-a' });
  assert.equal(same.kind, 'unchanged');
  assert.equal(same.observation.observationId, first.observation.observationId);

  const changed = ledger.classify({ ...base, artifactId: 'a2', contentDigest: 'digest-b' });
  assert.equal(changed.kind, 'revised');
  assert.equal(changed.observation.revisionOrdinal, 1);
  assert.equal(changed.observation.supersedesObservationId, first.observation.observationId);
});

test('a revision retains the prior observation rather than overwriting it', () => {
  const ledger = createRevisionLedger();
  const base = { sourceId: 's', sourceRecordId: 'r1', artifactId: 'a1', runId: 'run1', observedAt: '2026-01-01T00:00:00Z', parserVersion: 'p1' };
  ledger.classify({ ...base, contentDigest: 'v1' });
  ledger.classify({ ...base, contentDigest: 'v2' });
  ledger.classify({ ...base, contentDigest: 'v3' });

  const history = ledger.history('s', 'r1');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((o) => o.contentDigest), ['v1', 'v2', 'v3']);
  assert.deepEqual(history.map((o) => o.revisionOrdinal), [0, 1, 2]);
  assert.equal(ledger.current('s', 'r1')?.contentDigest, 'v3');
});

test('a different source record key is independent history', () => {
  const ledger = createRevisionLedger();
  const base = { sourceId: 's', artifactId: 'a1', runId: 'run1', observedAt: '2026-01-01T00:00:00Z', parserVersion: 'p1' };
  assert.equal(ledger.classify({ ...base, sourceRecordId: 'r1', contentDigest: 'x' }).kind, 'new');
  assert.equal(ledger.classify({ ...base, sourceRecordId: 'r2', contentDigest: 'x' }).kind, 'new');
  assert.equal(ledger.history('s', 'r1').length, 1);
});

// --- revision through the runtime ---------------------------------------------------

test('re-ingesting the same extract is idempotent and emits nothing new', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });

  const first = await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  assert.equal(first.run.metrics.rowsNew, 1);
  assert.equal(first.run.metrics.rowsEmitted, 1);

  const second = await harness({ root: h.root, fabricStore }).run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  assert.equal(second.run.metrics.rowsUnchanged, 1);
  assert.equal(second.run.metrics.rowsEmitted, 0);
  assert.equal(second.changeCounts.unchanged, 1);

  // Same evidence and same code means the same run id, so the store replaces
  // the run's partition instead of accumulating a duplicate.
  assert.equal(first.run.runId, second.run.runId);
  assert.equal((await fabricStore.runs()).length, 1);
  assert.equal((await fabricStore.sourceObservations()).length, 1);
});

test('changed content for a known source record is a revision, and history is kept', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });

  await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const revised = await harness({ root: h.root, fabricStore })
    .run([fixture('04-revision-of-1000001-price-changed.xml')], { period: '2026-W32' });

  assert.equal(revised.run.metrics.rowsRevised, 1);
  assert.equal(revised.run.metrics.rowsNew, 0);

  const observations = await fabricStore.sourceObservations();
  assert.equal(observations.length, 2, 'the prior observation must survive the revision');
  const ordered = [...observations].sort((a, b) => a.revisionOrdinal - b.revisionOrdinal);
  assert.equal(ordered[0]?.revisionOrdinal, 0);
  assert.equal(ordered[1]?.revisionOrdinal, 1);
  assert.equal(ordered[1]?.supersedesObservationId, ordered[0]?.observationId);
  assert.notEqual(ordered[0]?.contentDigest, ordered[1]?.contentDigest);
  // The prior evidence still points at the artifact that carried it.
  assert.notEqual(ordered[0]?.artifactId, ordered[1]?.artifactId);
});

test('a revision produces the same canonical transaction id, not a second transaction', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const a = await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const b = await harness({ root: h.root, fabricStore })
    .run([fixture('04-revision-of-1000001-price-changed.xml')], { period: '2026-W32' });

  assert.equal(a.bundles[0]?.transaction.transactionId, b.bundles[0]?.transaction.transactionId);
  // The stated price changed, and both statements are retained.
  assert.equal(a.bundles[0]?.transaction.totalConsideration?.amountMinor, 30_000_000);
  assert.equal(b.bundles[0]?.transaction.totalConsideration?.amountMinor, 31_250_000);
});

test('a new source record in a later extract is new, not a revision', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const next = await harness({ root: h.root, fabricStore })
    .run([fixture('05-same-name-unrelated-party.xml')], { period: '2026-W32' });
  assert.equal(next.run.metrics.rowsNew, 1);
  assert.equal(next.run.metrics.rowsRevised, 0);
});

// --- provenance ---------------------------------------------------------------------

test('every canonical row links to a source observation and an artifact', async () => {
  const h = harness();
  const result = await h.run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const bundle = result.bundles[0];
  assert.ok(bundle);

  const rows = [
    bundle.transaction,
    ...bundle.parties,
    ...bundle.propertyIdentifiers,
    ...bundle.financing,
    ...bundle.events,
  ];
  assert.ok(rows.length > 10);
  for (const row of rows) {
    const e = row.evidence;
    assert.equal(e.sourceId, 'mn_dor_ecrv_weekly_sales_extract');
    assert.equal(e.sourceRecordId, 'MN-27-1000002');
    assert.equal(e.artifactId, result.artifact?.artifactId);
    assert.equal(e.runId, result.run.runId);
    assert.ok(e.rawRecordHash.length === 64);
    assert.ok(e.parserVersion && e.normalizationVersion);
    assert.ok(e.observedAt);
  }
});

test('the artifact a canonical row names reproduces its own bytes and manifest', async () => {
  const h = harness();
  const result = await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const artifact = result.artifact;
  assert.ok(artifact);

  // read() re-hashes; a mismatch throws rather than returning the bytes.
  const bytes = await h.artifactStore.read(artifact);
  assert.equal(bytes.byteLength, artifact.byteLength);

  const manifest = await h.artifactStore.readManifest(artifact);
  assert.deepEqual(manifest, artifact.manifest);
  assert.equal(manifest.sha256, result.run.artifactSha256);
  assert.equal(manifest.sourceAuthority, 'Minnesota Department of Revenue');
  assert.equal(manifest.jurisdictionIds.length, 87);
});

// --- replay ---------------------------------------------------------------------------

test('replaying retained evidence reproduces the run byte for byte', async () => {
  const h = harness();
  const original = await h.run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  assert.ok(original.artifact);

  // Rebuild the derived estate from nothing, keeping only the archive. This is
  // the gate: the canonical output must be a pure function of the evidence.
  const replayed = await harness({ root: h.root }).run([], { replayArtifact: original.artifact });

  assert.equal(replayed.run.status, 'completed');
  assert.equal(replayed.run.runId, original.run.runId);
  assert.equal(replayed.run.normalizedDigest, original.run.normalizedDigest);
  assert.equal(replayed.run.artifactSha256, original.run.artifactSha256);
  assert.equal(replayed.run.metrics.rowsEmitted, original.run.metrics.rowsEmitted);
  assert.equal(replayed.run.metrics.rowsParsed, original.run.metrics.rowsParsed);
  assert.deepEqual(
    replayed.bundles.map((b) => contentDigest(b)).sort(),
    original.bundles.map((b) => contentDigest(b)).sort(),
  );
  assert.deepEqual(
    replayed.events.map((e) => e.eventId).sort(),
    original.events.map((e) => e.eventId).sort(),
  );
  assert.equal(replayed.run.replayOf, original.artifact.artifactId);
});

test('replay of the multi-document extract is deterministic across the whole batch', async () => {
  const h = harness();
  const original = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.equal(original.run.metrics.rowsEmitted, 3);
  assert.ok(original.artifact);

  const replayed = await harness({ root: h.root }).run([], { replayArtifact: original.artifact });
  assert.equal(replayed.run.normalizedDigest, original.run.normalizedDigest);
  assert.equal(replayed.contacts.length, original.contacts.length);
  assert.deepEqual(
    replayed.contacts.map((c) => c.contactObservationId).sort(),
    original.contacts.map((c) => c.contactObservationId).sort(),
  );
});

test('replay records a second interpretation only if the parser disagrees with itself', async () => {
  const h = harness();
  const original = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.ok(original.artifact);
  await harness({ root: h.root }).run([], { replayArtifact: original.artifact });

  const view = await h.artifactStore.view(original.artifact);
  // Same parser, same schema, same answer: one interpretation, written once.
  assert.equal(view.interpretations.length, 1);
  assert.equal(view.interpretations[0]?.recordCount, 3);
  assert.equal(view.interpretations[0]?.contentDigest, original.run.normalizedDigest);
});

test('a dry run reports everything and persists nothing', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const result = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip'], { dryRun: true });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.metrics.rowsEmitted, 3);
  assert.ok(result.run.normalizedDigest);
  assert.equal((await fabricStore.runs()).length, 0);
  assert.equal((await fabricStore.bundles()).length, 0);
  assert.equal((await fabricStore.sourceObservations()).length, 0);
  assert.equal(h.contactPlane.size(), 0);
});
