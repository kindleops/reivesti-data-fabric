/**
 * Florida DOR statewide audit — measured on the retained publisher bytes,
 * before any identity or normalisation rule is written down.
 *
 *   node --max-old-space-size=8192 tools/fl-audit.ts <nal|sdf|par|cross|all> [--out dir]
 *
 * Reads the release manifests the acquisition pinned (DF_VAR/DF_ARCHIVE), the
 * county files they name, straight out of their zip archives. Writes AGGREGATE
 * evidence only: counts, shapes, distributions, collision tallies. No parcel
 * id, owner, address or legal text is ever written — a shape like
 * `99999-999-AA` is the most specific thing that leaves this tool.
 *
 * A tool, not the pipeline: it may hold one county's identifiers in memory to
 * count collisions, which the production path never does.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listZipFile, readZipEntry, type ZipFileEntry } from '../src/core/zip-file.ts';
import { linesFromChunks } from '../src/core/lines.ts';
import { parseCsvRecord } from '../src/core/csv.ts';
import { openDbf } from '../src/core/dbf.ts';
import { openShp, prjLinearUnitMetres, prjName } from '../src/core/shp.ts';
import { flCountyByDorCode, FL_DOR_COUNTIES } from '../src/connectors/fl-dor/counties.ts';
import type { FlReleaseManifest } from '../src/connectors/fl-dor/acquire.ts';

const VAR = process.env['DF_VAR'] ?? 'var';
const ARCHIVE = process.env['DF_ARCHIVE'] ?? `${VAR}/archive`;
const args = process.argv.slice(2);
const what = args[0] ?? 'all';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] as string : 'reference/fl-statewide/2026';
mkdirSync(OUT, { recursive: true });

type ManifestFile = FlReleaseManifest['files'][number];

function latestManifest(sourceId: string): { manifest: FlReleaseManifest; sha256: string } {
  const base = join(ARCHIVE, 'data-fabric', sourceId);
  let best: { manifest: FlReleaseManifest; sha256: string; at: string } | null = null;
  for (const period of readdirSync(base)) {
    for (const dir of readdirSync(join(base, period))) {
      const m = JSON.parse(readFileSync(join(base, period, dir, 'manifest.json'), 'utf8')) as { originalFilename: string; retrievedAt: string; sha256: string };
      if (m.originalFilename !== 'fl-dor-release-manifest.json') continue;
      const body = JSON.parse(readFileSync(join(base, period, dir, 'source-original.json'), 'utf8')) as FlReleaseManifest;
      if (best === null || m.retrievedAt > best.at) best = { manifest: body, sha256: m.sha256, at: m.retrievedAt };
    }
  }
  if (best === null) throw new Error(`no release manifest retained for ${sourceId}`);
  return best;
}

function artifactPath(sourceId: string, f: ManifestFile, period: string): string {
  const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
  return join(ARCHIVE, 'data-fabric', sourceId, period, `sha256-${f.sha256}`, `source-original${ext}`);
}

/** A value's shape: digits → 9, letters → A, everything else kept. Never the value. */
export function shapeOf(v: string): string {
  return v.replace(/[0-9]/g, '9').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a');
}

const TRANSFORMS: readonly { readonly name: string; readonly fn: (s: string) => string }[] = [
  { name: 'trim', fn: (s) => s.trim() },
  { name: 'trim_upper', fn: (s) => s.trim().toUpperCase() },
  { name: 'strip_whitespace', fn: (s) => s.replace(/\s+/g, '').toUpperCase() },
  { name: 'strip_separators', fn: (s) => s.replace(/[\s\-./]+/g, '').toUpperCase() },
  { name: 'strip_all_punctuation', fn: (s) => s.replace(/[^0-9A-Za-z]+/g, '').toUpperCase() },
  { name: 'strip_leading_zeros', fn: (s) => s.trim().toUpperCase().replace(/^0+(?=.)/, '') },
  { name: 'alnum_no_leading_zeros', fn: (s) => s.replace(/[^0-9A-Za-z]+/g, '').toUpperCase().replace(/^0+(?=.)/, '') },
];

/** How many distinct raw ids stop being distinct under each transform. */
function collisions(ids: readonly string[]): Record<string, { groups: number; idsMerged: number }> {
  const distinctRaw = [...new Set(ids)];
  const out: Record<string, { groups: number; idsMerged: number }> = {};
  for (const t of TRANSFORMS) {
    const groups = new Map<string, number>();
    for (const id of distinctRaw) { const k = t.fn(id); groups.set(k, (groups.get(k) ?? 0) + 1); }
    let g = 0; let merged = 0;
    for (const n of groups.values()) if (n > 1) { g += 1; merged += n; }
    out[t.name] = { groups: g, idsMerged: merged };
  }
  return out;
}

