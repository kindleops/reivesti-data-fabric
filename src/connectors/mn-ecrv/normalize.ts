/**
 * eCRV to canonical.
 *
 * What this file refuses to do is as important as what it does:
 *
 *  - It never merges parties. Two filings naming "JOHN SMITH" produce two
 *    unresolved observations, because a matching name is not evidence.
 *  - It never resolves a property from an address string. Only a county-scoped
 *    parcel number resolves, and only to `provisional`, because the extract
 *    carries the submitter's preliminary PID rather than the county's final one.
 *  - It never turns `principalResidence` into an owner-occupancy fact. The
 *    submitter stated an intention about one transaction.
 *  - It never turns `financeType = CASH` into a cash buyer, or `legalActionInd`
 *    into a foreclosure. Those are derived claims about people, and nothing in
 *    this record supports them.
 *  - It never drops a transaction for being ineligible for the sales-ratio
 *    study. Study eligibility is analysis; the transfer still happened.
 */
import {
  type CanonicalBundle,
  type CanonicalEvent,
  type FinancingEvent,
  type PartyObservation,
  type PostalAddress,
  type Property,
  type PropertyIdentifierObservation,
  type SourceEvidence,
  type TransactionEvent,
  type TransactionParcel,
  type TransactionParty,
  normalizeName,
  normalizeParcelId,
  propertyIdFromCountyParcel,
  usd,
} from '../../canonical/models.ts';
import {
  type ContactObservation,
  type ContactType,
  contactObservationId,
} from '../../contact/contact-plane.ts';
import { fail } from '../../core/errors.ts';
import { deterministicId } from '../../core/hash.ts';
import { countyJurisdictionId, mnCountyByCode } from '../../registry/jurisdictions.ts';
import type { EcrvParty, EcrvRecord } from './record.ts';

export const NORMALIZATION_VERSION = 'mn_ecrv_norm_1';

/**
 * Values that appear where a parcel number should be but identify nothing.
 * Resolving one of these would collapse every unrelated property that used the
 * same placeholder into a single entity.
 */
const PARCEL_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '', '0', '00', '000', 'NA', 'N/A', 'NONE', 'UNKNOWN', 'TBD', 'PENDING', 'NEWSPLIT', 'NEW', 'SPLIT',
]);

export type NormalizeOutput = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

