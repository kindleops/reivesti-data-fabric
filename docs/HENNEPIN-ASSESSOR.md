# Hennepin County Parcels — assessor / property connector

Source forensics and connector documentation for `mn_hennepin_assessor`.
All findings were verified against the county's own service metadata on
**2026-08-31**, and confirmed by a bounded live retrieval the same day.

---

## 1. Authority and access

| | |
|---|---|
| Authority | Hennepin County, Minnesota |
| Programme | Hennepin County GIS — County Parcels (`HennepinData/LAND_PROPERTY`) |
| Compiled by | Hennepin County GIS Office, monthly, from Survey Division parcel geometry and Real Estate Services property-tax attributes |
| Service | `https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer` |
| Layer | `1` — County Parcels |
| Open data hub | https://gis-hennepin.hub.arcgis.com/datasets/county-parcels |
| Access type | Public ArcGIS REST API |
| Credentials | **None required** |
| Licence | Public; item access `public`. Furnished "AS IS", no warranty, not suitable for legal, engineering or surveying purposes. No licence agreement, no attribution requirement, no stated restriction on automated access. |
| **Automation status** | **`sanctioned`** — query is the interface the service exists to offer |
| Cadence | Monthly compilation. The service publishes only the current one. |
| Historical depth | **None.** No archive of prior compilations is offered, so depth begins when Reivesti starts snapshotting. |
| Capabilities | `Map, Query, Data` — read-only; no editing capability is exposed |
| Feature count | **448,087** parcels (2026-08-31) |
| `maxRecordCount` | 2,000 |
| Spatial reference | EPSG:26915 (NAD83 / UTM zone 15N) |
| Pagination | `supportsPagination: true`, `supportsOrderBy: true` |

This is materially different from eCRV: **live acquisition is permitted here.**
What the phase brief forbids is bulk ingestion into production, so the connector
takes a `maxFeatures` bound, the crawl is rate-limited, and every committed
fixture is synthetic.

### What is deliberately not used

- The interactive property-search UI is never touched, and no code path can.
- The **MetroGIS Regional Parcel Dataset** (Minnesota Geospatial Commons)
  redistributes the same counties' parcel data, but its terms state the data
  "have commercial value and have been maintained as trade secrets and/or
  non-public information, and are made available subject to licensing and
  copyright restrictions". The county's own open-data service carries no such
  restriction, so that is the one used.

---

## 2. Source record identity

```
county_fips + normalized parcel id     ->  MN-27053-0202824410097
```

`PID` is the county-assigned 13-digit property id, shaped `CC-TTT-RR-QQ-PPPP`.
Normalisation strips punctuation and case, which is exactly what makes the
county's `0202824410097` and eCRV's `02-028-24-41-0097` the same parcel. That
normalisation is defensible because it removes only formatting the county itself
applies inconsistently between systems.

`OBJECTID` is a service-local row id, stable only within one snapshot of one
service. It is retained for provenance and is never an identity.

`PID_TEXT` is a fragment ("significant PID within a quarter/quarter section"),
not a second full identifier.

---

## 3. Field coverage — 122 published fields

`df fields --source hennepin` prints the full decision table.

| Disposition | Count | Meaning |
|---|---:|---|
| `HISTORIZE` | 67 | time-aware observation; never overwritten by a later snapshot |
| `NORMALIZE` | 23 | typed and carried as source-stated parcel attributes |
| `CANONICALIZE` | 18 | first-class field or row on a canonical entity |
| `RESTRICTED` | 5 | personal data; restricted plane only |
| `DERIVE_LATER` | 4 | retained; interpretation deferred rather than guessed |
| `IGNORE_WITH_REASON` | 3 | not carried forward, reason recorded |
| `KEEP_RAW` | 2 | retained verbatim, no further treatment |

`HISTORIZE` dominates because an assessor roll restates every parcel every month.
A value written over its predecessor destroys the only interesting thing about
it — that it changed.

### By family

