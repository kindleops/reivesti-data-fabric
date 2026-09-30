# Streaming ingestion

The Data Fabric must never require `source_dataset_size <= process_memory`.
This document records how that is achieved, what was actually wrong before, and
how to operate a full-county run.

---

## 1. What was wrong

DF-0C ingested 5,000 Hennepin parcels comfortably and projected to roughly 15 GB
of heap for all 448,087. Profiling the real code path found **two** defects, not
one.

### Memory: every stage held the whole dataset

| Stage | What it retained |
|---|---|
| ArcGIS crawl | a `Map` of every feature, then an array copy, then N canonical-JSON strings, then one giant joined string, then one giant `Uint8Array` — four whole-county copies alive together |
| Archive | the complete artifact as a single buffer, hashed in one call |
| Parse | `readFileSync` + `split('\n')` + `map(JSON.parse)` — three more whole-dataset copies |
| Normalize | `allBundles`, `allEvents`, `allContacts` arrays — 6 events per parcel, so 2.7 M objects at county scale |
| Digest | an array of N per-bundle digests, sorted then joined |
| Revision ledger | every prior observation for every source, as a `Map` of strings |
| Resolution | the *entire canonical estate* reloaded from the store on every run |
| Contact plane | every contact observation, forever |

Measured: **17,465 bytes of peak heap per row** at 5,000 rows, and **14,757** at
50,000 — linear, as expected when nothing is released.

### Time: `detectConflicts` was O(n²)

| rows | detectConflicts |
|---|---:|
| 5,000 | 14 ms |
| 50,000 | **206,634 ms** |

For every address shared by more than one parcel, it re-scanned all parcels to
find the ones involved. Shared addresses are not an edge case in a real county —
stacked condominium parcels share them constantly — so the pathological path was
the normal one. Fixed by building the address index in a single pass:
**206,634 ms → 236 ms**.

---

## 2. Design

```
ArcGIS  ──batch──▶  ByteSink  ──▶  staged file (hashed while writing)
                                        │ atomic promote at EOF
                                        ▼
                            data-fabric/…/sha256-<digest>/
                                        │ verify digest, then stream lines
                                        ▼
   line ─▶ parse ─▶ classify ─▶ normalize ─▶ write ─▶ release
                        │                       │
              binary key index          staged generation
                        │                       │
                        ▼                       ▼
                 absence scan          atomic CURRENT swap
                                                │
                          external sort ─▶ resolution projection
```

Nothing between the source and the disk holds more than a bounded window.

### Fetch

The DF-0C strategy is preserved exactly — metadata, count, OBJECTID inventory,
explicit `objectIds` batches, reconciliation — but each batch is written to the
artifact as it arrives.

The **OBJECTID inventory is the one whole-dataset structure that stays resident**,
and that is deliberate: the service offers no cursor, so the id list is how a
snapshot's membership is pinned at one instant. As an `Int32Array` it costs 4
bytes per feature — about **1.8 MB** for Hennepin — which is bounded and
negligible beside the 1.1 GB of attribute data it governs.

Global OBJECTID ordering is preserved without ever sorting the county: each batch
is sorted internally (≤ 2,000 rows) and batches are consumed in ascending order.

### Artifact

A content-addressed key cannot be known until the last byte, so bytes are staged
to a temporary file, hashed incrementally, and promoted with a single atomic
rename. **An interrupted download leaves a staging file and never a valid
artifact.**

Reads verify the digest in a separate pass *before* yielding any line. Hashing
while yielding would only detect corruption after a consumer had acted on the
corrupt rows, which is worse than useless for a provenance system.

### Artifact format

The v2 bundle adds a trailer, because reconciliation facts are not known until
the end:

```
line 1      header    service and layer metadata, schema digest, count before the crawl
lines 2..n  features  one canonical-JSON attribute object, OBJECTID ascending
last line   trailer   retrieved count, missing ids, count after the crawl
```

The reader identifies the trailer with **one line of lookahead**. Reconciliation
evidence therefore sits inside the hashed artifact and cannot be edited
independently of the data it describes. The v1 format DF-0C wrote is still read.

### Digest

An order-independent digest that never holds the dataset: each record's sha256 is
treated as a 256-bit big-endian integer and **added modulo 2^256**. Addition is
commutative, so ingestion order cannot change the result, and unlike XOR it does
not cancel duplicates. Memory is 32 bytes regardless of row count.

