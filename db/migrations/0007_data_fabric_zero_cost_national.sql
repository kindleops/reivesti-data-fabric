-- ============================================================================
-- Reivesti Data Fabric — zero-cost doctrine, national coverage, partitions (DF-0G)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- Three things arrive together because they are one decision:
--
-- 1. COST IS A FIRST-CLASS FACT. `sources.cost_class` and `sources.source_role`
--    make "Reivesti does not pay for core data" a constraint the database can
--    enforce rather than a policy someone remembers. The check at the bottom of
--    the sources block is the doctrine: a paid source cannot hold a core role.
--
-- 2. GEOGRAPHY HAS A LIFECYCLE. Connecticut replaced eight counties with nine
--    planning regions, and a deed recorded in New Haven County in 2019 was
--    recorded there. Retired identities are RETAINED, and a successor is
--    recorded only where an authoritative crosswalk states one.
--
-- 3. PROJECTION IS PARTITIONED. Each partition owns its digests, its generation
--    and its activation, so recomputing one county is one row here — and the
--    estate's digest is built from its children rather than from a fold over
--    everything.
--
-- Coverage is a RELATIONSHIP, not a source property: one statewide source covers
-- 87 counties from one row, and materialising 87 source definitions to say so
-- would be 87 lies about how many sources exist.
-- ============================================================================

-- ------------------------------------------------------ cost and role -------

alter table data_fabric.sources
  add column if not exists cost_class text not null default 'UNKNOWN_COST'
    check (cost_class in (
      'FREE_BULK','FREE_API','FREE_PUBLIC_DOWNLOAD','FREE_OPEN_DATA','FREE_WEB_SERVICE',
      'FREE_DATA_REQUEST','FREE_MANUAL_DELIVERY','FIRST_PARTY',
      'PAID_OPTIONAL','PAID_SUBSCRIPTION','PAID_PER_RECORD','UNKNOWN_COST'));

alter table data_fabric.sources
  add column if not exists source_role text
    check (source_role in (
      'CORE_CANONICAL_SOURCE','CORE_SUPPORTING_SOURCE','OPTIONAL_ENRICHMENT',
      'VALIDATION_ONLY','MANUAL_RESEARCH_ONLY','DEFERRED','REJECTED'));

-- Administrative state of a free access path. Source OPERATIONS metadata: it
-- says where a request has got to, never what the data contains.
alter table data_fabric.sources
  add column if not exists access_request_state text not null default 'NOT_REQUIRED'
    check (access_request_state in (
      'NOT_REQUIRED','NOT_REQUESTED','REQUESTED','AWAITING_RESPONSE',
      'APPROVED','DENIED','FEE_QUOTED','DELIVERED'));
alter table data_fabric.sources add column if not exists access_request_contact text;
alter table data_fabric.sources add column if not exists access_request_basis text;
alter table data_fabric.sources add column if not exists access_requested_at timestamptz;
-- Set when a free request comes back with a price. That is a COST change, and
-- the constraint below makes it impossible to keep calling the source free.
alter table data_fabric.sources add column if not exists quoted_fee_usd numeric(12,2);

do $$
begin
  -- THE DOCTRINE, as a constraint. A source that costs money cannot hold a core
  -- role, so a paid source cannot become a canonical dependency by an edit that
  -- nobody reviews.
  if not exists (select 1 from pg_constraint where conname = 'sources_core_role_is_zero_cost') then
    alter table data_fabric.sources add constraint sources_core_role_is_zero_cost check (
      source_role is null
      or source_role not in ('CORE_CANONICAL_SOURCE','CORE_SUPPORTING_SOURCE')
      or cost_class in (
        'FREE_BULK','FREE_API','FREE_PUBLIC_DOWNLOAD','FREE_OPEN_DATA','FREE_WEB_SERVICE',
        'FREE_DATA_REQUEST','FREE_MANUAL_DELIVERY','FIRST_PARTY')
    );
  end if;

  -- A quoted fee and a zero-cost class cannot both be true.
  if not exists (select 1 from pg_constraint where conname = 'sources_fee_quote_is_not_free') then
    alter table data_fabric.sources add constraint sources_fee_quote_is_not_free check (
      quoted_fee_usd is null
      or quoted_fee_usd = 0
      or cost_class not in (
        'FREE_BULK','FREE_API','FREE_PUBLIC_DOWNLOAD','FREE_OPEN_DATA','FREE_WEB_SERVICE',
        'FREE_DATA_REQUEST','FREE_MANUAL_DELIVERY','FIRST_PARTY')
    );
  end if;
