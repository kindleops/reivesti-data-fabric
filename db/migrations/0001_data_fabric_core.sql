-- ============================================================================
-- Reivesti Data Fabric — core schema
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- Two schemas, deliberately:
--
--   data_fabric              provenance, canonical entities, canonical events.
--                            Readable by internal consumers under RLS.
--   data_fabric_restricted   the contact plane. Nothing outside the Data Fabric
--                            service role reads it, ever.
--
-- Both are disjoint from the Reivesti application's `public` schema. The
-- application is a CONSUMER of projections from data_fabric; it owns none of
-- these tables and the Fabric depends on none of its. See
-- docs/REIVESTI-DB-TOPOLOGY.md for what is shared and what is owned.
--
-- Conventions carried from the existing Reivesti estate:
--   * text ids from deterministic namespaced hashing (src/core/hash.ts)
--   * FIPS, parcel numbers, ZIPs and phone numbers are TEXT (leading-zero law)
--   * money as integer minor units, never numeric-with-float-parsing
--   * raw payloads are never stored here; they live in the artifact store
-- ============================================================================

create schema if not exists data_fabric;

-- ---------------------------------------------------------------- registry --

create table if not exists data_fabric.jurisdictions (
  jurisdiction_id    text primary key,
  jurisdiction_type  text not null check (jurisdiction_type in ('nation','state','county','municipality','judicial_district')),
  country            text not null,
  state_code         text,
  state_fips         text,
  county_fips        text,
  county_name        text,
  name               text not null,
  parent_id          text references data_fabric.jurisdictions(jurisdiction_id),
  constraint jurisdiction_county_scope check (
    jurisdiction_type <> 'county' or (county_fips is not null and state_fips is not null)
  )
);
create index if not exists jurisdictions_county_fips_idx on data_fabric.jurisdictions(county_fips);

create table if not exists data_fabric.sources (
  source_id                  text primary key,
  source_authority           text not null,
  source_program             text not null,
  source_family              text not null,
  source_name                text not null,
  source_homepage            text not null,
  access_type                text not null check (access_type in ('bulk_download','api','soap','sftp','manual_import','object_storage','vendor_export')),
  -- "public record" is not "automatable": the runtime refuses to reach a
  -- publisher unless this column says the publisher sanctioned it.
  automation_status          text not null check (automation_status in ('sanctioned','manual_only','prohibited','unknown')),
  terms_status               text not null check (terms_status in ('reviewed_permitted','reviewed_restricted','not_reviewed')),
  license_status             text not null check (license_status in ('public_domain','open_with_attribution','licensed','restricted','unknown')),
  cost_model                 text not null check (cost_model in ('free','fee_per_request','subscription','contract','unknown')),
  historical_depth           date,
  expected_refresh_frequency text not null,
  source_priority            integer not null check (source_priority >= 1),
  active                     boolean not null default false,
  carries_restricted_contact boolean not null default false,
  notes                      text not null default ''
);

-- Scope, not enumeration: one row can mean one county, one state, several
-- states or the whole country. Expansion happens in the registry, so adding a
-- 58th county to a statewide source is a jurisdiction insert, not a data migration.
create table if not exists data_fabric.source_jurisdiction_mappings (
  mapping_id      text primary key,
  source_id       text not null references data_fabric.sources(source_id),
  scope_kind      text not null check (scope_kind in ('nation','states','all_counties_in_states','counties')),
  scope_values    text[] not null default '{}',
  capabilities    text[] not null check (cardinality(capabilities) > 0),
  coverage_start  date,
  coverage_end    date,
  status          text not null check (status in ('planned','fixture_only','blocked_on_access','active','retired')),
  adapter_key     text not null,
  config          jsonb not null default '{}'::jsonb
);
create index if not exists sjm_source_idx on data_fabric.source_jurisdiction_mappings(source_id);

-- ------------------------------------------------- release / run / artifact --

create table if not exists data_fabric.source_releases (
  release_id       text primary key,
  source_id        text not null references data_fabric.sources(source_id),
  release_label    text not null,
  reference_period text not null,
  publication_at   timestamptz,
  finality         text not null check (finality in ('provisional','final','unknown')),
  source_version   text
);

