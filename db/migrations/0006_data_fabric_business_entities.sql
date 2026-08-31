-- ============================================================================
-- Reivesti Data Fabric — state business-entity registry (DF-0F)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- The first authoritative source of ORGANIZATION identity. Four distinctions are
-- encoded here because each of them is easy to lose and expensive to get wrong:
--
-- 1. A REGISTRATION IS NOT A BUSINESS. `registry_status` says whether a filing
--    is in good standing with the Secretary of State. It says nothing about
--    whether the company trades, employs anyone, holds property or is worth
--    contacting, and there is deliberately no column here that could be read as
--    saying so.
--
-- 2. A NAME IS NOT AN IDENTITY. Names live in their own table, many per entity,
--    each with its type and its provenance. Nothing joins on a name string:
--    `business_entity_links` is the only bridge from an observed party name to a
--    registration, and it carries the evidence that justified it.
--
-- 3. CANDIDATE GENERATION IS NOT RESOLUTION. A link row exists for every
--    organization observation the resolver considered, including the ones it
--    refused to resolve. `link_state` distinguishes them, the candidate set is
--    retained, and `resolver_version` means a better resolver supersedes an
--    earlier decision instead of pretending it never happened.
--
-- 4. THE SOURCE IS LICENSED. Minnesota's Electronic Media License Agreement
--    permits serving these records to customers in the normal course of business
--    and forbids reselling or repackaging them in bulk. `license_class` records,
--    per row, which side of that line a value sits on, so the boundary is
--    reviewable in the data rather than implicit in application code.
--
-- Filing parties are frequently NATURAL PERSONS. Their names are registry facts
-- and are stored; their addresses are not stored here at all — they go to
-- data_fabric_restricted.contact_observations, as every other personal address
-- in the Fabric does. No table below has an address column for a party.
-- ============================================================================

-- ---------------------------------------------------------- entities --------

create table if not exists data_fabric.business_entities (
  entity_id                 text primary key,
  source_id                 text not null references data_fabric.sources(source_id),
  -- The registry's own identifier. Authoritative, static, never recycled.
  source_entity_id          text not null,
  registry_jurisdiction_id  text not null references data_fabric.jurisdictions(jurisdiction_id),
  original_filing_number    text,
  -- Verbatim, exactly as registered. The normalized forms are derived and are
  -- for candidate lookup only; neither may ever be treated as the entity's name.
  legal_name                text not null,
  normalized_name           text not null,
  compact_name              text not null,
  business_type_code        text not null,
  business_type_label       text,
  domesticity               text not null check (domesticity in ('domestic','foreign','unknown')),
  -- The status of the REGISTRATION. See note 1 above.
  registry_status           text not null check (registry_status in ('active','inactive','unknown')),
  registry_status_raw       text,
  -- A registry date has no time of day, and inventing one would be a fabrication.
  filing_date               date,
  expiration_date           date,
  next_renewal_due_date     date,
  home_jurisdiction         text,
  governing_statute         text,
  home_business_name        text,
  -- Source flags kept as the register states them rather than folded into the
  -- type: a professional LLC and a nonprofit LLC share business type code 44.
  attributes                jsonb not null default '{}'::jsonb,
  -- RAW_LICENSED never leaves the server. Nothing in DF-0F is PUBLIC_SAFE.
  license_class             text not null default 'CANONICAL_INTERNAL'
                              check (license_class in (
                                'RAW_LICENSED','NORMALIZED_PRIVATE','CANONICAL_INTERNAL',
                                'DERIVED_MEMBER_SAFE','PUBLIC_SAFE')),
  artifact_id               text not null references data_fabric.source_artifacts(artifact_id),
  run_id                    text not null references data_fabric.source_runs(run_id),
  observed_at               timestamptz not null,
  raw_record_hash           text not null,
  parser_version            text not null,
  normalization_version     text not null,
  -- The register's identifier is the identity. A name never is.
  unique (source_id, source_entity_id)
);
create index if not exists be_normalized_name_idx on data_fabric.business_entities(normalized_name);
create index if not exists be_compact_name_idx on data_fabric.business_entities(compact_name);
create index if not exists be_status_idx on data_fabric.business_entities(registry_jurisdiction_id, registry_status);
create index if not exists be_type_idx on data_fabric.business_entities(business_type_code);

-- ------------------------------------------------------------- names --------

create table if not exists data_fabric.business_entity_names (
  name_observation_id  text primary key,
  entity_id            text not null references data_fabric.business_entities(entity_id),
  -- PRIOR_NAME is declared because other registries supply it. Minnesota's bulk
  -- delivery does NOT: it carries only names active when the file was generated,
  -- so a name history is a Reivesti derivation across monthly deliveries and is
  -- never claimed from a single one.
  name_type            text not null check (name_type in (
                         'CURRENT_LEGAL_NAME','PRIOR_NAME','ASSUMED_NAME',
                         'HOME_JURISDICTION_NAME','FILING_PARTY_NAME','OTHER_SOURCE_NAME')),
  raw_name             text not null,
  normalized_name      text not null,
  compact_name         text not null,
  filing_number        text,
  observed_at          timestamptz not null,
  run_id               text not null references data_fabric.source_runs(run_id),
  unique (entity_id, name_type, raw_name)
);
create index if not exists ben_normalized_idx on data_fabric.business_entity_names(normalized_name);
create index if not exists ben_compact_idx on data_fabric.business_entity_names(compact_name);

-- ---------------------------------------------------------- addresses -------

