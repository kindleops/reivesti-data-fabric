import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import {
  JURISDICTIONS,
  countyJurisdictionId,
  getJurisdiction,
  mnCountyByCode,
  mnCounties,
  stateJurisdictionId,
} from '../src/registry/jurisdictions.ts';
import { MN_COUNTIES } from '../src/registry/mn-counties.ts';
import { createRegistry, expandScope } from '../src/registry/registry.ts';
import {
  DALLAS_MAPPING_AWAITING_JURISDICTIONS,
  MN_ECRV_SOURCE_ID,
  SOURCES,
  defaultRegistry,
} from '../src/registry/sources.ts';

test('all 87 Minnesota counties are catalogued with correct FIPS', () => {
  assert.equal(MN_COUNTIES.length, 87);
  const spot: readonly (readonly [string, string, string])[] = [
    ['01', '001', 'Aitkin'],
    ['27', '053', 'Hennepin'],
    ['62', '123', 'Ramsey'],
    ['69', '137', 'St. Louis'],
    ['87', '173', 'Yellow Medicine'],
  ];
  for (const [code, fips3, name] of spot) {
    const county = mnCountyByCode(code);
    assert.ok(county, `county ${code} missing`);
    assert.equal(county.countyFips, `27${fips3}`);
    assert.equal(county.countyName, name);
  }
});

test('the eCRV county code / FIPS relationship holds for every county', () => {
  // The state assigns county codes on the same alphabetical ordering as FIPS,
  // so fips = 2 * code - 1. Asserting it catches a corrupted table.
  for (const [code, fips3] of MN_COUNTIES) {
    assert.equal(Number(fips3), 2 * Number(code) - 1, `county code ${code}`);
  }
  assert.equal(new Set(mnCounties().map((c) => c.countyFips)).size, 87);
});

test('unpadded and padded county codes resolve to the same county', () => {
  assert.equal(mnCountyByCode('7')?.countyFips, mnCountyByCode('07')?.countyFips);
  assert.equal(mnCountyByCode('88'), undefined);
});

test('jurisdiction catalogue covers the nation, every state and Minnesota counties', () => {
  assert.ok(getJurisdiction('us'));
  assert.equal(JURISDICTIONS.filter((j) => j.jurisdictionType === 'state').length, 51);
  assert.equal(JURISDICTIONS.filter((j) => j.jurisdictionType === 'county').length, 87);
  const hennepin = getJurisdiction(countyJurisdictionId('27053'));
  assert.equal(hennepin?.parentId, stateJurisdictionId('MN'));
  assert.equal(hennepin?.stateFips, '27');
});

// --- one source, many jurisdictions ------------------------------------------

test('a statewide source expands to every county in the state from one mapping row', () => {
  const registry = defaultRegistry();
  const mapping = registry.mapping('mn_ecrv__all_mn_counties');
  const covered = registry.expand(mapping);
  assert.equal(covered.length, 87);
  assert.ok(covered.every((j) => j.jurisdictionType === 'county' && j.stateCode === 'MN'));
});

test('a single-county source expands to exactly that county', () => {
  const registry = defaultRegistry();
  const covered = registry.expand(registry.mapping('hennepin_assessor__hennepin'));
  assert.deepEqual(covered.map((j) => j.countyFips), ['27053']);
});

test('scopes support nation, state list, all-counties and explicit counties', () => {
  const nation = expandScope({ kind: 'nation', country: 'US' }, JURISDICTIONS, 't');
  assert.equal(nation.length, 1);
  const twoStates = expandScope({ kind: 'states', stateCodes: ['MN', 'TX'] }, JURISDICTIONS, 't');
  assert.deepEqual(twoStates.map((j) => j.stateCode), ['MN', 'TX']);
  const explicit = expandScope({ kind: 'counties', countyFips: ['27053', '27123'] }, JURISDICTIONS, 't');
  assert.equal(explicit.length, 2);
});

test('a scope naming uncatalogued jurisdictions fails loudly rather than covering nothing', () => {
  // Texas counties are not catalogued yet. Silently expanding to zero counties
  // would look like a working mapping that ingests nothing.
  assert.throws(
    () => expandScope(DALLAS_MAPPING_AWAITING_JURISDICTIONS.scope, JURISDICTIONS, 'dallas'),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
  assert.throws(
    () => expandScope({ kind: 'all_counties_in_states', stateCodes: ['TX'] }, JURISDICTIONS, 'tx'),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
});

// --- registry integrity -------------------------------------------------------

test('capability lookup finds the eCRV source for any Minnesota county', () => {
  const registry = defaultRegistry();
  for (const fips of ['27053', '27003', '27173']) {
    const sources = registry.sourcesFor(countyJurisdictionId(fips), 'transfer');
    assert.ok(sources.some((s) => s.sourceId === MN_ECRV_SOURCE_ID), fips);
  }
  assert.equal(registry.sourcesFor(countyJurisdictionId('27053'), 'court_event').length, 0);
});

test('registry rejects duplicate source ids and dangling mapping references', () => {
  const one = SOURCES[0];
  assert.ok(one);
  assert.throws(() => createRegistry([one, one], []), (e: unknown) => isFabricError(e, 'CONFIG'));
  assert.throws(
    () => createRegistry([one], [{
      mappingId: 'x', sourceId: 'nope', scope: { kind: 'nation', country: 'US' },
      capabilities: ['parcel'], coverageStart: null, coverageEnd: null,
      status: 'planned', adapterKey: 'x', config: {},
    }]),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
});

test('the eCRV source records restricted contact and unsanctioned automation', () => {
  const source = defaultRegistry().source(MN_ECRV_SOURCE_ID);
  // Both of these gate real behaviour: the first routes PII to the restricted
  // plane, the second stops the runtime touching the publisher.
  assert.equal(source.carriesRestrictedContact, true);
  assert.notEqual(source.automationStatus, 'sanctioned');
});

test('future connectors are modelled in the registry without being implemented', () => {
  const registry = defaultRegistry();
  const planned = registry.mappings.filter((m) => m.status === 'planned').map((m) => m.adapterKey);
  // The Hennepin assessor left this list in DF-0C and the Hennepin recorder in
  // DF-0E: both have adapters now. What remains is registry entries only, and
  // the runtime refuses to run them.
  for (const key of ['mn_sos_entities']) {
    assert.ok(planned.includes(key), `${key} should be modelled as planned`);
  }
  for (const implemented of ['mn_hennepin_assessor', 'mn_hennepin_recorder']) {
    assert.ok(!planned.includes(implemented), `${implemented} is implemented and should no longer be planned`);
  }
});
