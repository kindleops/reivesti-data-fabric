/**
 * New York statewide parcels: 62 counties from one source, acquired with nobody
 * present, through the publisher's 2026 service migration.
 *
 * Every pipeline test runs the REAL pipeline — discovery, planning, download,
 * geodatabase derivation, streaming ingestion, partition activation, ledger —
 * against a synthetic File Geodatabase built at test time and served by a fake
 * publisher that models the program page, the archive host, GeoHub, the retiring
 * legacy server and the publisher's ArcGIS Online catalogue item
 * (tests/support/ny-fixture.ts). The fixture reproduces the 2025-roll schema
 * exactly: its schema digest is the one measured on the real 562,761,366-byte
 * archive and on the live GeoHub FeatureServer.
 *
 * Every row is invented. No live New York owner name or mailing address is
 * committed or generated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { propertyIdFromCountyParcel, type SourceEvidence } from '../src/canonical/models.ts';
import { parcelMatchKey } from '../src/canonical/normalization-contract.ts';
import { assessActivation } from '../src/registry/policy.ts';
import { buildCoverage, nationalCoverageReport } from '../src/registry/coverage.ts';
import { ACTIVE_COUNTY_EQUIVALENTS } from '../src/registry/us-geography.ts';
import { defaultRegistry, NY_POLYGON_SOURCE_ID } from '../src/registry/sources.ts';
import { createGenerationStore } from '../src/runtime/staged-store.ts';
import { createPartitionStore } from '../src/runtime/partition-store.ts';
import { createAcquisitionLedger } from '../src/runtime/bulk-acquisition.ts';
import { fieldSetDigestOf } from '../src/runtime/arcgis-session.ts';
import {
  NY_PINNED_FIELD_SET_DIGEST,
  NY_STATEWIDE_SOURCE_ID,
} from '../src/connectors/ny-statewide-parcels/index.ts';
import {
  NY_RESTRICTED_FIELDS,
  NY_STATEWIDE_FIELD_MAP,
  nyStatewideDispositionCounts,
} from '../src/connectors/ny-statewide-parcels/field-map.ts';
import {
  foldNyCountyName,
  isNonParcelLabel,
  nyParcelIdentity,
  nyTaxMapKey,
  routeNyCounty,
} from '../src/connectors/ny-statewide-parcels/identity.ts';
import { NY_2025_COUNTY_INVENTORY, nyExpectedCountyFips, reconcileNyCounties } from '../src/connectors/ny-statewide-parcels/counties.ts';
import { parseNyStatewideFeature } from '../src/connectors/ny-statewide-parcels/parse.ts';
import { canonicalAreaOf, normalizeNyStatewideParcel, yearBuiltOf } from '../src/connectors/ny-statewide-parcels/normalize.ts';
import {
  NY_LEGACY_GIS_HOST,
  currentLink,
  labelFromServiceMetadata,
  parseProgramLinks,
  preferCurrent,
  readRemoteZipDirectory,
} from '../src/connectors/ny-statewide-parcels/release.ts';
import {
  NY_STATEWIDE_MAPPING_ID,
  replayNyFromArchive,
  runNyStatewidePipeline,
  type NyPipelineOptions,
} from '../src/connectors/ny-statewide-parcels/pipeline.ts';
import {
  WI_STATEWIDE_MAPPING_ID,
  runWiStatewidePipeline,
} from '../src/connectors/wi-statewide-parcels/pipeline.ts';
import { createLocalBackend, artifactKey } from '../src/archive/artifact-backend.ts';
import { findRelease, type DurableStore } from '../src/archive/durable-artifacts.ts';
import { RUN_INSTANT, streamHarness, tempRoot } from './helpers.ts';
import {
  NY_2025_FIELDS,
  NY_CENTROID_ARCHIVE_URL,
  buildNyPolygonRelease,
  buildNyRelease,
  nyFakePublisher,
  nyParcel,
  nyServiceFields,
  zipArchive,
  type BuiltNyRelease,
  type NyPublisherOptions,
  type NyRow,
} from './support/ny-fixture.ts';
import { buildRelease as buildWiRelease, fakePublisher as wiFakePublisher, parcel as wiParcel } from './support/wi-fixture.ts';

type Row = Record<string, unknown>;

/** The live-measured field-set digest: archive and GeoHub FeatureServer, 2026-09-29. */
const LIVE_2025_FIELD_SET_DIGEST = '2c0ad408c074e384f437fcd153ddc10b91dbc97e83c48135c11eee9a77f19b44';

const ALBANY = '36001';
const ERIE = '36029';
const KINGS = '36047';
const MONROE = '36055';
const NASSAU = '36059';
const NEW_YORK = '36061';
const ST_LAWRENCE = '36089';
const SUFFOLK = '36103';

const SBL_A = '00100000010010000000';
const SBL_B = '00200000010010000000';

/** The base release: every case the phase has to get right, on invented rows. */
function baseRows(): (NyRow | null)[] {
  return [
    nyParcel('Albany', '010100', SBL_A),
    nyParcel('Albany', '010100', '00100000010020000000'),
    // The same tax map number in another municipality of the same county.
    nyParcel('Albany', '013089', SBL_A),
    // A village portion and the town-outside-village portion of one tax map number.
    nyParcel('Albany', '013001', SBL_B),
    nyParcel('Albany', '013089', SBL_B),
    // No SBL: a right-of-way polygon with no roll record behind it.
    nyParcel('Albany', '010100', 'x', {
      SBL: null, SWIS_SBL_ID: null, TOTAL_AV: null, LAND_AV: null, FULL_MARKET_VAL: null,
      MUNI_PARCEL_ID: null, OWNER_TYPE: '10', PRINT_KEY: '1.-1-1',
    }),
    // A second copy of the first parcel inside the same release.
    nyParcel('Albany', '010100', SBL_A, { PRIMARY_OWNER: 'SECOND COPY' }),
    null, // a deleted slot in the geodatabase
    // A feature label, not a tax map number.
    nyParcel('Westchester', '550100', 'WATER', { OWNER_TYPE: '11', TOTAL_AV: null, MUNI_PARCEL_ID: null }),
    // New York City: MapPLUTO lineage.
    nyParcel('NewYork', '620100', '1008750074'),
    nyParcel('Kings', '610100', '3012340056'),
    // The layer's own spelling of St. Lawrence.
    nyParcel('StLawrence', '401200', '09900000020100000000'),
    // COUNTY_NAME and SWIS name different counties.
    nyParcel('Erie', '010100', '12300000010010000000'),
    // A borough name is not a county.
    nyParcel('Manhattan', '620100', '1000010001'),
    // Suffolk: one SBL in two villages of one town — two roll parcels.
    nyParcel('Suffolk', '472001', '02000000010000100000'),
    nyParcel('Suffolk', '472003', '02000000010000100000'),
    // A lower-case SBL.
    nyParcel('Suffolk', '472089', '0300abc0000100000000'),
    nyParcel('Monroe', '260100', '12000000010010000000', { __noGeometry: 1 }),
    // The publisher's composite disagrees with its own parts.
    nyParcel('Nassau', '280200', '04500000010010000000', { SWIS_SBL_ID: '28020004500000010010000001' }),
    nyParcel('Erie', '140100', '11100000010010000000', {
      ADD_OWNER: 'TEST CO-OWNER', ADD_MAIL_ADDR: '9 INVENTED WAY', ADD_MAIL_CITY: 'FAKETOWN', ADD_MAIL_STATE: 'NY', ADD_MAIL_ZIP: '14000',
    }),
  ];
}

const BASE_VALID = baseRows().filter((r) => r !== null).length; // 19
const BASE_ACCEPTED = 14; // 19 − no SBL − duplicate − label − county/SWIS mismatch − uncatalogued

