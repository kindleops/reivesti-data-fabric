/**
 * County inventory of the Wisconsin Statewide Parcel Map, V12.0.0 (2026).
 *
 * Measured from the publisher's archive on 2026-09-28 — rows grouped by CONAME,
 * the county each parcel lies in — and pinned here as the EXPECTATION the next
 * release is reconciled against. It is not a permanent truth: a county's count
 * moves every year, and `reconcileWiCounties()` reports the movement rather
 * than assuming it away.
 *
 * All 72 catalogued Wisconsin counties are present; there is no opt-in gap of
 * the kind Minnesota has. 3,574,645 rows route to a county; one row names
 * "MENOMONIE", which is a city, and routes nowhere.
 *
 * `loadDates` is when the State Cartographer's Office loaded each submission,
 * which is the per-county freshness. Two counties have more than one because
 * multi-county cities submit through a neighbouring county: Calumet receives
 * Appleton's parcels via Outagamie (loaded 2026-03-03) and Menasha's via
 * Winnebago (2026-03-13), beside its own submission (2026-03-11).
 *
 * `sourceRows` counts every row, placeholders included; accepted parcels are
 * fewer. The run report carries the accepted figures.
 */
import { wiExpectedCountyFips } from './identity.ts';

export type WiCountyInventory = {
  readonly fips: string;
  /** As the layer spells it in CONAME. */
  readonly name: string;
  readonly sourceRows: number;
  readonly loadDates: readonly string[];
};

export const WI_V12_RELEASE = 'V12.0.0-2026';

