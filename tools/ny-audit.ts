/**
 * Aggregate-only audits of the New York statewide estate.
 *
 *   node tools/ny-audit.ts quality <bundle.ndjson.gz>   field completeness, statewide and per county
 *                                                       (min / median / max), quarantine reasons,
 *                                                       lineage, roll and spatial years
 *   node tools/ny-audit.ts pid-reuse <varRoot>          parcel strings reused across counties and
 *                                                       across MN, WI and NY, and proof that each
 *                                                       (county, parcel) is its own property
 *
 * Output is counts, rates, ranges and codes. No owner name, mailing address or
 * situs address is ever printed.
 *
 * Memory: the quality pass keeps per-county counters (62 × a few dozen
 * numbers). The reuse pass never builds a set of parcel strings: it writes one
 * line per identifier to scratch and external-sorts it, so what is held is one
 * sort chunk and one group.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readLines } from '../src/core/lines.ts';
import { createFileLineWriter } from '../src/core/lines.ts';
import { externalSort, groupSorted } from '../src/core/external-sort.ts';
import { canonicalMoney, parcelMatchKey } from '../src/canonical/normalization-contract.ts';
import { parseNyStatewideFeature } from '../src/connectors/ny-statewide-parcels/parse.ts';
import { routeNyCounty } from '../src/connectors/ny-statewide-parcels/identity.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';

const has = (a: Record<string, unknown>, f: string) => a[f] !== undefined && a[f] !== null && String(a[f]).trim() !== '';
const positive = (a: Record<string, unknown>, f: string) => typeof a[f] === 'number' && (a[f] as number) > 0;

/** Metric → whether a raw row has it. Parcel identity is decided by the connector's own parser. */
const QUALITY: Readonly<Record<string, (a: Record<string, unknown>) => boolean>> = {
  situs_address: (a) => has(a, 'PARCEL_ADDR') || has(a, 'LOC_STREET'),
  situs_zip: (a) => has(a, 'LOC_ZIP'),
  owner: (a) => has(a, 'PRIMARY_OWNER'),
  // Counted for completeness; the values live only on the restricted plane.
  mailing: (a) => has(a, 'MAIL_ADDR') || has(a, 'PO_BOX'),
  assessment: (a) => has(a, 'TOTAL_AV'),
  full_market_value: (a) => has(a, 'FULL_MARKET_VAL'),
  land_use_class: (a) => has(a, 'PROP_CLASS'),
  roll_section: (a) => has(a, 'ROLL_SECTION'),
  parcel_area: (a) => positive(a, 'ACRES') || positive(a, 'SQ_FT'),
  year_built: (a) => positive(a, 'YR_BLT'),
  living_area: (a) => positive(a, 'SQFT_LIVING'),
  print_key: (a) => has(a, 'PRINT_KEY'),
  orpts_parcel_id: (a) => has(a, 'MUNI_PARCEL_ID'),
};

type Counter = { rows: number; accepted: number; fill: Record<string, number> };

