/**
 * Canonical structured addresses.
 *
 * DF-0H reported **0% situs-address agreement** across 443,605 Hennepin parcels
 * observed by two sources. Neither source was wrong: the Hennepin connector and
 * the MnGeo connector each assembled a display string from components, using
 * different conventions, and the audit compared the strings.
 *
 * The fix is to stop comparing assembled strings. Each adapter interprets its
 * publisher's fields into **components**; the contract decides how components
 * are represented and compared. A display string is still produced, because
 * humans need one — it is just no longer the comparison surface.
 *
 * ## This is not identity resolution
 *
 * An address still never resolves a property. `100 Main St` exists in most of
 * the 3,222 county-equivalents, and DF-0G's partitioning and DF-0B's rule that
 * only a county-scoped parcel number resolves a property both stand unchanged.
 * What this module does is narrower and duller: decide whether two observations
 * of *the same parcel* are stating the same address.
 *
 * Everything here is deterministic and conservative. There is no fuzzy matching,
 * no geocoding, no phonetics and no external service — each of those merges
 * addresses that are genuinely different, and a false merge is worse than a miss.
 */
import { absenceOf, type Absent } from './normalization-contract.ts';

/**
 * Address components, source-neutral.
 *
 * Every field is optional because publishers supply different subsets. An
 * adapter fills what its source actually states and leaves the rest null —
 * inferring a missing directional from a street name would be inventing data.
 */
export type AddressComponents = {
  readonly houseNumber: string | null;
  readonly houseNumberPrefix: string | null;
  readonly houseNumberSuffix: string | null;
  readonly preDirectional: string | null;
  readonly preType: string | null;
  readonly streetName: string | null;
  readonly postType: string | null;
  readonly postDirectional: string | null;
  readonly unitType: string | null;
  readonly unitId: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly postalCodeExtension: string | null;
};

export type CanonicalAddress = {
  readonly present: true;
  /** Interpreted components, normalised individually. */
  readonly components: AddressComponents;
  /** What the source said, per component, before normalisation. */
  readonly sourceComponents: AddressComponents;
  /** A display string. For humans; NOT the comparison surface. */
  readonly display: string;
  /**
   * The comparison key: street portion only, normalised, plus the unit.
   *
   * City and postal code are deliberately excluded. Two sources routinely give
   * a parcel different postal communities and municipality names for the same
   * location — that is a naming difference about the *place*, not a
   * disagreement about the *address* — and including them would manufacture
   * conflicts on exactly the fields publishers are least consistent about.
   */
  readonly comparisonKey: string;
};

export type AddressValue = CanonicalAddress | Absent;

/**
 * Street suffixes folded to one form.
 *
 * Only where the mapping is unambiguous. USPS Publication 28 has hundreds of
 * variants; this table covers the ones that actually differ between the
 * connectors in this repository, and an unlisted suffix is simply left as
 * written rather than guessed at.
 */
const STREET_TYPES: Readonly<Record<string, string>> = {
  AVENUE: 'AVE', AV: 'AVE', AVE: 'AVE',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', BLV: 'BLVD',
  CIRCLE: 'CIR', CIR: 'CIR', CIRC: 'CIR',
  COURT: 'CT', CT: 'CT', CRT: 'CT',
  DRIVE: 'DR', DR: 'DR', DRV: 'DR',
  HIGHWAY: 'HWY', HWY: 'HWY', HIWAY: 'HWY',
  LANE: 'LN', LN: 'LN',
  PARKWAY: 'PKWY', PKWY: 'PKWY', PKY: 'PKWY',
  PLACE: 'PL', PL: 'PL',
  ROAD: 'RD', RD: 'RD',
  STREET: 'ST', ST: 'ST', STR: 'ST',
  TERRACE: 'TER', TER: 'TER', TERR: 'TER',
  TRAIL: 'TRL', TRL: 'TRL', TR: 'TRL',
  WAY: 'WAY', WY: 'WAY',
  ALLEY: 'ALY', ALY: 'ALY',
  CROSSING: 'XING', XING: 'XING',
  POINT: 'PT', PT: 'PT',
  RIDGE: 'RDG', RDG: 'RDG',
};

const DIRECTIONALS: Readonly<Record<string, string>> = {
  NORTH: 'N', N: 'N', SOUTH: 'S', S: 'S', EAST: 'E', E: 'E', WEST: 'W', W: 'W',
  NORTHEAST: 'NE', NE: 'NE', NORTHWEST: 'NW', NW: 'NW',
  SOUTHEAST: 'SE', SE: 'SE', SOUTHWEST: 'SW', SW: 'SW',
};

const UNIT_TYPES: Readonly<Record<string, string>> = {
  APARTMENT: 'APT', APT: 'APT',
  UNIT: 'UNIT', STE: 'STE', SUITE: 'STE',
  BUILDING: 'BLDG', BLDG: 'BLDG',
  FLOOR: 'FL', FL: 'FL',
  ROOM: 'RM', RM: 'RM',
  '#': 'UNIT', NO: 'UNIT', NUM: 'UNIT',
};

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Uppercase, collapse whitespace, drop punctuation that is never meaningful. */
function fold(value: string | null): string | null {
  if (value === null) return null;
  const folded = value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return folded === '' ? null : folded;
}

