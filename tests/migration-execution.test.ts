/**
 * Real PostgreSQL migration execution — the DF-0A P1 gate.
 *
 * `tests/migrations.test.ts` asserts what the SQL *says*. This file asserts what
 * PostgreSQL actually *does* with it: objects created, constraints enforced on
 * real rows, RLS blocking real roles, and two independent fresh applications
 * producing an identical schema signature.
 *
 * Skips loudly, never silently, when no PostgreSQL binaries are available.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import {
  APP_ROLES,
  POSTGRES_UNAVAILABLE_MESSAGE,
  SERVICE_ROLE,
  migrationFiles,
  schemaSignature,
  startDisposablePostgres,
  type DisposablePostgres,
} from './support/postgres.ts';

const server = await startDisposablePostgres();

if (!server) {
  test('real PostgreSQL migration execution', { skip: POSTGRES_UNAVAILABLE_MESSAGE }, () => {});
} else {
  describe('real PostgreSQL migration execution', () => {
    let db: pg.Client;
    let signatureOne = '';
    const applied: string[] = [];

    before(async () => {
      await server.createDatabase('df_gate_one');
      for (const file of migrationFiles()) {
        await server.applyMigrations('df_gate_one', [file]);
        applied.push(file);
      }
      db = await server.connect('df_gate_one');
    });

    after(async () => {
      await db?.end().catch(() => {});
      await server.stop();
    });

    // --- execution ---------------------------------------------------------

    test('the server is a real PostgreSQL matching the production major version', () => {
      assert.match(server.version, /^17\./, `expected PostgreSQL 17.x, got ${server.version}`);
    });

    test('every migration executes without error, in order', () => {
      assert.deepEqual(applied, [
        '0001_data_fabric_core.sql',
        '0002_data_fabric_restricted_contact.sql',
        '0003_data_fabric_snapshot_and_resolution.sql',
        '0004_data_fabric_streaming_runs.sql',
      ]);
    });

    test('both schemas exist', async () => {
      const r = await db.query(
        `select nspname from pg_namespace where nspname in ('data_fabric','data_fabric_restricted') order by 1`,
      );
      assert.deepEqual(r.rows.map((x) => x.nspname), ['data_fabric', 'data_fabric_restricted']);
    });

    test('the expected tables exist, and only those', async () => {
      const r = await db.query(`
        select table_schema || '.' || table_name as t
        from information_schema.tables
        where table_schema in ('data_fabric','data_fabric_restricted') and table_type = 'BASE TABLE'
        order by 1`);
      assert.deepEqual(r.rows.map((x) => x.t), [
        'data_fabric.assessment_observations',
        'data_fabric.canonical_events',
        'data_fabric.distress_events',
        'data_fabric.financing_events',
        'data_fabric.jurisdictions',
        'data_fabric.parcel_snapshot_absences',
        'data_fabric.parcel_snapshot_observations',
        'data_fabric.parties',
        'data_fabric.party_aliases',
        'data_fabric.party_observations',
        'data_fabric.properties',
        'data_fabric.property_characteristic_observations',
        'data_fabric.property_conflicts',
        'data_fabric.property_identifier_observations',
        'data_fabric.property_resolutions',
        'data_fabric.recorded_instruments',
        'data_fabric.source_artifacts',
        'data_fabric.source_jurisdiction_mappings',
        'data_fabric.source_record_observations',
        'data_fabric.source_releases',
        'data_fabric.source_runs',
        'data_fabric.source_snapshots',
        'data_fabric.sources',
        'data_fabric.transaction_events',
        'data_fabric.transaction_parcels',
        'data_fabric.transaction_parties',
        'data_fabric_restricted.contact_observations',
      ]);
    });

    test('primary keys, foreign keys, uniques and checks were all created', async () => {
      const r = await db.query(`
        select con.contype, count(*)::int n
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname in ('data_fabric','data_fabric_restricted')
        group by 1`);
      const byType = Object.fromEntries(r.rows.map((x) => [x.contype, x.n]));
      assert.ok(byType['p'] >= 27, `expected a primary key per table, got ${byType['p']}`);
      assert.ok(byType['f'] >= 30, `expected foreign keys, got ${byType['f']}`);
      assert.ok(byType['u'] >= 6, `expected unique constraints, got ${byType['u']}`);
      assert.ok(byType['c'] >= 30, `expected check constraints, got ${byType['c']}`);
    });

    test('the named identity constraints exist as real constraints', async () => {
      const r = await db.query(`
        select con.conname from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = 'data_fabric' and con.contype = 'c'`);
      const names = new Set(r.rows.map((x) => x.conname));
      for (const expected of [
        'parcel_requires_county',
        'resolution_consistency',
        'address_never_resolves',
        'party_resolution_consistency',
        'jurisdiction_county_scope',
      ]) {
        assert.ok(names.has(expected), `missing CHECK constraint ${expected}`);
      }
    });

    test('expected indexes exist', async () => {
      const r = await db.query(`
        select indexname from pg_indexes
        where schemaname in ('data_fabric','data_fabric_restricted')`);
      const names = new Set(r.rows.map((x) => x.indexname));
      for (const expected of [
        'jurisdictions_county_fips_idx',
        'source_runs_source_started_idx',
        'sro_key_idx',
        'pio_parcel_idx',
        'po_normalized_name_idx',
        'te_county_date_idx',
        'ce_subject_idx',
        'co_party_obs_idx',
        'pso_snapshot_idx',
        'ao_property_idx',
        'psa_snapshot_idx',
        'pr_parcel_idx',
      ]) {
        assert.ok(names.has(expected), `missing index ${expected}`);
      }
    });

    // --- constraints enforced on real rows ----------------------------------

    test('a parcel identifier without a county is rejected by the database', async () => {
      await seedMinimal(db);
      await assert.rejects(
        () => insertIdentifier(db, { identifier_type: 'county_parcel', county_fips: null, resolution_state: 'unresolved', property_id: null }),
        /parcel_requires_county/,
      );
    });

    test('an unresolved identifier carrying a property link is rejected', async () => {
      await db.query(`insert into data_fabric.properties (property_id, county_fips, created_from_method)
                      values ('prop_x', '27053', 'test') on conflict do nothing`);
      await assert.rejects(
        () => insertIdentifier(db, { identifier_type: 'county_parcel', county_fips: '27053', resolution_state: 'unresolved', property_id: 'prop_x' }),
        /resolution_consistency/,
      );
      await assert.rejects(
        () => insertIdentifier(db, { identifier_type: 'county_parcel', county_fips: '27053', resolution_state: 'resolved', property_id: null }),
        /resolution_consistency/,
      );
    });

    test('an address identifier can never be anything but unresolved', async () => {
      await assert.rejects(
        () => insertIdentifier(db, { identifier_type: 'normalized_address', county_fips: '27053', resolution_state: 'provisional', property_id: 'prop_x' }),
        /address_never_resolves/,
      );
    });

    test('a valid privileged insert and select round-trips', async () => {
      const id = await insertIdentifier(db, {
        identifier_type: 'county_parcel', county_fips: '27053', resolution_state: 'provisional', property_id: 'prop_x',
      });
      const r = await db.query('select * from data_fabric.property_identifier_observations where observation_id = $1', [id]);
      assert.equal(r.rowCount, 1);
      assert.equal(r.rows[0].county_fips, '27053');
      assert.equal(r.rows[0].resolution_state, 'provisional');
    });

    test('a duplicate sha256 on an artifact is rejected', async () => {
      await assert.rejects(
        () => db.query(`
          insert into data_fabric.source_artifacts
            (artifact_id, source_id, original_filename, retrieved_at, byte_length, sha256, storage_path, manifest_path)
          values ('artifact_dup','src_test','a.xml', now(), 1, $1, 'p/dup', 'p/dup.json')`, ['a'.repeat(64)]),
        /source_artifacts_sha256_key|duplicate key/,
      );
    });

    test('a malformed sha256 is rejected by the format check', async () => {
      await assert.rejects(
        () => db.query(`
          insert into data_fabric.source_artifacts
            (artifact_id, source_id, original_filename, retrieved_at, byte_length, sha256, storage_path, manifest_path)
          values ('artifact_bad','src_test','a.xml', now(), 1, 'not-a-digest', 'p/bad', 'p/bad.json')`),
        /source_artifacts_sha256_check|violates check constraint/,
      );
    });

    test('an artifact cannot be marked mutable', async () => {
      await assert.rejects(
        () => db.query(`
          insert into data_fabric.source_artifacts
            (artifact_id, source_id, original_filename, retrieved_at, byte_length, sha256, storage_path, manifest_path, immutable)
          values ('artifact_mut','src_test','a.xml', now(), 1, $1, 'p/mut', 'p/mut.json', false)`, ['c'.repeat(64)]),
        /violates check constraint/,
      );
    });

    // --- RLS and privileges --------------------------------------------------

    test('RLS is enabled AND forced on every table in both schemas', async () => {
      const r = await db.query(`
        select n.nspname || '.' || c.relname as t, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('data_fabric','data_fabric_restricted') and c.relkind = 'r'`);
      assert.equal(r.rows.length, 27);
      const bad = r.rows.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity);
      assert.deepEqual(bad.map((x) => x.t), [], 'tables missing enabled+forced RLS');
    });

    test('a restrictive deny policy exists for each application role on every table', async () => {
      const r = await db.query(`
        select tablename, policyname, permissive, roles::text
        from pg_policies where schemaname in ('data_fabric','data_fabric_restricted')`);
      assert.equal(r.rows.length, 27 * APP_ROLES.length);
      assert.ok(r.rows.every((x) => x.permissive === 'RESTRICTIVE'), 'policies must be RESTRICTIVE');
      for (const role of APP_ROLES) {
        const forRole = r.rows.filter((x) => x.roles.includes(role));
        assert.equal(forRole.length, 27, `expected a deny policy per table for ${role}`);
      }
    });

    test('application roles have no USAGE on either schema', async () => {
      for (const role of APP_ROLES) {
        for (const schema of ['data_fabric', 'data_fabric_restricted']) {
          const r = await db.query('select has_schema_privilege($1, $2, $3) as ok', [role, schema, 'USAGE']);
          assert.equal(r.rows[0].ok, false, `${role} should not have USAGE on ${schema}`);
        }
      }
    });

    test('anon and authenticated cannot read canonical data', async () => {
      // anon/authenticated are NOLOGIN in Supabase; PostgREST assumes them with
      // SET ROLE on an already-authenticated connection. Testing that way also
      // proves a privileged session that drops into the role is still blocked.
      for (const role of APP_ROLES) {
        await assertDeniedAsRole(db, role, 'select * from data_fabric.transaction_events limit 1');
      }
    });

    test('anon and authenticated cannot write canonical data', async () => {
      for (const role of APP_ROLES) {
        await assertDeniedAsRole(
          db, role,
          `insert into data_fabric.properties (property_id, county_fips, created_from_method) values ('x','27053','t')`,
        );
      }
    });

    test('the restricted contact plane is unreachable for application roles', async () => {
      // Prove there is something to protect before proving it is protected.
      await db.query(`
        insert into data_fabric_restricted.contact_observations
          (contact_observation_id, contact_type, value, source_id, source_record_id, observed_at,
           confidence, status, artifact_id, run_id, raw_record_hash, parser_version, normalization_version)
        values ('c_secret','phone','555-0100','src_test','r1', now(),'source_stated','observed','a1','run1','h','p','n')
        on conflict do nothing`);
      const seen = await db.query('select count(*)::int n from data_fabric_restricted.contact_observations');
      assert.equal(seen.rows[0].n, 1);

      for (const role of APP_ROLES) {
        await assertDeniedAsRole(db, role, 'select value from data_fabric_restricted.contact_observations');
      }
    });

    test('a role that bypasses RLS can still read, so the boundary is privilege-based not accidental', async () => {
      // The service role bypasses RLS but still needs a grant; without one it is
      // denied too. That is the correct, least-astonishing behaviour, and pinning
      // it means a future blanket GRANT has to be a deliberate, visible change.
      await assertDeniedAsRole(db, SERVICE_ROLE, 'select 1 from data_fabric_restricted.contact_observations');
      // The owner (which the Fabric connects as) can.
      const owner = await db.query('select count(*)::int n from data_fabric_restricted.contact_observations');
      assert.equal(owner.rows[0].n, 1);
    });

    test('forced RLS means even the owner is subject to policy, and the deny policies target only app roles', async () => {
      // relforcerowsecurity is on, so the owner is policy-bound. The only
      // policies are restrictive denials scoped to anon/authenticated, which do
      // not apply to the owner, so the owner still reads. This test pins that
      // reasoning down so a future permissive policy cannot widen access silently.
      const r = await db.query('select count(*)::int n from data_fabric.properties');
      assert.ok(r.rows[0].n >= 1);
      const pol = await db.query(`
        select distinct roles::text from pg_policies where schemaname = 'data_fabric'`);
      assert.deepEqual(pol.rows.map((x) => x.roles).sort(), ['{anon}', '{authenticated}']);
    });


    test('the run manifest columns DF-0D added exist and are typed', async () => {
      const r = await db.query(`
        select column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = 'data_fabric' and table_name = 'source_runs'
          and column_name in (
            'artifact_byte_length','source_reported_count','source_reported_count_at_end',
            'source_changed_during_read','discovered_id_count','downloaded_count','duplicate_count',
            'canonical_digest','source_schema_digest','batch_configuration','streamed',
            'rows_missing_from_snapshot','rows_resolved','rows_conflicted','peak_heap_bytes')
        order by column_name`);
      assert.equal(r.rows.length, 15, 'every DF-0D manifest column should exist');
      const byName = Object.fromEntries(r.rows.map((x) => [x.column_name, x]));
      assert.equal(byName['batch_configuration'].data_type, 'jsonb');
      assert.equal(byName['streamed'].data_type, 'boolean');
      assert.equal(byName['source_changed_during_read'].is_nullable, 'NO');
    });

    test('a completed run cannot claim success while the source moved under it', async () => {
      await seedMinimal(db);
      // The honest-reconciliation constraint: "complete" is the claim everything
      // downstream trusts, so the database refuses to record it alongside
      // evidence that the snapshot was never consistent.
      await assert.rejects(
        () => db.query(`
          insert into data_fabric.source_runs
            (run_id, source_id, mapping_id, adapter_key, connector_version, parser_version,
             normalization_version, schema_version, started_at, status, stage, source_changed_during_read)
          values ('run_drifted','src_test','map_test','test','c','p','n','s', now(), 'completed','emit', true)`),
        /source_runs_reconciliation_honest/,
      );
      // The same run recorded as quarantined is accepted.
      await db.query(`
        insert into data_fabric.source_runs
          (run_id, source_id, mapping_id, adapter_key, connector_version, parser_version,
           normalization_version, schema_version, started_at, status, stage, source_changed_during_read)
        values ('run_drifted','src_test','map_test','test','c','p','n','s', now(), 'quarantined','emit', true)`);
    });

    test('absence is recorded by key hash and cannot be spelled as a deletion', async () => {
      const r = await db.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'data_fabric.parcel_snapshot_absences'::regclass and contype = 'c'`);
      const definitions = r.rows.map((x) => x.def).join(' ');
      assert.match(definitions, /parcel_missing_from_latest_source/);
      // There is deliberately no 'deleted' or 'removed' state to write.
      assert.ok(!/deleted|removed/i.test(definitions));
      assert.match(definitions, /\^\[0-9a-f\]\{1,16\}\$/);
    });

    // --- repeatability --------------------------------------------------------

    test('a second, independent fresh database yields an identical schema signature', async () => {
      signatureOne = await schemaSignature(db);
      assert.ok(signatureOne.length > 5000, 'signature suspiciously small');

      await server.createDatabase('df_gate_two');
      await server.applyMigrations('df_gate_two');
      const second = await server.connect('df_gate_two');
      try {
        const signatureTwo = await schemaSignature(second);
        assert.equal(
          createHash('sha256').update(signatureTwo).digest('hex'),
          createHash('sha256').update(signatureOne).digest('hex'),
          'two fresh applications produced different schemas',
        );
      } finally {
        await second.end();
      }
    });

    test('the schema signature covers columns, constraints, indexes, RLS and policies', async () => {
      const signature = signatureOne || (await schemaSignature(db));
      for (const prefix of ['col ', 'con ', 'idx ', 'rls ', 'pol ']) {
        assert.ok(signature.includes(`\n${prefix}`) || signature.startsWith(prefix), `signature has no ${prefix.trim()} lines`);
      }
      // Recorded so a change to the migrations is a visible, reviewed diff.
      process.stdout.write(`# schema signature sha256: ${createHash('sha256').update(signature).digest('hex')}\n`);
    });

    test('there is no down migration, and that is recorded rather than implied', async () => {
      const files = migrationFiles();
      assert.ok(!files.some((f) => /down|rollback|revert/i.test(f)),
        'a down migration now exists; update this test and the docs');
      // Teardown for repeatability is by dropping the database, not by reversing
      // DDL. The disposable-cluster harness is the only supported reset path.
      const r = await db.query(`select count(*)::int n from pg_namespace where nspname like 'data_fabric%'`);
      assert.equal(r.rows[0].n, 2);
    });
  });
}

// ---------------------------------------------------------------------------

/** Runs a statement with the session temporarily dropped into `role`. */
async function assertDeniedAsRole(db: pg.Client, role: string, sql: string): Promise<void> {
  await db.query(`set role ${role}`);
  try {
    await assert.rejects(() => db.query(sql), /permission denied/, `${role} was not denied: ${sql}`);
  } finally {
    await db.query('reset role');
  }
}

