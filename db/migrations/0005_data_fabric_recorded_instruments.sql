-- ============================================================================
-- Reivesti Data Fabric — recorded instruments (DF-0E)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- The first recorded-instrument source family. The schema encodes three
-- distinctions that are easy to lose and expensive to get wrong:
--
-- 1. A DOCUMENT is not an EVENT. `recorded_instruments` records what was filed.
--    Whether that filing conveyed anything is a separate, conditional claim, and
--    whether it was a *sale* is not claimed here at all — eCRV is the source for
--    sale economics and a deed carries no reliable price.
--
-- 2. ABSTRACT and TORRENS are different registration systems (Minn. Stat.
--    ch. 507 vs ch. 508), separately numbered by the County Recorder and the
--    Registrar of Titles. Document number alone is therefore NOT an identity,
--    and the unique constraint says so.
--
-- 3. An UNRESOLVED REFERENCE IS DATA. A 2024 satisfaction pointing at a 2009
--    mortgage stays unresolved until backfill reaches 2009. Deleting it would
--    destroy the lineage at exactly the moment it was about to become useful, so
--    the table stores the document NUMBER and resolves the id later.
-- ============================================================================

-- --------------------------------------------------------- instruments ------

create table if not exists data_fabric.recorded_instrument_documents (
  instrument_id             text primary key,
  source_id                 text not null references data_fabric.sources(source_id),
  source_record_id          text not null,
  jurisdiction_id           text not null references data_fabric.jurisdictions(jurisdiction_id),
  county_fips               text not null,
  document_number           text not null,
  normalized_document_number text not null,
  -- Never guessed. 'unknown' is a real answer that narrows what identity and
  -- reference resolution may conclude.
  registration_system       text not null
                              check (registration_system in ('abstract','torrens','both','unknown')),
  -- Torrens only: the Certificate of Title the document is memorialised on.
  certificate_of_title_number text,
  document_type_raw         text not null,
  document_type_normalized  text not null check (document_type_normalized in (
                              'CONVEYANCE','MORTGAGE','MORTGAGE_ASSIGNMENT','MORTGAGE_RELEASE',
                              'CONTRACT_FOR_DEED','LIEN','LIEN_RELEASE','FORECLOSURE_RELATED',
                              'CORRECTION','LEASE_RELATED','TITLE_RELATED','OTHER')),
  -- The recorder is authoritative for this, and for the document number and
  -- type. It is authoritative for nothing else on this row.
  recorded_at               timestamptz,
  document_date             timestamptz,
  -- Only ever an indexed field. Never parsed from a document image, never
  -- derived from tax stamps or recording fees.
  stated_consideration_minor bigint,
  book_page                 text,
  artifact_id               text not null references data_fabric.source_artifacts(artifact_id),
  run_id                    text not null references data_fabric.source_runs(run_id),
  observed_at               timestamptz not null,
  raw_record_hash           text not null,
  parser_version            text not null,
  normalization_version     text not null,
  -- Identity is (county, system, number). Two counties, and the Recorder and
  -- the Registrar within one county, all number from one.
  unique (county_fips, registration_system, normalized_document_number)
);
create index if not exists rid_recorded_at_idx on data_fabric.recorded_instrument_documents(county_fips, recorded_at desc);
create index if not exists rid_family_idx on data_fabric.recorded_instrument_documents(document_type_normalized, recorded_at desc);
create index if not exists rid_number_idx on data_fabric.recorded_instrument_documents(county_fips, normalized_document_number);

-- ------------------------------------------------------------- parties ------

create table if not exists data_fabric.instrument_parties (
  instrument_id        text not null references data_fabric.recorded_instrument_documents(instrument_id),
  party_observation_id text not null references data_fabric.party_observations(observation_id),
  -- Verbatim. The normalized role drives ownership direction, so the source's
  -- own word has to survive for anyone checking the normalisation.
  raw_role             text not null,
  normalized_role      text not null check (normalized_role in (
                         'GRANTOR','GRANTEE','MORTGAGOR','MORTGAGEE','ASSIGNOR','ASSIGNEE',
                         'TRUSTOR','TRUSTEE','BENEFICIARY','BORROWER','LENDER','OTHER')),
  sequence             integer,
  primary key (instrument_id, party_observation_id, normalized_role)
);
create index if not exists ip_party_idx on data_fabric.instrument_parties(party_observation_id);
create index if not exists ip_role_idx on data_fabric.instrument_parties(normalized_role);

-- ------------------------------------------------------ property links ------

