/**
 * The national source registry: which authorities publish which kinds of
 * public record, for which places, on what terms, through which adapter.
 *
 * The registry is deliberately independent of any connector implementation. It
 * is the answer to "what could Reivesti ingest, and is it allowed to?" — a
 * question that must be answerable for jurisdictions we have not built yet.
 */

// ---------------------------------------------------------------------------
// Jurisdiction
// ---------------------------------------------------------------------------

export type JurisdictionType = 'nation' | 'state' | 'county' | 'municipality' | 'judicial_district';

import type { CountyEquivalentType, GeographyStatus } from './us-geography.ts';

export type { CountyEquivalentType, GeographyStatus };

export type Jurisdiction = {
  /** Stable Reivesti-owned key, e.g. "us", "us-mn", "us-mn-27053". */
  readonly jurisdictionId: string;
  readonly jurisdictionType: JurisdictionType;
  readonly country: string;
  readonly stateCode?: string;
  readonly stateFips?: string;
  /** Full 5-digit county FIPS (state + county), e.g. "27053". */
  readonly countyFips?: string;
  readonly countyName?: string;
  readonly name: string;
  /** The parent jurisdiction this one sits inside, if any. */
  readonly parentId?: string;
  /**
   * The legal form of a county-equivalent, kept distinct rather than flattened
   * into "county". A parish, a borough, a census area, a planning region and an
   * independent city are governed differently, and the offices that hold their
   * records differ with them — which is a source-registry fact, not trivia.
   */
  readonly countyEquivalentType?: CountyEquivalentType;
  /**
   * Whether this geography is current. Retired identities are RETAINED: a deed
   * recorded in New Haven County in 2019 was recorded there, and rewriting it to
   * a planning region would falsify the record.
   */
  readonly status?: GeographyStatus;
  /** Successor geographies, only where an authoritative crosswalk states them. */
  readonly replacedBy?: readonly string[];
  readonly note?: string;
};

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * What kind of public-record fact a source can supply. A source may supply
 * several; capability is declared per source/jurisdiction pairing because the
 * same publisher often covers different ground in different counties.
 */
export type Capability =
  | 'parcel'
  | 'assessor'
  | 'tax'
  | 'ownership'
  | 'transfer'
  /**
   * A property appraiser's record that a parcel sold, with the price and the
   * appraiser's qualification decision (Florida's SDF). Evidence that a sale
   * happened and was reviewed — NOT a deed, NOT a recorded instrument, NOT a
   * transfer declaration naming the parties.
   */
  | 'sale_observation'
  /** The consideration of such a sale, as the publisher derives it (Florida: from documentary stamp tax). */
  | 'sale_economics'
  | 'deed'
  | 'mortgage'
  | 'mortgage_release'
  | 'foreclosure_notice'
  | 'tax_delinquency'
  | 'tax_sale'
  | 'lien'
  | 'business_entity'
  | 'permit'
  | 'code_violation'
  | 'court_event'
  | 'contact_enrichment';

/** How bytes are obtained. The runtime owns lifecycle; this names the transport. */
export type AccessType =
  | 'bulk_download' //     a published file or archive fetched over HTTP(S)
  | 'api' //               REST/JSON or similar
  | 'soap' //              WSDL-described web service
  | 'sftp' //              credentialed file transfer
  | 'manual_import' //     an operator places the file; no automated retrieval
  | 'object_storage' //    a bucket handoff from the publisher or a partner
  | 'vendor_export'; //    a licensed redistributor's export

/**
 * Whether Reivesti may retrieve this source automatically. "Public" never
 * implies "automatable": this field records the sanctioned mechanism, and the
 * runtime refuses to fetch anything not marked `sanctioned`.
 */
export type AutomationStatus =
  | 'sanctioned' //            publisher offers this feed/API/download for programmatic use
  | 'manual_only' //           lawful to obtain, but only by a human action
  | 'prohibited' //            terms forbid automated retrieval
  | 'unknown'; //              not yet established; treated as prohibited by the runtime