export function normalizeEcrv(
  record: EcrvRecord,
  evidence: SourceEvidence,
  sourceId: string,
): NormalizeOutput {
  const county = mnCountyByCode(record.countyCode);
  if (!county) {
    fail('VALIDATION', `eCRV county code "${record.countyCode}" is not a Minnesota county`, {
      countyCode: record.countyCode,
    });
  }
  const countyFips = county.countyFips;
  const jurisdictionId = countyJurisdictionId(countyFips);
  const transactionId = deterministicId('txn', sourceId, countyFips, record.crvNumber);

  // --- parties -------------------------------------------------------------
  const parties: PartyObservation[] = [];
  const transactionParties: TransactionParty[] = [];
  /** partyKey -> the observation it produced, so contacts attach by key not by index. */
  const partyByKey = new Map<string, PartyObservation>();
  let ordinal = 0;

  for (const p of [...record.buyers, ...record.sellers]) {
    ordinal += 1;
    const observationId = deterministicId('partyobs', sourceId, evidence.sourceRecordId, p.partyKey);
    const rawName = rawNameOf(p);
    const observation: PartyObservation = {
      observationId,
      kind: partyKind(p),
      role: p.side,
      // eCRV is a revenue declaration, not a recording, so its roles are buyer
      // and seller. Grantor/grantee belong to a recorder source (DF-0D).
      sourceRole: `ecrv:${p.side}:${p.block}`,
      rawName,
      normalizedName: normalizeName(rawName),
      nameParts: {
        first: p.firstName,
        middle: p.middleName,
        last: p.lastName,
        suffix: p.nameSuffix,
        organizationName: p.organizationName,
      },
      address: addressOf(p),
      foreignAddress: p.foreignAddress,
      protectedIdentity: p.privateIndicator === true,
      // Nothing in a single filing is evidence that this party is a party we
      // have already seen. Resolution is a later, evidence-bearing decision.
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    };
    parties.push(observation);
    partyByKey.set(p.partyKey, observation);
    transactionParties.push({
      transactionId,
      partyObservationId: observationId,
      role: p.side,
      sourceRole: `ecrv:${p.side}:${p.block}`,
      ordinal,
    });
  }

  // --- property identifiers ------------------------------------------------
  const propertyIdentifiers: PropertyIdentifierObservation[] = [];
  const transactionParcels: TransactionParcel[] = [];
  const properties = new Map<string, Property>();

  record.property.parcels.forEach((parcel, index) => {
    const raw = parcel.parcelId ?? '';
    const normalized = normalizeParcelId(raw);
    const resolvable = raw.trim() !== '' && !PARCEL_PLACEHOLDERS.has(normalized) && /\d/.test(normalized);
    const propertyId = resolvable ? propertyIdFromCountyParcel(countyFips, normalized) : null;
    const observationId = deterministicId('propid', sourceId, evidence.sourceRecordId, 'parcel', String(index + 1), normalized);

    propertyIdentifiers.push({
      observationId,
      identifierType: 'county_parcel',
      value: raw,
      normalizedValue: normalized,
      countyFips,
      sourceDesignation: parcel.primary === true ? 'primary' : parcel.primary === false ? 'secondary' : 'unspecified',
      // The extract carries the submitter's PID. The county's verified final PID
      // is county-added data and is not in this feed, so finality is preliminary
      // and must not be represented as anything stronger.
      finality: 'preliminary',
      resolutionState: resolvable ? 'provisional' : 'unresolved',
      propertyId,
      resolutionMethod: resolvable ? 'county_parcel_preliminary' : null,
      evidence,
    });
    transactionParcels.push({ transactionId, propertyIdentifierObservationId: observationId, ordinal: index + 1 });

    if (propertyId && !properties.has(propertyId)) {
      properties.set(propertyId, { propertyId, countyFips, createdFromMethod: 'county_parcel_preliminary' });
    }
  });

  // Addresses are retained as identifier evidence and never resolve anything.
  // A situs address is not a property identity, and treating it as one is how
  // two neighbouring units become one property.
  record.property.addresses.forEach((address, index) => {
    const value = [address.street1, address.street2, address.city, address.zip].filter(Boolean).join(', ');
    if (value === '') return;
    propertyIdentifiers.push({
      observationId: deterministicId('propid', sourceId, evidence.sourceRecordId, 'address', String(index + 1), normalizeName(value)),
      identifierType: 'normalized_address',
      value,
      normalizedValue: normalizeName(value),
      countyFips,
      sourceDesignation: 'unspecified',
      finality: 'unknown',
      resolutionState: 'unresolved',
      propertyId: null,
      resolutionMethod: null,
      evidence,
    });
  });

  // --- transaction ---------------------------------------------------------
  const transaction: TransactionEvent = {
    transactionId,
    sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId,
    countyFips,
    transferDate: record.sale.deedContractDate,
    instrumentTypeCode: record.sale.deedTypeCode,
    totalConsideration: money(record.sale.totalPurchaseAmountMinor),
    downPayment: money(record.sale.downPaymentEquityMinor),
    sellerPaidPoints: money(record.sale.sellerPaidPointsMinor),
    delinquentSpecialAssessmentsPaidByBuyer: money(record.sale.specialAssessmentAmountMinor),
    personalPropertyIncludedInTotal: record.sale.personalPropertyIncludedInTotal,
    legalDescription: record.property.legalDescription,
    characteristics: {
      // Property, as declared for this sale.
      deeded_acres: record.property.totalAcres,
      tillable_acres: record.property.tillableAcres,
      irrigated_acres: record.property.irrigatedAcres,
      included_in_sale_code: record.property.whatIsIncludedInSaleCode,
      new_buildings_in_sale_year: record.property.newBuildingsOnSaleYear,
      rental_buildings: record.property.numberOfRentalBuildings,
      rental_units: record.property.numberOfRentalUnitsInAllBuildings,
      conservation_program_code: record.property.programs[0]?.programCode ?? null,
      conservation_program_acres: record.property.programs[0]?.programAcres ?? null,
      // An intention stated about this transaction, not a property attribute.
      buyer_intends_principal_residence: record.property.principalResidence,
      // Agreement terms.
      agreement_over_two_years_old: record.sale.agreement2YrsOld,
      buyer_acquired_partial_interest: record.sale.buyerPartInterest,
      contract_for_deed_payoff: record.sale.deedPayoff,
      buyer_leased_before_sale: record.sale.didBuyerLease,
      seller_leased_after_sale: record.sale.didSellerLease,
      seller_lease_months: record.sale.sellerLeaseMonths,
      minimum_guaranteed_rental_income: record.sale.guaranteeRentIncome,
      lease_with_option_to_buy: record.sale.leaseOptionToBuy,
      like_kind_exchange: record.sale.likeKindExchange,
      property_received_in_trade: record.sale.receivedInTrade,
      // Supplementary declarations.
      buyer_owns_adjacent_property: record.supplementary.adjacentPropertyInd,
      buyer_obtained_appraisal: record.supplementary.buyerAppraisalInd,
      buyer_appraisal_amount_minor: record.supplementary.buyerAppraisalAmountMinor,
      seller_obtained_appraisal: record.supplementary.sellerAppraisalInd,
      seller_appraisal_amount_minor: record.supplementary.sellerAppraisalAmountMinor,
      gift_or_inheritance: record.supplementary.giftInd,
      government_party: record.supplementary.governmentInd,
      // Declares that the sale arose from a legal proceeding. Not a foreclosure
      // event, and never promoted to one.
      foreclosure_or_legal_proceeding: record.supplementary.legalActionInd,
      name_change_only: record.supplementary.nameChangeInd,
      not_publicly_promoted: record.supplementary.nonListedInd,
      significant_price_difference: record.supplementary.nonMarketPriceInd,
      // Transaction-level relationship. Never a standing fact about either party.
      buyer_seller_related: record.supplementary.relatedInd,
      tax_exempt_party: record.supplementary.taxExemptInd,
      personal_property_count: record.sale.personalProperties.length,
    },
    analyticalMetadata: {
      // Sales-ratio study accept/reject is county-added and absent from this
      // feed. Recording the absence explicitly stops a later layer reading
      // "no rejection" as "accepted".
      studyEligibility: null,
      studyEligibilityAvailable: false,
      studyEligibilityNote: 'county-added; not present in the Weekly Sales Extract',
      plannedUseCodes: record.property.plannedUses.map((u) => [u.tier1Code, u.tier2Code, u.tier3Code]),
      usesBeforeSaleCodes: record.property.usesBeforeSale.map((u) => [u.tier1Code, u.tier2Code, u.tier3Code]),
    },
    evidence,
  };

  // --- financing -----------------------------------------------------------
  const financing: FinancingEvent[] = [];

  if (record.sale.financeArrangements.length === 0) {
    // No arrangement rows, but the submitter still declared a financing type.
    // That declaration is a fact worth keeping; it is not a financing event.
    if (record.sale.financeTypeCode !== null) {
      financing.push(emptyFinancing(transactionId, 1, record.sale.financeTypeCode, evidence));
    }
  } else {
    record.sale.financeArrangements.forEach((a) => {
      financing.push({
        financingId: deterministicId('fin', transactionId, String(a.ordinal)),
        transactionId,
        ordinal: a.ordinal,
        // CD is a contract for deed. It stays CD: folding it into MORTGAGE would
        // erase the distinction that makes the record worth ingesting.
        financeTypeCode: record.sale.financeTypeCode,
        principalAmount: money(a.contractMortgageAmountMinor),
        interestRateType: a.interestRateTypeCode === 'FIXED' ? 'fixed' : a.interestRateTypeCode === 'VARIABLE' ? 'variable' : null,
        interestRatePercent: a.interestRatePercent,
        paymentAmount: money(a.paymentAmountMinor),
        paymentFrequencyCode: a.paymentTypeCode === 'OTHER' ? (a.paymentTypeOther ?? 'OTHER') : a.paymentTypeCode,
        paymentAppliesToCode: a.paymentForCode,
        numberOfPayments: a.numberOfPayments,
        balloonAmount: money(a.balloonAmountMinor),
        balloonDate: a.balloonDate,
        selectedBySource: a.selected,
        evidence,
      });
    });
  }

  // --- events --------------------------------------------------------------
  const events: CanonicalEvent[] = [];
  const eventId = (type: string, subject: string): string =>
    deterministicId('evt', type, subject, evidence.sourceRecordId, evidence.rawRecordHash);

  events.push({
    eventId: eventId('REAL_ESTATE_TRANSFER_OBSERVED', transactionId),
    eventType: 'REAL_ESTATE_TRANSFER_OBSERVED',
    occurredAt: transaction.transferDate,
    subjectId: transactionId,
    payload: {
      countyFips,
      instrumentTypeCode: transaction.instrumentTypeCode,
      parcelCount: transactionParcels.length,
      buyerCount: record.buyers.length,
      sellerCount: record.sellers.length,
    },
    evidence,
  });

  // A sale is only claimed where a property resolved AND consideration was
  // stated. A $0 transfer between relatives is a transfer, not a sale.
  const consideration = transaction.totalConsideration;
  if (consideration && consideration.amountMinor > 0) {
    for (const property of properties.values()) {
      events.push({
        eventId: eventId('PROPERTY_SALE_OBSERVED', property.propertyId),
        eventType: 'PROPERTY_SALE_OBSERVED',
        occurredAt: transaction.transferDate,
        subjectId: property.propertyId,
        payload: {
          transactionId,
          countyFips,
          totalConsiderationMinor: consideration.amountMinor,
          propertyIdentityFinality: 'preliminary',
        },
        evidence,
      });
    }
  }

  // Financing is only *observed* where an arrangement with a principal exists.
  // A declared CASH type means there was no financing to observe.
  for (const f of financing) {
    if (!f.principalAmount) continue;
    events.push({
      eventId: eventId('FINANCING_OBSERVED', f.financingId),
      eventType: 'FINANCING_OBSERVED',
      occurredAt: transaction.transferDate,
      subjectId: f.financingId,
      payload: {
        transactionId,
        financeTypeCode: f.financeTypeCode,
        principalMinor: f.principalAmount.amountMinor,
        interestRateType: f.interestRateType,
        interestRatePercent: f.interestRatePercent,
        hasBalloon: f.balloonAmount !== null,
      },
      evidence,
    });
  }

  // --- restricted contact plane -------------------------------------------
  const contacts = extractContacts(record, partyByKey, evidence, sourceId);

  return {
    bundle: {
      transaction,
      parties,
      transactionParties,
      propertyIdentifiers,
      transactionParcels,
      properties: [...properties.values()],
      financing,
      events,
    },
    contacts,
  };
}

