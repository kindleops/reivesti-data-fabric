/**
 * Minnesota statewide parcel feature → typed record.
 *
 * Two things this parser refuses to do, both because getting them wrong is
 * silent:
 *
 * **It never infers the county.** `co_code` is a five-digit FIPS supplied by the
 * source, and it is the authoritative routing key. A row whose county is missing
 * or is not a catalogued Minnesota county is quarantined rather than placed by
 * guessing from its address — a parcel filed into the wrong county partition
 * would acquire a wrong canonical property id and never be found again.
 *
 * **It never invents an identity.** 18,462 rows carry no `county_pin`. They have
 * no parcel identity, so they are refused. Fabricating a surrogate would create a
 * property that no county recognises.
 */
import { fail } from '../../core/errors.ts';
import { normalizeParcelId } from '../../canonical/models.ts';
import { countyEquivalent } from '../../registry/us-geography.ts';

export const MN_STATE_FIPS = '27';

export type MnStatewideParcelRecord = {
  // -- identity
  readonly countyFips: string;
  readonly countyName: string | null;
  readonly countyPin: string;
  readonly normalizedParcel: string;
  readonly statePin: string | null;
  /** The publisher's row id. A source identifier, never Reivesti identity. */
  readonly sourceObjectId: number | null;

  // -- situs address
  readonly houseNumber: number | null;
  readonly houseNumberPrefix: string | null;
  readonly houseNumberSuffix: string | null;
  readonly streetPreDirection: string | null;
  readonly streetPreType: string | null;
  readonly streetName: string | null;
  readonly streetPostType: string | null;
  readonly streetPostDirection: string | null;
  readonly unitType: string | null;
  readonly unitId: string | null;
  readonly zip: string | null;
  readonly zip4: string | null;
  readonly postalCommunity: string | null;
  readonly ctuName: string | null;
  readonly ctuId: string | null;

  // -- ownership (names only; mailing goes to the restricted plane)
  readonly ownerName: string | null;
  readonly ownerMore: string | null;
  readonly taxpayerName: string | null;
  readonly ownershipType: string | null;
  readonly homestead: string | null;
  readonly ownerMailing: readonly string[];
  readonly taxpayerMailing: readonly string[];

  // -- assessment
  readonly emvLand: number | null;
  readonly emvBuilding: number | null;
  readonly emvTotal: number | null;
  readonly marketValueYear: number | null;
  readonly taxCapacity: number | null;
  readonly useClasses: readonly string[];
  readonly exemptUseClasses: readonly string[];
  readonly multipleUses: string | null;
  readonly taxExempt: string | null;

  // -- tax
  readonly taxYear: number | null;
  readonly totalTax: number | null;
  readonly specialAssessments: number | null;
  readonly schoolDistrict: string | null;
  readonly watershedDistrict: string | null;
  readonly greenAcres: string | null;
  readonly openSpace: string | null;
  readonly agPreserve: string | null;

  // -- structure
  readonly dwellingType: string | null;
  readonly homeStyle: string | null;
  readonly finishedSquareFeet: number | null;
  readonly garage: string | null;
  readonly garageSquareFeet: number | null;
  readonly basement: string | null;
  readonly heating: string | null;
  readonly cooling: string | null;
  readonly yearBuilt: number | null;
  readonly numberOfUnits: number | null;

  // -- assessor-reported sale echo. NOT a transfer record.
  readonly saleDate: string | null;
  readonly saleValue: number | null;

  // -- legal / area / provenance
  readonly lot: string | null;
  readonly block: string | null;
  readonly platName: string | null;
  readonly abbreviatedLegal: string | null;
  readonly acresPolygon: number | null;
  readonly acresDeed: number | null;
  readonly editDate: string | null;
  readonly exportDate: string | null;
  readonly standardConformance: number | null;
};

export type ParsedMnParcel = {
  readonly record: MnStatewideParcelRecord;
  readonly sourceRecordId: string;
};

/** Source record identity: county-scoped, and stable across snapshots. */
export function mnStatewideSourceRecordId(countyFips: string, normalizedParcel: string): string {
  return `MN-${countyFips}-${normalizedParcel}`;
}