function harness(publisherOptions: NyPublisherOptions = {}, h = streamHarness()) {
  const publisher = nyFakePublisher(publisherOptions);
  const run = (overrides: Partial<NyPipelineOptions> = {}) => runNyStatewidePipeline({
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

function release(rows: (NyRow | null)[], build = '2605', rollYear = 2025): BuiltNyRelease {
  return buildNyRelease({ rollYear, build, rows });
}

async function ingestedBase(publisherOptions: NyPublisherOptions = {}) {
  const w = harness(publisherOptions);
  const built = release(baseRows());
  w.publisher.publish(built);
  w.publisher.publishPolygons(buildNyPolygonRelease(2025, '2605'));
  const result = await w.run();
  return { ...w, built, result };
}

async function bundlesOf(varRoot: string): Promise<Row[]> {
  const out: Row[] = [];
  for await (const line of createGenerationStore(varRoot).readTable('bundles')) out.push(JSON.parse(line) as Row);
  return out;
}

function nyBundles(rows: Row[]): Row[] {
  return rows.filter((b) => (b['transaction'] as Row)['sourceId'] === NY_STATEWIDE_SOURCE_ID);
}

function evidence(sourceRecordId: string): SourceEvidence {
  return {
    sourceId: NY_STATEWIDE_SOURCE_ID, sourceRecordId, artifactId: 'artifact_test', runId: 'run_test', observedAt: RUN_INSTANT,
    effectiveAt: null, rawRecordHash: 'x', parserVersion: 'p', normalizationVersion: 'n',
  };
}

function normalized(row: NyRow) {
  const parsed = parseNyStatewideFeature(row as Record<string, unknown>, 'f');
  return normalizeNyStatewideParcel(parsed.record, evidence(parsed.sourceRecordId), {
    sourceId: NY_STATEWIDE_SOURCE_ID, snapshotId: 'snap', changeKind: 'new_parcel_observed', changedFieldGroups: [],
  });
}

/** Every file under a directory: path, bytes, mtime and content hash. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}\t${statSync(p).size}\t${statSync(p).mtimeMs}\t${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort();
}

// ===========================================================================
// 1. Automation and the registry
// ===========================================================================

test('the source is automated-core eligible from registry facts alone', () => {
  const source = defaultRegistry().source(NY_STATEWIDE_SOURCE_ID);
  const verdict = assessActivation(source);
  assert.equal(verdict.verdict, 'CORE_ELIGIBLE');
  assert.equal(verdict.gate, 'none');
  assert.equal(source.costClass, 'FREE_BULK');
  assert.equal(source.acquisitionClass, 'AUTOMATED_BULK_DOWNLOAD');
  assert.equal(source.automationStatus, 'sanctioned');
  assert.equal(source.role, 'CORE_CANONICAL_SOURCE');
});

test('one source and one mapping cover all 62 counties the federal catalogue lists', () => {
  const registry = defaultRegistry();
  const mapping = registry.mapping(NY_STATEWIDE_MAPPING_ID);
  const expanded = registry.expand(mapping).map((j) => j.countyFips).sort();
  const catalogue = ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateFips === '36').map((c) => c.fips).sort();
  assert.equal(catalogue.length, 62);
  assert.deepEqual(expanded, catalogue);
  assert.deepEqual(nyExpectedCountyFips(), catalogue);
  assert.equal(registry.sources.filter((s) => s.sourceId.startsWith('ny_statewide_parcels')).length, 1, 'one source, not 62');
});

test('only the capabilities the layer carries are claimed: no tax, no transfer', () => {
  const mapping = defaultRegistry().mapping(NY_STATEWIDE_MAPPING_ID);
  assert.deepEqual([...mapping.capabilities].sort(), ['assessor', 'ownership', 'parcel']);
  for (const c of ['tax', 'transfer', 'deed', 'mortgage', 'lien', 'foreclosure_notice'] as const) {
    assert.ok(!mapping.capabilities.includes(c), `${c} must not be claimed`);
  }
});

test('the polygon product is registered as validation-only evidence with no coverage', () => {
  const registry = defaultRegistry();
  const polygons = registry.source(NY_POLYGON_SOURCE_ID);
  assert.equal(polygons.role, 'VALIDATION_ONLY');
  assert.equal(registry.mappings.filter((m) => m.sourceId === NY_POLYGON_SOURCE_ID).length, 0, 'no mapping, so never coverage');
});

test('national parcel coverage gains exactly New York\'s 62 counties', () => {
  const registry = defaultRegistry();
  const report = nationalCoverageReport(registry, buildCoverage(registry), RUN_INSTANT);
  // Minnesota 59 + Wisconsin 72 + New York 62.
  assert.equal(report.jurisdictionsWithCoreSource, 193);
  assert.equal(report.byCapability.find((c) => c.capability === 'parcel')?.covered, 193);
  assert.equal(report.byCapability.find((c) => c.capability === 'transfer')?.covered, 0);
});

// ===========================================================================
// 2. Schema
// ===========================================================================

test('every one of the 73 attributes is classified, and the pinned digest is the live one', () => {
  assert.equal(NY_STATEWIDE_FIELD_MAP.length, 73);
  assert.equal(new Set(NY_STATEWIDE_FIELD_MAP.map((f) => f.field)).size, 73);
  assert.equal(NY_PINNED_FIELD_SET_DIGEST, LIVE_2025_FIELD_SET_DIGEST);
  // The fixture's geodatabase and service declare exactly what the real ones do.
  assert.equal(fieldSetDigestOf(nyServiceFields()), LIVE_2025_FIELD_SET_DIGEST);
  for (const f of NY_STATEWIDE_FIELD_MAP) assert.ok(f.note.length > 10, `${f.field} has no reason`);
  assert.deepEqual(nyStatewideDispositionCounts(), {
    KEEP_RAW: 9, CANONICALIZE: 15, NORMALIZE: 36, RESTRICTED: 10, DERIVE_LATER: 2, HISTORIZE: 1,
  });
});

test('the restricted fields are exactly both owners\' mailing parts', () => {
  assert.deepEqual([...NY_RESTRICTED_FIELDS].sort(), [
    'ADD_MAIL_ADDR', 'ADD_MAIL_CITY', 'ADD_MAIL_PO_BOX', 'ADD_MAIL_STATE', 'ADD_MAIL_ZIP',
    'MAIL_ADDR', 'MAIL_CITY', 'MAIL_STATE', 'MAIL_ZIP', 'PO_BOX',
  ]);
});

test('the pinned inventory is the 62 catalogue counties, each with one SWIS county code', () => {
  assert.equal(NY_2025_COUNTY_INVENTORY.length, 62);
  assert.deepEqual(NY_2025_COUNTY_INVENTORY.map((c) => c.fips).sort(), nyExpectedCountyFips());
  assert.equal(NY_2025_COUNTY_INVENTORY.reduce((a, c) => a + c.sourceRows, 0), 5_510_061);
  assert.equal(new Set(NY_2025_COUNTY_INVENTORY.map((c) => c.swisCountyCode)).size, 62);
  const nyc = NY_2025_COUNTY_INVENTORY.filter((c) => Number(c.swisCountyCode) >= 60).map((c) => c.fips).sort();
  assert.deepEqual(nyc, ['36005', '36047', '36061', '36081', '36085'], 'SWIS 60–64 are exactly the five boroughs');
});

test('county reconciliation names missing and extra counties and never mixes raw with accepted counts', () => {
  const accepted = new Map(nyExpectedCountyFips().filter((f) => f !== ALBANY).map((f) => [f, 1] as const));
  accepted.set('55025', 1);
  const raw = Object.fromEntries(NY_2025_COUNTY_INVENTORY.map((c) => [c.name, c.sourceRows]));
  raw['Albany'] = 0;
  const r = reconcileNyCounties(accepted, raw);
  assert.deepEqual(r.missing, [ALBANY]);
  assert.deepEqual(r.extra, ['55025']);
  assert.deepEqual(r.rowCountChanges, [{ fips: ALBANY, expected: 112804, actual: 0 }]);
  assert.equal(r.matches, false);
});

// ===========================================================================
// 3. Routing and identity
// ===========================================================================

test('county names fold unambiguously; the layer\'s spellings reach the right counties', () => {
  assert.equal(routeNyCounty('NewYork', '620100', 'f'), NEW_YORK);
  assert.equal(routeNyCounty('New York', '620100', 'f'), NEW_YORK);
  assert.equal(routeNyCounty('StLawrence', '401200', 'f'), ST_LAWRENCE);
  assert.equal(routeNyCounty('St. Lawrence', '401200', 'f'), ST_LAWRENCE);
  const folds = ACTIVE_COUNTY_EQUIVALENTS.filter((c) => c.stateFips === '36').map((c) => foldNyCountyName(c.name.replace(/ County$/, '')));
  assert.equal(new Set(folds).size, 62, 'no two catalogue counties fold together');
});

test('a county is placed only when COUNTY_NAME and the SWIS county code agree', () => {
  assert.throws(() => routeNyCounty('Erie', '010100', 'f'), /name different counties/);
  assert.throws(() => routeNyCounty('Manhattan', '620100', 'f'), /not a catalogued New York county/);
  assert.throws(() => routeNyCounty('Albany', '01010', 'f'), /6-digit/);
  assert.throws(() => routeNyCounty(null, '010100', 'f'), /no COUNTY_NAME/);
});

test('identity is SWIS + SBL: the same SBL in two municipalities is two properties', () => {
  const a = nyParcelIdentity(ALBANY, '010100', SBL_A);
  const b = nyParcelIdentity(ALBANY, '013089', SBL_A);
  assert.equal(a.normalizedParcel, `010100${SBL_A}`);
  assert.notEqual(a.propertyId, b.propertyId);
  assert.equal(a.propertyId, propertyIdFromCountyParcel(ALBANY, `010100${SBL_A}`));
});

test('village and town portions of one tax map number stay two properties, linked by a candidate key', () => {
  const village = nyParcelIdentity(ALBANY, '013001', SBL_B);
  const town = nyParcelIdentity(ALBANY, '013089', SBL_B);
  assert.notEqual(village.propertyId, town.propertyId);
  assert.equal(nyTaxMapKey('013000', village.normalizedSbl), nyTaxMapKey('013000', town.normalizedSbl));
});

test('the SBL keeps leading zeros and punctuation, folds case, trims only its ends', () => {
  const id = nyParcelIdentity(SUFFOLK, '472089', '  0300abc0000100000000 ');
  assert.equal(id.normalizedSbl, '0300ABC0000100000000');
  assert.equal(id.rawSbl, '0300abc0000100000000');
  const dotted = nyParcelIdentity(ALBANY, '010100', '001.2-3');
  const bare = nyParcelIdentity(ALBANY, '010100', '0012-3');
  assert.notEqual(dotted.propertyId, bare.propertyId, 'punctuation is identity');
  assert.equal(dotted.matchKey, bare.matchKey, 'the folded form is only a candidate match');
  assert.notEqual(nyParcelIdentity(ALBANY, '010100', '0012').propertyId, nyParcelIdentity(ALBANY, '010100', '012').propertyId);
});

test('an absent SBL and a digit-less label are refused, never admitted as parcels', () => {
  assert.throws(() => nyParcelIdentity(ALBANY, '010100', ''), /BLANK_SOURCE|MISSING/);
  assert.throws(() => nyParcelIdentity(ALBANY, '010100', 'WATER '), /non-parcel feature label/);
  assert.ok(isNonParcelLabel('WATER'));
  assert.ok(!isNonParcelLabel('0300ABC'));
});

test('the formatted print key is never identity: its punctuation is what tells keys apart', () => {
  // Folding a print key's separators merges distinct keys (58,239 groups live).
  assert.equal(parcelMatchKey('1.-2-3'), parcelMatchKey('1.2-3'));
  const a = parseNyStatewideFeature(nyParcel('Albany', '010100', SBL_A, { PRINT_KEY: '1.-2-3' }) as Record<string, unknown>, 'f');
  const b = parseNyStatewideFeature(nyParcel('Albany', '010100', SBL_A, { PRINT_KEY: '1.2-3' }) as Record<string, unknown>, 'f');
  assert.equal(a.sourceRecordId, b.sourceRecordId, 'identity comes from SWIS + SBL alone');
});

// ===========================================================================
// 4. Semantics
// ===========================================================================

test('an ORPTS row: assessed and full market value never share a slot; no tax; no sale', () => {
  const { bundle } = normalized(nyParcel('Albany', '010100', SBL_A, { TOTAL_AV: 150000, LAND_AV: 30000, FULL_MARKET_VAL: 187500 }));
  const assessment = bundle.assessments![0]!;
  assert.equal(assessment.totalValue?.amountMinor, 15_000_000);
  assert.equal(assessment.landValue?.amountMinor, 3_000_000);
  assert.equal(assessment.buildingValue, null, 'total − land is a derivation, not the roll');
  assert.equal(assessment.netTax, null);
  assert.equal(assessment.assessmentYear, 2025);
  assert.equal(assessment.characteristics['full_market_value_minor'], 18_750_000);
  assert.equal(assessment.characteristics['value_basis'], 'assessed_at_municipal_level_of_assessment');
  assert.equal(assessment.characteristics['property_class_system'], 'nys_orpts_property_class');
  assert.equal(bundle.transaction.totalConsideration, null);
  assert.equal(bundle.financing.length, 0);
  const c = bundle.characteristics![0]!.characteristics;
  assert.equal(c['last_deed_book_raw'], 1234, 'kept raw');
  assert.equal(c['sale_fields_in_source'], false);
  assert.ok(!bundle.events.some((e) => /TRANSFER|SALE|DEED/.test(e.eventType)), 'BOOK/PAGE is not a transfer');
});

test('a New York City row keeps its own code systems and value basis', () => {
  const { bundle } = normalized(nyParcel('Kings', '610100', '3012340056'));
  const a = bundle.assessments![0]!;
  const c = bundle.characteristics![0]!.characteristics;
  assert.equal(c['lineage'], 'nyc_mappluto');
  assert.equal(a.characteristics['property_class_system'], 'nyc_pluto_land_use');
  assert.equal(a.characteristics['value_basis'], 'nyc_dof_assessed_value');
  assert.equal(a.characteristics['full_market_value_minor'], null);
  assert.equal(c['building_style_system'], 'nyc_dof_building_class');
  assert.equal(bundle.characteristics![0]!.parcelAreaSqFt, 2500, 'NYC states lot area in square feet');
});

test('owners are unresolved observations; mailing addresses go only to the restricted plane', () => {
  const { bundle, contacts } = normalized(nyParcel('Erie', '140100', '11100000010010000000', {
    ADD_OWNER: 'TEST CO-OWNER', ADD_MAIL_ADDR: '9 INVENTED WAY', ADD_MAIL_CITY: 'FAKETOWN', ADD_MAIL_STATE: 'NY', ADD_MAIL_ZIP: '14000',
  }));
  assert.equal(bundle.parties.length, 2);
  for (const p of bundle.parties) {
    assert.equal(p.kind, 'unknown');
    assert.equal(p.resolutionState, 'unresolved');
    assert.equal(p.address, null);
  }
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c.permittedUse === 'record_only' && c.contactType === 'mailing_address'));
  const coOwner = bundle.parties.find((p) => p.rawName === 'TEST CO-OWNER')!;
  assert.equal(contacts.find((c) => c.value.startsWith('9 INVENTED WAY'))?.partyObservationId, coOwner.observationId);
  assert.ok(!JSON.stringify(bundle).includes('INVENTED WAY'), 'no mailing string on a canonical row');
});

test('the same mailing address stated for both owners of an unnamed record is one fact', () => {
  const { contacts } = normalized(nyParcel('Albany', '010100', SBL_A, {
    PRIMARY_OWNER: null, ADD_MAIL_ADDR: '100 INVENTED WAY', MAIL_ADDR: '100 INVENTED WAY', ADD_MAIL_CITY: 'FAKETOWN',
    MAIL_CITY: 'FAKETOWN', ADD_MAIL_STATE: 'NY', MAIL_STATE: 'NY', ADD_MAIL_ZIP: '12000', MAIL_ZIP: '12000',
  }));
  assert.equal(contacts.length, 1);
});

test('area: the roll\'s acres, else its square feet, else nothing; never frontage × depth', () => {
  const area = (o: NyRow) => canonicalAreaOf(parseNyStatewideFeature(nyParcel('Albany', '010100', SBL_A, o) as Record<string, unknown>, 'f').record);
  const acres = area({ ACRES: 2, SQ_FT: 0 });
  assert.equal(acres.field, 'ACRES');
  assert.equal(acres.area.present && acres.area.squareFeet, 87_120);
  assert.equal(area({ ACRES: 0, SQ_FT: 5000 }).field, 'SQ_FT');
  const none = area({ ACRES: 0, SQ_FT: 0 });
  assert.equal(none.area.present, false);
  assert.equal(!none.area.present && none.area.reason, 'NOT_APPLICABLE');
});

test('year built: 0 means not recorded; the raw value is always kept', () => {
  assert.equal(yearBuiltOf(0, 2025), null);
  assert.equal(yearBuiltOf(1650, 2025), 1650, 'New York has standing 17th-century houses');
  assert.equal(yearBuiltOf(1599, 2025), null);
  assert.equal(yearBuiltOf(2026, 2025), 2026);
  assert.equal(yearBuiltOf(2031, 2025), null);
  assert.equal(yearBuiltOf(1950, null), null, 'no roll year, nothing to check against, no clock consulted');
  const { bundle } = normalized(nyParcel('Albany', '010100', SBL_A, { YR_BLT: 0 }));
  assert.equal(bundle.characteristics![0]!.yearBuilt, null);
  assert.equal(bundle.characteristics![0]!.characteristics['year_built_raw'], 0);
});

test('a stated zero is a value, and a land value above total is flagged, not repaired', () => {
  const { bundle } = normalized(nyParcel('Albany', '010100', SBL_A, { TOTAL_AV: 0, LAND_AV: 5000 }));
  const a = bundle.assessments![0]!;
  assert.equal(a.totalValue?.amountMinor, 0);
  assert.equal(a.characteristics['land_exceeds_total'], true);
});

// ===========================================================================
// 5. Discovery through the migration
// ===========================================================================

test('the program page yields the archives and services, and refuses a mirror', () => {
  const html = [
    NY_CENTROID_ARCHIVE_URL,
    'https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels.zip',
    'https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels-State-Owned.gdb.zip',
    'https://nysgeohub.ny.gov/arcgis/rest/services/Parcels/NYS_Tax_Parcel_Centroid_Points/FeatureServer',
    `https://${NY_LEGACY_GIS_HOST}/arcgis/rest/services/NYS_Tax_Parcel_Centroid_Points/FeatureServer`,
    'https://parcels-mirror.example.com/NYS-Tax-Parcel-Centroid-Points.gdb.zip',
    // Linked at a layer rather than the service: the same service.
    'https://nysgeohub.ny.gov/arcgis/rest/services/Parcels/NYS_Tax_Parcels_Public/FeatureServer/1',
  ].map((u) => `<a href="${u}">x</a>`).join('');
  const links = parseProgramLinks(html);
  assert.deepEqual(links.centroidArchives, [NY_CENTROID_ARCHIVE_URL]);
  assert.deepEqual(links.polygonArchives, ['https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels.zip']);
  assert.equal(links.centroidServices.length, 2);
  assert.equal(preferCurrent(links.centroidServices)[0], 'https://nysgeohub.ny.gov/arcgis/rest/services/Parcels/NYS_Tax_Parcel_Centroid_Points/FeatureServer');
  assert.deepEqual(links.refusedNonOfficial, ['https://parcels-mirror.example.com/NYS-Tax-Parcel-Centroid-Points.gdb.zip']);
  assert.deepEqual(links.polygonServices, ['https://nysgeohub.ny.gov/arcgis/rest/services/Parcels/NYS_Tax_Parcels_Public/FeatureServer']);
});

test('the release is named by the archive itself, read by range: no download, no legacy request', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.outcome, 'DISCOVERED');
  assert.equal(result.discovered?.referencePeriod, '2025-2605');
  assert.equal(result.discovered?.archive.label.source, 'archive_directory');
  assert.equal(result.discovered?.archive.label.geodatabase, 'NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb');
  assert.equal(result.discovered?.witness.discoveredVia, 'program_page');
  assert.equal(result.discovered?.migration.dependsOnLegacyHost, false);
  assert.equal(result.discovered?.serviceMatchesArchive, true);
  assert.equal(result.plan?.action, 'ACQUIRE');
  assert.equal(w.publisher.archiveGets(), 0, 'discovery must never download the archive');
  assert.equal(w.publisher.legacyRequests(), 0, 'the retiring host is never asked');
});

test('when the page links only the retiring server, the catalogue item leads to GeoHub', async () => {
  const w = harness({ serviceLinks: 'legacy' });
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.discovered?.witness.discoveredVia, 'catalog_item');
  assert.equal(new URL(result.discovered!.witness.serviceUrl).hostname, 'nysgeohub.ny.gov');
  assert.equal(result.discovered?.migration.dependsOnLegacyHost, false);
  assert.equal(w.publisher.legacyRequests(), 0);
});

test('a further move of the services is followed with no code change', async () => {
  const w = harness({ geohubHost: 'geohub2.its.ny.gov' });
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(new URL(result.discovered!.witness.serviceUrl).hostname, 'geohub2.its.ny.gov');
  assert.equal(result.discovered?.witness.count, BASE_VALID);
});

test('only the retiring server left anywhere: discovery fails, naming the migration, and never asks it', async () => {
  // Frozen since 2026-09-18 and retiring in 10/2026: a count read there cannot
  // vouch for a newer archive. Failing now is louder than retirement failing later.
  const w = harness({ serviceLinks: 'legacy', catalogOwner: 'SOMEONE_ELSE' });
  w.publisher.publish(release(baseRows()));
  await assert.rejects(w.run({ discoverOnly: true }), (error: Error) => {
    assert.match(error.message, /only the retiring legacy host gisservices\.its\.ny\.gov/);
    assert.match(error.message, /owned by SOMEONE_ELSE, not NYSGIS_GPO/, 'the catalogue item\'s reason is carried');
    assert.match(error.message, /GeoHub migration has left no current witness/);
    return true;
  });
  assert.equal(w.publisher.legacyRequests(), 0);
  assert.equal((await createAcquisitionLedger(w.h.varRoot, NY_STATEWIDE_SOURCE_ID).entries()).at(-1)?.action, 'FAILED');
});

test('a catalogue item still pointing at the retiring server is refused with that reason', async () => {
  const w = harness({ serviceLinks: 'legacy', catalogPointsAt: 'legacy' });
  w.publisher.publish(release(baseRows()));
  await assert.rejects(w.run({ discoverOnly: true }), /still points at the retiring legacy server/);
  const none = harness({ serviceLinks: 'none', catalogPointsAt: 'legacy' });
  none.publisher.publish(release(baseRows()));
  await assert.rejects(none.run({ discoverOnly: true }), /no centroid FeatureServer .*still points at the retiring legacy server/);
  assert.equal(w.publisher.legacyRequests() + none.publisher.legacyRequests(), 0);
});

test('a legacy link beside a current one is ignored, reported, and never requested', async () => {
  const w = harness({ serviceLinks: 'both' });
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.discovered?.witness.discoveredVia, 'program_page');
  assert.equal(new URL(result.discovered!.witness.serviceUrl).hostname, 'nysgeohub.ny.gov');
  assert.equal(result.discovered?.migration.dependsOnLegacyHost, false);
  assert.equal(result.discovered?.migration.legacyLinksIgnored.length, 2);
  assert.equal(w.publisher.legacyRequests(), 0);
});

test('two current links for one product are ambiguous: discovery refuses to choose', async () => {
  const w = harness({ extraLinks: ['https://gisdata.ny.gov/GISData/State/Parcels/2026/NYS-Tax-Parcel-Centroid-Points.gdb.zip'] });
  w.publisher.publish(release(baseRows()));
  await assert.rejects(w.run({ discoverOnly: true }), /links 2 current centroid archives; which one is the release is ambiguous/);
  assert.throws(() => currentLink(['https://a.ny.gov/x/FeatureServer', 'https://b.ny.gov/x/FeatureServer'], 'service'), /ambiguous/);
  assert.deepEqual(currentLink([`https://${NY_LEGACY_GIS_HOST}/x/FeatureServer`], 'service'), {
    url: null, legacy: [`https://${NY_LEGACY_GIS_HOST}/x/FeatureServer`],
  });
});

test('an archive holding two geodatabases is refused at discovery and again at derivation', async () => {
  const second = [{ name: 'NYS_2024_Tax_Parcels_Centroid_Points_2505.gdb/', bytes: null }];
  const ranged = harness();
  ranged.publisher.publish(buildNyRelease({ rollYear: 2025, build: '2605', rows: baseRows(), extraEntries: second }));
  await assert.rejects(ranged.run({ discoverOnly: true }), /the archive holds 2 geodatabases, expected exactly one/);
  // Without ranges discovery cannot see inside; derivation, which can, refuses.
  const unranged = harness({ ranges: false });
  unranged.publisher.publish(buildNyRelease({ rollYear: 2025, build: '2605', rows: baseRows(), extraEntries: second }));
  await assert.rejects(unranged.run(), /the archive holds 2 geodatabases, expected exactly one/);
  assert.deepEqual(await createPartitionStore(unranged.h.varRoot).manifests(), []);
});

test('no service anywhere, or no archive link, fails discovery rather than guessing', async () => {
  const noService = harness({ serviceLinks: 'none', catalogOwner: null });
  noService.publisher.publish(release(baseRows()));
  await assert.rejects(noService.run({ discoverOnly: true }), /no centroid FeatureServer/);
  const noArchive = harness({ archiveLinks: false });
  noArchive.publisher.publish(release(baseRows()));
  await assert.rejects(noArchive.run({ discoverOnly: true }), /no longer links the centroid archive/);
  // Linked, but gone: an answer, loudly, never a guess at another URL.
  const gone = harness();
  await assert.rejects(gone.run({ discoverOnly: true }), /returned 404/);
});

test('a host that ignores byte ranges: the label comes from the service, and the archive must agree', async () => {
  const w = harness({ ranges: false });
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.discovered?.archive.label.source, 'service_metadata');
  assert.equal(result.discovered?.referencePeriod, '2025-2605');
  assert.equal(labelFromServiceMetadata('NYS 2025 Tax Parcel Centroid Points', 'Publication Date: May 2026')?.referencePeriod, '2025-2605');
});

test('ranges advertised and then ignored: no second request, the label comes from the service', async () => {
  const w = harness({ ranges: 'advertised_only' });
  w.publisher.publish(release(baseRows()));
  const result = await w.run({ discoverOnly: true });
  assert.equal(result.discovered?.access.archiveAcceptsRanges, true, 'what the host advertised');
  assert.equal(result.discovered?.archive.label.source, 'service_metadata', 'what it did');
  assert.equal(result.discovered?.archive.entryCount, null);
  assert.equal(result.discovered?.referencePeriod, '2025-2605');
  const ranged = w.publisher.requests.filter((r) => r.url === NY_CENTROID_ARCHIVE_URL && r.headers['range'] !== undefined);
  assert.equal(ranged.length, 1, 'a host that answered a range with the whole body is not asked again');
  // The ingest that follows still names its release from the archive itself.
  const ingested = await w.run();
  assert.equal(ingested.outcome, 'INGESTED');
  assert.equal(ingested.derivation?.label.referencePeriod, '2025-2605');
});

test('an archive whose geodatabase names a different release than discovery activates nothing', async () => {
  const w = harness({ ranges: false });
  // The service says June 2026; the archive's geodatabase says May 2026.
  w.publisher.publish(release(baseRows()), { publication: 'June 2026' });
  await assert.rejects(w.run(), /archive is release 2025-2605, not 2025-2606/);
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
  assert.equal((await createAcquisitionLedger(w.h.varRoot, NY_STATEWIDE_SOURCE_ID).entries()).at(-1)?.action, 'FAILED');
});

/** Serves one file by range; with `ignore`, answers every request with the whole body. */
function rangeHost(bytes: Buffer, mode: 'ranges' | 'ignore' = 'ranges') {
  const ranges: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const range = ((init?.headers ?? {}) as Record<string, string>)['range'];
    ranges.push(range ?? 'none');
    const m = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m && mode === 'ranges') return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof fetch;
  return { http: { fetchImpl, sleep: async () => {} }, ranges };
}

const GDB_2605 = 'NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb';
const gdbEntries = (n: number) => [
  { name: `${GDB_2605}/`, bytes: null },
  ...Array.from({ length: n }, (_, i) => ({ name: `${GDB_2605}/a${String(i).padStart(8, '0')}.gdbindexes`, bytes: Buffer.from([i & 0xff]) })),
];
const ZIP_URL = 'https://gisdata.ny.gov/GISData/State/Parcels/test.zip';

test('the ZIP end record is the one that ends the file, not the first signature from the end', async () => {
  // An archive comment may contain the signature. Only the record whose own
  // comment length ends it exactly at the end of the file is the record.
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  fake.writeUInt16LE(7, 10);
  const bytes = zipArchive(gdbEntries(3), { comment: Buffer.concat([Buffer.from('built by '), fake, Buffer.from(' for a test')]) });
  const host = rangeHost(bytes);
  assert.deepEqual(await readRemoteZipDirectory(ZIP_URL, bytes.length, host.http), { geodatabases: [GDB_2605], entryCount: 4 });
  assert.equal(host.ranges.length, 1, 'a directory inside the tail costs one request');
});

test('a central directory larger than the tail window is fetched with a second range', async () => {
  const bytes = zipArchive(gdbEntries(1500));
  const host = rangeHost(bytes);
  assert.deepEqual(await readRemoteZipDirectory(ZIP_URL, bytes.length, host.http), { geodatabases: [GDB_2605], entryCount: 1501 });
  assert.equal(host.ranges.length, 2);
});

test('a ZIP64 archive is read through its locator', async () => {
  const bytes = zipArchive(gdbEntries(3), { zip64: true });
  assert.deepEqual(await readRemoteZipDirectory(ZIP_URL, bytes.length, rangeHost(bytes).http), { geodatabases: [GDB_2605], entryCount: 4 });
});

test('a host that answers a range with the whole body yields no directory, and is not asked twice', async () => {
  const bytes = zipArchive(gdbEntries(3));
  const host = rangeHost(bytes, 'ignore');
  assert.equal(await readRemoteZipDirectory(ZIP_URL, bytes.length, host.http), null);
  assert.equal(host.ranges.length, 1);
});

test('bytes that are not a ZIP, or a directory its end record contradicts, are refused', async () => {
  const junk = Buffer.alloc(4096, 0x41);
  await assert.rejects(readRemoteZipDirectory(ZIP_URL, junk.length, rangeHost(junk).http), /no ZIP end-of-central-directory record/);
  const lying = Buffer.from(zipArchive(gdbEntries(3)));
  lying.writeUInt16LE(9, lying.length - 22 + 10);
  await assert.rejects(readRemoteZipDirectory(ZIP_URL, lying.length, rangeHost(lying).http), /lists 4 entries, its end record says 9/);
});

test('no request carries a credential, cookie or session token', async () => {
  const { publisher } = await ingestedBase();
  for (const r of publisher.requests) {
    const names = Object.keys(r.headers).map((h) => h.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'x-api-key', 'x-esri-authorization']) {
      assert.ok(!names.includes(forbidden), `${r.url} carried ${forbidden}`);
    }
    assert.ok(!/[?&]token=/.test(r.url), `${r.url} carried a token`);
  }
});

// ===========================================================================
// 6. The unattended pipeline
// ===========================================================================

test('acquisition needs no human: discover → acquire → derive → ingest in one call', async () => {
  const { result, publisher, built } = await ingestedBase();
  assert.equal(result.outcome, 'INGESTED');
  assert.equal(publisher.archiveGets(NY_CENTROID_ARCHIVE_URL), 1, 'one archive request, not a crawl');
  assert.equal(result.publisherArtifact?.sha256, built.sha256);
  assert.equal(result.ledger?.action, 'ACQUIRED_AND_INGESTED');
  assert.ok(result.bundleArtifact!.storagePath.endsWith('source-original.ndjson'), 'plain NDJSON: its bytes are a function of the rows alone');
  assert.equal(result.crossCheck?.agrees, true);
  assert.equal(result.crossCheck?.releaseAgrees, true);
  assert.deepEqual(result.crossCheck?.onlyInService, []);
  assert.deepEqual(result.crossCheck?.onlyInArchive, []);
});

test('every row is accounted for: accepted + quarantined = the release, exactly', async () => {
  const { result } = await ingestedBase();
  const m = result.run!.run.metrics;
  assert.equal(result.derivation?.rowsWritten, BASE_VALID);
  assert.equal(result.derivation?.deletedSlots, 1);
  assert.equal(result.derivation?.rowsWithoutGeometry, 1);
  assert.equal(m.rowsParsed, BASE_VALID);
  assert.equal(m.rowsValid, BASE_ACCEPTED);
  assert.equal(m.rowsQuarantined, BASE_VALID - BASE_ACCEPTED);
  assert.equal(result.run!.run.duplicateCount, 1);
  assert.deepEqual(Object.keys(result.run!.countyCounts).sort(), [ALBANY, ERIE, KINGS, MONROE, NASSAU, NEW_YORK, ST_LAWRENCE, SUFFOLK]);
  assert.equal(Object.values(result.run!.countyCounts).reduce((a, b) => a + b, 0), BASE_ACCEPTED);
  assert.equal(result.run!.countyCounts[ALBANY], 5, 'the same SBL in two municipalities, and a split tax map number, are five parcels');
});

test('county partitions are activated per county; nothing is invented for a county with no parcels', async () => {
  const { result } = await ingestedBase();
  const property = result.run!.activations.filter((a) => a.partitionId.startsWith('property/'));
  assert.equal(property.length, 8);
  assert.ok(property.every((a) => a.state === 'activated'));
  assert.ok(!property.some((a) => a.partitionId.endsWith('36119')), 'Westchester delivered only a label');
});

test('the same release rediscovered is a NOOP: no download, no parse, no projection', async () => {
  const w = await ingestedBase();
  const again = await w.run();
  assert.equal(again.outcome, 'NOOP');
  assert.equal(again.run, null);
  assert.equal(w.publisher.archiveGets(NY_CENTROID_ARCHIVE_URL), 1, 'a NOOP tick must not re-download');
  assert.equal(again.ledger?.action, 'NOOP_SAME_RELEASE');
  assert.equal(again.companion?.status, 'ALREADY_RETAINED');
});

test('a republished file and a new roll are both planned; a new roll needs schema validation', async () => {
  const w = await ingestedBase();
  w.publisher.publish(release(baseRows()), { etag: '"republished"' });
  const republished = await w.run({ discoverOnly: true });
  assert.equal(republished.plan?.action === 'ACQUIRE' && republished.plan.reason, 'REPUBLISHED_RELEASE');
  w.publisher.publish(release(baseRows(), '2705', 2026), { title: 'NYS 2026 Tax Parcel Centroid Points', publication: 'May 2027' });
  const next = await w.run({ discoverOnly: true });
  assert.equal(next.discovered?.referencePeriod, '2026-2705');
  assert.equal(next.plan?.action === 'ACQUIRE' && next.plan.reason, 'NEW_RELEASE');
  assert.equal(next.plan?.action === 'ACQUIRE' && next.plan.schemaValidationRequired, true);
});

test('a witness count that disagrees with the archive activates nothing', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()), { serviceCount: BASE_VALID + 1 });
  const result = await w.run();
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.run, null, 'the runtime never started');
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
  const failed = (await createAcquisitionLedger(w.h.varRoot, NY_STATEWIDE_SOURCE_ID).entries()).at(-1);
  assert.equal(failed?.runStatus, 'crosscheck_disagrees');
  assert.equal(failed?.releaseFingerprint, result.discovered?.releaseFingerprint);
});