This is a multiset checksum for change detection, not a collision-resistant
commitment — an adversary who chooses inputs could construct a collision, which
is not a threat model that applies to a county parcel file.

### Snapshot diff

A fixed-width binary index replaces the `Map` of strings:

```
bytes  0..7   key hash        first 8 bytes of sha256(sourceRecordId)
bytes  8..15  content digest  first 8 bytes of the record's content digest
bytes 16..23  group digest    first 8 bytes of a digest over the field groups
```

**24 bytes per row — 10.7 MB for all of Hennepin**, flat in the number of
canonical rows those parcels produce. Sorted by key hash, so lookup is a binary
search; a parallel bit set marks what the current pass saw, making absence a
single scan at the end.

On truncation: a 64-bit key hash over 448k keys has a birthday collision
probability around 5 × 10⁻⁹. A collision compares a row against the wrong
predecessor's digest, which almost certainly differs, so the row is classified
`changed` — the safe direction. `ENTRY_BYTES` is exported so the width can be
raised if a source ever needs it.

### Resolution projection

Resolution folds every identifier observation for a property, across every source
and run. That is done by **external sort**: bounded chunks are sorted in memory,
spilled to run files, then k-way merged with one line per input held at a time.
Peak memory is one chunk, not the estate.

Order-independence is not merely preserved but strengthened — sorting makes each
fold's input canonical, so the result cannot depend on ingestion order even in
principle.

Two sorted passes: by property id (resolution and per-parcel conflicts), then by
address (the one conflict kind that spans parcels).

### Atomic activation

```
runs/<runId>/<generation>/<table>.ndjson
runs/<runId>/CURRENT            ← names the generation readers should use
```

A commit writes a whole new generation directory, then replaces `CURRENT` with a
single atomic rename. Until that rename readers see the previous generation;
after it they see the new one. **There is no moment at which they see a mix.**

A crash leaves the previous valid estate intact plus an orphaned generation, which
`df sweep` reclaims.

### Backpressure

Every write awaits `drain`. The crawl runs at most `maxConcurrentRequests` in
flight, and out-of-order results wait in a map that can never hold more than
`concurrency` entries. There is no `Promise.all` over every batch anywhere.

---

## 3. Measured results

Synthetic Hennepin-shaped data, same code path, hard heap caps:

| rows | buffered peak | streaming peak | bytes/row | wall clock |
|---:|---:|---:|---:|---:|
| 5,000 | 83 MB | 36 MB | 7,620 | 3.7 s |
| 50,000 | 704 MB | 57 MB *(under a 128 MB cap)* | 1,140 | 37 s |
| 448,087 | — *(projected ~7 GB)* | 170 MB *(under a 512 MB cap)* | **397** | 334 s |

**90× the rows costs 4.7× the heap, and bytes-per-row falls 19×.** The residual
growth is the OBJECTID inventory, the key index and the sort chunk — all bounded
by configuration rather than by dataset size, which is why a 448k run completes
inside a 512 MB cap that a 50k buffered run would not.

Peak-heap sampling counts uncollected garbage, so the hard cap is the honest
gate: the process is *given* less memory than the dataset and finishes anyway.

---

### The real county

Not synthetic — the actual Hennepin service, crawled end to end on 2026-08-31
with `--batch 2000 --concurrency 2 --rate-ms 400`:

| | |
|---|---:|
| Source-reported count | 448,087 |
| Downloaded / parsed / accepted | 448,087 / 448,087 / 448,087 |
| Quarantined / duplicates | 0 / 0 |
| Canonical properties resolved | 448,087 |
| Conflicts (all `address_matches_different_pid`) | 4,354 |
| Canonical events | 2,675,094 |
| Restricted contact observations | 443,595 |
| Artifact | 1,108,716,098 bytes |
| Artifact sha256 | `8ec2d7a7bff176ee90d244febf33c310415873d6c8d2e463ba8a49e0f84f13a5` |
| Normalized digest | `93ac0e66d2cd63229bdffcde27c3b390ecd2d78e3c7743e621c2e15bdac62d95` |
| Canonical digest | `adc7f711718bc467c5bf63851040d528686111c2d3fef3fa22916edea7492c84` |
| Completeness | **complete** — reported count reconciles, and did not move during the crawl |
| Acquire / parse+normalize / project | 101 s / 383 s / 18 s |
| Total | 502 s |
| Peak heap | 221 MB, under a 768 MB cap |

