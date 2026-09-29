/**
 * NYS Tax Parcel Centroid Points record → canonical rows.
 *
 * Everything the contract already knows how to say is said through it —
 * money, areas, addresses, identifiers — and nothing New York-specific is
 * invented in its place. What the adapter contributes is knowledge only a
 * reader of this layer has:
 *
 * - **Two lineages, never blended.** 57 counties carry ORPTS assessment-roll
 *   attributes; the five boroughs carry NYC MapPLUTO's. PROP_CLASS is an ORPTS
 *   3-digit property class in one and a PLUTO land-use code in the other;
 *   BLDG_STYLE is a residential style in one and a DOF building class in the
 *   other; assessed value is a municipal assessor's in one and the NYC
 *   Department of Finance's in the other. Every such value carries its code
 *   system or value basis, so the two are never compared as if alike.
 * - **Assessed ≠ full market.** TOTAL_AV is ASSESSED, at the municipality's own
 *   level of assessment, and becomes `totalValue`. FULL_MARKET_VAL is a
 *   different value type and rides beside it, never in the same slot.
 * - **The roll year is the time axis.** Every value belongs to ROLL_YR (2025 on
 *   every row); two roll years are two observations, never a conflict.
 * - **No tax amount exists** in this schema, so `netTax` is null and no tax
 *   capability is claimed. ROLL_SECTION is a roll-status code, kept as such.
 * - **No sale exists.** BOOK/PAGE reference the last recorded deed but carry no
 *   date, price or party; they are kept raw and emit no transfer, sale, deed or
 *   mortgage fact of any kind.
 * - **The mailing addresses are restricted.** Both owners' mailing parts go to
 *   the restricted plane and nowhere else.
 */
import { deterministicId, contentDigest } from '../../core/hash.ts';
import {
  normalizeName,
  propertyIdFromCountyParcel,
  type AssessmentObservation,
  type CanonicalBundle,
  type CanonicalEvent,
  type Money,
  type PartyObservation,
  type Property,
  type PropertyCharacteristicObservation,
  type PropertyIdentifierObservation,
  type SourceEvidence,
} from '../../canonical/models.ts';
import {
  parcelObservationId,
  type ParcelSnapshotObservation,
  type SnapshotChangeKind,
} from '../../canonical/snapshot.ts';
import { contactObservationId, type ContactObservation } from '../../contact/contact-plane.ts';
import { canonicalAddress } from '../../canonical/address.ts';
import {
  NORMALIZATION_CONTRACT_VERSION,
  PARCEL_IDENTIFIER_EXTENSION,
  absent,
  canonicalArea,
  canonicalMoney,
  type AreaValue,
} from '../../canonical/normalization-contract.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { NY_PARCEL_IDENTIFIER_SCHEME } from './identity.ts';
import type { NyMailing, NyStatewideParcelRecord } from './parse.ts';

export type NyNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export const NY_STATEWIDE_NORMALIZATION_VERSION = 'ny_statewide_normalizer_1';

export type NyNormalizeResultRows = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

/** Earliest year accepted as a build year. New York has standing 17th-century houses. */
const EARLIEST_BUILD_YEAR = 1600;

/**
 * A year built the contract can use. ORPTS writes 0 for "not recorded" (38,687
 * rows); a year before 1600 or after the roll's own year + 1 is not a build
 * year either. The raw value is always kept.
 */
export function yearBuiltOf(raw: number | null, rollYear: number | null): number | null {
  // Without a roll year there is nothing to check a build year against, and
  // the clock is never consulted: a replay must reach the same answer.
  if (raw === null || raw === 0 || rollYear === null) return null;
  return raw >= EARLIEST_BUILD_YEAR && raw <= rollYear + 1 ? raw : null;
}

/** A roll year the contract can use as a time axis. Anything else stays null. */
export function rollYearOf(raw: number | null): number | null {
  return raw !== null && raw >= 1990 && raw <= 2100 ? raw : null;
}

/**
 * The canonical parcel area.
 *
 * ORPTS sizes a parcel in exactly one of three ways — acres, square feet, or
 * frontage × depth — and writes 0 in the units it did not use: SQ_FT is 0 on
 * 4.36 million rows outside New York City. So the first POSITIVE of ACRES then
 * SQ_FT is the area the roll states; where both are 0 the roll sized the parcel
 * by its frontage and depth, which is kept raw and not multiplied out here.
 */
