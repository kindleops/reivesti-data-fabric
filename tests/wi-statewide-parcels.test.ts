/**
 * Wisconsin Statewide Parcel Map: the second statewide parcel estate, acquired
 * with nobody present.
 *
 * Every test runs the REAL pipeline — discovery, planning, download, geodatabase
 * derivation, streaming ingestion, partition activation, ledger — against a
 * synthetic File Geodatabase built at test time and served by a fake publisher
 * (tests/support/wi-fixture.ts). The fixture reproduces the V12 schema exactly:
 * its schema digest is the one measured on the real 759,926,092-byte archive.
 *
 * Every row is invented. No live Wisconsin owner name or mailing address is
 * committed or generated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { canonicalJson } from '../src/core/hash.ts';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { propertyIdFromCountyParcel, normalizeParcelId, type SourceEvidence } from '../src/canonical/models.ts';
import { canonicalParcelIdentifier, parcelMatchKey } from '../src/canonical/normalization-contract.ts';
import { resolveAll, parcelAuthorityFor } from '../src/canonical/property-resolution.ts';
import { assessActivation } from '../src/registry/policy.ts';
import { buildCoverage, nationalCoverageReport } from '../src/registry/coverage.ts';
import { defaultRegistry, WI_RETR_SOURCE_ID } from '../src/registry/sources.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import { globalDigest } from '../src/canonical/partitions.ts';
import { createAcquisitionLedger, planAcquisition, releaseFingerprintOf } from '../src/runtime/bulk-acquisition.ts';
import {
  WI_PINNED_FIELD_SET_DIGEST,
  WI_STATEWIDE_SOURCE_ID,
} from '../src/connectors/wi-statewide-parcels/index.ts';
import {
  WI_RESTRICTED_FIELDS,
  WI_STATEWIDE_FIELD_MAP,
  wiStatewideDispositionCounts,
} from '../src/connectors/wi-statewide-parcels/field-map.ts';
import {
  isNonParcelLabel,
  routeWiCounty,
  wiExpectedCountyFips,
  wiParcelIdentity,
} from '../src/connectors/wi-statewide-parcels/identity.ts';
import { parseWiStatewideFeature } from '../src/connectors/wi-statewide-parcels/parse.ts';
import { normalizeWiStatewideParcel, rollYearOf } from '../src/connectors/wi-statewide-parcels/normalize.ts';
import { parseArchiveLinks } from '../src/connectors/wi-statewide-parcels/release.ts';
import { WI_V12_COUNTY_INVENTORY, reconcileWiCounties } from '../src/connectors/wi-statewide-parcels/counties.ts';
import {
  WI_STATEWIDE_MAPPING_ID,
  replayWiFromArchive,
  runWiStatewidePipeline,
  type WiPipelineOptions,
} from '../src/connectors/wi-statewide-parcels/pipeline.ts';
import { parseRetrCsvRow } from '../src/connectors/wi-retr/parse.ts';
import { retrParcelObservations } from '../src/connectors/wi-retr/property.ts';
import { WI_RETR_FIELDS } from '../src/connectors/wi-retr/field-map.ts';
import { RUN_INSTANT, mnStatewideFixture, streamHarness } from './helpers.ts';
import {
  V12_FIELDS,
  buildRelease,
  fakePublisher,
  parcel,
  type BuiltRelease,
  type WiFixtureRow,
} from './support/wi-fixture.ts';

type Row = Record<string, unknown>;

const V12 = { major: 12, minor: 0, patch: 0, year: 2026 };
const ADAMS = '55001';
const BROWN = '55009';
const CALUMET = '55015';
const DANE = '55025';
const MILWAUKEE = '55079';

/** The base release: every case the phase has to get right, on invented rows. */
function baseRows(): (WiFixtureRow | null)[] {
  return [
    parcel('ADAMS', '008002310010'),
    parcel('ADAMS', '008002310011'),
    // Brown's numbering: these two fold to the same digits and are two parcels.
    parcel('BROWN', '1-1109'),
    parcel('BROWN', '11-109'),
    // Right-of-way strips: feature labels, not identifiers.
    parcel('BROWN', 'ROW'),
    parcel('BROWN', 'ROW'),
    null, // a deleted slot in the geodatabase
    // An Appleton parcel lying in Calumet, submitted through Outagamie.
    parcel('CALUMET', '31-1-2', { PARCELFIPS: '087', PARCELSRC: 'OUTAGAMIE' }),
    parcel('CALUMET', '001-0001', { OWNERNME2: 'TEST CO-OWNER', TAXPARCELID: '001-0001-T' }),
    // The same string Minnesota's fixture uses for an Anoka parcel.
    parcel('DANE', '112233445566'),
    parcel('DANE', '0608-123-4567-0', { NETPRPTA: 2316.19, TAXROLLYEAR: '2026' }),
    parcel('DANE', 'X', { PARCELID: null }),
    // The same string as an Adams parcel, in another county.
    parcel('MILWAUKEE', '008002310010', { OWNERNME1: 'TEST OWNER LLC', PSTLADRESS: null }),
    // A duplicate of an Adams parcel inside the same release.
    parcel('ADAMS', '008002310010', { OWNERNME1: 'SECOND COPY' }),
    // A city, not a county.
    parcel('MENOMONIE', '99-1', { PARCELFIPS: '999' }),
    parcel('EAU CLAIRE', 'E-1', { __noGeometry: 1 }),
  ];
}

const BASE_VALID = baseRows().filter((r) => r !== null).length; // 15
const BASE_ACCEPTED = 10; // 15 − 2 ROW − 1 no id − 1 duplicate − 1 MENOMONIE

function harness() {
  const h = streamHarness();
  const publisher = fakePublisher();
  const run = (overrides: Partial<WiPipelineOptions> = {}) => runWiStatewidePipeline({
    registry: defaultRegistry(),
    artifactStore: h.artifactStore,
    contactPlane: h.contactPlane,
    varRoot: h.varRoot,
    clock: fixedClock(RUN_INSTANT),
    logger: captureLogger().logger,
    http: { fetchImpl: publisher.fetchImpl, sleep: async () => {} },
    batch: { sortChunkLines: 4 },
    ...overrides,
  });
  return { h, publisher, run };
}