The clearest evidence of boundedness is not the peak but the shape. Heap
readings taken every 50,000 rows through the run:

```
 50,000 →  75 MB     250,000 →  81 MB
100,000 →  75 MB     300,000 →  99 MB
150,000 →  69 MB     350,000 → 111 MB
200,000 →  94 MB     400,000 → 111 MB
```

Flat. Eight times the rows processed, the same working set.

## 4. Checkpoint, resume and failure

Acquisition and canonicalization are separate, and each is independently
restartable:

- **Acquisition** is atomic. It either produces a complete, digest-named artifact
  or nothing. On success it records a checkpoint, so `--resume` skips straight to
  canonicalisation instead of re-fetching 1.1 GB.
  The checkpoint is a **pointer, never a cache**: the artifact it names is
  re-hashed before it is trusted, so a stale one degrades to a normal crawl
  rather than to a wrong answer.
- **Canonicalization** is idempotent on the artifact. The run id is derived from
  the evidence and the code, so re-running writes a new generation of the same
  run and swaps it in atomically. Nothing is duplicated and nothing is lost.

| Failure | Result |
|---|---|
| Crawl interrupted | staging file only; no artifact; previous estate untouched |
| Parse fails mid-county | generation aborted; `CURRENT` still names the old one |
| Process killed | orphaned generation; `df sweep` reclaims it |
| Source changed mid-crawl | run **quarantined**, never marked complete |
| Retained artifact corrupted on disk | run **fails** with `IMMUTABILITY`. Re-acquiring would mean writing over retained evidence; corrupted evidence is an incident for a human, not something ingestion quietly repairs |
| Retained artifact deleted | re-acquired, landing on the same digest |
| Incomplete crawl | run **quarantined** |
| Field set changed | run quarantined **before any record is normalised** |

---

## 5. Operating it

```bash
# Bounded live proof
df stream hennepin_assessor__hennepin --live --period 2026-09 --max 2000

# Full county
df stream hennepin_assessor__hennepin --live --period 2026-09 \
  --batch 2000 --concurrency 2 --rate-ms 400

# Local bundle
df stream hennepin_assessor__hennepin --file ./snapshot.ndjson --period 2026-09

# Replay: reads retained evidence, touches no network
df stream hennepin_assessor__hennepin --artifact <sha256> --period 2026-09

# Resume a failed canonicalisation without re-downloading
df stream hennepin_assessor__hennepin --live --period 2026-09 --resume
df checkpoints    # completed acquisitions available to --resume

df sweep          # reclaim generations a crashed run left behind
df resolutions    # canonical property resolution state
df conflicts      # cross-source disagreements
```

| Dial | Default | Effect |
|---|---:|---|
| `--batch` | 2000 | rows per source query, clamped to the layer's maximum |
| `--concurrency` | 2 | requests in flight; output order is preserved regardless |
| `--rate-ms` | 400 | minimum gap between requests |
| `sortChunkLines` | 50,000 | lines per external-sort chunk; the main memory dial |

**Batch sizes are throughput dials that never change results.** Identical
digests, canonical ids and output at batch size 1 and 5,000 are asserted in
`tests/streaming-pipeline.test.ts`, not assumed.

---

## 6. Security under streaming

Streaming adds temporary files, so it adds places personal data could linger.

- Restricted rows are written to a **separate root** (`var/restricted/`) with mode
  `0600`, per generation, exactly as the buffered store does.
- Artifact staging files are created `0600` and are either promoted or removed;
  a failure removes them.
- The scratch directory holding sort spills and contribution files is deleted in a
  `finally`, on success and on failure alike.
- The contact plane is **bounded** in streaming runs. Counts stay exact — an
  operator metric must never be truncated by a memory setting — while retention is
  capped, because the durable, permission-gated record is the restricted partition
  on disk, not a 448,000-entry `Map`.

A test walks the entire non-restricted tree after a run and asserts no
mailing-only value appears in it.

> One subtlety worth stating: a parcel whose owner is billed at the property
> itself has a mailing address equal to its situs address, and the situs address
> is public property data that canonical output is *supposed* to carry. The test
> therefore matches on values that appear only in the taxpayer block. Flagging
> that coincidence as a leak would train everyone to ignore the test.

---

## 6a. A second streaming source

