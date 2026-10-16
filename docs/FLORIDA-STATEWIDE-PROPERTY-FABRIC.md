# Florida statewide property fabric (DF-0M)

**Sources:** `fl_statewide_cadastral` · `fl_dor_nal` · `fl_dor_sdf` · **Scope:** all 67 Florida counties ·
**Status:** `active` · **Releases ingested:** the 2026 roll — PAR `e554e8d7cbf3`, NAL `61cefe3bc57c`,
SDF `2e8e986f863d` · **Certified:** 2026-09-30

Florida is the Fabric's third statewide estate and the first built from three sources that describe
the same parcels. The **map** is the county parcel shapefiles the Department of Revenue joins to the
roll. The **roll** is the Name–Address–Legal file. The **sales** are the Sale Data File. Each source was
gated, acquired, derived, ingested, replayed and audited on its own. The Fabric then converges them
on one property per (county, parcel) and one sale per (county, parcel, appraiser sale id), with nothing
merged by name and nothing inferred that a publisher did not state.

| | Cadastral (PAR) | NAL roll | SDF |
|---|---:|---:|---:|
| Publisher files | 69 (67 counties + 2 condo tables) | 67 | 67 |
| Publisher bytes (zipped) | 4,141,216,126 | 824,781,865 | 34,684,277 |
| Rows read (= the .dbf headers' counts; the CSVs state none) | 10,951,117 | 11,090,242 | 1,726,627 |
| Accepted | 10,622,753 | 11,090,242 | 1,726,627 |
| Quarantined | 328,364 | 0 | 0 |
| Partitions activated | 134 | 135 | 134 |
| Wall time (discover → activate) | 70 min 16 s | 179 min 20 s | 48 min 32 s |
| Peak heap (cap 1,024 MB) | 74 MB | 82 MB | 79 MB |

Per-source detail — authority, every column's disposition, refusals — is in
[`FLORIDA-CADASTRAL.md`](FLORIDA-CADASTRAL.md), [`FLORIDA-DOR-NAL.md`](FLORIDA-DOR-NAL.md) and
[`FLORIDA-DOR-SDF.md`](FLORIDA-DOR-SDF.md). This page covers the release, the runs, the convergence and
the verdicts. Evidence (aggregates only) is in `reference/fl-statewide/2026/`.

---

## 1. Sources and gates

All three come from one publisher, the Department of Revenue's Property Tax Oversight program. They
are served from the public PTO Data Portal, a SharePoint document library whose REST listing and files
answer anonymous GETs. No account, cookie, token, session or CAPTCHA is involved, robots.txt restricts
neither path, and the records are Florida public records (ch. 119, F.S.). Registry facts:
`FREE_BULK`, `AUTOMATED_BULK_DOWNLOAD`, `automationStatus: sanctioned`,
`termsStatus: reviewed_permitted`, `licenseStatus: public_domain`, quoted fee $0. From those alone,
`assessActivation` returns **CORE_ELIGIBLE** for each source, with no override. The runtime asks the
gate again before every unattended acquisition, and a `MANUAL_ONLY` source is refused before any
request leaves (test 06).

| Source | Capabilities | Authoritative for parcel identity | Restricted plane |
|---|---|---|---|
| `fl_statewide_cadastral` | parcel | yes — the county's number on its own polygon | none (its owner/mailing columns are the NAL's) |
| `fl_dor_nal` | parcel, assessor, ownership (current), tax | yes — the appraiser's roll | mailing, domicile, care-of |
| `fl_dor_sdf` | sale_observation, sale_economics | no — a sale names a parcel, never defines one | none (names no party) |

Paths considered and **not** used:

| Path | Why not |
|---|---|
| FGIO `Florida_Statewide_Cadastral` FeatureServer | answers `499 Token Required` |
| FGIO parcel centroid layer | anonymous, but still the 2025 roll |
| Prior-year NAL/SDF rolls | "available by request": a manual path; DF-0M ingests the current roll only |
| Portal folders beginning with `~` (staff and request-delivery folders) | never listed, entered or requested — by construction and by test |
| Third-party mirrors | not authority |

## 2. Release model and freshness

