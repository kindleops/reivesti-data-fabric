/**
 * Minnesota SOS bulk CSV reader.
 *
 * The delivery is one heterogeneous CSV — master, filing-history and
 * name/address rows interleaved, distinguished by column 2, with different
 * column counts. Rows are dispatched on that column; nothing assumes a single
 * header.
 *
 * Coercion rules, stated because a registry row is an authoritative legal fact:
 *
 *   Master ID   a GUID, kept verbatim. It is the source key and never rewritten.
 *   dates       MM/DD/YYYY per the guide, emitted as ISO date-only. A registry
 *               date has no time and inventing one would be a fabrication.
 *   flags       0/1 integers become booleans only for the fields the guide
 *               documents as 0/1; anything else stays raw.
 *   empty       absence is null. The guide is explicit that expiration date and
 *               next-renewal date are legitimately null for whole business
 *               types, so null carries meaning and must not become a default.
 */
import { cell } from '../../core/csv.ts';
import { fail } from '../../core/errors.ts';
import {
  FILING_COLUMNS,
  MASTER_COLUMNS,
  NAME_ADDRESS_COLUMNS,
  RECORD_TYPE_FILING,
  RECORD_TYPE_MASTER,
  RECORD_TYPE_NAME_ADDRESS,
} from './domain.ts';

export type MasterRow = {
  readonly kind: 'master';
  readonly masterId: string;
  readonly businessTypeCode: string;
  readonly originalFilingNumber: string | null;
  readonly minnesotaBusinessName: string;
  readonly businessFilingStatus: string | null;
  readonly filingDate: string | null;
  readonly expirationDate: string | null;
  readonly nextRenewalDueDate: string | null;
  readonly homeJurisdiction: string | null;
  readonly governingStatute: string | null;
  readonly isLlcNonProfit: boolean | null;
  readonly isLllp: boolean | null;
  readonly isProfessional: boolean | null;
  readonly homeBusinessName: string | null;
  readonly numberOfShares: string | null;
  readonly businessMarkType: string | null;
  readonly markFirstUseDate: string | null;
  readonly markClassificationNumber: string | null;
  readonly markLogo: string | null;
  readonly exportDate: string | null;
};

export type FilingRow = {
  readonly kind: 'filing';
  readonly masterId: string;
  readonly businessTypeCode: string;
  readonly originalFilingNumber: string | null;
  readonly filingNumber: string;
  readonly filingActionRaw: string;
  readonly filingRank: 'primary' | 'secondary' | 'unknown';
  readonly filingDate: string | null;
  readonly effectiveDate: string | null;
};

export type NameAddressRow = {
  readonly kind: 'name_address';
  readonly masterId: string;
  readonly businessTypeCode: string;
  readonly originalFilingNumber: string | null;
  readonly filingNumber: string | null;
  readonly nameTypeCode: string | null;
  readonly addressTypeCode: string | null;
  readonly partyName: string | null;
  readonly streetAddressLine1: string | null;
  readonly streetAddressLine2: string | null;
  readonly cityName: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly postalCodeExtension: string | null;
  readonly countryName: string | null;
};

export type SosRow = MasterRow | FilingRow | NameAddressRow;

/** Dispatches one CSV row on its record-type column. */
export function parseSosRow(cells: readonly string[], origin: string): SosRow {
  const recordType = cell(cells, 1);
  if (recordType === null) fail('PARSE', `${origin}: row has no record type in column 2`);

  switch (recordType) {
    case RECORD_TYPE_MASTER: return parseMaster(cells, origin);
    case RECORD_TYPE_FILING: return parseFiling(cells, origin);
    case RECORD_TYPE_NAME_ADDRESS: return parseNameAddress(cells, origin);
    default:
      return fail('PARSE', `${origin}: unknown record type "${recordType}"`, {
        recordType,
        known: [RECORD_TYPE_MASTER, RECORD_TYPE_FILING, RECORD_TYPE_NAME_ADDRESS],
      });
  }
}

