import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeParcelId, propertyIdFromCountyParcel } from '../src/canonical/models.ts';
import { countyJurisdictionId } from '../src/registry/jurisdictions.ts';
import { fixture, harness } from './helpers.ts';

// --- property identity ---------------------------------------------------------

test('a county-scoped parcel resolves a property, and the county is part of the key', () => {
  const hennepin = propertyIdFromCountyParcel('27053', normalizeParcelId('01-234-56-78-9012'));
  const anoka = propertyIdFromCountyParcel('27003', normalizeParcelId('01-234-56-78-9012'));
  // The same parcel string in two counties is two different properties. Parcel
  // numbers are only unique inside a county, and forgetting that merges them.
  assert.notEqual(hennepin, anoka);
  assert.equal(hennepin, propertyIdFromCountyParcel('27053', normalizeParcelId('012345678 9012')));
});

test('parcel normalisation ignores punctuation and case but keeps the raw form', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const identifier = result.bundles[0]?.propertyIdentifiers.find((p) => p.identifierType === 'county_parcel');
  assert.equal(identifier?.value, '01-234-56-78-9012');
  assert.equal(identifier?.normalizedValue, '01234567890 12'.replace(' ', ''));
  assert.equal(identifier?.countyFips, '27053');
});

test('a preliminary parcel resolves only to provisional, never to resolved', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const identifier = result.bundles[0]?.propertyIdentifiers.find((p) => p.identifierType === 'county_parcel');
  // The extract carries the submitter's PID. The county's verified final PID is
  // county-added data that this feed does not contain, so the identity is good
  // enough to key on and not good enough to call settled.
  assert.equal(identifier?.finality, 'preliminary');
  assert.equal(identifier?.resolutionState, 'provisional');
  assert.equal(identifier?.resolutionMethod, 'county_parcel_preliminary');
  assert.ok(identifier?.propertyId);
});

test('a placeholder parcel stays unresolved and creates no property', async () => {
  const result = await harness().run([fixture('06-placeholder-parcel-unresolved.xml')]);
  const bundle = result.bundles[0];
  const identifier = bundle?.propertyIdentifiers.find((p) => p.identifierType === 'county_parcel');
  assert.equal(identifier?.value, 'PENDING');
  assert.equal(identifier?.resolutionState, 'unresolved');
  assert.equal(identifier?.propertyId, null);
  assert.deepEqual(bundle?.properties, []);
  // The transaction still exists; ambiguity about the property does not delete it.
  assert.ok(bundle?.transaction.transactionId);
  assert.equal(bundle?.transactionParcels.length, 1);
});

test('an address is retained as evidence and never resolves a property', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const addresses = result.bundles[0]?.propertyIdentifiers.filter((p) => p.identifierType === 'normalized_address') ?? [];
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0]?.resolutionState, 'unresolved');
  assert.equal(addresses[0]?.propertyId, null);
});

test('a transaction over three parcels yields three properties, not one', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const bundle = result.bundles[0];
  assert.equal(bundle?.transactionParcels.length, 3);
  assert.equal(bundle?.properties.length, 3);
  assert.equal(new Set(bundle?.properties.map((p) => p.propertyId)).size, 3);
  // One transaction is not one parcel, and the model never assumes it is.
  assert.equal(new Set(bundle?.transactionParcels.map((p) => p.transactionId)).size, 1);
});

// --- party identity ---------------------------------------------------------------

test('every party observation from eCRV is unresolved: a filing is not identity evidence', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const parties = result.bundles[0]?.parties ?? [];
  assert.equal(parties.length, 6);
  assert.ok(parties.every((p) => p.resolutionState === 'unresolved'));
  assert.ok(parties.every((p) => p.partyId === null));
});

test('the same name on two unrelated filings does NOT merge into one party', async () => {
  const h = harness();
  await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  await h.run([fixture('05-same-name-unrelated-party.xml')], { period: '2026-W32' });

  const bundles = await h.fabricStore.bundles();
  const averys = bundles
    .flatMap((b) => b.parties)
    .filter((p) => p.normalizedName === 'AVERY TESTONE');

  assert.equal(averys.length, 2, 'both filings should be retained');
  // Two distinct observations, no shared identity. False merges are worse than
  // missed merges, and a matching name is not evidence of sameness.
  assert.equal(new Set(averys.map((p) => p.observationId)).size, 2);
  assert.ok(averys.every((p) => p.partyId === null));
});

test('the same party in the same filing re-observed on replay keeps one identity', async () => {
  const h = harness();
  const first = await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const ids = first.bundles[0]?.parties.map((p) => p.observationId) ?? [];

  const replay = await harness({ root: h.root }).run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  assert.deepEqual(replay.bundles[0]?.parties.map((p) => p.observationId), ids);
});

test('party kind comes from the source flag, never from the shape of the name', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const parties = result.bundles[0]?.parties ?? [];
  const org = parties.find((p) => p.nameParts.organizationName === 'SYNTHETIC HOLDINGS LLC');
  assert.equal(org?.kind, 'organization');
  assert.ok(parties.filter((p) => p.kind === 'person').length >= 5);
});

// --- transaction and financing ------------------------------------------------------