DF-0E added the Hennepin recorder connector on the same runtime with no changes
to the pipeline. Two small extensions carried it:

- **`extraRows`** on a normalisation result. A connector may emit canonical rows
  beyond the transaction-shaped bundle — instruments, party roles, property
  links, legal descriptions, references, recorded financing — keyed by staged
  table. The runtime persists them verbatim and never interprets them, so a new
  source family costs a key rather than a change to the runtime.
- **`discover()` on a refusal path.** When a connector has no streaming transport
  and no local file, the runtime now asks it to explain itself before failing.
  A source whose terms forbid automation has a far more useful answer than
  "transport unsupported", and the operator should see it.

Everything else — bounded memory, batch invariance, atomic activation, replay,
idempotency — applied unchanged and is asserted for the recorder in
`tests/recorded-instruments.test.ts`.

One DF-0D defect surfaced only once a second source existed: the resolution
projection folds the **entire estate** but was writing its output to a file keyed
by the *current run's* source. With one source that was invisible; with two, the
same estate landed in a different file depending on which source ran last, and
the other file went stale. The output is now estate-wide
(`derived/resolutions/current.ndjson`), and order-independence is asserted across
sources rather than only across runs of one source.

## 6b. A third streaming source, and a latent sort bug

DF-0F added the Minnesota SOS business register. The runtime again needed no
changes, but the source did stress one part of it in a way no earlier source had:
**one external sort feeding another**.

Grouping the register needs a sort by Master ID. Deciding organization links
needs two more — a key-join sort feeding an observation-join sort — and the
organization-link projection also joins entities to their addresses before
counting statewide name collisions. Several sorts are therefore live at once in
one process.

`externalSort` named its spill directory `sort-<pid>-<timestamp>`. Two sorts
started in the same millisecond shared a directory, and both wrote
`run-0.ndjson`, `run-1.ndjson`, … over each other. Every earlier use was
sequential, so it had never fired. It surfaced as a JSON parse error a million
rows into a 300,000-business proof — the honest failure mode, but only because
the proof was run at a scale where chunks actually spill. Fixed with a
process-local counter in the directory name.

Two things are worth taking from that. Spilling only happens above the chunk
threshold, so a bug in the spill path is invisible to any test whose fixture fits
in one chunk — which is why the batch-invariance tests deliberately run at
`chunkLines: 1`. And a scaling proof is not only about memory: it is the only
place where concurrency, file counts and merge behaviour are exercised at all.

### Measured, DF-0F

A synthetic register of 300,000 businesses (1,200,000 CSV rows, 170,436,210
bytes), written **ungrouped** so the sort does real work:

| | |
|---|---|
| heap cap | 768 MB |
| peak heap | 151 MB |
| heap across the crawl | flat, 48–90 MB |
| parse + normalize | 101 s |
| organization-link projection | 28 s |

Batch invariance holds at that scale, not only in fixtures. The same delivery at
`sortChunkLines` 50,000 and 5,000 produced the same run id and the same
normalized digest, `ec2a37c1268bb09bf2a2e7b273dd26962aaa35cbb955ae374fa967f5cdd73016`.

One caveat found while measuring: a smaller sort chunk costs *more* memory here,
not less — 151 MB at 50,000 lines per chunk against **301 MB at 5,000**, because
5,000 produces 240 run files and the k-way merge holds one buffered read stream
per file. The default of 50,000 is the better trade at this shape. It changes
nothing about the output, which is the point of the dial.

## 6c. A fourth streaming source, at 2.7 million rows

DF-0H ingested the Minnesota statewide parcel aggregation — 2,710,201 rows across
59 counties — on the same runtime. Two things it changed, and one it exposed.

**Acquisition became pluggable.** The publisher offers both a FeatureServer and a
bulk GeoPackage. The query path measured 37.6 s per 2,000 rows (14-19 hours for
the whole state); the bulk file took two minutes. Both now emit the same snapshot
bundle, so everything downstream is identical and the choice is purely about how
to be a good citizen of someone else's service.

**A parse failure can quarantine a row instead of a run.** 18,462 of the 2.7
million rows carry no parcel identifier, and some counties publish placeholder
rows with junk identifiers. Failing the state because of them would be absurd, so
connectors may opt into per-row quarantine. It stays loud: a systematic failure
trips a drift reason at 5% of rows, with an absolute floor of 50 so a small
delivery is never called drift on no evidence.

