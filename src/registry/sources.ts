/**
 * Seeded national source registry.
 *
 * Only `mn_ecrv` has an adapter in DF-0B. The remaining entries are modelled,
 * not implemented: they exist so that the registry shape is exercised against
 * the real variety of upcoming sources (statewide bulk file, single-county
 * assessor snapshot, county document index, statewide entity API, county notice
 * feed) before an adapter locks the design in. Their status is `planned` and the
 * runtime refuses to run a mapping whose adapter is not registered.
 */
import { createRegistry, type Registry } from './registry.ts';
import { MN_STATEWIDE_PARTICIPATING_COUNTIES } from '../connectors/mn-statewide-parcels/participation.ts';
import { WI_V12_COUNTIES } from '../connectors/wi-statewide-parcels/counties.ts';
import { flExpectedCountyFips } from '../connectors/fl-dor/counties.ts';
import type { SourceDefinition, SourceJurisdictionMapping } from './types.ts';

export const MN_ECRV_SOURCE_ID = 'mn_dor_ecrv_weekly_sales_extract';
export const MN_ECRV_ADAPTER_KEY = 'mn_ecrv';
export const HENNEPIN_ASSESSOR_SOURCE_ID = 'mn_hennepin_county_parcels';
export const HENNEPIN_ADAPTER_KEY = 'mn_hennepin_assessor';
export const HENNEPIN_RECORDER_SOURCE_ID = 'mn_hennepin_recorded_instruments';
export const HENNEPIN_RECORDER_ADAPTER_KEY = 'mn_hennepin_recorder';
export const MN_SOS_SOURCE_ID = 'mn_sos_business_entities';
export const MN_SOS_ADAPTER_KEY = 'mn_sos_business';
export const MN_STATEWIDE_SOURCE_ID = 'mn_statewide_parcels';
export const WI_RETR_SOURCE_ID = 'wi_dor_retr_historical';
export const WI_RETR_ADAPTER_KEY = 'wi_retr';
export const MN_STATEWIDE_ADAPTER_KEY = 'mn_statewide_parcels';
export const WI_STATEWIDE_SOURCE_ID = 'wi_statewide_parcels';
export const WI_STATEWIDE_ADAPTER_KEY = 'wi_statewide_parcels';
export const FL_CADASTRAL_SOURCE_ID = 'fl_statewide_cadastral';
export const FL_CADASTRAL_ADAPTER_KEY = 'fl_statewide_cadastral';
export const FL_NAL_SOURCE_ID = 'fl_dor_nal';
export const FL_NAL_ADAPTER_KEY = 'fl_dor_nal';
export const FL_SDF_SOURCE_ID = 'fl_dor_sdf';
export const FL_SDF_ADAPTER_KEY = 'fl_dor_sdf';

/**
 * What every Florida DOR source shares: the publisher, the portal, the terms.
 * Established 2026-09-29 — see docs/FLORIDA-STATEWIDE-PROPERTY-FABRIC.md §2.
 */
const FL_DOR_COMMON = {
  sourceHomepage: 'https://floridarevenue.com/property/dataportal/Pages/default.aspx',
  accessType: 'bulk_download',
  /**
   * Posted for public download in DOR's Property Tax Oversight data library.
   * Its SharePoint REST listing and every file answer an anonymous GET: no
   * account, cookie, token, session or CAPTCHA. robots.txt restricts neither
   * the library nor its REST path for general agents, and no term of use
   * restricts automated retrieval — the site's "Conditions of Use" link is
   * dead (404) and the records are Florida public records (ch. 119, F.S.).
   */
  automationStatus: 'sanctioned',
  termsStatus: 'reviewed_permitted',
  // Florida public records; the Department and FGIO state disclaimers of
  // accuracy only. No licence, attribution condition or use restriction.
  licenseStatus: 'public_domain',
  costModel: 'free',
  costClass: 'FREE_BULK',
  /** A listed file at a stable URL in a machine-readable folder listing: one GET per file. */
  acquisitionClass: 'AUTOMATED_BULK_DOWNLOAD',
  accessRequest: {
    state: 'NOT_REQUIRED', contact: null, basis: null, requestedAt: null,
    lastUpdatedAt: '2026-09-29', quotedFeeUsd: 0, notes: null,
  },
  sourcePriority: 1,
  active: true,
} as const;

