/**
 * DF-0M foundations: the Florida county table, the PTO library discovery, and
 * the streaming readers the statewide files need (zip entry, dBase, shapefile).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDbf } from '../src/core/dbf.ts';
import { openShp, prjLinearUnitMetres, prjName } from '../src/core/shp.ts';
import { listZipFile, readZipEntry } from '../src/core/zip-file.ts';
import { isFabricError } from '../src/core/errors.ts';
import { ACTIVE_COUNTY_EQUIVALENTS } from '../src/registry/us-geography.ts';
import {
  FL_DOR_COUNTIES,
  flCountyByDorCode,
  flCountyByFileName,
  flExpectedCountyFips,
  routeFlCounty,
} from '../src/connectors/fl-dor/counties.ts';
import {
  FL_PTO_LIBRARY,
  discoverFlParcelShapefiles,
  discoverFlRoll,
  isHiddenPortalPath,
  listPortalFolder,
} from '../src/connectors/fl-dor/portal.ts';
import {
  STATE_PLANE_FL_NORTH_FEET_PRJ,
  dbfOf,
  fakePortal,
  shpOf,
  square,
  zipOf,
  type DbfFieldSpec,
} from './support/fl-fixture.ts';
import { tempRoot } from './helpers.ts';

// ===========================================================================
// County table
// ===========================================================================

test('the DOR county table names all 67 Florida counties, one FIPS each, checked against the national catalogue', () => {
  assert.equal(FL_DOR_COUNTIES.length, 67);
  const catalogue = new Map(ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateFips === '12').map((c) => [c.fips, c.name]));
  assert.equal(catalogue.size, 67);
  assert.equal(new Set(FL_DOR_COUNTIES.map((c) => c.fips)).size, 67, 'no FIPS used twice');
  assert.equal(new Set(FL_DOR_COUNTIES.map((c) => c.dorCode)).size, 67, 'no DOR number used twice');
  const fold = (s: string) => s.toLowerCase().replace(/ county$/, '').replace(/^st\. /, 'saint ').replace(/[^a-z]/g, '');
  for (const c of FL_DOR_COUNTIES) {
    const name = catalogue.get(c.fips);
    assert.ok(name, `${c.dorName}: FIPS ${c.fips} is not a catalogued Florida county`);
    assert.equal(fold(name), fold(c.dorName), `${c.dorCode} ${c.dorName} ≠ ${c.fips} ${name}`);
  }
  assert.deepEqual(flExpectedCountyFips(), [...catalogue.keys()].sort());
});

test('DOR numbers are not FIPS arithmetic: Miami-Dade, DeSoto and Seminole prove it', () => {
  assert.equal(flCountyByDorCode('23')?.fips, '12086', 'numbered as Dade before 1997, FIPS 12086 since');
  assert.equal(flCountyByDorCode('24')?.fips, '12027');
  assert.equal(flCountyByDorCode('69')?.fips, '12117');
  assert.equal(flCountyByDorCode('58')?.dorName, 'Orange');
});

test('CO_NO is read as the files write it, and anything else is not a county', () => {
  assert.equal(flCountyByDorCode('44')?.dorName, 'Lafayette');
  assert.equal(flCountyByDorCode('44.00000')?.dorName, 'Lafayette', 'the shapefile DBF writes N(19,5)');
  assert.equal(flCountyByDorCode(44)?.dorName, 'Lafayette');
  for (const bad of ['0', '0.00000', '00', '10', '78', '99', 'A4', '44.5', '', ' ', null, undefined]) {
    assert.equal(flCountyByDorCode(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => routeFlCounty('0', 'row 1'), (e) => isFabricError(e) && e.kind === 'PARSE');
});

test('a filename is read for its county NAME only — the 2026 folder mislabels Seminole as 58', () => {
  assert.equal(flCountyByFileName('Seminole 58 Preliminary NAL 2026.zip')?.dorCode, '69');
  assert.equal(flCountyByFileName('Broward Preliminary NAL 2026.zip')?.dorCode, '16');
  assert.equal(flCountyByFileName('Dade 23 Preliminary SDF 2026.zip')?.dorCode, '23');
  assert.equal(flCountyByFileName('miamidade_condos_2026.zip')?.dorCode, '23');
  assert.equal(flCountyByFileName('stjohnscondos_2026.zip')?.dorCode, '65');
  assert.equal(flCountyByFileName('Saint Lucie 66 Preliminary NAL 2026.zip')?.dorCode, '66');
  assert.equal(flCountyByFileName('palmbeach_2026Ppar.zip')?.dorCode, '60');
  assert.equal(flCountyByFileName('indianriver_2026Ppar.zip')?.dorCode, '41');
  assert.equal(flCountyByFileName('Levy 48 Preliminary NAL 2026.zip')?.dorCode, '48', 'not Lee');
  assert.equal(flCountyByFileName('Atlantis 99 Preliminary NAL 2026.zip'), null);
});

// ===========================================================================
// PTO library discovery
// ===========================================================================

function rollFixture() {
  const portal = fakePortal();
  const zip = (name: string) => zipOf([{ name, bytes: Buffer.from('CO_NO,PARCEL_ID\r\n') }]);
  for (const c of FL_DOR_COUNTIES) {
    if (c.dorCode === '26' || c.dorCode === '19') {
      portal.put(`Tax Roll Data Files/NAL/2026F/${c.dorName} ${c.dorCode} Final NAL 2026.zip`, zip('x.csv'));
    } else {
      // The two real filename anomalies, reproduced.
      const label = c.dorCode === '69' ? `${c.dorName} 58` : c.dorCode === '16' ? c.dorName : `${c.dorName} ${c.dorCode}`;
      portal.put(`Tax Roll Data Files/NAL/2026P/${label} Preliminary NAL 2026.zip`, zip('x.csv'));
    }
  }
  // Staff and request folders the connector must never enter.
  portal.folder('Tax Roll Data Files/~NAL-EDR/2026P');
  portal.put('Tax Roll Data Files/~NAL-EDR/2026P/NAL_CONF_2026P_to_analysts.txt', Buffer.from('never read'));
  portal.folder('Tax Roll Data Files/NAL/~Temp');
  return portal;
}

test('the current roll is the newest year, one file per county, a final superseding a preliminary', async () => {
  const portal = rollFixture();
  // Duval's preliminary is still posted beside its final.
  portal.put('Tax Roll Data Files/NAL/2026P/Duval 26 Preliminary NAL 2026.zip', zipOf([{ name: 'x.csv', bytes: Buffer.from('a') }]));
  // Last year's final is still posted too.
  portal.put('Tax Roll Data Files/NAL/2025F/Alachua 11 Final NAL 2025.zip', zipOf([{ name: 'x.csv', bytes: Buffer.from('a') }]));
  const release = await discoverFlRoll('NAL', { fetchImpl: portal.fetchImpl, sleep: async () => {} });
  assert.equal(release.rollYear, 2026);
  assert.equal(release.files.length, 67);
  assert.deepEqual(release.stageCounts, { FINAL: 2, PRELIMINARY: 65 });
  assert.deepEqual(release.missingCounties, []);
  assert.equal(release.files.find((f) => f.county.dorCode === '26')?.stage, 'FINAL');
  assert.deepEqual(release.superseded.map((f) => f.file.name), ['Duval 26 Preliminary NAL 2026.zip']);
  const anomalies = Object.fromEntries(release.files.filter((f) => f.nameAnomalies.length > 0).map((f) => [f.county.dorName, f.nameAnomalies]));
  assert.deepEqual(anomalies, { Broward: ['FILENAME_CODE_ABSENT'], Seminole: ['FILENAME_CODE_MISMATCH:58'] });
  assert.equal(portal.fileGets(), 0, 'discovery lists; it never downloads');
});

test('a ~ folder is never listed, never entered, and cannot be asked for', async () => {
  const portal = rollFixture();
  const release = await discoverFlRoll('NAL', { fetchImpl: portal.fetchImpl, sleep: async () => {} });
  assert.ok(release.hiddenFoldersIgnored >= 1);
  assert.ok(portal.requests.every((r) => !decodeURIComponent(r.url).includes('~')), 'no request touched a ~ path');
  assert.equal(isHiddenPortalPath(`${FL_PTO_LIBRARY}/Tax Roll Data Files/~NAL-EDR`), true);
  await assert.rejects(
    listPortalFolder(`${FL_PTO_LIBRARY}/Tax Roll Data Files/~NAL-EDR`, { fetchImpl: portal.fetchImpl, sleep: async () => {} }),
    (e) => isFabricError(e) && e.kind === 'CONFIG',
  );
  await assert.rejects(listPortalFolder('/somewhere/else', { fetchImpl: portal.fetchImpl, sleep: async () => {} }));
});

test('discovery sends no credential, cookie or token — only the listing request and an Accept header', async () => {
  const portal = rollFixture();
  await discoverFlRoll('SDF', { fetchImpl: portal.fetchImpl, sleep: async () => {} }).catch(() => {});
  for (const r of portal.requests) {
    const names = Object.keys(r.headers).map((h) => h.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'x-requestdigest', 'x-api-key']) assert.ok(!names.includes(forbidden), forbidden);
  }
});

test('the release fingerprint moves when any one county file changes, and only then', async () => {
  const portal = rollFixture();
  const http = { fetchImpl: portal.fetchImpl, sleep: async () => {} };
  const a = await discoverFlRoll('NAL', http);
  const b = await discoverFlRoll('NAL', http);
  assert.equal(a.releaseFingerprint, b.releaseFingerprint);
  portal.put('Tax Roll Data Files/NAL/2026P/Holmes 40 Preliminary NAL 2026.zip', zipOf([{ name: 'x.csv', bytes: Buffer.from('changed') }]), { etag: '"{NEW},2"' });
  const c = await discoverFlRoll('NAL', http);
  assert.notEqual(c.releaseFingerprint, a.releaseFingerprint);
});

test('a county missing from the roll is reported, not invented', async () => {
  const portal = rollFixture();
  portal.remove('Tax Roll Data Files/NAL/2026P/Liberty 49 Preliminary NAL 2026.zip');
  const release = await discoverFlRoll('NAL', { fetchImpl: portal.fetchImpl, sleep: async () => {} });
  assert.deepEqual(release.missingCounties, ['49']);
  assert.equal(release.files.length, 66);
});

test('the parcel shapefiles are the newest <year>F PAR folder, with the condominium tables beside their counties', async () => {
  const portal = fakePortal();
  const z = zipOf([{ name: 'a.dbf', bytes: Buffer.from('x') }]);
  for (const c of FL_DOR_COUNTIES) {
    const stem = c.dorName.toLowerCase().replace(/^saint /, 'st').replace(/[^a-z]/g, '');
    portal.put(`Map Data/2026F/2026F PAR/${stem}_2026Ppar.zip`, z);
    portal.put(`Map Data/2026F/2026F PIN/${stem}_2026pin.zip`, z);
  }
  portal.put('Map Data/2026F/2026F PAR/miamidade_condos_2026.zip', z);
  portal.put('Map Data/2026F/2026F PAR/stjohnscondos_2026.zip', z);
  portal.put('Map Data/2019F/leon_2019par.zip', z); // an older flat year
  portal.put('Map Data/parcel shapefiles readme.pdf', Buffer.from('%PDF'));
  const release = await discoverFlParcelShapefiles({ fetchImpl: portal.fetchImpl, sleep: async () => {} });
  assert.equal(release.rollYear, 2026);
  assert.equal(release.files.filter((f) => f.role === 'county_parcels').length, 67);
  assert.deepEqual(release.files.filter((f) => f.role === 'condo_related').map((f) => f.county.dorCode), ['23', '65']);
  assert.deepEqual(release.stageCounts, { PRELIMINARY: 67 });
  assert.deepEqual(release.missingCounties, []);
  assert.ok(release.files.every((f) => f.folder.endsWith('2026F PAR')), 'PIN shapefiles carry no attributes and are not the source');
});

// ===========================================================================
// Streaming readers
// ===========================================================================

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

const FIELDS: readonly DbfFieldSpec[] = [
  { name: 'PARCELNO', type: 'C', length: 12 },
  { name: 'CO_NO', type: 'N', length: 19, decimals: 5 },
  { name: 'JV', type: 'N', length: 19, decimals: 5 },
  { name: 'OWN_NAME', type: 'C', length: 20 },
];

test('the dBase reader streams fixed-width records literally, across any chunking', async () => {
  const table = dbfOf(FIELDS, [
    { PARCELNO: '0101', CO_NO: 44, JV: 350000, OWN_NAME: 'TEST OWNER' },
    { PARCELNO: '0102', CO_NO: 44, JV: null, OWN_NAME: 'ÑANDÚ LLC' },
    { PARCELNO: '0103', CO_NO: 0, JV: 12.5, OWN_NAME: null, __deleted: true },
  ]);
  for (const size of [1, 7, 64, table.length]) {
    const dbf = await openDbf(chunked(table, size));
    assert.equal(dbf.header.recordCount, 3);
    assert.deepEqual(dbf.header.fields.map((f) => [f.name, f.type, f.length, f.decimals]), FIELDS.map((f) => [f.name, f.type, f.length, f.decimals ?? 0]));
    const rows = [];
    for await (const r of dbf.records()) rows.push(r);
    assert.deepEqual(rows.map((r) => [r.deleted, ...r.values]), [
      [false, '0101', '44.00000', '350000.00000', 'TEST OWNER'],
      [false, '0102', '44.00000', null, 'ÑANDÚ LLC'],
      [true, '0103', '0.00000', '12.50000', null],
    ]);
    assert.equal(dbf.decodeReplacements(), 0);
  }
});

test('a dBase table shorter than its header declares fails, rather than yielding a short estate', async () => {
  const table = dbfOf(FIELDS, [{ PARCELNO: '1', CO_NO: 44 }], { declaredCount: 2, eof: false });
  const dbf = await openDbf(chunked(table, 16));
  await assert.rejects((async () => { for await (const _ of dbf.records()) { /* read */ } })(), /declares 2 records|short/);
});

