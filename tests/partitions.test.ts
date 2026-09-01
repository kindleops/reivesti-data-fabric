/**
 * Projection partitioning: the fix for the carried whole-estate-fold P1.
 *
 * The claim under test is narrow and checkable: **changing one county recomputes
 * one county.** Not "recomputes less", not "is faster on average" — zero bytes
 * written anywhere else. A partition that quietly re-runs is a partition that
 * will re-run 3,222 times at national scale.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../src/core/hash.ts';
import { isFabricError } from '../src/core/errors.ts';
import {
  DOMAIN_SCOPE,
  countyPartition,
  globalDigest,
  nationPartition,
  parsePartitionId,
  partitionId,
  planPartitions,
  type PartitionKey,
} from '../src/canonical/partitions.ts';
import { propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { parcelAuthorityFor } from '../src/canonical/property-resolution.ts';
import type { ResolutionContribution } from '../src/canonical/resolution-projection.ts';
import { createPartitionStore, type PartitionStore } from '../src/runtime/partition-store.ts';
import { recomputePartitions } from '../src/runtime/partition-projection.ts';
import { tempRoot } from './helpers.ts';

const AUTHORITY = parcelAuthorityFor(['assessor']);
const AT = '2026-08-31T12:00:00.000Z';

const HENNEPIN = '27053';
const RAMSEY = '27123';
const DALLAS = '48113';

function contribution(countyFips: string, parcel: string, over: Partial<ResolutionContribution> = {}): ResolutionContribution {
  return {
    p: propertyIdFromCountyParcel(countyFips, parcel),
    c: countyFips,
    n: parcel,
    o: `obs-${countyFips}-${parcel}`,
    s: 'assessor',
    r: `rec-${countyFips}-${parcel}`,
    st: 'resolved',
    f: 'final',
    a: null,
    t: AT,
    ...over,
  };
}

async function seed(
  store: PartitionStore,
  runId: string,
  rows: readonly ResolutionContribution[],
): Promise<void> {
  const byCounty = new Map<string, ResolutionContribution[]>();
  for (const row of rows) {
    const list = byCounty.get(row.c) ?? [];
    list.push(row);
    byCounty.set(row.c, list);
  }
  for (const [county, list] of byCounty) {
    async function* lines(): AsyncGenerator<string> {
      for (const row of list) yield canonicalJson(row);
    }
    await store.writeContributions(countyPartition('PROPERTY_RESOLUTION', county), runId, lines());
  }
}

async function project(store: PartitionStore, ids: readonly string[], runId: string) {
  return recomputePartitions({
    partitions: store, partitionIds: ids, authority: AUTHORITY, runId, detectedAt: AT,
    sort: { chunkLines: 8 },
  });
}

/** Generation directory name + mtime of every partition — the "was it rewritten" probe. */
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

async function threeCountyEstate(): Promise<{ root: string; store: PartitionStore }> {
  const root = tempRoot('df-part-');
  const store = createPartitionStore(root);
  await seed(store, 'run-1', [
    contribution(HENNEPIN, '0202824410097'),
    contribution(HENNEPIN, '0202824410098'),
    contribution(RAMSEY, '0202824410097'),
    contribution(RAMSEY, '112233445566'),
    contribution(DALLAS, '0202824410097'),
  ]);
  const ids = [HENNEPIN, RAMSEY, DALLAS].map((c) => partitionId(countyPartition('PROPERTY_RESOLUTION', c)));
  await project(store, ids, 'run-1');
  return { root, store };
}

// ===========================================================================
// The key model
// ===========================================================================

test('partition ids round-trip, and the domain decides the scope', () => {
  const property = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
  assert.equal(partitionId(property), 'property/us-county-27053');
  assert.deepEqual(parsePartitionId('property/us-county-27053'), property);

  const org = nationPartition('ORGANIZATION_RESOLUTION');
  assert.equal(partitionId(org), 'organization/us');
  assert.deepEqual(parsePartitionId('organization/us'), org);
});

test('a county-scoped domain refuses a national partition, and vice versa', () => {
  // Getting this wrong is not a typo, it is a category error: it would either
  // fold unrelated counties together or scatter one identity across thousands
  // of buckets.
  assert.throws(() => nationPartition('PROPERTY_RESOLUTION'), (e: unknown) => isFabricError(e, 'CONFIG'));
  assert.throws(() => countyPartition('ORGANIZATION_RESOLUTION', HENNEPIN), (e: unknown) => isFabricError(e, 'CONFIG'));
});

