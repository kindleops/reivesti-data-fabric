import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import { createContactPlane } from '../src/contact/contact-plane.ts';
import { createStreamingHennepinConnector } from '../src/connectors/mn-hennepin-assessor/index.ts';
import type { CanonicalBundle } from '../src/canonical/models.ts';
import { hennepinFixture, streamHarness } from './helpers.ts';

const AUG = hennepinFixture('v2-2026-08.ndjson');
const SEP = hennepinFixture('v2-2026-09.ndjson');
const OCT = hennepinFixture('v2-2026-10.ndjson');

// --- the streaming path produces the same answers -------------------------------

test('a streamed run ingests, resolves and reconciles', async () => {
  const h = streamHarness();
  const result = await h.run(AUG);

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.streamed, true);
  assert.equal(result.run.metrics.rowsParsed, 3);
  assert.equal(result.run.metrics.rowsEmitted, 3);
  assert.equal(result.run.metrics.rowsResolved, 3);
  assert.equal(result.run.snapshotCompleteness, 'complete');
  assert.ok(result.run.normalizedDigest && result.run.canonicalDigest);
  assert.equal((await h.bundles()).length, 3);
});

test('the run manifest records everything an operator needs to audit the crawl', async () => {
  const result = await streamHarness().run(AUG);
  for (const field of [
    'runId', 'sourceId', 'releaseId', 'artifactId', 'artifactSha256', 'artifactByteLength',
    'schemaVersion', 'sourceSchemaDigest', 'sourceReportedCount', 'downloadedCount',
    'normalizedDigest', 'canonicalDigest', 'startedAt', 'completedAt',
    'connectorVersion', 'parserVersion', 'batchConfiguration',
  ] as const) {
    assert.notEqual(result.run[field], undefined, `run manifest is missing ${field}`);
  }
  assert.equal(result.run.duplicateCount, 0);
  assert.equal(result.run.sourceChangedDuringRead, false);
});

// --- batch invariance ---------------------------------------------------------------

test('batch size changes nothing: identical digests at 1, 50, 500 and 5000', async () => {
  const digests: { normalized: string; canonical: string; artifact: string }[] = [];

  for (const size of [1, 50, 500, 5000]) {
    const h = streamHarness();
    const result = await h.run(AUG, {
      batch: { sortChunkLines: size, checkpointEveryRows: size, fetchBatchSize: size },
    });
    assert.equal(result.run.status, 'completed', `batch ${size}`);
    digests.push({
      normalized: result.run.normalizedDigest as string,
      canonical: result.run.canonicalDigest as string,
      artifact: result.run.artifactSha256 as string,
    });
  }

  const first = digests[0];
  assert.ok(first);
  for (const [i, d] of digests.entries()) {
    assert.equal(d.normalized, first.normalized, `normalizedDigest differs at index ${i}`);
    assert.equal(d.canonical, first.canonical, `canonicalDigest differs at index ${i}`);
    assert.equal(d.artifact, first.artifact, `artifact digest differs at index ${i}`);
  }
});

test('canonical ids are identical regardless of batch size', async () => {
  const idsAt = async (size: number): Promise<string[]> => {
    const h = streamHarness();
    await h.run(AUG, { batch: { sortChunkLines: size, checkpointEveryRows: size } });
    return (await h.bundles() as CanonicalBundle[])
      .flatMap((b) => b.properties.map((p) => p.propertyId))
      .sort();
  };
  assert.deepEqual(await idsAt(1), await idsAt(5000));
});

// --- snapshot diff -----------------------------------------------------------------

