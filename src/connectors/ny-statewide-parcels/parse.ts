/**
 * NYS Tax Parcel Centroid Points feature → typed record.
 *
 * Refuses, rather than repairs, four kinds of row — each counted and reported:
 *
 *  - a COUNTY_NAME the federal catalogue does not know;
 *  - a SWIS that is malformed or names a different county than COUNTY_NAME;
 *  - an absent SBL (6,606 rows in the 2025 roll: no assessment-roll record);
 *  - an SBL that is a feature label with no digit (19 rows).
 *
 * See `identity.ts` for why each is a refusal and not a guess.
 *
 * Values are kept exactly as published: money, areas and counts as the numbers
 * the geodatabase stores, codes as strings, years as integers. Interpretation
 * happens in `normalize.ts`, through the contract.
 */
import { NYC_BOROUGH_FIPS } from './counties.ts';
import { nyParcelIdentity, nySourceRecordId, nyTaxMapKey, routeNyCounty } from './identity.ts';

/** Where a row's attributes came from. Two lineages share one schema. */
export type NyLineage =
  /** County GIS polygons + ORPTS assessment-roll attributes. */
  | 'orpts_assessment_roll'
  /** New York City: NYC MapPLUTO, standardized by the state. */
  | 'nyc_mappluto';

export type NyStatewideParcelRecord = {
  // -- identity and routing
  readonly countyFips: string;
  /** As the layer spells it (`NewYork`, `StLawrence`). */
  readonly countyName: string;
  readonly swis: string;
  readonly sbl: string;
  readonly normalizedSbl: string;
  readonly normalizedParcel: string;
  /** Punctuation-folded. Candidate matching only; never identity. */
  readonly matchKey: string;
  /** CITYTOWN_SWIS + SBL. Candidate link between village and town roll records; never identity. */
  readonly taxMapKey: string | null;
  readonly printKey: string | null;
  readonly muniParcelId: string | null;
  readonly publishedSwisSblId: string | null;
  readonly publishedSwisPrintKeyId: string | null;
  /** True when the publisher's composite SWIS_SBL_ID differs from SWIS + SBL. */
  readonly swisSblIdMismatch: boolean;
  readonly swisPrintKeyIdMismatch: boolean;
  readonly sourceObjectId: number | null;
  readonly sourceOrigFid: number | null;
  readonly lineage: NyLineage;

  // -- municipality
  readonly municipalityName: string | null;
  readonly cityTownName: string | null;
  readonly cityTownSwis: string | null;

  // -- time
  readonly rollYear: number | null;
  readonly spatialYear: number | null;

  // -- ownership (names only on canonical rows; mailing goes to the restricted plane)
  readonly primaryOwner: string | null;
  readonly additionalOwner: string | null;
  readonly ownerTypeCode: string | null;
  readonly stateAgencyName: string | null;
  readonly stateAgencyNameSource: string | null;
  readonly primaryMailing: NyMailing;
  readonly additionalMailing: NyMailing;

  // -- situs
  readonly parcelAddress: string | null;
  readonly streetNumber: string | null;
  readonly street: string | null;
  readonly unit: string | null;
  readonly zip: string | null;

  // -- assessment, as published
  readonly propertyClass: string | null;
  readonly rollSection: string | null;
  readonly landAssessedValue: number | null;
  readonly totalAssessedValue: number | null;
  readonly fullMarketValue: number | null;
  readonly schoolCode: string | null;
  readonly schoolName: string | null;

  // -- structure
  readonly yearBuiltRaw: number | null;
  readonly livingAreaSqFt: number | null;
  readonly grossFloorArea: number | null;
  readonly kitchens: number | null;
  readonly fullBaths: number | null;
  readonly bedrooms: number | null;
  readonly buildingStyleCode: string | null;
  readonly buildingStyleDescription: string | null;
  readonly heatTypeCode: string | null;
  readonly heatTypeDescription: string | null;
  readonly fuelTypeCode: string | null;
  readonly fuelTypeDescription: string | null;
  readonly sewerTypeCode: string | null;
  readonly sewerTypeDescription: string | null;
  readonly waterSupplyCode: string | null;
  readonly waterSupplyDescription: string | null;
  readonly utilitiesCode: string | null;
  readonly utilitiesDescription: string | null;
  readonly usedAsCode: string | null;
  readonly usedAsDescription: string | null;

  // -- area and location
  readonly frontFeet: number | null;
  readonly depthFeet: number | null;
  readonly assessedSquareFeet: number | null;
  readonly assessedAcres: number | null;
  readonly gisAcres: number | null;
  readonly gridEast: number | null;
  readonly gridNorth: number | null;
  readonly agriculturalDistrictCode: string | null;
  readonly agriculturalDistrictName: string | null;
  readonly duplicateGeometry: boolean;

  // -- the roll's last-deed reference: never a transfer
  readonly deedBook: number | null;
  readonly deedPage: number | null;
};