async function seedMinimal(db: pg.Client): Promise<void> {
  await db.query(`insert into data_fabric.jurisdictions (jurisdiction_id, jurisdiction_type, country, name)
                  values ('us','nation','US','United States') on conflict do nothing`);
  await db.query(`insert into data_fabric.sources
      (source_id, source_authority, source_program, source_family, source_name, source_homepage,
       access_type, automation_status, terms_status, license_status, cost_model,
       expected_refresh_frequency, source_priority)
    values ('src_test','A','P','F','N','https://example.invalid',
            'manual_import','manual_only','not_reviewed','unknown','free','weekly',1)
    on conflict do nothing`);
  await db.query(`insert into data_fabric.source_jurisdiction_mappings
      (mapping_id, source_id, scope_kind, scope_values, capabilities, status, adapter_key)
    values ('map_test','src_test','counties','{27053}','{parcel}','fixture_only','test')
    on conflict do nothing`);
  await db.query(`insert into data_fabric.source_artifacts
      (artifact_id, source_id, original_filename, retrieved_at, byte_length, sha256, storage_path, manifest_path)
    values ('a1','src_test','a.xml', now(), 1, $1, 'p/a1', 'p/a1.json') on conflict do nothing`, ['a'.repeat(64)]);
  await db.query(`insert into data_fabric.source_runs
      (run_id, source_id, mapping_id, adapter_key, connector_version, parser_version,
       normalization_version, schema_version, started_at, status, stage)
    values ('run1','src_test','map_test','test','c','p','n','s', now(), 'completed','emit')
    on conflict do nothing`);
}

let identifierSeq = 0;

async function insertIdentifier(
  db: pg.Client,
  row: { identifier_type: string; county_fips: string | null; resolution_state: string; property_id: string | null },
): Promise<string> {
  const id = `obs_${++identifierSeq}`;
  await db.query(`
    insert into data_fabric.property_identifier_observations
      (observation_id, identifier_type, value, normalized_value, county_fips, source_designation,
       finality, resolution_state, property_id, source_id, source_record_id, artifact_id, run_id,
       observed_at, raw_record_hash, parser_version, normalization_version)
    values ($1,$2,'RAW','RAW',$3,'unspecified','preliminary',$4,$5,'src_test','r1','a1','run1', now(),'h','p','n')`,
    [id, row.identifier_type, row.county_fips, row.resolution_state, row.property_id]);
  return id;
}
