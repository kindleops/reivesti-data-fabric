/**
 * Florida DOR Sale Data File (SDF) — complete field inventory.
 *
 * The 23 columns every 2026 county file carries, in file order, classified
 * against Section 2 of the 2026 User's Guide ("Sales Data Files"). All 67
 * files carry exactly this header (measured 2026-09-29). Where the file spells
 * a column differently from the guide — SAL_CHG_CD for the guide's
 * SAL_CHNG_CD, STATE_PARCEL_ID for STATE_PAR_ID — the file is the authority.
 *
 * The SDF names no party and carries no address: nothing in it is restricted.
 * What it does carry is easy to over-read, and each note below says what a
 * column is NOT as carefully as what it is.
 */
import type { FieldSpec } from '../mn-statewide-parcels/field-map.ts';

const f = (field: string, sourceType: string, maxLength: number | undefined, group: FieldSpec['group'], disposition: FieldSpec['disposition'], note: string): FieldSpec =>
  ({ field, sourceType, ...(maxLength !== undefined ? { maxLength } : {}), group, disposition, note });

export const FL_SDF_FIELD_MAP: readonly FieldSpec[] = [
  f('CO_NO', 'Integer', 2, 'identity', 'CANONICALIZE', 'DOR county number, routed to FIPS through the Department\'s table.'),
  f('PARCEL_ID', 'String', 26, 'identity', 'CANONICALIZE', 'The parcel that sold, as the appraiser numbers it. Links to the property the roll created; never creates one.'),
  f('ASMNT_YR', 'Integer', 4, 'assessment', 'HISTORIZE', 'The assessment year whose submission carried this sale.'),
  f('ATV_STRT', 'Integer', 1, 'assessment', 'KEEP_RAW', 'DOR active stratum of the parcel.'),
  f('GRP_NO', 'Integer', 1, 'assessment', 'KEEP_RAW', 'DOR group number of the parcel.'),
  f('DOR_UC', 'Integer', 3, 'assessment', 'NORMALIZE', 'DOR land use code of the parcel at submission — not necessarily its use when it sold.'),
  f('NBRHD_CD', 'String', 10, 'geography', 'KEEP_RAW', 'Appraiser neighborhood code.'),
  f('MKT_AR', 'String', 3, 'geography', 'KEEP_RAW', 'Appraiser market area code.'),
  f('CENSUS_BK', 'String', 16, 'geography', 'KEEP_RAW', 'Census block group of the parcel centre.'),
  f('SALE_ID_CD', 'String', 25, 'sale', 'CANONICALIZE', 'The appraiser\'s own sale identifier; "remains with the sale for all subsequent SDF submissions". With the parcel, the sale observation\'s identity.'),
  f('SAL_CHG_CD', 'Integer', 1, 'sale', 'NORMALIZE', 'Sale change code (guide: SAL_CHNG_CD): a significant change between the sale and the assessment date — 1 split … 8 incomplete new construction.'),
  f('VI_CD', 'String', 1, 'sale', 'NORMALIZE', 'V vacant land / I improved property: what the PRICE included, not what the parcel was.'),
  f('OR_BOOK', 'String', 6, 'sale', 'CANONICALIZE', 'Official record book. A recording reference, not an instrument.'),
  f('OR_PAGE', 'String', 6, 'sale', 'CANONICALIZE', 'Official record page.'),
  f('CLERK_NO', 'String', 20, 'sale', 'CANONICALIZE', 'Clerk\'s instrument number, where the clerk numbers instruments instead of books and pages.'),
  f('QUAL_CD', 'String', 2, 'sale', 'CANONICALIZE', 'The appraiser\'s qualification decision, verbatim, read against the official 2026 list. Not a comparable, not a deed type.'),
  f('SALE_YR', 'Integer', 4, 'sale', 'CANONICALIZE', 'Sale year. With SALE_MO, a SALE_DATE at MONTH precision; no day exists and none is invented.'),
  f('SALE_MO', 'Integer', 2, 'sale', 'CANONICALIZE', 'Sale month.'),
  f('SALE_PRC', 'Integer', 12, 'sale', 'CANONICALIZE', 'Price "derived from the documentary stamp tax amount": SALE_PRICE_DOC_STAMP_DERIVED, exact money, 0 is a value and blank is absent. For a qualified multi-parcel sale (code 05) the FULL price is on every parcel and is never summed.'),
  f('MULTI_PAR_SAL', 'String', 1, 'sale', 'CANONICALIZE', 'C: parcels of one sale share a clerk instrument number; D: they share a book and page.'),
  f('RS_ID', 'String', 4, 'provenance', 'KEEP_RAW', 'Submission id shared with the county\'s NAL of the same submission.'),
  f('MP_ID', 'String', 8, 'identity', 'KEEP_RAW', 'Master parcel identification code.'),
  f('STATE_PARCEL_ID', 'String', 18, 'identity', 'KEEP_RAW', 'DOR\'s uniform statewide parcel code (guide: STATE_PAR_ID). Kept as evidence; the NAL attaches it to the property.'),
];

export const FL_SDF_LAYOUT_2026: readonly string[] = FL_SDF_FIELD_MAP.map((x) => x.field);

export function flSdfDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const x of FL_SDF_FIELD_MAP) out[x.disposition] = (out[x.disposition] ?? 0) + 1;
  return out;
}