| Family | Fields |
|---|---|
| **Parcel identity** | `PID`, `PID_TEXT`, `FEATURECODE`, `STATE_CD`, `TORRENS_TYP`, `ABSTR_TORRENS_CD`, `PROPERTY_STATUS_CD`, `PRI_SEC_CODE` |
| **Legal** | `ABBREV_ADDN_NM`, `ADDITION_NO`, `LOT`, `BLOCK`, `METES_BNDS1`–`4`, `MORE_METES_BNDS_IND` |
| **Situs address** | `HOUSE_NO`, `FRAC_HOUSE_NO`, `STREET_NM`, `CONDO_NO`, `MUNIC_NM`, `MUNIC_CD`, `ZIP_CD`, `MULTI_ADDR_IND` |
| **Ownership** | `OWNER_NM`, `TAXPAYER_NM`, `TAXPAYER_NM_1`–`3`, `MAILING_MUNIC_CD/NM`, `OWNER_PCT1`–`4` |
| **Structure** | `BUILD_YR`, `PARCEL_AREA` — **that is all** |
| **Assessment** | `MKT_VAL_TOT`, `TAXABLE_VAL_TOT`, `NET_IMPRV_AMT`, and per-tier `LAND_MV`, `BLDG_MV`, `MACH_MV`, `TOTAL_MV`, `QUAL_IMPR`, `VET_EXCL`, `HMS_EXCL`, `NET_TC`, `NET_TAX`, `PR_TYP_CD/NM`, `HMSTD_CD`, `CONT_IND` (tiers 1–4) |
| **Tax** | `TOT_NET_TAX`, `TOT_SPEC_TAX`, `TAX_TOT`, `NET_TAX_PD`, `TOT_PENALTY_PD`, `EARLIEST_DELQ_YR`, `COMP_JUDG_IND`, `MTG_CO_NBR` |
| **Geography** | `SCHOOL_DIST_NO`, `WATERSHED_NO`, `SEWER_DIST_NO`, `TIF_PROJECT_NO`, `LAT`, `LON`, `Shape` |
| **Sale echo** | `SALE_DATE`, `SALE_PRICE`, `SALE_CODE`, `SALE_CODE_NAME` — all `DERIVE_LATER` |
| **Status flags** | `FORFEIT_LAND_IND`, `CO_OP_IND`, `GR_ACRE_OPEN_SPACE_CD`, `PETITION_REVIEW_IND`, `TAX_ADJ_PEND_IND`, `DIV_PEND_IND`, `DIV_STATUS_DATE` |

### What this source does NOT contain

Proven from the field list, not assumed:

| Absent | Consequence |
|---|---|
| **Assessment year** | There is no year column. Values are *current as of the snapshot*. The year is recorded as `null`, never inferred from the capture date. |
| Living area / finished square feet | Only `PARCEL_AREA` (land) is published. |
| Bedrooms, bathrooms, stories, rooms | Not in this layer. |
| Construction type, quality, condition | Not in this layer. |
| Effective year built | Only `BUILD_YR`. |
| Unit counts | Not in this layer. |
| Neighborhood code | Not in this layer. |
| Discrete owner mailing street | The taxpayer block packs name and address into four fixed lines. |
| Permits | A separate county system; out of scope. |

Anything the interactive property-search UI shows beyond this list is not in the
open-data layer, and DF-0C does not go and get it.

### The taxpayer block

The county defines `TAXPAYER_NM` as **"Taxpayer Name and Mailing Address Line 1"**,
with `TAXPAYER_NM_1`–`_3` as lines 2–4. It is one four-line name-and-address blob,
not four clean fields. The connector therefore:

- treats **line 1 only** as a name, recorded as a source-formatted reading rather
  than a parse;
- routes **lines 2–4 and `MAILING_MUNIC_NM`** to the restricted contact plane as a
  `mailing_address` observation;
- never puts any of it on a canonical party's `address`.

### Sale fields are not transfers

