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
    sourceId: 'mn_sos_business_entities',
    sourceAuthority: 'Minnesota Secretary of State',
    sourceProgram: 'Business Services',
    sourceFamily: 'state_entity_registry',
    sourceName: 'Minnesota business entity registry',
    sourceHomepage: 'https://www.sos.state.mn.us/business-liens/',
    accessType: 'bulk_download',
    automationStatus: 'unknown',
    termsStatus: 'not_reviewed',
    licenseStatus: 'unknown',
    costModel: 'unknown',
    historicalDepth: null,
    expectedRefreshFrequency: 'daily',
    sourcePriority: 3,
    active: false,
    carriesRestrictedContact: false,
    notes: 'DF-0E. Statewide entity source used later for organisation party resolution. Not implemented.',
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
    historicalDepth: null,
    expectedRefreshFrequency: 'weekly',
    sourcePriority: 2,
    active: false,
    carriesRestrictedContact: false,
    notes: 'DF-0F. Event-feed-shaped source: dated notices, not a state of the world. Not implemented.',
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
    sourceId: 'mn_sos_business_entities',
    scope: { kind: 'states', stateCodes: ['MN'] },
    capabilities: ['business_entity'],
    coverageStart: null,
    coverageEnd: null,
    status: 'planned',
    adapterKey: 'mn_sos_entities',
    config: {},
  },
  {
    mappingId: 'dallas_foreclosure__dallas',
    sourceId: 'tx_dallas_foreclosure_notices',
    scope: { kind: 'counties', countyFips: ['48113'] },
    capabilities: ['foreclosure_notice'],
    coverageStart: null,
    coverageEnd: null,
    // Texas counties are not catalogued yet, so this mapping is intentionally
    // omitted from the default registry: expanding it would fail loudly, which
    // is the correct behaviour and is asserted in tests.
    status: 'planned',
    adapterKey: 'dallas_foreclosure',
    config: {},
  },
];

/** Mappings whose scopes resolve against the currently catalogued jurisdictions. */
const RESOLVABLE = MAPPINGS.filter((m) => m.mappingId !== 'dallas_foreclosure__dallas');

export const DALLAS_MAPPING_AWAITING_JURISDICTIONS = MAPPINGS.find(
  (m) => m.mappingId === 'dallas_foreclosure__dallas',
) as SourceJurisdictionMapping;

export function defaultRegistry(): Registry {
  return createRegistry(SOURCES, RESOLVABLE);
}