test('a transaction records the source instrument code without mapping it', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const t = result.bundles[0]?.transaction;
  assert.equal(t?.instrumentTypeCode, 'QUITCLAIM');
  assert.equal(t?.countyFips, '27053');
  assert.equal(t?.jurisdictionId, countyJurisdictionId('27053'));
  assert.equal(t?.totalConsideration?.amountMinor, 50_000_000);
  assert.equal(t?.transferDate, '2026-04-01T00:00:00');
});

test('a contract for deed stays distinguishable from a purchase mortgage', async () => {
  const h = harness();
  const cd = await h.run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const mortgage = await h.run([fixture('01-single-buyer-single-seller-mortgage.xml')], { period: '2026-W32' });

  assert.equal(cd.bundles[0]?.financing[0]?.financeTypeCode, 'CD');
  assert.equal(mortgage.bundles[0]?.financing[0]?.financeTypeCode, 'MORTGAGE');
  assert.equal(cd.bundles[0]?.financing[0]?.balloonAmount?.amountMinor, 30_000_000);
  assert.equal(cd.bundles[0]?.financing[0]?.interestRateType, 'variable');
  assert.equal(mortgage.bundles[0]?.financing[0]?.interestRateType, 'fixed');
});

test('a declared cash sale records the declaration but observes no financing event', async () => {
  const result = await harness().run([fixture('05-same-name-unrelated-party.xml')]);
  const bundle = result.bundles[0];
  assert.equal(bundle?.financing.length, 1);
  assert.equal(bundle?.financing[0]?.financeTypeCode, 'CASH');
  assert.equal(bundle?.financing[0]?.principalAmount, null);
  assert.equal(bundle?.events.some((e) => e.eventType === 'FINANCING_OBSERVED'), false);
});

test('buyer intent about a principal residence is not recorded as an owner-occupancy fact', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const bundle = result.bundles[0];
  assert.equal(bundle?.transaction.characteristics['buyer_intends_principal_residence'], true);
  // It lives on the transaction and nowhere else. No property or party row
  // carries a standing occupancy claim derived from it.
  const propertyText = JSON.stringify(bundle?.properties);
  assert.ok(!/occup/i.test(propertyText));
  assert.ok(!/occupied/i.test(JSON.stringify(bundle?.parties)));
});

test('a related-party declaration stays on the transaction, not on the parties', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const bundle = result.bundles[0];
  assert.equal(bundle?.transaction.characteristics['buyer_seller_related'], true);
  assert.ok(!/related/i.test(JSON.stringify(bundle?.parties)));
});

test('study eligibility is recorded as unavailable, not as acceptance', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const meta = result.bundles[0]?.transaction.analyticalMetadata;
  assert.equal(meta?.['studyEligibility'], null);
  assert.equal(meta?.['studyEligibilityAvailable'], false);
});

// --- events -----------------------------------------------------------------------

test('only events the source supports are emitted', async () => {
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const types = (result.events ?? []).map((e) => e.eventType).sort();
  assert.deepEqual(types, ['FINANCING_OBSERVED', 'PROPERTY_SALE_OBSERVED', 'REAL_ESTATE_TRANSFER_OBSERVED']);
  const emitted = JSON.stringify(result.events);
  for (const forbidden of ['INVESTOR', 'CASH_BUYER', 'FORECLOSURE', 'ACTIVE_BUYER']) {
    assert.ok(!emitted.includes(forbidden), `${forbidden} must never be emitted from an eCRV`);
  }
});

test('a zero-consideration gift is a transfer but not a sale', async () => {
  const result = await harness().run([fixture('03-gift-no-financing-no-contact.xml')]);
  const types = result.events.map((e) => e.eventType);
  assert.ok(types.includes('REAL_ESTATE_TRANSFER_OBSERVED'));
  assert.ok(!types.includes('PROPERTY_SALE_OBSERVED'));
  // And the transfer is still fully ingested.
  assert.equal(result.bundles[0]?.transaction.characteristics['gift_or_inheritance'], true);
});

test('a legal-proceeding declaration never becomes a distress or foreclosure event', async () => {
  const xml = fixture('01-single-buyer-single-seller-mortgage.xml');
  const result = await harness().run([xml]);
  assert.ok(result.events.every((e) => e.eventType !== 'FINANCING_OBSERVED' || e.payload['financeTypeCode'] === 'MORTGAGE'));
  // The characteristic exists; no event or entity is derived from it.
  assert.equal('foreclosure_or_legal_proceeding' in (result.bundles[0]?.transaction.characteristics ?? {}), true);
});

test('one sale event is emitted per resolved property', async () => {
  const result = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const sales = result.events.filter((e) => e.eventType === 'PROPERTY_SALE_OBSERVED');
  assert.equal(sales.length, 3);
  assert.equal(new Set(sales.map((e) => e.subjectId)).size, 3);
  assert.ok(sales.every((e) => e.payload['propertyIdentityFinality'] === 'preliminary'));
});

test('event ids are deterministic, so replay re-emits rather than duplicates', async () => {
  const a = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const b = await harness().run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  assert.deepEqual(a.events.map((e) => e.eventId).sort(), b.events.map((e) => e.eventId).sort());
});
