/**
 * Wisconsin Statewide Parcel Map (V12) — field inventory and disposition.
 *
 * Every attribute column of `V1200_WisconsinParcels_2026`, as the publisher's
 * own File Geodatabase declares it, classified one by one. The inventory is the
 * GEODATABASE's, not the FeatureServer's, because the geodatabase is the
 * artifact this connector reads; the two differ by three columns and the
 * difference is recorded below rather than papered over.
 *
 * The layer follows the SCO's statewide parcel schema, which is what makes one
 * field map serve 72 counties. It is not a promise that every county fills every
 * field — fill rates were measured over all 3,574,646 rows on 2026-09-28 and are
 * quoted where they matter.
 *
 * ## What this schema does NOT carry
 *
 * No year built, no living area, no dwelling type, no unit count, no bedrooms,
 * and **no sale date or sale price at all**. Minnesota's statewide standard has
 * a structure block and an assessor's sale echo; Wisconsin's does not. So this
 * connector emits no structure characteristics and no
 * `ASSESSOR_REPORTED_SALE_OBSERVATION`, and the coverage graph claims neither.
 * Saying so here is the point: a missing concept should be visibly missing, not
 * a column of nulls that reads as "unknown for every parcel".
 */
import type { Disposition, FieldGroup, FieldSpec } from '../mn-statewide-parcels/field-map.ts';

export type { Disposition, FieldGroup, FieldSpec };

