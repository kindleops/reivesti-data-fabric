import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isFabricError } from '../src/core/errors.ts';
import { detectAbsences, reconcile } from '../src/canonical/snapshot.ts';
import { decodeSnapshotBundle, encodeSnapshotBundle, type SnapshotBundleHeader } from '../src/runtime/arcgis.ts';
import {
  HENNEPIN_FIELD_MAP,
  HENNEPIN_ABSENT_FIELDS,
  hennepinDispositionCounts,
  hennepinMappedFields,
  hennepinOutFields,
  hennepinRestrictedFields,
} from '../src/connectors/mn-hennepin-assessor/field-map.ts';
import { parseHennepinFeature } from '../src/connectors/mn-hennepin-assessor/parse.ts';
import { createMemoryFabricStore } from '../src/runtime/fabric-store.ts';
import { harness, hennepinFixture } from './helpers.ts';

const features = (name: string): readonly Record<string, unknown>[] =>
  decodeSnapshotBundle(readFileSync(hennepinFixture(name)), name).features;

const first = (name: string): Record<string, unknown> => features(name)[0] as Record<string, unknown>;

// --- field inventory -----------------------------------------------------------

test('every published field has exactly one mapping decision', () => {
  assert.equal(HENNEPIN_FIELD_MAP.length, 122);
  assert.equal(new Set(HENNEPIN_FIELD_MAP.map((f) => f.field)).size, 122);
  const counts = hennepinDispositionCounts();
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 122);
  // HISTORIZE dominates because an assessor roll restates the same parcel every
  // month; a value written over its predecessor destroys the only interesting
  // thing about it.
  assert.ok(counts.HISTORIZE > 50);
});

test('the field map matches the fields the service actually publishes', () => {
  const published = new Set(Object.keys(first('snapshot-2026-08.ndjson')));
  const mapped = new Set(hennepinMappedFields());
  for (const field of published) assert.ok(mapped.has(field), `unmapped field in fixture: ${field}`);
});

test('personal fields are routed away from canonical output', () => {
  const restricted = hennepinRestrictedFields();
  // The taxpayer block is "name and mailing address" packed into four lines;
  // lines 2-4 and the mailing municipality are address, not name.
  assert.deepEqual([...restricted].sort(), [
    'MAILING_MUNIC_CD', 'MAILING_MUNIC_NM', 'TAXPAYER_NM_1', 'TAXPAYER_NM_2', 'TAXPAYER_NM_3',
  ]);
  assert.ok(!hennepinOutFields().includes('Shape'), 'geometry is deliberately not requested');
});

test('fields the source does not have are documented rather than silently missing', () => {
  const documented = HENNEPIN_ABSENT_FIELDS.map((f) => f.field).join(' ');
  for (const expected of ['assessmentYear', 'bedrooms', 'livingArea', 'neighborhoodCode']) {
    assert.ok(documented.includes(expected), `${expected} should be documented as absent`);
  }
  // And genuinely absent: no assessment-year column exists in the field set.
  assert.ok(!HENNEPIN_FIELD_MAP.some((f) => /ASMT_YR|ASSESS.*YEAR/i.test(f.field)));
});

test('sale fields are retained but deferred, never turned into transfers', () => {
  for (const field of ['SALE_DATE', 'SALE_PRICE', 'SALE_CODE', 'SALE_CODE_NAME']) {
    const mapping = HENNEPIN_FIELD_MAP.find((f) => f.field === field);
    assert.equal(mapping?.disposition, 'DERIVE_LATER', field);
    assert.match(mapping?.note ?? '', /eCRV|deferred|never emitted/i);
  }
});

// --- parser ---------------------------------------------------------------------

test('a valid parcel parses with county-scoped identity', () => {
  const { record, sourceRecordId } = parseHennepinFeature(first('snapshot-2026-08.ndjson'), 'f0');
  assert.equal(record.pid, '0202824410097');
  assert.equal(record.normalizedParcel, '0202824410097');
  assert.equal(record.countyFips, '27053');
  assert.equal(sourceRecordId, 'MN-27053-0202824410097');
  assert.equal(record.ownerName, 'TESTONE, AVERY R');
  assert.equal(record.yearBuilt, 1909);
  assert.equal(record.propertyStatusCode, '0');
});