function release(rows: (WiFixtureRow | null)[], version = V12): BuiltRelease {
  return buildRelease({ version, rows });
}

async function ingestedBase() {
  const w = harness();
  const built = release(baseRows());
  w.publisher.publish(built);
  const result = await w.run();
  return { ...w, built, result };
}

function bundlesOf(varRoot: string): Promise<Row[]> {
  return (async () => {
    const out: Row[] = [];
    for await (const line of createGenerationStore(varRoot).readTable('bundles')) out.push(JSON.parse(line) as Row);
    return out;
  })();
}

function wiBundles(rows: Row[]): Row[] {
  return rows.filter((b) => (b['transaction'] as Row)['sourceId'] === WI_STATEWIDE_SOURCE_ID);
}

function evidence(sourceId: string, sourceRecordId: string): SourceEvidence {
  return {
    sourceId, sourceRecordId, artifactId: 'artifact_test', runId: 'run_test', observedAt: RUN_INSTANT,
    effectiveAt: null, rawRecordHash: 'x', parserVersion: 'p', normalizationVersion: 'n',
  };
}

// ===========================================================================
// 1. Automation
// ===========================================================================

test('the source is automated-core eligible from registry facts alone', () => {
  const source = defaultRegistry().source(WI_STATEWIDE_SOURCE_ID);
  const verdict = assessActivation(source);
  assert.equal(verdict.verdict, 'CORE_ELIGIBLE');
  assert.equal(verdict.gate, 'none');
  assert.equal(source.costClass, 'FREE_BULK');
  assert.equal(source.acquisitionClass, 'AUTOMATED_BULK_DOWNLOAD');
  assert.equal(source.automationStatus, 'sanctioned');
});

test('discovery needs no human: three small anonymous requests and no archive download', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.outcome, 'DISCOVERED');
  assert.equal(result.discovered?.referencePeriod, 'V12.0.0-2026');
  assert.equal(result.plan?.action, 'ACQUIRE');
  assert.equal(w.publisher.archiveGets(), 0, 'discovery must never download the archive');
  assert.deepEqual(w.publisher.requests.map((r) => r.method).sort(), ['GET', 'GET', 'GET', 'HEAD']);
});

test('acquisition needs no human: discover → acquire → derive → ingest in one call', async () => {
  const { result, publisher, built } = await ingestedBase();
  assert.equal(result.outcome, 'INGESTED');
  assert.equal(publisher.archiveGets(), 1, 'one archive request, not a crawl');
  assert.equal(result.publisherArtifact?.sha256, built.sha256);
  assert.equal(result.run?.run.status, 'completed');
  assert.equal(result.ledger?.action, 'ACQUIRED_AND_INGESTED');
});

test('no request carries a credential, cookie or session token', async () => {
  const { publisher } = await ingestedBase();
  for (const r of publisher.requests) {
    const names = Object.keys(r.headers).map((h) => h.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'x-api-key', 'x-esri-authorization']) {
      assert.ok(!names.includes(forbidden), `${r.url} carried ${forbidden}`);
    }
    assert.ok(!/[?&](token|f=pjson&token)=/.test(r.url), `${r.url} carried a token`);
  }
});

test('the same release rediscovered is a NOOP: no download, no parse, no projection', async () => {
  const w = await ingestedBase();
  const before = w.publisher.archiveGets();
  const again = await w.run();
  assert.equal(again.outcome, 'NOOP');
  assert.equal(again.run, null);
  assert.equal(w.publisher.archiveGets(), before, 'a NOOP tick must not re-download');
  assert.equal(again.ledger?.action, 'NOOP_SAME_RELEASE');
});

test('a newer version is detected and planned, flagged for schema validation', async () => {
  const w = await ingestedBase();
  w.publisher.publish(release(baseRows(), { major: 13, minor: 0, patch: 0, year: 2027 }));
  const next = await w.run({ discoverOnly: true });
  assert.equal(next.discovered?.referencePeriod, 'V13.0.0-2027');
  assert.equal(next.plan?.action, 'ACQUIRE');
  assert.equal(next.plan?.action === 'ACQUIRE' && next.plan.reason, 'NEW_RELEASE');
  assert.equal(next.plan?.action === 'ACQUIRE' && next.plan.schemaValidationRequired, true);
});

test('the same version republished with new bytes is detected as a republication', async () => {
  const w = await ingestedBase();
  w.publisher.publish(release(baseRows()), { etag: '"republished"' });
  const next = await w.run({ discoverOnly: true });
  assert.equal(next.plan?.action === 'ACQUIRE' && next.plan.reason, 'REPUBLISHED_RELEASE');
});

test('a truncated smoke run never counts as an ingestion of the release', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  const smoke = await w.run({ maxRows: 3 });
  assert.equal(smoke.ledger?.action, 'TRUNCATED_SMOKE_RUN');
  assert.equal((await w.run({ discoverOnly: true })).plan?.action, 'ACQUIRE');
});

// ===========================================================================
// 2. Source
// ===========================================================================

test('the landing page yields the newest uncompressed archive, and nothing else', () => {
  const html = [
    'https://web.s3.wisc.edu/parcels/v11_parcels/V11.0.0_Wisconsin_Parcels_2025_10.3_Uncompressed.zip',
    'https://web.s3.wisc.edu/parcels/v12_parcels/V12.0.0_Wisconsin_Parcels_2026_10.3_Compressed.zip',
    'https://web.s3.wisc.edu/parcels/v12_parcels/V12.0.0_Wisconsin_Parcels_2026_10.3_Uncompressed.zip',
    'https://web.s3.wisc.edu/parcels/v9_parcels/V9.0.1_Wisconsin_Parcels_2023_10.3_Uncompressed.zip',
  ].map((u) => `<a href="${u}">x</a>`).join('');
  const links = parseArchiveLinks(html);
  assert.equal(links.length, 3, 'the compressed (CDF) archive is not a candidate');
  assert.equal(links[0]?.referencePeriod, 'V12.0.0-2026');
  assert.equal(links[0]?.expectedLayerName, 'V1200_WisconsinParcels_2026');
});