A Florida release is one file per county per source, pinned by a **release manifest**: an archived
artifact that records every file's URL, ETag, byte count, Last-Modified, retrieval instant and sha256.
The **release fingerprint** is a digest over every file's URL, ETag, size and Last-Modified. If the same
fingerprint comes back, the run is a NOOP and fetches nothing. If one county re-posts, the fingerprint
changes and only the changed county is recomputed (`skipUnchangedPartitions`). Within the newest
roll year, a county's FINAL file supersedes its PRELIMINARY one. Every observation carries its county's
stage and its county file's Last-Modified, so freshness is per source **and** per county.

| Source | Release manifest sha256 | Fingerprint | Files | Stages | Publisher Last-Modified |
|---|---|---|---:|---|---|
| cadastral | `a087c0358d0e4be4bae125134c89d369467616c92d623086c51221cec9a504f8` | `e554e8d7cbf3…` | 69 | 67 preliminary | 2026-08-07 → 2026-08-07 |
| NAL | `5829348a185813361b9acb9508d21f73c8bebcab89d208f4859500682069db09` | `61cefe3bc57c…` | 67 | 2 final, 65 preliminary | 2026-07-27 → 2026-09-29 |
| SDF | `8545336d2e7ce7eab2f864ae64d039e141994a68acf2f5ad5c31f6a60aa969a3` | `2e8e986f863d…` | 67 | 2 final, 65 preliminary | 2026-07-27 → 2026-09-29 |

The three manifests are committed byte for byte in `reference/fl-statewide/2026/manifests/`. Every
county file is pinned in `reference/artifact-catalog.json` by sha256, bytes, URL and certified
retrieval. A Florida replay is therefore restorable from Git plus the publisher. The rule that applies
(DF-0L policy): the file must come back with the **same sha256** to count as the certified file; bytes
that differ are a new release.

A parcel that leaves a county's roll is `parcel_missing_from_latest_source`, never deleted. One that
comes back is `parcel_reappeared`, never new a second time (test 03b).

## 3. Field inventories

Every column of every source has exactly one disposition, generated into the per-source documents
from the field maps (test: "every column of every Florida source has exactly one disposition").

| Source | Columns | CANONICALIZE | NORMALIZE | KEEP_RAW | HISTORIZE | RESTRICTED | IGNORE_WITH_REASON |
|---|---:|---:|---:|---:|---:|---:|---:|
| NAL (165 preliminary + 2 final-only) | 167 | 23 | 72 | 28 | 6 | 36 | 2 |
| SDF | 23 | 11 | 3 | 8 | 1 | 0 | 0 |
| Cadastral .dbf | 118 | 23 | 0 | 0 | 0 | 20 | 75 |

The cadastral file's 75 ignored columns are the NAL's own roll columns joined onto the polygon: they
are compared with the NAL (§9) and never projected a second time.

## 4. Identity

`(county FIPS, PARCEL_ID)` under **PUNCTUATION_PRESERVING** (trim, upper-case; nothing else). The
scheme was chosen by measuring every candidate fold over all 11,090,242 NAL parcel ids before any was
adopted:

| Transformation | Distinct ids merged inside a county |
|---|---:|
| trim / upper-case / strip whitespace / strip leading zeros | **0** |
| strip separators (`-`, `.`, space) | 1,856 (928 groups; Brevard, Marion) |
| strip all punctuation | 7,584 (3,782 groups) |

A folded key is kept as a **match key** and never becomes identity. Leading zeros are identity
(`0000012345` ≠ `12345`, test 08). Punctuation is identity (`1-1109` ≠ `11-109`, test 09). The county is
identity too: 18,863 normalized parcel ids occur in more than one Florida county, which is 38,077
(county, id) pairs, and each pair is its own property.

Across the whole estate (Florida, Minnesota, Wisconsin; `cross-state-reuse.json`):

| | |
|---|---:|
| resolved properties | 17,251,703 |
| Florida parcel strings in several Florida counties | 18,863 |
| parcel strings present in both FL and MN / FL and WI / MN and WI | 852 / 1,318 / 30,988 |
| **property ids naming more than one (county, parcel)** | **0** |
| **(county, parcel) pairs with more than one property id** | **0** |

Source record ids are `FL-NAL-<fips>-<parcel>`, `FL-PAR-<fips>-<parcel>` and
`FL-SDF-<fips>-<len>.<parcel>-<saleId>`. The last is length-prefixed because both parts may contain
dashes. The SDF never creates a property.

## 5. County routing

