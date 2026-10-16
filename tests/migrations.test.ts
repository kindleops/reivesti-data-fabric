/**
 * Migration tests.
 *
 * These are STRUCTURAL, not executed. No Postgres is reachable from this
 * environment (no docker, no psql), so nothing here proves the SQL runs — it
 * proves the schema says what the architecture requires it to say. The
 * limitation is recorded in the run report rather than papered over; applying
 * these migrations against a throwaway database is a prerequisite for DF-0C.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO } from './helpers.ts';

const DIR = join(REPO, 'db', 'migrations');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const SQL = FILES.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n');

test('migrations exist and are ordered', () => {
  assert.deepEqual(FILES, [
    '0001_data_fabric_core.sql',
    '0002_data_fabric_restricted_contact.sql',
    '0003_data_fabric_snapshot_and_resolution.sql',
    '0004_data_fabric_streaming_runs.sql',
    '0005_data_fabric_recorded_instruments.sql',
  '0006_data_fabric_business_entities.sql',
  '0007_data_fabric_zero_cost_national.sql',
  '0008_data_fabric_field_authority.sql',
    '0009_data_fabric_normalization_contract.sql',
    '0010_data_fabric_transfer_declarations.sql',
    '0011_data_fabric_durable_artifacts.sql',
    '0012_data_fabric_sale_observations.sql',
  ]);
});

test('every migration states plainly that it has not been applied to production', () => {
  for (const file of FILES) {
    const text = readFileSync(join(DIR, file), 'utf8');
    assert.match(text, /NOT APPLIED TO PRODUCTION/, file);
  }
});

test('the Fabric owns its own schemas and touches no application schema', () => {
  assert.match(SQL, /create schema if not exists data_fabric;/);
  assert.match(SQL, /create schema if not exists data_fabric_restricted;/);
  // Nothing may create, alter or drop anything in the application's schema.
  for (const forbidden of [
    /create table[^;]*\bpublic\./i,
    /alter table\s+public\./i,
    /drop table/i,
    /drop schema/i,
    /truncate/i,
  ]) {
    assert.ok(!forbidden.test(SQL), `migrations must not contain ${forbidden}`);
  }
});

test('every table the runtime writes has a home in the schema', () => {
  const expected = [
    'data_fabric.jurisdictions',
    'data_fabric.sources',
    'data_fabric.source_jurisdiction_mappings',
    'data_fabric.source_releases',
    'data_fabric.source_artifacts',
    'data_fabric.source_runs',
    'data_fabric.source_record_observations',
    'data_fabric.properties',
    'data_fabric.property_identifier_observations',
    'data_fabric.parties',
    'data_fabric.party_observations',
    'data_fabric.party_aliases',
    'data_fabric.transaction_events',
    'data_fabric.transaction_parties',
    'data_fabric.transaction_parcels',
    'data_fabric.financing_events',
    'data_fabric.recorded_instruments',
    'data_fabric.distress_events',
    'data_fabric.canonical_events',
    'data_fabric_restricted.contact_observations',
    // DF-0C: snapshot sources and authoritative property resolution.
    'data_fabric.source_snapshots',
    'data_fabric.parcel_snapshot_observations',
    'data_fabric.assessment_observations',
    'data_fabric.property_characteristic_observations',
    'data_fabric.property_resolutions',
    'data_fabric.parcel_snapshot_absences',
    // DF-0E: recorded instruments and the graph over them.
    'data_fabric.recorded_instrument_documents',
    'data_fabric.instrument_parties',
    'data_fabric.instrument_property_links',
    'data_fabric.legal_descriptions',
    'data_fabric.instrument_references',
    'data_fabric.recorded_financing',
    'data_fabric.ownership_observations',
    'data_fabric.transaction_candidates',
    'data_fabric.property_conflicts',
  ];
  for (const table of expected) {
    assert.ok(SQL.includes(`create table if not exists ${table} (`), `missing table ${table}`);
  }
});

test('contact data has exactly one home, and it is the restricted schema', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  // No column in the canonical schema can hold a phone number or an email.
  for (const column of [/^\s*\w*phone\w*\s+text/im, /^\s*\w*email\w*\s+text/im, /contact_notes/i]) {
    assert.ok(!column.test(core), `the canonical schema declares a contact column: ${column}`);
  }
  const restricted = readFileSync(join(DIR, '0002_data_fabric_restricted_contact.sql'), 'utf8');
  assert.match(restricted, /create table if not exists data_fabric_restricted\.contact_observations/);
});

test('row level security is enabled and forced on every Fabric table', () => {
  const restricted = readFileSync(join(DIR, '0002_data_fabric_restricted_contact.sql'), 'utf8');
  assert.match(restricted, /enable row level security/);
  // FORCE matters: without it the table owner still bypasses the policies.
  assert.match(restricted, /force row level security/);
  assert.match(restricted, /where schemaname in \('data_fabric', 'data_fabric_restricted'\)/);
});

test('application roles are explicitly denied rather than merely unmentioned', () => {
  const restricted = readFileSync(join(DIR, '0002_data_fabric_restricted_contact.sql'), 'utf8');
  assert.match(restricted, /array\['anon', 'authenticated'\]/);
  assert.match(restricted, /as restrictive for all to %I using \(false\) with check \(false\)/);
  assert.match(restricted, /revoke all on schema data_fabric_restricted from public/);
  assert.match(restricted, /revoke all on schema data_fabric from public/);
});

test('the schema enforces the identity rules the normaliser relies on', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  // A parcel identifier without a county is meaningless.
  assert.match(core, /constraint parcel_requires_county check/);
  // An unresolved observation cannot carry an entity link, and vice versa.
  assert.match(core, /constraint resolution_consistency check/);
  assert.match(core, /constraint party_resolution_consistency check/);
  // An address string never resolves a property, at the database level too.
  assert.match(core, /constraint address_never_resolves check/);
});

test('artifacts are content-addressed and declared immutable in the schema', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  assert.match(core, /sha256\s+text not null unique check \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(core, /storage_path\s+text not null unique/);
  assert.match(core, /immutable\s+boolean not null default true check \(immutable\)/);
});

test('canonical event types are constrained to the three the source supports', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  const match = /event_type\s+text not null check \(event_type in \(([^)]*)\)\)/.exec(core.slice(core.indexOf('canonical_events')));
  assert.ok(match);
  const types = (match[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
  // 0001 declares the transfer-source events; 0003 widens the constraint to add
  // the assessor-supported ones. Neither list may contain a claim the source
  // cannot make, so the forbidden set is asserted against the whole estate.
  assert.deepEqual(types.sort(), ['FINANCING_OBSERVED', 'PROPERTY_SALE_OBSERVED', 'REAL_ESTATE_TRANSFER_OBSERVED']);
  for (const forbidden of ['PROPERTY_SOLD', 'BUYER_ACQUIRED_PROPERTY', 'FORECLOSURE', 'ACTIVE_BUYER', 'DISTRESS']) {
    assert.ok(!SQL.includes(`'${forbidden}'`), `${forbidden} must never be a canonical event type`);
  }
});

test('money is stored as integer minor units, never as a float type', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  const moneyColumns = (core.match(/^\s*(\w+_minor)\s+(\w+)/gim) ?? []).map((m) => m.trim().split(/\s+/));
  assert.deepEqual(
    moneyColumns.map((c) => c[0]).sort(),
    [
      'balloon_amount_minor',
      'delinquent_special_assessments_minor',
      'down_payment_minor',
      'payment_amount_minor',
      'principal_amount_minor',
      'seller_paid_points_minor',
      'total_consideration_minor',
    ],
  );
  for (const [name, type] of moneyColumns) {
    assert.equal(type, 'bigint', `money column ${name} is ${type}, not bigint`);
  }
  // No column anywhere is declared with an inexact or locale-dependent type.
  const floatColumns = core.match(/^\s*\w+\s+(real|double precision|float\d*|money)\b/gim) ?? [];
  assert.deepEqual(floatColumns, [], 'no column may use an inexact or locale-dependent numeric type');
});

test('every canonical table carries lineage columns', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  for (const table of ['transaction_events', 'party_observations', 'property_identifier_observations', 'financing_events', 'canonical_events']) {
    const start = core.indexOf(`create table if not exists data_fabric.${table} (`);
    assert.ok(start > 0, table);
    const body = core.slice(start, core.indexOf(');', start));
    for (const column of ['artifact_id', 'source_record_id', 'raw_record_hash', 'observed_at']) {
      assert.ok(body.includes(column), `${table} is missing lineage column ${column}`);
    }
  }
});

test('FIPS, parcel and ZIP style identifiers are TEXT, preserving leading zeros', () => {
  const core = readFileSync(join(DIR, '0001_data_fabric_core.sql'), 'utf8');
  for (const column of ['county_fips', 'state_fips', 'address_postal_code']) {
    const declarations = core.match(new RegExp(`^\\s*${column}\\s+(\\w+)`, 'gim')) ?? [];
    assert.ok(declarations.length > 0, `${column} not declared`);
    for (const d of declarations) assert.match(d, /text/i, d.trim());
  }
});
