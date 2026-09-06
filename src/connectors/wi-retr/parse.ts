/**
 * Reading a Wisconsin RETR historical CSV distribution.
 *
 * The record shape below carries **collections** of grantors, grantees and
 * parcels even though the CSV can only ever fill one of each. That is
 * deliberate: the publisher offers the same month as XML with every party and
 * parcel present, and both distributions must produce the same canonical shape
 * so a transfer is never modelled differently depending on which file an
 * operator happened to download. A CSV-sourced record simply declares that it
 * is truncated, and says so on every row it produces.
 *
 * ## The publisher's own warning
 *
 * "the parcel, grantor, and grantee sections only show the first parcel,
 * grantor, and grantee."
 *
 * A RETR with three grantors arrives as one CSV row naming one of them. Nothing
 * in the file says how many were dropped, so a CSV ingest can never assert
 * "this transfer had one grantor" — only "this file showed one". That
 * distinction is carried through to the canonical rows as
 * `partiesMayBeIncomplete`, because a downstream reader that mistakes the first
 * for the only will attribute a whole sale to one of four siblings.
 */
import { readCsvFromLines, type CsvRow } from '../../core/csv.ts';
import { fail } from '../../core/errors.ts';
import { WI_COUNTY_FIPS, WI_STATE_FIPS } from './codes.ts';
import { WI_RETR_FIELDS } from './field-map.ts';

/** Which publisher distribution a record came from. They differ in completeness. */
export type RetrDistribution = 'csv' | 'xml';

/** One party as the return names them. A name, never an identity. */
export type RetrParty = {
  readonly role: 'grantor' | 'grantee';
  /** Position within the return's own list, 1-based. Preserves filed order. */
  readonly ordinal: number;
  readonly partyType: string | null;
  readonly partyTypeExplain: string | null;
  readonly name: string;
  /** Mailing address. RESTRICTED — never reaches a canonical row. */
  readonly mailingAddress: string | null;
  readonly mailingCountry: string | null;
  readonly hasAgent: boolean | null;
  /** Agent identity. RESTRICTED. */
  readonly agentName: string | null;
  readonly agentAddress: string | null;
  readonly agentCountry: string | null;
};

/** One parcel the return lists. A RETR may list up to ten before overflowing. */
export type RetrParcel = {
  readonly ordinal: number;
  /** Verbatim, tab stripped, leading zeros intact. Never numeric. */
  readonly parcelNumber: string;
  readonly municipality: string | null;
  readonly partOfParcelTransferred: string | null;
  readonly propertyType: string | null;
  readonly propertyUseType: string | null;
  readonly propertyUseSubType: string | null;
  readonly propertyExplain: string | null;
  readonly numberOfUnits: number | null;
  readonly primaryResidenceOfGrantee: boolean | null;
  readonly physicalAddress: string | null;
  readonly section: string | null;
  readonly township: string | null;
  readonly range: string | null;
  readonly meridian: string | null;
  readonly subdivisionName: string | null;
  readonly lotNumber: string | null;
  readonly blockNumber: string | null;
  readonly condominiumName: string | null;
  readonly unitNumber: string | null;
  readonly squareFeet: string | null;
  readonly acres: string | null;
  readonly mflPfcAcres: string | null;
  readonly feetOfWaterFrontage: string | null;
};

