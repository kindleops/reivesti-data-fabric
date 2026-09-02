# Off-heap indexing

Dataset-sized state does not live on the JavaScript heap. This document records
what was actually retained, how it was measured, and what the replacement costs.

---

## 1. What was wrong, and what we got wrong about it

DF-0H's network-off replay of the real 2.7-million-row Minnesota statewide
delivery died at row 2,625,000 under `--max-old-space-size=1024`.

The DF-0H post-mortem blamed the identity `Set` and the snapshot index. **That
diagnosis was wrong**, and it was wrong in the way the phase brief warns about:
it was inferred from total heap rather than measured per structure.

Measuring each structure in isolation (`tools/memprofile.ts`, 1,000,000 rows):

| Structure | Heap per row | Heap | External |
|---|---:|---:|---:|
| identity `Set<number>` (DF-0H) | 37 B | 35.3 MB | 0 |
| identity index (DF-0I) | 0 B | 0.1 MB | 61.4 MB |
| `SnapshotIndexBuilder` | 0 B | 0 MB | 22.9 MB |
| `SnapshotIndex` (built, sorted) | 0 B | 0 MB | 23.0 MB |

The identity set was real but modest — about 100 MB at Minnesota's 2.7 million
parcels. The snapshot index was **already off-heap**: it is a `BigUint64Array`,
which V8 accounts as external memory, and it cost approximately zero heap all
along.

The actual cause was in `distributeContributions`. Grouping contributions by
county materialised each county's lines into one array before writing them, and
Hennepin's 447,044 lines are about 110 MB of strings in a single array. Per-stage
sampling made it obvious in a way total heap never had:

| Stage | Heap before fix | Heap after fix |
|---|---:|---:|
| fetch | 39 MB | 41 MB |
| parse | 36 MB | 16 MB |
| normalize | 94 MB | 77 MB |
| **emit** | **215 MB** | **154 MB** |

The fix streams each county group straight into the partition writer instead of
collecting it, holding one line at a time.

> The lesson is the phase brief's, and it earned its place there: **do not infer
> retention from total heap.** Two of the three structures blamed were innocent,
> and the guilty one was in a stage nobody had profiled.

---

## 2. The identity index

`src/runtime/identity-index.ts`. Exact duplicate detection over an arbitrary
number of source records, with no per-row heap.

### Structure

A **segment** is a fixed-size open-addressed hash table plus a key arena:

```
fingerprints  BigUint64Array   8 bytes/slot   first 8 bytes of sha256(identity)
offsets       BigUint64Array   8 bytes/slot   byte offset of the key in the arena
arena         Buffer           2 + len        length-prefixed identity text
```

All three are external memory. A segment is allocated whole and never resized or
copied. When one fills, the next is allocated; membership is "present in any
segment", newest first.

The first segment is sized from the row count the delivery declares — the bundle
header's `sourceReportedCount`, threaded through
`StreamingParseSession.declaredRowCount` — so a source that knows its own size
allocates a right-sized table once instead of doubling into it.

### Exactness

A 64-bit fingerprint is a **filter, not a verdict**. Every fingerprint hit is
confirmed against the full identity string held in the arena, so a collision
produces a confirmed non-match. The count of rejected fingerprint hits is
reported in the run's stats, and a test forces collisions with a deliberately
weak fingerprint function to prove the confirmation path runs.

This matters more than it sounds: a false duplicate silently drops a real parcel.
Approximate structures may assist and may never decide.

### What it costs

Measured at **64 bytes of external memory per distinct identity** for 27-byte
county-scoped parcel keys — 16 bytes of slot, 29 bytes of arena, and the rest
lost to rounding the slot count up to a power of two (a 1,000,000-row table needs
1,428,572 slots and gets 2,097,152). The power of two buys `& mask` instead of a
modulo on every probe.

At 5.5 million rows that is roughly 350 MB of external memory. It is real, it is
reported by `stats().bytesPerIdentity`, and it is not on the heap where the limit
applies.

### What an earlier draft claimed, and why it was replaced

The first version of this file spilled overflow keys to a disk file past a fixed
96 MB budget, and its header claimed that "keeps resident memory flat at any row
count". It did not: membership for spilled keys was answered from a
`Set<string>` held in memory. It was a heap-proportional structure wearing a
disk-backed comment, and at 5.5 million rows it would have put back most of what
the phase removed.

Segments are the honest version. The growth is real, it is off-heap, it is
bounded per allocation, and the stats report it.

---

## 3. The snapshot index

`src/canonical/snapshot-index.ts`. 24 bytes per row in one flat
`BigUint64Array` — key hash, content digest, group digest, all truncated to 64
bits — sorted by key hash for binary search, with a parallel bit set recording
which keys the current snapshot matched.

Two DF-0I changes:

