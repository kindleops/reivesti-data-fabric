/**
 * Jurisdiction catalogue: the whole United States, county-equivalent by
 * county-equivalent.
 *
 * DF-0B enumerated the nation, the states and Minnesota's 87 counties, on the
 * reasoning that county detail could be added state by state as connectors
 * arrived. DF-0G replaces that with the complete federal geography, because the
 * coverage matrix has to be able to say "no source" for a place — and a place
 * that is not in the catalogue cannot be reported as uncovered, only as absent,
 * which is a different and much less useful answer.
 *
 * The geography is built from pinned Census files (see `us-geography.ts`), not
 * from a remembered county count. Retired identities stay in the catalogue.
 */
import { MN_COUNTIES, MN_STATE_CODE, MN_STATE_FIPS } from './mn-counties.ts';
import { US_COUNTY_EQUIVALENTS, type CountyEquivalent } from './us-geography.ts';
import type { Jurisdiction } from './types.ts';

/**
 * [stateCode, stateFips, name] for the 50 states plus DC.
 *
 * Enumerated rather than derived: the Gazetteer carries the postal code but not
 * the state's own name, and a state list that changes is a much bigger event
 * than a county list that changes.
 */
const US_STATES: readonly (readonly [string, string, string])[] = [
  ['AL', '01', 'Alabama'], ['AK', '02', 'Alaska'], ['AZ', '04', 'Arizona'], ['AR', '05', 'Arkansas'],
  ['CA', '06', 'California'], ['CO', '08', 'Colorado'], ['CT', '09', 'Connecticut'], ['DE', '10', 'Delaware'],
  ['DC', '11', 'District of Columbia'], ['FL', '12', 'Florida'], ['GA', '13', 'Georgia'], ['HI', '15', 'Hawaii'],
  ['ID', '16', 'Idaho'], ['IL', '17', 'Illinois'], ['IN', '18', 'Indiana'], ['IA', '19', 'Iowa'],
  ['KS', '20', 'Kansas'], ['KY', '21', 'Kentucky'], ['LA', '22', 'Louisiana'], ['ME', '23', 'Maine'],
  ['MD', '24', 'Maryland'], ['MA', '25', 'Massachusetts'], ['MI', '26', 'Michigan'], ['MN', '27', 'Minnesota'],
  ['MS', '28', 'Mississippi'], ['MO', '29', 'Missouri'], ['MT', '30', 'Montana'], ['NE', '31', 'Nebraska'],
  ['NV', '32', 'Nevada'], ['NH', '33', 'New Hampshire'], ['NJ', '34', 'New Jersey'], ['NM', '35', 'New Mexico'],
  ['NY', '36', 'New York'], ['NC', '37', 'North Carolina'], ['ND', '38', 'North Dakota'], ['OH', '39', 'Ohio'],
  ['OK', '40', 'Oklahoma'], ['OR', '41', 'Oregon'], ['PA', '42', 'Pennsylvania'], ['RI', '44', 'Rhode Island'],
  ['SC', '45', 'South Carolina'], ['SD', '46', 'South Dakota'], ['TN', '47', 'Tennessee'], ['TX', '48', 'Texas'],
  ['UT', '49', 'Utah'], ['VT', '50', 'Vermont'], ['VA', '51', 'Virginia'], ['WA', '53', 'Washington'],
  ['WV', '54', 'West Virginia'], ['WI', '55', 'Wisconsin'], ['WY', '56', 'Wyoming'],
];

export const NATION_ID = 'us';

export function stateJurisdictionId(stateCode: string): string {
  return `us-${stateCode.toLowerCase()}`;
}

export function countyJurisdictionId(countyFips: string): string {
  return `us-county-${countyFips}`;
}

/**
 * State-level entities that appear in the county geography but not in the
 * 50-states-plus-DC list: Puerto Rico, and the island areas the 2020 vintage
 * carried. Named here so their counties have a real parent rather than dangling.
 */
const TERRITORIES: readonly (readonly [string, string, string])[] = [
  ['PR', '72', 'Puerto Rico'], ['AS', '60', 'American Samoa'], ['GU', '66', 'Guam'],
  ['MP', '69', 'Northern Mariana Islands'], ['VI', '78', 'U.S. Virgin Islands'],
  ['UM', '74', 'U.S. Minor Outlying Islands'],
];

function jurisdictionOf(county: CountyEquivalent, stateName: string): Jurisdiction {
  return {
    jurisdictionId: countyJurisdictionId(county.fips),
    jurisdictionType: 'county',
    country: 'US',
    stateCode: county.stateCode,
    stateFips: county.stateFips,
    countyFips: county.fips,
    // The bare name without its legal suffix, for display and for matching a
    // source that says "Hennepin". The full federal name is `name`.
    countyName: county.name
      .replace(/ (County|Parish|Borough|Census Area|Municipality|Municipio|Planning Region|District|Islands?)$/, '')
      .replace(/ city$/, ''),
    name: `${county.name}, ${stateName}`,
    parentId: stateJurisdictionId(county.stateCode),
    countyEquivalentType: county.type,
    status: county.status,
    replacedBy: county.replacedBy,
    ...(county.note !== null ? { note: county.note } : {}),
  };
}

function buildCatalogue(): readonly Jurisdiction[] {
  const out: Jurisdiction[] = [
    { jurisdictionId: NATION_ID, jurisdictionType: 'nation', country: 'US', name: 'United States', status: 'active' },
  ];

  const stateNames = new Map<string, string>();
  for (const [stateCode, stateFips, name] of [...US_STATES, ...TERRITORIES]) {
    stateNames.set(stateCode, name);
    out.push({
      jurisdictionId: stateJurisdictionId(stateCode),
      jurisdictionType: 'state',
      country: 'US',
      stateCode,
      stateFips,
      name,
      parentId: NATION_ID,
      status: 'active',
    });
  }

  for (const county of US_COUNTY_EQUIVALENTS) {
    const stateName = stateNames.get(county.stateCode);
    if (stateName === undefined) {
      throw new Error(`county ${county.fips} names state "${county.stateCode}", which is not catalogued`);
    }
    out.push(jurisdictionOf(county, stateName));
  }

  return Object.freeze(out);
}

export const JURISDICTIONS: readonly Jurisdiction[] = buildCatalogue();

const BY_ID = new Map(JURISDICTIONS.map((j) => [j.jurisdictionId, j] as const));

export function getJurisdiction(jurisdictionId: string): Jurisdiction | undefined {
  return BY_ID.get(jurisdictionId);
}

// --- Minnesota county-code lookups (eCRV <countyCde>) ------------------------

const MN_BY_CODE = new Map(MN_COUNTIES.map(([code, fips3, name]) => [code, { code, countyFips: `${MN_STATE_FIPS}${fips3}`, countyName: name }] as const));

export type MnCounty = { readonly code: string; readonly countyFips: string; readonly countyName: string };

/** Resolves an eCRV county code ("01".."87", or "1".."87") to county identity. */
export function mnCountyByCode(code: string): MnCounty | undefined {
  const normalized = code.trim().padStart(2, '0');
  return MN_BY_CODE.get(normalized);
}

export function mnCounties(): readonly MnCounty[] {
  return [...MN_BY_CODE.values()];
}