/**
 * HOW the bytes actually arrive, and whether a machine can make them arrive.
 *
 * `AutomationStatus` above answers a question of PERMISSION — may we automate?
 * This answers a question of MECHANISM — is there something to automate? The two
 * are independent and both must pass. A publisher can warmly permit automated
 * retrieval of a file that only exists behind a fifteen-minute session and a
 * rotating state token, and a stable public URL can sit behind terms that
 * forbid touching it. Collapsing the two is how a source nobody can fetch ends
 * up counting as coverage.
 *
 * The distinction this type exists to enforce: **a human in the loop is not an
 * acquisition mechanism.** A source whose retrieval step is "an operator opens
 * a browser each month and saves a file into an inbox" is not a production
 * source, however free, however lawful, however good the data. It will be
 * skipped the month that operator is on leave, and nothing in the pipeline will
 * know the difference between "no transfers recorded" and "nobody clicked".
 */
export type AcquisitionClass =
  // --- Automated. A scheduled process retrieves this with no human present. ---
  /** A documented programmatic interface: REST, SOAP, GraphQL, OGC. */
  | 'AUTOMATED_API'
  /** A published archive at a stable, fetchable URL. */
  | 'AUTOMATED_BULK_DOWNLOAD'
  /** An open-data platform with a machine endpoint: Socrata, CKAN, ArcGIS Hub. */
  | 'AUTOMATED_OPEN_DATA'
  /** A plain public HTTP resource — no session, no token, no negotiation. */
  | 'AUTOMATED_PUBLIC_HTTP'
  /**
   * A headless browser, where the publisher has SAID that is acceptable.
   * Deliberately the least preferred automated class and never the default: it
   * is the most fragile to publisher change and the easiest to mistake for
   * permission that was never given.
   */
  | 'AUTOMATED_BROWSER_ALLOWED'
  // --- Not automated. None of these may carry core coverage. ---
  /** Obtainable only by a human action. Lawful, free, and still not production. */
  | 'MANUAL_ONLY'
  /** The publisher forbids automated retrieval. */
  | 'PROHIBITED_AUTOMATION'
  /** Not yet established. Treated as ineligible, never as automated. */
  | 'UNKNOWN_AUTOMATION';

/** The classes that constitute an unattended acquisition path. */
export const AUTOMATED_ACQUISITION_CLASSES: ReadonlySet<AcquisitionClass> = new Set<AcquisitionClass>([
  'AUTOMATED_API', 'AUTOMATED_BULK_DOWNLOAD', 'AUTOMATED_OPEN_DATA',
  'AUTOMATED_PUBLIC_HTTP', 'AUTOMATED_BROWSER_ALLOWED',
]);

/** True when a machine can acquire this source with nobody watching. */
export function isAutomatedAcquisition(acquisition: AcquisitionClass): boolean {
  return AUTOMATED_ACQUISITION_CLASSES.has(acquisition);
}

export type TermsStatus = 'reviewed_permitted' | 'reviewed_restricted' | 'not_reviewed';

export type LicenseStatus = 'public_domain' | 'open_with_attribution' | 'licensed' | 'restricted' | 'unknown';

/**
 * The original coarse cost model, kept because existing rows use it and
 * rewriting history is not the job. `costClass` below is the field policy reads.
 */
export type CostModel = 'free' | 'fee_per_request' | 'subscription' | 'contract' | 'unknown';

/**
 * What it costs to obtain this source, as a first-class classification.
 *
 * Deliberately separate from access type, automation status, licence status and
 * authority — four questions that are routinely conflated and are genuinely
 * independent. A free source may forbid automation. A paid source may be
 * perfectly lawful to use. Neither fact is derivable from the other, and the
 * zero-cost doctrine turns on the cost answer alone.
 */
export type CostClass =
  // Zero-cost families. Each is a distinct ACQUISITION shape, because the
  // engineering and the operational burden differ even though the price does not.
  /** A published file or archive, downloadable without payment. */
  | 'FREE_BULK'
  /** A documented programmatic interface offered without charge. */
  | 'FREE_API'
  /** A file a human downloads from a public page, no account, no fee. */
  | 'FREE_PUBLIC_DOWNLOAD'
  /** An open-data portal dataset (Socrata, CKAN, ArcGIS Hub, and the like). */
  | 'FREE_OPEN_DATA'
  /** A queryable service — ArcGIS FeatureServer, WFS, OGC API. */
  | 'FREE_WEB_SERVICE'
  /** Obtainable at no charge by a public-records or data-practices request. */
  | 'FREE_DATA_REQUEST'
  /** An operator receives a recurring file at no charge by arrangement. */
  | 'FREE_MANUAL_DELIVERY'
  /** Reivesti's own data. Costs nothing and is owned outright. */
  | 'FIRST_PARTY'
  // Non-zero. Usable, documentable, never required.
  | 'PAID_OPTIONAL'
  | 'PAID_SUBSCRIPTION'
  | 'PAID_PER_RECORD'
  /** Not yet established. Treated as ineligible, NOT as free. */
  | 'UNKNOWN_COST';

