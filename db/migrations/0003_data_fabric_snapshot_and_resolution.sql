-- ============================================================================
-- Reivesti Data Fabric — snapshot sources, assessor observations, and
-- authoritative property resolution (DF-0C)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- DF-0B ingested an append-only event feed (eCRV filings). A county assessor
-- roll is a different shape: a periodic SNAPSHOT of a state of the world. Three
-- things follow, and this migration adds exactly those and nothing more.
--
--   1. A snapshot has identity, a completeness claim, and a reconciliation
--      result. A run over 448,000 features that silently fetched 447,000 must be
--      detectable after the fact.
--   2. A row's absence from the latest snapshot is a fact about the snapshot,
--      not about the world. "Not in the September file" is not "demolished".
--   3. Assessor values and characteristics are observations at a point in time,
--      never eternal truths. A 2026 market value must not overwrite a 2025 one.
--
-- Plus the DF-0C convergence concept: a property's resolution is a FOLD over the
-- identifier observations that point at it, not a mutable flag on any one of
-- them. That is what makes eCRV-then-assessor and assessor-then-eCRV produce the
-- same answer, and it is why no prior observation is ever rewritten.
-- ============================================================================

-- ---------------------------------------------------------------- snapshots --

-- One row per (source, snapshot). Distinct from source_releases: a release is
-- what the publisher published; a snapshot is the state of the world it claims
-- to describe, together with what we managed to retrieve of it.
create table if not exists data_fabric.source_snapshots (
  snapshot_id            text primary key,
  source_id              text not null references data_fabric.sources(source_id),
  release_id             text references data_fabric.source_releases(release_id),
  artifact_id            text references data_fabric.source_artifacts(artifact_id),
  run_id                 text references data_fabric.source_runs(run_id),
  reference_period       text not null,
  captured_at            timestamptz not null,
  -- The count the source itself reported, when it can be asked. Without this,
  -- "we ingested everything" is an assertion rather than a measurement.
  source_reported_count  integer,
  retrieved_count        integer not null default 0,
  parsed_count           integer not null default 0,
  accepted_count         integer not null default 0,
  quarantined_count      integer not null default 0,
  duplicate_count        integer not null default 0,
  -- complete: retrieved == reported. partial: fewer, and we know it.
  -- unverifiable: the source exposes no count to reconcile against.
  completeness           text not null default 'unverifiable'
                           check (completeness in ('complete','partial','unverifiable')),
  -- Digest of the service/layer metadata the snapshot was taken under, so a
  -- provider-side schema change between snapshots is visible.
  source_schema_digest   text,
  unique (source_id, reference_period)
);
create index if not exists ss_source_captured_idx on data_fabric.source_snapshots(source_id, captured_at desc);

-- One immutable sighting of one parcel row in one snapshot. Append-only: a later
-- snapshot adds rows, it never edits these.
create table if not exists data_fabric.parcel_snapshot_observations (
  observation_id       text primary key,
  snapshot_id          text not null references data_fabric.source_snapshots(snapshot_id),
  source_id            text not null references data_fabric.sources(source_id),
  source_record_id     text not null,
  county_fips          text not null,
  normalized_parcel    text not null,
  property_id          text references data_fabric.properties(property_id),
  -- How this row compares with the same key in the previous snapshot.
  change_kind          text not null check (change_kind in (
                         'new_parcel_observed',
                         'unchanged_parcel',
                         'parcel_attributes_changed',
                         'parcel_missing_from_latest_source',
                         'parcel_reappeared')),
  -- Digest of the full source row, so 'unchanged' is a measurement.
  content_digest       text not null,
  -- Which attribute groups differed from the prior snapshot.
  changed_field_groups text[] not null default '{}',
  -- The source's own lifecycle flag (Hennepin: 0 current, 3 non-current, D in
  -- process). A parcel can be present and non-current, which is not absence.
  source_status_code   text,
  artifact_id          text not null references data_fabric.source_artifacts(artifact_id),
  run_id               text not null references data_fabric.source_runs(run_id),
  observed_at          timestamptz not null,
  raw_record_hash      text not null,
  parser_version       text not null,
  normalization_version text not null,
  unique (snapshot_id, source_record_id)
);
create index if not exists pso_snapshot_idx on data_fabric.parcel_snapshot_observations(snapshot_id, change_kind);
create index if not exists pso_parcel_idx on data_fabric.parcel_snapshot_observations(county_fips, normalized_parcel);

