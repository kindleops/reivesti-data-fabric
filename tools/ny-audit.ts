/**
 * Aggregate-only audits of the New York statewide estate.
 *
 *   node tools/ny-audit.ts quality <bundle.ndjson>      field completeness, statewide and per county
 *                                                       (min / median / max), quarantine reasons,
 *                                                       lineage, roll and spatial years
 *   node tools/ny-audit.ts leak <varRoot> <runId> <bundle.ndjson>
 *                                                       per parcel: does the derived row carry its own
 *                                                       owner's mailing-only string? Plus the key
 *                                                       names of every derived row, and the restricted
 *                                                       plane's file modes and row count
 *   node tools/ny-audit.ts leak-paths <varRoot> <runId> <bundle.ndjson>
 *                                                       every `leak` hit classified: whole string value
 *                                                       or part of one, and at which key paths
 *   node tools/ny-audit.ts extract-ids <varRoot> <out>  one line per county_parcel observation in the
 *                                                       estate's run tables: parcel strings and
 *                                                       property ids only (no names, no addresses)
 *   node tools/ny-audit.ts pid-reuse <ids> [<ids> …]    parcel strings reused across counties and
 *                                                       across MN, WI and NY, and proof that each
 *                                                       (county, parcel) is its own property
 *
 * `extract-ids` and `pid-reuse` are separate so an estate too large for one disk
 * can be audited in stages: another state's identifiers are extracted before
 * its regenerable run tables are released, then audited together.
 *
 * Output is counts, rates, ranges and codes. No owner name, mailing address or
 * situs address is ever printed.
 *
 * Memory: the quality pass keeps per-county counters (62 × a few dozen
 * numbers). The reuse pass never builds a set of parcel strings: it writes one
 * line per identifier to scratch and external-sorts it, so what is held is one
 * sort chunk and one group.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/** Mailing lines, both owners. City, state and ZIP are too generic to test by substring. */
const MAILING_LINES = ['MAIL_ADDR', 'PO_BOX', 'ADD_MAIL_ADDR', 'ADD_MAIL_PO_BOX'] as const;
/** Key names that would mean a contact-shaped value reached the derived plane. */
const FORBIDDEN_KEY = /mail|po_?box|phone|email|contact/i;

/**
 * The derived plane against the publisher's rows, parcel by parcel.
 *
 * The runtime emits bundles in delivery order, dropping quarantined rows and
 * later duplicates, so the two files merge-join on the source record id with
 * one row of each in memory. A parcel's mailing line counts as mailing-ONLY
 * when it is not the parcel's own situs: an owner billed at the property has a
 * mailing address equal to public situs data that canonical output is meant to
 * carry, and calling that a leak would make the audit worthless. Values are
 * compared, never printed.
 */
