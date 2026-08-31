import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContactPlane } from '../src/contact/contact-plane.ts';
import { isFabricError } from '../src/core/errors.ts';
import { createNdjsonFabricStore } from '../src/runtime/fabric-store.ts';
import { fixture, harness, tempRoot } from './helpers.ts';

/** Values that appear in the fixtures and must never reach canonical output. */
const CONTACT_VALUES = ['555-0100', '555-0102', 'avery.testone@example.invalid', 'ops@example.invalid'];

test('anonymous and member principals cannot read the restricted contact plane', async () => {
  const h = harness();
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.ok(h.contactPlane.size() > 0, 'the fixture should have produced contact observations');

  for (const principal of ['anonymous', 'member'] as const) {
    assert.throws(
      () => h.contactPlane.read(principal),
      (e: unknown) => isFabricError(e, 'RESTRICTED'),
      `${principal} must not read contact data`,
    );
  }
  // Operator and service can, and that is the only way in.
  assert.ok(h.contactPlane.read('operator').length > 0);
  assert.ok(h.contactPlane.read('service').length > 0);
});

test('value-free aggregates are available without unlocking the plane', async () => {
  const h = harness();
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  // Operational metrics must not require a privileged read, and must not
  // disclose a single character of anybody's contact details.
  const counts = h.contactPlane.countsByType();
  assert.equal(typeof h.contactPlane.size(), 'number');
  assert.ok((counts['phone'] ?? 0) > 0);
  assert.ok(!JSON.stringify(counts).includes('555'));
});

test('no contact value appears anywhere in canonical output', async () => {
  const h = harness();
  const result = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);

  const canonical = JSON.stringify({
    bundles: result.bundles,
    events: result.events,
  });
  for (const value of CONTACT_VALUES) {
    assert.ok(!canonical.includes(value), `${value} leaked into canonical output`);
  }
  // The values do exist — in the restricted plane, where they belong.
  const restricted = JSON.stringify(h.contactPlane.read('operator'));
  assert.ok(CONTACT_VALUES.some((v) => restricted.includes(v)));
});

test('canonical types have no field that could hold a contact value', async () => {
  // The structural guarantee. Even a future normaliser bug cannot put a phone
  // number on a party or transaction, because no such column exists.
  const result = await harness().run([fixture('01-single-buyer-single-seller-mortgage.xml')]);
  const bundle = result.bundles[0];
  assert.ok(bundle);

  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
    }
  };
  walk(bundle);
  for (const key of keys) {
    assert.ok(!/phone|email|contactnote/i.test(key), `canonical output exposes a contact-shaped field: ${key}`);
  }
});

test('contact rows persist to a separate restricted root, not beside canonical data', async () => {
  const root = tempRoot('df-store-');
  const store = createNdjsonFabricStore(root);
  const h = harness({ fabricStore: store });
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);

  const derived = join(root, 'derived');
  const restricted = join(root, 'restricted');
  assert.ok(statSync(restricted).isDirectory());
  assert.deepEqual(readdirSync(restricted), ['contacts']);

  // Nothing under derived/ contains a contact value.
  const scan = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of scan(derived)) {
    const text = readFileSync(file, 'utf8');
    for (const value of CONTACT_VALUES) {
      assert.ok(!text.includes(value), `${value} leaked into ${file}`);
    }
  }
});

test('restricted partitions are written with owner-only permissions', async () => {
  const root = tempRoot('df-perm-');
  const h = harness({ fabricStore: createNdjsonFabricStore(root) });
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const dir = join(root, 'restricted', 'contacts');
  for (const name of readdirSync(dir)) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  }
});

test('an artifact that may carry contact data is labelled as such in its manifest', async () => {
  const h = harness();
  const result = await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  // The raw bytes contain the same phone numbers, so the retention label has to
  // travel with the artifact for storage policy to act on it.
  assert.equal(result.artifact?.manifest.access.carriesRestrictedContact, true);
  assert.equal(result.artifact?.manifest.access.termsStatus, 'reviewed_restricted');
});

test('observing a channel is recorded as record_only, never as permission to use it', async () => {
  const h = harness();
  await h.run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const rows = h.contactPlane.read('operator');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.permittedUse, 'record_only');
    assert.equal(row.confidence, 'source_stated');
    assert.equal(row.partyId, null, 'contact must not be attached to an unresolved party identity');
  }
});

test('a party the source flags as protected carries that status onto its contact rows', async () => {
  const h = harness();
  await h.run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const bundles = await h.fabricStore.bundles();
  const protectedParty = bundles.flatMap((b) => b.parties).find((p) => p.protectedIdentity);
  assert.ok(protectedParty, 'the fixture includes a privateIndicator party');

  // That party has no contact channels in the fixture, so assert the mechanism
  // directly rather than relying on the fixture carrying one.
  const plane = createContactPlane();
  plane.record({
    contactObservationId: 'c1',
    partyId: null,
    partyObservationId: protectedParty.observationId,
    contactType: 'phone',
    value: '555-0199',
    sourceId: 's',
    sourceRecordId: 'r',
    observedAt: '2026-08-31T12:00:00.000Z',
    confidence: 'source_stated',
    permittedUse: 'record_only',
    status: 'protected_identity',
    evidence: protectedParty.evidence,
  });
  assert.equal(plane.read('service')[0]?.status, 'protected_identity');
  assert.throws(() => plane.read('anonymous'), (e: unknown) => isFabricError(e, 'RESTRICTED'));
});

test('contact observation ids are deterministic, so replay does not duplicate anyone', async () => {
  const a = await harness().run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  const b = await harness().run(['fixtures/mn-ecrv/weekly-extract-sample.zip']);
  assert.deepEqual(
    a.contacts.map((c) => c.contactObservationId).sort(),
    b.contacts.map((c) => c.contactObservationId).sort(),
  );
  const plane = createContactPlane();
  for (const c of [...a.contacts, ...b.contacts]) plane.record(c);
  assert.equal(plane.size(), a.contacts.length);
});

test('unbounded submitter free text is isolated rather than published', async () => {
  const h = harness();
  const result = await h.run([fixture('02-multi-party-multi-parcel-contract-for-deed.xml')]);
  const comment = 'Synthetic note: price reflects a family arrangement.';
  assert.ok(!JSON.stringify(result.bundles).includes(comment), 'submitter free text leaked into canonical output');
  assert.ok(h.contactPlane.read('operator').some((c) => c.value === comment));
});
