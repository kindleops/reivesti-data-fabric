-- ============================================================================
-- Reivesti Data Fabric — streaming run manifest and snapshot absences (DF-0D)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- DF-0D made full-county ingestion possible. Two things follow for the schema.
--
-- 1. A long crawl needs a manifest that can be audited afterwards. "We ingested
--    Hennepin" is a claim; the reconciliation columns below are what turn it
--    into a measurement that a reviewer can check months later.
--
-- 2. Absence is recorded by key HASH rather than by key. A 448,000-row snapshot
--    that loses 40,000 parcels would otherwise mean 40,000 full key strings in
--    memory to write them out; the hash is the same 8 bytes the streaming index
--    already holds, and the absent row's full key is in the prior snapshot's own
--    partition where it has always been.
-- ============================================================================

-- ------------------------------------------------------- run manifest --------

alter table data_fabric.source_runs
  add column if not exists artifact_byte_length bigint,
  -- What the source said it held, before and after the crawl. A layer that
  -- moved underneath a long read must not be reported as a complete snapshot.
  add column if not exists source_reported_count integer,
  add column if not exists source_reported_count_at_end integer,
  add column if not exists source_changed_during_read boolean not null default false,
  add column if not exists discovered_id_count integer,
  add column if not exists downloaded_count integer,
  add column if not exists duplicate_count integer not null default 0,
  -- Digest over the canonical property resolutions the run produced. Distinct
  -- from normalized_digest, which covers the reading of the artifact: a replay
  -- must reproduce both.
  add column if not exists canonical_digest text,
  add column if not exists source_schema_digest text,
  -- Batch sizes are operational dials that must never change results. Recording
  -- them means a digest mismatch can be checked against the configuration that
  -- produced it rather than guessed at.
  add column if not exists batch_configuration jsonb not null default '{}'::jsonb,
  add column if not exists streamed boolean not null default false,
  add column if not exists rows_missing_from_snapshot integer not null default 0,
  add column if not exists rows_resolved integer not null default 0,
  add column if not exists rows_conflicted integer not null default 0,
  add column if not exists peak_heap_bytes bigint;

comment on column data_fabric.source_runs.source_changed_during_read is
  'The source''s own row count differed before and after the crawl. The run is not a '
  'consistent snapshot and must not be activated as complete.';

-- A run either reconciles or says why not. Enforced rather than documented,
-- because "complete" is the claim everything downstream trusts.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'source_runs_reconciliation_honest'
      and conrelid = 'data_fabric.source_runs'::regclass
  ) then
    alter table data_fabric.source_runs
      add constraint source_runs_reconciliation_honest
      check (
        status <> 'completed'
        or source_changed_during_read = false
      );
  end if;
end
$$;

-- --------------------------------------------------- snapshot absences -------

create table if not exists data_fabric.parcel_snapshot_absences (
  observation_id          text primary key,
  snapshot_id             text not null references data_fabric.source_snapshots(snapshot_id),
  source_id               text not null references data_fabric.sources(source_id),
  -- 64-bit truncation of sha256(sourceRecordId), hex encoded. The full key is
  -- in the prior snapshot's parcel_snapshot_observations row.
  source_record_key_hash  text not null check (source_record_key_hash ~ '^[0-9a-f]{1,16}$'),
  run_id                  text not null references data_fabric.source_runs(run_id),
  observed_at             timestamptz not null,
  -- Deliberately not an enum with a 'deleted' member. A parcel missing from one
  -- file is a fact about the file; a partial export and a genuine retirement
  -- produce an identical signal, and only later snapshots distinguish them.
  change_kind             text not null default 'parcel_missing_from_latest_source'
                            check (change_kind = 'parcel_missing_from_latest_source'),
  unique (snapshot_id, source_record_key_hash)
);
create index if not exists psa_snapshot_idx on data_fabric.parcel_snapshot_absences(snapshot_id);
create index if not exists psa_source_idx on data_fabric.parcel_snapshot_absences(source_id, observed_at desc);

-- ------------------------------------------------- resolution lookup ---------

-- The projection is rebuilt by streaming merge, and consumers look properties up
-- by parcel. Both want this index; neither had it.
create index if not exists pr_parcel_idx
  on data_fabric.property_resolutions(county_fips, normalized_parcel);
create index if not exists pr_authority_idx
  on data_fabric.property_resolutions(authoritative_source_id)
  where authoritative_source_id is not null;

-- ============================================================================
-- Re-apply the security posture to the table this migration added, exactly as
-- 0002 and 0003 do, so the invariant holds after every migration rather than
-- only after the one that happens to run last.
-- ============================================================================

revoke all on all tables in schema data_fabric from public;
revoke all on all tables in schema data_fabric_restricted from public;

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename from pg_tables
    where schemaname in ('data_fabric', 'data_fabric_restricted')
  loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('alter table %I.%I force row level security', r.schemaname, r.tablename);
  end loop;
end
$$;

do $$
declare
  r record;
  role_name text;
begin
  for r in
    select schemaname, tablename from pg_tables
    where schemaname in ('data_fabric', 'data_fabric_restricted')
  loop
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        if not exists (
          select 1 from pg_policies
          where schemaname = r.schemaname and tablename = r.tablename
            and policyname = format('deny_%s', role_name)
        ) then
          execute format(
            'create policy %I on %I.%I as restrictive for all to %I using (false) with check (false)',
            format('deny_%s', role_name), r.schemaname, r.tablename, role_name
          );
        end if;
      end if;
    end loop;
  end loop;
end
$$;
