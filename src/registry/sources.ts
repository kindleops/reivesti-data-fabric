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
import type { SourceDefinition, SourceJurisdictionMapping } from './types.ts';

export const MN_ECRV_SOURCE_ID = 'mn_dor_ecrv_weekly_sales_extract';
export const MN_ECRV_ADAPTER_KEY = 'mn_ecrv';
export const HENNEPIN_ASSESSOR_SOURCE_ID = 'mn_hennepin_county_parcels';
export const HENNEPIN_ADAPTER_KEY = 'mn_hennepin_assessor';
export const HENNEPIN_RECORDER_SOURCE_ID = 'mn_hennepin_recorded_instruments';
export const HENNEPIN_RECORDER_ADAPTER_KEY = 'mn_hennepin_recorder';
export const MN_SOS_SOURCE_ID = 'mn_sos_business_entities';
export const MN_SOS_ADAPTER_KEY = 'mn_sos_business';

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
