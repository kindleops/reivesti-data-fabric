/**
 * The zero-cost doctrine, the national jurisdiction registry, the coverage
 * matrix and source discovery.
 *
 * The load-bearing claim is the one in §6 of the brief: **remove every paid
 * source and the core Fabric still works.** Everything else here supports that —
 * the gate that stops a paid source becoming core, the role model that stops it
 * becoming a hidden dependency, and the coverage report that refuses to count it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/core/hash.ts';
import {
  ACTIVE_COUNTY_EQUIVALENTS,
  GEOGRAPHY_PROVENANCE,
  US_COUNTY_EQUIVALENTS,
  countyEquivalent,
} from '../src/registry/us-geography.ts';
import { JURISDICTIONS, countyJurisdictionId, getJurisdiction } from '../src/registry/jurisdictions.ts';
import { createRegistry } from '../src/registry/registry.ts';
import { MAPPINGS, SOURCES, defaultRegistry } from '../src/registry/sources.ts';
import { assessActivation, isCoreActivatable, isPaidSource } from '../src/registry/policy.ts';
import { ZERO_COST_CLASSES, isZeroCost, type CostClass, type SourceDefinition } from '../src/registry/types.ts';
import {
  buildCoverage,
  coverageGaps,
  nationalCoverageReport,
  TRACKED_CAPABILITIES,
} from '../src/registry/coverage.ts';
import { checkPromotion, rankCandidates, type SourceCandidate } from '../src/discovery/candidates.ts';
import { LEGAL_CAPABILITY_LIMITS, PLATFORM_FAMILIES, SOURCE_CANDIDATES } from '../src/discovery/catalogue.ts';
import { candidateJurisdictionCount, rankCatalogue, rankingInputFor } from '../src/discovery/rank.ts';

const AT = '2026-08-31';

function source(over: Partial<SourceDefinition> = {}): SourceDefinition {
  return {
    sourceId: 'probe', sourceAuthority: 'A', sourceProgram: 'P', sourceFamily: 'F',
    sourceName: 'N', sourceHomepage: 'https://example.gov', accessType: 'api',
    automationStatus: 'sanctioned', termsStatus: 'reviewed_permitted', licenseStatus: 'public_domain',
    costModel: 'free', historicalDepth: null, expectedRefreshFrequency: 'monthly',
    sourcePriority: 1, active: true, carriesRestrictedContact: false,
    costClass: 'FREE_API', acquisitionClass: 'AUTOMATED_API', role: 'CORE_CANONICAL_SOURCE', notes: '',
    ...over,
  };
}

// ===========================================================================
// 1. Zero-cost policy
// ===========================================================================

for (const costClass of ['FREE_BULK', 'FREE_API', 'FREE_OPEN_DATA', 'FREE_WEB_SERVICE',
  'FREE_PUBLIC_DOWNLOAD', 'FIRST_PARTY'] as CostClass[]) {
  test(`${costClass} with an automated acquisition path and reviewed terms is core eligible`, () => {
    const assessment = assessActivation(source({ costClass }));
    assert.equal(assessment.verdict, 'CORE_ELIGIBLE');
    assert.equal(assessment.zeroCost, true);
    assert.equal(assessment.remedy, null);
  });
}

// FREE_MANUAL_DELIVERY is zero-cost and still not core: the cost gate and the
// acquisition gate ask different questions, and free has never implied fetchable.
test('FREE_MANUAL_DELIVERY is zero-cost but never core eligible', () => {
  const assessment = assessActivation(source({ costClass: 'FREE_MANUAL_DELIVERY' }));
  assert.equal(assessment.zeroCost, true);
  assert.equal(assessment.verdict, 'BLOCKED_MANUAL_ACQUISITION');
  assert.equal(assessment.gate, 'acquisition');
});

test('FREE_DATA_REQUEST is core eligible once delivery is granted AND automatable', () => {
  const pending = source({
    costClass: 'FREE_DATA_REQUEST', automationStatus: 'manual_only',
    acquisitionClass: 'AUTOMATED_BULK_DOWNLOAD',
  });
  assert.equal(assessActivation(pending, { accessRequestState: 'NOT_REQUESTED' }).verdict, 'BLOCKED_ACCESS');
  assert.equal(assessActivation(pending, { accessRequestState: 'AWAITING_RESPONSE' }).verdict, 'BLOCKED_ACCESS');
  assert.equal(assessActivation(pending, { accessRequestState: 'DELIVERED' }).verdict, 'CORE_ELIGIBLE');
  assert.equal(assessActivation(pending, { accessRequestState: 'APPROVED' }).verdict, 'CORE_ELIGIBLE');

  // Approval alone is not enough. If what the approval grants is a file a person
  // collects, the source is still not something a scheduler can run.
  const byHand = source({ costClass: 'FREE_DATA_REQUEST', acquisitionClass: 'MANUAL_ONLY' });
  assert.equal(assessActivation(byHand, { accessRequestState: 'APPROVED' }).verdict, 'BLOCKED_MANUAL_ACQUISITION');
});

for (const costClass of ['PAID_OPTIONAL', 'PAID_SUBSCRIPTION', 'PAID_PER_RECORD'] as CostClass[]) {
  test(`${costClass} is refused for core activation however good the source is`, () => {
    const assessment = assessActivation(source({ costClass, role: 'CORE_CANONICAL_SOURCE' }));
    assert.equal(assessment.verdict, 'OPTIONAL_PAID');
    assert.equal(assessment.gate, 'cost');
    assert.match(assessment.reason, /does not pay for core data/);
    assert.equal(isCoreActivatable(source({ costClass })), false);
  });
}

test('UNKNOWN_COST is refused: unknown is not free', () => {
  const assessment = assessActivation(source({ costClass: 'UNKNOWN_COST' }));
  assert.equal(assessment.verdict, 'BLOCKED_COST_UNKNOWN');
  assert.match(assessment.remedy ?? '', /fee schedule/);
});

test('a source with no declared cost is treated as unknown, never as free', () => {
  const undeclared = source();
  delete (undeclared as { costClass?: CostClass }).costClass;
  assert.equal(assessActivation(undeclared).verdict, 'BLOCKED_COST_UNKNOWN');
});

test('free plus prohibited automation is refused', () => {
  const assessment = assessActivation(source({ costClass: 'FREE_BULK', automationStatus: 'prohibited' }));
  assert.equal(assessment.verdict, 'BLOCKED_AUTOMATION');
  assert.equal(assessment.gate, 'automation');
});

test('free plus unreviewed terms is refused', () => {
  assert.equal(assessActivation(source({ termsStatus: 'not_reviewed' })).verdict, 'BLOCKED_TERMS');
});

test('free plus unpinned schema or unreproducible provenance is refused', () => {
  assert.equal(assessActivation(source(), { schemaPinned: false }).verdict, 'BLOCKED_SCHEMA');
  assert.equal(assessActivation(source(), { provenanceReproducible: false }).verdict, 'BLOCKED_PROVENANCE');
});

test('a fee quote on a free request moves the source out of zero-cost eligibility', () => {
  const quoted = assessActivation(
    source({ costClass: 'FREE_DATA_REQUEST', automationStatus: 'manual_only' }),
    { accessRequestState: 'FEE_QUOTED' },
  );
  assert.equal(quoted.verdict, 'OPTIONAL_PAID');
  assert.match(quoted.reason, /fee quote/);
  assert.match(quoted.remedy ?? '', /keep looking for a free path/);
});

test('a denied request is an access block, not a cost block', () => {
  const denied = assessActivation(source({ costClass: 'FREE_DATA_REQUEST' }), { accessRequestState: 'DENIED' });
  assert.equal(denied.verdict, 'BLOCKED_ACCESS');
  assert.match(denied.remedy ?? '', /different authority/);
});

test('a source declared as enrichment is not competing for core status', () => {
  assert.equal(assessActivation(source({ role: 'OPTIONAL_ENRICHMENT', costClass: 'PAID_OPTIONAL' })).verdict, 'OPTIONAL_PAID');
  assert.equal(assessActivation(source({ role: 'DEFERRED' })).verdict, 'DEFERRED');
  assert.equal(assessActivation(source({ role: 'REJECTED' })).verdict, 'DEFERRED');
  assert.equal(isCoreActivatable(source({ role: 'VALIDATION_ONLY' })), false);
});

test('the zero-cost family list is the single definition of the doctrine', () => {
  assert.equal(ZERO_COST_CLASSES.size, 8);
  for (const c of ZERO_COST_CLASSES) assert.equal(isZeroCost(c), true);
  for (const c of ['PAID_OPTIONAL', 'PAID_SUBSCRIPTION', 'PAID_PER_RECORD', 'UNKNOWN_COST'] as CostClass[]) {
    assert.equal(isZeroCost(c), false);
  }
});

test('activation is deterministic and total', () => {
  const s = source({ costClass: 'FREE_BULK' });
  assert.equal(canonicalJson(assessActivation(s)), canonicalJson(assessActivation(s)));
});

// ===========================================================================
// 2. Paid sources are not a dependency
// ===========================================================================

test('removing every paid source leaves the core registry operable', () => {
  const full = defaultRegistry();
  const paid = full.sources.filter(isPaidSource);
  assert.ok(paid.length >= 1, 'the estate must actually contain a paid source for this to prove anything');
  assert.deepEqual(paid.map((s) => s.sourceId), ['mn_sos_business_entities']);

  const paidIds = new Set(paid.map((s) => s.sourceId));
  const freeOnly = createRegistry(
    SOURCES.filter((s) => !paidIds.has(s.sourceId)),
    MAPPINGS.filter((m) => !paidIds.has(m.sourceId)),
  );

  // The registry still builds, still expands, and still answers coverage.
  assert.ok(freeOnly.sources.length >= 4);
  assert.equal(freeOnly.expand(freeOnly.mapping('mn_ecrv__all_mn_counties')).length, 87);
  assert.equal(freeOnly.expand(freeOnly.mapping('hennepin_assessor__hennepin')).length, 1);

  const matrix = buildCoverage(freeOnly);
  const hennepin = countyJurisdictionId('27053');
  assert.equal(matrix.coreStateOf(hennepin, 'parcel'), 'ACTIVE');
  assert.ok(matrix.entries.length > 0);
});

test('no paid source is authoritative for parcel identity or any canonical key', () => {
  for (const s of defaultRegistry().sources.filter(isPaidSource)) {
    assert.notEqual(s.authoritativeForParcelIdentity, true);
    assert.notEqual(s.role, 'CORE_CANONICAL_SOURCE');
    assert.notEqual(s.role, 'CORE_SUPPORTING_SOURCE');
  }
});

test('a paid source can never satisfy core coverage, however well it covers a place', () => {
  const matrix = buildCoverage(defaultRegistry());
  const sosEntries = matrix.entries.filter((e) => e.sourceId === 'mn_sos_business_entities');
  assert.ok(sosEntries.length > 0, 'the paid source must be visible in the matrix');
  assert.ok(sosEntries.every((e) => e.countsAsCore === false));
  // Minnesota therefore has NO core business-entity coverage, and says so.
  assert.notEqual(matrix.coreStateOf(countyJurisdictionId('27053'), 'business_entity'), 'ACTIVE');
});

test('the paid SOS connector remains implemented and inactive, not deleted', () => {
  const sos = defaultRegistry().source('mn_sos_business_entities');
  assert.equal(sos.costClass, 'PAID_OPTIONAL');
  assert.equal(sos.role, 'DEFERRED');
  assert.equal(assessActivation(sos).verdict, 'DEFERRED');
  // The mapping and adapter still exist; nothing was thrown away.
  assert.equal(defaultRegistry().mapping('mn_sos__statewide').adapterKey, 'mn_sos_business');
});

// ===========================================================================
// 3. National jurisdiction registry
// ===========================================================================

test('every county-equivalent loads from a pinned authoritative federal file', () => {
  assert.match(GEOGRAPHY_PROVENANCE.current.sha256, /^[0-9a-f]{64}$/);
  assert.match(GEOGRAPHY_PROVENANCE.legacy.sha256, /^[0-9a-f]{64}$/);
  assert.equal(GEOGRAPHY_PROVENANCE.current.authority, 'U.S. Census Bureau');
  assert.ok(US_COUNTY_EQUIVALENTS.length > 3000);
  assert.ok(ACTIVE_COUNTY_EQUIVALENTS.length > 3000);
});

test('combined FIPS is unique across the whole catalogue', () => {
  const fips = US_COUNTY_EQUIVALENTS.map((c) => c.fips);
  assert.equal(new Set(fips).size, fips.length);
  for (const f of fips) assert.match(f, /^\d{5}$/);
});

test('every county names a catalogued state, and the state relationship holds', () => {
  const states = new Set(JURISDICTIONS.filter((j) => j.jurisdictionType === 'state').map((j) => j.jurisdictionId));
  for (const j of JURISDICTIONS.filter((x) => x.jurisdictionType === 'county')) {
    assert.ok(states.has(j.parentId as string), `${j.jurisdictionId} has no state`);
    assert.equal(j.countyFips?.slice(0, 2), j.stateFips);
  }
});

test('retired Connecticut counties are retained and NOT mapped to planning regions', () => {
  const replaced = US_COUNTY_EQUIVALENTS.filter((c) => c.status === 'replaced');
  assert.equal(replaced.length, 8);
  assert.ok(replaced.every((c) => c.stateCode === 'CT'));
  for (const c of replaced) {
    // No crosswalk exists, so none is invented. A deed recorded in New Haven
    // County was recorded there.
    assert.deepEqual(c.replacedBy, []);
    assert.match(c.note ?? '', /no one-to-one crosswalk/i);
  }
  const newHaven = countyEquivalent('09009');
  assert.equal(newHaven?.name, 'New Haven County');
  assert.equal(newHaven?.status, 'replaced');
});

test('Connecticut planning regions are active county-equivalents in their own right', () => {
  const regions = ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateCode === 'CT');
  assert.equal(regions.length, 9);
  assert.ok(regions.every((c) => c.type === 'planning_region'));
});

test('island-area geographies are SOURCE_LEGACY, not asserted retired', () => {
  const legacy = US_COUNTY_EQUIVALENTS.filter((c) => c.status === 'source_legacy');
  assert.ok(legacy.length > 0);
  // Absent from a product's scope is not evidence of ceasing to exist.
  for (const c of legacy) assert.match(c.note ?? '', /Not evidence that the geography ceased to exist/);
});

test('distinct legal forms are not flattened into "county"', () => {
  const types = new Set(US_COUNTY_EQUIVALENTS.map((c) => c.type));
  for (const expected of ['parish', 'borough', 'census_area', 'independent_city', 'planning_region', 'municipio', 'federal_district']) {
    assert.ok(types.has(expected as never), `${expected} was flattened away`);
  }
  assert.equal(countyEquivalent('22071')?.type, 'parish', 'Orleans Parish is not a county');
  assert.equal(countyEquivalent('11001')?.type, 'federal_district');
});

test('the same county name in different states is two distinct jurisdictions', () => {
  const named = US_COUNTY_EQUIVALENTS.filter((c) => c.name === 'Washington County' && c.status === 'active');
  assert.ok(named.length > 20, 'Washington County exists in most states');
  assert.equal(new Set(named.map((c) => c.fips)).size, named.length);
  assert.equal(new Set(named.map((c) => c.stateCode)).size, named.length);
});

test('a county jurisdiction id resolves and carries its legal form', () => {
  const orleans = getJurisdiction(countyJurisdictionId('22071'));
  assert.equal(orleans?.countyEquivalentType, 'parish');
  assert.equal(orleans?.countyName, 'Orleans');
  assert.match(orleans?.name ?? '', /Orleans Parish, Louisiana/);
});

// ===========================================================================
// 4. Coverage
// ===========================================================================

test('one statewide source covers every county in the state without duplicate definitions', () => {
  const registry = defaultRegistry();
  const matrix = buildCoverage(registry);
  const ecrv = matrix.entries.filter((e) => e.sourceId === 'mn_dor_ecrv_weekly_sales_extract' && e.capability === 'transfer');
  assert.equal(ecrv.length, 87);
  assert.equal(new Set(ecrv.map((e) => e.sourceId)).size, 1);
  assert.equal(registry.sources.filter((s) => s.sourceId.startsWith('mn_dor_ecrv')).length, 1);
});

test('a single-county source covers exactly one county', () => {
  const matrix = buildCoverage(defaultRegistry());
  const hennepin = matrix.entries.filter((e) => e.sourceId === 'mn_hennepin_county_parcels' && e.capability === 'parcel');
  assert.deepEqual(hennepin.map((e) => e.jurisdictionId), [countyJurisdictionId('27053')]);
});

test('coverage is capability-specific, not per-source blanket', () => {
  const matrix = buildCoverage(defaultRegistry());
  const hennepin = countyJurisdictionId('27053');
  assert.equal(matrix.coreStateOf(hennepin, 'parcel'), 'ACTIVE');
  // The assessor feed deliberately does not declare deeds; the county runs other
  // systems for those and this is not them.
  assert.notEqual(matrix.coreStateOf(hennepin, 'deed'), 'ACTIVE');
});

test('unknown is reported as UNVERIFIED, never as UNAVAILABLE', () => {
  const matrix = buildCoverage(defaultRegistry());
  // Nobody has researched Wyoming. That is not the same as Wyoming having nothing.
  assert.equal(matrix.coreStateOf(countyJurisdictionId('56001'), 'parcel'), 'UNVERIFIED');
  const gaps = coverageGaps(defaultRegistry(), matrix, ['parcel']);
  assert.ok((gaps[0]?.uncoveredJurisdictions ?? 0) > 3000);
});

test('the national report counts jurisdictions with a verified core source, not candidates', () => {
  const registry = defaultRegistry();
  const report = nationalCoverageReport(registry, buildCoverage(registry), AT);
  assert.equal(report.activeJurisdictions, ACTIVE_COUNTY_EQUIVALENTS.length);
  // DF-0H activated the statewide parcel aggregation: 59 Minnesota counties,
  // plus Hennepin from its own direct source — the same county, so 59 distinct.
  //
  // DF-0J briefly counted Wisconsin RETR across all 72 Wisconsin counties. DF-0J.1A
  // took them back. RETR is free, lawful, public and genuinely good data, and the
  // only way to obtain it is for a person to work a fifteen-minute session in a
  // tax portal. Counting those 72 said Reivesti could answer a question about a
  // Wisconsin transfer, and Reivesti could not; a number that flatters us is worse
  // than a smaller one that is true, because only the smaller one gets fixed.
  //
  // DF-0K adds 72 back — honestly this time: the Wisconsin Statewide Parcel Map
  // is an archive at a stable URL that a scheduler retrieves with nobody
  // present. Parcel, not transfer: 59 + 72 = 131. DF-0N adds New York's 62 from
  // the statewide centroid archive, also retrieved unattended: 193.
  assert.equal(report.jurisdictionsWithCoreSource, 193);
  assert.equal(report.sources.paidOptional, 1);
  assert.ok(report.byCapability.length === TRACKED_CAPABILITIES.length);

  const parcel = report.byCapability.find((c) => c.capability === 'parcel');
  assert.equal(parcel?.covered, 193);
  // Zero transfer coverage, nationally. Both statewide transfer sources are real,
  // free and parsed, and neither can be fetched: Wisconsin RETR needs a human in a
  // portal, Minnesota eCRV needs a request nobody has sent. This is the estate's
  // largest open gap and the report is required to keep saying so.
  const transfer = report.byCapability.find((c) => c.capability === 'transfer');
  assert.equal(transfer?.covered, 0, 'RETR needs a human; eCRV needs a request');
});

test('coverage gaps name the states where leverage is', () => {
  const registry = defaultRegistry();
  const gaps = coverageGaps(registry, buildCoverage(registry), ['parcel'], 3);
  const worst = gaps[0]?.worstStates ?? [];
  assert.equal(worst.length, 3);
  // Texas has the most county-equivalents of any state, so it leads the gap list.
  assert.equal(worst[0]?.stateCode, 'TX');
  assert.equal(worst[0]?.uncovered, ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateCode === 'TX').length);
});

// ===========================================================================
// 5. Discovery
// ===========================================================================

test('a candidate cannot be promoted before it is verified', () => {
  const unverified = SOURCE_CANDIDATES.find((c) => c.verification === 'UNVERIFIED') as SourceCandidate;
  assert.ok(unverified);
  const check = checkPromotion(unverified);
  assert.equal(check.ready, false);
  assert.ok(check.missing.some((m) => /verification is UNVERIFIED/.test(m)));
});

test('promotion requires official evidence for cost, automation, terms and coverage', () => {
  const bare: SourceCandidate = {
    ...(SOURCE_CANDIDATES[0] as SourceCandidate),
    verification: 'VERIFIED',
    evidence: [{ claim: 'cost', url: 'https://blog.example', quote: 'it is free', retrievedAt: AT, kind: 'secondary' }],
  };
  const check = checkPromotion(bare);
  assert.equal(check.ready, false);
  assert.ok(check.missing.some((m) => /"cost" rests only on secondary evidence/.test(m)));
  assert.ok(check.missing.some((m) => /no evidence recorded for "terms"/.test(m)));
});

test('the verified free statewide parcel candidate is promotable', () => {
  const mn = SOURCE_CANDIDATES.find((c) => c.sourceName.startsWith('Parcels, Compiled')) as SourceCandidate;
  assert.equal(mn.verification, 'VERIFIED_LIVE');
  assert.equal(checkPromotion(mn).ready, true);
});

test('every candidate assertion carries evidence with a URL and a quote', () => {
  for (const c of SOURCE_CANDIDATES) {
    for (const e of c.evidence) {
      assert.match(e.url, /^https?:\/\//, `${c.sourceName}: evidence without a URL`);
      assert.ok(e.quote.length > 20, `${c.sourceName}: evidence without a real quote`);
      assert.match(e.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('ranking is deterministic and its components are exposed', () => {
  const a = rankCatalogue();
  const b = rankCatalogue();
  assert.equal(canonicalJson(a), canonicalJson(b));
  for (const r of a) {
    assert.ok(Object.keys(r.components).length >= 9, 'the score must be decomposable');
  }
});

test('zero cost is a hard gate in ranking, not a heavy weight', () => {
  const paid: SourceCandidate = { ...(SOURCE_CANDIDATES[0] as SourceCandidate), costHypothesis: 'PAID_SUBSCRIPTION' };
  const [ranked] = rankCandidates([rankingInputFor(paid)]);
  assert.equal(ranked?.score, 0);
  assert.match(ranked?.excluded ?? '', /does not pay for core data/);
  // And an excluded candidate can never outrank an included one, whatever its
  // other qualities.
  assert.ok(rankCatalogue().filter((r) => r.excluded === null).every((r) => r.score > 0));
});

test('an unpriced candidate is excluded too: unknown is not free', () => {
  const tx = SOURCE_CANDIDATES.find((c) => c.costHypothesis === 'UNKNOWN_COST') as SourceCandidate;
  const [ranked] = rankCandidates([rankingInputFor(tx)]);
  assert.equal(ranked?.score, 0);
  assert.match(ranked?.excluded ?? '', /unknown is not free/);
});

test('jurisdiction leverage moves the ranking', () => {
  const statewide = SOURCE_CANDIDATES.find((c) => c.sourceName.startsWith('Parcels, Compiled')) as SourceCandidate;
  const oneCounty = SOURCE_CANDIDATES.find((c) => c.sourceName.startsWith('Notice of Foreclosure')) as SourceCandidate;
  assert.ok(candidateJurisdictionCount(statewide) > 80);
  assert.equal(candidateJurisdictionCount(oneCounty), 1);
  const ranked = rankCatalogue();
  const s = ranked.find((r) => r.candidateId === statewide.candidateId);
  const o = ranked.find((r) => r.candidateId === oneCounty.candidateId);
  assert.ok((s?.components.jurisdictionLeverage ?? 0) > (o?.components.jurisdictionLeverage ?? 1));
  assert.ok((s?.score ?? 0) > (o?.score ?? 0));
});

test('a shared platform is modelled separately from the sources on it', () => {
  const arcgis = PLATFORM_FAMILIES.find((p) => p.platformId === 'arcgis_feature_service');
  assert.ok(arcgis);
  assert.equal(arcgis.connectorReusable, true);
  // The caveat that stops "same vendor" being read as "same schema".
  assert.match(arcgis.reuseBoundary, /FIELD NAMES AND SEMANTICS ARE NOT/);
  const users = SOURCE_CANDIDATES.filter((c) => c.platformId === 'arcgis_feature_service');
  assert.ok(users.length >= 2, 'a platform exists to be shared');
  assert.equal(new Set(users.map((c) => c.sourceName)).size, users.length);
});

test('a legal ceiling is recorded as a legal ceiling, not as a cost blocker', () => {
  const texas = LEGAL_CAPABILITY_LIMITS.find((l) => l.stateCodes.includes('TX'));
  assert.ok(texas);
  assert.match(texas.basis, /22\.27/);
  assert.ok(texas.capabilities.includes('transfer'));
  // The distinction matters: "keep looking" is the answer to a paid source, and
  // "stop" is the answer to a record that legally does not exist.
  assert.match(texas.quote, /non-disclosure/i);
});

test('candidate ids are unique and derived from authority plus name', () => {
  const ids = SOURCE_CANDIDATES.map((c) => c.candidateId);
  assert.equal(new Set(ids).size, ids.length);
});

// ===========================================================================
// 6. Security: discovery metadata is not permission
// ===========================================================================

test('deferring the paid source does not relax its raw-data protections', () => {
  const sos = defaultRegistry().source('mn_sos_business_entities');
  // Deferred does not mean declassified. The licence still binds the bytes, the
  // restricted plane still holds the party addresses, and the licence terms are
  // still recorded on the source.
  assert.equal(sos.carriesRestrictedContact, true);
  assert.equal(sos.licenseStatus, 'licensed');
  assert.ok(sos.licenseTerms);
  assert.equal(sos.licenseTerms.prohibitsBulkRedistribution, true);
});

test('a source candidate carries no data and no access, only claims about them', () => {
  for (const c of SOURCE_CANDIDATES) {
    const keys = Object.keys(c);
    // Knowing a source exists is not permission to fetch it. A candidate has no
    // credentials, no transport and no adapter — the fields the runtime would
    // need to reach a publisher simply are not on the type.
    for (const forbidden of ['credentials', 'apiKey', 'token', 'adapterKey', 'transport']) {
      assert.ok(!keys.includes(forbidden), `a candidate must not carry ${forbidden}`);
    }
  }
});

test('every source that carries personal data still says so after reclassification', () => {
  const registry = defaultRegistry();
  for (const id of ['mn_dor_ecrv_weekly_sales_extract', 'mn_hennepin_county_parcels',
    'mn_hennepin_recorded_instruments', 'mn_sos_business_entities']) {
    assert.equal(registry.source(id).carriesRestrictedContact, true, `${id} lost its restricted flag`);
  }
});

test('a source may not be declared core before its cost is known', () => {
  // Mirrors the sources_core_role_is_zero_cost constraint in migration 0007, so
  // the rule holds whether a row is built in TypeScript or inserted by hand.
  assert.throws(
    () => createRegistry([source({ costClass: 'UNKNOWN_COST', role: 'CORE_CANONICAL_SOURCE' })], []),
    /declared CORE_CANONICAL_SOURCE/,
  );
  assert.throws(
    () => createRegistry([source({ costClass: 'PAID_SUBSCRIPTION', role: 'CORE_SUPPORTING_SOURCE' })], []),
    /declared CORE_SUPPORTING_SOURCE/,
  );
});
