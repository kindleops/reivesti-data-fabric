-- ============================================================================
-- Reivesti Data Fabric — sale observations (DF-0M)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- Florida is the first source that publishes a SALE without a deed, a
-- declaration or a party: the Department of Revenue's Sale Data File says a
-- parcel changed hands in a month, at a price derived from the documentary
-- stamp tax, and how the appraiser qualified the sale. The roll repeats up to
-- two of those sales on the parcel record, and the cadastral files repeat them
-- again. This migration gives those facts a home without bending any existing
-- table to fit them:
--
-- 1. `sale_observations` — one row per statement of a sale: a sale-data row
--    (SALE_OBSERVATION) or a roll's echo of one (ASSESSOR_SALE_ECHO). The
--    semantic class travels on every row, so a doc-stamp-derived price is
--    never read as a declared consideration and an echo never as a sale.
--
-- 2. `sale_resolutions` — the TRANSACTION_RESOLUTION projection: many
--    statements, one canonical sale, with the ids of every statement it rests
--    on and whether the echoes SUPPORT it.
--
-- 3. Three CHECK lists grow, and nothing else about them changes:
--      transfer_considerations.kind     + SALE_PRICE_DOC_STAMP_DERIVED
--      transfer_classifications         + the qualification dimensions the
--                                         Department's own code wording
--                                         supports (no GIFT, no FORECLOSURE)
--      contact_observations.contact_type + mailing_address (the TypeScript
--                                         plane has carried it since DF-0H;
--                                         this list never did) and
--                                         care_of_block (Florida's fiduciary
--                                         / care-of block)
--
-- Each CHECK constraint is dropped and re-added by its generated NAME in
-- consecutive statements of this one file; applied as one multi-statement
-- query, PostgreSQL runs the file in a single implicit transaction, so no
-- other session ever sees a list missing.
-- ============================================================================

-- ---------------------------------------------------- consideration kinds --

alter table data_fabric.transfer_considerations
  drop constraint if exists transfer_considerations_kind_check;
alter table data_fabric.transfer_considerations
  add constraint transfer_considerations_kind_check check (kind in (
    'SALE_PRICE',
    'ESTIMATED_VALUE',
    'TRANSFER_FEE',
    'PERSONAL_PROPERTY_EXCLUDED',
    'PERSONAL_PROPERTY_INCLUDED',
    'TOTAL_CONSIDERATION',
    'DOWN_PAYMENT',
    -- Florida SDF / NAL SALE_PRC: a price the PUBLISHER derived from the
    -- documentary stamp tax. Observed, not computed by Reivesti, and never a
    -- price the parties declared.
    'SALE_PRICE_DOC_STAMP_DERIVED'));

-- ------------------------------------------------- classification names ----

alter table data_fabric.transfer_classifications
  drop constraint if exists transfer_classifications_classification_check;
alter table data_fabric.transfer_classifications
  add constraint transfer_classifications_classification_check check (classification in (
    'MARKET_SALE_SUPPORTED',
    'NON_MARKET_TRANSFER_SUPPORTED',
    'RELATIONSHIP_TRANSFER',
    'GIFT_TRANSFER',
    'EXEMPT_TRANSFER',
    'FORECLOSURE_RELATED',
    'PARTIAL_INTEREST_TRANSFER',
    'UNKNOWN_TRANSFER_TYPE',
    -- The appraiser's decision, as the Department groups its codes.
    'ASSESSOR_QUALIFIED_SALE',
    'ASSESSOR_DISQUALIFIED_SALE',
    'ASSESSOR_QUALIFICATION_PENDING',
    -- The Department's own statement about sales-ratio study use. A qualified
    -- sale is not a comparable; nothing here says it is.
    'RATIO_STUDY_INCLUDED',
    'RATIO_STUDY_EXCLUDED',
    -- Facts a specific code's official wording states, and only those.
    'GOVERNMENT_PARTY_TRANSFER',
    'FINANCIAL_INSTITUTION_OR_DEED_IN_LIEU',
    'DURESS_OR_FORECLOSURE_PREVENTION',
    'LIFE_ESTATE_RESERVED',
    'MULTI_PARCEL_TRANSFER',
    'NOMINAL_OR_NON_MARKET_INSTRUMENT'));

-- ------------------------------------------------------- contact types ----

alter table data_fabric_restricted.contact_observations
  drop constraint if exists contact_observations_contact_type_check;