export type RetrRecord = {
  readonly distribution: RetrDistribution;
  /**
   * True when the distribution could have dropped parties or parcels.
   *
   * Always true for CSV: the publisher shows only the first of each and gives
   * no count, so there is no way to tell a genuinely single-grantor return from
   * one with four. "May be incomplete" rather than "truncated" because that is
   * the actual state of knowledge.
   */
  readonly partiesMayBeIncomplete: boolean;
  readonly parcelsMayBeIncomplete: boolean;

  // -- identity -------------------------------------------------------------
  readonly county: string;
  readonly countyFips: string;
  readonly documentNumber: string;
  readonly recordedDate: string | null;

  // -- conveyance -----------------------------------------------------------
  readonly documentType: string | null;
  readonly documentExplain: string | null;
  readonly conveyanceType: string | null;
  readonly conveyanceExplain: string | null;
  readonly conveyanceDate: string | null;
  readonly originalLandContractDate: string | null;

  // -- relationship ---------------------------------------------------------
  readonly relationship: string | null;
  readonly relationshipExplain: string | null;
  readonly ownershipType: string | null;
  readonly ownershipExplain: string | null;
  readonly rightsRetained: string | null;
  readonly rightsRetainedExplain: string | null;

  // -- collections ----------------------------------------------------------
  readonly parties: readonly RetrParty[];
  readonly parcels: readonly RetrParcel[];

  // -- economics ------------------------------------------------------------
  readonly feeExemption: string | null;
  readonly estimatedValue: string | null;
  readonly salePrice: string | null;
  readonly transferFeeDue: string | null;
  readonly personalPropertyExcluded: string | null;
  readonly personalPropertyIncluded: string | null;

  // -- prior document -------------------------------------------------------
  readonly previousDocumentNumber: string | null;
  readonly stateWhereFiled: string | null;
  readonly dateFiled: string | null;
  readonly acquiredByCorporationDate: string | null;
  readonly domesticPartnershipDate: string | null;

  // -- financing (booleans only; the form's amounts are not published) -------
  readonly hasFinancing: boolean | null;
  readonly financingConventional: boolean | null;
  readonly financingGovernment: boolean | null;
  readonly financingAssumedExisting: boolean | null;
  readonly financingFromSeller: boolean | null;
  readonly financingThirdParty: boolean | null;

  // -- restricted -----------------------------------------------------------
  readonly preparerName: string | null;
  readonly taxBillName: string | null;
  readonly taxBillAddress: string | null;
  readonly taxBillCountry: string | null;

  readonly legalDescription: string | null;
};

/** Field count the publisher documents. A row of a different width is drift. */
export const WI_RETR_CSV_FIELD_COUNT = 78;

/** Column ordinals, 1-based, exactly as documented. */
const COL = Object.fromEntries(WI_RETR_FIELDS.map((f) => [f.name, f.ordinal])) as Record<string, number>;