export const SOURCES: readonly SourceDefinition[] = [
  {
    sourceId: MN_ECRV_SOURCE_ID,
    sourceAuthority: 'Minnesota Department of Revenue',
    sourceProgram: 'Electronic Certificate of Real Estate Value (eCRV)',
    sourceFamily: 'state_transfer_declaration',
    sourceName: 'eCRV Weekly Sales Extract',
    sourceHomepage: 'https://www.revenue.state.mn.us/electronic-certificate-real-estate-value-ecrv',
    accessType: 'bulk_download',
    // The publisher distributes the extract to approved requesters. Until that
    // approval is in hand the runtime must not attempt retrieval, so automation
    // is recorded as manual_only rather than sanctioned.
    automationStatus: 'manual_only',
    termsStatus: 'reviewed_restricted',
    licenseStatus: 'unknown',
    costModel: 'free',
    // The department distributes the extract to approved requesters at no
    // charge. Free, but not yet in hand — which is an ACCESS state, not a cost
    // state, and the two are kept apart deliberately.
    costClass: 'FREE_DATA_REQUEST',
    /**
     * Unknown until the request is answered. The department may hand approved
     * requesters a fetchable endpoint or may email a zip each week, and those
     * are opposite answers to the only question that matters here. Recording it
     * as unknown keeps eCRV out of core coverage until somebody knows.
     */
    acquisitionClass: 'UNKNOWN_AUTOMATION',
    role: 'CORE_CANONICAL_SOURCE',
    accessRequest: {
      state: 'NOT_REQUESTED',
      contact: 'ecrv.support@state.mn.us',
      basis: 'Minnesota Department of Revenue eCRV extract distribution',
      requestedAt: null,
      lastUpdatedAt: '2026-08-31',
      quotedFeeUsd: null,
      notes: 'No fee is published for the extract. If a fee is quoted, this source moves to PAID_OPTIONAL.',
    },
    // Extract schema versions are documented back to 2015-10-12; the department
    // does not publish a retention floor for the extract itself.
    historicalDepth: '2015-10-12',
    expectedRefreshFrequency: 'weekly',
    sourcePriority: 1,
    active: true,
    carriesRestrictedContact: true,
    notes:
      'Zipped XML, one document per accepted sale. Contains submitter-provided data only: '
      + 'county/city-added values (assessor values, year built, neighborhood code, study '
      + 'accept/reject, final PIDs, property classifications) are NOT present. Access is '
      + 'granted by request to ecrv.support@state.mn.us.',
  },
  {
    sourceId: HENNEPIN_ASSESSOR_SOURCE_ID,
    sourceAuthority: 'Hennepin County, Minnesota',
    sourceProgram: 'Hennepin County GIS - County Parcels (LAND_PROPERTY)',
    sourceFamily: 'county_assessor',
    sourceName: 'Hennepin County Parcels',
    sourceHomepage: 'https://gis-hennepin.hub.arcgis.com/datasets/county-parcels',
    accessType: 'api',
    // A public ArcGIS REST service the county publishes as open data: no
    // credentials, no licence, and query is the interface it exists to offer.
    automationStatus: 'sanctioned',
    termsStatus: 'reviewed_permitted',
    licenseStatus: 'public_domain',
    costModel: 'free',
    // A public ArcGIS service the county publishes as open data. The reference
    // implementation of a core-eligible source: free, sanctioned, licence-clear,
    // and already proven end to end on 448,087 real parcels.
    costClass: 'FREE_OPEN_DATA',
    /** An ArcGIS FeatureServer. A scheduler pages it; no human involved. */
    acquisitionClass: 'AUTOMATED_OPEN_DATA',
    role: 'CORE_CANONICAL_SOURCE',
    accessRequest: { state: 'NOT_REQUIRED', contact: null, basis: null, requestedAt: null, lastUpdatedAt: '2026-08-31', quotedFeeUsd: null, notes: null },
    // The service publishes only the current compilation; no archive of prior
    // months is offered, so depth begins when Reivesti starts snapshotting.
    historicalDepth: null,
    expectedRefreshFrequency: 'monthly',
    // Authoritative for parcel identity in Hennepin, so it outranks the
    // state-level preliminary PID for that one purpose.
    sourcePriority: 1,
    active: true,
    // OWNER_NM, TAXPAYER_NM and the taxpayer mailing block are personal data.
    carriesRestrictedContact: true,
    authoritativeForParcelIdentity: true,
    notes:
      'ArcGIS MapServer layer 1, 122 fields, ~448k parcel features, EPSG:26915, maxRecordCount 2000. '
      + 'Compiled monthly by Hennepin County GIS from Survey Division geometry and Real Estate Services '
      + 'tax attributes. Licence: furnished AS IS, no warranty, not for legal/engineering/surveying use. '
      + 'Contains no assessment-year column: values are current-as-of-snapshot. Contains no interior '
      + 'structure characteristics (bedrooms, living area, stories).',
  },
  {
    sourceId: HENNEPIN_RECORDER_SOURCE_ID,
    sourceAuthority: 'Hennepin County, Minnesota',
    sourceProgram: 'County Recorder / Registrar of Titles (RecordEASE)',
    sourceFamily: 'county_recorder_index',
    sourceName: 'Hennepin County recorded document index',
    sourceHomepage: 'https://www.hennepincounty.gov/services/property/land-title-records-access',
    // A lawful delivery under the Minnesota Government Data Practices Act, not a
    // machine interface: no API, feed or index export is published.
    accessType: 'manual_import',
    // The binding subscription agreement states: "SUBSCRIBER shall not access the
    // Information by any means other than the Application including but not
    // limited to scraping, robots, wanderers, crawlers, spiders, etc". This is a
    // contractual prohibition, not a rate limit, and the runtime enforces it:
    // no publisher-reaching transport will run against this source.
    automationStatus: 'prohibited',
    termsStatus: 'reviewed_restricted',
    // The RecordEASE application is not the route. The lawful route is a
    // Minn. Stat. ch. 13 data-practices request, which carries no standing fee —
    // so the source is zero-cost and blocked on ACCESS, not on money. A fee
    // quote on the request would move it to PAID_OPTIONAL.
    costClass: 'FREE_DATA_REQUEST',
    /** RecordEASE terms forbid automated retrieval. Settled in DF-0E. */
    acquisitionClass: 'PROHIBITED_AUTOMATION',
    role: 'CORE_CANONICAL_SOURCE',
    accessRequest: {
      state: 'NOT_REQUESTED',
      contact: 'recordsrequest@hennepin.us',
      basis: 'Minn. Stat. ch. 13 (Minnesota Government Data Practices Act)',
      requestedAt: null,
      lastUpdatedAt: '2026-08-31',
      quotedFeeUsd: null,
      notes: 'RecordEASE Pro charges $2.50 per document image; the recording INDEX request is separate and '
        + 'is what this source needs. Automation of the application itself is contractually prohibited.',
    },
    // The same agreement forbids redistribution of the Information, which
    // constrains what any downstream product may expose.
    licenseStatus: 'restricted',
    costModel: 'fee_per_request',
    historicalDepth: null,
    expectedRefreshFrequency: 'daily',
    // The recorder is authoritative for recording date, document number and
    // document type — and for nothing else. Authority is field-specific.
    sourcePriority: 1,
    active: true,
    // Recorded documents name people and often carry their addresses.
    carriesRestrictedContact: true,
    authoritativeForParcelIdentity: false,
    notes:
      'RecordEASE Public (free index search) and RecordEASE Pro ($2.50 per document/certificate/plat, '
      + 'no monthly fee) are browser applications for human use. Programmatic access is contractually '
      + 'prohibited and Hennepin publishes no recorded-document layer in its open data. Activation path '
      + 'is a Minn. Stat. ch. 13 data-practices request for the recording index '
      + '(recordsrequest@hennepin.us). Abstract (Minn. Stat. ch. 507) and Torrens (ch. 508) are '
      + 'separately numbered series and are modelled as distinct registration systems.',
  },
  {
    sourceId: MN_SOS_SOURCE_ID,
    sourceAuthority: 'Minnesota Secretary of State',
    sourceProgram: 'Business & Lien System (MBLS) — Business Bulk Data',
    sourceFamily: 'state_entity_registry',
    sourceName: 'Minnesota Business Bulk Data',
    sourceHomepage: 'https://www.sos.state.mn.us/business-liens/business-help/lists-and-data/',
    accessType: 'bulk_download',
    // There IS a sanctioned bulk product — but obtaining it means a purchase and
    // a signed licence by a human on the MBLS Portal. No machine endpoint exists,
    // and software may not sign or buy on anyone's behalf, so retrieval is
    // manual_only and the runtime will refuse any publisher-reaching transport.
    automationStatus: 'manual_only',
    // Permissive for the intended use and restrictive about redistribution: the
    // licence grants the right to serve customers in the normal course of
    // business and to charge for access, and forbids bulk resale or repackaging.
    termsStatus: 'reviewed_permitted',
    licenseStatus: 'licensed',
    costModel: 'fee_per_request',
    // $710 commercial one-time. DF-0F built the connector before the zero-cost
    // doctrine existed; under it the source is DEFERRED and the connector stays
    // implemented, tested and inactive. It is not deleted and it is not a
    // dependency — a regression test proves the estate works without it.
    costClass: 'PAID_OPTIONAL',
    acquisitionClass: 'MANUAL_ONLY',
    role: 'DEFERRED',
    // The file is a current-state export. It carries only names and addresses
    // active at generation time, so the register supplies no history of its own.
    historicalDepth: null,
    expectedRefreshFrequency: 'monthly',
    // Authoritative for business registration facts in Minnesota, and for
    // nothing about property. Authority is field-specific.
    sourcePriority: 1,
    active: true,
    // Filings name registered agents, organizers and officers, most of whom are
    // natural persons, and give their addresses.
    carriesRestrictedContact: true,
    authoritativeForParcelIdentity: false,
    licenseTerms: {
      licenseName: 'Electronic Media License Agreement',
      licensor: 'Minnesota Office of the Secretary of State',
      statutoryAuthority: 'Minn. Stat. § 13.03 subd. 3',
      fees: [
        { product: 'Business Bulk Data (all records, active and inactive)', usd: 710, basis: 'one_time' },
        { product: 'Active Business Data', usd: 30, basis: 'one_time' },
        { product: 'Active Business Data (weekly refresh)', usd: 30, basis: 'weekly' },
        { product: 'Business name search', usd: 35, basis: 'per_request' },
      ],
      freeFor: ['news media', 'journalists', 'researchers', 'non-commercial use'],
      permitsServingCustomers: true,
      prohibitsBulkRedistribution: true,
      requiresConsentToSublicense: true,
      prohibitsOfficialPresentation: true,
      reviewedAt: '2026-08-31',
      termsUrl: 'https://mblsportal.sos.state.mn.us/',
    },
    notes:
      'One heterogeneous CSV in a ZIP, uncompressed possibly over 2.5 GB, generated at the beginning of '
      + 'each month and delivered through MBLS Portal → Transaction History to a registered account. Three '
      + 'record types (01 master, 02 filing history, 03 name/address) share the file, distinguished by '
      + 'column 2 and keyed by a 36-character Master ID GUID that is static, unique and never recycled. '
      + 'Name and address rows carry only what was ACTIVE at generation time, so the delivery contains no '
      + 'prior-name history. An assumed name is its own master row (business type 59) with no documented '
      + 'link to the business that filed it. Licence permits serving customers and charging for access; it '
      + 'forbids bulk resale or repackaging of any substantial part, sub-licensing without written consent, '
      + 'and presenting the records as the office\'s Official record. Updates require a separate agreement.',
  },
  {
    sourceId: MN_STATEWIDE_SOURCE_ID,
    sourceAuthority: 'Minnesota Geospatial Information Office (MnGeo)',
    sourceProgram: 'Minnesota Geospatial Commons — statewide parcel aggregation',
    sourceFamily: 'state_parcel_aggregation',
    sourceName: 'Parcels, Compiled from Opt-In Open Data Counties, Minnesota',
    sourceHomepage: 'https://gis.data.mn.gov/maps/69148d3959194a05a23964cc60f6517b',
    accessType: 'bulk_download',
    // Open data on the state's own portal: no account, no credentials, no fee.
    // Both a public FeatureServer and a bulk GeoPackage are published.
    automationStatus: 'sanctioned',
    termsStatus: 'reviewed_permitted',
    licenseStatus: 'open_with_attribution',
    costModel: 'free',
    costClass: 'FREE_OPEN_DATA',
    /** A published archive at a stable URL on the state geospatial commons. */
    acquisitionClass: 'AUTOMATED_BULK_DOWNLOAD',
    role: 'CORE_CANONICAL_SOURCE',
    accessRequest: {
      state: 'NOT_REQUIRED', contact: null, basis: null, requestedAt: null,
      lastUpdatedAt: '2026-08-31', quotedFeeUsd: null, notes: null,
    },
    // Each aggregation run republishes the current rolls. No archive of prior
    // runs is offered, so depth begins when Reivesti starts snapshotting.
    historicalDepth: null,
    expectedRefreshFrequency: 'monthly',
    // The county rolls themselves, republished under a state standard. For the
    // 59 participating counties this is authoritative parcel identity — the
    // aggregation does not re-key parcels.
    sourcePriority: 1,
    active: true,
    // owner_name, tax_name and four lines each of owner and taxpayer mailing.
    carriesRestrictedContact: true,
    authoritativeForParcelIdentity: true,
    notes:
      'ArcGIS FeatureServer layer 1 plus a bulk GeoPackage distribution; 94 attribute fields standardised to '
      + 'the MnGAC Parcel Data Standard v1.1.3. 2,710,201 parcels across 59 of Minnesota\'s 87 counties as of '
      + 'the 2026-08-06 aggregation run; participation is per county and is published in layer 0, which also '
      + 'carries each county\'s acquisition date (range 2024-05-20 to 2026-08-06 — freshness varies by over two '
      + 'years). Carries sale_date and sale_value, which are the ASSESSOR\'S echo of a last sale: present on a '
      + 'minority of parcels, including zero-consideration transfers, latest-only, with dates reaching the year '
      + '3009. NOT eCRV-grade transfer economics. Geometry is available and deliberately not ingested.',
  },
  {
    sourceId: WI_STATEWIDE_SOURCE_ID,
    sourceAuthority: 'Wisconsin State Cartographer\'s Office / Wisconsin Land Information Program (DOA)',
    sourceProgram: 'Statewide Parcel Map Initiative — annual statewide parcel database',
    sourceFamily: 'state_parcel_aggregation',
    sourceName: 'Wisconsin Statewide Parcel Map',
    sourceHomepage: 'https://www.sco.wisc.edu/parcels/data/',
    accessType: 'bulk_download',
    /**
     * Published for anyone to download: "This data is provided free of charge".
     * The archive sits at a stable public URL and the FeatureServer answers
     * anonymously. Re-verified 2026-09-28 with no credential, cookie, token or
     * CAPTCHA anywhere on either path.
     */
    automationStatus: 'sanctioned',
    termsStatus: 'reviewed_permitted',
    // No licence is imposed. The publisher asks users to complete a feedback
    // form and credits the V12 project in the layer's copyright text; both are
    // requests, not conditions, and neither restricts use.
    licenseStatus: 'open_with_attribution',
    costModel: 'free',
    /** A published statewide archive, downloadable without payment. */
    costClass: 'FREE_BULK',
    /** One GET of a stable archive URL, discovered from the publisher's page. */
    acquisitionClass: 'AUTOMATED_BULK_DOWNLOAD',
    role: 'CORE_CANONICAL_SOURCE',
    accessRequest: {
      state: 'NOT_REQUIRED', contact: null, basis: null, requestedAt: null,
      lastUpdatedAt: '2026-09-28', quotedFeeUsd: 0, notes: null,
    },
    /**
     * Twelve annual versions are published (V1 2015 through V12 2026). Only the
     * current release is ingested; the older archives are real history that a
     * later phase may backfill, so depth is recorded as what the publisher
     * offers rather than what Reivesti holds.
     */
    historicalDepth: '2015 (V1), annual',
    expectedRefreshFrequency: 'annual',
    sourcePriority: 1,
    active: true,
    // OWNERNME1/2 and PSTLADRESS, a full owner mailing address.
    carriesRestrictedContact: true,
    // The county and municipal rolls themselves, aggregated without re-keying.
    authoritativeForParcelIdentity: true,
    notes:
      'V12.0.0 (2026): 3,574,646 rows across all 72 Wisconsin counties, one File Geodatabase in a 759,926,092-byte '
      + 'archive, 44 attributes plus polygon geometry. Aggregated by the SCO from county and municipal submissions '
      + 'loaded 2026-01-16 to 2026-04-20; V13 is announced for 2027-06-30. Carries owner names, owner mailing '
      + 'address, assessed and estimated fair market values, net and gross tax, property class and three acreage '
      + 'figures. Carries NO year built, NO structure detail and NO sale date or price: it is a parcel roll, not '
      + 'a transfer source. A public FeatureServer serves the same release and is used as a witness, not crawled.',
  },
  {
    sourceId: WI_RETR_SOURCE_ID,
    sourceAuthority: 'Wisconsin Department of Revenue',
    sourceProgram: 'Real Estate Transfer Return — historical data',
    sourceFamily: 'state_transfer_declaration',
    sourceName: 'Wisconsin Real Estate Transfer Return (RETR) historical data',
    sourceHomepage: 'https://www.revenue.wi.gov/Pages/RETr/Home.aspx',
    accessType: 'bulk_download',
    /**
     * A human clicks; the connector ingests what they saved.
     *
     * The download is a JavaScript-generated file behind a liability
     * disclaimer, not an addressable URL — there is nothing for a fetcher to
     * GET. DOR's only sanctioned programmatic route is the RETR web services,
     * which are for approved filing-software providers and are explicitly not
     * a public bulk interface. Driving the portal would therefore be automating
     * an interactive UI the publisher has not offered for that purpose, so the
     * connector does not: it accepts the file a person downloaded.
     */
    automationStatus: 'manual_only',
    termsStatus: 'reviewed_permitted',
    // Wisconsin public records. The disclaimer disclaims liability and asserts
    // no rights over the data; no attribution or use restriction is stated.
    licenseStatus: 'public_domain',
    costModel: 'free',
    /** A file a human downloads from a public page. No account, no fee. */
    costClass: 'FREE_PUBLIC_DOWNLOAD',
    /**
     * MANUAL_ONLY, established by probing the public endpoint in DF-0J.1A.
     *
     * `tap.revenue.wi.gov/RETRHistoric` redirects into My Tax Account, a Fast
     * Enterprises GenTax single-page application whose shell contains no
     * content at all — every view, including the download, is assembled by
     * XHR. Each of those calls must carry a `tap-session` cookie AND a
     * `FAST_VERLAST__` server-state token, both of which the server reissues on
     * every response, inside a session that expires after fifteen minutes.
     * There is no month URL to fetch: the links are JavaScript hash routes and
     * the file is generated server-side per request.
     *
     * So there is nothing here a scheduler can address. Reaching the file means
     * replaying a stateful UI protocol, which is automating an interactive
     * portal the publisher has not offered for that purpose — and DOR's one
     * sanctioned programmatic route, the RETR web services, is approval-gated
     * to filing-software providers and offers no historical bulk retrieval.
     *
     * Both legacy distributions were checked and are gone: the old eRETR data
     * page and the propertyinfo.revenue.wi.gov sales search now 302 into this
     * same portal. There is no second way in.
     */
    acquisitionClass: 'MANUAL_ONLY',
    /**
     * DEFERRED, not core. Reivesti does not depend on a source a person has to
     * fetch: the connector, parser and semantics are finished and tested, and
     * they stay dormant until Wisconsin publishes an automated distribution.
     */
    role: 'DEFERRED',
    accessRequest: {
      state: 'NOT_REQUIRED', contact: 'RETR@wisconsin.gov', basis: null, requestedAt: null,
      lastUpdatedAt: '2026-09-05', quotedFeeUsd: 0, notes:
        'No account, no credentials, no fee. The only gate is a liability disclaimer with Agree/Disagree, '
        + 'which claims no rights over the data and imposes no restriction on use or redistribution.',
    },
    /**
     * Five years, rolling. The tool offers the current year plus five, by
     * month; anything older is referred to the county register of deeds, which
     * is 72 separate offices and not a bulk source.
     */
    historicalDepth: '5 years rolling, by month',
    expectedRefreshFrequency: 'monthly',
    sourcePriority: 1,
    active: true,
    /**
     * Grantor, grantee, agent and tax-bill MAILING ADDRESSES are published, and
     * for an individual grantor that is a home address. Public record does not
     * mean unrestricted product field.
     */
    carriesRestrictedContact: true,
    /**
     * A transfer declaration states the parcel the parties said was conveyed.
     * That is a claim about a parcel, not the assessor's roll, so RETR does not
     * get to define parcel identity — it creates provisional properties that a
     * future Wisconsin parcel source can corroborate.
     */
    authoritativeForParcelIdentity: false,
    notes:
      'Wisconsin\'s analogue of Minnesota eCRV, and the estate\'s first real statewide TRANSFER source. '
      + '78 published fields covering conveyance, parties, parcels, consideration, exemptions, recording and '
      + 'financing flags, across all 72 counties. Two distributions per month: CSV, which the publisher warns '
      + '"can only show one grantor, one grantee, and one parcel", and XML, which "can show all grantors, '
      + 'grantees, and parcels" — so XML is the faithful one and CSV is lossy by design. Identity is '
      + 'county + recorded document number; the public dataset carries no RETR receipt number. Moved into My '
      + 'Tax Account in 2026, which changed the ACCESS mechanics; whether it changed the published schema is '
      + 'an open question until two eras are compared on real files.',
  },
  {
    ...FL_DOR_COMMON,
    sourceId: FL_CADASTRAL_SOURCE_ID,
    sourceAuthority: 'Florida Department of Revenue, Property Tax Oversight (from the 67 county property appraisers)',
    sourceProgram: 'Statewide parcel GIS — county parcel shapefiles joined to the current tax roll ("PAR")',
    sourceFamily: 'state_parcel_aggregation',
    sourceName: 'Florida Statewide Cadastral (DOR parcel shapefiles)',
    role: 'CORE_CANONICAL_SOURCE',
    /**
     * Map Data folders go back to 2005; only the current year is ingested
     * (DF-0M is current data only). Depth is what the publisher offers.
     */
    historicalDepth: '2005 (annual Map Data folders)',
    /** PTO collects the shapefiles each April and posts the joined PAR files each August. */
    expectedRefreshFrequency: 'annual',
    // The joined roll attributes include OWN_ADDR*/FIDU_* mailing lines.
    carriesRestrictedContact: true,
    // The county property appraisers' own parcel numbers, not re-keyed by DOR.
    authoritativeForParcelIdentity: true,
    notes:
      'The primary acquisition path for Florida parcel GIS: 67 county shapefile archives plus the Miami-Dade and '
      + 'St. Johns condominium tables, 4.14 GB, posted 2026-08-07 and joined by DOR to the 2026 PRELIMINARY roll. '
      + 'Each county keeps its own coordinate system. The FGIO-hosted statewide polygon FeatureServer now requires '
      + 'a token, and the anonymous FGIO centroid layer still carries the 2025 roll, so neither is the current '
      + 'source of truth; the PAR files are what FGIO refreshes from. Geometry is summarised (parts, vertices, '
      + 'bbox, area, centroid in the source CRS) and kept exactly in the retained archives; canonical polygons are '
      + 'deferred. The joined roll attributes are the SAME publisher facts as the NAL and are compared with it, '
      + 'never projected a second time.',
  },
  {
    ...FL_DOR_COMMON,
    sourceId: FL_NAL_SOURCE_ID,
    sourceAuthority: 'Florida Department of Revenue, Property Tax Oversight (from the 67 county property appraisers)',
    sourceProgram: 'Real property assessment roll — Name–Address–Legal (NAL) file',
    sourceFamily: 'state_assessment_roll',
    sourceName: 'Florida DOR Name–Address–Legal (NAL) real property roll',
    role: 'CORE_CANONICAL_SOURCE',
    /**
     * Only the most current version of each roll is posted; prior rolls are
     * available by request, which is a manual path this source does not use.
     */
    historicalDepth: 'current roll only (prior rolls by records request — manual, not used)',
    /** Preliminary by July 1, initial final in October, post-VAB final after certification — county by county. */
    expectedRefreshFrequency: 'irregular',
    // OWN_ADDR*, OWN_CITY/STATE/ZIPCD and the fiduciary's mailing lines.
    carriesRestrictedContact: true,
    authoritativeForParcelIdentity: true,
    notes:
      'All 67 county real property rolls as DOR publishes them: 165 columns per parcel — identity, strata, use '
      + 'codes, just/assessed/taxable values and 16 classified-use values, land and improvement facts, two assessor '
      + 'sale echoes, owner and fiduciary names and mailing addresses, short legal, location, homestead '
      + 'portability, 49 exemption values and data-management codes. On 2026-09-29 the current roll was 65 counties '
      + 'PRELIMINARY and 2 FINAL (Citrus, Duval); finality is per county and travels on every observation. '
      + 'Confidential records under s. 119.071 F.S. are withheld from the public files by the Department.',
  },
  {
    ...FL_DOR_COMMON,
    sourceId: FL_SDF_SOURCE_ID,
    sourceAuthority: 'Florida Department of Revenue, Property Tax Oversight (from the 67 county property appraisers)',
    sourceProgram: 'Sale Data File (SDF) submitted with the real property roll',
    sourceFamily: 'state_sale_data_file',
    sourceName: 'Florida DOR Sale Data File (SDF)',
    role: 'CORE_CANONICAL_SOURCE',
    historicalDepth: 'current roll only: transfers in the year before Jan 1 plus the months to submission',
    expectedRefreshFrequency: 'irregular',
    // No names and no addresses: parcel, sale id, codes, book/page/instrument, month, price.
    carriesRestrictedContact: false,
    /**
     * A sale record states which parcel sold; it does not define the parcel.
     * It links to the property the roll created and never creates one.
     */
    authoritativeForParcelIdentity: false,
    notes:
      'One row per transfer of ownership the property appraiser recorded in the sale window — "If a parcel '
      + 'transferred multiple times during that time period, the SDF lists each separately". Carries the '
      + 'appraiser\'s own stable sale identifier, official record book/page or clerk instrument number, sale year '
      + 'and MONTH (no day), a price "derived from the documentary stamp tax amount", and the DOR transfer '
      + 'qualification code. It is a SALE OBSERVATION: not a deed, not a recorded instrument, not a transfer '
      + 'declaration — it names no parties and carries no recording date.',
  },
  {
    sourceId: 'tx_dallas_foreclosure_notices',
    sourceAuthority: 'Dallas County, Texas',
    sourceProgram: 'County Clerk foreclosure notice postings',
    sourceFamily: 'county_notice_feed',
    sourceName: 'Dallas County foreclosure notices',
    sourceHomepage: 'https://www.dallascounty.org/departments/countyclerk/',
    accessType: 'bulk_download',
    automationStatus: 'unknown',
    termsStatus: 'not_reviewed',
    licenseStatus: 'unknown',
    costModel: 'unknown',
    // Not yet researched. Recorded as UNKNOWN_COST rather than assumed free,
    // which is what keeps it out of core coverage until someone reads the terms.
    costClass: 'UNKNOWN_COST',
    acquisitionClass: 'UNKNOWN_AUTOMATION',
    // No role is declared. A source may only be called core once it is KNOWN to
    // be free, which mirrors the sources_core_role_is_zero_cost constraint in
    // migration 0007 and is asserted when the registry is built.

    historicalDepth: null,
    expectedRefreshFrequency: 'weekly',
    sourcePriority: 2,
    active: false,
    carriesRestrictedContact: false,
    notes: 'Event-feed-shaped source: dated notices, not a state of the world. Not implemented. '
      + 'Texas county geography is catalogued as of DF-0G, so this mapping now resolves.',
  },
];