-- Business addresses only. A filing party's address is personal data and lives
-- in data_fabric_restricted.contact_observations; see the header note.
create table if not exists data_fabric.business_entity_addresses (
  address_observation_id text primary key,
  entity_id              text not null references data_fabric.business_entities(entity_id),
  -- The registry's own numeric code is authoritative; the family is a coarse
  -- rollup for querying and never replaces it.
  address_type_code      text not null,
  address_type_label     text,
  address_family         text not null check (address_family in (
                           'PRINCIPAL','REGISTERED_OFFICE','MAILING','PARTY_ADDRESS','OTHER')),
  line1                  text,
  line2                  text,
  city                   text,
  state_or_province      text,
  postal_code            text,
  country                text,
  -- Comparison key: case and punctuation folding only. Supporting evidence for a
  -- link, never an identity on its own — office buildings and registered-agent
  -- services put thousands of unrelated companies at one address.
  normalized_address     text not null,
  filing_number          text,
  observed_at            timestamptz not null,
  run_id                 text not null references data_fabric.source_runs(run_id),
  unique (entity_id, address_type_code, normalized_address)
);
create index if not exists bea_normalized_idx on data_fabric.business_entity_addresses(normalized_address);
create index if not exists bea_entity_idx on data_fabric.business_entity_addresses(entity_id);

-- ------------------------------------------------------------ filings -------

create table if not exists data_fabric.business_entity_filings (
  filing_observation_id  text primary key,
  entity_id              text not null references data_fabric.business_entities(entity_id),
  filing_number          text not null,
  original_filing_number text,
  -- Verbatim, always. The normalized action is a lookup over a table the
  -- publisher documents only BY EXAMPLE, so OTHER is an expected, honest answer
  -- and the raw text is what a reviewer checks it against.
  filing_action_raw      text not null,
  filing_action          text not null check (filing_action in (
                           'ORIGINAL_FILING','AMENDMENT','RENEWAL','REINSTATEMENT','DISSOLUTION',
                           'WITHDRAWAL','MERGER','NAME_CHANGE','ADMINISTRATIVE_ACTION','OTHER')),
  filing_rank            text not null check (filing_rank in ('primary','secondary','unknown')),
  filing_date            date,
  effective_date         date,
  observed_at            timestamptz not null,
  run_id                 text not null references data_fabric.source_runs(run_id)
);
create index if not exists bef_entity_idx on data_fabric.business_entity_filings(entity_id, filing_date desc);
create index if not exists bef_action_idx on data_fabric.business_entity_filings(filing_action);
create unique index if not exists bef_unique_idx on data_fabric.business_entity_filings(
  entity_id, filing_number, filing_action_raw, filing_rank, coalesce(filing_date, date '0001-01-01')
);

-- ----------------------------------------------------- filing parties -------

create table if not exists data_fabric.business_filing_parties (
  filing_party_id        text primary key,
  entity_id              text not null references data_fabric.business_entities(entity_id),
  name_type_code         text not null,
  role_label             text,
  raw_name               text not null,
  normalized_name        text not null,
  -- A HINT about handling, from the register's role vocabulary — never a stored
  -- classification. A registered agent may be a corporate service company and an
  -- organizer may be a law firm; the register does not say, so neither do we.
  likely_natural_person  boolean not null,
  filing_number          text,
  observed_at            timestamptz not null,
  run_id                 text not null references data_fabric.source_runs(run_id),
  unique (entity_id, name_type_code, raw_name, filing_number)
);
create index if not exists bfp_entity_idx on data_fabric.business_filing_parties(entity_id);
create index if not exists bfp_name_idx on data_fabric.business_filing_parties(normalized_name);

-- ------------------------------------------------------------- links --------

-- The ONLY bridge between an observed organization name on a county record and a
-- state registration. One row per observation the resolver considered, resolved
-- or not: a refusal is a decision and is recorded as one.
create table if not exists data_fabric.business_entity_links (
  link_id               text primary key,
  party_observation_id  text not null references data_fabric.party_observations(observation_id),
  observation_source_id text not null references data_fabric.sources(source_id),
  observed_name         text not null,
  -- Null unless the decision actually resolved. See the consistency check.
  entity_id             text references data_fabric.business_entities(entity_id),
  link_state            text not null check (link_state in (
                          'resolved','provisional','ambiguous','unresolved')),
  -- Every candidate considered, retained even when the decision was to refuse.
  -- Without it "ambiguous" is an unreviewable verdict.
  candidate_entity_ids  jsonb not null default '[]'::jsonb,
  -- What matched, and how strong it was. A resolved row without decisive or
  -- strong evidence is a bug, and this is where it would be visible.
  evidence              jsonb not null default '[]'::jsonb,
  reason                text,
  resolver_version      text not null,
  decided_at            timestamptz not null,
  -- A resolved link must name an entity; an unresolved one must not.
  constraint bel_state_consistency check ((link_state = 'resolved') = (entity_id is not null)),
  -- One decision per observation per resolver version. A better resolver writes
  -- a new row; it does not overwrite the earlier judgement.
  unique (party_observation_id, resolver_version)
);
create index if not exists bel_entity_idx on data_fabric.business_entity_links(entity_id);
create index if not exists bel_state_idx on data_fabric.business_entity_links(link_state);
create index if not exists bel_source_idx on data_fabric.business_entity_links(observation_source_id);

-- ---------------------------------------------------------------------------
-- Row-level security. Re-run over every table so the tables added above are
-- covered by the same forced-RLS and role-denial posture as the rest.
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
