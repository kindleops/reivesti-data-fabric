/**
 * Canonical substrate.
 *
 * Two rules shape every type here:
 *
 *  1. Reivesti owns identity. Every canonical id is a Reivesti key derived in
 *     our own namespace. County parcel numbers, eCRV numbers and grantee names
 *     are *evidence attached to* an identity, never the identity itself.
 *
 *  2. Nothing is asserted that the source did not say. Where a source is silent
 *     the field is null and stays null; where a source is ambiguous the
 *     resolution state stays ambiguous. A canonical row is a claim, and every
 *     claim carries the evidence that supports it.
 *
 * This is the minimum substrate for public-record transfer ingestion. Assessor
 * values, distress lifecycles and derived intelligence are deliberately absent.
 */
import { deterministicId } from '../core/hash.ts';
import type { ParcelSnapshotObservation } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/** Answers "where did this come from?" for every canonical row in the system. */
export type SourceEvidence = {
  readonly sourceId: string;
  /** Publisher's own record key, scoped to the source. */
  readonly sourceRecordId: string;
  readonly artifactId: string;
  readonly runId: string;
  /** When Reivesti observed it. */
  readonly observedAt: string;
  /** When the source says the fact was true, when the source says so at all. */
  readonly effectiveAt: string | null;
  /** Digest of the exact parsed source record this claim rests on. */
  readonly rawRecordHash: string;
  readonly parserVersion: string;
  readonly normalizationVersion: string;
};

export type ResolutionState =
  /** Strong deterministic evidence ties this observation to a canonical entity. */
  | 'resolved'
  /** Tied on evidence that is good but revocable; not safe to merge across sources. */
  | 'provisional'
  /** Several candidates fit and none dominates. Must not be silently collapsed. */
  | 'ambiguous'
  /** No canonical entity has been assigned, and none may be inferred. */
  | 'unresolved';

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

export type PropertyIdentifierType = 'county_parcel' | 'normalized_address' | 'source_property_key';

/**
 * An identifier as a source stated it. Retained whether or not it resolves.
 * `normalizedValue` is a comparison key; `value` is what the source actually said.
 */
export type PropertyIdentifierObservation = {
  readonly observationId: string;
  readonly identifierType: PropertyIdentifierType;
  readonly value: string;
  readonly normalizedValue: string;
  /** Parcel numbers are only unique within a county, so scope is mandatory. */
  readonly countyFips: string | null;
  /** The source's own designation, e.g. eCRV `primary` on a parcel. */
  readonly sourceDesignation: 'primary' | 'secondary' | 'unspecified';
  /** eCRV supplies preliminary PIDs; county-final PIDs come from other sources. */
  readonly finality: 'preliminary' | 'final' | 'unknown';
  readonly resolutionState: ResolutionState;
  readonly propertyId: string | null;
  readonly resolutionMethod: string | null;
  readonly evidence: SourceEvidence;
};

export type Property = {
  readonly propertyId: string;
  readonly countyFips: string;
  readonly createdFromMethod: string;
};

/**
 * The one property-resolution rule DF-0B applies: a syntactically valid parcel
 * number, scoped to a known county, identifies one property. Nothing weaker
 * resolves — address strings alone never do.
 */
export function propertyIdFromCountyParcel(countyFips: string, normalizedParcel: string): string {
  return deterministicId('prop', 'county_parcel', countyFips, normalizedParcel);
}

