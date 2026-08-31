/**
 * Business entities from a state registry.
 *
 * This extends the existing `Party` layer rather than inventing a rival concept:
 * a registered business is a party that happens to have an authoritative
 * registration behind it. What is new is the *registration* — the facts a
 * secretary of state maintains, which no county source can supply.
 *
 * The governing rule, as everywhere else in the Fabric: the registry's own
 * identifier is the source key, Reivesti owns the canonical key, and a company
 * name is neither.
 */
import { deterministicId } from '../core/hash.ts';
import type { PostalAddress, ResolutionState, SourceEvidence } from './models.ts';

// ---------------------------------------------------------------------------
// The entity
// ---------------------------------------------------------------------------

/**
 * Registry status, exactly as the source states it.
 *
 * Minnesota's bulk file carries `Active` or `Inactive` and nothing more. It
 * means the *registration* is active — not that the company trades, employs
 * anyone, buys property or exists in any commercial sense. Nothing in the Fabric
 * may read it as an activity signal.
 */
export type RegistryStatus = 'active' | 'inactive' | 'unknown';

export type BusinessEntityRecord = {
  readonly entityId: string;
  readonly sourceId: string;
  /** The registry's own identifier. Authoritative for this jurisdiction. */
  readonly sourceEntityId: string;
  /** The state whose register this is. */
  readonly registryJurisdictionId: string;
  /** The filing number the registry assigned when the entity was created. */
  readonly originalFilingNumber: string | null;
  /** Current registered name in this jurisdiction, verbatim. */
  readonly legalName: string;
  readonly normalizedName: string;
  readonly compactName: string;
  /** Source code plus its label. The code is authoritative; the label is a lookup. */
  readonly businessTypeCode: string;
  readonly businessTypeLabel: string | null;
  /** Whether the registry treats it as formed here or registered from elsewhere. */
  readonly domesticity: 'domestic' | 'foreign' | 'unknown';
  readonly registryStatus: RegistryStatus;
  readonly registryStatusRaw: string | null;
  readonly filingDate: string | null;
  readonly expirationDate: string | null;
  readonly nextRenewalDueDate: string | null;
  /** Where the entity is organised: a US state, a country or a tribe. */
  readonly homeJurisdiction: string | null;
  readonly governingStatute: string | null;
  /** The name used in the home jurisdiction, when a foreign entity has one. */
  readonly homeBusinessName: string | null;
  /** Source-specific flags kept as stated, not folded into a type. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /**
   * How this row may be used, given the source licence (see `LicenseClass`
   * below). Carried on the row so the boundary is answerable from the data
   * rather than from application code that remembers which sources were bought.
   */
  readonly licenseClass: LicenseClass;
  readonly evidence: SourceEvidence;
};