/** The zero-cost families, in one place so the doctrine has a single definition. */
export const ZERO_COST_CLASSES: ReadonlySet<CostClass> = new Set<CostClass>([
  'FREE_BULK', 'FREE_API', 'FREE_PUBLIC_DOWNLOAD', 'FREE_OPEN_DATA',
  'FREE_WEB_SERVICE', 'FREE_DATA_REQUEST', 'FREE_MANUAL_DELIVERY', 'FIRST_PARTY',
]);

export function isZeroCost(cost: CostClass): boolean {
  return ZERO_COST_CLASSES.has(cost);
}

/**
 * What a source is FOR in the estate.
 *
 * The point of this field is to stop a paid optional source from quietly
 * becoming load-bearing. A source that is only ever `OPTIONAL_ENRICHMENT` cannot
 * be the thing a canonical property id depends on, and the difference has to be
 * declared rather than discovered during an outage.
 */
export type SourceRole =
  /** Canonical facts the estate is built from. Must be zero-cost. */
  | 'CORE_CANONICAL_SOURCE'
  /** Supports canonical resolution without being the authority. Must be zero-cost. */
  | 'CORE_SUPPORTING_SOURCE'
  /** Adds value; nothing canonical may depend on it. May be paid. */
  | 'OPTIONAL_ENRICHMENT'
  /** Used only to check other sources, never to assert a fact. */
  | 'VALIDATION_ONLY'
  /** A human looks things up here. No ingestion. */
  | 'MANUAL_RESEARCH_ONLY'
  /** Known, deliberately not pursued yet. */
  | 'DEFERRED'
  /** Considered and ruled out. The reason is kept. */
  | 'REJECTED';

/**
 * Administrative state of a free access path.
 *
 * Source OPERATIONS metadata, not source truth: it says where a request has got
 * to, never what the data contains. It matters because a free data request that
 * comes back with a fee quote changes the source's cost class, and that
 * transition needs somewhere to be recorded.
 */
export type AccessRequestState =
  | 'NOT_REQUIRED'
  | 'NOT_REQUESTED'
  | 'REQUESTED'
  | 'AWAITING_RESPONSE'
  | 'APPROVED'
  | 'DENIED'
  | 'FEE_QUOTED'
  | 'DELIVERED';

export type AccessRequest = {
  readonly state: AccessRequestState;
  /** Who the request goes to. */
  readonly contact: string | null;
  /** The statute or programme it is made under, where there is one. */
  readonly basis: string | null;
  readonly requestedAt: string | null;
  readonly lastUpdatedAt: string | null;
  /** Set when the answer came back with a price. Moves the source off zero-cost. */
  readonly quotedFeeUsd: number | null;
  readonly notes: string | null;
};

export type RefreshFrequency =
  | 'continuous'
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'irregular'
  | 'unknown';