export function canonicalAreaOf(record: NyStatewideParcelRecord): { readonly area: AreaValue; readonly field: string | null } {
  if (record.assessedAcres !== null && record.assessedAcres > 0) {
    return { area: canonicalArea(record.assessedAcres, 'acres'), field: 'ACRES' };
  }
  if (record.assessedSquareFeet !== null && record.assessedSquareFeet > 0) {
    return { area: canonicalArea(record.assessedSquareFeet, 'square_feet'), field: 'SQ_FT' };
  }
  if (record.assessedAcres === null && record.assessedSquareFeet === null) {
    return { area: absent('MISSING'), field: null };
  }
  // Stated, as zero, in both units: the roll sized this parcel another way.
  return { area: absent('NOT_APPLICABLE', 'ACRES=0;SQ_FT=0'), field: null };
}

export function normalizeNyStatewideParcel(
  record: NyStatewideParcelRecord,
  evidence: SourceEvidence,
  ctx: NyNormalizeContext,
): NyNormalizeResultRows {
  const jurisdictionId = countyJurisdictionId(record.countyFips);
  // The same function every county-parcel source uses; see identity.ts.
  const propertyId = propertyIdFromCountyParcel(record.countyFips, record.normalizedParcel);
  const nyc = record.lineage === 'nyc_mappluto';
  const rollYear = rollYearOf(record.rollYear);
  const values = moneyFacts(record);
  const situs = situsAddress(record);
  const { area, field: areaField } = canonicalAreaOf(record);
  const valueBasis = nyc ? 'nyc_dof_assessed_value' : 'assessed_at_municipal_level_of_assessment';
  const propertyClassSystem = record.propertyClass === null ? null
    : nyc ? 'nyc_pluto_land_use' : 'nys_orpts_property_class';
  const buildingStyleSystem = record.buildingStyleCode === null ? null
    : nyc ? 'nyc_dof_building_class' : 'nys_orpts_residential_building_style';

  // -- identifiers ---------------------------------------------------------

  const identifiers: PropertyIdentifierObservation[] = [{
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: `${record.swis}${record.sbl}`,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    // The municipal rolls, aggregated by the state without re-keying.
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  }];

  // The same row states these; they attach to this property and are never join
  // keys: `source_property_key` does not participate in resolution.
  const secondary = (kind: string, value: string | null): void => {
    if (value === null) return;
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, kind),
      identifierType: 'source_property_key',
      value,
      normalizedValue: value.toUpperCase(),
      countyFips: record.countyFips,
      sourceDesignation: 'secondary',
      finality: 'final',
      resolutionState: 'resolved',
      propertyId,
      resolutionMethod: 'same_source_row',
      evidence,
    });
  };
  secondary('print_key', record.printKey === null ? null : `${record.swis}${record.printKey}`);
  secondary('muni_parcel_id', record.muniParcelId);

  if (situs !== null) {
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'address', normalizeName(situs)),
      identifierType: 'normalized_address',
      value: situs,
      normalizedValue: normalizeName(situs),
      countyFips: record.countyFips,
      sourceDesignation: 'unspecified',
      finality: 'unknown',
      // An address is never an identity on its own.
      resolutionState: 'unresolved',
      propertyId: null,
      resolutionMethod: null,
      evidence,
    });
  }

  // -- parties: names only --------------------------------------------------

  const parties: PartyObservation[] = [];
  const contacts: ContactObservation[] = [];
  const addOwner = (name: string, sourceRole: 'PRIMARY_OWNER' | 'ADD_OWNER'): string => {
    const observationId = deterministicId('partyobs', ctx.sourceId, evidence.sourceRecordId, sourceRole);
    parties.push({
      observationId,
      // The roll does not say whether an owner is a person or a company, and
      // OWNER_TYPE is the publisher's own derived category, so neither does
      // the Fabric. The same name on two parcels is not evidence of one party:
      // resolution stays `unresolved`, and nothing here merges.
      kind: 'unknown',
      role: 'assessor_owner_of_record',
      sourceRole: `ny_statewide:assessor_owner_of_record:${sourceRole}`,
      rawName: name,
      normalizedName: normalizeName(name),
      nameParts: { first: null, middle: null, last: null, suffix: null, organizationName: null },
      address: null,
      foreignAddress: null,
      protectedIdentity: false,
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });
    return observationId;
  };
  const primary = record.primaryOwner !== null ? addOwner(record.primaryOwner, 'PRIMARY_OWNER') : null;
  const additional = record.additionalOwner !== null ? addOwner(record.additionalOwner, 'ADD_OWNER') : null;

  const seenMailing = new Set<string>();
  const addMailing = (mailing: NyMailing, partyObservationId: string | null): void => {
    const value = mailingString(mailing);
    if (value === null) return;
    // The same address stated twice for the same party is one fact, not two.
    const key = `${partyObservationId ?? ''}\u0000${value}`;
    if (seenMailing.has(key)) return;
    seenMailing.add(key);
    // Attached to the owner it belongs to. Where the roll names no such owner,
    // the address still belongs to the record and is kept — restricted —
    // rather than dropped or pinned on a party nobody named.
    contacts.push({
      contactObservationId: contactObservationId(ctx.sourceId, evidence.sourceRecordId, partyObservationId, 'mailing_address', value),
      partyId: null,
      partyObservationId,
      contactType: 'mailing_address',
      value,
      sourceId: ctx.sourceId,
      sourceRecordId: evidence.sourceRecordId,
      observedAt: evidence.observedAt,
      confidence: 'source_stated',
      permittedUse: 'record_only',
      status: 'observed',
      evidence,
    });
  };
  addMailing(record.primaryMailing, primary);
  addMailing(record.additionalMailing, additional);

  // -- assessment ----------------------------------------------------------

  const assessments: AssessmentObservation[] = [];
  if (values.totalAssessed !== null || values.landAssessed !== null || values.fullMarket !== null) {
    assessments.push({
      observationId: deterministicId('assess', ctx.snapshotId, evidence.sourceRecordId, '1'),
      propertyId,
      countyFips: record.countyFips,
      normalizedParcel: record.normalizedParcel,
      snapshotId: ctx.snapshotId,
      // The roll the values come from. Null when it is not a year — never
      // guessed from the release.
      assessmentYear: rollYear,
      tier: 1,
      propertyTypeCode: record.propertyClass,
      propertyTypeName: null,
      homesteadCode: null,
      landValue: values.landAssessed,
      // Not stated. Total minus land would be a derivation, not the roll.
      buildingValue: null,
      machineryValue: null,
      // ASSESSED, at the municipality's level of assessment (or DOF's in NYC).
      totalValue: values.totalAssessed,
      taxableValue: null,
      netTaxCapacity: null,
      // No tax amount exists in this schema.
      netTax: null,
      characteristics: {
        value_basis: valueBasis,
        roll_year: rollYear,
        roll_year_raw: record.rollYear,
        full_market_value_minor: values.fullMarket?.amountMinor ?? null,
        full_market_value_basis: values.fullMarket === null ? null : 'roll_stated_full_market_value',
        property_class_code: record.propertyClass,
        property_class_system: propertyClassSystem,
        roll_section: record.rollSection,
        land_exceeds_total: values.landAssessed !== null && values.totalAssessed !== null
          && values.landAssessed.amountMinor > values.totalAssessed.amountMinor,
        school_district_code: record.schoolCode,
        lineage: record.lineage,
        invalid_money_fields: values.invalid,
      },
      evidence,
    });
  }

  // -- characteristics ------------------------------------------------------

  const canonicalAddressValue = canonicalAddress({
    houseNumber: record.streetNumber,
    // LOC_STREET already holds pre-direction, name, post-direction and suffix
    // as one string. It is not re-parsed into parts here: splitting a street
    // name on guessed boundaries would be inventing structure.
    streetName: record.street,
    unitId: record.unit,
    city: null,
    state: 'NY',
    postalCode: record.zip,
  });
  const assessedTotal = canonicalMoney(record.totalAssessedValue === null ? null : String(record.totalAssessedValue), 'major_units');

  const characteristics: PropertyCharacteristicObservation[] = [{
    observationId: deterministicId('charobs', ctx.snapshotId, evidence.sourceRecordId),
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    snapshotId: ctx.snapshotId,
    yearBuilt: yearBuiltOf(record.yearBuiltRaw, rollYear),
    parcelAreaSqFt: area.present ? area.squareFeet : null,
    characteristics: {
      lineage: record.lineage,
      situs_address: situs,
      municipality: record.municipalityName,
      city_town: record.cityTownName,
      swis: record.swis,
      city_town_swis: record.cityTownSwis,
      school_district: record.schoolName,
      school_district_code: record.schoolCode,
      property_class_code: record.propertyClass,
      property_class_system: propertyClassSystem,
      roll_section: record.rollSection,
      roll_year: rollYear,
      spatial_year: record.spatialYear,
      year_built_raw: record.yearBuiltRaw,
      living_area_sq_ft: record.livingAreaSqFt,
      gross_floor_area_sq_ft: record.grossFloorArea,
      kitchens: record.kitchens,
      full_baths: record.fullBaths,
      bedrooms: record.bedrooms,
      building_style_code: record.buildingStyleCode,
      building_style_description: record.buildingStyleDescription,
      building_style_system: buildingStyleSystem,
      heat_type_code: record.heatTypeCode,
      heat_type_description: record.heatTypeDescription,
      fuel_type_code: record.fuelTypeCode,
      fuel_type_description: record.fuelTypeDescription,
      sewer_type_code: record.sewerTypeCode,
      sewer_type_description: record.sewerTypeDescription,
      water_supply_code: record.waterSupplyCode,
      water_supply_description: record.waterSupplyDescription,
      utilities_code: record.utilitiesCode,
      utilities_description: record.utilitiesDescription,
      used_as_code: record.usedAsCode,
      used_as_description: record.usedAsDescription,
      agricultural_district_code: record.agriculturalDistrictCode,
      agricultural_district_name: record.agriculturalDistrictName,
      owner_type_code: record.ownerTypeCode,
      state_agency_name: record.stateAgencyName,
      state_agency_name_source: record.stateAgencyNameSource,
      front_feet: record.frontFeet,
      depth_feet: record.depthFeet,
      assessed_acres: record.assessedAcres,
      assessed_square_feet: record.assessedSquareFeet,
      gis_acres: record.gisAcres,
      duplicate_geometry: record.duplicateGeometry,
      canonical_area_square_feet: area.present ? area.squareFeet : null,
      canonical_area_source_unit: area.present ? area.sourceUnit : null,
      canonical_area_source_value: area.present ? area.sourceValue : null,
      canonical_area_source_field: areaField,
      canonical_area_absent_reason: area.present ? null : area.reason,
      canonical_address_key: canonicalAddressValue.present ? canonicalAddressValue.comparisonKey : null,
      canonical_assessed_total_minor: assessedTotal.present ? assessedTotal.amountMinor.toString() : null,
      canonical_value_basis: valueBasis,
      canonical_tax_total_minor: null,
      canonical_tax_basis: null,
      // The centroid is the row's point geometry, retained in the archive and
      // not decoded; GRID_EAST/GRID_NORTH are the roll's own grid, zone unstated.
      latitude: null,
      longitude: null,
      coordinate_kind: null,
      centroid_geometry: 'retained_in_publisher_archive_not_decoded',
      roll_grid_east_raw: record.gridEast,
      roll_grid_north_raw: record.gridNorth,
      // The roll's pointer to the last recorded deed. Not a transfer: no date,
      // no price, no parties.
      last_deed_book_raw: record.deedBook,
      last_deed_page_raw: record.deedPage,
      sale_fields_in_source: false,
      tax_amount_fields_in_source: false,
      source_object_id: record.sourceObjectId,
      source_orig_fid: record.sourceOrigFid,
      source_print_key: record.printKey,
      source_muni_parcel_id: record.muniParcelId,
      source_swis_sbl_id: record.publishedSwisSblId,
      source_swis_sbl_id_mismatch: record.swisSblIdMismatch,
      source_swis_print_key_id: record.publishedSwisPrintKeyId,
      source_swis_print_key_id_mismatch: record.swisPrintKeyIdMismatch,
      roll_record_present: nyc ? values.totalAssessed !== null : record.muniParcelId !== null,
      parcel_match_key: record.matchKey,
      tax_map_key: record.taxMapKey,
      normalization_contract: NORMALIZATION_CONTRACT_VERSION,
      parcel_identifier_extension: PARCEL_IDENTIFIER_EXTENSION,
      parcel_identifier_scheme: NY_PARCEL_IDENTIFIER_SCHEME,
    },
    evidence,
  }];

  // -- parcel snapshot ------------------------------------------------------

  const parcelObservations: ParcelSnapshotObservation[] = [{
    observationId: parcelObservationId(ctx.snapshotId, evidence.sourceRecordId),
    snapshotId: ctx.snapshotId,
    sourceId: ctx.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    propertyId,
    changeKind: ctx.changeKind,
    contentDigest: contentDigest(record),
    changedFieldGroups: ctx.changedFieldGroups,
    sourceStatusCode: null,
    runId: evidence.runId,
    observedAt: evidence.observedAt,
  }];

  const property: Property = {
    propertyId,
    countyFips: record.countyFips,
    createdFromMethod: 'county_parcel_authoritative',
  };

  // -- events ---------------------------------------------------------------

  const events: CanonicalEvent[] = [{
    eventId: deterministicId('event', 'PARCEL_OBSERVED', propertyId, evidence.observedAt),
    eventType: 'PARCEL_OBSERVED',
    occurredAt: evidence.observedAt,
    subjectId: propertyId,
    payload: {
      countyFips: record.countyFips,
      source: 'state_aggregation',
      lineage: record.lineage,
      semantics: 'a municipal assessment-roll parcel (or NYC MapPLUTO lot), aggregated by NYS ITS Geospatial '
        + 'Services with ORPTS roll attributes. A parcel exists; nothing here says it sold, transferred, or is for sale.',
    },
    evidence,
  }];

  if (assessments.length > 0) {
    events.push({
      eventId: deterministicId('event', 'ASSESSMENT_OBSERVED', propertyId, String(rollYear ?? ''), evidence.observedAt),
      eventType: 'ASSESSMENT_OBSERVED',
      occurredAt: evidence.observedAt,
      subjectId: propertyId,
      payload: {
        rollYear,
        valueBasis,
        totalValueMinor: values.totalAssessed?.amountMinor ?? null,
      },
      evidence,
    });
  }

  for (const party of parties) {
    events.push({
      eventId: deterministicId('event', 'ASSESSOR_OWNER_OBSERVED', propertyId, party.observationId),
      eventType: 'ASSESSOR_OWNER_OBSERVED',
      occurredAt: evidence.observedAt,
      subjectId: propertyId,
      payload: {
        semantics: 'the assessment roll names this party. It says who is assessed, NOT who acquired the '
          + 'property, when, or for how much.',
      },
      evidence,
    });
  }

  return {
    bundle: {
      transaction: nonTransactionFor(record, propertyId, jurisdictionId, rollYear, evidence),
      parties,
      transactionParties: [],
      propertyIdentifiers: identifiers,
      transactionParcels: [],
      properties: [property],
      financing: [],
      events,
      assessments,
      characteristics,
      parcelObservations,
    },
    contacts,
  };
}

