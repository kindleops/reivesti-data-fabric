/**
 * DF-0Q national transaction reconnaissance: LEADS, not findings.
 *
 * Read this before reading any entry. DF-0Q ran in a runtime with no web access:
 * no page, no API metadata and no terms document was opened. Every candidate
 * below is therefore `UNVERIFIED` and carries NO evidence — not because evidence
 * was lost, but because a quote that was not read off a page would be invented,
 * and `checkPromotion` exists to stop exactly that. The hypotheses are the
 * researcher's prior knowledge of these publishers (to mid-2026), recorded so the
 * next pass knows what to open and in what order, and stated as hypotheses in
 * the fields named for them.
 *
 * Kept apart from `SOURCE_CANDIDATES` deliberately: that catalogue's header
 * promises every entry was checked against an official source, and `df sources
 * rank` / `opportunities` read it without regard to verification level. Mixing
 * unverified leads into it would put guesses on the list a reader treats as
 * researched. These are ranked only by `transactionPriority`, which labels them.
 *
 * `officialUrl` is the authority's root domain, not a guessed deep link;
 * specific endpoints a researcher recalls are in `notes`, marked as recalled.
 */
import type { PlatformFamily, SourceCandidate } from './candidates.ts';
import { candidateId } from './candidates.ts';
import { JURISDICTIONS } from '../registry/jurisdictions.ts';

const AT = '2026-10-19';

/** One line every note starts with, so no entry can be read as researched. */
const LEAD = 'DF-0Q LEAD — nothing here was retrieved or read in DF-0Q; every detail is a hypothesis to verify. ';

// ---------------------------------------------------------------------------
// Platform families (transaction-relevant), hypotheses
// ---------------------------------------------------------------------------

