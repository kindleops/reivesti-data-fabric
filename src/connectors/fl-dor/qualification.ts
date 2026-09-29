/**
 * Florida DOR sale qualification codes — the official 2026 list, modelled
 * exactly.
 *
 * Source: "2026 User's Guide — Department Property Tax Data Files", NAL field
 * 55 (QUAL_CD1) and SDF field 16 (QUAL_CD): "a code denoting the property
 * appraiser's sales qualification decisions … which the Department often uses
 * to judge a sale's suitability for statistical analysis". The guide states the
 * list applies "to sales occurring in 2026"; it is the list pinned here.
 *
 * ## What a code is, and what it is not
 *
 * A qualification code is the APPRAISER'S DECISION about whether a transfer is
 * suitable for the Department's sales-ratio study. It is evidence about the
 * transfer, stated by a public official, and it is kept verbatim on every
 * observation.
 *
 * It is NOT:
 *
 *  - a comparable. A qualified sale is one the appraiser judged arm's length
 *    for ratio analysis. Whether it is a good comparable for a particular
 *    subject property is a different question, answered by nothing here;
 *  - a deed type. Code 11 names quitclaim, corrective and tax deeds because the
 *    appraiser disqualified on seeing one; the SDF itself carries no
 *    instrument type, and none is inferred from the code;
 *  - a verdict Reivesti reached. Every normalized dimension below is a reading
 *    of the Department's own wording for that code, and where the wording does
 *    not support a dimension, the dimension is absent. There is deliberately no
 *    GIFT and no FORECLOSURE: no code says either. Code 12 says "financial
 *    institution" or "in lieu of foreclosure"; code 38 says "forced or under
 *    duress … to prevent foreclosure". Those are what is recorded.
 *
 * Unknown codes are retained verbatim and classified UNKNOWN — never guessed
 * into the nearest known one. Code 15 is "Removed - not currently accepted;
 * reserved for future use": a row carrying it is flagged, not reinterpreted.
 */

/** The appraiser's decision, as the Department groups the codes. */
export type FlQualificationStatus =
  | 'QUALIFIED'
  | 'DISQUALIFIED'
  | 'PENDING'
  | 'UNKNOWN';

/** Why the decision was made, as the Department groups the codes. */
export type FlQualificationBasis =
  /** 01, 11–21: the deed or other instrument was examined. */
  | 'INSTRUMENT_EXAMINATION'
  /** 02, 30–43: documented evidence. */
  | 'DOCUMENTED_EVIDENCE'
  /** 03–06: an arm's-length transfer with a stated circumstance. */
  | 'QUALIFIED_WITH_CIRCUMSTANCE'
  | 'PENDING'
  | null;

/** The Department's own statement about ratio-study use. */
export type FlRatioStudyUse = 'INCLUDED' | 'EXCLUDED' | 'PENDING' | null;

/**
 * Normalized facts the code's official wording states. Only these; each is
 * named after the words that support it.
 */
