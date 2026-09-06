-- ============================================================================
-- Reivesti Data Fabric — transfer declarations (DF-0J)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- A state transfer declaration — a Wisconsin RETR, a Minnesota eCRV — is filed
-- with the county when a conveyance is recorded. It is the estate's best source
-- of who sold to whom, for how much, and on what terms, and it is the first
-- thing that will be misread if the schema lets it be.
--
-- Three misreadings this schema is shaped to prevent:
--
-- 1. A TRANSFER IS NOT A SALE. Roughly a third of Wisconsin's returns are
--    gifts, inheritances, divorces, corrections and foreclosures, and every one
--    carries a value. `transfer_classifications` records what the publisher
--    said the conveyance WAS, with the field it was read from, so nothing has
--    to guess from a price. There is no `is_arms_length` boolean, because that
--    is a conclusion and this table holds evidence.
--
-- 2. FIVE MONEY FIELDS ARE FIVE FACTS. Wisconsin publishes a sale price, an
--    estimated value, a transfer TAX and two personal-property adjustments.
--    `transfer_considerations` keys each by its kind so a query cannot silently
--    add a tax to a price. Amounts are `numeric`, never floating point, and the
--    kind is constrained.
--
-- 3. ONE TRANSFER, MANY PARCELS. A return can convey ten parcels. The existing
--    `transaction_parcels` link table already models that; nothing here clones
--    a transaction per parcel, and a unique constraint makes a duplicate link
--    impossible rather than merely discouraged.
--
-- What is NOT here: any table for financing terms, contact details or tax
-- identifiers. Wisconsin's FORM collects amounts financed, APRs, phone numbers,
-- email addresses and SSN/FEIN; its public DATASET publishes none of them, and
-- a column for a value that is never delivered is an invitation to fill it from
-- somewhere else.
-- ============================================================================

-- ------------------------------------------------ transfer classification ---

create table if not exists data_fabric.transfer_classifications (
  classification_id   text primary key,
  transaction_id      text not null references data_fabric.transaction_events(transaction_id) on delete cascade,
  -- What kind of transfer the SOURCE describes. Not a computed verdict.
  classification      text not null check (classification in (
                        'MARKET_SALE_SUPPORTED',
                        'NON_MARKET_TRANSFER_SUPPORTED',
                        'RELATIONSHIP_TRANSFER',
                        'GIFT_TRANSFER',
                        'EXEMPT_TRANSFER',
                        'FORECLOSURE_RELATED',
                        'PARTIAL_INTEREST_TRANSFER',
                        'UNKNOWN_TRANSFER_TYPE')),
  -- Exactly one classification per transfer is primary: the one that most
  -- governs how the transfer should be read. The rest remain, because a part
  -- sale to a child with a retained life estate is genuinely three things.
  is_primary          boolean not null default false,
  -- The publisher field and value the classification was read from. Both are
  -- NOT NULL: a classification whose basis nobody can check is an opinion.
  basis_field         text not null,
  basis_value         text not null,
  unique (transaction_id, classification, basis_field)
);
create index if not exists tc_transaction_idx on data_fabric.transfer_classifications(transaction_id);
create index if not exists tc_classification_idx on data_fabric.transfer_classifications(classification);

-- Exactly one primary per transaction, enforced rather than assumed.
create unique index if not exists tc_one_primary
  on data_fabric.transfer_classifications(transaction_id)
  where is_primary;

-- ------------------------------------------------ transfer considerations ---

create table if not exists data_fabric.transfer_considerations (
  consideration_id    text primary key,
  transaction_id      text not null references data_fabric.transaction_events(transaction_id) on delete cascade,
  -- What this figure IS. A transfer fee is a tax; an estimated value is not a
  -- price. Constrained so a new source cannot invent a kind that queries then
  -- silently sum together.
  kind                text not null check (kind in (
                        'SALE_PRICE',
                        'ESTIMATED_VALUE',
                        'TRANSFER_FEE',
                        'PERSONAL_PROPERTY_EXCLUDED',
                        'PERSONAL_PROPERTY_INCLUDED',
                        'TOTAL_CONSIDERATION',
                        'DOWN_PAYMENT')),
  -- Exact minor units. `numeric`, never a float: a cent lost per row is a wrong
  -- total over a county.
  amount_minor        numeric(20, 0),
  currency            text not null default 'USD' check (currency = 'USD'),
  -- Why it is absent when it is. NULL and BLANK and an explicit $0.00 are three
  -- different statements by the publisher and stay three different rows.
  absent_reason       text check (absent_reason in (
                        'MISSING', 'NULL_SOURCE', 'BLANK_SOURCE', 'NOT_APPLICABLE', 'INVALID', 'SUPPRESSED', 'UNKNOWN')),
  -- The publisher's own field name, so any figure can be traced back.
  source_field        text not null,
  -- Set only on a figure Reivesti COMPUTED. Null means observed. An observed
  -- figure always outranks a derived one.
  derivation_version  text,
  -- A figure is either present or explained. Never both, never neither.
  constraint consideration_present_or_explained check (
    (amount_minor is not null and absent_reason is null)
    or (amount_minor is null and absent_reason is not null)
  ),
  unique (transaction_id, kind, source_field)
);
create index if not exists tcon_transaction_idx on data_fabric.transfer_considerations(transaction_id);
create index if not exists tcon_kind_idx on data_fabric.transfer_considerations(kind);

-- ------------------------------------------- transfer declaration context ---

-- General facts any transfer declaration carries, added to the existing
-- transaction event rather than duplicated into a Wisconsin-shaped table.
alter table data_fabric.transaction_events
  -- When the county recorded it, as distinct from when the property changed
  -- hands. A deed signed in December and recorded in January belongs to both
  -- months for different purposes, and collapsing them loses one of them.
  add column if not exists recording_date date,
  -- The recording document number the declaration REPORTS. Evidence that an
  -- instrument exists; not the instrument, and never a reason to create one.
  add column if not exists recorded_document_number text,
  -- What kind of conveyance, as opposed to what paper was filed. Wisconsin
  -- publishes both and they answer different questions.
  add column if not exists conveyance_type_code text,
  -- How much of the grantor's interest moved, and what they kept.
  add column if not exists ownership_type_code text,
  add column if not exists rights_retained_code text,
  -- Which distribution the row was read from, and whether that distribution
  -- could have dropped parties or parcels. Wisconsin's CSV shows only the first
  -- grantor, grantee and parcel and gives no count, so a CSV-sourced transfer
  -- can never assert "this had one grantor" — only "the file showed one".
  -- Named "may be incomplete" because that is the actual state of knowledge:
  -- a shortened list and a genuinely short one look identical in the file.
  add column if not exists source_distribution text,
  add column if not exists parties_may_be_incomplete boolean not null default false,
  add column if not exists parcels_may_be_incomplete boolean not null default false,
  add column if not exists normalization_contract text
    references data_fabric.normalization_contracts(contract_version);

create index if not exists te_recorded_document_idx
  on data_fabric.transaction_events(county_fips, recorded_document_number)
  where recorded_document_number is not null;

-- A transfer may name many parcels; it must never name one twice.
create unique index if not exists tp_transaction_parcel_unique
  on data_fabric.transaction_parcels(transaction_id, property_identifier_observation_id);

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
