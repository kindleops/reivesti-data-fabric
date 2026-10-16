/**
 * National multi-state integration (DF-0O): the regression matrix that keeps
 * Minnesota, Wisconsin and New York — and whichever state comes next — honest
 * together.
 *
 *   registry   one lifecycle per mapping, derived; nothing manual-only,
 *              prohibited or unpriced can read as automated core; totals are
 *              computed, never typed in; NOT_SUPPORTED where nothing claims a
 *              capability; Florida's sale observations are not transfers, and
 *              no transfer, deed, mortgage or lien is claimed live
 *   identity   pinned ids per state, cross-state distinctness, and an identity
 *              contract for every source that mints a property id
 *   orgs       the national organization fold records which runs it read and
 *              is PARTIAL — never national — when one is missing
 *   capacity   the preflight refuses before anything is downloaded or written
 *   scratch    run-owned scratch; only a provably dead owner's is removed
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { isFabricError } from '../src/core/errors.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { assessActivation } from '../src/registry/policy.ts';
import {
  DASHBOARD_CAPABILITIES,
  LIFECYCLE_ORDER,
  automatedCoreJurisdictions,
  capabilityCoverage,
  lifecycleOf,
  sourceLifecycles,
} from '../src/registry/lifecycle.ts';
import { normalizeParcelId, propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { IDENTITY_CONTRACTS, identityContractOf } from '../src/canonical/identity-inventory.ts';
import { wiParcelIdentity, WI_PARCEL_IDENTIFIER_SCHEME } from '../src/connectors/wi-statewide-parcels/identity.ts';
import { nyParcelIdentity, NY_PARCEL_IDENTIFIER_SCHEME } from '../src/connectors/ny-statewide-parcels/identity.ts';
import { flParcelIdentity, FL_PARCEL_IDENTIFIER_SCHEME } from '../src/connectors/fl-dor/identity.ts';
import { assessOrganizationCompleteness, organizationCompletenessOf } from '../src/canonical/organization-completeness.ts';
import { nationPartition } from '../src/canonical/partitions.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import { assertCapacity, planFromProfile, preflightCapacity, type CapacityProbe } from '../src/runtime/capacity.ts';
import { claimScratch, cleanOrphanedScratch, listScratch, SCRATCH_OWNER_FILE, type ScratchHost } from '../src/runtime/scratch.ts';
import { NY_FOOTPRINT, runNyStatewidePipeline } from '../src/connectors/ny-statewide-parcels/pipeline.ts';
import { WI_FOOTPRINT } from '../src/connectors/wi-statewide-parcels/pipeline.ts';
import { RUN_INSTANT, hennepinFixture, streamHarness, tempRoot } from './helpers.ts';
import { buildNyRelease, nyFakePublisher, nyParcel } from './support/ny-fixture.ts';

const GIB = 1024 ** 3;
const registry = defaultRegistry();

// ---------------------------------------------------------------------------
// Registry and source graph
// ---------------------------------------------------------------------------

test('registry: source and mapping ids are unique, and every mapping names a registered source', () => {
  const sources = registry.sources.map((s) => s.sourceId);
  assert.equal(new Set(sources).size, sources.length, 'duplicate source id');
  const mappings = registry.mappings.map((m) => m.mappingId);
  assert.equal(new Set(mappings).size, mappings.length, 'duplicate mapping id');
  for (const m of registry.mappings) assert.ok(sources.includes(m.sourceId), `${m.mappingId} names an unknown source`);
});

test('registry: every source and mapping has exactly one derived lifecycle from the fixed set', () => {
  const rows = sourceLifecycles(registry);
  for (const s of registry.sources) assert.ok(rows.some((r) => r.sourceId === s.sourceId), `${s.sourceId} has no lifecycle`);
  for (const r of rows) assert.ok(LIFECYCLE_ORDER.includes(r.lifecycle), `${r.sourceId}: ${r.lifecycle}`);
  const keys = rows.map((r) => `${r.sourceId}/${r.mappingId}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('registry: nothing manual-only, prohibited, paid or unpriced is ever ACTIVE_AUTOMATED_CORE', () => {
  for (const row of sourceLifecycles(registry)) {
    const source = registry.source(row.sourceId);
    if (row.lifecycle !== 'ACTIVE_AUTOMATED_CORE') continue;
    assert.equal(assessActivation(source).verdict, 'CORE_ELIGIBLE', row.sourceId);
    assert.equal(source.automationStatus, 'sanctioned', row.sourceId);
    assert.ok(source.costClass !== undefined && source.costClass !== 'UNKNOWN_COST', row.sourceId);
    assert.equal(row.mappingStatus, 'active', row.sourceId);
  }
  // And the ones that must not be, by name.
  const life = (id: string) => sourceLifecycles(registry).filter((r) => r.sourceId === id).map((r) => r.lifecycle);
  assert.deepEqual(life('mn_hennepin_recorded_instruments'), ['BLOCKED_AUTOMATION']);
  assert.deepEqual(life('mn_dor_ecrv_weekly_sales_extract'), ['BLOCKED_ACCESS']);
  assert.deepEqual(life('wi_dor_retr_historical'), ['FIXTURE_ONLY']);
  assert.deepEqual(life('mn_sos_business_entities'), ['DEFERRED']);
  assert.deepEqual(life('tx_dallas_foreclosure_notices'), ['UNKNOWN']);
  assert.deepEqual(life('ny_statewide_parcel_polygons'), ['DEFERRED'], 'validation-only polygons never count');
});

test('registry: a lifecycle follows the facts — an unsanctioned copy of a core source is not automated core', () => {
  const ny = registry.source('ny_statewide_parcels');
  const mapping = registry.mapping('ny_statewide_parcels__all_ny_counties');
  assert.equal(lifecycleOf(ny, mapping).lifecycle, 'ACTIVE_AUTOMATED_CORE');
  assert.notEqual(lifecycleOf({ ...ny, automationStatus: 'manual_only' }, mapping).lifecycle, 'ACTIVE_AUTOMATED_CORE');
  assert.notEqual(lifecycleOf({ ...ny, costClass: 'UNKNOWN_COST' }, mapping).lifecycle, 'ACTIVE_AUTOMATED_CORE');
  assert.equal(lifecycleOf(ny, { ...mapping, status: 'planned' }).lifecycle, 'CORE_ELIGIBLE_NOT_INGESTED');
  assert.equal(lifecycleOf(ny, { ...mapping, status: 'fixture_only' }).lifecycle, 'FIXTURE_ONLY');
});

test('registry: the state baselines are 59 / 72 / 62 / 67 and the national parcel total is computed from them', () => {
  const count = (mappingId: string) => registry.expand(registry.mapping(mappingId)).length;
  assert.equal(count('mn_statewide_parcels__opt_in_counties'), 59);
  assert.equal(count('wi_statewide_parcels__all_wi_counties'), 72);
  assert.equal(count('ny_statewide_parcels__all_ny_counties'), 62);
  for (const fl of ['fl_statewide_cadastral__all_fl_counties', 'fl_dor_nal__all_fl_counties', 'fl_dor_sdf__all_fl_counties']) {
    assert.equal(count(fl), 67, fl);
  }
  // Hennepin's own feed is inside Minnesota's 59, and Florida's map and roll
  // cover the same 67, so the union is the sum of the four states.
  assert.equal(automatedCoreJurisdictions(registry, 'PARCEL'), 59 + 72 + 62 + 67);
  const coverage = capabilityCoverage(registry);
  const parcel = (state: string) => coverage.find((c) => c.stateCode === state && c.capability === 'PARCEL')!;
  assert.equal(parcel('MN').byLifecycle.ACTIVE_AUTOMATED_CORE, 59);
  assert.equal(parcel('WI').byLifecycle.ACTIVE_AUTOMATED_CORE, 72);
  assert.equal(parcel('NY').byLifecycle.ACTIVE_AUTOMATED_CORE, 62);
  assert.equal(parcel('FL').byLifecycle.ACTIVE_AUTOMATED_CORE, 67);
  // A state the registry does not cover is not in the table — it is not "zero percent covered".
  assert.equal(coverage.some((c) => c.stateCode === 'CA'), false);
});

test('registry: NOT_SUPPORTED wherever no source claims a capability, and every county is counted once', () => {
  const coverage = capabilityCoverage(registry);
  const cell = (state: string, capability: string) => coverage.find((c) => c.stateCode === state && c.capability === capability)!;
  for (const c of coverage) {
    const total = Object.values(c.byLifecycle).reduce((a, b) => a + (b ?? 0), 0);
    assert.equal(total, c.countyEquivalents, `${c.stateCode} ${c.capability}`);
  }
  assert.deepEqual(cell('NY', 'TAX').byLifecycle, { NOT_SUPPORTED: 62 }, 'NY carries no tax amount');
  assert.deepEqual(cell('NY', 'SALE_OBSERVATION').byLifecycle, { NOT_SUPPORTED: 62 });
  assert.deepEqual(cell('WI', 'SALE_OBSERVATION').byLifecycle, { NOT_SUPPORTED: 72 }, 'WI V12 has no sale fields');
  assert.equal(cell('MN', 'SALE_OBSERVATION').byLifecycle.ACTIVE_AUTOMATED_CORE, 59, 'MN assessor sale echo');
  assert.deepEqual(cell('FL', 'SALE_OBSERVATION').byLifecycle, { ACTIVE_AUTOMATED_CORE: 67 }, 'FL SDF');
  assert.deepEqual(cell('FL', 'SALE_ECONOMICS').byLifecycle, { ACTIVE_AUTOMATED_CORE: 67 }, 'FL doc-stamp-derived price');
  assert.deepEqual(cell('FL', 'TAX').byLifecycle, { ACTIVE_AUTOMATED_CORE: 67 }, 'FL NAL');
  assert.equal(coverage.filter((c) => c.capability === 'PARCEL').length, new Set(coverage.map((c) => c.stateCode)).size);
  assert.deepEqual([...new Set(coverage.map((c) => c.capability))], [...DASHBOARD_CAPABILITIES]);
});

test('registry: no transfer, deed, mortgage, lien or foreclosure is claimed live anywhere; sale economics only where published', () => {
  // Florida's SDF price is the publisher's doc-stamp derivation (SALE_ECONOMICS),
  // and only there: a sale observation is never a transfer, deed or declaration.
  assert.equal(automatedCoreJurisdictions(registry, 'SALE_ECONOMICS'), 67);
  for (const c of capabilityCoverage(registry).filter((x) => x.capability === 'SALE_ECONOMICS' && x.stateCode !== 'FL')) {
    assert.equal(c.byLifecycle.ACTIVE_AUTOMATED_CORE, undefined, `${c.stateCode} SALE_ECONOMICS`);
  }
  for (const capability of ['TRANSFER', 'DEED', 'MORTGAGE', 'MORTGAGE_RELEASE', 'LIEN', 'FORECLOSURE_NOTICE'] as const) {
    assert.equal(automatedCoreJurisdictions(registry, capability), 0, capability);
    for (const c of capabilityCoverage(registry).filter((x) => x.capability === capability)) {
      assert.equal(c.byLifecycle.ACTIVE_AUTOMATED_CORE, undefined, `${c.stateCode} ${capability}`);
    }
  }
});

test('registry: df national reports computed totals and df auto dispatches exactly the pipelines that exist', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'df.ts');
  const env = { ...process.env, DF_VAR: tempRoot('df-natcli-') };
  const report = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'national'], { env }).toString()) as {
    automatedCoreJurisdictions: Record<string, number>;
  };
  assert.equal(report.automatedCoreJurisdictions['PARCEL'], automatedCoreJurisdictions(registry, 'PARCEL'));
  for (const mappingId of ['ny_statewide_parcels__all_ny_counties', 'wi_statewide_parcels__all_wi_counties']) {
    assert.ok(registry.mapping(mappingId), mappingId);
  }
  let status = 0;
  try {
    execFileSync(process.execPath, ['--no-warnings', cli, 'auto', 'hennepin_recorder__hennepin'], { env, stdio: 'pipe' });
  } catch (e) {
    status = (e as { status: number }).status;
  }
  assert.equal(status, 2, 'a blocked source has no unattended pipeline to dispatch');
});

// ---------------------------------------------------------------------------
// Property identity
// ---------------------------------------------------------------------------

test('identity: pinned property ids for each state do not move', () => {
  assert.equal(propertyIdFromCountyParcel('27053', normalizeParcelId('02-028-24-41-0097')), 'prop_265548f625d901771894553b1a30b9d0');
  assert.equal(wiParcelIdentity('55009', '1-1109').propertyId, 'prop_47be46856166a44ef89da4ebb791055d');
  assert.equal(wiParcelIdentity('55009', '11-109').propertyId, 'prop_94b3b400a9f5a2860f1aae0bcc30db78');
  assert.equal(nyParcelIdentity('36001', '010100', '00100000010010000000').propertyId, 'prop_758bf9dbac68cda8dbbdf541c3e16351');
  assert.equal(nyParcelIdentity('36047', '610100', '3012340056').propertyId, 'prop_84da89525abc661b9a39e0ad933a780a');
  assert.equal(flParcelIdentity('12086', '01-3132-001-0010').propertyId, 'prop_a16922693a29b587f506144136627c5b');
  // Leading zeros are identity in Florida.
  assert.equal(flParcelIdentity('12086', '0000012345').propertyId, 'prop_b9abd6f0b09b2e8e1d58f5c5cc191947');
  assert.equal(flParcelIdentity('12086', '12345').propertyId, 'prop_1136b0b259e72c48b5b68d0794712964');
});

test('identity: the same parcel string in MN, WI, NY and FL is four properties; a reused identifier never collides', () => {
  const ids = new Set([
    propertyIdFromCountyParcel('27053', '1234'),
    propertyIdFromCountyParcel('55009', '1234'),
    propertyIdFromCountyParcel('36001', '1234'),
    propertyIdFromCountyParcel('12086', '1234'),
  ]);
  assert.equal(ids.size, 4);
  // Minnesota folds punctuation; Wisconsin keeps it. The same raw string is
  // two different normalized parcels — and, scoped by county, two ids anyway.
  assert.equal(normalizeParcelId('1-1109'), '11109');
  assert.equal(wiParcelIdentity('55009', '1-1109').normalizedParcel, '1-1109');
  assert.notEqual(wiParcelIdentity('55009', '1-1109').propertyId, wiParcelIdentity('55009', '11-109').propertyId);
});

test('identity: every source that mints property ids has a contract, and the contract matches the code', () => {
  for (const row of sourceLifecycles(registry)) {
    if (row.lifecycle !== 'ACTIVE_AUTOMATED_CORE' || !row.capabilities.includes('parcel')) continue;
    const contract = identityContractOf(row.sourceId);
    assert.ok(contract, `${row.sourceId} has no identity contract`);
    assert.equal(contract.derivation, 'propertyIdFromCountyParcel(countyFips, normalizedParcel)');
    assert.equal(contract.leadingZeros, 'PRESERVED');
  }
  assert.equal(identityContractOf('wi_statewide_parcels')!.scheme, WI_PARCEL_IDENTIFIER_SCHEME);
  assert.equal(identityContractOf('ny_statewide_parcels')!.scheme, NY_PARCEL_IDENTIFIER_SCHEME);
  for (const fl of ['fl_dor_nal', 'fl_statewide_cadastral', 'fl_dor_sdf']) {
    assert.equal(identityContractOf(fl)!.scheme, FL_PARCEL_IDENTIFIER_SCHEME, fl);
  }
  assert.equal(identityContractOf('mn_statewide_parcels')!.scheme, 'PUNCTUATION_FOLDED');
  const fips = new Map<string, string>();
  for (const c of IDENTITY_CONTRACTS) {
    assert.equal(fips.get(c.stateCode) ?? c.stateFips, c.stateFips);
    fips.set(c.stateCode, c.stateFips);
  }
  assert.equal(new Set(fips.values()).size, fips.size, 'two states share a FIPS prefix');
});

// ---------------------------------------------------------------------------
// National organization completeness
// ---------------------------------------------------------------------------

test('organizations: the completeness rule is a watermark — any expected run missing makes it PARTIAL', () => {
  assert.equal(assessOrganizationCompleteness(['r1', 'r2'], ['r1', 'r2', 'r3']).status, 'FULL_NATIONAL');
  const partial = assessOrganizationCompleteness(['r2', 'r1', 'r1'], ['r2']);
  assert.equal(partial.status, 'PARTIAL');
  assert.deepEqual(partial.missingRuns, ['r1']);
  assert.deepEqual(partial.expectedRuns, ['r1', 'r2']);
  assert.equal(organizationCompletenessOf(null), 'ABSENT');
  assert.equal(organizationCompletenessOf({}), 'UNVERIFIED', 'a fold from before DF-0O is not presumed complete');
});

test('organizations: a fold over a released run is recorded PARTIAL, names the run, and is never reported national', async () => {
  const h = streamHarness();
  const first = await h.run(hennepinFixture('snapshot-2026-08.ndjson'));
  assert.equal(first.run.status, 'completed');
  const partitions = createPartitionStore(h.varRoot);
  const orgKey = nationPartition('ORGANIZATION_RESOLUTION');
  const full = (await partitions.manifest(orgKey))!;
  assert.equal(full.completeness?.status, 'FULL_NATIONAL');
  assert.deepEqual(full.completeness?.contributingRuns, [first.run.runId]);

  // Release the first run's canonical tables, as DF-0N did for disk.
  rmSync(join(h.varRoot, 'derived', 'runs', first.run.runId), { recursive: true, force: true });
  rmSync(join(h.varRoot, 'restricted', 'runs', first.run.runId), { recursive: true, force: true });

  const { logger, records } = captureLogger();
  const second = await h.run(hennepinFixture('snapshot-2026-09.ndjson'), { period: '2026-09', logger });
  assert.equal(second.run.status, 'completed');
  const manifest = (await partitions.manifest(orgKey))!;
  assert.equal(manifest.completeness?.status, 'PARTIAL');
  assert.deepEqual(manifest.completeness?.missingRuns, [first.run.runId]);
  assert.ok(records.some((r) => r.event === 'partition.organization_partial'), 'the partial fold is logged');

  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'df.ts');
  const report = JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'organizations'], {
    env: { ...process.env, DF_VAR: h.varRoot },
  }).toString()) as { recorded: string; estateNow: string; national: boolean; missingRuns: string[] };
  assert.equal(report.recorded, 'PARTIAL');
  assert.equal(report.estateNow, 'PARTIAL');
  assert.equal(report.national, false);
  assert.deepEqual(report.missingRuns, [first.run.runId]);
});

// ---------------------------------------------------------------------------
// Capacity preflight
// ---------------------------------------------------------------------------

function probe(o: { varBytes: number; scratchBytes?: number; sameDevice?: boolean; tmpfs?: boolean; freeMemory?: number }): CapacityProbe {
  return {
    availableBytes: async (p) => (p.endsWith('scratch') ? o.scratchBytes ?? o.varBytes : o.varBytes),
    device: async (p) => (o.sameDevice === false && p.endsWith('scratch') ? 2 : 1),
    isTmpfs: async () => o.tmpfs ?? false,
    freeMemoryBytes: () => o.freeMemory ?? 64 * GIB,
  };
}

test('capacity: a full statewide plan is sized from the measured profile, with margin', async () => {
  const varRoot = tempRoot('df-cap-');
  const plan = planFromProfile('ny full', NY_FOOTPRINT, 5_510_061, { publisherArchive: 562_761_366 });
  const fits = await preflightCapacity(varRoot, plan, { probe: probe({ varBytes: 40 * GIB }) });
  assert.equal(fits.ok, true);
  assert.ok(fits.varRoot.needBytes > 20 * GIB && fits.varRoot.needBytes < 30 * GIB, `${fits.varRoot.needBytes}`);
  const short = await preflightCapacity(varRoot, plan, { probe: probe({ varBytes: 4 * GIB }) });
  assert.equal(short.ok, false);
  assert.throws(() => assertCapacity(short), (e: unknown) => isFabricError(e, 'CONFIG') && /insufficient capacity/.test((e as Error).message));
  // A fresh worker has no var root yet: the real probe measures where it will be.
  const fresh = await preflightCapacity(join(varRoot, 'not', 'yet', 'var'), planFromProfile('tiny', NY_FOOTPRINT, 10));
  assert.equal(fresh.ok, true);
  assert.ok(fresh.varRoot.availableBytes > 0);
  // A forced run whose partitions are already live writes none.
  const forced = planFromProfile('ny forced', NY_FOOTPRINT, 5_510_061, {}, { partitionsAlreadyLive: true });
  assert.equal(forced.durable['partitions'], 0);
  assert.ok(planFromProfile('wi', WI_FOOTPRINT, 3_574_646).scratch > 0);
});

test('capacity: separate scratch must fit its own volume, and tmpfs scratch must also fit free memory', async () => {
  const varRoot = tempRoot('df-cap2-');
  mkdirSync(join(varRoot, 'scratch'));
  const plan = { label: 'x', durable: { a: 10 * GIB }, scratch: 5 * GIB };
  assert.equal((await preflightCapacity(varRoot, plan, { probe: probe({ varBytes: 12 * GIB, scratchBytes: 6 * GIB, sameDevice: false }) })).ok, true);
  const noRoom = await preflightCapacity(varRoot, plan, { probe: probe({ varBytes: 12 * GIB, scratchBytes: 4 * GIB, sameDevice: false }) });
  assert.match(noRoom.reasons.join(), /scratch filesystem/);
  const ram = await preflightCapacity(varRoot, plan, {
    probe: probe({ varBytes: 12 * GIB, scratchBytes: 16 * GIB, sameDevice: false, tmpfs: true, freeMemory: 6 * GIB }),
  });
  assert.equal(ram.ok, false);
  assert.match(ram.reasons.join(), /tmpfs \(RAM\)/);
  // Same filesystem: durable and scratch share it.
  assert.equal((await preflightCapacity(varRoot, plan, { probe: probe({ varBytes: 14 * GIB }) })).ok, false);
});

test('capacity: the New York pipeline refuses before downloading anything when the run cannot fit', async () => {
  const publisher = nyFakePublisher();
  publisher.publish(buildNyRelease({ rollYear: 2025, build: '2605', rows: [nyParcel('Albany', '010100', '00100000010010000000')] }));
  const h = streamHarness();
  await assert.rejects(runNyStatewidePipeline({
    registry, artifactStore: h.artifactStore, contactPlane: h.contactPlane, varRoot: h.varRoot,
    clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger,
    http: { fetchImpl: publisher.fetchImpl, sleep: async () => {} }, retainCompanion: false,
    capacityProbe: probe({ varBytes: 1024 }),
  }), /insufficient capacity/);
  assert.equal(existsSync(join(h.root, 'archive')) ? readdirSync(join(h.root, 'archive')).length : 0, 0, 'nothing downloaded');
  assert.equal(existsSync(join(h.varRoot, 'derived', 'runs')), false, 'nothing derived');
});

// ---------------------------------------------------------------------------
// Scratch ownership
// ---------------------------------------------------------------------------

function host(o: { alive?: readonly number[]; startedAt?: Date | null; name?: string; boot?: string } = {}): ScratchHost {
  return {
    host: o.name ?? 'worker-a',
    bootId: o.boot ?? 'boot-1',
    isAlive: (pid) => (o.alive ?? []).includes(pid),
    processStartedAt: async () => o.startedAt ?? null,
  };
}

test('scratch: a claimed directory is owner-only and stamped with its owner', async () => {
  const varRoot = tempRoot('df-scr-');
  const dir = await claimScratch(varRoot, 'run', host());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, SCRATCH_OWNER_FILE)).mode & 0o777, 0o600);
  const [entry] = await listScratch(varRoot, host({ alive: [process.pid] }));
  assert.equal(entry!.status, 'LIVE');
  assert.equal(entry!.owner!.purpose, 'run');
});

test('scratch: only a provably dead owner\'s scratch is removed; live, unowned and foreign scratch is kept', async () => {
  const varRoot = tempRoot('df-scr2-');
  const live = await claimScratch(varRoot, 'run', host());
  const dead = join(varRoot, 'scratch', 'run-dead');
  mkdirSync(dead);
  writeFileSync(join(dead, SCRATCH_OWNER_FILE), JSON.stringify({ pid: 999_999, host: 'worker-a', bootId: 'boot-1', startedAt: '2026-01-01T00:00:00Z', purpose: 'run' }));
  writeFileSync(join(dead, 'contributions.ndjson'), 'x'.repeat(100));
  const reused = join(varRoot, 'scratch', 'run-reused');
  mkdirSync(reused);
  writeFileSync(join(reused, SCRATCH_OWNER_FILE), JSON.stringify({ pid: process.pid, host: 'worker-a', bootId: 'boot-1', startedAt: '2020-01-01T00:00:00Z', purpose: 'run' }));
  const foreign = join(varRoot, 'scratch', 'run-foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, SCRATCH_OWNER_FILE), JSON.stringify({ pid: 1, host: 'worker-b', bootId: 'boot-9', startedAt: '2026-01-01T00:00:00Z', purpose: 'run' }));
  const unowned = join(varRoot, 'scratch', 'run-legacy');
  mkdirSync(unowned);

  const h = host({ alive: [process.pid], startedAt: new Date('2026-06-01T00:00:00Z') });
  const status = Object.fromEntries((await listScratch(varRoot, h)).map((e) => [e.name, e.status]));
  assert.equal(status['run-dead'], 'ORPHANED');
  assert.equal(status['run-reused'], 'ORPHANED', 'a pid reused by a later process is not the owner');
  assert.equal(status['run-foreign'], 'UNVERIFIABLE');
  assert.equal(status['run-legacy'], 'UNOWNED');

  const { removed, kept } = await cleanOrphanedScratch(varRoot, h);
  assert.deepEqual(removed.map((e) => e.name).sort(), ['run-dead', 'run-reused']);
  assert.ok(kept.some((e) => e.path === live));
  assert.ok(existsSync(live) && existsSync(foreign) && existsSync(unowned));
  assert.equal(existsSync(dead), false);
  assert.ok(removed.find((e) => e.name === 'run-dead')!.bytes >= 100);
});
