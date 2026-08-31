# DF-0A / DF-0B design decisions

Recorded before implementation, after auditing the existing Reivesti estate
(`kindleops/rei-automation`) for reusable infrastructure.

---

## EXISTING — found in the Reivesti estate

| Thing | Where | Verdict |
|---|---|---|
| Deterministic namespaced hashing | `packages/seller-engine/lib/hash.mjs` | pattern is right |
| Idempotent streaming importer with raw preservation + lineage | `packages/seller-engine/importers/common.mjs` | pattern is right |
| NDJSON staging store, atomic partition replace per batch | `packages/seller-engine/lib/store.mjs` | pattern is right |
| Schema fingerprint from sorted header list | `importers/common.mjs` | pattern is right, too weak for XML |
| `import_batches` / `source_records` lineage tables | `supabase/migrations-draft/seller-engine/0001_*.sql` | vendor-CSV-shaped |
| Corpus manifests with completion evidence | same draft | good idea, different problem |
| Migration drafts kept out of the applied directory | `migrations-draft/`, `PROPOSED_*` | convention adopted |
| RLS with explicit service-role policies | `apps/api/supabase/migrations/planned/item5c/0001_*.sql` | convention adopted, hardened |
| `node --test`, ESM, zero-dependency local tooling | `packages/seller-engine` | convention adopted |
| Leading-zero law: FIPS/APN/ZIP/phone as TEXT | seller-engine canonical draft | convention adopted |

## REUSE — conventions carried into this repository

- Deterministic `text` ids from namespaced sha256.
- NDJSON partition store, one file per (table, run), replaced atomically.
- Raw always retained; lineage on every row.
- `node --test` with no test framework dependency.
- TEXT for anything with meaningful leading zeros.
- Migration drafts are not applied migrations.

These are **conventions**, re-implemented here. No application code was copied,
and this repository imports nothing from `rei-automation` — a hard requirement,
since the Fabric must not depend on the web application runtime.

## EXTEND — existing ideas taken further

| Existing | Extension | Why |
|---|---|---|
| `file_sha256` on an import batch | Content-addressed artifact store with write-once enforcement, digest-verified reads, and a machine-readable manifest | A hash column records identity; it does not *enforce* immutability. `latest.xml` becoming history is prevented by storage semantics, not by a column. |
| `schema_fingerprint` from sorted CSV headers | Compiled-XSD digest plus per-record structural validation | A header list cannot express types, enumerations or cardinality. Enum drift is invisible to a header hash. |
| `import_batches` | `source` / `release` / `run` / `artifact` / `observation` as five distinct things | A vendor CSV conflates them harmlessly. A weekly government extract that reissues corrections does not. |
| One-shot batch idempotency | Explicit `new` / `unchanged` / `revised` classification with supersession | The existing importer replaces a partition. That is right for a vendor snapshot and wrong for an authoritative record that gets corrected. |
| Raw JSON retained in a `jsonb` column | Raw bytes retained as files, digested and manifested | Source evidence is a file, and a file's identity is its bytes. |

## NEW — no existing equivalent

| Component | Why it had to be new |
|---|---|
| National source registry (jurisdiction × source × capability × scope) | Nothing in the estate models jurisdictions or source terms at all. |
| Connector runtime with a seven-stage lifecycle | The existing importer is CSV-and-filesystem shaped; it cannot express discovery, transports or releases. |
| Transport abstraction with an automation gate | "Public does not mean automatable" had nowhere to live. |
| XSD compiler and instance validator | No XML handling existed anywhere. |
| Strict XML reader that refuses DOCTYPE | Same, plus this closes XXE and entity expansion for every future connector at once. |
| Zip reader | The extract is a zipped folder and there was no unzip path. |
| Restricted contact plane | Contact data currently lives in the application's `public` tables alongside everything else. The Fabric cannot inherit that. |
| Canonical property / party / transaction / financing substrate | No canonical property or transaction model exists in `public`; the nearest tables are derived, application-scoped scores and snapshots. |
| Revision ledger | No supersession concept existed. |

## REJECTED — parallel abstractions deliberately not built

| Rejected | Instead |
|---|---|
| A second Supabase project for the Fabric | Owned schemas in the existing project. Forensics found one project, application confined to `public`, and no name collision. See `REIVESTI-DB-TOPOLOGY.md`. |
| Importing `@rei/seller-engine` for hashing and storage | Re-implemented the two small primitives. Importing would create the dependency on the application runtime this repository exists to avoid, for ~40 lines of code. |
| A second lineage vocabulary alongside `import_batches` / `source_records` | Extended the same vocabulary (`source_artifacts`, `source_record_observations`) rather than inventing a rival one with different words for the same ideas. |
| An XML parsing dependency (`fast-xml-parser` et al.) | A ~200-line strict reader. Zero dependencies keeps the parser deterministic across environments, and lets DOCTYPE be refused outright rather than configured off. |
| A generic `raw_json` column on canonical tables | Raw lives in the artifact store. A canonical row carries a digest pointing at it. |
| A `properties` row per transaction when no parcel resolves | No property row at all. Fabricating one to have something to point at is exactly the false identity the architecture forbids. |
| Mapping eCRV use-taxonomy codes to a Reivesti taxonomy | `DERIVE_LATER`. The code list is not published with the extract; guessing it would be inventing data. |
| Treating `financeType = CASH` as a cash buyer, or `legalActionInd` as a foreclosure | Both stay as source declarations on the transaction. These are derived claims about people, and DF-0B does not make them. |
| Resolving parties on matching names | All eCRV parties are `unresolved`. False merges are worse than missed merges. |
| An admin UI | CLI plus structured logs, per the phase brief. |

---

## Two decisions worth their own note

**Preliminary parcels resolve to `provisional`, not `resolved`.** The extract
carries the submitter's PID, and the department states county-added data — which
includes final PIDs — is not in this feed. A deterministic county+parcel key is
good enough to join on and not good enough to call settled. `provisional` says
both things at once, and DF-0C can promote it when a county source confirms.
A consequence worth stating: **nothing in DF-0B is ever `resolved`.** That is the
honest state of the evidence, not a gap.

**`normalizedDigest` covers the whole artifact, not the run's writes.** An early
version digested only the records a run persisted, which made a second idempotent
ingest produce a different digest for identical bytes — and, because the
interpretation record is write-once, a self-contradiction. Digesting every valid
record in the artifact makes the value a property of the evidence and the code
rather than of what the store happened to contain. That is the only version of
the property worth testing, and the write-once interpretation record now enforces
it: the same parser producing a different answer for the same bytes is a hard
failure.
