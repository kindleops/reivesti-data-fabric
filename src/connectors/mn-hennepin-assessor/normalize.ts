/**
 * Hennepin assessor roll to canonical.
 *
 * What this file refuses to do:
 *
 *  - It never emits a sale. The roll echoes SALE_DATE and SALE_PRICE, but a tax
 *    roll is not a transfer record: eCRV is authoritative for what was conveyed,
 *    for how much, and on what terms. Deriving a transfer here would create a
 *    second, weaker account of the same event.
 *  - It never claims ownership was *acquired*. `OWNER_NM` is who the roll shows
 *    today. When they became the owner, and by what instrument, is DF-0D's
 *    question. The role is `assessor_owner_of_record`, and the event is
 *    `ASSESSOR_OWNER_OBSERVED`, precisely so the limit is legible.
 *  - It never merges parties. Same name on two parcels is two observations.
 *  - It never treats `HMSTD_CD` as a residency fact. It is a tax classification.
 *  - It never overwrites an assessment. Every value is an observation carrying
 *    the snapshot it came from.
 *
 * What it does that eCRV could not: it supplies an AUTHORITATIVE parcel
 * identifier, which is what promotes a property from provisional to resolved.
 */
import {
  type AssessmentObservation,
  type CanonicalBundle,
  type CanonicalEvent,
  type PartyObservation,
  type PropertyCharacteristicObservation,
  type PropertyIdentifierObservation,
  type Property,
  type SourceEvidence,
  normalizeName,
  propertyIdFromCountyParcel,
  usd,
} from '../../canonical/models.ts';
import {
  type ParcelSnapshotObservation,
  type SnapshotChangeKind,
  parcelObservationId,
} from '../../canonical/snapshot.ts';
import {
  type ContactObservation,
  contactObservationId,
} from '../../contact/contact-plane.ts';
import { contentDigest, deterministicId } from '../../core/hash.ts';
import { canonicalAddress } from '../../canonical/address.ts';
import {
  NORMALIZATION_CONTRACT_VERSION,
  canonicalArea,
  canonicalDate,
  canonicalMoney,
} from '../../canonical/normalization-contract.ts';
import { splitPackedStreet } from './street.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import type { HennepinParcelRecord } from './record.ts';

/**
 * Bumped in DF-0I: canonical output now carries contract-governed area, address
 * and date representations. The change is deliberate, so it must be visible as a
 * version rather than as an unexplained digest difference.
 */
export const HENNEPIN_NORMALIZATION_VERSION = 'mn_hennepin_norm_2';

export type HennepinNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export type HennepinNormalizeOutput = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

