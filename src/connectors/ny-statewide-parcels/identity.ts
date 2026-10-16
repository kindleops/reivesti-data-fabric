/**
 * New York parcel identity and county routing.
 *
 * Every rule here was measured on all 5,510,061 rows of the 2025-roll release
 * (May 2026 build) before it was written down, and each is chosen to be wrong
 * loudly rather than silently.
 *
 * ## 1. The county comes from two fields that must agree
 *
 * COUNTY_NAME is written the way the layer writes it — `NewYork`, `StLawrence`,
 * no spaces — so it is folded (letters only, upper case) and resolved through
 * the federal county catalogue, never trusted as text. The SWIS code carries
 * ORPTS's own two-digit county code in its first two digits (01–57, and 60–64
 * for the New York City boroughs). The two are independent statements of the
 * county, and a row is routed only when they agree. In this release every one
 * of the 62 counties carries exactly one SWIS county code and no row disagrees;
 * a future row that did would be quarantined, not placed by either field alone.
 * The county is never inferred from an address.
 *
 * ## 2. A parcel is its SWIS plus its SBL — not the SBL, not the print key
 *
 * The SBL (section-block-lot) is the tax map number in ORPTS's unformatted,
 * fixed-width form (20 characters outside New York City; the 10-digit BBL
 * inside it). A tax map number is unique only within the municipality that
 * assigns it: the same SBL occurs in two towns of one county 123,246 times.
 * SWIS — the 6-digit code of the city, town, village or village-portion the
 * parcel is assessed in — is therefore part of the parcel identifier, exactly as
 * the publisher's own `SWIS_SBL_ID` ("uniquely identifies each parcel") says.
 *
 * Using the city/town code instead of the full SWIS was measured and rejected:
 * 11,523 (city/town, SBL) keys carry more than one SWIS, 9,952 of them in
 * Suffolk and 1,042 in Nassau where village portions are numbered separately,
 * and 11,476 of those have different assessed values. Folding them onto one
 * property would merge distinct roll parcels. Where the same polygon IS
 * assessed by both a village and its town (the publisher's DUP_GEO note), the
 * two roll records stay two properties; the city/town key is kept on each as a
 * candidate link, never as identity.
 *
 * The identity key is `SWIS + SBL` — the publisher's documented composite —
 * computed by Reivesti from the two component fields rather than trusted from
 * the precomposed `SWIS_SBL_ID` (which disagrees with its own parts on 2 rows).
 *
 * ## 3. The SBL is normalized with PUNCTUATION_PRESERVING
 *
 * Outer whitespace trimmed and case folded, nothing else (the contract's
 * `parcel_identifier_scheme_1`). Measured over every (county, SWIS, SBL): the
 * raw form has 0 collisions, and trim, case, separator, punctuation and
 * leading-zero folding each add exactly ONE merge — a Westchester water label
 * with a trailing space, which is not a parcel at all and is refused below.
 * The formatted PRINT_KEY is a different matter: folding its separators would
 * merge 58,239 groups (117,372 keys). It is never identity.
 *
 * ## 4. A label is not an identifier; an absent SBL is not one either
 *
 * 19 Westchester rows carry an SBL with no digit in it (water and unknown
 * features). 6,606 rows carry no SBL at all — right-of-way, water and unknown
 * polygons with no assessment-roll record behind them; 1,510 of those carry a
 * formatted print key, which is not converted into an SBL here. Both kinds are
 * quarantined, counted and reported.
 */
import { fail } from '../../core/errors.ts';
import {
  canonicalParcelIdentifier,
  parcelMatchKey,
  type ParcelIdentifierScheme,
} from '../../canonical/normalization-contract.ts';
import { propertyIdFromCountyParcel } from '../../canonical/models.ts';
import { ACTIVE_COUNTY_EQUIVALENTS } from '../../registry/us-geography.ts';
import { NY_2025_COUNTY_INVENTORY, NY_STATE_FIPS, nyExpectedCountyFips } from './counties.ts';

export { NY_STATE_FIPS, nyExpectedCountyFips };

/** The identity scheme every New York parcel source must use, so they converge. */
export const NY_PARCEL_IDENTIFIER_SCHEME: ParcelIdentifierScheme = 'PUNCTUATION_PRESERVING';

/** A county name folded the way both spellings agree: letters only, upper case. */
export function foldNyCountyName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * New York's counties from the federal catalogue, keyed by folded name.
 *
 * Derived, not typed in. Building the map refuses a fold that would make two
 * catalogue counties indistinguishable, so the fold can never become a merge.
 */
const NY_COUNTIES_BY_FOLD: ReadonlyMap<string, { readonly fips: string; readonly name: string }> = (() => {
  const out = new Map<string, { fips: string; name: string }>();
  for (const c of ACTIVE_COUNTY_EQUIVALENTS.filter((e) => e.stateFips === NY_STATE_FIPS)) {
    const bare = c.name.replace(/ County$/, '');
    const key = foldNyCountyName(bare);
    if (out.has(key)) fail('CONFIG', `county fold "${key}" is ambiguous in the federal catalogue`);
    out.set(key, { fips: c.fips, name: bare });
  }
  return out;
})();

