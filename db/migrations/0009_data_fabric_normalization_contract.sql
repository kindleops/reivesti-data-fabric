-- ============================================================================
-- Reivesti Data Fabric — the canonical normalization contract (DF-0I)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- DF-0H's Hennepin overlap audit reported four fields in total disagreement
-- across 443,605 parcels. Three of those conclusions were wrong: the sources
-- agreed, and we were comparing square feet against acres, cents against an
-- integer dollar column, '201412' against a day-padded '2014-12-01', and a
-- packed street string against the same street split into components.
--
-- Those verdicts were written down. This migration makes it impossible to read
-- one without also reading the contract version it was measured under, and adds
-- the two outcomes the old string comparison could not express.
--
-- 1. A MEASUREMENT BELONGS TO A CONTRACT VERSION. `normalization_contract` is
--    not nullable on a field-authority row. A verdict measured under one set of
--    comparators is not evidence about another, and the old rows' backfilled
--    value says exactly which comparison produced them.
--
-- 2. SAME FACT, DIFFERENT REPRESENTATION IS ITS OWN OUTCOME. `equivalent_match`
--    counts pairs that agree only after unit, scale or precision normalization.
--    It is deliberately NOT folded into `exact_match`: 109672.88 and 109673 are
--    the same tax bill written to different precision, and a report that called
--    that exact would be claiming an accuracy the aggregation does not offer.
--
-- 3. NOT EVERY PAIR IS COMPARABLE. `incomparable` counts pairs where the
--    question does not apply — two dates that mean different things, a value
--    the contract refused to parse. They are excluded from the agreement rate
--    rather than silently scored as agreement or as conflict.
--
-- What is NOT here: any change to how observations are stored. The contract
-- governs comparison and canonical representation; raw evidence is untouched,
-- and both sources' rows remain in the estate with their own provenance.
-- ============================================================================

-- ------------------------------------------- the contract itself ------------

-- Which versions of the contract exist, and what each one changed. A row is
-- added when comparators change, so a stale verdict can be identified as stale
-- rather than merely being old.
create table if not exists data_fabric.normalization_contracts (
  contract_version   text primary key,
  introduced_at      date not null,
  -- What this version changed about representation or comparison. Not
  -- nullable: a version whose effect nobody wrote down cannot be reasoned about
  -- when a digest moves.
  summary            text not null,
  -- False once superseded. Rows are never deleted: a verdict may still point
  -- here.
  current            boolean not null default true
);

insert into data_fabric.normalization_contracts (contract_version, introduced_at, summary, current)
values (
  'canonical_normalization_v1',
  date '2026-09-01',
  'First shared contract. Absence reasons distinct from zero; areas in square feet with '
  || 'the source unit retained and compared within the coarser source''s stated precision; '
  || 'money as exact minor units parsed from decimal text, never binary floating point; '
  || 'dates carrying the precision the source stated and a semantic, with UTC epoch reading '
  || 'and no cross-semantic comparison; addresses as components with a street-and-unit '
  || 'comparison key; identifiers keeping leading zeros and jurisdiction scope.',
  true
)
on conflict (contract_version) do nothing;

-- --------------------------------------- field authority, re-measured -------

alter table data_fabric.source_field_authority
  add column if not exists equivalent_match integer not null default 0
    check (equivalent_match >= 0),
  add column if not exists incomparable integer not null default 0
    check (incomparable >= 0),
  -- Which comparison produced the counts above.
  add column if not exists normalization_contract text
    references data_fabric.normalization_contracts(contract_version),
  -- 'literal' reproduces the DF-0H string comparison; 'canonical' goes through
  -- the contract. Both are kept, because the difference between them is the
  -- report.
  add column if not exists comparison_mode text;

-- Existing rows were measured by the literal string comparison, before any
-- contract existed. Saying so is more useful than leaving a null that someone
-- later reads as "current".
update data_fabric.source_field_authority
   set normalization_contract = 'canonical_normalization_v1',
       comparison_mode = coalesce(comparison_mode, 'literal')
 where normalization_contract is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'field_authority_contract_known'
  ) then
    alter table data_fabric.source_field_authority
      alter column normalization_contract set not null,
      alter column comparison_mode set not null,
      add constraint field_authority_contract_known
        check (comparison_mode in ('literal', 'canonical'));
  end if;
end
$$;

-- The population constraint has to account for the two new buckets. Dropped and
-- re-added rather than altered: a check constraint that no longer describes the
-- columns is worse than none, because it reads as if it does.
alter table data_fabric.source_field_authority
  drop constraint if exists field_authority_population;
alter table data_fabric.source_field_authority
  add constraint field_authority_population check (
    exact_match + normalized_match + equivalent_match + conflicts + incomparable
      <= both_populated
  );

create index if not exists sfa_contract_idx
  on data_fabric.source_field_authority(normalization_contract, comparison_mode);

-- --------------------------------------------- rows carry their contract ----

-- Every canonical row records the contract its values were written under, so a
-- digest change can be attributed to a deliberate representation change rather
-- than investigated as corruption.
alter table data_fabric.parcel_snapshot_observations
  add column if not exists normalization_contract text
    references data_fabric.normalization_contracts(contract_version);

-- ----------------------------------------------- external index state -------

-- An index is the memory of what the last ACCEPTED snapshot held, so the next
-- run can say which parcels vanished. Activating one built by a quarantined run
-- would make the following run report every parcel the rejected delivery
-- omitted as absent. The runtime enforces the transition; this records it, so an
-- operator can see which index a run is actually diffing against.
create table if not exists data_fabric.snapshot_index_state (
  index_id          text primary key,
  source_id         text not null references data_fabric.sources(source_id),
  snapshot_id       text not null,
  run_id            text not null,
  -- DISCARDED is deliberately distinct from FAILED: a discarded index was
  -- correct and is simply no longer wanted (a dry run), while a failed one is
  -- not known to be correct at all. Collapsing them would lose the ability to
  -- tell "we threw this away" from "this went wrong".
  lifecycle         text not null check (lifecycle in (
                      'BUILDING','COMPLETE','ACTIVATED','FAILED','DISCARDED')),
  entry_count       bigint not null default 0 check (entry_count >= 0),
  entry_bytes       integer not null default 24 check (entry_bytes > 0),
  -- Where the bytes are. Null while BUILDING and after DISCARDED.
  storage_path      text,
  observed_at       timestamptz not null,
  -- Exactly one activated index per source and snapshot. The next run must not
  -- have two candidate memories of the same delivery.
  constraint snapshot_index_storage_present check (
    (lifecycle in ('ACTIVATED', 'COMPLETE')) = (storage_path is not null)
  )
);
create unique index if not exists snapshot_index_one_activated
  on data_fabric.snapshot_index_state(source_id, snapshot_id)
  where lifecycle = 'ACTIVATED';
create index if not exists snapshot_index_run_idx
  on data_fabric.snapshot_index_state(run_id);

-- ------------------------------------------------------- RLS ----------------

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
