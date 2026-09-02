/**
 * The canonical normalization contract.
 *
 * DF-0H compared two Reivesti connectors describing the same 443,605 Hennepin
 * parcels and reported four fields in total disagreement. Three were caused by
 * how *we* represented values, not by the publishers. Every test below exists
 * because of a specific one of those, or to stop the fix from over-reaching:
 * normalising until everything agrees would be a worse failure than the one it
 * replaced.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import {
  NORMALIZATION_CONTRACT_VERSION,
  SQUARE_FEET_PER_ACRE,
  absenceOf,
  areaComparisonKey,
  assertAreaUnit,
  canonicalArea,
  canonicalDate,
  canonicalIdentifier,
  canonicalMoney,
  compareAreas,
  compareDates,
  compareMoney,
  dateAtPrecision,
  dateComparisonKey,
  identifierComparisonKey,
  moneyComparisonKey,
  normalizationScope,
} from '../src/canonical/normalization-contract.ts';
import { canonicalAddress, compareAddresses } from '../src/canonical/address.ts';
import { splitPackedStreet } from '../src/connectors/mn-hennepin-assessor/street.ts';

// ===========================================================================
// Area — the square-feet-versus-acres defect
// ===========================================================================

test('one acre and 43,560 square feet are the same area', () => {
  const acres = canonicalArea(1, 'acres');
  const feet = canonicalArea(SQUARE_FEET_PER_ACRE, 'square_feet');
  assert.ok(acres.present && feet.present);
  assert.equal(acres.squareFeet, feet.squareFeet);
  assert.equal(areaComparisonKey(acres), areaComparisonKey(feet));
  assert.equal(compareAreas(acres, feet), 'EQUAL');
});

test('the source value and unit survive the conversion', () => {
  const area = canonicalArea(1.83, 'acres');
  assert.ok(area.present);
  assert.equal(area.sourceValue, 1.83);
  assert.equal(area.sourceUnit, 'acres');
  assert.equal(area.conversion, 'acres_to_square_feet');
  // Both representations are available; neither replaces the other.
  assert.equal(area.squareFeet, 79714.8);
  assert.ok(Math.abs(area.acres - 1.83) < 1e-9);
});

test('the real Hennepin parcel compares equal within the coarser source precision', () => {
  // PID 0102724110003: Hennepin publishes 79902.43 sq ft, MnGeo 1.83 acres.
  // 1.83 acres is 79,714.8 sq ft — a 0.24% difference caused entirely by MnGeo
  // rounding acreage to two decimals. Calling that a conflict would be
  // arithmetic illiteracy dressed as rigour.
  const direct = canonicalArea(79902.43, 'square_feet');
  const aggregation = canonicalArea(1.83, 'acres');
  assert.equal(compareAreas(direct, aggregation), 'EQUAL_WITHIN_SOURCE_PRECISION');
});

test('genuinely different areas stay different', () => {
  // Half an acre against two acres is not a rounding artefact.
  assert.equal(compareAreas(canonicalArea(0.5, 'acres'), canonicalArea(2, 'acres')), 'DIFFERENT');
  assert.equal(compareAreas(canonicalArea(5000, 'square_feet'), canonicalArea(50000, 'square_feet')), 'DIFFERENT');
});

test('a malformed or negative area is refused, not coerced', () => {
  assert.equal((canonicalArea('not a number', 'acres') as { reason: string }).reason, 'INVALID');
  assert.equal((canonicalArea(-5, 'square_feet') as { reason: string }).reason, 'INVALID');
  assert.throws(() => assertAreaUnit('furlongs'), (e: unknown) => isFabricError(e, 'CONFIG'));
});

// ===========================================================================
// Money — the tax-total defect
// ===========================================================================

test('money is exact, and never floating point', () => {
  // 1234.565 * 100 is 123456.49999999999 in binary floating point. Parsing the
  // decimal string keeps the cent.
  const money = canonicalMoney('1234.56');
  assert.ok(money.present);
  assert.equal(money.amountMinor, 123456n);
  assert.equal(typeof money.amountMinor, 'bigint');
});

test('formatting is not value', () => {
  for (const text of ['$1,234.56', '1234.56', ' 1234.56 ']) {
    const money = canonicalMoney(text);
    assert.ok(money.present);
    assert.equal(money.amountMinor, 123456n);
  }
});

test('the real Hennepin tax total differs only by the aggregation rounding', () => {
  // Hennepin publishes 109672.88; MnGeo's column is an integer, so 109673.
  // DF-0H measured 5.91% agreement, which is about the share of parcels whose
  // tax happens to be a whole number of dollars.
  const direct = canonicalMoney('109672.88');
  const aggregation = canonicalMoney('109673');
  assert.equal(compareMoney(direct, aggregation), 'EQUAL_AT_WHOLE_UNITS');
  // And it is reported as its own outcome, not folded into EQUAL: the cents are
  // a real, if small, loss.
  assert.notEqual(compareMoney(direct, aggregation), 'EQUAL');
});

test('genuinely different amounts stay different', () => {
  assert.equal(compareMoney(canonicalMoney('100.00'), canonicalMoney('200.00')), 'DIFFERENT');
  assert.equal(compareMoney(canonicalMoney('109672.88'), canonicalMoney('109674')), 'DIFFERENT');
});

test('null, blank and zero are three different facts', () => {
  const zero = canonicalMoney('0');
  const blank = canonicalMoney('');
  const nothing = canonicalMoney(null);
  assert.ok(zero.present);
  assert.equal(zero.amountMinor, 0n);
  assert.equal(blank.present, false);
  assert.equal((blank as { reason: string }).reason, 'BLANK_SOURCE');
  assert.equal((nothing as { reason: string }).reason, 'NULL_SOURCE');
  // Their comparison keys differ, so none can be mistaken for another.
  assert.notEqual(moneyComparisonKey(zero), moneyComparisonKey(blank));
  assert.equal(moneyComparisonKey(blank), null);
});

test('minor and major unit sources normalise to the same value', () => {
  const major = canonicalMoney('2300000', 'major_units');
  const minor = canonicalMoney('230000000', 'minor_units');
  assert.ok(major.present && minor.present);
  assert.equal(major.amountMinor, minor.amountMinor);
});

test('more precision than a cent is refused rather than rounded away', () => {
  assert.equal((canonicalMoney('1.005') as { reason: string }).reason, 'INVALID');
  assert.equal((canonicalMoney('abc') as { reason: string }).reason, 'INVALID');
});

// ===========================================================================
// Dates — the sale-date mystery
// ===========================================================================

test('Hennepin YYYYMM and MnGeo day-padded dates agree at the precision both state', () => {
  // The exact values from PID 0102724110003. Hennepin states a month; MnGeo
  // pads the day to 01 — all 390,589 of its Hennepin sale dates do.
  const direct = canonicalDate('201412', 'SALE_DATE');
  const aggregation = canonicalDate('2014-12-01T00:00:00.000Z', 'SALE_DATE', 'month');
  assert.ok(direct.present && aggregation.present);
  assert.equal(direct.precision, 'month');
  assert.equal(direct.sourceFormat, 'yyyymm');
  assert.equal(compareDates(direct, aggregation), 'EQUAL');
});

test('a month-precision source does not confirm a day it never stated', () => {
  const month = canonicalDate('201412', 'SALE_DATE');
  const day = canonicalDate('2014-12-17', 'SALE_DATE');
  // Same month, different day: they agree only at the shared precision, and
  // saying so is more honest than either EQUAL or DIFFERENT.
  assert.equal(compareDates(month, day), 'EQUAL_AT_SHARED_PRECISION');
  assert.equal(dateAtPrecision(month as never, 'month'), '2014-12');
});

test('different months are different', () => {
  assert.equal(compareDates(canonicalDate('201411', 'SALE_DATE'), canonicalDate('2014-12-01', 'SALE_DATE')), 'DIFFERENT');
});

test('the same calendar date with different meanings is never agreement', () => {
  const sale = canonicalDate('2024-06-15', 'SALE_DATE');
  const recording = canonicalDate('2024-06-15', 'RECORDING_DATE');
  assert.equal(compareDates(sale, recording), 'INCOMPARABLE_SEMANTICS');
  assert.notEqual(dateComparisonKey(sale), dateComparisonKey(recording));
});

test('the same date in different formats is the same date', () => {
  const keys = ['2024-06-15', '06/15/2024', '2024-06-15T09:30:00.000Z']
    .map((v) => dateComparisonKey(canonicalDate(v, 'SALE_DATE')));
  assert.equal(new Set(keys).size, 1);
});

test('epoch values are read in UTC, so a midnight edit does not shift a day', () => {
  const millis = canonicalDate(Date.UTC(2024, 5, 15), 'SOURCE_EDIT_DATE');
  assert.ok(millis.present);
  assert.equal(millis.date, '2024-06-15');
  assert.equal(millis.sourceFormat, 'epoch_millis');
});

test('an impossible date is refused', () => {
  // Date would roll this into March rather than objecting.
  assert.equal((canonicalDate('2026-02-31', 'SALE_DATE') as { reason: string }).reason, 'INVALID');
  assert.equal((canonicalDate('nonsense', 'SALE_DATE') as { reason: string }).reason, 'INVALID');
});

test('the year 3009 anomaly is retained and flagged, never corrected', () => {
  // MnGeo really does publish a sale date in 3009. Rewriting it would hide a
  // publisher defect; dropping it would lose the row.
  const odd = canonicalDate('3009-12-30', 'SALE_DATE');
  assert.ok(odd.present);
  assert.equal(odd.date, '3009-12-30');
  assert.equal(odd.implausible, true);
  assert.equal(canonicalDate('2024-06-15', 'SALE_DATE').present && (canonicalDate('2024-06-15', 'SALE_DATE') as { implausible: boolean }).implausible, false);
});

// ===========================================================================
// Addresses — the 0%-agreement defect
// ===========================================================================

test("Hennepin's packed street field splits into the components MnGeo publishes", () => {
  // '78TH ST E' against st_name=78th, st_pos_typ=Street, st_pos_dir=East.
  const split = splitPackedStreet('78TH ST E           ');
  assert.deepEqual(split, { streetName: '78TH', postType: 'ST', postDirectional: 'E', preDirectional: null });
});

test('the real Hennepin address compares equal once components are normalised', () => {
  const direct = canonicalAddress({
    houseNumber: '2901', ...splitPackedStreet('78TH ST E'),
    city: 'BLOOMINGTON', state: 'MN', postalCode: '55425',
  });
  const aggregation = canonicalAddress({
    houseNumber: '2901', streetName: '78th', postType: 'Street', postDirectional: 'East',
    city: 'Bloomington', state: 'MN', postalCode: '55425',
  });
  assert.ok(direct.present && aggregation.present);
  assert.equal(direct.comparisonKey, '2901 78TH ST E');
  assert.equal(compareAddresses(direct, aggregation), 'EQUAL');
});

test('a different unit number stays a different address', () => {
  const a = canonicalAddress({ houseNumber: '100', streetName: 'MAIN', postType: 'ST', unitType: 'APT', unitId: '101' });
  const b = canonicalAddress({ houseNumber: '100', streetName: 'MAIN', postType: 'ST', unitType: 'APT', unitId: '102' });
  // Two homes. This is the case over-normalisation would destroy.
  assert.equal(compareAddresses(a, b), 'SAME_STREET_DIFFERENT_UNIT');
  assert.notEqual(a.present && a.comparisonKey, b.present && b.comparisonKey);
});

test('a different street stays different', () => {
  const a = canonicalAddress({ houseNumber: '100', streetName: 'MAIN', postType: 'ST' });
  const b = canonicalAddress({ houseNumber: '100', streetName: 'ELM', postType: 'ST' });
  assert.equal(compareAddresses(a, b), 'DIFFERENT');
});

test('the source components are preserved verbatim', () => {
  const address = canonicalAddress({ streetName: '78th', postType: 'Street', houseNumber: '2901' });
  assert.ok(address.present);
  assert.equal(address.sourceComponents.streetName, '78th');
  assert.equal(address.components.streetName, '78TH');
  assert.equal(address.components.postType, 'ST');
});

test('an address still resolves no property', () => {
  // The comparison key deliberately carries no county and no jurisdiction: it
  // answers "do these two observations state the same address", never "which
  // property is this".
  const a = canonicalAddress({ houseNumber: '100', streetName: 'MAIN', postType: 'ST', city: 'MINNEAPOLIS' });
  const b = canonicalAddress({ houseNumber: '100', streetName: 'MAIN', postType: 'ST', city: 'SAINT PAUL' });
  assert.ok(a.present && b.present);
  assert.equal(a.comparisonKey, b.comparisonKey);
  assert.ok(!a.comparisonKey.includes('MINNEAPOLIS'), 'the key is a street, not a place');
});

test('an address with no street and no number is absent, not empty', () => {
  assert.equal(canonicalAddress({ city: 'MINNEAPOLIS' }).present, false);
});

// ===========================================================================
// Identifiers
// ===========================================================================

test('leading zeros survive, because they are part of the identifier', () => {
  const id = canonicalIdentifier('0102724110003', 'us-county-27053');
  assert.ok(id.present);
  assert.equal(id.normalized, '0102724110003');
  assert.notEqual(canonicalIdentifier('007').present && (canonicalIdentifier('007') as { normalized: string }).normalized,
    canonicalIdentifier('7').present && (canonicalIdentifier('7') as { normalized: string }).normalized);
});

test('the same parcel id in two counties is two identifiers', () => {
  const a = canonicalIdentifier('123', 'us-county-27053');
  const b = canonicalIdentifier('123', 'us-county-27123');
  assert.notEqual(identifierComparisonKey(a), identifierComparisonKey(b));
});

test('punctuation folds reversibly and the raw value is kept', () => {
  const id = canonicalIdentifier('01-027-24-11-0003');
  assert.ok(id.present);
  assert.equal(id.raw, '01-027-24-11-0003');
  assert.equal(id.normalized, '01027241100 03'.replace(' ', ''));
});

// ===========================================================================
// Absence, versioning
// ===========================================================================

test('absence reasons distinguish missing, null and blank', () => {
  assert.equal(absenceOf(undefined)?.reason, 'MISSING');
  assert.equal(absenceOf(null)?.reason, 'NULL_SOURCE');
  assert.equal(absenceOf('   ')?.reason, 'BLANK_SOURCE');
  // Zero is a value.
  assert.equal(absenceOf(0), null);
  assert.equal(absenceOf('0'), null);
});

test('the digest scope names every version that can change representation', () => {
  const scope = normalizationScope({ parserVersion: 'p1', normalizationVersion: 'n1' });
  assert.ok(scope.includes(NORMALIZATION_CONTRACT_VERSION));
  assert.ok(scope.includes('parser=p1'));
  assert.ok(scope.includes('normalizer=n1'));
  // A contract change therefore changes the digest deliberately, rather than
  // looking like a corrupted replay.
  assert.notEqual(
    normalizationScope({ parserVersion: 'p1', normalizationVersion: 'n1' }),
    normalizationScope({ parserVersion: 'p1', normalizationVersion: 'n2' }),
  );
});

test('normalization is deterministic', () => {
  for (const build of [
    () => canonicalArea(1.83, 'acres'),
    () => canonicalMoney('109672.88'),
    () => canonicalDate('201412', 'SALE_DATE'),
    () => canonicalAddress({ houseNumber: '2901', streetName: '78th', postType: 'Street', postDirectional: 'East' }),
  ]) {
    assert.deepEqual(build(), build());
  }
});

// ===========================================================================
// What the real Hennepin layer actually contains
//
// Every case below was found by running the splitter over the retained
// 447,044-row artifact rather than by imagining what a street field looks like.
// ===========================================================================

test("Hennepin's own street-type abbreviations split", () => {
  // LA 3,067, TR 954 and CUR 382 in the first 100,000 rows: the county's
  // abbreviations for Lane, Trail and Curve.
  assert.equal(splitPackedStreet('SHERIDAN LA N').postType, 'LA');
  assert.equal(splitPackedStreet('WOODLAND TR').postType, 'TR');
  assert.equal(splitPackedStreet('BASSWOOD CUR').postType, 'CUR');
});

test('a street name that looks like a type is left alone', () => {
  // BROADWAY appears 281 times in 100,000 rows and is a name every time.
  assert.equal(splitPackedStreet('BROADWAY ST NE').streetName, 'BROADWAY');
  assert.equal(splitPackedStreet('WEST BROADWAY').streetName, 'WEST BROADWAY');
  // "LA SALLE AVE" keeps its leading LA: only a trailing token is a candidate.
  assert.equal(splitPackedStreet('LA SALLE AVE').streetName, 'LA SALLE');
});

test('a placeholder in the street field is an absence, not an address', () => {
  // Hennepin writes ADDRESS UNASSIGNED for parcels with no address yet — 2,420
  // times in 120,000 rows, always with a null house number. Treated as a name,
  // every one of them would share a canonical address key and an overlap audit
  // would call that agreement.
  assert.deepEqual(splitPackedStreet('ADDRESS UNASSIGNED  '),
    { streetName: null, postType: null, postDirectional: null, preDirectional: null });
  const address = canonicalAddress({ houseNumber: null, ...splitPackedStreet('ADDRESS UNASSIGNED') });
  assert.equal(address.present, false);
});

test('a blank sale date is blank, not an epoch', () => {
  // 10,816 of 100,000 real rows carry spaces in SALE_DATE rather than null.
  const blank = canonicalDate('      ', 'SALE_DATE');
  assert.equal(blank.present, false);
  assert.equal((blank as { reason: string }).reason, 'BLANK_SOURCE');
});

test('the tax-total agreement rate was arithmetic, not data quality', () => {
  // 5,122 of 100,000 real Hennepin parcels have a whole-dollar TAX_TOT — 5.1%,
  // against the 5.91% agreement DF-0H measured against MnGeo's integer column.
  // Those are the same number, and it is the share of parcels whose cents
  // happen to be zero.
  assert.equal(compareMoney(canonicalMoney('4200.00'), canonicalMoney('4200')), 'EQUAL');
  assert.equal(compareMoney(canonicalMoney('4200.37'), canonicalMoney('4200')), 'EQUAL_AT_WHOLE_UNITS');
});

test('the whole-unit tolerance is only for a source that lost its cents', () => {
  // 109672.88 against an integer column that can only say 109673.
  assert.equal(compareMoney(canonicalMoney('109672.88'), canonicalMoney('109673')), 'EQUAL_AT_WHOLE_UNITS');
  // But two sources that both state cents and disagree about them, disagree.
  // Rounding both to 101 to call them equivalent would manufacture agreement.
  assert.equal(compareMoney(canonicalMoney('100.50'), canonicalMoney('100.99')), 'DIFFERENT');
  assert.equal(compareMoney(canonicalMoney('4200.37'), canonicalMoney('4200.38')), 'DIFFERENT');
});

test('an adapter may coarsen a date precision but never sharpen it', () => {
  // MnGeo pads every sale day to -01, and only its adapter can know that.
  const padded = canonicalDate('2014-12-01', 'SALE_DATE', 'month');
  assert.ok(padded.present);
  assert.equal(padded.precision, 'month');

  // But no adapter knowledge turns a year into a day. A declaration finer than
  // the text supports is ignored rather than believed.
  const yearOnly = canonicalDate('2014', 'SALE_DATE', 'day');
  assert.ok(yearOnly.present);
  assert.equal(yearOnly.precision, 'year');

  const monthOnly = canonicalDate('201412', 'SALE_DATE', 'day');
  assert.ok(monthOnly.present);
  assert.equal(monthOnly.precision, 'month');
});

test('areas compare by whether the sources could be describing the same parcel', () => {
  // Each stated value denotes an interval half a unit wide either side, and two
  // observations agree when those intervals can overlap.
  //
  // 0.12 acres means [0.115, 0.125) acres — [5009, 5445) square feet — and
  // 5,000 square feet is outside it. The sources disagree, and a comparator
  // that widened the tolerance until they did not would be inventing agreement.
  assert.equal(compareAreas(canonicalArea(5000, 'square_feet'), canonicalArea(0.12, 'acres')), 'DIFFERENT');
  // 0.115 acres is 5,009.4 square feet, and 5,100 is inside its interval.
  assert.equal(
    compareAreas(canonicalArea(5100, 'square_feet'), canonicalArea(0.12, 'acres')),
    'EQUAL_WITHIN_SOURCE_PRECISION',
  );
});