// ---------------------------------------------------------------------------

function extractContacts(
  record: EcrvRecord,
  partyByKey: ReadonlyMap<string, PartyObservation>,
  evidence: SourceEvidence,
  sourceId: string,
): readonly ContactObservation[] {
  const out: ContactObservation[] = [];

  const push = (
    partyObservationId: string | null,
    contactType: ContactType,
    value: string | null,
    protectedIdentity: boolean,
  ): void => {
    if (value === null || value.trim() === '') return;
    out.push({
      contactObservationId: contactObservationId(sourceId, evidence.sourceRecordId, partyObservationId, contactType, value),
      partyId: null,
      partyObservationId,
      contactType,
      value,
      sourceId,
      sourceRecordId: evidence.sourceRecordId,
      observedAt: evidence.observedAt,
      confidence: 'source_stated',
      // Observing a channel on a public filing is not permission to use it.
      permittedUse: 'record_only',
      status: protectedIdentity ? 'protected_identity' : 'observed',
      evidence,
    });
  };

  for (const contact of record.restricted.partyContacts) {
    const party = partyByKey.get(contact.partyKey);
    const isProtected = party?.protectedIdentity === true;
    push(party?.observationId ?? null, 'phone', contact.daytimePhone, isProtected);
    push(party?.observationId ?? null, 'email', contact.email, isProtected);
    push(party?.observationId ?? null, 'contact_note', contact.contactNotes, isProtected);
  }

  // Unbounded submitter free text. It routinely names people and describes
  // relationships, so it is isolated rather than published to market data.
  push(null, 'contact_note', record.restricted.nonListedComment, false);
  push(null, 'contact_note', record.restricted.nonMarketPriceComment, false);
  push(null, 'unstructured_submitter_block', record.restricted.submitterFormRaw, false);

  return out;
}