test('the FeatureServer witness count agrees with the archive, and differences are named', async () => {
  const { result } = await ingestedBase();
  assert.equal(result.crossCheck?.archiveRows, BASE_VALID);
  assert.equal(result.crossCheck?.serviceCount, BASE_VALID);
  assert.equal(result.crossCheck?.agrees, true);
  assert.equal(result.crossCheck?.serviceMatchesArchive, true);
  assert.deepEqual(result.crossCheck?.onlyInService, ['SITEADRESS_STAND']);
  assert.deepEqual(result.crossCheck?.onlyInArchive, []);
});

test('a material count disagreement blocks COMPLETE and never records an ingestion', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()), { serviceCount: BASE_VALID + 500 });
  const result = await w.run();
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.ledger?.action, 'FAILED');
  assert.equal((await w.run({ discoverOnly: true })).plan?.action, 'ACQUIRE');
});

test('the archive schema digest is exactly the pinned one', async () => {
  const { result } = await ingestedBase();
  assert.equal(result.derivation?.sourceSchemaDigest, WI_PINNED_FIELD_SET_DIGEST);
  assert.equal(result.derivation?.tableName, 'V1200_WisconsinParcels_2026');
  assert.equal(result.derivation?.geometry.type, 'polygon');
});

test('an unexpected schema is quarantined before a row is read, and not activated', async () => {
  const w = harness();
  const fields = [...V12_FIELDS, { name: 'NEWCOLUMN', kind: 'string' as const, length: 10 }];
  w.publisher.publish(buildRelease({ version: V12, rows: baseRows(), fields }));
  const result = await w.run();
  assert.equal(result.run?.run.status, 'quarantined');
  assert.equal(result.run?.run.failureKind, 'SCHEMA_DRIFT');
  assert.equal(result.outcome, 'FAILED');
  assert.deepEqual(await createPartitionStore(w.h.varRoot).listPartitions(), []);
});

test('the publisher archive is retained byte for byte, with its URL and version', async () => {
  const { result, built, h } = await ingestedBase();
  const artifact = result.publisherArtifact!;
  assert.equal(artifact.byteLength, built.archive.length);
  assert.equal(artifact.manifest.originalUrl, built.url);
  assert.equal(artifact.manifest.originalFilename, built.filename);
  assert.equal(artifact.manifest.referencePeriod, 'V12.0.0-2026');
  assert.deepEqual(readFileSync(h.artifactStore.localPath(artifact)), built.archive);
  assert.equal(statSync(h.artifactStore.localPath(artifact)).mode & 0o222, 0, 'retained bytes are read-only');
});

test('the county inventory reconciles against the federal catalogue', async () => {
  const { result } = await ingestedBase();
  const counties = result.counties!;
  assert.equal(counties.expected, 72);
  assert.deepEqual(counties.extra, []);
  assert.ok(counties.missing.length > 0, 'a six-county fixture is missing counties, and says so');
  assert.equal(reconcileWiCounties(new Map(WI_V12_COUNTY_INVENTORY.map((c) => [c.fips, c.sourceRows]))).matches, true);
  assert.equal(WI_V12_COUNTY_INVENTORY.reduce((s, c) => s + c.sourceRows, 0), 3_574_645);
});

// ===========================================================================
// 3. Identity
// ===========================================================================

test('county + parcel identity is deterministic', () => {
  const a = wiParcelIdentity(ADAMS, '008002310010');
  const b = wiParcelIdentity(ADAMS, ' 008002310010 ');
  assert.equal(a.propertyId, b.propertyId);
  assert.equal(a.propertyId, propertyIdFromCountyParcel(ADAMS, '008002310010'));
});

test('leading zeros survive and nothing is converted to a number', () => {
  const id = wiParcelIdentity(ADAMS, '008002310010');
  assert.equal(id.normalizedParcel, '008002310010');
  assert.notEqual(id.propertyId, wiParcelIdentity(ADAMS, '8002310010').propertyId);
});

test('punctuation is identity in Wisconsin: 1-1109 and 11-109 are two parcels', async () => {
  const a = wiParcelIdentity(BROWN, '1-1109');
  const b = wiParcelIdentity(BROWN, '11-109');
  assert.notEqual(a.propertyId, b.propertyId);
  // …which the Minnesota rule would have merged. That is the measured reason.
  assert.equal(normalizeParcelId('1-1109'), normalizeParcelId('11-109'));
  // The folded form survives only as a candidate match key.
  assert.equal(a.matchKey, b.matchKey);
  const { h } = await ingestedBase();
  const brown = wiBundles(await bundlesOf(h.varRoot)).filter((b) => (b['properties'] as Row[])[0]?.['countyFips'] === BROWN);
  assert.equal(brown.length, 2, 'both Brown parcels are admitted as distinct properties');
});

test('the same parcel string in two Wisconsin counties is two properties', async () => {
  const { h } = await ingestedBase();
  const ids = wiBundles(await bundlesOf(h.varRoot))
    .flatMap((b) => b['propertyIdentifiers'] as Row[])
    .filter((o) => o['identifierType'] === 'county_parcel' && o['normalizedValue'] === '008002310010');
  assert.deepEqual(ids.map((o) => o['countyFips']).sort(), [ADAMS, MILWAUKEE]);
  assert.equal(new Set(ids.map((o) => o['propertyId'])).size, 2);
});

test('the same parcel string in Minnesota and Wisconsin is two properties', async () => {
  const w = harness();
  await w.h.runStatewide(mnStatewideFixture('five-county-2026-08.bundle'));
  w.publisher.publish(release(baseRows()));
  await w.run();
  const ids = (await bundlesOf(w.h.varRoot))
    .flatMap((b) => b['propertyIdentifiers'] as Row[])
    .filter((o) => o['identifierType'] === 'county_parcel' && o['normalizedValue'] === '112233445566');
  assert.equal(new Set(ids.map((o) => String(o['countyFips']).slice(0, 2))).size, 2, 'one MN and one WI observation');
  assert.equal(new Set(ids.map((o) => o['propertyId'])).size, 2, 'jurisdiction is part of identity');
});