### The defect this exposed, and the fix

Duplicate detection held a `Map<sourceRecordId, firstSeenIndex>` so a repeated
identity could name where it was first read. Bounded by distinct records rather
than by dataset bytes — but *linear in row count*, and at this scale that is not
the same as bounded. Measured on the first attempt:

| rows processed | heap |
|---|---|
| 400,000 | 180 MB |
| 675,000 | 247 MB |
| 1,000,000 | 339 MB |
| 1,175,000 | 402 MB |

Roughly 0.34 MB per thousand rows, on a trajectory to exhaust a 1 GB cap before
the end of the state. The run was stopped rather than allowed to OOM.

The fix was to hold **53-bit fingerprints in a `Set<number>`** instead of strings
and boxed indices: two FNV-1a variants combined, about 16 bytes per row instead
of ~120. The cost is the first-seen index in the duplicate message, which is
worth far less than finishing. At 2.7 million identities the chance of a false
duplicate is roughly one in 2,500, and a false duplicate quarantines a single row
with a stated reason rather than corrupting anything — the right way round for a
cheap guard.

The general lesson is the one DF-0F's spill-directory collision taught in a
different costume: **a structure that is "bounded" by a count rather than by
bytes is only bounded until the count gets large**, and the only way to find out
is to run it at the size it will actually see.

### And the fix was not enough — the honest result

The fingerprint change bought real headroom and did **not** make memory constant.
The full statewide run completed with a peak of **967 MB against a 1,024 MB cap**,
and a subsequent replay of the same artifact under the same cap **ran out of
memory at 2,625,000 of 2,710,201 rows**. Two runs of identical work, one just
inside the limit and one just outside it, which is the signature of a margin that
is too thin to call bounded.

What is still linear in row count:

| structure | cost at 2.7M rows |
|---|---|
| `Set<number>` of identity fingerprints (values exceed SMI range, so each is a heap number) | ~85 MB |
| `SnapshotIndexBuilder`, 24 bytes per row, grown by doubling | ~65 MB, ~130 MB transient |
| allocation churn — roughly 40 short-lived objects per row across parse, normalise and 3 party observations | pressure rather than retention |

So the accurate claim is **not** "memory is independent of dataset size". It is:
memory is independent of dataset *bytes* — a 2.5 GB artifact streams through
without being held — and grows with distinct *record count*, at roughly 350 MB
per million rows on this source. At 2.7 million that needs about 1.5 GB to be
comfortable. At 10 million it would not work at all.

Recorded as the phase's principal limitation. The fix for a future phase is to
move both structures off the heap: the identity set to a disk-backed structure or
a Bloom filter with an external-sort verification pass, and the snapshot index to
a memory-mapped file it is already shaped for.

## 6d. Taking the indexes off the heap (DF-0I)

Section 6c ended with an honest failure: 967 MB against a 1,024 MB cap, and a
replay of the same artifact that ran out of memory at row 2,625,000. It also
ended with a **wrong diagnosis**, which is worth recording because the correction
is the useful part.

### The diagnosis was wrong

6c blamed the identity `Set` and the `SnapshotIndexBuilder`. Measured one
structure at a time at 1,000,000 rows (`tools/memprofile.ts`):

| Structure | Heap per row |
|---|---:|
| identity `Set<number>` | 37 B (~100 MB at 2.7 M) |
| `SnapshotIndexBuilder` | **0 B** — it is a `BigUint64Array`, which V8 accounts as external, not heap |
| `SnapshotIndex`, built and sorted | **0 B** |

The identity set was real but modest. The snapshot index was innocent: it had
been off-heap since the day it was written, and the 6c table's "~65 MB, ~130 MB
transient" was external memory misread as heap.

The actual culprit was `distributeContributions`, which grouped contributions by
county and materialised each county's lines into an array before writing them.
Hennepin's 447,044 lines are about 110 MB of strings in one array. Per-stage
sampling found it in a single run:

| Stage | Heap before | Heap after |
|---|---:|---:|
| fetch | 39 MB | 41 MB |
| parse | 36 MB | 16 MB |
| normalize | 94 MB | 77 MB |
| **emit** | **215 MB** | **154 MB** |

The fix streams each county group straight into the partition writer.

**Do not infer retention from total heap.** Two of the three structures blamed
were innocent, and the guilty one was in a stage nobody had profiled.

