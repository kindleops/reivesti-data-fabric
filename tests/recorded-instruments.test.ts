import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import { contentDigest } from '../src/core/hash.ts';
import {
  CONVEYANCE_FAMILIES,
  OWNERSHIP_GRADE_LINKS,
  impliedReferenceType,
  instrumentIdOf,
  normalizeDocumentNumber,
} from '../src/canonical/instruments.ts';
import {
  isMatchable,
  parseLegalDescription,
  platMatchKey,
} from '../src/canonical/legal-description.ts';
import {
  classifyDocumentType,
  documentTypeEntries,
  familyCounts,
} from '../src/connectors/mn-hennepin-recorder/taxonomy.ts';
import { normalizeRole } from '../src/connectors/mn-hennepin-recorder/normalize.ts';
import { createHennepinRecorderConnector } from '../src/connectors/mn-hennepin-recorder/index.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { assertAutomationPermitted, createHttpTransport } from '../src/runtime/transport.ts';
import { createArcGisSnapshotTransport } from '../src/runtime/arcgis.ts';
import { recorderFixture, streamHarness } from './helpers.ts';

const CHAIN = recorderFixture('chain-2024-2025.ndjson');
const EDGE = recorderFixture('edge-cases.ndjson');
const PID = '0202824410097';

type Row = Record<string, unknown>;
const rowsOf = async (h: ReturnType<typeof streamHarness>, table: string): Promise<Row[]> =>
  (await h.table(table)) as Row[];

// --- access: the gate that defines this phase --------------------------------

test('the registry records that automation is contractually prohibited', () => {
  const source = defaultRegistry().source('mn_hennepin_recorded_instruments');
  // Not "unknown" and not "manual_only": Hennepin's subscription agreement
  // explicitly forbids scraping, robots, crawlers and spiders, and forbids
  // redistribution of the Information.
  assert.equal(source.automationStatus, 'prohibited');
  assert.equal(source.licenseStatus, 'restricted');
  assert.equal(source.termsStatus, 'reviewed_restricted');
  assert.equal(source.carriesRestrictedContact, true);
  assert.equal(source.authoritativeForParcelIdentity, false);
});

test('every publisher-reaching transport is refused for this source', () => {
  const source = defaultRegistry().source('mn_hennepin_recorded_instruments');
  for (const transport of [
    createHttpTransport(),
    createArcGisSnapshotTransport({ serviceUrl: 'https://example.invalid', layerId: 0 }),
  ]) {
    assert.throws(
      () => assertAutomationPermitted(transport, source.automationStatus, source.sourceId),
      (e: unknown) => isFabricError(e, 'ACCESS_BLOCKED'),
    );
  }
});

test('the connector ships no network transport at all', () => {
  const connector = createHennepinRecorderConnector();
  // It cannot be pointed at the county even by mistake.
  assert.equal(connector.transport.reachesPublisher, false);
  assert.equal(connector.transport.accessType, 'manual_import');
});

test('with no lawful delivery the run is blocked on access, and says why', async () => {
  const h = streamHarness();
  const { runStreamingConnector } = await import('../src/runtime/stream-run.ts');
  const result = await runStreamingConnector({
    registry: defaultRegistry(),
    connector: createHennepinRecorderConnector(),
    mappingId: 'hennepin_recorder__hennepin',
    artifactStore: h.artifactStore,
    contactPlane: h.contactPlane,
    varRoot: h.varRoot,
    referencePeriod: '2024',
  });
  assert.equal(result.run.status, 'blocked_on_access');
  assert.equal(result.run.failureKind, 'ACCESS_BLOCKED');
});

test('the run log never carries credentials or a subscription URL', async () => {
  const { captureLogger } = await import('../src/core/logging.ts');
  const { logger, records } = captureLogger('debug');
  const h = streamHarness();
  await h.runRecorder(CHAIN, { logger });
  const text = JSON.stringify(records);
  for (const secret of ['password', 'subscription_agreement', 'ts.recordease.support', 'Authorization']) {
    assert.ok(!text.includes(secret), `the run log mentions ${secret}`);
  }
});

