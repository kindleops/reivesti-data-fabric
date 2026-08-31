# Reivesti Data Fabric — Architecture

The Data Fabric ingests, preserves, normalises and serves authoritative
real-estate data from county, state, federal, licensed and first-party sources.
It is headless: a CLI, workers, a database, object storage, tests and structured
logs. It has no UI and no runtime dependency on the Reivesti web application.
The application is a **consumer** of Fabric output, never the other way round.

```
government / public / licensed source
        │
        ▼  source connector          (adapter: source-specific behaviour only)
        ▼  immutable artifact        (content-addressed, digest-verified)
        ▼  validated observations    (pinned schema, drift refused)
        ▼  canonical entities/events (Reivesti-owned identity)
        ▼  identity / property resolution
        ▼  derived intelligence      (later phases)
        ▼  Exchange / Deals / Lead Command / Network / AI
```

---

## 1. Non-negotiables, and where each one lives in the code

| Principle | Enforced by |
|---|---|
| Reivesti owns canonical identity; external ids are evidence | `src/canonical/models.ts` — every id is derived in a Reivesti namespace |
| Raw source evidence is immutable | `src/archive/object-store.ts` — write-once `put`; a differing rewrite is a hard error |
| Every derived fact traces to source evidence | `SourceEvidence` is a required field on every canonical type |
| Refreshes must not rewrite observed history | `src/canonical/revision.ts` — no update path exists, only new observations |
| Connectors are replayable | `replayArtifact` in `src/runtime/run.ts`; digest-verified reads |
| Parsers are deterministic | Injected clock, canonical JSON digests, no ambient state |
| Schema drift fails loudly | `src/schema/xsd.ts` + drift quarantine in `src/runtime/run.ts` |
| Ambiguity stays ambiguous | `ResolutionState`; DB check constraints in `db/migrations/0001` |
| False merges are worse than missed merges | eCRV emits only `unresolved` parties |
| Contact data is isolated | `src/contact/contact-plane.ts`; no canonical type has a contact field |
| "Public" does not mean automatable | `assertAutomationPermitted` in `src/runtime/transport.ts` |
| A URL is provenance, not identity | Storage path is `sha256-<digest>`; the URL is a manifest field |

---

## 2. Connector lifecycle

Seven stages. The runtime owns five of them; the adapter owns the rest.

| Stage | Owner | What happens |
|---|---|---|
| `discover` | connector | Which releases exist and how to request them |
| `fetch` | **runtime** | Transport, rate limit, retry, automation gate |
| `archive` | **runtime** | Digest, write-once store, retrieval manifest |
| `parse` | connector | Bytes → deterministic records |
| `validate` | connector | Pinned-schema validation, drift detection |
| `normalize` | connector | Record → canonical bundle + contact observations |
| `emit` | **runtime** | Revision decision, persistence, events, run report |

An adapter implements `Connector` (`src/runtime/connector.ts`) and nothing else.
It never opens a socket, never decides a run id, never writes to the store.

**Transports** are separate from adapters (`src/runtime/transport.ts`), so one
adapter can serve an HTTP bulk download today and an SFTP drop or a vendor
export later without touching its parser. Supported shapes: `bulk_download`,
`api`, `soap`, `sftp`, `manual_import`, `object_storage`, `vendor_export`.

### The automation gate

Before a single byte crosses the wire, the runtime checks the source's
`automationStatus` against whether the transport reaches the publisher. Anything
other than `sanctioned` refuses with `ACCESS_BLOCKED`. This is deliberately not
something an adapter can forget: a public record being public says nothing about
whether a publisher has sanctioned automated retrieval of it.

---

## 3. Source, release, run, artifact, observation

Five distinct things that are routinely conflated, and must not be:

- **Source** — the publisher's programme. `mn_dor_ecrv_weekly_sales_extract`.
- **Release** — what the publisher published. Exists whether or not we fetched it.
  One release may be fetched many times.
- **Run** — one execution of the pipeline. Identity is derived from the evidence
  and the code that read it: `(sourceId, mappingId, releaseId, artifactSha256,
  connectorVersion, parserVersion, normalizationVersion)`. Re-ingesting the same
  bytes with the same code produces the *same* run id, so the store replaces that
  run's partition rather than appending a duplicate. Change any input and you get
  a new run, which is exactly when you want one.
