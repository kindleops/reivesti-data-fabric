# Cloud execution

**The execution machine is disposable.** A worker is a clone of this repository,
a Node runtime, and environment configuration. It holds nothing that another
worker cannot rebuild from the durable artifact store
([`ARTIFACT-STORAGE.md`](ARTIFACT-STORAGE.md)) and, where the store has nothing
yet, from the publisher. No step requires any particular laptop, container or
person.

## 0. Status (recorded 2026-09-29)

| DF-0L | Status |
|---|---|
| ARCHITECTURE / IMPLEMENTATION | **PASS** |
| PRODUCTION DURABLE STORE | **DEFERRED_INFRA** — provisioning deferred by the owner; not a blocker for source expansion |
| LOCAL MAC REQUIRED | **NO** |
| CLOUD EXECUTION | **ACTIVE** |

### Standing interim policy (until a production durable store exists)

1. Operate entirely from Claude cloud workers.
2. GitHub is canonical for code, migrations, tests, schemas, docs and small
   aggregate evidence.
3. Nothing is required from anyone's local computer.
4. Nobody downloads source data by hand.
5. A new core source must be $0, official, lawfully automatable, fully
   unattended and reproducible.
6. Source artifacts are retained on the active worker's execution disk while it
   lives.
7. Every publisher artifact's sha256, byte count, release fingerprint, schema
   digest and provenance are pinned in repository-safe metadata
   (`reference/artifact-catalog.json`, `reference/<source>/…`), including the
   certified manifest's retrieval facts (`certifiedRetrieval`).
8. If a worker disappears: reacquire automatically from the official publisher
   (`df artifacts reacquire`); only an exact sha256 match is a restoration, and
   only then is the certified manifest restored with it; different bytes are
   registered as a NEW release; historical byte identity is never fabricated.
9. Completed phase code and aggregate evidence are pushed to GitHub promptly.
10. Production durable object storage (§8) is a later infrastructure task.

Under this policy `DF_ARTIFACT_BACKEND` is unset: acquisition keeps raw bytes in
the workspace store, and no step pretends they are durable.

## 1. What a worker needs

| Need | Source |
|---|---|
| code | `git clone` of this repository at the release commit |
| runtime | Node ≥ 22.18 (type stripping; no build step), `npm ci` |
| scratch disk | `DF_VAR` — ≥ 12 GB for a Wisconsin release with `DF_DERIVED_GZIP=1` |
| durable store | `DF_ARTIFACT_*` environment variables (§3) |
| network | the publisher, when acquiring; the durable store; nothing else |

Nothing else: no mounted home directory, no pre-seeded `var/`, no local database.

## 2. Bootstrap

```sh
git clone https://github.com/kindleops/reivesti-data-fabric && cd reivesti-data-fabric
npm ci
export DF_VAR=/scratch/df DF_DERIVED_GZIP=1        # execution disk
# DF_ARTIFACT_* come from the platform's secret store, never from a file in Git
npm run df:doctor -- --probe                     # exit 0 or stop
node src/cli/df.ts artifacts catalog --verify    # what the estate holds
node src/cli/df.ts auto wi_statewide_parcels__all_wi_counties
```

`df doctor` checks Node, binaries, writable directories, disk, memory, the
Postgres test binaries, the backend configuration and — with `--probe` — a
PUT/HEAD/GET/re-hash round trip with the real credentials. Secrets are reported
as `configured` / `absent`; a value never leaves the process.

## 3. Runtime configuration

| Variable | Meaning | Secret? |
|---|---|---|
| `DF_VAR` | execution scratch root | no |
| `DF_ARCHIVE` | workspace artifact store (default `$DF_VAR/archive`) | no |
| `DF_DERIVED_GZIP` | gzip the derived plane on disk | no |
| `DF_LOG_LEVEL` | `error` … `debug` | no |
| `DF_ARTIFACT_BACKEND` | `s3` or `local` | no |
| `DF_ARTIFACT_DURABILITY` | `required` (default for `s3`) or `optional` | no |
| `DF_ARTIFACT_PREFIX` | key prefix (default `reivesti-data-fabric`) | no |
| `DF_ARTIFACT_S3_ENDPOINT` | S3-protocol endpoint | no |
| `DF_ARTIFACT_S3_REGION` | signing region | no |
| `DF_ARTIFACT_BUCKET` | private bucket | no |
| `DF_ARTIFACT_ACCESS_KEY_ID` | credential | **yes** |
| `DF_ARTIFACT_SECRET_ACCESS_KEY` | credential | **yes** |
| `DF_ARTIFACT_LOCAL_ROOT`, `DF_ARTIFACT_LOCAL_DURABLE` | LOCAL backend on a persistent volume | no |

Generic `AWS_*` variables are ignored on purpose (§ARTIFACT-STORAGE 2).

## 4. The unattended cycle

```
discover → plan (durable release record? ledger?) → download → hash
  → durable upload → re-read verify → register release → derive → project
  → activate → durable run receipt
```