/** ORPTS county code (the first two SWIS digits) by county FIPS, from the measured inventory. */
const SWIS_COUNTY_CODE_BY_FIPS: ReadonlyMap<string, string> = new Map(
  NY_2025_COUNTY_INVENTORY.map((c) => [c.fips, c.swisCountyCode] as const),
);

export function nyCountyNameOf(fips: string): string | null {
  for (const c of NY_COUNTIES_BY_FOLD.values()) if (c.fips === fips) return c.name;
  return null;
}

/** The SWIS county code ORPTS assigns a county, or null when the county is not New York's. */
export function nySwisCountyCodeOf(fips: string): string | null {
  return SWIS_COUNTY_CODE_BY_FIPS.get(fips) ?? null;
}

/**
 * COUNTY_NAME and SWIS → county FIPS, or a refusal naming what was wrong.
 *
 * Both must be present and must agree. Neither is enough alone.
 */
export function routeNyCounty(countyName: string | null, swis: string | null, origin: string): string {
  if (countyName === null) fail('PARSE', `${origin}: row has no COUNTY_NAME, so it cannot be placed in a county`);
  const county = NY_COUNTIES_BY_FOLD.get(foldNyCountyName(countyName));
  if (county === undefined) {
    fail('PARSE', `${origin}: "${countyName}" is not a catalogued New York county`, {
      remedy: 'the county is inferred from nothing; a row the source cannot place is quarantined',
    });
  }
  if (swis === null || !/^\d{6}$/.test(swis)) {
    fail('PARSE', `${origin}: SWIS ${JSON.stringify(swis)} is not a 6-digit municipal code`);
  }
  const expected = SWIS_COUNTY_CODE_BY_FIPS.get(county.fips);
  if (expected === undefined || swis.slice(0, 2) !== expected) {
    fail('PARSE', `${origin}: COUNTY_NAME "${countyName}" and SWIS ${swis} name different counties`, {
      reason: 'COUNTY_SWIS_DISAGREE',
      remedy: 'two statements of the county disagree; the row is not routed by either alone',
    });
  }
  return county.fips;
}

/** True when an SBL is a feature label rather than an identifier. */
export function isNonParcelLabel(sbl: string): boolean {
  return !/[0-9]/.test(sbl);
}

export type NyParcelIdentity = {
  readonly countyFips: string;
  readonly swis: string;
  /** The SBL as published, outer whitespace trimmed. */
  readonly rawSbl: string;
  /** The SBL under PUNCTUATION_PRESERVING. */
  readonly normalizedSbl: string;
  /** The identity key: SWIS + normalized SBL (the NYS `SWIS_SBL_ID` convention). */
  readonly normalizedParcel: string;
  /** Punctuation-folded, for candidate matching only. Never identity. */
  readonly matchKey: string;
  readonly propertyId: string;
};

/**
 * The canonical identity of a New York parcel reference.
 *
 * Shared by every New York parcel source that states a SWIS and an SBL, because
 * two sources converge only if they compute the key the same way without
 * consulting each other.
 */
export function nyParcelIdentity(countyFips: string, swis: string, sbl: string, origin = 'parcel'): NyParcelIdentity {
  if (!SWIS_COUNTY_CODE_BY_FIPS.has(countyFips)) fail('PARSE', `${origin}: ${countyFips} is not a New York county`);
  if (!/^\d{6}$/.test(swis)) fail('PARSE', `${origin}: SWIS ${JSON.stringify(swis)} is not a 6-digit municipal code`);
  const id = canonicalParcelIdentifier(sbl, NY_PARCEL_IDENTIFIER_SCHEME, countyFips);
  if (!id.present) {
    fail('PARSE', `${origin}: SBL ${JSON.stringify(sbl)} is ${id.reason}`, { reason: 'NO_PARCEL_IDENTIFIER' });
  }
  if (isNonParcelLabel(id.normalized)) {
    fail('PARSE', `${origin}: "${id.raw}" is a non-parcel feature label, not a tax map number`, {
      reason: 'NON_PARCEL_FEATURE',
    });
  }
  const normalizedParcel = `${swis}${id.normalized}`;
  return {
    countyFips,
    swis,
    rawSbl: id.raw,
    normalizedSbl: id.normalized,
    normalizedParcel,
    matchKey: `${swis}${parcelMatchKey(id.raw)}`,
    propertyId: propertyIdFromCountyParcel(countyFips, normalizedParcel),
  };
}

/**
 * The tax-map key: the city or town's SWIS plus the SBL.
 *
 * Kept on every row as a candidate link between the village and town roll
 * records of one polygon. It is NOT identity — see the module header for the
 * 11,523 keys it would wrongly merge.
 */
export function nyTaxMapKey(cityTownSwis: string | null, normalizedSbl: string): string | null {
  return cityTownSwis === null || !/^\d{6}$/.test(cityTownSwis) ? null : `${cityTownSwis}${normalizedSbl}`;
}

/** Source record identity: county-scoped, stable across releases. */
export function nySourceRecordId(countyFips: string, normalizedParcel: string): string {
  return `NY-${countyFips}-${normalizedParcel}`;
}
