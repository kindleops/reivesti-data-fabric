/**
 * The sale facts Florida publishes, read the same way wherever they appear —
 * a Sale Data File row, a NAL sale echo, the cadastral file's joined echo.
 *
 * Three rules, each stated by the 2026 User's Guide and none invented here:
 *
 *  - **The date is a month.** SALE_YR and SALE_MO; there is no day, and none is
 *    added. Stored as `YYYY-MM` with month precision through the contract. A
 *    sale date is never a recording date, a deed date or an assessment date.
 *  - **The price is derived from the documentary stamp tax** "by the property
 *    appraiser" (SDF field 19). It is a publisher-derived consideration, kind
 *    SALE_PRICE_DOC_STAMP_DERIVED, whole dollars, exact to the cent through the
 *    contract. Zero is a value — 127,410 SDF rows state it — and blank is not.
 *  - **The recording reference names an instrument without being one.** Book
 *    and page where the clerk uses them, the clerk's instrument number where it
 *    does not. It is what a future recorder source would join on; no
 *    instrument, deed or grantee is created from it.
 */
import { deterministicId } from '../../core/hash.ts';
import { canonicalDate, canonicalMoney } from '../../canonical/normalization-contract.ts';
import type { SaleObservation, SaleObservationKind, SourceEvidence } from '../../canonical/models.ts';

export const FL_PRICE_KIND = 'SALE_PRICE_DOC_STAMP_DERIVED';

export type FlSaleMonth =
  | { readonly present: true; readonly month: string; readonly year: number; readonly implausible: boolean }
  | { readonly present: false; readonly reason: string; readonly raw: string | null };

/** SALE_YR + SALE_MO → `YYYY-MM`, month precision. Either part blank or out of range → absent, with why. */
export function flSaleMonth(year: string | undefined, month: string | undefined): FlSaleMonth {
  const y = (year ?? '').trim();
  const m = (month ?? '').trim();
  if (y === '' && m === '') return { present: false, reason: 'BLANK_SOURCE', raw: null };
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m)) return { present: false, reason: 'INVALID', raw: `${y}/${m}` };
  const date = canonicalDate(`${y}${m.padStart(2, '0')}`, 'SALE_DATE', 'month');
  if (!date.present) return { present: false, reason: date.reason, raw: `${y}/${m}` };
  return { present: true, month: date.date.slice(0, 7), year: Number(y), implausible: date.implausible };
}

export type FlSalePrice =
  | { readonly present: true; readonly minor: string }
  | { readonly present: false; readonly reason: string; readonly raw: string | null };

/**
 * SALE_PRC → exact minor units. The field exists in every pinned layout, so a
 * value the row does not carry was BLANK in the file — never zero.
 */
export function flSalePrice(raw: string | undefined): FlSalePrice {
  const money = canonicalMoney(raw ?? '', 'major_units');
  return money.present
    ? { present: true, minor: money.amountMinor.toString() }
    : { present: false, reason: money.reason, raw: money.raw };
}

/**
 * The recording reference, as one comparable string.
 *
 * `OR:<book>/<page>` when either book or page is stated, `CLK:<number>` when
 * the clerk's instrument number is; null when none is. Verbatim apart from
 * trimming and case: a book "01234" is not the book "1234" until a publisher
 * says so.
 */
export function flRecordingReference(book: string | undefined, page: string | undefined, clerk: string | undefined): string | null {
  const b = (book ?? '').trim().toUpperCase();
  const p = (page ?? '').trim().toUpperCase();
  const c = (clerk ?? '').trim().toUpperCase();
  if (b !== '' || p !== '') return `OR:${b}/${p}`;
  if (c !== '') return `CLK:${c}`;
  return null;
}

export type FlSaleFacts = {
  readonly publisherSaleId: string | null;
  readonly year: string | undefined;
  readonly month: string | undefined;
  readonly price: string | undefined;
  readonly qualificationCode: string | undefined;
  readonly vacantImproved: string | undefined;
  readonly book: string | undefined;
  readonly page: string | undefined;
  readonly clerk: string | undefined;
  readonly multiParcel: string | undefined;
};

/** True when a sale slot says anything at all. An empty echo slot is not a sale. */
export function saleSlotStated(facts: FlSaleFacts): boolean {
  return [facts.year, facts.month, facts.price, facts.qualificationCode, facts.book, facts.page, facts.clerk]
    .some((v) => v !== undefined && v.trim() !== '');
}

/** A sale observation (SDF row or roll echo) in canonical form. */
export function flSaleObservation(input: {
  readonly kind: SaleObservationKind;
  readonly semanticClass: string;
  readonly observationId: string;
  readonly propertyId: string;
  readonly countyFips: string;
  readonly normalizedParcel: string;
  readonly ordinal: number;
  readonly facts: FlSaleFacts;
  readonly evidence: SourceEvidence;
}): SaleObservation {
  const month = flSaleMonth(input.facts.year, input.facts.month);
  const price = flSalePrice(input.facts.price);
  const text = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim().toUpperCase());
  return {
    observationId: input.observationId,
    kind: input.kind,
    semanticClass: input.semanticClass,
    propertyId: input.propertyId,
    countyFips: input.countyFips,
    normalizedParcel: input.normalizedParcel,
    ordinal: input.ordinal,
    publisherSaleId: input.facts.publisherSaleId,
    saleMonth: month.present ? month.month : null,
    priceMinor: price.present ? price.minor : null,
    priceAbsentReason: price.present ? null : price.reason,
    priceKind: FL_PRICE_KIND,
    qualificationCode: text(input.facts.qualificationCode),
    vacantImprovedCode: text(input.facts.vacantImproved),
    recordingReference: flRecordingReference(input.facts.book, input.facts.page, input.facts.clerk),
    multiParcelCode: text(input.facts.multiParcel),
    evidence: input.evidence,
  };
}

/** Echo observation ids are snapshot-scoped: an echo is part of one roll's statement. */
export function flEchoObservationId(sourceId: string, snapshotId: string, sourceRecordId: string, slot: number): string {
  return deterministicId('flsaleecho', sourceId, snapshotId, sourceRecordId, String(slot));
}
