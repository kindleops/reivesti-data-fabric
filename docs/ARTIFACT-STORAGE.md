# Artifact storage

**Invariant: no authoritative source artifact may exist only on ephemeral
execution storage.**

A sha256 in Git proves which bytes existed. It does not keep them. DF-0K left a
760 MB Wisconsin archive on a container's disk and — earlier — Minnesota and
Hennepin artifacts on containers that no longer exist. DF-0L makes the durable
object store, not the machine, the home of evidence.

## 1. Two planes

| Plane | Holds | Lifetime |
|---|---|---|
| **Execution disk** (`DF_VAR`, `DF_ARCHIVE`) | download staging, the *workspace* artifact store, decompression scratch, external sorts, snapshot indexes, derived projections | disposable — a new worker starts empty |
| **Durable store** (`DF_ARTIFACT_*`) | raw publisher bytes, write-once manifests, release records, run receipts | the estate's memory |

## 2. Backends

`src/archive/artifact-backend.ts` defines one interface —
`head`, `putFile`, `putJson`, `getJson`, `stream`, `list` — with shared
`hashObject` / `downloadVerified`. Two implementations:

| Backend | Use | Durable? |
|---|---|---|
| `LOCAL` | tests, development, a mounted persistent volume | **no**, unless the operator sets `DF_ARTIFACT_LOCAL_DURABLE=1` for a directory that really is persistent |
| `S3_COMPATIBLE` | any private S3-protocol bucket: Supabase Storage, AWS S3, R2 … | yes |

The S3 client (`src/archive/s3-backend.ts`) is dependency-free: SigV4 signing,
path-style addressing, every upload multipart in 16 MiB parts read from the
staged file (bounded memory), each part's `x-amz-content-sha256` its real SHA-256
so a part corrupted in flight is rejected by the store. No vendor is named in
domain logic.

**No silent downgrade.** `DF_ARTIFACT_DURABILITY=required` (the default for an
S3 backend) refuses a non-durable backend at configuration time, and a failed
durable commit blocks activation. Generic `AWS_*` variables are deliberately
ignored: sandboxes and CI runners inject placeholders there (this one does), and a
placeholder standing in for the evidence store is exactly the failure to prevent.

## 3. Keys — content only

```
<prefix>/artifacts/sha256/<aa>/<sha256>                 the bytes, exactly
<prefix>/manifests/sha256/<aa>/<sha256>.json            write-once manifest
<prefix>/releases/<sourceId>/<period>/<fingerprint>.json  write-once release record
<prefix>/receipts/<sourceId>/<runId>/<receipt-sha>.json   run receipt
```

`<prefix>` defaults to `reivesti-data-fabric`. No key depends on "latest",
"current", a timestamp or a publisher filename; the filename is manifest
metadata. The digest is always of the **stored bytes as-is** —
`contentEncoding: identity` — and the manifest's `role` says whether those bytes
are the publisher's (`publisher_raw`) or a deterministic derivation
(`derived_bundle`, with `derivedFrom`). Publisher artifacts are never
recompressed: their exact bytes are the evidence.

## 4. Immutability

A key names one byte sequence. Enforced by the application on every write,
whatever the store offers:

- an artifact key that exists with a different size or declared digest →
  `IMMUTABILITY` hard failure; the original stands;
- the LOCAL backend re-hashes the written bytes before the rename;
- manifests and release records are write-once, first-writer-wins (the first
  retrieval is the historical fact); a later disagreement is reported
  (`identical: false`), never overwritten.

## 5. Durability lifecycle

```
STAGING  →  HASH_VERIFIED  →  DURABLE  →  REGISTERED
```

| Phase | Meaning |
|---|---|
| STAGING | bytes on execution disk in the workspace store |
| HASH_VERIFIED | the staged file re-hashed and equal to its content id — or nothing is uploaded |
| DURABLE | uploaded; size checked by HEAD; **re-read end to end and re-hashed** |
| REGISTERED | write-once manifest stored beside it |

Only DURABLE + REGISTERED satisfies replay provenance. An interrupted multipart
upload is aborted — parts are invisible until completion, so a partial object
can never become an artifact. Observed on real data in DF-0L: a 2.5 GB upload
failed at part 102 (the test store ran out of disk), was aborted, and a HEAD
afterwards found no object; the retry succeeded.

## 6. Rehydration

A fresh machine asks for a digest: manifest → streamed GET → workspace staging
(hashing as it goes) → accepted only if the hash equals the requested digest.
Object-store metadata is never trusted alone. The manifest's original retrieval
time and publisher URL are restored, not replaced by the time of the download —
which is what keeps a replay's run id and digests identical.

