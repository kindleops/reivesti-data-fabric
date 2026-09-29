/**
 * County inventory of the NYS Tax Parcel Centroid Points, 2025 roll (May 2026
 * build, `NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb`).
 *
 * Measured from the publisher's archive on 2026-09-29 — every row grouped by
 * COUNTY_NAME exactly as the layer spells it — and pinned here as the
 * EXPECTATION the next release is reconciled against. It is not a permanent
 * truth: a county's count moves every roll year, and `reconcileNyCounties()`
 * reports the movement rather than assuming it away.
 *
 * All 62 catalogued New York counties are present, including the five New York
 * City boroughs as their own county-equivalents (Bronx, Kings, New York, Queens,
 * Richmond). The layer writes two names without spaces — `NewYork` and
 * `StLawrence` — which is why the name alone is never trusted: see identity.ts.
 *
 * `swisCountyCode` is the first two digits of every SWIS code in the county. It
 * is the Office of Real Property Tax Services' own county code (01–57 outside
 * New York City, 60–64 for the boroughs), NOT a FIPS code, and in this release
 * each county carries exactly one. A row whose SWIS disagrees with its
 * COUNTY_NAME is refused, never routed by either field alone.
 *
 * `sourceRows` counts every publisher row, including those later quarantined
 * (no SBL, a label, a duplicate). Accepted counts are in the run report.
 */
import { ACTIVE_COUNTY_EQUIVALENTS } from '../../registry/us-geography.ts';

export const NY_STATE_FIPS = '36';

/**
 * Every catalogued New York county FIPS, sorted. Derived from the federal
 * catalogue, never typed in: the "62" in every report is a measurement.
 */
export function nyExpectedCountyFips(): readonly string[] {
  return ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateFips === NY_STATE_FIPS).map((c) => c.fips).sort();
}

export type NyCountyInventory = {
  readonly fips: string;
  /** As the layer spells it in COUNTY_NAME. */
  readonly name: string;
  /** ORPTS's two-digit county code: the first two digits of the county's SWIS codes. */
  readonly swisCountyCode: string;
  readonly sourceRows: number;
};

/** The release the inventory was measured on: `<roll year>-<build yymm>`. */
export const NY_2025_RELEASE = '2025-2605';

export const NY_2025_COUNTY_INVENTORY: readonly NyCountyInventory[] = [
  { fips: '36001', name: 'Albany', swisCountyCode: '01', sourceRows: 112804 },
  { fips: '36003', name: 'Allegany', swisCountyCode: '02', sourceRows: 33683 },
  { fips: '36005', name: 'Bronx', swisCountyCode: '60', sourceRows: 89229 },
  { fips: '36007', name: 'Broome', swisCountyCode: '03', sourceRows: 85058 },
  { fips: '36009', name: 'Cattaraugus', swisCountyCode: '04', sourceRows: 50459 },
  { fips: '36011', name: 'Cayuga', swisCountyCode: '05', sourceRows: 39127 },
  { fips: '36013', name: 'Chautauqua', swisCountyCode: '06', sourceRows: 88396 },
  { fips: '36015', name: 'Chemung', swisCountyCode: '07', sourceRows: 39390 },
  { fips: '36017', name: 'Chenango', swisCountyCode: '08', sourceRows: 32232 },
  { fips: '36019', name: 'Clinton', swisCountyCode: '09', sourceRows: 38741 },
  { fips: '36021', name: 'Columbia', swisCountyCode: '10', sourceRows: 35973 },
  { fips: '36023', name: 'Cortland', swisCountyCode: '11', sourceRows: 22662 },
  { fips: '36025', name: 'Delaware', swisCountyCode: '12', sourceRows: 43000 },
  { fips: '36027', name: 'Dutchess', swisCountyCode: '13', sourceRows: 110364 },
  { fips: '36029', name: 'Erie', swisCountyCode: '14', sourceRows: 370424 },
  { fips: '36031', name: 'Essex', swisCountyCode: '15', sourceRows: 37213 },
  { fips: '36033', name: 'Franklin', swisCountyCode: '16', sourceRows: 32387 },
  { fips: '36035', name: 'Fulton', swisCountyCode: '17', sourceRows: 33209 },
  { fips: '36037', name: 'Genesee', swisCountyCode: '18', sourceRows: 28266 },
  { fips: '36039', name: 'Greene', swisCountyCode: '19', sourceRows: 38418 },
  { fips: '36041', name: 'Hamilton', swisCountyCode: '20', sourceRows: 12947 },
  { fips: '36043', name: 'Herkimer', swisCountyCode: '21', sourceRows: 41442 },
  { fips: '36045', name: 'Jefferson', swisCountyCode: '22', sourceRows: 58979 },
  { fips: '36047', name: 'Kings', swisCountyCode: '61', sourceRows: 275680 },
  { fips: '36049', name: 'Lewis', swisCountyCode: '23', sourceRows: 24688 },
  { fips: '36051', name: 'Livingston', swisCountyCode: '24', sourceRows: 28780 },
  { fips: '36053', name: 'Madison', swisCountyCode: '25', sourceRows: 37627 },
  { fips: '36055', name: 'Monroe', swisCountyCode: '26', sourceRows: 267414 },
  { fips: '36057', name: 'Montgomery', swisCountyCode: '27', sourceRows: 25260 },
  { fips: '36059', name: 'Nassau', swisCountyCode: '28', sourceRows: 423430 },
  { fips: '36061', name: 'NewYork', swisCountyCode: '62', sourceRows: 42061 },
  { fips: '36063', name: 'Niagara', swisCountyCode: '29', sourceRows: 93673 },
  { fips: '36065', name: 'Oneida', swisCountyCode: '30', sourceRows: 105058 },
  { fips: '36067', name: 'Onondaga', swisCountyCode: '31', sourceRows: 181909 },
  { fips: '36069', name: 'Ontario', swisCountyCode: '32', sourceRows: 51318 },
  { fips: '36071', name: 'Orange', swisCountyCode: '33', sourceRows: 145694 },
  { fips: '36073', name: 'Orleans', swisCountyCode: '34', sourceRows: 20538 },
  { fips: '36075', name: 'Oswego', swisCountyCode: '35', sourceRows: 59567 },
  { fips: '36077', name: 'Otsego', swisCountyCode: '36', sourceRows: 39706 },
  { fips: '36079', name: 'Putnam', swisCountyCode: '37', sourceRows: 42291 },
  { fips: '36081', name: 'Queens', swisCountyCode: '63', sourceRows: 324164 },
  { fips: '36083', name: 'Rensselaer', swisCountyCode: '38', sourceRows: 64346 },
  { fips: '36085', name: 'Richmond', swisCountyCode: '64', sourceRows: 125536 },
  { fips: '36087', name: 'Rockland', swisCountyCode: '39', sourceRows: 92620 },
  { fips: '36089', name: 'StLawrence', swisCountyCode: '40', sourceRows: 67717 },
  { fips: '36091', name: 'Saratoga', swisCountyCode: '41', sourceRows: 102202 },
  { fips: '36093', name: 'Schenectady', swisCountyCode: '42', sourceRows: 58472 },
  { fips: '36095', name: 'Schoharie', swisCountyCode: '43', sourceRows: 23033 },
  { fips: '36097', name: 'Schuyler', swisCountyCode: '44', sourceRows: 13274 },
  { fips: '36099', name: 'Seneca', swisCountyCode: '45', sourceRows: 17737 },
  { fips: '36101', name: 'Steuben', swisCountyCode: '46', sourceRows: 55384 },
  { fips: '36103', name: 'Suffolk', swisCountyCode: '47', sourceRows: 586600 },
  { fips: '36105', name: 'Sullivan', swisCountyCode: '48', sourceRows: 67340 },
  { fips: '36107', name: 'Tioga', swisCountyCode: '49', sourceRows: 26133 },
  { fips: '36109', name: 'Tompkins', swisCountyCode: '50', sourceRows: 35369 },
  { fips: '36111', name: 'Ulster', swisCountyCode: '51', sourceRows: 88260 },
  { fips: '36113', name: 'Warren', swisCountyCode: '52', sourceRows: 45869 },
  { fips: '36115', name: 'Washington', swisCountyCode: '53', sourceRows: 35431 },
  { fips: '36117', name: 'Wayne', swisCountyCode: '54', sourceRows: 43900 },
  { fips: '36119', name: 'Westchester', swisCountyCode: '55', sourceRows: 258145 },
  { fips: '36121', name: 'Wyoming', swisCountyCode: '56', sourceRows: 23530 },
  { fips: '36123', name: 'Yates', swisCountyCode: '57', sourceRows: 15902 },
];