- **Sized from the declared row count.** Growing from the old 1,024-entry
  default by doubling copied the whole array twelve times on the way to 2.7
  million rows.
- **The sort no longer boxes its permutation.** `sortTriples` sorted a
  `Uint32Array` of indices by first copying it into a plain `Array`, which for
  2.7 million rows is roughly 22 MB of boxed numbers on the heap this module
  exists to keep empty. `TypedArray.prototype.sort` takes a comparator; the copy
  was never needed.

### One index per county, not one per nation

Parcel identity is county-scoped — DF-0G established that — so the snapshot index
is too. `snapshotIndexPath(root, sourceId, partitionKey)` puts each county's
index in its own file, and the runtime loads them lazily: a five-county delta
reads five prior indexes and leaves the other fifty-four files untouched.

The connector says which partition a row belongs to, through
`partitionOf(record)` on the parse session; the runtime cannot read a county out
of an opaque identity string. A source whose identity is genuinely nation-scoped
omits it and keeps a single index, because partitioning that would be a claim
about the identity space rather than a decomposition of it.

Smaller working sets and cheap incremental update are the obvious wins. The
important one is a correctness fix:

**A county missing from a delivery is one finding, not a county of absences.**
With a single national index, a statewide file that omitted Dakota would walk
every Dakota key in prior state and emit one "parcel missing" observation per
parcel. At statewide scale that is 40,000 rows asserting something about 40,000
parcels when the only thing actually known is that the delivery did not contain
that county. Absence is now computed per partition and only for partitions the
delivery covered; an uncovered partition is reported once, as
`uncoveredPartitions` on the run and a `stream.partition_uncovered` warning, and
its index is left exactly as it was.

That last part matters on the following run: because the county's index was
never rewritten, a parcel that was merely missing from one delivery compares as
`unchanged` when it returns, rather than being reported as new by an index that
had forgotten it.

### Lifecycle

An index is the memory of what the last **accepted** snapshot contained, so the
next run can say which parcels vanished. Activating one from a quarantined run
would make the following run diff against a snapshot nobody accepted and report a
county's worth of parcels as absent.

```
BUILDING ──build()──▶ COMPLETE ──activateSnapshotIndex()──▶ ACTIVATED
   │                     │
   └──────fail()─────────┴──▶ FAILED ──▶ (never written)
                         └──discard()──▶ DISCARDED
```

`activateSnapshotIndex` refuses anything that is not `COMPLETE`, and a `COMPLETE`
index cannot take more entries. `DISCARDED` is distinct from `FAILED` on purpose:
a discarded index was correct and is simply no longer wanted — a dry run
discards the index it built — while a failed one is not known to be correct at
all.

The ordering in `stream-run.ts` already prevented the bad case; the lifecycle
makes it a rule rather than a property of statement order.

---

## 4. The organization fold, and the merge buffer it exposed

The organization fold is the one projection whose input is **not** partitioned by
county: an LLC does not stop at a county line, so it is nation-scoped by design
(see `docs/DATA-FABRIC-ARCHITECTURE.md` §5h). That makes it the obvious place for
a hidden dataset-sized structure, so it was measured rather than assumed
(`tools/orgprofile.ts`).

Two real problems came out of the measurement.

### A key can be unbounded

`resolveOrganizations` joined entities and observations by normalized name, and
held each key's whole group in memory to form the cross product. A key here is an
organization *name*, and a placeholder name — assessor files have them — can
appear on a hundred thousand parcels. Bounded by a count again, and the count is
the dataset.

Fixed two ways:

- `groupSortedStreaming` yields each group as a stream rather than an array, so
  the observation side is never materialised.
- The entity side is capped at 64 candidates per key. A name shared by more
  registrations than that cannot resolve to one of them under any rule requiring
  statewide uniqueness, so further candidates cannot change the verdict — and
  every decision built from a capped set carries `candidatesTruncated`, so a
  reader cannot mistake a sample for the whole candidate list.

### A fixed per-file read buffer is a linear one

`mergeSortedFiles` opened every run file with `readLines`' default 1 MiB buffer.
The number of run files is `lines / chunkLines`, which grows with the dataset, so
merge memory grew with it too — through a constant that looked like a constant.

One million organization observations through two nested sorts (~80 run files
each):

| | Before | After |
|---|---:|---:|
| peak heap, 1 GB cap | 473 MB | 242 MB |
| retained after | ~0 MB | ~0 MB |
| under a 256 MB cap | out of memory | — |

Almost nothing retained and a 473 MB peak is the signature of buffers, not of a
leak. The merge now shares a 32 MiB budget across its open inputs, with a 64 KiB
floor, and merges in passes above 64 inputs so both memory and file descriptors
stay bounded however large the sort gets.

