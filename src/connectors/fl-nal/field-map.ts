/**
 * Florida DOR Name–Address–Legal (NAL) file — complete field inventory.
 *
 * Every column the 2026 county files carry, in file order, classified one by
 * one against the Department's "2026 User's Guide — Department Property Tax
 * Data Files" (fields 1–167). The file header is the authority: where the
 * guide misspells a column ("AV_ WRKNG_WTRFNT", "R_PAGE2"), the file's
 * spelling is used and the guide's is noted.
 *
 * ## Two published layouts, one inventory
 *
 * The statewide audit of 2026-09-29 found the roll in TWO layouts: the 65
 * preliminary files carry 165 columns, and the 2 final files (Citrus, Duval)
 * carry 167 — the same columns in the same order plus EXMPT_47 and EXMPT_48
 * after EXMPT_46, both of which the guide documents. So this inventory is
 * their union (167), both layouts are pinned, and a county file must match one
 * of them exactly; anything else is schema drift and activates nothing.
 *
 * ## What is restricted, and why
 *
 * Public record is not unrestricted product field. Three kinds of column never
 * reach a canonical row:
 *
 * - **Contact-shaped**: the owner's mailing address and state of domicile, and
 *   the fiduciary / care-of block. They go to the restricted contact plane.
 * - **The owner's personal circumstances**: the exemptions that exist only
 *   because of who the owner IS — blind, widowed, disabled, a disabled or
 *   deployed veteran, a low-income senior, a disabled first responder, a
 *   parent in a granny flat — and the homestead applicants' status codes,
 *   which the Department historically defined as wife / husband / other.
 *   Retained in the publisher archive, reported only as aggregates, never
 *   projected.
 * - **The owner's previous home**: the homestead-portability block names the
 *   county and parcel an owner moved from. A residential history, restricted.
 *
 * Property-level exemptions — homestead, government, religious, charitable,
 * historic, affordable housing, conservation — are facts about the PROPERTY
 * and stay canonical.
 */
import type { Disposition, FieldGroup, FieldSpec } from '../mn-statewide-parcels/field-map.ts';

export type { Disposition, FieldGroup, FieldSpec };

const f = (field: string, sourceType: string, maxLength: number | undefined, group: FieldGroup, disposition: Disposition, note: string): FieldSpec =>
  ({ field, sourceType, ...(maxLength !== undefined ? { maxLength } : {}), group, disposition, note });

const money = (field: string, title: string, disposition: Disposition = 'NORMALIZE', group: FieldGroup = 'assessment'): FieldSpec =>
  f(field, 'Integer', 12, group, disposition, `${title}. Whole dollars as published; exact minor units through the contract; blank ≠ 0.`);

/** Exemptions that exist because of who the owner is. Restricted. */
const PERSONAL_EXEMPTIONS: Readonly<Record<string, string>> = {
  EXMPT_03: 'county additional exemption for low-income seniors 65+ (s. 196.075)',
  EXMPT_04: 'municipal additional exemption for low-income seniors 65+ (s. 196.075)',
  EXMPT_05: 'permanently and totally disabled veterans and surviving spouses (ss. 196.081, 196.102)',
  EXMPT_06: 'disabled veterans confined to wheelchairs and surviving spouses (s. 196.091)',
  EXMPT_08: 'totally and permanently disabled persons (s. 196.101)',
  EXMPT_31: 'blind persons (s. 196.202)',
  EXMPT_32: 'widowers (s. 196.202)',
  EXMPT_33: 'widows (s. 196.202)',
  EXMPT_34: 'totally and permanently disabled persons (s. 196.202)',
  EXMPT_35: 'disabled ex-service members (s. 196.24)',
  EXMPT_38: 'homestead of deployed military personnel (s. 196.173)',
  EXMPT_39: 'county exemption for long-resident low-income seniors 65+ (s. 196.075)',
  EXMPT_40: 'municipal exemption for long-resident low-income seniors 65+ (s. 196.075)',
  EXMPT_41: 'first responders disabled in the line of duty, and surviving spouses (ss. 196.081(6), 196.102)',
  EXMPT_80: 'disabled veterans homestead discount, veterans 65+ (s. 196.082)',
  EXMPT_81: 'living quarters of parents or grandparents (s. 193.703)',
};

