/**
 * DF-0I: deterministic synthetic parcel bundles at arbitrary scale.
 *
 * Shaped like the MnGeo statewide delivery so it exercises the same connector,
 * and distributed across many county partitions so partition planning is
 * exercised too. No personal data: every owner name is a generated token.
 */
import { createFileLineWriter } from '../src/core/lines.ts';
import { canonicalJson } from '../src/core/hash.ts';
import { readFileSync } from 'node:fs';
import { ACTIVE_COUNTY_EQUIVALENTS } from '../src/registry/us-geography.ts';

const [outPath, rowsArg, layerMeta, countyArg] = process.argv.slice(2) as string[];
const ROWS = Number(rowsArg);
const COUNTIES = Number(countyArg ?? 59);
const fields = (JSON.parse(readFileSync(layerMeta as string, 'utf8')) as { fields: unknown[] }).fields;

// Real Minnesota counties, so routing runs against the real catalogue.
const counties = ACTIVE_COUNTY_EQUIVALENTS
  .filter((c) => c.stateFips === '27').slice(0, COUNTIES).map((c) => ({ fips: c.fips, name: c.name.replace(/ County$/, '') }));

const writer = await createFileLineWriter(outPath as string);
await writer.write(canonicalJson({
  kind: 'df.gpkg.snapshot/1',
  sourceId: 'mn_statewide_parcels',
  serviceUrl: 'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer',
  layerId: 1,
  acquisition: { method: 'synthetic', downloadUrl: 'synthetic', archiveSha256: '0'.repeat(64), note: 'DF-0I scale proof; no real rows' },
  retrievedAt: '2026-09-01T00:00:00.000Z',
  sourceReportedCount: ROWS,
  sourceSchemaDigest: 'synthetic',
  layerMetadata: { fields },
  declaredFields: [],
  countyMetadata: [],
}));

const STREETS = ['SYNTHETIC', 'NOTIONAL', 'FABRICATED', 'IMAGINARY', 'PLACEHOLDER', 'INVENTED'];
const TYPES = ['AVE', 'ST', 'RD', 'LN', 'BLVD', 'CT'];
for (let i = 0; i < ROWS; i++) {
  const county = counties[i % counties.length] as { fips: string; name: string };
  const pin = `SYN${String(i).padStart(10, '0')}`;
  await writer.write(JSON.stringify({
    objectid: i + 1,
    co_code: county.fips,
    co_name: county.name,
    state_code: 'MN',
    county_pin: pin,
    state_pin: `${county.fips}-${pin}`,
    anumber: (i % 9999) + 1,
    st_name: STREETS[i % STREETS.length],
    st_pos_typ: TYPES[i % TYPES.length],
    ctu_name: `${county.name} City`,
    zip: `55${String(400 + (i % 90)).padStart(3, '0')}`,
    owner_name: `SYNTHETIC OWNER ${i % 100000}`,
    tax_name: `SYNTHETIC TAXPAYER ${i % 100000}`,
    own_add_l1: `${(i % 9999) + 1} GENERATED WAY`,
    emv_land: 40000 + (i % 50000),
    emv_bldg: 90000 + (i % 250000),
    emv_total: 130000 + (i % 300000),
    mkt_year: 2026,
    tax_year: 2026,
    total_tax: 1000 + (i % 9000),
    year_built: 1900 + (i % 126),
    fin_sq_ft: 600 + (i % 4000),
    acres_poly: Math.round(((i % 500) / 100 + 0.05) * 100) / 100,
    sale_date: i % 3 === 0 ? `20${String(10 + (i % 15)).padStart(2, '0')}-0${(i % 9) + 1}-1${i % 9}T00:00:00.000Z` : undefined,
    sale_value: i % 2 === 0 ? 100000 + (i % 400000) : undefined,
    n_standard: 1,
    edit_date: '2026-07-01T00:00:00.000Z',
  }));
}
await writer.write(canonicalJson({
  kind: 'df.arcgis.snapshot.trailer/2',
  retrievedFeatureCount: ROWS, sourceReportedCountAtEnd: ROWS,
  sourceChangedDuringRead: false, missingObjectIds: [],
}));
await writer.close();
console.log(JSON.stringify({ rows: ROWS, counties: counties.length, out: outPath }));