async function leak(varRoot: string, runId: string, bundlePath: string): Promise<unknown> {
  const derived = createGenerationStore(varRoot).readRunTable(runId, 'bundles')[Symbol.asyncIterator]();
  let next = await derived.next();
  const result = {
    runId,
    publisherRows: 0,
    derivedRows: 0,
    joined: 0,
    unmatchedDerived: 0,
    mailingOnlyValuesChecked: 0,
    mailingEqualToOwnSitus: 0,
    leaks: 0,
    // The same test on a value that SHOULD be there: the owner name is a public
    // observation the derived row carries. Proves the join and the matching.
    positiveControl: { ownerNamesChecked: 0, ownerNamesFound: 0 },
    partiesWithAddress: 0,
    derivedKeyNames: 0,
    forbiddenKeyNames: [] as string[],
    restricted: { files: 0, filesNotOwnerOnly: 0, directoriesNotOwnerOnly: 0, contactRows: 0 },
  };
  const keys = new Set<string>();
  const walkKeys = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walkKeys(x); return; }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) { keys.add(k); walkKeys(x); }
  };
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, ' ') : '');
  let header = true;
  for await (const line of readLines(bundlePath)) {
    if (header) { header = false; continue; }
    const a = JSON.parse(line) as Record<string, unknown>;
    if (a['kind'] !== undefined) continue;
    result.publisherRows += 1;
    let id: string;
    try {
      id = parseNyStatewideFeature(a, 'audit').sourceRecordId;
    } catch {
      continue; // quarantined: never emitted
    }
    if (next.done) continue;
    const row = next.value;
    const bundle = JSON.parse(row) as { transaction: { sourceRecordId: string }; parties: { address: unknown }[] };
    if (bundle.transaction.sourceRecordId !== id) continue; // a later duplicate of a row already joined
    result.joined += 1;
    result.derivedRows += 1;
    walkKeys(bundle);
    result.partiesWithAddress += bundle.parties.filter((p) => p.address !== null && p.address !== undefined).length;
    const situs = new Set([norm(a['PARCEL_ADDR']), norm(`${String(a['LOC_ST_NBR'] ?? '')} ${String(a['LOC_STREET'] ?? '')}`)]);
    const upper = row.toUpperCase();
    const collapsed = upper.replace(/\s+/g, ' ');
    const carried = (raw: unknown, value: string) => collapsed.includes(JSON.stringify(value).slice(1, -1))
      || (typeof raw === 'string' && upper.includes(JSON.stringify(raw.trim().toUpperCase()).slice(1, -1)));
    for (const field of MAILING_LINES) {
      const value = norm(a[field]);
      if (value.length < 4) continue;
      if (situs.has(value)) { result.mailingEqualToOwnSitus += 1; continue; }
      result.mailingOnlyValuesChecked += 1;
      if (carried(a[field], value)) result.leaks += 1;
    }
    const owner = norm(a['PRIMARY_OWNER']);
    if (owner.length >= 4) {
      result.positiveControl.ownerNamesChecked += 1;
      if (carried(a['PRIMARY_OWNER'], owner)) result.positiveControl.ownerNamesFound += 1;
    }
    next = await derived.next();
  }
  while (!next.done) { result.derivedRows += 1; result.unmatchedDerived += 1; next = await derived.next(); }
  result.derivedKeyNames = keys.size;
  result.forbiddenKeyNames = [...keys].filter((k) => FORBIDDEN_KEY.test(k)).sort();

  // The restricted plane: owner-only files and directories, and its row count.
  const restrictedRoot = join(varRoot, 'restricted', 'runs', runId);
  const walk = async (dir: string): Promise<void> => {
    const st = await stat(dir);
    if ((st.mode & 0o077) !== 0) result.restricted.directoriesNotOwnerOnly += 1;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      result.restricted.files += 1;
      if (((await stat(p)).mode & 0o077) !== 0 && e.name !== 'CURRENT') result.restricted.filesNotOwnerOnly += 1;
    }
  };
  await walk(restrictedRoot).catch(() => {});
  for await (const _ of createGenerationStore(varRoot).readRunTable(runId, 'contacts')) result.restricted.contactRows += 1;
  return result;
}

/**
 * Every `leak` hit, classified. For each parcel whose derived row contains its
 * own mailing-only line as a substring: is that line a WHOLE string value of
 * the row, or only part of one; and at which key paths (array positions
 * dropped) the containing strings sit. A mailing value that reached a
 * canonical field would show as a whole-value hit at a non-address path.
 * Counts only.
 */
async function leakPaths(varRoot: string, runId: string, bundlePath: string): Promise<unknown> {
  const derived = createGenerationStore(varRoot).readRunTable(runId, 'bundles')[Symbol.asyncIterator]();
  let next = await derived.next();
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, ' ') : '');
  const result = {
    runId, joined: 0, hits: 0, wholeValueHits: 0, substringOnlyHits: 0,
    hitsByMailingField: {} as Record<string, number>,
    containingPaths: {} as Record<string, number>,
    wholeValuePaths: {} as Record<string, number>,
  };
  const leaves = (v: unknown, path: string, out: [string, string][]): void => {
    if (Array.isArray(v)) { for (const x of v) leaves(x, `${path}[]`, out); return; }
    if (v !== null && typeof v === 'object') { for (const [k, x] of Object.entries(v)) leaves(x, path === '' ? k : `${path}.${k}`, out); return; }
    if (typeof v === 'string') out.push([path, norm(v)]);
  };
  let header = true;
  for await (const line of readLines(bundlePath)) {
    if (header) { header = false; continue; }
    const a = JSON.parse(line) as Record<string, unknown>;
    if (a['kind'] !== undefined) continue;
    let id: string;
    try { id = parseNyStatewideFeature(a, 'audit').sourceRecordId; } catch { continue; }
    if (next.done) continue;
    const bundle = JSON.parse(next.value) as { transaction: { sourceRecordId: string } };
    if (bundle.transaction.sourceRecordId !== id) continue;
    result.joined += 1;
    const situs = new Set([norm(a['PARCEL_ADDR']), norm(`${String(a['LOC_ST_NBR'] ?? '')} ${String(a['LOC_STREET'] ?? '')}`)]);
    let strings: [string, string][] | null = null;
    for (const field of MAILING_LINES) {
      const value = norm(a[field]);
      if (value.length < 4 || situs.has(value)) continue;
      strings ??= (() => { const out: [string, string][] = []; leaves(bundle, '', out); return out; })();
      const containing = strings.filter(([, s]) => s.includes(value));
      if (containing.length === 0) continue;
      result.hits += 1;
      result.hitsByMailingField[field] = (result.hitsByMailingField[field] ?? 0) + 1;
      const whole = containing.filter(([, s]) => s === value);
      if (whole.length > 0) result.wholeValueHits += 1; else result.substringOnlyHits += 1;
      for (const [path] of new Map(containing)) result.containingPaths[path] = (result.containingPaths[path] ?? 0) + 1;
      for (const [path] of new Map(whole)) result.wholeValuePaths[path] = (result.wholeValuePaths[path] ?? 0) + 1;
    }
    next = await derived.next();
  }
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([, x], [, y]) => y - x));
  return { ...result, containingPaths: sorted(result.containingPaths), wholeValuePaths: sorted(result.wholeValuePaths) };
}

