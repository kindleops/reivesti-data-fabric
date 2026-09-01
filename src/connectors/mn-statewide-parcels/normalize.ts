/**
 * Minnesota statewide parcel record → canonical rows.
 *
 * ## The sale echo is not a sale
 *
 * This layer carries `sale_date` and `sale_value`, and the temptation to treat
 * them as transfer economics is exactly what this module refuses. Measured over
 * all 2,710,201 rows on 2026-08-31:
 *
 *   sale_date populated    1,019,065   37.6%
 *   sale_value populated   1,434,191   52.9%
 *   sale_value = 0           464,388   non-arm's-length transfers ARE included
 *   value with no date       415,126   a price not anchored to any moment
 *   sale_date range        1879-07-01 to **3009-12-30**
 *
 * A field whose maximum is the year 3009 contains data-entry errors. A field
 * that is empty on 62% of parcels is not a transfer record. And one row per
 * parcel means **only the latest sale exists** — there is no history here.
 *
 * So the canonical output is an `ASSESSOR_REPORTED_SALE_OBSERVATION`: the county
 * assessor said a sale happened, on a date they recorded, for an amount they
 * recorded. It is evidence. It is not eCRV, which is a filed declaration of
 * consideration with statutory backing, and nothing here may silently replace
 * it. No `PROPERTY_SALE_OBSERVED` and no `FINANCING_OBSERVED` are emitted.
 *
 * ## Mailing addresses
 *
 * Owner and taxpayer mailing lines are personal data and go to the restricted
 * plane. No canonical row here has a field that could hold one.
 */
import { deterministicId } from '../../core/hash.ts';
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
import { contentDigest } from '../../core/hash.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import type { MnStatewideParcelRecord } from './parse.ts';

/** What the runtime knows that the record does not. */
export type MnNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export const MN_STATEWIDE_NORMALIZATION_VERSION = 'mn_statewide_normalizer_1';

/**
 * A sale the county assessor reported on its parcel roll.
 *
 * Named at length on purpose. Every consumer that reads this has to be told, by
 * the type, that it is not a transfer record.
 */
export const ASSESSOR_SALE_KIND = 'ASSESSOR_REPORTED_SALE_OBSERVATION';

export type NormalizeResultRows = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

