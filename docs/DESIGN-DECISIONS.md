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
| Partitioning projections by `source_id` | By jurisdiction, for property. Property resolution exists to make the assessor, eCRV and the recorder converge on one parcel; partitioning by source would put three observations of one property in three partitions that never meet, which does not slow convergence down — it removes it. |
| One partition per property | Correct and useless: the address-collision pass compares parcels against each other, so a per-property partition cannot see the conflict it exists to find. Also millions of generation directories. |
| Partitioning organization identity by county | Nation-scoped. A company observed as an owner in Hennepin may be registered in Delaware; scoping identity to where an observation happened to be seen is the definition of a wrong key. |
| Claiming global atomicity across a multi-partition run | Per-partition activation, with the outcome of each recorded. Partitions are independent, so a half-applied run leaves every partition individually consistent — and saying that plainly beats implying a guarantee that does not exist. |
| A hard-coded county count | Derived from pinned Census files, digest-verified at load. Connecticut replaced eight counties with nine planning regions; a remembered number is a bug waiting for a news cycle. |
| Mapping retired Connecticut counties onto planning regions | No successor asserted. The boundaries do not correspond one-to-one and no federal crosswalk exists; inventing one would relocate every record filed before 2022. |
| Calling the island areas "retired" because they are absent from the 2025 Gazetteer | `SOURCE_LEGACY`. Absence from a product's scope is not evidence that a geography ceased to exist. |
| Treating `UNKNOWN_COST` as free, or as paid | Neither. Unknown is ineligible for core use and is reported as unresearched — "we have not priced it" sends someone to a fee schedule, "it costs money" sends them to a budget. |
| Cost as a heavily-weighted ranking factor | A hard gate. A paid source is excluded and the exclusion is reported instead of a score; a weight is how a doctrine erodes one comparison at a time. |
| An automated source-discovery bot | `df sources verify` reports what evidence is missing and reaches no publisher. Crawling the internet looking for government data is the behaviour the access doctrine exists to prevent. |
| Reporting Texas's missing transfer prices as `BLOCKED_ON_COST` | `UNAVAILABLE`, with the statute. Tex. Tax Code § 22.27 means no amount of money buys a lawful government sale-price feed; "keep looking" is the right answer to a paid source and the wrong answer to a record that does not exist. |
| Scraping the MBLS public business search instead of buying the bulk file | Bought the licensed product's route. A public UI is a different access route under different terms, and "the data is public" is not the same as "this mechanism is sanctioned". `manual_only`, and the connector ships no HTTP client. |
| Buying Active Business Data at $30 instead of Business Bulk Data at $710 | The cheap product omits every inactive registration — exactly the population that matters when tracing a dissolved seller entity. Saving $680 by silently narrowing the estate is not a saving. |
| Fuzzy organization matching (Levenshtein, Jaro-Winkler, embeddings) | Deterministic rules only. All three are excellent ways to rank candidates for a human and none of them may establish identity. A false merge corrupts every downstream ownership conclusion, silently. |
| Resolving on a statewide-unique exact legal name | Recorded as *strong* evidence and still `provisional`. Enabling the rule is a decision to make after `measureNameCollisions()` runs on the real register, not before. |
| Linking an assumed name to the business that filed it | The delivery documents no such link. The assumed-name row becomes its own entity, flagged as not a legal entity, and any parent relationship is left to the evidence-scored resolver. |
| Deriving prior names from the bulk file | The file carries only names active at generation time. No `PRIOR_NAME` is emitted from a single delivery; a name history is a Reivesti derivation across deliveries, and is not claimed as a source fact. |
| Assuming the bulk CSV is grouped or sorted by Master ID | Externally sorted before grouping. The guide never promises an ordering, and assuming one would make the estate depend on how the publisher happened to write the export. |

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


**A registry is a register.** `registryStatus: 'active'` means a filing is in good
standing with the Secretary of State. It does not mean the company trades, employs
anyone, holds property or is worth contacting. There is deliberately no
`BUSINESS_ACTIVE`, `BUSINESS_OPERATING` or `ACTIVE_BUYER` event type, no
`is_operating` column, and a test enumerates the event vocabulary to keep it that
way. The temptation to read a status column as a buying signal is exactly the kind
of quiet inference this codebase exists to prevent.

**Row numbers are not part of a record.** An early version of the SOS connector
carried the delivery's row numbers on the grouped record for traceability. They
reached the content digest, which meant a reshuffled export looked like a register
in which every company had changed — and the September delivery reported 17
revisions where one address had moved. Row numbers are a property of the
delivery's ordering, not of the business. They survive only on quarantined rows,
where tracing back to the file is the entire point.

**A licence is part of a delivery's identity.** The SOS manifest travels as line 1
of the artifact rather than as a sidecar, so the terms the bytes arrived under are
inside the immutable evidence. A delivery whose declared terms do not permit the
intended use quarantines the run before a single row is read. Ingesting bytes
whose terms are unknown, and discovering the problem later from the data, is the
failure mode that costs a relationship with a publisher.


**Partitioning the inputs, not just the outputs.** The first sketch of the
partition store split only the projection's results by county. That would have
looked like a fix and been worth almost nothing: the fold still had to *read*
every county's contributions to produce one county's answer, so the cost stayed
O(estate). Contributions are therefore written into per-partition files at run
time, which is what makes "recompute Hennepin" open no Ramsey file. The
measurement is the proof — 5,001 input rows read for a one-county update in a
1.5-million-row estate.

**The address-collision key was quietly wrong, and partitioning found it.**
`projectResolutions` grouped its second pass by address alone. With one county
that is correct; with 3,222, "100 Main St" in Hennepin and "100 Main St" in
Ramsey would have grouped together and reported rival parcel identities for one
address across state lines. The group key now includes the county FIPS, and
county partitioning makes the case unreachable in the normal path as well. Two
independent guards for the same mistake, because the failure is silent.

**A registry that cannot name a place cannot report a gap.** Expanding the
jurisdiction catalogue from 87 counties to 3,244 county-equivalents is not
cosmetic: coverage reporting is the whole point of DF-0G, and a place absent from
the catalogue produces no row at all rather than an `UNVERIFIED` one. The
difference between "we have nothing for Wyoming" and "Wyoming is not in our
model" is the difference between a work queue and a blind spot.
