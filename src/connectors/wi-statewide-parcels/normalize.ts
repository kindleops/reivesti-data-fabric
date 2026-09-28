/**
 * Wisconsin statewide parcel record → canonical rows.
 *
 * Everything the contract already knows how to say is said through it —
 * money, dates, areas, addresses, identifiers — and nothing Wisconsin-specific
 * is invented in its place. What the adapter contributes is knowledge only a
 * reader of this layer has:
 *
 * - **Two value types, never one slot.** CNTASSDVALUE is ASSESSED value, at the
 *   municipality's own assessment ratio. ESTFMKVALUE is ESTIMATED FAIR MARKET
 *   value. They are different facts and are stored as different facts; the
 *   assessed figure is `totalValue`, the market estimate rides beside it.
 * - **Two taxes, never one slot.** NETPRPTA is net of state credits; GRSPRPTA is
 *   gross. `netTax` is the net figure and the gross is kept separately.
 * - **The roll year is the time axis.** Every value on a row belongs to its
 *   TAXROLLYEAR. That year is carried on the assessment observation, so a 2025
 *   roll and a 2026 roll are two observations of two years, never a conflict.
 * - **No sale echo exists.** Unlike Minnesota's standard, Wisconsin's schema has
 *   no sale date and no sale price. No `ASSESSOR_REPORTED_SALE_OBSERVATION` is
 *   emitted, and no transfer, deed or mortgage fact of any kind.
 * - **The mailing address is restricted.** PSTLADRESS goes to the restricted
 *   plane and nowhere else.
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
  canonicalArea,
  canonicalDate,
  canonicalMoney,
} from '../../canonical/normalization-contract.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { WI_PARCEL_IDENTIFIER_SCHEME } from './identity.ts';
import type { WiStatewideParcelRecord } from './parse.ts';

export type WiNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export const WI_STATEWIDE_NORMALIZATION_VERSION = 'wi_statewide_normalizer_1';

export type WiNormalizeResultRows = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

const DIRECTIONAL_TOKENS: ReadonlySet<string> = new Set([
  'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'NORTH', 'SOUTH', 'EAST', 'WEST',
  'NORTHEAST', 'NORTHWEST', 'SOUTHEAST', 'SOUTHWEST',
]);

/** A roll year the contract can use as a time axis. Anything else stays null. */
export function rollYearOf(raw: string | null): number | null {
  if (raw === null || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1990 && year <= 2100 ? year : null;
}

export function normalizeWiStatewideParcel(
  record: WiStatewideParcelRecord,
  evidence: SourceEvidence,
  ctx: WiNormalizeContext,
): WiNormalizeResultRows {
  const jurisdictionId = countyJurisdictionId(record.countyFips);
  // The same function every county-parcel source uses; see identity.ts.
  const propertyId = propertyIdFromCountyParcel(record.countyFips, record.normalizedParcel);
  const situs = situsAddress(record);
  const rollYear = rollYearOf(record.taxRollYear);
  const values = moneyFacts(record);

  // -- identifiers ---------------------------------------------------------

  const identifiers: PropertyIdentifierObservation[] = [{
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: record.parcelId,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    // The county's roll, aggregated by the state without re-keying.
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  }];

  if (record.taxParcelId !== null) {
    // The same row states both ids, so the tax id is attached to this property.
    // It is never a join key: `source_property_key` does not participate in
    // resolution, which is correct for an identifier only some counties keep.
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'tax_parcel'),
      identifierType: 'source_property_key',
      value: record.taxParcelId,
      normalizedValue: record.taxParcelId.toUpperCase(),
      countyFips: record.countyFips,
      sourceDesignation: 'secondary',
      finality: 'final',
      resolutionState: 'resolved',
      propertyId,
      resolutionMethod: 'same_source_row',
      evidence,
    });
  }

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
  const addOwner = (name: string, sourceRole: 'OWNERNME1' | 'OWNERNME2'): string => {
    const observationId = deterministicId('partyobs', ctx.sourceId, evidence.sourceRecordId, sourceRole);
    parties.push({
      observationId,
      // The roll does not say whether an owner is a person or a company, so
      // neither does the Fabric. The same name on two parcels is not evidence
      // of one party: resolution stays `unresolved`, and nothing here merges.
      kind: 'unknown',
      role: 'assessor_owner_of_record',
      sourceRole: `wi_statewide:assessor_owner_of_record:${sourceRole}`,
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
  const primary = record.ownerName1 !== null ? addOwner(record.ownerName1, 'OWNERNME1') : null;
  if (record.ownerName2 !== null) addOwner(record.ownerName2, 'OWNERNME2');

  if (record.mailingAddress !== null) {
    // Attached to the primary owner where there is one. Where the roll names no
    // owner, the address still belongs to the record and is kept — restricted —
    // rather than dropped or pinned on a party nobody named.
    contacts.push({
      contactObservationId: contactObservationId(ctx.sourceId, evidence.sourceRecordId, primary, 'mailing_address', record.mailingAddress),
      partyId: null,
      partyObservationId: primary,
      contactType: 'mailing_address',
      value: record.mailingAddress,
      sourceId: ctx.sourceId,
      sourceRecordId: evidence.sourceRecordId,
      observedAt: evidence.observedAt,
      confidence: 'source_stated',
      permittedUse: 'record_only',
      status: 'observed',
      evidence,
    });
  }

  // -- assessment ----------------------------------------------------------

  const assessments: AssessmentObservation[] = [];
  if (values.assessedTotal !== null || values.assessedLand !== null || values.assessedImprovements !== null
    || values.estimatedFairMarket !== null || values.netTax !== null) {
    assessments.push({
      observationId: deterministicId('assess', ctx.snapshotId, evidence.sourceRecordId, '1'),
      propertyId,
      countyFips: record.countyFips,
      normalizedParcel: record.normalizedParcel,
      snapshotId: ctx.snapshotId,
      // The roll the values come from. Null when the roll year is blank or not
      // a year — never guessed from the release year.
      assessmentYear: rollYear,
      tier: 1,
      propertyTypeCode: record.propertyClassRaw,
      propertyTypeName: null,
      homesteadCode: null,
      landValue: values.assessedLand,
      buildingValue: values.assessedImprovements,
      machineryValue: null,
      // ASSESSED, at the municipality's ratio. Market estimate is separate.
      totalValue: values.assessedTotal,
      taxableValue: null,
      netTaxCapacity: null,
      netTax: values.netTax,
      characteristics: {
        value_basis: 'assessed_at_municipal_ratio',
        tax_roll_year: rollYear,
        tax_roll_year_raw: record.taxRollYear,
        estimated_fair_market_value_minor: values.estimatedFairMarket?.amountMinor ?? null,
        managed_forest_value_minor: values.managedForest?.amountMinor ?? null,
        gross_tax_minor: values.grossTax?.amountMinor ?? null,
        property_classes: record.propertyClasses,
        auxiliary_classes: record.auxiliaryClasses,
        invalid_money_fields: values.invalid,
      },
      evidence,
    });
  }

  // -- characteristics ------------------------------------------------------

  const characteristics: PropertyCharacteristicObservation[] = [{
    observationId: deterministicId('charobs', ctx.snapshotId, evidence.sourceRecordId),
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    snapshotId: ctx.snapshotId,
    // Not in the V12 schema. Null because the source does not say, not because
    // the answer is unknown to the county.
    yearBuilt: null,
    parcelAreaSqFt: null,
    characteristics: {
      assessed_acres: record.assessedAcres,
      deeded_acres: record.deededAcres,
      gis_acres: record.gisAcres,
      situs_address: situs,
      ...canonicalFacts(record, rollYear),
      latitude: record.latitude,
      longitude: record.longitude,
      coordinate_kind: record.latitude !== null ? 'source_centroid' : null,
      municipality: record.placeName,
      school_district: record.schoolDistrict,
      school_district_number: record.schoolDistrictNumber,
      property_classes: record.propertyClasses,
      auxiliary_classes: record.auxiliaryClasses,
      tax_roll_year: rollYear,
      // No sale fields exist in this schema. Stated, so an empty value is not
      // mistaken for "no sale".
      sale_fields_in_source: false,
      source_parcel_date_raw: record.parcelDate,
      source_load_date_raw: record.loadDate,
      source_object_id: record.sourceObjectId,
      source_state_id: record.stateId,
      source_submitting_county_fips: record.submittingCountyFips,
      source_submitting_county_code: record.submittingCountyCode,
      source_submitting_jurisdiction: record.submittingSource,
      cross_county_submission: record.crossCountySubmission,
      parcel_match_key: record.matchKey,
      normalization_contract: NORMALIZATION_CONTRACT_VERSION,
      parcel_identifier_extension: PARCEL_IDENTIFIER_EXTENSION,
      parcel_identifier_scheme: WI_PARCEL_IDENTIFIER_SCHEME,
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
      semantics: 'a county or municipal parcel roll, aggregated by the Wisconsin State Cartographer\'s Office. '
        + 'A parcel exists; nothing here says it sold, transferred, or is for sale.',
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
        taxRollYear: rollYear,
        valueBasis: 'assessed_at_municipal_ratio',
        totalValueMinor: values.assessedTotal?.amountMinor ?? null,
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
        semantics: 'the parcel roll names this party. It says who is assessed, NOT who acquired the '
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
  record: WiStatewideParcelRecord,
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
      parcel_id: record.parcelId,
      tax_roll_year: rollYear,
      sale_fields_in_source: false,
    },
    analyticalMetadata: {
      note:
        'A parcel roll row from the Wisconsin Statewide Parcel Map. The schema carries no sale date, sale price, '
        + 'deed or mortgage field. It is not a transfer source, and Wisconsin transfer coverage remains a gap '
        + 'until an automated RETR distribution exists.',
    },
    evidence,
  };
}

type MoneyFacts = {
  readonly assessedTotal: Money | null;
  readonly assessedLand: Money | null;
  readonly assessedImprovements: Money | null;
  readonly estimatedFairMarket: Money | null;
  readonly managedForest: Money | null;
  readonly netTax: Money | null;
  readonly grossTax: Money | null;
  /** Fields whose published value the contract refused (e.g. sub-cent floats). */
  readonly invalid: readonly string[];
};

function moneyFacts(record: WiStatewideParcelRecord): MoneyFacts {
  const invalid: string[] = [];
  const read = (value: number | null, field: string): Money | null => {
    if (value === null) return null;
    // Through the contract's decimal-string path: the geodatabase stores
    // doubles, and 1097.67 must be 109767 cents, not 109766.99999.
    const money = canonicalMoney(String(value), 'major_units');
    if (!money.present) {
      invalid.push(field);
      return null;
    }
    return { amountMinor: Number(money.amountMinor), currency: 'USD' };
  };
  return {
    assessedTotal: read(record.assessedTotal, 'CNTASSDVALUE'),
    assessedLand: read(record.assessedLand, 'LNDVALUE'),
    assessedImprovements: read(record.assessedImprovements, 'IMPVALUE'),
    estimatedFairMarket: read(record.estimatedFairMarketValue, 'ESTFMKVALUE'),
    managedForest: read(record.managedForestValue, 'MFLVALUE'),
    netTax: read(record.netTax, 'NETPRPTA'),
    grossTax: read(record.grossTax, 'GRSPRPTA'),
    invalid,
  };
}

/** Contract-governed values: the comparison surface for any future overlap. */
function canonicalFacts(record: WiStatewideParcelRecord, rollYear: number | null): Readonly<Record<string, unknown>> {
  const area = canonicalArea(record.deededAcres, 'acres');
  const prefix = record.streetPrefix?.toUpperCase() ?? null;
  const address = canonicalAddress({
    houseNumber: record.addressNumber,
    houseNumberPrefix: record.addressNumberPrefix,
    houseNumberSuffix: record.addressNumberSuffix,
    // PREFIX carries either a directional or a pre-type. Only a reader of
    // this layer knows that, so the adapter splits it.
    preDirectional: prefix !== null && DIRECTIONAL_TOKENS.has(prefix) ? record.streetPrefix : null,
    preType: prefix !== null && !DIRECTIONAL_TOKENS.has(prefix) ? record.streetPrefix : null,
    streetName: record.streetName,
    postType: record.streetType,
    postDirectional: record.streetSuffix,
    unitType: record.unitType,
    unitId: record.unitId,
    city: null,
    state: record.state ?? 'WI',
    postalCode: record.zip,
    postalCodeExtension: record.zip4,
  });
  const loadDate = canonicalDate(record.loadDate, 'SOURCE_ACQUISITION_DATE');
  const netTax = canonicalMoney(record.netTax === null ? null : String(record.netTax), 'major_units');
  const assessed = canonicalMoney(record.assessedTotal === null ? null : String(record.assessedTotal), 'major_units');

  return {
    canonical_area_square_feet: area.present ? area.squareFeet : null,
    canonical_area_source_unit: area.present ? area.sourceUnit : null,
    canonical_area_source_value: area.present ? area.sourceValue : null,
    canonical_area_source_field: area.present ? 'DEEDACRES' : null,
    canonical_area_absent_reason: area.present ? null : area.reason,
    canonical_address_key: address.present ? address.comparisonKey : null,
    canonical_tax_total_minor: netTax.present ? netTax.amountMinor.toString() : null,
    canonical_tax_basis: netTax.present ? 'net_after_credits' : null,
    canonical_assessed_total_minor: assessed.present ? assessed.amountMinor.toString() : null,
    canonical_tax_year: rollYear,
    canonical_source_load_date: loadDate.present ? loadDate.date : null,
  };
}

/** The situs as the county wrote it; assembled from components only when absent. */
function situsAddress(record: WiStatewideParcelRecord): string | null {
  if (record.siteAddress !== null) return record.siteAddress;
  const parts = [
    record.addressNumberPrefix, record.addressNumber, record.addressNumberSuffix, record.streetPrefix,
    record.streetName, record.streetType, record.streetSuffix, record.unitType, record.unitId,
  ].filter((p): p is string => p !== null && p !== '');
  return parts.length === 0 ? null : parts.join(' ');
}

/** Field groups, so a snapshot run can report WHAT kind of thing changed. */
export function wiStatewideFieldGroups(record: WiStatewideParcelRecord): Readonly<Record<string, string>> {
  return {
    identity: digest([record.countyFips, record.parcelId, record.taxParcelId, record.stateId]),
    address: digest([
      record.siteAddress, record.addressNumber, record.streetPrefix, record.streetName, record.streetType,
      record.streetSuffix, record.unitId, record.zip, record.placeName,
    ]),
    ownership: digest([record.ownerName1, record.ownerName2]),
    assessment: digest([
      record.assessedTotal, record.assessedLand, record.assessedImprovements, record.estimatedFairMarketValue,
      record.managedForestValue, record.propertyClassRaw, record.auxiliaryClassRaw, record.taxRollYear,
    ]),
    tax: digest([record.netTax, record.grossTax, record.taxRollYear]),
    geography: digest([record.assessedAcres, record.deededAcres, record.gisAcres, record.latitude, record.longitude]),
    provenance: digest([record.loadDate, record.parcelDate, record.submittingCountyCode, record.submittingSource]),
  };
}

function digest(values: readonly (string | number | null)[]): string {
  return deterministicId('fg', ...values.map((v) => (v === null ? '' : String(v))));
}
