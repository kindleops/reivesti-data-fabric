/**
 * DF-0Q: national source intelligence for recorded transactions.
 *
 *   audit       merged-main coverage per dashboard capability, computed, so the
 *               DF-0Q report cannot drift from the registry it describes
 *   semantics   what one record means; a sale echo or a declaration can never
 *               claim a deed; the registry's own overclaims are reported
 *   leads       DF-0Q candidates are UNVERIFIED, evidence-free and unpromotable
 *   priority    a separate transaction score; eligibility is a gate, not a weight;
 *               the general ranking's scores are untouched by the new fields
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { canonicalJson } from '../src/core/hash.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { isZeroCost } from '../src/registry/types.ts';
import { DASHBOARD_CAPABILITIES, automatedCoreJurisdictions } from '../src/registry/lifecycle.ts';
import { checkPromotion, rankCandidate, type SourceCandidate } from '../src/discovery/candidates.ts';
import { LEGAL_CAPABILITY_LIMITS, SOURCE_CANDIDATES } from '../src/discovery/catalogue.ts';
import { NATIONAL_PLATFORM_FAMILIES, NATIONAL_TRANSACTION_CANDIDATES } from '../src/discovery/national-catalogue.ts';
import { candidateJurisdictionCount, rankCatalogue, rankingInputFor } from '../src/discovery/rank.ts';
import {
  REGISTERED_SOURCE_SEMANTICS,
  TRANSACTION_CAPABILITIES,
  TRANSACTION_SEMANTICS,
  TRANSACTION_SEMANTIC_CLASSES,
  registrySemanticFindings,
  semanticOverclaims,
} from '../src/discovery/transaction-semantics.ts';
import { TRANSACTION_WEIGHTS, rankTransactionCandidates, transactionPriority } from '../src/discovery/transaction-priority.ts';
import { tempRoot } from './helpers.ts';

const registry = defaultRegistry();
const ALL = [...SOURCE_CANDIDATES, ...NATIONAL_TRANSACTION_CANDIDATES];
const byName = (fragment: string): SourceCandidate => {
  const found = ALL.find((c) => c.sourceName.includes(fragment));
  assert.ok(found, fragment);
  return found;
};

/** A fully evidenced, free, sanctioned, automated candidate to vary one fact at a time. */
function verified(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  const evidence = ['cost', 'automation', 'terms', 'coverage'].map((claim) => ({
    claim, url: 'https://example.gov/terms', quote: `official statement about ${claim} for this test`,
    retrievedAt: '2026-10-19', kind: 'official_authority' as const,
  }));
  return {
    candidateId: 'test-candidate',
    authority: 'Example County Recorder',
    sourceName: 'Example recorded document index',
    scope: { kind: 'states', stateCodes: ['NJ'] },
    capabilities: ['deed', 'mortgage'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://example.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_API',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_API',
    licenseHypothesis: 'public_domain',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: false,
    historicalDepth: '2000-01-01',
    cadence: 'daily',
    platformId: null,
    verification: 'VERIFIED',
    lastResearchedAt: '2026-10-19',
    evidence,
    notes: 'test fixture',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The coverage audit, computed
// ---------------------------------------------------------------------------

test('audit: merged-main automated-core coverage per capability is what the DF-0Q report states', () => {
  const expected: Record<(typeof DASHBOARD_CAPABILITIES)[number], number> = {
    PARCEL: 260, ASSESSOR: 260, OWNERSHIP_CURRENT: 260, TAX: 198,
    SALE_OBSERVATION: 126, SALE_ECONOMICS: 67,
    TRANSFER: 0, DEED: 0, MORTGAGE: 0, MORTGAGE_RELEASE: 0, LIEN: 0, FORECLOSURE_NOTICE: 0,
  };
  for (const capability of DASHBOARD_CAPABILITIES) {
    assert.equal(automatedCoreJurisdictions(registry, capability), expected[capability], capability);
  }
});

// ---------------------------------------------------------------------------
// 2. Semantics
// ---------------------------------------------------------------------------

test('semantics: every class says what one record means, what it is not, and claims only transaction capabilities', () => {
  assert.equal(Object.keys(TRANSACTION_SEMANTICS).length, TRANSACTION_SEMANTIC_CLASSES.length);
  for (const k of TRANSACTION_SEMANTIC_CLASSES) {
    const s = TRANSACTION_SEMANTICS[k];
    assert.equal(s.semanticClass, k);
    assert.ok(s.oneRecordMeans.length > 40, k);
    assert.ok(s.isNot.length > 0, k);
    for (const cap of s.mayClaim) assert.ok(TRANSACTION_CAPABILITIES.has(cap), `${k} claims ${cap}`);
  }
});

test('semantics: only a recorded instrument may claim a deed, mortgage, release or lien', () => {
  for (const cap of ['deed', 'mortgage', 'mortgage_release', 'lien'] as const) {
    const classes = TRANSACTION_SEMANTIC_CLASSES.filter((k) => TRANSACTION_SEMANTICS[k].mayClaim.includes(cap));
    assert.deepEqual(classes, ['RECORDED_INSTRUMENT'], cap);
  }
  // The brief's four rules, as overclaims.
  assert.deepEqual(semanticOverclaims(['deed'], ['ASSESSOR_SALE_OBSERVATION']), ['deed'], 'a sale observation is not a deed');
  assert.deepEqual(semanticOverclaims(['deed', 'mortgage'], ['TRANSFER_DECLARATION']), ['deed', 'mortgage']);
  assert.deepEqual(semanticOverclaims(['sale_economics'], ['TAX_ROLL_SALE_ECHO']), ['sale_economics'], 'an echoed price is not economics');
  assert.deepEqual(semanticOverclaims(['tax_sale'], ['FORECLOSURE_NOTICE']), ['tax_sale']);
  // Undeclared semantics never pass, and non-transaction capabilities are not this module's business.
  assert.deepEqual(semanticOverclaims(['deed', 'parcel'], undefined), ['deed']);
  assert.deepEqual(semanticOverclaims(['parcel', 'assessor'], undefined), []);
});

test('semantics: every catalogued candidate claiming a transaction capability declares semantics that support it', () => {
  for (const c of ALL) {
    if (!c.capabilities.some((cap) => TRANSACTION_CAPABILITIES.has(cap))) continue;
    assert.ok((c.transactionSemantics ?? []).length > 0, `${c.sourceName}: no declared semantics`);
    assert.deepEqual(semanticOverclaims(c.capabilities, c.transactionSemantics), [], c.sourceName);
  }
});

test('semantics: Wisconsin RETR is a transfer declaration, not a deed source, and is not automatable', () => {
  const retr = byName('Real Estate Transfer Return');
  assert.deepEqual(retr.transactionSemantics, ['TRANSFER_DECLARATION']);
  assert.ok(!retr.capabilities.includes('deed'));
  assert.equal(retr.acquisitionHypothesis, 'MANUAL_ONLY');
});

test('semantics: the Texas legal limit covers price and declaration, not recorded deeds', () => {
  const texas = LEGAL_CAPABILITY_LIMITS.find((l) => l.stateCodes.includes('TX'));
  assert.ok(texas);
  assert.ok(texas.capabilities.includes('transfer'));
  assert.ok(texas.capabilities.includes('sale_economics'));
  assert.ok(!texas.capabilities.includes('deed'), 'Texas deeds are recorded and public');
});

test('semantics: every classified registered source exists, and the registry\'s overclaims are reported, not hidden', () => {
  for (const id of Object.keys(REGISTERED_SOURCE_SEMANTICS)) assert.ok(registry.source(id), id);
  // Every registered mapping that claims a transaction capability is classified.
  for (const m of registry.mappings) {
    if (m.capabilities.some((cap) => TRANSACTION_CAPABILITIES.has(cap))) {
      assert.ok(REGISTERED_SOURCE_SEMANTICS[m.sourceId], `${m.sourceId} is unclassified`);
    }
  }
  // eCRV's mapping claims deed and mortgage; a transfer declaration supports
  // neither. DF-0Q reports this and does not edit the registry (no coverage change).
  const findings = registrySemanticFindings(registry.mappings);
  assert.deepEqual(
    findings.map((f) => [f.sourceId, [...f.overclaimed].sort()]),
    [['mn_dor_ecrv_weekly_sales_extract', ['deed', 'mortgage']]],
  );
});

// ---------------------------------------------------------------------------
// 3. DF-0Q leads
// ---------------------------------------------------------------------------

test('leads: every DF-0Q candidate is UNVERIFIED, carries no evidence, says so, and cannot be promoted', () => {
  assert.ok(NATIONAL_TRANSACTION_CANDIDATES.length >= 20);
  for (const c of NATIONAL_TRANSACTION_CANDIDATES) {
    assert.equal(c.verification, 'UNVERIFIED', c.sourceName);
    assert.deepEqual(c.evidence, [], `${c.sourceName}: DF-0Q read no page, so it may quote none`);
    assert.match(c.notes, /^DF-0Q LEAD — nothing here was retrieved/, c.sourceName);
    assert.equal(checkPromotion(c).ready, false, c.sourceName);
    assert.match(c.officialUrl, /^https:\/\//);
  }
  for (const p of NATIONAL_PLATFORM_FAMILIES) assert.deepEqual(p.evidence, [], p.platformId);
});

test('leads: ids are unique across both catalogues, every scope expands, and none leaks into the researched catalogue', () => {
  const ids = ALL.map((c) => c.candidateId);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of NATIONAL_TRANSACTION_CANDIDATES) {
    assert.ok(candidateJurisdictionCount(c) > 0, c.sourceName);
    assert.ok(!SOURCE_CANDIDATES.some((s) => s.candidateId === c.candidateId), c.sourceName);
  }
  const platformIds = new Set(NATIONAL_PLATFORM_FAMILIES.map((p) => p.platformId));
  assert.equal(platformIds.size, NATIONAL_PLATFORM_FAMILIES.length);
});

// ---------------------------------------------------------------------------
// 4. Transaction priority
// ---------------------------------------------------------------------------

test('priority: nothing is PROMOTABLE today — no transaction source has verified evidence', () => {
  const ranked = rankTransactionCandidates(ALL, registry);
  assert.equal(ranked.filter((r) => r.eligibility === 'PROMOTABLE').length, 0);
  for (const r of ranked) {
    if (r.eligibility === 'EXCLUDED') assert.equal(r.score, 0, r.sourceName);
    else assert.ok(r.score > 0, r.sourceName);
    assert.ok(r.blockers.length > 0, `${r.sourceName}: a non-promotable candidate must say why`);
  }
  // Every candidate here touches a transaction capability; parcel-only ones are not ranked.
  assert.ok(!ranked.some((r) => r.sourceName.startsWith('Parcels, Compiled')));
});

test('priority: the queue is the 27 DF-0Q leads plus the 2 researched candidates that claim a transaction capability', () => {
  const ranked = rankTransactionCandidates(ALL, registry);
  const researched = SOURCE_CANDIDATES.filter((c) => c.capabilities.some((cap) => TRANSACTION_CAPABILITIES.has(cap)));
  assert.equal(NATIONAL_TRANSACTION_CANDIDATES.length, 27);
  assert.deepEqual(researched.map((c) => c.sourceName).sort(),
    ['Notice of Foreclosure Sale postings', 'Real Estate Transfer Return (RETR) historical data']);
  assert.equal(ranked.length, NATIONAL_TRANSACTION_CANDIDATES.length + researched.length);
});

test('priority: a fully evidenced, free, sanctioned, automated candidate is PROMOTABLE; each failing fact excludes or queues it', () => {
  assert.equal(transactionPriority(verified(), registry).eligibility, 'PROMOTABLE');
  const excluded = (o: Partial<SourceCandidate>) => transactionPriority(verified(o), registry);
  for (const [o, why] of [
    [{ costHypothesis: 'PAID_SUBSCRIPTION' }, /does not pay/],
    [{ automationHypothesis: 'prohibited' }, /prohibited/],
    [{ acquisitionHypothesis: 'PROHIBITED_AUTOMATION' }, /prohibited/],
    [{ acquisitionHypothesis: 'MANUAL_ONLY' }, /human is not an acquisition mechanism/],
    [{ automationHypothesis: 'manual_only' }, /human is not an acquisition mechanism/],
    [{ transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'] }, /cannot support: deed, mortgage/],
    [{ verification: 'RULED_OUT' }, /ruled out/],
  ] as const) {
    const r = excluded(o as Partial<SourceCandidate>);
    assert.equal(r.eligibility, 'EXCLUDED', JSON.stringify(o));
    assert.equal(r.score, 0);
    assert.ok(r.blockers.some((b) => why.test(b)), `${JSON.stringify(o)}: ${r.blockers.join('; ')}`);
  }
  // Unknown is queued, never excluded and never promotable.
  for (const o of [{ costHypothesis: 'UNKNOWN_COST' }, { acquisitionHypothesis: 'UNKNOWN_AUTOMATION' },
    { acquisitionHypothesis: undefined }, { automationHypothesis: 'unknown' }, { verification: 'OFFICIAL_PAGE' }] as const) {
    assert.equal(excluded(o as Partial<SourceCandidate>).eligibility, 'VERIFICATION_QUEUE', JSON.stringify(o));
  }
});

test('priority: a hypothesised exclusion says it is a hypothesis', () => {
  const r = transactionPriority(verified({ costHypothesis: 'PAID_SUBSCRIPTION', verification: 'UNVERIFIED' }), registry);
  assert.equal(r.eligibility, 'EXCLUDED');
  assert.ok(r.blockers.some((b) => /PAID_SUBSCRIPTION.*\(hypothesis; UNVERIFIED\)/.test(b)), r.blockers.join('; '));
});

test('leads: no unverified lead is classified paid — an unread price is UNKNOWN_COST, not PAID', () => {
  for (const c of NATIONAL_TRANSACTION_CANDIDATES) {
    assert.ok(c.costHypothesis === 'UNKNOWN_COST' || isZeroCost(c.costHypothesis), `${c.sourceName}: ${c.costHypothesis}`);
  }
  // So the suspected-paid systems are queued for verification, not excluded on a recollection.
  for (const name of ['PT-61', 'Secure Remote Access', 'WCCA']) {
    assert.equal(transactionPriority(byName(name), registry).eligibility, 'VERIFICATION_QUEUE', name);
  }
});

test('priority: a legal ceiling removes only the barred capability, and a source left with none is excluded', () => {
  const tx = (capabilities: SourceCandidate['capabilities'], classes: SourceCandidate['transactionSemantics']) =>
    transactionPriority(verified({ scope: { kind: 'states', stateCodes: ['TX'] }, capabilities, transactionSemantics: classes }), registry);
  const declaration = tx(['transfer', 'sale_economics'], ['TRANSFER_DECLARATION']);
  assert.equal(declaration.eligibility, 'EXCLUDED');
  assert.ok(declaration.blockers.some((b) => /legally unavailable/.test(b)));
  const deeds = tx(['deed'], ['RECORDED_INSTRUMENT']);
  assert.equal(deeds.eligibility, 'PROMOTABLE', 'Texas deeds are recordable records');
  assert.deepEqual(deeds.transactionCapabilities, ['deed']);
});

test('priority: what a record means moves the score — a deed index outranks a roll echo, all else equal', () => {
  const deed = transactionPriority(verified(), registry);
  const echo = transactionPriority(verified({ capabilities: ['sale_observation'], transactionSemantics: ['TAX_ROLL_SALE_ECHO'] }), registry);
  assert.ok(deed.components.semanticValue > echo.components.semanticValue);
  assert.ok(deed.score > echo.score);
});

test('priority: gap closure is zero where the capability is already automated core, one where nothing is', () => {
  const fl = transactionPriority(verified({
    scope: { kind: 'states', stateCodes: ['FL'] }, capabilities: ['sale_observation'], transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
  }), registry);
  assert.equal(fl.components.gapClosure, 0, 'Florida already has SDF sale observations in all 67 counties');
  const flDeeds = transactionPriority(verified({ scope: { kind: 'states', stateCodes: ['FL'] } }), registry);
  assert.equal(flDeeds.components.gapClosure, 1, 'and no recorded instruments anywhere');
});

test('priority: deterministic, decomposable, weights sum to 100, and the strongest recorded-instrument lead leads the queue', () => {
  const a = rankTransactionCandidates(ALL, registry);
  assert.equal(canonicalJson(a), canonicalJson(rankTransactionCandidates(ALL, registry)));
  assert.equal(Object.values(TRANSACTION_WEIGHTS).reduce((x, y) => x + y, 0), 100);
  for (const r of a) assert.equal(Object.keys(r.components).length, Object.keys(TRANSACTION_WEIGHTS).length);
  const queue = a.filter((r) => r.eligibility === 'VERIFICATION_QUEUE');
  const acris = queue.findIndex((r) => r.sourceName.startsWith('ACRIS'));
  assert.equal(acris, 0, queue.slice(0, 3).map((r) => `${r.sourceName} ${r.score}`).join(' | '));
  // Every echo and assessor observation sits below every recorded instrument in the queue.
  const worstInstrument = Math.max(...queue.map((r, i) => (r.semanticClasses.includes('RECORDED_INSTRUMENT') ? i : -1)));
  const bestEcho = queue.findIndex((r) => r.semanticClasses.every((k) => k === 'TAX_ROLL_SALE_ECHO'));
  assert.ok(bestEcho === -1 || bestEcho > worstInstrument);
});

// ---------------------------------------------------------------------------
// 5. The general ranking is untouched except by the acquisition gate
// ---------------------------------------------------------------------------

test('general ranking: the new fields change no score, and a known non-automated source is now excluded', () => {
  for (const c of SOURCE_CANDIDATES) {
    if (c.acquisitionHypothesis !== undefined) continue;
    const without = rankCandidate(rankingInputFor({ ...c, transactionSemantics: undefined }));
    assert.equal(rankCandidate(rankingInputFor(c)).score, without.score, c.sourceName);
  }
  const retr = rankCatalogue().find((r) => r.sourceName.startsWith('Real Estate Transfer Return'));
  assert.equal(retr?.score, 0);
  assert.match(retr?.excluded ?? '', /human is not an acquisition mechanism/);
  // Before DF-0Q manual_only out-scored unknown; now it cannot score at all.
  const dallas = byName('Notice of Foreclosure Sale');
  assert.equal(rankCandidate(rankingInputFor({ ...dallas, automationHypothesis: 'manual_only' })).score, 0);
});

test('cli: df sources transactions reports the queue and the registry finding without reaching a publisher', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'df.ts');
  const report = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'sources', 'transactions'], {
    env: { ...process.env, DF_VAR: tempRoot('df-txq-') },
  }).toString()) as { ranked: { sourceName: string; eligibility: string }[]; registrySemanticFindings: { sourceId: string }[] };
  assert.ok(report.ranked.length >= NATIONAL_TRANSACTION_CANDIDATES.length);
  assert.ok(report.ranked.every((r) => r.eligibility !== 'PROMOTABLE'));
  assert.deepEqual(report.registrySemanticFindings.map((f) => f.sourceId), ['mn_dor_ecrv_weekly_sales_extract']);
});