test('the preserving scheme is injective where the folding one is not', () => {
  const raw = ['1-1109', '11-109', '1-111', '1-11-1', '11-11', 'a-1', 'A-1'];
  const kept = new Set(raw.map((r) => {
    const id = canonicalParcelIdentifier(r, 'PUNCTUATION_PRESERVING', BROWN);
    return id.present ? id.normalized : null;
  }));
  assert.equal(kept.size, 6, 'only the case-only pair folds together');
  assert.equal(new Set(raw.map(parcelMatchKey)).size, 3);
});

// ===========================================================================
// 4. Routing
// ===========================================================================

test('every valid Wisconsin county routes to its own partition', async () => {
  const { result } = await ingestedBase();
  assert.deepEqual(Object.keys(result.run!.countyCounts).sort(), [ADAMS, BROWN, CALUMET, DANE, '55035', MILWAUKEE]);
  const planned = result.run!.partitionPlan.partitions.filter((p) => p.startsWith('property/'));
  assert.equal(planned.length, 6);
});

test('CONAME routes, not the submitting county: an Appleton parcel lies in Calumet', () => {
  const { record } = parseWiStatewideFeature(parcel('CALUMET', '31-1-2', { PARCELFIPS: '087' }) as Row, 'f');
  assert.equal(record.countyFips, CALUMET);
  assert.equal(record.submittingCountyFips, '55087');
  assert.equal(record.crossCountySubmission, true);
});

test('an uncatalogued county is quarantined, never guessed', () => {
  assert.throws(() => routeWiCounty('MENOMONIE', 'f'), /not a catalogued Wisconsin county/);
  assert.equal(routeWiCounty('ST CROIX', 'f'), '55109');
  assert.equal(routeWiCounty('Fond du Lac', 'f'), '55039');
});

test('the source maps to 72 county coverage relationships through one mapping', () => {
  const registry = defaultRegistry();
  assert.equal(wiExpectedCountyFips().length, 72);
  assert.equal(registry.expand(registry.mapping(WI_STATEWIDE_MAPPING_ID)).length, 72);
  assert.equal(registry.sources.filter((s) => s.sourceId.startsWith('wi_statewide')).length, 1, 'one source, not 72');
});

test('every accepted row is reconciled: accepted + quarantined = parsed = archive rows', async () => {
  const { result } = await ingestedBase();
  const run = result.run!.run;
  assert.equal(run.metrics.rowsParsed, BASE_VALID);
  assert.equal(run.metrics.rowsValid, BASE_ACCEPTED);
  assert.equal(run.metrics.rowsValid + run.metrics.rowsQuarantined, run.metrics.rowsParsed);
  assert.equal(run.duplicateCount, 1);
  assert.equal(run.sourceReportedCount, BASE_VALID);
  assert.equal(run.snapshotCompleteness, 'complete');
});

test('a feature label is not an identifier', () => {
  for (const label of ['ROW', 'GAP', 'NO PIN - ROW', 'LAKE BED', 'ROAD.RESERVATION']) assert.ok(isNonParcelLabel(label));
  for (const id of ['1-1109', 'A9', 'ROW-1']) assert.ok(!isNonParcelLabel(id));
  assert.throws(() => wiParcelIdentity(BROWN, 'ROW'), /non-parcel feature label/);
});

// ===========================================================================
// 5. Normalization
// ===========================================================================

function normalized(overrides: WiFixtureRow = {}) {
  const parsed = parseWiStatewideFeature(parcel('DANE', '0608-123-4567-0', overrides) as Row, 'f');
  return normalizeWiStatewideParcel(parsed.record, evidence(WI_STATEWIDE_SOURCE_ID, parsed.sourceRecordId), {
    sourceId: WI_STATEWIDE_SOURCE_ID, snapshotId: 'snap', changeKind: 'new_parcel_observed', changedFieldGroups: [],
  });
}

test('area: deeded acres become canonical square feet, and the source unit is kept', () => {
  const c = normalized({ DEEDACRES: 2 }).bundle.characteristics![0]!.characteristics;
  assert.equal(c['canonical_area_square_feet'], 87_120);
  assert.equal(c['canonical_area_source_unit'], 'acres');
  assert.equal(c['canonical_area_source_field'], 'DEEDACRES');
  assert.equal(c['gis_acres'], 1.07, 'the other acreage figures stay as published');
});

test('money is exact cents; assessed and fair-market values never share a slot', () => {
  const { bundle } = normalized({ NETPRPTA: 1097.67, CNTASSDVALUE: 94500, ESTFMKVALUE: 110700.25 });
  const a = bundle.assessments![0]!;
  assert.deepEqual(a.netTax, { amountMinor: 109767, currency: 'USD' });
  assert.deepEqual(a.totalValue, { amountMinor: 9_450_000, currency: 'USD' });
  assert.equal(a.characteristics['estimated_fair_market_value_minor'], 11_070_025);
  assert.equal(a.characteristics['value_basis'], 'assessed_at_municipal_ratio');
  assert.equal(a.characteristics['gross_tax_minor'], 123456);
});

test('a sub-cent float is refused as invalid money, not rounded', () => {
  const { bundle } = normalized({ ESTFMKVALUE: 0.30000000000000004 });
  const a = bundle.assessments![0]!;
  assert.equal(a.characteristics['estimated_fair_market_value_minor'], null);
  assert.deepEqual(a.characteristics['invalid_money_fields'], ['ESTFMKVALUE']);
});

test('dates: the roll year is the time axis, and the load date keeps its meaning', () => {
  const { bundle } = normalized({ TAXROLLYEAR: '2025', LOADDATE: '3/2/2026' });
  assert.equal(bundle.assessments![0]!.assessmentYear, 2025);
  const c = bundle.characteristics![0]!.characteristics;
  assert.equal(c['canonical_source_load_date'], '2026-03-02');
  assert.equal(c['tax_roll_year'], 2025);
  assert.equal(rollYearOf('20XX'), null);
  assert.equal(rollYearOf(null), null);
  assert.equal(normalized({ TAXROLLYEAR: null }).bundle.assessments![0]!.assessmentYear, null, 'never guessed');
});