- **Artifact** — exact retrieved bytes plus their digest. Never overwritten.
- **Observation** — one immutable sighting of one source record.

---

## 4. Raw artifact retention

```
data-fabric/<sourceId>/<referencePeriod>/sha256-<digest>/
  source-original.<ext>
  manifest.json                                   ← retrieval facts, write-once
  interpretation/<parserVersion>__<schemaVersion>.json   ← per parse, write-once
```

Identity is the digest. A publisher who republishes `weekly.zip` with new bytes
gets a second directory; the first stays exactly as retrieved. Republishing
identical bytes is a no-op that records a fresh sighting on the run, not a new
artifact — and the *original* retrieval time is preserved, because that is the
historical fact.

**Why two manifests.** Byte length, digest and retrieval time are known the
moment bytes land and must never change. Record counts, effective date and
parser version are claims a *particular parser version* makes about those bytes.
A later parser may make different claims about the same evidence without
rewriting history. Each interpretation is write-once, so the same parser version
producing a *different* answer for the same bytes is a hard failure rather than
a silent overwrite — a determinism tripwire that costs nothing.

Reads re-hash and refuse on mismatch (`REPLAY`). Artifacts are never committed to
git; only tiny synthetic fixtures are.

---

## 5. Schema drift

The pinned schema is the publisher's own XSD, retained as a fixture with its
sha256 pinned in code. `src/schema/xsd.ts` compiles it into a validation model
and digests that model. A hand-written validator can drift from the authority; a
derived one cannot.

- **Structural drift** — an element the schema does not declare, a value outside
  a published enumeration, or the wrong root — **quarantines the whole run**. It
  never flows into normalisation on the assumption the changed part was
  unimportant.
- **Record faults** — a missing required element, a type violation, out-of-order
  children, a duplicated publisher key, or a record that contradicts itself —
  **quarantine that record**. One bad filing does not kill a 40,000-row extract.

Unknown fields are reported on the run, never dropped silently. The schema digest
ignores whitespace, comments and editor metadata, so a cosmetic republish does not
quarantine anything; adding, removing, retyping or re-enumerating anything does.

---

## 5-pre. Two runtimes, one contract

There are two orchestrators behind the same `Connector` contract:

| | buffered (`run.ts`) | streaming (`stream-run.ts`) |
|---|---|---|
| Holds | the whole artifact and its canonical output | a bounded window |
| Suits | filings, small extracts, fixtures | county-scale snapshots |
| Diff | in-memory revision ledger | fixed-width binary key index |
| Resolution | fold over the loaded estate | external sort and merge |
| Activation | partition replace per table | generation directory plus atomic `CURRENT` swap |

They produce the same canonical ids, the same resolutions and the same evidence
digests; the streaming path simply never holds the dataset. A connector opts in
by implementing `openStream`. See `STREAMING-INGESTION.md` for the design, the
measurements and the operational dials.

The rule the whole thing exists to keep: **the Fabric must never require
`source_dataset_size <= process_memory`.**

## 5a. Snapshot sources

eCRV is an append-only feed of filings. A county assessor roll is the opposite
shape: a periodic photograph of a state of the world. A connector declares
`snapshotSource: true` and the shared runtime turns on three behaviours — it does
**not** fork the pipeline.

**Reconciliation.** Every snapshot records the count the source claimed against
the count we retrieved, giving `complete` / `partial` / `unverifiable`. Without
that pair, "we ingested the whole county" is an assertion rather than a
measurement. An incomplete crawl quarantines the run.

**Absence.** A key earlier snapshots carried and this one does not is recorded as
its own observation. It is never a deletion: a partial export produces exactly
the same signal as a genuine retirement, and only later snapshots can tell them
apart. Prior observations and canonical rows are untouched.

**Field-group diffs.** Rows are digested per named group, so a run reports
"12,000 assessment changes and 40 owner changes" rather than "12,040 rows
changed".

## 5b. Property resolution across sources

A property's resolution is a **fold** over every identifier observation pointing
at it, recomputed as a projection — never an in-place edit of any observation.

