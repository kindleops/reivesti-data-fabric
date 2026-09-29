/**
 * Wisconsin parcel identity and county routing.
 *
 * Two decisions live here, both measured on the full V12 release before they
 * were written down, and both chosen to be wrong loudly rather than silently.
 *
 * ## 1. The county is where the parcel lies, not who submitted it
 *
 * The layer carries two county fields and they disagree on 5,431 rows:
 *
 *   CONAME       the county the parcel lies in
 *   PARCELFIPS   the county whose submission the row arrived in
 *
 * Appleton spans Outagamie, Calumet and Winnebago; Menasha spans Winnebago and
 * Calumet. Each city's parcels arrive in one county's submission, so 3,839
 * Calumet parcels carry Outagamie's code and 1,419 carry Winnebago's. Property
 * identity is scoped to the jurisdiction the land is in — the county that taxes
 * it and whose register of deeds records its transfers — so CONAME routes and
 * PARCELFIPS is kept as provenance. The routing is safe on the evidence: only
 * one (county, parcel) key in the whole release arrives from two submitters.
 *
 * CONAME is resolved through the federal county catalogue, never trusted as
 * text. One row says "MENOMONIE" — a city in Dunn County, with PARCELFIPS 999 —
 * and is quarantined. The county is never inferred from an address.
 *
 * ## 2. Identity preserves punctuation, because Wisconsin's numbering needs it
 *
 * Minnesota identity folds punctuation away. Doing that here would merge 11,411
 * pairs of distinct parcels inside a single county — Brown County's `1-1109`
 * and `11-109` are two properties. So Wisconsin uses the contract's
 * PUNCTUATION_PRESERVING scheme (see `normalization-contract.ts`): outer
 * whitespace trimmed and case folded, nothing else. Leading zeros, dashes, dots
 * and internal spaces survive. No digit-string is ever converted to a number.
 *
 * ## 3. A label is not an identifier
 *
 * 58,201 rows carry a PARCELID with no digit in it: ROW (23,169), GAP, OVERLAP,
 * TRIBAL, HYDRO, "NO ID IN TAX ROLL", "NEEDS PID", lake and river names — 1,146
 * distinct labels. These are right-of-way strips, water bodies and topology
 * artefacts that county GIS carries as polygons. Admitting them would create a
 * canonical property called "ROW" in each county and pile every strip of road
 * onto it. They are quarantined as non-parcel features, counted, and reported.
 */
import { fail } from '../../core/errors.ts';
import {
  canonicalParcelIdentifier,
  parcelMatchKey,
  type ParcelIdentifierScheme,
} from '../../canonical/normalization-contract.ts';
import { propertyIdFromCountyParcel } from '../../canonical/models.ts';
import { ACTIVE_COUNTY_EQUIVALENTS } from '../../registry/us-geography.ts';

export const WI_STATE_FIPS = '55';

/** The identity scheme every Wisconsin parcel source must use, so they converge. */
export const WI_PARCEL_IDENTIFIER_SCHEME: ParcelIdentifierScheme = 'PUNCTUATION_PRESERVING';

/** A county name folded the way the layer writes it: upper case, no periods. */
export function foldCountyName(name: string): string {
  return name.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Wisconsin's counties from the federal catalogue, keyed by folded name.
 *
 * Derived, not typed in: the expected set is whatever the jurisdiction registry
 * says Wisconsin has, so the "72" in every report is a measurement.
 */
const WI_COUNTIES_BY_NAME: ReadonlyMap<string, { readonly fips: string; readonly name: string }> = new Map(
  ACTIVE_COUNTY_EQUIVALENTS
    .filter((c) => c.stateFips === WI_STATE_FIPS)
    .map((c) => {
      const bare = c.name.replace(/ County$/, '');
      return [foldCountyName(bare), { fips: c.fips, name: bare }] as const;
    }),
);

const WI_COUNTY_FIPS_SET: ReadonlySet<string> = new Set([...WI_COUNTIES_BY_NAME.values()].map((c) => c.fips));

/** Every catalogued Wisconsin county FIPS, sorted. */
export function wiExpectedCountyFips(): readonly string[] {
  return [...WI_COUNTY_FIPS_SET].sort();
}

export function wiCountyNameOf(fips: string): string | null {
  for (const c of WI_COUNTIES_BY_NAME.values()) if (c.fips === fips) return c.name;
  return null;
}

/** CONAME → county FIPS, or a refusal naming what was wrong. */
export function routeWiCounty(coname: string | null, origin: string): string {
  if (coname === null) fail('PARSE', `${origin}: row has no CONAME, so it cannot be placed in a county`);
  const county = WI_COUNTIES_BY_NAME.get(foldCountyName(coname));
  if (county === undefined) {
    fail('PARSE', `${origin}: "${coname}" is not a catalogued Wisconsin county`, {
      remedy: 'the county is inferred from nothing; a row the source cannot place is quarantined',
    });
  }
  return county.fips;
}

/**
 * The submitting county, as a full FIPS, or null when the code is not a
 * catalogued Wisconsin county. Provenance only — see the module header.
 */
export function submittingCountyFips(parcelFips: string | null): string | null {
  if (parcelFips === null || !/^\d{3}$/.test(parcelFips)) return null;
  const fips = `${WI_STATE_FIPS}${parcelFips}`;
  return WI_COUNTY_FIPS_SET.has(fips) ? fips : null;
}

/** True when a PARCELID is a feature label rather than an identifier. */
export function isNonParcelLabel(parcelId: string): boolean {
  return !/[0-9]/.test(parcelId);
}

export type WiParcelIdentity = {
  readonly countyFips: string;
  /** As published, outer whitespace trimmed. */
  readonly rawParcelId: string;
  /** The identity key: PUNCTUATION_PRESERVING. */
  readonly normalizedParcel: string;
  /** Punctuation-folded, for candidate matching only. Never identity. */
  readonly matchKey: string;
  readonly propertyId: string;
};

/**
 * The canonical identity of a Wisconsin parcel reference.
 *
 * Shared by every Wisconsin source — the statewide parcel map today, RETR if it
 * is ever retrievable — because two sources only converge if they compute the
 * key the same way without consulting each other.
 */
export function wiParcelIdentity(countyFips: string, parcelId: string, origin = 'parcel'): WiParcelIdentity {
  if (!WI_COUNTY_FIPS_SET.has(countyFips)) fail('PARSE', `${origin}: ${countyFips} is not a Wisconsin county`);
  const id = canonicalParcelIdentifier(parcelId, WI_PARCEL_IDENTIFIER_SCHEME, countyFips);
  if (!id.present) fail('PARSE', `${origin}: parcel id ${JSON.stringify(parcelId)} is ${id.reason}`);
  if (isNonParcelLabel(id.normalized)) {
    fail('PARSE', `${origin}: "${id.raw}" is a non-parcel feature label, not a parcel identifier`, {
      reason: 'NON_PARCEL_FEATURE',
    });
  }
  return {
    countyFips,
    rawParcelId: id.raw,
    normalizedParcel: id.normalized,
    matchKey: parcelMatchKey(id.raw),
    propertyId: propertyIdFromCountyParcel(countyFips, id.normalized),
  };
}

/** Source record identity: county-scoped, stable across releases. */
export function wiSourceRecordId(countyFips: string, normalizedParcel: string): string {
  return `WI-${countyFips}-${normalizedParcel}`;
}
