import { ACTIVE_COUNTY_EQUIVALENTS } from '../../registry/us-geography.ts';
import { fail } from '../../core/errors.ts';

/** Wisconsin. */
export const WI_STATE_FIPS = '55';

/**
 * Wisconsin RETR code lists, transcribed from the publisher's data dictionary.
 *
 * Read from My Tax Account → Download Historical RETR Data → View CSV
 * Documentation on 2026-09-05. Every value below appears in that page's "…
 * Values" tables verbatim. An unlisted value is drift and is reported as such
 * rather than guessed at.
 *
 * These lists are what makes DF-0J's transfer classification defensible: the
 * conveyance type and the ch. 77.25 exemption are the publisher's own
 * statements about what kind of transfer happened, so a classification derived
 * from them is a reading of the source rather than an inference about it.
 */

/** All 72 Wisconsin counties, as the dataset spells them. */
export const WI_COUNTIES: readonly string[] = [
  'Adams', 'Ashland', 'Barron', 'Bayfield', 'Brown', 'Buffalo', 'Burnett', 'Calumet', 'Chippewa', 'Clark',
  'Columbia', 'Crawford', 'Dane', 'Dodge', 'Door', 'Douglas', 'Dunn', 'Eau Claire', 'Florence', 'Fond du Lac',
  'Forest', 'Grant', 'Green', 'Green Lake', 'Iowa', 'Iron', 'Jackson', 'Jefferson', 'Juneau', 'Kenosha',
  'Kewaunee', 'La Crosse', 'Lafayette', 'Langlade', 'Lincoln', 'Manitowoc', 'Marathon', 'Marinette', 'Marquette',
  'Menominee', 'Milwaukee', 'Monroe', 'Oconto', 'Oneida', 'Outagamie', 'Ozaukee', 'Pepin', 'Pierce', 'Polk',
  'Portage', 'Price', 'Racine', 'Richland', 'Rock', 'Rusk', 'Sauk', 'Sawyer', 'Shawano', 'Sheboygan', 'St. Croix',
  'Taylor', 'Trempealeau', 'Vernon', 'Vilas', 'Walworth', 'Washburn', 'Washington', 'Waukesha', 'Waupaca',
  'Waushara', 'Winnebago', 'Wood',
];

/**
 * County name to FIPS, resolved against the national jurisdiction registry.
 *
 * The dataset publishes a county NAME; Reivesti partitions by FIPS. The
 * mapping is looked up rather than computed: Wisconsin's codes look like
 * "odd numbers in alphabetical order" and are not — Menominee County is 55078,
 * even, because it was created in 1961 after the odd numbers had been handed
 * out. A derived code would have been wrong for Menominee and shifted every
 * county after it, which is a whole-state routing failure produced by a pattern
 * that held for 71 of 72 rows.
 *
 * Built at module load so a registry change cannot silently disagree with a
 * copy pinned here, and so a county the dataset names that the registry does
 * not know is a startup failure rather than a quarantined row a year later.
 */
export const WI_COUNTY_FIPS: Readonly<Record<string, string>> = Object.freeze(buildCountyFips());

function buildCountyFips(): Record<string, string> {
  const byName = new Map(
    ACTIVE_COUNTY_EQUIVALENTS
      .filter((county) => county.stateFips === WI_STATE_FIPS)
      .map((county) => [county.name.replace(/ County$/, ''), county.fips]),
  );

  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of WI_COUNTIES) {
    const fips = byName.get(name);
    if (fips === undefined) missing.push(name);
    else out[name] = fips;
  }
  if (missing.length > 0) {
    fail('CONFIG', `the jurisdiction registry has no Wisconsin county named ${missing.join(', ')}`, {
      remedy: 'the RETR county list and the federal catalogue disagree; reconcile before ingesting',
    });
  }
  return out;
}