function emptyFinancing(
  transactionId: string,
  ordinal: number,
  financeTypeCode: string,
  evidence: SourceEvidence,
): FinancingEvent {
  return {
    financingId: deterministicId('fin', transactionId, String(ordinal)),
    transactionId,
    ordinal,
    financeTypeCode,
    principalAmount: null,
    interestRateType: null,
    interestRatePercent: null,
    paymentAmount: null,
    paymentFrequencyCode: null,
    paymentAppliesToCode: null,
    numberOfPayments: null,
    balloonAmount: null,
    balloonDate: null,
    selectedBySource: null,
    evidence,
  };
}

function money(minor: number | null): ReturnType<typeof usd> | null {
  return minor === null ? null : usd(minor);
}

function partyKind(p: EcrvParty): PartyObservation['kind'] {
  if (p.block === 'organizations') return 'organization';
  if (p.isPerson === true) return 'person';
  if (p.isPerson === false) return 'organization';
  // The source did not say. Guessing from the name is exactly the inference
  // this layer is not allowed to make.
  return 'unknown';
}

function rawNameOf(p: EcrvParty): string {
  if (p.organizationName) return p.organizationName;
  return [p.firstName, p.middleName, p.lastName, p.nameSuffix].filter(Boolean).join(' ');
}

function addressOf(p: EcrvParty): PostalAddress | null {
  const any = p.addressLine1 ?? p.addressLine2 ?? p.city ?? p.stateOrProvince ?? p.zip ?? p.country;
  if (any === null) return null;
  return {
    line1: p.addressLine1,
    line2: p.addressLine2,
    city: p.city,
    stateOrProvince: p.stateOrProvince,
    postalCode: p.zip,
    country: p.country,
  };
}