The roll echoes `SALE_DATE`, `SALE_PRICE`, `SALE_CODE`. All four are
`DERIVE_LATER` and **no transfer or sale event is ever derived from them**.
Minnesota eCRV is authoritative for what was conveyed, for how much, and on what
terms; deriving a transfer here would create a second, weaker account of the
same event.

---

## 4. Snapshot semantics

A parcel roll is a state of the world, not a feed of events. Three consequences:

| Change kind | Meaning |
|---|---|
| `new_parcel_observed` | first sighting of this parcel key |
| `unchanged_parcel` | byte-identical to the last sighting |
| `parcel_attributes_changed` | same key, different content — with the field **groups** that moved |
| `parcel_missing_from_latest_source` | earlier snapshots had it, this one does not |
| `parcel_reappeared` | present again after an absence |

Rows are digested per field group (`identity`, `address`, `owner`, `assessment`,
`tax`, `characteristics`, `geography`), so a run reports "12,000 assessment
changes and 40 owner changes" rather than "12,040 rows changed".

**Absence is never deletion.** A parcel missing from the September file is a fact
about the September file. A partial export produces exactly the same signal as a
genuine retirement, and only later snapshots can tell them apart — the October
fixture exercises precisely that. `DIV_PEND_IND` (division pending) is the
county's own hint that a parcel is mid-split and may vanish.

`PROPERTY_STATUS_CD` (`0` current, `3` non-current, `D` in process) is a separate
axis: a parcel can be *present and non-current*, which is not absence.

### Reconciliation

Every snapshot records what the source claimed against what we retrieved:

```
sourceReportedCount   the service's own count for the same WHERE clause
retrievedCount        features actually returned
completeness          complete | partial | unverifiable
```

An incomplete crawl (`missingObjectIds` non-empty) **quarantines the run** rather
than reporting a short county.

---

## 5. Crawl strategy

Offset paging is wrong for a 448k-feature layer: offsets are evaluated against
the live table, so one edit mid-crawl silently shifts every later page. Instead:

1. `GET  /1?f=json` — layer metadata; digest the field set.
2. `POST /1/query returnCountOnly` — the count to reconcile against.
3. `POST /1/query returnIdsOnly` — the complete OBJECTID list, pinning membership.
4. `POST /1/query objectIds=…` in batches of `maxRecordCount` — every batch names
   exactly the rows it wants, so a concurrent edit can make a row *missing*
   (detected and reported) but never silently swap it for a different one.
5. Reconcile ids requested vs features returned vs count reported.

Query calls are **POST**. An `objectIds` batch plus ~120 `outFields` is several
kilobytes; as a GET that overruns proxy URL limits and the service answers `404`
rather than `414`, which is not a self-explanatory failure.

The artifact is deterministic NDJSON — a header line then one canonical-JSON
feature per line, ordered by OBJECTID — so identical source state always produces
identical bytes and therefore one artifact.

---

## 6. Schema drift

Two independent tripwires:

- **Field set digest.** The connector pins a digest of the 122 `name:type:length`
  triples it was written against. Any added, removed or retyped column makes the
  live digest differ and quarantines the run.
- **Unmapped field.** Any attribute returned with no row in the field map
  quarantines the run. There is no default and no catch-all.

The pinned digest was verified against the live service during the DF-0C live
proof: it matched exactly.

---

## 7. eCRV convergence

```
eCRV        county 27 (Hennepin), preliminary PID  02-028-24-41-0097  -> provisional
Hennepin    county 27053, authoritative PID        0202824410097      -> resolved
                                    both normalise to 0202824410097
                                    both compute prop_265548f625d901771894553b1a30b9d0
```

Property resolution is a **fold** over every identifier observation pointing at a
property, not a mutation of any one of them. A fold over a set cannot depend on
insertion order, so:

- **eCRV then assessor** and **assessor then eCRV** produce byte-identical
  resolution records. This is asserted, not assumed.
- The eCRV observation keeps saying `preliminary` / `provisional` **forever**.
  Nothing rewrites the historical filing to pretend it was authoritative.
