# db/migrations

**These migrations are DRAFTS. None has been applied to any database, and none
has been applied to production.**

| File | Creates |
|---|---|
| `0001_data_fabric_core.sql` | schema `data_fabric` — registry, release/run/artifact/observation provenance, canonical property / party / transaction / financing / instrument / distress, canonical events |
| `0002_data_fabric_restricted_contact.sql` | schema `data_fabric_restricted` — the contact plane; forced RLS and explicit denials across both schemas |
| `0004_data_fabric_streaming_runs.sql` | streaming run manifest (reconciliation counts, canonical digest, batch configuration), snapshot absences keyed by hash, resolution lookup indexes |
| `0003_data_fabric_snapshot_and_resolution.sql` | snapshot sources, time-aware assessment and characteristic observations, authoritative property resolution and conflicts; re-applies the security posture to the new tables |

## Before applying

1. Apply against a throwaway database first. `npm run test:pg` does exactly
   this: it boots a disposable PostgreSQL 17 cluster in a temp directory,
   applies every migration, verifies objects, constraints, RLS, privileges and
   real row behaviour, checks that a second fresh application yields an
   identical schema signature, then deletes the cluster. As of DF-0C the
   migrations are verified **by execution**, not only structurally.
2. Confirm `data_fabric` and `data_fabric_restricted` do not exist in the target.
   The Reivesti application occupies `public` exclusively; see
   `docs/REIVESTI-DB-TOPOLOGY.md`.
3. Confirm the `anon` and `authenticated` roles exist. `0002` skips policy
   creation for roles that are absent rather than failing.
4. Create the private object-storage bucket for raw artifacts separately. Raw eCRV
   bytes contain personal contact data; the bucket must not be public.

## No down migrations

There are none, and that is deliberate rather than an oversight. Reset is by
dropping the database, which is what the disposable-cluster harness does. A
down migration for a provenance schema would be a tool for destroying retained
evidence, and the repeatability gate does not need one.

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
- RLS is enabled **and forced** on every table in both schemas, re-applied by
  every migration that adds a table.
- A property's resolution cannot claim `resolved` without naming the
  authoritative source that justifies it.
- An artifact cannot be marked mutable.
- A run cannot be recorded `completed` while `source_changed_during_read` is
  true: "complete" is the claim everything downstream trusts.
- Absence has exactly one spelling, `parcel_missing_from_latest_source`. There is
  deliberately no `deleted` state to write.