// --- taxonomy ------------------------------------------------------------------

test('document types are matched exactly, never fuzzily', () => {
  assert.equal(classifyDocumentType('WARRANTY DEED').family, 'CONVEYANCE');
  assert.equal(classifyDocumentType('warranty  deed').family, 'CONVEYANCE'); // case and spacing only
  // Substring reasoning would get all three of these wrong.
  assert.equal(classifyDocumentType('SATISFACTION OF MORTGAGE').family, 'MORTGAGE_RELEASE');
  assert.equal(classifyDocumentType('ASSIGNMENT OF MORTGAGE').family, 'MORTGAGE_ASSIGNMENT');
  assert.equal(classifyDocumentType('TRANSFER ON DEATH DEED').family, 'CONVEYANCE');
});

test('an unknown document type is OTHER, not a nearest guess', () => {
  const result = classifyDocumentType('SYNTHETIC NOVEL INSTRUMENT');
  assert.equal(result.family, 'OTHER');
  assert.equal(result.recognised, false);
  assert.equal(result.entry, null);
});

test('only genuine conveyances may support a conveyance event', () => {
  const unsafe = ['CONTRACT FOR DEED', 'SHERIFFS CERTIFICATE OF SALE', 'CORRECTION DEED', 'TRANSFER ON DEATH DEED'];
  for (const label of unsafe) {
    const entry = classifyDocumentType(label).entry;
    assert.ok(entry, label);
    assert.equal(entry.safeConveyanceEvent, false, `${label} must not support a conveyance event`);
  }
  for (const label of ['WARRANTY DEED', 'QUIT CLAIM DEED', 'TRUSTEES DEED']) {
    assert.equal(classifyDocumentType(label).entry?.safeConveyanceEvent, true, label);
  }
  assert.deepEqual([...CONVEYANCE_FAMILIES], ['CONVEYANCE']);
});

test('every taxonomy entry explains itself and the families are populated', () => {
  for (const e of documentTypeEntries()) {
    assert.ok(e.rawType.length > 2);
    if (!e.safeConveyanceEvent && e.family === 'CONVEYANCE') {
      assert.ok(e.notes.length > 30, `${e.rawType} is a conveyance excluded from conveyance events and must say why`);
    }
    if (e.expectsReferences) assert.notEqual(e.impliedReference, null, e.rawType);
  }
  const counts = familyCounts();
  for (const family of ['CONVEYANCE', 'MORTGAGE', 'MORTGAGE_ASSIGNMENT', 'MORTGAGE_RELEASE', 'CORRECTION']) {
    assert.ok((counts[family] ?? 0) > 0, `no entries for ${family}`);
  }
});

test('reference type is implied by the referencing document, conservatively', () => {
  assert.equal(impliedReferenceType('MORTGAGE_ASSIGNMENT'), 'ASSIGNS');
  assert.equal(impliedReferenceType('MORTGAGE_RELEASE'), 'SATISFIES');
  assert.equal(impliedReferenceType('CORRECTION'), 'AMENDS');
  assert.equal(impliedReferenceType('CONVEYANCE'), 'REFERENCES');
  assert.equal(impliedReferenceType('OTHER'), 'REFERENCES');
});

test('roles normalise exactly, and anything unrecognised is OTHER', () => {
  assert.equal(normalizeRole('Grantor'), 'GRANTOR');
  assert.equal(normalizeRole('GRANTEES'), 'GRANTEE');
  assert.equal(normalizeRole('Mortgagee'), 'MORTGAGEE');
  // Getting this wrong would reverse the direction of an ownership inference.
  assert.equal(normalizeRole('PARTY OF THE THIRD PART'), 'OTHER');
});

// --- identity ----------------------------------------------------------------------

