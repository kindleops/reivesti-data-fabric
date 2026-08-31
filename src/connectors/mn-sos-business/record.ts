/**
 * The Minnesota SOS bulk-delivery ingestion contract.
 *
 * The Business Bulk Data product is **not a machine interface**. It is a
 * one-time purchase ($710 commercial) collected by a signed-in human from the
 * MBLS Portal's Transaction History, under an Electronic Media License
 * Agreement. So this connector never reaches the publisher: an operator places
 * the delivered ZIP on disk together with a manifest recording *what was bought,
 * under which agreement, and when*, and the runtime ingests that.
 *
 * The manifest is not bookkeeping. A licensed source has obligations attached to
 * particular bytes — the agreement is terminable on notice, and what may be done
 * with a row depends on the licence it arrived under — so the licence terms are
 * recorded alongside the artifact rather than in a wiki page that drifts away
 * from the data.
 *
 * ## Grouping
 *
 * One business is spread across many CSV rows: one master (01), zero or more
 * filings (02), zero or more name/address rows (03), all sharing a Master ID.
 * The guide does not promise the file is grouped or sorted, so the parser does
 * not assume it is — rows are externally sorted by Master ID before grouping.
 * That is bounded-memory (DF-0D machinery) and order-independent, which also
 * makes the result identical no matter how the publisher orders the export.
 */

export const SOS_DELIVERY_KIND = 'df.mn-sos.delivery/1';

/**
 * Which SOS product a delivery is. They differ in coverage and in price, and
 * conflating them would silently narrow the estate: Active Business Data omits
 * every inactive registration, which is exactly the population that matters when
 * tracing a dissolved seller entity.
 */
export type SosProduct =
  /** Every business record, active and inactive. $710 commercial, one-time. */
  | 'business_bulk_data'
  /** Active registrations only. $30 one-time or $30/week. */
  | 'active_business_data';

export type SosLicenseTerms = {
  /** The agreement the delivery arrived under, verbatim in name. */
  readonly agreementName: string;
  /** Statutory authority the agreement cites. */
  readonly statutoryAuthority: string;
  /**
   * True when the agreement permits making the records available to customers
   * in the normal course of business. Minnesota's does (paragraph A.1).
   */
  readonly mayServeCustomers: boolean;
  /**
   * True when the agreement forbids bulk resale or bulk repackaging of a
   * substantial part of the records. Minnesota's does (paragraph C.1) — which is
   * why `LicenseClass` exists and why nothing is `PUBLIC_SAFE`.
   */
  readonly prohibitsBulkResale: boolean;
  /** True when sub-licensing needs written consent. Minnesota's does (C.1). */
  readonly requiresConsentToSublicense: boolean;
  /** True when the records may not be presented as the office's official record (C.7). */
  readonly prohibitsOfficialPresentation: boolean;
  /** ISO date the terms were read and recorded. */
  readonly reviewedAt: string;
  readonly termsUrl: string;
};

export type SosDeliveryManifest = {
  readonly kind: typeof SOS_DELIVERY_KIND;
  readonly sourceId: string;
  readonly product: SosProduct;
  /** The registry jurisdiction the register covers. */
  readonly registryJurisdictionId: string;
  /**
   * When the publisher generated the file. The guide states the bulk file is
   * created at the beginning of each month, and every name and address in it is
   * the one *active at generation time* — so this timestamp is the `observedAt`
   * for every name and address row, not the date we happened to load it.
   */
  readonly fileGeneratedAt: string;
  /** When the operator obtained it. */
  readonly obtainedAt: string;
  /** Name of the CSV inside the delivered archive. */
  readonly entryName: string;
  /** sha256 of the delivered archive, recorded by the operator at download. */
  readonly archiveSha256: string | null;
  /** Version or digest of the implementation guide the layout was pinned from. */
  readonly implementationGuideVersion: string;
  readonly license: SosLicenseTerms;
};

/** Minnesota's terms as read from the agreement on 2026-08-31. */
export const MN_SOS_LICENSE: SosLicenseTerms = {
  agreementName: 'Electronic Media License Agreement',
  statutoryAuthority: 'Minn. Stat. § 13.03 subd. 3',
  mayServeCustomers: true,
  prohibitsBulkResale: true,
  requiresConsentToSublicense: true,
  prohibitsOfficialPresentation: true,
  reviewedAt: '2026-08-31',
  termsUrl: 'https://mblsportal.sos.state.mn.us/',
};

// ---------------------------------------------------------------------------
// The grouped record
// ---------------------------------------------------------------------------

/**
 * Everything the delivery says about one Master ID.
 *
 * `master` may be null: the file can carry filing or name rows whose master row
 * is absent (a mid-export change, a truncated delivery). Those are **orphans**
 * and are reported rather than dropped or attached to a guess, because silently
 * discarding a filing is a silently incomplete corporate history.
 */
export type SosEntityRecord = {
  readonly masterId: string;
  readonly master: SosMasterFields | null;
  readonly filings: readonly SosFilingFields[];
  readonly names: readonly SosNameAddressFields[];
};

/**
 * Deliberately absent: the row numbers this record was assembled from.
 *
 * They are genuinely useful for tracing a row back to the file, and they are
 * still reported on quarantined rows for exactly that reason. But a record's
 * digest drives revision detection and the run's normalized digest, and a row
 * number is a property of the DELIVERY'S ORDERING, not of the business. Carrying
 * one here made a reshuffled export look like a register in which every company
 * had changed.
 */

export type SosMasterFields = {
  readonly businessTypeCode: string;
  readonly originalFilingNumber: string | null;
  readonly minnesotaBusinessName: string;
  readonly businessFilingStatus: string | null;
  readonly filingDate: string | null;
  readonly expirationDate: string | null;
  readonly nextRenewalDueDate: string | null;
  readonly homeJurisdiction: string | null;
  readonly governingStatute: string | null;
  readonly isLlcNonProfit: boolean | null;
  readonly isLllp: boolean | null;
  readonly isProfessional: boolean | null;
  readonly homeBusinessName: string | null;
  readonly numberOfShares: string | null;
  readonly businessMarkType: string | null;
  readonly markFirstUseDate: string | null;
  readonly markClassificationNumber: string | null;
  readonly exportDate: string | null;
};

export type SosFilingFields = {
  readonly filingNumber: string;
  readonly filingActionRaw: string;
  readonly filingRank: 'primary' | 'secondary' | 'unknown';
  readonly filingDate: string | null;
  readonly effectiveDate: string | null;
};

export type SosNameAddressFields = {
  readonly filingNumber: string | null;
  readonly nameTypeCode: string | null;
  readonly addressTypeCode: string | null;
  readonly partyName: string | null;
  readonly streetAddressLine1: string | null;
  readonly streetAddressLine2: string | null;
  readonly cityName: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly postalCodeExtension: string | null;
  readonly countryName: string | null;
};

/**
 * Field groups for change reporting.
 *
 * A monthly register delivery restates every row, so "changed" is only useful if
 * the run can say *what kind* of thing changed: 900 status changes and 12 name
 * changes, not 912 rows.
 */
export const SOS_FIELD_GROUPS = [
  'identity', 'status', 'filings', 'names', 'addresses', 'parties',
] as const;

export type SosFieldGroup = typeof SOS_FIELD_GROUPS[number];
