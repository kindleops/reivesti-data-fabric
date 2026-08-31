// Jurisdiction catalogue. Nation and states are enumerated for the whole US so
// that a source in any state can be registered before its adapter exists.
// County detail is added state by state as connectors reach that state; only
// Minnesota is enumerated in DF-0B.
import { MN_COUNTIES, MN_STATE_CODE, MN_STATE_FIPS } from './mn-counties.ts';
import type { Jurisdiction } from './types.ts';

/** [stateCode, stateFips, name] for the 50 states plus DC. */
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

function buildCatalogue(): readonly Jurisdiction[] {
  const out: Jurisdiction[] = [
    { jurisdictionId: NATION_ID, jurisdictionType: 'nation', country: 'US', name: 'United States' },
  ];

  for (const [stateCode, stateFips, name] of US_STATES) {
    out.push({
      jurisdictionId: stateJurisdictionId(stateCode),
      jurisdictionType: 'state',
      country: 'US',
      stateCode,
      stateFips,
      name,
      parentId: NATION_ID,
    });
  }

  for (const [, countyFips3, countyName] of MN_COUNTIES) {
    const countyFips = `${MN_STATE_FIPS}${countyFips3}`;
    out.push({
      jurisdictionId: countyJurisdictionId(countyFips),
      jurisdictionType: 'county',
      country: 'US',
      stateCode: MN_STATE_CODE,
      stateFips: MN_STATE_FIPS,
      countyFips,
      countyName,
      name: `${countyName} County, Minnesota`,
      parentId: stateJurisdictionId(MN_STATE_CODE),
    });
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