test('document number alone is not an identity', () => {
  const abstract = instrumentIdOf('27053', 'abstract', 'A6000001');
  const torrens = instrumentIdOf('27053', 'torrens', 'A6000001');
  const otherCounty = instrumentIdOf('27003', 'abstract', 'A6000001');
  // Abstract (Minn. Stat. ch. 507) and Torrens (ch. 508) number independently,
  // and every county starts from one.
  assert.equal(new Set([abstract, torrens, otherCounty]).size, 3);
  assert.equal(abstract, instrumentIdOf('27053', 'abstract', 'a-6000001'));
  assert.equal(normalizeDocumentNumber(' a-600.0001 '), 'A6000001');
});

test('an Abstract and a Torrens document sharing a number stay separate', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const instruments = await rowsOf(h, 'instruments');
  const shared = instruments.filter((i) => i['documentNumber'] === 'A6000001');
  assert.equal(shared.length, 2);
  assert.equal(new Set(shared.map((i) => i['instrumentId'])).size, 2);
  assert.deepEqual(shared.map((i) => i['registrationSystem']).sort(), ['abstract', 'torrens']);
});

// --- parser ---------------------------------------------------------------------------

test('the chain parses into instruments, parties, links and references', async () => {
  const h = streamHarness();
  const result = await h.runRecorder(CHAIN);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.metrics.rowsParsed, 6);
  assert.equal((await rowsOf(h, 'instruments')).length, 6);
  assert.equal((await rowsOf(h, 'instrument_references')).length, 3);
  assert.equal((await rowsOf(h, 'recorded_financing')).length, 3);
});

test('multiple grantors and grantees are all preserved', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const quitClaim = (await rowsOf(h, 'instruments')).find((i) => i['documentTypeRaw'] === 'QUIT CLAIM DEED');
  assert.ok(quitClaim);
  const parties = (await rowsOf(h, 'instrument_parties'))
    .filter((p) => p['instrumentId'] === quitClaim['instrumentId']);
  assert.equal(parties.filter((p) => p['normalizedRole'] === 'GRANTOR').length, 2);
  assert.equal(parties.filter((p) => p['normalizedRole'] === 'GRANTEE').length, 2);
  // Every one keeps its own raw role and sequence.
  assert.deepEqual(parties.map((p) => p['sequence']).sort(), [1, 1, 2, 2]);
});

test('a document with several parcels links to all of them', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const multi = (await rowsOf(h, 'instruments')).find((i) => i['documentNumber'] === 'A6000040');
  const links = (await rowsOf(h, 'instrument_property_links'))
    .filter((l) => l['instrumentId'] === multi?.['instrumentId']);
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l['linkState'] === 'DIRECT_PARCEL'));
});

test('a document with no parcel is unresolved, not discarded', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const noParcel = (await rowsOf(h, 'instruments')).find((i) => i['documentNumber'] === 'A6000030');
  assert.ok(noParcel, 'the document is still ingested');
  const links = (await rowsOf(h, 'instrument_property_links'))
    .filter((l) => l['instrumentId'] === noParcel['instrumentId']);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.['linkState'], 'UNRESOLVED');
  assert.equal(links[0]?.['propertyId'], null);
  // And its legal description is retained for a later, measured resolution model.
  const legals = (await rowsOf(h, 'legal_descriptions'))
    .filter((l) => l['instrumentId'] === noParcel['instrumentId']);
  assert.equal(legals.length, 1);
});

test('several legal descriptions on one document are all retained in order', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const multi = (await rowsOf(h, 'instruments')).find((i) => i['documentNumber'] === 'A6000040');
  const legals = (await rowsOf(h, 'legal_descriptions'))
    .filter((l) => l['instrumentId'] === multi?.['instrumentId'])
    .sort((a, b) => (a['sequence'] as number) - (b['sequence'] as number));
  assert.equal(legals.length, 2);
  assert.deepEqual(legals.map((l) => l['sequence']), [1, 2]);
});