/** Reivesti-owned canonical key, derived in our namespace from the source key. */
export function entityIdOf(sourceId: string, sourceEntityId: string): string {
  return deterministicId('entity', sourceId, sourceEntityId);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * How a name relates to its entity.
 *
 * `CURRENT_LEGAL_NAME` and `FILING_PARTY_NAME` are the two Minnesota's bulk file
 * actually supplies. `PRIOR_NAME` and `ASSUMED_NAME` exist in the model because
 * other registries supply them and Minnesota may later — but see the note on
 * `BusinessNameObservation`: Minnesota's delivery contains only names *active at
 * the time the file was generated*, so no prior-name history arrives with it.
 */
export type BusinessNameType =
  | 'CURRENT_LEGAL_NAME'
  | 'PRIOR_NAME'
  | 'ASSUMED_NAME'
  | 'HOME_JURISDICTION_NAME'
  | 'FILING_PARTY_NAME'
  | 'OTHER_SOURCE_NAME';

export type BusinessNameObservation = {
  readonly nameObservationId: string;
  readonly entityId: string;
  readonly nameType: BusinessNameType;
  /** Verbatim, including punctuation and spelling. Never rewritten. */
  readonly rawName: string;
  readonly normalizedName: string;
  readonly compactName: string;
  /** The filing this name arrived on, where the source ties them. */
  readonly filingNumber: string | null;
  readonly observedAt: string;
  readonly evidence: SourceEvidence;
};

export function nameObservationIdOf(entityId: string, nameType: string, rawName: string): string {
  return deterministicId('bizname', entityId, nameType, rawName);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Address roles, taken from the registry's own vocabulary.
 *
 * Deliberately a passthrough of the source code plus a coarse family: inventing
 * a role the register does not use would put a fact into the estate that no
 * source stated.
 */
export type BusinessAddressFamily =
  | 'PRINCIPAL'
  | 'REGISTERED_OFFICE'
  | 'MAILING'
  | 'PARTY_ADDRESS'
  | 'OTHER';

export type BusinessAddressObservation = {
  readonly addressObservationId: string;
  readonly entityId: string;
  /** The registry's numeric address-type code, authoritative. */
  readonly addressTypeCode: string;
  readonly addressTypeLabel: string | null;
  readonly family: BusinessAddressFamily;
  readonly address: PostalAddress;
  /** Comparison key. Supporting evidence only — never an identity on its own. */
  readonly normalizedAddress: string;
  readonly filingNumber: string | null;
  readonly observedAt: string;
  readonly evidence: SourceEvidence;
};

export function addressObservationIdOf(
  entityId: string,
  addressTypeCode: string,
  normalizedAddress: string,
): string {
  return deterministicId('bizaddr', entityId, addressTypeCode, normalizedAddress);
}

/**
 * Comparison form for an address.
 *
 * Conservative: case and punctuation only. No street-type expansion, no
 * abbreviation dictionary, no geocoding — each of those merges addresses that a
 * filer wrote differently *and* addresses that are genuinely different.
 */
export function normalizeAddress(address: PostalAddress): string {
  const parts = [
    address.line1, address.line2, address.city, address.stateOrProvince, address.postalCode,
  ].filter((p): p is string => p !== null && p.trim() !== '');
  return parts
    .join(' ')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

/**
 * A filing as the register recorded it.
 *
 * The normalized action is a *lookup*, not an interpretation: an action the
 * table does not know stays `OTHER` with the raw text intact, because a filing
 * action drives status and name-change reasoning and a wrong guess is a wrong
 * corporate history.
 */
export type FilingAction =
  | 'ORIGINAL_FILING'
  | 'AMENDMENT'
  | 'RENEWAL'
  | 'REINSTATEMENT'
  | 'DISSOLUTION'
  | 'WITHDRAWAL'
  | 'MERGER'
  | 'NAME_CHANGE'
  | 'ADMINISTRATIVE_ACTION'
  | 'OTHER';

export type BusinessFilingObservation = {
  readonly filingObservationId: string;
  readonly entityId: string;
  readonly filingNumber: string;
  readonly originalFilingNumber: string | null;
  /** Verbatim. The normalized action is derived from it and never replaces it. */
  readonly filingActionRaw: string;
  readonly filingAction: FilingAction;
  /** Whether this row is the primary occurrence in its filing set. */
  readonly filingRank: 'primary' | 'secondary' | 'unknown';
  readonly filingDate: string | null;
  readonly effectiveDate: string | null;
  readonly evidence: SourceEvidence;
};

export function filingObservationIdOf(
  entityId: string,
  filingNumber: string,
  filingActionRaw: string,
  rank: string,
  filingDate: string | null,
): string {
  return deterministicId('bizfiling', entityId, filingNumber, filingActionRaw, rank, filingDate ?? '');
}

// ---------------------------------------------------------------------------
// Filing parties
// ---------------------------------------------------------------------------

/**
 * A party named on a filing: a registered agent, an organizer, an officer.
 *
 * Many are **natural persons**. They are retained as source observations because
 * they are authoritative registry facts, and they are emphatically not the seed
 * of a people-search product. Their addresses go to the restricted plane; there
 * is no contact enrichment, no phone, no email — Minnesota states outright that
 * phone numbers are not available from that office — and no skip tracing.
 */
export type BusinessFilingParty = {
  readonly filingPartyId: string;
  readonly entityId: string;
  /** The registry's numeric name-type code. */
  readonly nameTypeCode: string;
  readonly roleLabel: string | null;
  readonly rawName: string;
  readonly normalizedName: string;
  /**
   * Whether the register's role implies a natural person. A hint for handling,
   * never a claim: the register does not classify, and neither do we.
   */
  readonly likelyNaturalPerson: boolean;
  readonly filingNumber: string | null;
  readonly observedAt: string;
  readonly evidence: SourceEvidence;
};

export function filingPartyIdOf(
  entityId: string,
  nameTypeCode: string,
  rawName: string,
  filingNumber: string | null,
): string {
  return deterministicId('bizparty', entityId, nameTypeCode, rawName, filingNumber ?? '');
}

// ---------------------------------------------------------------------------
// Registry events
// ---------------------------------------------------------------------------

/**
 * Events a registry filing can justify.
 *
 * Note what is absent, and why: nothing here says a company is operating,
 * investing, buying or active in any commercial sense. `BUSINESS_STATUS_OBSERVED`
 * reports a *registration* status. A registry is a register.
 */
export type BusinessEventType =
  | 'BUSINESS_ENTITY_OBSERVED'
  | 'BUSINESS_FILING_OBSERVED'
  | 'BUSINESS_STATUS_OBSERVED'
  | 'BUSINESS_NAME_OBSERVED'
  | 'BUSINESS_ADDRESS_OBSERVED'
  | 'BUSINESS_PARTY_OBSERVED';

/** Everything one registry row produces. */
export type BusinessEntityBundle = {
  readonly entity: BusinessEntityRecord;
  readonly names: readonly BusinessNameObservation[];
  readonly addresses: readonly BusinessAddressObservation[];
  readonly filings: readonly BusinessFilingObservation[];
  readonly parties: readonly BusinessFilingParty[];
};

/**
 * How a downstream consumer may use a value, given the source licence.
 *
 * Minnesota's Electronic Media License Agreement grants the right to "publish
 * and make available in the normal course of its business to its customers" and
 * permits charging for access — but forbids reselling or repackaging *in bulk*
 * any substantial part of the Records, and forbids presenting them as the
 * Official records of the office.
 *
 * So the boundary is not "may a member see this field?" but "is this a derived
 * answer about one entity, or a redistribution of the database?". Classifying it
 * per row makes that judgement reviewable instead of implicit.
 */
export type LicenseClass =
  /** The delivered bytes. Server-side only, never served to anyone. */
  | 'RAW_LICENSED'
  /** Parsed rows, one-to-one with the delivery. Internal processing only. */
  | 'NORMALIZED_PRIVATE'
  /** Canonical entities and resolution evidence. Internal use. */
  | 'CANONICAL_INTERNAL'
  /** A derived answer about a specific entity, in the normal course of business. */
  | 'DERIVED_MEMBER_SAFE'
  /** Nothing is classified this way in DF-0F. */
  | 'PUBLIC_SAFE';