/** Exemptions that describe the property's use or ownership class. Canonical. */
const PROPERTY_EXEMPTIONS: Readonly<Record<string, string>> = {
  EXMPT_01: 'homestead exemption, first $25,000 (s. 196.031(1)(a))',
  EXMPT_02: 'additional homestead exemption up to $26,411, non-school levies (s. 196.031(1)(b))',
  EXMPT_07: 'licensed child care facility in an enterprise zone (s. 196.095)',
  EXMPT_09: 'charitable, religious, scientific or literary use (s. 196.196)',
  EXMPT_10: 'county historic property, commercial or nonprofit use (s. 196.1961)',
  EXMPT_11: 'municipal historic property, commercial or nonprofit use (s. 196.1961)',
  EXMPT_12: 'hospitals, nursing homes and homes for special services (s. 196.197)',
  EXMPT_13: 'nonprofit homes for the aged (s. 196.1975)',
  EXMPT_14: 'proprietary continuing care facilities (s. 196.1977)',
  EXMPT_15: 'affordable housing property (ss. 196.1978, 196.196)',
  EXMPT_16: 'educational property (s. 196.198)',
  EXMPT_17: 'charter school property (s. 196.1983)',
  EXMPT_18: 'labor organization property (s. 196.1985)',
  EXMPT_19: 'community center property (s. 196.1986)',
  EXMPT_20: 'government property (s. 196.199)',
  EXMPT_21: 'property under agreements with local governments for public use (s. 196.1993)',
  EXMPT_22: 'county economic development exemption (s. 196.1995)',
  EXMPT_23: 'municipal economic development exemption (s. 196.1995)',
  EXMPT_24: 'county historic property improvements (s. 196.1997)',
  EXMPT_25: 'municipal historic property improvements (s. 196.1997)',
  EXMPT_26: 'county historic properties open to the public (s. 196.1998)',
  EXMPT_27: 'municipal historic properties open to the public (s. 196.1998)',
  EXMPT_29: 'not-for-profit sewer and water company property (s. 196.2001)',
  EXMPT_30: 's. 501(c)(12) not-for-profit water and wastewater systems (s. 196.2002)',
  EXMPT_36: 'land dedicated in perpetuity for conservation, used exclusively so (s. 196.26(2))',
  EXMPT_37: 'conservation land also used commercially (s. 196.26(3))',
  EXMPT_42: 'biblical history display property (s. 196.1987)',
  EXMPT_43: 'FHFC-certified new multi-family under a land use restriction agreement (s. 196.1978(3),(4))',
  EXMPT_44: 'land leased by a nonprofit for affordable housing (s. 196.1978(1)(b))',
  EXMPT_45: 'county affordable housing program (s. 196.1979)',
  EXMPT_46: 'municipal affordable housing program (s. 196.1979)',
  EXMPT_47: 'affordable housing property owned by the state (s. 196.19781) — only in FINAL-stage files in 2026',
  EXMPT_48: 'affordable housing property on governmental property (s. 196.19782) — only in FINAL-stage files in 2026',
  EXMPT_82: 'lands available for taxes (s. 197.502)',
};

export const FL_NAL_PERSONAL_EXEMPTIONS: readonly string[] = Object.keys(PERSONAL_EXEMPTIONS);
export const FL_NAL_PROPERTY_EXEMPTIONS: readonly string[] = Object.keys(PROPERTY_EXEMPTIONS);