export function normalizeHennepinParcel(
  record: HennepinParcelRecord,
  evidence: SourceEvidence,
  ctx: HennepinNormalizeContext,
): HennepinNormalizeOutput {
  const { countyFips, normalizedParcel } = record;
  const propertyId = propertyIdFromCountyParcel(countyFips, normalizedParcel);
  const jurisdictionId = countyJurisdictionId(countyFips);

  // --- parcel identity ------------------------------------------------------
  // This is the whole point of DF-0C. The county assigns the PID, so this
  // observation is `final` and `resolved` where eCRV's is `preliminary` and
  // `provisional`. The property id itself is a pure function of
  // (county, parcel), so both sources compute the same one independently.
  const identifierObservation: PropertyIdentifierObservation = {
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'parcel', '1', normalizedParcel),
    identifierType: 'county_parcel',
    value: record.pid,
    normalizedValue: normalizedParcel,
    countyFips,
    sourceDesignation: 'primary',
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  };

  const identifiers: PropertyIdentifierObservation[] = [identifierObservation];

  // The situs address is retained as evidence and resolves nothing, exactly as
  // in eCRV. A parcel flagged MULTI_ADDR_IND makes the reason obvious.
  const situsText = formatSitus(record);
  if (situsText !== null) {
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'address', '1', normalizeName(situsText)),
      identifierType: 'normalized_address',
      value: situsText,
      normalizedValue: normalizeName(situsText),
      countyFips,
      sourceDesignation: 'unspecified',
      finality: 'unknown',
      resolutionState: 'unresolved',
      propertyId: null,
      resolutionMethod: null,
      evidence,
    });
  }

  const property: Property = {
    propertyId,
    countyFips,
    createdFromMethod: 'county_parcel_authoritative',
  };

  // --- parties --------------------------------------------------------------
  const parties: PartyObservation[] = [];
  const addParty = (
    role: 'assessor_owner_of_record' | 'assessor_taxpayer',
    rawName: string | null,
    note: string,
  ): void => {
    if (rawName === null) return;
    parties.push({
      observationId: deterministicId('partyobs', ctx.sourceId, evidence.sourceRecordId, role),
      // The roll does not classify person vs organisation, and inferring it from
      // the shape of a name is exactly the guess this layer will not make.
      kind: 'unknown',
      role,
      sourceRole: `hennepin:${role}:${note}`,
      rawName,
      normalizedName: normalizeName(rawName),
      nameParts: { first: null, middle: null, last: null, suffix: null, organizationName: null },
      // Mailing address is personal and lives in the restricted plane, not here.
      address: null,
      foreignAddress: null,
      protectedIdentity: false,
      // Same name on two parcels is not evidence of the same party.
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });
  };
  addParty('assessor_owner_of_record', record.ownerName, 'OWNER_NM');
  addParty('assessor_taxpayer', record.taxpayerNameLine, 'TAXPAYER_NM-line1');

  // --- assessment observations ---------------------------------------------
  const assessments: AssessmentObservation[] = record.tiers.map((tier) => ({
    observationId: deterministicId('assess', ctx.snapshotId, evidence.sourceRecordId, String(tier.tier)),
    propertyId,
    countyFips,
    normalizedParcel,
    snapshotId: ctx.snapshotId,
    // The layer publishes no assessment year. Recording null is honest;
    // inferring it from the capture date would fabricate a fact.
    assessmentYear: null,
    tier: tier.tier,
    propertyTypeCode: tier.propertyTypeCode,
    propertyTypeName: tier.propertyTypeName,
    // A tax classification, never read as "somebody lives there".
    homesteadCode: tier.homesteadCode,
    landValue: money(tier.landValueMinor),
    buildingValue: money(tier.buildingValueMinor),
    machineryValue: money(tier.machineryValueMinor),
    totalValue: money(tier.totalValueMinor),
    taxableValue: tier.tier === 1 ? money(record.taxableValueTotalMinor) : null,
    netTaxCapacity: money(tier.netTaxCapacityMinor),
    netTax: money(tier.netTaxMinor),
    characteristics: {
      owner_percent: tier.ownerPercent,
      contiguous: tier.contiguousIndicator,
      qualifying_improvement_minor: tier.qualifyingImprovementMinor,
      veteran_exclusion_minor: tier.veteranExclusionMinor,
      homestead_exclusion_minor: tier.homesteadExclusionMinor,
      ...(tier.tier === 1
        ? {
          parcel_market_value_total_minor: record.marketValueTotalMinor,
          net_improvement_minor: record.attributes['net_improvement'] ?? null,
          total_net_tax_minor: record.attributes['total_net_tax'] ?? null,
          total_special_tax_minor: record.attributes['total_special_tax'] ?? null,
          tax_total_minor: record.attributes['tax_total'] ?? null,
          net_tax_paid_minor: record.attributes['net_tax_paid'] ?? null,
          total_penalty_paid_minor: record.attributes['total_penalty_paid'] ?? null,
          earliest_delinquent_year: record.attributes['earliest_delinquent_year'] ?? null,
        }
        : {}),
    },
    evidence,
  }));

  // --- characteristics ------------------------------------------------------
  const characteristics: PropertyCharacteristicObservation[] = [{
    observationId: deterministicId('charobs', ctx.snapshotId, evidence.sourceRecordId),
    propertyId,
    countyFips,
    normalizedParcel,
    snapshotId: ctx.snapshotId,
    yearBuilt: record.yearBuilt,
    parcelAreaSqFt: record.parcelAreaSqFt,
    characteristics: {
      legal_description: record.legalDescription,
      property_status_code: record.propertyStatusCode,
      situs_address: situsText,
      // Canonical, contract-governed representations. DF-0H compared assembled
      // display strings and concluded two sources disagreed about every Hennepin
      // address; they did not, and these are the surface that shows it.
      ...canonicalFacts(record),
      ...record.geography,
      ...record.attributes,
      // Retained, explicitly not interpreted: the assessor's echo of a last
      // sale is not a transfer record.
      assessor_last_sale_date: record.lastSale.date,
      assessor_last_sale_price_minor: record.lastSale.priceMinor,
      assessor_last_sale_code: record.lastSale.code,
      assessor_last_sale_code_name: record.lastSale.codeName,
    },
    evidence,
  }];

  // --- snapshot observation -------------------------------------------------
  const parcelObservation: ParcelSnapshotObservation = {
    observationId: parcelObservationId(ctx.snapshotId, evidence.sourceRecordId),
    snapshotId: ctx.snapshotId,
    sourceId: ctx.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    countyFips,
    normalizedParcel,
    propertyId,
    changeKind: ctx.changeKind,
    contentDigest: contentDigest(record),
    changedFieldGroups: ctx.changedFieldGroups,
    sourceStatusCode: record.propertyStatusCode,
    runId: evidence.runId,
    observedAt: evidence.observedAt,
  };

  // --- events ---------------------------------------------------------------
  const events: CanonicalEvent[] = [];
  const eventId = (type: string, subject: string): string =>
    deterministicId('evt', type, subject, evidence.sourceRecordId, evidence.rawRecordHash);

  events.push({
    eventId: eventId('PARCEL_OBSERVED', propertyId),
    eventType: 'PARCEL_OBSERVED',
    // A snapshot has no per-row event time; the observation time is the run's.
    occurredAt: null,
    subjectId: propertyId,
    payload: {
      countyFips,
      pid: record.pid,
      propertyStatusCode: record.propertyStatusCode,
      snapshotId: ctx.snapshotId,
    },
    evidence,
  });

  // Emitted by the authoritative source only: this is the promotion signal.
  events.push({
    eventId: eventId('PARCEL_RESOLVED', propertyId),
    eventType: 'PARCEL_RESOLVED',
    occurredAt: null,
    subjectId: propertyId,
    payload: {
      countyFips,
      normalizedParcel,
      method: 'county_parcel_authoritative',
      authoritativeSourceId: ctx.sourceId,
      identifierObservationId: identifierObservation.observationId,
    },
    evidence,
  });

  if (ctx.changeKind === 'parcel_attributes_changed' && ctx.changedFieldGroups.length > 0) {
    events.push({
      eventId: eventId('PARCEL_ATTRIBUTES_CHANGED', propertyId),
      eventType: 'PARCEL_ATTRIBUTES_CHANGED',
      occurredAt: null,
      subjectId: propertyId,
      payload: { countyFips, changedFieldGroups: ctx.changedFieldGroups, snapshotId: ctx.snapshotId },
      evidence,
    });
  }

  for (const party of parties) {
    events.push({
      eventId: eventId('ASSESSOR_OWNER_OBSERVED', party.observationId),
      eventType: 'ASSESSOR_OWNER_OBSERVED',
      occurredAt: null,
      subjectId: party.observationId,
      payload: {
        propertyId,
        role: party.role,
        // Named so nothing downstream can mistake this for an acquisition.
        semantics: 'assessor roll observation; not a deed-derived ownership history',
        snapshotId: ctx.snapshotId,
      },
      evidence,
    });
  }

  if (assessments.length > 0) {
    events.push({
      eventId: eventId('ASSESSMENT_OBSERVED', propertyId),
      eventType: 'ASSESSMENT_OBSERVED',
      occurredAt: null,
      subjectId: propertyId,
      payload: {
        countyFips,
        tiers: assessments.length,
        totalValueMinor: assessments[0]?.totalValue?.amountMinor ?? null,
        assessmentYear: null,
        snapshotId: ctx.snapshotId,
      },
      evidence,
    });
  }

  events.push({
    eventId: eventId('PROPERTY_CHARACTERISTICS_OBSERVED', propertyId),
    eventType: 'PROPERTY_CHARACTERISTICS_OBSERVED',
    occurredAt: null,
    subjectId: propertyId,
    payload: { countyFips, yearBuilt: record.yearBuilt, parcelAreaSqFt: record.parcelAreaSqFt, snapshotId: ctx.snapshotId },
    evidence,
  });

  // --- restricted plane -----------------------------------------------------
  const contacts = extractContacts(record, parties, evidence, ctx.sourceId);

  return {
    bundle: {
      // A parcel row is not a transaction. The transaction slots that eCRV fills
      // stay empty here rather than being populated with a plausible fiction.
      transaction: emptyTransactionFor(propertyId, jurisdictionId, countyFips, evidence),
      parties,
      transactionParties: [],
      propertyIdentifiers: identifiers,
      transactionParcels: [],
      properties: [property],
      financing: [],
      events,
      assessments,
      characteristics,
      parcelObservations: [parcelObservation],
    },
    contacts,
  };
}