-- ------------------------------------------------------ time-aware values ----

-- Assessment values as observed in one snapshot. Never updated in place: a new
-- snapshot inserts a new row, so the 2025 figure survives the 2026 one.
create table if not exists data_fabric.assessment_observations (
  observation_id        text primary key,
  property_id           text references data_fabric.properties(property_id),
  county_fips           text not null,
  normalized_parcel     text not null,
  snapshot_id           text not null references data_fabric.source_snapshots(snapshot_id),
  -- Null when the source states no assessment year. Recording null is honest;
  -- inferring the year from the snapshot date would be inventing data.
  assessment_year       integer,
  -- Sub-record ordinal: a parcel may carry several classified portions.
  tier                  smallint not null default 1,
  property_type_code    text,
  property_type_name    text,
  homestead_code        text,
  land_value_minor      bigint,
  building_value_minor  bigint,
  machinery_value_minor bigint,
  total_value_minor     bigint,
  taxable_value_minor   bigint,
  net_tax_capacity_minor bigint,
  net_tax_minor         bigint,
  source_id             text not null references data_fabric.sources(source_id),
  source_record_id      text not null,
  artifact_id           text not null references data_fabric.source_artifacts(artifact_id),
  run_id                text not null references data_fabric.source_runs(run_id),
  observed_at           timestamptz not null,
  raw_record_hash       text not null,
  parser_version        text not null,
  normalization_version text not null,
  unique (snapshot_id, source_record_id, tier)
);
create index if not exists ao_property_idx on data_fabric.assessment_observations(property_id, observed_at desc);
create index if not exists ao_parcel_idx on data_fabric.assessment_observations(county_fips, normalized_parcel);

-- Physical and descriptive characteristics as observed. Year built gets
-- corrected; building area changes. Both are observations, not eternal facts.
create table if not exists data_fabric.property_characteristic_observations (
  observation_id        text primary key,
  property_id           text references data_fabric.properties(property_id),
  county_fips           text not null,
  normalized_parcel     text not null,
  snapshot_id           text not null references data_fabric.source_snapshots(snapshot_id),
  year_built            integer,
  parcel_area_sq_ft     numeric,
  -- Everything else the source supplies, typed but not modelled as columns until
  -- a consumer needs it. Adding a column later is cheaper than guessing now.
  characteristics       jsonb not null default '{}'::jsonb,
  source_id             text not null references data_fabric.sources(source_id),
  source_record_id      text not null,
  artifact_id           text not null references data_fabric.source_artifacts(artifact_id),
  run_id                text not null references data_fabric.source_runs(run_id),
  observed_at           timestamptz not null,
  raw_record_hash       text not null,
  parser_version        text not null,
  normalization_version text not null,
  unique (snapshot_id, source_record_id)
);
create index if not exists pco_property_idx on data_fabric.property_characteristic_observations(property_id, observed_at desc);

-- ------------------------------------------------------------- resolution ----

