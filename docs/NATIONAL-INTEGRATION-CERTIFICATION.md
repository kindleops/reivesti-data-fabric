# National integration certification (DF-0O)

Minnesota, Wisconsin and New York, integrated on one `main`, certified
together. Florida is certified on its own branch and integrates next, under
the contract in §2.
This document records what was proven, at what level, on what evidence — and,
as carefully, what was not.

**Gate.** `THREE_STATE_INTEGRATION: PASS` · `FOUR_STATE_INTEGRATION: PENDING_FLORIDA_INTEGRATION`
(Florida's branch is certified; it is not yet merged with this one).

---

## 1. Git and branch state

| | |
|---|---|
| `main` after New York | `f0891a4` — merge of PR #4 (DF-0N New York + the DF-0O permission fix), merge commit like PR #3 |
| PR #4 | CI green on `e77bff7`; CodeRabbit's 8 findings: 7 fixed (owner-only hardening, `--max` validation, docs), 1 withdrawn (POSIX-only repo); every thread resolved before merge |
| Merges before it | #1 DF-0A/B, #2 DF-0C, #3 DF-0K Wisconsin + DF-0L durable artifacts |
| Migrations on `main` | 11 drafts, unchanged by DF-0N and DF-0O; no duplicate numbers; no production DDL |
| Branch protection | the protection API returns 403 to this session; the rulesets endpoint lists none. PR #4 merged through the normal merge API with checks green — nothing was bypassed |
| Florida (DF-0M) | **on branch `claude/wisconsin-parcel-ingestion-1zz3r9`** (misnamed: it carried DF-0K/DF-0L as PR #3 and then received Florida), HEAD `c868376`, 13 commits beyond the PR #3 merge base `e9ada40`, no pull request. Certified there (2026-09-30): 67 counties, 11,090,492 properties, three sources, network-off replay, idempotency, migration 0012 chain twice. **Not merged and not counted here** — this document certifies `main`. An earlier draft of DF-0O recorded Florida as "not found": the branch was in the listing, but it was taken for the already-merged Wisconsin branch without checking for commits ahead of `main`. That was wrong. |

## 2. Florida: the integration contract

A branch's own certification is never `main`'s. Florida (§1) integrates on
these terms, and fails them loudly otherwise:

1. **It is merged only after its own certification** — full statewide ingest,
   NOOP, forced re-ingest and a network-off replay, evidence in
   `reference/fl-statewide/2026/` (Florida has this) — and through a
   history-preserving merge into current `main`, never a re-implementation.
2. **Registry**: its source(s) and mapping(s) append to `SOURCES`/`MAPPINGS`
   with unique ids (`tests/national-integration.test.ts` fails on a duplicate).
   Its lifecycle is derived (`src/registry/lifecycle.ts`); nothing is declared.
3. **Totals are computed, never typed**: `automatedCoreJurisdictions(registry)`
   is 193 today; with Florida it is 193 + Florida's own expansion, and no test
   may hard-code a national total that assumes Florida (the four-state figure
   is a result, not a constant).
4. **Identity**: Florida adds a row to `IDENTITY_CONTRACTS`
   (`src/canonical/identity-inventory.ts`) naming its scheme, routing and
   collision evidence; it mints ids only through
   `propertyIdFromCountyParcel(countyFips, normalizedParcel)` with FIPS `12`;
   the inventory test refuses a state sharing a FIPS prefix.
5. **Shared files**: the merge-conflict table in
   `docs/NEW-YORK-STATEWIDE-PROPERTY.md` §14 lists every shared file New York
   and DF-0O touched and how to resolve each. Florida merges main, resolves
   that table additively, and re-runs the whole suite, the PostgreSQL gate as
   a non-root user, and live discovery-only ticks for every automated source.
6. **Organizations**: Florida's run joins the national fold's expected set
   automatically (§5); a container that cannot read Florida's run tables
   records the fold `PARTIAL`, never national.
7. **Capacity**: Florida's pipeline declares a measured `FootprintProfile` and
   calls the preflight before acquiring, rehydrating or deriving (§7).

## 3. The reconciled source graph

`df national` — one lifecycle per mapping, derived from the doctrine verdict,
the mapping status, the acquisition class and the automation status. There is
no lifecycle field to set by hand.

| Source | Mapping | Lifecycle | Jurisdictions |
|---|---|---|---:|
| `mn_statewide_parcels` | opt-in counties | ACTIVE_AUTOMATED_CORE | 59 |
| `mn_hennepin_county_parcels` | Hennepin | ACTIVE_AUTOMATED_CORE | 1 (inside the 59) |
| `wi_statewide_parcels` | all WI counties | ACTIVE_AUTOMATED_CORE | 72 |
| `ny_statewide_parcels` | all NY counties | ACTIVE_AUTOMATED_CORE | 62 |
| `mn_dor_ecrv_weekly_sales_extract` | all MN counties | BLOCKED_ACCESS | 87 |
| `mn_hennepin_recorded_instruments` | Hennepin | BLOCKED_AUTOMATION | 1 |
| `wi_dor_retr_historical` | all WI counties | FIXTURE_ONLY | 72 |
| `mn_sos_business_entities` | statewide | DEFERRED | 1 |
| `ny_statewide_parcel_polygons` | (none — validation only) | DEFERRED | 0 |
| `tx_dallas_foreclosure_notices` | Dallas | UNKNOWN (cost unestablished) | 1 |

`PAID_OPTIONAL` and `CORE_ELIGIBLE_NOT_INGESTED`: none today. The lifecycle
vocabulary reuses the doctrine's own verdict names (`BLOCKED_ACCESS`,
`BLOCKED_MANUAL_ACQUISITION`, `BLOCKED_AUTOMATION`, `DEFERRED`) and the
mapping status `fixture_only`. `ACTIVE_AUTOMATED_CORE` requires all of:
`CORE_ELIGIBLE`, an active mapping, an automated acquisition class **and**
`automationStatus: sanctioned` — the last added in DF-0O after a test showed a
copy of a core source marked `manual_only` would otherwise still have read as
automated.

**Automated-core parcel jurisdictions: 193**, computed
(`automatedCoreJurisdictions`), equal to 59 + 72 + 62 because Hennepin's own
feed lies inside Minnesota's 59.

## 4. Capability coverage, by state (registry claims)

County-equivalents per lifecycle. `NOT_SUPPORTED`: no source in the registry
claims the capability there. `SALE_OBSERVATION` is an assessor's sale echo
(Minnesota's `ASSESSOR_REPORTED_SALE_OBSERVATION`); `SALE_ECONOMICS` is a
filed declaration of consideration (eCRV, RETR). Neither is inferred from a
column existing.

| Capability | MN (87) | WI (72) | NY (62) |
|---|---|---|---|
| PARCEL | 59 ACTIVE · 28 BLOCKED_ACCESS | 72 ACTIVE | 62 ACTIVE |
| ASSESSOR | 59 ACTIVE · 28 NOT_SUPPORTED | 72 ACTIVE | 62 ACTIVE |
| OWNERSHIP_CURRENT | 59 ACTIVE · 28 NOT_SUPPORTED | 72 ACTIVE | 62 ACTIVE |
| TAX | 59 ACTIVE · 28 NOT_SUPPORTED | 72 ACTIVE | 62 NOT_SUPPORTED |
| SALE_OBSERVATION | 59 ACTIVE · 28 NOT_SUPPORTED | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |
| SALE_ECONOMICS | 87 BLOCKED_ACCESS | 72 FIXTURE_ONLY | 62 NOT_SUPPORTED |
| TRANSFER | 87 BLOCKED_ACCESS | 72 FIXTURE_ONLY | 62 NOT_SUPPORTED |
| DEED | 87 BLOCKED_ACCESS | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |
| MORTGAGE | 87 BLOCKED_ACCESS | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |
| MORTGAGE_RELEASE | 1 BLOCKED_AUTOMATION · 86 NOT_SUPPORTED | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |
| LIEN | 1 BLOCKED_AUTOMATION · 86 NOT_SUPPORTED | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |
| FORECLOSURE_NOTICE | 87 NOT_SUPPORTED | 72 NOT_SUPPORTED | 62 NOT_SUPPORTED |

(ACTIVE = ACTIVE_AUTOMATED_CORE.) Nationally: PARCEL / ASSESSOR /
OWNERSHIP_CURRENT 193, TAX 131, SALE_OBSERVATION 59, and **0** for sale
economics, transfer, deed, mortgage, mortgage release, lien and foreclosure
notice — asserted by the regression matrix, so a fake deed or sale claim fails
the suite. Texas appears in `df national` only for its single unpriced Dallas
candidate; every other state is absent, not "0% covered".

## 5. National organization completeness

**Before DF-0O** the nation-scoped fold `organization/us` recorded nothing about
which runs it read, so a fold over an estate missing runs looked exactly like a
complete one. In this container it folds New York only: Minnesota's and
Wisconsin's run tables were released for disk during DF-0N.

**The guard** (`src/canonical/organization-completeness.ts`, rule
`organization_completeness_1`):

- EXPECTED = the folding run ∪ every run with a contribution file live in a
  property partition ∪ every run the previous fold read;
- AVAILABLE = every run whose committed canonical rows are readable now;
- `FULL_NATIONAL` only when nothing expected is missing **and** the expected
  set is known to be whole; `PARTIAL` with the missing runs named when any is
  missing, recorded in the partition manifest, logged as
  `partition.organization_partial`, and stated in the activation reason;
- `UNVERIFIED` when nothing is missing but the estate already held a fold
  written before the watermark: that fold recorded no runs, so a released run
  that left no partition contribution (a business-registry run, say) cannot
  be ruled out. The status is sticky on that estate until it is rebuilt from a
  fold that started under the watermark.

A `PARTIAL` fold still activates (its links are right for what it saw) but is
never labelled, reported or counted national. A fold written before DF-0O reads
`UNVERIFIED`. `df organizations` reports the recorded verdict and the estate's
verdict now.

**Live estate, 2026-10-16:** recorded `UNVERIFIED` (written by DF-0N);
estate now **`PARTIAL`** — 3 expected runs, 1 readable, missing
`run_2f3677c1…` (Wisconsin) and `run_4f6a6f9b…` (Minnesota); `national: false`.
1,662,170 observations, 831,085 links — New York's alone.

**Remediation path** (not run here: the container has 4.0 GiB free and a
re-ingest of either state needs 15–25 GiB, §7): on a worker that fits, reacquire
`b22bfaad…` (Wisconsin, `REACQUIRABLE`) and `e3d54ee1…` (Minnesota,
`REACQUIRABLE`), re-ingest each forced, and the next fold reads all three runs
and records `FULL_NATIONAL`.

**Performance (P1, documented, not changed).** Every run that names an
organization re-folds the whole nation: `organizationObservations` streams
every run's committed bundles. DF-0N's forced New York re-ingest, with every
property partition skipped as unchanged, still spent ~1,107 s in projection,
nearly all of it this fold over 1,662,170 observations. The fix is an
incremental fold: per-run organization contribution files (like property
partitions) so a fold merges the new run's observations into the prior state
instead of re-reading every bundle. It changes the fold's input contract, so it
is P1 for its own phase rather than a change made under certification.

## 6. Property identity across states

| Pair | Canonical strings reused | Folded keys reused | Property-id collisions |
|---|---:|---:|---:|
| MN ↔ WI | 30,988 | 32,970 | **0** |
| MN ↔ NY | 0 (143 if New York's SBL were used without its SWIS) | 0 | **0** |
| WI ↔ NY | 0 (26 likewise) | 0 | **0** |

11,664,439 identities (MN 2,648,100 · WI 3,513,111 · NY 5,503,228), 0
collisions (`reference/ny-statewide/2025-2605/pid-reuse.json`). Reuse of a raw
string is expected and harmless: every id hashes the 5-digit county FIPS, whose
first two digits are the state. The contract per source — scheme, routing,
leading zeros, punctuation, collision evidence, refusals — is in
`IDENTITY_CONTRACTS` and summarised in
[CANONICAL-NORMALIZATION.md §4c](CANONICAL-NORMALIZATION.md). Pinned ids per
state are asserted in `tests/national-integration.test.ts`.

## 7. Cloud disk and scratch safety

**Preflight** (`src/runtime/capacity.ts`). Before the New York and Wisconsin
pipelines download, rehydrate, derive or write anything — scheduled, forced or
replay — they size the run from a measured per-row `FootprintProfile` and the
witness's row count (a replay sizes from the archive's bytes), measure the var
root's filesystem, where `var/scratch` resolves, whether that is tmpfs, and
free memory, and refuse with `CONFIG insufficient capacity` and the arithmetic.
Same filesystem: durable + scratch must fit. Separate: each its own; tmpfs
scratch must also fit free memory with 2 GiB process headroom. 10% margin.
Nothing moves scratch to tmpfs; the preflight only checks an operator's choice.

| Measured per row | NY (2025-2605) | WI (V12) |
|---|---:|---:|
| derived bundle | 1,066 B | 762 B |
| run tables (gzip) | 1,571 B | 1,310 B |
| partitions | 775 B | 750 B |
| snapshot indexes | 24 B | 24 B (NY's) |
| organization fold | 62 B | 62 B (NY's) |
| scratch peak | 850 B | 850 B (NY's) |
| publisher archive | 103 B | 213 B |

`df capacity` on this worker, 2026-10-16: a full New York run needs 25.12 GiB
and a full Wisconsin run 14.54 GiB; 4.03 GiB is available — **both refused**,
correctly, before any byte would move. (DF-0N's first forced New York re-ingest
ran this disk out in its last stage after ninety minutes; the preflight turns
that into a refusal in the first second.)

**Scratch ownership** (`src/runtime/scratch.ts`). Every run's scratch is claimed
owner-only with `.owner.json` (pid, host, boot id, start, purpose).
`df scratch` lists each directory LIVE / ORPHANED / UNOWNED / UNVERIFIABLE;
`--clean-orphans` removes only ORPHANED — same host and boot, pid gone or
reused by a later process. Unowned (pre-DF-0O) and other-host directories are
reported and left alone. Nothing outside `var/scratch` is touched; `/tmp` is
never swept. Live estate: no scratch directories.

## 8. Restricted-data security

Owner-only at every level since DF-0O: restricted, scratch, snapshot-index and
artifact trees `0700`; restricted files `0600`; retained artifacts `0400`;
restricted `CURRENT` `0600`. Wider legacy modes are tightened on the next
write — including an identical re-put/re-promote and an index activation under
its root. A symbolic link below a private root is refused; a linked root is
never chmod-ed through. `df permissions` treats only `ENOENT` as absent and
reports a linked root unaudited. **Live estate:** `ownerOnly: true`, 0 open
entries over restricted (4 dirs, 2 files), scratch, indexes (193 index files)
and archive (12 dirs, 6 files). Regression tests: new directories, nested
restricted directories, interrupted runs, recovery, replay, restored and
derived artifacts, a fresh worker, a rehydrating worker, the CLI.

## 9. Artifacts: what exists, and where

`df artifacts catalog` on the live worker, mapped to DF-0O's vocabulary
(`EPHEMERAL_ONLY` ≙ EPHEMERAL_RETAINED, `REACQUIRABLE` ≙ REACQUIRABLE_EXACT —
reacquisition counts only on an equal sha256):

| Artifact | Role | State |
|---|---|---|
| WI `b22bfaad…` | publisher raw | REACQUIRABLE (not on this disk) |
| WI `b622edfe…` | derived bundle | REGENERABLE |
| MN `e3d54ee1…` | publisher raw | REACQUIRABLE (not on this disk) |
| MN `24b35d8a…`, `5f9251f9…` | derived bundles | LOST_EXACT_BYTES |
| MN `31a5f1c3…` | publisher raw (DF-0H) | LOST_EXACT_BYTES |
| Hennepin `8ec2d7a7…` | crawl | LOST_EXACT_BYTES |
| NY `7c5b5164…` | publisher raw | EPHEMERAL_ONLY (retained on this container) |
| NY `3969c4a0…` | derived bundle | EPHEMERAL_ONLY |
| NY polygons `ea803fbd…` | raw companion | EPHEMERAL_ONLY |

**DURABLE_REMOTE: none.** No production durable object store is configured;
nothing here is claimed durable. DURABLE OBJECT STORAGE: **DEFERRED**.

## 10. Counts, by what they mean

| | Identities | Basis |
|---|---:|---|
| **Certified** | 11,664,439 | MN 2,648,100 + WI 3,513,111 (DF-0K/DF-0L) + NY 5,503,228 (DF-0N), each proven by NOOP, forced re-ingest and network-off replay when certified |
| **Materialized here** | 193 property partitions + `organization/us`; global digest `5c46d1e3…` (= DF-0N's) | canonical run tables readable for New York only |
| **Durably persisted** | 0 | no durable store (§9) |
| **Production deployed** | 0 | no production DDL; migrations are drafts |

## 11. Proof levels

| Level | MN | WI | NY |
|---|---|---|---|
| 1 unit / fixture | PASS (DF-0O suite) | PASS | PASS |
| 2 discovery / schema | PASS — live bytes hash to `e3d54ee1…`, unchanged | PASS — live tick: same release V12.0.0-2026, NOOP | PASS — live tick: same release 2025-2605, NOOP, 0 legacy-host requests |
| 3 partition / digest | PASS — 59 partitions live, in global digest `5c46d1e3…` | PASS — 72 partitions | PASS — 62 partitions |
| 4 full network-off replay | PASS at certification (DF-0L, prior container); **not re-runnable byte-identically** — its bundle is LOST_EXACT_BYTES | PASS at certification (DF-0K/DF-0L, prior container) | PASS (DF-0N, this container) |

DF-0O ran levels 1–3 itself. It did not re-run level 4 for any state, and does
not present synthetic tests as one.

## 12. Discovery-only checks (2026-10-16)

| Source | Result |
|---|---|
| `ny_statewide_parcels` | release 2025-2605, fingerprint `dc301291…`, 562,761,366 bytes, witness 5,510,061 rows on `nysgeohub.ny.gov` — unchanged; plan NOOP |
| `wi_statewide_parcels` | release V12.0.0-2026, fingerprint `cb681301…`, 759,926,092 bytes, witness 3,574,646 — unchanged; plan NOOP |
| `mn_statewide_parcels` | MnGeo serves no length, ETag or Last-Modified and ignores Range; stream-hashed without storing (09:48Z): 2,610,774,016 bytes, sha256 `e3d54ee1…` — **identical** to the catalogued raw artifact; still REACQUIRABLE exactly; no newer release |
| `mn_hennepin_county_parcels` | service live, 122 fields, count 448,126 (DF-0D crawled 448,087) — the county has changed since; a crawl would be a NEW release, not ingested here |

No newer release was ingested: this phase starts no ingestion.

## 13. Regression matrix

`tests/national-integration.test.ts` (18 tests) plus the existing suites:

- **Git/registry**: unique source and mapping ids; every mapping names a
  source; one derived lifecycle each; manual-only / prohibited / paid / unpriced
  never automated core; lifecycle follows the facts; 59/72/62 baselines; 193
  computed; NOT_SUPPORTED cells; county totals per cell; `df national`; `df
  auto` refuses a blocked source.
- **Identity**: pinned MN/WI/NY ids; same string in three states → three ids;
  WI punctuation preserved; a contract for every id-minting source matching
  the connector's declared scheme; distinct state FIPS.
- **Partitions**: existing `partitions.test.ts` (county isolation, digest
  determinism, order independence, no global atomicity claimed).
- **Organizations**: watermark rule; end to end — a released run makes the next
  fold PARTIAL, names it, logs it, and `df organizations` says not national.
- **Security**: `restricted-permissions.test.ts` (14 tests), `security-pii.test.ts`.
- **Cloud**: capacity sizing and refusal (same fs, separate fs, tmpfs/RAM);
  the New York pipeline refusing before any download; scratch claim, status
  and orphan-only cleanup.
- **Sales / no fake deed**: zero automated-core jurisdictions for sale
  economics, transfer, deed, mortgage, release, lien, foreclosure.
- **Database**: `tests/migration-execution.test.ts` against real PostgreSQL as
  a non-root user: the full chain applied, in order, to two independent fresh
  databases. DF-0O adds no migration, so nothing new was applied.

## 14. What remains

- Organization fold: incremental (P1, §5); a full national fold needs the MN
  and WI runs re-ingested on a worker with the room (§5).
- Durable object storage: deferred; until it exists, every retained artifact is
  as durable as the container holding it.
- Minnesota and Hennepin have no ledger/NOOP pipeline (`df auto` covers New
  York and Wisconsin); their acquisition is automated but each tick is a full
  run. A generic statewide pipeline (DF-0N proposal 2) is the natural home.
