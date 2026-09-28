# Wisconsin Statewide Parcel Map

**Source id:** `wi_statewide_parcels` · **Adapter:** `wi_statewide_parcels` ·
**Mapping:** `wi_statewide_parcels__all_wi_counties` · **Status:** `active` ·
**Release ingested:** `V12.0.0-2026`

Reivesti's second statewide parcel estate, and the first source whose
acquisition is a program from end to end: **one source, 72 county partitions,
3,574,646 publisher rows**, discovered, downloaded, hashed, retained, derived,
ingested and replayed with nobody present.

It is a parcel roll. It is **not** a transfer source and carries no sale field of
any kind. Wisconsin transfer coverage remains a gap (see `WISCONSIN-RETR.md`).

---

## 1. Authority, access, terms — re-verified 2026-09-28

| | |
|---|---|
| Authority | Wisconsin State Cartographer's Office (SCO), administered by the Wisconsin Land Information Program at the Department of Administration |
| Dataset | Wisconsin Statewide Parcel Map, Version 12 (`V1200_WisconsinParcels_2026`) — "the final deliverable for the Version 12 Statewide Parcel Map Database Project" |
| Landing page | `https://www.sco.wisc.edu/parcels/data/` — links every annual archive, V1 (2015) through V12 (2026) |
| Bulk archive | `https://web.s3.wisc.edu/parcels/v12_parcels/V12.0.0_Wisconsin_Parcels_2026_10.3_Uncompressed.zip` |
| Archive | 759,926,092 bytes, `application/zip`, `Accept-Ranges: bytes` (a range request returned 206), ETag `"eb1985c678037a0288beda1e02a1ef79-73"`, Last-Modified 2026-06-30 21:11:02 GMT, S3 version `0000019f-1a5f-05d1-f2b8-14a30909537e` |
| Format | Esri File Geodatabase 10.3, uncompressed, zipped; parcel table `a0000000c` (1,627,037,029 bytes inflated) + offset index (17,873,952 bytes) |
| FeatureServer | `services3.arcgis.com/n6uYoouQZW75n5WI/…/Wisconsin_Statewide_Parcels_DB/FeatureServer/0` |
| Service facts | `capabilities: Query`, layer `maxRecordCount` 2000 (service-level 1000), `supportsPagination` and `supportsOrderBy` true, `objectIdField: OBJECTID`, `esriGeometryPolygon`, 47 fields, `count` **3,574,646** |
| Service dates | `lastEditDate` = `dataLastEditDate` 2026-06-30T21:21:29Z; `schemaLastEditDate` 2026-06-18T23:13:58Z |
| Cost | **$0.** "This data is provided free of charge". `FREE_BULK` |
| Terms | A feedback form is *requested*, not required; a no-warranty disclaimer ("No warranty, expressed or implied, is made regarding accuracy, completeness, or legality"). No licence restriction. `open_with_attribution` |
| robots.txt | `www.sco.wisc.edu` disallows only `/wp-admin/` and `/wp-login.php`; `web.s3.wisc.edu` serves none |
| Credentials / session / CAPTCHA | **None** on either path. Every request above was anonymous |
| Next release | "V13 is tentatively scheduled for June 30, 2027" — annual cadence |

**Core eligibility.** `assessActivation` returns `CORE_ELIGIBLE`, gate `none`, from
the registry facts alone: `FREE_BULK`, `automationStatus: sanctioned`,
`acquisitionClass: AUTOMATED_BULK_DOWNLOAD`, `termsStatus: reviewed_permitted`.
No override.

No core-access fact changed since DF-0J.1A: the count is exactly the 3,574,646
recorded then, and access is still anonymous.

---

## 2. Two sanctioned paths, benchmarked

| Path | Measured 2026-09-28 |
|---|---|
| **Bulk archive** | **759,926,092 bytes in 12.7 s**, one request |
| FeatureServer, `resultOffset` paging, 2,000 rows/page | **1.23 s** at offset 0; **28.9 s** at offset 1,000,000 |
| → full crawl | 1,788 pages, cost growing with depth: many hours of load on a public service |

| | Bulk archive | FeatureServer crawl |
|---|---|---|
| Snapshot semantics | one coherent published release, named and versioned | a live table that could change between page 1 and page 1,788 |
| Publisher byte preservation | exact bytes, hashed and retained | JSON re-serialisation of a query |
| Pagination risk | none | offset paging over 3.5 M rows, degrading |
| Schema fidelity | the geodatabase itself: field types, lengths, geometry, SRS | hosted-layer view (adds `SITEADRESS_STAND`, `Shape__*`) |
| Geometry | retained in the archive | would have to be requested |
| Reproducibility / resume | the archive IS the replay input | re-crawl |
| Bandwidth | 760 MB once | >2 GB of JSON without geometry |

**The archive is primary.** The FeatureServer is the **witness**: its layer name,
count, schema and edit dates are checked against every archive, and it is never
crawled. There is exactly one canonical ingestion per release.

---

## 3. Release identity and automated discovery

A release is identified by what the publisher serves, never by "latest":