function parseMaster(cells: readonly string[], origin: string): MasterRow {
  requireWidth(cells, MASTER_COLUMNS.length, origin, 'master');
  const masterId = required(cells, 0, origin, 'Master ID');
  const name = cell(cells, 4);
  if (name === null) fail('PARSE', `${origin}: master row ${masterId} has no Minnesota Business Name`);

  return {
    kind: 'master',
    masterId,
    businessTypeCode: required(cells, 2, origin, 'Business Type Code'),
    originalFilingNumber: cell(cells, 3),
    minnesotaBusinessName: name,
    businessFilingStatus: cell(cells, 5),
    filingDate: date(cells, 6, origin),
    expirationDate: date(cells, 7, origin),
    nextRenewalDueDate: date(cells, 8, origin),
    homeJurisdiction: cell(cells, 9),
    governingStatute: cell(cells, 10),
    isLlcNonProfit: flag(cells, 11, origin),
    isLllp: flag(cells, 12, origin),
    isProfessional: flag(cells, 13, origin),
    homeBusinessName: cell(cells, 14),
    numberOfShares: cell(cells, 15),
    businessMarkType: cell(cells, 16),
    markFirstUseDate: date(cells, 17, origin),
    markClassificationNumber: cell(cells, 18),
    markLogo: cell(cells, 19),
    // Column 20 is documented as a blank column and is deliberately skipped.
    exportDate: date(cells, 21, origin),
  };
}

function parseFiling(cells: readonly string[], origin: string): FilingRow {
  requireWidth(cells, FILING_COLUMNS.length, origin, 'filing');
  const rank = cell(cells, 6);
  return {
    kind: 'filing',
    masterId: required(cells, 0, origin, 'Master ID'),
    businessTypeCode: required(cells, 2, origin, 'Business Type Code'),
    originalFilingNumber: cell(cells, 3),
    filingNumber: required(cells, 4, origin, 'Filing Number'),
    filingActionRaw: required(cells, 5, origin, 'Filing Action'),
    filingRank: rank === 'P' ? 'primary' : rank === 'S' ? 'secondary' : 'unknown',
    filingDate: date(cells, 7, origin),
    effectiveDate: date(cells, 8, origin),
  };
}

function parseNameAddress(cells: readonly string[], origin: string): NameAddressRow {
  requireWidth(cells, NAME_ADDRESS_COLUMNS.length, origin, 'name/address');
  return {
    kind: 'name_address',
    masterId: required(cells, 0, origin, 'Master ID'),
    businessTypeCode: required(cells, 2, origin, 'Business Type Code'),
    originalFilingNumber: cell(cells, 3),
    filingNumber: cell(cells, 4),
    nameTypeCode: cell(cells, 5),
    addressTypeCode: cell(cells, 6),
    partyName: cell(cells, 7),
    streetAddressLine1: cell(cells, 8),
    streetAddressLine2: cell(cells, 9),
    cityName: cell(cells, 10),
    regionCode: cell(cells, 11),
    postalCode: cell(cells, 12),
    postalCodeExtension: cell(cells, 13),
    countryName: cell(cells, 14),
  };
}

// ---------------------------------------------------------------------------

/**
 * A row narrower than its layout is malformed; a wider one is drift.
 *
 * Both refuse rather than reading whatever happens to be in position: a
 * misaligned row would silently put an address in a name column.
 */
function requireWidth(cells: readonly string[], expected: number, origin: string, kind: string): void {
  if (cells.length < expected) {
    fail('PARSE', `${origin}: ${kind} row has ${cells.length} columns, expected ${expected}`, {
      expected, actual: cells.length,
    });
  }
}

function required(cells: readonly string[], index: number, origin: string, field: string): string {
  const value = cell(cells, index);
  if (value === null) fail('PARSE', `${origin}: ${field} is required and is empty`);
  return value;
}

/** MM/DD/YYYY per the guide, emitted as an ISO date. No time is invented. */
function date(cells: readonly string[], index: number, origin: string): string | null {
  const raw = cell(cells, index);
  if (raw === null) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) {
    // Already-ISO values are accepted so a re-exported delivery still parses.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return fail('PARSE', `${origin}: "${raw}" is not an MM/DD/YYYY date`);
  }
  const [, mm, dd, yyyy] = m as unknown as string[];
  return `${yyyy}-${(mm as string).padStart(2, '0')}-${(dd as string).padStart(2, '0')}`;
}

/** Only the documented 0/1 flags. Anything else is refused rather than coerced. */
function flag(cells: readonly string[], index: number, origin: string): boolean | null {
  const raw = cell(cells, index);
  if (raw === null) return null;
  if (raw === '0') return false;
  if (raw === '1') return true;
  return fail('PARSE', `${origin}: "${raw}" is not a documented 0/1 flag`);
}