export type FlQualificationFact =
  | 'PHYSICAL_CHANGE_AFTER_TRANSFER'        // 03
  | 'LEGAL_CHANGE_AFTER_TRANSFER'           // 04
  | 'MULTI_PARCEL_FULL_PRICE_ON_EACH'       // 05
  | 'CROSSES_COUNTY_LINE'                   // 06
  | 'NOMINAL_OR_NON_MARKET_INSTRUMENT'      // 11
  | 'FINANCIAL_INSTITUTION_OR_DEED_IN_LIEU' // 12
  | 'CEMETERY'                              // 13
  | 'LIFE_ESTATE_RESERVED'                  // 14
  | 'RETIRED_CODE'                          // 15
  | 'PARTIAL_INTEREST'                      // 16
  | 'RELIGIOUS_CHARITABLE_BENEVOLENT_PARTY' // 17
  | 'GOVERNMENT_PARTY'                      // 18
  | 'FIDUCIARY_PARTY'                       // 19
  | 'UTILITY_PARTY'                         // 20
  | 'CONTRACT_FOR_DEED'                     // 21
  | 'RELATED_PARTY'                         // 30
  | 'LAND_EXCHANGE'                         // 31
  | 'ABNORMAL_CONTRACT_PERIOD'              // 32
  | 'INCOMPLETE_COMMON_PROPERTY'            // 33
  | 'PRIOR_CONTRACT_PAYOFF'                 // 34
  | 'ATYPICAL_PERSONAL_PROPERTY'            // 35
  | 'ATYPICAL_COSTS_OF_SALE'                // 36
  | 'ATYPICAL_EXPOSURE_OR_MOTIVATION'       // 37
  | 'DURESS_OR_FORECLOSURE_PREVENTION'      // 38
  | 'CONSIDERATION_DIFFERS_FROM_STAMPS'     // 39
  | 'NON_MARKET_FINANCING_OR_LEASE'         // 40
  | 'OTHER_APPROVED'                        // 41
  | 'MORTGAGE_FRAUD_NOTIFICATION'           // 42
  | 'ALLOCATED_PACKAGE_PRICE'               // 43
  | 'INSTRUMENT_ERRORS'                     // 98
  | 'RECENTLY_DISCOVERED';                  // 99

export type FlQualificationCode = {
  readonly code: string;
  readonly status: FlQualificationStatus;
  readonly basis: FlQualificationBasis;
  readonly ratioStudy: FlRatioStudyUse;
  readonly facts: readonly FlQualificationFact[];
  /** The Department's definition, abridged only where marked. */
  readonly definition: string;
};

const code = (
  c: string,
  status: FlQualificationStatus,
  basis: FlQualificationBasis,
  ratioStudy: FlRatioStudyUse,
  facts: readonly FlQualificationFact[],
  definition: string,
): FlQualificationCode => ({ code: c, status, basis, ratioStudy, facts, definition });

/** Version of the pinned list. A new list is a new version, never an edit. */
export const FL_QUALIFICATION_CODE_LIST_VERSION = 'fl_dor_sale_qualification_codes_2026';

