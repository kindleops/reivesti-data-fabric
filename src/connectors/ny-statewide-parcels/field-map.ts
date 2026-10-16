/**
 * NYS Tax Parcel Centroid Points (2025 roll, May 2026 build) — field inventory
 * and disposition.
 *
 * Every attribute column of `NYS_Tax_Parcels_Centroid_Points`, as the
 * publisher's own File Geodatabase declares it, classified one by one. The
 * geodatabase and the GeoHub FeatureServer declare the same 73 attributes
 * (order differs; the digest is order-free), so one inventory serves the
 * artifact and the witness.
 *
 * Fill rates were measured over all 5,510,061 rows on 2026-09-29 and are quoted
 * where they matter. The schema is shared by 62 counties with two lineages:
 *
 *   57 counties   county GIS polygons + ORPTS 2025 assessment-roll attributes
 *   5 boroughs    New York City, from NYC MapPLUTO — a different system. There,
 *                 PROP_CLASS is a PLUTO land-use code, BLDG_STYLE a DOF building
 *                 class, the assessed values are DOF's, and PRINT_KEY,
 *                 FULL_MARKET_VAL, ROLL_SECTION, ACRES, MUNI_PARCEL_ID and the
 *                 owner mailing fields are empty.
 *
 * ## What this schema does NOT carry
 *
 * No tax amount of any kind — no levy, no bill, no net or gross tax — so the
 * connector claims no `tax` capability. No sale date and no sale price. BOOK and
 * PAGE are the roll's reference to the last recorded deed (populated "only for
 * parcels which have sold in the last 10-12 years"); they carry no date, no
 * consideration and no parties, and they are never read as a transfer.
 * No latitude/longitude attribute: the centroid is the point geometry itself,
 * retained in the publisher archive and not decoded (see the connector docs).
 */
import type { Disposition, FieldGroup, FieldSpec } from '../mn-statewide-parcels/field-map.ts';

export type { Disposition, FieldGroup, FieldSpec };

const s = (field: string, maxLength: number, group: FieldGroup, disposition: Disposition, note: string): FieldSpec =>
  ({ field, sourceType: 'String', maxLength, group, disposition, note });
const n = (field: string, sourceType: 'Double' | 'Integer' | 'SmallInteger', group: FieldGroup, disposition: Disposition, note: string): FieldSpec =>
  ({ field, sourceType, group, disposition, note });