test('a witness serving another schema is not a witness: nothing is activated', async () => {
  const w = harness();
  const fields = nyServiceFields();
  fields.push({ name: 'NEW_COLUMN', type: 'esriFieldTypeString', length: 10 });
  w.publisher.publish(release(baseRows()), { serviceFields: fields });
  const result = await w.run();
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.crossCheck?.schemaAgrees, false);
  assert.deepEqual(result.crossCheck?.onlyInService, ['NEW_COLUMN']);
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
});

test('a publisher schema change in the archive quarantines the run before a row is trusted', async () => {
  const w = harness();
  const fields = [...NY_2025_FIELDS, { name: 'NEW_COLUMN', kind: 'string' as const, length: 10 }];
  const built = buildNyRelease({ rollYear: 2025, build: '2605', rows: baseRows(), fields });
  w.publisher.publish(built, { serviceFields: nyServiceFields(fields) });
  const result = await w.run();
  assert.notEqual(result.outcome, 'INGESTED');
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
});

/**
 * Stored entries and zeroed timestamps make the fixture archive the same bytes
 * on every platform and zlib build, so the bundle derived from it can be pinned.
 * The run id, every row's evidence and the normalized digest descend from the
 * bundle's sha256: it may move only when the rows, the header contract, or this
 * code's derivation of them does — never with the machine.
 */