| Situation on a fresh worker | Behaviour | Publisher bytes fetched |
|---|---|---|
| release never seen | full cycle | 1 |
| release registered in the durable store | **rehydrate** from the store, sha-verified, then derive and project (`REHYDRATED_AND_INGESTED`) | 0 |
| same worker, next tick | **NOOP** | 0 |
| durable commit refused (`required`) | run fails **before** any partition is activated | 1 |

## 5. Recovery

| Failure | State left | Next worker |
|---|---|---|
| container lost after acquisition, before projection | raw bytes DURABLE + REGISTERED | finds the release record, rehydrates, projects; no second download (tested: `durable-pipeline.test.ts`) |
| container lost after projection, before anything else | raw DURABLE, run receipt durable | projection is disposable: replay from the durable raw rebuilds identical partitions and digests |
| container lost mid-upload | multipart aborted or never completed → no object | re-uploads; content-addressed, so idempotent |
| store unreachable, `required` | nothing activated | retries next tick |

Execution checkpoints (ledger, sort spills, snapshot indexes) are
EPHEMERAL_RESTARTABLE; only the raw artifact, its manifest, the release record
and the run receipt are DURABLE_RESUMABLE.

## 6. What does and does not go to GitHub

| GitHub | Never GitHub |
|---|---|
| code, migrations (drafts marked as such), tests, docs | raw source artifacts (hundreds of MB – GB) |
| `reference/` aggregate evidence: digests, counts, reports | derived bundles, projections, snapshot indexes |
| `reference/artifact-catalog.json` (digests, sizes, public URLs) | owner names / mailing addresses (restricted plane) |
| CI workflow | object-store credentials, `.env` files, signed URLs |
| | database files, `var/`, `.s3env/` |

`.gitignore` enforces the directory half; the portability test
(`tests/artifact-storage.test.ts`) fails on machine-specific absolute paths in
source; CI (`.github/workflows/ci.yml`) repeats that grep before installing
anything.

## 7. CI

`.github/workflows/ci.yml`, on every push and pull request: portability grep →
Node 22.18 → `npm ci` → moto test peer in `.s3env/` → `df doctor` →
`tsc --noEmit` → `npm test` → the Postgres 17 migration chain twice on a fresh
embedded cluster (the runner is unprivileged; each run prints the schema
fingerprint). CI never
receives production credentials; the S3 contract runs against the disposable
IAM-enforcing peer.

## 8. Provisioning the durable store (operator action — DEFERRED_INFRA)

Deferred by the owner on 2026-09-29; recorded here so it can be done later
without rediscovery. The repository cannot create credentials, and must not
contain them. One-time:

1. Create a **private** bucket (e.g. `data-fabric-artifacts`) in an
   S3-compatible store. On the existing Supabase project this is Storage →
   New bucket, *public off*; S3 access keys are created under Storage →
   S3 Connection. Any S3-protocol store works; nothing in the code names a vendor.
2. Grant the key only object read/write/list on that bucket where the store
   supports scoping.
3. Put the six `DF_ARTIFACT_*` values in the execution environment's secret
   settings — not in chat, not in a file in the repository.
4. On the next worker: `npm run df:doctor -- --probe`, then
   `df artifacts reacquire --sha b22bfaad…` and `--sha e3d54ee1…`: each is
   accepted only if the re-download's sha256 equals the catalogued one, and is
   then committed durable. From then on no worker needs the publisher to replay.

## 9. Cost

Infrastructure, not source data: ~5.9 GB today, ~$0.13/month at S3-class
prices; see [`ARTIFACT-STORAGE.md`](ARTIFACT-STORAGE.md) §11.

## 10. Certified (2026-09-28)

A worker cloned from GitHub, sharing nothing with the previous one (whose
estate was deleted) except durable-store environment variables, ran doctor
(ready), the suite, the PG chain, `artifacts catalog --verify`, pulled MN and WI
by digest, and replayed both inside `unshare --net` — publisher and store both
unreachable. Minnesota: canonical digest `c0cdc535…`, 2,648,100 / 62,101, equal
to DF-0K. Wisconsin: publisher `b22bfaad…` → bundle `b622edfe…`, 3,513,111
accepted / 61,535 quarantined, normalized `3e2ec68b…`, global `5780f1ba…`, same
run id, **132 / 132 partitions identical** in input digest, output digest and
rows. Evidence: `reference/durable/df-0l-fresh-worker.json`.

The first WI attempt failed in 5 s: a replay tried to write the archive and a
receipt to the unreachable store. Replays are now write-free (regression test in
`durable-pipeline.test.ts`).

**Caveat, stated plainly:** the durable store in that proof was a disposable
S3-compatible peer inside the same container. The mechanics are certified; the
estate's survival beyond this container is not, until §8 is done. The container
restarted on 2026-09-29 and that peer died with it, taking the only remaining
copy of the Minnesota bundle `24b35d8a…` (now `LOST_EXACT_BYTES` in the
catalog): its workspace copy had been deleted during the Wisconsin replay to
free disk, on the premise that the test store would outlive the container. That
is the exact failure the invariant names, and why §0 item 7 pins certified
retrieval facts in Git.