/** State FIPS the estate holds statewide parcel sources for. */
const STATES: Readonly<Record<string, string>> = { '27': 'MN', '55': 'WI', '36': 'NY' };

/** One line per county_parcel observation: normalized key, folded key, state, county, property id, local key. */
async function extractIds(varRoot: string, out: string): Promise<{ readonly identifiers: number }> {
  const writer = await createFileLineWriter(out);
  let rows = 0;
  // For New York the local key is the tax map number alone (the SBL, without its SWIS).
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
  return { identifiers: rows };
}

async function* linesOf(files: readonly string[]): AsyncGenerator<string> {
  for (const file of files) yield* readLines(file);
}

async function pidReuse(idFiles: readonly string[]): Promise<unknown> {
  // Sort scratch beside the identifier files; the files themselves are read in place.
  const scratch = join(dirname(idFiles[0] as string), `pid-audit-${Date.now()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  let rows = 0;

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
  for await (const { items } of groupSorted(externalSort(linesOf(idFiles), (l) => (JSON.parse(l) as Id)[0], sortOpts),
    (l) => (JSON.parse(l) as Id)[0], (l) => JSON.parse(l) as Id)) {
    rows += items.length;
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
  result.identifiers = rows;
  // Pass 2: by folded key, which is how a naive matcher would have joined them.
  for await (const { items } of groupSorted(externalSort(linesOf(idFiles), (l) => (JSON.parse(l) as Id)[1], sortOpts),
    (l) => (JSON.parse(l) as Id)[1], (l) => JSON.parse(l) as Id)) {
    tally(result.foldedKeysInSeveralStates, byState(items));
  }
  // Pass 3: New York's local tax map number (without SWIS) against the other states' parcel strings.
  for await (const { items } of groupSorted(externalSort(linesOf(idFiles), (l) => (JSON.parse(l) as Id)[5], sortOpts),
    (l) => (JSON.parse(l) as Id)[5], (l) => JSON.parse(l) as Id)) {
    tally(result.nyLocalSblInOtherStates, byState(items));
  }
  // Pass 4: by property id — one id must never name two (county, parcel) pairs.
  for await (const { items } of groupSorted(externalSort(linesOf(idFiles), (l) => (JSON.parse(l) as Id)[4], sortOpts),
    (l) => (JSON.parse(l) as Id)[4], (l) => JSON.parse(l) as Id)) {
    if (new Set(items.map((i) => `${i[3]}|${i[0]}`)).size > 1) result.propertyIdCollisions += 1;
  }
  await rm(scratch, { recursive: true, force: true });
  return result;
}

const [command, arg, ...rest] = process.argv.slice(2);
if (command === 'quality' && arg) process.stdout.write(`${JSON.stringify(await quality(arg), null, 1)}\n`);
else if (command === 'leak' && arg && rest[0] && rest[1]) process.stdout.write(`${JSON.stringify(await leak(arg, rest[0], rest[1]), null, 1)}\n`);
else if (command === 'leak-paths' && arg && rest[0] && rest[1]) process.stdout.write(`${JSON.stringify(await leakPaths(arg, rest[0], rest[1]), null, 1)}\n`);
else if (command === 'extract-ids' && arg && rest[0]) process.stdout.write(`${JSON.stringify(await extractIds(arg, rest[0]))}\n`);
else if (command === 'pid-reuse' && arg) process.stdout.write(`${JSON.stringify(await pidReuse([arg, ...rest]), null, 1)}\n`);
else {
  process.stderr.write('usage: ny-audit.ts quality <bundle.ndjson> | leak <varRoot> <runId> <bundle.ndjson> | extract-ids <varRoot> <out.ndjson> | pid-reuse <ids.ndjson> [<ids.ndjson> …]\n');
  process.exitCode = 2;
}