-- Content-addressed and append-only. There is no UPDATE path: a republished
-- file with different bytes is a different row, and the first row stands.
create table if not exists data_fabric.source_artifacts (
  artifact_id        text primary key,
  source_id          text not null references data_fabric.sources(source_id),
  release_id         text references data_fabric.source_releases(release_id),
  original_url       text,
  original_filename  text not null,
  retrieved_at       timestamptz not null,
  effective_at       timestamptz,
  byte_length        bigint not null check (byte_length >= 0),
  sha256             text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type          text,
  storage_path       text not null unique,
  manifest_path      text not null,
  jurisdiction_ids   text[] not null default '{}',
  carries_restricted_contact boolean not null default false,
  immutable          boolean not null default true check (immutable)
);

create table if not exists data_fabric.source_runs (
  run_id                 text primary key,
  source_id              text not null references data_fabric.sources(source_id),
  mapping_id             text not null references data_fabric.source_jurisdiction_mappings(mapping_id),
  release_id             text references data_fabric.source_releases(release_id),
  artifact_id            text references data_fabric.source_artifacts(artifact_id),
  adapter_key            text not null,
  connector_version      text not null,
  parser_version         text not null,
  normalization_version  text not null,
  schema_version         text not null,
  schema_digest          text,
  started_at             timestamptz not null,
  completed_at           timestamptz,
  status                 text not null check (status in ('pending','running','completed','quarantined','failed','blocked_on_access')),
  stage                  text not null,
  dry_run                boolean not null default false,
  replay_of              text,
  rows_discovered        integer not null default 0,
  rows_parsed            integer not null default 0,
  rows_valid             integer not null default 0,
  rows_quarantined       integer not null default 0,
  rows_emitted           integer not null default 0,
  rows_new               integer not null default 0,
  rows_unchanged         integer not null default 0,
  rows_revised           integer not null default 0,
  validation_error_count integer not null default 0,
  unknown_fields         text[] not null default '{}',
  missing_fields         text[] not null default '{}',
  failure_kind           text,
  failure_message        text,
  -- Digest over every canonical bundle. Two runs over the same evidence with
  -- the same code must produce the same value; that is the replay gate.
  normalized_digest      text
);
create index if not exists source_runs_source_started_idx on data_fabric.source_runs(source_id, started_at desc);

-- One immutable sighting of one source record. Re-publication of identical
-- content adds nothing; re-publication of changed content adds a row that
-- points at the one it supersedes. Nothing is ever updated in place.
create table if not exists data_fabric.source_record_observations (
  observation_id           text primary key,
  source_id                text not null references data_fabric.sources(source_id),
  source_record_id         text not null,
  artifact_id              text not null references data_fabric.source_artifacts(artifact_id),
  run_id                   text not null references data_fabric.source_runs(run_id),
  observed_at              timestamptz not null,
  content_digest           text not null,
  revision_ordinal         integer not null check (revision_ordinal >= 0),
  supersedes_observation_id text references data_fabric.source_record_observations(observation_id),
  parser_version           text not null,
  unique (source_id, source_record_id, content_digest, revision_ordinal)
);
create index if not exists sro_key_idx on data_fabric.source_record_observations(source_id, source_record_id, revision_ordinal desc);

-- ------------------------------------------------------------- canonical ----

create table if not exists data_fabric.properties (
  property_id         text primary key,
  county_fips         text not null,
  created_from_method text not null
);

