/**
 * Florida Department of Revenue county numbers → federal county FIPS.
 *
 * Every Florida DOR file — NAL, SDF, NAP, and the parcel shapefiles joined to
 * them — identifies its county by a two-digit **DOR county number** (`CO_NO`),
 * 11 through 77. It is not a FIPS code and it is not derivable from one:
 *
 * - DOR assigned the numbers alphabetically **before 1997**, when Dade County
 *   became Miami-Dade. The 2026 User's Guide says so: "Miami-Dade" still sorts
 *   under "D" and keeps number 23. Its FIPS is 12086, a code the Census Bureau
 *   issued in 1997; 12025, the old Dade FIPS, is retired.
 * - DeSoto is DOR 24 and FIPS 12027; Seminole is DOR 69 and FIPS 12117. Any
 *   arithmetic from one to the other is wrong somewhere.
 *
 * So the relationship is written down, one row per county, exactly as the
 * User's Guide tabulates it (field 1 of the NAL and SDF layouts,
 * "County Numbers"), and each FIPS is checked against the national jurisdiction
 * catalogue by name in the tests — never computed.
 *
 * Filenames are not a routing source either. The 2026 preliminary NAL folder
 * names Seminole's file "Seminole 58" (58 is Orange) and Broward's carries no
 * number at all. Rows route by the `CO_NO` inside the data, through this table.
 *
 * Source: Florida Department of Revenue, Property Tax Oversight,
 * "2026 User's Guide — Department Property Tax Data Files", field 1, and the
 * "County Codes" sheet of the 2026 User's Guide Quick Reference workbook.
 */
import { fail } from '../../core/errors.ts';

export const FL_STATE_FIPS = '12';

export type FlDorCounty = {
  /** The DOR county number, two digits. */
  readonly dorCode: string;
  /** As the User's Guide spells it. */
  readonly dorName: string;
  /** Federal county FIPS, state + county. */
  readonly fips: string;
};

export const FL_DOR_COUNTIES: readonly FlDorCounty[] = [
  { dorCode: '11', dorName: 'Alachua', fips: '12001' },
  { dorCode: '12', dorName: 'Baker', fips: '12003' },
  { dorCode: '13', dorName: 'Bay', fips: '12005' },
  { dorCode: '14', dorName: 'Bradford', fips: '12007' },
  { dorCode: '15', dorName: 'Brevard', fips: '12009' },
  { dorCode: '16', dorName: 'Broward', fips: '12011' },
  { dorCode: '17', dorName: 'Calhoun', fips: '12013' },
  { dorCode: '18', dorName: 'Charlotte', fips: '12015' },
  { dorCode: '19', dorName: 'Citrus', fips: '12017' },
  { dorCode: '20', dorName: 'Clay', fips: '12019' },
  { dorCode: '21', dorName: 'Collier', fips: '12021' },
  { dorCode: '22', dorName: 'Columbia', fips: '12023' },
  // Numbered as "Dade" before 1997; FIPS 12086 since.
  { dorCode: '23', dorName: 'Miami-Dade', fips: '12086' },
  { dorCode: '24', dorName: 'DeSoto', fips: '12027' },
  { dorCode: '25', dorName: 'Dixie', fips: '12029' },
  { dorCode: '26', dorName: 'Duval', fips: '12031' },
  { dorCode: '27', dorName: 'Escambia', fips: '12033' },
  { dorCode: '28', dorName: 'Flagler', fips: '12035' },
  { dorCode: '29', dorName: 'Franklin', fips: '12037' },
  { dorCode: '30', dorName: 'Gadsden', fips: '12039' },
  { dorCode: '31', dorName: 'Gilchrist', fips: '12041' },
  { dorCode: '32', dorName: 'Glades', fips: '12043' },
  { dorCode: '33', dorName: 'Gulf', fips: '12045' },
  { dorCode: '34', dorName: 'Hamilton', fips: '12047' },
  { dorCode: '35', dorName: 'Hardee', fips: '12049' },
  { dorCode: '36', dorName: 'Hendry', fips: '12051' },
  { dorCode: '37', dorName: 'Hernando', fips: '12053' },
  { dorCode: '38', dorName: 'Highlands', fips: '12055' },
  { dorCode: '39', dorName: 'Hillsborough', fips: '12057' },
  { dorCode: '40', dorName: 'Holmes', fips: '12059' },
  { dorCode: '41', dorName: 'Indian River', fips: '12061' },
  { dorCode: '42', dorName: 'Jackson', fips: '12063' },
  { dorCode: '43', dorName: 'Jefferson', fips: '12065' },
  { dorCode: '44', dorName: 'Lafayette', fips: '12067' },
  { dorCode: '45', dorName: 'Lake', fips: '12069' },
  { dorCode: '46', dorName: 'Lee', fips: '12071' },
  { dorCode: '47', dorName: 'Leon', fips: '12073' },
  { dorCode: '48', dorName: 'Levy', fips: '12075' },
  { dorCode: '49', dorName: 'Liberty', fips: '12077' },
  { dorCode: '50', dorName: 'Madison', fips: '12079' },
  { dorCode: '51', dorName: 'Manatee', fips: '12081' },
  { dorCode: '52', dorName: 'Marion', fips: '12083' },
  { dorCode: '53', dorName: 'Martin', fips: '12085' },
  { dorCode: '54', dorName: 'Monroe', fips: '12087' },
  { dorCode: '55', dorName: 'Nassau', fips: '12089' },
  { dorCode: '56', dorName: 'Okaloosa', fips: '12091' },
  { dorCode: '57', dorName: 'Okeechobee', fips: '12093' },
  { dorCode: '58', dorName: 'Orange', fips: '12095' },
  { dorCode: '59', dorName: 'Osceola', fips: '12097' },
  { dorCode: '60', dorName: 'Palm Beach', fips: '12099' },
  { dorCode: '61', dorName: 'Pasco', fips: '12101' },
  { dorCode: '62', dorName: 'Pinellas', fips: '12103' },
  { dorCode: '63', dorName: 'Polk', fips: '12105' },
  { dorCode: '64', dorName: 'Putnam', fips: '12107' },
  { dorCode: '65', dorName: 'Saint Johns', fips: '12109' },
  { dorCode: '66', dorName: 'Saint Lucie', fips: '12111' },
  { dorCode: '67', dorName: 'Santa Rosa', fips: '12113' },
  { dorCode: '68', dorName: 'Sarasota', fips: '12115' },
  { dorCode: '69', dorName: 'Seminole', fips: '12117' },
  { dorCode: '70', dorName: 'Sumter', fips: '12119' },
  { dorCode: '71', dorName: 'Suwannee', fips: '12121' },
  { dorCode: '72', dorName: 'Taylor', fips: '12123' },
  { dorCode: '73', dorName: 'Union', fips: '12125' },
  { dorCode: '74', dorName: 'Volusia', fips: '12127' },
  { dorCode: '75', dorName: 'Wakulla', fips: '12129' },
  { dorCode: '76', dorName: 'Walton', fips: '12131' },
  { dorCode: '77', dorName: 'Washington', fips: '12133' },
];