end
$$;

-- --------------------------------------------------- geography lifecycle ----

alter table data_fabric.jurisdictions
  add column if not exists county_equivalent_type text
    check (county_equivalent_type in (
      'county','parish','borough','census_area','municipality','municipio',
      'planning_region','independent_city','federal_district','district','island','territory'));

alter table data_fabric.jurisdictions
  add column if not exists geography_status text not null default 'active'
    check (geography_status in ('active','replaced','retired','source_legacy'));

-- Successors, ONLY where an authoritative crosswalk states them. Empty for the
-- retired Connecticut counties: the planning regions do not correspond
-- one-to-one, and inventing a mapping would relocate historical records.
alter table data_fabric.jurisdictions
  add column if not exists replaced_by text[] not null default '{}';
alter table data_fabric.jurisdictions add column if not exists geography_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jurisdiction_successor_needs_replacement') then
    alter table data_fabric.jurisdictions add constraint jurisdiction_successor_needs_replacement check (
      cardinality(replaced_by) = 0 or geography_status in ('replaced','retired')
    );
  end if;
end
$$;
create index if not exists jurisdictions_status_idx on data_fabric.jurisdictions(geography_status);

-- ------------------------------------------------------------ coverage ------

-- One row per (jurisdiction, capability, source). Derived from scope expansion,
-- never hand-maintained: a statewide source produces 87 rows and stays one source.
create table if not exists data_fabric.capability_coverage (
  coverage_id          text primary key,
  jurisdiction_id      text not null references data_fabric.jurisdictions(jurisdiction_id),
  capability           text not null,
  source_id            text not null references data_fabric.sources(source_id),
  mapping_id           text not null references data_fabric.source_jurisdiction_mappings(mapping_id),
  adapter_key          text not null,
  -- UNVERIFIED means nobody looked. UNAVAILABLE means someone looked and there
  -- is nothing. Collapsing them would turn the gap report into a list of things
  -- we forgot rather than things that do not exist.
  coverage_state       text not null check (coverage_state in (
                         'ACTIVE','READY_NOT_ACTIVATED','BLOCKED_ON_ACCESS','BLOCKED_ON_TERMS',
                         'BLOCKED_ON_COST','DISCOVERED','UNVERIFIED','UNAVAILABLE','DEFERRED')),
  activation_verdict   text not null,
  cost_class           text not null,
  automation_status    text not null,
  license_status       text not null,
  historical_depth     date,
  refresh_cadence      text not null,
  -- False for every paid source. A paid source may appear in the matrix and can
  -- never be what makes a jurisdiction count as covered.
  counts_as_core       boolean not null,
  evidence_url         text not null,
  last_verified_at     date,
  notes                text,
  unique (jurisdiction_id, capability, source_id)
);
create index if not exists cc_jurisdiction_idx on data_fabric.capability_coverage(jurisdiction_id, capability);
create index if not exists cc_capability_state_idx on data_fabric.capability_coverage(capability, coverage_state);
create index if not exists cc_core_idx on data_fabric.capability_coverage(counts_as_core) where counts_as_core;

-- --------------------------------------------------- source discovery -------

-- A shared technical platform. Modelled separately from the sources on it
-- because that separation is what makes one connector serve many jurisdictions.
create table if not exists data_fabric.source_platforms (
  platform_id             text primary key,
  name                    text not null,
  transport_pattern       text not null,
  authentication_pattern  text not null check (authentication_pattern in ('none','api_key','oauth','account','varies')),
  pagination_pattern      text not null,
  common_capabilities     text[] not null default '{}',
  -- True when one implementation serves every jurisdiction on the platform
  -- given only configuration.
  connector_reusable      boolean not null,
  -- Where reuse stops. Same vendor does NOT mean same schema, and this column
  -- exists so that caveat travels with the platform.
  reuse_boundary          text not null
);

