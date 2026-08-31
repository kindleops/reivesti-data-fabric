/**
 * Recorded instruments.
 *
 * A recorded instrument is a *document*, not an event. That distinction is the
 * spine of this file: the recorder can tell us with certainty that a document
 * of a given type, naming given parties, was recorded on a given date against
 * given land. It cannot tell us that a sale happened, what it sold for, or that
 * anybody's ownership began — those are interpretations, and each one needs its
 * own justification.
 *
 * So the model is layered:
 *
 *   DOCUMENT RECORDED      always, for every row the source gives us
 *   CONVEYANCE OBSERVED    only where the instrument family conveys, the parties
 *                          are unambiguous and the property link is strong
 *   SALE OBSERVED          not from here at all — eCRV is the source for sale
 *                          economics, and a deed carries no reliable price
 *
 * Two Minnesota specifics shape the identity rules:
 *
 *  - Hennepin maintains both **Abstract** land (Minn. Stat. ch. 507, recorded by
 *    the County Recorder) and **Torrens** registered land (ch. 508, filed with
 *    the Registrar of Titles and memorialised on a Certificate of Title). These
 *    are legally distinct systems with their own numbering. Collapsing them
 *    would merge two documents that merely share a number.
 *  - Hennepin's own fee schedule charges "$10 additional per referenced number
 *    over four" on assignments, satisfactions and partial releases, which is
 *    direct evidence that referenced prior document numbers are a first-class
 *    recorder concept rather than something we are inferring.
 */
import { deterministicId } from '../core/hash.ts';
import type { PostalAddress, ResolutionState, SourceEvidence } from './models.ts';

// ---------------------------------------------------------------------------
// Registration system
// ---------------------------------------------------------------------------

/**
 * Which land-registration system a document belongs to.
 *
 * `unknown` is a real and common answer for a source that does not say, and it
 * is never guessed at: an Abstract document and a Torrens document can share a
 * document number, so an unknown system means identity is scoped conservatively.
 */
export type RegistrationSystem = 'abstract' | 'torrens' | 'both' | 'unknown';

// ---------------------------------------------------------------------------
// Document taxonomy
// ---------------------------------------------------------------------------

/**
 * Normalized families. Deliberately coarse: a family exists only where the
 * *semantic effect* of the document is clear enough to act on. Anything else is
 * `OTHER`, with the raw type preserved verbatim.
 */
export type InstrumentFamily =
  | 'CONVEYANCE'
  | 'MORTGAGE'
  | 'MORTGAGE_ASSIGNMENT'
  | 'MORTGAGE_RELEASE'
  | 'CONTRACT_FOR_DEED'
  | 'LIEN'
  | 'LIEN_RELEASE'
  | 'FORECLOSURE_RELATED'
  | 'CORRECTION'
  | 'LEASE_RELATED'
  | 'TITLE_RELATED'
  | 'OTHER';

/**
 * Whether a family may support a conveyance observation.
 *
 * Note what is absent. A Sheriff's Certificate transfers an interest but arises
 * from foreclosure, not a market conveyance. A Contract for Deed creates an
 * equitable interest without conveying legal title. A Correction amends an
 * earlier document and conveys nothing of its own. Each of those would look like
 * an ownership change to a naive rule, and each would be wrong.
 */
export const CONVEYANCE_FAMILIES: ReadonlySet<InstrumentFamily> = new Set<InstrumentFamily>(['CONVEYANCE']);

export const MORTGAGE_LIFECYCLE_FAMILIES: ReadonlySet<InstrumentFamily> = new Set<InstrumentFamily>([
  'MORTGAGE', 'MORTGAGE_ASSIGNMENT', 'MORTGAGE_RELEASE',
]);

// ---------------------------------------------------------------------------
// Party roles
// ---------------------------------------------------------------------------

export type InstrumentPartyRole =
  | 'GRANTOR'
  | 'GRANTEE'
  | 'MORTGAGOR'
  | 'MORTGAGEE'
  | 'ASSIGNOR'
  | 'ASSIGNEE'
  | 'TRUSTOR'
  | 'TRUSTEE'
  | 'BENEFICIARY'
  | 'BORROWER'
  | 'LENDER'
  | 'OTHER';