function lengthStats(ids: readonly string[]): { min: number; median: number; max: number } {
  const ls = ids.map((s) => s.length).sort((a, b) => a - b);
  return { min: ls[0] ?? 0, median: ls[Math.floor(ls.length / 2)] ?? 0, max: ls.at(-1) ?? 0 };
}

function top(counter: Map<string, number>, n: number): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

function bump(m: Map<string, number>, k: string, by = 1): void { m.set(k, (m.get(k) ?? 0) + by); }

async function csvRows(path: string): Promise<{ entry: ZipFileEntry; header: string[]; rows: AsyncGenerator<string[]>; encodingReport: () => { nonAscii: number; replacement: number } }> {
  const entries = (await listZipFile(path)).filter((e) => !e.isDirectory);
  if (entries.length !== 1) throw new Error(`${path}: expected one CSV entry, found ${entries.map((e) => e.name).join(', ')}`);
  const entry = entries[0] as ZipFileEntry;
  let nonAscii = 0;
  async function* counted(): AsyncGenerator<Buffer> {
    for await (const c of readZipEntry(path, entry)) {
      for (let i = 0; i < c.length; i++) if ((c[i] as number) > 127) nonAscii += 1;
      yield c;
    }
  }
  const lines = linesFromChunks(counted(), 'utf8');
  const first = await lines.next();
  const header = parseCsvRecord(first.value as string, ',', '"') ?? [];
  let replacement = 0;
  async function* rows(): AsyncGenerator<string[]> {
    let pending = '';
    for await (const line of lines) {
      pending = pending === '' ? line : `${pending}\n${line}`;
      const cells = parseCsvRecord(pending, ',', '"');
      if (cells === null) continue;
      pending = '';
      if (cells.some((c) => c.includes('�'))) replacement += 1;
      yield cells;
    }
    if (pending !== '') throw new Error(`${path}: ends inside a quoted field`);
  }
  return { entry, header, rows: rows(), encodingReport: () => ({ nonAscii, replacement }) };
}

// ---------------------------------------------------------------------------

const NAL_KEY_FIELDS = [
  'PARCEL_ID', 'DOR_UC', 'PA_UC', 'JV', 'AV_SD', 'AV_NSD', 'TV_SD', 'TV_NSD', 'LND_VAL', 'LND_SQFOOT', 'NO_LND_UNTS',
  'ACT_YR_BLT', 'EFF_YR_BLT', 'TOT_LVG_AREA', 'NO_BULDNG', 'NO_RES_UNTS', 'SALE_PRC1', 'SALE_YR1', 'QUAL_CD1', 'SALE_PRC2',
  'OWN_NAME', 'OWN_ADDR1', 'OWN_CITY', 'OWN_STATE', 'OWN_ZIPCD', 'OWN_STATE_DOM', 'FIDU_NAME', 'S_LEGAL', 'PHY_ADDR1',
  'PHY_CITY', 'PHY_ZIPCD', 'CENSUS_BK', 'TWN', 'RNG', 'SEC', 'ALT_KEY', 'MP_ID', 'STATE_PAR_ID', 'SEQ_NO', 'RS_ID',
  'EXMPT_01', 'SPC_CIR_CD', 'APP_STAT', 'PUBLIC_LND', 'MKT_AR', 'NBRHD_CD', 'TAX_AUTH_CD', 'DT_LAST_INSPT',
];