const PINNED_FIXTURE_ARCHIVE_SHA256 = 'ed5000b0d2b0844ecbcc85752c3e20d152d08082b17965a1ebdf999b46ba4c3e';
const PINNED_FIXTURE_BUNDLE_SHA256 = '490a511e4ad53ebe3c990e61f0bb2140752b56dddf9e528755fcc99a540e613f';

test('the fixture archive, and the bundle derived from it, are pinned byte for byte', async () => {
  const { result, built } = await ingestedBase();
  assert.equal(built.sha256, PINNED_FIXTURE_ARCHIVE_SHA256);
  assert.equal(result.publisherArtifact?.sha256, PINNED_FIXTURE_ARCHIVE_SHA256);
  assert.equal(result.bundleArtifact?.sha256, PINNED_FIXTURE_BUNDLE_SHA256);
});

test('with no witness at all, the runtime\'s own schema pin still quarantines a drifted archive', async () => {
  // The cross-check is not the only gate. A replay has no FeatureServer to
  // compare with; the runtime refuses the bundle's header before a row is read.
  const w = harness();
  const fields = [...NY_2025_FIELDS, { name: 'NEW_COLUMN', kind: 'string' as const, length: 10 }];
  const built = buildNyRelease({ rollYear: 2025, build: '2605', rows: baseRows(), fields });
  w.publisher.publish(built, { serviceFields: nyServiceFields(fields) });
  const live = await w.run();
  assert.equal(live.outcome, 'FAILED');
  assert.equal(live.run, null, 'the live run is stopped by the cross-check, before the runtime');
  const replay = await replayNyFromArchive({
    registry: defaultRegistry(), artifactStore: w.h.artifactStore, contactPlane: w.h.contactPlane, varRoot: w.h.varRoot,
    clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger,
    publisherSha256: built.sha256, referencePeriod: '2025-2605', batch: { sortChunkLines: 4 },
  });
  assert.equal(replay.crossCheck, null, 'no witness in a replay');
  assert.equal(replay.outcome, 'FAILED');
  assert.equal(replay.run?.run.status, 'quarantined');
  assert.equal(replay.run?.run.failureKind, 'SCHEMA_DRIFT');
  assert.equal(replay.run?.run.metrics.rowsParsed, 0, 'refused from the header');
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
});