test('currency is exact integer minor units, including two-decimal tax doubles', () => {
  const { record } = parseHennepinFeature(first('snapshot-2026-08.ndjson'), 'f0');
  assert.equal(record.marketValueTotalMinor, 24_130_000);
  assert.equal(record.tiers[0]?.landValueMinor, 8_800_000);
  assert.equal(record.tiers[0]?.netTaxMinor, 324_156);
  assert.equal(record.attributes['tax_total'], 324_156);
});

test('a missing PID is a parse failure: a row with no identity cannot be ingested', () => {
  assert.throws(
    () => parseHennepinFeature(first('fault-missing-pid.ndjson'), 'f0'),
    (e: unknown) => isFabricError(e, 'PARSE') && /no PID/.test((e as Error).message),
  );
});

test('a PID that does not normalise to the county shape is refused', () => {
  assert.throws(
    () => parseHennepinFeature(first('fault-malformed-pid.ndjson'), 'f0'),
    (e: unknown) => isFabricError(e, 'PARSE') && /13-digit/.test((e as Error).message),
  );
});

test('BUILD_YR of 0000 is absence, not the year zero', () => {
  const p3 = features('snapshot-2026-08.ndjson').find((f) => f['PID'] === '3011821140004');
  const { record } = parseHennepinFeature(p3 as Record<string, unknown>, 'f2');
  assert.equal(record.yearBuilt, null);
});

test('a null owner produces no party rather than an empty one', async () => {
  const source = first('snapshot-2026-08.ndjson');
  const { record } = parseHennepinFeature({ ...source, OWNER_NM: null, TAXPAYER_NM: null }, 'f0');
  assert.equal(record.ownerName, null);
  assert.equal(record.taxpayerNameLine, null);

  const h = harness();
  const bundleBytes = rewrite('snapshot-2026-08.ndjson', (f) =>
    f['PID'] === '0202824410097' ? { ...f, OWNER_NM: null, TAXPAYER_NM: null } : f);
  const result = await h.runHennepin(await writeTemp(h.root, 'no-owner.ndjson', bundleBytes));
  const bundle = result.bundles.find((b) => b.transaction.sourceRecordId === 'MN-27053-0202824410097');
  assert.deepEqual(bundle?.parties, []);
});

test('padded fixed-width strings are trimmed, and blanks become null', () => {
  const source = first('snapshot-2026-08.ndjson');
  const { record } = parseHennepinFeature({ ...source, MUNIC_NM: 'MINNEAPOLIS     ', CONDO_NO: '   ' }, 'f0');
  assert.equal(record.situs.municipality, 'MINNEAPOLIS');
  assert.equal(record.situs.condoNumber, null);
});

test('the four assessment tiers are read, and empty padding tiers are dropped', () => {
  const { record } = parseHennepinFeature(first('snapshot-2026-08.ndjson'), 'f0');
  assert.equal(record.tiers.length, 1);
  assert.equal(record.tiers[0]?.propertyTypeName, 'RESIDENTIAL');
  assert.equal(record.tiers[0]?.homesteadCode, 'H');
});

test('the taxpayer block is split into a name line and mailing lines', async () => {
  const h = harness();
  const result = await h.runHennepin(hennepinFixture('snapshot-2026-08.ndjson'));
  const bundle = result.bundles.find((b) => b.transaction.sourceRecordId === 'MN-27053-0202824410097');
  const taxpayer = bundle?.parties.find((p) => p.role === 'assessor_taxpayer');
  assert.equal(taxpayer?.rawName, 'AVERY R TESTONE');
  // The address half went to the restricted plane, not onto the party.
  assert.equal(taxpayer?.address, null);
  const mailing = h.contactPlane.read('operator').find((c) => c.partyObservationId === taxpayer?.observationId);
  assert.equal(mailing?.contactType, 'mailing_address');
  assert.match(mailing?.value ?? '', /100 SYNTHETIC AVE/);
});

// --- snapshot semantics -----------------------------------------------------------