async function auditNal(): Promise<Record<string, unknown>> {
  const { manifest, sha256 } = latestManifest('fl_dor_nal');
  const perCounty: Record<string, unknown>[] = [];
  const headerDigests = new Map<string, number>();
  const statewide = new Map<string, Set<string>>(); // normalized id → counties (strip nothing: trim_upper)
  let totalRows = 0;
  const idShapesState = new Map<string, number>();
  const collisionTotals: Record<string, { groups: number; idsMerged: number }> = {};
  for (const f of manifest.files) {
    const path = artifactPath('fl_dor_nal', f, manifest.referencePeriod);
    const { entry, header, rows, encodingReport } = await csvRows(path);
    bump(headerDigests, createHash('sha256').update(header.join(',')).digest('hex'));
    const idx = (name: string) => header.indexOf(name);
    const iCo = idx('CO_NO'); const iPid = idx('PARCEL_ID'); const iYr = idx('ASMNT_YR'); const iFt = idx('FILE_T');
    const coValues = new Map<string, number>(); const years = new Map<string, number>(); const fileT = new Map<string, number>();
    const widths = new Map<number, number>();
    const present = new Map<string, number>();
    const ids: string[] = [];
    const shapes = new Map<string, number>();
    let rowsN = 0; let blankId = 0; let lower = 0; let withSpace = 0; let withDash = 0; let withDot = 0; let withSlash = 0; let withOther = 0; let leadingZero = 0;
    const money = { negative: 0, fractional: 0, nonNumeric: 0 };
    for await (const cells of rows) {
      rowsN += 1;
      bump(widths, cells.length);
      bump(coValues, cells[iCo] ?? ''); bump(years, cells[iYr] ?? ''); bump(fileT, cells[iFt] ?? '');
      for (const k of NAL_KEY_FIELDS) { const i = idx(k); if (i >= 0 && (cells[i] ?? '').trim() !== '') bump(present, k); }
      for (const k of ['JV', 'AV_SD', 'AV_NSD', 'TV_SD', 'TV_NSD', 'LND_VAL', 'SALE_PRC1', 'SALE_PRC2']) {
        const v = (cells[idx(k)] ?? '').trim();
        if (v === '') continue;
        if (!/^-?\d+(\.\d+)?$/.test(v)) money.nonNumeric += 1;
        else { if (v.startsWith('-')) money.negative += 1; if (/\.\d*[1-9]/.test(v)) money.fractional += 1; }
      }
      const raw = cells[iPid] ?? '';
      if (raw.trim() === '') { blankId += 1; continue; }
      ids.push(raw);
      bump(shapes, shapeOf(raw)); bump(idShapesState, shapeOf(raw));
      if (/[a-z]/.test(raw)) lower += 1;
      if (/\s/.test(raw.trim())) withSpace += 1;
      if (raw.includes('-')) withDash += 1;
      if (raw.includes('.')) withDot += 1;
      if (raw.includes('/')) withSlash += 1;
      if (/[^0-9A-Za-z\s\-./]/.test(raw)) withOther += 1;
      if (/^0/.test(raw.trim())) leadingZero += 1;
      if (raw !== raw.trim()) bump(shapes, '<untrimmed>');
    }
    totalRows += rowsN;
    const distinct = new Set(ids);
    const coll = collisions(ids);
    for (const [k, v] of Object.entries(coll)) {
      collisionTotals[k] = { groups: (collisionTotals[k]?.groups ?? 0) + v.groups, idsMerged: (collisionTotals[k]?.idsMerged ?? 0) + v.idsMerged };
    }
    for (const id of distinct) {
      const k = id.trim().toUpperCase();
      const s = statewide.get(k) ?? new Set<string>();
      s.add(f.countyFips); statewide.set(k, s);
    }
    const coMatch = [...coValues.keys()].map((v) => flCountyByDorCode(v)?.fips ?? `INVALID:${v}`);
    perCounty.push({
      dorCode: f.dorCode, countyFips: f.countyFips, stage: f.stage, file: f.name, csv: entry.name, bytes: f.bytes,
      rows: rowsN, columns: header.length, rowWidths: Object.fromEntries(widths),
      coNo: Object.fromEntries(coValues), coNoRoutesToFileCounty: coMatch.every((x) => x === f.countyFips),
      assessmentYears: Object.fromEntries(years), fileTypes: Object.fromEntries(fileT),
      encoding: encodingReport(),
      parcelId: {
        blank: blankId, distinct: distinct.size, duplicateRows: ids.length - distinct.size, length: lengthStats(ids),
        lowercase: lower, internalWhitespace: withSpace, dash: withDash, dot: withDot, slash: withSlash, otherPunctuation: withOther,
        leadingZero, topShapes: top(shapes, 5), collisionsUnderTransform: coll,
      },
      completeness: Object.fromEntries(NAL_KEY_FIELDS.map((k) => [k, rowsN === 0 ? 0 : Math.round((present.get(k) ?? 0) / rowsN * 10000) / 10000])),
      money,
    });
    process.stderr.write(`nal ${f.dorCode} ${rowsN}\n`);
  }
  let crossCounty = 0; let crossCountyIds = 0;
  for (const s of statewide.values()) if (s.size > 1) { crossCounty += 1; crossCountyIds += s.size; }
  return {
    source: 'fl_dor_nal', releaseManifestSha256: sha256, referencePeriod: manifest.referencePeriod, stageCounts: manifest.stageCounts,
    files: manifest.files.length, totalRows, headerVariants: headerDigests.size,
    statewideIdShapesTop: top(idShapesState, 25), collisionsUnderTransformStatewide: collisionTotals,
    crossCountyReuse: { normalizedIdsInMoreThanOneCounty: crossCounty, countyIdPairsInvolved: crossCountyIds },
    perCounty,
  };
}