That single choice buys order-independence. A fold over a set cannot depend on
insertion order, so ingesting a state transfer declaration and then a county
assessor roll produces byte-identical output to the reverse order. The canonical
property id helps: it is a pure function of `(countyFips, normalizedParcel)`, so
both sources compute the same id without ever consulting each other.

| Evidence | Identifier state | Property state |
|---|---|---|
| state-level preliminary PID only | `preliminary` / `provisional` | `provisional` |
| county-assigned authoritative PID | `final` / `resolved` | `resolved` |
| address only | `unknown` / `unresolved` | not resolved at all |

Authority is declared per source with `authoritativeForParcelIdentity`, and it is
**field- and semantic-specific**. A county assessor is authoritative for parcel
identity and *not* for an accepted transfer price; eCRV is authoritative for the
latter. There is no blanket "county beats state".

Disagreements become `property_conflicts` rows — flagged for a human or for
better evidence. Ingestion never picks a winner.

## 5c. Recorded instruments: document, conveyance, sale

DF-0E adds the first recorded-instrument family, and with it a three-level
distinction the rest of the system depends on:

| Claim | Needs | Source |
|---|---|---|
| **A document was recorded** | nothing beyond the row | recorder — always safe |
| **A conveyance was observed** | a conveying family AND an ownership-grade property link AND a named grantee | recorder — conditional |
| **A sale happened, for this much** | a transfer declaration | **eCRV only** — never a deed |

A deed carries no reliable price, so there is deliberately no recorder-sourced
sale event of any kind, and the database constraint on `canonical_events` says so.

Four instrument types touch title and are still excluded from conveyance: a
contract for deed (equitable interest only), a transfer-on-death deed (conveys
nothing until death), a sheriff's certificate (subject to redemption) and a
correction (amends, conveys nothing). Each would look like an ownership change to
a naive rule.

**Unresolved references are data.** A satisfaction naming a mortgage the estate
has not backfilled yet keeps its pointer; the lineage appears the moment the
target arrives.

**Authority is field-specific.** The recorder is authoritative for recording
date, document number and document type. The assessor is authoritative for parcel
identity. eCRV is authoritative for sale economics. There is no global ranking
between sources, and the registry's `authoritativeForParcelIdentity` flag is
per-field precisely so no one is tempted to invent one.

## 5d. Not triple-counting a transaction

Three sources describing one sale must not become three canonical sales, and must
not be merged on a hunch. Observations are clustered by property and date and the
cluster is classified — `SUPPORTED_MATCH`, `POSSIBLE_MATCH`, `CONFLICT`,
`UNRESOLVED` — never merged. A `CONFLICT` is a durable statement that the sources
disagree, which beats a silently chosen winner.

## 6. Change detection

| Case | Result |
|---|---|
| First sighting of a source record key | `new` — observation written, canonical output emitted |
| Same key, byte-identical content | `unchanged` — nothing written, nothing emitted |
| Same key, different content | `revised` — a new observation that *supersedes* the prior one |

There is no code path that updates a prior observation in place. A revision keeps
the earlier observation, its digest, and the artifact that carried it.

---

## 7. Replay

Take a retained artifact, throw away the derived estate, and run again:

```
df replay mn_ecrv__all_mn_counties --artifact <sha256> --period 2026-W31
```

The run reads bytes back through the store (re-hashing them), runs the identical
pipeline with no network involved, and must produce the same run id, the same
`normalizedDigest`, the same counts and the same canonical ids.

`normalizedDigest` is a digest over the canonical reading of the *whole artifact*
— every valid record, whether or not this particular run wrote it. That makes it
a property of the evidence and the code rather than of what the store happened to
contain, which is the only version of the property worth testing.

---

## 8. The restricted contact plane

Two questions, kept apart because they have different answers:

- **May we retain this observation?** → `status`
- **May we use this channel to contact a person?** → `permittedUse`

`record_only` is the default and the only value ingestion assigns. A phone number
on a public filing is evidence the number was stated. It is not consent. No
outbound, suppression, TCPA or DNC logic lives in the Data Fabric.

The structural guarantee is stronger than the access check: **no canonical type
has a field that can hold a phone number, an email address or free-text contact
notes.** Contact data cannot leak into market intelligence by accident, because
there is nowhere for it to land. Tests assert this both by inspecting canonical
key names and by grepping serialised output for the fixture values.