`CO_NO`, the Department's county number (11–77), routes every row through the Department's own table
(`src/connectors/fl-dor/counties.ts`) to a FIPS code. It is never FIPS arithmetic, never a city and
never the filename's number: Seminole's 2026 file is labelled 58. A row whose `CO_NO` names another
county than its file is quarantined as `AMBIGUOUS_COUNTY_ROUTING`. Measured on the 2026 releases:
**0** such rows in the NAL, the SDF and the cadastral files. All 67 counties are present in all three
releases (`missingCounties: []`).

## 6. Normalization, briefly

Money is exact `bigint` minor units, never a float. Past 2^53 minor units a value is refused by the
`Money` slot and kept as exact decimal text, never rounded. Null is not zero and blank is not zero.
dBASE numerics cannot be blank, so the cadastral file's 0 in an unstated slot states nothing. A sale
date is a MONTH (`YYYY-MM`); no day is invented. The situs is kept as published; a situs line with no
digit gets no comparison key (placeholders such as a single word on 40,356 Brevard parcels are not
addresses). Details: `CANONICAL-NORMALIZATION.md` §4c.

## 7. The full statewide runs

`df auto <mapping> --retention digest_only` for each source in turn (map → roll → sales), 1 GB heap
cap, into the estate that already held Minnesota's 59 and Wisconsin's 72 county partitions. The
derived lines are read from the retained county files and digested as they stream; nothing derived
is stored. Evidence: `run-report.json`.

| | Cadastral | NAL | SDF |
|---|---:|---:|---:|
| run id | `run_cfe48cdfd3376c811f7f06b6e991c65d` | `run_1c386b372a3ce7ced45b314dabb5b300` | `run_a5ab58981f8e8437ee47036bad015f56` |
| outcome | INGESTED | INGESTED | INGESTED |
| files fetched / reused | 0 / 69 | 0 / 67 | 0 / 67 |
| source-reported rows | 10,951,117 | none published | none published |
| parsed | 10,951,117 | 11,090,242 | 1,726,627 |
| **accepted** | **10,622,753** | **11,090,242** | **1,726,627** |
| quarantined | 328,364 | 0 | 0 |
| reconciliation (accepted + quarantined = parsed = reported) | exact | exact (no publisher count; = derived rows) | exact (no publisher count; = derived rows) |
| completeness | complete | unverifiable | unverifiable |
| new / unchanged / revised | 10,622,753 / 0 / 0 | 11,090,242 / 0 / 0 | 1,726,627 / 0 / 0 |
| partitions planned / activated | 134 / 134 | 135 / 135 | 134 / 134 |
| derived lines | 10,951,119 | 11,090,244 | 1,726,629 |
| derived-lines sha256 | `11966ab5ed709d5f…` | `c81a0f1de4214790…` | `1b2fc77649c2811a…` |
| normalized digest | `65b7475119dc0983…` | `28727c1d278c431d…` | `705b7039a9f57b3d…` |

The cadastral .dbf headers state their record counts, and the run reconciles to them (`complete`). The NAL and SDF
CSVs state none, so their completeness is `unverifiable` by design: the rows derived, parsed and accepted equal
each other and equal the count an independent reader (`tools/fl-audit.ts`) took from the same files.

The quarantines, by reason:

- cadastral: a second polygon of a parcel already read (duplicate identity) 231,025 · an unjoined polygon, CO_NO 0 (unparseable) 97,339 — both exactly the audit's independent counts
- NAL: none
- SDF: none

**Global estate digest after the three runs (MN + WI + FL):** `40d87b18d8d6a0ce4ef617886f3585679148e5c3091e87dcfe34a2718f45d283`
(266 partitions: 59 MN, 72 WI, 67 FL property, 67 FL
transaction, 1 national).

## 8. Properties

11,090,492 Florida properties resolved. States: resolved 11,090,492. Contributing sources:

- fl_dor_nal + fl_statewide_cadastral: 9,248,337
- fl_dor_nal + fl_dor_sdf + fl_statewide_cadastral: 1,374,166
- fl_dor_nal: 421,106
- fl_dor_nal + fl_dor_sdf: 46,633
- fl_statewide_cadastral: 250

Property-level conflicts: `address_matches_different_pid` 56,019 — two parcels sharing a situs, reported and never merged:
an address never resolves identity (test 13).

## 9. Cross-source convergence: the map and the roll

Two authoritative sources naming the same parcel is **convergence**, not a conflict.
`duplicate_authoritative_row` fires only when one source states a parcel twice (test 14). The joined
roll attributes on each polygon were compared with the NAL row for the same (county, parcel) over the
full release (`audit-cross.json`):

