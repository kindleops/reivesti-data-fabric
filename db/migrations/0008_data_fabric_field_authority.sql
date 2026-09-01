-- ============================================================================
-- Reivesti Data Fabric — field-level source authority (DF-0H)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- Hennepin County now appears in two legitimate free sources: its own ArcGIS
-- parcel service, and the Minnesota statewide aggregation that republishes it.
-- Both are the county's data. The question "which source wins" has no good
-- answer; "which source is authoritative for which FIELD" does, and these
-- tables are where that answer lives.
--
-- Three rules are encoded structurally:
--
-- 1. AUTHORITY IS PER FIELD. `source_field_authority` is keyed by field, not by
--    source. A state aggregation can be fresher on one attribute and thinner on
--    another, and a blanket winner throws away whichever half the loser was
--    better at.
--
-- 2. A VERDICT CARRIES ITS MEASUREMENT. `basis` is not nullable. A preference
--    with no evidence behind it is a preference someone will later be unable to
--    check or overturn.
--
-- 3. COVERAGE KEEPS EVERY SOURCE. `capability_source_preference` records a
--    preferred source AND the supporting ones, because "who else has this?" is
--    the question that matters when a source breaks. It is deliberately not a
--    boolean.
--
-- What is NOT here: any mechanism for deleting the losing observation. Both
-- sources' rows stay in the estate with their own provenance. A canonical
-- current value prefers one; the evidence keeps both.
-- ============================================================================

-- --------------------------------------------------- field authority --------

create table if not exists data_fabric.source_field_authority (
  authority_id            text primary key,
  -- Scope. A decision made for Hennepin does not silently govern Ramsey.
  jurisdiction_id         text not null references data_fabric.jurisdictions(jurisdiction_id),
  -- The canonical field or characteristic the decision governs.
  field                   text not null,
  direct_source_id        text not null references data_fabric.sources(source_id),
  aggregation_source_id   text not null references data_fabric.sources(source_id),
  verdict                 text not null check (verdict in (
                            'PREFER_DIRECT_COUNTY','PREFER_STATE_AGGREGATION',
                            'COEQUAL_OBSERVATIONS','SEMANTICALLY_DIFFERENT','UNRESOLVED')),
  -- The measurement that justified the verdict. Never nullable: a preference
  -- without evidence is one nobody can check.
  basis                   text not null,

  -- The agreement profile the verdict was derived from, retained so the verdict
  -- can be recomputed and disputed rather than merely believed.
  both_populated          integer not null default 0 check (both_populated >= 0),
  exact_match             integer not null default 0 check (exact_match >= 0),
  normalized_match        integer not null default 0 check (normalized_match >= 0),
  conflicts               integer not null default 0 check (conflicts >= 0),
  only_direct             integer not null default 0 check (only_direct >= 0),
  only_aggregation        integer not null default 0 check (only_aggregation >= 0),

  decided_at              timestamptz not null,
  -- The two sources compared must be different ones.
  constraint field_authority_distinct_sources check (direct_source_id <> aggregation_source_id),
  -- The matched populations cannot exceed the compared population.
  constraint field_authority_population check (exact_match + normalized_match + conflicts <= both_populated),
  unique (jurisdiction_id, field, direct_source_id, aggregation_source_id)
);
create index if not exists sfa_jurisdiction_idx on data_fabric.source_field_authority(jurisdiction_id);
create index if not exists sfa_verdict_idx on data_fabric.source_field_authority(verdict);

-- ------------------------------------------- capability preference ----------

-- Which source is preferred for a capability in a place, and which others also
-- supply it. Multiple sources per capability is the normal case and is modelled
-- as such.
create table if not exists data_fabric.capability_source_preference (
  preference_id          text primary key,
  jurisdiction_id        text not null references data_fabric.jurisdictions(jurisdiction_id),
  capability             text not null,
  -- Null while no field-level decision has established one. Null is the honest
  -- default, and it is not the same as "there is only one source".
  preferred_source_id    text references data_fabric.sources(source_id),
  -- Every other source that supplies this capability here. Never collapsed away:
  -- when the preferred source breaks, this column is the answer.
  supporting_source_ids  text[] not null default '{}',
  basis                  text not null,
  last_verified_at       date not null,
  unique (jurisdiction_id, capability)
);
create index if not exists csp_capability_idx on data_fabric.capability_source_preference(capability);

-- ------------------------------------------------ source supersession -------

-- A source is retired only on proof. Every condition must hold, and the row
-- records which ones were checked — so a retirement is auditable rather than a
-- decision someone remembers making.
create table if not exists data_fabric.source_supersession (
  supersession_id           text primary key,
  retired_source_id         text not null references data_fabric.sources(source_id),
  replacement_source_id     text not null references data_fabric.sources(source_id),
  redundant_field_for_field boolean not null,
  freshness_at_least_equal  boolean not null,
  no_unique_fields_lost     boolean not null,
  provenance_remains        boolean not null,
  operational_reason        text not null,
  decided_at                timestamptz not null,
  constraint supersession_distinct check (retired_source_id <> replacement_source_id),
  -- The row cannot exist unless every condition was met. "Broader coverage" is
  -- deliberately absent from the list: breadth is a reason to ADD a source,
  -- never a reason to remove one.
  constraint supersession_requires_proof check (
    redundant_field_for_field and freshness_at_least_equal
    and no_unique_fields_lost and provenance_remains
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