export type SourceDefinition = {
  readonly sourceId: string;
  /** The governmental or corporate body that publishes it. */
  readonly sourceAuthority: string;
  /** The named program or system within that authority. */
  readonly sourceProgram: string;
  /**
   * The reusable shape of the source. Sources in the same family can often share
   * an adapter across jurisdictions (e.g. every county on the same vendor platform).
   */
  readonly sourceFamily: string;
  readonly sourceName: string;
  readonly sourceHomepage: string;
  readonly accessType: AccessType;
  readonly automationStatus: AutomationStatus;
  readonly termsStatus: TermsStatus;
  readonly licenseStatus: LicenseStatus;
  readonly costModel: CostModel;
  /** Earliest reference period the publisher retains, ISO date or null if unknown. */
  readonly historicalDepth: string | null;
  readonly expectedRefreshFrequency: RefreshFrequency;
  /** 1 = highest. Ordering hint for resolution when sources disagree. */
  readonly sourcePriority: number;
  readonly active: boolean;
  /** True when the payload can contain personal contact data or protected identity. */
  readonly carriesRestrictedContact: boolean;
  /**
   * True when this source's parcel identifiers are the county-assigned, verified
   * ones — i.e. the office that issues the number publishes this feed.
   *
   * Authority is field- and semantic-specific, never a blanket "county beats
   * state". A county assessor is authoritative for parcel identity and NOT for
   * an accepted transfer price; Minnesota eCRV is authoritative for the latter.
   */
  readonly authoritativeForParcelIdentity?: boolean;
  /**
   * Commercial licence facts, for sources that are bought rather than published.
   *
   * `costModel` says a source costs money; this says what it costs and what the
   * money buys the right to do. That second half is the part that constrains
   * product design, so it belongs in the registry next to the source rather than
   * in a contract folder nobody reads before writing a feature.
   */
  readonly licenseTerms?: SourceLicenseTerms;
  /**
   * What it costs. The zero-cost doctrine reads this field and no other.
   * Optional so DF-0A..0F rows stay valid; policy treats absence as UNKNOWN_COST,
   * which is ineligible rather than free.
   */
  readonly costClass?: CostClass;
  /**
   * How the bytes arrive. Optional so pre-DF-0J.1A rows stay structurally valid;
   * policy treats absence as UNKNOWN_AUTOMATION, which is ineligible rather than
   * automated. Same posture as `costClass`: silence is never a yes.
   */
  readonly acquisitionClass?: AcquisitionClass;
  /** What the source is for. Absence is treated as undeclared, never as core. */
  readonly role?: SourceRole;
  /** Where a free access path has got to administratively. */
  readonly accessRequest?: AccessRequest;
  readonly notes: string;
};

export type LicenseFeeBasis = 'one_time' | 'weekly' | 'monthly' | 'annual' | 'per_request';

export type SourceLicenseTerms = {
  readonly licenseName: string;
  readonly licensor: string;
  /** The statute the licence is made under, where it names one. */
  readonly statutoryAuthority: string | null;
  /** Published prices, in whole US dollars, per product the licence covers. */
  readonly fees: readonly {
    readonly product: string;
    readonly usd: number;
    readonly basis: LicenseFeeBasis;
  }[];
  /** Categories of requester the publisher supplies without charge, if any. */
  readonly freeFor: readonly string[];
  /** Whether the licence permits serving the data to customers in the normal course of business. */
  readonly permitsServingCustomers: boolean;
  /** Whether it forbids reselling or repackaging the records in bulk. */
  readonly prohibitsBulkRedistribution: boolean;
  readonly requiresConsentToSublicense: boolean;
  /** Whether the records may not be presented as the publisher's official record. */
  readonly prohibitsOfficialPresentation: boolean;
  /** ISO date the terms were read. Terms change; an unread licence is an unknown one. */
  readonly reviewedAt: string;
  readonly termsUrl: string;
};

// ---------------------------------------------------------------------------
// Source-to-jurisdiction mapping
// ---------------------------------------------------------------------------

/**
 * Coverage is expressed as a scope, not an enumeration, precisely because a
 * single source may be one county, one state, several states, or national. The
 * registry expands a scope into concrete jurisdictions on demand.
 */
export type JurisdictionScope =
  | { readonly kind: 'nation'; readonly country: string }
  | { readonly kind: 'states'; readonly stateCodes: readonly string[] }
  | { readonly kind: 'all_counties_in_states'; readonly stateCodes: readonly string[] }
  | { readonly kind: 'counties'; readonly countyFips: readonly string[] };

export type CoverageStatus =
  /** Modelled but never run: no adapter has been activated for this pairing. */
  | 'planned'
  /** Adapter exists and has been exercised against fixtures only. */
  | 'fixture_only'
  /** Adapter exists; live retrieval is waiting on credentials or approval. */
  | 'blocked_on_access'
  /** Live retrieval is permitted and has succeeded. */
  | 'active'
  /** Previously active, now stopped. */
  | 'retired';

export type SourceJurisdictionMapping = {
  readonly mappingId: string;
  readonly sourceId: string;
  readonly scope: JurisdictionScope;
  readonly capabilities: readonly Capability[];
  /** ISO date of the earliest reference period covered for this scope. */
  readonly coverageStart: string | null;
  readonly coverageEnd: string | null;
  readonly status: CoverageStatus;
  /** Key of the connector implementation that services this pairing. */
  readonly adapterKey: string;
  readonly config: Readonly<Record<string, unknown>>;
};
