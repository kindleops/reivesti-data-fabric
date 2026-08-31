/**
 * Three sources, one property, three separate provenances.
 *
 *   eCRV       what the buyer declared to the Department of Revenue: the sale
 *              and its economics
 *   assessor   the county's parcel roll: authoritative parcel identity
 *   recorder   the legal instrument: what was filed, by whom, when
 *
 * They must converge on one canonical property without collapsing into one
 * undifferentiated "sale", and without any of them overwriting another's
 * evidence. This file proves both halves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentDigest, canonicalJson } from '../src/core/hash.ts';
import { normalizeParcelId, propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { matchTransactionCandidates } from '../src/canonical/instrument-graph.ts';
import { createMemoryFabricStore } from '../src/runtime/fabric-store.ts';
import {
  ECRV_CONVERGENCE_FIXTURE,
  fixture,
  harness,
  hennepinFixture,
  recorderFixture,
  streamHarness,
} from './helpers.ts';

const PID = '0202824410097';
const PROPERTY_ID = propertyIdFromCountyParcel('27053', PID);
const ASSESSOR = hennepinFixture('v2-2026-08.ndjson');
const RECORDER = recorderFixture('chain-2024-2025.ndjson');

type Row = Record<string, unknown>;

// --- the shared key -------------------------------------------------------------

test('all three sources compute the same canonical property id independently', () => {
  // eCRV writes a punctuated preliminary PID; the assessor and the recorder
  // write the county's 13-digit form. None of them consults the others.
  assert.equal(normalizeParcelId('02-028-24-41-0097'), PID);
  assert.equal(normalizeParcelId('0202824410097'), PID);
  assert.equal(propertyIdFromCountyParcel('27053', normalizeParcelId('02-028-24-41-0097')), PROPERTY_ID);
});

// --- assessor and recorder, both orders --------------------------------------------

test('assessor then recorder converge on one property', async () => {
  const h = streamHarness();
  await h.run(ASSESSOR, { period: '2026-08' });
  await h.runRecorder(RECORDER);
  await assertConverged(h);
});

test('recorder then assessor converge on the same property', async () => {
  const h = streamHarness();
  await h.runRecorder(RECORDER);
  await h.run(ASSESSOR, { period: '2026-08' });
  await assertConverged(h);
});

test('ingest order does not change the resolution at all', async () => {
  const forward = streamHarness();
  await forward.run(ASSESSOR, { period: '2026-08' });
  await forward.runRecorder(RECORDER);

  const reverse = streamHarness();
  await reverse.runRecorder(RECORDER);
  await reverse.run(ASSESSOR, { period: '2026-08' });

  const a = (await forward.resolutions() as Row[]).find((r) => r['normalizedParcel'] === PID);
  const b = (await reverse.resolutions() as Row[]).find((r) => r['normalizedParcel'] === PID);
  assert.ok(a && b);
  assert.equal(contentDigest(a), contentDigest(b));
});

test('the assessor stays authoritative for parcel identity, not the recorder', async () => {
  const h = streamHarness();
  await h.runRecorder(RECORDER);
  await h.run(ASSESSOR, { period: '2026-08' });

  const resolution = (await h.resolutions() as Row[]).find((r) => r['normalizedParcel'] === PID);
  assert.equal(resolution?.['state'], 'resolved');
  // Authority is field-specific. The county office that *assigns* parcel numbers
  // is the assessor roll; the recorder indexes them but does not issue them.
  assert.equal(resolution?.['authoritativeSourceId'], 'mn_hennepin_county_parcels');
  assert.deepEqual(
    (resolution?.['contributingSourceIds'] as string[]).sort(),
    ['mn_hennepin_county_parcels', 'mn_hennepin_recorded_instruments'],
  );
});

test('recorder-only property linkage stays provisional', async () => {
  // Without the assessor, the recorder's indexed PID is good evidence and not
  // the issuing authority, so the property resolves only to provisional.
  const h = streamHarness();
  await h.runRecorder(RECORDER);
  const resolution = (await h.resolutions() as Row[]).find((r) => r['normalizedParcel'] === PID);
  assert.equal(resolution?.['state'], 'provisional');
  assert.equal(resolution?.['authoritativeSourceId'], null);
});

// --- evidence stays separate ---------------------------------------------------------

test('each source keeps its own evidence after convergence', async () => {
  const h = streamHarness();
  await h.run(ASSESSOR, { period: '2026-08' });
  await h.runRecorder(RECORDER);

  const identifiers = (await h.bundles() as Row[])
    .flatMap((b) => (b['propertyIdentifiers'] ?? []) as Row[])
    .filter((o) => o['identifierType'] === 'county_parcel' && o['normalizedValue'] === PID);

  const bySource = new Map(identifiers.map((o) => [((o['evidence'] as Row)['sourceId']) as string, o]));
  assert.equal(bySource.size, 2);

  const assessor = bySource.get('mn_hennepin_county_parcels');
  const recorder = bySource.get('mn_hennepin_recorded_instruments');
  // The assessor issues the number: final and resolved. The recorder indexes it:
  // preliminary and provisional. Neither rewrites the other.
  assert.equal(assessor?.['finality'], 'final');
  assert.equal(assessor?.['resolutionState'], 'resolved');
  assert.equal(recorder?.['finality'], 'preliminary');
  assert.equal(recorder?.['resolutionState'], 'provisional');
});

test('the recorder adds no assessor-style owner observation, and vice versa', async () => {
  const h = streamHarness();
  await h.run(ASSESSOR, { period: '2026-08' });
  await h.runRecorder(RECORDER);

  const parties = (await h.bundles() as Row[]).flatMap((b) => (b['parties'] ?? []) as Row[]);
  const assessorOwners = parties.filter((p) => p['role'] === 'assessor_owner_of_record');
  const recorderParties = parties.filter((p) => String(p['sourceRole']).startsWith('hennepin_recorder:'));

  assert.ok(assessorOwners.length > 0);
  assert.ok(recorderParties.length > 0);
  // Two vocabularies, deliberately not unified: the roll says who is billed, the
  // recorder says who signed a document.
  assert.ok(assessorOwners.every((p) => !String(p['sourceRole']).startsWith('hennepin_recorder:')));
  assert.ok(recorderParties.every((p) => p['role'] === 'other'));
});

// --- duplicate transaction prevention ----------------------------------------------------

test('eCRV, assessor and recorder describing one sale yield one candidate, not three', async () => {
  const candidates = await candidatesFor([
    ecrvObservation('2025-06-01T00:00:00Z', ['TESTTWO BLAKE', 'NORTHSTAR HOMES LLC'], 49_800_000),
    recorderObservation('2025-06-01T11:00:00-05:00', ['NORTHSTAR HOMES LLC', 'TESTTWO BLAKE'], null),
    assessorObservation('2025-06-04T00:00:00Z', [], 49_800_000),
  ]);

  assert.equal(candidates.length, 1, 'three observations of one event, not three events');
  assert.equal(candidates[0]?.state, 'SUPPORTED_MATCH');
  assert.deepEqual(candidates[0]?.supportingSourceIds.length, 3);
  // The underlying observations are untouched; the candidate points at each.
  assert.ok(candidates[0]?.ecrvTransactionId);
  assert.ok(candidates[0]?.recorderInstrumentId);
  assert.ok(candidates[0]?.assessorSaleEcho);
});

test('sources that disagree on price produce a CONFLICT, never a chosen winner', async () => {
  const candidates = await candidatesFor([
    ecrvObservation('2025-06-01T00:00:00Z', ['TESTTWO BLAKE'], 49_800_000),
    assessorObservation('2025-06-03T00:00:00Z', ['TESTTWO BLAKE'], 12_000_000),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.state, 'CONFLICT');
  assert.ok((candidates[0]?.disagreements ?? []).some((d) => /consideration differs/.test(d)));
  // A conflict is a durable statement that the sources disagree. Nothing was merged.
  assert.ok(candidates[0]?.ecrvTransactionId && candidates[0]?.assessorSaleEcho);
});

test('two genuinely different events months apart stay two candidates', async () => {
  const candidates = await candidatesFor([
    ecrvObservation('2024-03-11T00:00:00Z', ['NORTHSTAR HOMES LLC'], 41_250_000),
    recorderObservation('2024-03-15T10:22:00-05:00', ['NORTHSTAR HOMES LLC'], null),
    ecrvObservation('2025-05-28T00:00:00Z', ['TESTTWO BLAKE'], 49_800_000),
    recorderObservation('2025-06-01T11:00:00-05:00', ['TESTTWO BLAKE'], null),
  ]);
  assert.equal(candidates.length, 2, 'a 2024 sale and a 2025 sale are two events');
  assert.ok(candidates.every((c) => c.state === 'SUPPORTED_MATCH'));
});

test('corroboration without a shared party is only a POSSIBLE_MATCH', async () => {
  const candidates = await candidatesFor([
    ecrvObservation('2025-06-01T00:00:00Z', ['SOMEONE ELSE'], null),
    recorderObservation('2025-06-01T11:00:00-05:00', ['NORTHSTAR HOMES LLC'], null),
  ]);
  assert.equal(candidates[0]?.state, 'POSSIBLE_MATCH');
  assert.ok((candidates[0]?.disagreements ?? []).some((d) => /no party name is shared/.test(d)));
});

test('a single source alone is UNRESOLVED, not a confirmed transaction', async () => {
  const candidates = await candidatesFor([
    recorderObservation('2025-06-01T11:00:00-05:00', ['NORTHSTAR HOMES LLC'], null),
  ]);
  assert.equal(candidates[0]?.state, 'UNRESOLVED');
});

test('candidate matching is order-independent', async () => {
  const rows = [
    ecrvObservation('2025-06-01T00:00:00Z', ['TESTTWO BLAKE'], 49_800_000),
    recorderObservation('2025-06-01T11:00:00-05:00', ['TESTTWO BLAKE'], null),
    assessorObservation('2025-06-04T00:00:00Z', ['TESTTWO BLAKE'], 49_800_000),
  ];
  const forward = await candidatesFor(rows);
  const reverse = await candidatesFor([...rows].reverse());
  assert.equal(contentDigest(forward), contentDigest(reverse));
});

// --- eCRV keeps its own account of the sale ---------------------------------------------

test('eCRV remains the source of sale economics; the recorder claims none', async () => {
  const ecrv = harness({ fabricStore: createMemoryFabricStore() });
  const ecrvRun = await ecrv.run([ECRV_CONVERGENCE_FIXTURE]);
  const ecrvBundle = ecrvRun.bundles[0];
  assert.ok(ecrvBundle);
  assert.equal(ecrvBundle.transaction.totalConsideration?.amountMinor, 30_000_000);
  assert.equal(ecrvBundle.properties[0]?.propertyId, PROPERTY_ID);

  const recorder = streamHarness();
  await recorder.runRecorder(RECORDER);
  const recorderBundles = await recorder.bundles() as Row[];
  // Every recorder bundle is explicitly a document, not a transaction.
  for (const b of recorderBundles) {
    const t = b['transaction'] as Row;
    assert.equal(t['totalConsideration'], null);
    assert.equal(t['transferDate'], null);
    assert.equal((t['characteristics'] as Row)['record_kind'], 'recorded_instrument');
  }
  // And the two never produce competing sale events.
  const recorderEvents = new Set((await recorder.table('events') as Row[]).map((e) => e['eventType']));
  assert.ok(!recorderEvents.has('PROPERTY_SALE_OBSERVED'));
  assert.ok(recorderEvents.has('CONVEYANCE_OBSERVED'));

  const ecrvEvents = new Set(ecrvRun.events.map((e) => e.eventType));
  assert.ok(ecrvEvents.has('PROPERTY_SALE_OBSERVED'));
  assert.ok(!ecrvEvents.has('CONVEYANCE_OBSERVED'));
});

// ---------------------------------------------------------------------------

async function assertConverged(h: ReturnType<typeof streamHarness>): Promise<void> {
  const properties = (await h.bundles() as Row[])
    .flatMap((b) => (b['properties'] ?? []) as Row[])
    .filter((p) => p['propertyId'] === PROPERTY_ID);
  assert.ok(properties.length >= 2, 'both sources contribute to the same property');

  const resolution = (await h.resolutions() as Row[]).find((r) => r['normalizedParcel'] === PID);
  assert.ok(resolution, 'the shared parcel resolves');
  assert.equal(resolution['propertyId'], PROPERTY_ID);
  assert.equal(resolution['state'], 'resolved');
}

type Candidate = Awaited<ReturnType<typeof candidatesFor>>[number];

async function candidatesFor(rows: readonly Record<string, unknown>[]): Promise<{
  state: string; supportingSourceIds: readonly string[]; disagreements: readonly string[];
  ecrvTransactionId: string | null; recorderInstrumentId: string | null; assessorSaleEcho: string | null;
}[]> {
  async function* source(): AsyncGenerator<string> {
    for (const r of rows) yield canonicalJson(r);
  }
  const out: Candidate[] = [];
  await matchTransactionCandidates(
    source,
    () => ({
      sourceId: 'test', sourceRecordId: 'r', artifactId: 'a', runId: 'run',
      observedAt: '2026-08-31T12:00:00.000Z', effectiveAt: null,
      rawRecordHash: 'h', parserVersion: 'p', normalizationVersion: 'n',
    }),
    async (c) => {
      out.push({
        state: c.state, supportingSourceIds: c.supportingSourceIds, disagreements: c.disagreements,
        ecrvTransactionId: c.ecrvTransactionId, recorderInstrumentId: c.recorderInstrumentId,
        assessorSaleEcho: c.assessorSaleEcho,
      });
    },
  );
  return out;
}

function ecrvObservation(t: string, names: readonly string[], amount: number | null): Record<string, unknown> {
  return { p: PROPERTY_ID, c: '27053', t, s: 'mn_dor_ecrv_weekly_sales_extract', k: 'ecrv', id: `ecrv-${t}`, n: [...names].sort(), a: amount };
}
function recorderObservation(t: string, names: readonly string[], amount: number | null): Record<string, unknown> {
  return { p: PROPERTY_ID, c: '27053', t, s: 'mn_hennepin_recorded_instruments', k: 'recorder', id: `instr-${t}`, n: [...names].sort(), a: amount };
}
function assessorObservation(t: string, names: readonly string[], amount: number | null): Record<string, unknown> {
  return { p: PROPERTY_ID, c: '27053', t, s: 'mn_hennepin_county_parcels', k: 'assessor', id: `echo-${t}`, n: [...names].sort(), a: amount };
}