/** Reads a cell by the publisher's own column NAME, resolved to its ordinal. */
function at(cells: readonly string[], name: string): string | null {
  const ordinal = COL[name];
  if (ordinal === undefined) fail('CONFIG', `no pinned ordinal for RETR column "${name}"`);
  const raw = cells[ordinal - 1];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Strips the publisher's Excel guard from a parcel number.
 *
 * "The parcel number is prefixed with a tab in order to prevent Excel from
 * removing leading zeros." The tab is a transport artefact of the CSV
 * distribution and is removed; the zeros it was protecting are part of the
 * identifier and are not.
 */
export function stripParcelGuard(raw: string): string {
  return raw.replace(/^[\t\s]+/, '').trim();
}

/** Yes/No to boolean. Anything else is null rather than a guessed false. */
function yesNo(value: string | null): boolean | null {
  if (value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return null;
}

/** Currency text to a plain decimal string. `canonicalMoney` does the parsing. */
function currency(value: string | null): string | null {
  return value;
}

/** MM-dd-yyyy, the only date format the publisher documents, to ISO. */
export function retrDate(value: string | null): string | null {
  if (value === null) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (m === null) return null;
  const [, month, day, year] = m as unknown as string[];
  return `${year}-${month}-${day}`;
}

/**
 * One CSV row to a record.
 *
 * Throws for a row that cannot be identified at all — no county, no document
 * number, or a county the federal catalogue does not contain. The runtime
 * quarantines those individually rather than failing the month.
 */
export function parseRetrCsvRow(row: CsvRow): RetrRecord {
  const { cells } = row;
  if (cells.length !== WI_RETR_CSV_FIELD_COUNT) {
    fail('PARSE', `row ${row.rowNumber}: expected ${WI_RETR_CSV_FIELD_COUNT} columns, got ${cells.length}`, {
      remedy: 'the publisher changed the CSV layout; re-read the CSV documentation before ingesting',
    });
  }

  const county = at(cells, 'County');
  if (county === null) fail('PARSE', `row ${row.rowNumber}: no county, so the transfer cannot be placed`);
  const countyFips = WI_COUNTY_FIPS[county];
  if (countyFips === undefined) {
    fail('PARSE', `row ${row.rowNumber}: "${county}" is not one of Wisconsin's 72 counties`, {
      remedy: 'a new or renamed county means the jurisdiction catalogue needs updating first',
    });
  }

  const documentNumber = at(cells, 'Document Number');
  if (documentNumber === null) {
    fail('PARSE', `row ${row.rowNumber}: no document number, which is half of this dataset's only identity`);
  }

  const parcelRaw = at(cells, 'Parcel Number');
  const parcels: RetrParcel[] = parcelRaw === null ? [] : [{
    ordinal: 1,
    parcelNumber: stripParcelGuard(parcelRaw),
    municipality: at(cells, 'Municipality'),
    partOfParcelTransferred: at(cells, 'Part of Parcel Transferred'),
    propertyType: at(cells, 'Property Type'),
    propertyUseType: at(cells, 'Property Use Type'),
    propertyUseSubType: at(cells, 'Property Use Sub Type'),
    propertyExplain: at(cells, 'Property Explain'),
    numberOfUnits: numberOrNull(at(cells, 'Number of Units')),
    primaryResidenceOfGrantee: yesNo(at(cells, 'Primary Residence of Grantee?')),
    physicalAddress: at(cells, 'Physical Address'),
    section: at(cells, 'Section'),
    township: at(cells, 'Township'),
    range: at(cells, 'Range'),
    meridian: at(cells, 'Meridian'),
    subdivisionName: at(cells, 'Subdivision Name'),
    lotNumber: at(cells, 'Lot Number'),
    blockNumber: at(cells, 'Block Number'),
    condominiumName: at(cells, 'Condominium Name'),
    unitNumber: at(cells, 'Unit Number'),
    squareFeet: at(cells, 'Square Feet'),
    acres: at(cells, 'Acres'),
    mflPfcAcres: at(cells, 'MFL/PFC Acres'),
    feetOfWaterFrontage: at(cells, 'Feet of Water Frontage'),
  }];

  const parties: RetrParty[] = [];
  const grantorName = at(cells, 'Grantor Name');
  if (grantorName !== null) {
    parties.push({
      role: 'grantor', ordinal: 1,
      partyType: at(cells, 'Grantor Type'),
      partyTypeExplain: at(cells, 'Grantor Explain'),
      name: grantorName,
      mailingAddress: at(cells, 'Grantor Address'),
      mailingCountry: at(cells, 'Grantor Country'),
      hasAgent: yesNo(at(cells, 'Grantor Has Agent?')),
      agentName: at(cells, 'Grantor Agent Name'),
      agentAddress: at(cells, 'Grantor Agent Address'),
      agentCountry: at(cells, 'Grantor Agent Country'),
    });
  }
  const granteeName = at(cells, 'Grantee Name');
  if (granteeName !== null) {
    parties.push({
      role: 'grantee', ordinal: 1,
      partyType: at(cells, 'Grantee Type'),
      partyTypeExplain: at(cells, 'Grantee Explain'),
      name: granteeName,
      mailingAddress: at(cells, 'Grantee Address'),
      mailingCountry: at(cells, 'Grantee Country'),
      hasAgent: yesNo(at(cells, 'Grantee Has Agent?')),
      agentName: at(cells, 'Grantee Agent Name'),
      agentAddress: at(cells, 'Grantee Agent Address'),
      agentCountry: at(cells, 'Grantee Agent Country'),
    });
  }

  return {
    distribution: 'csv',
    // The publisher states the CSV shows only the first of each. There is no
    // way to tell a shortened list from a genuinely single one, so every CSV
    // record declares the uncertainty rather than any of them claiming a count.
    partiesMayBeIncomplete: true,
    parcelsMayBeIncomplete: true,

    county,
    countyFips,
    documentNumber,
    recordedDate: retrDate(at(cells, 'Recorded Date')),

    documentType: at(cells, 'Document Type'),
    documentExplain: at(cells, 'Document Explain'),
    conveyanceType: at(cells, 'Conveyance Type'),
    conveyanceExplain: at(cells, 'Conveyance Explain'),
    conveyanceDate: retrDate(at(cells, 'Conveyance Date')),
    originalLandContractDate: retrDate(at(cells, 'Original Land Contract Date')),

    relationship: at(cells, 'Grantor/Grantee Relationship'),
    relationshipExplain: at(cells, 'Grantor/Grantee Explain'),
    ownershipType: at(cells, 'Ownership Type'),
    ownershipExplain: at(cells, 'Ownership Explain'),
    rightsRetained: at(cells, 'Rights Retained by Grantor'),
    rightsRetainedExplain: at(cells, 'Rights Retained Explain'),

    parties,
    parcels,

    feeExemption: at(cells, 'Fee Exemption'),
    estimatedValue: currency(at(cells, 'Estimated Value')),
    salePrice: currency(at(cells, 'Sale Price')),
    transferFeeDue: currency(at(cells, 'Transfer Fee Due')),
    personalPropertyExcluded: currency(at(cells, 'Personal Property Excluded')),
    personalPropertyIncluded: currency(at(cells, 'Personal Property Included')),

    previousDocumentNumber: at(cells, 'Previous Document Number'),
    stateWhereFiled: at(cells, 'State Where Filed'),
    dateFiled: retrDate(at(cells, 'Date Filed')),
    acquiredByCorporationDate: retrDate(at(cells, 'Acquired by Corporation Date')),
    domesticPartnershipDate: retrDate(at(cells, 'Domestic Partnership Date')),

    hasFinancing: yesNo(at(cells, 'Has Financing?')),
    financingConventional: yesNo(at(cells, 'Financing - Conventional')),
    financingGovernment: yesNo(at(cells, 'Financing - Government')),
    financingAssumedExisting: yesNo(at(cells, 'Financing - Assumed Existing')),
    financingFromSeller: yesNo(at(cells, 'Financing - From Seller')),
    financingThirdParty: yesNo(at(cells, 'Financing - Third Party')),

    preparerName: at(cells, 'Preparer Name'),
    taxBillName: at(cells, 'Tax Bill Name'),
    taxBillAddress: at(cells, 'Tax Bill Address'),
    taxBillCountry: at(cells, 'Tax Bill Country'),

    legalDescription: at(cells, 'Legal Description'),
  };
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The source record identity: county FIPS plus the recorded document number.
 *
 * The public dataset publishes **no RETR receipt number**. The only identity it
 * carries is the county and the county's own recording document number, which
 * is why identity is county-scoped: document numbers repeat freely across
 * Wisconsin's 72 counties, and two counties' document 123456 are two transfers.
 */
export function retrSourceRecordId(record: Pick<RetrRecord, 'countyFips' | 'documentNumber'>): string {
  return `wi-retr ${record.countyFips}:${record.documentNumber}`;
}

/** Reads a whole CSV distribution, skipping the English header row. */
export async function* readRetrCsv(lines: AsyncIterable<string>): AsyncGenerator<{
  readonly record: RetrRecord | null;
  readonly row: CsvRow;
  readonly error: string | null;
}> {
  for await (const row of readCsvFromLines(lines, { skipRows: 1 })) {
    try {
      yield { record: parseRetrCsvRow(row), row, error: null };
    } catch (e) {
      yield { record: null, row, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export { WI_STATE_FIPS };
