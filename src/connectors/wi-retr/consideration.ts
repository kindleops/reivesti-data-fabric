/**
 * What each RETR money field means, and what may be concluded from it.
 *
 * The dataset publishes five monetary fields and they are five different facts.
 * Confusing any two of them produces a number that looks like a sale price and
 * is not, which is the single most damaging mistake available in this source:
 *
 *   Sale Price                    what the property sold for, when it sold
 *   Estimated Value               what it was worth, when there was no sale price
 *   Transfer Fee Due              a TAX, 30 cents per $100 of value
 *   Personal Property Excluded    value NOT included in the real-estate figure
 *   Personal Property Included    tax-exempt property value that IS included
 *
 * The last two are named almost identically by the publisher and move in
 * opposite directions. They are kept apart here by their full names for exactly
 * that reason.
 *
 * Every amount is exact minor units through `canonicalMoney`. Wisconsin
 * publishes currency as `$0,000.00`; the dollar sign and thousands separators
 * are formatting, and the cents are not.
 */
import {
  canonicalMoney,
  type MoneyValue,
} from '../../canonical/normalization-contract.ts';
import {
  WI_LAND_CONTRACT_RATE_FROM,
  WI_LAND_CONTRACT_RATE_TO,
  WI_TRANSFER_FEE_RATE,
  WI_TRANSFER_FEE_RATE_LAND_CONTRACT,
} from './codes.ts';

/** What a monetary figure on a RETR actually is. */
export type ConsiderationKind =
  /** An arm's-length or negotiated price the parties state. */
  | 'SALE_PRICE'
  /** A value assigned where no price exists. Not a price. */
  | 'ESTIMATED_VALUE'
  /** The transfer tax owed. Never a consideration. */
  | 'TRANSFER_FEE'
  /** Personal property carved OUT of the real-estate figure. */
  | 'PERSONAL_PROPERTY_EXCLUDED'
  /** Locally tax-exempt property carried IN the real-estate figure. */
  | 'PERSONAL_PROPERTY_INCLUDED';

export type RetrConsideration = {
  readonly kind: ConsiderationKind;
  readonly value: MoneyValue;
  /** The publisher's field name, so a reader can always get back to the source. */
  readonly sourceField: string;
};

export type RetrEconomicsInput = {
  readonly salePrice: unknown;
  readonly estimatedValue: unknown;
  readonly transferFeeDue: unknown;
  readonly personalPropertyExcluded: unknown;
  readonly personalPropertyIncluded: unknown;
};

/**
 * Every monetary figure the return states, each labelled with what it is.
 *
 * Absent figures are retained as absences rather than dropped: a RETR with no
 * sale price and a stated estimated value is a different fact from one with
 * neither, and `canonicalMoney` distinguishes `NULL_SOURCE` from `BLANK_SOURCE`
 * from a genuine `$0.00`.
 */
export function retrConsiderations(input: RetrEconomicsInput): readonly RetrConsideration[] {
  return [
    { kind: 'SALE_PRICE', sourceField: 'Sale Price', value: canonicalMoney(input.salePrice, 'major_units') },
    { kind: 'ESTIMATED_VALUE', sourceField: 'Estimated Value', value: canonicalMoney(input.estimatedValue, 'major_units') },
    { kind: 'TRANSFER_FEE', sourceField: 'Transfer Fee Due', value: canonicalMoney(input.transferFeeDue, 'major_units') },
    {
      kind: 'PERSONAL_PROPERTY_EXCLUDED',
      sourceField: 'Personal Property Excluded',
      value: canonicalMoney(input.personalPropertyExcluded, 'major_units'),
    },
    {
      kind: 'PERSONAL_PROPERTY_INCLUDED',
      sourceField: 'Personal Property Included',
      value: canonicalMoney(input.personalPropertyIncluded, 'major_units'),
    },
  ];
}