- The assessor observation says `final` / `resolved`.
- The promotion is recorded on the property, with the authoritative observation
  id, the method, and the instant the authoritative evidence was observed.

`PARCEL_RESOLVED` is emitted by the authoritative source as the promotion signal.

### Conflicts — flagged, never guessed

| Kind | Severity | Behaviour |
|---|---|---|
| exact PID match | — | resolve |
| `address_matches_different_pid` | info | reported; **two PIDs stay two properties** |
| `same_pid_different_address` | warn | reported; nothing picks a winner |
| `duplicate_authoritative_row` | blocking | two authoritative rows for one PID is ambiguous source state |
| `pid_absent_from_authoritative_source` | info | the eCRV PID stays **provisional** |

Duplicate PIDs inside one snapshot quarantine **both** rows: with two
contradictory rows there is no basis for picking one, and emitting either would
be a guess. (The layer documents stacked multi-tax parcels as having *different*
PIDs, so a repeat is not something to deduplicate quietly.)

Parcel splits and combines are handled by not forcing one eternal parcel id: each
PID is its own canonical property, and a split simply produces new ones while the
old one's observations remain.

---

## 8. Ownership semantics

`OWNER_NM` is who the roll shows **today**. When they became the owner, and by
what instrument, is a question this source cannot answer.

- Role is `assessor_owner_of_record`, not `grantee`.
- Event is `ASSESSOR_OWNER_OBSERVED`, and its payload states in words that this
  is an assessor roll observation and not a deed-derived ownership history.
- `assessor_taxpayer` is a separate role: the party the county bills is
  frequently a servicer or agent, not the owner.
- Every party is `unresolved`. The same name on two parcels is two observations.
- `HMSTD_CD` is a tax classification, never read as "somebody lives there".

Recorded-instrument ownership history is DF-0D.

---

## 9. Security

| Field | Handling |
|---|---|
| `OWNER_NM`, `TAXPAYER_NM` (line 1) | canonical party observation, as eCRV buyer/seller names already are |
| `TAXPAYER_NM_1`–`3`, `MAILING_MUNIC_*` | **restricted contact plane only**, `contactType: mailing_address` |
| Raw artifact | private object store; manifest carries `carriesRestrictedContact: true` |

Mailing addresses are recorded with `permittedUse: identity_resolution` — they are
evidence for ownership resolution, and they are not permission to contact anybody.
`anon` and `authenticated` reach neither the plane nor the schema.

No skip tracing, no enrichment, no outbound anything.

---

## 10. Known gaps

1. **No assessment year**, so no assessment-year series can be built from this
   source alone. Snapshot-over-snapshot comparison is the only time axis available.
2. **No historical archive.** Depth starts when Reivesti starts snapshotting.
3. **No interior structure characteristics.** Anything beyond `BUILD_YR` and
   `PARCEL_AREA` needs a different source.
4. **Geometry is not retrieved** (`returnGeometry=false`). `LAT`/`LON` give a
   representative point. Geometry belongs in geospatial storage, and pulling
   polygons would multiply artifact size for no DF-0C consumer.
5. ~~**Full-county ingestion is not proven.**~~ **Closed in DF-0D.** The whole
   county now ingests through the streaming runtime in bounded memory. See
   `STREAMING-INGESTION.md`.
6. **Sale-code semantics unmapped** (`DERIVE_LATER`).
7. **Reissue behaviour unknown**: whether the county ever republishes a month's
   compilation is untested.

---

## 10a. Full-county ingestion (DF-0D)

```bash
df stream hennepin_assessor__hennepin --live --period 2026-09 \
  --batch 2000 --concurrency 2 --rate-ms 400
```

A full crawl is roughly 225 requests at `maxRecordCount` 2,000 and produces a
~1.1 GB artifact. The rate limiter is engaged by default; there is no reason to
make those requests fast.

The run is only reported `complete` when the source's own count reconciles with
what was retrieved **and** that count did not move during the crawl. A layer that
changed underneath a long read is quarantined rather than presented as a
consistent snapshot.

## 10b. Canonical normalization (DF-0I)