/** Parcel numbers are compared without punctuation or case; the raw form is kept separately. */
export function normalizeParcelId(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

export type PartyKind = 'person' | 'organization' | 'government' | 'unknown';

export type PartyRole =
  | 'buyer'
  | 'seller'
  | 'grantor'
  | 'grantee'
  | 'borrower'
  | 'lender'
  /** Owner of record on an assessor roll. An observation of the tax roll, NOT a
   *  deed-derived ownership history: the roll says who is billed, not who
   *  acquired what and when. Recorded-instrument history arrives in DF-0D. */
  | 'assessor_owner_of_record'
  /** The party the county bills. Frequently a servicer or agent, not the owner. */
  | 'assessor_taxpayer'
  | 'other';

/**
 * A party exactly as one source record named it. This row is always written.
 * Resolution to a canonical `Party` is a separate, evidence-bearing decision
 * that DF-0B does not make: matching names is not evidence.
 */
export type PartyObservation = {
  readonly observationId: string;
  readonly kind: PartyKind;
  readonly role: PartyRole;
  /** Source-specific role label, kept because roles are not universal. */
  readonly sourceRole: string;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly nameParts: {
    readonly first: string | null;
    readonly middle: string | null;
    readonly last: string | null;
    readonly suffix: string | null;
    readonly organizationName: string | null;
  };
  readonly address: PostalAddress | null;
  readonly foreignAddress: boolean | null;
  /** Source flagged this party as protected (e.g. an address-confidentiality program). */
  readonly protectedIdentity: boolean;
  readonly resolutionState: ResolutionState;
  readonly partyId: string | null;
  readonly evidence: SourceEvidence;
};

export type Party = {
  readonly partyId: string;
  readonly kind: PartyKind;
  readonly canonicalName: string;
};

export type PartyAlias = {
  readonly aliasId: string;
  readonly partyId: string;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly evidence: SourceEvidence;
};

export type PostalAddress = {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly stateOrProvince: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
};

/** Case- and punctuation-insensitive comparison key. Never an identity by itself. */
export function normalizeName(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export type TransactionEvent = {
  readonly transactionId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly jurisdictionId: string;
  readonly countyFips: string;
  /** The transfer date the source states. Null when the source does not state one. */
  readonly transferDate: string | null;
  /** Source's own instrument label, unmapped. e.g. eCRV deedTypeCde "QUITCLAIM". */
  readonly instrumentTypeCode: string | null;
  readonly totalConsideration: Money | null;
  readonly downPayment: Money | null;
  readonly sellerPaidPoints: Money | null;
  readonly delinquentSpecialAssessmentsPaidByBuyer: Money | null;
  readonly personalPropertyIncludedInTotal: boolean | null;
  readonly legalDescription: string | null;
  /**
   * Source-stated transaction characteristics, kept as the source's own booleans
   * rather than folded into a derived "arms length" verdict. Interpretation is a
   * later layer's job; ingestion records what was declared.
   */
  readonly characteristics: Readonly<Record<string, boolean | number | string | null>>;
  /**
   * Analytical metadata such as sales-ratio study eligibility. Never a reason to
   * drop the transaction: a sale excluded from a study still happened.
   */
  readonly analyticalMetadata: Readonly<Record<string, unknown>>;
  readonly evidence: SourceEvidence;
};

export type TransactionParty = {
  readonly transactionId: string;
  readonly partyObservationId: string;
  readonly role: PartyRole;
  readonly sourceRole: string;
  readonly ordinal: number;
};

export type TransactionParcel = {
  readonly transactionId: string;
  readonly propertyIdentifierObservationId: string;
  readonly ordinal: number;
};

export type Money = {
  /** Minor units (cents). Integer arithmetic only: currency never touches floats. */
  readonly amountMinor: number;
  readonly currency: 'USD';
};

export function usd(amountMinor: number): Money {
  if (!Number.isInteger(amountMinor)) throw new TypeError(`money must be integer minor units, got ${amountMinor}`);
  return { amountMinor, currency: 'USD' };
}

// ---------------------------------------------------------------------------
// Financing
// ---------------------------------------------------------------------------

/**
 * A financing arrangement stated on a transaction. Note `arrangementKind` keeps
 * the source's distinction intact: a contract for deed is not a mortgage, and
 * collapsing them would destroy the very signal that makes the record useful.
 */
export type FinancingEvent = {
  readonly financingId: string;
  readonly transactionId: string;
  readonly ordinal: number;
  /** Source-stated financing type code, unmapped (eCRV: CASH | CD | MORTGAGE | ASSUMED). */
  readonly financeTypeCode: string | null;
  readonly principalAmount: Money | null;
  readonly interestRateType: 'fixed' | 'variable' | null;
  /** Annual percentage as stated, e.g. 6.375. Null when not stated. */
  readonly interestRatePercent: number | null;
  readonly paymentAmount: Money | null;
  readonly paymentFrequencyCode: string | null;
  readonly paymentAppliesToCode: string | null;
  readonly numberOfPayments: number | null;
  readonly balloonAmount: Money | null;
  readonly balloonDate: string | null;
  readonly selectedBySource: boolean | null;
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// Time-aware observations (snapshot sources)
// ---------------------------------------------------------------------------

/**
 * Assessment values as one snapshot stated them.
 *
 * A new snapshot inserts a new row. It never overwrites the previous one,
 * because "the total market value is 241,300" is only interesting alongside
 * "and last year it was 228,000".
 */
export type AssessmentObservation = {
  readonly observationId: string;
  readonly propertyId: string | null;
  readonly countyFips: string;
  readonly normalizedParcel: string;
  readonly snapshotId: string;
  /**
   * Null when the source states no assessment year. Inferring it from the
   * capture date would be inventing data, so the null stands.
   */
  readonly assessmentYear: number | null;
  /** A parcel may carry several classified portions; this is the sub-record index. */
  readonly tier: number;
  readonly propertyTypeCode: string | null;
  readonly propertyTypeName: string | null;
  readonly homesteadCode: string | null;
  readonly landValue: Money | null;
  readonly buildingValue: Money | null;
  readonly machineryValue: Money | null;
  readonly totalValue: Money | null;
  readonly taxableValue: Money | null;
  readonly netTaxCapacity: Money | null;
  readonly netTax: Money | null;
  readonly characteristics: Readonly<Record<string, unknown>>;
  readonly evidence: SourceEvidence;
};

/** Physical and descriptive characteristics as one snapshot stated them. */
export type PropertyCharacteristicObservation = {
  readonly observationId: string;
  readonly propertyId: string | null;
  readonly countyFips: string;
  readonly normalizedParcel: string;
  readonly snapshotId: string;
  readonly yearBuilt: number | null;
  readonly parcelAreaSqFt: number | null;
  readonly characteristics: Readonly<Record<string, unknown>>;
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// Recorded instruments and distress (modelled now, unpopulated by eCRV)
// ---------------------------------------------------------------------------

/**
 * A document as a recorder's index describes it. eCRV is a revenue filing, not
 * a recording, so it populates none of this: the type exists so DF-0D has a
 * destination that already carries lineage and county scoping.
 */
export type RecordedInstrument = {
  readonly instrumentId: string;
  readonly countyFips: string;
  readonly recordingReference: string;
  readonly recordedAt: string | null;
  readonly instrumentTypeCode: string | null;
  readonly transactionId: string | null;
  readonly evidence: SourceEvidence;
};

export type DistressEventType =
  | 'notice_of_default'
  | 'notice_of_sale'
  | 'foreclosure_sale'
  | 'tax_delinquency'
  | 'tax_sale'
  | 'lis_pendens';

/** Defined for DF-0F. No connector in DF-0B emits one. */
export type DistressEvent = {
  readonly distressEventId: string;
  readonly eventType: DistressEventType;
  readonly countyFips: string;
  readonly propertyId: string | null;
  readonly eventDate: string | null;
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// Emitted canonical events
// ---------------------------------------------------------------------------

/**
 * Only statements the source actually supports. Notably absent: anything about
 * buyer intent, investor status or cash-buyer classification — a `financeType`
 * of CASH on a revenue filing is a declaration about this transaction, not a
 * property of the buyer.
 */
export type CanonicalEventType =
  // Transfer sources (eCRV)
  | 'REAL_ESTATE_TRANSFER_OBSERVED'
  | 'PROPERTY_SALE_OBSERVED'
  | 'FINANCING_OBSERVED'
  // Snapshot / assessor sources. None of these asserts a transaction: an
  // assessor roll cannot support PROPERTY_SOLD, BUYER_ACQUIRED_PROPERTY,
  // FORECLOSURE or ACTIVE_BUYER, so none of those exists.
  | 'PARCEL_OBSERVED'
  | 'PARCEL_RESOLVED'
  | 'PARCEL_ATTRIBUTES_CHANGED'
  | 'ASSESSOR_OWNER_OBSERVED'
  | 'ASSESSMENT_OBSERVED'
  | 'PROPERTY_CHARACTERISTICS_OBSERVED'
  // Recorded-instrument sources. Note the layering: a document was RECORDED is
  // always safe; a CONVEYANCE was observed needs a conveying family and land we
  // can identify; a SALE is never claimed here at all, because a deed carries no
  // reliable price and eCRV is the source for sale economics.
  | 'INSTRUMENT_RECORDED'
  | 'CONVEYANCE_OBSERVED'
  | 'MORTGAGE_RECORDED'
  | 'MORTGAGE_ASSIGNED'
  | 'MORTGAGE_RELEASED'
  // State business registers. Every one of these is an OBSERVATION of a
  // registration. None asserts that a company trades, holds property, invests or
  // is worth contacting — a register is a register, and there is deliberately no
  // BUSINESS_ACTIVE or BUSINESS_OPERATING here to be misread later.
  | 'BUSINESS_ENTITY_OBSERVED'
  | 'BUSINESS_FILING_OBSERVED'
  | 'BUSINESS_STATUS_OBSERVED'
  | 'BUSINESS_NAME_OBSERVED'
  | 'BUSINESS_ADDRESS_OBSERVED'
  | 'BUSINESS_PARTY_OBSERVED';

export type CanonicalEvent = {
  /** Deterministic: replaying the same evidence re-emits the same event id. */
  readonly eventId: string;
  readonly eventType: CanonicalEventType;
  readonly occurredAt: string | null;
  readonly subjectId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidence: SourceEvidence;
};

/** The complete canonical output of normalising one source record. */
export type CanonicalBundle = {
  readonly transaction: TransactionEvent;
  readonly parties: readonly PartyObservation[];
  readonly transactionParties: readonly TransactionParty[];
  readonly propertyIdentifiers: readonly PropertyIdentifierObservation[];
  readonly transactionParcels: readonly TransactionParcel[];
  readonly properties: readonly Property[];
  readonly financing: readonly FinancingEvent[];
  readonly events: readonly CanonicalEvent[];
  // Snapshot-source additions. Optional so a feed-source bundle serialises
  // exactly as it did before these existed, keeping DF-0B digests stable.
  readonly assessments?: readonly AssessmentObservation[];
  readonly characteristics?: readonly PropertyCharacteristicObservation[];
  readonly parcelObservations?: readonly ParcelSnapshotObservation[];
};