create table if not exists data_fabric.instrument_property_links (
  -- A surrogate key, because a link may name no property at all and a primary
  -- key cannot be an expression over a nullable column.
  link_id            text primary key,
  instrument_id      text not null references data_fabric.recorded_instrument_documents(instrument_id),
  property_id        text references data_fabric.properties(property_id),
  county_fips        text not null,
  normalized_parcel  text,
  -- The gap between DIRECT_PARCEL and everything below is the gap between a
  -- fact and a hypothesis. Only the top two may move ownership.
  link_state         text not null check (link_state in (
                       'DIRECT_PARCEL','STRONG_DOCUMENT_PROPERTY_LINK','PROVISIONAL',
                       'AMBIGUOUS','UNRESOLVED')),
  link_method        text not null,
  legal_description_id text,
  observed_at        timestamptz not null,
  -- A link that names no property cannot claim to be resolved, and a resolved
  -- one must name a property.
  constraint link_state_consistency check (
    (link_state in ('DIRECT_PARCEL','STRONG_DOCUMENT_PROPERTY_LINK','PROVISIONAL')) = (property_id is not null)
  )
);
-- One link per (instrument, property, state). The expression handles the
-- property-less case, which a plain unique constraint cannot.
create unique index if not exists ipl_unique_idx
  on data_fabric.instrument_property_links(instrument_id, coalesce(property_id, ''), link_state);
create index if not exists ipl_property_idx on data_fabric.instrument_property_links(property_id);
create index if not exists ipl_state_idx on data_fabric.instrument_property_links(link_state);

-- --------------------------------------------------- legal descriptions -----

create table if not exists data_fabric.legal_descriptions (
  legal_description_id text primary key,
  instrument_id        text not null references data_fabric.recorded_instrument_documents(instrument_id),
  sequence             integer not null,
  -- The record. Everything below is a convenience derived from it.
  raw                  text not null,
  parse_status         text not null check (parse_status in ('unparsed','partial','structured')),
  parser_version       text not null,
  confidence           numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  lot                  text,
  block                text,
  addition             text,
  unit                 text,
  section              text,
  township             text,
  range                text,
  observed_at          timestamptz not null,
  unique (instrument_id, sequence),
  -- Structured components are only meaningful when the parse actually succeeded.
  constraint parsed_components_need_a_parse check (
    parse_status <> 'unparsed'
    or (lot is null and block is null and addition is null and unit is null
        and section is null and township is null and range is null)
  )
);
create index if not exists ld_plat_idx on data_fabric.legal_descriptions(addition, block, lot)
  where parse_status = 'structured';

-- ---------------------------------------------------------- references ------

create table if not exists data_fabric.instrument_references (
  reference_id                 text primary key,
  from_instrument_id           text not null references data_fabric.recorded_instrument_documents(instrument_id),
  -- The NUMBER, not an id. The target may not be in the estate yet, and that is
  -- the normal case during historical backfill.
  to_document_number           text not null,
  to_normalized_document_number text not null,
  to_registration_system       text not null
                                 check (to_registration_system in ('abstract','torrens','both','unknown')),
  to_instrument_id             text references data_fabric.recorded_instrument_documents(instrument_id),
  resolved                     boolean not null default false,
  -- Set from the referencing document's own family, never from the target's.
  reference_type               text not null check (reference_type in (
                                 'AMENDS','ASSIGNS','RELEASES','SATISFIES','CONTINUES','REFERENCES')),
  -- Populated when a number matches instruments in more than one system, which
  -- means two different documents and therefore no resolution.
  ambiguous_candidates         text[] not null default '{}',
  observed_at                  timestamptz not null,
  unique (from_instrument_id, to_normalized_document_number),
  constraint resolution_needs_a_target check (resolved = (to_instrument_id is not null))
);
create index if not exists ir_target_idx on data_fabric.instrument_references(to_normalized_document_number);
create index if not exists ir_unresolved_idx on data_fabric.instrument_references(resolved) where resolved = false;

-- ---------------------------------------------------- recorded financing ----

create table if not exists data_fabric.recorded_financing (
  recorded_financing_id text primary key,
  instrument_id         text not null references data_fabric.recorded_instrument_documents(instrument_id),
  property_id           text references data_fabric.properties(property_id),
  county_fips           text not null,
  -- Indexed principal only. Absent on most assignments and satisfactions, and
  -- absent is recorded as absent.
  principal_amount_minor bigint,
  recorded_at           timestamptz,
  document_date         timestamptz,
  maturity_date         date,
  -- The mortgage this document acts on, once the reference resolves.
  acts_on_instrument_id text references data_fabric.recorded_instrument_documents(instrument_id),
  lifecycle_state       text not null check (lifecycle_state in ('recorded','assigned','released')),
  observed_at           timestamptz not null,
  unique (instrument_id)
);
create index if not exists rf_property_idx on data_fabric.recorded_financing(property_id, recorded_at desc);
create index if not exists rf_acts_on_idx on data_fabric.recorded_financing(acts_on_instrument_id);

