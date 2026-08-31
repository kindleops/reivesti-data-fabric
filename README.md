# reivesti-data-fabric

The authoritative ingestion, provenance, canonicalization and resolution codebase
for Reivesti. Headless: CLI, workers, database, object storage, tests, structured
logs. No UI, no frontend dependencies, and no runtime dependency on the Reivesti
web application — that application is a **consumer** of what this produces.

**Phase:** DF-0A (national source runtime) + DF-0B (Minnesota eCRV) + DF-0C
(real PostgreSQL migration proof, Hennepin County assessor, cross-source
property resolution) + DF-0D (bounded-memory streaming, full-county proof) +
DF-0E (recorded instruments, instrument graph, ownership foundation) + DF-0F
(Minnesota Secretary of State business register, organization identity).

---

## Quick start

Node 22.18+ is the only requirement. TypeScript runs directly via Node's type
stripping, so there is no build step; `typescript` is a dev dependency used only
for the typecheck gate.

```bash
npm install            # also pulls a self-contained PostgreSQL for the migration gate
npm run check          # tsc --noEmit && tests && real-Postgres migration gate

node src/cli/df.ts sources
node src/cli/df.ts fields
node src/cli/df.ts run mn_ecrv__all_mn_counties \
  --file fixtures/mn-ecrv/weekly-extract-sample.zip --period 2026-W31

# A snapshot source. --live reaches the county's public API; --max bounds it.
node src/cli/df.ts run hennepin_assessor__hennepin \
  --file fixtures/hennepin/snapshot-2026-08.ndjson --period 2026-08

# The bounded-memory path. Handles a whole county; `run` does not.
node src/cli/df.ts stream hennepin_assessor__hennepin \
  --file fixtures/hennepin/v2-2026-08.ndjson --period 2026-08

node src/cli/df.ts resolutions   # canonical property resolution state
node src/cli/df.ts conflicts     # cross-source disagreements, flagged not guessed
node src/cli/df.ts runs
```

`npm run test:pg` is the migration gate on its own. It boots a disposable
PostgreSQL 17 cluster in a temp directory, applies every migration for real, and
deletes the cluster. It skips loudly — never silently — if no PostgreSQL binaries
are found.

`DF_VAR` (default `var`) and `DF_ARCHIVE` (default `var/archive`) control where the
derived plane and the artifact store live. Both are gitignored.

---

## Layout

```
src/
  core/         hashing, canonical JSON, strict XML, zip, logging, clock, errors
  registry/     jurisdictions, sources, capabilities, scope expansion
  schema/       XSD compiler, instance validator, schema digest
  archive/      write-once object store, content-addressed artifact store
  runtime/      connector contract, transports, retry, run orchestrator, stores
  canonical/    property, party, transaction, financing, events, revision ledger
  contact/      restricted contact plane
  connectors/
    mn-ecrv/    field map, record types, parser, normaliser, connector
    mn-hennepin-assessor/   the same five files for the first snapshot source
    mn-hennepin-recorder/   taxonomy, record, parse, normalise, streaming connector
    mn-sos-business/        domain vocabularies, heterogeneous CSV, licensed delivery
  cli/          df
db/migrations/  data_fabric + data_fabric_restricted — DRAFTS, NOT APPLIED to
                any Reivesti database; executed for real against a disposable one
docs/           architecture, source registry, MN eCRV, DB topology, decisions
fixtures/       the pinned eCRV XSD and synthetic test documents, all invented
tests/          424 tests plus 40 real-PostgreSQL migration assertions
```

---

## Documentation