test('recording dates keep their stated offset', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const deed = (await rowsOf(h, 'instruments')).find((i) => i['documentNumber'] === 'A5000001');
  // Minn. Stat. 508.47 has the registrar endorse the hour and minute of filing.
  // Normalising that to UTC would restate a statutory fact.
  assert.equal(deed?.['recordedAt'], '2024-03-15T10:22:00-05:00');
});

test('consideration is only ever the indexed figure', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const instruments = await rowsOf(h, 'instruments');
  assert.equal(instruments.find((i) => i['documentNumber'] === 'A5000001')?.['statedConsideration'], 41_250_000);
  // An assignment states none, and none is recorded rather than zero.
  assert.equal(instruments.find((i) => i['documentNumber'] === 'A5000450')?.['statedConsideration'], null);
});

// --- legal descriptions --------------------------------------------------------------

test('a clean plat description parses and is matchable', () => {
  const parsed = parseLegalDescription('LOT 1 BLOCK 2 SYNTHETIC ADDITION');
  assert.equal(parsed.status, 'structured');
  assert.equal(parsed.lot, '1');
  assert.equal(parsed.block, '2');
  assert.equal(parsed.addition, 'SYNTHETIC');
  assert.ok(isMatchable(parsed));
  assert.ok(platMatchKey('27053', parsed));
});

test('a compound or metes-and-bounds description is never matchable', () => {
  for (const raw of [
    'THAT PART OF LOT 4 BLOCK 9 UNPLATTED 30 118 21 LYING NORTH OF THE CENTERLINE',
    'LOTS 1 AND 2 BLOCK 3 SYNTHETIC ADDITION EXCEPT THE SOUTH 20 FEET',
    'COMMENCING AT THE NE CORNER THENCE SOUTH 89 DEGREES 200 FEET TO THE POINT OF BEGINNING',
  ]) {
    const parsed = parseLegalDescription(raw);
    assert.ok(!isMatchable(parsed), `should not be matchable: ${raw}`);
    assert.equal(platMatchKey('27053', parsed), null);
    assert.ok(parsed.notes.length > 0, 'a low score must explain itself');
  }
});

test('an unparseable description fails open to raw, with no invented components', () => {
  const parsed = parseLegalDescription('SEE ATTACHED EXHIBIT A');
  assert.equal(parsed.status, 'unparsed');
  assert.equal(parsed.confidence, 0);
  assert.deepEqual(
    [parsed.lot, parsed.block, parsed.addition, parsed.section, parsed.township, parsed.range],
    [null, null, null, null, null, null],
  );
});

test('the raw text always survives the parse', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const legals = await rowsOf(h, 'legal_descriptions');
  assert.ok(legals.length > 0);
  for (const l of legals) {
    assert.ok(typeof l['raw'] === 'string' && (l['raw'] as string).length > 0);
    assert.ok(typeof l['parserVersion'] === 'string');
    assert.ok(typeof l['confidence'] === 'number');
  }
});

// --- reference graph -------------------------------------------------------------------

test('references resolve to the instruments they name', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const { resolveReferences } = await import('../src/canonical/instrument-graph.ts');

  const resolutions: Record<string, unknown>[] = [];
  const summary = await resolveReferences(
    () => instrumentKeys(h), () => referenceKeys(h),
    async (r) => { resolutions.push(r as unknown as Record<string, unknown>); },
  );

  // assignment -> mortgage, satisfaction -> mortgage, correction -> deed
  assert.equal(summary.total, 3);
  assert.equal(summary.resolved, 3);
  assert.equal(summary.unresolved, 0);
  assert.ok(resolutions.every((r) => r['resolved'] === true));
});