Reads require an explicit principal. `anonymous` and `member` — the public and
customer-facing surfaces of the Reivesti application — are refused with
`RESTRICTED`. Value-free aggregates (`size()`, `countsByType()`) are available
without a privileged read, so run reports need no exemption.

Raw artifacts carry the same data and are labelled `carriesRestrictedContact` in
their manifest, so storage policy can act on it.

---

## 7a. Digesting without holding the dataset

The buffered runtime digests a run by collecting per-record digests, sorting and
hashing the join — which needs the whole dataset in memory.

The streaming runtime accumulates instead: each record's sha256 is treated as a
256-bit big-endian integer and added modulo 2^256. Addition is commutative, so
order cannot change the result, and unlike XOR it does not cancel duplicates.
Memory is 32 bytes regardless of row count.

It is a multiset checksum for change detection rather than a collision-resistant
commitment, which is the right tool for "did this file change?" and the wrong one
for an adversarial setting. No source in the Fabric is adversarial.

## 8a. What the replay digest covers

`normalizedDigest` answers "what do these bytes say?", which must be stable
forever. A snapshot source also produces output describing how this reading
*differs from what we already knew* — a change kind, a `PARCEL_ATTRIBUTES_CHANGED`
event. Those depend on store history, not on the bytes, so the same artifact
legitimately produces different values for them on a first ingest and a re-ingest.

They are therefore excluded from the digest and reported separately, on the
parcel observations and in the run metrics, where a changing value is correct.

A related rule, learned the hard way: a run's partition holds the **complete**
canonical reading of its artifact, not just the delta it found newsworthy. A run
id is derived from its evidence, so persisting only the delta meant re-ingesting
an unchanged artifact rewrote that run's partition with nothing — deleting rows
the earlier run had correctly emitted. The delta drives metrics and the
append-only observation ledger; it does not decide what the partition contains.

## 9. Storage and the database

Two schemas, both owned by the Fabric and disjoint from the application's
`public` schema (see `REIVESTI-DB-TOPOLOGY.md`):

- `data_fabric` — provenance, canonical entities, canonical events
- `data_fabric_restricted` — the contact plane

RLS is enabled **and forced** on every table (`FORCE` matters: without it a table
owner still bypasses the policies). `anon` and `authenticated` are explicitly
denied and have no `USAGE` on either schema.

Migrations in `db/migrations/` are **drafts and have not been applied to any
Reivesti database, and never to production**. They are, however, executed for
real: `npm run test:pg` boots a disposable PostgreSQL 17 cluster in a temp
directory, applies every migration, and interrogates `pg_catalog` and real row
behaviour — objects created, constraints enforced on real inserts, RLS blocking
real roles, and two independent fresh applications producing an identical schema
signature. Structural tests assert what the SQL *says*; that gate asserts what
PostgreSQL *does* with it.

The local derived plane (`var/derived`, `var/restricted`) mirrors these tables as
NDJSON partitions, one file per (table, run), replaced atomically. Loading it into
Postgres in a later phase is mechanical.

---

## 10. Expansion model

Adding a source is: a registry row, a mapping row, and an adapter implementing
`Connector`. Nothing in the runtime changes.

The contract is deliberately exercised against five source shapes before any of
them is built (all `planned` in the registry, none implemented):

| Shape | Example | What it stresses |
|---|---|---|
| Statewide bulk file | MN eCRV (DF-0B) | one source, 87 jurisdictions, weekly releases |
| County snapshot | Hennepin assessor (DF-0C) | state-of-the-world per release, not events |
| Document index | Hennepin recorder (DF-0D) | append-only instruments, sanctioned access |
| Statewide entity API | MN Secretary of State (DF-0E) | API transport, organisation resolution |
| County notice feed | Dallas foreclosures (DF-0F) | dated events, a second state |

A mapping whose jurisdictions are not yet catalogued fails loudly rather than
expanding to zero — asserted in tests using the Dallas mapping, since Texas
counties are not catalogued.

---

## 11. Observability

Structured JSON logs only. Every run emits `run.release_selected`,
`run.archived`, `run.parsed`, per-record `record.quarantined`, and
`run.finished` with the full metric set. `runReport()` is the concise operator
view; `df runs` lists history. No admin UI in this phase, by design.