// ---------------------------------------------------------------------------

/**
 * A snapshot bundle has no transaction. Rather than make `transaction` optional
 * — which would force every existing consumer to handle a null it never sees
 * from a transfer source — a parcel bundle carries an explicitly non-transaction
 * placeholder whose `sourceRecordId` is the parcel and whose consideration and
 * dates are null. `instrumentTypeCode: null` and an empty party list make it
 * unmistakable that nothing was conveyed.
 */
function emptyTransactionFor(
  propertyId: string,
  jurisdictionId: string,
  countyFips: string,
  evidence: SourceEvidence,
): CanonicalBundle['transaction'] {
  return {
    transactionId: deterministicId('parcelrec', evidence.sourceId, evidence.sourceRecordId),
    sourceId: evidence.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId,
    countyFips,
    transferDate: null,
    instrumentTypeCode: null,
    totalConsideration: null,
    downPayment: null,
    sellerPaidPoints: null,
    delinquentSpecialAssessmentsPaidByBuyer: null,
    personalPropertyIncludedInTotal: null,
    legalDescription: null,
    characteristics: { record_kind: 'parcel_snapshot', property_id: propertyId },
    analyticalMetadata: {
      note: 'assessor snapshot row; carries no transfer. Transfer evidence comes from eCRV (DF-0B) and recorded instruments (DF-0D).',
    },
    evidence,
  };
}

