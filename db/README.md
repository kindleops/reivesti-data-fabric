# db/migrations

**These migrations are DRAFTS. None has been applied to any database, and none
has been applied to production.**

| File | Creates |
|---|---|
| `0001_data_fabric_core.sql` | schema `data_fabric` — registry, release/run/artifact/observation provenance, canonical property / party / transaction / financing / instrument / distress, canonical events |
| `0002_data_fabric_restricted_contact.sql` | schema `data_fabric_restricted` — the contact plane; forced RLS and explicit denials across both schemas |

## Before applying

1. Apply against a throwaway database first. This has not been possible in the
   development environment used for DF-0B (no Docker, no `psql`), so the
   migrations are currently verified **structurally only** — see
   `tests/migrations.test.ts`, which asserts what the schema says, not that it
   runs.
2. Confirm `data_fabric` and `data_fabric_restricted` do not exist in the target.
   The Reivesti application occupies `public` exclusively; see
   `docs/REIVESTI-DB-TOPOLOGY.md`.
3. Confirm the `anon` and `authenticated` roles exist. `0002` skips policy
   creation for roles that are absent rather than failing.
4. Create the private object-storage bucket for raw artifacts separately. Raw eCRV
   bytes contain personal contact data; the bucket must not be public.

## Invariants the schema enforces

- Artifacts are content-addressed (`sha256` unique, format-checked) and declared
  immutable.
- A parcel identifier cannot exist without a county — parcel numbers are unique
  only inside one.
- An observation that is `unresolved` or `ambiguous` cannot carry an entity link,
  and one that is `resolved` or `provisional` must.
- A `normalized_address` identifier can only ever be `unresolved`.
- Every canonical table carries `artifact_id`, `source_record_id`,
  `raw_record_hash` and `observed_at`.
- Currency is `bigint` minor units. No column anywhere uses `real`,
  `double precision`, `float` or `money`.
- RLS is enabled **and forced** on every table in both schemas.
