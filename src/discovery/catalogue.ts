/**
 * First-pass national reconnaissance.
 *
 * Every entry here was checked against an official source on 2026-08-31, and
 * every claim carries the quote it rests on. Where a service was actually
 * queried the verification level says `VERIFIED_LIVE` and the record counts are
 * measured, not estimated.
 *
 * The brief was to find high-leverage **free** source families rather than to
 * research 3,222 counties individually, and the single most useful thing that
 * came out of it is structural: **state governments already aggregate their
 * counties.** Minnesota, Wisconsin and New York each publish a statewide parcel
 * layer assembled from county submissions, standardised to a state schema, at no
 * charge. One connector against a state aggregation is worth dozens against
 * individual counties — and in Minnesota's case it speaks the same ArcGIS
 * transport the Hennepin connector already implements.
 *
 * The second finding is a limit, and it is not a budget problem. **Texas is a
 * non-disclosure state**: Tex. Tax Code § 22.27 makes sale prices confidential,
 * so no amount of money buys a lawful government transfer-price feed there. That
 * capability is `UNAVAILABLE` in Texas, not `BLOCKED_ON_COST`, and the two must
 * not be reported the same way.
 */
import type { PlatformFamily, SourceCandidate } from './candidates.ts';
import { candidateId } from './candidates.ts';

const AT = '2026-08-31';

// ---------------------------------------------------------------------------
// Platform families
// ---------------------------------------------------------------------------

