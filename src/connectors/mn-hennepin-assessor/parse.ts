/**
 * Deterministic Hennepin parcel reader.
 *
 * Coercion rules, stated because implicit coercion is how a public record
 * quietly becomes a different fact:
 *
 *   PID       kept as published AND normalised. The normalised form strips
 *             punctuation and case, which is exactly what makes the county's
 *             "0202824410097" and eCRV's "02-028-24-41-0097" the same parcel.
 *   currency  the roll publishes whole dollars as integers and taxes as
 *             decimals; both become exact integer minor units.
 *   empty     ArcGIS returns null, "" and "   " interchangeably. All three are
 *             absence, and absence is null. Never zero, never "".
 *   numbers   a numeric field carrying a non-number is a parse failure, not a
 *             silent 0.
 */
import { fail } from '../../core/errors.ts';
import { normalizeParcelId } from '../../canonical/models.ts';
import type {
  HennepinAssessmentTier,
  HennepinParcelRecord,
  HennepinSitusAddress,
} from './record.ts';

export const HENNEPIN_COUNTY_FIPS = '27053';

/** Hennepin PIDs are 13 digits: CC-TTT-RR-QQ-PPPP with the punctuation removed. */
const PID_SHAPE = /^\d{13}$/;

export type ParsedParcel = {
  readonly record: HennepinParcelRecord;
  readonly sourceRecordId: string;
};

/** Source record identity: county-scoped and stable across snapshots. */
export function hennepinSourceRecordId(normalizedParcel: string): string {
  return `MN-27053-${normalizedParcel}`;
}

