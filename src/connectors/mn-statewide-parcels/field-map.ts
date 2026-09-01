/**
 * Minnesota statewide parcel layer — field inventory and disposition.
 *
 * All 94 attribute fields of `plan_parcels_open`, captured from the publisher's
 * own layer metadata on 2026-08-31 and classified one by one. Nothing is
 * ingested because it looks useful and nothing is dropped silently: every field
 * has a disposition and a reason, and an unlisted field is schema drift.
 *
 * The layer is standardised to the **MnGAC Parcel Data Standard v1.1.3**, which
 * is what makes one field map serve 59 counties instead of 59 field maps. It is
 * emphatically not a guarantee that every county populates every field — the
 * null rates below are measured, not assumed, and several fields are
 * near-universally empty.
 */

export type Disposition =
  | 'KEEP_RAW'
  | 'NORMALIZE'
  | 'CANONICALIZE'
  | 'HISTORIZE'
  | 'RESTRICTED'
  | 'DERIVE_LATER'
  | 'IGNORE_WITH_REASON';

export type FieldGroup =
  | 'identity' | 'address' | 'ownership' | 'assessment' | 'structure'
  | 'tax' | 'sale' | 'geography' | 'legal' | 'provenance';

export type FieldSpec = {
  readonly field: string;
  readonly sourceType: string;
  readonly maxLength?: number;
  readonly group: FieldGroup;
  readonly disposition: Disposition;
  readonly note: string;
};

