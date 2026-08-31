-- ============================================================================
-- Reivesti Data Fabric — restricted contact plane
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- Phone numbers, email addresses and unbounded submitter free text live here
-- and nowhere else. The separation is structural as well as policy: no table in
-- `data_fabric` has a column that could hold a contact value, so there is no
-- path by which one leaks into market intelligence.
--
-- Two questions are kept apart, because they have different answers:
--   status        — may we retain this observation?
--   permitted_use — may we use this channel to contact a person?
-- `record_only` is the default and the only value ingestion assigns. A phone
-- number on a public filing is evidence the number was stated. It is not
-- consent, and no outbound, suppression or TCPA/DNC logic belongs in the Fabric.
-- ============================================================================

create schema if not exists data_fabric_restricted;

create table if not exists data_fabric_restricted.contact_observations (
  contact_observation_id text primary key,
  -- Set only once a party is genuinely resolved. Unresolved observations stand
  -- alone rather than being attached to a guess.
  party_id               text,
  -- Null for record-level material belonging to no single party.
  party_observation_id   text,
  contact_type           text not null check (contact_type in ('phone','email','contact_note','unstructured_submitter_block')),
  value                  text not null,
  source_id              text not null,
  source_record_id       text not null,
  observed_at            timestamptz not null,
  confidence             text not null check (confidence in ('source_stated','inferred')),
  permitted_use          text not null default 'record_only'
                           check (permitted_use in ('record_only','identity_resolution','operator_review')),
  status                 text not null check (status in ('observed','suppressed','protected_identity')),
  artifact_id            text not null,
  run_id                 text not null,
  raw_record_hash        text not null,
  parser_version         text not null,
  normalization_version  text not null
);
create index if not exists co_party_obs_idx on data_fabric_restricted.contact_observations(party_observation_id);
create index if not exists co_source_record_idx on data_fabric_restricted.contact_observations(source_id, source_record_id);

-- ============================================================================
-- Row level security
--
-- The Reivesti application authenticates users as `anon` and `authenticated`.
-- Neither role is granted anything in either Fabric schema. Access is via the
-- service role, which bypasses RLS, plus explicitly named projections created
-- later for the application to consume.
--
-- RLS with no permissive policy denies by default, but USAGE on the schema is
-- revoked as well so the tables are not even nameable from a client session.
-- ============================================================================

revoke all on schema data_fabric_restricted from public;
revoke all on all tables in schema data_fabric_restricted from public;
revoke all on schema data_fabric from public;
revoke all on all tables in schema data_fabric from public;

do $$
declare
  r record;
begin
  -- Every Fabric table has RLS enabled and forced. FORCE matters: without it a
  -- table owner still bypasses the policies, which is exactly the accident this
  -- boundary exists to prevent.
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('data_fabric', 'data_fabric_restricted')
  loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('alter table %I.%I force row level security', r.schemaname, r.tablename);
  end loop;
end
$$;

-- Explicit denial for the application-facing roles. RLS already denies by
-- default; these exist so an audit of pg_policies shows the intent rather than
-- an absence that a future migration might casually fill in.
do $$
declare
  r record;
  role_name text;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('data_fabric', 'data_fabric_restricted')
  loop
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        if not exists (
          select 1 from pg_policies
          where schemaname = r.schemaname
            and tablename = r.tablename
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

-- The artifact store holds raw source bytes, which for eCRV include contact
-- data. The bucket is private; only the Fabric service role signs reads.
-- (Bucket creation is a deployment step, recorded here so the expectation is
-- part of the reviewed schema rather than tribal knowledge.)
comment on schema data_fabric_restricted is
  'Restricted contact plane. No application role has USAGE. Reads are service-role only. '
  'Raw artifacts containing the same data live in a private object-storage bucket, not in a public bucket.';

comment on schema data_fabric is
  'Reivesti Data Fabric canonical and provenance schema. Owned by the Data Fabric; '
  'the Reivesti application consumes named projections, never these tables directly.';