export const FL_QUALIFICATION_CODES: readonly FlQualificationCode[] = [
  // Real property transfers qualified and included in sales ratio analysis
  code('01', 'QUALIFIED', 'INSTRUMENT_EXAMINATION', 'INCLUDED', [],
    'Transfers qualified as arm\'s length because of examination of the deed or other instrument transferring ownership of real property'),
  code('02', 'QUALIFIED', 'DOCUMENTED_EVIDENCE', 'INCLUDED', [],
    'Transfers qualified as arm\'s length because of documented evidence'),
  // Real property transfers qualified but excluded from sales ratio analysis
  code('03', 'QUALIFIED', 'QUALIFIED_WITH_CIRCUMSTANCE', 'EXCLUDED', ['PHYSICAL_CHANGE_AFTER_TRANSFER'],
    'Arm\'s length transaction at time of transfer, but the physical property characteristics changed significantly after the transfer AND prior to the January 1 assessment date, or transfer included property characteristics not substantially complete at the January 1 assessment date (subcodes in the sale change code)'),
  code('04', 'QUALIFIED', 'QUALIFIED_WITH_CIRCUMSTANCE', 'EXCLUDED', ['LEGAL_CHANGE_AFTER_TRANSFER'],
    'Arm\'s length transaction at time of transfer, but the legal characteristics changed significantly after the transfer AND prior to the January 1 assessment date'),
  code('05', 'QUALIFIED', 'QUALIFIED_WITH_CIRCUMSTANCE', 'EXCLUDED', ['MULTI_PARCEL_FULL_PRICE_ON_EACH'],
    'Arm\'s length transaction transferring multiple parcels with multiple parcel identification numbers (deed must be recorded on all parcels included in the transaction, and the full sale price, as calculated from the documentary stamp amount, must be reflected on all parcels)'),
  code('06', 'QUALIFIED', 'QUALIFIED_WITH_CIRCUMSTANCE', 'EXCLUDED', ['CROSSES_COUNTY_LINE'],
    'Arm\'s length transaction transferring a single parcel that crosses one or more county lines'),
  // Disqualified because of examination of the deed or other transfer instrument
  code('11', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['NOMINAL_OR_NON_MARKET_INSTRUMENT'],
    'Corrective Deed, Quit Claim Deed, or Tax Deed; deed bearing Florida documentary stamp at the minimum rate prescribed under chapter 201, F.S.; transfer of ownership in which no documentary stamps were paid'),
  code('12', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['FINANCIAL_INSTITUTION_OR_DEED_IN_LIEU'],
    'Transfer to or from financial institutions (use code 18 for government entities); deed stating "In Lieu of Foreclosure" (including private lenders)'),
  code('13', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['CEMETERY'],
    'Transfer conveying cemetery lots or parcels'),
  code('14', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['LIFE_ESTATE_RESERVED'],
    'Transfer containing a reservation of occupancy for more than 90 days (life estate interest)'),
  code('15', 'UNKNOWN', null, null, ['RETIRED_CODE'],
    'Removed - not currently accepted; reserved for future use'),
  code('16', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['PARTIAL_INTEREST'],
    'Transfer conveying ownership of less than 100% undivided interest'),
  code('17', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['RELIGIOUS_CHARITABLE_BENEVOLENT_PARTY'],
    'Transfer to or from a religious, charitable, or benevolent organization or entity'),
  code('18', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['GOVERNMENT_PARTY'],
    'Transfer to or from a federal, state, or local government agency (including trustees (or board) of the Internal Improvement Trust Fund, courts, counties, municipalities, sheriffs, or educational organizations as well as FDIC, HUD, FANNIE MAE, and FREDDY MAC)'),
  code('19', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['FIDUCIARY_PARTY'],
    'Transfer to or from bankruptcy trustees, administrators, executors, guardians, personal representatives, or receivers'),
  code('20', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['UTILITY_PARTY'],
    'Transfer to or from utility companies'),
  code('21', 'DISQUALIFIED', 'INSTRUMENT_EXAMINATION', 'EXCLUDED', ['CONTRACT_FOR_DEED'],
    'Contract for Deed; Agreement for Deed (does not include Warranty Deed associated with seller financing)'),
  // Disqualified because of documented evidence
  code('30', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['RELATED_PARTY'],
    'Transfer between relatives or between corporate affiliates (including landlord-tenant)'),
  code('31', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['LAND_EXCHANGE'],
    'Transfer involving a trade or exchange of land (does not include 1031 exchanges)'),
  code('32', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['ABNORMAL_CONTRACT_PERIOD'],
    'Transfer involving an abnormal period of time between contract date and sale date (examples: pre-construction sales, pre-development sales)'),
  code('33', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['INCOMPLETE_COMMON_PROPERTY'],
    'Transfer that included incomplete or unbuilt common property'),
  code('34', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['PRIOR_CONTRACT_PAYOFF'],
    'Transfer satisfying payment in full of a prior property contract'),
  code('35', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['ATYPICAL_PERSONAL_PROPERTY'],
    'Transfer involving atypical amounts of personal property'),
  code('36', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['ATYPICAL_COSTS_OF_SALE'],
    'Transfer involving atypical costs of sale'),
  code('37', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['ATYPICAL_EXPOSURE_OR_MOTIVATION'],
    'Transfer in which property\'s market exposure was atypical; transfer involving participants who were atypically motivated; transfer involving participants who were not knowledgeable or informed of market conditions or property characteristics'),
  code('38', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['DURESS_OR_FORECLOSURE_PREVENTION'],
    'Transfer that was forced or under duress; transfer that was to prevent foreclosure (occurs prior to date shown in judgment order for public sale)'),
  code('39', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['CONSIDERATION_DIFFERS_FROM_STAMPS'],
    'Transfer in which the consideration paid for real property is verified to be different than the consideration indicated by documentary stamps'),
  code('40', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['NON_MARKET_FINANCING_OR_LEASE'],
    'Transfer in which the consideration paid for real property is verified to be significantly influenced by non-market financing or assumption of non-market lease'),
  code('41', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['OTHER_APPROVED'],
    'Other, including duplicate recordings and Rehabbed sales; requires approval'),
  code('42', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['MORTGAGE_FRAUD_NOTIFICATION'],
    'Transfer involving mortgage fraud per a law enforcement agency\'s notification of probable cause'),
  code('43', 'DISQUALIFIED', 'DOCUMENTED_EVIDENCE', 'EXCLUDED', ['ALLOCATED_PACKAGE_PRICE'],
    'Transfer where the sale price (as the documentary stamps indicate) is verified to be an allocated price as part of a package or bulk transaction'),
  // Qualification decision pending
  code('98', 'PENDING', 'PENDING', 'PENDING', ['INSTRUMENT_ERRORS'],
    'Unable to process transfer because of transfer instrument errors (examples: incomplete or incorrect legal description, incorrect grantor)'),
  code('99', 'PENDING', 'PENDING', 'PENDING', ['RECENTLY_DISCOVERED'],
    'Transfer was recorded or otherwise discovered in the previous 90 days and qualification decision is pending; invalid for transfers recorded or otherwise discovered more than 90 days earlier'),
];