// ---------------------------------------------------------------------------

/** A parcel roll row is not a transaction. Placeholder, as every roll connector emits. */
function nonTransactionFor(
  record: NyStatewideParcelRecord,
  propertyId: string,
  jurisdictionId: string,
  rollYear: number | null,
  evidence: SourceEvidence,
): CanonicalBundle['transaction'] {
  return {
    transactionId: deterministicId('parcelroll', evidence.sourceId, evidence.sourceRecordId),
    sourceId: evidence.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId,
    countyFips: record.countyFips,
    transferDate: null,
    instrumentTypeCode: null,
    recordingDate: null,
    recordedDocumentNumber: null,
    conveyanceTypeCode: null,
    ownershipTypeCode: null,
    rightsRetainedCode: null,
    // Nothing in this source states a consideration, and nothing fills it.
    totalConsideration: null,
    downPayment: null,
    sellerPaidPoints: null,
    delinquentSpecialAssessmentsPaidByBuyer: null,
    personalPropertyIncludedInTotal: null,
    legalDescription: null,
    characteristics: {
      record_kind: 'parcel_roll_row',
      property_id: propertyId,
      swis: record.swis,
      sbl: record.sbl,
      roll_year: rollYear,
      sale_fields_in_source: false,
    },
    analyticalMetadata: {
      note:
        'A parcel roll row from the NYS Tax Parcel Centroid Points. The schema carries no sale date, sale price, '
        + 'mortgage or tax amount; its deed book/page is a reference, not a transfer. It is not a transfer source.',
    },
    evidence,
  };
}