export const MN_STATEWIDE_FIELD_MAP: readonly FieldSpec[] = [
  // -- identity ------------------------------------------------------------
  { field: 'objectid', sourceType: 'OID', group: 'provenance', disposition: 'KEEP_RAW',
    note: 'The service\'s own row id. Retained as a source identifier and NEVER used as Reivesti property identity: ArcGIS reassigns OBJECTIDs, so it is not stable across snapshots.' },
  { field: 'county_pin', sourceType: 'String', maxLength: 22, group: 'identity', disposition: 'CANONICALIZE',
    note: 'The county\'s own parcel identifier. With co_code this is canonical property identity. Empty on 18,462 rows, which therefore have no identity and are quarantined.' },
  { field: 'state_pin', sourceType: 'String', maxLength: 28, group: 'identity', disposition: 'KEEP_RAW',
    note: 'The standard\'s statewide form, "<co_code>-<county_pin>". Retained as a source identifier; Reivesti derives its own key rather than trusting a source-composed string.' },
  { field: 'co_code', sourceType: 'String', maxLength: 5, group: 'identity', disposition: 'CANONICALIZE',
    note: 'Five-digit county FIPS, supplied by the source. This is the authoritative county identity used for partition routing — never inferred from the address.' },
  { field: 'co_name', sourceType: 'String', maxLength: 40, group: 'geography', disposition: 'NORMALIZE',
    note: 'County name. Cross-checked against the FIPS catalogue; a disagreement is drift.' },
  { field: 'state_code', sourceType: 'String', maxLength: 2, group: 'geography', disposition: 'NORMALIZE',
    note: 'Always MN in this layer. Checked rather than assumed.' },

  // -- situs address -------------------------------------------------------
  { field: 'anumberpre', sourceType: 'String', maxLength: 15, group: 'address', disposition: 'NORMALIZE', note: 'House-number prefix.' },
  { field: 'anumber', sourceType: 'Integer', group: 'address', disposition: 'NORMALIZE', note: 'House number.' },
  { field: 'anumbersuf', sourceType: 'String', maxLength: 15, group: 'address', disposition: 'NORMALIZE', note: 'House-number suffix.' },
  { field: 'st_pre_mod', sourceType: 'String', maxLength: 15, group: 'address', disposition: 'NORMALIZE', note: 'Street pre-modifier.' },
  { field: 'st_pre_dir', sourceType: 'String', maxLength: 9, group: 'address', disposition: 'NORMALIZE', note: 'Street pre-directional.' },
  { field: 'st_pre_typ', sourceType: 'String', maxLength: 35, group: 'address', disposition: 'NORMALIZE', note: 'Street pre-type.' },
  { field: 'st_pre_sep', sourceType: 'String', maxLength: 20, group: 'address', disposition: 'NORMALIZE', note: 'Street pre-separator.' },
  { field: 'st_name', sourceType: 'String', maxLength: 60, group: 'address', disposition: 'NORMALIZE', note: 'Street name.' },
  { field: 'st_pos_typ', sourceType: 'String', maxLength: 15, group: 'address', disposition: 'NORMALIZE', note: 'Street post-type.' },
  { field: 'st_pos_dir', sourceType: 'String', maxLength: 9, group: 'address', disposition: 'NORMALIZE', note: 'Street post-directional.' },
  { field: 'st_pos_mod', sourceType: 'String', maxLength: 15, group: 'address', disposition: 'NORMALIZE', note: 'Street post-modifier.' },
  { field: 'sub_type1', sourceType: 'String', maxLength: 12, group: 'address', disposition: 'NORMALIZE', note: 'Subaddress type (UNIT, APT).' },
  { field: 'sub_id1', sourceType: 'String', maxLength: 30, group: 'address', disposition: 'NORMALIZE', note: 'Subaddress identifier.' },
  { field: 'sub_type2', sourceType: 'String', maxLength: 12, group: 'address', disposition: 'NORMALIZE', note: 'Second subaddress type.' },
  { field: 'sub_id2', sourceType: 'String', maxLength: 30, group: 'address', disposition: 'NORMALIZE', note: 'Second subaddress identifier.' },
  { field: 'zip', sourceType: 'String', maxLength: 5, group: 'address', disposition: 'NORMALIZE', note: 'Situs ZIP.' },
  { field: 'zip4', sourceType: 'String', maxLength: 4, group: 'address', disposition: 'NORMALIZE', note: 'Situs ZIP+4.' },
  { field: 'postcomm', sourceType: 'String', maxLength: 40, group: 'address', disposition: 'NORMALIZE', note: 'Postal community — often differs from the municipality.' },
  { field: 'ctu_name', sourceType: 'String', maxLength: 100, group: 'geography', disposition: 'NORMALIZE', note: 'City/township/unorganised territory name.' },
  { field: 'ctu_id_txt', sourceType: 'String', maxLength: 8, group: 'geography', disposition: 'KEEP_RAW', note: 'CTU GNIS identifier.' },

  // -- ownership. Names are canonical party observations; MAILING IS NOT. ---
  { field: 'owner_name', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'CANONICALIZE',
    note: 'Owner of record on the county roll. A party OBSERVATION — the roll says who is billed and assessed, not who acquired what and when.' },
  { field: 'owner_more', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'CANONICALIZE',
    note: 'Additional owner names. A second party observation, never concatenated into the first.' },
  { field: 'own_add_l1', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED',
    note: 'Owner mailing address. Personal data: restricted plane only, never on a canonical row.' },
  { field: 'own_add_l2', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Owner mailing address line 2.' },
  { field: 'own_add_l3', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Owner mailing address line 3.' },
  { field: 'own_add_l4', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Owner mailing address line 4.' },
  { field: 'tax_name', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'CANONICALIZE',
    note: 'Taxpayer of record. Frequently a servicer or agent rather than the owner, so it is a distinct role, not a fallback owner name.' },
  { field: 'tax_add_l1', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Taxpayer mailing address.' },
  { field: 'tax_add_l2', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Taxpayer mailing address line 2.' },
  { field: 'tax_add_l3', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Taxpayer mailing address line 3.' },
  { field: 'tax_add_l4', sourceType: 'String', maxLength: 100, group: 'ownership', disposition: 'RESTRICTED', note: 'Taxpayer mailing address line 4.' },
  { field: 'ownership', sourceType: 'String', maxLength: 30, group: 'ownership', disposition: 'KEEP_RAW',
    note: 'County-supplied ownership-type text. No statewide domain, so it is retained verbatim rather than mapped to a taxonomy that does not exist.' },
  { field: 'homestead', sourceType: 'String', maxLength: 10, group: 'ownership', disposition: 'KEEP_RAW',
    note: 'Homestead status. Owner-occupancy evidence, and a classification the county makes rather than a fact about a person.' },

  // -- assessment ----------------------------------------------------------
  { field: 'emv_land', sourceType: 'Integer', group: 'assessment', disposition: 'CANONICALIZE', note: 'Estimated market value, land.' },
  { field: 'emv_bldg', sourceType: 'Integer', group: 'assessment', disposition: 'CANONICALIZE', note: 'Estimated market value, buildings.' },
  { field: 'emv_total', sourceType: 'Integer', group: 'assessment', disposition: 'CANONICALIZE', note: 'Estimated market value, total. Not necessarily land + building: counties compute it.' },
  { field: 'mkt_year', sourceType: 'SmallInteger', group: 'assessment', disposition: 'CANONICALIZE',
    note: 'The year the market value applies to. Present here and ABSENT from the direct Hennepin feed, which is a concrete advantage of the statewide standard.' },
  { field: 'tax_capac', sourceType: 'Integer', group: 'assessment', disposition: 'KEEP_RAW', note: 'Tax capacity — a Minnesota-specific derived value, retained as stated.' },
  { field: 'useclass1', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'NORMALIZE', note: 'Primary use classification.' },
  { field: 'useclass2', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'NORMALIZE', note: 'Second use classification.' },
  { field: 'useclass3', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'NORMALIZE', note: 'Third use classification.' },
  { field: 'useclass4', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'NORMALIZE', note: 'Fourth use classification.' },
  { field: 'multi_uses', sourceType: 'String', maxLength: 10, group: 'assessment', disposition: 'KEEP_RAW', note: 'Flag: the parcel has several uses.' },
  { field: 'xuseclass1', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'KEEP_RAW', note: 'Tax-exempt use classification.' },
  { field: 'xuseclass2', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'KEEP_RAW', note: 'Second exempt classification.' },
  { field: 'xuseclass3', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'KEEP_RAW', note: 'Third exempt classification.' },
  { field: 'xuseclass4', sourceType: 'String', maxLength: 100, group: 'assessment', disposition: 'KEEP_RAW', note: 'Fourth exempt classification.' },
  { field: 'tax_exempt', sourceType: 'String', maxLength: 3, group: 'assessment', disposition: 'KEEP_RAW', note: 'Exempt flag.' },

  // -- tax -----------------------------------------------------------------
  { field: 'tax_year', sourceType: 'SmallInteger', group: 'tax', disposition: 'CANONICALIZE', note: 'The year the tax amount applies to.' },
  { field: 'total_tax', sourceType: 'Integer', group: 'tax', disposition: 'CANONICALIZE', note: 'Total tax for tax_year.' },
  { field: 'spec_asses', sourceType: 'Integer', group: 'tax', disposition: 'CANONICALIZE', note: 'Special assessments.' },
  { field: 'school_dst', sourceType: 'String', maxLength: 10, group: 'geography', disposition: 'NORMALIZE', note: 'School district.' },
  { field: 'wshd_dst', sourceType: 'String', maxLength: 50, group: 'geography', disposition: 'NORMALIZE', note: 'Watershed district.' },
  { field: 'green_acre', sourceType: 'String', maxLength: 10, group: 'tax', disposition: 'KEEP_RAW', note: 'Green Acres deferral programme flag.' },
  { field: 'open_space', sourceType: 'String', maxLength: 10, group: 'tax', disposition: 'KEEP_RAW', note: 'Open Space deferral flag.' },
  { field: 'ag_preserv', sourceType: 'String', maxLength: 10, group: 'tax', disposition: 'KEEP_RAW', note: 'Agricultural Preserve flag.' },
  { field: 'agpre_enrd', sourceType: 'Date', maxLength: 8, group: 'tax', disposition: 'KEEP_RAW', note: 'Agricultural Preserve enrolment date.' },
  { field: 'agpre_expd', sourceType: 'Date', maxLength: 8, group: 'tax', disposition: 'KEEP_RAW', note: 'Agricultural Preserve expiry date.' },

  // -- structure -----------------------------------------------------------
  { field: 'dwell_type', sourceType: 'String', maxLength: 30, group: 'structure', disposition: 'NORMALIZE', note: 'Dwelling type.' },
  { field: 'home_style', sourceType: 'String', maxLength: 30, group: 'structure', disposition: 'NORMALIZE', note: 'Home style.' },
  { field: 'fin_sq_ft', sourceType: 'Integer', group: 'structure', disposition: 'CANONICALIZE',
    note: 'Finished square feet. ABSENT from the direct Hennepin feed — a real gain from the statewide standard.' },
  { field: 'garage', sourceType: 'String', maxLength: 10, group: 'structure', disposition: 'KEEP_RAW', note: 'Garage present.' },
  { field: 'garagesqft', sourceType: 'Integer', group: 'structure', disposition: 'KEEP_RAW', note: 'Garage square feet.' },
  { field: 'basement', sourceType: 'String', maxLength: 10, group: 'structure', disposition: 'KEEP_RAW', note: 'Basement present.' },
  { field: 'heating', sourceType: 'String', maxLength: 30, group: 'structure', disposition: 'KEEP_RAW', note: 'Heating type.' },
  { field: 'cooling', sourceType: 'String', maxLength: 30, group: 'structure', disposition: 'KEEP_RAW', note: 'Cooling type.' },
  { field: 'year_built', sourceType: 'SmallInteger', group: 'structure', disposition: 'CANONICALIZE', note: 'Year built.' },
  { field: 'num_units', sourceType: 'Integer', group: 'structure', disposition: 'CANONICALIZE', note: 'Number of dwelling units.' },

  // -- sale echo. See sale-semantics.ts: NOT eCRV-grade economics. ----------
  { field: 'sale_date', sourceType: 'Date', maxLength: 8, group: 'sale', disposition: 'HISTORIZE',
    note: 'Assessor-reported latest sale date. Populated on 37.6% of rows and ranges to the year 3009, so it carries data-entry errors. An OBSERVATION, never a transfer record.' },
  { field: 'sale_value', sourceType: 'Integer', group: 'sale', disposition: 'HISTORIZE',
    note: 'Assessor-reported latest sale value. 464,388 rows carry 0 and 415,126 carry a value with no date. Not consideration, and not comparable to eCRV.' },

  // -- legal ---------------------------------------------------------------
  { field: 'lot', sourceType: 'String', maxLength: 30, group: 'legal', disposition: 'NORMALIZE', note: 'Lot.' },
  { field: 'block', sourceType: 'String', maxLength: 30, group: 'legal', disposition: 'NORMALIZE', note: 'Block.' },
  { field: 'plat_name', sourceType: 'String', maxLength: 150, group: 'legal', disposition: 'NORMALIZE', note: 'Plat/addition name.' },
  { field: 'abb_legal', sourceType: 'String', maxLength: 254, group: 'legal', disposition: 'KEEP_RAW',
    note: 'Abbreviated legal description. Truncated by the standard at 254 characters, so it is not a legal description and must never be treated as one.' },
  { field: 'landmark', sourceType: 'String', maxLength: 150, group: 'legal', disposition: 'KEEP_RAW', note: 'Landmark name.' },
  { field: 'section', sourceType: 'SmallInteger', group: 'legal', disposition: 'KEEP_RAW', note: 'PLSS section.' },
  { field: 'township', sourceType: 'SmallInteger', group: 'legal', disposition: 'KEEP_RAW', note: 'PLSS township.' },
  { field: 'range', sourceType: 'SmallInteger', group: 'legal', disposition: 'KEEP_RAW', note: 'PLSS range.' },
  { field: 'range_dir', sourceType: 'SmallInteger', group: 'legal', disposition: 'KEEP_RAW', note: 'PLSS range direction.' },
  { field: 'prin_mer', sourceType: 'SmallInteger', group: 'legal', disposition: 'KEEP_RAW', note: 'PLSS principal meridian.' },

  // -- area ----------------------------------------------------------------
  { field: 'acres_poly', sourceType: 'Double', group: 'geography', disposition: 'CANONICALIZE', note: 'Acreage computed from the polygon.' },
  { field: 'acres_deed', sourceType: 'Double', group: 'geography', disposition: 'CANONICALIZE', note: 'Acreage as deeded. Kept separate from the computed figure; they legitimately differ.' },

  // -- provenance ----------------------------------------------------------
  { field: 'edit_date', sourceType: 'Date', maxLength: 8, group: 'provenance', disposition: 'KEEP_RAW', note: 'County edit date. Freshness evidence for the overlap comparison.' },
  { field: 'exp_date', sourceType: 'Date', maxLength: 8, group: 'provenance', disposition: 'KEEP_RAW', note: 'Export date.' },
  { field: 'polyptrel', sourceType: 'SmallInteger', group: 'provenance', disposition: 'KEEP_RAW', note: 'Polygon/point relationship code from the standard.' },
  { field: 'n_standard', sourceType: 'SmallInteger', group: 'provenance', disposition: 'KEEP_RAW', note: 'Standard-conformance indicator supplied by the aggregator.' },

  // -- geometry, deliberately not ingested ---------------------------------
  { field: 'Shape__Area', sourceType: 'Double', group: 'geography', disposition: 'IGNORE_WITH_REASON',
    note: 'Geometry-derived area in the layer\'s projection (EPSG:26915). acres_poly is the county-supplied figure and is the one used; this is a rendering artefact of the service.' },
  { field: 'Shape__Length', sourceType: 'Double', group: 'geography', disposition: 'IGNORE_WITH_REASON',
    note: 'Geometry-derived perimeter. No canonical consumer.' },
];

/**
 * Fields the layer offers that are NOT ingested, and why.
 *
 * Geometry is the big one: the layer is polygon, and Reivesti has no canonical
 * geometry model. Fetching 2.7 million parcel polygons would multiply the
 * artifact several times over to store something nothing reads. It is recorded
 * as available so a future phase adds it deliberately rather than discovering it.
 */
export const NOT_INGESTED: readonly { readonly field: string; readonly reason: string }[] = [
  { field: 'Shape (MULTIPOLYGON)', reason: 'Parcel boundary geometry, EPSG:26915. Available in the source; no canonical geometry model exists, so ingesting it would store megabytes nothing reads.' },
  { field: 'gdb_geomattr_data', reason: 'Esri geodatabase internal geometry attribute blob. Not source data.' },
];

const BY_FIELD = new Map(MN_STATEWIDE_FIELD_MAP.map((f) => [f.field, f] as const));

export function mnStatewideField(name: string): FieldSpec | undefined {
  return BY_FIELD.get(name);
}

/** Fields with a mapping decision. Anything else the source returns is drift. */
export function mnStatewideKnownFields(): ReadonlySet<string> {
  return new Set(MN_STATEWIDE_FIELD_MAP.map((f) => f.field));
}

/** Attribute columns to select. Geometry is deliberately excluded. */
export function mnStatewideOutFields(): readonly string[] {
  return MN_STATEWIDE_FIELD_MAP.map((f) => f.field);
}

export function mnStatewideDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of MN_STATEWIDE_FIELD_MAP) out[f.disposition] = (out[f.disposition] ?? 0) + 1;
  return out;
}

/** Mailing fields, which may never reach a canonical row. */
export const RESTRICTED_FIELDS: readonly string[] = MN_STATEWIDE_FIELD_MAP
  .filter((f) => f.disposition === 'RESTRICTED')
  .map((f) => f.field);
