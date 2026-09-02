/**
 * Splitting Hennepin's packed street field.
 *
 * Hennepin publishes the whole street in one column:
 *
 *   STREET_NM = '78TH ST E           '
 *
 * MnGeo, republishing the same parcel, splits it:
 *
 *   st_name = '78th'   st_pos_typ = 'Street'   st_pos_dir = 'East'
 *
 * Both mean *2901 78th Street East*. DF-0H compared assembled display strings
 * and reported 0% agreement across 443,605 parcels — a conclusion about our own
 * formatting, not about Hennepin or MnGeo.
 *
 * This split is **adapter work, not contract work**. Only someone reading
 * Hennepin's own layer knows that `STREET_NM` carries name, type and directional
 * in one space-padded field; the canonical contract must not be in the business
 * of guessing that from the shape of a string. So the interpretation lives here,
 * next to the source it interprets, and hands components to the contract.
 *
 * It is deliberately conservative: a trailing token is only taken as a
 * directional or a street type when it is unambiguously one. Anything it cannot
 * confidently split stays in the street name, which compares fine against
 * another source that also failed to split it, and merely misses an equivalence
 * it could have found. Missing an equivalence is recoverable; inventing one is
 * not.
 */

/** Directionals as Hennepin abbreviates them, and as they may be spelled. */
const DIRECTIONALS: ReadonlySet<string> = new Set([
  'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW',
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'NORTHEAST', 'NORTHWEST', 'SOUTHEAST', 'SOUTHWEST',
]);

/**
 * Street types Hennepin uses.
 *
 * Only tokens that are unambiguously a street type. `PARK` is deliberately
 * absent: "LYNDALE PARK" is a street name, and treating PARK as a type would
 * mangle it. So is `BROADWAY`, which appears 281 times in the first 100,000
 * rows and is a street name every time.
 *
 * `LA`, `TR` and `CUR` are here because the county's own abbreviations were
 * measured, not guessed: across 100,000 real rows the trailing tokens the
 * splitter could not place were `LA` 3,067 times (Lane), `TR` 954 (Trail) and
 * `CUR` 382 (Curve). Adding them took street-type recognition from 82.5% to
 * about 87% of non-blank rows. `LA` is safe as a *trailing* token even though
 * "LA SALLE AVE" exists, because a leading `LA` is never examined here.
 */
const STREET_TYPES: ReadonlySet<string> = new Set([
  'AVE', 'AV', 'AVENUE', 'BLVD', 'BOULEVARD', 'CIR', 'CIRCLE', 'CT', 'COURT',
  'CUR', 'CURVE', 'DR', 'DRIVE', 'HWY', 'HIGHWAY', 'LA', 'LN', 'LANE',
  'PKWY', 'PARKWAY', 'PL', 'PLACE',
  'RD', 'ROAD', 'ST', 'STREET', 'TER', 'TERR', 'TERRACE', 'TR', 'TRL', 'TRAIL',
  'WAY', 'ALY', 'ALLEY', 'XING', 'CROSSING', 'PT', 'POINT', 'RDG', 'RIDGE',
  'LOOP', 'CV', 'COVE', 'BAY', 'CRK', 'CREEK', 'RUN',
]);

/**
 * Values that occupy the street field without being a street.
 *
 * Hennepin writes `ADDRESS UNASSIGNED` into `STREET_NM` for parcels that have no
 * address yet — 2,420 times in the first 120,000 rows, always with a null
 * `HOUSE_NO`. Treated as a street name it would give every one of those parcels
 * the same canonical address key, and an overlap audit would report them as
 * agreeing on their address. They agree on having none.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  'ADDRESS UNASSIGNED', 'UNASSIGNED', 'ADDRESS PENDING', 'PENDING', 'UNKNOWN', 'NONE', 'N/A',
]);

export type SplitStreet = {
  readonly streetName: string | null;
  readonly postType: string | null;
  readonly postDirectional: string | null;
  readonly preDirectional: string | null;
};

/**
 * Splits a packed street string into components.
 *
 * Reads from the end, because that is where the structure is: an optional
 * trailing directional, then an optional street type, and whatever remains is
 * the name.
 */
export function splitPackedStreet(packed: string | null): SplitStreet {
  const empty: SplitStreet = { streetName: null, postType: null, postDirectional: null, preDirectional: null };
  if (packed === null) return empty;

  const collapsed = packed.trim().toUpperCase().replace(/\s+/g, ' ');
  // A placeholder is an absence with text in it. Returning the empty split makes
  // the address absent downstream, which is what it is.
  if (PLACEHOLDERS.has(collapsed)) return empty;

  const tokens = collapsed.split(' ').filter((t) => t !== '');
  if (tokens.length === 0) return empty;

  let preDirectional: string | null = null;
  // A leading directional, but never when it is the only token: "N" alone is a
  // street name someone wrote badly, not a direction with no street.
  if (tokens.length > 2 && DIRECTIONALS.has(tokens[0] as string)) {
    preDirectional = tokens.shift() as string;
  }

  let postDirectional: string | null = null;
  if (tokens.length > 1 && DIRECTIONALS.has(tokens[tokens.length - 1] as string)) {
    postDirectional = tokens.pop() as string;
  }

  let postType: string | null = null;
  if (tokens.length > 1 && STREET_TYPES.has(tokens[tokens.length - 1] as string)) {
    postType = tokens.pop() as string;
  }

  const streetName = tokens.join(' ');
  return {
    streetName: streetName === '' ? null : streetName,
    postType,
    postDirectional,
    preDirectional,
  };
}
