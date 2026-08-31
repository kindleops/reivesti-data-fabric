/**
 * Minnesota SOS bulk-data domain vocabularies.
 *
 * Transcribed from Appendix II of the *Business Bulk Data Implementation Guide*
 * (Minnesota Business & Lien System), retrieved 2026-08-31.
 *
 * These are lookups, not interpretations. An unknown code is retained and
 * reported, never mapped to a nearest neighbour: a business-type code drives
 * whether an entity is a company or a trademark, and a name-type code decides
 * whether a row names a natural person.
 */
import type { BusinessAddressFamily } from '../../canonical/organizations.ts';

// ---------------------------------------------------------------------------
// Business types (Appendix II)
// ---------------------------------------------------------------------------

export type BusinessTypeEntry = {
  readonly code: string;
  readonly label: string;
  readonly domesticity: 'domestic' | 'foreign' | 'unknown';
  /**
   * False for rows that are not companies at all. A Name Reservation is a
   * placeholder and a Trademark is a mark — neither can own property, so neither
   * should ever become a resolution candidate for a property owner.
   */
  readonly isLegalEntity: boolean;
};

export const BUSINESS_TYPES: readonly BusinessTypeEntry[] = [
  { code: '38', label: 'Cooperative Association', domesticity: 'unknown', isLegalEntity: true },
  { code: '39', label: 'Cooperative (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '41', label: 'Nonprofit Corporation (Domestic)', domesticity: 'domestic', isLegalEntity: true },
  { code: '42', label: 'Nonprofit Corporation (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '43', label: 'Business Corporation (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '44', label: 'Limited Liability Company (Domestic)', domesticity: 'domestic', isLegalEntity: true },
  { code: '46', label: 'Limited Liability Company (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '48', label: 'Limited Partnership (Domestic)', domesticity: 'domestic', isLegalEntity: true },
  { code: '49', label: 'Limited Partnership (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '50', label: 'Limited Liability Partnership (Domestic)', domesticity: 'domestic', isLegalEntity: true },
  { code: '52', label: 'Limited Liability Partnership (Foreign)', domesticity: 'foreign', isLegalEntity: true },
  { code: '57', label: 'Trademark', domesticity: 'unknown', isLegalEntity: false },
  // An assumed name is its own master row in this file. The guide does not
  // state a link back to the business that filed it, so none is invented.
  { code: '59', label: 'Assumed Name', domesticity: 'unknown', isLegalEntity: false },
  { code: '60', label: 'Name Reservation', domesticity: 'unknown', isLegalEntity: false },
  { code: '61', label: 'Housing Cooperative', domesticity: 'unknown', isLegalEntity: true },
  { code: '66', label: 'Business Corporation (Domestic)', domesticity: 'domestic', isLegalEntity: true },
  { code: '104', label: 'Cooperative (Domestic)', domesticity: 'domestic', isLegalEntity: true },
];

const BUSINESS_TYPE_BY_CODE = new Map(BUSINESS_TYPES.map((t) => [t.code, t] as const));

export function businessType(code: string): BusinessTypeEntry | undefined {
  return BUSINESS_TYPE_BY_CODE.get(code.trim());
}

// ---------------------------------------------------------------------------
// Party name types (Appendix II)
// ---------------------------------------------------------------------------

export type PartyNameTypeEntry = {
  readonly code: string;
  readonly label: string;
  /**
   * Whether the role is ordinarily filled by a natural person.
   *
   * A hint for handling, never a stored classification: a registered agent may
   * be a corporate service company, and an organizer may be a law firm. The
   * register does not say, so neither do we — but the roles marked true are the
   * ones whose rows most often name an individual, and their addresses are
   * treated accordingly.
   */
  readonly ordinarilyNaturalPerson: boolean;
};

export const PARTY_NAME_TYPES: readonly PartyNameTypeEntry[] = [
  { code: '1', label: 'Applicant', ordinarilyNaturalPerson: true },
  { code: '2', label: 'Markholder', ordinarilyNaturalPerson: false },
  { code: '4', label: 'Registered Agent', ordinarilyNaturalPerson: true },
  { code: '7', label: 'Organizer', ordinarilyNaturalPerson: true },
  { code: '8', label: 'Incorporator', ordinarilyNaturalPerson: true },
  { code: '11', label: 'Filing Contact', ordinarilyNaturalPerson: true },
  { code: '12', label: 'President', ordinarilyNaturalPerson: true },
  { code: '13', label: 'Manager', ordinarilyNaturalPerson: true },
  { code: '14', label: 'Chief Executive Officer', ordinarilyNaturalPerson: true },
  { code: '19', label: 'Individual Contact for Agent', ordinarilyNaturalPerson: true },
];

const PARTY_NAME_TYPE_BY_CODE = new Map(PARTY_NAME_TYPES.map((t) => [t.code, t] as const));

export function partyNameType(code: string): PartyNameTypeEntry | undefined {
  return PARTY_NAME_TYPE_BY_CODE.get(code.trim());
}

// ---------------------------------------------------------------------------
// Address types (Appendix II)
// ---------------------------------------------------------------------------

export type AddressTypeEntry = {
  readonly code: string;
  readonly label: string;
  readonly family: BusinessAddressFamily;
};

export const ADDRESS_TYPES: readonly AddressTypeEntry[] = [
  { code: '2', label: 'Principal Place of Business Address', family: 'PRINCIPAL' },
  { code: '3', label: 'Registered Office Address', family: 'REGISTERED_OFFICE' },
  { code: '4', label: 'Home Office Address', family: 'PRINCIPAL' },
  { code: '5', label: 'Principal Office Address', family: 'PRINCIPAL' },
  { code: '6', label: 'Chief Executive Office Address', family: 'PRINCIPAL' },
  { code: '7', label: 'Office Address', family: 'PRINCIPAL' },
  { code: '8', label: 'Designated Office Address', family: 'PRINCIPAL' },
  { code: '9', label: 'Service Address', family: 'OTHER' },
  { code: '11', label: 'Business Mailing Address', family: 'MAILING' },
  { code: '14', label: 'Party Primary Address', family: 'PARTY_ADDRESS' },
  { code: '16', label: 'Principal Office Mailing Address', family: 'MAILING' },
  { code: '17', label: 'Principal Executive Office Address', family: 'PRINCIPAL' },
  { code: '18', label: 'Designated Office Mailing Address', family: 'MAILING' },
  { code: '19', label: 'Registered Agent Mailing Address', family: 'MAILING' },
  { code: '21', label: 'Registered Agent Address', family: 'REGISTERED_OFFICE' },
  { code: '204', label: 'Individual Contact for Agent Mailing Address', family: 'MAILING' },
  { code: '9999', label: 'Mailing Address', family: 'MAILING' },
];

const ADDRESS_TYPE_BY_CODE = new Map(ADDRESS_TYPES.map((t) => [t.code, t] as const));

export function addressType(code: string): AddressTypeEntry | undefined {
  return ADDRESS_TYPE_BY_CODE.get(code.trim());
}

// ---------------------------------------------------------------------------
// Filing actions
// ---------------------------------------------------------------------------

/**
 * Filing actions.
 *
 * The guide gives `Original Filing`, `Amendment` and `Renewal` as *examples*,
 * not an exhaustive list, and says so. So this table is explicitly partial and
 * anything unmatched stays `OTHER` with the raw text retained — which is why the
 * connector reports unknown filing actions rather than failing on them.
 */
export const FILING_ACTIONS: readonly (readonly [string, string])[] = [
  ['ORIGINAL FILING', 'ORIGINAL_FILING'],
  ['AMENDMENT', 'AMENDMENT'],
  ['RENEWAL', 'RENEWAL'],
  ['REINSTATEMENT', 'REINSTATEMENT'],
  ['DISSOLUTION', 'DISSOLUTION'],
  ['WITHDRAWAL', 'WITHDRAWAL'],
  ['MERGER', 'MERGER'],
  ['NAME CHANGE', 'NAME_CHANGE'],
  ['ADMINISTRATIVE DISSOLUTION', 'ADMINISTRATIVE_ACTION'],
  ['ADMINISTRATIVE TERMINATION', 'ADMINISTRATIVE_ACTION'],
];

const FILING_ACTION_BY_LABEL = new Map(FILING_ACTIONS.map(([label, action]) => [label, action] as const));

export function filingAction(raw: string): string {
  return FILING_ACTION_BY_LABEL.get(raw.trim().toUpperCase().replace(/\s+/g, ' ')) ?? 'OTHER';
}

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export const RECORD_TYPE_MASTER = '01';
export const RECORD_TYPE_FILING = '02';
export const RECORD_TYPE_NAME_ADDRESS = '03';

/**
 * Column layouts, in order, exactly as the implementation guide lists them.
 *
 * The delivered file is **one heterogeneous CSV**: all three record types share
 * it, distinguished by column 2, and they have different column counts. The
 * parser dispatches on that column rather than assuming a single header.
 */
export const MASTER_COLUMNS: readonly string[] = [
  'Master ID', 'Record Type', 'Business Type Code', 'Original Filing Number',
  'Minnesota Business Name', 'Business Filing Status', 'Filing Date', 'Expiration Date',
  'Next Renewal Due Date', 'Home Jurisdiction', 'Governing Statute', 'Is LLC Non Profit',
  'Is Limited Liability Limited Partnership', 'Is Professional', 'Home Business Name',
  'Number of Shares', 'Business Mark Type', 'Mark First Use Date', 'Mark Classification Number',
  'Mark Logo', 'Blank Column', 'Export Date',
];

export const FILING_COLUMNS: readonly string[] = [
  'Master ID', 'Record Type', 'Business Type Code', 'Original Filing Number',
  'Filing Number', 'Filing Action', 'Filing Rank', 'Filing Date', 'Effective Date',
];

export const NAME_ADDRESS_COLUMNS: readonly string[] = [
  'Master ID', 'Record Type', 'Business Type Code', 'Original Filing Number', 'Filing Number',
  'Name Type Number', 'Address Type Number', 'Party Name', 'Street Address Line 1',
  'Street Address Line 2', 'City Name', 'Region Code', 'Postal Code', 'Postal Code Extension',
  'Country Name',
];

/** Digest input for the pinned layout: a change here is schema drift. */
export function layoutSignature(): string {
  return [
    `01:${MASTER_COLUMNS.join('|')}`,
    `02:${FILING_COLUMNS.join('|')}`,
    `03:${NAME_ADDRESS_COLUMNS.join('|')}`,
    `types:${BUSINESS_TYPES.map((t) => t.code).join(',')}`,
    `names:${PARTY_NAME_TYPES.map((t) => t.code).join(',')}`,
    `addresses:${ADDRESS_TYPES.map((t) => t.code).join(',')}`,
  ].join('\n');
}
