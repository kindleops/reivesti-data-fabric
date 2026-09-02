/**
 * The canonical normalization contract, v1.
 *
 * DF-0H's Hennepin overlap audit compared two Reivesti connectors describing the
 * same 443,605 parcels and found four fields in total disagreement. Three of
 * those four were **our fault, not the publishers'**:
 *
 *   parcel_area          square feet on one side, acres on the other
 *   situs_address        two different string-assembly conventions
 *   assessor_sale_date   0% agreement while its own VALUE agreed on 99.33%
 *
 * A value cannot match while its date never does unless the two connectors
 * represent dates differently. Each of those is a defect in how Reivesti stores
 * an interpreted value, and patching them per source would guarantee the fourth
 * connector reintroduces them.
 *
 * So the fix is a contract, and the boundary it draws is the important part:
 *
 *   SOURCE ADAPTER      "What does this publisher's field MEAN?"
 *                       MnGeo's `acres_poly` is acreage. Hennepin's
 *                       `PARCEL_AREA_SQFT` is square feet. Only the adapter,
 *                       reading that publisher's documentation, can say so.
 *
 *   THIS CONTRACT       "How does Reivesti REPRESENT that meaning?"
 *                       Both become a `CanonicalArea` in square feet, carrying
 *                       the source value and unit, so they compare as equal.
 *
 * Field meaning never moves into here. A generic normaliser that guessed whether
 * a number was acres or square feet would be wrong silently, which is the exact
 * failure mode this module exists to end.
 *
 * ## Everything keeps its raw value
 *
 * No canonical form replaces what the source said. Every type below carries the
 * source value, the source unit where there is one, and how the conversion was
 * made — so a canonical value can always be audited back to the publisher's own
 * number, and a contract change can re-derive it without re-fetching anything.
 */
import { fail } from '../core/errors.ts';

/**
 * The contract version.
 *
 * Stamped onto normalized observations and mixed into normalized digests. A
 * contract change is then visible as a deliberate representation change rather
 * than masquerading as a corrupted replay — see `normalizationScope()`.
 */
export const NORMALIZATION_CONTRACT_VERSION = 'canonical_normalization_v1';

// ---------------------------------------------------------------------------
// Null semantics
// ---------------------------------------------------------------------------

/**
 * Why a value is absent. These are genuinely different facts and collapsing
 * them loses information the source took the trouble to state.
 *
 * The distinction that matters most in practice: an empty string is not zero,
 * and zero is not missing. DF-0F found 464,388 Minnesota parcels with a sale
 * value of exactly 0 — those are real zero-consideration transfers, and turning
 * them into nulls would erase a population; turning blanks into zeros would
 * invent one.
 */
export type AbsenceReason =
  /** The source has no such field for this record. */
  | 'MISSING'
  /** The field exists and the source explicitly set it null. */
  | 'NULL_SOURCE'
  /** The field exists and the source set it to an empty string. */
  | 'BLANK_SOURCE'
  /** The field does not apply to this kind of record. */
  | 'NOT_APPLICABLE'
  /** A value was present and could not be interpreted. Retained verbatim. */
  | 'INVALID'
  /** The publisher withheld it — a confidentiality programme, for instance. */
  | 'SUPPRESSED'
  /** Present, uninterpretable, and no reason established. */
  | 'UNKNOWN';

/** An absent value with its reason and, when there was one, the raw text. */
export type Absent = {
  readonly present: false;
  readonly reason: AbsenceReason;
  readonly raw: string | null;
};

export function absent(reason: AbsenceReason, raw: string | null = null): Absent {
  return { present: false, reason, raw };
}

/**
 * Classifies a raw source value's absence. **Zero is never absent.**
 */
export function absenceOf(raw: unknown): Absent | null {
  if (raw === undefined) return absent('MISSING', null);
  if (raw === null) return absent('NULL_SOURCE', null);
  if (typeof raw === 'string' && raw.trim() === '') return absent('BLANK_SOURCE', raw);
  return null;
}

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

export type AreaUnit = 'square_feet' | 'acres' | 'square_meters' | 'hectares';