type MoneyFacts = {
  readonly landAssessed: Money | null;
  readonly totalAssessed: Money | null;
  readonly fullMarket: Money | null;
  /** Fields whose published value the contract refused (e.g. sub-cent floats). */
  readonly invalid: readonly string[];
};

function moneyFacts(record: NyStatewideParcelRecord): MoneyFacts {
  const invalid: string[] = [];
  const read = (value: number | null, field: string): Money | null => {
    if (value === null) return null;
    // Through the contract's decimal-string path: the geodatabase stores
    // doubles, and a value must become exact cents or be refused, never rounded.
    const money = canonicalMoney(String(value), 'major_units');
    if (!money.present) {
      invalid.push(field);
      return null;
    }
    return { amountMinor: Number(money.amountMinor), currency: 'USD' };
  };
  return {
    landAssessed: read(record.landAssessedValue, 'LAND_AV'),
    totalAssessed: read(record.totalAssessedValue, 'TOTAL_AV'),
    fullMarket: read(record.fullMarketValue, 'FULL_MARKET_VAL'),
    invalid,
  };
}

/** The situs as the roll wrote it; assembled from its parts only when absent. */
function situsAddress(record: NyStatewideParcelRecord): string | null {
  if (record.parcelAddress !== null) return record.parcelAddress;
  const parts = [record.streetNumber, record.street, record.unit].filter((p): p is string => p !== null && p !== '');
  return parts.length === 0 ? null : parts.join(' ');
}