test('organization identity is deliberately NOT county-scoped', () => {
  // A company observed as an owner in Hennepin may be registered in Delaware.
  // Scoping it to the county would make identity depend on where it happened to
  // be seen, which is the definition of a wrong partition key.
  assert.equal(DOMAIN_SCOPE.ORGANIZATION_RESOLUTION, 'nation');
  assert.equal(DOMAIN_SCOPE.PROPERTY_RESOLUTION, 'county');
});

test('a partition scope must be a real jurisdiction', () => {
  assert.throws(() => countyPartition('PROPERTY_RESOLUTION', ''), (e: unknown) => isFabricError(e, 'CONFIG'));
  assert.throws(() => countyPartition('PROPERTY_RESOLUTION', '27'), (e: unknown) => isFabricError(e, 'CONFIG'));
});

// ===========================================================================
// The planner
// ===========================================================================

test('the plan comes from observed jurisdictions, not from the declared scope', () => {
  const plan = planPartitions({
    runId: 'r', observedCountyFips: [HENNEPIN], producedOrganizationRows: false, producedTransactionRows: false,
  });
  assert.deepEqual(plan.partitions, ['property/us-county-27053']);
  assert.deepEqual(plan.observedJurisdictionIds, ['us-county-27053']);
});

test('a run that names an organization plans the national partition too', () => {
  const plan = planPartitions({
    runId: 'r', observedCountyFips: [HENNEPIN], producedOrganizationRows: true, producedTransactionRows: false,
  });
  assert.deepEqual(plan.partitions, ['organization/us', 'property/us-county-27053']);
});

test('a run that observed nothing plans nothing', () => {
  const plan = planPartitions({
    runId: 'r', observedCountyFips: [], producedOrganizationRows: false, producedTransactionRows: false,
  });
  assert.deepEqual(plan.partitions, []);
});

test('the plan is deterministic and duplicate-free', () => {
  const a = planPartitions({ runId: 'r', observedCountyFips: [RAMSEY, HENNEPIN, HENNEPIN], producedOrganizationRows: false, producedTransactionRows: false });
  const b = planPartitions({ runId: 'r', observedCountyFips: [HENNEPIN, RAMSEY], producedOrganizationRows: false, producedTransactionRows: false });
  assert.deepEqual(a.partitions, b.partitions);
  assert.equal(a.partitions.length, 2);
});

// ===========================================================================
// Isolation — the point of the whole exercise
// ===========================================================================

test('changing one county recomputes that county and rewrites nothing else', async () => {
  const { root, store } = await threeCountyEstate();
  const before = await fingerprints(root);
  assert.equal(Object.keys(before).length, 3);

  // One new Hennepin observation arrives.
  await seed(store, 'run-2', [contribution(HENNEPIN, '0202824410099')]);
  const hennepinId = partitionId(countyPartition('PROPERTY_RESOLUTION', HENNEPIN));
  const recomputed = await project(store, [hennepinId], 'run-2');

  assert.deepEqual(recomputed.activations.map((a) => a.state), ['activated']);
  const after = await fingerprints(root);

  assert.notEqual(after[hennepinId], before[hennepinId], 'Hennepin must have been recomputed');
  for (const county of [RAMSEY, DALLAS]) {
    const id = partitionId(countyPartition('PROPERTY_RESOLUTION', county));
    assert.equal(after[id], before[id], `${county} was rewritten and must not have been`);
  }
});

test('the global digest changes only through the affected child digest', async () => {
  const { root, store } = await threeCountyEstate();
  const first = await store.manifests();
  const firstGlobal = globalDigest(first);

  await seed(store, 'run-2', [contribution(HENNEPIN, '0202824410099')]);
  await project(store, [partitionId(countyPartition('PROPERTY_RESOLUTION', HENNEPIN))], 'run-2');

  const second = await store.manifests();
  const secondGlobal = globalDigest(second);
  assert.notEqual(firstGlobal, secondGlobal);

  const changed = second.filter((m) => {
    const prior = first.find((p) => p.partitionId === m.partitionId);
    return prior?.outputDigest !== m.outputDigest;
  });
  assert.deepEqual(changed.map((m) => m.partitionId), ['property/us-county-27053']);

  // And the global digest is reconstructible from the children alone, which is
  // what makes a one-county update an O(1) global-digest update rather than an
  // O(estate) re-fold.
  assert.equal(globalDigest(second), secondGlobal);
});