Formats needing random access (a ZIP's central directory is at its end) are
downloaded to scratch; line-oriented bundles stream.

## 7. Where metadata lives

| Where | What | Why |
|---|---|---|
| Object store | bytes, per-digest manifest, release records, run receipts | what a worker with only credentials needs to find, verify and replay |
| Postgres (migration 0011, draft) | `source_artifacts.artifact_role`, `content_encoding`, `derived_from_sha256`; `artifact_storage_copies` (backend, key, durability state, last verification) | the searchable registry; the object store is never the only index. A `DURABLE` row must carry a verification to its own digest; storage keys may not contain signatures |
| Git | `reference/artifact-catalog.json` (every certified digest, including lost ones), evidence JSON, code | the pinned expectation, small and public-safe |

## 8. Catalog — what exists, including what doesn't

`df artifacts catalog [--verify]` reconciles the Git catalog with the workspace
and the durable store. There is **no production durable store** (DF-0L
production storage is `DEFERRED_INFRA`, see
[`CLOUD-EXECUTION.md`](CLOUD-EXECUTION.md) §0); the DF-0L proof reported
`DURABLE` only against a disposable in-container test store, which no longer
exists. Pinned states as of 2026-09-29:

| Artifact | Bytes | State |
|---|---:|---|
| WI V12 publisher archive `b22bfaad…` | 759,926,092 | **REACQUIRABLE** — retained on the active worker only; certified manifest pinned, so a reacquisition of exact bytes replays to the certified digests |
| WI V12 derived bundle `b622edfe…` | 2,724,190,106 | REGENERABLE (59 s from the raw, byte-identical) |
| MN GeoPackage `e3d54ee1…` (DF-0K baseline input) | 2,610,774,016 | **REACQUIRABLE** — re-downloaded in DF-0L with the same sha256; its DF-0K retrieval instant was never pinned |
| MN derived bundle `24b35d8a…` | 2,526,486,899 | **LOST_EXACT_BYTES** — its last copies were the test store and a workspace copy deleted to free disk; not byte-regenerable (header embeds the unpinned DF-0K instant) |
| MN GeoPackage `31a5f1c3…` (DF-0H) | 2,624,212,992 | **LOST_EXACT_BYTES** — publisher has republished; digest retained |
| MN bundle `5f9251f9…` (DF-0H) | 2,526,658,472 | **LOST_EXACT_BYTES** — only an 8-char prefix was ever recorded |
| Hennepin crawl `8ec2d7a7…` (DF-0D) | 1,108,716,098 | **LOST_EXACT_BYTES** — a live-service crawl is not byte-reproducible |

A re-download with a different digest is a **new release**, never a restoration
(`df artifacts reacquire` reports `DIFFERENT_BYTES`, stores the bytes under
their own digest with that retrieval's own facts, and does not relabel). Exact
bytes restore the pinned `certifiedRetrieval` manifest facts with them; where
none were pinned, the result says it is a new retrieval of the certified bytes.

## 9. What is compressed, what is kept

| Class | Durable? | Compression | GC |
|---|---|---|---|
| publisher raw | **always** | never (exact bytes are the evidence) | **never automatic** — not even when a newer release exists |
| release records, manifests, receipts | always | none (tiny JSON) | never |
| derived replay bundle | when regeneration is non-trivial (MN: needs the original conversion instant) | may be gzip; the manifest says so | policy-driven |
| canonical projections | no — rebuilt by replay | `DF_DERIVED_GZIP=1` on execution disk | disposable |
| scratch, sorts, staging | no | — | deleted automatically |

## 10. Checkpoints

| Checkpoint | Class | Why |
|---|---|---|
| raw archive + manifest + release record | DURABLE_RESUMABLE | the only thing a new worker needs to resume |
| run receipt | DURABLE_RESUMABLE | reconstructs a run that finished just before its machine vanished |
| acquisition ledger, workspace checkpoints, sort spills, snapshot indexes | EPHEMERAL_RESTARTABLE | re-created by replay from the durable raw artifact |

## 11. Cost (infrastructure, not source data)

| | Bytes |
|---|---:|
| authoritative raw (WI + MN) | 3.37 GB |
| derived kept durably (MN bundle) | 2.53 GB |
| total durable today | **5.90 GB** |
| per-release growth, WI (annual) + MN (monthly republish, if every month kept) | ~0.76 GB/yr + ~31 GB/yr |

At typical S3-class pricing (~$0.021–0.023 per GB-month) today's estate is about
**$0.13/month (~$1.60/year)**; keeping every monthly MN republication adds about
$0.70/month by year end. Supabase Pro includes 100 GB of storage. This is
infrastructure cost, not a source-data fee: the zero-cost DATA doctrine is
unaffected.

## 12. Security

- Private bucket; no anonymous read (tested: anonymous GET → 403).
- Least privilege: the worker needs `GetObject`, `PutObject`, `ListBucket`,
  `AbortMultipartUpload` on one bucket — no delete, no bucket administration.
- Credentials only from `DF_ARTIFACT_*` environment variables; never in Git,
  manifests, receipts, logs or errors (tested); no presigned URL is persisted.
- Raw archives contain public-record owner mailing strings. They are evidence,
  not product assets: the bucket is never exposed through the Reivesti frontend.

## 13. Test peer

Contract tests run against LOCAL always and against moto's server in
IAM-enforcing mode when installed (`.s3env/`, or `DF_TEST_MOTO_SERVER`). Known
moto defect: it mis-verifies SigV4 when a signed query string contains an
encoded `/` (boto3 fails identically), so the list test uses a slash-free
prefix; the client encodes `%2F` as AWS specifies.
