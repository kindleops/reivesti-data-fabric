/**
 * United States county and county-equivalent geography.
 *
 * Built from pinned federal reference files rather than from a remembered county
 * count, because "how many counties are there" has no stable answer: Connecticut
 * replaced its eight counties with nine planning regions, Alaska keeps
 * reorganising boroughs and census areas, and independent cities appear and
 * consolidate. A hard-coded number is a bug waiting for a news cycle.
 *
 * Two files, and the pairing is deliberate:
 *
 *   2025_Gaz_counties_national.txt   the CURRENT geography. Everything in it is
 *                                    active. 50 states, DC and Puerto Rico.
 *   national_county2020.txt          the 2020 vintage, which additionally carries
 *                                    the legal CLASS code and the island areas.
 *                                    Used for typing, and to see what CHANGED.
 *
 * Both are retained in `reference/geography/` and verified by digest at load, so
 * the registry cannot silently drift from the evidence it claims to be built on.
 *
 * ## What is NOT done here
 *
 * The eight retired Connecticut counties are marked `replaced` and are **not**
 * mapped onto planning regions. The boundaries do not correspond one-to-one, no
 * federal crosswalk asserts such a mapping, and inventing one would put a false
 * geography into every downstream property id. A record filed in "New Haven
 * County" in 2019 stays in New Haven County.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../core/hash.ts';
import { fail } from '../core/errors.ts';

const REFERENCE_DIR = join(import.meta.dirname, '..', '..', 'reference', 'geography');

/**
 * Provenance of the geography, recorded next to the data it produced.
 *
 * A registry built from an unpinned download is a registry nobody can reproduce.
 */
export const GEOGRAPHY_PROVENANCE = {
  current: {
    file: '2025_Gaz_counties_national.txt',
    authority: 'U.S. Census Bureau',
    product: '2025 Gazetteer Files — Counties (national)',
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip',
    sha256: '1914f0d83243362de83b8ddd298c213b1768d63d62d19464743289abd8bb35b1',
    retrievedAt: '2026-08-31',
  },
  legacy: {
    file: 'national_county2020.txt',
    authority: 'U.S. Census Bureau',
    product: '2020 national county and county-equivalent codes',
    url: 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt',
    sha256: '9f6e5f6eb6ac2f5e9a36d5fd01dec77991bddc75118f748a069441a4782970d6',
    retrievedAt: '2026-08-31',
  },
} as const;

/**
 * Legal form of a county-equivalent, kept distinct rather than flattened.
 *
 * A Louisiana parish, an Alaska census area and a Virginia independent city are
 * not counties, and the offices that hold their records differ accordingly —
 * which matters directly to a source registry: an Alaska census area has no
 * county government and therefore no county recorder.
 */
export type CountyEquivalentType =
  | 'county'
  | 'parish'
  | 'borough'
  | 'census_area'
  | 'municipality'
  | 'municipio'
  | 'planning_region'
  | 'independent_city'
  | 'federal_district'
  // Island-area forms. These appear only in the 2020 vintage, which is why they
  // are named here rather than guessed: American Samoa is organised into
  // districts and islands, the Northern Marianas into municipalities, and Guam
  // is a single territory-wide county equivalent.
  | 'district'
  | 'island'
  | 'territory';

/**
 * Whether a geography is current.
 *
 * `source_legacy` is the honest answer for the island areas: they appear in the
 * 2020 codes file and not in the 2025 counties Gazetteer, which is a difference
 * in that product's SCOPE, not evidence that they ceased to exist. Calling them
 * retired would be a claim the sources do not support.
 */
export type GeographyStatus = 'active' | 'replaced' | 'retired' | 'source_legacy';

export type CountyEquivalent = {
  /** 5-digit combined state+county FIPS. Unique across the whole set. */
  readonly fips: string;
  readonly stateCode: string;
  readonly stateFips: string;
  /** Verbatim federal name, including its legal suffix. */
  readonly name: string;
  readonly type: CountyEquivalentType;
  readonly status: GeographyStatus;
  /** Census ANSI (GNIS) code, where the source supplies one. */
  readonly ansiCode: string | null;
  /** 2020 CLASSFP, where the row exists in that vintage. */
  readonly classFp: string | null;
  /**
   * Successor geographies, ONLY where a federal crosswalk states them. Empty for
   * the retired Connecticut counties: no such crosswalk exists, and guessing one
   * would relocate historical records.
   */
  readonly replacedBy: readonly string[];
  readonly note: string | null;
};

// ---------------------------------------------------------------------------

function read(file: string, expected: string): string {
  const path = join(REFERENCE_DIR, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return fail('CONFIG', `geography reference "${file}" is missing`, { path, cause: (e as Error).message });
  }
  const actual = sha256(text);
  if (actual !== expected) {
    fail('CONFIG', `geography reference "${file}" does not match its pinned digest`, {
      path, expected, actual,
      remedy: 'the registry is built from this file; re-pin GEOGRAPHY_PROVENANCE deliberately, never silently',
    });
  }
  return text;
}