export const NATIONAL_PLATFORM_FAMILIES: readonly PlatformFamily[] = [
  {
    platformId: 'socrata_soda',
    name: 'Tyler Data & Insights (Socrata) — SODA API',
    transportPattern:
      'HTTPS GET /resource/<dataset-id>.json|csv with SoQL $select/$where/$order/$limit/$offset; '
      + 'full export /api/views/<dataset-id>/rows.csv?accessType=DOWNLOAD; metadata /api/views/<dataset-id>.json',
    authenticationPattern: 'none',
    paginationPattern: '$limit + $offset with a stable $order (e.g. :id); an app token raises throttling limits, it does not gate access',
    commonCapabilities: ['deed', 'mortgage', 'mortgage_release', 'sale_observation', 'parcel', 'assessor'],
    connectorReusable: true,
    reuseBoundary:
      'Transport, paging and metadata are one implementation for every Socrata portal (NYC, Cook, CT, MD, LA). '
      + 'RELEASE IDENTITY IS NOT: a SODA dataset is a mutable table with a rowsUpdatedAt stamp, not a versioned '
      + 'file, so the bulk-acquisition ledger cannot fingerprint a publisher release. The release is OUR retrieval: '
      + 'full export → content-addressed artifact → sha256, with rowsUpdatedAt + row count as the NOOP witness. '
      + 'Semantics (document types, party roles) stay per dataset.',
    evidence: [],
  },
  {
    platformId: 'ckan_datastore',
    name: 'CKAN Action API + DataStore',
    transportPattern:
      'HTTPS GET /api/3/action/package_show?id=<dataset>; resources carry url + last_modified; '
      + '/datastore/dump/<resource-id> for a full CSV',
    authenticationPattern: 'none',
    paginationPattern: 'datastore_search limit/offset; bulk dump has none',
    commonCapabilities: ['sale_observation', 'lien', 'foreclosure_notice'],
    connectorReusable: true,
    reuseBoundary:
      'One connector for CKAN discovery and dump retrieval (WPRDC, many state portals). Resource last_modified '
      + 'is a usable NOOP witness when the resource is a file; a DataStore table has the Socrata problem.',
    evidence: [],
  },
  {
    platformId: 'carto_sql',
    name: 'CARTO SQL API',
    transportPattern: 'HTTPS GET /api/v2/sql?q=<SQL>&format=csv',
    authenticationPattern: 'none',
    paginationPattern: 'LIMIT/OFFSET in SQL, or one full CSV',
    commonCapabilities: ['deed', 'transfer'],
    connectorReusable: false,
    reuseBoundary: 'Only a handful of governments publish this way (Philadelphia is the transaction-relevant one).',
    evidence: [],
  },
  {
    platformId: 'government_bulk_archive',
    name: 'Government file at a stable URL (CSV / ZIP / XLSX)',
    transportPattern: 'HTTPS HEAD + GET of a published file; discovery by reading the publisher\'s index page or listing',
    authenticationPattern: 'none',
    paginationPattern: 'none',
    commonCapabilities: ['transfer', 'sale_observation', 'sale_economics', 'tax_sale'],
    connectorReusable: true,
    reuseBoundary:
      'Acquisition is already generic (src/runtime/bulk-acquisition.ts: fingerprint, ledger, NOOP, streamed '
      + 'download — Wisconsin, New York). Discovery of the newest file and the field map are per publisher.',
    evidence: [],
  },
  {
    platformId: 'sharepoint_rest_listing',
    name: 'SharePoint document library REST listing',
    transportPattern: 'GET …/_api/web/GetFolderByServerRelativeUrl(\'<folder>\')?$expand=Folders,Files; each file a plain GET',
    authenticationPattern: 'none',
    paginationPattern: 'none; one listing per folder',
    commonCapabilities: ['parcel', 'assessor', 'sale_observation', 'sale_economics'],
    connectorReusable: false,
    reuseBoundary:
      'Proven anonymous for Florida DOR in DF-0M (AUTOMATED-ACQUISITION.md). Anonymous listing is a per-site '
      + 'configuration, not a SharePoint property: every other library has to be shown anonymous on its own.',
    evidence: [],
  },
  {
    platformId: 'recorder_vendor_portal',
    name: 'County recorder vendor search portals (Tyler Eagle, Kofile, Landmark Web, Laredo, iDocMarket, RecordEASE…)',
    transportPattern: 'interactive web search application; per-page or per-document image fees are common',
    authenticationPattern: 'varies',
    paginationPattern: 'UI paging; not a distribution',
    commonCapabilities: ['deed', 'mortgage', 'mortgage_release', 'lien', 'foreclosure_notice'],
    connectorReusable: false,
    reuseBoundary:
      'Shared software is NOT shared permission. These are search applications, not distributions; terms are '
      + 'per county and frequently forbid automated access (Hennepin RecordEASE names scrapers and robots). '
      + 'No connector against this family without a written, per-county sanction of automated bulk access or a '
      + 'published index export. Its existence is the reason recorded-instrument coverage is 0.',
    evidence: [],
  },
  {
    platformId: 'court_case_portal',
    name: 'State court case-search portals (Odyssey portals, WCCA, PA UJS and similar)',
    transportPattern: 'interactive case search; bulk access, where it exists, is a separate licensed product',
    authenticationPattern: 'varies',
    paginationPattern: 'UI paging',
    commonCapabilities: ['foreclosure_notice', 'court_event'],
    connectorReusable: false,
    reuseBoundary:
      'Judicial foreclosure lives here, and the common bulk route is a paid data licence. Case search UIs are not '
      + 'automated without an explicit sanction.',
    evidence: [],
  },
  {
    platformId: 'auction_vendor_platform',
    name: 'Auction vendor platforms (RealForeclose / RealTaxDeed, Bid4Assets, GovEase and similar)',
    transportPattern: 'vendor-operated auction calendars and listings',
    authenticationPattern: 'varies',
    paginationPattern: 'UI paging',
    commonCapabilities: ['foreclosure_notice', 'tax_sale'],
    connectorReusable: false,
    reuseBoundary:
      'Operated for clerks and treasurers by a private vendor under the vendor\'s terms. The listing copies a '
      + 'notice the official record holds elsewhere; the official record is the target, not the vendor copy.',
    evidence: [],
  },
];

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function lead(c: Omit<SourceCandidate, 'candidateId' | 'verification' | 'lastResearchedAt' | 'evidence'>): SourceCandidate {
  return {
    ...c,
    candidateId: candidateId(c.authority, c.sourceName),
    verification: 'UNVERIFIED',
    lastResearchedAt: AT,
    evidence: [],
  };
}

const NYC_ACRIS_COUNTIES = ['36005', '36047', '36061', '36081'];
const NYC_COUNTIES = [...NYC_ACRIS_COUNTIES, '36085'];
/** New York outside the five boroughs, from the pinned catalogue rather than a typed list. */
const NY_OUTSIDE_NYC = JURISDICTIONS
  .filter((j) => j.jurisdictionType === 'county' && j.stateCode === 'NY' && (j.status ?? 'active') === 'active'
    && j.countyFips !== undefined && !NYC_COUNTIES.includes(j.countyFips))
  .map((j) => j.countyFips as string);

