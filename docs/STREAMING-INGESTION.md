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
   obvious fix and is not yet needed.