export const WI_V12_COUNTY_INVENTORY: readonly WiCountyInventory[] = [
  { fips: '55001', name: "ADAMS", sourceRows: 38489, loadDates: ['2026-03-04'] },
  { fips: '55003', name: "ASHLAND", sourceRows: 21352, loadDates: ['2026-03-12'] },
  { fips: '55005', name: "BARRON", sourceRows: 45011, loadDates: ['2026-01-28'] },
  { fips: '55007', name: "BAYFIELD", sourceRows: 35897, loadDates: ['2026-03-12'] },
  { fips: '55009', name: "BROWN", sourceRows: 105679, loadDates: ['2026-02-05'] },
  { fips: '55011', name: "BUFFALO", sourceRows: 24414, loadDates: ['2026-03-13'] },
  { fips: '55013', name: "BURNETT", sourceRows: 34015, loadDates: ['2026-02-10'] },
  { fips: '55015', name: "CALUMET", sourceRows: 29685, loadDates: ['2026-03-03', '2026-03-11', '2026-03-13'] },
  { fips: '55017', name: "CHIPPEWA", sourceRows: 52868, loadDates: ['2026-02-10'] },
  { fips: '55019', name: "CLARK", sourceRows: 35567, loadDates: ['2026-02-17'] },
  { fips: '55021', name: "COLUMBIA", sourceRows: 43719, loadDates: ['2026-03-03'] },
  { fips: '55023', name: "CRAWFORD", sourceRows: 23135, loadDates: ['2026-03-23'] },
  { fips: '55025', name: "DANE", sourceRows: 218857, loadDates: ['2026-03-09'] },
  { fips: '55027', name: "DODGE", sourceRows: 47987, loadDates: ['2026-03-10'] },
  { fips: '55029', name: "DOOR", sourceRows: 43560, loadDates: ['2026-03-10'] },
  { fips: '55031', name: "DOUGLAS", sourceRows: 47729, loadDates: ['2026-03-10'] },
  { fips: '55033', name: "DUNN", sourceRows: 36011, loadDates: ['2026-03-13'] },
  { fips: '55035', name: "EAU CLAIRE", sourceRows: 52015, loadDates: ['2026-03-03'] },
  { fips: '55037', name: "FLORENCE", sourceRows: 12168, loadDates: ['2026-02-28'] },
  { fips: '55039', name: "FOND DU LAC", sourceRows: 60408, loadDates: ['2026-02-11'] },
  { fips: '55041', name: "FOREST", sourceRows: 21022, loadDates: ['2026-02-04'] },
  { fips: '55043', name: "GRANT", sourceRows: 48765, loadDates: ['2026-03-12'] },
  { fips: '55045', name: "GREEN", sourceRows: 28052, loadDates: ['2026-03-13'] },
  { fips: '55047', name: "GREEN LAKE", sourceRows: 19471, loadDates: ['2026-03-04'] },
  { fips: '55049', name: "IOWA", sourceRows: 31740, loadDates: ['2026-03-11'] },
  { fips: '55051', name: "IRON", sourceRows: 17963, loadDates: ['2026-03-02'] },
  { fips: '55053', name: "JACKSON", sourceRows: 27652, loadDates: ['2026-03-12'] },
  { fips: '55055', name: "JEFFERSON", sourceRows: 45169, loadDates: ['2026-02-09'] },
  { fips: '55057', name: "JUNEAU", sourceRows: 31381, loadDates: ['2026-01-26'] },
  { fips: '55059', name: "KENOSHA", sourceRows: 68499, loadDates: ['2026-03-09'] },
  { fips: '55061', name: "KEWAUNEE", sourceRows: 16750, loadDates: ['2026-03-02'] },
  { fips: '55063', name: "LA CROSSE", sourceRows: 54142, loadDates: ['2026-03-03'] },
  { fips: '55065', name: "LAFAYETTE", sourceRows: 21562, loadDates: ['2026-03-10'] },
  { fips: '55067', name: "LANGLADE", sourceRows: 29492, loadDates: ['2026-03-09'] },
  { fips: '55069', name: "LINCOLN", sourceRows: 30616, loadDates: ['2026-02-16'] },
  { fips: '55071', name: "MANITOWOC", sourceRows: 49744, loadDates: ['2026-01-21'] },
  { fips: '55073', name: "MARATHON", sourceRows: 83708, loadDates: ['2026-03-04'] },
  { fips: '55075', name: "MARINETTE", sourceRows: 57986, loadDates: ['2026-03-05'] },
  { fips: '55077', name: "MARQUETTE", sourceRows: 22030, loadDates: ['2026-03-02'] },
  { fips: '55078', name: "MENOMINEE", sourceRows: 4514, loadDates: ['2026-03-12'] },
  { fips: '55079', name: "MILWAUKEE", sourceRows: 280676, loadDates: ['2026-02-19'] },
  { fips: '55081', name: "MONROE", sourceRows: 39367, loadDates: ['2026-03-10'] },
  { fips: '55083', name: "OCONTO", sourceRows: 42142, loadDates: ['2026-03-12'] },
  { fips: '55085', name: "ONEIDA", sourceRows: 58355, loadDates: ['2026-03-03'] },
  { fips: '55087', name: "OUTAGAMIE", sourceRows: 94426, loadDates: ['2026-03-03'] },
  { fips: '55089', name: "OZAUKEE", sourceRows: 41165, loadDates: ['2026-02-20'] },
  { fips: '55091', name: "PEPIN", sourceRows: 9693, loadDates: ['2026-02-02'] },
  { fips: '55093', name: "PIERCE", sourceRows: 28378, loadDates: ['2026-03-04'] },
  { fips: '55095', name: "POLK", sourceRows: 48937, loadDates: ['2026-02-16'] },
  { fips: '55097', name: "PORTAGE", sourceRows: 47509, loadDates: ['2026-01-16'] },
  { fips: '55099', name: "PRICE", sourceRows: 27890, loadDates: ['2026-04-20'] },
  { fips: '55101', name: "RACINE", sourceRows: 84569, loadDates: ['2026-03-12'] },
  { fips: '55103', name: "RICHLAND", sourceRows: 20907, loadDates: ['2026-03-10'] },
  { fips: '55105', name: "ROCK", sourceRows: 73143, loadDates: ['2026-03-05'] },
  { fips: '55107', name: "RUSK", sourceRows: 29163, loadDates: ['2026-03-19'] },
  { fips: '55109', name: "ST CROIX", sourceRows: 54900, loadDates: ['2026-03-13'] },
  { fips: '55111', name: "SAUK", sourceRows: 50762, loadDates: ['2026-02-20'] },
  { fips: '55113', name: "SAWYER", sourceRows: 42906, loadDates: ['2026-03-19'] },
  { fips: '55115', name: "SHAWANO", sourceRows: 40318, loadDates: ['2026-03-03'] },
  { fips: '55117', name: "SHEBOYGAN", sourceRows: 62042, loadDates: ['2026-03-03'] },
  { fips: '55119', name: "TAYLOR", sourceRows: 25650, loadDates: ['2026-02-12'] },
  { fips: '55121', name: "TREMPEALEAU", sourceRows: 33157, loadDates: ['2026-04-20'] },
  { fips: '55123', name: "VERNON", sourceRows: 35555, loadDates: ['2026-03-13'] },
  { fips: '55125', name: "VILAS", sourceRows: 49901, loadDates: ['2026-02-19'] },
  { fips: '55127', name: "WALWORTH", sourceRows: 69231, loadDates: ['2026-03-09'] },
  { fips: '55129', name: "WASHBURN", sourceRows: 34927, loadDates: ['2026-01-28'] },
  { fips: '55131', name: "WASHINGTON", sourceRows: 63682, loadDates: ['2026-03-06'] },
  { fips: '55133', name: "WAUKESHA", sourceRows: 164715, loadDates: ['2026-03-10'] },
  { fips: '55135', name: "WAUPACA", sourceRows: 43171, loadDates: ['2026-03-11'] },
  { fips: '55137', name: "WAUSHARA", sourceRows: 31328, loadDates: ['2026-03-11'] },
  { fips: '55139', name: "WINNEBAGO", sourceRows: 80772, loadDates: ['2026-03-03', '2026-03-13'] },
  { fips: '55141', name: "WOOD", sourceRows: 46484, loadDates: ['2026-03-06'] },
];

export const WI_V12_COUNTIES: readonly string[] = WI_V12_COUNTY_INVENTORY.map((c) => c.fips);

export type CountyReconciliation = {
  readonly expected: number;
  readonly actual: number;
  /** Catalogued Wisconsin counties with no rows in the delivery. */
  readonly missing: readonly string[];
  /** Counties in the delivery that the catalogue does not list for Wisconsin. */
  readonly extra: readonly string[];
  readonly rowCountChanges: readonly { readonly fips: string; readonly expected: number; readonly actual: number }[];
  readonly matches: boolean;
};

/**
 * Compares a delivery's counties against the federal catalogue and the pinned
 * inventory. Never fails a run on its own: a missing county is news an
 * operator must see, and the per-partition activation already keeps that
 * county's previous state live.
 */
export function reconcileWiCounties(actualCounts: ReadonlyMap<string, number>): CountyReconciliation {
  const expected = new Set(wiExpectedCountyFips());
  const actual = new Set(actualCounts.keys());
  const missing = [...expected].filter((f) => !actual.has(f)).sort();
  const extra = [...actual].filter((f) => !expected.has(f)).sort();
  const rowCountChanges: { fips: string; expected: number; actual: number }[] = [];
  for (const county of WI_V12_COUNTY_INVENTORY) {
    const n = actualCounts.get(county.fips);
    if (n !== undefined && n !== county.sourceRows) rowCountChanges.push({ fips: county.fips, expected: county.sourceRows, actual: n });
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