/** Exact by definition: an acre IS 43,560 square feet in US survey practice. */
export const SQUARE_FEET_PER_ACRE = 43_560;
const SQUARE_FEET_PER_SQUARE_METER = 10.763_910_416_709_722;
const SQUARE_FEET_PER_HECTARE = SQUARE_FEET_PER_SQUARE_METER * 10_000;

/**
 * An area, canonically in square feet.
 *
 * Square feet rather than acres because parcel areas span six orders of
 * magnitude — a condominium and a farm — and an integer-ish square-foot figure
 * keeps small parcels precise where fractional acres would not.
 *
 * `sourceValue` and `sourceUnit` are always kept. "1 acre" and "43560 sq ft"
 * compare equal on `squareFeet` and remain distinguishable in provenance.
 */
export type CanonicalArea = {
  readonly present: true;
  readonly squareFeet: number;
  readonly acres: number;
  readonly sourceValue: number;
  readonly sourceUnit: AreaUnit;
  readonly conversion: 'identity' | 'acres_to_square_feet' | 'square_meters_to_square_feet' | 'hectares_to_square_feet';
};

export type AreaValue = CanonicalArea | Absent;

export function canonicalArea(raw: unknown, sourceUnit: AreaUnit): AreaValue {
  const missing = absenceOf(raw);
  if (missing) return missing;

  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return absent('INVALID', String(raw));
  // A negative area is not a small area; it is a broken row.
  if (value < 0) return absent('INVALID', String(raw));

  let squareFeet: number;
  let conversion: CanonicalArea['conversion'];
  switch (sourceUnit) {
    case 'square_feet': squareFeet = value; conversion = 'identity'; break;
    case 'acres': squareFeet = value * SQUARE_FEET_PER_ACRE; conversion = 'acres_to_square_feet'; break;
    case 'square_meters': squareFeet = value * SQUARE_FEET_PER_SQUARE_METER; conversion = 'square_meters_to_square_feet'; break;
    case 'hectares': squareFeet = value * SQUARE_FEET_PER_HECTARE; conversion = 'hectares_to_square_feet'; break;
  }

  // Rounded to a hundredth of a square foot. Parcel areas are survey estimates,
  // and carrying float noise into a comparison key would make two equal areas
  // differ in the last bit.
  const rounded = Math.round(squareFeet * 100) / 100;
  return {
    present: true,
    squareFeet: rounded,
    acres: Math.round((rounded / SQUARE_FEET_PER_ACRE) * 1_000_000) / 1_000_000,
    sourceValue: value,
    sourceUnit,
    conversion,
  };
}

/** Comparison key. Whole square feet: survey figures do not agree below that. */
export function areaComparisonKey(area: AreaValue): string | null {
  return area.present ? String(Math.round(area.squareFeet)) : null;
}

export type AreaAgreement =
  | 'EQUAL'
  /** Equal within the rounding the coarser source's own unit imposes. */
  | 'EQUAL_WITHIN_SOURCE_PRECISION'
  | 'DIFFERENT'
  | 'ONE_ABSENT'
  | 'BOTH_ABSENT';

/**
 * Compares areas, tolerating the rounding a coarse source unit forces.
 *
 * A parcel of 79,902.43 square feet is 1.8343 acres, and a source publishing
 * acres to two decimals states 1.83 — which converts back to 79,714.8 square
 * feet. The two describe the same parcel to within a quarter of a percent, and
 * calling that a conflict would be arithmetic illiteracy rather than rigour.
 *
 * The tolerance is derived from the coarser source's own unit and decimals, not
 * chosen to make numbers agree: half of one unit in the last published place.
 */