const BY_CODE: ReadonlyMap<string, FlDorCounty> = new Map(FL_DOR_COUNTIES.map((c) => [c.dorCode, c]));
const BY_FIPS: ReadonlyMap<string, FlDorCounty> = new Map(FL_DOR_COUNTIES.map((c) => [c.fips, c]));

/** Every Florida county FIPS the DOR table names, sorted. The "67" in every report is this length. */
export function flExpectedCountyFips(): readonly string[] {
  return [...BY_FIPS.keys()].sort();
}

export function flCountyByFips(fips: string): FlDorCounty | null {
  return BY_FIPS.get(fips) ?? null;
}

/**
 * A raw `CO_NO` as the files carry it — `"44"` in CSV, `"44.00000"` in the
 * shapefile DBF — to the DOR county, or null when it is not one of the 67.
 *
 * Only an integral value in 11..77 that the table lists is accepted. `0`, which
 * the joined parcel shapefiles use for polygons that matched no roll record, is
 * not a county.
 */
export function flCountyByDorCode(raw: string | number | null | undefined): FlDorCounty | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'number' ? String(raw) : raw.trim();
  const match = /^(\d{1,2})(?:\.0+)?$/.exec(text);
  if (match === null) return null;
  return BY_CODE.get((match[1] as string).padStart(2, '0')) ?? null;
}

/** `CO_NO` → county FIPS, or a refusal naming what was wrong. Never inferred from an address or a filename. */
export function routeFlCounty(raw: string | number | null | undefined, origin: string): string {
  const county = flCountyByDorCode(raw);
  if (county === null) {
    fail('PARSE', `${origin}: CO_NO ${JSON.stringify(raw ?? null)} is not a Florida DOR county number`, {
      remedy: 'rows route by the county number the Department assigned; one it did not assign is quarantined',
    });
  }
  return county.fips;
}

/**
 * The county a publisher FILENAME names, by name only.
 *
 * Used solely to cross-check a file against the county its rows route to. The
 * number in a filename is never read: the 2026 folder proves it can be wrong.
 */
export function flCountyByFileName(fileName: string): FlDorCounty | null {
  const folded = foldName(fileName.replace(/\.[^.]+$/, ''));
  let best: { county: FlDorCounty; length: number } | null = null;
  for (const county of FL_DOR_COUNTIES) {
    for (const alias of aliasesOf(county)) {
      // The longest matching name wins, so a name is never read as a shorter one it begins with.
      if (folded.startsWith(alias) && (best === null || alias.length > best.length)) best = { county, length: alias.length };
    }
  }
  return best?.county ?? null;
}

/** Name forms a DOR file may use for a county: "Saint Johns", "stjohns", "Dade", "miamidade". */
function aliasesOf(county: FlDorCounty): readonly string[] {
  const base = foldName(county.dorName);
  const out = new Set<string>([base]);
  if (base.startsWith('saint')) out.add(`st${base.slice('saint'.length)}`);
  if (county.dorCode === '23') { out.add('dade'); out.add('miamidade'); }
  return [...out];
}

function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}