### What replaced the identity set

An open-addressed hash table in `BigUint64Array`s with a length-prefixed key
arena in a `Buffer` — all external memory — allocated in fixed-size segments and
sized from the row count the delivery's own header declares. Measured at 0 bytes
of heap per row and about 64 bytes of external memory per distinct identity.

Every fingerprint hit is confirmed against the full key, so a collision reports a
non-match rather than a false duplicate. The 6c fix accepted a one-in-2,500
chance of a false duplicate quarantining a real parcel; that trade is no longer
necessary and no longer made.

An earlier DF-0I draft spilled overflow keys to disk while keeping a
`Set<string>` of them in memory — a heap-proportional structure wearing a
disk-backed comment. It was replaced before it shipped. See
`docs/OFF-HEAP-INDEXING.md`.

### Two more structures bounded by a count

Two further defects surfaced while measuring, both the same shape as the one
6c described and neither in the place anyone was looking:

- **The contact plane's dedup ledger.** `maxRetained` capped the rows kept for
  reading and did not cap the `Set<string>` of observation ids used to keep
  `size()` exact. A 500,000-parcel run put half a million ids on the heap; it was
  the largest remaining row-proportional structure after the identity index moved
  off. The ledger is now the same off-heap index, and counting stays exact.
  Peak heap for the 500,000-row ladder step fell from 157 MB to 96 MB.
- **The external sort's merge buffers.** `mergeSortedFiles` opened every run file
  with a 1 MiB read buffer, and the number of run files grows with the dataset.
  The organization fold — two nested sorts over a million observations — peaked
  at 473 MB of heap with almost nothing retained, and died under a 256 MB cap.
  The merge now shares a 32 MiB budget across its inputs and merges in passes
  above 64 of them.

### Off the heap means onto disk, so the permissions were audited

Sort spills and the run's contributions file hold source rows verbatim,
including owner names and taxpayer mailing lines. The run scratch directory and
caller-supplied sort scratch went from 0755 to 0700, and spill and line-writer
files from 0644 to 0600. `createFileLineWriter` now defaults to 0600 rather than
taking an option callers remember to pass.

## 6f. Inputs from a durable store (DF-0L)

The runtime's input is still a content-addressed artifact in the workspace
store; DF-0L only changes where that artifact can come from. `rehydrate`
streams it from the durable store into the workspace, hashing as it goes, and
restores the original retrieval manifest, so the run id, partition digests and
global digest of a replay on a new machine equal the original's. Formats that
need random access (ZIP) land on scratch first; NDJSON bundles stream. Nothing
in the projection path talks to the object store. Execution checkpoints
(ledger, sort spills, snapshot indexes) are EPHEMERAL_RESTARTABLE — a new worker
rebuilds them from the durable raw artifact. See
[`ARTIFACT-STORAGE.md`](ARTIFACT-STORAGE.md).

## 7. Limits

1. **Absences are recorded by key hash**, not key. The full key lives in the prior
   snapshot's partition. Resolving an absence to a human-readable parcel needs a
   join, which no consumer needs yet.
2. **Changed-field-group reporting is coarse in the streaming path.** The index
   stores one combined group digest, so a changed row reports `['*']` rather than
   `['assessment']`. The buffered path still reports precise groups. Storing
   per-group digests would widen the index by 8 bytes per group per row.
3. **The resolution projection re-folds the whole estate each run.** It is O(n)
   and externally sorted, so it is bounded, but a 448k run spends ~20 s there.
   Incremental merge against the existing sorted resolutions file is the next
   optimisation if that becomes a problem.
4. **One county is proven.** Multi-county estates will re-fold every county's
   contributions on every run; partitioning the projection by county is the
   obvious fix and is not yet needed. **Tracked scaling P1**: partition the
   projection by jurisdiction and source before any multi-county rollout. DF-0E
   added a second source to the same county and did not degrade it materially,
   which is the condition under which this stays deferred.

## 6e. Three refinements for an annual statewide roll (DF-0K)

Wisconsin is the first source that restates a whole state once a year from a
geodatabase whose row ids are positions. Three things the runtime could not
express before, each opt-in and each measured on V12:

**Volatile publisher row ids stay out of change detection.** `ArcGisSessionOptions.contentOf`
lets a source say what change detection digests. Wisconsin's OBJECTID is the
row's position in the geodatabase; drop one parcel and every later OBJECTID
shifts. Digested, it made the synthetic next-release test report 5 revisions for
2 real changes. It is retained on the row and excluded from the digest.

