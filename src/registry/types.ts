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

export type TermsStatus = 'reviewed_permitted' | 'reviewed_restricted' | 'not_reviewed';

export type LicenseStatus = 'public_domain' | 'open_with_attribution' | 'licensed' | 'restricted' | 'unknown';

export type CostModel = 'free' | 'fee_per_request' | 'subscription' | 'contract' | 'unknown';

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
  readonly notes: string;
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