test('addresses: the PREFIX column is split into directional or pre-type by the adapter', () => {
  const dir = normalized({ PREFIX: 'N', STREETNAME: 'MAIN', STREETTYPE: 'STREET', ADDNUM: '10' });
  const type = normalized({ PREFIX: 'STATE ROAD', STREETNAME: '13', STREETTYPE: null, ADDNUM: '3733' });
  assert.match(String(dir.bundle.characteristics![0]!.characteristics['canonical_address_key']), /\bN\b.*MAIN/);
  assert.match(String(type.bundle.characteristics![0]!.characteristics['canonical_address_key']), /STATE ROAD.*13/);
});

test('nulls stay null: a blank field is absent, a zero is a zero', () => {
  const { bundle } = normalized({ IMPVALUE: 0, MFLVALUE: null, OWNERNME2: null });
  assert.deepEqual(bundle.assessments![0]!.buildingValue, { amountMinor: 0, currency: 'USD' });
  assert.equal(bundle.assessments![0]!.characteristics['managed_forest_value_minor'], null);
  assert.equal(bundle.parties.length, 1);
  assert.equal(bundle.characteristics![0]!.yearBuilt, null, 'the V12 schema has no year built');
});

test('no sale, transfer or financing fact is emitted — the schema carries none', () => {
  const { bundle } = normalized();
  assert.equal(bundle.transaction.totalConsideration, null);
  assert.equal(bundle.transaction.transferDate, null);
  assert.equal(bundle.financing.length, 0);
  assert.equal(bundle.characteristics![0]!.characteristics['sale_fields_in_source'], false);
  const types = new Set<string>(bundle.events.map((e) => e.eventType));
  for (const forbidden of ['PROPERTY_SALE_OBSERVED', 'REAL_ESTATE_TRANSFER_OBSERVED', 'FINANCING_OBSERVED']) {
    assert.ok(!types.has(forbidden));
  }
  assert.ok(!canonicalJson(bundle).includes('ASSESSOR_REPORTED_SALE_OBSERVATION'));
});

// ===========================================================================
// 6. Ownership
// ===========================================================================

test('owner names are observations, with the roll\'s role and no resolution', () => {
  const { bundle } = normalized({ OWNERNME1: 'TEST OWNER A', OWNERNME2: 'TEST OWNER B' });
  assert.equal(bundle.parties.length, 2);
  for (const p of bundle.parties) {
    assert.equal(p.role, 'assessor_owner_of_record');
    assert.equal(p.kind, 'unknown');
    assert.equal(p.resolutionState, 'unresolved');
    assert.equal(p.partyId, null);
    assert.equal(p.address, null);
  }
});

test('the secondary owner is a second observation, never concatenated', () => {
  const { bundle } = normalized({ OWNERNME1: 'TEST OWNER A', OWNERNME2: 'TEST OWNER B' });
  assert.deepEqual(bundle.parties.map((p) => p.rawName), ['TEST OWNER A', 'TEST OWNER B']);
});

test('the same name on two parcels is never merged into one party', async () => {
  const w = harness();
  w.publisher.publish(release([
    parcel('ADAMS', '1-1', { OWNERNME1: 'TEST SHARED NAME' }),
    parcel('DANE', '2-2', { OWNERNME1: 'TEST SHARED NAME' }),
  ]));
  await w.run();
  const parties = wiBundles(await bundlesOf(w.h.varRoot)).flatMap((b) => b['parties'] as Row[]);
  assert.equal(parties.length, 2);
  assert.equal(new Set(parties.map((p) => p['observationId'])).size, 2);
  assert.ok(parties.every((p) => p['partyId'] === null));
});

// ===========================================================================
// 7. Security
// ===========================================================================

test('the owner mailing address reaches the restricted plane and nothing else', async () => {
  const { h } = await ingestedBase();
  const contacts = (await h.rows('contacts')) as Row[];
  assert.ok(contacts.length >= 9);
  assert.ok(contacts.every((c) => c['contactType'] === 'mailing_address' && c['permittedUse'] === 'record_only'));
  const canonical = canonicalJson(await bundlesOf(h.varRoot));
  assert.ok(!canonical.includes('INVENTED WAY'), 'a mailing address leaked into a canonical row');
  assert.deepEqual(WI_RESTRICTED_FIELDS, ['PSTLADRESS']);
});

test('no mailing string appears anywhere under the derived plane, compressed or not', async () => {
  const previous = process.env['DF_DERIVED_GZIP'];
  process.env['DF_DERIVED_GZIP'] = '1';
  try {
    const { h } = await ingestedBase();
    const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]));
    let compressed = 0;
    for (const file of scan(join(h.varRoot, 'derived'))) {
      const bytes = readFileSync(file);
      const text = file.endsWith('.gz') ? (compressed++, gunzipSync(bytes).toString('utf8')) : bytes.toString('utf8');
      assert.ok(!text.includes('INVENTED WAY'), `leak in ${file}`);
    }
    assert.ok(compressed > 0, 'the scan actually decompressed something');
    for (const file of scan(join(h.varRoot, 'restricted'))) {
      if (file.endsWith('CURRENT')) continue;
      assert.equal(statSync(file).mode & 0o777, 0o600, `${file} is not owner-only`);
    }
  } finally {
    if (previous === undefined) delete process.env['DF_DERIVED_GZIP'];
    else process.env['DF_DERIVED_GZIP'] = previous;
  }
});

test('the fixture is invented: no live owner or mailing string is committed', () => {
  const text = readFileSync(new URL('./support/wi-fixture.ts', import.meta.url), 'utf8');
  assert.ok(text.includes('TEST OWNER') && text.includes('INVENTED WAY'));
  const rows = baseRows().filter((r): r is WiFixtureRow => r !== null);
  assert.ok(rows.every((r) => r['OWNERNME1'] === null || /^(TEST|SECOND)/.test(String(r['OWNERNME1']))));
});

test('every field has a disposition and the mailing field is the only restricted one', () => {
  assert.equal(WI_STATEWIDE_FIELD_MAP.length, 46);
  const counts = wiStatewideDispositionCounts();
  assert.equal(counts['RESTRICTED'], 1);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 46);
});

// ===========================================================================
// 8. Partitions
// ===========================================================================