/** Conveyance types. This field, not the document type, says what happened. */
export const WI_CONVEYANCE_TYPES: readonly string[] = [
  'Affidavit of correction/correction instrument',
  'County/municipality foreclosure judgment',
  'Deed in satisfaction of land contract',
  'Divorce or between spouses',
  'Exchange',
  'Foreclosure or In lieu of foreclosure (no prior interest in property or mortgage)',
  'Foreclosure or In lieu of foreclosure (with prior interest in property or mortgage)',
  'Gift',
  "Judgment/Sheriff's deed (no prior interest in the mortgage or property)",
  "Judgment/Sheriff's deed (with prior interest in the mortgage or property)",
  'Land contract amendment',
  'Member(s) to LLC or LLC to member(s)',
  'Mineral lease',
  'Mineral lease (amendment)',
  'Mineral lease (royalties transfer fee payment)',
  'Other',
  'Parcel creation (WRPLA improvement document or other type of document)',
  'Parent/child or grandparent/grandchild - gift',
  'Parent/child or grandparent/grandchild - part sale/part gift',
  'Partition',
  'Partner(s) to partnership or Partnership to partner(s)',
  'Sale',
  'Shareholder(s) to corporation or corporation to shareholder(s)',
  "Sheriff's deed of partition",
  "Termination of decedent's interest",
  'Transfer by affidavit (PR-1831)',
  'Trust (conveyance to)',
  'Trustee to a 3rd party',
  'Trustee to beneficiary',
  'Will, decedent, or survivorship',
];

/** Document types. The instrument that was filed, which is a separate question. */
export const WI_DOCUMENT_TYPES: readonly string[] = [
  'Affidavit of correction/correction instrument',
  'Assignment of lease (99 years or more)',
  'Assignment of lease (less than 99 years) with improvements',
  'Assignment of lease (less than 99 years) with no improvements',
  'Building, fixtures, improvements document - WRPLA',
  'Condominium deed',
  'Designation of a TOD beneficiary',
  'Easements',
  'Foreclosure - county/municipality judgment',
  "Foreclosure - judgment/sheriff's deed",
  'Land contract',
  'Land contract - amendment',
  "Land contract - assignment of vendee's interest",
  "Land contract - assignment of vendor's interest",
  'Lease of 99 years or more',
  'Lease of less than 99 years',
  'Mineral lease/amendment to mineral lease',
  'Option to purchase/Right of first-refusal',
  'Other',
  "Partition - sheriff's deed",
  "Personal representative's deed",
  'Quit claim deed',
  "Termination of decedent's interest",
  'Transfer by affidavit (PR-1831)',
  "Trustee's deed",
  'Warranty deed',
  'WDOT - Award of damages by state of Wisconsin',
  'WDOT - Conveyances of rights in land',
  'WDOT - Deed by corporation',
  'WDOT - Highway easement',
  'WDOT - Notice of lis pendens',
  'WDOT - Permanent limited easement',
  "WDOT - Personal representative's deed",
  'WDOT - Quit claim deed - by corporation',
  'WDOT - Quit claim deed - state grantor',
  'WDOT - Quit claim deed - state purchase',
  'WDOT - Temporary limited easement',
  'WDOT - Temporary right of entry easement',
  "WDOT - Trustee's deed",
  'WDOT - Warranty deed',
];

/** Declared relationship between the parties. */
export const WI_PARTY_RELATIONSHIPS: readonly string[] = [
  'Employer/employee', 'Ex-spouses', 'Family', 'Financial', 'No relationship', 'Other',
  'Parent/child or grandparent/grandchild', 'Shareholder/partner/member', 'Spouses',
];

/** How much of the grantor's interest the grantee receives. */
export const WI_OWNERSHIP_TYPES: readonly string[] = ['Full', 'Other', 'Partial'];

/** What the grantor kept. A retained life estate is not a clean transfer. */
export const WI_RIGHTS_RETAINED: readonly string[] = ['Easement', 'Life Estate', 'None', 'Other'];

/** How much of the parcel moved. */
export const WI_PARCEL_TRANSFER_TYPES: readonly string[] = [
  '1. Entire parcel', '2. Less than 100%', '3. Improvements only', '4. New parcel',
];

export const WI_PROPERTY_TYPES: readonly string[] = [
  'Buildings/improvements only', 'Condominium', 'Land and buildings/improvements', 'Land only',
  'Miscellaneous', 'Timeshare',
];

export const WI_PROPERTY_USE_TYPES: readonly string[] = [
  'Agricultural (Class 4)', 'Agricultural forest (Class 5m)', 'Commercial (Class 2)', 'Manufacturing (Class 3)',
  'Multi-family', 'Other (Class 7)', 'Productive forest land (Class 6)', 'Single family (Class 1)',
  'Telephone company', 'Undeveloped land (Class 5)', 'Utility',
];

export const WI_PROPERTY_USE_SUB_TYPES: readonly string[] = [
  'Contractor shop', 'Gas station/convenience store', 'Miscellaneous', 'Mixed retail/office/residential',
  'Office', 'Quarry', 'Restaurant/tavern', 'Retail', 'Service garage', 'Warehouse',
];