| Document | Covers |
|---|---|
| [DATA-FABRIC-ARCHITECTURE.md](docs/DATA-FABRIC-ARCHITECTURE.md) | System architecture, connector lifecycle, immutability, replay, drift, the contact plane, expansion |
| [SOURCE-REGISTRY.md](docs/SOURCE-REGISTRY.md) | Jurisdiction/source modelling, how one statewide connector covers 87 counties, activation lifecycle |
| [MN-ECRV.md](docs/MN-ECRV.md) | Authority, access, cadence, schema, field coverage, county-added limitations, live-activation steps |
| [STREAMING-INGESTION.md](docs/STREAMING-INGESTION.md) | Bounded-memory design, what was actually wrong, measurements, checkpoint/resume, operational dials |
| [HENNEPIN-RECORDED-INSTRUMENTS.md](docs/HENNEPIN-RECORDED-INSTRUMENTS.md) | RecordEASE access finding, document taxonomy, reference graph, ownership and mortgage boundaries, convergence |
| [MN-SOS-BUSINESS-ENTITIES.md](docs/MN-SOS-BUSINESS-ENTITIES.md) | Licensed bulk delivery, what the licence permits, the heterogeneous CSV, organization resolution rules and why almost nothing resolves |
| [HENNEPIN-ASSESSOR.md](docs/HENNEPIN-ASSESSOR.md) | Authority, ArcGIS access, 122-field coverage, snapshot semantics, crawl strategy, eCRV convergence, ownership limits |
| [REIVESTI-DB-TOPOLOGY.md](docs/REIVESTI-DB-TOPOLOGY.md) | What the application owns, what the Fabric owns, why no second Supabase project |
| [DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) | EXISTING / REUSE / EXTEND / NEW / REJECTED |

---

## Status

| | |
|---|---|
| DF-0A national foundation | complete |
| DF-0B Minnesota eCRV connector | complete, **blocked on live access** |
| DF-0C real PostgreSQL migration proof | complete — PostgreSQL 17.10, 25 assertions |
| DF-0C Hennepin assessor connector | complete, **live access permitted**, proven on 5,000 real parcels |
| eCRV live extract retrieval | not available — request access from ecrv.support@state.mn.us |
| DF-0D streaming runtime | complete — 448,087 parcels in a 512 MB heap |
| Hennepin full-county ingestion | proven: 448,087 parcels, reconciled, 221 MB peak; not scheduled |
| DF-0E recorded-instrument architecture | complete |
| Hennepin RecordEASE access | **blocked** — terms prohibit programmatic access; activation is a data-practices request |
| DF-0F business-entity register and organization identity | complete |
| MN SOS bulk delivery | **not purchased** — $710 commercial one-time, signed licence, no machine endpoint |
| Production DDL | **not applied**, and not ready to be |
| Scheduled ingestion | not activated |

Everything after retrieval — archival, schema validation, parsing, normalisation,
revision detection, replay — runs today against operator-supplied files and
fixtures, and will run unchanged against the live feed. See
[MN-ECRV.md §8](docs/MN-ECRV.md) for the exact activation steps.

## Safety properties worth knowing before you change anything

- The runtime refuses to reach a publisher unless the registry records that the
  publisher **sanctioned** automated retrieval.
- Retained artifacts are write-once. An overwrite is an error, not a replacement.
- Schema drift quarantines a run. It never flows through.
- No canonical type has a field that can hold a phone number or an email address.
- No party from any source is ever resolved to a canonical identity. Matching
  names are not evidence.
- An organization name resolves to a state registration on one thing only: the
  registry's own identifier. A statewide-unique exact name is strong evidence and
  still does not resolve, pending a collision audit on the real register.
- A licensed source carries its terms in the registry and a licence class on every
  row. A delivery whose terms do not permit the use quarantines before it is read.
- A business registration says a REGISTRATION exists. It never says a company
  trades, holds property, or is worth contacting.
- A parcel's absence from the latest snapshot is never a deletion.
- Property resolution is a fold over evidence, so it cannot depend on the order
  sources were ingested in.
- An assessor roll never produces a sale, a transfer, or an ownership acquisition.
- A recorded deed never produces a sale either: a deed carries no reliable price.
- A source whose terms forbid automation is marked `prohibited`, and the runtime
  refuses every publisher-reaching transport for it.
- Batch sizes are throughput dials that never change results.
- A crash cannot activate a partial estate: canonical rows are activated by one
  atomic pointer swap.