test('an unresolved reference is retained, and resolves when its target arrives', async () => {
  const h = streamHarness();
  await h.runRecorder(recorderFixture('unresolved-reference.ndjson'), { period: '2025' });
  const { resolveReferences } = await import('../src/canonical/instrument-graph.ts');

  let before = await resolveReferences(() => instrumentKeys(h), () => referenceKeys(h), async () => {});
  assert.equal(before.total, 1);
  assert.equal(before.unresolved, 1, 'the 2009 mortgage is not in the estate yet');

  // The pointer is still on disk. Dropping it would have destroyed the lineage.
  assert.equal((await rowsOf(h, 'instrument_references')).length, 1);

  // Backfill reaches 2009.
  await h.runRecorder(recorderFixture('late-target.ndjson'), { period: '2009' });
  const after = await resolveReferences(() => instrumentKeys(h), () => referenceKeys(h), async () => {});
  assert.equal(after.total, 1);
  assert.equal(after.resolved, 1, 'the same reference now resolves');
});

test('reference resolution is a pure fold and invents no cycles', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const { resolveReferences } = await import('../src/canonical/instrument-graph.ts');
  const edges: [string, string][] = [];
  await resolveReferences(() => instrumentKeys(h), () => referenceKeys(h), async (r) => {
    if (r.toInstrumentId) edges.push([r.fromInstrumentId, r.toInstrumentId]);
  });
  // No edge points at itself, and no pair points at each other.
  for (const [from, to] of edges) {
    assert.notEqual(from, to);
    assert.ok(!edges.some(([f, t]) => f === to && t === from), 'a two-cycle was created');
  }
});

// --- ownership ---------------------------------------------------------------------------

test('a qualifying deed chain yields acquisition and disposition, and a correction yields neither', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const observations = await deriveOwnershipFor(h);

  const northstar = observations.find((o) => o.normalizedName === 'NORTHSTAR HOMES LLC');
  assert.ok(northstar, 'the buyer of the first deed should have an interval');
  assert.equal(northstar.observedAcquiredAt, '2024-03-15T10:22:00-05:00');
  assert.equal(northstar.observedDisposedAt, '2025-06-01T11:00:00-05:00', 'closed by the later warranty deed');
  assert.equal(northstar.basis, 'recorded_conveyance');

  const blake = observations.find((o) => o.normalizedName === 'TESTTWO BLAKE');
  assert.equal(blake?.observedAcquiredAt, '2025-06-01T11:00:00-05:00');
  assert.equal(blake?.observedDisposedAt, null, 'we have not seen them convey it away');

  // The correction deed names the same grantor and grantee as the 2024 deed. If
  // it counted, NORTHSTAR would show a second acquisition after its disposition.
  const northstarIntervals = observations.filter((o) => o.normalizedName === 'NORTHSTAR HOMES LLC');
  assert.equal(northstarIntervals.length, 1, 'a correction must not create a second acquisition');
});

test('a grantor never observed acquiring does not get a disposition invented', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const observations = await deriveOwnershipFor(h);
  // TESTONE granted the 2024 deed, but the estate never saw them acquire. That
  // usually just means backfill has not reached their deed.
  assert.equal(observations.find((o) => o.normalizedName === 'TESTONE AVERY R'), undefined);
});

test('contracts for deed and sheriff certificates never move ownership', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const observations = await deriveOwnershipFor(h);
  for (const name of ['TESTEIGHT HARPER', 'FIRST SYNTHETIC BANK NA']) {
    assert.equal(observations.find((o) => o.normalizedName === name), undefined,
      `${name} acquired via a non-conveying instrument and must not hold an interval`);
  }
});

test('a deed with no identifiable land cannot move ownership', async () => {
  const h = streamHarness();
  await h.runRecorder(EDGE);
  const observations = await deriveOwnershipFor(h);
  // A6000030 is a warranty deed with legal descriptions but no indexed parcel.
  assert.equal(observations.find((o) => o.normalizedName === 'TESTELEVEN KAI'), undefined);
  assert.ok(OWNERSHIP_GRADE_LINKS.has('DIRECT_PARCEL'));
  assert.ok(!OWNERSHIP_GRADE_LINKS.has('PROVISIONAL'));
});