alter table data_fabric_restricted.contact_observations
  add constraint contact_observations_contact_type_check check (contact_type in (
    'phone', 'email', 'contact_note', 'unstructured_submitter_block',
    'mailing_address', 'care_of_block'));

-- ----------------------------------------------------- sale observations --

create table if not exists data_fabric.sale_observations (
  observation_id         text primary key,
  kind                   text not null check (kind in ('SALE_OBSERVATION', 'ASSESSOR_SALE_ECHO')),
  -- e.g. FL_DOR_SALE_OBSERVATION, FL_DOR_NAL_SALE_ECHO, FL_DOR_PAR_SALE_ECHO.
  semantic_class         text not null,
  property_id            text not null,
  county_fips            text not null check (county_fips ~ '^[0-9]{5}$'),
  normalized_parcel      text not null,
  ordinal                integer not null check (ordinal >= 1),
  publisher_sale_id      text,
  -- A MONTH. The Department publishes year and month; no day exists and none
  -- is stored.
  sale_month             text check (sale_month is null or sale_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  price_minor            numeric(20, 0),
  price_absent_reason    text check (price_absent_reason in (
                           'MISSING', 'NULL_SOURCE', 'BLANK_SOURCE', 'NOT_APPLICABLE', 'INVALID', 'SUPPRESSED', 'UNKNOWN')),
  price_kind             text not null check (price_kind in ('SALE_PRICE_DOC_STAMP_DERIVED')),
  qualification_code     text,
  vacant_improved_code   text,
  -- OR:<book>/<page> or CLK:<number>. A reference, not an instrument.
  recording_reference    text,
  multi_parcel_code      text,
  source_id              text not null references data_fabric.sources(source_id),
  source_record_id       text not null,
  artifact_id            text not null references data_fabric.source_artifacts(artifact_id),
  run_id                 text not null references data_fabric.source_runs(run_id),
  observed_at            timestamptz not null,
  raw_record_hash        text not null,
  parser_version         text not null,
  normalization_version  text not null,
  -- A price is either stated or explained. Zero is stated.
  constraint sale_price_present_or_explained check (
    (price_minor is not null and price_absent_reason is null)
    or (price_minor is null and price_absent_reason is not null)
  ),
  -- Only a sale-data row carries the publisher's sale identifier.
  constraint sale_echo_has_no_sale_id check (kind = 'SALE_OBSERVATION' or publisher_sale_id is null),
  unique (source_id, source_record_id, kind, ordinal, observed_at)
);
create index if not exists so_property_idx on data_fabric.sale_observations(property_id, sale_month);
create index if not exists so_county_month_idx on data_fabric.sale_observations(county_fips, sale_month);

-- ------------------------------------------------------ sale resolutions --

create table if not exists data_fabric.sale_resolutions (
  sale_id                  text primary key,
  county_fips              text not null check (county_fips ~ '^[0-9]{5}$'),
  property_id              text not null,
  normalized_parcel        text not null,
  state                    text not null check (state in ('SUPPORTED_MATCH', 'SALE_OBSERVATION_ONLY', 'ECHO_ONLY')),
  semantic_class           text not null,
  publisher_sale_id        text,
  sale_month               text check (sale_month is null or sale_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  price_minor              numeric(20, 0),
  price_absent_reason      text,
  price_kind               text not null,
  qualification_code       text,
  vacant_improved_code     text,
  recording_reference      text,
  multi_parcel_code        text,
  multi_parcel_group_id    text,
  sale_observation_ids     text[] not null default '{}',
  supporting_echo_ids      text[] not null default '{}',
  discrepant_echo_ids      text[] not null default '{}',
  contributing_source_ids  text[] not null default '{}',
  statement_count          integer not null check (statement_count >= 1),
  observed_at              timestamptz not null,
  first_observed_at        timestamptz not null,
  resolver_version         text not null,
  -- A sale resting on a sale-data row names it; an echo-only sale names none.
  constraint sale_resolution_state_matches_evidence check (
    (state = 'ECHO_ONLY') = (cardinality(sale_observation_ids) = 0)
  ),
  constraint supported_match_has_support check (
    state <> 'SUPPORTED_MATCH' or cardinality(supporting_echo_ids) > 0
  )
);
create index if not exists sr_property_idx on data_fabric.sale_resolutions(property_id, sale_month);
create index if not exists sr_group_idx on data_fabric.sale_resolutions(multi_parcel_group_id)
  where multi_parcel_group_id is not null;

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