/** Party types. Shared by Grantor Type and Grantee Type. */
export const WI_PARTY_TYPES: readonly string[] = [
  'Charitable remainder trust', 'Corporation', 'Corporation (non-stock)', 'County', 'Decedent', 'Estate',
  'Federal agency', 'Financial institution', 'General partnership', 'Individual', 'Irrevocable trust',
  'Limited liability company', 'Limited liability partnership', 'Limited partnership',
  'Local exposition district (subch. II of ch. 229)', 'Municipality', 'Other', 'Real estate investment trust',
  'Revocable trust', 'State agency', 'Unincorporated non-profit association (sec. 184.15, Wis. Stats.)',
];

/**
 * Party types that name an organization rather than a natural person.
 *
 * Used to decide whether a party observation is a candidate for organization
 * linkage at all. It does NOT resolve identity — DF-0J leaves grantor and
 * grantee as unresolved party observations, and this set only avoids offering
 * a natural person's name to an entity resolver.
 */
export const WI_ORGANIZATION_PARTY_TYPES: ReadonlySet<string> = new Set([
  'Charitable remainder trust', 'Corporation', 'Corporation (non-stock)', 'County', 'Estate', 'Federal agency',
  'Financial institution', 'General partnership', 'Irrevocable trust', 'Limited liability company',
  'Limited liability partnership', 'Limited partnership', 'Local exposition district (subch. II of ch. 229)',
  'Municipality', 'Real estate investment trust', 'Revocable trust', 'State agency',
  'Unincorporated non-profit association (sec. 184.15, Wis. Stats.)',
]);

/**
 * The ch. 77.25 transfer-fee exemptions, as the dataset spells them.
 *
 * Published as "code - label". The code before the dash is the statutory
 * subsection and is the stable part; the label is the publisher's shorthand and
 * has at least one typo ("6d - Partisanship/qualification" is s. 178.0901
 * partnership qualification), which is exactly why the code is what gets parsed.
 */
export const WI_FEE_EXEMPTIONS: readonly string[] = [
  '1 - Prior to 1-Oct-1969',
  '10 - Secure/release debt',
  '10m - Designate TOD 705.15',
  '11 - Will, descent survivorship',
  '11m - Transfer on death 705.15',
  '12 - Condemnation',
  '13 - Value under $1,000',
  '14 - Foreclosure',
  '15 - Corp/sole or family',
  '15m - Partnership/family',
  '15s - LLC/sole or family',
  '16 - To trust',
  '17 - Satisfaction of land contract',
  '18 - Exposition district',
  '2 - From government agency',
  '20 - Nonprofit fiduciary',
  '21 - Transmission company',
  '2g - Gift to government agency',
  '2r - Road to government agency',
  '3 - Correct prior',
  '4 - Delinquent tax',
  '5 - Partition',
  '6 - Mergers',
  '6d - Partisanship/qualification',
  '6m - Convert entity',
  '6q - Interest exchange',
  '6t - Domestication',
  '7 - Subsidiary corporation to parent',
  '8 - Gift parent/children or grandparent/grandchildren',
  '8m - Between spouses',
  '8n - Domestic partners',
  '9 - Agent/trustee',
];

/** The statutory subsection alone, e.g. "8m" from "8m - Between spouses". */
export function exemptionCode(value: string | null): string | null {
  if (value === null) return null;
  const dash = value.indexOf(' - ');
  const code = (dash === -1 ? value : value.slice(0, dash)).trim();
  return code === '' ? null : code;
}

/**
 * The transfer fee rate, in minor units of fee per minor unit of value.
 *
 * s. 77.22(1), Wis. Stats.: 30 cents per $100 of value. A deed satisfying an
 * original land contract dated between 1971-12-17 and 1981-08-31 is charged 10
 * cents per $100 instead. Both rates are recorded because DF-0J's derivation
 * rules refuse to invert a fee without knowing which rate applied — see
 * `derive.ts`.
 */
export const WI_TRANSFER_FEE_RATE = 0.003;
export const WI_TRANSFER_FEE_RATE_LAND_CONTRACT = 0.001;
export const WI_LAND_CONTRACT_RATE_FROM = '1971-12-17';
export const WI_LAND_CONTRACT_RATE_TO = '1981-08-31';