| | V12 value |
|---|---|
| Version (from the archive filename) | `V12.0.0`, year 2026 → reference period **`V12.0.0-2026`** |
| Layer name (service), must agree | `V1200_WisconsinParcels_2026` ✔ |
| Release fingerprint (URL, ETag, length, Last-Modified, S3 version) | `cb6813016f6ed8e0e5c163b7fefd27b0dfbbd02931c32120e20a6bf34e532676` |
| Archive sha256 | `b22bfaad251676f7fad76b57649060dd5d2280c4b5c3efa4bb82d8c35957e7df` |
| Geodatabase field-set digest (pinned) | `924538d03c25e57817d3f88611f3997ad0963093ad7a25794f1d552db0e6ffa4` |
| Service field-set digest | `9da67281d552631b75e7c05284c6e0d78848334473d310e26f07aa396c9bb5cb` |

Discovery reads the landing page, takes the highest `V*_Uncompressed.zip` it
links (the "Compressed" archive is Esri CDF, the same release in a different
on-disk format), HEADs it and reads the service's metadata and count: three GETs
and a HEAD, no download. A new version (V13) is detected and planned with
`schemaValidationRequired`; it is ingested only if the pinned field-set digest
still matches — a changed schema quarantines the run before a row is read.

---

## 4. Schema: every field, classified

46 attribute columns in the geodatabase (plus the `Shape` geometry column), all
classified in `src/connectors/wi-statewide-parcels/field-map.ts`:

| Disposition | Count |
|---|---:|
| `CANONICALIZE` | 15 |
| `NORMALIZE` | 20 |
| `KEEP_RAW` | 7 |
| `HISTORIZE` | 1 |
| `RESTRICTED` | 1 |
| `IGNORE_WITH_REASON` | 2 |

| Group | Fields |
|---|---|
| Parcel | `PARCELID` (identity), `TAXPARCELID` (27.8%, always ≠ PARCELID), `STATEID` (SCO-composed, KEEP_RAW), `OBJECTID` (row position) |
| Situs | `SITEADRESS`, `ADDNUMPREFIX`, `ADDNUM`, `ADDNUMSUFFIX`, `PREFIX`, `STREETNAME`, `STREETTYPE`, `SUFFIX`, `LANDMARKNAME`, `UNITTYPE`, `UNITID`, `ZIPCODE`, `ZIP4`, `STATE` |
| Municipality | `PLACENAME` ("TOWN OF / CITY OF / VILLAGE OF …") |
| Ownership | `OWNERNME1`, `OWNERNME2`; **`PSTLADRESS` → restricted plane**. No taxpayer field exists |
| Assessment | `CNTASSDVALUE` (assessed), `LNDVALUE`, `IMPVALUE`, `MFLVALUE` (managed forest), `ESTFMKVALUE` (estimated fair market), `PROPCLASS`, `AUXCLASS` |
| Tax | `NETPRPTA` (net), `GRSPRPTA` (gross), `TAXROLLYEAR` |
| Area | `DEEDACRES` (canonical), `ASSDACRES`, `GISACRES` |
| Geography | `CONAME` (routing), `PARCELFIPS` (submitter), `PARCELSRC`, `SCHOOLDIST`, `SCHOOLDISTNO`, `LATITUDE`, `LONGITUDE` |
| Provenance | `LOADDATE` (per-county freshness), `PARCELDATE` (21%, a dozen textual shapes, kept raw) |
| Geometry | `Shape` POLYGON ZM, NAD83(HARN) Wisconsin TM; `Shape_Length`, `Shape_Area` ignored |

**Not in this schema at all:** year built, finished area, dwelling type, units,
bedrooms, homestead, **sale date, sale price**. Only fields actually present are
claimed. There is no sale-echo field, so no `ASSESSOR_REPORTED_SALE_OBSERVATION`
is emitted — unlike Minnesota's layer.

**Service vs archive.** The FeatureServer has `SITEADRESS_STAND`,
`Shape__Area`, `Shape__Length`; the archive has `Shape`, `Shape_Length`,
`Shape_Area`. The 44 source attributes are identical. The cross-check reports
the difference by name rather than calling it drift.

---

## 5. Geometry policy

The layer is 3.57 M polygons with Z and M, in NAD83(HARN) Wisconsin TM. They
are **retained, byte for byte, inside the publisher archive** — not thrown away —
and **not decoded into canonical rows**: Reivesti has no canonical geometry
model and no consumer. The reader locates and skips each geometry blob and
counts rows without one (2 in V12). The source's own centroid
`LATITUDE`/`LONGITUDE` (99.77% populated, all inside Wisconsin) are ingested as
`coordinate_kind: source_centroid`.

---

## 6. Parcel identity

`propertyId = deterministicId('prop','county_parcel', countyFips, normalizedParcel)` —
unchanged. What is Wisconsin-shaped is what `normalizedParcel` may fold.

### Punctuation is identity here

