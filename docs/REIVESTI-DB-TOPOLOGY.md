# Reivesti database topology — what is shared, what the Fabric owns

Required before any production-facing database integration. Findings from
inspecting the existing Reivesti estate on **2026-08-31**. **No production DDL
was executed and no production data was read.**

---

## 1. What exists today

| | |
|---|---|
| Application repository | `kindleops/rei-automation` (npm workspaces: `apps/api`, `apps/dashboard`, `packages/seller-engine`) |
| Supabase projects | **exactly one** — `real-estate-automation`, ref `lcppdrmrdfblstpcbgpf`, us-west-2, Postgres 17.6, `ACTIVE_HEALTHY` |
| Applied migrations | 125 files in `apps/api/supabase/migrations` (plus 4 in the repo-root `supabase/migrations`) |
| Schemas in applied migrations | **`public` only** |
| Other schemas referenced | `seller_engine`, created solely by an unapplied draft (`supabase/migrations-draft/seller-engine/0001_seller_engine_canonical.sql`) |
| Application tables | ~125, all in `public` |
| Application views | ~20 `public.*` hydration and dashboard views |
| Object storage | No `storage.buckets` / `storage.objects` usage found anywhere in the repository |
| Credentials pattern | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` via environment |

The application's tables are messaging, campaign, workflow, inbox, closing-desk
and lead-command concerns: `campaigns`, `send_queue`, `workflow_runs`,
`inbox_thread_state`, `closing_cases`, `acquisition_opportunities`, and so on.

There is **no existing canonical property, parcel, party or transaction model in
`public`**. The nearest things are all derived, application-scoped artefacts:
`property_acquisition_scores`, `property_cash_offer_snapshots`,
`property_income_snapshots`, `map_filter_property_prospect_links`,
`deal_context_index`. Each is keyed on application concepts, not on an
authoritative parcel identity.

---

## 2. Does the Data Fabric need its own Supabase project?

**No.** Architecture forensics do not support creating one.

- Only one project exists, and the application occupies `public` exclusively.
- Postgres schemas already give complete namespace isolation. The Fabric can own
  `data_fabric` and `data_fabric_restricted` with zero collision risk: neither
  name is used, referenced, or reserved anywhere in the existing estate.
- Schema-level `REVOKE` plus forced RLS gives a stronger, more auditable boundary
  than a second project would, because a second project would push the boundary
  into application code and network configuration instead of the database.
- A second project would add a cross-project data movement problem to solve
  before delivering any value.

**Decision: the Fabric owns schemas inside the existing project.** This is
revisitable — if the Fabric's write volume or retention later warrants separate
compute, the schema boundary is exactly what makes that move mechanical.

---

## 3. Ownership map

| Object | Owner | Fabric access |
|---|---|---|
| `public.*` (all ~125 tables, ~20 views) | **Reivesti application** | **none** — the Fabric neither reads nor writes it |
| `seller_engine.*` (draft, unapplied) | seller-engine package | none |
| `data_fabric.*` | **Data Fabric** | full |
| `data_fabric_restricted.*` | **Data Fabric** | full; service role only |
| Object storage bucket for raw artifacts | **Data Fabric** | full; private bucket, not yet created |

### Shared interfaces

Exactly one direction, and it is not a shared table:

```
data_fabric.*  ──▶  named, versioned projections  ──▶  public.* consumers
```

The application reads Fabric output through **projections the Fabric publishes**
(read-only views or materialised views in `data_fabric`, granted explicitly), never
by selecting from Fabric base tables and never by joining across the boundary in
application code. Nothing in the Fabric reads `public.*`.

No projections exist yet. Defining the first one is a DF-0C task, once there is
canonical data worth projecting.

---

## 4. Roles and access

| Role | `data_fabric` | `data_fabric_restricted` |
|---|---|---|
| `anon` | revoked, explicit restrictive deny policy | revoked, explicit restrictive deny policy |
| `authenticated` | revoked, explicit restrictive deny policy | revoked, explicit restrictive deny policy |
| Fabric service role | full (bypasses RLS) | full (bypasses RLS) |
| Application service role | future: `SELECT` on named projections only | **never** |

RLS is enabled **and forced** on every Fabric table. `FORCE` is not decoration:
without it a table owner still bypasses the policies, which is precisely the
accident this boundary exists to prevent.

The application currently uses a permissive `anon`-can-do-everything pattern on
some of its own tables (e.g. `operator_entity_preferences`). That pattern is
**not** carried into the Fabric, and the divergence is deliberate.

---

## 5. Conventions carried over

Adopted from the existing estate so the two are mechanically compatible:

- Deterministic `text` primary keys from namespaced hashing (matching
  `packages/seller-engine/lib/hash.mjs`).
- FIPS, parcel numbers, ZIPs and phone numbers as `TEXT` — the leading-zero law.
- Raw payloads always retained; here they live in the artifact store rather than a
  `jsonb` column, because they are files.
- Migration **drafts** kept out of the applied migrations directory, following the
  existing `migrations-draft/` and `PROPOSED_*` conventions.

Deliberately **not** carried over:

- Everything-in-`public`. The Fabric owns named schemas.
- Permissive `anon` policies.
- Floating-point money. All currency is integer minor units in `bigint`.

---

## 6. Production boundary

- No migration in `db/migrations/` has been applied to any database.
- No production DDL was executed in this phase.
- No production data was read. The only remote call made was a read-only
  `list_projects` to establish how many Supabase projects exist.
- No scheduled ingestion was activated.
- No object-storage bucket was created.

Applying these migrations against a throwaway database is a prerequisite for
DF-0C, and cannot be done in the current environment (no Docker, no `psql` — see
the limitations section of the phase report).