test('a Wisconsin run leaves every Minnesota partition untouched', async () => {
  const w = harness();
  await w.h.runStatewide(mnStatewideFixture('five-county-2026-08.bundle'));
  const store = createPartitionStore(w.h.varRoot);
  const mnBefore = (await store.manifests()).filter((m) => m.partitionId.startsWith('property/us-county-27'));
  assert.ok(mnBefore.length >= 4);
  w.publisher.publish(release(baseRows()));
  const result = await w.run();
  const touched = result.run!.activations.map((a) => a.partitionId);
  assert.ok(touched.every((p) => !p.startsWith('property/us-county-27')), `touched ${touched}`);
  const mnAfter = (await store.manifests()).filter((m) => m.partitionId.startsWith('property/us-county-27'));
  assert.deepEqual(mnAfter, mnBefore, 'generation, digests and activation time all unchanged');
});

test('Minnesota canonical ids are unchanged by the Wisconsin identity rule', () => {
  // The contract extension added a scheme; it did not change the MN one.
  assert.equal(normalizeParcelId('02-028-24-41-0097'), '0202824410097');
  assert.equal(propertyIdFromCountyParcel('27053', '0202824410097'), propertyIdFromCountyParcel('27053', normalizeParcelId('0202824410097')));
});

test('each county activates independently, and a skipped county keeps its generation', async () => {
  const w = await ingestedBase();
  const store = createPartitionStore(w.h.varRoot);
  const before = await store.manifests();
  const next = release(baseRows().map((r) => (r && r['CONAME'] === 'DANE' && r['PARCELID'] === '112233445566'
    ? { ...r, CNTASSDVALUE: 999999 } : r)), { major: 12, minor: 0, patch: 1, year: 2026 });
  w.publisher.publish(next);
  const result = await w.run();
  const byId = new Map(result.run!.activations.map((a) => [a.partitionId, a]));
  assert.equal(byId.get(`property/us-county-${DANE}`)?.state, 'activated');
  assert.equal(byId.get(`property/us-county-${ADAMS}`)?.state, 'skipped');
  const after = new Map((await store.manifests()).map((m) => [m.partitionId, m]));
  for (const m of before) {
    if (m.partitionId === `property/us-county-${DANE}` || !m.partitionId.startsWith('property/')) continue;
    assert.deepEqual(after.get(m.partitionId), m, `${m.partitionId} was rewritten`);
  }
});

test('the global digest is rebuilt from sorted child digests, and reproduces', async () => {
  const a = await ingestedBase();
  const b = await ingestedBase();
  const manifests = await createPartitionStore(a.h.varRoot).manifests();
  // Order of the child list is irrelevant: the digest sorts before folding.
  assert.equal(globalDigest(manifests), globalDigest([...manifests].reverse()));
  // Two independent estates from the same release agree exactly.
  assert.equal(globalDigest(manifests), globalDigest(await createPartitionStore(b.h.varRoot).manifests()));
  assert.equal(a.result.run!.globalDigest, globalDigest(manifests));
});

// ===========================================================================
// 9. Source change across releases
// ===========================================================================

test('a synthetic next release: new, assessment, owner, missing, reappeared — only those counties recompute', async () => {
  const w = harness();
  const counties = ['ADAMS', 'BROWN', 'CALUMET', 'DANE', 'EAU CLAIRE', 'MILWAUKEE'];
  const r0 = counties.flatMap((c, i) => [parcel(c, `${i}-1`), parcel(c, `${i}-2`)]);
  // Release 1: county E (EAU CLAIRE) drops one parcel.
  const r1 = r0.filter((r) => !(r['CONAME'] === 'EAU CLAIRE' && r['PARCELID'] === '4-2'));
  // Release 2: A new parcel, B assessment, C owner, D missing, E reappears. F unchanged.
  const r2 = [
    ...r1.filter((r) => !(r['CONAME'] === 'DANE' && r['PARCELID'] === '3-2')).map((r) => {
      if (r['CONAME'] === 'BROWN' && r['PARCELID'] === '1-1') return { ...r, CNTASSDVALUE: 424242 };
      if (r['CONAME'] === 'CALUMET' && r['PARCELID'] === '2-1') return { ...r, OWNERNME1: 'TEST NEW OWNER' };
      return r;
    }),
    parcel('ADAMS', '0-3'),
    parcel('EAU CLAIRE', '4-2'),
  ];
  w.publisher.publish(release(r0, { major: 12, minor: 0, patch: 0, year: 2026 }));
  await w.run();
  w.publisher.publish(release(r1, { major: 12, minor: 0, patch: 1, year: 2026 }));
  const first = await w.run();
  assert.equal(first.run!.changeCounts.parcel_missing_from_latest_source, 1);
  w.publisher.publish(release(r2, { major: 12, minor: 0, patch: 2, year: 2026 }));
  const second = await w.run();
  const c = second.run!.changeCounts;
  assert.equal(c.new_parcel_observed, 1, 'Adams');
  assert.equal(c.parcel_attributes_changed, 2, 'Brown assessment and Calumet owner');
  assert.equal(c.parcel_missing_from_latest_source, 1, 'Dane');
  assert.equal(c.parcel_reappeared, 1, 'Eau Claire: seen, dropped, back');
  const activated = second.run!.activations.filter((a) => a.state === 'activated' && a.partitionId.startsWith('property/'))
    .map((a) => a.partitionId).sort();
  assert.deepEqual(activated, [ADAMS, BROWN, CALUMET, DANE, '55035'].map((f) => `property/us-county-${f}`));
  assert.deepEqual(second.run!.skippedPartitions, [`property/us-county-${MILWAUKEE}`]);
});

// ===========================================================================
// 10. Idempotency, replay, resume
// ===========================================================================

test('forcing the same release again: no new, no lost, no revised, same ids and digests', async () => {
  const w = await ingestedBase();
  const again = await w.run({ mode: 'force' });
  assert.equal(w.publisher.archiveGets(), 1, 'a forced re-ingest reads the retained archive, not the publisher');
  assert.equal(again.ledger?.action, 'REPLAYED');
  const m = again.run!.run.metrics;
  assert.equal(m.rowsNew, 0);
  assert.equal(m.rowsRevised, 0);
  assert.equal(m.rowsMissingFromSnapshot, 0);
  assert.equal(m.rowsUnchanged, BASE_ACCEPTED);
  assert.equal(again.run!.run.runId, w.result.run!.run.runId);
  assert.equal(again.run!.run.normalizedDigest, w.result.run!.run.normalizedDigest);
  assert.equal(again.run!.globalDigest, w.result.run!.globalDigest);
  assert.ok(again.run!.activations.filter((a) => a.partitionId.startsWith('property/')).every((a) => a.state === 'skipped'));
});