Measured over all rows: folding punctuation (Minnesota's rule) merges **11,411
pairs of distinct PARCELIDs inside one county** (22,972 rows) — e.g. Brown
County `1-1109` vs `11-109`. Case folding merges **0**. So Wisconsin uses the
contract extension `parcel_identifier_scheme_1`, scheme
`PUNCTUATION_PRESERVING` (trim + upper-case, nothing else). See
`CANONICAL-NORMALIZATION.md` §4b. Minnesota's ids are untouched.

Identifier forensics:

| | |
|---|---|
| characters besides A–Z/0–9 | `-` 2.18 M, space 652 k, `.` 236 k, `&` 3.6 k, `/` 3.4 k, `:` 2.7 k, `#`, `*`, `'`, `(`, `)`, `_` |
| leading zero | 1,501,336 rows — preserved; nothing is converted to a number |
| max length | 41 |
| shapes | digits only 1.95 M; `9-9-9` 429 k; letter+digits 189 k; `9 9` 91 k; `9-9.9` 80 k; … |
| no PARCELID | 1 row |
| **feature labels, no digit** | **58,201 rows, 1,146 distinct**: ROW 23,169 · GAP 6,140 · OVERLAP 2,343 · TRIBAL 2,257 · ROAD 2,076 · NO PIN - ROW 1,887 · HYDRO 1,844 · NO ID IN TAX ROLL 1,716 · WATER · RIGHT OF WAY · NEEDS PID · lake and river names … |
| (county, PARCELID) keys repeated | 3,461 keys / 60,037 extra rows — dominated by the labels above |
| raw PIDs reused across WI counties | 146,502 strings |

Feature labels are right-of-way strips, water, topology gaps and overlaps that
county GIS carries as polygons. They are **quarantined as non-parcel features**,
not admitted as a canonical property called "ROW" in every county.

`TAXPARCELID` is kept as a secondary `source_property_key` observation on the same
property — never a join key. `STATEID` and `OBJECTID` are retained, never identity.

---

## 7. County routing

Two county fields, and they disagree on **5,431** rows:

| | meaning |
|---|---|
| `CONAME` | the county the parcel **lies in** — **the routing key** |
| `PARCELFIPS` | the county whose **submission** the row came in — provenance |

Appleton spans Outagamie, Calumet and Winnebago; Menasha spans Winnebago and
Calumet. So 3,839 Calumet parcels carry Outagamie's 087, 1,419 carry
Winnebago's 139, and 172 Winnebago parcels carry 087. Routing by where the land
is keeps identity with the county that taxes it and records its deeds; it is
safe on the evidence — only **one** (county, parcel) key in the release arrives
from two submitters. Rows are flagged `cross_county_submission`.

`CONAME` is resolved through the federal catalogue, never trusted as text. One
row says **`MENOMONIE`** (a city in Dunn County) with `PARCELFIPS 999`, and is
quarantined. The county is never inferred from an address.

| | |
|---|---|
| expected (federal catalogue) | 72 |
| actual | **72** |
| missing / extra | none / none |
| invalid | 1 row (`MENOMONIE`) |
| smallest county | Menominee (55078), 4,514 rows |
| largest county | Milwaukee (55079), 280,676 rows |

The per-county inventory is pinned in `counties.ts` and reconciled every release.

---

## 8. Field semantics

- **Assessed ≠ market.** `CNTASSDVALUE` is assessed at each municipality's own
  assessment ratio and becomes `totalValue` with `value_basis:
  assessed_at_municipal_ratio`. `ESTFMKVALUE` (estimated fair market) is a
  different value type and is stored beside it, never in the same slot. It is
  absent on 833,590 rows where assessed value is present.
- **Net ≠ gross tax.** `NETPRPTA` (after credits) is `netTax` and the canonical
  tax total; `GRSPRPTA` is kept separately. Gross is never below net.
- **The roll year is the time axis.** `TAXROLLYEAR`: 2025 on 3,510,241 rows,
  2026 on 25,801, 2027 on 537, 2024 on 211, 2023 on 2, 2021 on 21, blank on
  37,833. It is `assessmentYear` on the assessment observation, so two roll
  years are two observations, never a conflict. A blank or non-year stays null.
- **Money** is read from the geodatabase's doubles through the contract's
  decimal-string path into exact cents. One `ESTFMKVALUE` carries sub-cent float
  noise and is refused as invalid, not rounded.
- **Classes** are comma-separated statutory codes (Wis. Stat. § 70.32) kept as
  ordered lists: 1 residential (2.14 M sole), 2 commercial, 3 manufacturing, 4
  agricultural, 5 undeveloped, 5M agricultural forest, 6 productive forest, 7
  other; auxiliary X1–X4 exempt, W-codes managed forest, AW/AWO.
- **Ownership** names are observations with role `assessor_owner_of_record`,
  `kind: unknown`, `unresolved`; `OWNERNME2` is a second observation. No name is
  merged with another; no investor, buyer or seller is inferred.
- **No sale, transfer, deed or mortgage fact** is emitted. The transaction slot
  is the standard non-transaction placeholder with `totalConsideration: null`.

---

## 9–12. Measured run, proofs and performance

See the sections appended below from the DF-0K proof run.