/**
 * The figure that may be read as this transfer's consideration, if any.
 *
 * Sale Price when the return states one. Otherwise nothing — **not** Estimated
 * Value, which answers a different question, and never Transfer Fee Due, which
 * is a tax. A caller that wants the estimated value can read it from
 * `retrConsiderations`; it will not arrive disguised as a price.
 */
export function statedConsideration(considerations: readonly RetrConsideration[]): RetrConsideration | null {
  const price = considerations.find((c) => c.kind === 'SALE_PRICE');
  return price !== undefined && price.value.present ? price : null;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export type DerivedValue = {
  /** Minor units of the value the fee implies. */
  readonly amountMinor: bigint;
  /** Which statutory rate was applied. */
  readonly rate: number;
  /** The version of this derivation, stored with the result. */
  readonly derivationVersion: string;
  /**
   * The derivation is a RANGE, not a point: the statute charges per $100 "or
   * fraction thereof", so a fee of $300 means a value anywhere in
   * ($99,900.01, $100,000.00]. This is the bottom of that range.
   */
  readonly lowerBoundMinor: bigint;
  readonly upperBoundMinor: bigint;
};

export const WI_FEE_DERIVATION_VERSION = 'wi_retr_fee_to_value_1';

/**
 * The value a transfer fee implies, where the statute makes that unambiguous.
 *
 * s. 77.22(1), Wis. Stats.: "at the rate of 30 cents for each $100 of value or
 * fraction thereof". That formula is explicit, published and invertible, which
 * is what DF-0J requires before deriving anything at all.
 *
 * Refused, deliberately, when:
 *
 *   - **an exemption was claimed** — no fee was owed, so a zero fee says nothing
 *     about value, and inverting it would manufacture a $0 sale;
 *   - **the fee is absent or zero** — same reason;
 *   - **an original land contract date falls in the 1971–1981 window** — the rate
 *     is 10 cents rather than 30, and applying the wrong one understates value
 *     by a factor of three;
 *   - **the land contract date is present but unparseable** — the rate cannot be
 *     chosen, so nothing is claimed.
 *
 * The result is a bounded range because "or fraction thereof" rounds the value
 * up to the next $100 before charging. A single number would be a false
 * precision, and an observed Sale Price always outranks this.
 */
export function deriveValueFromFee(
  transferFee: MoneyValue,
  options: {
    readonly feeExemption: string | null;
    readonly originalLandContractDate: string | null;
  },
): DerivedValue | null {
  if (options.feeExemption !== null && options.feeExemption !== '') return null;
  if (!transferFee.present || transferFee.amountMinor <= 0n) return null;

  let rate = WI_TRANSFER_FEE_RATE;
  const contractDate = options.originalLandContractDate;
  if (contractDate !== null && contractDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(contractDate)) return null;
    if (contractDate >= WI_LAND_CONTRACT_RATE_FROM && contractDate <= WI_LAND_CONTRACT_RATE_TO) {
      rate = WI_TRANSFER_FEE_RATE_LAND_CONTRACT;
    }
  }

  // Fee is charged per whole $100 of value, rounding value UP. So
  //   fee = ceil(value / $100) * rate * $100
  // and the value lies in the $100 band the fee names.
  const feePerHundred = BigInt(Math.round(rate * 100 * 100)); // minor units of fee per $100 of value
  if (feePerHundred <= 0n) return null;
  const hundreds = transferFee.amountMinor / feePerHundred;
  if (hundreds <= 0n || transferFee.amountMinor % feePerHundred !== 0n) {
    // The fee is not a whole number of rate-units, so it was not produced by
    // this formula at whole-$100 granularity. Refused rather than rounded.
    return null;
  }

  const hundredMinor = 10_000n; // $100.00 in cents
  return {
    amountMinor: hundreds * hundredMinor,
    rate,
    derivationVersion: WI_FEE_DERIVATION_VERSION,
    lowerBoundMinor: (hundreds - 1n) * hundredMinor + 1n,
    upperBoundMinor: hundreds * hundredMinor,
  };
}