/**
 * Contract-governed values for the fields two sources actually compare on.
 *
 * The adapter has already read Hennepin's layer and knows what its columns mean;
 * this hands those meanings to the contract in its representation.
 */
function canonicalFacts(record: HennepinParcelRecord): Readonly<Record<string, unknown>> {
  // Hennepin publishes PARCEL_AREA in square feet. MnGeo publishes acres for the
  // same parcels; the contract puts both in square feet so they compare.
  const area = canonicalArea(record.parcelAreaSqFt, 'square_feet');
  // STREET_NM packs name, type and directional into one padded field. Splitting
  // it is source interpretation and belongs here, not in the contract.
  const street = splitPackedStreet(record.situs.streetName);
  const address = canonicalAddress({
    houseNumber: record.situs.houseNumber,
    houseNumberSuffix: record.situs.fractionalHouseNumber,
    preDirectional: street.preDirectional,
    streetName: street.streetName,
    postType: street.postType,
    postDirectional: street.postDirectional,
    unitId: record.situs.condoNumber,
    city: record.situs.municipality,
    state: 'MN',
    postalCode: record.situs.zip,
  });
  // SALE_DATE is 'YYYYMM' — a year and a month, with no day. Declared as month
  // precision so it compares honestly against a source that states a day.
  const saleDate = canonicalDate(record.lastSale.date, 'SALE_DATE', 'month');
  const saleValue = record.lastSale.priceMinor === null
    ? canonicalMoney(null)
    : canonicalMoney(String(record.lastSale.priceMinor), 'minor_units');
  // TAX_TOT is dollars and cents; the connector already scaled it to minor units.
  const taxRaw = record.attributes['tax_total'];
  const taxTotal = taxRaw === null || taxRaw === undefined
    ? canonicalMoney(null)
    : canonicalMoney(String(taxRaw), 'minor_units');

  return {
    canonical_area_square_feet: area.present ? area.squareFeet : null,
    canonical_area_source_unit: area.present ? area.sourceUnit : null,
    canonical_area_source_value: area.present ? area.sourceValue : null,
    canonical_area_absent_reason: area.present ? null : area.reason,
    // The comparison KEY only — street and unit. The display string is
    // deliberately not stored: `situs_address` above already carries a
    // human-readable form, and a second one that concatenates city, state and
    // ZIP can reproduce a taxpayer mailing line verbatim. The components are
    // public situs data either way, but a canonical field that is
    // byte-identical to a restricted value defeats leak scanning, and a scan
    // that cries wolf is a scan nobody reads.
    canonical_address_key: address.present ? address.comparisonKey : null,
    canonical_sale_date: saleDate.present ? saleDate.date : null,
    canonical_sale_date_precision: saleDate.present ? saleDate.precision : null,
    canonical_sale_value_minor: saleValue.present ? saleValue.amountMinor.toString() : null,
    canonical_tax_total_minor: taxTotal.present ? taxTotal.amountMinor.toString() : null,
    normalization_contract: NORMALIZATION_CONTRACT_VERSION,
  };
}

