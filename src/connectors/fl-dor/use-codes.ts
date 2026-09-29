/**
 * Florida DOR land use codes 000–099, from the 2026 User's Guide (NAL field 8,
 * pages 5–7). The appraiser assigns the code by the parcel's PREDOMINANT use;
 * the Department groups the codes into the categories kept here.
 *
 * A code outside the table is retained verbatim and flagged unknown — never
 * mapped to the nearest known one.
 */
export type FlUseCategory =
  | 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL' | 'AGRICULTURAL' | 'INSTITUTIONAL'
  | 'GOVERNMENTAL' | 'MISCELLANEOUS' | 'CENTRALLY_ASSESSED' | 'NON_AGRICULTURAL_ACREAGE';

export const FL_DOR_USE_CODE_LIST_VERSION = 'fl_dor_land_use_codes_2026';

const RAW: readonly [string, FlUseCategory, string][] = [
  ['000', 'RESIDENTIAL', 'Vacant Residential – with/without extra features'],
  ['001', 'RESIDENTIAL', 'Single Family'],
  ['002', 'RESIDENTIAL', 'Mobile Homes'],
  ['003', 'COMMERCIAL', 'Multi-family - 10 units or more'],
  ['004', 'RESIDENTIAL', 'Condominiums'],
  ['005', 'RESIDENTIAL', 'Cooperatives'],
  ['006', 'RESIDENTIAL', 'Retirement Homes not eligible for exemption'],
  ['007', 'RESIDENTIAL', 'Miscellaneous Residential (migrant camps, boarding homes, etc.)'],
  ['008', 'RESIDENTIAL', 'Multi-family - fewer than 10 units'],
  ['009', 'RESIDENTIAL', 'Residential Common Elements/Areas'],
  ['010', 'COMMERCIAL', 'Vacant Commercial - with/without extra features'],
  ['011', 'COMMERCIAL', 'Stores, one story'],
  ['012', 'COMMERCIAL', 'Mixed use - store and office or store and residential combination'],
  ['013', 'COMMERCIAL', 'Department Stores'],
  ['014', 'COMMERCIAL', 'Supermarkets'],
  ['015', 'COMMERCIAL', 'Regional Shopping Centers'],
  ['016', 'COMMERCIAL', 'Community Shopping Centers'],
  ['017', 'COMMERCIAL', 'Office buildings, non-professional service buildings, one story'],
  ['018', 'COMMERCIAL', 'Office buildings, non-professional service buildings, multi-story'],
  ['019', 'COMMERCIAL', 'Professional service buildings'],
  ['020', 'COMMERCIAL', 'Airports (private or commercial), bus terminals, marine terminals, piers, marinas'],
  ['021', 'COMMERCIAL', 'Restaurants, cafeterias'],
  ['022', 'COMMERCIAL', 'Drive-in Restaurants'],
  ['023', 'COMMERCIAL', 'Financial institutions (banks, saving and loan companies, mortgage companies, credit services)'],
  ['024', 'COMMERCIAL', 'Insurance company offices'],
  ['025', 'COMMERCIAL', 'Repair service shops (excluding automotive), radio and T.V. repair, refrigeration service, electric repair, laundries, Laundromats'],
  ['026', 'COMMERCIAL', 'Service stations'],
  ['027', 'COMMERCIAL', 'Auto sales, auto repair and storage, auto service shops, body and fender shops, commercial garages, farm and machinery sales and services, auto rental, marine equipment, trailers and related equipment, mobile home sales, motorcycles, construction vehicle sales'],
  ['028', 'COMMERCIAL', 'Parking lots (commercial or patron), mobile home parks'],
  ['029', 'COMMERCIAL', 'Wholesale outlets, produce houses, manufacturing outlets'],
  ['030', 'COMMERCIAL', 'Florists, greenhouses'],
  ['031', 'COMMERCIAL', 'Drive-in theaters, open stadiums'],
  ['032', 'COMMERCIAL', 'Enclosed theaters, enclosed auditoriums'],
  ['033', 'COMMERCIAL', 'Nightclubs, cocktail lounges, bars'],
  ['034', 'COMMERCIAL', 'Bowling alleys, skating rinks, pool halls, enclosed arenas'],
  ['035', 'COMMERCIAL', 'Tourist attractions, permanent exhibits, other entertainment facilities, fairgrounds (privately owned)'],
  ['036', 'COMMERCIAL', 'Camps'],
  ['037', 'COMMERCIAL', 'Race tracks (horse, auto, or dog)'],
  ['038', 'COMMERCIAL', 'Golf courses, driving ranges'],
  ['039', 'COMMERCIAL', 'Hotels, motels'],
  ['040', 'INDUSTRIAL', 'Vacant Industrial - with/without extra features'],
  ['041', 'INDUSTRIAL', 'Light manufacturing, small equipment manufacturing plants, small machine shops, instrument manufacturing, printing plants'],
  ['042', 'INDUSTRIAL', 'Heavy industrial, heavy equipment manufacturing, large machine shops, foundries, steel fabricating plants, auto or aircraft plants'],
  ['043', 'INDUSTRIAL', 'Lumber yards, sawmills, planing mills'],
  ['044', 'INDUSTRIAL', 'Packing plants, fruit and vegetable packing plants, meat packing plants'],
  ['045', 'INDUSTRIAL', 'Canneries, fruit and vegetable, bottlers and brewers, distilleries, wineries'],
  ['046', 'INDUSTRIAL', 'Other food processing, candy factories, bakeries, potato chip factories'],
  ['047', 'INDUSTRIAL', 'Mineral processing, phosphate processing, cement plants, refineries, clay plants, rock and gravel plants'],
  ['048', 'INDUSTRIAL', 'Warehousing, distribution terminals, trucking terminals, van and storage warehousing'],
  ['049', 'INDUSTRIAL', 'Open storage, new and used building supplies, junk yards, auto wrecking, fuel storage, equipment and material storage'],
  ['050', 'AGRICULTURAL', 'Improved agricultural'],
  ['051', 'AGRICULTURAL', 'Cropland soil capability Class I'],
  ['052', 'AGRICULTURAL', 'Cropland soil capability Class II'],
  ['053', 'AGRICULTURAL', 'Cropland soil capability Class III'],
  ['054', 'AGRICULTURAL', 'Timberland - site index 90 and above'],
  ['055', 'AGRICULTURAL', 'Timberland - site index 80 to 89'],
  ['056', 'AGRICULTURAL', 'Timberland - site index 70 to 79'],
  ['057', 'AGRICULTURAL', 'Timberland - site index 60 to 69'],
  ['058', 'AGRICULTURAL', 'Timberland - site index 50 to 59'],
  ['059', 'AGRICULTURAL', 'Timberland not classified by site index to Pines'],
  ['060', 'AGRICULTURAL', 'Grazing land soil capability Class I'],
  ['061', 'AGRICULTURAL', 'Grazing land soil capability Class II'],
  ['062', 'AGRICULTURAL', 'Grazing land soil capability Class III'],
  ['063', 'AGRICULTURAL', 'Grazing land soil capability Class IV'],
  ['064', 'AGRICULTURAL', 'Grazing land soil capability Class V'],
  ['065', 'AGRICULTURAL', 'Grazing land soil capability Class VI'],
  ['066', 'AGRICULTURAL', 'Orchard Groves, citrus, etc.'],
  ['067', 'AGRICULTURAL', 'Poultry, bees, tropical fish, rabbits, etc.'],
  ['068', 'AGRICULTURAL', 'Dairies, feed lots'],
  ['069', 'AGRICULTURAL', 'Ornamentals, miscellaneous agricultural'],
  ['070', 'INSTITUTIONAL', 'Vacant Institutional, with or without extra features'],
  ['071', 'INSTITUTIONAL', 'Churches'],
  ['072', 'INSTITUTIONAL', 'Private schools and colleges'],
  ['073', 'INSTITUTIONAL', 'Privately owned hospitals'],
  ['074', 'INSTITUTIONAL', 'Homes for the aged'],
  ['075', 'INSTITUTIONAL', 'Orphanages, other non-profit or charitable services'],
  ['076', 'INSTITUTIONAL', 'Mortuaries, cemeteries, crematoriums'],
  ['077', 'INSTITUTIONAL', 'Clubs, lodges, union halls'],
  ['078', 'INSTITUTIONAL', 'Sanitariums, convalescent and rest homes'],
  ['079', 'INSTITUTIONAL', 'Cultural organizations, facilities'],
  ['080', 'GOVERNMENTAL', 'Vacant Governmental - with/without extra features for municipal, counties, state, federal properties and water management district (including DOT/State of Florida retention and/or detention areas)'],
  ['081', 'GOVERNMENTAL', 'Military'],
  ['082', 'GOVERNMENTAL', 'Forest, parks, recreational areas'],
  ['083', 'GOVERNMENTAL', 'Public county schools - including all property of Board of Public Instruction'],
  ['084', 'GOVERNMENTAL', 'Colleges (non-private)'],
  ['085', 'GOVERNMENTAL', 'Hospitals (non-private)'],
  ['086', 'GOVERNMENTAL', 'Counties (other than public schools, colleges, hospitals) including non-municipal government'],
  ['087', 'GOVERNMENTAL', 'State, other than military, forests, parks, recreational areas, colleges, hospitals'],
  ['088', 'GOVERNMENTAL', 'Federal, other than military, forests, parks, recreational areas, hospitals, colleges'],
  ['089', 'GOVERNMENTAL', 'Municipal, other than parks, recreational areas, colleges, hospitals'],
  ['090', 'MISCELLANEOUS', 'Leasehold interests (government-owned property leased by a non-governmental lessee)'],
  ['091', 'MISCELLANEOUS', 'Utility, gas and electricity, telephone and telegraph, locally assessed railroads, water and sewer service, pipelines, canals, radio/television communication'],
  ['092', 'MISCELLANEOUS', 'Mining lands, petroleum lands, or gas lands'],
  ['093', 'MISCELLANEOUS', 'Subsurface rights'],
  ['094', 'MISCELLANEOUS', 'Right-of-way, streets, roads, irrigation channel, ditch, etc.'],
  ['095', 'MISCELLANEOUS', 'Rivers and lakes, submerged lands'],
  ['096', 'MISCELLANEOUS', 'Sewage disposal, solid waste, borrow pits, drainage reservoirs, waste land, marsh, sand dunes, swamps'],
  ['097', 'MISCELLANEOUS', 'Outdoor recreational or parkland, or high-water recharge subject to classified use assessment'],
  ['098', 'CENTRALLY_ASSESSED', 'Centrally assessed'],
  ['099', 'NON_AGRICULTURAL_ACREAGE', 'Acreage not zoned agricultural - with/without extra features'],
];

export type FlUseCode = { readonly code: string; readonly category: FlUseCategory; readonly name: string };

const BY_CODE: ReadonlyMap<string, FlUseCode> = new Map(RAW.map(([code, category, name]) => [code, { code, category, name }]));

export const FL_DOR_USE_CODES: readonly FlUseCode[] = [...BY_CODE.values()];

/**
 * The published code, read against the table.
 *
 * The files write the code as three digits ("001"). A shorter numeral is read
 * as the same code only because the guide defines the field as a three-digit
 * number 000–099 — "1" and "001" are the same number there — and the result
 * records that it was padded.
 */
export function readFlUseCode(raw: string | null | undefined): { readonly code: string | null; readonly known: FlUseCode | null; readonly padded: boolean } {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text === '') return { code: null, known: null, padded: false };
  const padded = /^\d{1,2}$/.test(text);
  const code = padded ? text.padStart(3, '0') : text;
  return { code, known: BY_CODE.get(code) ?? null, padded };
}