test('a second snapshot classifies new, unchanged, changed and missing', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08' });
  const sept = await h.run(SEP, { period: '2026-09' });

  assert.equal(sept.run.metrics.rowsNew, 1, 'one parcel appears for the first time');
  assert.equal(sept.run.metrics.rowsRevised, 2, 'one reassessed, one owner change');
  assert.equal(sept.run.metrics.rowsUnchanged, 0);
  assert.equal(sept.run.metrics.rowsMissingFromSnapshot, 1, 'one parcel is absent');

  const absences = await h.rows('absences') as { changeKind: string }[];
  assert.equal(absences.length, 1);
  assert.equal(absences[0]?.changeKind, 'parcel_missing_from_latest_source');
});

test('a parcel absent from the latest snapshot is not deleted', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08' });
  await h.run(SEP, { period: '2026-09' });

  // Its canonical rows and its resolution both survive: absence from one file is
  // a fact about the file, never a statement that the parcel ceased to exist.
  const resolutions = await h.resolutions() as { normalizedParcel: string; state: string }[];
  const vanished = resolutions.find((r) => r.normalizedParcel === '3011821140004');
  assert.ok(vanished, 'the absent parcel must still have a resolution');
  assert.equal(vanished.state, 'resolved');
});

test('a parcel that returns is seen again without a new absence', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08' });
  await h.run(SEP, { period: '2026-09' });
  const oct = await h.run(OCT, { period: '2026-10' });

  assert.equal(oct.run.metrics.rowsMissingFromSnapshot, 0);
  // The September absence still stands as the record of what September lacked.
  const absences = await h.rows('absences');
  assert.equal(absences.length, 1);
});

test('an unchanged parcel is reported as unchanged, not as a change', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08' });
  const again = await h.run(AUG, { period: '2026-09' });
  assert.equal(again.run.metrics.rowsUnchanged, 3);
  assert.equal(again.run.metrics.rowsRevised, 0);
  assert.equal(again.run.metrics.rowsNew, 0);
});

// --- drift and reconciliation ---------------------------------------------------------

