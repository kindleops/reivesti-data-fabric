import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import { contentDigest } from '../src/core/hash.ts';
import { compileXsd } from '../src/schema/xsd.ts';
import { ECRV_COUNTY_ONLY_FIELDS, ECRV_FIELD_MAP, dispositionCounts, mappedPaths } from '../src/connectors/mn-ecrv/field-map.ts';
import { PINNED_SCHEMA_PATH, loadPinnedSchema } from '../src/connectors/mn-ecrv/index.ts';
import { parseEcrvDocument, parseMoneyMinor, splitArtifact } from '../src/connectors/mn-ecrv/parse.ts';
import { FIXTURES, fixtureXml } from './helpers.ts';

const parse = (name: string) => parseEcrvDocument(fixtureXml(name), name).record;

// --- parties ------------------------------------------------------------------

test('one buyer and one seller are read as one buyer and one seller', () => {
  const r = parse('01-single-buyer-single-seller-mortgage.xml');
  assert.equal(r.buyers.length, 1);
  assert.equal(r.sellers.length, 1);
  assert.equal(r.buyers[0]?.firstName, 'AVERY');
  assert.equal(r.buyers[0]?.lastName, 'TESTONE');
  assert.equal(r.buyers[0]?.isPerson, true);
  assert.equal(r.sellers[0]?.side, 'seller');
});

test('multiple buyers stay separate parties, never one concatenated string', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.buyers.length, 3);
  assert.deepEqual(r.buyers.map((b) => b.block), ['individuals', 'individuals', 'organizations']);
  assert.deepEqual(r.buyers.map((b) => b.firstName ?? b.organizationName), ['CASEY', 'DREW', 'SYNTHETIC HOLDINGS LLC']);
  // Party keys are unique within the filing so contacts and roles attach unambiguously.
  assert.equal(new Set(r.buyers.map((b) => b.partyKey)).size, 3);
});

test('multiple sellers stay separate parties', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.sellers.length, 3);
  assert.deepEqual(r.sellers.map((s) => s.lastName), ['TESTFIVE', 'TESTSIX', 'TESTSEVEN']);
});

test('a source-flagged protected party is carried through as protected', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  const protectedParty = r.sellers.find((s) => s.privateIndicator === true);
  assert.ok(protectedParty, 'expected one party flagged with privateIndicator');
  assert.equal(protectedParty.lastName, 'TESTSEVEN');
});

test('an organisation is classified by the source, not inferred from its name', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  const org = r.buyers.find((b) => b.block === 'organizations');
  assert.equal(org?.isPerson, false);
  assert.equal(org?.organizationName, 'SYNTHETIC HOLDINGS LLC');
  assert.equal(org?.firstName, null);
});

// --- parcels --------------------------------------------------------------------

test('multiple parcels are all retained, with the source designation preserved', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.property.parcels.length, 3);
  assert.deepEqual(r.property.parcels.map((p) => p.primary), [true, false, false]);
  assert.deepEqual(
    r.property.parcels.map((p) => p.parcelId),
    ['11-111-11-11-1111', '22-222-22-22-2222', '33-333-33-33-3333'],
  );
});

test('multiple situs addresses are retained', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.property.addresses.length, 2);
});

// --- financing --------------------------------------------------------------------

test('a mortgage with a fixed rate is read exactly', () => {
  const r = parse('01-single-buyer-single-seller-mortgage.xml');
  assert.equal(r.sale.financeTypeCode, 'MORTGAGE');
  assert.equal(r.sale.financeArrangements.length, 1);
  const f = r.sale.financeArrangements[0];
  assert.equal(f?.contractMortgageAmountMinor, 24_000_000);
  assert.equal(f?.interestRateTypeCode, 'FIXED');
  assert.equal(f?.interestRatePercent, 6.375);
  assert.equal(f?.paymentAmountMinor, 149_732);
  assert.equal(f?.numberOfPayments, 360);
  assert.equal(f?.paymentForCode, 'INTANDPRIN');
  assert.equal(f?.balloonAmountMinor, null);
  assert.equal(f?.balloonDate, null);
});

test('a contract for deed keeps its own finance type and its balloon terms', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  // CD must never be read as MORTGAGE: it is the distinction that makes the
  // record worth ingesting at all.
  assert.equal(r.sale.financeTypeCode, 'CD');
  const f = r.sale.financeArrangements[0];
  assert.equal(f?.interestRateTypeCode, 'VARIABLE');
  assert.equal(f?.balloonAmountMinor, 30_000_000);
  assert.equal(f?.balloonDate, '2036-04-01T00:00:00');
});