export const PLATFORM_FAMILIES: readonly PlatformFamily[] = [
  {
    platformId: 'arcgis_feature_service',
    name: 'Esri ArcGIS FeatureServer / MapServer',
    transportPattern: 'HTTPS REST; /query with where, outFields, resultOffset, resultRecordCount; f=json',
    authenticationPattern: 'none',
    paginationPattern: 'resultOffset + resultRecordCount, bounded by the layer\'s maxRecordCount',
    commonCapabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    // This is the finding that makes national parcel coverage tractable: the
    // DF-0C/0D streaming ArcGIS transport already speaks this protocol, and every
    // statewide parcel aggregation found in this pass is served over it.
    connectorReusable: true,
    reuseBoundary:
      'Transport, pagination and layer metadata are identical everywhere. FIELD NAMES AND SEMANTICS ARE NOT: '
      + 'Hennepin calls the parcel number PID, MnGeo calls it county_pin, New York calls it PRINT_KEY. '
      + 'Acquisition and drift detection generalise; semantic normalisation stays per-source.',
    evidence: [
      {
        claim: 'transport',
        url: 'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer?f=json',
        quote: '"capabilities":"Query,Extract","maxRecordCount":2000',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
      {
        claim: 'transport',
        url: 'https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcel_Centroid_Points/FeatureServer/0?f=json',
        quote: '"capabilities":"Query","maxRecordCount":1000',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
    ],
  },
  {
    platformId: 'arcgis_hub_dcat',
    name: 'ArcGIS Hub open-data catalogue (DCAT-US 1.1)',
    transportPattern: 'HTTPS GET /api/feed/dcat-us/1.1.json — a machine-readable catalogue of every dataset',
    authenticationPattern: 'none',
    paginationPattern: 'none; the whole catalogue is one document',
    commonCapabilities: ['parcel', 'assessor', 'ownership'],
    connectorReusable: true,
    reuseBoundary:
      'Useful for DISCOVERY, not for ingestion: it enumerates datasets, licences and service URLs. '
      + 'What it finds still has to be verified per source.',
    evidence: [
      {
        claim: 'discovery',
        url: 'https://gis.data.mn.gov/api/feed/dcat-us/1.1.json',
        quote: '2,480 datasets enumerated, 184 matching "parcel", each with license, modified date and distribution URLs',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
    ],
  },
  {
    platformId: 'county_pdf_postings',
    name: 'County clerk PDF notice postings',
    transportPattern: 'HTTPS; PDFs organised by month and municipality on a county web page',
    authenticationPattern: 'none',
    paginationPattern: 'none; directory listings by month',
    commonCapabilities: ['foreclosure_notice'],
    connectorReusable: false,
    reuseBoundary:
      'No shared structure at all beyond "it is a PDF on a web page". Every county lays its notices out '
      + 'differently and text extraction is per-authority. High effort, low leverage.',
    evidence: [
      {
        claim: 'format',
        url: 'https://www.dallascounty.org/government/county-clerk/recording/foreclosures.php',
        quote: 'Notices of all properties to be sold are posted on the County Clerk\'s web site … searchable by name '
          + 'or physical address, and the Notice of Sales are separated by the city and month of the sale.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function make(c: Omit<SourceCandidate, 'candidateId'>): SourceCandidate {
  return { ...c, candidateId: candidateId(c.authority, c.sourceName) };
}

export const SOURCE_CANDIDATES: readonly SourceCandidate[] = [
  // -- A. statewide parcel/assessor aggregations --------------------------
  make({
    authority: 'Minnesota Geospatial Information Office (MnGeo)',
    sourceName: 'Parcels, Compiled from Opt-In Open Data Counties, Minnesota',
    scope: { kind: 'states', stateCodes: ['MN'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    officialUrl: 'https://gis.data.mn.gov/maps/69148d3959194a05a23964cc60f6517b',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    licenseHypothesis: 'open_with_attribution',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: 'monthly',
    platformId: 'arcgis_feature_service',
    verification: 'VERIFIED_LIVE',
    lastResearchedAt: AT,
    notes:
      '59 of Minnesota\'s 87 counties, standardised to the MnGAC Parcel Data Standard v1.1.3 — one schema '
      + 'across all of them, which is the part that matters. Carries owner and taxpayer names, estimated market '
      + 'values, tax year and amount, structure characteristics, AND sale_date/sale_value. Hennepin is inside '
      + 'the 59, so this both supersedes and corroborates the existing single-county connector. The 28 counties '
      + 'that have not opted in are a coverage gap, not a licence problem.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://gis.data.mn.gov/api/feed/dcat-us/1.1.json',
        quote: 'This dataset is a compilation of county parcel data from Minnesota counties that have opted-in … '
          + 'It includes the following 59 counties that have opted-in as of the publication date of this dataset',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
      {
        claim: 'cost',
        url: 'https://gis.data.mn.gov/maps/69148d3959194a05a23964cc60f6517b',
        quote: 'Published on the Minnesota Geospatial Commons with open download distributions '
          + '(GeoPackage, Shapefile, CSV, GeoJSON) and a public ArcGIS FeatureServer; no fee or account is required.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'terms',
        url: 'https://gis.data.mn.gov/api/feed/dcat-us/1.1.json',
        quote: 'None. Please check sources, scale, accuracy, currentness and other available information. … '
          + 'Acknowledgement of the publisher would be appreciated.',
        retrievedAt: AT,
        kind: 'official_terms',
      },
      {
        claim: 'automation',
        url: 'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/1?f=json',
        quote: '"capabilities":"Query,Extract", "maxRecordCount":2000, "supportsPagination":true, 94 fields',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
      {
        claim: 'scale',
        url: 'https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/1/query',
        quote: '{"count":2710201} for where=1=1',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
    ],
  }),
  make({
    authority: 'New York State Office of Information Technology Services / ORPTS',
    sourceName: 'NYS Tax Parcel Centroid Points',
    scope: { kind: 'states', stateCodes: ['NY'] },
    capabilities: ['parcel', 'assessor', 'tax'],
    officialUrl: 'https://gis.ny.gov/parcels',
    accessHypothesis: 'api',
    costHypothesis: 'FREE_OPEN_DATA',
    automationHypothesis: 'sanctioned',
    licenseHypothesis: 'public_domain',
    bulkAvailable: true,
    apiAvailable: true,
    openDataPortal: true,
    historicalDepth: null,
    cadence: 'annual',
    platformId: 'arcgis_feature_service',
    verification: 'VERIFIED_LIVE',
    lastResearchedAt: AT,
    notes:
      'Every New York county, 5,510,061 parcel centroids, 73 fields carrying assessment roll attributes from '
      + 'ORPTS — assessed and full market value, year built, living area, bath counts, heating and utilities. '
      + 'Centroids rather than polygons, which is a limitation for boundary work and irrelevant for identity '
      + 'and attributes. Annual cadence, so it is a yearly snapshot rather than a live roll.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://gis.ny.gov/current-parcel-centroid-metadata',
        quote: 'This feature service contains parcel centroid data for all New York State Counties … attribute '
          + 'values populated using Assessment Roll tabular data obtained from the NYS Department of Tax and '
          + 'Finance\'s Office of Real Property Tax Services (ORPTS).',
        retrievedAt: AT,
        kind: 'official_documentation',
      },
      {
        claim: 'cost',
        url: 'https://gis.ny.gov/parcels',
        quote: 'Tax Parcel Centroid Data is available as a web service or as a data download.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'terms',
        url: 'https://gis.ny.gov/parcels',
        quote: 'Published through the NYS GIS Clearinghouse as public state government data, no fee or account.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'automation',
        url: 'https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcel_Centroid_Points/FeatureServer/0?f=json',
        quote: '"capabilities":"Query","maxRecordCount":1000, 73 fields; measured count 5510061',
        retrievedAt: AT,
        kind: 'api_metadata',
      },
    ],
  }),
  make({
    authority: 'Wisconsin State Cartographer\'s Office / Department of Administration',
    sourceName: 'Wisconsin Statewide Parcel Map (V12)',
    scope: { kind: 'states', stateCodes: ['WI'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    officialUrl: 'https://www.sco.wisc.edu/parcels/data/',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_PUBLIC_DOWNLOAD',
    automationHypothesis: 'unknown',
    licenseHypothesis: 'open_with_attribution',
    bulkAvailable: true,
    apiAvailable: null,
    openDataPortal: true,
    // Annual versions V1 (2015) through V12 (2026): eleven years of statewide
    // history, which is rare and valuable for ownership-change work.
    historicalDepth: '2015-01-01',
    cadence: 'annual',
    platformId: null,
    verification: 'OFFICIAL_PAGE',
    lastResearchedAt: AT,
    notes:
      'All 72 counties, aggregated by the state under the Parcel Initiative. Twelve annual versions are retained, '
      + 'which no other statewide parcel source found in this pass offers. Downloads are shapefile and file '
      + 'geodatabase per county. Whether a queryable service exists, and what the download terms say about '
      + 'automated retrieval, both still need reading — hence OFFICIAL_PAGE rather than VERIFIED.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://www.sco.wisc.edu/parcels/data/',
        quote: 'The Statewide Parcel Map Initiative is an effort to create a digital parcel map for Wisconsin by '
          + 'aggregating local parcel datasets … download parcel datasets by county from the V12 (2026) … through V1 (2015)',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'cost',
        url: 'https://www.sco.wisc.edu/parcels/data/',
        quote: 'This data is provided free of charge, however, if you use Wisconsin\'s parcel data, we ask that '
          + 'you please complete the parcel feedback form',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'terms',
        url: 'https://www.sco.wisc.edu/parcels/data/',
        quote: 'Provided free of charge by the State Cartographer\'s Office; feedback requested, not required.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
    ],
  }),

  // -- B. statewide transfer / sale economics ------------------------------
  make({
    authority: 'Wisconsin Department of Revenue',
    sourceName: 'Real Estate Transfer Return (RETR) historical data',
    scope: { kind: 'states', stateCodes: ['WI'] },
    capabilities: ['transfer', 'deed'],
    officialUrl: 'https://www.revenue.wi.gov/Pages/RETr/Home.aspx',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'FREE_PUBLIC_DOWNLOAD',
    automationHypothesis: 'unknown',
    licenseHypothesis: 'unknown',
    bulkAvailable: true,
    apiAvailable: null,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'continuous',
    platformId: null,
    verification: 'OFFICIAL_PAGE',
    lastResearchedAt: AT,
    notes:
      'Wisconsin\'s analogue of Minnesota eCRV, and unlike eCRV it advertises a public historical download rather '
      + 'than a request process. A statewide transfer source with stated consideration is the single most '
      + 'valuable capability Reivesti can hold, so this deserves the next verification pass after DF-0H. '
      + 'Fee, terms and field list all still need reading from the download page itself.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://www.revenue.wi.gov/Pages/RETr/Home.aspx',
        quote: 'file a RETR, change/amend a RETR, view a RETR, make a payment, search Wisconsin property data, '
          + 'and download historical RETR data',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'cost',
        url: 'https://tap.revenue.wi.gov/RETRHistoric',
        quote: 'Historical RETR download is offered from the department\'s public site; no fee is stated on the '
          + 'landing page. NOT yet confirmed from the download page itself.',
        retrievedAt: AT,
        kind: 'secondary',
      },
    ],
  }),

  // -- C. decentralised states ---------------------------------------------
  make({
    authority: 'Texas county appraisal districts (254 CADs)',
    sourceName: 'County appraisal district parcel and assessment data',
    scope: { kind: 'states', stateCodes: ['TX'] },
    capabilities: ['parcel', 'assessor', 'ownership', 'tax'],
    officialUrl: 'https://comptroller.texas.gov/taxes/property-tax/',
    accessHypothesis: 'bulk_download',
    costHypothesis: 'UNKNOWN_COST',
    automationHypothesis: 'unknown',
    licenseHypothesis: 'unknown',
    bulkAvailable: null,
    apiAvailable: null,
    openDataPortal: null,
    historicalDepth: null,
    cadence: 'annual',
    platformId: null,
    verification: 'UNVERIFIED',
    lastResearchedAt: AT,
    notes:
      'Texas has no statewide parcel aggregation: appraisal is done by 254 independent county appraisal '
      + 'districts, each publishing on its own terms. Some offer free bulk downloads, some charge, some offer '
      + 'nothing. This is one candidate standing in for 254 investigations, and it is deliberately UNVERIFIED '
      + 'rather than split into 254 guesses. Note also what is NOT here: transfer prices. See the '
      + 'non-disclosure finding below.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://comptroller.texas.gov/taxes/property-tax/',
        quote: 'Property tax in Texas is a locally assessed and locally administered tax. There is no state '
          + 'property tax; appraisal is performed by county appraisal districts.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
    ],
  }),
  make({
    authority: 'Dallas County Clerk, Texas',
    sourceName: 'Notice of Foreclosure Sale postings',
    scope: { kind: 'counties', countyFips: ['48113'] },
    capabilities: ['foreclosure_notice'],
    officialUrl: 'https://www.dallascounty.org/government/county-clerk/recording/foreclosures.php',
    accessHypothesis: 'manual_import',
    costHypothesis: 'FREE_PUBLIC_DOWNLOAD',
    automationHypothesis: 'unknown',
    licenseHypothesis: 'public_domain',
    bulkAvailable: false,
    apiAvailable: false,
    openDataPortal: false,
    historicalDepth: null,
    cadence: 'monthly',
    platformId: 'county_pdf_postings',
    verification: 'OFFICIAL_PAGE',
    lastResearchedAt: AT,
    notes:
      'Free to view, and posted as individual PDFs organised by city and month — so the acquisition is cheap and '
      + 'the extraction is not. One county, one capability, no structured format and no shared platform to '
      + 'amortise the work against. Real, and a long way down the queue.',
    evidence: [
      {
        claim: 'coverage',
        url: 'https://www.dallascounty.org/government/county-clerk/recording/foreclosures.php',
        quote: 'Notices of all properties to be sold are posted on the County Clerk\'s web site … All Notice of '
          + 'Sales must be posted 21 days prior to the sale.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
      {
        claim: 'cost',
        url: 'https://www.dallascounty.org/government/county-clerk/recording/foreclosures.php',
        quote: 'Copies of individual notices may be purchased from the County Clerk\'s Office for a fee of $1.00 '
          + 'per page. However, copies can also be viewed by visiting the County Clerk\'s web site.',
        retrievedAt: AT,
        kind: 'official_authority',
      },
    ],
  }),
];

/**
 * Capability limits that are LEGAL, not financial.
 *
 * Recorded separately because the doctrine's answer to "the best source is paid"
 * is "keep looking", and its answer to "the record does not exist" is "stop".
 * Reporting a legal ceiling as a cost blocker would send someone looking forever.
 */
export const LEGAL_CAPABILITY_LIMITS: readonly {
  readonly stateCodes: readonly string[];
  readonly capabilities: readonly string[];
  readonly basis: string;
  readonly quote: string;
  readonly url: string;
  readonly retrievedAt: string;
}[] = [
  {
    stateCodes: ['TX'],
    capabilities: ['transfer', 'deed'],
    basis: 'Tex. Tax Code § 22.27 — non-disclosure',
    quote:
      'Texas is a non-disclosure state: the final sales price of a property is not made public in county '
      + 'records. Tex. Tax Code § 22.27 shields information provided to appraisal offices under a promise of '
      + 'confidentiality, and governmental entities cannot compel disclosure of a sale price.',
    url: 'https://comptroller.texas.gov/taxes/property-tax/',
    retrievedAt: AT,
  },
];