test('the assessor owner observation stays separate evidence', async () => {
  const h = streamHarness();
  const { hennepinFixture } = await import('./helpers.ts');
  await h.run(hennepinFixture('v2-2026-08.ndjson'), { period: '2026-08' });
  await h.runRecorder(CHAIN);

  const parties = (await rowsOf(h, 'bundles')).flatMap((b) => (b['parties'] ?? []) as Row[]);
  const assessorOwners = parties.filter((p) => p['role'] === 'assessor_owner_of_record');
  assert.ok(assessorOwners.length > 0, 'the assessor roll still contributes its own observation');
  // They are separate rows with separate evidence, not merged into ownership.
  const ownership = await deriveOwnershipFor(h);
  assert.ok(!ownership.some((o) => o.normalizedName === 'TESTONE AVERY R'));
});

// --- mortgage lifecycle --------------------------------------------------------------------

test('the mortgage lifecycle is recorded, assigned and released without inventing loans', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const financing = await rowsOf(h, 'recorded_financing');
  assert.equal(financing.length, 3);

  const byState = Object.fromEntries(financing.map((f) => [f['lifecycleState'], f]));
  assert.equal(byState['recorded']?.['principalAmountMinor'], 33_000_000);
  // An assignment moves the lender's interest; it is not a new loan, so it
  // carries no principal of its own.
  assert.equal(byState['assigned']?.['principalAmountMinor'], null);
  // A satisfaction discharges the lien; the payoff amount is not recorded.
  assert.equal(byState['released']?.['principalAmountMinor'], null);
});

test('an assignment is not counted as a second mortgage', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const events = (await rowsOf(h, 'events')).map((e) => e['eventType']);
  assert.equal(events.filter((e) => e === 'MORTGAGE_RECORDED').length, 1);
  assert.equal(events.filter((e) => e === 'MORTGAGE_ASSIGNED').length, 1);
  assert.equal(events.filter((e) => e === 'MORTGAGE_RELEASED').length, 1);
});

test('a satisfaction is not evidence of a sale', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const released = (await rowsOf(h, 'events')).find((e) => e['eventType'] === 'MORTGAGE_RELEASED');
  const payload = released?.['payload'] as Row;
  assert.match(String(payload['semantics']), /payoff amount and the reason are not recorded/);
  // And no sale event exists anywhere in a recorder run.
  const types = new Set((await rowsOf(h, 'events')).map((e) => e['eventType']));
  assert.ok(!types.has('PROPERTY_SALE_OBSERVED'));
  assert.ok(!types.has('REAL_ESTATE_TRANSFER_OBSERVED'));
});

// --- events -------------------------------------------------------------------------------

test('every row yields INSTRUMENT_RECORDED, and only conveyances yield CONVEYANCE_OBSERVED', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const events = await rowsOf(h, 'events');
  assert.equal(events.filter((e) => e['eventType'] === 'INSTRUMENT_RECORDED').length, 6);
  // Two warranty deeds convey. The mortgage, assignment, satisfaction and
  // correction do not.
  assert.equal(events.filter((e) => e['eventType'] === 'CONVEYANCE_OBSERVED').length, 2);
});

test('a conveyance event states plainly that it is not a sale', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const conveyance = (await rowsOf(h, 'events')).find((e) => e['eventType'] === 'CONVEYANCE_OBSERVED');
  assert.match(String((conveyance?.['payload'] as Row)['semantics']), /sale economics come from eCRV/);
});

// --- delivery faults --------------------------------------------------------------------------