function mapped(value: string | null, table: Readonly<Record<string, string>>): string | null {
  const folded = fold(value);
  if (folded === null) return null;
  return table[folded] ?? folded;
}

/** Five digits, zeros preserved. A ZIP is an identifier, not a number. */
function normalizePostalCode(value: string | null): string | null {
  const folded = fold(value);
  if (folded === null) return null;
  const digits = folded.replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
}

/**
 * Builds a canonical address from interpreted components.
 *
 * The adapter has already decided which publisher field is the street name and
 * which is the post-type. This normalises and compares them.
 */
export function canonicalAddress(source: Partial<AddressComponents>): AddressValue {
  const sourceComponents: AddressComponents = {
    houseNumber: clean(source.houseNumber),
    houseNumberPrefix: clean(source.houseNumberPrefix),
    houseNumberSuffix: clean(source.houseNumberSuffix),
    preDirectional: clean(source.preDirectional),
    preType: clean(source.preType),
    streetName: clean(source.streetName),
    postType: clean(source.postType),
    postDirectional: clean(source.postDirectional),
    unitType: clean(source.unitType),
    unitId: clean(source.unitId),
    city: clean(source.city),
    state: clean(source.state),
    postalCode: clean(source.postalCode),
    postalCodeExtension: clean(source.postalCodeExtension),
  };

  // An address with neither a street name nor a house number is not an address.
  if (sourceComponents.streetName === null && sourceComponents.houseNumber === null) {
    return absenceOf(null) ?? { present: false, reason: 'MISSING', raw: null };
  }

  const components: AddressComponents = {
    houseNumber: fold(sourceComponents.houseNumber),
    houseNumberPrefix: fold(sourceComponents.houseNumberPrefix),
    houseNumberSuffix: fold(sourceComponents.houseNumberSuffix),
    preDirectional: mapped(sourceComponents.preDirectional, DIRECTIONALS),
    preType: mapped(sourceComponents.preType, STREET_TYPES),
    streetName: fold(sourceComponents.streetName),
    postType: mapped(sourceComponents.postType, STREET_TYPES),
    postDirectional: mapped(sourceComponents.postDirectional, DIRECTIONALS),
    unitType: mapped(sourceComponents.unitType, UNIT_TYPES),
    unitId: fold(sourceComponents.unitId),
    city: fold(sourceComponents.city),
    state: fold(sourceComponents.state),
    postalCode: normalizePostalCode(sourceComponents.postalCode),
    postalCodeExtension: fold(sourceComponents.postalCodeExtension),
  };

  return {
    present: true,
    components,
    sourceComponents,
    display: displayOf(components),
    comparisonKey: comparisonKeyOf(components),
  };
}

/**
 * The comparison surface: street portion and unit only.
 *
 * A different unit number is a different address and stays different — that is
 * the case this must not over-normalise, because unit 101 and unit 102 are two
 * homes.
 */
function comparisonKeyOf(c: AddressComponents): string {
  const street = [
    c.houseNumberPrefix, c.houseNumber, c.houseNumberSuffix,
    c.preDirectional, c.preType, c.streetName, c.postType, c.postDirectional,
  ].filter((p): p is string => p !== null).join(' ');
  const unit = c.unitId === null ? '' : `${c.unitType ?? 'UNIT'} ${c.unitId}`;
  return unit === '' ? street : `${street} ${unit}`;
}

function displayOf(c: AddressComponents): string {
  const street = comparisonKeyOf(c);
  const locality = [c.city, c.state, c.postalCode].filter((p): p is string => p !== null).join(' ');
  return locality === '' ? street : `${street}, ${locality}`;
}

/** Comparison key, or null when absent. */
export function addressComparisonKey(address: AddressValue): string | null {
  return address.present ? address.comparisonKey : null;
}

/**
 * How two addresses relate. Deliberately finer than equal/not-equal, because
 * "same street, different unit" and "different street" are different findings.
 */
export type AddressAgreement =
  | 'EQUAL'
  | 'EQUAL_AFTER_NORMALIZATION'
  | 'SAME_STREET_DIFFERENT_UNIT'
  | 'DIFFERENT'
  | 'ONE_ABSENT'
  | 'BOTH_ABSENT';

export function compareAddresses(a: AddressValue, b: AddressValue): AddressAgreement {
  if (!a.present && !b.present) return 'BOTH_ABSENT';
  if (!a.present || !b.present) return 'ONE_ABSENT';
  if (a.display === b.display) return 'EQUAL';
  if (a.comparisonKey === b.comparisonKey) return 'EQUAL_AFTER_NORMALIZATION';

  const streetOf = (x: CanonicalAddress) => comparisonKeyOf({ ...x.components, unitType: null, unitId: null });
  if (streetOf(a) === streetOf(b)) return 'SAME_STREET_DIFFERENT_UNIT';
  return 'DIFFERENT';
}