export function parseHennepinFeature(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): ParsedParcel {
  const pid = text(attributes, 'PID');
  if (pid === null) fail('PARSE', `${origin}: parcel row has no PID, so it has no identity`);

  const normalizedParcel = normalizeParcelId(pid);
  if (!PID_SHAPE.test(normalizedParcel)) {
    fail('PARSE', `${origin}: PID "${pid}" does not normalise to a 13-digit Hennepin parcel id`, {
      pid,
      normalized: normalizedParcel,
    });
  }

  const situs: HennepinSitusAddress = {
    houseNumber: numberText(attributes, 'HOUSE_NO'),
    fractionalHouseNumber: text(attributes, 'FRAC_HOUSE_NO'),
    streetName: text(attributes, 'STREET_NM'),
    condoNumber: text(attributes, 'CONDO_NO'),
    municipality: text(attributes, 'MUNIC_NM'),
    zip: text(attributes, 'ZIP_CD'),
    multipleAddresses: text(attributes, 'MULTI_ADDR_IND') === 'Y',
  };

  const tiers: HennepinAssessmentTier[] = [];
  for (let n = 1; n <= 4; n++) {
    const tier: HennepinAssessmentTier = {
      tier: n,
      propertyTypeCode: text(attributes, `PR_TYP_CD${n}`),
      propertyTypeName: text(attributes, `PR_TYP_NM${n}`),
      homesteadCode: text(attributes, `HMSTD_CD${n}`),
      ownerPercent: numeric(attributes, `OWNER_PCT${n}`, origin),
      contiguousIndicator: text(attributes, `CONT_IND${n}`),
      landValueMinor: money(attributes, `LAND_MV${n}`, origin),
      buildingValueMinor: money(attributes, `BLDG_MV${n}`, origin),
      machineryValueMinor: money(attributes, `MACH_MV${n}`, origin),
      totalValueMinor: money(attributes, `TOTAL_MV${n}`, origin),
      qualifyingImprovementMinor: money(attributes, `QUAL_IMPR${n}`, origin),
      veteranExclusionMinor: money(attributes, `VET_EXCL${n}`, origin),
      homesteadExclusionMinor: money(attributes, `HMS_EXCL${n}`, origin),
      netTaxCapacityMinor: money(attributes, `NET_TC${n}`, origin),
      netTaxMinor: money(attributes, `NET_TAX${n}`, origin),
    };
    // A tier with no type and no values is padding, not a classified portion.
    if (isEmptyTier(tier)) continue;
    tiers.push(tier);
  }

  const record: HennepinParcelRecord = {
    pid,
    normalizedParcel,
    countyFips: HENNEPIN_COUNTY_FIPS,
    objectId: integer(attributes, 'OBJECTID', origin),
    propertyStatusCode: text(attributes, 'PROPERTY_STATUS_CD'),
    situs,
    ownerName: text(attributes, 'OWNER_NM'),
    taxpayerNameLine: text(attributes, 'TAXPAYER_NM'),
    legalDescription: joinLegalDescription(attributes),
    yearBuilt: yearValue(attributes, 'BUILD_YR', origin),
    parcelAreaSqFt: numeric(attributes, 'PARCEL_AREA', origin),
    marketValueTotalMinor: money(attributes, 'MKT_VAL_TOT', origin),
    taxableValueTotalMinor: money(attributes, 'TAXABLE_VAL_TOT', origin),
    tiers,
    lastSale: {
      date: text(attributes, 'SALE_DATE'),
      priceMinor: money(attributes, 'SALE_PRICE', origin),
      code: text(attributes, 'SALE_CODE'),
      codeName: text(attributes, 'SALE_CODE_NAME'),
    },
    geography: {
      municipality_code: text(attributes, 'MUNIC_CD'),
      school_district: text(attributes, 'SCHOOL_DIST_NO'),
      watershed: text(attributes, 'WATERSHED_NO'),
      sewer_district: text(attributes, 'SEWER_DIST_NO'),
      tif_project: text(attributes, 'TIF_PROJECT_NO'),
      latitude: numeric(attributes, 'LAT', origin),
      longitude: numeric(attributes, 'LON', origin),
    },
    attributes: {
      feature_code: integer(attributes, 'FEATURECODE', origin),
      state_code: integer(attributes, 'STATE_CD', origin),
      torrens_type: text(attributes, 'TORRENS_TYP'),
      abstract_torrens_code: text(attributes, 'ABSTR_TORRENS_CD'),
      multi_address_indicator: text(attributes, 'MULTI_ADDR_IND'),
      forfeited_land: text(attributes, 'FORFEIT_LAND_IND'),
      cooperative: text(attributes, 'CO_OP_IND'),
      primary_secondary_code: text(attributes, 'PRI_SEC_CODE'),
      metes_bounds_truncated: text(attributes, 'MORE_METES_BNDS_IND'),
      composite_judgment: text(attributes, 'COMP_JUDG_IND'),
      mortgage_company_number: text(attributes, 'MTG_CO_NBR'),
      green_acres_open_space: text(attributes, 'GR_ACRE_OPEN_SPACE_CD'),
      petition_review_pending: text(attributes, 'PETITION_REVIEW_IND'),
      tax_adjustment_pending: text(attributes, 'TAX_ADJ_PEND_IND'),
      // A pending division is why a parcel may vanish from a later snapshot
      // without anything having been demolished.
      division_pending: text(attributes, 'DIV_PEND_IND'),
      division_status_date: text(attributes, 'DIV_STATUS_DATE'),
      net_improvement: money(attributes, 'NET_IMPRV_AMT', origin),
      total_net_tax: money(attributes, 'TOT_NET_TAX', origin),
      total_special_tax: money(attributes, 'TOT_SPEC_TAX', origin),
      tax_total: money(attributes, 'TAX_TOT', origin),
      net_tax_paid: money(attributes, 'NET_TAX_PD', origin),
      total_penalty_paid: money(attributes, 'TOT_PENALTY_PD', origin),
      // Two digits, as published. Not expanded to four: the century is not
      // stated, and guessing it would invent data.
      earliest_delinquent_year: text(attributes, 'EARLIEST_DELQ_YR'),
      pid_text: text(attributes, 'PID_TEXT'),
    },
    restricted: {
      taxpayerBlockLines: ['TAXPAYER_NM', 'TAXPAYER_NM_1', 'TAXPAYER_NM_2', 'TAXPAYER_NM_3']
        .map((f) => text(attributes, f))
        .filter((v): v is string => v !== null),
      mailingMunicipality: text(attributes, 'MAILING_MUNIC_NM'),
    },
  };

  return { record, sourceRecordId: hennepinSourceRecordId(normalizedParcel) };
}

