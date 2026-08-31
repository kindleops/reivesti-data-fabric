/**
 * The DF-0C proof: eCRV and the Hennepin assessor converge on one canonical
 * property, and they do it regardless of which arrives first.
 *
 * eCRV supplies a submitter-stated PREPARATORY parcel id, punctuated:
 *   02-028-24-41-0097   -> provisional
 * Hennepin supplies the county's AUTHORITATIVE parcel id, unpunctuated:
 *   0202824410097       -> resolved
 *
 * Both normalise to the same 13-digit key and therefore compute the same
 * canonical property id, independently, without either source consulting the
 * other.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeParcelId,
  propertyIdFromCountyParcel,
  type PropertyIdentifierObservation,
} from '../src/canonical/models.ts';
import {
  detectConflicts,
  parcelAuthorityFor,
  resolveAll,
  resolveProperty,
} from '../src/canonical/property-resolution.ts';
import { contentDigest } from '../src/core/hash.ts';
import { createMemoryFabricStore, type FabricStore } from '../src/runtime/fabric-store.ts';
import { HENNEPIN_ASSESSOR_SOURCE_ID, MN_ECRV_SOURCE_ID } from '../src/registry/sources.ts';
import { fixture, harness, hennepinFixture } from './helpers.ts';

const CONVERGENCE_PID = '0202824410097';
const CONVERGENCE_PROPERTY_ID = propertyIdFromCountyParcel('27053', CONVERGENCE_PID);
const ECRV_FIXTURE = fixture('07-hennepin-convergence-preliminary-pid.xml');
const ASSESSOR_FIXTURE = hennepinFixture('snapshot-2026-08.ndjson');

// --- the join key -----------------------------------------------------------------

test('the punctuated and unpunctuated parcel ids normalise to the same key', () => {
  assert.equal(normalizeParcelId('02-028-24-41-0097'), CONVERGENCE_PID);
  assert.equal(normalizeParcelId('0202824410097'), CONVERGENCE_PID);
  // Normalisation is defensibly reversible in the sense that matters: it only
  // removes formatting the county itself applies inconsistently. Both sources
  // therefore compute the same canonical id without ever comparing notes.
  assert.equal(
    propertyIdFromCountyParcel('27053', normalizeParcelId('02-028-24-41-0097')),
    propertyIdFromCountyParcel('27053', normalizeParcelId('0202824410097')),
  );
});

test('the same parcel string in another county is a different property', () => {
  assert.notEqual(
    propertyIdFromCountyParcel('27053', CONVERGENCE_PID),
    propertyIdFromCountyParcel('27003', CONVERGENCE_PID),
  );
});

// --- eCRV first -------------------------------------------------------------------

test('eCRV alone leaves the property provisional', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const ecrv = await h.run([ECRV_FIXTURE]);

  assert.equal(ecrv.run.status, 'completed');
  const resolution = (await fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);
  assert.ok(resolution, 'the eCRV filing should have produced a property');
  assert.equal(resolution.state, 'provisional');
  assert.equal(resolution.authoritativeSourceId, null);
  assert.equal(resolution.resolutionMethod, 'county_parcel_preliminary');
  assert.deepEqual(resolution.contributingSourceIds, [MN_ECRV_SOURCE_ID]);
});

test('eCRV then assessor promotes the property to resolved', async () => {
  const { fabricStore } = await ingest(['ecrv', 'assessor']);
  const resolution = (await fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);

  assert.equal(resolution?.state, 'resolved');
  assert.equal(resolution?.authoritativeSourceId, HENNEPIN_ASSESSOR_SOURCE_ID);
  assert.equal(resolution?.resolutionMethod, 'county_parcel_authoritative');
  assert.deepEqual(resolution?.contributingSourceIds, [HENNEPIN_ASSESSOR_SOURCE_ID, MN_ECRV_SOURCE_ID].sort());
  assert.equal(resolution?.evidenceObservationIds.length, 2);
});

// --- assessor first ---------------------------------------------------------------

test('assessor then eCRV reaches exactly the same state', async () => {
  const { fabricStore } = await ingest(['assessor', 'ecrv']);
  const resolution = (await fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);

  assert.equal(resolution?.state, 'resolved');
  assert.equal(resolution?.authoritativeSourceId, HENNEPIN_ASSESSOR_SOURCE_ID);
  assert.deepEqual(resolution?.contributingSourceIds, [HENNEPIN_ASSESSOR_SOURCE_ID, MN_ECRV_SOURCE_ID].sort());
});

test('ingestion order does not change the canonical outcome at all', async () => {
  const forward = await ingest(['ecrv', 'assessor']);
  const reverse = await ingest(['assessor', 'ecrv']);

  const a = (await forward.fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);
  const b = (await reverse.fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);

  // Not merely "both resolved": byte-identical resolution records. Resolution is
  // a fold over a set, and a fold over a set cannot depend on insertion order.
  assert.ok(a && b);
  assert.equal(contentDigest(a), contentDigest(b));
  assert.equal(a.propertyId, CONVERGENCE_PROPERTY_ID);
});

test('every property, not just the shared one, resolves order-independently', async () => {
  const forward = await ingest(['ecrv', 'assessor']);
  const reverse = await ingest(['assessor', 'ecrv']);

  const digest = async (store: FabricStore): Promise<string> =>
    contentDigest((await store.resolutions()).map((r) => ({ ...r })));

  assert.equal(await digest(forward.fabricStore), await digest(reverse.fabricStore));
  assert.equal((await forward.fabricStore.resolutions()).length, 3);
});

// --- evidence is preserved on both sides --------------------------------------------

test('the eCRV transaction and its evidence survive the promotion untouched', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const ecrv = await h.run([ECRV_FIXTURE]);
  const before = ecrv.bundles[0];
  assert.ok(before);

  await harness({ root: h.root, fabricStore }).runHennepin(ASSESSOR_FIXTURE);

  const after = (await fabricStore.bundles())
    .find((b) => b.transaction.sourceRecordId === 'MN-27-1000007');
  assert.ok(after);
  // Byte-identical: nothing rewrote the historical filing to pretend it was
  // authoritative all along.
  assert.equal(contentDigest(after), contentDigest(before));
  assert.equal(after.transaction.totalConsideration?.amountMinor, 30_000_000);
});

test('the eCRV parcel observation still says preliminary and provisional, forever', async () => {
  const { fabricStore } = await ingest(['ecrv', 'assessor']);
  const identifiers = (await fabricStore.bundles())
    .flatMap((b) => b.propertyIdentifiers)
    .filter((o) => o.identifierType === 'county_parcel' && o.normalizedValue === CONVERGENCE_PID);

  assert.equal(identifiers.length, 2);
  const fromEcrv = identifiers.find((o) => o.evidence.sourceId === MN_ECRV_SOURCE_ID);
  const fromAssessor = identifiers.find((o) => o.evidence.sourceId === HENNEPIN_ASSESSOR_SOURCE_ID);

  // The promotion is recorded on the property, not by editing what eCRV said.
  assert.equal(fromEcrv?.finality, 'preliminary');
  assert.equal(fromEcrv?.resolutionState, 'provisional');
  assert.equal(fromAssessor?.finality, 'final');
  assert.equal(fromAssessor?.resolutionState, 'resolved');
  // Both point at the same property, computed independently.
  assert.equal(fromEcrv?.propertyId, CONVERGENCE_PROPERTY_ID);
  assert.equal(fromAssessor?.propertyId, CONVERGENCE_PROPERTY_ID);
});

test('assessor evidence exists separately and is not folded into the transaction', async () => {
  const { fabricStore } = await ingest(['ecrv', 'assessor']);
  const bundles = await fabricStore.bundles();

  const assessorBundle = bundles.find((b) => b.transaction.sourceRecordId === `MN-27053-${CONVERGENCE_PID}`);
  assert.ok(assessorBundle);
  // The assessor row carries no transfer: it is not a second, weaker account of
  // the sale eCRV already recorded.
  assert.equal(assessorBundle.transaction.totalConsideration, null);
  assert.equal(assessorBundle.transaction.transferDate, null);
  assert.equal(assessorBundle.transaction.instrumentTypeCode, null);
  assert.deepEqual(assessorBundle.transactionParties, []);
  assert.equal(assessorBundle.transaction.characteristics['record_kind'], 'parcel_snapshot');

  // And the assessor's echo of a last sale never becomes a transfer event.
  const types = new Set(bundles.flatMap((b) => b.events).map((e) => e.eventType));
  assert.ok(types.has('PARCEL_RESOLVED'));
  assert.ok(types.has('REAL_ESTATE_TRANSFER_OBSERVED'));
  const assessorEvents = assessorBundle.events.map((e) => e.eventType);
  assert.ok(!assessorEvents.includes('REAL_ESTATE_TRANSFER_OBSERVED'));
  assert.ok(!assessorEvents.includes('PROPERTY_SALE_OBSERVED'));
});

test('replay after convergence reproduces the same canonical property id', async () => {
  const { fabricStore, hennepinRun, root } = await ingest(['ecrv', 'assessor']);
  assert.ok(hennepinRun.artifact);

  const before = (await fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);
  const replayed = await harness({ root, fabricStore })
    .runHennepin(ASSESSOR_FIXTURE, { replayArtifact: hennepinRun.artifact });

  assert.equal(replayed.run.normalizedDigest, hennepinRun.run.normalizedDigest);
  const after = (await fabricStore.resolutions()).find((r) => r.propertyId === CONVERGENCE_PROPERTY_ID);
  assert.equal(contentDigest(after), contentDigest(before));
});

// --- conflict handling -----------------------------------------------------------------

test('a preliminary PID the assessor does not contain stays provisional and is flagged', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  // This eCRV filing names a Hennepin parcel that is not in the snapshot.
  await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const run = await harness({ root: h.root, fabricStore }).runHennepin(ASSESSOR_FIXTURE);

  const orphan = (await fabricStore.resolutions())
    .find((r) => r.normalizedParcel === normalizeParcelId('01-234-56-78-9012'));
  assert.equal(orphan?.state, 'provisional');
  assert.equal(orphan?.authoritativeSourceId, null);

  const conflict = run.conflicts.find((c) => c.conflictKind === 'pid_absent_from_authoritative_source');
  assert.ok(conflict, 'the gap should be flagged');
  // Informational, not blocking: the parcel may simply be outside the slice we hold.
  assert.equal(conflict.severity, 'info');
});

test('two PIDs sharing an address are reported and never merged', async () => {
  const run = await harness().runHennepin(hennepinFixture('conflict-same-address-different-pid.ndjson'));

  const properties = new Set(run.bundles.flatMap((b) => b.properties).map((p) => p.propertyId));
  assert.equal(properties.size, 2, 'two PIDs must stay two properties');

  const conflict = run.conflicts.find((c) => c.conflictKind === 'address_matches_different_pid');
  assert.ok(conflict, 'the shared address should be flagged');
  assert.equal(conflict.severity, 'info');
  assert.equal((conflict.detail['propertyIds'] as string[]).length, 2);
});

test('one PID described with different addresses by two sources is flagged, not reconciled', () => {
  const authority = parcelAuthorityFor([HENNEPIN_ASSESSOR_SOURCE_ID]);
  const observations = [
    identifier('a', MN_ECRV_SOURCE_ID, 'provisional', 'preliminary'),
    identifier('b', HENNEPIN_ASSESSOR_SOURCE_ID, 'resolved', 'final'),
  ];
  const conflicts = detectConflicts({
    observations,
    authority,
    runId: 'run1',
    detectedAt: '2026-08-31T12:00:00.000Z',
    addressByObservation: new Map([['a', '100 SYNTHETIC AVE'], ['b', '900 DIFFERENT WAY']]),
  });
  const conflict = conflicts.find((c) => c.conflictKind === 'same_pid_different_address');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'warn');
  // Flagged only. Nothing picked a winner.
  const resolution = resolveProperty(observations, authority);
  assert.equal(resolution?.state, 'resolved');
});

test('two authoritative rows for one PID are a blocking conflict', () => {
  const authority = parcelAuthorityFor([HENNEPIN_ASSESSOR_SOURCE_ID]);
  const conflicts = detectConflicts({
    observations: [
      identifier('a', HENNEPIN_ASSESSOR_SOURCE_ID, 'resolved', 'final', 'rec-1'),
      identifier('b', HENNEPIN_ASSESSOR_SOURCE_ID, 'resolved', 'final', 'rec-2'),
    ],
    authority,
    runId: 'run1',
    detectedAt: '2026-08-31T12:00:00.000Z',
    addressByObservation: new Map(),
  });
  const conflict = conflicts.find((c) => c.conflictKind === 'duplicate_authoritative_row');
  assert.equal(conflict?.severity, 'blocking');
});

test('an address-only source resolves nothing', () => {
  const authority = parcelAuthorityFor([HENNEPIN_ASSESSOR_SOURCE_ID]);
  const addressOnly: PropertyIdentifierObservation = {
    ...identifier('a', MN_ECRV_SOURCE_ID, 'unresolved', 'unknown'),
    identifierType: 'normalized_address',
    propertyId: null,
  };
  assert.equal(resolveProperty([addressOnly], authority), null);
  assert.deepEqual(resolveAll([addressOnly], authority), []);
});

test('the resolution fold gives the same answer for every permutation of its input', () => {
  const authority = parcelAuthorityFor([HENNEPIN_ASSESSOR_SOURCE_ID]);
  const observations = [
    identifier('a', MN_ECRV_SOURCE_ID, 'provisional', 'preliminary', 'rec-1'),
    identifier('b', HENNEPIN_ASSESSOR_SOURCE_ID, 'resolved', 'final', 'rec-2'),
    identifier('c', MN_ECRV_SOURCE_ID, 'provisional', 'preliminary', 'rec-3'),
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map((order) => resolveProperty(order.map((i) => observations[i] as PropertyIdentifierObservation), authority));

  const digests = new Set(permutations.map((r) => contentDigest(r)));
  assert.equal(digests.size, 1, 'the fold must not depend on input order');
  assert.equal(permutations[0]?.state, 'resolved');
});

// ---------------------------------------------------------------------------

type Ingested = {
  fabricStore: FabricStore;
  root: string;
  hennepinRun: Awaited<ReturnType<ReturnType<typeof harness>['runHennepin']>>;
};

/** Ingests both sources in the given order into one shared estate. */
async function ingest(order: readonly ('ecrv' | 'assessor')[]): Promise<Ingested> {
  const fabricStore = createMemoryFabricStore();
  const base = harness({ fabricStore });
  let hennepinRun!: Ingested['hennepinRun'];

  for (const which of order) {
    const h = harness({ root: base.root, fabricStore });
    if (which === 'ecrv') await h.run([ECRV_FIXTURE]);
    else hennepinRun = await h.runHennepin(ASSESSOR_FIXTURE);
  }
  return { fabricStore, root: base.root, hennepinRun };
}

function identifier(
  id: string,
  sourceId: string,
  resolutionState: PropertyIdentifierObservation['resolutionState'],
  finality: PropertyIdentifierObservation['finality'],
  sourceRecordId = 'rec-1',
): PropertyIdentifierObservation {
  return {
    observationId: id,
    identifierType: 'county_parcel',
    value: CONVERGENCE_PID,
    normalizedValue: CONVERGENCE_PID,
    countyFips: '27053',
    sourceDesignation: 'primary',
    finality,
    resolutionState,
    propertyId: CONVERGENCE_PROPERTY_ID,
    resolutionMethod: null,
    evidence: {
      sourceId,
      sourceRecordId,
      artifactId: 'a1',
      runId: 'run1',
      observedAt: '2026-08-31T12:00:00.000Z',
      effectiveAt: null,
      rawRecordHash: 'h',
      parserVersion: 'p',
      normalizationVersion: 'n',
    },
  };
}