const BY_CODE: ReadonlyMap<string, FlQualificationCode> = new Map(FL_QUALIFICATION_CODES.map((c) => [c.code, c]));

export type FlQualificationReading = {
  /** Verbatim, trimmed. Null when blank. */
  readonly code: string | null;
  readonly known: boolean;
  readonly status: FlQualificationStatus;
  readonly basis: FlQualificationBasis;
  readonly ratioStudy: FlRatioStudyUse;
  readonly facts: readonly FlQualificationFact[];
  readonly listVersion: string;
};

/**
 * Reads a published code against the pinned list.
 *
 * A one-digit code is NOT left-padded: "1" is not "01" until a publisher says
 * so, and the 2026 files carry two digits on every non-blank row. Anything the
 * list does not contain is UNKNOWN, kept verbatim.
 */
export function readFlQualification(raw: string | null | undefined): FlQualificationReading {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text === '') {
    return { code: null, known: false, status: 'UNKNOWN', basis: null, ratioStudy: null, facts: [], listVersion: FL_QUALIFICATION_CODE_LIST_VERSION };
  }
  const entry = BY_CODE.get(text);
  if (entry === undefined) {
    return { code: text, known: false, status: 'UNKNOWN', basis: null, ratioStudy: null, facts: [], listVersion: FL_QUALIFICATION_CODE_LIST_VERSION };
  }
  return {
    code: text, known: entry.status !== 'UNKNOWN', status: entry.status, basis: entry.basis,
    ratioStudy: entry.ratioStudy, facts: entry.facts, listVersion: FL_QUALIFICATION_CODE_LIST_VERSION,
  };
}

/**
 * The transfer-classification rows a qualification code supports, for the
 * canonical `transfer_classifications` table.
 *
 * Exactly one row is primary: the appraiser's decision. The ratio-study row and
 * the fact rows follow, each with the code as its basis, so any of them can be
 * argued with by reading one field of the publisher's file.
 */
export function flQualificationClassifications(
  reading: FlQualificationReading,
): readonly { readonly classification: string; readonly primary: boolean; readonly basisValue: string }[] {
  const basisValue = reading.code ?? '';
  const primary = reading.status === 'QUALIFIED' ? 'ASSESSOR_QUALIFIED_SALE'
    : reading.status === 'DISQUALIFIED' ? 'ASSESSOR_DISQUALIFIED_SALE'
    : reading.status === 'PENDING' ? 'ASSESSOR_QUALIFICATION_PENDING'
    : 'UNKNOWN_TRANSFER_TYPE';
  const rows: { classification: string; primary: boolean; basisValue: string }[] = [
    { classification: primary, primary: true, basisValue },
  ];
  if (reading.ratioStudy === 'INCLUDED') rows.push({ classification: 'RATIO_STUDY_INCLUDED', primary: false, basisValue });
  if (reading.ratioStudy === 'EXCLUDED') rows.push({ classification: 'RATIO_STUDY_EXCLUDED', primary: false, basisValue });
  for (const fact of reading.facts) {
    const mapped = FACT_CLASSIFICATION[fact];
    if (mapped !== undefined) rows.push({ classification: mapped, primary: false, basisValue });
  }
  return rows;
}