-- --------------------------------------------------- ownership observations -

create table if not exists data_fabric.ownership_observations (
  ownership_observation_id text primary key,
  property_id              text not null references data_fabric.properties(property_id),
  county_fips              text not null,
  -- A party OBSERVATION, not a resolved canonical party. Two spellings of one
  -- company are two observations until a dedicated identity phase says otherwise.
  party_observation_id     text not null references data_fabric.party_observations(observation_id),
  normalized_name          text not null,
  -- Named `observed_*` throughout. An acquisition with no disposition means
  -- "we have seen them acquire and have not seen them convey away", which is
  -- not the same as "they own it today".
  observed_acquired_at     timestamptz,
  acquired_by_instrument_id text references data_fabric.recorded_instrument_documents(instrument_id),
  observed_disposed_at     timestamptz,
  disposed_by_instrument_id text references data_fabric.recorded_instrument_documents(instrument_id),
  basis                    text not null check (basis in ('recorded_conveyance')),
  observed_at              timestamptz not null,
  -- An interval cannot end before it starts.
  constraint ownership_interval_ordered check (
    observed_acquired_at is null
    or observed_disposed_at is null
    or observed_disposed_at >= observed_acquired_at
  ),
  -- A disposition has to be attributable to the instrument that caused it.
  constraint disposition_needs_an_instrument check (
    (observed_disposed_at is null) = (disposed_by_instrument_id is null)
  )
);
create index if not exists oo_property_idx on data_fabric.ownership_observations(property_id, observed_acquired_at);
create index if not exists oo_name_idx on data_fabric.ownership_observations(normalized_name);

-- -------------------------------------------------- transaction candidates --

-- Three sources can describe one sale: the assessor echoes it, eCRV declares it,
-- the recorder holds the deed. Emitting three canonical sales would triple-count
-- every transaction in the county; merging them on a hunch would fuse different
-- events that shared a month. A candidate is a hypothesis over the observations,
-- and it never rewrites them.
create table if not exists data_fabric.transaction_candidates (
  candidate_id           text primary key,
  property_id            text not null references data_fabric.properties(property_id),
  county_fips            text not null,
  anchor_date            timestamptz,
  state                  text not null check (state in (
                           'SUPPORTED_MATCH','POSSIBLE_MATCH','CONFLICT','UNRESOLVED')),
  supporting_source_ids  text[] not null default '{}',
  ecrv_transaction_id    text,
  recorder_instrument_id text references data_fabric.recorded_instrument_documents(instrument_id),
  assessor_sale_echo     text,
  -- Why it is not a supported match. A durable statement that the sources
  -- disagree is far more useful than a silently chosen winner.
  disagreements          text[] not null default '{}',
  observed_at            timestamptz not null,
  run_id                 text not null references data_fabric.source_runs(run_id),
  -- A conflict is a conflict. It may not be recorded as agreement.
  constraint conflict_states_its_reason check (
    state <> 'CONFLICT' or cardinality(disagreements) > 0
  )
);
create index if not exists tc_property_idx on data_fabric.transaction_candidates(property_id, anchor_date desc);
create index if not exists tc_state_idx on data_fabric.transaction_candidates(state);

-- --------------------------------------------------------- event types ------

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
    -- transfer declarations (eCRV)
    'REAL_ESTATE_TRANSFER_OBSERVED','PROPERTY_SALE_OBSERVED','FINANCING_OBSERVED',
    -- assessor snapshot
    'PARCEL_OBSERVED','PARCEL_RESOLVED','PARCEL_ATTRIBUTES_CHANGED',
    'ASSESSOR_OWNER_OBSERVED','ASSESSMENT_OBSERVED','PROPERTY_CHARACTERISTICS_OBSERVED',
    -- recorded instruments. Note the layering: RECORDED is always safe,
    -- CONVEYANCE needs a conveying family and identifiable land, and there is
    -- deliberately no recorder-sourced SALE event of any kind.
    'INSTRUMENT_RECORDED','CONVEYANCE_OBSERVED',
    'MORTGAGE_RECORDED','MORTGAGE_ASSIGNED','MORTGAGE_RELEASED'));

-- ============================================================================
-- Security posture, re-applied to the tables this migration added.
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