Hennepin's layer writes three things down in ways that need interpretation before
they can be compared with any other source. That interpretation lives in this
connector, not in the shared contract, because only someone reading Hennepin's
own layer knows it is needed:

| Column | What it is | Where it is handled |
|---|---|---|
| `STREET_NM` | name, type and directional packed into one space-padded field: `'78TH ST E           '` | `street.ts` → `splitPackedStreet()` |
| `SALE_DATE` | `'YYYYMM'` — a year and a month, with **no day** | declared as `month` precision to `canonicalDate` |
| `PARCEL_AREA` | square feet, two decimals | `canonicalArea(..., 'square_feet')` |
| `TAX_TOT` | dollars and cents, scaled to minor units | `canonicalMoney(..., 'minor_units')` |

`splitPackedStreet` reads from the end — an optional trailing directional, then
an optional street type, and whatever remains is the name — and is deliberately
conservative. A trailing token becomes a directional or a street type only when
it is unambiguously one, and `PARK` is absent from the street-type table because
"Lyndale Park" is a street name. Anything it cannot confidently split stays in
the street name, which still compares correctly against another source that also
failed to split it. Missing an equivalence is recoverable; inventing one is not.

### Measured against the retained artifact, not guessed

Running the splitter over the first 100,000 rows of the retained 447,044-row
artifact recognised a street type in **82.5%** of non-blank values. The trailing
tokens it could not place, most common first:

| Token | Count | Verdict |
|---|---:|---|
| `LA` | 3,067 | the county's abbreviation for Lane — **added** |
| `UNASSIGNED` | 1,967 | part of `ADDRESS UNASSIGNED`; a placeholder, not a street |
| `TR` | 954 | Trail — **added** |
| `CUR` | 382 | Curve — **added** |
| `BROADWAY` | 281 | a street name every time — **left alone** |
| `PENDING` | 138 | placeholder |

Adding `LA`, `TR` and `CUR` took recognition to about 87%. `LA` is safe as a
*trailing* token even though "LA SALLE AVE" exists, because a leading `LA` is
never examined.

`ADDRESS UNASSIGNED` appears 2,420 times in 120,000 rows, always with a null
`HOUSE_NO`, and is now mapped to **absent**. Treated as a street name, every one
of those parcels would share one canonical address key and an overlap audit would
report them as agreeing on their address. They agree on having none.

Three more facts from the same pass, each of which the contract depends on:

| Field | Measured over 100,000 rows |
|---|---|
| `SALE_DATE` as `YYYYMM` | 88,412 — a month, with no day |
| `SALE_DATE` blank | 10,816, as **spaces** rather than null |
| `PARCEL_AREA` fractional square feet | 99,949 of 100,000 |
| `TAX_TOT` a whole number of dollars | 5,122 (5.1%) |

That last figure is the DF-0H tax mystery: the audit measured 5.91% agreement
against MnGeo's integer tax column, and 5.1% of Hennepin parcels have no cents.
Same population, no data-quality problem.

The connector's `normalizationVersion` moved to `mn_hennepin_norm_2` when these
landed, and every row now carries `normalization_contract`. See
`docs/CANONICAL-NORMALIZATION.md`.

## 11. Activating full ingestion

Live access needs no approval — the gate is operational, not legal.

1. Bounded proof against the live service:
   ```
   df run hennepin_assessor__hennepin --live --period 2026-09 --max 2000
   ```
   Confirm `completeness: complete`, `unknownFields: []`, no drift.
2. Replay the retained artifact and confirm the `normalizedDigest` matches.
3. Use `df stream`, not `df run`. The buffered command holds the whole batch in
   memory and will not survive a county; the streaming command completes
   448,087 parcels inside a 512 MB heap.
4. Keep the rate limiter engaged. A full crawl is ~225 requests at
   `maxRecordCount` 2,000; there is no reason to make them fast.
5. Snapshot monthly, matching the county's compilation cadence. Two snapshots in
   one month produce one artifact, because identical bytes dedupe.