test('the shapefile reader summarises area and centroid exactly, holes subtracting, multi-part included', async () => {
  const { shp } = shpOf([
    [square(0, 0, 10)],
    [square(0, 0, 10), square(2, 2, 2, true)],
    [square(0, 0, 10), square(20, 0, 10)],
    null,
  ]);
  const reader = await openShp(chunked(shp, 13));
  const out = [];
  for await (const s of reader.records()) out.push(s);
  assert.equal(out.length, 4);
  assert.deepEqual([out[0]!.area, out[0]!.centroid, out[0]!.parts, out[0]!.points], [100, [5, 5], 1, 5]);
  assert.equal(out[1]!.area, 96, 'a 2×2 hole subtracts');
  assert.ok(Math.abs(out[1]!.centroid![0] - (500 - 4 * 3) / 96) < 1e-12);
  assert.deepEqual([out[2]!.area, out[2]!.centroid, out[2]!.parts], [200, [15, 5], 2]);
  assert.deepEqual([out[3]!.nullShape, out[3]!.area, out[3]!.centroid], [true, null, null]);
  assert.ok(out.every((s) => s.ringsClosed));
});

test('an unclosed ring is reported, not repaired', async () => {
  const { shp } = shpOf([[[[0, 0], [0, 10], [10, 10], [10, 0]]]]);
  const reader = await openShp(chunked(shp, 1 << 16));
  const [s] = await (async () => { const a = []; for await (const x of reader.records()) a.push(x); return a; })();
  assert.equal(s!.ringsClosed, false);
});