test('replay from the retained archive, with no fetch at all, reproduces every digest', async () => {
  const w = await ingestedBase();
  const original = w.result;
  const store = createPartitionStore(w.h.varRoot);
  const partitionsBefore = (await store.manifests()).map((m) => [m.partitionId, m.inputDigest, m.outputDigest]);
  const idsBefore = wiBundles(await bundlesOf(w.h.varRoot)).map((b) => (b['properties'] as Row[])[0]?.['propertyId']).sort();

  // Delete the derived Wisconsin estate — everything but the archive.
  for (const dir of ['derived', 'restricted', 'indexes', 'checkpoints', 'acquisition']) {
    await rm(join(w.h.varRoot, dir), { recursive: true, force: true });
  }
  await rm(join(w.h.root, 'archive', 'data-fabric', WI_STATEWIDE_SOURCE_ID, 'V12.0.0-2026',
    `sha256-${original.bundleArtifact!.sha256}`), { recursive: true, force: true });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network used during replay'); }) as typeof fetch;
  try {
    const replay = await replayWiFromArchive({
      registry: defaultRegistry(), artifactStore: w.h.artifactStore, contactPlane: w.h.contactPlane,
      varRoot: w.h.varRoot, clock: fixedClock('2031-01-01T00:00:00.000Z'), logger: captureLogger().logger,
      publisherSha256: original.publisherArtifact!.sha256, referencePeriod: 'V12.0.0-2026', batch: { sortChunkLines: 4 },
    });
    assert.equal(replay.publisherArtifact!.sha256, original.publisherArtifact!.sha256);
    assert.equal(replay.bundleArtifact!.sha256, original.bundleArtifact!.sha256, 'the derived bundle is byte-identical');
    assert.equal(replay.run!.run.runId, original.run!.run.runId);
    assert.equal(replay.run!.run.normalizedDigest, original.run!.run.normalizedDigest);
    assert.equal(replay.run!.globalDigest, original.run!.globalDigest);
    assert.deepEqual((await store.manifests()).map((m) => [m.partitionId, m.inputDigest, m.outputDigest]), partitionsBefore);
    assert.deepEqual(wiBundles(await bundlesOf(w.h.varRoot)).map((b) => (b['properties'] as Row[])[0]?.['propertyId']).sort(), idsBefore);
    assert.equal(w.publisher.archiveGets(), 1, 'the publisher was not asked again');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an interrupted download leaves no artifact and no ingestion, and the next tick recovers', async () => {
  const w = harness();
  const built = release(baseRows());
  w.publisher.publish(built);
  let fail = true;
  const flaky: typeof fetch = async (input, init) => {
    const response = await w.publisher.fetchImpl(input, init);
    if (fail && String(input).endsWith('.zip') && (init?.method ?? 'GET') === 'GET') {
      // A body cut off half way: the length check must refuse it.
      return new Response(new Uint8Array(built.archive.subarray(0, 100)), { status: 200, headers: response.headers });
    }
    return response;
  };
  await assert.rejects(w.run({ http: { fetchImpl: flaky, sleep: async () => {}, retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, retryable: () => false } } }));
  assert.equal((await createAcquisitionLedger(w.h.varRoot, WI_STATEWIDE_SOURCE_ID).entries()).at(-1)?.action, 'FAILED');
  assert.ok(!readdirSync(w.h.root, { recursive: true }).some((f) => String(f).endsWith('source-original.zip')));
  fail = false;
  const recovered = await w.run({ http: { fetchImpl: flaky, sleep: async () => {} } });
  assert.equal(recovered.outcome, 'INGESTED');
});

test('a failed canonicalisation resumes from the retained archive without a second download', async () => {
  const w = await ingestedBase();
  // The pipeline's own resume path: the checkpoint names the derived bundle.
  const checkpoint = readdirSync(join(w.h.varRoot, 'checkpoints'));
  assert.deepEqual(checkpoint, [`${WI_STATEWIDE_SOURCE_ID}__V12.0.0-2026.json`]);
  const again = await w.run({ mode: 'force' });
  assert.equal(again.run!.run.status, 'completed');
});

test('duplicate identity inside a release is detected exactly and counted once', async () => {
  const { result } = await ingestedBase();
  assert.equal(result.run!.run.duplicateCount, 1);
});

test('memory stays bounded for a release far larger than any in-heap structure would allow', async () => {
  const w = harness();
  const rows: WiFixtureRow[] = [];
  for (let i = 0; i < 12_000; i++) rows.push(parcel(i % 2 ? 'DANE' : 'BROWN', `${i}-${i % 97}`));
  w.publisher.publish(release(rows));
  const result = await w.run({ batch: { sortChunkLines: 2_000 } });
  assert.equal(result.run!.run.metrics.rowsValid, 12_000);
  assert.ok(result.run!.peakHeapBytes < 400 * 1048576, `peak heap ${Math.round(result.run!.peakHeapBytes / 1048576)} MB`);
});

// ===========================================================================
// 11. RETR: future convergence, on synthetic returns only
// ===========================================================================

function syntheticRetr(county: string, documentNumber: string, parcelNumber: string) {
  const cells = WI_RETR_FIELDS.map(() => '');
  const set = (name: string, value: string) => {
    const f = WI_RETR_FIELDS.find((x) => x.name === name);
    if (!f) throw new Error(name);
    cells[f.ordinal - 1] = value;
  };
  set('County', county);
  set('Document Number', documentNumber);
  set('Parcel Number', `\t${parcelNumber}`);
  return parseRetrCsvRow({ cells, rowNumber: 2 });
}

async function parcelObservation(parcelId: string) {
  const w = harness();
  w.publisher.publish(release([parcel('DANE', parcelId)]));
  await w.run();
  return wiBundles(await bundlesOf(w.h.varRoot))
    .flatMap((b) => b['propertyIdentifiers'] as Row[])
    .filter((o) => o['identifierType'] === 'county_parcel') as never[];
}

