-- ============================================================================
-- Reivesti Data Fabric — durable artifact storage (DF-0L)
--
-- STATUS: DRAFT. NOT APPLIED TO ANY DATABASE, AND NOT APPLIED TO PRODUCTION.
--
-- DF-0K left authoritative publisher bytes on execution disk, and a container
-- can vanish. `source_artifacts` already records each artifact once, by sha256,
-- with ONE `storage_path` — a local path that means nothing on another machine.
-- This migration adds what that table cannot say, without a parallel catalog:
--
-- 1. WHAT THE DIGEST IS OF. `artifact_role` separates a publisher's exact bytes
--    from a deterministic derivation, and `content_encoding` says the digest is
--    over the stored bytes as-is. A compressed derived bundle and a publisher
--    archive can never be confused.
--
-- 2. WHERE EVERY COPY IS, AND WHETHER IT COUNTS. `artifact_storage_copies` has
--    one row per (artifact, backend, key): the backend kind, the content-derived
--    key, the durability state and when the bytes were last re-hashed. Only
--    DURABLE copies satisfy replay provenance.
--
-- 3. HISTORY THAT LOST ITS BYTES. A digest certified in an earlier phase whose
--    bytes are gone is recorded as LOST_EXACT_BYTES — not deleted, not hidden.
--    `sha256` is therefore not a foreign key: a historical digest may have no
--    `source_artifacts` row, and must still be representable.
--
-- No credential, signed URL or temporary authorization is ever stored: the key
-- is stable storage identity, and authorization is the worker's environment.
-- ============================================================================

alter table data_fabric.source_artifacts
  add column if not exists artifact_role text not null default 'publisher_raw'
    check (artifact_role in ('publisher_raw', 'derived_bundle')),
  add column if not exists content_encoding text not null default 'identity'
    check (content_encoding in ('identity', 'gzip')),
  add column if not exists derived_from_sha256 text
    check (derived_from_sha256 is null or derived_from_sha256 ~ '^[0-9a-f]{64}$');

-- A derived artifact names its raw parent; a publisher artifact has none.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'source_artifacts_derived_has_parent') then
    alter table data_fabric.source_artifacts add constraint source_artifacts_derived_has_parent
      check ((artifact_role = 'derived_bundle') = (derived_from_sha256 is not null));
  end if;
end
$$;

create table if not exists data_fabric.artifact_storage_copies (
  copy_id            text primary key,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source_id          text not null references data_fabric.sources(source_id),
  backend_kind       text not null check (backend_kind in ('LOCAL', 'S3_COMPATIBLE')),
  -- Bucket (or root) and content-derived key. Never a URL with a signature.
  storage_location   text not null,
  storage_key        text not null check (storage_key !~ '(?i)(x-amz-signature|x-amz-credential|token=|signature=)'),
  byte_length        bigint check (byte_length is null or byte_length >= 0),
  durability_state   text not null check (durability_state in (
                       'EPHEMERAL_ONLY', 'DURABLE', 'MISSING_BYTES', 'REACQUIRABLE', 'LOST_EXACT_BYTES')),
  first_seen_at      timestamptz not null,
  last_verified_at   timestamptz,
  last_verified_sha256 text check (last_verified_sha256 is null or last_verified_sha256 ~ '^[0-9a-f]{64}$'),
  note               text,
  -- A copy claimed DURABLE must have been re-hashed, and to its own digest.
  constraint artifact_copy_durable_is_verified check (
    durability_state <> 'DURABLE'
    or (last_verified_at is not null and last_verified_sha256 = sha256)
  ),
  constraint artifact_copy_key_is_content_addressed check (
    durability_state in ('LOST_EXACT_BYTES', 'REACQUIRABLE') or storage_key like '%' || sha256 || '%'
  ),
  unique (sha256, backend_kind, storage_location, storage_key)
);

create index if not exists artifact_storage_copies_sha256_idx on data_fabric.artifact_storage_copies (sha256);
create index if not exists artifact_storage_copies_state_idx on data_fabric.artifact_storage_copies (durability_state);

comment on table data_fabric.artifact_storage_copies is
  'Where each copy of an artifact is and whether it counts. Only DURABLE copies satisfy replay provenance. '
  'Raw publisher artifacts are never garbage-collected.';

-- ---------------------------------------------------------------------------
-- Every table in both schemas: RLS enabled and forced; application roles denied.
-- Re-run here so the new table is covered exactly as the old ones are.
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
