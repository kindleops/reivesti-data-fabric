/**
 * Wisconsin RETR transfer semantics.
 *
 * A RETR proves a conveyance was filed. Roughly a third of Wisconsin's returns
 * are gifts, inheritances, divorces, corrections and foreclosures, and every one
 * of them carries a value field that would read as a sale price to anything that
 * did not look at the conveyance type. These tests are the guard on that.
 *
 * Every code and every rate below is the publisher's own, transcribed from the
 * data dictionary at My Tax Account → Download Historical RETR Data → View CSV
 * Documentation, and from the RETR Overview (R. 5-26). Nothing is invented.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WI_COUNTIES,
  WI_COUNTY_FIPS,
  WI_FEE_EXEMPTIONS,
  WI_TRANSFER_FEE_RATE,
  exemptionCode,
} from '../src/connectors/wi-retr/codes.ts';
import { classifyTransfer } from '../src/connectors/wi-retr/classify.ts';
import {
  deriveValueFromFee,
  retrConsiderations,
  statedConsideration,
} from '../src/connectors/wi-retr/consideration.ts';
import { canonicalMoney } from '../src/canonical/normalization-contract.ts';
import { WI_RETR_FIELDS, WI_RETR_RESTRICTED_FIELDS } from '../src/connectors/wi-retr/field-map.ts';
import { retrDate, retrSourceRecordId, stripParcelGuard } from '../src/connectors/wi-retr/parse.ts';

const base = {
  conveyanceType: null as string | null,
  feeExemption: null as string | null,
  relationship: null as string | null,
  ownershipType: null as string | null,
  rightsRetained: null as string | null,
  salePriceMinor: null as bigint | null,
};

// ===========================================================================
// Geography
// ===========================================================================

test('all 72 Wisconsin counties resolve against the federal catalogue', () => {
  assert.equal(WI_COUNTIES.length, 72);
  for (const name of WI_COUNTIES) {
    assert.match(WI_COUNTY_FIPS[name] ?? '', /^55\d{3}$/, `${name} has no FIPS`);
  }
  // Menominee is the one that breaks the "odd numbers, alphabetical" pattern:
  // it was created in 1961, after the odd codes were allocated. A derived code
  // would be wrong here and for every county after it.
  assert.equal(WI_COUNTY_FIPS['Menominee'], '55078');
  assert.equal(WI_COUNTY_FIPS['Adams'], '55001');
  assert.equal(WI_COUNTY_FIPS['Wood'], '55141');
});

// ===========================================================================
// Transfer classification — a RETR is not a sale
// ===========================================================================

test('a clean arm\'s-length sale is the only thing that reads as a market sale', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Sale',
    relationship: 'No relationship',
    ownershipType: 'Full',
    rightsRetained: 'None',
    salePriceMinor: 25_000_000n,
  });
  assert.equal(result.primary, 'MARKET_SALE_SUPPORTED');
});

test('a sale between relatives is not a market sale', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Sale',
    relationship: 'Parent/child or grandparent/grandchild',
    ownershipType: 'Full',
    rightsRetained: 'None',
    salePriceMinor: 25_000_000n,
  });
  assert.equal(result.primary, 'RELATIONSHIP_TRANSFER');
  assert.ok(!result.all.some((e) => e.classification === 'MARKET_SALE_SUPPORTED'));
});

test('a sale of a partial interest is not a market sale of the property', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Sale',
    relationship: 'No relationship',
    ownershipType: 'Partial',
    rightsRetained: 'None',
    salePriceMinor: 25_000_000n,
  });
  assert.equal(result.primary, 'PARTIAL_INTEREST_TRANSFER');
});

test('a sale with a retained life estate is not a clean transfer', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Sale',
    relationship: 'No relationship',
    ownershipType: 'Full',
    rightsRetained: 'Life Estate',
    salePriceMinor: 25_000_000n,
  });
  assert.equal(result.primary, 'PARTIAL_INTEREST_TRANSFER');
});

test('a sale with a price of zero is not a market sale', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Sale', relationship: 'No relationship', ownershipType: 'Full',
    rightsRetained: 'None', salePriceMinor: 0n,
  });
  assert.notEqual(result.primary, 'MARKET_SALE_SUPPORTED');
});

test('inheritance, divorce and corrections are non-market however they are priced', () => {
  for (const conveyance of ['Will, decedent, or survivorship', 'Divorce or between spouses',
    'Affidavit of correction/correction instrument', 'Trustee to beneficiary']) {
    const result = classifyTransfer({ ...base, conveyanceType: conveyance, salePriceMinor: 25_000_000n });
    assert.ok(
      result.all.some((e) => e.classification === 'NON_MARKET_TRANSFER_SUPPORTED'),
      `${conveyance} should be non-market`,
    );
    assert.notEqual(result.primary, 'MARKET_SALE_SUPPORTED');
  }
});

test('a foreclosure is reported as a foreclosure, not as a sale', () => {
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Foreclosure or In lieu of foreclosure (with prior interest in property or mortgage)',
    salePriceMinor: 18_000_000n,
  });
  assert.equal(result.primary, 'FORECLOSURE_RELATED');
});

test('a part sale/part gift to a child is all three things it is', () => {
  // The case that would be destroyed by forcing a single label.
  const result = classifyTransfer({
    ...base,
    conveyanceType: 'Parent/child or grandparent/grandchild - part sale/part gift',
    relationship: 'Parent/child or grandparent/grandchild',
    ownershipType: 'Partial',
    salePriceMinor: 5_000_000n,
  });
  const kinds = new Set(result.all.map((e) => e.classification));
  assert.ok(kinds.has('GIFT_TRANSFER'));
  assert.ok(kinds.has('RELATIONSHIP_TRANSFER'));
  assert.ok(kinds.has('PARTIAL_INTEREST_TRANSFER'));
  assert.equal(result.primary, 'GIFT_TRANSFER');
});

test('every classification names the field and value it was read from', () => {
  const result = classifyTransfer({ ...base, conveyanceType: 'Gift', feeExemption: '8m - Between spouses' });
  for (const evidence of result.all) {
    assert.ok(evidence.field.length > 0, 'a classification with no basis is an inference');
    assert.ok(evidence.value.length > 0);
  }
  assert.ok(result.all.some((e) => e.field === 'Fee Exemption' && e.value === '8m - Between spouses'));
});

test('an exemption is matched on the statutory code, not the publisher label', () => {
  // The published label list contains at least one typo — "6d -
  // Partisanship/qualification" is s. 178.0901 partnership qualification. The
  // code is the stable half, so that is what is matched.
  assert.equal(exemptionCode('8m - Between spouses'), '8m');
  assert.equal(exemptionCode('6d - Partisanship/qualification'), '6d');
  assert.equal(exemptionCode(null), null);

  const spouses = classifyTransfer({ ...base, feeExemption: '8m - Between spouses' });
  assert.ok(spouses.all.some((e) => e.classification === 'RELATIONSHIP_TRANSFER'));
});

test('an unlisted code is reported as drift, not silently classified', () => {
  const result = classifyTransfer({ ...base, conveyanceType: 'Teleportation' });
  assert.deepEqual(result.unknownCodes, ['Conveyance Type=Teleportation']);
  assert.equal(result.primary, 'UNKNOWN_TRANSFER_TYPE');
});

test('saying nothing is UNKNOWN, which is never a synonym for sale', () => {
  const result = classifyTransfer(base);
  assert.equal(result.primary, 'UNKNOWN_TRANSFER_TYPE');
});

test('every published exemption code parses', () => {
  for (const exemption of WI_FEE_EXEMPTIONS) {
    assert.ok((exemptionCode(exemption) ?? '').length > 0, `${exemption} has no code`);
  }
  assert.equal(WI_FEE_EXEMPTIONS.length, 32);
});

// ===========================================================================
// Consideration — five fields, five different facts
// ===========================================================================

test('the five monetary fields stay five different facts', () => {
  const c = retrConsiderations({
    salePrice: '$250,000.00',
    estimatedValue: '$260,000.00',
    transferFeeDue: '$750.00',
    personalPropertyExcluded: '$5,000.00',
    personalPropertyIncluded: '$1,200.00',
  });
  const minor = (kind: string): bigint | null => {
    const value = c.find((x) => x.kind === kind)?.value;
    return value !== undefined && value.present ? value.amountMinor : null;
  };
  assert.equal(minor('SALE_PRICE'), 25_000_000n);
  assert.equal(minor('ESTIMATED_VALUE'), 26_000_000n);
  assert.equal(minor('TRANSFER_FEE'), 75_000n);
  assert.equal(minor('PERSONAL_PROPERTY_EXCLUDED'), 500_000n);
  assert.equal(minor('PERSONAL_PROPERTY_INCLUDED'), 120_000n);
  assert.equal(c.length, 5);
});

test('the transfer fee is a tax and can never be read as consideration', () => {
  const c = retrConsiderations({
    salePrice: null, estimatedValue: null, transferFeeDue: '$750.00',
    personalPropertyExcluded: null, personalPropertyIncluded: null,
  });
  // A fee is present, a price is not, and the answer is "no consideration".
  assert.equal(statedConsideration(c), null);
});

test('an estimated value does not become a sale price', () => {
  const c = retrConsiderations({
    salePrice: null, estimatedValue: '$260,000.00', transferFeeDue: null,
    personalPropertyExcluded: null, personalPropertyIncluded: null,
  });
  assert.equal(statedConsideration(c), null, 'estimated value answers a different question');
  assert.ok(c.some((x) => x.kind === 'ESTIMATED_VALUE' && x.value.present), 'and is still retained');
});

test('money is exact through the dollar signs and commas', () => {
  const c = retrConsiderations({
    salePrice: '$1,234,567.89', estimatedValue: null, transferFeeDue: null,
    personalPropertyExcluded: null, personalPropertyIncluded: null,
  });
  const price = statedConsideration(c);
  assert.ok(price?.value.present);
  assert.equal(price.value.amountMinor, 123_456_789n);
});

test('blank, null, zero and exempt stay four different facts', () => {
  const blank = retrConsiderations({
    salePrice: '', estimatedValue: null, transferFeeDue: '$0.00',
    personalPropertyExcluded: null, personalPropertyIncluded: null,
  });
  const byKind = new Map(blank.map((x) => [x.kind, x.value]));
  assert.equal(byKind.get('SALE_PRICE')?.present, false);
  assert.equal((byKind.get('SALE_PRICE') as { reason: string }).reason, 'BLANK_SOURCE');
  assert.equal((byKind.get('ESTIMATED_VALUE') as { reason: string }).reason, 'NULL_SOURCE');
  // An explicit $0.00 fee is a value: it says the transfer was exempt or free,
  // which is different from the fee not being stated.
  const fee = byKind.get('TRANSFER_FEE');
  assert.ok(fee?.present);
  assert.equal(fee.amountMinor, 0n);
});

test('a malformed amount is refused, not coerced to zero', () => {
  const c = retrConsiderations({
    salePrice: 'see attached', estimatedValue: null, transferFeeDue: null,
    personalPropertyExcluded: null, personalPropertyIncluded: null,
  });
  const price = c.find((x) => x.kind === 'SALE_PRICE');
  assert.equal(price?.value.present, false);
  assert.equal((price?.value as { reason: string }).reason, 'INVALID');
  assert.equal(statedConsideration(c), null);
});

// ===========================================================================
// Derivation — only where the statute is explicit
// ===========================================================================

test('the statutory fee formula inverts to the value band it names', () => {
  // DOR's own worked example: "$100,000 x .003 = $300.00 transfer fee".
  const derived = deriveValueFromFee(canonicalMoney('300.00', 'major_units'), {
    feeExemption: null, originalLandContractDate: null,
  });
  assert.ok(derived !== null);
  assert.equal(derived.amountMinor, 10_000_000n);
  assert.equal(derived.rate, WI_TRANSFER_FEE_RATE);
  // "or fraction thereof" rounds value UP to the next $100 before charging, so
  // the fee names a band, not a point. Reporting a single number would be a
  // false precision.
  assert.equal(derived.lowerBoundMinor, 9_990_001n);
  assert.equal(derived.upperBoundMinor, 10_000_000n);
  assert.equal(derived.derivationVersion, 'wi_retr_fee_to_value_1');
});

test('an exempt transfer is never inverted into a $0 sale', () => {
  // No fee was owed, so a zero fee says nothing whatever about value. This is
  // the derivation that would otherwise invent hundreds of thousands of
  // worthless "sales" a year.
  assert.equal(
    deriveValueFromFee(canonicalMoney('0.00', 'major_units'), {
      feeExemption: '11 - Will, descent survivorship', originalLandContractDate: null,
    }),
    null,
  );
  assert.equal(
    deriveValueFromFee(canonicalMoney('300.00', 'major_units'), {
      feeExemption: '8m - Between spouses', originalLandContractDate: null,
    }),
    null,
  );
});

test('the 1971-1981 land contract rate is refused rather than guessed', () => {
  // Deeds satisfying an original land contract dated in that window are charged
  // 10c per $100, not 30c. Applying the wrong rate understates value threefold.
  assert.equal(
    deriveValueFromFee(canonicalMoney('300.00', 'major_units'), {
      feeExemption: null, originalLandContractDate: '1975-06-01',
    })?.rate,
    0.001,
  );
  // Outside the window the ordinary rate applies.
  assert.equal(
    deriveValueFromFee(canonicalMoney('300.00', 'major_units'), {
      feeExemption: null, originalLandContractDate: '1990-06-01',
    })?.rate,
    WI_TRANSFER_FEE_RATE,
  );
  // An unparseable contract date means the rate cannot be chosen, so nothing
  // is claimed.
  assert.equal(
    deriveValueFromFee(canonicalMoney('300.00', 'major_units'), {
      feeExemption: null, originalLandContractDate: 'unknown',
    }),
    null,
  );
});

test('a fee that the formula could not have produced is refused', () => {
  // 30c per $100 always yields a whole number of 30c units. $301.17 did not
  // come from this formula at whole-$100 granularity, so no value is claimed.
  assert.equal(
    deriveValueFromFee(canonicalMoney('301.17', 'major_units'), {
      feeExemption: null, originalLandContractDate: null,
    }),
    null,
  );
});

// ===========================================================================
// Parsing details that lose data when they go wrong
// ===========================================================================

test('the parcel number keeps its leading zeros and loses only the Excel tab', () => {
  // "The parcel number is prefixed with a tab in order to prevent Excel from
  // removing leading zeros." The tab is transport; the zeros are identity.
  assert.equal(stripParcelGuard('\t007-0123-4567'), '007-0123-4567');
  assert.equal(stripParcelGuard('251/123456789123'), '251/123456789123');
  assert.notEqual(stripParcelGuard('\t007'), '7');
});

test('dates are read in the publisher\'s MM-dd-yyyy and nothing else', () => {
  assert.equal(retrDate('11-30-2025'), '2025-11-30');
  assert.equal(retrDate('01-05-2024'), '2024-01-05');
  // Not ISO, not d-m-y, not a guess.
  assert.equal(retrDate('2025-11-30'), null);
  assert.equal(retrDate(''), null);
  assert.equal(retrDate(null), null);
});

test('identity is county-scoped, because document numbers repeat across counties', () => {
  const dane = retrSourceRecordId({ countyFips: '55025', documentNumber: '123456' });
  const brown = retrSourceRecordId({ countyFips: '55009', documentNumber: '123456' });
  assert.notEqual(dane, brown);
  // The public dataset publishes no RETR receipt number, so this pair IS the
  // publisher's identity — there is nothing better to key on.
  assert.match(dane, /55025/);
  assert.match(dane, /123456/);
});

// ===========================================================================
// The filing/dataset boundary
// ===========================================================================

test('the pinned field map is the publisher\'s 78 columns', () => {
  assert.equal(WI_RETR_FIELDS.length, 78);
  const ordinals = WI_RETR_FIELDS.map((f) => f.ordinal).sort((a, b) => a - b);
  assert.deepEqual(ordinals, Array.from({ length: 78 }, (_, i) => i + 1), 'ordinals must be 1..78 with no gaps');
});

test('mailing addresses and agent identities are restricted, never canonical', () => {
  for (const name of ['Grantor Address', 'Grantee Address', 'Grantor Agent Name', 'Grantee Agent Name',
    'Tax Bill Address', 'Tax Bill Name', 'Preparer Name']) {
    assert.ok(WI_RETR_RESTRICTED_FIELDS.has(name), `${name} must be restricted`);
  }
  // Party NAMES are not restricted — a grantor's name is the transfer. Their
  // home address is not.
  assert.ok(!WI_RETR_RESTRICTED_FIELDS.has('Grantor Name'));
  assert.ok(!WI_RETR_RESTRICTED_FIELDS.has('Grantee Name'));
});

test('financing is published as flags only, and no amount is claimed', () => {
  const financing = WI_RETR_FIELDS.filter((f) => f.group === 'financing');
  assert.equal(financing.length, 6);
  // The FORM collects amount financed, APR and term. The public dataset does
  // not, and no field here pretends otherwise.
  for (const field of financing) assert.equal(field.sourceType, 'String', `${field.name} is a Yes/No flag`);
  assert.ok(!WI_RETR_FIELDS.some((f) => /amount financed|APR|term/i.test(f.name)));
});