/** One restricted mailing string from its published parts, or null when there are none. */
function mailingString(m: NyMailing): string | null {
  const cityLine = [m.city, [m.state, m.zip].filter((p) => p !== null).join(' ')].filter((p) => p !== null && p !== '').join(', ');
  const parts = [m.street, m.poBox, cityLine].filter((p): p is string => p !== null && p !== '');
  return parts.length === 0 ? null : parts.join(', ');
}

/** Field groups, so a snapshot run can report WHAT kind of thing changed. */
export function nyStatewideFieldGroups(record: NyStatewideParcelRecord): Readonly<Record<string, string>> {
  return {
    identity: digest([record.countyFips, record.swis, record.sbl, record.printKey, record.muniParcelId]),
    address: digest([record.parcelAddress, record.streetNumber, record.street, record.unit, record.zip, record.municipalityName]),
    ownership: digest([
      record.primaryOwner, record.additionalOwner, record.ownerTypeCode, record.stateAgencyName,
      ...mailingParts(record.primaryMailing), ...mailingParts(record.additionalMailing),
    ]),
    assessment: digest([
      record.landAssessedValue, record.totalAssessedValue, record.fullMarketValue, record.propertyClass,
      record.rollSection, record.rollYear, record.schoolCode,
    ]),
    structure: digest([
      record.yearBuiltRaw, record.livingAreaSqFt, record.grossFloorArea, record.kitchens, record.fullBaths,
      record.bedrooms, record.buildingStyleCode, record.heatTypeCode, record.fuelTypeCode, record.sewerTypeCode,
      record.waterSupplyCode, record.utilitiesCode, record.usedAsCode,
    ]),
    geography: digest([
      record.frontFeet, record.depthFeet, record.assessedSquareFeet, record.assessedAcres, record.gisAcres,
      record.gridEast, record.gridNorth, record.agriculturalDistrictCode, record.duplicateGeometry ? 'Y' : '',
    ]),
    provenance: digest([record.spatialYear, record.deedBook, record.deedPage, record.stateAgencyNameSource]),
  };
}

function mailingParts(m: NyMailing): readonly (string | null)[] {
  return [m.street, m.poBox, m.city, m.state, m.zip];
}

function digest(values: readonly (string | number | null)[]): string {
  return deterministicId('fg', ...values.map((v) => (v === null ? '' : String(v))));
}