export function compareAreas(a: AreaValue, b: AreaValue): AreaAgreement {
  if (!a.present && !b.present) return 'BOTH_ABSENT';
  if (!a.present || !b.present) return 'ONE_ABSENT';
  if (Math.round(a.squareFeet) === Math.round(b.squareFeet)) return 'EQUAL';

  const toleranceOf = (area: CanonicalArea): number => {
    const decimals = decimalPlaces(area.sourceValue);
    const halfUnit = 0.5 * Math.pow(10, -decimals);
    switch (area.sourceUnit) {
      case 'acres': return halfUnit * SQUARE_FEET_PER_ACRE;
      case 'hectares': return halfUnit * SQUARE_FEET_PER_HECTARE;
      case 'square_meters': return halfUnit * SQUARE_FEET_PER_SQUARE_METER;
      case 'square_feet': return halfUnit;
    }
  };

  // The SUM, not the maximum: each stated value denotes an interval half a unit
  // wide either side, and the question is whether those intervals can overlap.
  // 1.83 acres means "somewhere in [1.825, 1.835)" and 79902.43 square feet
  // means "somewhere in [79902.425, 79902.435)"; they are the same parcel if
  // those ranges meet. Taking the maximum would call two coarse sources
  // different when neither is precise enough to say so.
  const tolerance = toleranceOf(a) + toleranceOf(b);
  return Math.abs(a.squareFeet - b.squareFeet) <= tolerance ? 'EQUAL_WITHIN_SOURCE_PRECISION' : 'DIFFERENT';
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Money as exact integer minor units. Never a float.
 *
 * `bigint` rather than `number` so a total across a statewide estate cannot
 * silently lose precision past 2^53 minor units.
 */
export type CanonicalMoney = {
  readonly present: true;
  readonly amountMinor: bigint;
  readonly currency: 'USD';
  /** Verbatim, so "1,234.50" and "$1234.5" are both auditable. */
  readonly sourceValue: string;
  /** How the source expressed it: already minor units, or major units. */
  readonly sourceScale: 'minor_units' | 'major_units';
};

export type MoneyValue = CanonicalMoney | Absent;

/**
 * Parses money exactly, through decimal string arithmetic.
 *
 * Deliberately not `Math.round(value * 100)`: 1234.565 * 100 is 123456.49999
 * in binary floating point, and a cent lost per row is a wrong total over a
 * county. Splitting the decimal string keeps it exact.
 */
export function canonicalMoney(
  raw: unknown,
  sourceScale: 'minor_units' | 'major_units' = 'major_units',
): MoneyValue {
  const missing = absenceOf(raw);
  if (missing) return missing;

  const text = String(raw).trim();
  // Currency symbols, thousands separators and a trailing minus are formatting,
  // not value. A parenthesised negative is an accounting convention.
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  const cleaned = text.replace(/^\(|\)$/g, '').replace(/^-/, '').replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d+(\.\d*)?$/.test(cleaned)) return absent('INVALID', text);

  let minor: bigint;
  if (sourceScale === 'minor_units') {
    if (cleaned.includes('.')) return absent('INVALID', text);
    minor = BigInt(cleaned);
  } else {
    const [whole = '0', fraction = ''] = cleaned.split('.');
    if (fraction.length > 2) {
      // More precision than a cent. Refused rather than rounded: silently
      // dropping a third decimal is how a rate gets stored as a price.
      return absent('INVALID', text);
    }
    minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  }

  return {
    present: true,
    amountMinor: negative ? -minor : minor,
    currency: 'USD',
    sourceValue: text,
    sourceScale,
  };
}

/** Comparison key. Absent and zero produce different keys, deliberately. */
export function moneyComparisonKey(money: MoneyValue): string | null {
  return money.present ? money.amountMinor.toString() : null;
}

export type MoneyAgreement =
  | 'EQUAL'
  /** Equal once rounded to whole major units — one source carries no cents. */
  | 'EQUAL_AT_WHOLE_UNITS'
  | 'DIFFERENT'
  | 'ONE_ABSENT'
  | 'BOTH_ABSENT';

/**
 * Compares money, tolerating a source that publishes whole units.
 *
 * DF-0H measured 5.91% agreement on Hennepin tax totals. The cause was not a
 * dispute about tax: the county publishes `109672.88` and MnGeo's column is an
 * integer, so it publishes `109673`. Roughly one parcel in seventeen has a tax
 * bill that happens to be a whole number of dollars, which is precisely the
 * agreement rate observed.
 *
 * Rounding to whole units is reported as its OWN outcome rather than folded into
 * `EQUAL`, because losing the cents is a real, if minor, loss of information.
 */