create table if not exists data_fabric.property_identifier_observations (
  observation_id      text primary key,
  identifier_type     text not null check (identifier_type in ('county_parcel','normalized_address','source_property_key')),
  value               text not null,
  normalized_value    text not null,
  -- Parcel numbers are unique only within a county. Scope is not optional for one.
  county_fips         text,
  source_designation  text not null check (source_designation in ('primary','secondary','unspecified')),
  finality            text not null check (finality in ('preliminary','final','unknown')),
  resolution_state    text not null check (resolution_state in ('resolved','provisional','ambiguous','unresolved')),
  property_id         text references data_fabric.properties(property_id),
  resolution_method   text,
  source_id           text not null,
  source_record_id    text not null,
  artifact_id         text not null references data_fabric.source_artifacts(artifact_id),
  run_id              text not null references data_fabric.source_runs(run_id),
  observed_at         timestamptz not null,
  effective_at        timestamptz,
  raw_record_hash     text not null,
  parser_version      text not null,
  normalization_version text not null,
  constraint parcel_requires_county check (identifier_type <> 'county_parcel' or county_fips is not null),
  -- An unresolved identifier must not smuggle in a property link.
  constraint resolution_consistency check (
    (resolution_state in ('resolved','provisional')) = (property_id is not null)
  ),
  -- An address string is never sufficient to resolve a property.
  constraint address_never_resolves check (
    identifier_type <> 'normalized_address' or resolution_state = 'unresolved'
  )
);
create index if not exists pio_property_idx on data_fabric.property_identifier_observations(property_id);
create index if not exists pio_parcel_idx on data_fabric.property_identifier_observations(county_fips, normalized_value);

create table if not exists data_fabric.parties (
  party_id       text primary key,
  kind           text not null check (kind in ('person','organization','government','unknown')),
  canonical_name text not null
);

create table if not exists data_fabric.party_observations (
  observation_id       text primary key,
  kind                 text not null check (kind in ('person','organization','government','unknown')),
  role                 text not null check (role in ('buyer','seller','grantor','grantee','borrower','lender','other')),
  source_role          text not null,
  raw_name             text not null,
  normalized_name      text not null,
  name_first           text,
  name_middle          text,
  name_last            text,
  name_suffix          text,
  organization_name    text,
  address_line1        text,
  address_line2        text,
  address_city         text,
  address_state        text,
  address_postal_code  text,
  address_country      text,
  foreign_address      boolean,
  protected_identity   boolean not null default false,
  resolution_state     text not null check (resolution_state in ('resolved','provisional','ambiguous','unresolved')),
  party_id             text references data_fabric.parties(party_id),
  source_id            text not null,
  source_record_id     text not null,
  artifact_id          text not null references data_fabric.source_artifacts(artifact_id),
  run_id               text not null references data_fabric.source_runs(run_id),
  observed_at          timestamptz not null,
  effective_at         timestamptz,
  raw_record_hash      text not null,
  parser_version       text not null,
  normalization_version text not null,
  -- A party link requires a resolution state that justifies it. Merging on a
  -- matching name is not a justification, and the schema will not accept one.
  constraint party_resolution_consistency check (
    (resolution_state in ('resolved','provisional')) = (party_id is not null)
  )
);
create index if not exists po_normalized_name_idx on data_fabric.party_observations(normalized_name);
create index if not exists po_party_idx on data_fabric.party_observations(party_id);

create table if not exists data_fabric.party_aliases (
  alias_id        text primary key,
  party_id        text not null references data_fabric.parties(party_id),
  raw_name        text not null,
  normalized_name text not null,
  source_id       text not null,
  source_record_id text not null,
  observed_at     timestamptz not null
);

create table if not exists data_fabric.transaction_events (
  transaction_id        text primary key,
  source_id             text not null references data_fabric.sources(source_id),
  source_record_id      text not null,
  jurisdiction_id       text not null references data_fabric.jurisdictions(jurisdiction_id),
  county_fips           text not null,
  transfer_date         date,
  instrument_type_code  text,
  total_consideration_minor        bigint,
  down_payment_minor               bigint,
  seller_paid_points_minor         bigint,
  delinquent_special_assessments_minor bigint,
  personal_property_included_in_total  boolean,
  legal_description     text,
  -- Source-stated declarations, kept as the source stated them. Interpretation
  -- ("arms length", "investor") is a later layer's claim, not an ingestion fact.
  characteristics       jsonb not null default '{}'::jsonb,
  -- Study eligibility and similar. Never a reason to omit the transfer.
  analytical_metadata   jsonb not null default '{}'::jsonb,
  artifact_id           text not null references data_fabric.source_artifacts(artifact_id),
  run_id                text not null references data_fabric.source_runs(run_id),
  observed_at           timestamptz not null,
  effective_at          timestamptz,
  raw_record_hash       text not null,
  parser_version        text not null,
  normalization_version text not null,
  unique (source_id, source_record_id)
);
create index if not exists te_county_date_idx on data_fabric.transaction_events(county_fips, transfer_date desc);