test('a truncated smoke run activates nothing and never counts as an ingestion', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  w.publisher.publishPolygons(buildNyPolygonRelease(2025, '2605'));
  const smoke = await w.run({ maxRows: 3 });
  assert.equal(smoke.outcome, 'TRUNCATED_SMOKE_RUN', 'never reported as an ingestion');
  assert.equal(smoke.ledger?.action, 'TRUNCATED_SMOKE_RUN');
  assert.equal(smoke.derivation?.rowsWritten, 3);
  assert.equal(smoke.companion, null, 'a smoke run retains no polygons');
  assert.equal(w.publisher.requests.filter((r) => r.url.includes('NYS-Tax-Parcels.zip')).length, 0, 'nor even asks about them');
  assert.deepEqual(await createPartitionStore(w.h.varRoot).manifests(), []);
  assert.equal((await w.run({ discoverOnly: true })).plan?.action, 'ACQUIRE');
});

test('a run that will not retain the polygons sends no request for them', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  w.publisher.publishPolygons(buildNyPolygonRelease(2025, '2605'));
  const result = await w.run({ retainCompanion: false });
  assert.equal(result.outcome, 'INGESTED');
  assert.equal(result.companion?.status, 'SKIPPED');
  assert.equal(result.discovered?.companion, null);
  assert.equal(result.discovered?.companionError, null);
  assert.equal(w.publisher.requests.filter((r) => r.url.includes('NYS-Tax-Parcels')).length, 0);
});