// ---------------------------------------------------------------------------

async function auditSdf(): Promise<Record<string, unknown>> {
  const { manifest, sha256 } = latestManifest('fl_dor_sdf');
  const { manifest: nalManifest } = latestManifest('fl_dor_nal');
  const perCounty: Record<string, unknown>[] = [];
  const qual = new Map<string, number>(); const vi = new Map<string, number>(); const mps = new Map<string, number>();
  const chg = new Map<string, number>(); const yr = new Map<string, number>(); const mo = new Map<string, number>();
  let total = 0;
  const headerDigests = new Map<string, number>();
  for (const f of manifest.files) {
    const { header, rows, encodingReport } = await csvRows(artifactPath('fl_dor_sdf', f, manifest.referencePeriod));
    bump(headerDigests, createHash('sha256').update(header.join(',')).digest('hex'));
    const i = (n: string) => header.indexOf(n);
    // The same county's NAL parcel ids, for linkage.
    const nalFile = nalManifest.files.find((x) => x.countyFips === f.countyFips);
    const nalIds = new Set<string>();
    if (nalFile) {
      const nal = await csvRows(artifactPath('fl_dor_nal', nalFile, nalManifest.referencePeriod));
      const ip = nal.header.indexOf('PARCEL_ID');
      for await (const c of nal.rows) nalIds.add((c[ip] ?? '').trim().toUpperCase());
    }
    let n = 0; let blankSaleId = 0; let blankPid = 0; let linked = 0; let priceBlank = 0; let priceZero = 0; let priceNonNumeric = 0; let priceFractional = 0;
    let badMonth = 0; let badYear = 0; let future = 0; let book = 0; let clerk = 0; let both = 0; let neither = 0;
    const saleIds = new Map<string, number>(); const pairs = new Set<string>(); const coValues = new Map<string, number>();
    const perParcel = new Map<string, number>();
    const assessmentYears = new Map<string, number>();
    for await (const c of rows) {
      n += 1;
      const pid = (c[i('PARCEL_ID')] ?? '').trim();
      const sid = (c[i('SALE_ID_CD')] ?? '').trim();
      bump(coValues, c[i('CO_NO')] ?? '');
      bump(assessmentYears, c[i('ASMNT_YR')] ?? '');
      if (pid === '') blankPid += 1; else { bump(perParcel, pid); if (nalIds.has(pid.toUpperCase())) linked += 1; }
      if (sid === '') blankSaleId += 1; else bump(saleIds, sid);
      pairs.add(`${pid}\u0000${sid}`);
      bump(qual, (c[i('QUAL_CD')] ?? '').trim()); bump(vi, (c[i('VI_CD')] ?? '').trim()); bump(mps, (c[i('MULTI_PAR_SAL')] ?? '').trim());
      bump(chg, (c[i('SAL_CHG_CD')] ?? '').trim());
      const y = (c[i('SALE_YR')] ?? '').trim(); const m = (c[i('SALE_MO')] ?? '').trim();
      bump(yr, y); bump(mo, m);
      if (!/^\d{4}$/.test(y)) badYear += 1;
      if (!/^(0[1-9]|1[0-2])$/.test(m)) badMonth += 1;
      if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m) && `${y}-${m}` > '2026-09') future += 1;
      const p = (c[i('SALE_PRC')] ?? '').trim();
      if (p === '') priceBlank += 1; else if (!/^\d+(\.\d+)?$/.test(p)) priceNonNumeric += 1; else { if (Number(p) === 0) priceZero += 1; if (/\.\d*[1-9]/.test(p)) priceFractional += 1; }
      const hasBook = (c[i('OR_BOOK')] ?? '').trim() !== '' || (c[i('OR_PAGE')] ?? '').trim() !== '';
      const hasClerk = (c[i('CLERK_NO')] ?? '').trim() !== '';
      if (hasBook) book += 1; if (hasClerk) clerk += 1; if (hasBook && hasClerk) both += 1; if (!hasBook && !hasClerk) neither += 1;
    }
    total += n;
    const dupSaleIds = [...saleIds.values()].filter((v) => v > 1).length;
    const multiSaleParcels = [...perParcel.values()].filter((v) => v > 1).length;
    perCounty.push({
      dorCode: f.dorCode, countyFips: f.countyFips, stage: f.stage, rows: n, encoding: encodingReport(),
      coNo: Object.fromEntries(coValues), assessmentYears: Object.fromEntries(assessmentYears),
      saleId: { blank: blankSaleId, distinct: saleIds.size, valuesRepeated: dupSaleIds, distinctParcelSalePairs: pairs.size },
      parcel: { blank: blankPid, parcelsWithMultipleSales: multiSaleParcels, linkedToSameCountyNal: linked },
      price: { blank: priceBlank, zero: priceZero, nonNumeric: priceNonNumeric, fractional: priceFractional },
      date: { badYear, badMonth, afterAcquisitionMonth: future },
      recording: { bookPage: book, clerkNumber: clerk, both, neither },
    });
    process.stderr.write(`sdf ${f.dorCode} ${n}\n`);
  }
  return {
    source: 'fl_dor_sdf', releaseManifestSha256: sha256, referencePeriod: manifest.referencePeriod, stageCounts: manifest.stageCounts,
    files: manifest.files.length, totalRows: total, headerVariants: headerDigests.size,
    qualificationCodes: Object.fromEntries([...qual.entries()].sort()), vacantImproved: Object.fromEntries([...vi.entries()].sort()),
    multiParcel: Object.fromEntries([...mps.entries()].sort()), saleChange: Object.fromEntries([...chg.entries()].sort()),
    saleYears: Object.fromEntries([...yr.entries()].sort()), saleMonths: Object.fromEntries([...mo.entries()].sort()),
    perCounty,
  };
}