test('a cash sale with no arrangements has no financing arrangements', () => {
  const r = parse('03-gift-no-financing-no-contact.xml');
  assert.equal(r.sale.financeTypeCode, 'CASH');
  assert.equal(r.sale.financeArrangements.length, 0);
});

// --- transaction characteristics ---------------------------------------------------

test('1031, partial interest and related-party declarations are read as stated', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.sale.likeKindExchange, true);
  assert.equal(r.sale.buyerPartInterest, true);
  assert.equal(r.supplementary.relatedInd, true);
  assert.equal(r.supplementary.nonMarketPriceInd, true);
});

test('a gift or inheritance indicator is read as stated', () => {
  const r = parse('03-gift-no-financing-no-contact.xml');
  assert.equal(r.supplementary.giftInd, true);
  assert.equal(r.sale.totalPurchaseAmountMinor, 0);
  assert.equal(r.sale.deedTypeCode, 'PERREPDEED');
});

test('acreage figures are retained verbatim as decimal text, not floated', () => {
  const r = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(r.property.totalAcres, '40.0');
  assert.equal(r.property.tillableAcres, '12.5');
  assert.equal(r.property.irrigatedAcres, null);
});

// --- typed coercion ------------------------------------------------------------------

test('currency is exact integer minor units in every written form', () => {
  assert.equal(parseMoneyMinor('300000.00'), 30_000_000);
  assert.equal(parseMoneyMinor('300000'), 30_000_000);
  assert.equal(parseMoneyMinor('1234.5'), 123_450);
  assert.equal(parseMoneyMinor('0'), 0);
  assert.equal(parseMoneyMinor('-500.25'), -50_025);
  assert.equal(parseMoneyMinor('.99'), 99);
  assert.equal(parseMoneyMinor(''), null);
  // More precision than currency has is refused rather than rounded away.
  assert.equal(parseMoneyMinor('1.005'), null);
  assert.equal(parseMoneyMinor('abc'), null);
});

test('currency avoids the floating point error a naive parser would introduce', () => {
  // 0.1 + 0.2 style drift: 1234567.89 * 100 is 123456788.99999999 in IEEE 754.
  assert.equal(parseMoneyMinor('1234567.89'), 123_456_789);
  assert.notEqual(Math.round(Number('1234567.89') * 100), 123_456_788);
});

test('a dateTime with no offset keeps its wall-clock date', () => {
  const r = parse('03-gift-no-financing-no-contact.xml');
  // A naive UTC conversion of a local midnight can move the date by a day, and
  // a transfer date that moves is a different fact.
  assert.equal(r.sale.deedContractDate, '2026-02-02T00:00:00');
});

test('booleans accept only the lexical forms XSD permits', () => {
  const xml = fixtureXml('01-single-buyer-single-seller-mortgage.xml')
    .replace('<giftInd>false</giftInd>', '<giftInd>maybe</giftInd>');
  assert.throws(() => parseEcrvDocument(xml, 'bool'), (e: unknown) => isFabricError(e, 'PARSE'));
});

test('empty elements are absence, and absence is null rather than zero', () => {
  const xml = fixtureXml('01-single-buyer-single-seller-mortgage.xml')
    .replace('<totPurchaseAmt>300000.00</totPurchaseAmt>', '<totPurchaseAmt></totPurchaseAmt>')
    .replace('<principalResidence>true</principalResidence>', '<principalResidence></principalResidence>');
  const r = parseEcrvDocument(xml, 'empty').record;
  assert.equal(r.sale.totalPurchaseAmountMinor, null);
  assert.equal(r.property.principalResidence, null);
});

// --- contact separation at parse time ---------------------------------------------

test('contact fields are split out of the record at parse time', () => {
  const r = parse('01-single-buyer-single-seller-mortgage.xml');
  const buyerContact = r.restricted.partyContacts.find((c) => c.partyKey === 'buyer:individuals:1');
  assert.equal(buyerContact?.daytimePhone, '555-0100');
  assert.equal(buyerContact?.email, 'avery.testone@example.invalid');
  // The party block itself carries no channel to leak.
  assert.equal(Object.keys(r.buyers[0] ?? {}).some((k) => /phone|email|contactNotes/i.test(k)), false);
});