test('the polygon companion is retained as raw evidence, once, and never ingested', async () => {
  const { result, h, publisher } = await ingestedBase();
  const polygons = buildNyPolygonRelease(2025, '2605');
  assert.equal(result.companion?.status, 'RETAINED');
  assert.equal(result.companion?.sha256, polygons.sha256);
  assert.equal(result.companion?.referencePeriod, '2025-2605');
  const retained = readdirSync(join(h.root, 'archive'), { recursive: true }).map(String)
    .filter((p) => p.includes(NY_POLYGON_SOURCE_ID) && p.endsWith('source-original.zip'));
  assert.equal(retained.length, 1);
  assert.ok(!(await bundlesOf(h.varRoot)).some((b) => (b['transaction'] as Row)['sourceId'] === NY_POLYGON_SOURCE_ID));
  assert.equal(publisher.archiveGets('https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels.zip'), 1);
});

test('a missing polygon archive is reported and never blocks the canonical ingest', async () => {
  const w = harness();
  w.publisher.publish(release(baseRows()));
  const result = await w.run();
  assert.equal(result.outcome, 'INGESTED');
  // Linked but not served: a recorded failure, not a silent "not linked".
  assert.equal(result.companion?.status, 'FAILED');
  assert.match(result.companion?.note ?? '', /polygon archive discovery failed/);
});