test('the same parcel string in three counties is three properties, never one', async () => {
  const { root, store } = await threeCountyEstate();
  void root;
  const ids: string[] = [];
  for (const county of [HENNEPIN, RAMSEY, DALLAS]) {
    const key = countyPartition('PROPERTY_RESOLUTION', county);
    for await (const line of store.readTable(key, 'resolutions')) {
      const row = JSON.parse(line) as { propertyId: string; normalizedParcel: string; countyFips: string };
      if (row.normalizedParcel === '0202824410097') ids.push(`${row.countyFips}:${row.propertyId}`);
    }
  }
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids.map((i) => i.split(':')[1])).size, 3, 'parcel strings collided across counties');
});

test('the same address in two counties never produces a cross-county conflict', async () => {
  const root = tempRoot('df-addr-');
  const store = createPartitionStore(root);
  const address = '100 MAIN ST';
  await seed(store, 'run-1', [
    contribution(HENNEPIN, 'AAA', { a: address }),
    contribution(RAMSEY, 'BBB', { a: address }),
  ]);
  const ids = [HENNEPIN, RAMSEY].map((c) => partitionId(countyPartition('PROPERTY_RESOLUTION', c)));
  const result = await project(store, ids, 'run-1');
  const crossCounty = result.conflicts.filter((c) => c.conflictKind === 'address_matches_different_pid');
  assert.deepEqual(crossCounty, [], 'one address in two counties is two addresses');
});

// ===========================================================================
// Determinism, replay and atomicity
// ===========================================================================

test('recomputing a partition twice produces the same digest', async () => {
  const { store } = await threeCountyEstate();
  const key = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
  const before = await store.manifest(key);
  await project(store, [partitionId(key)], 'run-replay');
  const after = await store.manifest(key);
  assert.equal(after?.outputDigest, before?.outputDigest);
  assert.equal(after?.inputDigest, before?.inputDigest);
  assert.notEqual(after?.generation, before?.generation, 'a recomputation is a new generation');
});

test('replaying one partition leaves every other partition untouched', async () => {
  const { root, store } = await threeCountyEstate();
  const before = await fingerprints(root);
  await project(store, [partitionId(countyPartition('PROPERTY_RESOLUTION', RAMSEY))], 'run-replay');
  const after = await fingerprints(root);
  for (const county of [HENNEPIN, DALLAS]) {
    const id = partitionId(countyPartition('PROPERTY_RESOLUTION', county));
    assert.equal(after[id], before[id]);
  }
});

test('contribution order does not change a partition digest', async () => {
  const rows = [
    contribution(HENNEPIN, 'AAA'), contribution(HENNEPIN, 'BBB'), contribution(HENNEPIN, 'CCC'),
  ];
  const digests: string[] = [];
  for (const order of [rows, [...rows].reverse()]) {
    const store = createPartitionStore(tempRoot('df-order-'));
    await seed(store, 'run-1', order);
    const key = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
    await project(store, [partitionId(key)], 'run-1');
    digests.push((await store.manifest(key))?.outputDigest as string);
  }
  assert.equal(digests[0], digests[1]);
});

test('the sort chunk size changes nothing about a partition', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => contribution(HENNEPIN, `P${String(i).padStart(4, '0')}`));
  const digests = new Set<string>();
  for (const chunkLines of [1, 7, 1000]) {
    const store = createPartitionStore(tempRoot('df-chunk-'));
    await seed(store, 'run-1', rows);
    const key = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
    await recomputePartitions({
      partitions: store, partitionIds: [partitionId(key)], authority: AUTHORITY,
      runId: 'run-1', detectedAt: AT, sort: { chunkLines },
    });
    digests.add((await store.manifest(key))?.outputDigest as string);
  }
  assert.equal(digests.size, 1);
});

test('a failed projection leaves the previous partition active and reports the failure', async () => {
  const { root, store } = await threeCountyEstate();
  const key = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
  const before = await store.manifest(key);
  const beforePrints = await fingerprints(root);

  // A contribution file that is not JSON: the fold must fail, not half-apply.
  await store.writeContributions(key, 'run-broken', (async function* () {
    yield '{ this is not json';
  })());

  const result = await project(store, [partitionId(key)], 'run-broken');
  assert.deepEqual(result.activations.map((a) => a.state), ['failed']);
  assert.ok(result.activations[0]?.reason);

  const after = await store.manifest(key);
  assert.equal(after?.generation, before?.generation, 'the previous generation must still be active');
  assert.equal((await fingerprints(root))[partitionId(key)], beforePrints[partitionId(key)]);
});