create table if not exists data_fabric.transaction_parties (
  transaction_id       text not null references data_fabric.transaction_events(transaction_id),
  party_observation_id text not null references data_fabric.party_observations(observation_id),
  role                 text not null,
  source_role          text not null,
  ordinal              integer not null,
  primary key (transaction_id, party_observation_id)
);

-- Many parcels per transaction and many transactions per parcel. Neither
-- direction is assumed to be one.
create table if not exists data_fabric.transaction_parcels (
  transaction_id                    text not null references data_fabric.transaction_events(transaction_id),
  property_identifier_observation_id text not null references data_fabric.property_identifier_observations(observation_id),
  ordinal                           integer not null,
  primary key (transaction_id, property_identifier_observation_id)
);

create table if not exists data_fabric.financing_events (
  financing_id             text primary key,
  transaction_id           text not null references data_fabric.transaction_events(transaction_id),
  ordinal                  integer not null,
  -- Source code, unmapped. CD (contract for deed) stays distinct from MORTGAGE.
  finance_type_code        text,
  principal_amount_minor   bigint,
  interest_rate_type       text check (interest_rate_type in ('fixed','variable')),
  interest_rate_percent    numeric(9,6),
  payment_amount_minor     bigint,
  payment_frequency_code   text,
  payment_applies_to_code  text,
  number_of_payments       integer,
  balloon_amount_minor     bigint,
  balloon_date             date,
  selected_by_source       boolean,
  source_id                text not null references data_fabric.sources(source_id),
  source_record_id         text not null,
  artifact_id              text not null references data_fabric.source_artifacts(artifact_id),
  run_id                   text not null references data_fabric.source_runs(run_id),
  observed_at              timestamptz not null,
  raw_record_hash          text not null,
  parser_version           text not null,
  normalization_version    text not null,
  unique (transaction_id, ordinal)
);

-- Defined now so DF-0D has a destination that already carries lineage.
-- No connector in DF-0B writes to it: eCRV is a revenue filing, not a recording.
create table if not exists data_fabric.recorded_instruments (
  instrument_id        text primary key,
  county_fips          text not null,
  recording_reference  text not null,
  recorded_at          timestamptz,
  instrument_type_code text,
  transaction_id       text references data_fabric.transaction_events(transaction_id),
  source_id            text not null,
  source_record_id     text not null,
  artifact_id          text not null references data_fabric.source_artifacts(artifact_id),
  observed_at          timestamptz not null,
  raw_record_hash      text not null,
  unique (county_fips, recording_reference)
);

-- Defined for DF-0F. Nothing in eCRV is a distress event, and legalActionInd
-- is explicitly not treated as one.
create table if not exists data_fabric.distress_events (
  distress_event_id text primary key,
  event_type        text not null check (event_type in ('notice_of_default','notice_of_sale','foreclosure_sale','tax_delinquency','tax_sale','lis_pendens')),
  county_fips       text not null,
  property_id       text references data_fabric.properties(property_id),
  event_date        date,
  source_id         text not null,
  source_record_id  text not null,
  artifact_id       text not null references data_fabric.source_artifacts(artifact_id),
  observed_at       timestamptz not null,
  raw_record_hash   text not null
);

create table if not exists data_fabric.canonical_events (
  event_id     text primary key,
  event_type   text not null check (event_type in ('REAL_ESTATE_TRANSFER_OBSERVED','PROPERTY_SALE_OBSERVED','FINANCING_OBSERVED')),
  occurred_at  date,
  subject_id   text not null,
  payload      jsonb not null default '{}'::jsonb,
  source_id    text not null,
  source_record_id text not null,
  artifact_id  text not null references data_fabric.source_artifacts(artifact_id),
  run_id       text not null references data_fabric.source_runs(run_id),
  observed_at  timestamptz not null,
  raw_record_hash text not null,
  normalization_version text not null
);
create index if not exists ce_subject_idx on data_fabric.canonical_events(subject_id, occurred_at desc);
create index if not exists ce_type_idx on data_fabric.canonical_events(event_type, occurred_at desc);