export const WI_STATEWIDE_FIELD_MAP: readonly FieldSpec[] = [
  // -- identity ------------------------------------------------------------
  { field: 'OBJECTID', sourceType: 'OID', group: 'provenance', disposition: 'KEEP_RAW',
    note: 'The geodatabase row id. A source identifier, never Reivesti identity: it is reassigned every annual release.' },
  { field: 'STATEID', sourceType: 'String', maxLength: 100, group: 'identity', disposition: 'KEEP_RAW',
    note: 'The SCO\'s composed statewide key (submitting FIPS + local id). 60,038 rows repeat one, because it inherits every placeholder PARCELID. Retained; Reivesti derives its own key rather than trusting a source-composed string.' },
  { field: 'PARCELID', sourceType: 'String', maxLength: 100, group: 'identity', disposition: 'CANONICALIZE',
    note: 'The local parcel identifier. With the county, canonical property identity. 58,201 rows carry a label with no digit — ROW, GAP, HYDRO, OVERLAP — which is a non-parcel feature, not an identifier, and is quarantined.' },
  { field: 'TAXPARCELID', sourceType: 'String', maxLength: 100, group: 'identity', disposition: 'CANONICALIZE',
    note: 'The tax-roll identifier where a county keeps one distinct from PARCELID. Populated on 27.8% of rows and different from PARCELID on every one of them. A secondary identifier observation — never identity.' },

  // -- provenance / freshness ------------------------------------------------
  { field: 'PARCELDATE', sourceType: 'String', maxLength: 25, group: 'provenance', disposition: 'KEEP_RAW',
    note: 'A county-supplied parcel date. 21% populated, in a dozen textual shapes including 2-digit years and times. Kept verbatim and not interpreted: its meaning is not uniform across submitters.' },
  { field: 'TAXROLLYEAR', sourceType: 'String', maxLength: 10, group: 'tax', disposition: 'CANONICALIZE',
    note: 'The tax roll the values and taxes come from. 2025 on 98.2% of rows; 2021–2027 and blank also occur. The year every value on the row belongs to, so two different roll years are never compared as a conflict.' },
  { field: 'LOADDATE', sourceType: 'String', maxLength: 10, group: 'provenance', disposition: 'HISTORIZE',
    note: 'When the SCO loaded the submitting county\'s data. The per-county freshness evidence: 2026-01-16 to 2026-04-20 across counties. Not one statewide date.' },
  { field: 'PARCELFIPS', sourceType: 'String', maxLength: 10, group: 'provenance', disposition: 'KEEP_RAW',
    note: 'The SUBMITTING county\'s 3-digit FIPS — not always the county the parcel lies in. Appleton and Menasha span county lines, so 5,430 Calumet and Winnebago parcels arrive under Outagamie\'s or Winnebago\'s code. Provenance, never the routing key.' },
  { field: 'PARCELSRC', sourceType: 'String', maxLength: 50, group: 'provenance', disposition: 'KEEP_RAW',
    note: 'The submitting jurisdiction\'s name. 73 distinct values.' },

  // -- geography -------------------------------------------------------------
  { field: 'CONAME', sourceType: 'String', maxLength: 50, group: 'geography', disposition: 'CANONICALIZE',
    note: 'The county the parcel lies in. THE routing key, resolved to a FIPS through the federal catalogue. One row names "MENOMONIE" — a city, not a county — and is quarantined.' },
  { field: 'PLACENAME', sourceType: 'String', maxLength: 100, group: 'geography', disposition: 'NORMALIZE',
    note: 'Municipality (minor civil division), "TOWN OF …", "CITY OF …" or "VILLAGE OF …". The taxing municipality, which is not the postal community.' },
  { field: 'SCHOOLDIST', sourceType: 'String', maxLength: 60, group: 'geography', disposition: 'NORMALIZE', note: 'School district name.' },
  { field: 'SCHOOLDISTNO', sourceType: 'String', maxLength: 50, group: 'geography', disposition: 'KEEP_RAW', note: 'School district number (DPI code). Kept as a string: it is an identifier.' },
  { field: 'LONGITUDE', sourceType: 'Double', group: 'geography', disposition: 'NORMALIZE',
    note: 'Source-computed parcel centroid longitude, decimal degrees. 99.77% populated, all inside Wisconsin\'s extent. A point, not a boundary.' },
  { field: 'LATITUDE', sourceType: 'Double', group: 'geography', disposition: 'NORMALIZE', note: 'Source-computed parcel centroid latitude, decimal degrees.' },
  { field: 'STATE', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Situs state. WI or blank. Checked, not assumed.' },

  // -- ownership. Names are canonical observations; MAILING IS NOT. ----------
  { field: 'OWNERNME1', sourceType: 'String', maxLength: 254, group: 'ownership', disposition: 'CANONICALIZE',
    note: 'Primary owner of record on the roll (98.3%). A party OBSERVATION: the roll says who is assessed and billed, not who acquired the land or when.' },
  { field: 'OWNERNME2', sourceType: 'String', maxLength: 254, group: 'ownership', disposition: 'CANONICALIZE',
    note: 'Secondary owner name (36.2%). A second observation, never concatenated into the first.' },
  { field: 'PSTLADRESS', sourceType: 'String', maxLength: 200, group: 'ownership', disposition: 'RESTRICTED',
    note: 'The owner\'s full mailing address, one string (96.5%). Personal data: restricted plane only, never on a canonical row.' },

  // -- situs address -------------------------------------------------------
  { field: 'SITEADRESS', sourceType: 'String', maxLength: 200, group: 'address', disposition: 'NORMALIZE', note: 'Full situs address as the county wrote it (69.8%).' },
  { field: 'ADDNUMPREFIX', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Address-number prefix. Often a grid designation (N, W) in Wisconsin\'s rural numbering.' },
  { field: 'ADDNUM', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Address number. A string: it can carry letters and leading zeros.' },
  { field: 'ADDNUMSUFFIX', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Address-number suffix.' },
  { field: 'PREFIX', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE',
    note: 'Street prefix. Carries EITHER a directional (N) or a pre-type (STATE ROAD, COUNTY ROAD); the adapter decides which, per value.' },
  { field: 'STREETNAME', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Street name.' },
  { field: 'STREETTYPE', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Street post-type, spelled out (COURT, ROAD).' },
  { field: 'SUFFIX', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Street post-directional.' },
  { field: 'LANDMARKNAME', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'KEEP_RAW', note: 'Landmark name (0.3%).' },
  { field: 'UNITTYPE', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Unit type.' },
  { field: 'UNITID', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Unit identifier.' },
  { field: 'ZIPCODE', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Situs ZIP (65.6%). Always five digits where present.' },
  { field: 'ZIP4', sourceType: 'String', maxLength: 50, group: 'address', disposition: 'NORMALIZE', note: 'Situs ZIP+4.' },

  // -- assessment ----------------------------------------------------------
  { field: 'CNTASSDVALUE', sourceType: 'Double', group: 'assessment', disposition: 'CANONICALIZE',
    note: 'Total ASSESSED value (90.7%). Wisconsin assesses at each municipality\'s own assessment ratio, so this is not market value and is not comparable across municipalities without the ratio.' },
  { field: 'LNDVALUE', sourceType: 'Double', group: 'assessment', disposition: 'CANONICALIZE', note: 'Assessed value of land.' },
  { field: 'IMPVALUE', sourceType: 'Double', group: 'assessment', disposition: 'CANONICALIZE', note: 'Assessed value of improvements.' },
  { field: 'MFLVALUE', sourceType: 'Double', group: 'assessment', disposition: 'NORMALIZE',
    note: 'Assessed value of Managed Forest Law / Forest Crop Law land. A separate programme value, not part of the land figure.' },
  { field: 'ESTFMKVALUE', sourceType: 'Double', group: 'assessment', disposition: 'CANONICALIZE',
    note: 'ESTIMATED FAIR MARKET value (67.4%). A different value type from assessed value — assessed divided by the assessment ratio — and never stored in the same slot.' },
  { field: 'PROPCLASS', sourceType: 'String', maxLength: 150, group: 'assessment', disposition: 'NORMALIZE',
    note: 'Statutory property classes (Wis. Stat. § 70.32), comma-separated: 1 residential, 2 commercial, 3 manufacturing, 4 agricultural, 5 undeveloped, 5M agricultural forest, 6 productive forest, 7 other. A parcel can carry several.' },
  { field: 'AUXCLASS', sourceType: 'String', maxLength: 150, group: 'assessment', disposition: 'NORMALIZE',
    note: 'Auxiliary classes: X1–X4 exempt (federal, state, county, other), W-codes managed-forest programmes, AW/AWO agricultural-woodland. Comma-separated.' },

  // -- tax -----------------------------------------------------------------
  { field: 'NETPRPTA', sourceType: 'Double', group: 'tax', disposition: 'CANONICALIZE',
    note: 'NET property tax, in dollars and cents (92.5%) — after state credits.' },
  { field: 'GRSPRPTA', sourceType: 'Double', group: 'tax', disposition: 'CANONICALIZE',
    note: 'GROSS property tax, before credits (82.1%). Never below net in the data. A different fact from net and kept separately.' },

  // -- area ----------------------------------------------------------------
  { field: 'ASSDACRES', sourceType: 'Double', group: 'geography', disposition: 'CANONICALIZE', note: 'Assessed acres (88.3%).' },
  { field: 'DEEDACRES', sourceType: 'Double', group: 'geography', disposition: 'CANONICALIZE',
    note: 'Deeded acres (90.0%). The canonical area source: the legal description\'s figure, most widely populated.' },
  { field: 'GISACRES', sourceType: 'Double', group: 'geography', disposition: 'CANONICALIZE', note: 'Acres computed from the polygon by the submitter (62.7%).' },

  // -- geometry-derived, not ingested --------------------------------------
  { field: 'Shape_Length', sourceType: 'Double', group: 'geography', disposition: 'IGNORE_WITH_REASON',
    note: 'Perimeter in the layer\'s projection (NAD83(HARN) Wisconsin TM, metres). A rendering artefact of the geometry; no canonical consumer.' },
  { field: 'Shape_Area', sourceType: 'Double', group: 'geography', disposition: 'IGNORE_WITH_REASON',
    note: 'Area in square metres of the projection. GISACRES and DEEDACRES are the county-stated figures and are the ones used.' },
];

/**
 * Columns the source offers that are not ingested, and why.
 *
 * Geometry is retained — in the publisher's archive, byte for byte — and not
 * decoded into canonical rows. See docs/WISCONSIN-STATEWIDE-PARCELS.md §8.
 */
export const WI_NOT_INGESTED: readonly { readonly field: string; readonly reason: string }[] = [
  { field: 'Shape (POLYGON ZM, NAD83(HARN) Wisconsin TM)', reason: 'Parcel boundaries. Retained inside the immutable publisher archive; not decoded, because no canonical geometry model or consumer exists. LATITUDE/LONGITUDE centroids are ingested instead.' },
];

/**
 * Columns the FeatureServer has and the geodatabase does not.
 *
 * The hosted layer adds a standardised site address and its own geometry
 * metrics. Recorded so the ArcGIS cross-check can explain the difference
 * instead of calling it drift.
 */
export const WI_ARCGIS_ONLY_FIELDS: readonly string[] = ['SITEADRESS_STAND', 'Shape__Area', 'Shape__Length'];

/** Concepts other statewide schemas carry and this one does not. */
export const WI_ABSENT_CONCEPTS: readonly string[] = [
  'year_built', 'finished_square_feet', 'dwelling_type', 'number_of_units',
  'sale_date', 'sale_value', 'homestead',
];

const BY_FIELD = new Map(WI_STATEWIDE_FIELD_MAP.map((f) => [f.field, f] as const));

export function wiStatewideField(name: string): FieldSpec | undefined {
  return BY_FIELD.get(name);
}

export function wiStatewideKnownFields(): ReadonlySet<string> {
  return new Set(WI_STATEWIDE_FIELD_MAP.map((f) => f.field));
}

export function wiStatewideDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of WI_STATEWIDE_FIELD_MAP) out[f.disposition] = (out[f.disposition] ?? 0) + 1;
  return out;
}

export const WI_RESTRICTED_FIELDS: readonly string[] = WI_STATEWIDE_FIELD_MAP
  .filter((f) => f.disposition === 'RESTRICTED')
  .map((f) => f.field);
