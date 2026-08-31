/**
 * Deterministic recorder index reader.
 *
 * Coercion rules, stated because a recorded document is a legal instrument and
 * a sloppy read of one is a wrong legal fact:
 *
 *   document number   kept verbatim AND normalized. Identity is scoped to the
 *                     registration system, because Abstract and Torrens number
 *                     independently and can collide.
 *   registration      never guessed. An index that does not say gets `unknown`,
 *                     which narrows what identity and references can conclude.
 *   dates             ISO, offset preserved. A recording date is a legal fact
 *                     with a statutory hour and minute; shifting it is not ours
 *                     to do.
 *   money             exact integer minor units, and only from a stated field.
 *   empty             absence is null, never zero and never "".
 */
import { fail } from '../../core/errors.ts';
import { normalizeParcelId } from '../../canonical/models.ts';
import type { RegistrationSystem } from '../../canonical/instruments.ts';
import { normalizeDocumentNumber } from '../../canonical/instruments.ts';
import type { RecorderIndexRow, RecorderRecord } from './record.ts';

export const HENNEPIN_COUNTY_FIPS = '27053';

/** Hennepin parcel identifiers are 13 digits, as proven in DF-0C. */
const PID_SHAPE = /^\d{13}$/;

export type ParsedRecorderRow = {
  readonly record: RecorderRecord;
  readonly sourceRecordId: string;
};

/**
 * Source record identity.
 *
 * Scoped to county AND registration system, per Minn. Stat. ch. 507 vs ch. 508:
 * the Recorder and the Registrar of Titles maintain separate series, so
 * `1234567` can name two unrelated documents.
 */
export function recorderSourceRecordId(system: RegistrationSystem, documentNumber: string): string {
  return `MN-27053-${system.toUpperCase()}-${normalizeDocumentNumber(documentNumber)}`;
}

export function parseRecorderRow(row: RecorderIndexRow, origin: string): ParsedRecorderRow {
  const documentNumber = text(row.documentNumber);
  if (documentNumber === null) fail('PARSE', `${origin}: index row has no document number, so it has no identity`);

  const recordedAt = isoInstant(row.recordedAt, `${origin}.recordedAt`);
  if (recordedAt === null) {
    fail('PARSE', `${origin}: index row has no recording date; the recorder is authoritative for it and it cannot be inferred`);
  }

  const documentTypeRaw = text(row.documentType);
  if (documentTypeRaw === null) fail('PARSE', `${origin}: index row has no document type`);

  const registrationSystem = readRegistrationSystem(row.registrationSystem);

  const record: RecorderRecord = {
    documentNumber,
    normalizedDocumentNumber: normalizeDocumentNumber(documentNumber),
    registrationSystem,
    certificateOfTitleNumber: text(row.certificateOfTitleNumber),
    documentTypeRaw,
    recordedAt,
    documentDate: isoInstant(row.documentDate, `${origin}.documentDate`),
    parties: (row.parties ?? []).map((p, i) => {
      const name = text(p.name);
      if (name === null) fail('PARSE', `${origin}: party ${i} has no name`);
      const rawRole = text(p.role);
      if (rawRole === null) fail('PARSE', `${origin}: party ${i} ("${name}") has no role`);
      return {
        rawRole,
        name,
        sequence: p.sequence ?? null,
        addressLine1: text(p.addressLine1),
        city: text(p.city),
        state: text(p.state),
        postalCode: text(p.postalCode),
      };
    }),
    parcelIds: (row.parcelIds ?? [])
      .map((p) => normalizeParcelId(String(p)))
      // A parcel identifier that is not county-shaped is not a parcel
      // identifier. Passing it through would create a property from a typo.
      .filter((p) => PID_SHAPE.test(p)),
    legalDescriptions: (row.legalDescriptions ?? [])
      .map((l) => String(l).trim())
      .filter((l) => l !== ''),
    referencedDocuments: (row.referencedDocuments ?? [])
      .map((r) => ({
        documentNumber: String(r.documentNumber).trim(),
        registrationSystem: readRegistrationSystem(r.registrationSystem),
      }))
      .filter((r) => r.documentNumber !== ''),
    considerationMinor: money(row.considerationAmount, `${origin}.considerationAmount`),
    principalMinor: money(row.principalAmount, `${origin}.principalAmount`),
    maturityDate: isoInstant(row.maturityDate, `${origin}.maturityDate`),
    bookPage: text(row.bookPage),
  };

  return { record, sourceRecordId: recorderSourceRecordId(registrationSystem, documentNumber) };
}

// ---------------------------------------------------------------------------

/**
 * Registration system, never inferred.
 *
 * An index that omits it yields `unknown`, and `unknown` deliberately makes
 * identity and reference resolution more conservative rather than less.
 */
function readRegistrationSystem(raw: unknown): RegistrationSystem {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'abstract' || value === 'a') return 'abstract';
  if (value === 'torrens' || value === 't' || value === 'registered') return 'torrens';
  if (value === 'both' || value === 'ab' || value === 'at') return 'both';
  return 'unknown';
}

function text(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

/**
 * ISO instant with the offset preserved.
 *
 * Minn. Stat. 508.47 has the registrar endorse the date, hour and minute of
 * filing. Normalising that to UTC would silently restate a statutory fact, so an
 * offset-free value stays offset-free, exactly as the eCRV parser does.
 */
function isoInstant(raw: unknown, origin: string): string | null {
  const value = text(raw);
  if (value === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!m) fail('PARSE', `${origin} is "${value}", which is not an ISO date or dateTime`);
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', offset = ''] = m as unknown as string[];
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}${offset}`;
}

/** Exact currency in integer minor units, via string arithmetic. */
function money(raw: unknown, origin: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number'
    ? (Number.isFinite(raw) ? (Number.isInteger(raw) ? String(raw) : raw.toFixed(2)) : fail('PARSE', `${origin} is not finite`))
    : String(raw).trim().replace(/[$,]/g, '');
  if (value === '') return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!m) fail('PARSE', `${origin} is "${value}", which is not a currency amount`);
  const [, sign = '', whole = '', fraction = ''] = m as unknown as string[];
  if (whole === '' && fraction === '') return null;
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > 2) fail('PARSE', `${origin} is "${value}", which has sub-cent precision`);
  const cents = Number(`${whole === '' ? '0' : whole}${trimmed.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(cents)) fail('PARSE', `${origin} is "${value}", which exceeds safe integer range`);
  return sign === '-' ? -cents : cents;
}