This is the third time this repository has been caught by a structure that is
"bounded" by a count rather than by bytes — after DF-0F's spill-directory
collision and DF-0H's identity map. It is worth naming as a pattern rather than
fixing a third instance quietly.

## 5. External sorting and scratch

Everything else that scales with the dataset already went to disk:
`externalSort`, `mergeSortedFiles`, `groupSorted`, and the run's contributions
file. DF-0I audited their permissions, because moving state off the heap means
moving it onto disk, and a sort spill holds source rows verbatim — including the
owner names and taxpayer mailing lines the contact plane exists to separate.

| Path | Before | Now |
|---|---|---|
| run scratch directory | 0755 | 0700 |
| sort spill directory (caller-supplied scratch) | 0755 | 0700 |
| sort spill files | 0644 | 0600 |
| `createFileLineWriter` files | 0644 | 0600 by default |
| `writeLinesAtomically` temp files | 0644 | 0600 |
| snapshot index | 0600 | 0600 |
| restricted contact tables | 0600 | 0600 |

`createFileLineWriter` defaults to 0600 rather than taking an option callers
remember to pass. Every file written through it holds either raw source rows or
staged canonical rows; a caller that genuinely wants a readable file says so.

Tests in `tests/security-pii.test.ts` assert the spill directory and its files
mid-sort, while they exist.

---

## 6. The scale ladder

Synthetic deliveries of the real Minnesota statewide schema, streamed end to end
under `--max-old-space-size=1024`, across 59 real county partitions. No real
parcel rows: the point is the shape of the memory curve, and inventing 5.5
million rows is cheaper and safer than copying them.

Reproduce with `sh tools/scale-ladder.sh`.

| rows | peak heap | max RSS | snapshot indexes | scratch + estate on disk | elapsed |
|---:|---:|---:|---:|---:|---:|
| 5,000 | 32 MB | 140 MB | 236 KB | 77 MB | 3 s |
| 50,000 | 54 MB | 205 MB | 1.2 MB | 764 MB | 27 s |
| 500,000 | 105 MB | 347 MB | 11.8 MB | 7.3 GB | 294 s |
| 2,700,000 | 244 MB | 682 MB | 63.5 MB | 40 GB | 1,580 s |
| **5,500,000** | **201 MB** | **575 MB** | 129 MB | 81 GB | 3,566 s |

**5.5 million rows peaked at 201 MB against the 1,024 MB cap — 80% of the limit
unused.** The 2.7-million-row run peaked *higher* than the 5.5-million-row one,
which is the clearest statement available that the curve is not the row count:
the peak is the emit stage's projection fold, and that depends on how the rows
distribute across partitions rather than on how many there are.

Every run reconciled exactly, produced 59 county partitions and reported
`completeness: complete`.

The shape is what matters. **540× the rows costs 7.6× the heap** between the
first and fourth rows, and the growth that remains is in the emit stage's
projection fold rather than in anything retained per row. The failing shape the
phase named — 10× rows for 10× retained heap — is not present.

External memory does grow with the row count, as section 2 said it would: the
identity index at ~64 bytes per distinct identity, the snapshot indexes at
exactly 24. Those are the bytes the design moved off the heap on purpose, and
they are reported rather than hidden.

---

## 6a. The real artifact

The synthetic ladder proves the shape; the retained 2,526,658,472-byte Minnesota
delivery proves it on the data it was built for. Replayed from the archive with
the network off:

| | DF-0H | DF-0I |
|---|---:|---:|
| rows accepted / quarantined | 2,648,100 / 62,101 | **identical** |
| **peak heap** | **967 MB**, and the replay OOM'd at row 2,625,000 | **162 MB** |
| max RSS | — | 614 MB |
| parse + normalize | 1,555 s | 1,400 s |
| project | 831 s | 619 s |
| snapshot indexes | one file | 62 MB across 59 county files |

Row 2,625,000 — the exact row the DF-0H replay died on — went past at 33 MB of
heap.

Ingesting the 448,087-row direct Hennepin artifact into that finished 59-county
estate peaked at 120 MB and rewrote **two** partitions: Hennepin's, and the
nation-scoped organization partition. Fifty-eight counties were untouched.

---

## 7. What is still linear

Honesty about what was fixed and what was not:

- **Heap** is flat in the row count. That is the property the 1 GB limit
  measures and the property the phase required.
- **External memory** is linear at roughly 64 bytes per distinct identity plus 24
  bytes per snapshot row — about 480 MB at 5.5 million rows. Exact duplicate
  detection with full key retention has to keep the keys somewhere.
- **Disk** is linear in the delivery: the archived artifact, the contributions
  file, and sort spills. The artifact is retained deliberately.

A source large enough for the external cost to matter would want the identity
check restructured as a sorted-adjacency pass over the contributions file rather
than an online index. That is a real design, it changes when duplicates are
reported, and it is not needed at national parcel scale.
