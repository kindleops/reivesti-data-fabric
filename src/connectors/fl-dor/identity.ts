/**
 * Florida parcel identity — one rule, shared by all three Florida sources.
 *
 * The cadastral PAR files, the NAL roll and the SDF each name parcels by the
 * county property appraiser's PARCEL_ID. They converge on one canonical
 * property only if each computes the key the same way without consulting the
 * others, so the rule lives here and nowhere else.
 *
 * ## The scheme was chosen by measurement, before it was written down
 *
 * The statewide NAL audit of 2026-09-29 read all 11,090,242 parcel ids in the
 * 67 county rolls and applied each candidate transform inside each county:
 *
 *   trim                    0 merged groups
 *   trim + upper            0
 *   strip whitespace        0
 *   strip leading zeros     0
 *   strip separators      928 groups, 1,856 distinct ids merged (Brevard, Marion)
 *   strip all punctuation 3,782 groups, 7,584 distinct ids merged
 *
 * So folding punctuation — Minnesota's rule — would give two Brevard or Marion
 * parcels one canonical id. Florida therefore uses the contract's
 * PUNCTUATION_PRESERVING scheme, like Wisconsin: outer whitespace trimmed and
 * case folded, nothing else. Leading zeros, dashes, dots and internal spaces
 * survive (2,497,579 ids start with a zero; 1,248,507 carry an internal space).
 * A digit string is never converted to a number.
 *
 * ## Scope is the county, routed by the Department's own number
 *
 * 18,863 id strings occur in more than one county. They are different parcels:
 * identity is `(county FIPS, normalized id)`, and the county comes from the
 * row's CO_NO through the Department's table (`counties.ts`) — never from a
 * city, a ZIP code or a file name.
 */
import { fail } from '../../core/errors.ts';
import {
  canonicalParcelIdentifier,
  parcelMatchKey,
  type ParcelIdentifierScheme,
} from '../../canonical/normalization-contract.ts';
import { propertyIdFromCountyParcel } from '../../canonical/models.ts';
import { flCountyByFips } from './counties.ts';

/** The identity scheme every Florida parcel source must use, so they converge. */
export const FL_PARCEL_IDENTIFIER_SCHEME: ParcelIdentifierScheme = 'PUNCTUATION_PRESERVING';

export type FlParcelIdentity = {
  readonly countyFips: string;
  /** As published, outer whitespace trimmed. */
  readonly rawParcelId: string;
  /** The identity key: PUNCTUATION_PRESERVING. */
  readonly normalizedParcel: string;
  /** Punctuation-folded, for candidate matching only. Never identity. */
  readonly matchKey: string;
  readonly propertyId: string;
};

/** The canonical identity of a Florida parcel reference, or a refusal saying why not. */
export function flParcelIdentity(countyFips: string, parcelId: string | null, origin = 'parcel'): FlParcelIdentity {
  if (flCountyByFips(countyFips) === null) fail('PARSE', `${origin}: ${countyFips} is not a Florida county`);
  const id = canonicalParcelIdentifier(parcelId, FL_PARCEL_IDENTIFIER_SCHEME, countyFips);
  if (!id.present) {
    fail('PARSE', `${origin}: parcel id ${JSON.stringify(parcelId)} is ${id.reason}`, { reason: id.reason });
  }
  return {
    countyFips,
    rawParcelId: id.raw,
    normalizedParcel: id.normalized,
    matchKey: parcelMatchKey(id.raw),
    propertyId: propertyIdFromCountyParcel(countyFips, id.normalized),
  };
}

/**
 * Source record identities. County-scoped, stable across releases, and distinct
 * per source so the three Florida sources never share a record key.
 */
export function flNalSourceRecordId(countyFips: string, normalizedParcel: string): string {
  return `FL-NAL-${countyFips}-${normalizedParcel}`;
}

export function flCadastralSourceRecordId(countyFips: string, normalizedParcel: string): string {
  return `FL-PAR-${countyFips}-${normalizedParcel}`;
}

/**
 * A sale observation is keyed by the appraiser's own sale identifier WITHIN the
 * parcel. The identifier "remains with the sale for all subsequent SDF
 * submissions" (2026 User's Guide, SDF field 10), so the key is stable from the
 * preliminary roll to the final one. It is not unique on its own — 8,878 values
 * repeat across parcels inside one county, because some appraisers number sales
 * per parcel — so the parcel is always part of it.
 *
 * The parcel is length-prefixed because both parts may contain a dash: without
 * it, parcel `01-2` with sale `3` and parcel `01` with sale `2-3` would share a
 * key. With it, the key decodes one way only.
 */
export function flSdfSourceRecordId(countyFips: string, normalizedParcel: string, saleId: string): string {
  return `FL-SDF-${countyFips}-${normalizedParcel.length}.${normalizedParcel}-${saleId}`;
}
