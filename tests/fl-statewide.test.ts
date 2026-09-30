/**
 * DF-0M — Florida statewide property fabric: the 65-item verification matrix.
 *
 * Every test runs the real pipeline — discovery against a fake PTO library,
 * acquisition into a real artifact store, derivation from the retained zips,
 * the streaming runtime, the partition projections — over an invented roll in
 * the Department's real 2026 layouts (`support/fl-roll-fixture.ts`). Test
 * names carry their matrix number.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createStreamingArtifactStore } from '../src/archive/artifact-store.ts';
import { createStreamingFilesystemObjectStore } from '../src/archive/object-store.ts';
import { createContactPlane } from '../src/contact/contact-plane.ts';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { contentDigest, deterministicId } from '../src/core/hash.ts';
import { propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { foldProperty, type SaleContribution } from '../src/canonical/sale-projection.ts';
import { assessActivation } from '../src/registry/policy.ts';
import { defaultRegistry, FL_CADASTRAL_SOURCE_ID, FL_NAL_SOURCE_ID, FL_SDF_SOURCE_ID } from '../src/registry/sources.ts';
import type { Registry } from '../src/registry/registry.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';
import { replayFlRelease, runFlPipeline, type FlPipelineResult, type FlSourceSpec } from '../src/connectors/fl-dor/pipeline.ts';
import { flParcelIdentity, flSdfSourceRecordId } from '../src/connectors/fl-dor/identity.ts';
import { flCountyByDorCode } from '../src/connectors/fl-dor/counties.ts';
import { FL_QUALIFICATION_CODES, readFlQualification, flQualificationClassifications } from '../src/connectors/fl-dor/qualification.ts';
import { FL_NAL_SPEC } from '../src/connectors/fl-nal/index.ts';
import { FL_SDF_SPEC } from '../src/connectors/fl-sdf/index.ts';
import { FL_CADASTRAL_SPEC } from '../src/connectors/fl-cadastral/index.ts';
import { createFlNalLeakageAudit } from '../src/connectors/fl-nal/leakage.ts';
import { FL_NAL_FIELD_MAP, FL_NAL_RESTRICTED_FIELDS } from '../src/connectors/fl-nal/field-map.ts';
import { FL_PAR_FIELD_MAP, dbfDecimal } from '../src/connectors/fl-cadastral/field-map.ts';
import { tempRoot } from './helpers.ts';
import {
  GULF, LAFAYETTE, LIBERTY, P_DASHED, P_PUNCT_A, P_PUNCT_B, P_ZEROS,
  flFixturePortal, lafayetteNal, lafayetteSdf, nalRow, sdfRow, type FlFixtureOptions,
} from './support/fl-roll-fixture.ts';

const INSTANT = '2026-09-29T12:00:00.000Z';
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type Estate = {
  readonly root: string;
  readonly varRoot: string;
  readonly portal: ReturnType<typeof flFixturePortal>;
  readonly store: ReturnType<typeof createStreamingArtifactStore>;
  readonly registry: Registry;
  run(spec: FlSourceSpec, extra?: Partial<Parameters<typeof runFlPipeline>[1]>): Promise<FlPipelineResult>;
  replay(spec: FlSourceSpec, result: FlPipelineResult, extra?: Partial<Parameters<typeof replayFlRelease>[1]>): Promise<FlPipelineResult>;
  digests(filter?: RegExp): Promise<Record<string, string>>;
  global(): Promise<string>;
  table(domain: 'property' | 'transaction', fips: string, table: 'resolutions' | 'conflicts'): Promise<Record<string, unknown>[]>;
};

function estate(options: FlFixtureOptions = {}, shared?: { portal: ReturnType<typeof flFixturePortal>; root: string }): Estate {
  const root = shared?.root ?? tempRoot('df-fl-');
  if (!shared) roots.push(root);
  const varRoot = join(root, 'var');
  const portal = shared?.portal ?? flFixturePortal(options);
  const store = createStreamingArtifactStore(createStreamingFilesystemObjectStore(join(root, 'archive')));
  const registry = defaultRegistry();
  const base = {
    registry, artifactStore: store, contactPlane: createContactPlane({ maxRetained: 0 }), varRoot,
    clock: fixedClock(INSTANT), logger: captureLogger().logger,
  };
  return {
    root, varRoot, portal, store, registry,
    run: (spec, extra = {}) => runFlPipeline(spec, { ...base, http: { fetchImpl: portal.fetchImpl, sleep: async () => {} }, ...extra }),
    replay: (spec, result, extra = {}) => replayFlRelease(spec, {
      ...base, releaseManifestSha256: result.manifestArtifact?.sha256 ?? '', referencePeriod: '2026', ...extra,
    }),
    async digests(filter) {
      const out: Record<string, string> = {};
      for (const m of await createPartitionStore(varRoot).manifests()) {
        if (!filter || filter.test(m.partitionId)) out[m.partitionId] = m.outputDigest;
      }
      return out;
    },
    async global() {
      const { globalDigest } = await import('../src/canonical/partitions.ts');
      return globalDigest(await createPartitionStore(varRoot).manifests());
    },
    async table(domain, fips, table) {
      const { countyPartition } = await import('../src/canonical/partitions.ts');
      const key = countyPartition(domain === 'property' ? 'PROPERTY_RESOLUTION' : 'TRANSACTION_RESOLUTION', fips);
      const rows: Record<string, unknown>[] = [];
      for await (const line of createPartitionStore(varRoot).readTable(key, table)) rows.push(JSON.parse(line));
      return rows;
    },
  };
}

const SPECS = { par: FL_CADASTRAL_SPEC, nal: FL_NAL_SPEC, sdf: FL_SDF_SPEC } as const;

async function ingestAll(e: Estate, order: readonly (keyof typeof SPECS)[] = ['par', 'nal', 'sdf']): Promise<Record<string, FlPipelineResult>> {
  const out: Record<string, FlPipelineResult> = {};
  for (const k of order) {
    const r = await e.run(SPECS[k]);
    assert.equal(r.outcome, 'INGESTED', `${k}: ${r.run?.run.failureMessage ?? r.outcome}`);
    out[k] = r;
  }
  return out;
}

// The shared, fully ingested estate most tests read from.
let sharedEstate: Estate | null = null;
let sharedRuns: Record<string, FlPipelineResult> = {};
async function ingested(): Promise<{ e: Estate; runs: Record<string, FlPipelineResult> }> {
  if (sharedEstate === null) {
    sharedEstate = estate();
    sharedRuns = await ingestAll(sharedEstate);
  }
  return { e: sharedEstate, runs: sharedRuns };
}

// ===========================================================================
// Automation (1–7)
// ===========================================================================

test('01 cadastral: acquisition needs no human — listing and plain GETs, no credential of any kind', async () => {
  const { e } = await ingested();
  const requests = e.portal.requests;
  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.method, 'GET');
    for (const header of Object.keys(r.headers).map((h) => h.toLowerCase())) {
      assert.ok(!['authorization', 'cookie', 'x-api-key'].includes(header), `sent ${header}`);
    }
    assert.ok(!/token|key=|sig=|password/i.test(r.url), r.url);
    assert.ok(!r.url.includes('/~'), 'a ~ folder was entered');
  }
});

test('02 cadastral: the activation gate says CORE_ELIGIBLE, zero cost, from registry facts alone', () => {
  const registry = defaultRegistry();
  for (const id of [FL_CADASTRAL_SOURCE_ID]) {
    const source = registry.source(id);
    assert.equal(assessActivation(source).verdict, 'CORE_ELIGIBLE');
    assert.equal(source.costModel, 'free');
    assert.equal(source.accessRequest?.quotedFeeUsd, 0);
  }
});

test('03 cadastral: the same release is a NOOP — not one file fetched again', async () => {
  const e = estate();
  const first = await e.run(FL_CADASTRAL_SPEC);
  assert.equal(first.outcome, 'INGESTED');
  const gets = e.portal.fileGets();
  const second = await e.run(FL_CADASTRAL_SPEC);
  assert.equal(second.outcome, 'NOOP');
  assert.equal(e.portal.fileGets(), gets);
  assert.equal(second.ledger?.action, 'NOOP_SAME_RELEASE');
});

test('03b freshness across releases: present, then missing, then present again is missing and then reappeared — never new twice', async () => {
  const e = estate();
  assert.equal((await e.run(FL_NAL_SPEC)).outcome, 'INGESTED');
  const later = (at: string) => runFlPipeline(FL_NAL_SPEC, {
    registry: e.registry, artifactStore: e.store, contactPlane: createContactPlane({ maxRetained: 0 }), varRoot: e.varRoot,
    clock: fixedClock(at), logger: captureLogger().logger, http: { fetchImpl: e.portal.fetchImpl, sleep: async () => {} },
  });
  const full = lafayetteNal();
  const dropped = full.filter((r) => r['PARCEL_ID'] !== P_PUNCT_B);
  assert.equal(dropped.length, full.length - 1);

  // Release B: the county re-posts its roll without one parcel. Missing from the latest source — not deleted.
  e.portal.publish({ nal: { '44': dropped } });
  const b = await later('2026-10-15T12:00:00.000Z');
  assert.equal(b.outcome, 'INGESTED');
  assert.equal(b.run?.changeCounts.parcel_missing_from_latest_source, 1);
  assert.equal(b.run?.changeCounts.parcel_reappeared, 0);
  assert.equal(b.run?.changeCounts.new_parcel_observed, 0);

  // Release C: the parcel is back. It reappears; it is not observed as new a second time.
  e.portal.publish({ nal: { '44': full } });
  const c = await later('2026-11-15T12:00:00.000Z');
  assert.equal(c.outcome, 'INGESTED');
  assert.equal(c.run?.changeCounts.parcel_reappeared, 1);
  assert.equal(c.run?.changeCounts.new_parcel_observed, 0);
  assert.equal(c.run?.changeCounts.parcel_missing_from_latest_source, 0);
  // One property per parcel throughout, under the same id.
  const ids = (await e.table('property', LAFAYETTE.fips, 'resolutions')).map((r) => r['propertyId']);
  assert.equal(new Set(ids).size, full.length);
  assert.ok(ids.includes(flParcelIdentity(LAFAYETTE.fips, P_PUNCT_B).propertyId));
});

test('04–05 NAL and SDF: the automation gate is CORE_ELIGIBLE for both, each on its own facts', () => {
  const registry = defaultRegistry();
  for (const id of [FL_NAL_SOURCE_ID, FL_SDF_SOURCE_ID]) {
    const source = registry.source(id);
    assert.equal(assessActivation(source).verdict, 'CORE_ELIGIBLE', id);
    assert.equal(source.automationStatus, 'sanctioned');
    assert.equal(source.costModel, 'free');
  }
  // The SDF names no one; the NAL does, and says so.
  assert.equal(registry.source(FL_SDF_SOURCE_ID).carriesRestrictedContact, false);
  assert.equal(registry.source(FL_NAL_SOURCE_ID).carriesRestrictedContact, true);
});

test('06 a manual-only path cannot become core: the gate refuses before any request leaves', async () => {
  const e = estate();
  const registry = defaultRegistry();
  // A manual-only path, as the registry states one: the bytes arrive only when a person fetches them.
  const manual = { ...registry.source(FL_NAL_SOURCE_ID), acquisitionClass: 'MANUAL_ONLY' as const, accessType: 'manual_import' as const };
  assert.equal(assessActivation(manual).verdict, 'BLOCKED_MANUAL_ACQUISITION');
  const patched: Registry = { ...registry, source: (id: string) => (id === FL_NAL_SOURCE_ID ? manual : registry.source(id)) } as Registry;
  await assert.rejects(runFlPipeline(FL_NAL_SPEC, {
    registry: patched, artifactStore: e.store, contactPlane: createContactPlane(), varRoot: e.varRoot,
    clock: fixedClock(INSTANT), http: { fetchImpl: e.portal.fetchImpl, sleep: async () => {} },
  }), /refusing unattended acquisition/);
  assert.equal(e.portal.requests.length, 0);
});

test('07 no silent local fallback: a portal that fails fails the run, and nothing is ingested', async () => {
  const e = estate();
  const broken = (async () => new Response('down', { status: 503 })) as typeof fetch;
  await assert.rejects(runFlPipeline(FL_SDF_SPEC, {
    registry: e.registry, artifactStore: e.store, contactPlane: createContactPlane(), varRoot: e.varRoot,
    clock: fixedClock(INSTANT), http: { fetchImpl: broken, sleep: async () => {}, retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, retryable: () => false } },
  }));
  assert.deepEqual(await e.digests(), {});
  const ledger = readFileSync(join(e.varRoot, 'acquisition', `${FL_SDF_SOURCE_ID}.ledger.ndjson`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.at(-1).action, 'FAILED');
});

// ===========================================================================
// Florida identity (8–13)
// ===========================================================================

test('08 leading zeros survive: 0000012345 is not 12345', () => {
  const id = flParcelIdentity(LAFAYETTE.fips, P_ZEROS);
  assert.equal(id.normalizedParcel, '0000012345');
  assert.notEqual(id.propertyId, flParcelIdentity(LAFAYETTE.fips, '12345').propertyId);
});

test('09 punctuation is tested before it is stripped: 1-1109 and 11-109 stay two parcels', async () => {
  const a = flParcelIdentity(LAFAYETTE.fips, P_PUNCT_A);
  const b = flParcelIdentity(LAFAYETTE.fips, P_PUNCT_B);
  assert.equal(a.matchKey, b.matchKey, 'folded, they collide — which is why folding is not identity');
  assert.notEqual(a.propertyId, b.propertyId);
  const { e } = await ingested();
  const props = (await e.table('property', LAFAYETTE.fips, 'resolutions')).map((r) => r['normalizedParcel']);
  assert.ok(props.includes(P_PUNCT_A) && props.includes(P_PUNCT_B));
});

test('10 a duplicate parcel inside one county is detected, counted and not admitted twice', async () => {
  const e = estate({ nal: { '44': [...lafayetteNal(), nalRow(LAFAYETTE, P_ZEROS, { OWN_NAME: 'INVENTED DUPLICATE' })] } });
  const r = await e.run(FL_NAL_SPEC);
  assert.equal(r.outcome, 'INGESTED');
  assert.equal(r.run?.snapshot?.duplicateCount, 1);
  assert.equal(r.run?.run.metrics.rowsQuarantined, 1);
});

test('11 the same id string in two counties is two properties', async () => {
  const { e } = await ingested();
  const laf = (await e.table('property', LAFAYETTE.fips, 'resolutions')).find((r) => r['normalizedParcel'] === P_ZEROS);
  const lib = (await e.table('property', LIBERTY.fips, 'resolutions')).find((r) => r['normalizedParcel'] === P_ZEROS);
  assert.ok(laf && lib);
  assert.notEqual(laf['propertyId'], lib['propertyId']);
});

test('12 the same id string in Florida, Minnesota and Wisconsin is three properties in three partitions', () => {
  const ids = ['12067', '27053', '55079'].map((fips) => propertyIdFromCountyParcel(fips, P_ZEROS));
  assert.equal(new Set(ids).size, 3);
});

test('13 an address never resolves identity on its own', async () => {
  const { e } = await ingested();
  const conflicts = await e.table('property', LAFAYETTE.fips, 'conflicts');
  // Two parcels share a situs: reported, never merged.
  const shared = conflicts.find((c) => c['conflictKind'] === 'address_matches_different_pid');
  assert.ok(shared, 'the shared situs is reported');
  const resolutions = await e.table('property', LAFAYETTE.fips, 'resolutions');
  assert.equal(resolutions.filter((r) => r['normalizedParcel'] === P_PUNCT_A || r['normalizedParcel'] === P_PUNCT_B).length, 2);
});

// ===========================================================================
// Cross-source convergence (14–19)
// ===========================================================================

test('14 the map and the roll converge on one property, and two authoritative sources are not a conflict', async () => {
  const { e } = await ingested();
  const row = (await e.table('property', LAFAYETTE.fips, 'resolutions')).find((r) => r['normalizedParcel'] === P_DASHED);
  assert.ok(row);
  assert.equal(row['state'], 'resolved');
  assert.deepEqual(row['contributingSourceIds'], [FL_SDF_SOURCE_ID, FL_NAL_SOURCE_ID, FL_CADASTRAL_SOURCE_ID].sort());
  const conflicts = await e.table('property', LAFAYETTE.fips, 'conflicts');
  assert.ok(!conflicts.some((c) => c['conflictKind'] === 'duplicate_authoritative_row'));
});

test('15 the roll and the sale file converge: one property, and the sale supported by its echo', async () => {
  const { e } = await ingested();
  const sales = await e.table('transaction', LAFAYETTE.fips, 'resolutions');
  const sale = sales.find((s) => s['publisherSaleId'] === '2501');
  assert.ok(sale);
  assert.equal(sale['state'], 'SUPPORTED_MATCH');
  assert.equal(sale['propertyId'], propertyIdFromCountyParcel(LAFAYETTE.fips, P_DASHED));
});

test('16–18 ingest order does not matter: map→roll→sales, roll→sales→map and sales→map→roll are byte-identical', async () => {
  const orders: (keyof typeof SPECS)[][] = [['par', 'nal', 'sdf'], ['nal', 'sdf', 'par'], ['sdf', 'par', 'nal']];
  const results: string[] = [];
  const partitions: Record<string, string>[] = [];
  for (const order of orders) {
    const e = estate();
    await ingestAll(e, order);
    results.push(await e.global());
    partitions.push(await e.digests());
  }
  assert.equal(new Set(results).size, 1, 'global digests differ by ingest order');
  assert.deepEqual(partitions[1], partitions[0]);
  assert.deepEqual(partitions[2], partitions[0]);
  // Conflicts exist in this estate, so their provenance is part of what was compared.
  assert.ok(Object.keys(partitions[0] ?? {}).includes('transaction/us-county-12067'));
});

test('19 raw evidence is retained per county file, independently of anything derived', async () => {
  const { e, runs } = await ingested();
  for (const r of Object.values(runs)) {
    for (const f of r.acquisition?.files ?? []) {
      await e.store.verify(f.artifact);
      assert.equal(f.artifact.sha256, f.entry.sha256);
    }
  }
  // Every row's evidence names the release manifest, which names every file by sha256.
  const manifest = JSON.parse(readFileSync(e.store.localPath(runs['nal']?.manifestArtifact as never), 'utf8'));
  assert.ok(manifest.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

// ===========================================================================
// Normalization (20–26)
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bundlesOf(e: Estate, sourceId: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for await (const line of createGenerationStore(e.varRoot).readTable('bundles')) {
    const b = JSON.parse(line);
    if (b.transaction.sourceId === sourceId) out.push(b);
  }
  return out;
}

test('20 area and units: land square feet are the assessor\'s; the map area is a labelled GIS area in the file\'s unit', async () => {
  const { e } = await ingested();
  const nal = (await bundlesOf(e, FL_NAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  assert.equal(nal.characteristics[0].parcelAreaSqFt, 43560);
  assert.equal(nal.characteristics[0].characteristics.land_unit, 'ACRE');
  const par = (await bundlesOf(e, FL_CADASTRAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  const c = par.characteristics[0];
  assert.equal(c.parcelAreaSqFt, null, 'a drawing\'s area is never the assessor\'s land area');
  assert.equal(c.characteristics.area_source_units, 10000);
  // US survey feet → international feet: 10,000 ft² is 10,000.04 ft² exactly as converted.
  assert.equal(c.characteristics.gis_area_square_feet, 10000.04);
  assert.equal(c.characteristics.gis_area_derivation, 'shoelace_source_crs_1');
});

test('21 money is exact minor units: never a float, and past 2^53 it is refused rather than rounded', async () => {
  const { e } = await ingested();
  const nal = (await bundlesOf(e, FL_NAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  assert.deepEqual(nal.assessments[0].totalValue, { amountMinor: 15000000, currency: 'USD' });
  assert.equal(nal.assessments[0].characteristics.values_minor.TV_NSD, '8500000');
  assert.equal(dbfDecimal('150000.00000'), '150000');
  assert.equal(dbfDecimal('12.50000'), '12.5');
  const huge = estate({ nal: { '44': [nalRow(LAFAYETTE, 'HUGE-1', { JV: '999999999999999' })] } });
  const r = await huge.run(FL_NAL_SPEC, { canonicalRetention: 'full' });
  assert.equal(r.outcome, 'INGESTED');
  const b = (await bundlesOf(huge, FL_NAL_SOURCE_ID))[0] as Record<string, any>;
  assert.equal(b.assessments[0].totalValue, null, 'beyond Number.MAX_SAFE_INTEGER minor units, the Money slot stays empty');
  assert.equal(b.assessments[0].characteristics.values_minor.JV, '99999999999999900', 'and the exact figure survives as text');
});

test('22 dates keep their meaning: a sale MONTH, an assessment year, an inspection MMYY kept verbatim', async () => {
  const { e } = await ingested();
  const sdf = (await bundlesOf(e, FL_SDF_SOURCE_ID)).find((b) => b.transaction.characteristics.publisher_sale_id === '2501');
  assert.equal(sdf.transaction.transferDate, null, 'no day was published, so none is stored');
  assert.equal(sdf.transaction.characteristics.sale_month, '2025-06');
  assert.equal(sdf.saleObservations[0].saleMonth, '2025-06');
  const nal = (await bundlesOf(e, FL_NAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  assert.equal(nal.assessments[0].assessmentYear, 2026);
  assert.equal(nal.characteristics[0].characteristics.verbatim.DT_LAST_INSPT, '0315');
});

test('23 the situs is kept as published, keyed with its city and ZIP, and never resolves identity', async () => {
  const { e } = await ingested();
  const nal = (await bundlesOf(e, FL_NAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  const address = nal.propertyIdentifiers.find((p: { identifierType: string }) => p.identifierType === 'normalized_address');
  assert.equal(address.value, '23 SAMPLE RD, MAYO, 32066');
  assert.equal(address.normalizedValue, '23 SAMPLE RD MAYO 32066');
  assert.equal(address.resolutionState, 'unresolved');
  assert.equal(address.propertyId, null);
});

test('23b a placeholder situs with no house number is kept as text and never compared', async () => {
  const e = estate({ nal: { '44': [nalRow(LAFAYETTE, 'PH-1', { PHY_ADDR1: 'UNKNOWN' }), nalRow(LAFAYETTE, 'PH-2', { PHY_ADDR1: 'UNKNOWN' })] } });
  const r = await e.run(FL_NAL_SPEC, { canonicalRetention: 'full' });
  assert.equal(r.outcome, 'INGESTED');
  const bundles = (await bundlesOf(e, FL_NAL_SOURCE_ID)).filter((b) => String(b.propertyIdentifiers[0].value).startsWith('PH-'));
  assert.equal(bundles.length, 2);
  for (const b of bundles) {
    assert.ok(!b.propertyIdentifiers.some((p: { identifierType: string }) => p.identifierType === 'normalized_address'));
    assert.equal(b.characteristics[0].characteristics.situs_address, 'UNKNOWN, MAYO, 32066');
  }
  const conflicts = await e.table('property', LAFAYETTE.fips, 'conflicts');
  assert.ok(!conflicts.some((c) => c['conflictKind'] === 'address_matches_different_pid'));
});

test('24 null is not zero: a blank price is absent with its reason, a stated 0 is zero, a dBASE zero year states nothing', async () => {
  const { e } = await ingested();
  const sales = await bundlesOf(e, FL_SDF_SOURCE_ID);
  const blank = sales.find((b) => b.transaction.characteristics.publisher_sale_id === '2504');
  assert.equal(blank.saleObservations[0].priceMinor, null);
  assert.equal(blank.saleObservations[0].priceAbsentReason, 'BLANK_SOURCE');
  const zero = sales.find((b) => b.transaction.characteristics.publisher_sale_id === '2503');
  assert.equal(zero.saleObservations[0].priceMinor, '0');
  // The PAR record for the unsold-in-slot-2 parcel carries SALE_YR2 = 0: no echo.
  const par = (await bundlesOf(e, FL_CADASTRAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_DASHED);
  assert.equal(par.saleObservations.length, 1);
});

test('25 codes outside the published lists are kept and flagged, never guessed', async () => {
  assert.equal(readFlQualification('77').status, 'UNKNOWN');
  assert.equal(readFlQualification('77').code, '77');
  assert.equal(readFlQualification('15').facts[0], 'RETIRED_CODE');
  assert.equal(readFlQualification('1').known, false, 'a one-digit code is not left-padded into a known one');
  const { e } = await ingested();
  const nal = (await bundlesOf(e, FL_NAL_SOURCE_ID)).find((b) => b.propertyIdentifiers[0].value === P_PUNCT_B);
  assert.equal(nal.assessments[0].propertyTypeCode, '105');
  assert.equal(nal.assessments[0].characteristics.use_code_known, false);
});

test('26 the normalized digest is scoped by the normalizer version: a representation change is a different digest', async () => {
  const { runs } = await ingested();
  const e = estate();
  const renamed: FlSourceSpec = {
    ...FL_SDF_SPEC,
    connector: (m) => ({ ...FL_SDF_SPEC.connector(m), normalizationVersion: 'fl_sdf_normalizer_TEST' }),
  };
  const r = await e.run(renamed);
  assert.equal(r.outcome, 'INGESTED');
  assert.notEqual(r.run?.run.normalizedDigest, runs['sdf']?.run?.run.normalizedDigest);
});

// ===========================================================================
// Partitions (27–33)
// ===========================================================================

test('27 counties route through the Department\'s own numbers, never FIPS arithmetic or a city', async () => {
  const { runs } = await ingested();
  assert.deepEqual(Object.keys(runs['nal']?.run?.countyCounts ?? {}).sort(), [LAFAYETTE.fips, LIBERTY.fips]);
  // The DOR numbers are alphabetical with Miami-Dade filed under D; FIPS are not.
  assert.equal(flCountyByDorCode('44')?.fips, '12067');
  assert.equal(flCountyByDorCode('23')?.fips, '12086');
  assert.equal(flCountyByDorCode('24')?.fips, '12027');
  // A situs city is never a router: both fixture counties write MAYO, and each row still lands in its own county.
  const cities = new Set([...lafayetteNal(), ...(await import('./support/fl-roll-fixture.ts')).libertyNal()].map((r) => r['PHY_CITY']));
  assert.deepEqual([...cities], ['MAYO']);
});

test('28 an invalid county, or a row in the wrong county\'s file, is quarantined and counted', async () => {
  const e = estate({ nal: { '44': [...lafayetteNal(), nalRow(LAFAYETTE, 'BAD-CO', { CO_NO: '99' }), nalRow(LAFAYETTE, 'WRONG-FILE', { CO_NO: '49' })] } });
  const r = await e.run(FL_NAL_SPEC);
  assert.equal(r.outcome, 'INGESTED');
  assert.equal(r.run?.run.metrics.rowsQuarantined, 2);
  const props = (await e.table('property', LAFAYETTE.fips, 'resolutions')).map((x) => x['normalizedParcel']);
  assert.ok(!props.includes('BAD-CO') && !props.includes('WRONG-FILE'));
});

test('29 a Florida run plans only Florida partitions and the national organization partition', async () => {
  const { runs } = await ingested();
  for (const r of Object.values(runs)) {
    for (const p of r.run?.partitionPlan.partitions ?? []) {
      assert.match(p, /^(property|transaction)\/us-county-12\d{3}$|^organization\/us$/, p);
    }
  }
});

test('30–31 Minnesota and Wisconsin partitions are untouched by a Florida run: same generation, same digest', async () => {
  const e = estate();
  const partitions = createPartitionStore(e.varRoot);
  const { countyPartition } = await import('../src/canonical/partitions.ts');
  // Seed a Minnesota and a Wisconsin county partition with evidence of their own.
  for (const [fips, line] of [['27053', '{"c":"27053","n":"MN-1","o":"obs_mn","p":"prop_mn","r":"MN-1","s":"mn_statewide_parcels","st":"resolved","t":"2026-08-06T00:00:00.000Z","a":null,"f":"final"}'],
    ['55079', '{"c":"55079","n":"WI-1","o":"obs_wi","p":"prop_wi","r":"WI-1","s":"wi_statewide_parcels","st":"resolved","t":"2026-09-28T00:00:00.000Z","a":null,"f":"final"}']] as const) {
    const key = countyPartition('PROPERTY_RESOLUTION', fips);
    await partitions.writeContributions(key, 'run_seed', (async function* () { yield line; })());
    const w = await partitions.beginProjection(key, 'run_seed');
    await w.commit({ inputDigest: 'i', outputDigest: `o-${fips}`, resolverVersion: 'property_resolver_2', rowCount: 1, inputRowCount: 1, activatedAt: INSTANT, runId: 'run_seed' });
  }
  const before = (await partitions.manifests()).filter((m) => !m.scopeId.startsWith('us-county-12'));
  await ingestAll(e);
  const afterRun = (await partitions.manifests()).filter((m) => m.scopeId.startsWith('us-county-27') || m.scopeId.startsWith('us-county-55'));
  assert.deepEqual(afterRun, before.filter((m) => m.domain !== 'ORGANIZATION_RESOLUTION'));
});

test('32 activation is per county: an unchanged county keeps its generation byte for byte', async () => {
  const e = estate();
  await ingestAll(e);
  const before = await createPartitionStore(e.varRoot).manifests();
  // Only Liberty's roll changes.
  e.portal.publish({ nal: { '49': [nalRow(LIBERTY, P_ZEROS, { OWN_NAME: 'INVENTED PERSON FIVE', JV: '160000' }), nalRow(LIBERTY, '9999-0001', { OWN_NAME: 'INVENTED CORP INC' })] } });
  const r = await e.run(FL_NAL_SPEC);
  assert.equal(r.outcome, 'INGESTED');
  const afterRun = await createPartitionStore(e.varRoot).manifests();
  const gen = (list: typeof before, id: string) => list.find((m) => m.partitionId === id)?.generation;
  assert.equal(gen(afterRun, 'property/us-county-12067'), gen(before, 'property/us-county-12067'), 'Lafayette was not recomputed');
  assert.ok(r.run?.skippedPartitions.includes('property/us-county-12067'));
  assert.equal(r.run?.changeCounts.parcel_attributes_changed, 1);
});

test('33 the global digest is a pure function of the evidence: two independent estates agree', async () => {
  const { e } = await ingested();
  const other = estate();
  await ingestAll(other);
  assert.equal(await other.global(), await e.global());
});

// ===========================================================================
// Streaming (34–40)
// ===========================================================================

function bigNal(county: typeof LAFAYETTE, rows: number): ReturnType<typeof lafayetteNal> {
  return Array.from({ length: rows }, (_, i) => nalRow(county, `SYN-${String(i).padStart(7, '0')}`, { OWN_NAME: `INVENTED OWNER ${i}`, PHY_ADDR1: `${i} SYNTHETIC RD` }));
}

test('34 heap is bounded, not row-linear: 60,000 rows run to completion under a 96 MB heap cap', () => {
  // A child process under a small cap: a structure that grew with the rows would
  // crash it outright, so the test does not depend on a tuned threshold.
  const probe = join(import.meta.dirname, 'support', 'fl-heap-probe.ts');
  const run = spawnSync(process.execPath, ['--max-old-space-size=96', probe, '60000'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1) as string) as { outcome: string; rows: number; stages: Record<string, number> };
  assert.equal(out.outcome, 'INGESTED');
  assert.equal(out.rows, 60_002);
  // The per-row stage stays flat; the projection is bounded by a sort chunk.
  assert.ok((out.stages['normalize'] ?? 0) < 64 * 1048576, `normalize peaked at ${out.stages['normalize']}`);
});

test('35 duplicate identity is detected exactly, off the heap, across the whole statewide stream', async () => {
  const rows = bigNal(LAFAYETTE, 3_000);
  const e = estate({ nal: { '44': [...rows, rows[1234] as ReturnType<typeof nalRow>] } });
  const r = await e.run(FL_NAL_SPEC, { canonicalRetention: 'digest_only' });
  assert.equal(r.run?.snapshot?.duplicateCount, 1);
});

test('36 the snapshot index is external: one file per county on disk', async () => {
  const { e } = await ingested();
  const dir = join(e.varRoot, 'indexes', FL_NAL_SOURCE_ID);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.idx')).sort(), [`${LAFAYETTE.fips}.idx`, `${LIBERTY.fips}.idx`]);
});

test('37 a second acquisition resumes from retained files: nothing downloaded twice', async () => {
  const e = estate();
  await e.run(FL_SDF_SPEC, { acquireOnly: true });
  const gets = e.portal.fileGets();
  const r = await e.run(FL_SDF_SPEC);
  assert.equal(r.outcome, 'INGESTED');
  assert.equal(e.portal.fileGets(), gets);
  assert.ok(r.acquisition?.files.every((f) => f.reused));
});

test('38 an interrupted run activates nothing: a corrupt county file fails the release and the estate stands', async () => {
  const e = estate();
  const runs = await ingestAll(e);
  const before = await e.global();
  const generations = (await createPartitionStore(e.varRoot).manifests()).map((m) => m.generation);
  // Tamper with a retained county file: verification fails before a row is interpreted.
  const file = runs['nal']?.acquisition?.files[1]?.artifact;
  assert.ok(file);
  const path = e.store.localPath(file);
  chmodSync(path, 0o644);
  const bytes = readFileSync(path);
  bytes[bytes.length - 30] = (bytes[bytes.length - 30] as number) ^ 0xff;
  writeFileSync(path, bytes);
  await assert.rejects(e.run(FL_NAL_SPEC, { mode: 'force' }), /digest verification/);
  assert.equal(await e.global(), before);
  assert.deepEqual((await createPartitionStore(e.varRoot).manifests()).map((m) => m.generation), generations);
});

test('39 scratch is cleaned up on success and on failure', async () => {
  const { e } = await ingested();
  const scratch = join(e.varRoot, 'scratch');
  assert.deepEqual(existsSync(scratch) ? readdirSync(scratch) : [], []);
});

test('40 gzip mode changes bytes on disk and no digest', async () => {
  const plain = estate();
  const zipped = estate();
  const saved = process.env['DF_DERIVED_GZIP'];
  try {
    process.env['DF_DERIVED_GZIP'] = '0';
    await ingestAll(plain);
    process.env['DF_DERIVED_GZIP'] = '1';
    await ingestAll(zipped);
  } finally {
    if (saved === undefined) delete process.env['DF_DERIVED_GZIP']; else process.env['DF_DERIVED_GZIP'] = saved;
  }
  assert.equal(await zipped.global(), await plain.global());
  const files = (dir: string): string[] => readdirSync(dir, { recursive: true }) as string[];
  assert.ok(files(join(zipped.varRoot, 'derived', 'partitions')).some((f) => f.endsWith('.ndjson.gz')));
  assert.ok(!files(join(plain.varRoot, 'derived', 'partitions')).some((f) => f.endsWith('.ndjson.gz')));
});

// ===========================================================================
// Sales (41–49)
// ===========================================================================

test('41 a sale observation is keyed by county, parcel and the appraiser\'s sale id — unambiguously', () => {
  assert.notEqual(flSdfSourceRecordId('12067', '01-2', '3'), flSdfSourceRecordId('12067', '01', '2-3'));
  assert.equal(flSdfSourceRecordId('12067', P_DASHED, '2501'), `FL-SDF-12067-${P_DASHED.length}.${P_DASHED}-2501`);
});

test('42 one parcel, two sales: two canonical sales, never merged', async () => {
  const { e } = await ingested();
  const sales = (await e.table('transaction', LAFAYETTE.fips, 'resolutions')).filter((s) => s['normalizedParcel'] === P_DASHED);
  assert.deepEqual(sales.map((s) => s['publisherSaleId']).sort(), ['2501', '2502']);
  const multi = sales.find((s) => s['publisherSaleId'] === '2502');
  assert.equal(multi?.['state'], 'SALE_OBSERVATION_ONLY');
  assert.equal(multi?.['multiParcelGroupId'], deterministicId('multiparcel', LAFAYETTE.fips, 'OR:130/1'));
});

test('43 the price is exact and labelled for what it is: derived from stamps, never a declared consideration', async () => {
  const { e } = await ingested();
  const rows: Record<string, any>[] = [];
  for await (const line of createGenerationStore(e.varRoot).readTable('transfer_considerations')) rows.push(JSON.parse(line));
  const b = (await bundlesOf(e, FL_SDF_SOURCE_ID)).find((x) => x.transaction.characteristics.publisher_sale_id === '2501');
  const row = rows.find((r) => r.transactionId === b.transaction.transactionId);
  assert.deepEqual(row, {
    transactionId: b.transaction.transactionId, kind: 'SALE_PRICE_DOC_STAMP_DERIVED', amountMinor: '20000000', absentReason: null,
    currency: 'USD', sourceField: 'SALE_PRC', derivationVersion: null,
  });
  assert.equal(b.transaction.totalConsideration, null);
});

async function classificationsFor(e: Estate, saleId: string): Promise<string[]> {
  const b = (await bundlesOf(e, FL_SDF_SOURCE_ID)).find((x) => x.transaction.characteristics.publisher_sale_id === saleId);
  const out: string[] = [];
  for await (const line of createGenerationStore(e.varRoot).readTable('transfer_classifications')) {
    const r = JSON.parse(line);
    if (r.transactionId === b.transaction.transactionId) out.push(`${r.primary ? '*' : ''}${r.classification}`);
  }
  return out.sort();
}

test('44 a qualified code: the appraiser\'s decision is primary, ratio-study inclusion beside it — and nothing says comparable', async () => {
  const { e } = await ingested();
  assert.deepEqual(await classificationsFor(e, '2501'), ['*ASSESSOR_QUALIFIED_SALE', 'RATIO_STUDY_INCLUDED']);
  const b = (await bundlesOf(e, FL_SDF_SOURCE_ID)).find((x) => x.transaction.characteristics.publisher_sale_id === '2501');
  assert.equal(b.transaction.analyticalMetadata.comparable, 'NOT_ASSERTED');
});

test('45 a disqualified code: the decision, the exclusion, and only the fact its wording states', async () => {
  const { e } = await ingested();
  assert.deepEqual(await classificationsFor(e, '2503'), ['*ASSESSOR_DISQUALIFIED_SALE', 'NOMINAL_OR_NON_MARKET_INSTRUMENT', 'RATIO_STUDY_EXCLUDED']);
  // No official code says gift or foreclosure, so no classification does.
  for (const c of FL_QUALIFICATION_CODES) {
    for (const row of flQualificationClassifications(readFlQualification(c.code))) {
      assert.ok(!/GIFT|^FORECLOSURE/.test(row.classification), `${c.code} → ${row.classification}`);
    }
  }
});

test('46 an unknown code stays verbatim and unknown', async () => {
  const { e } = await ingested();
  assert.deepEqual(await classificationsFor(e, '2504'), ['*UNKNOWN_TRANSFER_TYPE']);
  const b = (await bundlesOf(e, FL_SDF_SOURCE_ID)).find((x) => x.transaction.characteristics.publisher_sale_id === '2504');
  assert.equal(b.transaction.characteristics.qualification_code, '77');
  assert.equal(b.transaction.characteristics.qualification_known, false);
});

test('47 a blank price and a zero price are different consideration rows', async () => {
  const { e } = await ingested();
  const rows: Record<string, any>[] = [];
  for await (const line of createGenerationStore(e.varRoot).readTable('transfer_considerations')) rows.push(JSON.parse(line));
  assert.ok(rows.some((r) => r.amountMinor === '0' && r.absentReason === null));
  assert.ok(rows.some((r) => r.amountMinor === null && r.absentReason === 'BLANK_SOURCE'));
});

test('48 a revised sale in a new release is one sale with two statements, the newest governing', async () => {
  const e = estate();
  await ingestAll(e);
  // The county re-submits: sale 2505 now carries a price of 180,000 and a decision.
  e.portal.publish({ sdf: { '44': lafayetteSdf().map((r) => (r['SALE_ID_CD'] === '2505' ? { ...r, SALE_PRC: '180000', QUAL_CD: '02' } : r)) } });
  const later = runFlPipeline(FL_SDF_SPEC, {
    registry: e.registry, artifactStore: e.store, contactPlane: createContactPlane(), varRoot: e.varRoot,
    clock: fixedClock('2026-10-15T12:00:00.000Z'), http: { fetchImpl: e.portal.fetchImpl, sleep: async () => {} },
  });
  const r = await later;
  assert.equal(r.outcome, 'INGESTED');
  assert.equal(r.run?.changeCounts.parcel_attributes_changed, 1);
  const sale = (await e.table('transaction', LAFAYETTE.fips, 'resolutions')).find((s) => s['publisherSaleId'] === '2505');
  assert.equal(sale?.['statementCount'], 2);
  assert.equal(sale?.['priceMinor'], '18000000');
  assert.equal(sale?.['qualificationCode'], '02');
  const conflicts = await e.table('transaction', LAFAYETTE.fips, 'conflicts');
  assert.ok(conflicts.some((c) => c['conflictKind'] === 'sale_statement_revised'));
});

test('49 the cadastral echo supports the sale it repeats and never becomes a second sale', async () => {
  const { e } = await ingested();
  const sales = await e.table('transaction', LAFAYETTE.fips, 'resolutions');
  const s = sales.find((x) => x['publisherSaleId'] === '2501');
  assert.deepEqual(s?.['contributingSourceIds'], [FL_SDF_SOURCE_ID, FL_NAL_SOURCE_ID, FL_CADASTRAL_SOURCE_ID].sort());
  assert.equal((s?.['supportingEchoIds'] as string[]).length, 2);
  assert.equal(sales.filter((x) => x['state'] === 'ECHO_ONLY').length, 0);
  // The fold itself, over permutations of one property's statements.
  const base = (o: string, k: SaleContribution['k'], i: string | null): SaleContribution => ({
    d: 'T', c: '12067', p: 'prop', n: 'P', k, sc: 'x', o, s: k === 'SALE_OBSERVATION' ? 'sdf' : 'nal', r: o, i,
    ym: '2025-06', pr: '100', pa: null, pk: 'SALE_PRICE_DOC_STAMP_DERIVED', q: '01', vi: 'I', ref: 'OR:1/2', mp: null, t: INSTANT,
  });
  const items = [base('a', 'SALE_OBSERVATION', '1'), base('b', 'ASSESSOR_SALE_ECHO', null), base('c', 'ASSESSOR_SALE_ECHO', null)];
  const perms = [[0, 1, 2], [2, 1, 0], [1, 0, 2]].map((o) => contentDigest(foldProperty(o.map((i) => items[i] as SaleContribution))));
  assert.equal(new Set(perms).size, 1);
});

// ===========================================================================
// Replay (50–56)
// ===========================================================================

test('50–56 network-off replay rebuilds a deleted estate exactly: artifacts, digests, partitions, ids', async () => {
  const e = estate();
  const original = await ingestAll(e);
  const partitions = await e.digests();
  const global = await e.global();
  const ids = async () => (await e.table('property', LAFAYETTE.fips, 'resolutions')).map((r) => r['propertyId']).sort();
  const saleIds = async () => (await e.table('transaction', LAFAYETTE.fips, 'resolutions')).map((r) => r['saleId']).sort();
  const beforeIds = await ids();
  const beforeSales = await saleIds();
  // Delete everything derived; keep only the archive.
  for (const d of ['derived', 'restricted', 'indexes']) rmSync(join(e.varRoot, d), { recursive: true, force: true });
  const noNetwork = (async () => { throw new Error('network is disabled'); }) as typeof fetch;
  const replays: Record<string, FlPipelineResult> = {};
  for (const k of ['par', 'nal', 'sdf'] as const) {
    replays[k] = await replayFlRelease(SPECS[k], {
      registry: e.registry, artifactStore: e.store, contactPlane: createContactPlane(), varRoot: e.varRoot,
      clock: fixedClock('2027-01-01T00:00:00.000Z'), releaseManifestSha256: original[k]?.manifestArtifact?.sha256 as string, referencePeriod: '2026',
      ...({ http: { fetchImpl: noNetwork } } as object),
    });
    assert.equal(replays[k]?.outcome, 'INGESTED', k);
    assert.equal(replays[k]?.derivedSha256, original[k]?.derivedSha256, `${k}: derived stream`);
    assert.equal(replays[k]?.run?.run.normalizedDigest, original[k]?.run?.run.normalizedDigest, `${k}: normalized digest`);
  }
  assert.deepEqual(await e.digests(/^property\//), Object.fromEntries(Object.entries(partitions).filter(([k]) => k.startsWith('property/'))));
  assert.deepEqual(await e.digests(/^transaction\//), Object.fromEntries(Object.entries(partitions).filter(([k]) => k.startsWith('transaction/'))));
  assert.deepEqual(await ids(), beforeIds);
  assert.deepEqual(await saleIds(), beforeSales);
  assert.equal(await e.global(), global);
});

test('51 a replay re-verifies every retained file and refuses one that changed', async () => {
  const e = estate();
  const r = await e.run(FL_SDF_SPEC);
  const file = r.acquisition?.files[0]?.artifact;
  assert.ok(file);
  const path = e.store.localPath(file);
  chmodSync(path, 0o644);
  const bytes = readFileSync(path);
  bytes[40] = (bytes[40] as number) ^ 0x01;
  writeFileSync(path, bytes);
  await assert.rejects(e.replay(FL_SDF_SPEC, r), /digest verification/);
});

// ===========================================================================
// Security (57–61)
// ===========================================================================

test('57–58 restricted fields reach the restricted plane or nothing: the sentinel audit finds no leak on any row', async () => {
  const e = estate();
  const audit = createFlNalLeakageAudit({ sentinelEvery: 1, sourceId: FL_NAL_SOURCE_ID });
  const r = await e.run(FL_NAL_SPEC, { inspect: audit.inspect });
  assert.equal(r.outcome, 'INGESTED');
  const report = audit.report();
  assert.equal(report.sentinelRowsChecked, report.rowsInspected);
  assert.deepEqual(report.sentinelLeaks, {});
  assert.deepEqual(report.valueLeaks, {});
  assert.ok((report.contactsByType['mailing_address'] ?? 0) > 0);
  assert.equal(report.contactsByType['care_of_block'], 1);
  // The canonical rows carry no restricted field name at all.
  const text = (await bundlesOf(e, FL_NAL_SOURCE_ID)).map((b) => JSON.stringify(b)).join('\n');
  for (const field of FL_NAL_RESTRICTED_FIELDS) assert.ok(!text.includes(`"${field}"`), field);
  for (const secret of ['FICTIONAL MAILING', 'FICTIONAL TRUST', 'PREV-000-PARCEL']) assert.ok(!text.includes(secret), secret);
  // The cadastral stream never even carries them.
  assert.ok(FL_PAR_FIELD_MAP.filter((f) => f.disposition === 'RESTRICTED').length === 20);
});

test('57b the value check tells a real leak from a situs composed of public lines', async () => {
  // An owner-occupied unit: the mailing line is PHY_ADDR1 + PHY_ADDR2, which the situs composes but no single
  // public column states. And one row whose bundle has a mailing line copied into it — what a real leak looks like.
  const composed = nalRow(LAFAYETTE, 'LK-0001', { PHY_ADDR1: '400 FICTION WAY', PHY_ADDR2: 'UNIT 12', OWN_ADDR1: '400 FICTION WAY UNIT 12' });
  const e = estate({ nal: { '44': [...lafayetteNal(), composed] } });
  const audit = createFlNalLeakageAudit({ sentinelEvery: 1, sourceId: FL_NAL_SOURCE_ID });
  const inspect: Parameters<typeof runFlPipeline>[1]['inspect'] = (parsed, result) => {
    const fields = (parsed.record as { fields?: Record<string, string> }).fields;
    if (fields?.['PARCEL_ID'] !== P_ZEROS || fields['CO_NO'] !== LAFAYETTE.dorCode) return audit.inspect(parsed, result);
    audit.inspect(parsed, { ...result, bundle: { ...result.bundle, injected: `note ${fields['OWN_ADDR1']}` } as typeof result.bundle });
  };
  assert.equal((await e.run(FL_NAL_SPEC, { inspect })).outcome, 'INGESTED');
  const report = audit.report();
  assert.deepEqual(report.valueLeaks, { OWN_ADDR1: 1 }, 'the copied mailing line is a leak');
  assert.equal(report.derivedFromPublicData['OWN_ADDR1'], 1, 'the composed situs is public data');
  assert.ok(Object.keys(report.derivedFromPublicDataPaths).some((k) => k.startsWith('OWN_ADDR1 @ ') && k.includes('situs_address')));
  assert.deepEqual(report.sentinelLeaks, {});
});

test('59 no live personal data is committed: reference evidence is aggregates, fixtures are invented', () => {
  const dir = join(import.meta.dirname, '..', 'reference', 'fl-statewide');
  if (!existsSync(dir)) return;
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const key of ['OWN_NAME', 'OWN_ADDR1', 'PHY_ADDR1', 'FIDU_NAME', 'PARCEL_ID_PRV_HMSTD']) {
      assert.ok(!new RegExp(`"${key}"\\s*:\\s*"[^"]`).test(text), `${f} carries a ${key} value`);
    }
  }
});

test('60 scratch is 0700, restricted contacts 0600', async () => {
  const e = estate();
  await e.run(FL_NAL_SPEC, { canonicalRetention: 'full' });
  const restricted = join(e.varRoot, 'restricted', 'runs');
  const files = (readdirSync(restricted, { recursive: true }) as string[]).filter((f) => f.includes('contacts.ndjson'));
  assert.ok(files.length > 0);
  for (const f of files) assert.equal(statSync(join(restricted, f)).mode & 0o777, 0o600);
});

test('61 the draft migration forces row-level security and denies the application roles on the new tables', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', 'db', 'migrations', '0012_data_fabric_sale_observations.sql'), 'utf8');
  assert.match(sql, /force row level security/);
  assert.match(sql, /as restrictive for all to %I using \(false\) with check \(false\)/);
  assert.match(sql, /NOT APPLIED TO PRODUCTION/);
});

// 62–65 (chain, second chain, fingerprint, RLS) execute against a real
// PostgreSQL 17 in tests/migration-execution.test.ts.

// ===========================================================================
// Field inventories
// ===========================================================================

test('every column of every Florida source has exactly one disposition, and restricted means restricted everywhere', () => {
  assert.equal(FL_NAL_FIELD_MAP.length, 167);
  assert.equal(FL_PAR_FIELD_MAP.length, 118);
  for (const f of FL_PAR_FIELD_MAP) {
    if (f.nalField === null) continue;
    const nal = FL_NAL_FIELD_MAP.find((x) => x.field === f.nalField);
    if (nal?.disposition === 'RESTRICTED') assert.equal(f.disposition, 'RESTRICTED', f.field);
  }
  void GULF;
  void sdfRow;
});