-- A candidate is NOT a source. Its fields are hypotheses, and the runtime never
-- reads them: promotion to `sources` is a deliberate act with an evidence gate.
create table if not exists data_fabric.source_candidates (
  candidate_id            text primary key,
  authority               text not null,
  source_name             text not null,
  scope_kind              text not null check (scope_kind in ('nation','states','all_counties_in_states','counties')),
  scope_values            text[] not null default '{}',
  capabilities            text[] not null check (cardinality(capabilities) > 0),
  official_url            text not null,
  access_hypothesis       text not null,
  cost_hypothesis         text not null,
  automation_hypothesis   text not null,
  license_hypothesis      text not null,
  bulk_available          boolean,
  api_available           boolean,
  open_data_portal        boolean,
  historical_depth        date,
  cadence                 text,
  platform_id             text references data_fabric.source_platforms(platform_id),
  verification_level      text not null check (verification_level in (
                            'UNVERIFIED','OFFICIAL_PAGE','OFFICIAL_DOCUMENTATION',
                            'VERIFIED','VERIFIED_LIVE','RULED_OUT')),
  last_researched_at      date not null,
  notes                   text not null default '',
  unique (authority, source_name)
);
create index if not exists sc_verification_idx on data_fabric.source_candidates(verification_level);
create index if not exists sc_platform_idx on data_fabric.source_candidates(platform_id);

-- Every claim a candidate makes has to point at something a reviewer can open.
-- "It's free" with no link is a rumour, and rumours are how a paid source ends
-- up in a core pipeline.
create table if not exists data_fabric.source_candidate_evidence (
  evidence_id    text primary key,
  candidate_id   text not null references data_fabric.source_candidates(candidate_id),
  claim          text not null,
  url            text not null,
  -- Quoted, not paraphrased into a conclusion.
  quote          text not null,
  evidence_kind  text not null check (evidence_kind in (
                   'official_authority','official_terms','official_documentation','api_metadata','secondary')),
  retrieved_at   date not null
);
create index if not exists sce_candidate_idx on data_fabric.source_candidate_evidence(candidate_id, claim);

-- ----------------------------------------------------- projection state -----

-- One row per activated projection partition. The estate's digest is built from
-- these children, so a one-county update changes one row and the global digest
-- follows — without re-reading any other county.
create table if not exists data_fabric.projection_partitions (
  partition_id      text primary key,
  domain            text not null check (domain in (
                      'PROPERTY_RESOLUTION','TRANSACTION_RESOLUTION',
                      'ORGANIZATION_RESOLUTION','PERSON_RESOLUTION')),
  -- A jurisdiction id: a county for property, the nation for organizations.
  -- Organization identity crosses jurisdictions, so it is deliberately not
  -- county-scoped; see docs/NATIONAL-COVERAGE.md.
  scope_id          text not null,
  generation        text not null,
  -- Both are order-independent multiset digests, so a partition's identity does
  -- not depend on the order its evidence arrived or its rows were emitted.
  input_digest      text not null,
  output_digest     text not null,
  resolver_version  text not null,
  row_count         integer not null check (row_count >= 0),
  input_row_count   integer not null check (input_row_count >= 0),
  activated_at      timestamptz not null,
  run_id            text not null references data_fabric.source_runs(run_id),
  unique (domain, scope_id)
);
create index if not exists pp_domain_idx on data_fabric.projection_partitions(domain);
create index if not exists pp_run_idx on data_fabric.projection_partitions(run_id);

-- What a run recomputed, and how each activation went. Recorded because a
-- multi-partition run is NOT globally atomic: partitions are independent, so a
-- partial application leaves each one individually consistent at possibly
-- different generations. That is stated here rather than implied.
create table if not exists data_fabric.run_partition_activations (
  run_id           text not null references data_fabric.source_runs(run_id),
  partition_id     text not null,
  activation_state text not null check (activation_state in ('activated','failed','skipped')),
  generation       text,
  reason           text,
  primary key (run_id, partition_id),
  constraint activation_generation_consistency check (
    (activation_state = 'activated') = (generation is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Row-level security over every table, including the ones added above.
-- ---------------------------------------------------------------------------

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