export type InstrumentParty = {
  readonly instrumentId: string;
  readonly partyObservationId: string;
  /** Exactly as the source labelled it. Never discarded. */
  readonly rawRole: string;
  readonly normalizedRole: InstrumentPartyRole;
  /** Source-supplied ordering, where the source supplies one. */
  readonly sequence: number | null;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly address: PostalAddress | null;
  /**
   * Always `unresolved` from a recorder source. "NORTHSTAR HOMES LLC" and
   * "NORTH STAR HOMES, LLC" are two observations until a dedicated identity
   * phase says otherwise; string similarity is not evidence of sameness.
   */
  readonly resolutionState: ResolutionState;
  readonly partyId: string | null;
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// Property linkage
// ---------------------------------------------------------------------------

/**
 * How confidently a document is tied to a canonical property.
 *
 * The gap between `DIRECT_PARCEL` and everything below it is the difference
 * between a fact and a hypothesis, and only the former is allowed to move
 * ownership.
 */
export type PropertyLinkState =
  /** The source supplied a county parcel identifier. */
  | 'DIRECT_PARCEL'
  /** The source's own document-to-property index tied them, without a PID. */
  | 'STRONG_DOCUMENT_PROPERTY_LINK'
  /** A legal description parsed confidently to exactly one known property. */
  | 'PROVISIONAL'
  /** Several properties fit and none dominates. Must not be collapsed. */
  | 'AMBIGUOUS'
  | 'UNRESOLVED';

/** Link states strong enough to carry an ownership claim. */
export const OWNERSHIP_GRADE_LINKS: ReadonlySet<PropertyLinkState> = new Set<PropertyLinkState>([
  'DIRECT_PARCEL',
  'STRONG_DOCUMENT_PROPERTY_LINK',
]);

export type InstrumentPropertyLink = {
  readonly instrumentId: string;
  readonly propertyId: string | null;
  readonly countyFips: string;
  readonly normalizedParcel: string | null;
  readonly linkState: PropertyLinkState;
  readonly linkMethod: string;
  /** The legal description this link came from, when it came from one. */
  readonly legalDescriptionId: string | null;
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

export type RecordedInstrumentRecord = {
  readonly instrumentId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly jurisdictionId: string;
  readonly countyFips: string;
  /** Exactly as the recorder assigned it. Not globally unique on its own. */
  readonly documentNumber: string;
  readonly registrationSystem: RegistrationSystem;
  /** For Torrens, the Certificate of Title the document is memorialised on. */
  readonly certificateOfTitleNumber: string | null;
  /** The recorder's own label, verbatim. */
  readonly documentTypeRaw: string;
  readonly documentTypeNormalized: InstrumentFamily;
  /** When the recorder recorded it. The recorder is authoritative for this. */
  readonly recordedAt: string | null;
  /** When the parties dated it, where the index supplies it. Often absent. */
  readonly documentDate: string | null;
  /**
   * Consideration as an *indexed field*, never parsed from a document image or
   * inferred from tax stamps. Null unless the source states it outright.
   */
  readonly statedConsideration: number | null;
  readonly bookPage: string | null;
  readonly evidence: SourceEvidence;
};

/**
 * Instrument identity, scoped to the issuing office and registration system.
 *
 * Document number alone is not unique: Abstract and Torrens number separately,
 * and every county starts from one.
 */
export function instrumentIdOf(
  countyFips: string,
  registrationSystem: RegistrationSystem,
  documentNumber: string,
): string {
  return deterministicId('instr', countyFips, registrationSystem, normalizeDocumentNumber(documentNumber));
}

/** Comparison form for document numbers. The raw form is always retained. */
export function normalizeDocumentNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Reference graph
// ---------------------------------------------------------------------------

export type ReferenceType =
  | 'AMENDS'
  | 'ASSIGNS'
  | 'RELEASES'
  | 'SATISFIES'
  | 'CONTINUES'
  | 'REFERENCES';

/**
 * A pointer from one document to a prior document number.
 *
 * The target frequently will not be in the estate yet — historical backfill
 * arrives newest-first or in partitions, and a 2024 satisfaction references a
 * 2009 mortgage. **An unresolved reference is retained, never dropped.** Dropping
 * it would silently destroy the lineage the moment backfill reached the target.
 */
export type InstrumentReference = {
  readonly referenceId: string;
  readonly fromInstrumentId: string;
  /** The document number as the source wrote it. */
  readonly toDocumentNumber: string;
  readonly toNormalizedDocumentNumber: string;
  /** The registration system assumed for the target, if the source says. */
  readonly toRegistrationSystem: RegistrationSystem;
  /** Resolved once a matching instrument exists in the estate. */
  readonly toInstrumentId: string | null;
  readonly resolved: boolean;
  /** Only set where the referencing document's own type implies it. */
  readonly referenceType: ReferenceType;
  readonly evidence: SourceEvidence;
};

export function referenceIdOf(fromInstrumentId: string, toNormalized: string): string {
  return deterministicId('instref', fromInstrumentId, toNormalized);
}

/**
 * The reference type a document's own family implies about its targets.
 *
 * Conservative by construction: anything whose family does not imply a specific
 * relationship gets the neutral `REFERENCES`.
 */
export function impliedReferenceType(family: InstrumentFamily): ReferenceType {
  switch (family) {
    case 'MORTGAGE_ASSIGNMENT': return 'ASSIGNS';
    case 'MORTGAGE_RELEASE': return 'SATISFIES';
    case 'LIEN_RELEASE': return 'RELEASES';
    case 'CORRECTION': return 'AMENDS';
    default: return 'REFERENCES';
  }
}

// ---------------------------------------------------------------------------
// Legal descriptions
// ---------------------------------------------------------------------------

export type LegalDescriptionParseStatus = 'unparsed' | 'partial' | 'structured';

/**
 * A legal description, raw first.
 *
 * The structured components are a convenience for search and a *candidate* for
 * matching. They never replace the raw text, and a low-confidence parse can
 * never move a property link above `PROVISIONAL`.
 */
export type LegalDescriptionObservation = {
  readonly legalDescriptionId: string;
  readonly instrumentId: string;
  readonly sequence: number;
  /** Verbatim. The only field guaranteed to be faithful. */
  readonly raw: string;
  readonly parseStatus: LegalDescriptionParseStatus;
  readonly parserVersion: string;
  /** 0..1. Structured components below are only meaningful above the threshold. */
  readonly confidence: number;
  readonly lot: string | null;
  readonly block: string | null;
  readonly addition: string | null;
  readonly unit: string | null;
  readonly section: string | null;
  readonly township: string | null;
  readonly range: string | null;
  readonly evidence: SourceEvidence;
};

export function legalDescriptionIdOf(instrumentId: string, sequence: number, raw: string): string {
  return deterministicId('legal', instrumentId, String(sequence), raw);
}

// ---------------------------------------------------------------------------
// Mortgage lifecycle
// ---------------------------------------------------------------------------

/**
 * A financing instrument observed in the record.
 *
 * Separate from DF-0B's `FinancingEvent`, which describes financing *declared on
 * a sale filing*. This one describes a *recorded lien document*. They can
 * describe the same loan and they are not the same evidence, so they are not
 * merged: one is what the buyer told the Department of Revenue, the other is
 * what was recorded against the land.
 */
export type RecordedFinancing = {
  readonly recordedFinancingId: string;
  readonly instrumentId: string;
  readonly propertyId: string | null;
  readonly countyFips: string;
  /** Indexed principal, where the source indexes it. Never parsed from an image. */
  readonly principalAmountMinor: number | null;
  readonly recordedAt: string | null;
  readonly documentDate: string | null;
  readonly maturityDate: string | null;
  /** The mortgage this document acts on, for assignments and releases. */
  readonly actsOnInstrumentId: string | null;
  readonly lifecycleState: 'recorded' | 'assigned' | 'released';
  readonly evidence: SourceEvidence;
};

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * An ownership interval inferred from conveyance documents.
 *
 * Every field is an *observation*, which is why they are all named `observed*`.
 * The recorder does not tell us who owns a property; it tells us which documents
 * were recorded. An interval with an acquisition and no disposition means only
 * "we have seen them acquire and have not seen them convey away" — which is very
 * different from "they own it today", and the naming keeps that honest.
 */
export type OwnershipObservation = {
  readonly ownershipObservationId: string;
  readonly propertyId: string;
  readonly countyFips: string;
  /** The party observation, not a resolved canonical party. */
  readonly partyObservationId: string;
  readonly normalizedName: string;
  readonly observedAcquiredAt: string | null;
  readonly acquiredByInstrumentId: string | null;
  readonly observedDisposedAt: string | null;
  readonly disposedByInstrumentId: string | null;
  /** Why this is believed. Recorded so a reviewer can disagree with the rule. */
  readonly basis: 'recorded_conveyance';
  readonly evidence: SourceEvidence;
};

export function ownershipObservationIdOf(propertyId: string, normalizedName: string): string {
  return deterministicId('ownobs', propertyId, normalizedName);
}

// ---------------------------------------------------------------------------
// Cross-source transaction candidates
// ---------------------------------------------------------------------------

/**
 * Three sources can describe one real-world sale: the assessor echoes a last
 * sale, eCRV declares the economics, and the recorder holds the deed. Creating
 * three canonical "sales" would be wrong, and merging them on a hunch would be
 * worse.
 *
 * A candidate is a *hypothesis* that several observations describe one event.
 * It never replaces the observations, and it never silently promotes itself.
 */
export type TransactionCandidateState =
  /** Independent sources agree on property, date window and at least one party. */
  | 'SUPPORTED_MATCH'
  /** They plausibly describe one event but the agreement is incomplete. */
  | 'POSSIBLE_MATCH'
  /** They cannot all be true of one event. Kept, flagged, never merged. */
  | 'CONFLICT'
  | 'UNRESOLVED';

export type TransactionCandidate = {
  readonly candidateId: string;
  readonly propertyId: string;
  readonly countyFips: string;
  /** The date the candidate is anchored on, from the strongest source present. */
  readonly anchorDate: string | null;
  readonly state: TransactionCandidateState;
  /** Every observation supporting the hypothesis, by source. */
  readonly supportingSourceIds: readonly string[];
  readonly ecrvTransactionId: string | null;
  readonly recorderInstrumentId: string | null;
  readonly assessorSaleEcho: string | null;
  /** Why it is not a SUPPORTED_MATCH, when it is not. */
  readonly disagreements: readonly string[];
  readonly evidence: SourceEvidence;
};

export function transactionCandidateIdOf(propertyId: string, anchorDate: string): string {
  return deterministicId('txncand', propertyId, anchorDate);
}