// ---------------------------------------------------------------------------

async function auditPar(): Promise<Record<string, unknown>> {
  const { manifest, sha256 } = latestManifest('fl_statewide_cadastral');
  const perFile: Record<string, unknown>[] = [];
  const fieldSets = new Map<string, number>();
  let total = 0; let totalUnjoined = 0;
  for (const f of manifest.files) {
    const path = artifactPath('fl_statewide_cadastral', f, manifest.referencePeriod);
    const entries = (await listZipFile(path)).filter((e) => !e.isDirectory);
    const byExt = (ext: string) => entries.find((e) => e.name.toLowerCase().endsWith(ext));
    const dbfE = byExt('.dbf'); const shpE = byExt('.shp'); const prjE = byExt('.prj'); const cpgE = byExt('.cpg');
    if (dbfE === undefined) { perFile.push({ file: f.name, role: f.role, entries: entries.map((e) => e.name), note: 'no .dbf' }); continue; }
    const text = async (e: ZipFileEntry | undefined) => {
      if (e === undefined) return null;
      const parts: Buffer[] = []; for await (const c of readZipEntry(path, e)) parts.push(c); return Buffer.concat(parts).toString('utf8');
    };
    const prj = await text(prjE); const cpg = (await text(cpgE))?.trim() ?? null;
    const dbf = await openDbf(readZipEntry(path, dbfE), { encoding: cpg !== null && /1252|latin/i.test(cpg) ? 'latin1' : 'utf8' });
    const fieldSig = dbf.header.fields.map((x) => `${x.name}:${x.type}:${x.length}:${x.decimals}`).join('|');
    bump(fieldSets, createHash('sha256').update(fieldSig).digest('hex').slice(0, 16));
    if (f.role === 'condo_related') {
      // An auxiliary unit table beside the parcel polygons: counted, not interpreted.
      let rows = 0; const types = new Map<string, number>();
      const shapes = shpE ? (await openShp(readZipEntry(path, shpE))).records() : null;
      for await (const _r of dbf.records()) {
        rows += 1;
        if (shapes) { const s = await shapes.next(); if (!s.done) bump(types, String(s.value.shapeType)); }
      }
      perFile.push({ dorCode: f.dorCode, countyFips: f.countyFips, role: f.role, file: f.name, bytes: f.bytes,
        entries: entries.map((e) => e.name.replace(/^.*\//, '')).sort(), fields: dbf.header.fields.length, rows, shapeTypes: Object.fromEntries(types) });
      process.stderr.write(`par ${f.dorCode} ${f.role} ${rows}\n`);
      continue;
    }
    const fi = (n: string) => dbf.header.fields.findIndex((x) => x.name === n);
    const iCo = fi('CO_NO'); const iPid = fi('PARCEL_ID'); const iNo = fi('PARCELNO');
    const shapes = shpE ? (await openShp(readZipEntry(path, shpE))).records() : null;
    let rows = 0; let deleted = 0; let unjoined = 0; let coMismatch = 0; let pidEqNo = 0; let pidNeNo = 0; let blankNo = 0;
    let nullShapes = 0; let openRings = 0; let zeroArea = 0; let multiPart = 0;
    const perNo = new Map<string, number>();
    const perJoinedPid = new Map<string, number>();
    const shapeTypes = new Map<string, number>();
    const coValues = new Map<string, number>();
    for await (const r of dbf.records()) {
      rows += 1;
      if (shapes) {
        const s = await shapes.next();
        if (s.done) throw new Error(`${f.name}: .shp shorter than .dbf`);
        bump(shapeTypes, String(s.value.shapeType));
        if (s.value.nullShape) nullShapes += 1; if (!s.value.ringsClosed) openRings += 1;
        if (s.value.area === 0) zeroArea += 1; if (s.value.parts > 1) multiPart += 1;
      }
      if (r.deleted) { deleted += 1; continue; }
      const co = iCo >= 0 ? r.values[iCo] ?? null : null;
      bump(coValues, co ?? '');
      const county = flCountyByDorCode(co);
      const no = iNo >= 0 ? r.values[iNo] ?? null : null;
      const pid = iPid >= 0 ? r.values[iPid] ?? null : null;
      if (no === null) blankNo += 1; else bump(perNo, no);
      if (county === null) { unjoined += 1; continue; }
      if (county.fips !== f.countyFips) coMismatch += 1;
      if (pid !== null) bump(perJoinedPid, pid.toUpperCase());
      if (pid !== null && no !== null && pid === no) pidEqNo += 1; else pidNeNo += 1;
    }
    if (shapes) { const extra = await shapes.next(); if (!extra.done) throw new Error(`${f.name}: .shp longer than .dbf`); }
    total += rows; totalUnjoined += unjoined;
    perFile.push({
      dorCode: f.dorCode, countyFips: f.countyFips, role: f.role, file: f.name, bytes: f.bytes,
      entries: entries.map((e) => e.name.replace(/^.*\//, '')).sort(), crs: prj ? prjName(prj) : null,
      unit: prj ? prjLinearUnitMetres(prj) : null, codePage: cpg, dbfLastUpdate: dbf.header.lastUpdate,
      fields: dbf.header.fields.length, rows, deleted, unjoined, coNoMismatchWithFile: coMismatch,
      parcelNo: { blank: blankNo, distinct: perNo.size, repeated: [...perNo.values()].filter((v) => v > 1).length, joinedWherePARCEL_IDEqualsPARCELNO: pidEqNo, joinedWhereTheyDiffer: pidNeNo },
      joinedParcelIds: { distinct: perJoinedPid.size, withMoreThanOnePolygon: [...perJoinedPid.values()].filter((v) => v > 1).length,
        extraPolygons: [...perJoinedPid.values()].reduce((a, v) => a + Math.max(0, v - 1), 0) },
      geometry: shapes ? { nullShapes, openRings, zeroArea, multiPart, shapeTypes: Object.fromEntries(shapeTypes) } : null,
      decodeReplacements: dbf.decodeReplacements(),
    });
    process.stderr.write(`par ${f.dorCode} ${f.role} ${rows}\n`);
  }
  return {
    source: 'fl_statewide_cadastral', releaseManifestSha256: sha256, referencePeriod: manifest.referencePeriod,
    files: manifest.files.length, totalRecords: total, totalUnjoined, fieldSetVariants: Object.fromEntries(fieldSets), perFile,
  };
}

// ---------------------------------------------------------------------------
// cross: the cadastral file's joined roll columns against the NAL itself
// ---------------------------------------------------------------------------

/** The joined columns compared, PAR name → NAL name, with how each is read. */
const CROSS_FIELDS: readonly { readonly par: string; readonly nal: string; readonly kind: 'number' | 'text' | 'code' }[] = [
  { par: 'ASMNT_YR', nal: 'ASMNT_YR', kind: 'number' },
  { par: 'DOR_UC', nal: 'DOR_UC', kind: 'code' },
  { par: 'JV', nal: 'JV', kind: 'number' },
  { par: 'AV_SD', nal: 'AV_SD', kind: 'number' },
  { par: 'AV_NSD', nal: 'AV_NSD', kind: 'number' },
  { par: 'TV_SD', nal: 'TV_SD', kind: 'number' },
  { par: 'TV_NSD', nal: 'TV_NSD', kind: 'number' },
  { par: 'LND_VAL', nal: 'LND_VAL', kind: 'number' },
  { par: 'LND_SQFOOT', nal: 'LND_SQFOOT', kind: 'number' },
  { par: 'ACT_YR_BLT', nal: 'ACT_YR_BLT', kind: 'number' },
  { par: 'TOT_LVG_AR', nal: 'TOT_LVG_AREA', kind: 'number' },
  { par: 'NO_RES_UNT', nal: 'NO_RES_UNTS', kind: 'number' },
  { par: 'OWN_NAME', nal: 'OWN_NAME', kind: 'text' },
  { par: 'PHY_ADDR1', nal: 'PHY_ADDR1', kind: 'text' },
  { par: 'PHY_CITY', nal: 'PHY_CITY', kind: 'text' },
  { par: 'PHY_ZIPCD', nal: 'PHY_ZIPCD', kind: 'number' },
  { par: 'S_LEGAL', nal: 'S_LEGAL', kind: 'text' },
  { par: 'SALE_PRC1', nal: 'SALE_PRC1', kind: 'number' },
  { par: 'SALE_YR1', nal: 'SALE_YR1', kind: 'number' },
  { par: 'SALE_MO1', nal: 'SALE_MO1', kind: 'code' },
  { par: 'QUAL_CD1', nal: 'QUAL_CD1', kind: 'code' },
  { par: 'OR_BOOK1', nal: 'OR_BOOK1', kind: 'text' },
  { par: 'STATE_PAR_', nal: 'STATE_PAR_ID', kind: 'text' },
];

type Verdict = 'EQUAL' | 'BOTH_ABSENT' | 'DBF_ZERO_FOR_BLANK' | 'TRUNCATED_EQUAL' | 'DIFFERENT' | 'NAL_ONLY' | 'PAR_ONLY';

function compareCross(kind: 'number' | 'text' | 'code', parRaw: string | null, nalRaw: string | undefined, width: number): Verdict {
  const nal = (nalRaw ?? '').trim();
  let par = (parRaw ?? '').trim();
  if (kind === 'number') {
    const p = par === '' ? '' : (par.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
    par = p;
    const n = nal === '' ? '' : String(Number(nal)) === 'NaN' ? nal : String(Number(nal));
    if (p === '' && n === '') return 'BOTH_ABSENT';
    // dBASE numerics cannot be blank: 0 is what the join wrote for an absent value.
    if (n === '' && (p === '0' || p === '')) return 'DBF_ZERO_FOR_BLANK';
    if (p === '' ) return 'NAL_ONLY';
    return p === n || Number(p) === Number(n) ? 'EQUAL' : 'DIFFERENT';
  }
  const pu = par.toUpperCase();
  const nu = nal.toUpperCase();
  if (pu === '' && nu === '') return 'BOTH_ABSENT';
  if (pu === '') return 'NAL_ONLY';
  if (nu === '') return 'PAR_ONLY';
  if (kind === 'code') return pu.replace(/^0+(?=.)/, '') === nu.replace(/^0+(?=.)/, '') ? 'EQUAL' : 'DIFFERENT';
  if (pu === nu) return 'EQUAL';
  // The dBASE column is narrower than the NAL's: a prefix of the right width is the same value.
  if (nu.length > width && nu.slice(0, width).trim() === pu) return 'TRUNCATED_EQUAL';
  return 'DIFFERENT';
}

async function auditCross(): Promise<Record<string, unknown>> {
  const nalRel = latestManifest('fl_dor_nal');
  const parRel = latestManifest('fl_statewide_cadastral');
  const statewide: Record<string, Record<Verdict, number>> = {};
  const perCounty: Record<string, unknown>[] = [];
  let parJoined = 0; let matched = 0; let parOnly = 0; let nalRowsTotal = 0; let nalMatched = 0;
  for (const pf of parRel.manifest.files.filter((f) => f.role === 'county_parcels')) {
    const nf = nalRel.manifest.files.find((f) => f.countyFips === pf.countyFips);
    if (nf === undefined) continue;
    // One county's NAL, only the compared columns, keyed by PARCEL_ID.
    const { header, rows } = await csvRows(artifactPath('fl_dor_nal', nf, nalRel.manifest.referencePeriod));
    const ix = new Map(header.map((h, i) => [h, i] as const));
    const nalBy = new Map<string, (string | undefined)[]>();
    for await (const cells of rows) {
      const pid = (cells[ix.get('PARCEL_ID') as number] ?? '').trim().toUpperCase();
      nalBy.set(pid, CROSS_FIELDS.map((c) => cells[ix.get(c.nal) as number]));
    }
    nalRowsTotal += nalBy.size;
    const path = artifactPath('fl_statewide_cadastral', pf, parRel.manifest.referencePeriod);
    const entries = (await listZipFile(path)).filter((e) => !e.isDirectory);
    const dbfE = entries.find((e) => e.name.toLowerCase().endsWith('.dbf')) as ZipFileEntry;
    const dbf = await openDbf(readZipEntry(path, dbfE));
    const fi = (n: string) => dbf.header.fields.findIndex((x) => x.name === n);
    const widths = CROSS_FIELDS.map((c) => dbf.header.fields[fi(c.par)]?.length ?? 0);
    const cols = CROSS_FIELDS.map((c) => fi(c.par));
    const iCo = fi('CO_NO'); const iPid = fi('PARCEL_ID');
    const county: Record<string, Record<Verdict, number>> = {};
    const seen = new Set<string>();
    let cJoined = 0; let cMatched = 0;
    for await (const r of dbf.records()) {
      const co = r.values[iCo] ?? null;
      if (co === null || /^0+(\.0+)?$/.test(co)) continue;
      cJoined += 1;
      const pid = (r.values[iPid] ?? '').trim().toUpperCase();
      const nal = nalBy.get(pid);
      if (nal === undefined) { parOnly += 1; continue; }
      if (seen.has(pid)) continue; // a second polygon of one parcel compares nothing new
      seen.add(pid);
      cMatched += 1;
      CROSS_FIELDS.forEach((c, k) => {
        const v = compareCross(c.kind, r.values[cols[k] as number] ?? null, nal[k], widths[k] as number);
        const s = (statewide[c.par] ??= {} as Record<Verdict, number>); s[v] = (s[v] ?? 0) + 1;
        const cc = (county[c.par] ??= {} as Record<Verdict, number>); cc[v] = (cc[v] ?? 0) + 1;
      });
    }
    parJoined += cJoined; matched += cMatched; nalMatched += seen.size;
    const rate = (f: string) => { const x = county[f] ?? ({} as Record<Verdict, number>); const t = Object.values(x).reduce((a, b) => a + b, 0); return t === 0 ? null : Math.round(10000 * ((x.EQUAL ?? 0) + (x.BOTH_ABSENT ?? 0) + (x.TRUNCATED_EQUAL ?? 0) + (x.DBF_ZERO_FOR_BLANK ?? 0)) / t) / 100; };
    perCounty.push({ dorCode: pf.dorCode, countyFips: pf.countyFips, nalStage: nf.stage, parJoinedPolygons: cJoined, matchedParcels: cMatched,
      nalRows: nalBy.size, nalWithoutPolygon: nalBy.size - seen.size, agreementPct: Object.fromEntries(CROSS_FIELDS.map((c) => [c.par, rate(c.par)])) });
    process.stderr.write(`cross ${pf.dorCode} ${cMatched}/${nalBy.size}\n`);
  }
  const agreement = Object.fromEntries(Object.entries(statewide).map(([f, v]) => {
    const t = Object.values(v).reduce((a, b) => a + b, 0);
    const ok = (v.EQUAL ?? 0) + (v.BOTH_ABSENT ?? 0) + (v.TRUNCATED_EQUAL ?? 0) + (v.DBF_ZERO_FOR_BLANK ?? 0);
    return [f, { compared: t, agreePct: Math.round(10000 * ok / t) / 100, verdicts: v }];
  }));
  return {
    nalReleaseManifestSha256: nalRel.sha256, parReleaseManifestSha256: parRel.sha256,
    parJoinedPolygons: parJoined, matchedParcels: matched, parJoinedWithoutNalRow: parOnly,
    nalRows: nalRowsTotal, nalParcelsWithPolygon: nalMatched, nalParcelsWithoutPolygon: nalRowsTotal - nalMatched,
    agreement, perCounty,
  };
}

// ---------------------------------------------------------------------------

const out: Record<string, unknown> = {};
if (what === 'nal' || what === 'all') { out['nal'] = await auditNal(); writeFileSync(join(OUT, 'audit-nal.json'), `${JSON.stringify(out['nal'], null, 1)}\n`); }
if (what === 'sdf' || what === 'all') { out['sdf'] = await auditSdf(); writeFileSync(join(OUT, 'audit-sdf.json'), `${JSON.stringify(out['sdf'], null, 1)}\n`); }
if (what === 'par' || what === 'all') { out['par'] = await auditPar(); writeFileSync(join(OUT, 'audit-par.json'), `${JSON.stringify(out['par'], null, 1)}\n`); }
if (what === 'cross' || what === 'all') { out['cross'] = await auditCross(); writeFileSync(join(OUT, 'audit-cross.json'), `${JSON.stringify(out['cross'], null, 1)}\n`); }
process.stdout.write(`${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { rows: (v as { totalRows?: number; totalRecords?: number }).totalRows ?? (v as { totalRecords?: number }).totalRecords }])))}\n`);
void FL_DOR_COUNTIES;