-- The current resolution of one canonical property. This is a PROJECTION,
-- recomputed as a fold over every identifier observation pointing at the
-- property. Because a fold over a set is order-independent, ingesting eCRV then
-- the assessor gives the same answer as the assessor then eCRV.
--
-- Note what this table does NOT do: it never edits the observations it folds
-- over. The eCRV row keeps saying "preliminary" forever, because that is what
-- eCRV said.
create table if not exists data_fabric.property_resolutions (
  property_id              text primary key references data_fabric.properties(property_id),
  county_fips              text not null,
  normalized_parcel        text not null,
  state                    text not null check (state in ('resolved','provisional','ambiguous','unresolved')),
  -- The source whose evidence justifies 'resolved'. Null while provisional.
  authoritative_source_id  text references data_fabric.sources(source_id),
  authoritative_observation_id text references data_fabric.property_identifier_observations(observation_id),
  resolution_method        text not null,
  -- When the property first reached its current state.
  resolved_at              timestamptz,
  -- Every identifier observation folded into this decision.
  evidence_observation_ids text[] not null default '{}',
  contributing_source_ids  text[] not null default '{}',
  updated_at               timestamptz not null default now(),
  constraint resolution_requires_authority check (
    (state = 'resolved') = (authoritative_source_id is not null)
  ),
  unique (county_fips, normalized_parcel)
);
create index if not exists pr_state_idx on data_fabric.property_resolutions(state);

-- Disagreements between sources that must not be resolved by guessing.
create table if not exists data_fabric.property_conflicts (
  conflict_id        text primary key,
  property_id        text references data_fabric.properties(property_id),
  county_fips        text not null,
  normalized_parcel  text,
  conflict_kind      text not null check (conflict_kind in (
                       'same_pid_different_address',
                       'duplicate_authoritative_row',
                       'pid_absent_from_authoritative_source',
                       'address_matches_different_pid')),
  severity           text not null check (severity in ('info','warn','blocking')),
  detail             jsonb not null default '{}'::jsonb,
  observation_ids    text[] not null default '{}',
  detected_at        timestamptz not null,
  run_id             text not null references data_fabric.source_runs(run_id),
  -- Conflicts are resolved by a human or by better evidence, never by ingestion.
  status             text not null default 'open' check (status in ('open','accepted','dismissed')),
  unique (conflict_kind, county_fips, normalized_parcel, run_id)
);
create index if not exists pc_open_idx on data_fabric.property_conflicts(status, conflict_kind);

-- ------------------------------------------------------- extend party roles --

-- An assessor roll names an owner of record and a taxpayer. Neither is a
-- grantee, and neither is a reconstructed deed-based ownership history.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'party_observations_role_check'
      and conrelid = 'data_fabric.party_observations'::regclass
  ) then
    alter table data_fabric.party_observations drop constraint party_observations_role_check;
  end if;
end
$$;

alter table data_fabric.party_observations
  add constraint party_observations_role_check
  check (role in (
    'buyer','seller','grantor','grantee','borrower','lender',
    'assessor_owner_of_record','assessor_taxpayer',
    'other'));

-- Canonical events gain the assessor-supported set. Deliberately absent:
-- PROPERTY_SOLD, BUYER_ACQUIRED_PROPERTY, FORECLOSURE, DISTRESS, ACTIVE_BUYER.
-- An assessor roll cannot support any of them.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'canonical_events_event_type_check'
      and conrelid = 'data_fabric.canonical_events'::regclass
  ) then
    alter table data_fabric.canonical_events drop constraint canonical_events_event_type_check;
  end if;
end
$$;

alter table data_fabric.canonical_events
  add constraint canonical_events_event_type_check
  check (event_type in (
    'REAL_ESTATE_TRANSFER_OBSERVED',
    'PROPERTY_SALE_OBSERVED',
    'FINANCING_OBSERVED',
    'PARCEL_OBSERVED',
    'PARCEL_RESOLVED',
    'PARCEL_ATTRIBUTES_CHANGED',
    'ASSESSOR_OWNER_OBSERVED',
    'ASSESSMENT_OBSERVED',
    'PROPERTY_CHARACTERISTICS_OBSERVED'));

-- ============================================================================
-- Re-apply the security posture to the tables this migration added.
-- Identical to 0002 and idempotent, so the invariant "every Fabric table has
-- forced RLS and an explicit denial per application role" holds after every
-- migration rather than only after 0002.
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
