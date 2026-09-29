/**
 * Wisconsin statewide parcel feature → typed record.
 *
 * Refuses, rather than repairs, three kinds of row — each counted and reported:
 *
 *  - a county the federal catalogue does not know (CONAME "MENOMONIE");
 *  - a PARCELID that is empty (one row in V12);
 *  - a PARCELID that is a feature label with no digit in it (58,201 rows).
 *
 * See `identity.ts` for why each of those is a refusal and not a guess.
 *
 * Values are kept exactly as published: money and acreage as the numbers the
 * geodatabase stores, codes as strings, dates as the text the county wrote.
 * Interpretation happens in `normalize.ts`, through the contract.
 */
import { routeWiCounty, submittingCountyFips, wiParcelIdentity, wiSourceRecordId } from './identity.ts';

export type WiStatewideParcelRecord = {
  // -- identity and routing
  readonly countyFips: string;
  readonly countyName: string;
  readonly parcelId: string;
  readonly normalizedParcel: string;
  /** Punctuation-folded. Candidate matching only; never identity. */
  readonly matchKey: string;
  readonly taxParcelId: string | null;
  readonly stateId: string | null;
  readonly sourceObjectId: number | null;
  /** The submitting county, which differs from `countyFips` for multi-county cities. */
  readonly submittingCountyFips: string | null;
  readonly submittingCountyCode: string | null;
  readonly submittingSource: string | null;
  readonly crossCountySubmission: boolean;

  // -- provenance and time
  readonly taxRollYear: string | null;
  readonly loadDate: string | null;
  readonly parcelDate: string | null;

  // -- ownership (names only; the mailing string goes to the restricted plane)
  readonly ownerName1: string | null;
  readonly ownerName2: string | null;
  readonly mailingAddress: string | null;

  // -- situs
  readonly siteAddress: string | null;
  readonly addressNumberPrefix: string | null;
  readonly addressNumber: string | null;
  readonly addressNumberSuffix: string | null;
  readonly streetPrefix: string | null;
  readonly streetName: string | null;
  readonly streetType: string | null;
  readonly streetSuffix: string | null;
  readonly landmarkName: string | null;
  readonly unitType: string | null;
  readonly unitId: string | null;
  readonly placeName: string | null;
  readonly zip: string | null;
  readonly zip4: string | null;
  readonly state: string | null;
  readonly schoolDistrict: string | null;
  readonly schoolDistrictNumber: string | null;

  // -- assessment and tax, as published
  readonly assessedTotal: number | null;
  readonly assessedLand: number | null;
  readonly assessedImprovements: number | null;
  readonly managedForestValue: number | null;
  readonly estimatedFairMarketValue: number | null;
  readonly netTax: number | null;
  readonly grossTax: number | null;
  readonly propertyClassRaw: string | null;
  readonly propertyClasses: readonly string[];
  readonly auxiliaryClassRaw: string | null;
  readonly auxiliaryClasses: readonly string[];

  // -- area and location
  readonly assessedAcres: number | null;
  readonly deededAcres: number | null;
  readonly gisAcres: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
};

export type ParsedWiParcel = {
  readonly record: WiStatewideParcelRecord;
  readonly sourceRecordId: string;
};

export function parseWiStatewideFeature(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): ParsedWiParcel {
  const countyName = text(attributes, 'CONAME');
  const countyFips = routeWiCounty(countyName, origin);

  const rawParcel = text(attributes, 'PARCELID');
  // wiParcelIdentity refuses empty ids and feature labels with the reason.
  const identity = wiParcelIdentity(countyFips, rawParcel ?? '', `${origin} in ${countyFips}`);

  const submittingCode = text(attributes, 'PARCELFIPS');
  const submitting = submittingCountyFips(submittingCode);

  const record: WiStatewideParcelRecord = {
    countyFips,
    countyName: countyName as string,
    parcelId: identity.rawParcelId,
    normalizedParcel: identity.normalizedParcel,
    matchKey: identity.matchKey,
    taxParcelId: text(attributes, 'TAXPARCELID'),
    stateId: text(attributes, 'STATEID'),
    sourceObjectId: integer(attributes, 'OBJECTID'),
    submittingCountyFips: submitting,
    submittingCountyCode: submittingCode,
    submittingSource: text(attributes, 'PARCELSRC'),
    crossCountySubmission: submitting !== null && submitting !== countyFips,

    taxRollYear: text(attributes, 'TAXROLLYEAR'),
    loadDate: text(attributes, 'LOADDATE'),
    parcelDate: text(attributes, 'PARCELDATE'),

    ownerName1: text(attributes, 'OWNERNME1'),
    ownerName2: text(attributes, 'OWNERNME2'),
    mailingAddress: text(attributes, 'PSTLADRESS'),

    siteAddress: text(attributes, 'SITEADRESS'),
    addressNumberPrefix: text(attributes, 'ADDNUMPREFIX'),
    addressNumber: text(attributes, 'ADDNUM'),
    addressNumberSuffix: text(attributes, 'ADDNUMSUFFIX'),
    streetPrefix: text(attributes, 'PREFIX'),
    streetName: text(attributes, 'STREETNAME'),
    streetType: text(attributes, 'STREETTYPE'),
    streetSuffix: text(attributes, 'SUFFIX'),
    landmarkName: text(attributes, 'LANDMARKNAME'),
    unitType: text(attributes, 'UNITTYPE'),
    unitId: text(attributes, 'UNITID'),
    placeName: text(attributes, 'PLACENAME'),
    zip: text(attributes, 'ZIPCODE'),
    zip4: text(attributes, 'ZIP4'),
    state: text(attributes, 'STATE'),
    schoolDistrict: text(attributes, 'SCHOOLDIST'),
    schoolDistrictNumber: text(attributes, 'SCHOOLDISTNO'),

    assessedTotal: real(attributes, 'CNTASSDVALUE'),
    assessedLand: real(attributes, 'LNDVALUE'),
    assessedImprovements: real(attributes, 'IMPVALUE'),
    managedForestValue: real(attributes, 'MFLVALUE'),
    estimatedFairMarketValue: real(attributes, 'ESTFMKVALUE'),
    netTax: real(attributes, 'NETPRPTA'),
    grossTax: real(attributes, 'GRSPRPTA'),
    propertyClassRaw: text(attributes, 'PROPCLASS'),
    propertyClasses: codeList(text(attributes, 'PROPCLASS')),
    auxiliaryClassRaw: text(attributes, 'AUXCLASS'),
    auxiliaryClasses: codeList(text(attributes, 'AUXCLASS')),

    assessedAcres: real(attributes, 'ASSDACRES'),
    deededAcres: real(attributes, 'DEEDACRES'),
    gisAcres: real(attributes, 'GISACRES'),
    latitude: real(attributes, 'LATITUDE'),
    longitude: real(attributes, 'LONGITUDE'),
  };

  return { record, sourceRecordId: wiSourceRecordId(countyFips, identity.normalizedParcel) };
}

/**
 * A comma-separated class list, as an ordered list of trimmed codes.
 *
 * Order is kept as published; "W8,W6" and "W6,W8" both occur and are not
 * reordered here, because nothing says the order is meaningless.
 */
export function codeList(raw: string | null): readonly string[] {
  if (raw === null) return [];
  return raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c !== '');
}

function text(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function integer(attributes: Readonly<Record<string, unknown>>, key: string): number | null {
  const n = real(attributes, key);
  return n === null ? null : Math.trunc(n);
}

function real(attributes: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = attributes[key];
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}