export function normalizeMnStatewideParcel(
  record: MnStatewideParcelRecord,
  evidence: SourceEvidence,
  ctx: MnNormalizeContext,
): NormalizeResultRows {
  const jurisdictionId = countyJurisdictionId(record.countyFips);
  const propertyId = propertyIdFromCountyParcel(record.countyFips, record.normalizedParcel);
  const situs = situsAddress(record);

  // -- identifiers ---------------------------------------------------------

  const identifierObservation: PropertyIdentifierObservation = {
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: record.countyPin,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    // The county's own roll republished by the state under a state standard.
    // The aggregation does not re-key parcels, so the identifier is final.
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  };
  const identifiers: PropertyIdentifierObservation[] = [identifierObservation];

  if (situs !== null) {
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'address', normalizeName(situs)),
      identifierType: 'normalized_address',
      value: situs,
      normalizedValue: normalizeName(situs),
      countyFips: record.countyFips,
      sourceDesignation: 'unspecified',
      finality: 'unknown',
      // An address is never an identity on its own: the same street address
      // exists in most of Minnesota's 87 counties.
      resolutionState: 'unresolved',
      propertyId: null,
      resolutionMethod: null,
      evidence,
    });
  }

  // -- parties. Names only. -------------------------------------------------

  const parties: PartyObservation[] = [];
  const contacts: ContactObservation[] = [];

  const addParty = (name: string, role: 'assessor_owner_of_record' | 'assessor_taxpayer', sourceRole: string, mailing: readonly string[]) => {
    const observationId = deterministicId('partyobs', ctx.sourceId, evidence.sourceRecordId, sourceRole);
    parties.push({
      observationId,
      // The roll does not say whether an owner is a person or a company, so
      // neither does the Fabric, however organisation-shaped the name looks.
      kind: 'unknown',
      role,
      sourceRole: `mn_statewide:${role}:${sourceRole}`,
      rawName: name,
      normalizedName: normalizeName(name),
      nameParts: { first: null, middle: null, last: null, suffix: null, organizationName: null },
      // Deliberately null: a mailing address is not the party's address on a
      // canonical row, and there is nowhere here to put one.
      address: null,
      foreignAddress: null,
      protectedIdentity: false,
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });
    for (const line of mailing) {
      contacts.push({
        contactObservationId: contactObservationId(ctx.sourceId, evidence.sourceRecordId, observationId, 'mailing_address', line),
        partyId: null,
        partyObservationId: observationId,
        contactType: 'mailing_address',
        value: line,
        sourceId: ctx.sourceId,
        sourceRecordId: evidence.sourceRecordId,
        observedAt: evidence.observedAt,
        confidence: 'source_stated',
        permittedUse: 'record_only',
        status: 'observed',
        evidence,
      });
    }
  };

  if (record.ownerName !== null) addParty(record.ownerName, 'assessor_owner_of_record', 'owner_name', record.ownerMailing);
  if (record.ownerMore !== null) addParty(record.ownerMore, 'assessor_owner_of_record', 'owner_more', []);
  if (record.taxpayerName !== null) addParty(record.taxpayerName, 'assessor_taxpayer', 'tax_name', record.taxpayerMailing);

  // -- assessment ----------------------------------------------------------

  const assessments: AssessmentObservation[] = [];
  if (record.emvTotal !== null || record.emvLand !== null || record.emvBuilding !== null) {
    assessments.push({
      observationId: deterministicId('assess', ctx.snapshotId, evidence.sourceRecordId, '1'),
      propertyId,
      countyFips: record.countyFips,
      normalizedParcel: record.normalizedParcel,
      snapshotId: ctx.snapshotId,
      // The statewide standard supplies mkt_year, which the direct Hennepin feed
      // does NOT. Where it is absent the year stays null rather than being
      // guessed from the snapshot date.
      assessmentYear: record.marketValueYear,
      tier: 1,
      propertyTypeCode: null,
      propertyTypeName: record.useClasses[0] ?? null,
      homesteadCode: record.homestead,
      landValue: money(record.emvLand),
      buildingValue: money(record.emvBuilding),
      machineryValue: null,
      totalValue: money(record.emvTotal),
      // The layer publishes no separate taxable value; tax capacity is the
      // Minnesota-specific analogue and is kept as itself rather than relabelled.
      taxableValue: null,
      netTaxCapacity: money(record.taxCapacity),
      netTax: money(record.totalTax),
      characteristics: {
        special_assessments_minor: record.specialAssessments === null ? null : record.specialAssessments * 100,
        tax_year: record.taxYear,
        use_classes: record.useClasses,
        exempt_use_classes: record.exemptUseClasses,
        tax_exempt: record.taxExempt,
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
    yearBuilt: record.yearBuilt,
    // The layer supplies acreage, not square feet. Converting would invent
    // precision the source does not have, so the acreage is kept as itself.
    parcelAreaSqFt: null,
    characteristics: {
      acres_polygon: record.acresPolygon,
      acres_deed: record.acresDeed,
      // ABSENT from the direct Hennepin feed. A concrete gain from the standard.
      finished_square_feet: record.finishedSquareFeet,
      dwelling_type: record.dwellingType,
      home_style: record.homeStyle,
      number_of_units: record.numberOfUnits,
      garage: record.garage,
      garage_square_feet: record.garageSquareFeet,
      basement: record.basement,
      heating: record.heating,
      cooling: record.cooling,
      situs_address: situs,
      school_district: record.schoolDistrict,
      watershed_district: record.watershedDistrict,
      ctu_name: record.ctuName,
      legal_lot: record.lot,
      legal_block: record.block,
      plat_name: record.platName,
      abbreviated_legal: record.abbreviatedLegal,
      ownership_type: record.ownershipType,
      homestead: record.homestead,
      // Retained and explicitly NOT interpreted. See the module header: this is
      // the assessor's echo of a last sale, not a transfer record.
      assessor_sale_kind: record.saleDate !== null || record.saleValue !== null ? ASSESSOR_SALE_KIND : null,
      assessor_sale_date: record.saleDate,
      assessor_sale_value_minor: record.saleValue === null ? null : record.saleValue * 100,
      source_edit_date: record.editDate,
      source_export_date: record.exportDate,
      source_object_id: record.sourceObjectId,
      source_state_pin: record.statePin,
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
      semantics: 'the county roll, republished by the state under the MnGAC standard. A parcel exists; '
        + 'nothing here says it sold, transferred, or is for sale.',
    },
    evidence,
  }];

  if (assessments.length > 0) {
    events.push({
      eventId: deterministicId('event', 'ASSESSMENT_OBSERVED', propertyId, String(record.marketValueYear ?? ''), evidence.observedAt),
      eventType: 'ASSESSMENT_OBSERVED',
      occurredAt: evidence.observedAt,
      subjectId: propertyId,
      payload: { marketValueYear: record.marketValueYear, totalValue: record.emvTotal },
      evidence,
    });
  }

  for (const party of parties) {
    if (party.role !== 'assessor_owner_of_record') continue;
    events.push({
      eventId: deterministicId('event', 'ASSESSOR_OWNER_OBSERVED', propertyId, party.observationId),
      eventType: 'ASSESSOR_OWNER_OBSERVED',
      occurredAt: evidence.observedAt,
      subjectId: propertyId,
      payload: {
        semantics: 'the assessor roll names this party. It says who is assessed, NOT who acquired the '
          + 'property or when.',
      },
      evidence,
    });
  }

  return {
    bundle: {
      transaction: nonTransactionFor(record, propertyId, jurisdictionId, evidence),
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

/**
 * A parcel roll row is not a transaction.
 *
 * The bundle's transaction slot carries an explicit non-transaction placeholder,
 * exactly as the assessor, recorder and business-register connectors do. The
 * assessor-reported sale echo rides in `characteristics` where it is clearly
 * labelled, and NOT in `totalConsideration`, which is reserved for a source that
 * actually states consideration.
 */
function nonTransactionFor(
  record: MnStatewideParcelRecord,
  propertyId: string,
  jurisdictionId: string,
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
    // Null, and the sale echo below does not fill it. An assessor's recollection
    // of a price is not a stated consideration.
    totalConsideration: null,
    downPayment: null,
    sellerPaidPoints: null,
    delinquentSpecialAssessmentsPaidByBuyer: null,
    personalPropertyIncludedInTotal: null,
    legalDescription: record.abbreviatedLegal,
    characteristics: {
      record_kind: 'parcel_roll_row',
      property_id: propertyId,
      county_pin: record.countyPin,
      tax_year: record.taxYear,
      market_value_year: record.marketValueYear,
      // The sale echo, labelled for what it is.
      assessor_sale_kind: record.saleDate !== null || record.saleValue !== null ? ASSESSOR_SALE_KIND : null,
      assessor_sale_date: record.saleDate,
      assessor_sale_value: record.saleValue,
    },
    analyticalMetadata: {
      note:
        'A parcel roll row from the Minnesota statewide aggregation. sale_date and sale_value are the '
        + 'ASSESSOR\'S report of the latest sale — present on a minority of parcels, including '
        + 'zero-consideration transfers, with no history and with dates that reach the year 3009. They are '
        + 'observations, not transfer economics, and they do not replace eCRV.',
    },
    evidence,
  };
}

function money(value: number | null): Money | null {
  if (value === null) return null;
  return { amountMinor: Math.round(value * 100), currency: 'USD' };
}

/** Situs address assembled from the standard's components, in order. */
function situsAddress(record: MnStatewideParcelRecord): string | null {
  const parts = [
    record.houseNumberPrefix,
    record.houseNumber === null ? null : String(record.houseNumber),
    record.houseNumberSuffix,
    record.streetPreDirection,
    record.streetPreType,
    record.streetName,
    record.streetPostType,
    record.streetPostDirection,
    record.unitType,
    record.unitId,
  ].filter((p): p is string => p !== null && p !== '');
  if (parts.length === 0) return null;
  const street = parts.join(' ');
  const city = record.ctuName ?? record.postalCommunity;
  return city === null ? street : `${street}, ${city}`;
}

/** Field groups, so a snapshot run can report WHAT kind of thing changed. */
export function mnStatewideFieldGroups(record: MnStatewideParcelRecord): Readonly<Record<string, string>> {
  return {
    identity: digest([record.countyFips, record.countyPin, record.statePin]),
    address: digest([
      record.houseNumber, record.streetName, record.streetPostType, record.streetPreDirection,
      record.unitId, record.zip, record.ctuName,
    ]),
    ownership: digest([record.ownerName, record.ownerMore, record.taxpayerName, record.homestead, record.ownershipType]),
    assessment: digest([record.emvLand, record.emvBuilding, record.emvTotal, record.marketValueYear, ...record.useClasses]),
    structure: digest([record.yearBuilt, record.finishedSquareFeet, record.dwellingType, record.numberOfUnits]),
    tax: digest([record.taxYear, record.totalTax, record.specialAssessments, record.taxCapacity]),
    sale: digest([record.saleDate, record.saleValue]),
    legal: digest([record.lot, record.block, record.platName, record.abbreviatedLegal]),
  };
}

function digest(values: readonly (string | number | null)[]): string {
  return deterministicId('fg', ...values.map((v) => (v === null ? '' : String(v))));
}