export const NY_STATEWIDE_FIELD_MAP: readonly FieldSpec[] = [
  // -- row identity ------------------------------------------------------------
  { field: 'OBJECTID', sourceType: 'OID', group: 'provenance', disposition: 'KEEP_RAW',
    note: 'The geodatabase row id. Retained, never Reivesti identity, and excluded from change detection: it is a row position reassigned by every build.' },

  // -- routing and identity ------------------------------------------------------
  s('COUNTY_NAME', 50, 'geography', 'CANONICALIZE',
    'The county the parcel lies in (100%). Routing key, resolved through the federal catalogue after folding to letters only — the layer writes "NewYork" and "StLawrence" — and required to agree with the SWIS county code.'),
  s('MUNI_NAME', 50, 'geography', 'NORMALIZE',
    'The assessing municipality: city, town, village, or NYC borough name (100%).'),
  s('SWIS', 10, 'identity', 'CANONICALIZE',
    'ORPTS\'s 6-digit municipal code (100%, always 6 digits). First two digits: county (01–57; NYC 60–64). Part of parcel identity: a tax map number is unique only inside its SWIS. Last two: 00 city/whole town, 89 town outside villages, 01/03/05… village portions.'),
  s('PARCEL_ADDR', 255, 'address', 'NORMALIZE',
    'Situs as one string, number and street (99.66%).'),
  s('PRINT_KEY', 50, 'identity', 'CANONICALIZE',
    'The formatted SBL, e.g. section.subsection-block-lot (84.24%; absent in New York City). A secondary identifier observation, never identity: folding its separators would merge 58,239 distinct keys.'),
  s('SBL', 50, 'identity', 'CANONICALIZE',
    'Section-Block-Lot, the tax map number in ORPTS\'s unformatted fixed-width form: 20 characters outside NYC, the 10-digit BBL inside it (99.88%). With SWIS, canonical property identity. Absent on 6,606 rows (right-of-way, water, unknown), which are quarantined; 19 Westchester rows carry a label with no digit, also quarantined.'),
  s('CITYTOWN_NAME', 50, 'geography', 'NORMALIZE',
    'The city or town (villages excluded) the parcel is in (100%).'),
  s('CITYTOWN_SWIS', 10, 'geography', 'KEEP_RAW',
    'The city or town\'s SWIS (100%). With SBL it forms the tax-map key kept as a CANDIDATE link between village and town roll records of one polygon — never identity (11,523 such keys span several SWIS, mostly distinct Suffolk and Nassau parcels).'),

  // -- situs address -------------------------------------------------------------
  s('LOC_ST_NBR', 25, 'address', 'NORMALIZE', 'Situs street number (89.17%). A string: it can carry letters, ranges and fractions.'),
  s('LOC_STREET', 255, 'address', 'NORMALIZE', 'Situs street including pre-direction, name, post-direction and suffix, as one string (99.66%).'),
  s('LOC_UNIT', 25, 'address', 'NORMALIZE', 'Situs unit (0.64%).'),
  s('LOC_ZIP', 25, 'address', 'NORMALIZE',
    'Situs ZIP (56.81%). County fill ranges from 0% (Nassau) to 99.97% (Kings); 32 counties are below half.'),

  // -- assessment -----------------------------------------------------------------
  s('PROP_CLASS', 10, 'assessment', 'NORMALIZE',
    'Two code systems in one column: outside NYC the ORPTS 3-digit property class (e.g. 210 one-family residence); in NYC the PLUTO 2-digit land-use code (01–11). The system is recorded beside every value and the two are never compared (99.58%).'),
  s('ROLL_SECTION', 2, 'assessment', 'NORMALIZE',
    'Assessment roll section (20 NYCRR 8190): 1 taxable, 3 taxable state land, 5 special franchise, 6 utility, 7 ceiling railroad, 8 wholly exempt (84.08%; absent in NYC). A roll-status code, not a tax amount.'),
  n('LAND_AV', 'Double', 'assessment', 'CANONICALIZE',
    'Assessed land value (99.62%). Whole dollars in this release (0 sub-cent, 0 negative); 0 is a stated zero, never "missing".'),
  n('TOTAL_AV', 'Double', 'assessment', 'CANONICALIZE',
    'Assessed total value (99.62%). ASSESSED, at the municipality\'s own level of assessment (outside NYC) or DOF\'s assessment (NYC) — not market value and not comparable across municipalities. 343 rows state land above total; kept and flagged, never repaired.'),
  n('FULL_MARKET_VAL', 'Double', 'assessment', 'CANONICALIZE',
    'Full market value as the roll states it (84.08%; absent in NYC; 0 on 414,981 rows). A different value type from assessed value and never stored in the same slot.'),
  s('SCHOOL_CODE', 10, 'geography', 'KEEP_RAW', 'ORPTS school district code (99.62%). An identifier, kept as a string.'),
  s('SCHOOL_NAME', 50, 'geography', 'NORMALIZE', 'School district name (84.08%).'),

  // -- structure (residential inventory; NYC: DOF building class) -------------------
  n('YR_BLT', 'Integer', 'structure', 'CANONICALIZE',
    'Year built (66.01%). 0 on 38,687 rows means "not recorded" and becomes null; a year outside 1600..roll year + 1 is kept raw and not canonicalized.'),
  n('FRONT', 'Integer', 'geography', 'NORMALIZE', 'Lot frontage in feet (99.36%). ORPTS sizes a parcel by frontage×depth, acres or square feet.'),
  n('DEPTH', 'Integer', 'geography', 'NORMALIZE', 'Lot depth in feet (99.36%).'),
  n('SQ_FT', 'Double', 'geography', 'CANONICALIZE',
    'Assessed area in square feet (99.36% present, but 0 on 4.36 M rows outside NYC where the roll sizes the parcel another way). The canonical area where ACRES states none; in NYC it is the lot area.'),
  n('ACRES', 'Double', 'geography', 'CANONICALIZE',
    'Assessed area in acres (83.82%; absent in NYC). The canonical area source when positive.'),
  s('SEWER_TYPE', 2, 'structure', 'NORMALIZE', 'Sewer type code (63.59%).'),
  s('SEWER_DESC', 50, 'structure', 'NORMALIZE', 'Sewer type description (66.01%).'),
  s('WATER_SUPPLY', 2, 'structure', 'NORMALIZE', 'Water supply code (63.79%).'),
  s('WATER_DESC', 50, 'structure', 'NORMALIZE', 'Water supply description (66.01%).'),
  s('UTILITIES', 2, 'structure', 'NORMALIZE', 'Utilities code (63.67%).'),
  s('UTILITIES_DESC', 50, 'structure', 'NORMALIZE', 'Utilities description (66.01%).'),
  s('BLDG_STYLE', 2, 'structure', 'NORMALIZE',
    'Residential building style code outside NYC; the DOF building class in NYC (62.77%). Code system recorded per row.'),
  s('BLDG_STYLE_DESC', 255, 'structure', 'NORMALIZE', 'Its description (62.77%).'),
  s('HEAT_TYPE', 2, 'structure', 'NORMALIZE', 'Heat type code, residential (46.54%).'),
  s('HEAT_TYPE_DESC', 50, 'structure', 'NORMALIZE', 'Heat type description (47.25%).'),
  s('FUEL_TYPE', 2, 'structure', 'NORMALIZE', 'Fuel type code, residential (43.82%).'),
  s('FUEL_TYPE_DESC', 50, 'structure', 'NORMALIZE', 'Fuel type description (47.25%).'),
  n('SQFT_LIVING', 'Double', 'structure', 'CANONICALIZE', 'Living area in square feet, residential (61.98%).'),
  n('GFA', 'Integer', 'structure', 'NORMALIZE', 'Gross floor area of a commercial building, all floors but the basement (18.33%).'),
  n('NBR_KITCHENS', 'SmallInteger', 'structure', 'NORMALIZE', 'Kitchens, residential (47.25%).'),
  n('NBR_FULL_BATHS', 'SmallInteger', 'structure', 'NORMALIZE', 'Full bathrooms, residential (47.25%).'),
  n('NBR_BEDROOMS', 'SmallInteger', 'structure', 'NORMALIZE', 'Bedrooms, residential (47.25%).'),
  s('USED_AS_CODE', 10, 'structure', 'NORMALIZE', 'Primary commercial use code (3.57%).'),
  s('USED_AS_DESC', 50, 'structure', 'NORMALIZE', 'Primary commercial use description (3.57%).'),
  s('AG_DIST_CODE', 10, 'geography', 'NORMALIZE', 'Agricultural district code (2.35%).'),
  s('AG_DIST_NAME', 50, 'geography', 'NORMALIZE', 'Agricultural district name (2.35%).'),

  // -- ownership. Names are observations; MAILING IS NOT. ------------------------------
  s('MAIL_ADDR', 255, 'ownership', 'RESTRICTED', 'Primary owner\'s mailing street address (80.26%; 0% in NYC). Restricted plane only.'),
  s('PO_BOX', 50, 'ownership', 'RESTRICTED', 'Primary owner\'s mailing PO box (4.23%). Restricted.'),
  s('MAIL_CITY', 50, 'ownership', 'RESTRICTED', 'Primary owner\'s mailing city (84.02%). Restricted.'),
  s('MAIL_STATE', 50, 'ownership', 'RESTRICTED', 'Primary owner\'s mailing state (83.47%). Restricted.'),
  s('MAIL_ZIP', 50, 'ownership', 'RESTRICTED', 'Primary owner\'s mailing ZIP (82.60%). Restricted.'),
  s('ADD_MAIL_ADDR', 255, 'ownership', 'RESTRICTED', 'Additional owner\'s mailing street address (28.67%). Restricted.'),
  s('ADD_MAIL_PO_BOX', 50, 'ownership', 'RESTRICTED', 'Additional owner\'s mailing PO box (1.40%). Restricted.'),
  s('ADD_MAIL_CITY', 50, 'ownership', 'RESTRICTED', 'Additional owner\'s mailing city (29.83%). Restricted.'),
  s('ADD_MAIL_STATE', 50, 'ownership', 'RESTRICTED', 'Additional owner\'s mailing state (29.78%). Restricted.'),
  s('ADD_MAIL_ZIP', 10, 'ownership', 'RESTRICTED', 'Additional owner\'s mailing ZIP (29.81%). Restricted.'),

  // -- deed reference, not a transfer ----------------------------------------------------
  n('BOOK', 'Integer', 'legal', 'DERIVE_LATER',
    'Liber of the last recorded deed, "only for parcels which have sold in the last 10-12 years" (53.53%). Kept raw as a candidate link for a future county-clerk source; no date, price or party, so NEVER a transfer or sale fact.'),
  n('PAGE', 'Integer', 'legal', 'DERIVE_LATER', 'Page of that deed (53.53%). Kept raw with BOOK; never a transfer.'),

  // -- location --------------------------------------------------------------------------------
  n('GRID_EAST', 'Double', 'geography', 'KEEP_RAW',
    'The roll\'s easting, "assumed to be State Plane" by the publisher (99.63%). Zone and datum are not stated per row, so it is kept raw and never converted into a coordinate.'),
  n('GRID_NORTH', 'Double', 'geography', 'KEEP_RAW', 'The roll\'s northing, same caveat (99.63%).'),

  // -- publisher-composed identifiers ------------------------------------------------------
  s('MUNI_PARCEL_ID', 50, 'identity', 'CANONICALIZE',
    'CITYTOWN_SWIS + ORPTS\'s internal parcel id: the link to other ORPTS products (84.08%, unique on every row that has it; absent in NYC). A secondary identifier observation — not the public tax map number, so not identity.'),
  s('SWIS_SBL_ID', 50, 'identity', 'KEEP_RAW',
    'The publisher\'s SWIS+SBL composite (99.88%). Retained; Reivesti computes the same key from SWIS and SBL itself and flags the 2 rows where the composite disagrees with its own parts.'),
  s('SWIS_PRINT_KEY_ID', 50, 'identity', 'KEEP_RAW',
    'The publisher\'s SWIS+PRINT_KEY composite (84.24%; 46 rows disagree with their parts). Retained, never identity.'),

  // -- time --------------------------------------------------------------------------------------
  n('ROLL_YR', 'Integer', 'assessment', 'CANONICALIZE',
    'The assessment roll year of every attribute on the row: 2025 on all 5,510,061 rows. It is `assessmentYear`, so two roll years are two observations and never a conflict.'),
  n('SPATIAL_YR', 'Integer', 'provenance', 'HISTORIZE',
    'The year of the parcel polygon the point was derived from: 2025, except 31,992 Westchester rows on 2024 geometry. Per-county vintage, not one statewide date.'),

  // -- publisher-derived classifications -------------------------------------------------------
  s('OWNER_TYPE', 10, 'ownership', 'NORMALIZE',
    'Geospatial Services\' owner category (1 federal … 8 private, 10 road right of way, 11 water, -999 unknown), derived by the publisher from the names, reference data and online research. Kept as a classification; never used to type or merge a party.'),
  s('PRIMARY_OWNER', 255, 'ownership', 'CANONICALIZE',
    'Current primary owner of record (99.63%). A party OBSERVATION: the roll names who is assessed, not who acquired the land or when.'),
  s('ADD_OWNER', 255, 'ownership', 'CANONICALIZE', 'Additional owner (29.92%). A second observation, never concatenated into the first.'),
  s('NYS_NAME', 50, 'ownership', 'NORMALIZE',
    'For state-owned parcels (OWNER_TYPE 2), the agency Geospatial Services deems owner/occupier (0.65%). A publisher attribution, kept as such.'),
  s('NYS_NAME_SOURCE', 50, 'provenance', 'KEEP_RAW', 'How the state-ownership attribution was made (X-Y-ZZ-y code; 0.65%).'),
  s('DUP_GEO', 5, 'geography', 'NORMALIZE',
    '"Y" when the polygon geometry is duplicated: condominium units (separate SBLs) or a parcel assessed by both a village and its town (separate SWIS) — 1.85%. Recorded per row; the publisher warns it inflates areas and counts.'),
  n('CALC_ACRES', 'Double', 'geography', 'NORMALIZE',
    'GIS-calculated acres of the polygon (100%). Kept as a GIS figure beside the assessed area, never the canonical area: duplicated geometries repeat it.'),
  n('ORIG_FID', 'Integer', 'provenance', 'KEEP_RAW',
    'The row id of the polygon the point was generated from, in the publisher\'s internal statewide build. Undocumented, reassigned every build: retained, excluded from change detection, never identity.'),
];