const exemption = (field: string): FieldSpec => {
  if (field === 'EXMPT_28') {
    return f(field, 'Integer', 12, 'tax', 'IGNORE_WITH_REASON', 'Exemption 28 — "No longer in use" per the 2026 guide. A non-blank value is counted as drift.');
  }
  const personal = PERSONAL_EXEMPTIONS[field];
  if (personal !== undefined) {
    return f(field, 'Integer', 12, 'tax', 'RESTRICTED',
      `Exemption value: ${personal}. Exists because of the owner's personal circumstances; retained in the publisher archive, aggregated only, never projected.`);
  }
  const property = PROPERTY_EXEMPTIONS[field];
  if (property === undefined) throw new Error(`${field}: exemption not classified`);
  return f(field, 'Integer', 12, 'tax', 'NORMALIZE', `Exemption value: ${property}. A property-level tax fact; exact money.`);
};

export const FL_NAL_FIELD_MAP: readonly FieldSpec[] = [
  // -- fields 1–4: parcel identification ----------------------------------------
  f('CO_NO', 'Integer', 2, 'identity', 'CANONICALIZE',
    'DOR county number 11–77. THE routing key, through the Department\'s own table to FIPS; never the filename\'s number (Seminole\'s 2026 file is labelled 58).'),
  f('PARCEL_ID', 'String', 26, 'identity', 'CANONICALIZE',
    'The property appraiser\'s parcel identification code, uniform within a county and varying between them. With the county, canonical property identity — under the scheme the statewide collision audit chose.'),
  f('FILE_T', 'String', 1, 'provenance', 'KEEP_RAW', 'Roll type; "R" (real property) on every row. Checked, kept.'),
  f('ASMNT_YR', 'Integer', 4, 'assessment', 'HISTORIZE', 'Assessment year: the roll values are as of January 1 of this year. The time axis every value on the row belongs to.'),
  // -- fields 5–7: stratification ------------------------------------------------
  f('BAS_STRT', 'Integer', 2, 'assessment', 'KEEP_RAW', 'DOR basic stratum (s. 195.096(3)(a), F.S.), assigned by the Department for its statistical review. A Department code, not an appraiser fact.'),
  f('ATV_STRT', 'Integer', 1, 'assessment', 'KEEP_RAW', 'DOR active stratum; blank for strata 09–13.'),
  f('GRP_NO', 'Integer', 1, 'assessment', 'KEEP_RAW', 'DOR group number within the active stratum, by just value.'),
  // -- fields 8–10: use ----------------------------------------------------------
  f('DOR_UC', 'Integer', 3, 'assessment', 'NORMALIZE', 'DOR land use code 000–099, from the Department\'s published table. Unknown codes are retained and flagged, never guessed.'),
  f('PA_UC', 'Integer', 2, 'assessment', 'KEEP_RAW', 'The property appraiser\'s own use code. County-defined; not comparable across counties.'),
  f('SPASS_CD', 'Integer', 1, 'assessment', 'KEEP_RAW', 'Special assessment code: 1 pollution control, 2 conservation easement / recreational land, 3 building moratorium.'),
  // -- fields 11–17: parcel values ---------------------------------------------
  money('JV', 'Just value: the appraiser\'s opinion of market value as of January 1', 'HISTORIZE'),
  money('JV_CHNG', 'Just value change'),
  f('JV_CHNG_CD', 'Integer', 2, 'assessment', 'KEEP_RAW', 'Reason code for the just value change (01 VAB change, 02 court, 03 revised after a VAB petition, …).'),
  money('AV_SD', 'Assessed value, school district levies', 'HISTORIZE'),
  money('AV_NSD', 'Assessed value, non-school levies', 'HISTORIZE'),
  money('TV_SD', 'Taxable value, school district levies', 'HISTORIZE', 'tax'),
  money('TV_NSD', 'Taxable value, non-school levies', 'HISTORIZE', 'tax'),
  // -- fields 18–35: classified use ---------------------------------------------
  money('JV_HMSTD', 'Just value, homestead property'),
  money('AV_HMSTD', 'Assessed value, homestead property'),
  money('JV_NON_HMSTD_RESD', 'Just value, non-homestead residential property'),
  money('AV_NON_HMSTD_RESD', 'Assessed value, non-homestead residential property'),
  money('JV_RESD_NON_RESD', 'Just value, residential and non-residential property'),
  money('AV_RESD_NON_RESD', 'Assessed value, residential and non-residential property'),
  money('JV_CLASS_USE', 'Just value, classified use (agricultural land)'),
  money('AV_CLASS_USE', 'Assessed value, classified use (agricultural land)'),
  money('JV_H2O_RECHRGE', 'Just value, high-water recharge land'),
  money('AV_H2O_RECHRGE', 'Assessed value, high-water recharge land'),
  money('JV_CONSRV_LND', 'Just value, conservation land'),
  money('AV_CONSRV_LND', 'Assessed value, conservation land'),
  money('JV_HIST_COM_PROP', 'Just value, historic commercial property'),
  money('AV_HIST_COM_PROP', 'Assessed value, historic commercial property'),
  money('JV_HIST_SIGNF', 'Just value, historically significant property'),
  money('AV_HIST_SIGNF', 'Assessed value, historically significant property'),
  money('JV_WRKNG_WTRFNT', 'Just value, working waterfront property'),
  money('AV_WRKNG_WTRFNT', 'Assessed value, working waterfront property (the guide misspells it "AV_ WRKNG_WTRFNT")'),
  // -- fields 36–40: parcel change ----------------------------------------------
  money('NCONST_VAL', 'New construction value'),
  money('DEL_VAL', 'Deletion value'),
  f('PAR_SPLT', 'Integer', 5, 'assessment', 'KEEP_RAW', 'Split/combine flag: first digit 1 split, 2 combine; then MMYY of the event. Kept verbatim; a two-digit year is not expanded here.'),
  f('DISTR_CD', 'Integer', undefined, 'assessment', 'KEEP_RAW', 'Disaster code (1 toxic drywall … 8 sink hole, 9 other), from the guide\'s table.'),
  f('DISTR_YR', 'Integer', 4, 'assessment', 'KEEP_RAW', 'Year of the disaster the code refers to.'),
  // -- fields 41–53: land and improvements --------------------------------------
  money('LND_VAL', 'Land value'),
  f('LND_UNTS_CD', 'Integer', 1, 'assessment', 'NORMALIZE', 'Unit of the land assessment: 1 acre, 2 square foot, 3/4 front foot, 5 lot, 6 combination. Gives NO_LND_UNTS its meaning.'),
  f('NO_LND_UNTS', 'Integer', 12, 'assessment', 'NORMALIZE', 'Number of land units, IN THE UNIT LND_UNTS_CD names. Acres only when that code is 1; never read as acres otherwise.'),
  f('LND_SQFOOT', 'Integer', 12, 'geography', 'NORMALIZE', 'Land square footage. The canonical parcel area, in square feet, through the contract.'),
  f('DT_LAST_INSPT', 'Integer', 4, 'structure', 'KEEP_RAW', 'Month and year of the last physical inspection as MMYY ("0315" = March 2015); "0000" = unknown. A two-digit year: kept verbatim, not expanded by guesswork.'),
  f('IMP_QUAL', 'Integer', 1, 'structure', 'KEEP_RAW', 'Improvement quality code (appraiser-assigned).'),
  f('CONST_CLASS', 'Integer', 1, 'structure', 'KEEP_RAW', 'Construction class code.'),
  f('EFF_YR_BLT', 'Integer', 4, 'structure', 'NORMALIZE', 'Effective year built.'),
  f('ACT_YR_BLT', 'Integer', 4, 'structure', 'NORMALIZE', 'Actual year built.'),
  f('TOT_LVG_AREA', 'Integer', 12, 'structure', 'NORMALIZE', 'Total living or usable area, square feet.'),
  f('NO_BULDNG', 'Integer', 4, 'structure', 'NORMALIZE', 'Number of buildings.'),
  f('NO_RES_UNTS', 'Integer', 4, 'structure', 'NORMALIZE', 'Number of residential units.'),
  money('SPEC_FEAT_VAL', 'Special feature value'),
  // -- fields 54–73: the appraiser's sale echo (two most recent) ------------------
  ...(['1', '2'] as const).flatMap((n) => [
    f(`MULTI_PAR_SAL${n}`, 'String', 1, 'sale', 'CANONICALIZE', `Sale ${n}: multi-parcel indicator — C matching clerk instrument number, D matching book and page.`),
    f(`QUAL_CD${n}`, 'String', 2, 'sale', 'CANONICALIZE', `Sale ${n}: DOR transfer qualification code, verbatim, classified through the official 2026 code list.`),
    f(`VI_CD${n}`, 'String', 1, 'sale', 'CANONICALIZE', `Sale ${n}: V vacant land / I improved — what the price bought, not what the parcel was.`),
    f(`SALE_PRC${n}`, 'Integer', 12, 'sale', 'CANONICALIZE', `Sale ${n}: price derived from documentary stamp tax. Exact money; 0 is a real value, blank is absent.`),
    f(`SALE_YR${n}`, 'Integer', 4, 'sale', 'CANONICALIZE', `Sale ${n}: sale year. With SALE_MO${n}, a SALE_DATE at MONTH precision — no day is invented.`),
    f(`SALE_MO${n}`, 'Integer', 2, 'sale', 'CANONICALIZE', `Sale ${n}: sale month.`),
    f(`OR_BOOK${n}`, 'String', 6, 'sale', 'CANONICALIZE', `Sale ${n}: official record book. A recording reference, not an instrument.`),
    f(`OR_PAGE${n}`, 'String', 6, 'sale', 'CANONICALIZE', `Sale ${n}: official record page${n === '2' ? ' (the guide misspells it "R_PAGE2")' : ''}.`),
    f(`CLERK_NO${n}`, 'String', 20, 'sale', 'CANONICALIZE', `Sale ${n}: clerk\'s instrument number, where the clerk uses instrument numbering instead of book/page.`),
    f(`SAL_CHNG_CD${n}`, 'Integer', 1, 'sale', 'KEEP_RAW', `Sale ${n}: significant change between sale and assessment date (1 split … 8 incomplete new construction).`),
  ]),
  // -- fields 74–90: owner and fiduciary --------------------------------------------
  f('OWN_NAME', 'String', 50, 'ownership', 'CANONICALIZE', 'Owner of record on the current roll — a party observation, name only, never merged across parcels by name. Current ownership, not a chain of title.'),
  f('OWN_ADDR1', 'String', 40, 'ownership', 'RESTRICTED', 'Owner mailing address line 1. Restricted contact plane only.'),
  f('OWN_ADDR2', 'String', 40, 'ownership', 'RESTRICTED', 'Owner mailing address line 2. Restricted contact plane only.'),
  f('OWN_CITY', 'String', 40, 'ownership', 'RESTRICTED', 'Owner mailing city. Restricted contact plane only.'),
  f('OWN_STATE', 'String', 25, 'ownership', 'RESTRICTED', 'Owner mailing state (or country). Restricted contact plane only.'),
  f('OWN_ZIPCD', 'Integer', 5, 'ownership', 'RESTRICTED', 'Owner mailing ZIP code. Restricted contact plane only.'),
  f('OWN_STATE_DOM', 'String', 2, 'ownership', 'RESTRICTED', 'Owner\'s state of domicile ("FC" = foreign country). Where a person lives; restricted.'),
  f('FIDU_NAME', 'String', 30, 'ownership', 'RESTRICTED', 'Fiduciary (care-of) name. Not required since 2012 and blank by rule; restricted when present.'),
  f('FIDU_ADDR1', 'String', 40, 'ownership', 'RESTRICTED', 'Fiduciary mailing address line 1. Restricted.'),
  f('FIDU_ADDR2', 'String', 40, 'ownership', 'RESTRICTED', 'Fiduciary mailing address line 2. Restricted.'),
  f('FIDU_CITY', 'String', 40, 'ownership', 'RESTRICTED', 'Fiduciary mailing city. Restricted.'),
  f('FIDU_STATE', 'String', 25, 'ownership', 'RESTRICTED', 'Fiduciary mailing state. Restricted.'),
  f('FIDU_ZIPCD', 'Integer', 5, 'ownership', 'RESTRICTED', 'Fiduciary mailing ZIP. Restricted.'),
  f('FIDU_CD', 'Integer', 1, 'ownership', 'KEEP_RAW', 'Fiduciary type code; "should be blank" per the guide.'),
  f('S_LEGAL', 'String', 30, 'legal', 'KEEP_RAW', 'Short legal description, 30 characters, "abbreviated, truncated, or incomplete" by the guide\'s own warning. Evidence, not a legal description of record.'),
  f('APP_STAT', 'String', 1, 'ownership', 'RESTRICTED', 'Homestead applicant\'s status code. Describes the applicant, not the property; restricted.'),
  f('CO_APP_STAT', 'String', 1, 'ownership', 'RESTRICTED', 'Homestead co-applicant\'s status — historically W wife / H husband / O other. Relationship status; restricted.'),
  // -- fields 91–102: location ----------------------------------------------------------
  f('MKT_AR', 'String', 3, 'geography', 'KEEP_RAW', 'Appraiser-assigned market area code.'),
  f('NBRHD_CD', 'String', 10, 'geography', 'KEEP_RAW', 'Appraiser-assigned neighborhood code.'),
  f('PUBLIC_LND', 'String', 1, 'ownership', 'NORMALIZE', 'Public land owner class: F federal, S state, C county/school district, M municipal, D special district, W water management, … An owner-class fact on the roll.'),
  f('TAX_AUTH_CD', 'String', 5, 'tax', 'NORMALIZE', 'Taxing authority code — the millage district the parcel is taxed in. Resolved through DOR\'s annual taxing-authority tables in a later phase.'),
  f('TWN', 'String', 3, 'legal', 'KEEP_RAW', 'Township (PLSS).'),
  f('RNG', 'String', 3, 'legal', 'KEEP_RAW', 'Range (PLSS).'),
  f('SEC', 'String', 3, 'legal', 'KEEP_RAW', 'Section or grant number (PLSS).'),
  f('CENSUS_BK', 'String', 16, 'geography', 'NORMALIZE', 'Census block group (state + county + tract + block group FIPS) of the parcel centre.'),
  f('PHY_ADDR1', 'String', 40, 'address', 'CANONICALIZE', 'Situs address line 1. A property identifier observation that never resolves identity on its own.'),
  f('PHY_ADDR2', 'String', 40, 'address', 'NORMALIZE', 'Situs address line 2.'),
  f('PHY_CITY', 'String', 40, 'address', 'NORMALIZE', 'Situs city — postal, not the taxing jurisdiction, and never a county router.'),
  f('PHY_ZIPCD', 'Integer', 5, 'address', 'NORMALIZE', 'Situs ZIP code.'),
  f('ALT_KEY', 'String', 26, 'identity', 'KEEP_RAW', 'Optional alternate key some counties keep beside the parcel id. Evidence, never identity.'),
  // -- fields 104–109: homestead portability ------------------------------------------
  f('ASS_TRNSFR_FG', 'Integer', 1, 'tax', 'RESTRICTED', 'Assessment-differential transfer flag: the owner ported a Save-Our-Homes benefit from a previous homestead. Part of the owner\'s residential history; restricted.'),
  f('PREV_HMSTD_OWN', 'Integer', 2, 'tax', 'RESTRICTED', 'Number of owners of the previous homestead. Restricted.'),
  f('ASS_DIF_TRNS', 'Integer', 12, 'tax', 'RESTRICTED', 'Assessment differential transferred. Restricted.'),
  f('CONO_PRV_HM', 'Integer', 2, 'tax', 'RESTRICTED', 'County of the owner\'s previous homestead. Restricted: where a person used to live.'),
  f('PARCEL_ID_PRV_HMSTD', 'String', 26, 'tax', 'RESTRICTED', 'Parcel of the owner\'s previous homestead. Restricted: it links a person to their former home.'),
  f('YR_VAL_TRNSF', 'Integer', 4, 'tax', 'RESTRICTED', 'Year the value was transferred. Restricted.'),
  // -- fields 110–160: exemptions --------------------------------------------------------
  ...[
    ...Array.from({ length: 48 }, (_, i) => `EXMPT_${String(i + 1).padStart(2, '0')}`),
    'EXMPT_80', 'EXMPT_81', 'EXMPT_82',
  ].map(exemption),
  // -- fields 161–167: data management -------------------------------------------------
  f('SEQ_NO', 'Integer', 7, 'provenance', 'IGNORE_WITH_REASON', 'File sequence number: the row\'s position in the submission. Renumbered by every file, so it is excluded from change detection and never identity.'),
  f('RS_ID', 'String', 4, 'provenance', 'KEEP_RAW', 'Real property submission id, shared by a county\'s NAL and SDF of one submission. Provenance: which submission the row came in.'),
  f('MP_ID', 'String', 8, 'identity', 'KEEP_RAW', 'Master parcel identification code, unique within the county\'s real property file.'),
  f('STATE_PAR_ID', 'String', 18, 'identity', 'CANONICALIZE', 'DOR\'s uniform statewide parcel code, generated by the Department and "cross-referenced longitudinally when a county\'s coding system changes". A secondary identifier observation — never identity.'),
  f('SPC_CIR_CD', 'Integer', 1, 'provenance', 'KEEP_RAW', 'Department special-circumstances code for database management.'),
  f('SPC_CIR_YR', 'Integer', 4, 'provenance', 'KEEP_RAW', 'Year of the special circumstance.'),
  f('SPC_CIR_TXT', 'String', 50, 'provenance', 'KEEP_RAW', 'Department description of the special circumstance.'),
];

