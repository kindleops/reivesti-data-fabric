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
    sourceId: 'mn_hennepin_assessor',
    sourceAuthority: 'Hennepin County, Minnesota',
    sourceProgram: 'Assessor / Property Information',
    sourceFamily: 'county_assessor',
    sourceName: 'Hennepin County assessor and parcel data',
    sourceHomepage: 'https://www.hennepin.us/residents/property',
    accessType: 'bulk_download',
    automationStatus: 'unknown',
    termsStatus: 'not_reviewed',
    licenseStatus: 'unknown',
    costModel: 'unknown',
    historicalDepth: null,
    expectedRefreshFrequency: 'unknown',
    sourcePriority: 2,
    active: false,
    carriesRestrictedContact: false,
    notes: 'DF-0C. Snapshot-shaped source: full-state-of-the-world per release. Not implemented.',
  },
  {
    sourceId: 'mn_hennepin_recorded_instruments',
    sourceAuthority: 'Hennepin County, Minnesota',
    sourceProgram: 'County Recorder / Registrar of Titles (RecordEASE)',
    sourceFamily: 'county_recorder_index',
    sourceName: 'Hennepin County recorded document index',
    sourceHomepage: 'https://www.hennepin.us/residents/property/recording-documents',
    accessType: 'vendor_export',
    automationStatus: 'unknown',
    termsStatus: 'not_reviewed',
    licenseStatus: 'unknown',
    costModel: 'subscription',
    historicalDepth: null,
    expectedRefreshFrequency: 'daily',
    sourcePriority: 2,
    active: false,
    carriesRestrictedContact: false,
    notes: 'DF-0D. Document-index-shaped source: append-only instrument records. Requires sanctioned access. Not implemented.',
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
    sourceId: 'mn_hennepin_assessor',
    scope: { kind: 'counties', countyFips: ['27053'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    coverageStart: null,
    coverageEnd: null,
    status: 'planned',
    adapterKey: 'hennepin_assessor',
    config: {},
  },
  {
    mappingId: 'hennepin_recorder__hennepin',
    sourceId: 'mn_hennepin_recorded_instruments',
    scope: { kind: 'counties', countyFips: ['27053'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien'],
    coverageStart: null,
    coverageEnd: null,
    status: 'planned',
    adapterKey: 'hennepin_recorder',
    config: {},
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
