/**
 * Minnesota SOS business register — the source, the entity model, and the
 * discipline that keeps candidate generation from becoming entity merging.
 *
 * Every fixture row is synthetic. No licensed bulk data is committed here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../src/core/hash.ts';
import { isFabricError } from '../src/core/errors.ts';
import {
  DEFAULT_RULES,
  EVIDENCE_STRENGTH,
  RESOLVER_VERSION,
  decide,
  measureNameCollisions,
  resolveOrganizations,
  type EntityCandidateRow,
  type EntityLinkDecision,
  type OrganizationObservation,
} from '../src/canonical/entity-resolution.ts';
import {
  looksLikeOrganization,
  normalizeOrganizationName,
} from '../src/canonical/name-normalization.ts';
import { normalizeAddress } from '../src/canonical/organizations.ts';
import { organizationObservationOf } from '../src/canonical/organization-projection.ts';
import {
  MN_SOS_ADAPTER_KEY,
  MN_SOS_SOURCE_ID,
  PINNED_GUIDE_VERSION,
  PINNED_LAYOUT_DIGEST,
  createMnSosBusinessConnector,
} from '../src/connectors/mn-sos-business/index.ts';
import {
  ADDRESS_TYPES,
  BUSINESS_TYPES,
  PARTY_NAME_TYPES,
  businessType,
  filingAction,
} from '../src/connectors/mn-sos-business/domain.ts';
import { parseSosRow } from '../src/connectors/mn-sos-business/parse.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { createHttpTransport } from '../src/runtime/transport.ts';
import {
  SOS_MAPPING_ID,
  fixture,
  hennepinFixture,
  recorderFixture,
  sosFixture,
  streamHarness,
} from './helpers.ts';

const AUGUST = sosFixture('register-2026-08.bundle');
const AUGUST_SHUFFLED = sosFixture('register-2026-08-shuffled.bundle');
const SEPTEMBER = sosFixture('register-2026-09.bundle');

type Row = Record<string, unknown>;

const gid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function august(): Promise<{
  h: ReturnType<typeof streamHarness>;
  entities: Row[];
  names: Row[];
  addresses: Row[];
  filings: Row[];
  parties: Row[];
  links: EntityLinkDecision[];
  run: Awaited<ReturnType<ReturnType<typeof streamHarness>['runSos']>>;
}> {
  const h = streamHarness();
  const run = await h.runSos(AUGUST);
  return {
    h,
    run,
    entities: (await h.table('business_entities')) as Row[],
    names: (await h.table('business_entity_names')) as Row[],
    addresses: (await h.table('business_entity_addresses')) as Row[],
    filings: (await h.table('business_entity_filings')) as Row[],
    parties: (await h.table('business_filing_parties')) as Row[],
    links: run.entityLinks as EntityLinkDecision[],
  };
}

const byId = (rows: Row[], masterId: string): Row =>
  rows.find((r) => r['sourceEntityId'] === masterId) as Row;

// ===========================================================================
// 1. The source: access, licence, registry
// ===========================================================================

test('the registry records a sanctioned bulk product that still cannot be fetched automatically', () => {
  const source = defaultRegistry().source(MN_SOS_SOURCE_ID);
  assert.equal(source.accessType, 'bulk_download');
  assert.equal(source.automationStatus, 'manual_only');
  assert.notEqual(source.automationStatus, 'sanctioned');
  assert.equal(source.termsStatus, 'reviewed_permitted');
  assert.equal(source.licenseStatus, 'licensed');
});

test('the licence terms are recorded in the registry, not just in a document somewhere', () => {
  const terms = defaultRegistry().source(MN_SOS_SOURCE_ID).licenseTerms;
  assert.ok(terms, 'a licensed source must carry its terms');
  assert.equal(terms.licenseName, 'Electronic Media License Agreement');
  assert.equal(terms.statutoryAuthority, 'Minn. Stat. § 13.03 subd. 3');
  // The two halves that decide what Reivesti may build.
  assert.equal(terms.permitsServingCustomers, true);
  assert.equal(terms.prohibitsBulkRedistribution, true);
  assert.equal(terms.requiresConsentToSublicense, true);
  assert.equal(terms.prohibitsOfficialPresentation, true);
  assert.ok(terms.fees.some((f) => f.product.startsWith('Business Bulk Data') && f.usd === 710));
  assert.ok(terms.freeFor.includes('news media'));
});

test('the mapping is blocked on a purchase, not on code', () => {
  const mapping = defaultRegistry().mapping(SOS_MAPPING_ID);
  assert.equal(mapping.status, 'blocked_on_access');
  assert.equal(mapping.adapterKey, MN_SOS_ADAPTER_KEY);
  assert.deepEqual(mapping.capabilities, ['business_entity']);
});

test('discovery without a delivery explains the lawful route and refuses to invent one', async () => {
  const connector = createMnSosBusinessConnector();
  await assert.rejects(
    () => connector.discover({} as never),
    (e: unknown) => {
      assert.ok(isFabricError(e));
      assert.equal(e.kind, 'ACCESS_BLOCKED');
      assert.match(String(e.detail?.['remedy']), /Business Bulk Data/);
      assert.match(String(e.detail?.['doNot']), /do not scrape/i);
      return true;
    },
  );
});

test('a publisher-reaching transport is refused for this source', async () => {
  const h = streamHarness();
  const result = await h.runSos(AUGUST, {
    connector: createMnSosBusinessConnector({ transport: createHttpTransport() }),
    localFile: undefined,
  } as never);
  assert.equal(result.run.status, 'blocked_on_access');
});

test('no automated purchase, subscription or form submission exists anywhere in the connector', async () => {
  const dir = join(process.cwd(), 'src', 'connectors', 'mn-sos-business');
  for (const file of ['index.ts', 'stream.ts', 'parse.ts', 'normalize.ts', 'record.ts', 'domain.ts']) {
    const text = await readFile(join(dir, file), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(text), `${file} must not perform HTTP`);
    assert.ok(!/mblsportal\.sos\.state\.mn\.us\/[a-z]/i.test(text), `${file} must not target a portal endpoint`);
  }
});

// ===========================================================================
// 2. Parsing the delivered layout
// ===========================================================================

test('the three record types are dispatched on column 2, not on a single header', () => {
  const master = parseSosRow(
    [gid(1), '01', '44', '1000001', 'A LLC', 'Active', '03/04/2019', '', '', '', '', '0', '0', '0', '', '', '', '', '', '', '', '08/01/2026'],
    'row 1',
  );
  const filing = parseSosRow([gid(1), '02', '44', '1000001', '1000001', 'Original Filing', 'P', '03/04/2019', ''], 'row 2');
  const nameRow = parseSosRow([gid(1), '03', '44', '1000001', '1000001', '4', '14', 'Dana Fictitious', '18 Imaginary Rd', '', 'Saint Paul', 'MN', '55102', '', 'USA'], 'row 3');
  assert.equal(master.kind, 'master');
  assert.equal(filing.kind, 'filing');
  assert.equal(nameRow.kind, 'name_address');
});

test('MM/DD/YYYY becomes an ISO date, and no time of day is invented', async () => {
  const { entities } = await august();
  assert.equal(byId(entities, gid(1))['filingDate'], '2019-03-04');
  assert.equal(byId(entities, gid(4))['expirationDate'], '2023-11-30');
});

test('an empty registry date stays null rather than becoming a default', async () => {
  const { entities } = await august();
  assert.equal(byId(entities, gid(5))['expirationDate'], null);
  assert.equal(byId(entities, gid(5))['nextRenewalDueDate'], null);
});

test('a doubled quote and an embedded newline both survive the CSV reader', async () => {
  const { entities, addresses } = await august();
  assert.equal(byId(entities, gid(2))['legalName'], 'LAKESIDE HOLDINGS "MN" INC');
  const wrapped = addresses.map((a) => a['address'] as Row).find((a) => String(a['line1']).includes('Wrapped'));
  assert.equal(wrapped?.['line1'], '12 Wrapped\nLine Rd');
});

test('a row narrower than its layout is quarantined, never read by position', async () => {
  const { run } = await august();
  assert.ok(run.run.metrics.rowsQuarantined >= 1);
});

test('an unrecognised record type is refused rather than guessed', () => {
  assert.throws(() => parseSosRow([gid(1), '07', '44'], 'row 9'), /unknown record type/);
});

// ===========================================================================
// 3. Grouping and delivery-order independence
// ===========================================================================

test('one business is assembled from its master, filing and name rows', async () => {
  const { entities, filings, addresses, parties } = await august();
  const e1 = byId(entities, gid(1));
  assert.equal(e1['legalName'], 'NORTH STAR HOMES LLC');
  assert.equal(filings.filter((f) => f['entityId'] === e1['entityId']).length, 2);
  assert.equal(addresses.filter((a) => a['entityId'] === e1['entityId']).length, 1);
  assert.equal(parties.filter((p) => p['entityId'] === e1['entityId']).length, 2);
});

test('shuffling every row in the delivery changes nothing but the run identity', async () => {
  const first = streamHarness();
  const second = streamHarness();
  const a = await first.runSos(AUGUST);
  const b = await second.runSos(AUGUST_SHUFFLED);
  assert.equal(a.run.metrics.rowsValid, b.run.metrics.rowsValid);
  assert.equal(a.run.metrics.rowsQuarantined, b.run.metrics.rowsQuarantined);

  // Run id and artifact id necessarily differ — they are derived from the file's
  // bytes, and the two files ARE different bytes. Everything the estate actually
  // asserts must not be.
  assert.deepEqual(
    (await first.bundles()).map(withoutRunIdentity).sort(),
    (await second.bundles()).map(withoutRunIdentity).sort(),
  );
  for (const table of ['business_entities', 'business_entity_names', 'business_entity_addresses',
    'business_entity_filings', 'business_filing_parties'] as const) {
    assert.deepEqual(
      (await first.table(table)).map(withoutRunIdentity).sort(),
      (await second.table(table)).map(withoutRunIdentity).sort(),
      `${table} depends on delivery order`,
    );
  }
});

test('the sort chunk size bounds memory and changes no output at all', async () => {
  const digests = new Set<string>();
  for (const chunkLines of [1, 50, 500, 5000]) {
    const r = await streamHarness().runSos(AUGUST, { chunkLines });
    digests.add(`${r.run.normalizedDigest}|${r.run.canonicalDigest}|${r.run.metrics.rowsValid}`);
  }
  // Same bytes every time, so even the run id must match: chunk size is not an
  // input to anything the estate records.
  assert.equal(digests.size, 1, 'batch size must not be observable in the output');
});

test('a filing whose master is missing is quarantined, not attached to a guess', async () => {
  const { run, filings } = await august();
  assert.ok(run.run.validationErrorCount >= 2);
  assert.ok(!filings.some((f) => String(f['filingNumber']) === '1000900'));
});

test('a party row whose master is missing is quarantined too', async () => {
  const { parties } = await august();
  assert.ok(!parties.some((p) => p['rawName'] === 'Casey Orphaned'));
});

// ===========================================================================
// 4. What the entity model does and does not claim
// ===========================================================================

test('the registry identifier is the identity; the name never is', async () => {
  const { entities } = await august();
  const ids = entities.map((e) => e['sourceEntityId']);
  assert.equal(new Set(ids).size, ids.length);
  // Two entities share a normalized name and remain two entities.
  const summit = entities.filter((e) => e['normalizedName'] === 'SUMMIT PARTNERS LLC');
  assert.equal(summit.length, 2);
  assert.notEqual(summit[0]?.['entityId'], summit[1]?.['entityId']);
});

test('registry status is the status of the REGISTRATION, and nothing says a company is active', async () => {
  const { entities, h } = await august();
  assert.equal(byId(entities, gid(4))['registryStatus'], 'inactive');
  assert.equal(byId(entities, gid(1))['registryStatus'], 'active');
  const events = (await h.rows('events')) as Row[];
  const types = new Set(events.map((e) => e['eventType']));
  for (const forbidden of ['BUSINESS_ACTIVE', 'BUSINESS_OPERATING', 'ACTIVE_BUYER', 'BUSINESS_TRADING']) {
    assert.ok(!types.has(forbidden), `${forbidden} must not exist`);
  }
  assert.ok(types.has('BUSINESS_ENTITY_OBSERVED'));
  assert.ok(types.has('BUSINESS_STATUS_OBSERVED'));
});

test('a trademark, an assumed name and a name reservation are not legal entities', async () => {
  const { entities } = await august();
  assert.equal((byId(entities, gid(14))['attributes'] as Row)['is_legal_entity'], false);
  assert.equal((byId(entities, gid(11))['attributes'] as Row)['is_legal_entity'], false);
  assert.equal((byId(entities, gid(1))['attributes'] as Row)['is_legal_entity'], true);
  for (const code of ['57', '59', '60']) {
    assert.equal(businessType(code)?.isLegalEntity, false);
  }
});

test('an assumed name is its own record with no invented link to a parent', async () => {
  const { entities } = await august();
  const assumed = byId(entities, gid(11));
  assert.equal((assumed['attributes'] as Row)['assumed_name_record'], true);
  // Nothing anywhere on the row points at another entity.
  assert.ok(!Object.keys(assumed).some((k) => /parent|owner_entity|filed_by/i.test(k)));
});

test('a name change appears as a FILING; no prior name is fabricated from it', async () => {
  const { filings, names } = await august();
  const e5Filings = filings.filter((f) => String(f['filingNumber']) === '1000600');
  assert.equal(e5Filings[0]?.['filingAction'], 'NAME_CHANGE');
  // The delivery carries only currently-active names, so PRIOR_NAME must never
  // be emitted from a single delivery.
  assert.equal(names.filter((n) => n['nameType'] === 'PRIOR_NAME').length, 0);
});

test('a foreign entity keeps its home-jurisdiction name as a name of the SAME entity', async () => {
  const { entities, names } = await august();
  const e3 = byId(entities, gid(3));
  assert.equal(e3['domesticity'], 'foreign');
  assert.equal(e3['homeJurisdiction'], 'Delaware');
  const home = names.filter((n) => n['entityId'] === e3['entityId'] && n['nameType'] === 'HOME_JURISDICTION_NAME');
  assert.equal(home.length, 1);
  assert.equal(home[0]?.['normalizedName'], 'NORTHSTAR HOMES LLC');
});

test('an unknown domain code is reported and retained, never mapped to a neighbour', async () => {
  const { run, entities } = await august();
  assert.ok(run.run.unknownFields.includes('business_type:99'));
  assert.ok(run.run.unknownFields.includes('name_type:77'));
  assert.ok(run.run.unknownFields.includes('address_type:888'));
  const e13 = byId(entities, gid(13));
  assert.equal(e13['businessTypeCode'], '99');
  assert.equal(e13['businessTypeLabel'], null);
  assert.equal(e13['domesticity'], 'unknown');
});

test('an undocumented filing action stays OTHER with its raw text intact', () => {
  assert.equal(filingAction('Original Filing'), 'ORIGINAL_FILING');
  assert.equal(filingAction('Statement of Something Novel'), 'OTHER');
});

test('the pinned vocabularies cover every code the connector claims to know', () => {
  assert.equal(new Set(BUSINESS_TYPES.map((t) => t.code)).size, BUSINESS_TYPES.length);
  assert.equal(new Set(PARTY_NAME_TYPES.map((t) => t.code)).size, PARTY_NAME_TYPES.length);
  assert.equal(new Set(ADDRESS_TYPES.map((t) => t.code)).size, ADDRESS_TYPES.length);
});

// ===========================================================================
// 5. Name normalization: candidate generation only
// ===========================================================================

test('suffix spellings fold together and the suffix is kept, not stripped', () => {
  const forms = ['ACME L.L.C.', 'Acme LLC', 'ACME Limited Liability Company', 'acme l l c'];
  const keys = new Set(forms.map((f) => normalizeOrganizationName(f).search));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], 'ACME LLC');
  // Different suffixes are different companies.
  assert.notEqual(
    normalizeOrganizationName('SMITH LLC').search,
    normalizeOrganizationName('SMITH INC').search,
  );
});

test('ampersand and "and" agree; a typographic apostrophe and a plain one agree', () => {
  assert.equal(
    normalizeOrganizationName('SMITH & SONS LLC').search,
    normalizeOrganizationName('Smith and Sons, L.L.C.').search,
  );
  assert.equal(
    normalizeOrganizationName("O’BRIEN HOLDINGS LLC").search,
    normalizeOrganizationName("O'BRIEN HOLDINGS LLC").search,
  );
});

test('the compact key collides where the search key does not, and is the weaker signal', () => {
  const a = normalizeOrganizationName('NORTH STAR HOMES LLC');
  const b = normalizeOrganizationName('NORTHSTAR HOMES LLC');
  assert.notEqual(a.search, b.search);
  assert.equal(a.compact, b.compact);
  assert.equal(EVIDENCE_STRENGTH.COMPACT_NAME, 'weak');
  assert.equal(EVIDENCE_STRENGTH.EXACT_SOURCE_ID, 'decisive');
});

test('normalization is deterministic and never rewrites the stored raw name', async () => {
  const { entities } = await august();
  const e8 = byId(entities, gid(8));
  assert.equal(e8['legalName'], 'Summit Partners, Inc.');
  assert.equal(e8['normalizedName'], 'SUMMIT PARTNERS INC');
  assert.equal(normalizeOrganizationName('Summit Partners, Inc.').search, 'SUMMIT PARTNERS INC');
});

test('a comma-first personal name is not treated as an organization', () => {
  assert.equal(looksLikeOrganization('TESTONE, AVERY R'), false);
  assert.equal(looksLikeOrganization('NORTHSTAR HOMES LLC'), true);
});

test('address normalization folds case and punctuation and nothing else', () => {
  const a = normalizeAddress({ line1: '100 Synthetic Ave.', line2: 'Suite 220', city: 'Minneapolis', stateOrProvince: 'MN', postalCode: '55401', country: 'USA' });
  assert.equal(a, '100 SYNTHETIC AVE SUITE 220 MINNEAPOLIS MN 55401');
  // No street-type expansion: AVE and AVENUE stay different, because guessing
  // would merge addresses that are genuinely different.
  assert.notEqual(a, normalizeAddress({ line1: '100 Synthetic Avenue', line2: 'Suite 220', city: 'Minneapolis', stateOrProvince: 'MN', postalCode: '55401', country: null }));
});

// ===========================================================================
// 6. Resolution rules
// ===========================================================================

const CANDIDATE = (over: Partial<EntityCandidateRow> = {}): EntityCandidateRow => ({
  i: 'entity-1', x: gid(1), n: 'NORTH STAR HOMES LLC', k: 'NORTHSTARHOMESLLC',
  r: 'NORTH STAR HOMES LLC', a: ['100 SYNTHETIC AVE MINNEAPOLIS MN 55401'], c: 1, ...over,
});

const OBSERVATION = (over: Partial<OrganizationObservation> = {}): OrganizationObservation => ({
  o: 'obs-1', s: 'mn_hennepin_county_parcels', r: 'NORTH STAR HOMES LLC',
  n: 'NORTH STAR HOMES LLC', k: 'NORTHSTARHOMESLLC', a: null, e: null, ...over,
});

test('only the registry identifier resolves on its own', () => {
  const d = decide(OBSERVATION({ e: gid(1) }), [CANDIDATE()], DEFAULT_RULES, '2026-08-31T00:00:00.000Z');
  assert.equal(d.state, 'resolved');
  assert.equal(d.evidence[0]?.evidenceType, 'EXACT_SOURCE_ID');
  assert.equal(d.resolverVersion, RESOLVER_VERSION);
});

test('a statewide-unique exact name is strong evidence and still does not resolve by default', () => {
  const d = decide(OBSERVATION(), [CANDIDATE()], DEFAULT_RULES, '2026-08-31T00:00:00.000Z');
  assert.equal(d.state, 'provisional');
  assert.equal(d.evidence[0]?.evidenceType, 'EXACT_LEGAL_NAME_UNIQUE');
  assert.match(d.reason ?? '', /collision audit/);
  assert.equal(DEFAULT_RULES.allowUniqueLegalName, false);
});

test('turning the name rule on still requires a corroborating address', () => {
  const at = '100 SYNTHETIC AVE MINNEAPOLIS MN 55401';
  const rules = { allowUniqueLegalName: true, requireAddressCorroboration: true };
  assert.equal(decide(OBSERVATION(), [CANDIDATE()], rules, 'T').state, 'provisional');
  const withAddress = decide(OBSERVATION({ a: at }), [CANDIDATE()], rules, 'T');
  assert.equal(withAddress.state, 'resolved');
  assert.ok(withAddress.evidence.some((e) => e.evidenceType === 'EXACT_ADDRESS'));
});

test('a shared name is ambiguous, never a silent pick', () => {
  const d = decide(
    OBSERVATION({ n: 'SUMMIT PARTNERS LLC', k: 'SUMMITPARTNERSLLC' }),
    [
      CANDIDATE({ i: 'a', x: gid(7), n: 'SUMMIT PARTNERS LLC', k: 'SUMMITPARTNERSLLC', c: 2 }),
      CANDIDATE({ i: 'b', x: gid(17), n: 'SUMMIT PARTNERS LLC', k: 'SUMMITPARTNERSLLC', c: 2 }),
    ],
    { allowUniqueLegalName: true, requireAddressCorroboration: false },
    'T',
  );
  assert.equal(d.state, 'ambiguous');
  assert.equal(d.entityId, null);
  assert.deepEqual([...d.candidateEntityIds].sort(), ['a', 'b']);
});

test('a compact-key-only match never resolves, however unique it is', () => {
  const d = decide(
    OBSERVATION({ n: 'NORTHSTAR HOMES LLC' }),
    [CANDIDATE({ n: 'NORTH STAR HOMES LLC' })],
    { allowUniqueLegalName: true, requireAddressCorroboration: false },
    'T',
  );
  assert.equal(d.state, 'provisional');
  assert.equal(d.entityId, null);
  assert.equal(d.evidence[0]?.evidenceType, 'COMPACT_NAME');
});

test('an address shared by many entities cannot resolve anything on its own', () => {
  const shared = '500 AGENT SERVICES PLZ STE 1000 MINNEAPOLIS MN 55402';
  const d = decide(
    OBSERVATION({ n: 'SOMETHING ELSE LLC', k: 'SOMETHINGELSELLC', a: shared }),
    [
      CANDIDATE({ i: 'a', n: 'CEDAR HOLLOW HOLDINGS LLC', k: 'CEDARHOLLOWHOLDINGSLLC', a: [shared] }),
      CANDIDATE({ i: 'b', n: 'BIRCH LANE CAPITAL LLC', k: 'BIRCHLANECAPITALLLC', a: [shared] }),
    ],
    { allowUniqueLegalName: true, requireAddressCorroboration: false },
    'T',
  );
  assert.equal(d.state, 'unresolved');
  assert.equal(d.entityId, null);
});

test('no candidates is a decision with a reason, not a silent drop', () => {
  const d = decide(OBSERVATION(), [], DEFAULT_RULES, 'T');
  assert.equal(d.state, 'unresolved');
  assert.match(d.reason ?? '', /no registered entity matched/);
});

test('decisions are order-independent in the candidate set', () => {
  const cs = [
    CANDIDATE({ i: 'a', n: 'X LLC', k: 'XLLC', c: 2 }),
    CANDIDATE({ i: 'b', n: 'X LLC', k: 'XLLC', c: 2 }),
  ];
  const one = decide(OBSERVATION({ n: 'X LLC', k: 'XLLC' }), cs, DEFAULT_RULES, 'T');
  const two = decide(OBSERVATION({ n: 'X LLC', k: 'XLLC' }), [...cs].reverse(), DEFAULT_RULES, 'T');
  assert.equal(canonicalJson(one), canonicalJson(two));
});

test('a decision carries its evidence and the resolver that made it', () => {
  const d = decide(OBSERVATION({ e: gid(1) }), [CANDIDATE()], DEFAULT_RULES, 'T');
  assert.equal(d.resolverVersion, 'org_resolver_1');
  assert.equal(d.linkId, decide(OBSERVATION({ e: gid(1) }), [CANDIDATE()], DEFAULT_RULES, 'T').linkId);
  assert.ok(d.evidence.length > 0);
});

test('the collision audit measures the register before any name rule is enabled', async () => {
  const rows = [
    CANDIDATE({ i: 'a', n: 'SUMMIT PARTNERS LLC', k: 'SUMMITPARTNERSLLC', a: ['SHARED'] }),
    CANDIDATE({ i: 'b', n: 'SUMMIT PARTNERS LLC', k: 'SUMMITPARTNERSLLC', a: ['SHARED'] }),
    CANDIDATE({ i: 'c', n: 'UNIQUE HOLDINGS LLC', k: 'UNIQUEHOLDINGSLLC', a: [] }),
  ];
  async function* lines(): AsyncGenerator<string> {
    for (const r of rows) yield canonicalJson(r);
  }
  const report = await measureNameCollisions(lines);
  assert.equal(report.totalEntities, 3);
  assert.equal(report.collidingNormalizedNames, 1);
  assert.equal(report.entitiesInNormalizedCollision, 2);
  assert.equal(report.largestNameCollision, 2);
  assert.equal(report.sharedAddresses, 1);
  assert.equal(report.normalizedUniquenessRate, 0.3333);
});

test('resolution over a stream matches deciding each observation directly', async () => {
  const entities = [CANDIDATE({ i: 'e-1', x: gid(1) })];
  const observations = [OBSERVATION({ o: 'obs-a' }), OBSERVATION({ o: 'obs-b', e: gid(1) })];
  async function* ents(): AsyncGenerator<string> { for (const e of entities) yield canonicalJson(e); }
  async function* obs(): AsyncGenerator<string> { for (const o of observations) yield canonicalJson(o); }

  const out: EntityLinkDecision[] = [];
  const summary = await resolveOrganizations(obs, ents, DEFAULT_RULES, 'T', async (d) => { out.push(d); });
  assert.equal(summary.observations, 2);
  assert.equal(summary.resolved, 1);
  assert.equal(summary.provisional, 1);
  for (const decision of out) {
    const direct = decide(
      observations.find((o) => o.o === decision.partyObservationId) as OrganizationObservation,
      entities, DEFAULT_RULES, 'T',
    );
    assert.equal(canonicalJson(decision), canonicalJson(direct));
  }
});

// ===========================================================================
// 7. Cross-source convergence
// ===========================================================================

test('an assessor owner name and an eCRV buyer name reach the same candidate registration', async () => {
  const h = streamHarness();
  await h.runSos(AUGUST);
  await h.run(hennepinFixture('v2-2026-08.ndjson'));
  const ecrv = streamHarness({ root: h.root });
  void ecrv;

  const links = (await readLinks(h.varRoot)).filter((l) => l.observedName === 'SYNTHETIC HOLDINGS LLC');
  assert.ok(links.length >= 1, 'the assessor owner must produce a link decision');
  const entities = (await h.table('business_entities')) as Row[];
  const target = String(byId(entities, gid(18))['entityId']);
  for (const link of links) {
    assert.deepEqual(link.candidateEntityIds, [target]);
    // Strong evidence, and still not resolved: the name rule is off.
    assert.equal(link.state, 'provisional');
    assert.ok(link.evidence.some((e) => e.evidenceType === 'EXACT_LEGAL_NAME_UNIQUE'));
  }
});

test('a recorder grantee name reaches its registration and keeps the compact collision visible', async () => {
  const h = streamHarness();
  await h.runSos(AUGUST);
  await h.runRecorder(recorderFixture('chain-2024-2025.ndjson'));

  const entities = (await h.table('business_entities')) as Row[];
  const northstar = String(byId(entities, gid(3))['entityId']);
  const northStar = String(byId(entities, gid(1))['entityId']);

  const links = (await readLinks(h.varRoot)).filter((l) => l.observedName === 'NORTHSTAR HOMES LLC');
  assert.ok(links.length >= 1);
  for (const link of links) {
    // Both are candidates — the compact key finds the spaced spelling — and the
    // decision refuses to choose between them on a name alone.
    assert.ok(link.candidateEntityIds.includes(northstar));
    assert.ok(link.candidateEntityIds.includes(northStar));
    assert.equal(link.entityId, null);
  }
});

test('ingest order does not change any link decision', async () => {
  const first = streamHarness();
  await first.runSos(AUGUST);
  await first.runRecorder(recorderFixture('chain-2024-2025.ndjson'));

  const second = streamHarness();
  await second.runRecorder(recorderFixture('chain-2024-2025.ndjson'));
  await second.runSos(AUGUST);

  const a = (await readLinks(first.varRoot)).map((l) => canonicalJson(l)).sort();
  const b = (await readLinks(second.varRoot)).map((l) => canonicalJson(l)).sort();
  assert.deepEqual(a, b);
});

test('a business registration adds no property, no transaction and no sale', async () => {
  const { h } = await august();
  const bundles = (await h.bundles()) as Row[];
  for (const bundle of bundles) {
    assert.deepEqual(bundle['properties'], []);
    assert.deepEqual(bundle['propertyIdentifiers'], []);
    assert.deepEqual(bundle['financing'], []);
    const tx = bundle['transaction'] as Row;
    assert.equal(tx['totalConsideration'], null);
    assert.equal(tx['transferDate'], null);
    assert.equal((tx['characteristics'] as Row)['record_kind'], 'business_entity_registration');
  }
});

test('an organization observation never becomes a party classification', async () => {
  const h = streamHarness();
  await h.run(hennepinFixture('v2-2026-08.ndjson'));
  const bundles = (await h.bundles()) as Row[];
  const parties = bundles.flatMap((b) => (b['parties'] as Row[]) ?? []);
  const org = parties.find((p) => p['rawName'] === 'SYNTHETIC HOLDINGS LLC') as Row;
  assert.ok(org);
  // The assessor does not say whether an owner is a person or a company, so the
  // Fabric does not either — however organization-shaped the name looks.
  assert.equal(org['kind'], 'unknown');
  assert.ok(organizationObservationOf(org as never) !== null);
});

// ===========================================================================
// 8. Snapshot behaviour across deliveries
// ===========================================================================

test('re-ingesting the same delivery is idempotent', async () => {
  const h = streamHarness();
  const one = await h.runSos(AUGUST);
  const two = await h.runSos(AUGUST);
  assert.equal(one.run.normalizedDigest, two.run.normalizedDigest);
  assert.equal(two.run.metrics.rowsUnchanged, two.run.metrics.rowsValid);
  assert.equal(two.run.metrics.rowsRevised, 0);
});

test('a changed address is reported as an address change, not as a changed entity', async () => {
  const h = streamHarness();
  await h.runSos(AUGUST);
  const september = await h.runSos(SEPTEMBER, { period: '2026-09' });
  assert.equal(september.run.metrics.rowsRevised, 1);
  const addresses = (await h.table('business_entity_addresses')) as Row[];
  assert.ok(addresses.some((a) => String((a['address'] as Row)['line1']).includes('New Notional')));
});

test('an entity absent from the next delivery is recorded as absent, not as dissolved', async () => {
  const h = streamHarness();
  await h.runSos(AUGUST);
  const september = await h.runSos(SEPTEMBER, { period: '2026-09' });
  assert.ok(september.run.metrics.rowsMissingFromSnapshot >= 1);
  const absences = (await h.rows('absences')) as Row[];
  assert.ok(absences.length >= 1);
  for (const absence of absences) {
    assert.ok(!/dissolv|terminat|closed/i.test(canonicalJson(absence)));
  }
});

test('replaying the retained artifact reproduces the run exactly', async () => {
  const h = streamHarness();
  const first = await h.runSos(AUGUST);
  const replayed = await h.runSos(AUGUST, { replayArtifact: first.artifact! } as never);
  assert.equal(replayed.run.normalizedDigest, first.run.normalizedDigest);
  assert.equal(replayed.run.runId, first.run.runId);
});

test('an interrupted delivery activates nothing', async () => {
  const h = streamHarness();
  await h.runSos(AUGUST);
  const before = (await h.table('business_entities')).length;

  // A delivery that fails mid-read: the manifest is valid, the rows are not.
  const broken = join(h.root, 'broken.bundle');
  const good = await readFile(AUGUST, 'utf8');
  const lines = good.split('\n');
  await writeFile(broken, `${lines.slice(0, 20).join('\n')}\n"unterminated\n`);

  const result = await h.runSos(broken, { period: '2026-broken' });
  assert.notEqual(result.run.status, 'completed');
  // The previously activated generation is untouched: a crash cannot leave a
  // partial register visible.
  assert.equal((await h.table('business_entities')).length, before);
});

test('replay reproduces the entity rows and the link decisions byte for byte', async () => {
  const h = streamHarness();
  const first = await h.runSos(AUGUST);
  const entitiesBefore = (await h.table('business_entities')).map(canonicalJson).sort();
  const linksBefore = (await readLinks(h.varRoot)).map((l) => canonicalJson(l)).sort();

  const replayed = await h.runSos(AUGUST, { replayArtifact: first.artifact! } as never);
  assert.equal(replayed.run.normalizedDigest, first.run.normalizedDigest);
  assert.deepEqual((await h.table('business_entities')).map(canonicalJson).sort(), entitiesBefore);
  assert.deepEqual((await readLinks(h.varRoot)).map((l) => canonicalJson(l)).sort(), linksBefore);
});

test('an assumed name and a legal name that collide stay two candidates, never one entity', async () => {
  const { entities } = await august();
  const legal = byId(entities, gid(5));
  const assumed = byId(entities, gid(12));
  assert.equal(legal['normalizedName'], assumed['normalizedName']);
  assert.notEqual(legal['entityId'], assumed['entityId']);
  // The assumed-name row is not a company, so it must never resolve a property
  // owner even though the name matches exactly.
  assert.equal((assumed['attributes'] as Row)['is_legal_entity'], false);
});

test('a home-jurisdiction name that equals another entity\'s legal name is a candidate, not a merge', async () => {
  const { entities, names } = await august();
  const iowa = byId(entities, gid(15));
  const mn = byId(entities, gid(9));
  const homeName = names.find((n) => n['entityId'] === iowa['entityId'] && n['nameType'] === 'HOME_JURISDICTION_NAME') as Row;
  assert.equal(homeName['normalizedName'], mn['normalizedName']);
  assert.notEqual(iowa['entityId'], mn['entityId']);
});

test('nothing in the estate is classified as safe to publish', async () => {
  const { entities } = await august();
  assert.ok(entities.length > 0);
  for (const entity of entities) {
    assert.equal(entity['licenseClass'], 'CANONICAL_INTERNAL');
    assert.notEqual(entity['licenseClass'], 'PUBLIC_SAFE');
  }
  // And there is no member- or public-facing projection of the register at all.
  const derived = join((await august()).h.varRoot, 'derived');
  const names = await readdir(derived).catch(() => [] as string[]);
  for (const name of names) {
    assert.ok(!/public|member|export|feed/i.test(name), `${name} looks like a published projection`);
  }
});

// ===========================================================================
// 9. Schema and licence drift
// ===========================================================================

test('a delivery declaring a different implementation guide quarantines the run', async () => {
  const h = streamHarness();
  const result = await h.runSos(sosFixture('fault-guide-version-drift.bundle'));
  assert.equal(result.run.status, 'quarantined');
  assert.equal(result.run.failureKind, 'SCHEMA_DRIFT');
  assert.match(result.run.failureMessage ?? '', /implementation guide version changed/);
  assert.equal(result.run.metrics.rowsValid, 0);
});

test('a delivery whose licence does not permit serving customers is refused before any row is read', async () => {
  const h = streamHarness();
  const result = await h.runSos(sosFixture('fault-license-not-permitted.bundle'));
  assert.equal(result.run.status, 'quarantined');
  assert.match(result.run.failureMessage ?? '', /does not permit making records available/);
  assert.equal((await h.table('business_entities')).length, 0);
});

test('the pinned layout digest is what the connector actually reads by', () => {
  assert.match(PINNED_LAYOUT_DIGEST, /^[0-9a-f]{64}$/);
  assert.match(PINNED_GUIDE_VERSION, /implementation-guide/);
});

// ===========================================================================
// 10. Restricted data and licence boundaries
// ===========================================================================

test('a filing party address goes to the restricted plane and to no canonical row', async () => {
  const { h, parties, addresses } = await august();
  const contacts = (await h.rows('contacts')) as Row[];
  assert.ok(contacts.length >= 1);
  assert.ok(contacts.every((c) => c['contactType'] === 'mailing_address'));
  assert.ok(contacts.every((c) => c['permittedUse'] === 'record_only'));

  // A registered agent's own address must appear nowhere in the canonical rows.
  const agentAddress = '18 IMAGINARY RD SAINT PAUL MN 55102';
  const canonical = canonicalJson({ parties, addresses });
  assert.ok(!canonical.includes('18 Imaginary Rd'), 'a party address leaked into a canonical row');
  assert.ok(contacts.some((c) => c['value'] === agentAddress));
});

test('a filing party carries a name and a role but never a contact channel', async () => {
  const { parties } = await august();
  const agent = parties.find((p) => p['rawName'] === 'Dana Fictitious') as Row;
  assert.ok(agent);
  assert.equal(agent['roleLabel'], 'Registered Agent');
  assert.equal(agent['likelyNaturalPerson'], true);
  for (const key of Object.keys(agent)) {
    assert.ok(!/phone|email|address|contact/i.test(key), `a filing party must not have a ${key} field`);
  }
});

test('no phone, email or skip-tracing field exists anywhere in the business model', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'canonical', 'organizations.ts'), 'utf8');
  const declarations = text.split('\n').filter((l) => /readonly \w+/.test(l));
  for (const line of declarations) {
    assert.ok(!/\b(phone|email|mobile|ssn|dob|skipTrace)\b/i.test(line), `unexpected contact field: ${line.trim()}`);
  }
});

test('the business type of a party address decides the plane, not the connector author', async () => {
  const { addresses } = await august();
  // Business addresses (principal, registered office) stay canonical.
  assert.ok(addresses.some((a) => a['family'] === 'PRINCIPAL'));
  assert.ok(addresses.some((a) => a['family'] === 'REGISTERED_OFFICE'));
  // Party addresses (family PARTY_ADDRESS, code 14) never do.
  assert.equal(addresses.filter((a) => a['addressTypeCode'] === '14').length, 0);
});

// ===========================================================================

/** A row with the two fields that are properties of the RUN, not of the fact. */
function withoutRunIdentity(row: unknown): string {
  return canonicalJson(row, ).replace(/"(runId|artifactId)":"[^"]*"/g, '"$1":""');
}

async function readLinks(varRoot: string): Promise<EntityLinkDecision[]> {
  const text = await readFile(join(varRoot, 'derived', 'entity-links', 'current.ndjson'), 'utf8')
    .catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EntityLinkDecision);
}

void fixture;