test('a changed declared field set quarantines before any row is read', async () => {
  const result = await streamHarness().runRecorder(recorderFixture('fault-field-drift.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.equal(result.run.metrics.rowsParsed, 0);
  assert.match(result.run.failureMessage ?? '', /newCountyField/);
});

test('a duplicate document number in one system quarantines those rows', async () => {
  const result = await streamHarness().runRecorder(recorderFixture('fault-duplicate-number.ndjson'));
  // The recorder numbers consecutively, so a repeat means the delivery is wrong.
  assert.ok(result.run.metrics.rowsQuarantined >= 1);
  assert.equal(result.run.duplicateCount, 1);
});

test('a short delivery is not reported as a complete window', async () => {
  const result = await streamHarness().runRecorder(recorderFixture('fault-incomplete-delivery.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.match(result.run.failureMessage ?? '', /incomplete_delivery/);
  assert.match(result.run.failureMessage ?? '', /500/);
});

test('an unrecognised document type is reported without failing the run', async () => {
  const h = streamHarness();
  const result = await h.runRecorder(EDGE);
  assert.equal(result.run.status, 'completed');
  assert.ok(result.run.unknownFields.some((f) => f.includes('SYNTHETIC NOVEL INSTRUMENT')));
  // The row is still ingested, in family OTHER, with its raw label intact.
  const novel = (await rowsOf(h, 'instruments')).find((i) => i['documentNumber'] === 'A6000020');
  assert.equal(novel?.['documentTypeNormalized'], 'OTHER');
  assert.equal(novel?.['documentTypeRaw'], 'SYNTHETIC NOVEL INSTRUMENT');
});

// --- streaming invariants ------------------------------------------------------------------------

test('batch size changes nothing', async () => {
  const digests: string[] = [];
  for (const size of [1, 50, 500, 5000]) {
    const h = streamHarness();
    const result = await h.runRecorder(CHAIN, {
      batch: { sortChunkLines: size, checkpointEveryRows: size, fetchBatchSize: size },
    });
    digests.push(`${result.run.normalizedDigest}|${result.run.artifactSha256}`);
  }
  assert.equal(new Set(digests).size, 1);
});

test('replay reproduces the estate with the network hard-disabled', async () => {
  const h = streamHarness();
  const original = await h.runRecorder(CHAIN);
  assert.ok(original.artifact);
  const before = await rowsOf(h, 'instruments');

  const replayed = await h.runRecorder(CHAIN, { replayArtifact: original.artifact });
  assert.equal(replayed.run.normalizedDigest, original.run.normalizedDigest);
  assert.equal(replayed.run.runId, original.run.runId);
  assert.deepEqual(await rowsOf(h, 'instruments'), before);
});

test('an identical second run neither duplicates nor loses instruments', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const before = await rowsOf(h, 'instruments');
  const second = await h.runRecorder(CHAIN);
  const after = await rowsOf(h, 'instruments');
  assert.equal(after.length, before.length);
  assert.deepEqual(contentDigest(after), contentDigest(before));
  assert.equal(second.run.metrics.rowsUnchanged, 6);
});

test('an interrupted recorder run leaves the previous estate intact', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const before = await rowsOf(h, 'instruments');

  const connector = createHennepinRecorderConnector({ localFile: CHAIN, referencePeriod: '2024-2025' });
  let seen = 0;
  const sabotaged = {
    ...connector,
    normalize(...args: Parameters<typeof connector.normalize>) {
      seen += 1;
      if (seen === 3) throw new Error('delivery truncated mid-canonicalisation');
      return connector.normalize(...args);
    },
  };
  const failed = await h.runRecorder(CHAIN, { connector: sabotaged as typeof connector });
  assert.equal(failed.run.status, 'failed');
  assert.deepEqual(await rowsOf(h, 'instruments'), before);
});

// --- security --------------------------------------------------------------------------------------

test('recorded party names stay canonical and unresolved, never merged', async () => {
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const parties = (await rowsOf(h, 'bundles')).flatMap((b) => (b['parties'] ?? []) as Row[]);
  assert.ok(parties.length > 0);
  for (const p of parties) {
    assert.equal(p['resolutionState'], 'unresolved');
    assert.equal(p['partyId'], null);
    assert.equal(p['kind'], 'unknown', 'the recorder does not classify person vs organisation');
  }
});

test('similar company names remain distinct observations', async () => {
  const { normalizeName } = await import('../src/canonical/models.ts');
  // Normalisation is a comparison aid, not an identity claim, and these two do
  // not even normalise alike.
  assert.notEqual(normalizeName('NORTHSTAR HOMES LLC'), normalizeName('NORTH STAR HOMES, LLC'));
  const h = streamHarness();
  await h.runRecorder(CHAIN);
  const observations = await deriveOwnershipFor(h);
  assert.ok(observations.every((o) => o.propertyId.startsWith('prop_')));
});

// ---------------------------------------------------------------------------

async function* instrumentKeys(h: ReturnType<typeof streamHarness>): AsyncGenerator<string> {
  const { canonicalJson } = await import('../src/core/hash.ts');
  for (const i of await rowsOf(h, 'instruments')) {
    yield canonicalJson({
      d: i['normalizedDocumentNumber'] ?? normalizeDocumentNumber(String(i['documentNumber'])),
      i: i['instrumentId'], c: i['countyFips'], s: i['registrationSystem'],
    });
  }
}

async function* referenceKeys(h: ReturnType<typeof streamHarness>): AsyncGenerator<string> {
  const { canonicalJson } = await import('../src/core/hash.ts');
  const instruments = new Map((await rowsOf(h, 'instruments')).map((i) => [i['instrumentId'], i] as const));
  for (const r of await rowsOf(h, 'instrument_references')) {
    const from = instruments.get(r['fromInstrumentId']);
    yield canonicalJson({
      d: r['toNormalizedDocumentNumber'], r: r['referenceId'], f: r['fromInstrumentId'],
      c: from?.['countyFips'] ?? '27053', s: r['toRegistrationSystem'],
    });
  }
}

/** Runs the ownership fold over whatever the estate currently holds. */
async function deriveOwnershipFor(
  h: ReturnType<typeof streamHarness>,
): Promise<{ normalizedName: string; propertyId: string; observedAcquiredAt: string | null; observedDisposedAt: string | null; basis: string }[]> {
  const { deriveOwnership } = await import('../src/canonical/instrument-graph.ts');
  const { canonicalJson } = await import('../src/core/hash.ts');

  const instruments = new Map((await rowsOf(h, 'instruments')).map((i) => [i['instrumentId'], i] as const));
  const links = await rowsOf(h, 'instrument_property_links');
  const parties = await rowsOf(h, 'instrument_parties');

  async function* rows(): AsyncGenerator<string> {
    for (const link of links) {
      if (link['propertyId'] === null) continue;
      const instrument = instruments.get(link['instrumentId']);
      if (!instrument) continue;
      const mine = parties.filter((p) => p['instrumentId'] === link['instrumentId']);
      yield canonicalJson({
        p: link['propertyId'], c: link['countyFips'], t: instrument['recordedAt'],
        i: instrument['instrumentId'], f: instrument['documentTypeNormalized'], l: link['linkState'],
        go: mine.filter((p) => p['normalizedRole'] === 'GRANTOR').map((p) => [p['partyObservationId'], p['normalizedName']]),
        ge: mine.filter((p) => p['normalizedRole'] === 'GRANTEE').map((p) => [p['partyObservationId'], p['normalizedName']]),
      });
    }
  }

  const out: Awaited<ReturnType<typeof deriveOwnershipFor>> = [];
  await deriveOwnership(
    rows,
    (instrumentId) => (instruments.get(instrumentId)?.['evidence'] ?? {}) as never,
    async (o) => {
      out.push({
        normalizedName: o.normalizedName, propertyId: o.propertyId,
        observedAcquiredAt: o.observedAcquiredAt, observedDisposedAt: o.observedDisposedAt, basis: o.basis,
      });
    },
  );
  return out;
}