test('a snapshot reconciles retrieved rows against the count the source reported', async () => {
  const result = await harness().runHennepin(hennepinFixture('snapshot-2026-08.ndjson'));
  assert.equal(result.run.snapshotCompleteness, 'complete');
  assert.equal(result.run.metrics.rowsParsed, 3);
  assert.equal(result.run.metrics.rowsEmitted, 3);
  assert.equal(reconcile(3, 3), 'complete');
  assert.equal(reconcile(448_087, 3), 'partial');
  assert.equal(reconcile(null, 3), 'unverifiable');
});

test('an incomplete crawl quarantines the run rather than reporting a short county', async () => {
  const result = await harness().runHennepin(hennepinFixture('fault-incomplete-crawl.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.match(result.run.failureMessage ?? '', /incomplete_crawl/);
});

test('re-ingesting the same snapshot is idempotent', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  const a = await h.runHennepin(hennepinFixture('snapshot-2026-08.ndjson'));
  const b = await harness({ root: h.root, fabricStore }).runHennepin(hennepinFixture('snapshot-2026-08.ndjson'));

  assert.equal(a.run.runId, b.run.runId);
  assert.equal(b.run.metrics.rowsUnchanged, 3);
  assert.equal(b.run.metrics.rowsEmitted, 0);
  assert.equal(a.artifact?.sha256, b.artifact?.sha256);
  assert.equal((await fabricStore.snapshots()).length, 1);
});

test('a later snapshot classifies change by kind, and says which fields moved', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  await h.runHennepin(hennepinFixture('snapshot-2026-08.ndjson'), { period: '2026-08' });
  const sept = await harness({ root: h.root, fabricStore })
    .runHennepin(hennepinFixture('snapshot-2026-09.ndjson'), { period: '2026-09' });

  assert.equal(sept.run.metrics.rowsRevised, 2); // reassessed parcel + owner change
  assert.equal(sept.run.metrics.rowsNew, 1); // a parcel appearing for the first time

  const observations = sept.bundles.flatMap((b) => b.parcelObservations ?? []);
  const reassessed = observations.find((o) => o.normalizedParcel === '0202824410097');
  assert.equal(reassessed?.changeKind, 'parcel_attributes_changed');
  assert.deepEqual(reassessed?.changedFieldGroups, ['assessment']);

  const ownerChanged = observations.find((o) => o.normalizedParcel === '1102824330051');
  assert.deepEqual(ownerChanged?.changedFieldGroups, ['owner']);
});

test('a parcel absent from the latest snapshot is recorded, never deleted', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  await h.runHennepin(hennepinFixture('snapshot-2026-08.ndjson'), { period: '2026-08' });
  const sept = await harness({ root: h.root, fabricStore })
    .runHennepin(hennepinFixture('snapshot-2026-09.ndjson'), { period: '2026-09' });

  assert.equal(sept.run.metrics.rowsMissingFromSnapshot, 1);
  const absences = await fabricStore.absences();
  assert.equal(absences.length, 1);
  assert.equal(absences[0]?.sourceRecordId, 'MN-27053-3011821140004');
  assert.equal(absences[0]?.changeKind, 'parcel_missing_from_latest_source');

  // The prior observation and its canonical rows are untouched: absence from a
  // file is not evidence that anything ceased to exist.
  const stillThere = (await fabricStore.bundles())
    .flatMap((b) => b.properties)
    .filter((p) => p.propertyId);
  assert.ok(stillThere.length >= 3);
  const resolutions = await fabricStore.resolutions();
  assert.ok(resolutions.some((r) => r.normalizedParcel === '3011821140004' && r.state === 'resolved'));
});

test('a parcel that comes back is a reappearance, not a resurrection', async () => {
  const fabricStore = createMemoryFabricStore();
  const h = harness({ fabricStore });
  await h.runHennepin(hennepinFixture('snapshot-2026-08.ndjson'), { period: '2026-08' });
  await harness({ root: h.root, fabricStore }).runHennepin(hennepinFixture('snapshot-2026-09.ndjson'), { period: '2026-09' });
  const oct = await harness({ root: h.root, fabricStore }).runHennepin(hennepinFixture('snapshot-2026-10.ndjson'), { period: '2026-10' });

  assert.equal(oct.run.metrics.rowsMissingFromSnapshot, 0);
  // Its content is byte-identical to August, so the ledger calls it unchanged
  // rather than inventing a new observation. The absence row from September
  // still stands as the record of what the September file did not contain.
  const absences = await fabricStore.absences();
  assert.equal(absences.length, 1);
  assert.equal(absences[0]?.snapshotId, (await fabricStore.snapshots()).find((s) => s.referencePeriod === '2026-09')?.snapshotId);
});