async function quality(bundlePath: string): Promise<unknown> {
  const statewide: Counter = { rows: 0, accepted: 0, fill: {} };
  const byCounty = new Map<string, Counter>();
  const reasons: Record<string, number> = {};
  const rollYears: Record<string, number> = {};
  const spatialYears = new Map<string, Record<string, number>>();
  const lineage: Record<string, number> = {};
  const ownerType: Record<string, number> = {};
  const flags = { duplicateGeometry: 0, swisSblIdMismatch: 0, swisPrintKeyIdMismatch: 0, landExceedsTotal: 0, invalidMoney: 0, noRollRecord: 0 };
  let header = true;

  for await (const line of readLines(bundlePath)) {
    if (header) { header = false; continue; }
    const a = JSON.parse(line) as Record<string, unknown>;
    if (a['kind'] !== undefined) continue; // trailer
    statewide.rows += 1;
    let fips: string | null = null;
    try {
      fips = routeNyCounty(typeof a['COUNTY_NAME'] === 'string' ? a['COUNTY_NAME'] : null, typeof a['SWIS'] === 'string' ? a['SWIS'] : null, 'audit');
    } catch (e) {
      const m = String((e as Error).message);
      const reason = /name different counties/.test(m) ? 'county_swis_disagree' : /not a catalogued/.test(m) ? 'uncatalogued_county' : 'unroutable';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    let accepted = false;
    if (fips !== null) {
      try {
        const { record } = parseNyStatewideFeature(a, 'audit');
        accepted = true;
        lineage[record.lineage] = (lineage[record.lineage] ?? 0) + 1;
        if (record.duplicateGeometry) flags.duplicateGeometry += 1;
        if (record.swisSblIdMismatch) flags.swisSblIdMismatch += 1;
        if (record.swisPrintKeyIdMismatch) flags.swisPrintKeyIdMismatch += 1;
        if (record.lineage === 'orpts_assessment_roll' && record.muniParcelId === null) flags.noRollRecord += 1;
        if (record.landAssessedValue !== null && record.totalAssessedValue !== null && record.landAssessedValue > record.totalAssessedValue) flags.landExceedsTotal += 1;
        for (const v of [record.landAssessedValue, record.totalAssessedValue, record.fullMarketValue]) {
          if (v !== null && !canonicalMoney(String(v), 'major_units').present) flags.invalidMoney += 1;
        }
      } catch (e) {
        const m = String((e as Error).message);
        const reason = /non-parcel feature label/.test(m) ? 'non_parcel_label' : /SBL/.test(m) ? 'no_sbl' : 'other';
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      const c = byCounty.get(fips) ?? { rows: 0, accepted: 0, fill: {} };
      byCounty.set(fips, c);
      c.rows += 1;
      if (accepted) c.accepted += 1;
      const sp = spatialYears.get(fips) ?? {};
      spatialYears.set(fips, sp);
      sp[String(a['SPATIAL_YR'])] = (sp[String(a['SPATIAL_YR'])] ?? 0) + 1;
      for (const [metric, test] of Object.entries(QUALITY)) {
        if (test(a)) {
          c.fill[metric] = (c.fill[metric] ?? 0) + 1;
          statewide.fill[metric] = (statewide.fill[metric] ?? 0) + 1;
        }
      }
    }
    if (accepted) statewide.accepted += 1;
    rollYears[String(a['ROLL_YR'])] = (rollYears[String(a['ROLL_YR'])] ?? 0) + 1;
    ownerType[String(a['OWNER_TYPE'] ?? '(null)')] = (ownerType[String(a['OWNER_TYPE'] ?? '(null)')] ?? 0) + 1;
  }

  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((10000 * n) / d) / 100);
  const metrics = ['parcel_identity', ...Object.keys(QUALITY)];
  const perCounty = [...byCounty].map(([fips, c]) => ({
    fips, rows: c.rows,
    rates: Object.fromEntries(metrics.map((m) => [m, m === 'parcel_identity' ? pct(c.accepted, c.rows) : pct(c.fill[m] ?? 0, c.rows)])),
  }));
  const summary = Object.fromEntries(metrics.map((m) => {
    const rates = perCounty.map((c) => ({ fips: c.fips, rate: c.rates[m] as number })).sort((x, y) => x.rate - y.rate);
    const mid = rates.length === 0 ? 0 : rates.length % 2 === 1 ? rates[(rates.length - 1) / 2]!.rate
      : ((rates[rates.length / 2 - 1]!.rate + rates[rates.length / 2]!.rate) / 2);
    const statewideRate = m === 'parcel_identity' ? pct(statewide.accepted, statewide.rows) : pct(statewide.fill[m] ?? 0, statewide.rows);
    return [m, {
      statewide: statewideRate,
      min: rates[0] ?? null, median: Math.round(mid * 100) / 100, max: rates.at(-1) ?? null,
      countiesBelow50: rates.filter((r) => r.rate < 50).length,
    }];
  }));
  const counties = perCounty.map((c) => ({ fips: c.fips, rows: c.rows })).sort((x, y) => x.rows - y.rows);
  const mixedSpatial = [...spatialYears].filter(([, years]) => Object.keys(years).length > 1)
    .map(([fips, years]) => ({ fips, years }));
  return {
    rows: statewide.rows,
    acceptedByParser: statewide.accepted,
    quarantineReasons: reasons,
    lineage,
    rollYears,
    countiesWithSeveralSpatialYears: mixedSpatial,
    ownerType,
    flags,
    counties: counties.length,
    smallestCounty: counties[0] ?? null,
    largestCounty: counties.at(-1) ?? null,
    quality: summary,
  };
}

/** State FIPS the estate holds statewide parcel sources for. */
const STATES: Readonly<Record<string, string>> = { '27': 'MN', '55': 'WI', '36': 'NY' };

async function pidReuse(varRoot: string): Promise<unknown> {
  const scratch = join(varRoot, 'scratch', `pid-audit-${Date.now()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const path = join(scratch, 'ids.ndjson');
  const writer = await createFileLineWriter(path);
  let rows = 0;
  // One line per county_parcel observation: normalized key, folded key, state, county, property id,
  // and for New York the local tax map number alone (the SBL, without its SWIS).
  for await (const line of createGenerationStore(varRoot).readTable('bundles')) {
    const bundle = JSON.parse(line) as { propertyIdentifiers: { identifierType: string; normalizedValue: string; countyFips: string; propertyId: string | null; value: string }[] };
    for (const o of bundle.propertyIdentifiers) {
      if (o.identifierType !== 'county_parcel' || o.propertyId === null) continue;
      const state = o.countyFips.slice(0, 2);
      const local = state === '36' ? o.normalizedValue.slice(6) : o.normalizedValue;
      await writer.write(JSON.stringify([o.normalizedValue, parcelMatchKey(o.value), state, o.countyFips, o.propertyId, local]));
      rows += 1;
    }
  }
  await writer.close();

  type Id = [string, string, string, string, string, string];
  const sortOpts = { chunkLines: 200_000, scratchDir: scratch };
  const byState = (items: Id[]) => {
    const out: Record<string, Set<string>> = {};
    for (const i of items) (out[STATES[i[2]] ?? i[2]] ??= new Set()).add(i[3]);
    return out;
  };
  const pairs = ['MN+WI', 'MN+NY', 'WI+NY', 'MN+WI+NY'] as const;
  const empty = () => Object.fromEntries(pairs.map((p) => [p, 0])) as Record<(typeof pairs)[number], number>;
  const result = {
    identifiers: rows,
    identifiersByState: {} as Record<string, number>,
    stringsInSeveralCountiesOfOneState: {} as Record<string, number>,
    canonicalStringsInSeveralStates: empty(),
    foldedKeysInSeveralStates: empty(),
    nyLocalSblInOtherStates: empty(),
    propertyIdCollisions: 0,
    distinctPropertiesAcrossStateReuse: true,
  };
  const tally = (target: Record<string, number>, states: Record<string, Set<string>>) => {
    const present = ['MN', 'WI', 'NY'].filter((s) => states[s] !== undefined && states[s].size > 0);
    if (present.length < 2) return;
    if (present.length === 3) target['MN+WI+NY'] = (target['MN+WI+NY'] ?? 0) + 1;
    for (const p of ['MN+WI', 'MN+NY', 'WI+NY']) {
      const [x, y] = p.split('+') as [string, string];
      if (present.includes(x) && present.includes(y)) target[p] = (target[p] ?? 0) + 1;
    }
  };
  // Pass 1: by exact canonical string.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[0], sortOpts),
    (l) => (JSON.parse(l) as Id)[0], (l) => JSON.parse(l) as Id)) {
    const states = byState(items);
    for (const [s, counties] of Object.entries(states)) {
      result.identifiersByState[s] = (result.identifiersByState[s] ?? 0) + items.filter((i) => STATES[i[2]] === s).length;
      if (counties.size > 1) result.stringsInSeveralCountiesOfOneState[s] = (result.stringsInSeveralCountiesOfOneState[s] ?? 0) + 1;
    }
    tally(result.canonicalStringsInSeveralStates, states);
    if (Object.keys(states).length > 1) {
      // Every county under this string must carry its own property id.
      const counties = new Set(items.map((i) => i[3]));
      const ids = new Set(items.map((i) => i[4]));
      if (ids.size !== counties.size) result.distinctPropertiesAcrossStateReuse = false;
    }
  }
  // Pass 2: by folded key, which is how a naive matcher would have joined them.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[1], sortOpts),
    (l) => (JSON.parse(l) as Id)[1], (l) => JSON.parse(l) as Id)) {
    tally(result.foldedKeysInSeveralStates, byState(items));
  }
  // Pass 3: New York's local tax map number (without SWIS) against the other states' parcel strings.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[5], sortOpts),
    (l) => (JSON.parse(l) as Id)[5], (l) => JSON.parse(l) as Id)) {
    tally(result.nyLocalSblInOtherStates, byState(items));
  }
  // Pass 4: by property id — one id must never name two (county, parcel) pairs.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[4], sortOpts),
    (l) => (JSON.parse(l) as Id)[4], (l) => JSON.parse(l) as Id)) {
    if (new Set(items.map((i) => `${i[3]}|${i[0]}`)).size > 1) result.propertyIdCollisions += 1;
  }
  await rm(scratch, { recursive: true, force: true });
  return result;
}

const [command, arg] = process.argv.slice(2);
if (command === 'quality' && arg) process.stdout.write(`${JSON.stringify(await quality(arg), null, 1)}\n`);
else if (command === 'pid-reuse' && arg) process.stdout.write(`${JSON.stringify(await pidReuse(arg), null, 1)}\n`);
else {
  process.stderr.write('usage: ny-audit.ts quality <bundle.ndjson.gz> | pid-reuse <varRoot>\n');
  process.exitCode = 2;
}