test('the .prj says what unit the numbers are in', () => {
  assert.deepEqual(prjLinearUnitMetres(STATE_PLANE_FL_NORTH_FEET_PRJ), { name: 'Foot_US', metres: 0.30480060960121924 });
  assert.equal(prjName(STATE_PLANE_FL_NORTH_FEET_PRJ), 'NAD_1983_StatePlane_Florida_North_FIPS_0903_Feet');
  assert.equal(prjLinearUnitMetres('GEOGCS["GCS_WGS_1984",UNIT["Degree",0.0174532925199433]]'), null);
});

test('a zip entry streams verified, and a corrupt one fails on its last chunk', async () => {
  const dir = tempRoot('df-flzip-');
  const payload = Buffer.from('CO_NO,PARCEL_ID\r\n44,0101\r\n'.repeat(500));
  const good = join(dir, 'good.zip');
  writeFileSync(good, zipOf([{ name: 'NAL44P202601.csv', bytes: payload }]));
  const [entry] = await listZipFile(good);
  const chunks: Buffer[] = [];
  for await (const c of readZipEntry(good, entry!)) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), payload);

  // The same bytes under a declared CRC-32 they do not have: what a corrupted
  // archive looks like to a reader that trusts nothing until the last chunk.
  const bad = join(dir, 'bad.zip');
  const archive = zipOf([{ name: 'NAL44P202601.csv', bytes: payload }]);
  const cd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE((archive.readUInt32LE(cd + 16) ^ 0xffffffff) >>> 0, cd + 16);
  writeFileSync(bad, archive);
  const [badEntry] = await listZipFile(bad);
  await assert.rejects((async () => { for await (const _ of readZipEntry(bad, badEntry!)) { /* read */ } })(), /CRC-32/);
});