export function parseMnStatewideFeature(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): ParsedMnParcel {
  const countyFips = text(attributes, 'co_code');
  if (countyFips === null) {
    fail('PARSE', `${origin}: row has no co_code, so it cannot be routed to a county`);
  }
  // Checked against the federal catalogue, not against a pattern. A five-digit
  // string that is not a real Minnesota county would route rows into a partition
  // no jurisdiction owns.
  const county = countyEquivalent(countyFips);
  if (county === undefined || county.stateFips !== MN_STATE_FIPS) {
    fail('PARSE', `${origin}: "${countyFips}" is not a catalogued Minnesota county`, {
      countyFips,
      remedy: 'the county is inferred from nothing; a row the source cannot place is quarantined',
    });
  }

  const countyPin = text(attributes, 'county_pin');
  if (countyPin === null) {
    fail('PARSE', `${origin}: parcel in ${countyFips} has no county_pin, so it has no identity`);
  }
  const normalizedParcel = normalizeParcelId(countyPin);
  if (normalizedParcel === '') {
    fail('PARSE', `${origin}: county_pin "${countyPin}" normalises to nothing`);
  }

  const record: MnStatewideParcelRecord = {
    countyFips,
    countyName: text(attributes, 'co_name'),
    countyPin,
    normalizedParcel,
    statePin: text(attributes, 'state_pin'),
    sourceObjectId: integer(attributes, 'objectid'),

    houseNumber: integer(attributes, 'anumber'),
    houseNumberPrefix: text(attributes, 'anumberpre'),
    houseNumberSuffix: text(attributes, 'anumbersuf'),
    streetPreDirection: text(attributes, 'st_pre_dir'),
    streetPreType: text(attributes, 'st_pre_typ'),
    streetName: text(attributes, 'st_name'),
    streetPostType: text(attributes, 'st_pos_typ'),
    streetPostDirection: text(attributes, 'st_pos_dir'),
    unitType: text(attributes, 'sub_type1'),
    unitId: text(attributes, 'sub_id1'),
    zip: text(attributes, 'zip'),
    zip4: text(attributes, 'zip4'),
    postalCommunity: text(attributes, 'postcomm'),
    ctuName: text(attributes, 'ctu_name'),
    ctuId: text(attributes, 'ctu_id_txt'),

    ownerName: text(attributes, 'owner_name'),
    ownerMore: text(attributes, 'owner_more'),
    taxpayerName: text(attributes, 'tax_name'),
    ownershipType: text(attributes, 'ownership'),
    homestead: text(attributes, 'homestead'),
    ownerMailing: lines(attributes, ['own_add_l1', 'own_add_l2', 'own_add_l3', 'own_add_l4']),
    taxpayerMailing: lines(attributes, ['tax_add_l1', 'tax_add_l2', 'tax_add_l3', 'tax_add_l4']),

    emvLand: integer(attributes, 'emv_land'),
    emvBuilding: integer(attributes, 'emv_bldg'),
    emvTotal: integer(attributes, 'emv_total'),
    marketValueYear: integer(attributes, 'mkt_year'),
    taxCapacity: integer(attributes, 'tax_capac'),
    useClasses: lines(attributes, ['useclass1', 'useclass2', 'useclass3', 'useclass4']),
    exemptUseClasses: lines(attributes, ['xuseclass1', 'xuseclass2', 'xuseclass3', 'xuseclass4']),
    multipleUses: text(attributes, 'multi_uses'),
    taxExempt: text(attributes, 'tax_exempt'),

    taxYear: integer(attributes, 'tax_year'),
    totalTax: integer(attributes, 'total_tax'),
    specialAssessments: integer(attributes, 'spec_asses'),
    schoolDistrict: text(attributes, 'school_dst'),
    watershedDistrict: text(attributes, 'wshd_dst'),
    greenAcres: text(attributes, 'green_acre'),
    openSpace: text(attributes, 'open_space'),
    agPreserve: text(attributes, 'ag_preserv'),

    dwellingType: text(attributes, 'dwell_type'),
    homeStyle: text(attributes, 'home_style'),
    finishedSquareFeet: integer(attributes, 'fin_sq_ft'),
    garage: text(attributes, 'garage'),
    garageSquareFeet: integer(attributes, 'garagesqft'),
    basement: text(attributes, 'basement'),
    heating: text(attributes, 'heating'),
    cooling: text(attributes, 'cooling'),
    yearBuilt: integer(attributes, 'year_built'),
    numberOfUnits: integer(attributes, 'num_units'),

    saleDate: date(attributes, 'sale_date'),
    saleValue: integer(attributes, 'sale_value'),

    lot: text(attributes, 'lot'),
    block: text(attributes, 'block'),
    platName: text(attributes, 'plat_name'),
    abbreviatedLegal: text(attributes, 'abb_legal'),
    acresPolygon: real(attributes, 'acres_poly'),
    acresDeed: real(attributes, 'acres_deed'),
    editDate: date(attributes, 'edit_date'),
    exportDate: date(attributes, 'exp_date'),
    standardConformance: integer(attributes, 'n_standard'),
  };

  return { record, sourceRecordId: mnStatewideSourceRecordId(countyFips, normalizedParcel) };
}

// ---------------------------------------------------------------------------

function text(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function integer(attributes: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = attributes[key];
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function real(attributes: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = attributes[key];
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Dates arrive as epoch milliseconds from the ArcGIS API and as ISO strings from
 * the GeoPackage. Both are accepted and emitted as an ISO date, because the
 * canonical form must not depend on which acquisition path was used — that is
 * the whole point of having one bundle contract.
 */
function date(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : (d.toISOString().slice(0, 10));
  }
  const s = String(value).trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1] as string;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Multi-line fields kept as an ordered list, never concatenated into one string. */
function lines(attributes: Readonly<Record<string, unknown>>, keys: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = text(attributes, key);
    if (value !== null) out.push(value);
  }
  return out;
}