/** A mailing address in its published parts. Restricted plane only. */
export type NyMailing = {
  readonly street: string | null;
  readonly poBox: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
};

export type ParsedNyParcel = {
  readonly record: NyStatewideParcelRecord;
  readonly sourceRecordId: string;
};

export function parseNyStatewideFeature(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): ParsedNyParcel {
  const countyName = text(attributes, 'COUNTY_NAME');
  const swis = text(attributes, 'SWIS');
  const countyFips = routeNyCounty(countyName, swis, origin);
  const sblText = text(attributes, 'SBL');
  // nyParcelIdentity refuses an absent SBL and a digit-less label, with the reason.
  const identity = nyParcelIdentity(countyFips, swis as string, sblText ?? '', `${origin} in ${countyFips}`);
  const cityTownSwis = text(attributes, 'CITYTOWN_SWIS');
  const printKey = text(attributes, 'PRINT_KEY');
  const publishedSwisSblId = text(attributes, 'SWIS_SBL_ID');
  const publishedSwisPrintKeyId = text(attributes, 'SWIS_PRINT_KEY_ID');

  const record: NyStatewideParcelRecord = {
    countyFips,
    countyName: countyName as string,
    swis: identity.swis,
    sbl: identity.rawSbl,
    normalizedSbl: identity.normalizedSbl,
    normalizedParcel: identity.normalizedParcel,
    matchKey: identity.matchKey,
    taxMapKey: nyTaxMapKey(cityTownSwis, identity.normalizedSbl),
    printKey,
    muniParcelId: text(attributes, 'MUNI_PARCEL_ID'),
    publishedSwisSblId,
    publishedSwisPrintKeyId,
    swisSblIdMismatch: publishedSwisSblId !== null && publishedSwisSblId !== `${identity.swis}${identity.rawSbl}`,
    swisPrintKeyIdMismatch: publishedSwisPrintKeyId !== null && printKey !== null
      && publishedSwisPrintKeyId !== `${identity.swis}${printKey}`,
    sourceObjectId: integer(attributes, 'OBJECTID'),
    sourceOrigFid: integer(attributes, 'ORIG_FID'),
    lineage: NYC_BOROUGH_FIPS.has(countyFips) ? 'nyc_mappluto' : 'orpts_assessment_roll',

    municipalityName: text(attributes, 'MUNI_NAME'),
    cityTownName: text(attributes, 'CITYTOWN_NAME'),
    cityTownSwis,

    rollYear: integer(attributes, 'ROLL_YR'),
    spatialYear: integer(attributes, 'SPATIAL_YR'),

    primaryOwner: text(attributes, 'PRIMARY_OWNER'),
    additionalOwner: text(attributes, 'ADD_OWNER'),
    ownerTypeCode: text(attributes, 'OWNER_TYPE'),
    stateAgencyName: text(attributes, 'NYS_NAME'),
    stateAgencyNameSource: text(attributes, 'NYS_NAME_SOURCE'),
    primaryMailing: {
      street: text(attributes, 'MAIL_ADDR'),
      poBox: text(attributes, 'PO_BOX'),
      city: text(attributes, 'MAIL_CITY'),
      state: text(attributes, 'MAIL_STATE'),
      zip: text(attributes, 'MAIL_ZIP'),
    },
    additionalMailing: {
      street: text(attributes, 'ADD_MAIL_ADDR'),
      poBox: text(attributes, 'ADD_MAIL_PO_BOX'),
      city: text(attributes, 'ADD_MAIL_CITY'),
      state: text(attributes, 'ADD_MAIL_STATE'),
      zip: text(attributes, 'ADD_MAIL_ZIP'),
    },

    parcelAddress: text(attributes, 'PARCEL_ADDR'),
    streetNumber: text(attributes, 'LOC_ST_NBR'),
    street: text(attributes, 'LOC_STREET'),
    unit: text(attributes, 'LOC_UNIT'),
    zip: text(attributes, 'LOC_ZIP'),

    propertyClass: text(attributes, 'PROP_CLASS'),
    rollSection: text(attributes, 'ROLL_SECTION'),
    landAssessedValue: real(attributes, 'LAND_AV'),
    totalAssessedValue: real(attributes, 'TOTAL_AV'),
    fullMarketValue: real(attributes, 'FULL_MARKET_VAL'),
    schoolCode: text(attributes, 'SCHOOL_CODE'),
    schoolName: text(attributes, 'SCHOOL_NAME'),

    yearBuiltRaw: integer(attributes, 'YR_BLT'),
    livingAreaSqFt: real(attributes, 'SQFT_LIVING'),
    grossFloorArea: integer(attributes, 'GFA'),
    kitchens: integer(attributes, 'NBR_KITCHENS'),
    fullBaths: integer(attributes, 'NBR_FULL_BATHS'),
    bedrooms: integer(attributes, 'NBR_BEDROOMS'),
    buildingStyleCode: text(attributes, 'BLDG_STYLE'),
    buildingStyleDescription: text(attributes, 'BLDG_STYLE_DESC'),
    heatTypeCode: text(attributes, 'HEAT_TYPE'),
    heatTypeDescription: text(attributes, 'HEAT_TYPE_DESC'),
    fuelTypeCode: text(attributes, 'FUEL_TYPE'),
    fuelTypeDescription: text(attributes, 'FUEL_TYPE_DESC'),
    sewerTypeCode: text(attributes, 'SEWER_TYPE'),
    sewerTypeDescription: text(attributes, 'SEWER_DESC'),
    waterSupplyCode: text(attributes, 'WATER_SUPPLY'),
    waterSupplyDescription: text(attributes, 'WATER_DESC'),
    utilitiesCode: text(attributes, 'UTILITIES'),
    utilitiesDescription: text(attributes, 'UTILITIES_DESC'),
    usedAsCode: text(attributes, 'USED_AS_CODE'),
    usedAsDescription: text(attributes, 'USED_AS_DESC'),

    frontFeet: integer(attributes, 'FRONT'),
    depthFeet: integer(attributes, 'DEPTH'),
    assessedSquareFeet: real(attributes, 'SQ_FT'),
    assessedAcres: real(attributes, 'ACRES'),
    gisAcres: real(attributes, 'CALC_ACRES'),
    gridEast: real(attributes, 'GRID_EAST'),
    gridNorth: real(attributes, 'GRID_NORTH'),
    agriculturalDistrictCode: text(attributes, 'AG_DIST_CODE'),
    agriculturalDistrictName: text(attributes, 'AG_DIST_NAME'),
    duplicateGeometry: (text(attributes, 'DUP_GEO') ?? '').toUpperCase() === 'Y',

    deedBook: integer(attributes, 'BOOK'),
    deedPage: integer(attributes, 'PAGE'),
  };

  return { record, sourceRecordId: nySourceRecordId(countyFips, identity.normalizedParcel) };
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