test('absence detection is a pure function of what was seen before and now', () => {
  const absences = detectAbsences({
    sourceId: 's',
    snapshotId: 'snap2',
    runId: 'r',
    observedAt: '2026-09-01T00:00:00.000Z',
    previouslySeen: new Map([['a', 'snap1'], ['b', 'snap1'], ['c', 'snap1']]),
    presentNow: new Set(['a', 'c']),
  });
  assert.deepEqual(absences.map((a) => a.sourceRecordId), ['b']);
  assert.equal(absences[0]?.lastSeenSnapshotId, 'snap1');
});

// --- drift and faults ---------------------------------------------------------------

test('a provider-side field-set change quarantines the run', async () => {
  const result = await harness().runHennepin(hennepinFixture('fault-schema-drift.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.match(result.run.failureMessage ?? '', /field_set_digest/);
  assert.equal(result.bundles.length, 0);
});

test('an unmapped field the service starts returning quarantines the run', async () => {
  const result = await harness().runHennepin(hennepinFixture('fault-unknown-field.ndjson'));
  assert.equal(result.run.status, 'quarantined');
  assert.match(result.run.failureMessage ?? '', /unknown_field/);
  assert.ok(result.run.unknownFields.includes('ASSESSOR_SECRET_SCORE'));
});

test('duplicate rows for one canonical PID are refused as ambiguous source state', async () => {
  const result = await harness().runHennepin(hennepinFixture('fault-duplicate-pid.ndjson'));
  // The layer documents stacked multi-tax parcels as having *different* PIDs, so
  // a repeat is not something to quietly deduplicate. Both rows claiming the PID
  // are quarantined: with two contradictory rows there is no basis for picking
  // one, and emitting either would be a guess.
  assert.equal(result.run.metrics.rowsQuarantined, 2);
  assert.equal(result.run.metrics.rowsEmitted, 0);
  assert.equal(result.run.status, 'quarantined');
});

test('a malformed snapshot bundle fails the run rather than yielding partial data', async () => {
  const h = harness();
  const path = await writeTemp(h.root, 'broken.ndjson', new TextEncoder().encode('{"kind":"wrong"}\n'));
  const result = await h.runHennepin(path);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failureKind, 'PARSE');
});

// --- bundle encoding ------------------------------------------------------------------

test('the snapshot bundle round-trips and is byte-stable for identical source state', () => {
  const bytes = readFileSync(hennepinFixture('snapshot-2026-08.ndjson'));
  const decoded = decodeSnapshotBundle(bytes, 'roundtrip');
  const reEncoded = encodeSnapshotBundle(decoded.header as SnapshotBundleHeader, decoded.features);
  assert.deepEqual(Buffer.from(reEncoded), Buffer.from(bytes));
});

test('the bundle header carries everything replay needs', () => {
  const { header } = decodeSnapshotBundle(readFileSync(hennepinFixture('snapshot-2026-08.ndjson')), 'h');
  for (const field of [
    'serviceUrl', 'layerId', 'objectIdField', 'outFields', 'sourceReportedCount',
    'retrievedFeatureCount', 'missingObjectIds', 'sourceSchemaDigest', 'layerMetadata', 'whereClause',
  ] as const) {
    assert.ok(field in header, `bundle header is missing ${field}`);
  }
  assert.equal(header.layerMetadata.spatialReferenceWkid, 26915);
  assert.equal(header.layerMetadata.maxRecordCount, 2000);
});

// ---------------------------------------------------------------------------

function rewrite(
  name: string,
  map: (feature: Record<string, unknown>) => Record<string, unknown>,
): Uint8Array {
  const bytes = readFileSync(hennepinFixture(name));
  const decoded = decodeSnapshotBundle(bytes, name);
  return encodeSnapshotBundle(decoded.header as SnapshotBundleHeader, decoded.features.map(map));
}

async function writeTemp(root: string, name: string, bytes: Uint8Array): Promise<string> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(root, 'tmp-fixtures');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}