test('a multi-partition run reports each activation rather than claiming global atomicity', async () => {
  const { store } = await threeCountyEstate();
  const good = partitionId(countyPartition('PROPERTY_RESOLUTION', HENNEPIN));
  const broken = countyPartition('PROPERTY_RESOLUTION', RAMSEY);
  await store.writeContributions(broken, 'run-mixed', (async function* () { yield 'not json'; })());

  const result = await project(store, [good, partitionId(broken)], 'run-mixed');
  assert.deepEqual(
    result.activations.map((a) => [a.partitionId, a.state]),
    [[good, 'activated'], [partitionId(broken), 'failed']],
  );
});

test('abandoned generations are swept, and the active one is never touched', async () => {
  const { root, store } = await threeCountyEstate();
  const key = countyPartition('PROPERTY_RESOLUTION', HENNEPIN);
  const orphan = await store.beginProjection(key, 'run-orphan');
  await orphan.write('resolutions', { propertyId: 'x' });
  // Deliberately not committed: a crashed run's generation.
  const active = (await store.manifest(key))?.generation;

  const removed = await store.sweepAbandoned();
  assert.ok(removed >= 1);
  const dir = join(root, 'derived', 'partitions', 'property', 'us-county-27053');
  const remaining = (await readdir(dir)).filter((e) => e.startsWith('gen-'));
  assert.deepEqual(remaining, [active]);
});

// ===========================================================================
// Digests
// ===========================================================================

test('a partition manifest records its inputs, outputs, resolver and counts', async () => {
  const { store } = await threeCountyEstate();
  const m = await store.manifest(countyPartition('PROPERTY_RESOLUTION', HENNEPIN));
  assert.ok(m);
  assert.equal(m.partitionId, 'property/us-county-27053');
  assert.equal(m.domain, 'PROPERTY_RESOLUTION');
  assert.equal(m.scopeId, 'us-county-27053');
  assert.match(m.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(m.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(m.resolverVersion, 'property_resolver_1');
  assert.equal(m.inputRowCount, 2);
  assert.equal(m.rowCount, 2);
  assert.equal(m.activatedAt, AT);
});

test('the global digest is order-independent over its partitions', () => {
  const manifest = (id: string, digest: string) => ({
    partitionId: id, domain: 'PROPERTY_RESOLUTION' as const, scopeId: id.split('/')[1] as string,
    generation: 'gen-1', inputDigest: 'i', outputDigest: digest, resolverVersion: 'v',
    rowCount: 1, inputRowCount: 1, activatedAt: AT, runId: 'r',
  });
  const a = [manifest('property/us-county-27053', 'aa'), manifest('property/us-county-27123', 'bb')];
  assert.equal(globalDigest(a), globalDigest([...a].reverse()));
  assert.notEqual(globalDigest(a), globalDigest([manifest('property/us-county-27053', 'cc'), a[1] as never]));
});

// ===========================================================================
// Scale
// ===========================================================================

test('recomputing one county in a many-county estate touches only that county', async () => {
  // 200 counties. The number is large enough that a whole-estate fold would be
  // visible in the write count, and the assertion is on writes, not on time.
  const root = tempRoot('df-scale-');
  const store = createPartitionStore(root);
  const counties = Array.from({ length: 200 }, (_, i) => `27${String(i * 2 + 1).padStart(3, '0')}`);
  await seed(store, 'run-1', counties.flatMap((c) => [contribution(c, 'AAA'), contribution(c, 'BBB')]));
  await project(store, counties.map((c) => partitionId(countyPartition('PROPERTY_RESOLUTION', c))), 'run-1');

  const before = await fingerprints(root);
  assert.equal(Object.keys(before).length, 200);

  const target = counties[57] as string;
  await seed(store, 'run-2', [contribution(target, 'CCC')]);
  await project(store, [partitionId(countyPartition('PROPERTY_RESOLUTION', target))], 'run-2');

  const after = await fingerprints(root);
  const rewritten = Object.keys(before).filter((id) => before[id] !== after[id]);
  assert.deepEqual(rewritten, [partitionId(countyPartition('PROPERTY_RESOLUTION', target))]);
  assert.equal(rewritten.length, 1, `199 unaffected counties must be untouched, ${rewritten.length - 1} were not`);
});

void stat;