test('null contact fields produce nulls rather than empty strings', () => {
  const r = parse('03-gift-no-financing-no-contact.xml');
  for (const c of r.restricted.partyContacts) {
    assert.equal(c.daytimePhone, null);
    assert.equal(c.email, null);
    assert.equal(c.contactNotes, null);
  }
  assert.equal(r.restricted.submitterFormRaw, null);
});

// --- determinism ---------------------------------------------------------------------

test('parsing is deterministic: identical input yields an identical digest', () => {
  const a = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  const b = parse('02-multi-party-multi-parcel-contract-for-deed.xml');
  assert.equal(contentDigest(a), contentDigest(b));
});

test('an artifact splits into its documents whether zipped or bare', () => {
  const zipped = splitArtifact(readFileSync(join(FIXTURES, 'weekly-extract-sample.zip')));
  assert.equal(zipped.length, 3);
  const bare = splitArtifact(new TextEncoder().encode(fixtureXml('01-single-buyer-single-seller-mortgage.xml')));
  assert.equal(bare.length, 1);
  assert.throws(() => splitArtifact(new TextEncoder().encode('plain text')), (e: unknown) => isFabricError(e, 'PARSE'));
});

// --- field inventory coverage ----------------------------------------------------------

test('every leaf element in the pinned schema has exactly one mapping decision', () => {
  // The coverage gate. When the department adds an element, this fails until a
  // human decides what it means — which is the only safe default.
  const model = compileXsd(readFileSync(PINNED_SCHEMA_PATH, 'utf8'), 'pinned');
  const schemaPaths: string[] = [];
  const walk = (type: typeof model.rootType, path: string): void => {
    if (type.kind === 'complex') for (const p of type.sequence) walk(p.type, `${path}/${p.name}`);
    else schemaPaths.push(path);
  };
  walk(model.rootType, `/${model.rootName}`);

  assert.deepEqual(mappedPaths(), [...schemaPaths].sort());
  assert.equal(ECRV_FIELD_MAP.length, schemaPaths.length);
  assert.equal(new Set(ECRV_FIELD_MAP.map((f) => f.path)).size, ECRV_FIELD_MAP.length);
});

test('every mapping decision carries a target or a stated reason for having none', () => {
  for (const f of ECRV_FIELD_MAP) {
    if (f.target === null) {
      assert.equal(f.disposition, 'IGNORE_WITH_REASON', `${f.path} has no target but is ${f.disposition}`);
      assert.ok(f.note.length > 20, `${f.path} must record why it is ignored`);
    }
  }
});

test('contact-bearing elements are all routed to the restricted plane', () => {
  const contactPaths = ECRV_FIELD_MAP
    .filter((f) => /daytimePhone|\/email$|contactNotes|submitterForm|Comment$/.test(f.path))
    .map((f) => f.disposition);
  assert.ok(contactPaths.length > 0);
  assert.ok(contactPaths.every((d) => d === 'RESTRICTED_CONTACT'), 'a contact-bearing element escaped the restricted plane');
});

test('county-added data is documented as absent rather than silently missing', () => {
  const notes = ECRV_COUNTY_ONLY_FIELDS.map((f) => f.path).join(' ');
  for (const expected of ['yearBuilt', 'estimatedMarketValue', 'finalParcelIds', 'studyAcceptReject', 'acceptDate']) {
    assert.ok(notes.includes(expected), `${expected} should be documented as county-added`);
  }
  assert.ok(ECRV_COUNTY_ONLY_FIELDS.every((f) => f.disposition === 'COUNTY_ONLY'));
  // And none of them are actually in the schema.
  const schemaText = readFileSync(PINNED_SCHEMA_PATH, 'utf8');
  for (const absent of ['yearBuilt', 'neighborhoodCode', 'estimatedMarketValue', 'acceptDate', 'submitDate']) {
    assert.ok(!schemaText.includes(absent), `${absent} unexpectedly appears in the pinned schema`);
  }
});

test('the disposition tally is stable and every disposition kind is exercised', () => {
  const counts = dispositionCounts();
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), ECRV_FIELD_MAP.length);
  for (const kind of ['CANONICALIZE', 'NORMALIZE', 'RESTRICTED_CONTACT', 'KEEP_RAW', 'IGNORE_WITH_REASON', 'DERIVE_LATER'] as const) {
    assert.ok((counts[kind] ?? 0) > 0, `${kind} is unused`);
  }
  assert.equal(loadPinnedSchema().model.rootName, 'ecrvForm');
});