const BY_FIELD = new Map(FL_NAL_FIELD_MAP.map((x) => [x.field, x] as const));

export function flNalField(name: string): FieldSpec | undefined {
  return BY_FIELD.get(name);
}

export function flNalKnownFields(): ReadonlySet<string> {
  return new Set(FL_NAL_FIELD_MAP.map((x) => x.field));
}

export function flNalDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const x of FL_NAL_FIELD_MAP) out[x.disposition] = (out[x.disposition] ?? 0) + 1;
  return out;
}

export const FL_NAL_RESTRICTED_FIELDS: readonly string[] = FL_NAL_FIELD_MAP
  .filter((x) => x.disposition === 'RESTRICTED')
  .map((x) => x.field);

/** Columns only the FINAL-stage layout carries (2026). */
export const FL_NAL_FINAL_ONLY_FIELDS: readonly string[] = ['EXMPT_47', 'EXMPT_48'];

/** The two layouts DOR published for the 2026 roll, measured on the files themselves. */
export const FL_NAL_LAYOUTS: Readonly<Record<'fl_nal_2026_preliminary' | 'fl_nal_2026_final', readonly string[]>> = {
  fl_nal_2026_preliminary: FL_NAL_FIELD_MAP.map((x) => x.field).filter((name) => !FL_NAL_FINAL_ONLY_FIELDS.includes(name)),
  fl_nal_2026_final: FL_NAL_FIELD_MAP.map((x) => x.field),
};