**Reappearance is detected.** The snapshot index remembers only the previous
snapshot, so a parcel dropped from one release and restored in the next looked
brand new. Each county index now has an off-heap tombstone set beside it
(`<county>.absent`: sorted 64-bit key hashes of parcels seen in some accepted
snapshot and missing from the latest). A row absent from the prior index but in
its tombstones is `parcel_reappeared`. Bounded by how many parcels a county has
dropped, never by the county.

**Unchanged partitions are left alone** (`skipUnchangedPartitions`). A statewide
release restates all 72 counties. When every row a county delivered matched the
last accepted snapshot and nothing in it went missing, its contributions are not
redistributed, its projection is not recomputed and its index is not rewritten;
the activation is recorded as `skipped` with its existing generation. The
release's canonical observations are still emitted in full — the county WAS
observed — only the projection is not redone. A forced re-ingest of the same
release therefore rewrites zero county partitions.

**The derived plane can be stored compressed** (`DF_DERIVED_GZIP=1` or
`createGenerationStore(root, { compress: true })`). Canonical bundles repeat
their evidence on every row: Minnesota's 2.65 M bundles were **14 GB**, and two
statewide estates did not fit one session's disk. Run tables are written as
`<table>.ndjson.gz` (gzip level 1) and every reader detects the suffix
(`readLines` decompresses on the fly), so compressed and plain generations can
coexist. Restricted tables keep mode 0600. The whole suite passes in both modes;
a leak scan of a compressed estate must decompress, and the Wisconsin test does.

## 6g. Many files, one release, and a sort that fits the disk (DF-0M)

Florida added three things to the runtime, each general. Two are features, and the third is a
defect the Florida roll exposed at 11 million rows.

**A derived input.** A Florida release is 67 county archives pinned by one release manifest. The
runtime accepts `derived: { artifact, release, lines }`: an artifact the caller has already acquired
and verified (the release manifest), and the snapshot lines a pure, versioned derivation reads out of
the retained county files. The lines are digested as they are pulled (`derivedSha256`) and never
stored. A stored NAL bundle would have been tens of gigabytes of NDJSON that the retained zips
regenerate exactly. A replay names the manifest's sha256 and re-derives under `unshare --net`.

**Canonical retention is a policy.** `canonicalRetention: 'digest_only'` (`--retention digest_only`,
or `DF_CANONICAL_RETENTION`) normalizes, digests, indexes and projects every row exactly as `full`
does. It produces the same normalized digest, contributions and partitions, and it does not write the
bundle, event, contact or extra-row tables. Organization observations are written in every mode, as
the slim table the national organization fold reads.

**The external sort held its input three times over.** The distribution sort reads the run's
scratch contributions, spills sorted runs of 50,000 lines, and merges them. Above 64 runs it merges in
passes. Before DF-0M every spill was plain NDJSON, and no run file was deleted until the whole sort
finished. For the Florida cadastral file (~12 million contribution lines, ~3.7 GB) the peak would have
been the scratch input, all the runs and all the passes at once: ~11 GB, more than a worker's disk. The
first full run was stopped before activation and the sort was fixed:

- spill runs, pass files and the run's scratch contributions are gzip level 1 (still 0600);
- a group of runs merged into a pass is deleted immediately, not when the sort ends.

Output is untouched: the same lines in the same order. The chunk-size identity tests, a new
multi-pass test and a real-data check all show it: the Gadsden + Lafayette three-source estate,
rebuilt with the new code, reproduces its global digest exactly.

Measured on the certified Florida runs (1 GB heap cap; evidence in `reference/fl-statewide/2026/`):

| | Cadastral | NAL | SDF |
|---|---:|---:|---:|
| rows | 10,951,117 | 11,090,242 | 1,726,627 |
| parse + normalize | 32 min 22 s | 105 min 03 s | 5 min 48 s |
| project | 37 min 37 s | 74 min 04 s | 42 min 41 s |
| peak heap | 74 MB | 82 MB | 79 MB |
| peak RSS | 1,044 MB | 2,110 MB | 332 MB |

Disk: the derived plane and indexes grew by 4.60 GB for all three sources; the least free disk observed during the runs was 4.42 GB and a run's scratch peaked at 1.70 GB.