export const MAPPINGS: readonly SourceJurisdictionMapping[] = [
  {
    // One source, 87 counties: the scope is stated once and expanded by the
    // registry. This is the shape most statewide programs take.
    mappingId: 'mn_ecrv__all_mn_counties',
    sourceId: MN_ECRV_SOURCE_ID,
    scope: { kind: 'all_counties_in_states', stateCodes: ['MN'] },
    capabilities: ['transfer', 'deed', 'mortgage', 'parcel', 'contact_enrichment'],
    coverageStart: '2015-10-12',
    coverageEnd: null,
    status: 'blocked_on_access',
    adapterKey: MN_ECRV_ADAPTER_KEY,
    config: {
      schemaVersion: 'sales_extract_schema_3',
      schemaEffectiveFrom: '2020-11-09',
      accessRequestContact: 'ecrv.support@state.mn.us',
    },
  },
  {
    mappingId: 'hennepin_assessor__hennepin',
    sourceId: HENNEPIN_ASSESSOR_SOURCE_ID,
    scope: { kind: 'counties', countyFips: ['27053'] },
    // Only what the layer actually carries. Deliberately absent: `deed`,
    // `mortgage` and `foreclosure_notice` — the county runs other systems that
    // hold those, and this feed is not them.
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    coverageStart: null,
    coverageEnd: null,
    status: 'active',
    adapterKey: HENNEPIN_ADAPTER_KEY,
    config: {
      serviceUrl: 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer',
      layerId: 1,
      maxRecordCount: 2000,
      spatialReferenceWkid: 26915,
      metadataVerifiedAt: '2026-08-31',
    },
  },
  {
    mappingId: 'hennepin_recorder__hennepin',
    sourceId: HENNEPIN_RECORDER_SOURCE_ID,
    scope: { kind: 'counties', countyFips: ['27053'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien'],
    coverageStart: null,
    coverageEnd: null,
    // The adapter is complete and runs against a lawful delivery. What is
    // missing is the delivery, not the code.
    status: 'blocked_on_access',
    adapterKey: HENNEPIN_RECORDER_ADAPTER_KEY,
    config: {
      accessRequestContact: 'recordsrequest@hennepin.us',
      technicalSupportContact: 'ts.recordease.support@hennepin.us',
      subscriptionAgreement: 'https://formcatalog.hennepin.us/rres/recorder_registrar_of_titles/subscription_agreement.html',
      registrationSystems: ['abstract', 'torrens'],
      termsVerifiedAt: '2026-08-31',
    },
  },
  {
    mappingId: 'mn_sos__statewide',
    sourceId: MN_SOS_SOURCE_ID,
    scope: { kind: 'states', stateCodes: ['MN'] },
    capabilities: ['business_entity'],
    coverageStart: null,
    coverageEnd: null,
    // The adapter exists and runs end to end on synthetic fixtures. Live
    // activation waits on a purchase and a signature, not on code.
    status: 'blocked_on_access',
    adapterKey: MN_SOS_ADAPTER_KEY,
    config: {
      product: 'business_bulk_data',
      licensedDelivery: true,
      purchaseUrl: 'https://mblsportal.sos.state.mn.us/',
      implementationGuideVersion: 'mbls-business-bulk-data-implementation-guide/2026-08-31',
      termsVerifiedAt: '2026-08-31',
    },
  },
  {
    // ONE mapping, 59 counties. Not 59 source definitions: coverage is a
    // relationship, and duplicating the source per county would be 59 lies
    // about how many sources exist.
    mappingId: 'mn_statewide_parcels__opt_in_counties',
    sourceId: MN_STATEWIDE_SOURCE_ID,
    scope: { kind: 'counties', countyFips: [...MN_STATEWIDE_PARTICIPATING_COUNTIES] },
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    coverageStart: null,
    coverageEnd: null,
    status: 'active',
    adapterKey: MN_STATEWIDE_ADAPTER_KEY,
    config: {
      serviceUrl: 'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer',
      layerId: 1,
      metadataLayerId: 0,
      bulkUrl: 'https://operations.gis.data.mn.gov/api/publicdownload/download/511/plan_parcels_open.gpkg',
      schemaStandard: 'MnGAC Parcel Data Standard v1.1.3',
      aggregationRunDate: '2026-08-06',
      termsVerifiedAt: '2026-08-31',
    },
  },
  {
    /**
     * One mapping, 72 counties — derived from the counties the V12 release
     * actually contains, which is every catalogued Wisconsin county.
     */
    mappingId: 'wi_statewide_parcels__all_wi_counties',
    sourceId: WI_STATEWIDE_SOURCE_ID,
    scope: { kind: 'counties', countyFips: [...WI_V12_COUNTIES] },
    /**
     * Only what the layer carries. NOT `transfer`, `deed`, `mortgage`, `lien`
     * or `foreclosure_notice`: the schema has no sale, instrument or financing
     * field at all, and it carries no assessor sale echo either.
     */
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    coverageStart: null,
    coverageEnd: null,
    status: 'active',
    adapterKey: WI_STATEWIDE_ADAPTER_KEY,
    config: {
      landingPage: 'https://www.sco.wisc.edu/parcels/data/',
      archiveUrl: 'https://web.s3.wisc.edu/parcels/v12_parcels/V12.0.0_Wisconsin_Parcels_2026_10.3_Uncompressed.zip',
      serviceUrl: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer',
      layerId: 0,
      release: 'V12.0.0-2026',
      acquisition: 'unattended: discover → NOOP if ingested → download archive → derive bundle → ingest',
      schemaDocumentation: 'https://www.sco.wisc.edu/parcels/data/assets/V12/V12_Wisconsin_Statewide_Parcels_Schema_Documentation.pdf',
      termsVerifiedAt: '2026-09-28',
    },
  },
  {
    /**
     * One mapping, 72 counties. A RETR is filed per county — a transfer
     * spanning two counties is two returns — so county is a property of the
     * record and never has to be inferred.
     */
    mappingId: 'wi_retr__all_wi_counties',
    sourceId: WI_RETR_SOURCE_ID,
    scope: { kind: 'all_counties_in_states', stateCodes: ['WI'] },
    /**
     * `transfer` only.
     *
     * NOT `deed`: RETR reports a recording document number, which is evidence
     * that a deed exists, not the deed. NOT `mortgage` or `foreclosure_notice`:
     * the financing fields are five yes/no flags with no amounts, and a
     * foreclosure conveyance type is a transfer that followed a foreclosure,
     * not the notice or the judgment. Claiming those would overstate what the
     * source can answer.
     */
    capabilities: ['transfer'],
    coverageStart: null,
    coverageEnd: null,
    /**
     * `fixture_only`, not `active`. The parser, classifier, consideration model
     * and 78-field layout are complete and tested, and every one of those tests
     * runs against a synthetic fixture. No RETR file has ever been retrieved,
     * and until one can be retrieved without a person, none will be.
     *
     * The mapping is kept rather than deleted so all 72 Wisconsin counties stay
     * visible in the coverage matrix as a known, understood gap. Removing it
     * would make Wisconsin indistinguishable from a state nobody has examined.
     */
    status: 'fixture_only',
    adapterKey: WI_RETR_ADAPTER_KEY,
    config: {
      downloadPage: 'https://tap.revenue.wi.gov/RETRHistoric',
      /**
       * Established by probing the public endpoint on 2026-09-19, and recorded
       * so a future phase can re-test these facts rather than re-derive them.
       * The day any of them changes is the day RETR becomes acquirable.
       */
      acquisitionForensics: {
        probedAt: '2026-09-19',
        platform: 'Fast Enterprises GenTax / My Tax Account (TAP)',
        requestClass: 'E_SESSION_BOUND',
        requiresSessionCookie: 'tap-session',
        requiresRotatingStateToken: 'FAST_VERLAST__',
        sessionIdleTimeoutMinutes: 15,
        stableMonthUrl: false,
        robotsTxt: 'absent on tap.revenue.wi.gov; www.revenue.wi.gov disallows only SharePoint internals',
        termsProhibitAutomation: false,
        legacyDistributionsRetired: [
          'https://www.revenue.wi.gov/Pages/ERETR/data-home.aspx',
          'https://propertyinfo.revenue.wi.gov/WisconsinProd/forms/htmlframe.aspx?mode=content/retransfer.htm',
        ],
        sanctionedProgrammaticRoute:
          'RETR web services, approval-gated to filing-software providers; no bulk historical retrieval',
      },
      distribution: 'xml',
      schemaDocumentedAt: '2026-09-05',
      termsVerifiedAt: '2026-09-05',
      publicationEra: 'mta_2026',
    },
  },
  {
    mappingId: 'fl_statewide_cadastral__all_fl_counties',
    sourceId: FL_CADASTRAL_SOURCE_ID,
    scope: { kind: 'counties', countyFips: [...flExpectedCountyFips()] },
    /**
     * `parcel` only: that the parcel exists as a mapped polygon, under the
     * county's own number. The roll attributes joined to it are the NAL's
     * facts and are claimed by the NAL mapping, not counted twice.
     */
    capabilities: ['parcel'],
    coverageStart: null,
    coverageEnd: null,
    status: 'fixture_only',
    adapterKey: FL_CADASTRAL_ADAPTER_KEY,
    config: {
      library: 'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Map%20Data',
      listing: 'SharePoint REST: _api/web/GetFolderByServerRelativeUrl(<folder>)?$expand=Folders,Files',
      acquisition: 'unattended: list Map Data → newest <year>F/<year>F PAR → per-county GET → derive → ingest',
      readme: 'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Map%20Data/parcel%20shapefiles%20readme.pdf',
      termsVerifiedAt: '2026-09-29',
    },
  },
  {
    mappingId: 'fl_dor_nal__all_fl_counties',
    sourceId: FL_NAL_SOURCE_ID,
    scope: { kind: 'counties', countyFips: [...flExpectedCountyFips()] },
    /** `ownership` is the CURRENT roll's owner of record, never a chain of title. */
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    coverageStart: null,
    coverageEnd: null,
    status: 'fixture_only',
    adapterKey: FL_NAL_ADAPTER_KEY,
    config: {
      library: 'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/NAL',
      acquisition: 'unattended: list NAL → newest roll year → per county the most advanced stage (F over P) → GET',
      layout: 'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/User%20Guides/2026%20Users%20guide%20and%20quick%20reference/2026_NAL_SDF_NAP_Users_Guide.pdf',
      termsVerifiedAt: '2026-09-29',
    },
  },
  {
    mappingId: 'fl_dor_sdf__all_fl_counties',
    sourceId: FL_SDF_SOURCE_ID,
    scope: { kind: 'counties', countyFips: [...flExpectedCountyFips()] },
    /**
     * NOT `transfer`, `deed` or `mortgage`: no parties, no instrument type, no
     * recording date and no financing. The SDF proves an appraiser-reviewed
     * sale in a month at a doc-stamp-derived price, and claims exactly that.
     */
    capabilities: ['sale_observation', 'sale_economics'],
    coverageStart: null,
    coverageEnd: null,
    status: 'fixture_only',
    adapterKey: FL_SDF_ADAPTER_KEY,
    config: {
      library: 'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/SDF',
      acquisition: 'unattended: list SDF → newest roll year → per county the most advanced stage (F over P) → GET',
      qualificationCodes: '2026 User\'s Guide Quick Reference, "Sale Qualification Codes" (applicable to sales occurring in 2026)',
      termsVerifiedAt: '2026-09-29',
    },
  },
  {
    mappingId: 'dallas_foreclosure__dallas',
    sourceId: 'tx_dallas_foreclosure_notices',
    scope: { kind: 'counties', countyFips: ['48113'] },
    capabilities: ['foreclosure_notice'],
    coverageStart: null,
    coverageEnd: null,
    // DF-0G catalogued every US county-equivalent, so this mapping resolves and
    // has rejoined the default registry. It stays `planned`: a resolvable scope
    // is not an adapter, and the runtime still refuses to run it.
    status: 'planned',
    adapterKey: 'dallas_foreclosure',
    config: {},
  },
];

/**
 * Every mapping now resolves.
 *
 * DF-0B..0F held the Dallas mapping out of the default registry because Texas
 * counties were not catalogued and expanding it would have failed. The national
 * geography removed that exclusion, which is the first concrete dividend of
 * DF-0G: a source can be modelled anywhere in the country before its adapter
 * exists.
 */
export const DALLAS_MAPPING = MAPPINGS.find(
  (m) => m.mappingId === 'dallas_foreclosure__dallas',
) as SourceJurisdictionMapping;

export function defaultRegistry(): Registry {
  return createRegistry(SOURCES, MAPPINGS);
}