// ===========================================================================
// 7. Idempotency, replay
// ===========================================================================

test('forcing the same release again: no new, no lost, no revised, same ids and digests', async () => {
  const w = await ingestedBase();
  const again = await w.run({ mode: 'force' });
  assert.equal(w.publisher.archiveGets(NY_CENTROID_ARCHIVE_URL), 1, 'a forced re-ingest reads the retained archive');
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

test('replay from the retained archive, with no fetch at all, reproduces every digest and the bundle bytes', async () => {
  const w = await ingestedBase();
  const original = w.result;
  const store = createPartitionStore(w.h.varRoot);
  const partitionsBefore = (await store.manifests()).map((m) => [m.partitionId, m.inputDigest, m.outputDigest]);
  const idsBefore = nyBundles(await bundlesOf(w.h.varRoot)).map((b) => (b['properties'] as Row[])[0]?.['propertyId']).sort();

  for (const dir of ['derived', 'restricted', 'indexes', 'checkpoints', 'acquisition']) {
    await rm(join(w.h.varRoot, dir), { recursive: true, force: true });
  }
  await rm(join(w.h.root, 'archive', 'data-fabric', NY_STATEWIDE_SOURCE_ID, '2025-2605',
    `sha256-${original.bundleArtifact!.sha256}`), { recursive: true, force: true });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network used during replay'); }) as typeof fetch;
  try {
    const replay = await replayNyFromArchive({
      registry: defaultRegistry(), artifactStore: w.h.artifactStore, contactPlane: w.h.contactPlane,
      varRoot: w.h.varRoot, clock: fixedClock('2031-01-01T00:00:00.000Z'), logger: captureLogger().logger,
      publisherSha256: original.publisherArtifact!.sha256, referencePeriod: '2025-2605', batch: { sortChunkLines: 4 },
    });
    assert.equal(replay.publisherArtifact!.sha256, original.publisherArtifact!.sha256);
    assert.equal(replay.bundleArtifact!.sha256, original.bundleArtifact!.sha256, 'the bundle is byte-identical');
    assert.equal(replay.run!.run.runId, original.run!.run.runId);
    assert.equal(replay.run!.run.normalizedDigest, original.run!.run.normalizedDigest);
    assert.equal(replay.run!.globalDigest, original.run!.globalDigest);
    assert.deepEqual((await store.manifests()).map((m) => [m.partitionId, m.inputDigest, m.outputDigest]), partitionsBefore);
    assert.deepEqual(nyBundles(await bundlesOf(w.h.varRoot)).map((b) => (b['properties'] as Row[])[0]?.['propertyId']).sort(), idsBefore);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the duplicate keeps its first row: the second copy never reaches the estate', async () => {
  const { h } = await ingestedBase();
  const owners = nyBundles(await bundlesOf(h.varRoot)).flatMap((b) => (b['parties'] as Row[]).map((p) => p['rawName']));
  assert.ok(!owners.includes('SECOND COPY'));
});

// ===========================================================================
// 8. A release that changes: only what moved is recomputed
// ===========================================================================

test('next release: A new, B value, C owner, D missing, E reappears — only those partitions rewrite', async () => {
  const w = harness();
  const a1 = nyParcel('Albany', '010100', SBL_A);
  const a2 = nyParcel('Albany', '010100', '00100000010030000000');
  const b1 = nyParcel('Erie', '140100', '11100000010010000000');
  const c1 = nyParcel('Monroe', '260100', '12000000010010000000');
  const d1 = nyParcel('Nassau', '280200', '04500000010010000000');
  const d2 = nyParcel('Nassau', '280200', '04500000010020000000');
  const e1 = nyParcel('Suffolk', '472089', '02000000010000100000');
  const e2 = nyParcel('Suffolk', '472089', '02000000010000200000');
  const f1 = nyParcel('Kings', '610100', '3012340056');

  w.publisher.publish(release([a1, b1, c1, d1, d2, e1, e2, f1]));
  const first = await w.run();
  assert.equal(first.run!.changeCounts.new_parcel_observed, 8);

  // Row order changes too, so every OBJECTID and ORIG_FID moves: volatile ids
  // must not read as revisions.
  const r2 = [
    { ...f1, ORIG_FID: 999 }, a1, a2, { ...b1, TOTAL_AV: 250000 }, { ...c1, PRIMARY_OWNER: 'TEST NEW OWNER' }, d1, e1,
  ];
  w.publisher.publish(release(r2, '2606'), { publication: 'June 2026' });
  const second = await w.run();
  const c = second.run!.changeCounts;
  assert.equal(c.new_parcel_observed, 1, 'A');
  assert.equal(c.parcel_attributes_changed, 2, 'B value and C owner');
  assert.equal(c.parcel_missing_from_latest_source, 2, 'D, and E ahead of its return');
  assert.equal(c.parcel_reappeared, 0);
  assert.equal(c.unchanged_parcel, 4);
  const activated = (r: typeof second) => r.run!.activations
    .filter((a) => a.state === 'activated' && a.partitionId.startsWith('property/')).map((a) => a.partitionId).sort();
  assert.deepEqual(activated(second), [ALBANY, ERIE, MONROE, NASSAU, SUFFOLK].map((f) => `property/us-county-${f}`));
  assert.deepEqual(second.run!.skippedPartitions, [`property/us-county-${KINGS}`]);

  w.publisher.publish(release([...r2, e2], '2607'), { publication: 'July 2026' });
  const third = await w.run();
  assert.equal(third.run!.changeCounts.parcel_reappeared, 1, 'E: seen, dropped, back');
  assert.equal(third.run!.changeCounts.parcel_missing_from_latest_source, 0);
  assert.deepEqual(activated(third), [`property/us-county-${SUFFOLK}`]);
  assert.deepEqual(third.run!.skippedPartitions, [ALBANY, ERIE, KINGS, MONROE, NASSAU].map((f) => `property/us-county-${f}`));
});

// ===========================================================================
// 9. Cross-state isolation and identity
// ===========================================================================

test('ingesting New York writes nothing in another state\'s partitions or indexes', async () => {
  const h = streamHarness();
  const wi = wiFakePublisher();
  wi.publish(buildWiRelease({ version: { major: 12, minor: 0, patch: 0, year: 2026 }, rows: [
    wiParcel('DANE', '0608-123-4567-0'), wiParcel('ADAMS', '008002310010'),
    // The same string New York uses for a parcel number, in Wisconsin.
    wiParcel('ADAMS', `010100${SBL_A}`),
  ] }));
  const wiResult = await runWiStatewidePipeline({
    registry: defaultRegistry(), artifactStore: h.artifactStore, contactPlane: h.contactPlane, varRoot: h.varRoot,
    clock: fixedClock(RUN_INSTANT), logger: captureLogger().logger, http: { fetchImpl: wi.fetchImpl, sleep: async () => {} },
    batch: { sortChunkLines: 4 },
  });
  assert.equal(wiResult.outcome, 'INGESTED');
  const wiDirs = ['55001', '55025'].map((f) => join(h.varRoot, 'derived', 'partitions', 'property', `us-county-${f}`));
  const wiIndexes = join(h.varRoot, 'indexes');
  const before = [...wiDirs.flatMap(filesUnder), ...filesUnder(wiIndexes).filter((f) => f.includes('wi_statewide'))];
  const manifestsBefore = (await createPartitionStore(h.varRoot).manifests()).filter((m) => m.partitionId.includes('us-county-55'));

  const w = harness({}, h);
  w.publisher.publish(release(baseRows()));
  const ny = await w.run();
  assert.equal(ny.outcome, 'INGESTED');
  assert.ok(!ny.run!.partitionPlan.partitions.some((p) => p.includes('us-county-55')), 'no Wisconsin partition in the plan');

  const after = [...wiDirs.flatMap(filesUnder), ...filesUnder(wiIndexes).filter((f) => f.includes('wi_statewide'))];
  assert.deepEqual(after, before, 'every Wisconsin partition and index file: same bytes, same mtime');
  const manifestsAfter = (await createPartitionStore(h.varRoot).manifests()).filter((m) => m.partitionId.includes('us-county-55'));
  assert.deepEqual(manifestsAfter, manifestsBefore);
  // The estate digest is built from child digests across both states.
  const all = await createPartitionStore(h.varRoot).manifests();
  assert.ok(all.some((m) => m.partitionId.includes('us-county-55')) && all.some((m) => m.partitionId.includes('us-county-36')));
  assert.notEqual(ny.run!.globalDigest, wiResult.run!.globalDigest);

  // The same string as a parcel number in both states is two properties.
  const ids = new Map<string, Set<string>>();
  for (const b of await bundlesOf(h.varRoot)) {
    const id = (b['propertyIdentifiers'] as Row[]).find((i) => i['identifierType'] === 'county_parcel');
    if (!id) continue;
    const key = String(id['normalizedValue']);
    ids.set(key, (ids.get(key) ?? new Set()).add(String(id['propertyId'])));
  }
  assert.equal(ids.get(`010100${SBL_A}`)?.size, 2, 'Wisconsin\'s and New York\'s are distinct properties');
});

// ===========================================================================
// 10. Security
// ===========================================================================

test('no mailing string reaches the derived plane, compressed or not; it is in the restricted plane', async () => {
  const { h } = await ingestedBase();
  const read = (p: string) => (p.endsWith('.gz') ? gunzipSync(readFileSync(p)) : readFileSync(p)).toString('utf8');
  const all = (dir: string) => readdirSync(dir, { recursive: true }).map(String).map((f) => join(dir, f)).filter((p) => statSync(p).isFile());
  const derived = all(join(h.varRoot, 'derived')).filter((p) => /\.ndjson(\.gz)?$/.test(p));
  assert.ok(derived.length > 0);
  for (const p of derived) assert.ok(!read(p).includes('INVENTED WAY'), `${p} carries a mailing address`);
  const restricted = all(join(h.varRoot, 'restricted')).filter((p) => /\.ndjson(\.gz)?$/.test(p));
  assert.ok(restricted.some((p) => read(p).includes('INVENTED WAY')), 'the restricted plane holds them');
});

// ===========================================================================
// 11. A durable store: the execution machine is disposable
// ===========================================================================

function durableStore(): DurableStore {
  return {
    backend: createLocalBackend(tempRoot('df-ny-durable-'), { durable: true }),
    prefix: `p${Date.now()}${Math.random().toString(36).slice(2)}`,
    required: true,
  };
}

test('the archive is durable and registered before activation; a fresh worker never asks the publisher for it', async () => {
  const durable = durableStore();
  const first = harness();
  first.publisher.publish(release(baseRows()));
  const a = await first.run({ durable });
  assert.equal(a.outcome, 'INGESTED');
  assert.deepEqual(a.durability?.commit?.phases.map((p) => p.phase), ['STAGING', 'HASH_VERIFIED', 'DURABLE', 'REGISTERED']);
  assert.equal(a.durability?.commit?.verifiedByReread, true);
  assert.equal(a.durability?.releaseRegistered, true);
  assert.ok(a.durability?.receiptKey, 'a durable run receipt exists');
  assert.equal((await durable.backend.head(artifactKey(durable.prefix, a.publisherArtifact!.sha256)))?.bytes, a.publisherArtifact!.byteLength);
  assert.ok(await findRelease(durable, NY_STATEWIDE_SOURCE_ID, '2025-2605', a.discovered!.releaseFingerprint));

  // Another worker: its own var root and artifact store, nothing shared but the
  // durable store and the publisher.
  const second = harness();
  second.publisher.publish(release(baseRows()));
  const b = await second.run({ durable });
  assert.equal(b.outcome, 'INGESTED');
  assert.equal(second.publisher.archiveGets(NY_CENTROID_ARCHIVE_URL), 0, 'rehydrated, not re-downloaded');
  assert.equal(b.durability?.source, 'durable_store');
  assert.equal(b.ledger?.action, 'REHYDRATED_AND_INGESTED');
  assert.equal(b.bundleArtifact?.sha256, a.bundleArtifact?.sha256);
  assert.equal(b.run!.run.runId, a.run!.run.runId);
  assert.equal(b.run!.run.normalizedDigest, a.run!.run.normalizedDigest);
  assert.equal(b.run!.globalDigest, a.run!.globalDigest);
});

test('publisher-off replay on a fresh worker, from the durable store alone', async () => {
  const durable = durableStore();
  const first = harness();
  first.publisher.publish(release(baseRows()));
  const a = await first.run({ durable });
  const fresh = streamHarness();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network used during replay'); }) as typeof fetch;
  try {
    const replay = await replayNyFromArchive({
      registry: defaultRegistry(), artifactStore: fresh.artifactStore, contactPlane: fresh.contactPlane, varRoot: fresh.varRoot,
      clock: fixedClock('2031-01-01T00:00:00.000Z'), logger: captureLogger().logger, durable,
      publisherSha256: a.publisherArtifact!.sha256, referencePeriod: '2025-2605', batch: { sortChunkLines: 4 },
    });
    assert.equal(replay.outcome, 'INGESTED');
    assert.equal(replay.durability?.source, 'durable_store');
    assert.equal(replay.durability?.commit, null, 'a replay reads the durable store and never writes it');
    assert.equal(replay.bundleArtifact?.sha256, a.bundleArtifact?.sha256);
    assert.equal(replay.run!.run.runId, a.run!.run.runId);
    assert.equal(replay.run!.run.normalizedDigest, a.run!.run.normalizedDigest);
    assert.equal(replay.run!.globalDigest, a.run!.globalDigest);
  } finally {
    globalThis.fetch = realFetch;
  }
});