export function compareMoney(a: MoneyValue, b: MoneyValue): MoneyAgreement {
  if (!a.present && !b.present) return 'BOTH_ABSENT';
  if (!a.present || !b.present) return 'ONE_ABSENT';
  if (a.amountMinor === b.amountMinor) return 'EQUAL';

  // The tolerance is only available when a source actually lost its cents. If
  // both state cents and the cents differ, they disagree — 100.50 against
  // 100.99 is two different tax bills, and rounding both to 101 to call them
  // equivalent would be manufacturing the agreement this phase exists to stop
  // manufacturing.
  const wholeUnits = (v: bigint): boolean => v % 100n === 0n;
  if (!wholeUnits(a.amountMinor) && !wholeUnits(b.amountMinor)) return 'DIFFERENT';

  const round = (v: bigint) => (v + (v < 0n ? -50n : 50n)) / 100n;
  return round(a.amountMinor) === round(b.amountMinor) ? 'EQUAL_AT_WHOLE_UNITS' : 'DIFFERENT';
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * What a date MEANS. Carried with every date, and compared before values are.
 *
 * Two identical ISO dates that mean different things are not agreement, and two
 * differently formatted dates that mean the same thing are not disagreement.
 * DF-0H's sale-date result — 0% agreement on 390,003 parcels whose sale VALUES
 * agreed 99.33% — is what this type exists to prevent recurring.
 */
export type DateSemantic =
  | 'SALE_DATE'
  | 'DEED_DATE'
  | 'RECORDING_DATE'
  | 'ASSESSMENT_DATE'
  | 'TAX_YEAR'
  | 'SOURCE_EDIT_DATE'
  | 'SOURCE_ACQUISITION_DATE'
  | 'SOURCE_EXPORT_DATE'
  | 'FILING_DATE'
  | 'EFFECTIVE_DATE'
  | 'EXPIRATION_DATE';

/**
 * How precisely a source states a date.
 *
 * This is the field that settles DF-0H's sale-date mystery. Hennepin publishes
 * `SALE_DATE` as `'201412'` — a year and a month, no day. MnGeo publishes
 * `2014-12-01T00:00:00.000Z`, and **every one of its 390,589 Hennepin sale dates
 * ends in `-01`**, because the day is padding rather than information. Compared
 * as ISO dates they disagree on 100% of parcels; compared at the precision each
 * actually carries, they agree.
 *
 * Neither source is wrong and neither parser is broken. Precision is a property
 * of the observation, so it travels with it.
 */
export type DatePrecision = 'day' | 'month' | 'year';

export type CanonicalDate = {
  readonly present: true;
  /** ISO calendar date. A record date has no time of day and none is invented. */
  readonly date: string;
  readonly semantic: DateSemantic;
  /** What the SOURCE actually stated, which may be coarser than `date`. */
  readonly precision: DatePrecision;
  readonly sourceValue: string;
  readonly sourceFormat: 'iso' | 'epoch_millis' | 'epoch_seconds' | 'us_slash' | 'iso_datetime' | 'yyyymm' | 'yyyy';
  /**
   * True when the date is real but outside any plausible range for its meaning.
   * Retained and flagged, never corrected: MnGeo really does publish a sale date
   * in the year 3009, and silently rewriting it would hide a publisher defect.
   */
  readonly implausible: boolean;
};

export type DateValue = CanonicalDate | Absent;

const PLAUSIBLE_FROM = 1600;
const PLAUSIBLE_TO = 2100;

/**
 * Parses a date to an ISO calendar date, recording how it was expressed.
 *
 * Epoch values are interpreted in **UTC**. That is a contract decision, not an
 * accident: ArcGIS returns epoch milliseconds for date fields, and interpreting
 * them in a local timezone would shift a date by a day for any parcel edited
 * near midnight — which is precisely how two connectors reading the same field
 * end up disagreeing on every row.
 */
export function canonicalDate(
  raw: unknown,
  semantic: DateSemantic,
  /**
   * Precision the ADAPTER knows its source states, when the text cannot say.
   * `'201412'` is unambiguous, but an adapter whose source pads a day it does
   * not have must declare that here — only the adapter can know.
   */
  declaredPrecision?: DatePrecision,
): DateValue {
  const missing = absenceOf(raw);
  if (missing) return missing;

  const sourceValue = String(raw);
  let iso: string | null = null;
  let sourceFormat: CanonicalDate['sourceFormat'];
  let precision: DatePrecision = 'day';

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Seconds and milliseconds are told apart by magnitude: anything past the
    // year 10000 in seconds is certainly milliseconds.
    const asMillis = Math.abs(raw) > 1e11 ? raw : raw * 1000;
    sourceFormat = Math.abs(raw) > 1e11 ? 'epoch_millis' : 'epoch_seconds';
    iso = isoFromEpochUtc(asMillis);
  } else {
    const text = sourceValue.trim();
    // YYYYMM and YYYY are checked BEFORE the numeric branch: '201412' is a
    // December 2014 date, not an epoch value six days after 1970.
    if (/^\d{6}$/.test(text) && Number(text.slice(4, 6)) >= 1 && Number(text.slice(4, 6)) <= 12) {
      iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-01`;
      sourceFormat = 'yyyymm';
      precision = 'month';
    } else if (/^(1[6-9]|20|21)\d{2}$/.test(text)) {
      iso = `${text}-01-01`;
      sourceFormat = 'yyyy';
      precision = 'year';
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) { iso = text; sourceFormat = 'iso'; }
    else if (/^\d{4}-\d{2}-\d{2}T/.test(text)) { iso = text.slice(0, 10); sourceFormat = 'iso_datetime'; }
    else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
      const [m, d, y] = text.split('/') as [string, string, string];
      iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      sourceFormat = 'us_slash';
    } else if (/^-?\d+$/.test(text)) {
      const n = Number(text);
      const asMillis = Math.abs(n) > 1e11 ? n : n * 1000;
      sourceFormat = Math.abs(n) > 1e11 ? 'epoch_millis' : 'epoch_seconds';
      iso = isoFromEpochUtc(asMillis);
    } else {
      return absent('INVALID', sourceValue);
    }
  }

  if (iso === null || !isRealCalendarDate(iso)) return absent('INVALID', sourceValue);

  const year = Number(iso.slice(0, 4));
  // The COARSER of what the adapter declares and what the text supports. An
  // adapter may know that a day is padding — only it can — but it may not
  // declare a precision the source never stated: no amount of documentation
  // turns '2014' into a day. Taking the coarser of the two lets the declaration
  // do the one job it exists for and nothing more.
  const stated: DatePrecision = declaredPrecision !== undefined
    && PRECISION_RANK[declaredPrecision] < PRECISION_RANK[precision]
    ? declaredPrecision
    : precision;

  return {
    present: true,
    date: iso,
    semantic,
    precision: stated,
    sourceValue,
    sourceFormat,
    implausible: year < PLAUSIBLE_FROM || year > PLAUSIBLE_TO,
  };
}

/**
 * Comparison key. **Includes the semantic**, so a sale date and a recording date
 * never compare as agreeing however equal their calendar values are.
 */
export function dateComparisonKey(date: DateValue): string | null {
  return date.present ? `${date.semantic}:${date.date}` : null;
}

/** True when two dates are comparable at all — same meaning. */
export function datesAreComparable(a: DateValue, b: DateValue): boolean {
  return a.present && b.present && a.semantic === b.semantic;
}

const PRECISION_RANK: Readonly<Record<DatePrecision, number>> = { day: 3, month: 2, year: 1 };

/**
 * Truncates a date to a precision, so two observations meet at the coarser one.
 *
 * Comparing at the coarser precision is the only honest option: a source that
 * says "December 2014" has not disagreed with one that says "3 December 2014",
 * and it has not confirmed the 3rd either.
 */
export function dateAtPrecision(date: CanonicalDate, precision: DatePrecision): string {
  if (precision === 'year') return date.date.slice(0, 4);
  if (precision === 'month') return date.date.slice(0, 7);
  return date.date;
}

export type DateAgreement =
  | 'EQUAL'
  /** Equal once both are truncated to the coarser source's precision. */
  | 'EQUAL_AT_SHARED_PRECISION'
  | 'DIFFERENT'
  /** Different meanings. Never a disagreement, because never a comparison. */
  | 'INCOMPARABLE_SEMANTICS'
  | 'ONE_ABSENT'
  | 'BOTH_ABSENT';

/**
 * Compares two dates honestly: semantics first, then at the precision both
 * sources actually support.
 */
export function compareDates(a: DateValue, b: DateValue): DateAgreement {
  if (!a.present && !b.present) return 'BOTH_ABSENT';
  if (!a.present || !b.present) return 'ONE_ABSENT';
  if (a.semantic !== b.semantic) return 'INCOMPARABLE_SEMANTICS';
  if (a.date === b.date) return 'EQUAL';

  const shared: DatePrecision = PRECISION_RANK[a.precision] <= PRECISION_RANK[b.precision] ? a.precision : b.precision;
  if (dateAtPrecision(a, shared) === dateAtPrecision(b, shared)) return 'EQUAL_AT_SHARED_PRECISION';
  return 'DIFFERENT';
}

function isoFromEpochUtc(millis: number): string | null {
  if (!Number.isFinite(millis)) return null;
  const d = new Date(millis);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Rejects 2026-02-31: `Date` would roll it into March rather than refusing. */
function isRealCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [, y, mo, d] = m as unknown as string[];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * An identifier, normalised **reversibly** and never numerically.
 *
 * Parcel numbers, FIPS codes and document numbers are strings that happen to
 * look like numbers. `parseInt` on `"007"` loses the leading zeros that make it
 * a different parcel from `"7"`, and no amount of care downstream gets them back.
 */
export type CanonicalIdentifier = {
  readonly present: true;
  readonly raw: string;
  /** Case and punctuation folded. Leading zeros always survive. */
  readonly normalized: string;
  /** The jurisdiction the identifier is scoped to. Part of identity, not context. */
  readonly jurisdictionScope: string | null;
};

export type IdentifierValue = CanonicalIdentifier | Absent;

export function canonicalIdentifier(raw: unknown, jurisdictionScope: string | null = null): IdentifierValue {
  const missing = absenceOf(raw);
  if (missing) return missing;
  const text = String(raw).trim();
  if (text === '') return absent('BLANK_SOURCE', String(raw));
  const normalized = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized === '') return absent('INVALID', text);
  return { present: true, raw: text, normalized, jurisdictionScope };
}

/** Comparison key. Jurisdiction-scoped, because a parcel id alone is not unique. */
export function identifierComparisonKey(id: IdentifierValue): string | null {
  if (!id.present) return null;
  return id.jurisdictionScope === null ? id.normalized : `${id.jurisdictionScope}:${id.normalized}`;
}

// ---------------------------------------------------------------------------
// Digest scoping
// ---------------------------------------------------------------------------

/**
 * The versions a normalized digest is scoped by.
 *
 * A canonical contract change legitimately changes normalized output. Mixing
 * these versions into the digest makes that a *different* digest rather than a
 * failed replay — the difference between "we changed the representation" and
 * "the evidence is corrupt", which are opposite emergencies.
 *
 * The raw artifact digest is untouched by any of this, always.
 */
export function normalizationScope(versions: {
  readonly parserVersion: string;
  readonly normalizationVersion: string;
  readonly resolverVersion?: string;
}): string {
  return [
    `contract=${NORMALIZATION_CONTRACT_VERSION}`,
    `parser=${versions.parserVersion}`,
    `normalizer=${versions.normalizationVersion}`,
    ...(versions.resolverVersion !== undefined ? [`resolver=${versions.resolverVersion}`] : []),
  ].join(';');
}

/** Guards a unit the caller claims a source uses. */
export function assertAreaUnit(unit: string): AreaUnit {
  if (unit === 'square_feet' || unit === 'acres' || unit === 'square_meters' || unit === 'hectares') return unit;
  return fail('CONFIG', `"${unit}" is not a canonical area unit`);
}