/**
 * Columns the source offers that are not ingested, and why.
 *
 * Geometry is retained — in the publisher's archive, byte for byte — and not
 * decoded into canonical rows.
 */
export const NY_NOT_INGESTED: readonly { readonly field: string; readonly reason: string }[] = [
  { field: 'Shape (POINT ZM, NAD83 / UTM zone 18N)', reason: 'The parcel centroid, "mathematically derived and falls within a tax parcel polygon". Retained inside the immutable publisher archive; not decoded, because the shared File Geodatabase reader skips geometry and decoding it is a shared-runtime change deferred to post-parallel integration. No coordinate is invented from GRID_EAST/GRID_NORTH.' },
  { field: 'Lookup tables NYS_Property_Class_Codes, NYC_LandUse_Codes, NYC_BldgClass_Codes, SWIS_Muni_Codes, NYS_Name_Source_Table', reason: 'Code descriptions shipped in the same geodatabase. Retained in the archive; codes are kept verbatim on every row and descriptions are DERIVE_LATER.' },
];

/** Concepts other statewide schemas carry and this one does not. */
export const NY_ABSENT_CONCEPTS: readonly string[] = [
  'tax_amount', 'net_tax', 'gross_tax', 'sale_date', 'sale_value', 'homestead', 'taxable_value', 'latitude', 'longitude',
];

const BY_FIELD = new Map(NY_STATEWIDE_FIELD_MAP.map((f) => [f.field, f] as const));

export function nyStatewideField(name: string): FieldSpec | undefined {
  return BY_FIELD.get(name);
}

export function nyStatewideKnownFields(): ReadonlySet<string> {
  return new Set(NY_STATEWIDE_FIELD_MAP.map((f) => f.field));
}

export function nyStatewideDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of NY_STATEWIDE_FIELD_MAP) out[f.disposition] = (out[f.disposition] ?? 0) + 1;
  return out;
}

export const NY_RESTRICTED_FIELDS: readonly string[] = NY_STATEWIDE_FIELD_MAP
  .filter((f) => f.disposition === 'RESTRICTED')
  .map((f) => f.field);