test('a source that changed under a long crawl is not reported as complete', async () => {
  const result = await streamHarness().run(hennepinFixture('v2-source-drifted.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.sourceChangedDuringRead, true);
  assert.match(result.run.failureMessage ?? '', /source_changed_during_read/);
});

test('an incomplete crawl quarantines rather than reporting a short county', async () => {
  const result = await streamHarness().run(hennepinFixture('v2-incomplete-crawl.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.match(result.run.failureMessage ?? '', /incomplete_crawl/);
});

test('a field-set change aborts before any record is normalised', async () => {
  const h = streamHarness();
  const result = await h.run(hennepinFixture('fault-schema-drift.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  // Nothing was written, because drift is detected from the header.
  assert.equal(result.run.metrics.rowsParsed, 0);
  assert.deepEqual(await h.bundles(), []);
});

test('the v1 bundles DF-0C wrote are still readable', async () => {
  const result = await streamHarness().run(hennepinFixture('snapshot-2026-08.ndjson'));
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.metrics.rowsParsed, 3);
});

// --- replay ----------------------------------------------------------------------------

test('replay reproduces every digest with the network hard-disabled', async () => {
  const h = streamHarness();
  const original = await h.run(AUG);
  assert.ok(original.artifact);

  // Any network call at all fails the test rather than merely being unused.
  const forbidden = (): never => {
    throw new Error('replay attempted a network request');
  };
  const replayed = await h.run(AUG, {
    replayArtifact: original.artifact,
    connector: createStreamingHennepinConnector({
      live: { referencePeriod: 'x', fetchImpl: forbidden as unknown as typeof fetch },
    }),
  });

  assert.equal(replayed.run.status, 'completed');
  assert.equal(replayed.run.artifactSha256, original.run.artifactSha256);
  assert.equal(replayed.run.normalizedDigest, original.run.normalizedDigest);
  assert.equal(replayed.run.canonicalDigest, original.run.canonicalDigest);
  assert.equal(replayed.run.runId, original.run.runId);
  assert.equal(replayed.run.metrics.rowsParsed, original.run.metrics.rowsParsed);
});

test('replay after wiping the derived estate rebuilds it identically', async () => {
  const h = streamHarness();
  const original = await h.run(AUG);
  const before = await h.resolutions();
  assert.ok(original.artifact);

  const { rm } = await import('node:fs/promises');
  await rm(join(h.varRoot, 'derived'), { recursive: true, force: true });
  await rm(join(h.varRoot, 'indexes'), { recursive: true, force: true });
  assert.deepEqual(await h.bundles(), [], 'the derived estate is gone');

  const replayed = await h.run(AUG, { replayArtifact: original.artifact });
  assert.equal(replayed.run.normalizedDigest, original.run.normalizedDigest);
  assert.equal(replayed.run.canonicalDigest, original.run.canonicalDigest);
  assert.deepEqual(await h.resolutions(), before);
});

// --- idempotency ------------------------------------------------------------------------

test('an identical second run preserves the estate exactly', async () => {
  const h = streamHarness();
  const first = await h.run(AUG);
  const bundlesBefore = await h.bundles();
  const resolutionsBefore = await h.resolutions();

  const second = await h.run(AUG);

  assert.equal(second.run.runId, first.run.runId, 'same evidence and code means the same run');
  assert.equal(second.run.normalizedDigest, first.run.normalizedDigest, 'the digest must not depend on history');
  assert.equal(second.run.canonicalDigest, first.run.canonicalDigest);

  // No duplication, and — the DF-0C regression this specifically guards — no loss.
  const bundlesAfter = await h.bundles() as CanonicalBundle[];
  assert.equal(bundlesAfter.length, bundlesBefore.length);
  assert.deepEqual(await h.resolutions(), resolutionsBefore);

  // The persisted rows are identical apart from one field that is *supposed* to
  // differ: `changeKind` records how this reading compared with what we already
  // knew, so the first run says `new_parcel_observed` and the second says
  // `unchanged_parcel`. That is the diff, not the evidence, which is exactly why
  // it is excluded from the digest asserted above.
  const withoutDiff = (rows: CanonicalBundle[]): unknown[] =>
    rows.map(({ parcelObservations: _diff, ...rest }) => rest);
  assert.deepEqual(withoutDiff(bundlesAfter), withoutDiff(bundlesBefore as CanonicalBundle[]));
  assert.deepEqual(
    bundlesAfter.flatMap((b) => (b.parcelObservations ?? []).map((o) => o.changeKind)),
    ['unchanged_parcel', 'unchanged_parcel', 'unchanged_parcel'],
  );

  // Every row was recognised as unchanged, so no false change events.
  assert.equal(second.run.metrics.rowsUnchanged, 3);
  assert.equal(second.run.metrics.rowsRevised, 0);
  assert.equal(second.run.metrics.rowsNew, 0);
});

test('three identical runs leave exactly one generation active', async () => {
  const h = streamHarness();
  await h.run(AUG);
  await h.run(AUG);
  await h.run(AUG);
  assert.equal((await h.bundles()).length, 3, 'three parcels, not nine');
  assert.equal((await h.store.listRuns()).length, 1);
});

// --- partition safety ---------------------------------------------------------------------

test('a failure during canonicalization leaves the previous estate intact', async () => {
  const h = streamHarness();
  await h.run(AUG);
  const before = await h.bundles();
  assert.equal(before.length, 3);

  // A connector that throws part-way through normalisation.
  const exploding = createStreamingHennepinConnector();
  let seen = 0;
  const sabotaged = {
    ...exploding,
    normalize(...args: Parameters<typeof exploding.normalize>) {
      seen += 1;
      if (seen === 2) throw new Error('disk full halfway through the county');
      return exploding.normalize(...args);
    },
  };

  const failed = await h.run(AUG, { connector: sabotaged as typeof exploding });
  assert.equal(failed.run.status, 'failed');
  assert.match(failed.run.failureMessage ?? '', /disk full/);

  // The activated estate is byte-identical to before the failed attempt.
  assert.deepEqual(await h.bundles(), before);
  // The failed run cleaned up after itself, so there is nothing left to sweep.
  // (Sweep exists for a hard crash, which cannot run an abort handler; that path
  // is covered in streaming-core.test.ts.)
  assert.equal(await h.store.sweepAbandoned(), 0);
  assert.deepEqual(await h.bundles(), before);
});

test('a dry run reports fully and writes nothing', async () => {
  const h = streamHarness();
  const result = await h.run(AUG, { dryRun: true });
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.metrics.rowsEmitted, 3);
  assert.ok(result.run.normalizedDigest);
  assert.deepEqual(await h.bundles(), []);
  assert.equal(existsSync(join(h.varRoot, 'indexes')), false);
});

// --- security ------------------------------------------------------------------------------

test('restricted rows stay in the restricted root, and nowhere else', async () => {
  const h = streamHarness();
  await h.run(AUG);

  const contacts = await h.rows('contacts') as { value: string }[];
  assert.equal(contacts.length, 3);

  // Tested against values that appear ONLY in the taxpayer mailing block. A
  // parcel whose owner is billed at the property itself has a mailing address
  // equal to its situs address, and the situs address is public property data
  // that canonical output is supposed to carry — matching on that would flag a
  // coincidence as a leak and teach us to ignore the test.
  const mailingOnly = ['PO BOX 9', 'SAINT PAUL MN 55101', 'MINNEAPOLIS MN 55401'];
  assert.ok(mailingOnly.every((v) => contacts.some((c) => c.value.includes(v))));

  const scan = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of scan(join(h.varRoot, 'derived'))) {
    const text = readFileSync(file, 'utf8');
    for (const value of mailingOnly) {
      assert.ok(!text.includes(value), `mailing-only value "${value}" leaked into ${file}`);
    }
  }
});

test('no RESTRICTED source field reaches canonical output', async () => {
  const h = streamHarness();
  await h.run(AUG);
  const { hennepinRestrictedFields } = await import('../src/connectors/mn-hennepin-assessor/field-map.ts');

  // The structural check, independent of any particular value: no canonical row
  // may carry a key named after a restricted source field.
  const bundles = await h.bundles();
  const serialised = JSON.stringify(bundles);
  for (const field of hennepinRestrictedFields()) {
    assert.ok(!serialised.includes(`"${field}"`), `${field} appears as a key in canonical output`);
  }
});

test('no scratch or staging file survives a completed run', async () => {
  const h = streamHarness();
  await h.run(AUG);
  const scratch = join(h.varRoot, 'scratch');
  assert.equal(existsSync(scratch) ? readdirSync(scratch).length : 0, 0, 'scratch must be swept');
  const staging = join(h.root, 'archive', '.staging');
  assert.equal(existsSync(staging) ? readdirSync(staging).length : 0, 0, 'no staged artifact left behind');
});

test('the contact plane can be bounded without losing the count', async () => {
  const plane = createContactPlane({ maxRetained: 1 });
  const h = streamHarness({ contactPlane: plane });
  await h.run(AUG);

  // Exact count, capped retention: an operator metric must never be truncated
  // by a memory setting.
  assert.equal(plane.size(), 3);
  assert.equal(plane.read('operator').length, 1);
  assert.equal(plane.countsByType()['mailing_address'], 3);
  assert.throws(() => plane.read('anonymous'), (e: unknown) => isFabricError(e, 'RESTRICTED'));
});

// --- cross-source convergence still holds through the streaming path ----------------------

test('the streaming path resolves the eCRV convergence parcel identically', async () => {
  const h = streamHarness();
  await h.run(AUG);
  const resolutions = await h.resolutions() as { propertyId: string; normalizedParcel: string; state: string }[];
  const shared = resolutions.find((r) => r.normalizedParcel === '0202824410097');
  assert.ok(shared);
  assert.equal(shared.state, 'resolved');
  // The same canonical id the buffered runtime and the eCRV connector compute.
  assert.equal(shared.propertyId, 'prop_265548f625d901771894553b1a30b9d0');
});

// --- checkpoint and resume -----------------------------------------------------------

test('a completed acquisition is checkpointed and reused on resume', async () => {
  const h = streamHarness();
  const first = await h.run(AUG, { period: '2026-08' });
  assert.ok(first.artifact);

  const { createCheckpointStore } = await import('../src/runtime/checkpoint.ts');
  const checkpoints = createCheckpointStore(h.varRoot);
  const saved = await checkpoints.read('mn_hennepin_county_parcels', '2026-08');
  assert.ok(saved, 'acquisition should record a checkpoint');
  assert.equal(saved.sha256, first.run.artifactSha256);

  // Resuming must not touch the source. A local file that no longer exists
  // proves acquisition was skipped rather than merely fast.
  const resumed = await h.run('/nonexistent/deleted-after-download.ndjson', {
    period: '2026-08',
    resume: true,
  });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.run.artifactSha256, first.run.artifactSha256);
  assert.equal(resumed.run.normalizedDigest, first.run.normalizedDigest);
  assert.equal(resumed.run.canonicalDigest, first.run.canonicalDigest);
});

test('a corrupted retained artifact fails the run rather than being silently replaced', async () => {
  const h = streamHarness();
  const first = await h.run(AUG, { period: '2026-08' });
  assert.ok(first.artifact);

  const { chmodSync, writeFileSync: write } = await import('node:fs');
  const objectPath = join(h.root, 'archive', ...first.artifact.storagePath.split('/'));
  chmodSync(objectPath, 0o644);
  write(objectPath, 'not the county at all\n');

  // A checkpoint is a pointer, not a cache: the artifact is re-hashed before it
  // is trusted, so the corruption is caught. What happens next is deliberate —
  // re-acquiring the real bytes would mean writing over retained evidence, and
  // the immutable store refuses. Corrupted evidence is an incident for a human,
  // not something ingestion quietly repairs.
  const resumed = await h.run(AUG, { period: '2026-08', resume: true });
  assert.equal(resumed.run.status, 'failed');
  assert.equal(resumed.run.failureKind, 'IMMUTABILITY');
  assert.match(resumed.run.failureMessage ?? '', /refusing to overwrite retained object/);
});

test('a deleted artifact is simply re-acquired', async () => {
  const h = streamHarness();
  const first = await h.run(AUG, { period: '2026-08' });
  assert.ok(first.artifact);

  const { rm } = await import('node:fs/promises');
  await rm(join(h.root, 'archive', ...first.artifact.storagePath.split('/')), { force: true });

  // Nothing is being overwritten, so acquisition proceeds and lands on the same
  // digest — content addressing means the recovered artifact is the same artifact.
  const resumed = await h.run(AUG, { period: '2026-08', resume: true });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.run.artifactSha256, first.run.artifactSha256);
  assert.equal(resumed.run.normalizedDigest, first.run.normalizedDigest);
});

test('resuming without a checkpoint is an ordinary run', async () => {
  const h = streamHarness();
  const result = await h.run(AUG, { period: '2026-08', resume: true });
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.metrics.rowsParsed, 3);
});

test('a resumed run produces no duplicate observations', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08' });
  const before = await h.bundles();
  await h.run(AUG, { period: '2026-08', resume: true });
  const after = await h.bundles();
  assert.equal(after.length, before.length);
  assert.equal((await h.store.listRuns()).length, 1);
});

test('a dry run leaves no checkpoint behind', async () => {
  const h = streamHarness();
  await h.run(AUG, { period: '2026-08', dryRun: true });
  const { createCheckpointStore } = await import('../src/runtime/checkpoint.ts');
  assert.equal(await createCheckpointStore(h.varRoot).read('mn_hennepin_county_parcels', '2026-08'), null);
});
