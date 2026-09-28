/**
 * Aggregate-only audits of the Wisconsin statewide estate.
 *
 *   node tools/wi-audit.ts quality <bundle.ndjson>     field completeness, statewide and per county;
 *                                                      freshness; invalid ids, dates, money, codes
 *   node tools/wi-audit.ts pid-reuse <varRoot>         parcel strings reused across WI counties and
 *                                                      between MN and WI, and proof that each
 *                                                      (county, parcel) is its own property
 *
 * Output is counts, rates, ranges and codes. No owner name, mailing address or
 * situs address is ever printed.
 *
 * Memory: the quality pass keeps per-county counters (72 × a few dozen
 * numbers). The reuse pass never builds a set of parcel strings: it writes one
 * line per identifier to scratch and external-sorts it, so what is held is one
 * sort chunk and one group.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readLines } from '../src/core/lines.ts';
import { createFileLineWriter } from '../src/core/lines.ts';
import { externalSort, groupSorted } from '../src/core/external-sort.ts';
import { canonicalDate, canonicalMoney, parcelMatchKey } from '../src/canonical/normalization-contract.ts';
import { routeWiCounty, isNonParcelLabel } from '../src/connectors/wi-statewide-parcels/identity.ts';
import { codeList } from '../src/connectors/wi-statewide-parcels/parse.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';

const KNOWN_PROPCLASS = new Set(['1', '2', '3', '4', '5', '5M', '6', '7']);
const KNOWN_AUXCLASS = /^(X[1-4]|W[1-9]|AW|AWO|M)$/;

const QUALITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  parcel_id: ['PARCELID'],
  situs_address: ['SITEADRESS', 'STREETNAME'],
  owner: ['OWNERNME1'],
  // Wisconsin's roll has no separate taxpayer field; reported as absent.
  mailing: ['PSTLADRESS'],
  parcel_area: ['DEEDACRES', 'ASSDACRES', 'GISACRES'],
  land_use_class: ['PROPCLASS'],
  assessment: ['CNTASSDVALUE'],
  fair_market_value: ['ESTFMKVALUE'],
  tax: ['NETPRPTA'],
  tax_roll_year: ['TAXROLLYEAR'],
  coordinates: ['LATITUDE'],
  zip: ['ZIPCODE'],
};

type Counter = { rows: number; fill: Record<string, number> };

async function quality(bundlePath: string): Promise<unknown> {
  const statewide: Counter = { rows: 0, fill: {} };
  const byCounty = new Map<string, Counter>();
  const loads = new Map<string, Map<string, number>>(); // county → load date → rows
  const invalid = { unroutable: 0, emptyParcelId: 0, nonParcelLabel: 0, invalidLoadDate: 0, invalidParcelDate: 0,
    invalidMoney: {} as Record<string, number>, unknownPropClass: {} as Record<string, number>,
    unknownAuxClass: {} as Record<string, number>, taxRollYear: {} as Record<string, number> };
  let header = true;

  for await (const line of readLines(bundlePath)) {
    if (header) { header = false; continue; }
    const a = JSON.parse(line) as Record<string, unknown>;
    if (a['kind'] !== undefined) continue; // trailer
    let fips: string;
    try {
      fips = routeWiCounty(typeof a['CONAME'] === 'string' ? a['CONAME'] : null, 'audit');
    } catch {
      invalid.unroutable += 1;
      continue;
    }
    const pid = typeof a['PARCELID'] === 'string' ? a['PARCELID'].trim() : '';
    if (pid === '') invalid.emptyParcelId += 1;
    else if (isNonParcelLabel(pid)) invalid.nonParcelLabel += 1;

    const c = byCounty.get(fips) ?? { rows: 0, fill: {} };
    byCounty.set(fips, c);
    for (const target of [statewide, c]) {
      target.rows += 1;
      for (const [metric, fields] of Object.entries(QUALITY_FIELDS)) {
        const present = fields.some((f) => a[f] !== undefined && a[f] !== null && String(a[f]).trim() !== '');
        const ok = metric === 'parcel_id' ? pid !== '' && !isNonParcelLabel(pid) : present;
        if (ok) target.fill[metric] = (target.fill[metric] ?? 0) + 1;
      }
    }

    const load = String(a['LOADDATE'] ?? '');
    const date = canonicalDate(load, 'SOURCE_ACQUISITION_DATE');
    if (!date.present) invalid.invalidLoadDate += 1;
    else {
      const m = loads.get(fips) ?? new Map<string, number>();
      loads.set(fips, m);
      m.set(date.date, (m.get(date.date) ?? 0) + 1);
    }
    if (typeof a['PARCELDATE'] === 'string' && !canonicalDate(a['PARCELDATE'], 'SOURCE_EDIT_DATE').present) {
      invalid.invalidParcelDate += 1;
    }
    for (const f of ['CNTASSDVALUE', 'LNDVALUE', 'IMPVALUE', 'MFLVALUE', 'ESTFMKVALUE', 'NETPRPTA', 'GRSPRPTA']) {
      if (typeof a[f] === 'number' && !canonicalMoney(String(a[f]), 'major_units').present) {
        invalid.invalidMoney[f] = (invalid.invalidMoney[f] ?? 0) + 1;
      }
    }
    for (const code of codeList(typeof a['PROPCLASS'] === 'string' ? a['PROPCLASS'] : null)) {
      if (!KNOWN_PROPCLASS.has(code)) invalid.unknownPropClass[code] = (invalid.unknownPropClass[code] ?? 0) + 1;
    }
    for (const code of codeList(typeof a['AUXCLASS'] === 'string' ? a['AUXCLASS'] : null)) {
      if (!KNOWN_AUXCLASS.test(code)) invalid.unknownAuxClass[code] = (invalid.unknownAuxClass[code] ?? 0) + 1;
    }
    const roll = String(a['TAXROLLYEAR'] ?? '(blank)');
    invalid.taxRollYear[roll] = (invalid.taxRollYear[roll] ?? 0) + 1;
  }

  const pct = (n: number | undefined, d: number) => Math.round((10000 * (n ?? 0)) / Math.max(d, 1)) / 100;
  const perCounty = [...byCounty].sort().map(([fips, c]) => ({
    fips, rows: c.rows,
    ...Object.fromEntries(Object.keys(QUALITY_FIELDS).map((m) => [m, pct(c.fill[m], c.rows)])),
  }));
  const ranges = Object.fromEntries(Object.keys(QUALITY_FIELDS).map((m) => {
    const values = perCounty.map((c) => ({ fips: c.fips, v: (c as unknown as Record<string, number>)[m] as number }))
      .sort((x, y) => x.v - y.v);
    return [m, { min: values[0], median: values[Math.floor(values.length / 2)]?.v, max: values.at(-1),
      countiesBelow50: values.filter((x) => x.v < 50).length, countiesAt0: values.filter((x) => x.v === 0).length }];
  }));

  // Freshness: the newest load per county, and every submitter's load.
  const newest = [...loads].map(([fips, m]) => ({ fips, newest: [...m.keys()].sort().at(-1) as string, loads: m.size }))
    .sort((x, y) => x.newest.localeCompare(y.newest));
  const release = '2026-06-30';
  const ageDays = (d: string) => Math.round((Date.parse(release) - Date.parse(d)) / 86_400_000);
  return {
    rows: statewide.rows,
    statewide: Object.fromEntries(Object.keys(QUALITY_FIELDS).map((m) => [m, pct(statewide.fill[m], statewide.rows)])),
    taxpayer: 'not in the V12 schema',
    yearBuilt: 'not in the V12 schema',
    saleEcho: 'not in the V12 schema',
    countyRanges: ranges,
    perCounty,
    freshness: {
      basis: 'LOADDATE — when the SCO loaded each submission; age measured to the 2026-06-30 publication',
      oldest: newest[0], newestCounty: newest.at(-1), median: newest[Math.floor(newest.length / 2)],
      countiesWithMultipleLoads: newest.filter((n) => n.loads > 1).map((n) => n.fips),
      staleOver120DaysAtPublication: newest.filter((n) => ageDays(n.newest) > 120).length,
      staleOver150DaysAtPublication: newest.filter((n) => ageDays(n.newest) > 150).length,
    },
    invalid,
  };
}

async function pidReuse(varRoot: string): Promise<unknown> {
  const scratch = join(varRoot, 'scratch', `pid-audit-${Date.now()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const path = join(scratch, 'ids.ndjson');
  const writer = await createFileLineWriter(path);
  let rows = 0;
  // One line per county_parcel observation: raw key, folded key, state, county, property id.
  for await (const line of createGenerationStore(varRoot).readTable('bundles')) {
    const bundle = JSON.parse(line) as { propertyIdentifiers: { identifierType: string; normalizedValue: string; countyFips: string; propertyId: string | null; value: string }[] };
    for (const o of bundle.propertyIdentifiers) {
      if (o.identifierType !== 'county_parcel' || o.propertyId === null) continue;
      await writer.write(JSON.stringify([o.normalizedValue, parcelMatchKey(o.value), o.countyFips.slice(0, 2), o.countyFips, o.propertyId]));
      rows += 1;
    }
  }
  await writer.close();

  type Id = [string, string, string, string, string];
  const sortOpts = { chunkLines: 200_000, scratchDir: scratch };
  const result = {
    identifiers: rows,
    wiStringsInSeveralWiCounties: 0,
    mnStringsInSeveralMnCounties: 0,
    stringsInBothStates: 0,
    foldedKeysInBothStates: 0,
    propertyIdCollisions: 0,
    distinctPropertiesAcrossStateReuse: true,
  };
  // Pass 1: by exact normalized string.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[0], sortOpts),
    (l) => (JSON.parse(l) as Id)[0], (l) => JSON.parse(l) as Id)) {
    const wiCounties = new Set(items.filter((i) => i[2] === '55').map((i) => i[3]));
    const mnCounties = new Set(items.filter((i) => i[2] === '27').map((i) => i[3]));
    if (wiCounties.size > 1) result.wiStringsInSeveralWiCounties += 1;
    if (mnCounties.size > 1) result.mnStringsInSeveralMnCounties += 1;
    if (wiCounties.size > 0 && mnCounties.size > 0) {
      result.stringsInBothStates += 1;
      // Every (county) under this string must carry its own property id.
      const byCounty = new Map<string, Set<string>>();
      for (const i of items) (byCounty.get(i[3]) ?? byCounty.set(i[3], new Set()).get(i[3])!).add(i[4]);
      const allIds = new Set(items.map((i) => i[4]));
      if (allIds.size !== byCounty.size) result.distinctPropertiesAcrossStateReuse = false;
    }
  }
  // Pass 2: by folded key, which is how a naive matcher would have joined them.
  for await (const { items } of groupSorted(externalSort(readLines(path), (l) => (JSON.parse(l) as Id)[1], sortOpts),
    (l) => (JSON.parse(l) as Id)[1], (l) => JSON.parse(l) as Id)) {
    if (items.some((i) => i[2] === '55') && items.some((i) => i[2] === '27')) result.foldedKeysInBothStates += 1;
  }
  // Pass 3: by property id — one id must never name two (county, parcel) pairs.
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
  process.stderr.write('usage: wi-audit.ts quality <bundle.ndjson> | pid-reuse <varRoot>\n');
  process.exitCode = 2;
}