| | |
|---|---:|
| polygons joined to a roll record | 10,853,778 |
| NAL parcels with a polygon | 10,622,503 |
| NAL parcels without a polygon (unresolved coverage, not conflicts) | 467,739 |
| joined polygons naming a parcel the NAL does not list | 250 |

Per-field authority, decided from that comparison:

| Field group | Agreement | Decision | Why |
|---|---:|---|---|
| parcel identity (`PARCELNO` / `PARCEL_ID`) | 100% of joined polygons | **COEQUAL** | both are the county's own number; both converge under the same scheme |
| `STATE_PAR_ID` | 100.00% (519 differ) | **COEQUAL** | the Department's own code on both |
| values (`JV`, `AV_*`, `TV_*`, `LND_VAL`) | 99.21–99.61% | **PREFER_NAL** | the map was joined to the PRELIMINARY roll; 83,966 of the 83,986 `JV` differences are in the two counties that have since posted FINAL rolls (Duval 79.3% agreement, Citrus 99.7%), and every preliminary county agrees 100% |
| owner name | 99.86% | **PREFER_NAL** | the roll is where the name originates; the map carries a joined copy |
| situs (`PHY_ADDR1`, city, ZIP) | 100.00% | **PREFER_NAL** | same reason; the map adds nothing |
| land area: `LND_SQFOOT` vs GIS area | — | **SEMANTICALLY_DIFFERENT** | the assessor's land area vs a planimetric area in the file's CRS; never compared as one |
| sale echo (slot 1) | 99.89% | **COEQUAL** | both repeat the SDF; both only SUPPORT the SDF's sale (§10) |
| geometry | — | **PREFER_CADASTRAL** | only the map has it |

Where a value is PREFER_NAL, the map's copy is not projected at all: disagreement is measured,
reported and left in the retained archive.

## 10. Sales: one sale, many statements

`FL_DOR_SALE_OBSERVATION` is the SDF's semantic class. It is **not** a deed, a recorded instrument, a
transfer declaration, an arm's-length finding or a comparable. TRANSACTION_RESOLUTION
(`sale_observation_resolver_1`) folds, per county and property, three kinds of statement:

- **SDF sale rows**, keyed by the appraiser's `SALE_ID_CD`;
- **the roll's echoes** (`FL_DOR_NAL_SALE_ECHO`, up to two per parcel);
- **the map's echoes** (`FL_DOR_PAR_SALE_ECHO`).

An echo with the same month, price and a compatible reference **supports** the sale
(`SUPPORTED_MATCH`) and never becomes a second sale. When a later release re-states a sale, the result
is one sale with two statements, the newest governing (`sale_statement_revised`). Capabilities
claimed: `sale_observation` and `sale_economics` only.

