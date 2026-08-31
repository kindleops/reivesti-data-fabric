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

## 9. Storage and the database

Two schemas, both owned by the Fabric and disjoint from the application's
`public` schema (see `REIVESTI-DB-TOPOLOGY.md`):

- `data_fabric` — provenance, canonical entities, canonical events
- `data_fabric_restricted` — the contact plane

RLS is enabled **and forced** on every table (`FORCE` matters: without it a table
owner still bypasses the policies). `anon` and `authenticated` are explicitly
denied and have no `USAGE` on either schema.

Migrations in `db/migrations/` are **drafts and have not been applied anywhere**.

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