/** The legal form is carried in the federal name's suffix. */
function typeOf(name: string): CountyEquivalentType {
  if (name === 'District of Columbia') return 'federal_district';
  if (name.endsWith(' County')) return 'county';
  if (name.endsWith(' Parish')) return 'parish';
  if (name.endsWith(' Borough')) return 'borough';
  if (name.endsWith(' Census Area')) return 'census_area';
  if (name.endsWith(' Municipality')) return 'municipality';
  if (name.endsWith(' Municipio')) return 'municipio';
  if (name.endsWith(' Planning Region')) return 'planning_region';
  // Virginia, Maryland and Missouri write independent cities in lower case;
  // Carson City is a consolidated municipality that is its own county equivalent.
  if (name.endsWith(' city') || name === 'Carson City') return 'independent_city';
  if (name.endsWith(' District')) return 'district';
  if (name.endsWith(' Island') || name.endsWith(' Islands')) return 'island';
  if (name === 'Guam') return 'territory';
  return fail('CONFIG', `cannot determine the county-equivalent type of "${name}"`, {
    remedy: 'a new legal form appeared in the federal file; classify it explicitly rather than defaulting to county',
  });
}

type LegacyRow = { stateCode: string; name: string; classFp: string; ansiCode: string };

function parseLegacy(text: string): Map<string, LegacyRow> {
  const out = new Map<string, LegacyRow>();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const f = line.split('|');
    if (f.length < 7) continue;
    out.set(`${f[1]}${f[2]}`, {
      stateCode: f[0] as string,
      name: f[4] as string,
      classFp: f[5] as string,
      ansiCode: f[3] as string,
    });
  }
  return out;
}

function build(): readonly CountyEquivalent[] {
  const legacy = parseLegacy(read(GEOGRAPHY_PROVENANCE.legacy.file, GEOGRAPHY_PROVENANCE.legacy.sha256));
  const current = read(GEOGRAPHY_PROVENANCE.current.file, GEOGRAPHY_PROVENANCE.current.sha256);

  const out: CountyEquivalent[] = [];
  const seen = new Set<string>();

  const lines = current.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const f = line.split('|');
    if (f.length < 5) continue;
    const fips = (f[1] as string).trim();
    const name = (f[4] as string).trim();
    if (seen.has(fips)) fail('CONFIG', `duplicate county FIPS "${fips}" in the current geography file`);
    seen.add(fips);
    const prior = legacy.get(fips);
    out.push({
      fips,
      stateCode: (f[0] as string).trim(),
      stateFips: fips.slice(0, 2),
      name,
      type: typeOf(name),
      status: 'active',
      ansiCode: (f[3] as string).trim() || null,
      classFp: prior?.classFp ?? null,
      replacedBy: [],
      note: null,
    });
  }

  // Anything the 2020 file knew that the current file does not. Two different
  // situations, and conflating them would be a false claim either way.
  for (const [fips, row] of legacy) {
    if (seen.has(fips)) continue;
    const isConnecticutCounty = fips.startsWith('09');
    out.push({
      fips,
      stateCode: row.stateCode,
      stateFips: fips.slice(0, 2),
      name: row.name,
      type: typeOf(row.name),
      status: isConnecticutCounty ? 'replaced' : 'source_legacy',
      ansiCode: row.ansiCode || null,
      classFp: row.classFp,
      // Deliberately empty. Connecticut's planning regions do not correspond
      // one-to-one with the counties they replaced, and no federal crosswalk
      // asserts a mapping. Records filed under this county stay under it.
      replacedBy: [],
      note: isConnecticutCounty
        ? 'Retired: Connecticut replaced county geography with nine planning regions. '
          + 'No one-to-one crosswalk exists, so no successor is asserted.'
        : 'Present in the 2020 national county codes file and outside the scope of the '
          + '2025 counties Gazetteer. Not evidence that the geography ceased to exist.',
    });
  }

  out.sort((a, b) => (a.fips < b.fips ? -1 : a.fips > b.fips ? 1 : 0));
  return Object.freeze(out);
}

export const US_COUNTY_EQUIVALENTS: readonly CountyEquivalent[] = build();

export const ACTIVE_COUNTY_EQUIVALENTS: readonly CountyEquivalent[] =
  US_COUNTY_EQUIVALENTS.filter((c) => c.status === 'active');

const BY_FIPS = new Map(US_COUNTY_EQUIVALENTS.map((c) => [c.fips, c] as const));

export function countyEquivalent(fips: string): CountyEquivalent | undefined {
  return BY_FIPS.get(fips);
}

/** State-level entities the current geography file actually covers. */
export function coveredStateFips(): readonly string[] {
  return [...new Set(ACTIVE_COUNTY_EQUIVALENTS.map((c) => c.stateFips))].sort();
}