| | |
|---|---:|
| canonical Florida sales | 1,726,769 |
| sale states | `SUPPORTED_MATCH` 1,660,005 · `SALE_OBSERVATION_ONLY` 66,622 · `ECHO_ONLY` 142 |
| contributing sources | fl_dor_nal + fl_dor_sdf + fl_statewide_cadastral 1,592,391 · fl_dor_nal + fl_dor_sdf 67,094 · fl_dor_sdf 66,622 · fl_dor_sdf + fl_statewide_cadastral 520 · fl_statewide_cadastral 142 |
| qualification (the appraiser's decision) | DISQUALIFIED 877,177 · QUALIFIED 826,927 · PENDING 22,645 · UNKNOWN 20 |
| price (SALE_PRICE_DOC_STAMP_DERIVED) | POSITIVE 1,599,357 · ZERO 127,410 · ABSENT:BLANK_SOURCE 2 |
| multi-parcel sales / groups | 260,819 / 49,014 |
| sales re-stated with different content | 0 |
| sales with a discrepant echo | 3 |
| sale-level conflicts | `echo_ambiguous` 408 · `echo_price_differs` 3 |

The price is the publisher's derivation from the documentary stamp tax. It is stored as a
`transfer_considerations` row of kind `SALE_PRICE_DOC_STAMP_DERIVED`, exact minor units, and never
as `totalConsideration`. A zero price is a stated zero; a blank price is absent with its reason. A
qualified sale is the appraiser's ratio-study decision, and nothing here says it is a comparable.

## 11. Partitions and cross-state isolation

67 Florida property partitions and 67 Florida transaction (sale)
partitions, one per county. Transaction partitions are planned only for counties with sale
contributions, and every Florida county has them. Every Minnesota and Wisconsin partition manifest was
captured before the Florida runs and after them (`isolation.json`):

| | before → after |
|---|---|
| Minnesota county partitions identical (digests, generation, run id) | **59 / 59** |
| Wisconsin county partitions identical (digests, generation, run id) | **72 / 72** |
| `organization/us` | recomputed — the one national partition, by design |

The Minnesota and Wisconsin baselines in this estate were rebuilt from retained evidence before
Florida arrived (`baseline.json`). Wisconsin's 72 partitions reproduce DF-0K's recorded input and
output digests exactly. Minnesota's 59 reproduce DF-0K's row counts exactly (59/59), but their
digests are a new retrieval of the same GeoPackage bytes. The DF-0K retrieval instant was never pinned
(see the catalog). This time it is pinned.

## 12. Restricted data and the leakage audit

The NAL's owner mailing block and state of domicile go to the restricted contact plane
(`mailing_address`, `contact_note`), and its fiduciary block goes there as `care_of_block`. The
owner-personal exemptions, homestead applicant status and homestead-portability block reach no plane.
The cadastral file's copies of the same columns reach no plane: they are the NAL's, projected once.
The SDF names no party.

The statewide run audited every NAL row two ways (`leakage-audit.json`):

| | |
|---|---:|
| rows inspected | 11,090,242 |
| restricted text values searched for in their row's canonical bundle | 23,389,133 |
| found in the bundle, stated by no single public column (stage one) | 109,314 |
| …of which public data put there (the row re-normalized without any restricted field still contains it: a situs composed of two public lines, a city that is also a word of the bundle's vocabulary) | 109,314 |
| **value leaks** (present in the bundle, absent from the public-only bundle) | **0** |
| rows re-normalized with every restricted field replaced by a sentinel (every 10th row) | 1,108,993 |
| **sentinel leaks** | **0** |
| restricted contacts routed to the plane | `mailing_address` 11,076,962 · `contact_note` 5,614,573 |

The committed evidence holds aggregates only: no owner, no address, no parcel-level example. The
test suite checks this (test 59).

## 13. Replay, idempotency and order

| Property | Result | Evidence |
|---|---|---|
| **network-off rebuild**: a copy of the estate as it stood before Florida (Minnesota and Wisconsin partitions and the raw archive hardlinked; every Florida output on tmpfs), each source replayed from its release manifest's sha256 under `unshare --net` | 134 / 134 Florida partitions identical; all 266 / 266 estate partitions identical; global digest identical; run ids, normalized digests and derived-lines sha256 identical | `replay-network-off.json` |
| **same release rediscovered** (network on) | every source NOOP_SAME_RELEASE, no file fetched | `idempotency.json` |
| **forced re-ingest of the same release in place**, network off | 23,439,622 rows unchanged, 0 new, 0 revised; 201 county partition recomputations skipped as unchanged; 266 / 266 partitions with identical digests; partitions given a new generation: `organization/us`; global digest unchanged | `idempotency.json` |
| **ingest order**: map→roll→sales, roll→sales→map, sales→map→roll (Gadsden + Lafayette, real 2026 files) | byte-identical partitions and global digest in all three orders | `order-invariance.json` |

Run ids are deterministic functions of the source, mapping, release, release-manifest sha256 and code
versions. A replay therefore reproduces the original run's id, and a conflict's provenance comes from
the newest evidence it involves, not from the run that happened to recompute its partition.

## 14. Quality (aggregate)

From the full-release audits (`quality-summary.json`, `audit-*.json`):

- **NAL**: 11,090,242 rows; PARCEL_ID blank or duplicate **0**; ASCII throughout; no negative,
  fractional or non-numeric money; statewide completeness JV 100%, LND_SQFOOT 87.4%, ACT_YR_BLT 79.9%,
  OWN_NAME 99.99%, PHY_ADDR1 96.1%. Rows per county range from 6,012 (Liberty) to 938,308
  (Miami-Dade). 65 counties PRELIMINARY, 2 FINAL (Citrus, Duval).
- **SDF**: 1,726,627 rows; every (parcel, SALE_ID_CD) pair unique; 100% linked to a same-county
  NAL parcel; sale years 2025: 1,221,543 · 2026: 505,082 · blank: 2; 19 rows dated after the
  retrieval month (kept, flagged); zero prices 127,410 (0%–39.4% by county); recording reference by
  book/page 1,207,494, clerk number 517,298, neither 1,835.
- **Cadastral**: 10,951,117 records; joined 99.11% (by county 94.81%–99.87%); situs 96.31% (by
  county 49.98%–100%); land area 89.98% (43.52%–100%); geometry and centroid on every joined
  record; 0 null shapes; 243 unclosed rings and 179 zero-area polygons counted.

## 15. Memory, disk and performance

| | Cadastral | NAL | SDF |
|---|---:|---:|---:|
| parse + normalize | 32 min 22 s | 105 min 03 s | 5 min 48 s |
| project | 37 min 37 s | 74 min 04 s | 42 min 41 s |
| end-to-end rows/s | 2,598 | 1,031 | 593 |
| peak heap | 74 MB | 82 MB | 79 MB |
| peak RSS | 1,044 MB | 2,110 MB | 332 MB |

The JavaScript heap is bounded by the sort chunk and the largest single county group, not by rows: 74–82 MB
at 11 million rows, under a 1,024 MB cap, and a synthetic 60,000-row NAL county runs under a 96 MB cap (test
34). Resident memory is larger, and honestly so: the snapshot index each run builds for the next one is held
off-heap for every county until the run ends, at 24 bytes per row (≈ 266 MB at 11.09 million rows) plus the
growth slack and superseded buffers awaiting collection — RSS peaked at 2.1 GB on the NAL, whose CSVs declare no
row count to size the builders from. Off-heap memory is therefore row-linear at a small constant; flushing each
county's index as the county completes would bound it by the largest county (carried). The NAL's and the
SDF's projection times are the cost of arriving second and third: each recomputes every Florida partition, now
folding more sources. `digest_only` retention is
what made the NAL fit a worker's disk. Its canonical rows are about 1 KB each even compressed: over
11 GB of canonical tables for one source under full retention. `digest_only` computes the
same normalized digest, contributions and partitions and does not write the bundle, event, contact or
extra-row tables. Disk: the derived plane and indexes grew by 4.60 GB for all three sources; the least free disk observed during the runs was 4.42 GB and a run's scratch peaked at 1.70 GB.

## 16. Coverage

| | DF-0K | DF-0M |
|---|---:|---:|
| Florida automated-core parcel jurisdictions | 0 | **67** |
| **Total automated-core parcel jurisdictions (MN 59 + WI 72 + FL 67)** | 131 | **198** |
| Florida sale-observation jurisdictions | 0 | **67** |
| National transfer / deed / mortgage coverage | 0 | **0** |

Derived by `buildCoverage` from the registry and asserted by tests. `sale_observation` and
`sale_economics` are not `transfer`: Florida's recorded instruments live with 67 county clerks, and
none is claimed.

## 17. Postgres

`db/migrations/0012_data_fabric_sale_observations.sql` is a **draft, applied to no production
database**. It widens three CHECK lists: `SALE_PRICE_DOC_STAMP_DERIVED`, the qualification
classifications the Department's wording supports, and the `mailing_address` and `care_of_block`
contact types. It adds `sale_observations` and `sale_resolutions`, with RLS forced and the anon and
authenticated roles denied on every table. The full chain 0001–0012 was applied twice to a scratch
PostgreSQL 17 by the migration-execution test: 60 / 60 tests passed on each of two runs; 57 tables with RLS enabled and forced; 114 restrictive deny policies (anon, authenticated); a second independent database built in each run has an identical schema signature.

## 18. Not claimed, carried, next

- **Not claimed**: deed, recorded instrument, mortgage, lien, foreclosure notice, transfer; any party
  to a sale; any sale day; arm's-length or comparable status; canonical polygons (geometry is
  summarised and kept in the archive); the condominium unit tables (retained, not interpreted);
  prior-year rolls (by request only, a manual path).
- **Carried**: the national organization partition recomputes on every run (P1). Owner names are
  party observations, never merged across parcels by name. Production durable object storage remains
  deferred infrastructure: the release files live on the active worker and are reacquirable only by
  an equal sha256. The next-run snapshot index builders are held off-heap for every county until a run
  ends (24 bytes per row live); flushing each county's index as the county completes is the follow-up.
- **Reported to the Department**: nothing. The confidential file in a `~` staff folder
  (`NAL_CONF_2026P_to_analysts.txt`) was never requested. The portal asks that an inadvertent
  confidential release be reported to the Department; none occurred.