export const NATIONAL_TRANSACTION_CANDIDATES: readonly SourceCandidate[] = [
  // -- 1. Recorded instruments with a published machine distribution ----------
  lead({
    authority: 'New York City Department of Finance — Office of the City Register',
    sourceName: 'ACRIS Real Property Master, Legals, Parties and References (NYC Open Data)',
    scope: { kind: 'counties', countyFips: NYC_ACRIS_COUNTIES },
    capabilities: ['deed', 'mortgage', 'mortgage_release'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://data.cityofnewyork.us',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: '1966-01-01',
    cadence: null,
    platformId: 'socrata_soda',
    notes: LEAD
      + 'The strongest recorded-instrument lead in the country: the City Register\'s own document index published '
      + 'as four related Socrata tables — Master (document id, doc type, recorded/document dates, document amount), '
      + 'Legals (borough-block-lot per document), Parties (party type per document, names, addresses) and '
      + 'References (prior document / CRFN / reel-page) — plus a document-control-codes table naming each doc type. '
      + 'Recalled scope: Manhattan, Bronx, Brooklyn, Queens; Staten Island (36085) is recorded by the Richmond County '
      + 'Clerk and is NOT in ACRIS. VERIFY: dataset ids and row counts from /api/views metadata; update cadence from '
      + 'rowsUpdatedAt; NYC Open Data terms of use; whether party addresses are present (restricted plane if so); '
      + 'lien and lis pendens doc types in the control-codes table before claiming lien or foreclosure_notice; '
      + 'BBL → NYS SWIS+SBL crosswalk for linkage to ny_statewide_parcels (NEW-YORK-STATEWIDE-PROPERTY.md §7). '
      + '"Document amount" is the amount stated on the document — never a sale price for a mortgage, never a balance.',
  }),
  lead({
    authority: 'City of Philadelphia Department of Records',
    sourceName: 'Real Estate Transfers (realty transfer tax summary) on OpenDataPhilly',
    scope: { kind: 'counties', countyFips: ['42101'] },
    capabilities: ['deed', 'transfer', 'sale_economics'],
    transactionSemantics: ['RECORDED_INSTRUMENT', 'TRANSFER_DECLARATION'],
    officialUrl: 'https://opendataphilly.org',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: null,
    platformId: 'carto_sql',
    notes: LEAD
      + 'Recalled as the Department of Records\' recorded documents that carry realty transfer tax — document id, '
      + 'document type, recording and document dates, grantors/grantees, stated consideration, tax paid, OPA '
      + 'account. VERIFY: whether non-deed types (mortgages, satisfactions) are present or only transfer-taxed '
      + 'documents — mortgage/release must not be claimed until a doc-type census shows them; the CARTO table '
      + 'name and the terms; how "total consideration" relates to tax-implied value.',
  }),
  lead({
    authority: 'Maricopa County Recorder',
    sourceName: 'Recorder public document API',
    scope: { kind: 'counties', countyFips: ['04013'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien', 'foreclosure_notice'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://recorder.maricopa.gov',
    accessHypothesis: 'api',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'daily',
    platformId: null,
    notes: LEAD
      + 'Recalled: the Recorder publishes a documented public REST interface (a "publicapi" host) returning '
      + 'recording number, recording date, document codes and names, with images separately. If it exists and '
      + 'is documented for public use, it is the only county-scale recorder API in this list. Arizona trustee '
      + 'sales record a Notice of Trustee\'s Sale, so foreclosure_notice is a RECORDED_INSTRUMENT here. '
      + 'VERIFY BEFORE ANY REQUEST: that the interface is documented by the Recorder for public programmatic use, '
      + 'its terms, rate limits and whether date-range enumeration is offered. An undocumented endpoint behind '
      + 'the search UI is NOT this candidate and must not be used.',
  }),
  lead({
    authority: 'Allegheny County Department of Court Records (via WPRDC)',
    sourceName: 'Tax liens — filings, satisfactions and current status',
    scope: { kind: 'counties', countyFips: ['42003'] },
    capabilities: ['lien'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://data.wprdc.org',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: null,
    platformId: 'ckan_datastore',
    notes: LEAD
      + 'Recalled: municipal and school tax liens docketed in the court of record, with satisfaction status, '
      + 'published by the Western Pennsylvania Regional Data Center. One record = a lien filed (and possibly '
      + 'satisfied) — not a balance owed today and not a tax sale. VERIFY: publisher of record vs WPRDC as '
      + 'republisher, licence, refresh, and parcel id linkage.',
  }),

  // -- 2. Transfer declarations (statewide where they exist) -------------------
  lead({
    authority: 'New Jersey Division of Taxation',
    sourceName: 'SR-1A sales file (statewide deed sales declarations)',
    scope: { kind: 'states', stateCodes: ['NJ'] },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://www.nj.gov/treasury/taxation/',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: 'government_bulk_archive',
    notes: LEAD
      + 'New Jersey county recording officers transmit SR-1A sales data to the State for the sales-ratio study; '
      + 'recalled as published by the State in county files. If public and file-based, it is a statewide '
      + 'transfer declaration for all 21 counties — the highest-leverage TRANSFER candidate in this list. '
      + 'VERIFY: whether the file is posted for download or supplied on request; fee; layout; whether grantor/'
      + 'grantee names are present (restricted plane); the deed book/page reference for recorder linkage.',
  }),
  lead({
    authority: 'New York State Department of Taxation and Finance — Office of Real Property Tax Services',
    sourceName: 'Real Property Transfer Report (RP-5217) sales data',
    scope: { kind: 'counties', countyFips: NY_OUTSIDE_NYC },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://www.tax.ny.gov',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: null,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'Every deed recorded outside New York City is accompanied by an RP-5217 filed through the county clerk '
      + 'to ORPTS, which compiles the sales for equalization. The same authority already supplies the roll '
      + 'behind ny_statewide_parcels, so linkage is SWIS + SBL — the identity this estate already uses. '
      + 'VERIFY: whether ORPTS publishes sale files publicly (a statewide-sales download or an open-data '
      + 'dataset), fee, layout and party fields. NYC files RPTT and records in ACRIS instead, hence the scope.',
  }),
  lead({
    authority: 'Indiana Department of Local Government Finance',
    sourceName: 'Sales disclosure form data',
    scope: { kind: 'states', stateCodes: ['IN'] },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://www.in.gov/dlgf/',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'annual',
    platformId: 'government_bulk_archive',
    notes: LEAD
      + 'Indiana requires a sales disclosure form on conveyances for valuable consideration and DLGF compiles them '
      + 'for ratio studies; recalled as offered in downloadable yearly files. Statewide, 92 counties. VERIFY: '
      + 'public posting vs request, fee, field list, confidentiality of any fields under Indiana law.',
  }),
  lead({
    authority: 'Illinois Department of Revenue',
    sourceName: 'PTAX-203 real estate transfer declarations (MyDec)',
    scope: { kind: 'states', stateCodes: ['IL'] },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://tax.illinois.gov',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'Statewide transfer declaration filed with every taxable deed. No public bulk distribution is recalled; '
      + 'this may be a filing system only, in which case it is MANUAL_ONLY or unavailable. VERIFY before ranking '
      + 'it above Cook\'s published sales.',
  }),
  lead({
    authority: 'Washington State Department of Revenue',
    sourceName: 'Real estate excise tax (REET) affidavit sales data',
    scope: { kind: 'states', stateCodes: ['WA'] },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://dor.wa.gov',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: null,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'Every Washington conveyance files a REET affidavit with stated selling price. Whether DOR publishes the '
      + 'affidavit data statewide is not known; county assessors (King) republish sales derived from it. VERIFY.',
  }),
  lead({
    authority: 'Vermont Department of Taxes',
    sourceName: 'Property transfer tax return data',
    scope: { kind: 'states', stateCodes: ['VT'] },
    capabilities: ['transfer', 'sale_economics'],
    transactionSemantics: ['TRANSFER_DECLARATION'],
    officialUrl: 'https://tax.vermont.gov',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: null,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'Statewide property transfer tax returns filed through town clerks. Small state, but a statewide '
      + 'declaration; VERIFY whether any public distribution exists.',
  }),

  // -- 3. Assessor sale observations (statewide first) -------------------------
  lead({
    authority: 'Connecticut Office of Policy and Management',
    sourceName: 'Real Estate Sales (data.ct.gov)',
    scope: { kind: 'states', stateCodes: ['CT'] },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://data.ct.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: '2001-01-01',
    cadence: 'annual',
    platformId: 'socrata_soda',
    notes: LEAD
      + 'Recalled: every town\'s sales list submitted to OPM for the sales-ratio study — town, address, list year, '
      + 'recorded date, sale amount, assessed value, sales ratio, property type, non-use code. Town-level, no '
      + 'parcel id recalled: linkage would be by town + address, which this estate does not resolve identity on. '
      + 'Geography: Connecticut\'s county-equivalents are now planning regions (NATIONAL-COVERAGE.md §1); town → '
      + 'region must come from the pinned crosswalk, never a remembered one.',
  }),
  lead({
    authority: 'Cook County Assessor\'s Office',
    sourceName: 'Parcel Sales (Cook County Open Data)',
    scope: { kind: 'counties', countyFips: ['17031'] },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://datacatalog.cookcountyil.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: '1999-01-01',
    cadence: null,
    platformId: 'socrata_soda',
    notes: LEAD
      + 'Recalled: the Assessor\'s sales table keyed by PIN, with sale date, price, deed type, document number and '
      + 'buyer/seller names. The document number is a REFERENCE to a recording, not the recording. The Assessor '
      + 'also publishes parcel universe, characteristics and assessed values on the same portal — a full Cook '
      + 'property source is a separate parcel candidate. VERIFY dataset ids, licence, party-name handling.',
  }),
  lead({
    authority: 'King County Department of Assessments',
    sourceName: 'Real property sales extract (assessor data download)',
    scope: { kind: 'counties', countyFips: ['53033'] },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://kingcounty.gov',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_PUBLIC_DOWNLOAD',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: 'government_bulk_archive',
    notes: LEAD
      + 'Recalled: a ZIP of CSV extracts including a sales file — excise tax affidavit number, document date, sale '
      + 'price, buyer/seller names, instrument and sale reason codes, keyed by major/minor parcel. Price is the '
      + 'affidavit\'s as the assessor records it. VERIFY: stable URL (vs a click-through), terms, cadence.',
  }),
  lead({
    authority: 'Allegheny County Office of Property Assessments (via WPRDC)',
    sourceName: 'Property sale transactions',
    scope: { kind: 'counties', countyFips: ['42003'] },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://data.wprdc.org',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: null,
    platformId: 'ckan_datastore',
    notes: LEAD
      + 'Recalled: sales with date, price, deed book/page and a sale-validity code, keyed by parcel id. VERIFY.',
  }),
  lead({
    authority: 'Franklin County (Ohio) Auditor',
    sourceName: 'Auditor data downloads — transfers',
    scope: { kind: 'counties', countyFips: ['39049'] },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://www.franklincountyauditor.com',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: null,
    historicalDepth: null,
    cadence: null,
    platformId: 'government_bulk_archive',
    notes: LEAD
      + 'Ohio auditors process conveyance-fee statements (DTE 100) and some publish transfer files. Stands for '
      + 'the 88-county Ohio auditor family: if Franklin\'s is a stable file, check the next-largest auditors for '
      + 'the same vendor layout before building anything county-specific.',
  }),
  lead({
    authority: 'New York City Department of Finance',
    sourceName: 'Rolling and annualized sales',
    scope: { kind: 'counties', countyFips: NYC_COUNTIES },
    capabilities: ['sale_observation', 'sale_economics'],
    transactionSemantics: ['ASSESSOR_SALE_OBSERVATION'],
    officialUrl: 'https://www.nyc.gov/site/finance/',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_PUBLIC_DOWNLOAD',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: '2003-01-01',
    cadence: 'monthly',
    platformId: 'government_bulk_archive',
    notes: LEAD
      + 'Per-borough sales spreadsheets including Staten Island. Lower priority than ACRIS, which carries the '
      + 'recorded documents these sales derive from; useful as a cross-check, never as deed evidence.',
  }),

  // -- 4. Roll sale echoes (parcel sources that happen to carry a last sale) ---
  lead({
    authority: 'Maryland State Department of Assessments and Taxation',
    sourceName: 'Maryland Real Property Assessments (Maryland Open Data)',
    scope: { kind: 'states', stateCodes: ['MD'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'sale_observation'],
    transactionSemantics: ['TAX_ROLL_SALE_ECHO'],
    officialUrl: 'https://opendata.maryland.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: null,
    platformId: 'socrata_soda',
    notes: LEAD
      + 'A statewide (24 county-equivalents) assessment roll with recent transfers — date, price, grantor and '
      + 'deed liber/folio — echoed on the account. Two things at once: the best next PARCEL state found, and '
      + 'only an ECHO for transactions (the liber/folio is a recording reference, not the recording). Recorded '
      + 'instruments themselves are in MDLandRec, an account-gated viewer — not a distribution.',
  }),
  lead({
    authority: 'District of Columbia Office of Tax and Revenue',
    sourceName: 'Integrated Tax System Public Extract',
    scope: { kind: 'states', stateCodes: ['DC'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'sale_observation'],
    transactionSemantics: ['TAX_ROLL_SALE_ECHO'],
    officialUrl: 'https://opendata.dc.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: null,
    platformId: 'arcgis_feature_service',
    notes: LEAD
      + 'Recalled: DC\'s tax roll as an open-data layer with last sale date and price per SSL. One '
      + 'county-equivalent; ArcGIS transport is already implemented.',
  }),
  lead({
    authority: 'Los Angeles County Office of the Assessor',
    sourceName: 'Assessor parcel data (LA County Open Data)',
    scope: { kind: 'counties', countyFips: ['06037'] },
    capabilities: ['parcel', 'assessor', 'sale_observation'],
    transactionSemantics: ['TAX_ROLL_SALE_ECHO'],
    officialUrl: 'https://data.lacounty.gov',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    acquisitionHypothesis: 'AUTOMATED_OPEN_DATA',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: 'annual',
    platformId: 'socrata_soda',
    notes: LEAD
      + 'Largest county in the US. Recalled as carrying a recording date for the last change of ownership but not '
      + 'a price: California\'s change-of-ownership statements are held confidential by the assessor (Rev. & Tax. '
      + 'Code § 481 — VERIFY the statute text before recording it as a legal limit). Deeds are still recorded and '
      + 'public at the Registrar-Recorder; that office has no recalled bulk index distribution.',
  }),

  // -- 5. State-level recording systems (structural; access unknown) -----------
  lead({
    authority: 'Hawaii Department of Land and Natural Resources — Bureau of Conveyances',
    sourceName: 'Statewide recorded document index (Regular System and Land Court)',
    scope: { kind: 'states', stateCodes: ['HI'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien', 'foreclosure_notice'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://dlnr.hawaii.gov/boc/',
    accessHypothesis: 'manual_import',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'Structurally unique: ONE state office records for the whole state, in two systems (Regular and Land Court '
      + '— the Torrens analogue; identity must carry the system, as Hennepin\'s does). If an index export exists '
      + 'it is a statewide recorded-instrument source. Expected access: an online search UI; that alone is not '
      + 'acquisition. VERIFY whether an index export or data request route exists.',
  }),
  lead({
    authority: 'Alaska Department of Natural Resources — Recorder\'s Office',
    sourceName: 'Statewide recording district index',
    scope: { kind: 'states', stateCodes: ['AK'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://dnr.alaska.gov',
    accessHypothesis: 'manual_import',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'A state-run recorder over recording districts that do not coincide with boroughs/census areas — '
      + 'district → county-equivalent needs its own crosswalk. Alaska does not require price disclosure, so '
      + 'expect deeds without economics. VERIFY access route.',
  }),
  lead({
    authority: 'Iowa County Recorders Association / Iowa Land Records',
    sourceName: 'Iowa Land Records statewide recorded document search',
    scope: { kind: 'states', stateCodes: ['IA'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://iowalandrecords.org',
    accessHypothesis: 'manual_import',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: false,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: 'recorder_vendor_portal',
    notes: LEAD
      + 'All 99 Iowa county recorders behind one portal — the closest thing to a national model of recorder '
      + 'coordination. Recalled as account-gated search with image fees. A shared portal is not a distribution: '
      + 'the question for the association is whether a sanctioned index export or data licence exists, and at '
      + 'what price. Do not automate the search UI.',
  }),
  lead({
    authority: 'Georgia Superior Court Clerks\' Cooperative Authority (GSCCCA)',
    sourceName: 'Statewide real estate, lien and PT-61 indexes',
    scope: { kind: 'states', stateCodes: ['GA'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien', 'transfer', 'sale_economics'],
    transactionSemantics: ['RECORDED_INSTRUMENT', 'TRANSFER_DECLARATION'],
    officialUrl: 'https://www.gsccca.org',
    accessHypothesis: 'vendor_export',
    costHypothesis: 'PAID_SUBSCRIPTION',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'licensed',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: null,
    notes: LEAD
      + 'A statutory statewide authority over all 159 clerks\' real estate and lien indexes and the PT-61 transfer '
      + 'tax form — the best-organised recorded-instrument system in the country, and recalled as subscription '
      + 'priced (with bulk data products also priced). Hypothesised PAID → excluded by doctrine until a free '
      + 'route is shown. VERIFY: whether PT-61 data or any index is offered free; never scrape the search.',
  }),
  lead({
    authority: 'Supreme Court of Virginia — circuit court clerks',
    sourceName: 'Secure Remote Access to land records',
    scope: { kind: 'states', stateCodes: ['VA'] },
    capabilities: ['deed', 'mortgage', 'mortgage_release', 'lien'],
    transactionSemantics: ['RECORDED_INSTRUMENT'],
    officialUrl: 'https://www.vacourts.gov',
    accessHypothesis: 'manual_import',
    costHypothesis: 'PAID_SUBSCRIPTION',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'licensed',
    bulkAvailable: false,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: null,
    cadence: null,
    platformId: 'recorder_vendor_portal',
    notes: LEAD
      + 'Recalled: remote land-record access is a per-clerk subscription under Virginia law. Hypothesised PAID → '
      + 'excluded. Recorded so nobody spends a pass rediscovering it.',
  }),

  // -- 6. Foreclosure, tax sale and auctions ------------------------------------
  lead({
    authority: 'Wisconsin Court System (WCCA)',
    sourceName: 'Circuit court foreclosure cases — WCCA data licence',
    scope: { kind: 'states', stateCodes: ['WI'] },
    capabilities: ['foreclosure_notice'],
    transactionSemantics: ['FORECLOSURE_NOTICE'],
    officialUrl: 'https://wcca.wicourts.gov',
    accessHypothesis: 'api',
    costHypothesis: 'PAID_SUBSCRIPTION',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'licensed',
    bulkAvailable: null,
    apiAvailable: true,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'daily',
    platformId: 'court_case_portal',
    notes: LEAD
      + 'Wisconsin forecloses judicially; the case filing is the earliest official signal. Recalled: the bulk / REST '
      + 'route is a paid data licence; the public case search is not to be automated. Hypothesised PAID → excluded. '
      + 'One case filing = a foreclosure commenced, not a sale, not a judgment.',
  }),
  lead({
    authority: 'Florida county clerks of court (auctions run on a vendor platform)',
    sourceName: 'Online foreclosure and tax deed auction calendars',
    scope: { kind: 'states', stateCodes: ['FL'] },
    capabilities: ['foreclosure_notice', 'tax_sale'],
    transactionSemantics: ['AUCTION_LISTING', 'TAX_SALE_EVENT'],
    officialUrl: 'https://www.flclerks.com',
    accessHypothesis: 'manual_import',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: false,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'daily',
    platformId: 'auction_vendor_platform',
    notes: LEAD
      + 'Most Florida clerks run judicial foreclosure and tax deed sales on per-county subdomains of one vendor '
      + 'platform. Florida is the one state where the estate already has every parcel (67 counties), so a '
      + 'listing would link on parcel id. Vendor terms govern and are expected to forbid automation; the '
      + 'official alternative is each clerk\'s docket and the tax collector\'s tax-certificate records. A listing '
      + 'says a sale is SCHEDULED; most are cancelled or reset.',
  }),
  lead({
    authority: 'Harris County Clerk, Texas',
    sourceName: 'Notice of trustee sale (foreclosure) postings',
    scope: { kind: 'counties', countyFips: ['48201'] },
    capabilities: ['foreclosure_notice'],
    transactionSemantics: ['FORECLOSURE_NOTICE'],
    officialUrl: 'https://www.cclerk.hctx.net',
    accessHypothesis: 'manual_import',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    acquisitionHypothesis: 'UNKNOWN_AUTOMATION',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'monthly',
    platformId: 'county_pdf_postings',
    notes: LEAD
      + 'Texas non-judicial foreclosure requires posting the notice of sale with the county clerk 21 days before '
      + 'the first-Tuesday sale — every one of 254 clerks holds them. Harris is the largest. Same family as '
      + 'Dallas (already catalogued): free to view, per-document PDFs, extraction-heavy. VERIFY whether Harris '
      + 'publishes an index or file rather than PDFs alone.',
  }),
];