function formatSitus(record: HennepinParcelRecord): string | null {
  const { situs } = record;
  const house = [situs.houseNumber, situs.fractionalHouseNumber].filter(Boolean).join(' ');
  const line = [house || null, situs.streetName, situs.condoNumber ? `UNIT ${situs.condoNumber}` : null]
    .filter(Boolean)
    .join(' ');
  const parts = [line || null, situs.municipality, situs.zip].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function extractContacts(
  record: HennepinParcelRecord,
  parties: readonly PartyObservation[],
  evidence: SourceEvidence,
  sourceId: string,
): readonly ContactObservation[] {
  // The taxpayer block packs a name and up to three mailing lines into four
  // fixed fields. Line 1 became the party name; lines 2+ are a mailing address
  // and belong in the restricted plane.
  const mailingLines = record.restricted.taxpayerBlockLines.slice(1);
  if (record.restricted.mailingMunicipality) mailingLines.push(record.restricted.mailingMunicipality);
  if (mailingLines.length === 0) return [];

  const taxpayer = parties.find((p) => p.role === 'assessor_taxpayer') ?? null;
  const value = mailingLines.join('\n');

  return [{
    contactObservationId: contactObservationId(
      sourceId, evidence.sourceRecordId, taxpayer?.observationId ?? null, 'mailing_address', value,
    ),
    partyId: null,
    partyObservationId: taxpayer?.observationId ?? null,
    contactType: 'mailing_address',
    value,
    sourceId,
    sourceRecordId: evidence.sourceRecordId,
    observedAt: evidence.observedAt,
    confidence: 'source_stated',
    // A mailing address on a tax roll is where the bill goes. It is evidence for
    // ownership resolution, and it is not permission to contact anybody.
    permittedUse: 'identity_resolution',
    status: 'observed',
    evidence,
  }];
}

function money(minor: number | null): ReturnType<typeof usd> | null {
  return minor === null ? null : usd(minor);
}