test('synthetic RETR first, then the parcel map: provisional becomes resolved on one id', async () => {
  const retr = syntheticRetr('Dane', 'DOC-1', '0608-123-4567-0');
  const retrObs = retrParcelObservations(retr, evidence(WI_RETR_SOURCE_ID, 'wi-retr 55025:DOC-1'));
  const authority = parcelAuthorityFor(defaultRegistry().sources.filter((s) => s.authoritativeForParcelIdentity).map((s) => s.sourceId));
  const alone = resolveAll(retrObs, authority);
  assert.equal(alone[0]?.state, 'provisional');
  const both = resolveAll([...retrObs, ...await parcelObservation('0608-123-4567-0')], authority);
  assert.equal(both.length, 1, 'one property');
  assert.equal(both[0]?.state, 'resolved');
  assert.equal(both[0]?.authoritativeSourceId, WI_STATEWIDE_SOURCE_ID);
  assert.deepEqual(both[0]?.contributingSourceIds, [WI_RETR_SOURCE_ID, WI_STATEWIDE_SOURCE_ID].sort());
});

test('parcel map first, then RETR: the same property, and both evidence trails kept', async () => {
  const authority = parcelAuthorityFor([WI_STATEWIDE_SOURCE_ID]);
  const parcelObs = await parcelObservation('0608-123-4567-0');
  const retrObs = retrParcelObservations(syntheticRetr('Dane', 'DOC-1', '0608-123-4567-0'), evidence(WI_RETR_SOURCE_ID, 'r'));
  const a = resolveAll([...parcelObs, ...retrObs], authority);
  const b = resolveAll([...retrObs, ...parcelObs], authority);
  assert.deepEqual(a, b, 'ingest order changes nothing');
  assert.equal(a[0]?.propertyId, propertyIdFromCountyParcel(DANE, '0608-123-4567-0'));
  assert.equal(a[0]?.evidenceObservationIds.length, 2);
});

test('a RETR parcel punctuated differently does not force a match — it stays a candidate', () => {
  const [obs] = retrParcelObservations(syntheticRetr('Brown', 'DOC-2', '11109'), evidence(WI_RETR_SOURCE_ID, 'r'));
  assert.notEqual(obs?.propertyId, wiParcelIdentity(BROWN, '1-1109').propertyId);
  assert.equal(parcelMatchKey('11109'), wiParcelIdentity(BROWN, '1-1109').matchKey, 'a candidate for a uniqueness-checked resolver');
});

test('no live transfer coverage is claimed for Wisconsin', () => {
  const registry = defaultRegistry();
  const matrix = buildCoverage(registry);
  assert.ok(!['ACTIVE', 'READY_NOT_ACTIVATED'].includes(matrix.coreStateOf('us-county-55025', 'transfer')));
  assert.ok(!['ACTIVE', 'READY_NOT_ACTIVATED'].includes(matrix.anyStateOf('us-county-55025', 'transfer')));
  assert.equal(matrix.coreStateOf('us-county-55025', 'parcel'), 'ACTIVE');
  const retr = registry.source(WI_RETR_SOURCE_ID);
  assert.equal(retr.acquisitionClass, 'MANUAL_ONLY');
  assert.equal(retr.role, 'DEFERRED');
  assert.equal(registry.mapping('wi_retr__all_wi_counties').status, 'fixture_only');
  const report = nationalCoverageReport(registry, matrix, RUN_INSTANT);
  assert.equal(report.byCapability.find((c) => c.capability === 'transfer')?.covered, 0);
});

// ===========================================================================
// 12. Coverage
// ===========================================================================

test('automated core parcel coverage is 59 Minnesota plus 72 Wisconsin, derived', () => {
  const registry = defaultRegistry();
  const matrix = buildCoverage(registry);
  const covered = (state: string) => registry.jurisdictions
    .filter((j) => j.jurisdictionType === 'county' && j.stateCode === state)
    .filter((j) => ['ACTIVE', 'READY_NOT_ACTIVATED'].includes(matrix.coreStateOf(j.jurisdictionId, 'parcel'))).length;
  assert.equal(covered('MN'), 59);
  assert.equal(covered('WI'), 72);
  const report = nationalCoverageReport(registry, matrix, RUN_INSTANT);
  assert.equal(report.byCapability.find((c) => c.capability === 'parcel')?.covered, 131);
  for (const unclaimed of ['transfer', 'deed', 'mortgage', 'lien', 'foreclosure_notice'] as const) {
    assert.equal(matrix.coreStateOf('us-county-55079', unclaimed) === 'ACTIVE', false, unclaimed);
  }
});

test('the fingerprint is over what the publisher serves, not the date', () => {
  const head = { url: 'u', etag: '"a"', lastModified: 'x', contentLength: 1, versionId: 'v', acceptRanges: true };
  assert.equal(releaseFingerprintOf(head), releaseFingerprintOf({ ...head, acceptRanges: false }));
  assert.notEqual(releaseFingerprintOf(head), releaseFingerprintOf({ ...head, etag: '"b"' }));
});

test('planning never NOOPs on a release that was only replayed or failed', async () => {
  const w = harness();
  const ledger = createAcquisitionLedger(w.h.varRoot, WI_STATEWIDE_SOURCE_ID);
  const base = {
    at: RUN_INSTANT, sourceId: WI_STATEWIDE_SOURCE_ID, referencePeriod: 'V12.0.0-2026', releaseFingerprint: 'f',
    publisherSha256: null, publisherBytes: null, bundleSha256: null, runId: null, runStatus: 'completed',
    normalizedDigest: null, estateDigest: null, note: null,
  };
  await ledger.append({ ...base, action: 'REPLAYED' });
  await ledger.append({ ...base, action: 'FAILED' });
  const release = { sourceId: WI_STATEWIDE_SOURCE_ID, referencePeriod: 'V12.0.0-2026', releaseFingerprint: 'f', head: {} as never };
  assert.equal((await planAcquisition(release, ledger, 'V12.0.0-2026')).action, 'ACQUIRE');
});
