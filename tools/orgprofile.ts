/**
 * DF-0I §28: what the national organization fold costs in memory.
 *
 * The fold joins every observed organization name against the whole business
 * register, which is the one projection whose input is not partitioned by
 * county — organizations are nation-scoped on purpose, because an LLC does not
 * stop at a county line. That makes it the obvious place for a hidden
 * dataset-sized structure, so it gets measured rather than assumed.
 *
 * Run:  node --expose-gc tools/orgprofile.ts [entities] [observations]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectOrganizationLinks } from '../src/canonical/organization-projection.ts';
import { DEFAULT_RULES } from '../src/canonical/entity-resolution.ts';

const ENTITIES = Number(process.argv[2] ?? 200_000);
const OBSERVATIONS = Number(process.argv[3] ?? 200_000);
const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;
const settle = async (): Promise<void> => {
  (global as { gc?: () => void }).gc?.();
  (global as { gc?: () => void }).gc?.();
  await new Promise((r) => setTimeout(r, 60));
};

// Every name below is generated. No register row is read.
//
// The shapes matter: the join keys off `normalizedName` / `compactName` on the
// entity side and `n` / `k` on the observation side, and a mismatch produces a
// silent zero-match run rather than an error. An earlier version of this script
// invented its own field names and spent fifteen minutes cross-joining every
// observation against every entity under the key `undefined`, which is a fair
// demonstration of the risk this measurement exists to check.
const NAME_POOL = Math.max(1, Math.floor(ENTITIES / 2));

async function* entities(): AsyncGenerator<string> {
  for (let i = 0; i < ENTITIES; i++) {
    const name = `GENERATED HOLDINGS ${i % NAME_POOL} LLC`;
    yield JSON.stringify({
      entityId: `ent_${i}`,
      sourceId: 'synthetic',
      sourceEntityId: `SRC-${i}`,
      registryJurisdictionId: 'us-state-mn',
      originalFilingNumber: null,
      legalName: name,
      normalizedName: name,
      compactName: name.replace(/[^A-Z0-9]/g, ''),
      businessTypeCode: 'llc',
      businessTypeLabel: 'Limited Liability Company',
      domesticity: 'domestic',
      registryStatus: 'active',
      registryStatusRaw: 'Active',
      filingDate: '2020-01-01',
      expirationDate: null,
      nextRenewalDueDate: null,
    });
  }
}

async function* addresses(): AsyncGenerator<string> {
  for (let i = 0; i < ENTITIES; i++) {
    yield JSON.stringify({
      addressObservationId: `addr_${i}`,
      entityId: `ent_${i}`,
      addressTypeCode: '1',
      addressTypeLabel: 'Registered Office',
      family: 'registered_office',
      normalizedAddress: `${i} GENERATED WAY MINNEAPOLIS MN 55401`,
      filingNumber: null,
      observedAt: '2026-08-31T12:00:00.000Z',
    });
  }
}

/** One observed organization name per parcel, as a county file produces them. */
async function* observations(): AsyncGenerator<string> {
  for (let i = 0; i < OBSERVATIONS; i++) {
    const name = `GENERATED HOLDINGS ${i % NAME_POOL} LLC`;
    yield JSON.stringify({
      o: `pobs_${i}`,
      s: 'synthetic',
      r: name,
      n: name,
      k: name.replace(/[^A-Z0-9]/g, ''),
      a: `${i} GENERATED WAY MINNEAPOLIS MN 55401`,
      e: null,
    });
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'df-orgprofile-'));
try {
  await settle();
  const before = process.memoryUsage();
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 100);
  const started = performance.now();

  let emitted = 0;
  const summary = await projectOrganizationLinks(
    observations, entities, addresses,
    async () => { emitted += 1; },
    { rules: DEFAULT_RULES, decidedAt: '2026-08-31T12:00:00.000Z', sort: { chunkLines: 50_000, scratchDir: scratch }, scratchDir: scratch },
  );

  clearInterval(sampler);
  const ms = Math.round(performance.now() - started);
  await settle();
  const after = process.memoryUsage();

  console.log(JSON.stringify({
    entities: ENTITIES,
    observations: OBSERVATIONS,
    ms,
    peakHeapMB: mb(peak),
    retainedHeapMB: mb(after.heapUsed - before.heapUsed),
    heapBytesPerObservation: Math.round((after.heapUsed - before.heapUsed) / OBSERVATIONS),
    externalMB: mb(after.external - before.external),
    emitted,
    summary,
  }, null, 1));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