export const NY_2025_COUNTIES: readonly string[] = NY_2025_COUNTY_INVENTORY.map((c) => c.fips);

/** The five New York City boroughs: county-equivalents whose rows come from NYC MapPLUTO. */
export const NYC_BOROUGH_FIPS: ReadonlySet<string> = new Set(['36005', '36047', '36061', '36081', '36085']);

export type CountyReconciliation = {
  readonly expected: number;
  readonly actual: number;
  /** Catalogued New York counties with no accepted rows in the delivery. */
  readonly missing: readonly string[];
  /** Counties in the delivery that the catalogue does not list for New York. */
  readonly extra: readonly string[];
  readonly rowCountChanges: readonly { readonly fips: string; readonly expected: number; readonly actual: number }[];
  readonly matches: boolean;
};

/**
 * Compares a delivery's counties against the federal catalogue and the pinned
 * inventory. Never fails a run on its own: a missing county is news an operator
 * must see, and per-partition activation already keeps that county's previous
 * state live.
 *
 * Two different counts, never mixed: `acceptedByFips` (rows accepted, by routed
 * county) decides which counties are present; `rawRowsByCountyName` (every
 * publisher row, by the raw COUNTY_NAME) is compared with the inventory, which
 * was measured the same way.
 */
export function reconcileNyCounties(
  acceptedByFips: ReadonlyMap<string, number>,
  rawRowsByCountyName: Readonly<Record<string, number>>,
): CountyReconciliation {
  const expected = new Set(nyExpectedCountyFips());
  const actual = new Set(acceptedByFips.keys());
  const missing = [...expected].filter((f) => !actual.has(f)).sort();
  const extra = [...actual].filter((f) => !expected.has(f)).sort();
  const rowCountChanges: { fips: string; expected: number; actual: number }[] = [];
  for (const county of NY_2025_COUNTY_INVENTORY) {
    const n = rawRowsByCountyName[county.name] ?? 0;
    if (n !== county.sourceRows) rowCountChanges.push({ fips: county.fips, expected: county.sourceRows, actual: n });
  }
  return {
    expected: expected.size,
    actual: actual.size,
    missing,
    extra,
    rowCountChanges,
    matches: missing.length === 0 && extra.length === 0,
  };
}
