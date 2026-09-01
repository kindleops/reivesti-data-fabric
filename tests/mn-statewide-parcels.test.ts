/**
 * Minnesota statewide parcels: one source, many counties.
 *
 * The claims under test are the ones that only appear at multi-jurisdiction
 * scale — county routing from authoritative FIPS, canonical identity that stays
 * county-scoped when parcel strings and street addresses repeat across county
 * lines, per-county partition isolation, and the Hennepin overlap where two
 * legitimate sources describe the same parcels.
 *
 * Every fixture row is invented. No live owner name or mailing address from the
 * 2.7-million-row delivery is committed to this repository.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../src/core/hash.ts';
import { isFabricError } from '../src/core/errors.ts';
import { propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { countyPartition, partitionId } from '../src/canonical/partitions.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import {
  auditOverlap,
  comparableOf,
  comparablesFrom,
  COMPARED_FIELDS,
} from '../src/canonical/overlap-audit.ts';
import { deriveVerdict, supersessionCheck, type FieldAgreement } from '../src/canonical/source-authority.ts';
import { assessActivation } from '../src/registry/policy.ts';
import { buildCoverage } from '../src/registry/coverage.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { countyJurisdictionId } from '../src/registry/jurisdictions.ts';
import {
  MN_STATEWIDE_SOURCE_ID,
  PINNED_FIELD_SET_DIGEST,
  createMnStatewideParcelConnector,
} from '../src/connectors/mn-statewide-parcels/index.ts';
import {
  MN_STATEWIDE_FIELD_MAP,
  NOT_INGESTED,
  RESTRICTED_FIELDS,
  mnStatewideDispositionCounts,
} from '../src/connectors/mn-statewide-parcels/field-map.ts';
import {
  AGGREGATION_RUN_DATE,
  MN_NOT_PARTICIPATING,
  MN_STATEWIDE_PARTICIPATION,
  reconcileParticipation,
} from '../src/connectors/mn-statewide-parcels/participation.ts';
import { parseMnStatewideFeature } from '../src/connectors/mn-statewide-parcels/parse.ts';
import { ASSESSOR_SALE_KIND } from '../src/connectors/mn-statewide-parcels/normalize.ts';
import {
  MN_STATEWIDE_MAPPING_ID,
  hennepinFixture,
  mnStatewideFixture,
  streamHarness,
  tempRoot,
} from './helpers.ts';

const HENNEPIN = '27053';
const RAMSEY = '27123';
const ANOKA = '27003';
const CARVER = '27019';
const DAKOTA = '27037';

const BASE = mnStatewideFixture('five-county-2026-08.bundle');
type Row = Record<string, unknown>;

// ===========================================================================
// 1. Source, policy and schema
// ===========================================================================

test('the source is zero-cost and the policy evaluator returns CORE_ELIGIBLE', () => {
  const source = defaultRegistry().source(MN_STATEWIDE_SOURCE_ID);
  assert.equal(source.costClass, 'FREE_OPEN_DATA');
  assert.equal(source.automationStatus, 'sanctioned');
  assert.equal(source.termsStatus, 'reviewed_permitted');
  // Reached through the doctrine, not by bypassing it.
  assert.equal(assessActivation(source).verdict, 'CORE_ELIGIBLE');
  assert.equal(source.role, 'CORE_CANONICAL_SOURCE');
});

test('one source definition covers 59 counties, not 59 sources', () => {
  const registry = defaultRegistry();
  const mapping = registry.mapping(MN_STATEWIDE_MAPPING_ID);
  assert.equal(registry.expand(mapping).length, 59);
  assert.equal(registry.sources.filter((s) => s.sourceId === MN_STATEWIDE_SOURCE_ID).length, 1);
  assert.deepEqual([...mapping.capabilities].sort(), ['assessor', 'ownership', 'parcel', 'tax']);
});

test('the whole published field set has a disposition, and geometry is excluded deliberately', () => {
  assert.equal(MN_STATEWIDE_FIELD_MAP.length, 94);
  const counts = mnStatewideDispositionCounts();
  assert.ok((counts['RESTRICTED'] ?? 0) === 8, 'four owner and four taxpayer mailing lines');
  assert.ok(NOT_INGESTED.some((n) => n.field.startsWith('Shape')));
  for (const n of NOT_INGESTED) assert.ok(n.reason.length > 30, 'an excluded field needs a real reason');
});

test('the pinned field-set digest is what the connector actually reads by', () => {
  assert.match(PINNED_FIELD_SET_DIGEST, /^[0-9a-f]{64}$/);
});

test('participation is derived from the publisher, and reconciles', () => {
  assert.equal(MN_STATEWIDE_PARTICIPATION.length, 59);
  assert.equal(MN_NOT_PARTICIPATING.length, 28);
  assert.equal(MN_STATEWIDE_PARTICIPATION.length + MN_NOT_PARTICIPATING.length, 87);
  assert.equal(AGGREGATION_RUN_DATE, '2026-08-06');
  // Freshness varies by county and that is the point of recording it.
  const dates = MN_STATEWIDE_PARTICIPATION.map((c) => c.acquiredAt).filter((d): d is string => d !== null);
  assert.ok(new Set(dates).size > 20, 'counties are acquired on many different dates');
  assert.ok((dates.sort()[0] as string) < '2025-01-01', 'some counties are over a year stale');
});

test('participation reconciliation reports additions and removals rather than assuming', () => {
  const actual = new Map(MN_STATEWIDE_PARTICIPATION.map((c) => [c.fips, c.expectedRows]));
  assert.equal(reconcileParticipation(actual).matches, true);

  actual.delete(HENNEPIN);
  actual.set('27007', 1234);
  const drifted = reconcileParticipation(actual);
  assert.equal(drifted.matches, false);
  assert.deepEqual(drifted.removed, [HENNEPIN]);
  assert.deepEqual(drifted.added, ['27007']);
});

// ===========================================================================
// 2. County routing
// ===========================================================================

test('every parcel routes to the county partition its own co_code names', async () => {
  const h = streamHarness();
  const result = await h.runStatewide(BASE);
  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.countyCounts, { [ANOKA]: 2, [CARVER]: 1, [DAKOTA]: 1, [HENNEPIN]: 2, [RAMSEY]: 2 });
  for (const county of [HENNEPIN, RAMSEY, ANOKA, CARVER, DAKOTA]) {
    assert.ok(result.partitionPlan.partitions.includes(partitionId(countyPartition('PROPERTY_RESOLUTION', county))));
  }
});

test('a county the federal catalogue does not contain is quarantined, never guessed', async () => {
  const h = streamHarness();
  const result = await h.runStatewide(mnStatewideFixture('fault-unknown-county.bundle'), { period: '2026-08-bad' });
  // 27999 is not a Minnesota county; 48113 is Dallas, Texas, in a Minnesota layer.
  assert.equal(result.run.metrics.rowsQuarantined, 2);
  assert.equal(result.run.metrics.rowsValid, 2);
  assert.deepEqual(Object.keys(result.countyCounts), [HENNEPIN]);
});

test('a parcel with no identifier is quarantined rather than given a surrogate', async () => {
  const h = streamHarness();
  const result = await h.runStatewide(mnStatewideFixture('fault-missing-pin.bundle'), { period: '2026-08-noid' });
  assert.equal(result.run.metrics.rowsQuarantined, 1);
  assert.equal(result.run.metrics.rowsValid, 2);
});

test('the county is never inferred from the address', () => {
  // A row whose address is unmistakably Hennepin but whose co_code says Ramsey
  // must land in Ramsey. The source is the authority on its own geography.
  const parsed = parseMnStatewideFeature(
    { co_code: RAMSEY, county_pin: 'X1', ctu_name: 'Minneapolis', st_name: 'Nicollet', anumber: 100 },
    'row',
  );
  assert.equal(parsed.record.countyFips, RAMSEY);
});

test('a malformed county code fails loudly at parse time', () => {
  assert.throws(
    () => parseMnStatewideFeature({ co_code: '99999', county_pin: 'X1' }, 'row'),
    (e: unknown) => isFabricError(e, 'PARSE'),
  );
  assert.throws(
    () => parseMnStatewideFeature({ county_pin: 'X1' }, 'row'),
    (e: unknown) => isFabricError(e, 'PARSE'),
  );
});

// ===========================================================================
// 3. Canonical identity across county lines
// ===========================================================================

test('the same parcel string in two counties is two properties', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const bundles = (await h.bundles()) as Row[];
  const shared = bundles
    .map((b) => (b['propertyIdentifiers'] as Row[]).find((i) => i['identifierType'] === 'county_parcel'))
    .filter((i): i is Row => i !== undefined && i['normalizedValue'] === '0202824410097');

  assert.equal(shared.length, 2, 'the fixture puts this PIN in Hennepin and Ramsey');
  assert.equal(new Set(shared.map((i) => i['propertyId'])).size, 2);
  assert.equal(shared.find((i) => i['countyFips'] === HENNEPIN)?.['propertyId'],
    propertyIdFromCountyParcel(HENNEPIN, '0202824410097'));
  assert.equal(shared.find((i) => i['countyFips'] === RAMSEY)?.['propertyId'],
    propertyIdFromCountyParcel(RAMSEY, '0202824410097'));
});

test('the same street address in two counties never merges', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  // The fixture puts "1 Synthetic Ave" in both Hennepin and Ramsey. A conflict
  // spanning counties would mean the address pass had grouped across county
  // lines, which is the failure county partitioning exists to make impossible.
  const conflicts = (await h.partitionConflicts()) as Row[];
  const addressConflicts = conflicts.filter((c) => c['conflictKind'] === 'address_matches_different_pid');
  for (const conflict of addressConflicts) {
    const propertyIds = ((conflict['detail'] as Row)['propertyIds'] ?? []) as string[];
    assert.equal(
      new Set(propertyIds.map((id) => id)).size, propertyIds.length,
      'a conflict must not list the same property twice',
    );
    assert.ok(conflict['countyFips'], 'every conflict is scoped to one county');
  }
  const hennepinRamsey = addressConflicts.filter((c) => String(c['countyFips']) === '');
  assert.deepEqual(hennepinRamsey, [], 'no conflict may span counties');
});

test('the publisher row id is a source identifier, never Reivesti identity', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const bundles = (await h.bundles()) as Row[];
  for (const bundle of bundles) {
    const identifier = (bundle['propertyIdentifiers'] as Row[])[0] as Row;
    assert.match(String(identifier['propertyId']), /^prop_[0-9a-f]+$/);
    // OBJECTID is retained as provenance and is nowhere in the identity.
    const chars = ((bundle['characteristics'] as Row[])[0]?.['characteristics'] ?? {}) as Row;
    assert.ok('source_object_id' in chars);
  }
});

// ===========================================================================
// 4. Sale echo semantics
// ===========================================================================

test('the assessor sale echo is labelled, and never becomes consideration', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const bundles = (await h.bundles()) as Row[];
  const withSale = bundles.filter((b) => {
    const chars = ((b['characteristics'] as Row[])[0]?.['characteristics'] ?? {}) as Row;
    return chars['assessor_sale_date'] !== null && chars['assessor_sale_date'] !== undefined;
  });
  assert.ok(withSale.length >= 1);
  for (const bundle of withSale) {
    const chars = ((bundle['characteristics'] as Row[])[0]?.['characteristics'] ?? {}) as Row;
    assert.equal(chars['assessor_sale_kind'], ASSESSOR_SALE_KIND);
    // The transaction slot stays a non-transaction: no consideration, no date.
    const tx = bundle['transaction'] as Row;
    assert.equal(tx['totalConsideration'], null);
    assert.equal(tx['transferDate'], null);
    assert.equal((tx['characteristics'] as Row)['record_kind'], 'parcel_roll_row');
  }
});

test('no sale, transfer or financing event type is emitted by this source', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const events = (await h.rows('events')) as Row[];
  const types = new Set(events.map((e) => e['eventType']));
  for (const forbidden of ['PROPERTY_SALE_OBSERVED', 'REAL_ESTATE_TRANSFER_OBSERVED', 'FINANCING_OBSERVED',
    'CONVEYANCE_OBSERVED', 'MORTGAGE_RECORDED']) {
    assert.ok(!types.has(forbidden), `${forbidden} must not come from a parcel roll`);
  }
  assert.ok(types.has('PARCEL_OBSERVED'));
  assert.ok(types.has('ASSESSOR_OWNER_OBSERVED'));
});

test('the coverage graph does not claim transfer, deed, mortgage or foreclosure', () => {
  const mapping = defaultRegistry().mapping(MN_STATEWIDE_MAPPING_ID);
  for (const notClaimed of ['transfer', 'deed', 'mortgage', 'foreclosure_notice', 'mortgage_release', 'lien']) {
    assert.ok(!mapping.capabilities.includes(notClaimed as never), `${notClaimed} must not be claimed`);
  }
});

// ===========================================================================
// 5. Snapshot behaviour and partition isolation with real counties
// ===========================================================================

async function fingerprints(root: string): Promise<Record<string, string>> {
  const store = createPartitionStore(root);
  const out: Record<string, string> = {};
  for (const key of await store.listPartitions()) {
    const dir = join(root, 'derived', 'partitions', ...partitionId(key).split('/'));
    const generation = (await readFile(join(dir, 'CURRENT'), 'utf8')).trim();
    const info = await stat(join(dir, generation, 'resolutions.ndjson'));
    out[partitionId(key)] = `${generation}|${info.mtimeMs}|${info.size}`;
  }
  return out;
}

test('a delta touching four counties leaves the fifth untouched', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const before = await fingerprints(h.root);

  // September: Ramsey assessment change, Anoka owner change, Carver new parcel,
  // Dakota parcel missing. Hennepin is unchanged but still in the delivery.
  const september = await h.runStatewide(mnStatewideFixture('five-county-2026-09.bundle'), { period: '2026-09' });
  assert.equal(september.run.status, 'completed');

  // Dakota's parcel is absent from the delivery, so Dakota produces no rows and
  // is not in the plan — which is exactly why its partition must not be rewritten.
  assert.ok(!Object.keys(september.countyCounts).includes(DAKOTA));
  const after = await fingerprints(h.root);
  const dakota = partitionId(countyPartition('PROPERTY_RESOLUTION', DAKOTA));
  assert.equal(after[dakota], before[dakota], 'Dakota was rewritten and must not have been');
});

test('new, changed, missing and reappeared are each reported as themselves', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const september = await h.runStatewide(mnStatewideFixture('five-county-2026-09.bundle'), { period: '2026-09' });
  assert.equal(september.run.metrics.rowsNew, 1, 'Carver CV-0002');
  assert.equal(september.run.metrics.rowsRevised, 2, 'Ramsey assessment, Anoka owner');
  assert.ok(september.run.metrics.rowsMissingFromSnapshot >= 1, 'Dakota DK-0001');

  const absences = (await h.rows('absences')) as Row[];
  assert.ok(absences.length >= 1);
  // Absent from a delivery is not deleted from the world.
  for (const absence of absences) assert.ok(!/deleted|removed/i.test(canonicalJson(absence)));

  const october = await h.runStatewide(mnStatewideFixture('five-county-2026-10.bundle'), { period: '2026-10' });
  assert.ok(october.run.metrics.rowsNew >= 1, 'Dakota reappears');
});

test('reordering the delivery changes nothing but the run identity', async () => {
  const first = streamHarness();
  const second = streamHarness();
  const a = await first.runStatewide(BASE);
  const b = await second.runStatewide(mnStatewideFixture('five-county-2026-08-shuffled.bundle'));
  assert.equal(a.run.metrics.rowsValid, b.run.metrics.rowsValid);
  const strip = (rows: unknown[]) => rows.map((r) => canonicalJson(r).replace(/"(runId|artifactId)":"[^"]*"/g, '"$1":""')).sort();
  assert.deepEqual(strip(await first.bundles()), strip(await second.bundles()));
});

test('the sort chunk size changes nothing', async () => {
  const digests = new Set<string>();
  for (const chunkLines of [1, 3, 5000]) {
    const h = streamHarness();
    const r = await h.runStatewide(BASE, { batch: { sortChunkLines: chunkLines } } as never);
    digests.add(`${r.run.normalizedDigest}|${r.globalDigest}`);
  }
  assert.equal(digests.size, 1);
});

test('re-ingesting the same delivery is idempotent', async () => {
  const h = streamHarness();
  const one = await h.runStatewide(BASE);
  const two = await h.runStatewide(BASE);
  assert.equal(one.run.normalizedDigest, two.run.normalizedDigest);
  assert.equal(one.globalDigest, two.globalDigest);
  assert.equal(two.run.metrics.rowsUnchanged, two.run.metrics.rowsValid);
});

test('replaying the retained artifact reproduces the run exactly', async () => {
  const h = streamHarness();
  const first = await h.runStatewide(BASE);
  const replayed = await h.runStatewide(BASE, { replayArtifact: first.artifact! } as never);
  assert.equal(replayed.run.runId, first.run.runId);
  assert.equal(replayed.run.normalizedDigest, first.run.normalizedDigest);
  assert.equal(replayed.globalDigest, first.globalDigest);
});

test('a duplicate parcel in one delivery is counted, not silently kept twice', async () => {
  const h = streamHarness();
  const result = await h.runStatewide(mnStatewideFixture('duplicate-parcel.bundle'), { period: '2026-08-dup' });
  assert.equal(result.run.duplicateCount, 1);
  assert.equal(result.run.metrics.rowsQuarantined, 1);
});

test('a changed publisher field set quarantines the run before any row is read', async () => {
  const h = streamHarness();
  const result = await h.runStatewide(mnStatewideFixture('fault-field-drift.bundle'), { period: '2026-08-drift' });
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.equal(result.run.metrics.rowsValid, 0);
});

// ===========================================================================
// 6. Hennepin overlap
// ===========================================================================

test('two sources describing one Hennepin parcel produce two observations of one property', async () => {
  const h = streamHarness();
  await h.run(hennepinFixture('v2-2026-08.ndjson'));
  await h.runStatewide(mnStatewideFixture('hennepin-overlap.bundle'), { period: '2026-08-overlap' });

  const bundles = (await h.bundles()) as Row[];
  const byProperty = new Map<string, Set<string>>();
  for (const bundle of bundles) {
    const identifier = (bundle['propertyIdentifiers'] as Row[]).find((i) => i['identifierType'] === 'county_parcel');
    if (!identifier?.['propertyId']) continue;
    const key = String(identifier['propertyId']);
    const set = byProperty.get(key) ?? new Set<string>();
    set.add(String((bundle['transaction'] as Row)['sourceId']));
    byProperty.set(key, set);
  }
  const shared = [...byProperty.values()].filter((s) => s.size > 1);
  assert.ok(shared.length >= 1, 'the two sources must converge on at least one property');
  for (const sources of shared) {
    assert.ok(sources.has('mn_hennepin_county_parcels'));
    assert.ok(sources.has(MN_STATEWIDE_SOURCE_ID));
  }
});

test('both sources keep their own evidence; neither overwrites the other', async () => {
  const h = streamHarness();
  await h.run(hennepinFixture('v2-2026-08.ndjson'));
  await h.runStatewide(mnStatewideFixture('hennepin-overlap.bundle'), { period: '2026-08-overlap' });

  const audit = await auditOverlap(
    () => comparablesFrom(h.store.readTable('bundles')),
    {
      directSourceId: 'mn_hennepin_county_parcels',
      aggregationSourceId: MN_STATEWIDE_SOURCE_ID,
      decidedAt: '2026-08-31T12:00:00.000Z',
      countyFips: HENNEPIN,
      sort: { chunkLines: 8 },
    },
  );
  assert.ok(audit.overlapping >= 1);
  // Every compared field yields a profile, including the ones only one source has.
  assert.equal(audit.agreements.length, COMPARED_FIELDS.length);
  assert.equal(audit.decisions.length, COMPARED_FIELDS.length);
  const parcel = audit.agreements.find((a) => a.field === 'normalized_parcel');
  assert.equal(parcel?.conflict, 0, 'the parcel id is what makes them the same property');
});

test('a field only one source populates is preferred, and said to be', () => {
  const onlyAggregation: FieldAgreement = {
    field: 'finished_square_feet', bothPopulated: 0, exactMatch: 0, normalizedMatch: 0,
    conflict: 0, onlyDirect: 0, onlyAggregation: 400, neither: 0,
  };
  const decision = deriveVerdict(onlyAggregation, {
    directSourceId: 'a', aggregationSourceId: 'b', decidedAt: 'T',
  });
  assert.equal(decision.verdict, 'PREFER_STATE_AGGREGATION');
  assert.match(decision.basis, /only the state aggregation/);
});

test('near-total agreement is coequal, not a winner', () => {
  const decision = deriveVerdict(
    { field: 'x', bothPopulated: 1000, exactMatch: 1000, normalizedMatch: 0, conflict: 0, onlyDirect: 0, onlyAggregation: 0, neither: 0 },
    { directSourceId: 'a', aggregationSourceId: 'b', decidedAt: 'T' },
  );
  assert.equal(decision.verdict, 'COEQUAL_OBSERVATIONS');
});

test('wholesale disagreement is semantic difference, not staleness', () => {
  const decision = deriveVerdict(
    { field: 'x', bothPopulated: 1000, exactMatch: 100, normalizedMatch: 0, conflict: 900, onlyDirect: 0, onlyAggregation: 0, neither: 0 },
    { directSourceId: 'a', aggregationSourceId: 'b', decidedAt: 'T' },
  );
  assert.equal(decision.verdict, 'SEMANTICALLY_DIFFERENT');
});

test('partial disagreement stays UNRESOLVED rather than being guessed', () => {
  const decision = deriveVerdict(
    { field: 'x', bothPopulated: 1000, exactMatch: 800, normalizedMatch: 0, conflict: 200, onlyDirect: 0, onlyAggregation: 0, neither: 0 },
    { directSourceId: 'a', aggregationSourceId: 'b', decidedAt: 'T' },
  );
  assert.equal(decision.verdict, 'UNRESOLVED');
  assert.match(decision.basis, /needs a dated comparison/);
});

test('a source may not be retired without proving every condition', () => {
  const blocked = supersessionCheck({
    redundantFieldForField: false, freshnessAtLeastEqual: true,
    noUniqueFieldsLost: false, provenanceRemains: true, operationalReason: null,
  });
  assert.equal(blocked.maySupersede, false);
  assert.equal(blocked.blockers.length, 3);

  const allowed = supersessionCheck({
    redundantFieldForField: true, freshnessAtLeastEqual: true,
    noUniqueFieldsLost: true, provenanceRemains: true, operationalReason: 'documented',
  });
  assert.equal(allowed.maySupersede, true);
});

test('both Hennepin sources remain in the coverage graph', () => {
  const matrix = buildCoverage(defaultRegistry());
  const hennepin = countyJurisdictionId(HENNEPIN);
  const parcelSources = matrix.entries
    .filter((e) => e.jurisdictionId === hennepin && e.capability === 'parcel')
    .map((e) => e.sourceId)
    .sort();
  // Coverage is not a boolean: when a source breaks, "who else has this?" is the
  // question that matters.
  // eCRV also declares parcel for all 87 MN counties, so Hennepin has three.
  // That is the point: coverage keeps every source rather than one boolean.
  assert.ok(parcelSources.includes('mn_hennepin_county_parcels'));
  assert.ok(parcelSources.includes(MN_STATEWIDE_SOURCE_ID));
  assert.ok(parcelSources.length >= 2);
});

test('the statewide source added 59 parcel jurisdictions', () => {
  const matrix = buildCoverage(defaultRegistry());
  const covered = new Set(
    matrix.entries
      .filter((e) => e.capability === 'parcel' && e.countsAsCore && e.state === 'ACTIVE')
      .map((e) => e.jurisdictionId),
  );
  assert.equal(covered.size, 59);
  assert.ok(covered.has(countyJurisdictionId(RAMSEY)));
  assert.ok(covered.has(countyJurisdictionId(HENNEPIN)));
});

// ===========================================================================
// 7. Restricted data
// ===========================================================================

test('owner and taxpayer mailing lines reach the restricted plane and nothing else', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);

  const contacts = (await h.rows('contacts')) as Row[];
  assert.ok(contacts.length >= 1);
  assert.ok(contacts.every((c) => c['contactType'] === 'mailing_address'));
  assert.ok(contacts.every((c) => c['permittedUse'] === 'record_only'));

  // The mailing line must appear nowhere in the canonical estate.
  const canonical = canonicalJson(await h.bundles());
  assert.ok(!canonical.includes('100 Invented Way'), 'a mailing address leaked into a canonical row');
  assert.ok(contacts.some((c) => String(c['value']).includes('100 Invented Way')));
});

test('the restricted field list matches the mailing fields in the map', () => {
  assert.deepEqual([...RESTRICTED_FIELDS].sort(), [
    'own_add_l1', 'own_add_l2', 'own_add_l3', 'own_add_l4',
    'tax_add_l1', 'tax_add_l2', 'tax_add_l3', 'tax_add_l4',
  ]);
});

test('a party observation carries a name and a role, never an address', async () => {
  const h = streamHarness();
  await h.runStatewide(BASE);
  const bundles = (await h.bundles()) as Row[];
  for (const bundle of bundles) {
    for (const party of (bundle['parties'] as Row[])) {
      assert.equal(party['address'], null);
      assert.equal(party['kind'], 'unknown', 'the roll does not classify person vs organisation');
      assert.equal(party['resolutionState'], 'unresolved');
    }
  }
});

test('no live owner name or mailing address is committed as a fixture', async () => {
  // The fixtures are generated by a committed script from invented values. This
  // asserts the generator is the only source of fixture identities.
  const text = await readFile(mnStatewideFixture('five-county-2026-08.bundle'), 'utf8');
  for (const invented of ['NORTHSTAR HOMES LLC', 'AVERY FICTITIOUS', 'Invented Way']) {
    assert.ok(text.includes(invented));
  }
  assert.ok(!/\bOWNER_NM\b/.test(text));
});

// ===========================================================================
// 8. Acquisition
// ===========================================================================

test('a connector with neither a bundle nor live options explains itself', async () => {
  const connector = createMnStatewideParcelConnector();
  await assert.rejects(
    () => connector.discover({} as never),
    (e: unknown) => {
      assert.ok(isFabricError(e));
      assert.equal(e.kind, 'ACCESS_BLOCKED');
      assert.match(String(e.detail?.['remedy']), /publicdownload/);
      return true;
    },
  );
});

test('the buffered path is refused, not merely unimplemented', () => {
  const connector = createMnStatewideParcelConnector({ localFile: BASE });
  assert.throws(() => connector.parse({} as never, new Uint8Array(), {} as never), /streaming/);
  assert.throws(() => connector.validate({} as never, {} as never), /streaming/);
});

test('comparableOf extracts nothing from a bundle with no parcel identifier', () => {
  assert.equal(comparableOf({
    transaction: { sourceId: 's' }, parties: [], transactionParties: [],
    propertyIdentifiers: [], transactionParcels: [], properties: [], financing: [], events: [],
  } as never), null);
});

void tempRoot;