/**
 * The facts that also have a national classification name. Two reuse existing
 * names whose definitions match the code's words exactly; the rest are named
 * after the Department's wording. Facts not listed stay on the observation as
 * the verbatim code and its fact list, with no national classification.
 */
const FACT_CLASSIFICATION: Partial<Record<FlQualificationFact, string>> = {
  RELATED_PARTY: 'RELATIONSHIP_TRANSFER',
  PARTIAL_INTEREST: 'PARTIAL_INTEREST_TRANSFER',
  GOVERNMENT_PARTY: 'GOVERNMENT_PARTY_TRANSFER',
  FINANCIAL_INSTITUTION_OR_DEED_IN_LIEU: 'FINANCIAL_INSTITUTION_OR_DEED_IN_LIEU',
  DURESS_OR_FORECLOSURE_PREVENTION: 'DURESS_OR_FORECLOSURE_PREVENTION',
  LIFE_ESTATE_RESERVED: 'LIFE_ESTATE_RESERVED',
  MULTI_PARCEL_FULL_PRICE_ON_EACH: 'MULTI_PARCEL_TRANSFER',
  NOMINAL_OR_NON_MARKET_INSTRUMENT: 'NOMINAL_OR_NON_MARKET_INSTRUMENT',
};

/** Every classification name this module can emit. The migration's CHECK list must contain all of them. */
export const FL_CLASSIFICATION_NAMES: readonly string[] = [
  'ASSESSOR_QUALIFIED_SALE', 'ASSESSOR_DISQUALIFIED_SALE', 'ASSESSOR_QUALIFICATION_PENDING', 'UNKNOWN_TRANSFER_TYPE',
  'RATIO_STUDY_INCLUDED', 'RATIO_STUDY_EXCLUDED',
  ...new Set(Object.values(FACT_CLASSIFICATION) as string[]),
];

/** V vacant land / I improved property, per the guide: what the PRICE included, not what the parcel was. */
export type FlVacantImproved = 'VACANT_LAND' | 'IMPROVED_PROPERTY' | 'UNKNOWN';

export function readFlVacantImproved(raw: string | null | undefined): FlVacantImproved {
  const text = raw === null || raw === undefined ? '' : String(raw).trim().toUpperCase();
  return text === 'V' ? 'VACANT_LAND' : text === 'I' ? 'IMPROVED_PROPERTY' : 'UNKNOWN';
}

/** Multi-parcel sale code: which recording reference ties the parcels together. */
export type FlMultiParcel = 'CLERK_INSTRUMENT_NUMBER' | 'OR_BOOK_PAGE' | null;

export function readFlMultiParcel(raw: string | null | undefined): FlMultiParcel {
  const text = raw === null || raw === undefined ? '' : String(raw).trim().toUpperCase();
  return text === 'C' ? 'CLERK_INSTRUMENT_NUMBER' : text === 'D' ? 'OR_BOOK_PAGE' : null;
}

/** Sale change code (SDF field 11): a change between the sale and the assessment date. */
export const FL_SALE_CHANGE_CODES: Readonly<Record<string, string>> = {
  '1': 'SPLIT',
  '2': 'COMBINE',
  '3': 'NEW_CONSTRUCTION',
  '4': 'DELETION',
  '5': 'DISASTER',
  '6': 'OTHER',
  '7': 'REMODEL_AND_RENOVATION',
  '8': 'INCOMPLETE_NEW_CONSTRUCTION',
};