/** The four metes-and-bounds lines plus plat detail, joined in source order. */
function joinLegalDescription(attributes: Readonly<Record<string, unknown>>): string | null {
  const parts = [
    text(attributes, 'ABBREV_ADDN_NM'),
    lotBlock(attributes),
    text(attributes, 'METES_BNDS1'),
    text(attributes, 'METES_BNDS2'),
    text(attributes, 'METES_BNDS3'),
    text(attributes, 'METES_BNDS4'),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

function lotBlock(attributes: Readonly<Record<string, unknown>>): string | null {
  const lot = text(attributes, 'LOT');
  const block = text(attributes, 'BLOCK');
  if (lot === null && block === null) return null;
  return [lot ? `LOT ${lot}` : null, block ? `BLOCK ${block}` : null].filter(Boolean).join(' ');
}

function isEmptyTier(tier: HennepinAssessmentTier): boolean {
  return tier.propertyTypeCode === null
    && tier.propertyTypeName === null
    && tier.homesteadCode === null
    && tier.landValueMinor === null
    && tier.buildingValueMinor === null
    && tier.totalValueMinor === null
    && tier.netTaxMinor === null;
}

// ---------------------------------------------------------------------------
// Typed readers
// ---------------------------------------------------------------------------

/** ArcGIS pads fixed-width columns, so trailing spaces are not data. */
function text(attributes: Readonly<Record<string, unknown>>, field: string): string | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

function numberText(attributes: Readonly<Record<string, unknown>>, field: string): string | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

function integer(attributes: Readonly<Record<string, unknown>>, field: string, origin: string): number | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) fail('PARSE', `${origin}: ${field} is ${raw}, which is not an integer`);
    return raw;
  }
  const value = String(raw).trim();
  if (value === '') return null;
  if (!/^[+-]?\d+$/.test(value)) fail('PARSE', `${origin}: ${field} is "${value}", which is not an integer`);
  return Number(value);
}

function numeric(attributes: Readonly<Record<string, unknown>>, field: string, origin: string): number | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) fail('PARSE', `${origin}: ${field} is not a finite number`);
    return raw;
  }
  const value = String(raw).trim();
  if (value === '') return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) fail('PARSE', `${origin}: ${field} is "${value}", which is not numeric`);
  return Number(value);
}

/**
 * Exact currency in integer minor units.
 *
 * The roll publishes whole-dollar integers for values and two-decimal doubles
 * for taxes. Both are converted by string arithmetic so no amount is ever a
 * floating-point approximation of itself.
 */
function money(attributes: Readonly<Record<string, unknown>>, field: string, origin: string): number | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? formatFinite(raw, field, origin) : String(raw).trim();
  if (value === '') return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match) fail('PARSE', `${origin}: ${field} is "${value}", which is not a currency amount`);
  const [, sign = '', whole = '', fraction = ''] = match as unknown as string[];
  if (whole === '' && fraction === '') return null;
  // The roll can carry sub-cent floating noise on tax doubles; more than two
  // decimals is refused rather than rounded, so a real precision change in the
  // source surfaces instead of being quietly absorbed.
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > 2) fail('PARSE', `${origin}: ${field} is "${value}", which has sub-cent precision`);
  const cents = `${whole === '' ? '0' : whole}${trimmed.padEnd(2, '0')}`;
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) fail('PARSE', `${origin}: ${field} is "${value}", which exceeds safe integer range`);
  return sign === '-' ? -n : n;
}

function formatFinite(raw: number, field: string, origin: string): string {
  if (!Number.isFinite(raw)) fail('PARSE', `${origin}: ${field} is not a finite number`);
  // toFixed(2) then trim keeps a double like 1234.5600000000001 honest.
  return Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
}

function yearValue(attributes: Readonly<Record<string, unknown>>, field: string, origin: string): number | null {
  const value = text(attributes, field);
  if (value === null) return null;
  if (!/^\d{4}$/.test(value)) fail('PARSE', `${origin}: ${field} is "${value}", which is not a four-digit year`);
  const year = Number(value);
  // 0000 is the roll's way of saying "unknown", not the year zero.
  return year === 0 ? null : year;
}
