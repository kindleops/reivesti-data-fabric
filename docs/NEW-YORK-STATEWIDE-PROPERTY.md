# New York Statewide Property Fabric

**Source id:** `ny_statewide_parcels` · **Adapter:** `ny_statewide_parcels` ·
**Mapping:** `ny_statewide_parcels__all_ny_counties` · **Status:** `active` ·
**Release ingested:** `2025-2605` (2025 assessment roll, May 2026 build)

Reivesti's third statewide parcel estate: **one source, 62 county partitions,
5,510,061 publisher rows**, discovered, downloaded, hashed, retained, derived,
ingested and replayed with nobody present — through a web-service migration the
publisher is in the middle of.

It is a parcel and assessment roll. It is **not** a transfer source and carries
no tax amount. New York transfer and tax coverage remain gaps.

---

## 1. The 2026 GeoHub migration (read this first)

NYS ITS Geospatial Services is moving every web service off its legacy ArcGIS
Server onto **GeoHub**, a new ArcGIS Enterprise. From the publisher's own
migration page (`https://gis.ny.gov/migration-web-services`, verified
2026-09-29 and again 2026-09-30; `reference/ny-statewide/2025-2605/migration.json`):

| | |
|---|---|
| Legacy environment | `https://gisservices.its.ny.gov/arcgis/rest/services` (ArcGIS Server 10.81) |
| GeoHub environment | `https://nysgeohub.ny.gov/arcgis/rest/services` (ArcGIS Enterprise 11.5) |
| Legacy vector services | **stopped receiving updates on 2026-09-18**; "remain online through October" |
| Planned retirement | **10/2026** (every parcel service: centroids, public polygons, state-owned) |
| URLs | "all GeoHub service URLs are different than the legacy URLs" |

| Centroid service | URL | Status on 2026-09-29 / 30 |
|---|---|---|
| GeoHub | `…/Parcels/NYS_Tax_Parcel_Centroid_Points/FeatureServer` | live, 11.5, `serviceItemId a83d82c6…`, `maxRecordCount` 2000, `Query,Extract`, **5,510,061** — the witness of every live run |
| Legacy | `…/NYS_Tax_Parcel_Centroid_Points/FeatureServer` | still answering, 10.81, `maxRecordCount` 1000, 5,510,061, **frozen since 2026-09-18** (re-checked once on 2026-09-30 for this report, outside the connector) |

The bulk downloads live on a third host, `gisdata.ny.gov` (Apache), which the
migration does not list and which the program page links directly.

### What the connector depends on — and what it does not

**No service hostname is hard-coded as a place to fetch from.** Discovery starts
from two publisher-controlled indirections that survived the migration:

1. **The program page**, `https://gis.ny.gov/parcels`. It links the current
   bulk downloads and the current FeatureServers, and was already updated to
   GeoHub. Every archive and service URL is read from it on every run.
2. **The publisher's ArcGIS Online catalogue item**
   `b25e828955bd4391ad17650d6893edde` (owner `NYSGIS_GPO`), whose `url` was
   repointed to GeoHub on 2026-08-27. Consulted only when the program page
   links no usable service; accepted only when its owner is the publisher's
   account and its URL is on an official host.

Every URL discovery uses must be on an official `ny.gov` host over HTTPS; a
third-party mirror link is refused (tested). The legacy hostname appears in the
code once, as a constant used to **recognise and refuse** it. Its services
stopped updating on 2026-09-18, so a count and schema read there cannot vouch
for a newer archive, and after October they will not answer at all: a release
that could only be discovered through the legacy host **fails discovery**,
with a message naming the migration and the catalogue item's own reason for
not helping — loudly, now, instead of silently at retirement. Legacy links
beside current ones are ignored and reported (`migration.legacyLinksIgnored`),
never requested. Each product must be linked **exactly once** on a current
host: two current centroid archives (or services) are ambiguous, and discovery
refuses to pick one.

Tested: a GeoHub run makes **zero** requests to the legacy host; a program page
that links only the legacy server still resolves GeoHub through the catalogue
item; a catalogue item still pointing at the legacy server is refused with that
reason; legacy-only everywhere fails discovery without contacting the legacy
host; two current archive links fail as ambiguous; a further move to another
`ny.gov` host is followed with no code change.

**Remaining legacy hostname dependency: none.** In the live runs the archive came
from `gisdata.ny.gov` and the witness from `nysgeohub.ny.gov` via the program
page; a request-recording preload on a live discovery counted `gis.ny.gov` 1,
`gisdata.ny.gov` 4 (2 HEAD, 2 range), `nysgeohub.ny.gov` 4 — and the legacy
server **0**.

---

## 2. Authority, access, terms — verified 2026-09-29

| | |
|---|---|
| Authority | NYS Office of Information Technology Services — Geospatial Services, Statewide Parcel Map Program |
| Attribute authority | NYS Department of Taxation and Finance, Office of Real Property Tax Services (ORPTS): the 2025 assessment rolls |
| New York City | NYC Department of City Planning **MapPLUTO** (stated in the metadata) |
| Program page | `https://gis.ny.gov/parcels` |
| Bulk archive | `https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcel-Centroid-Points.gdb.zip` |
| Archive | 562,761,366 bytes, `application/zip`, `Accept-Ranges: bytes`, ETag `"218b0e96-65c39faa0d700"`, Last-Modified **Thu, 24 Sep 2026 12:45:48 GMT** |
| Format | Esri File Geodatabase `NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb`; point table `a00000013` (2,284,720,063 bytes inflated, edited 2026-09-23) + offset index (27,550,752 bytes) + five lookup tables |
| Metadata | `https://gis.ny.gov/system/files/documents/2026/05/current_parcel_centroid_metadata.pdf` — "NYS 2025 Statewide Tax Parcel Centroid Points", Publication Date May 2026 |
| Cost | **$0.** "Publicly available GIS tax parcel data is available for Download or as Web Services." `FREE_BULK` |
| Terms | A no-warranty use limitation ("as is"); credits to contributing counties, Geospatial Services and ORPTS. No licence restriction. `open_with_attribution` |
| robots.txt | `gis.ny.gov` disallows only Drupal admin/system paths; `gisdata.ny.gov` and `nysgeohub.ny.gov` serve none |
| Credentials / session / CAPTCHA | **None** on any path. Every request was anonymous |
| Cadence | "Updated annually" (catalogue item: "annually, or as needed") |

**Core eligibility.** `assessActivation` returns `CORE_ELIGIBLE`, gate `none`,
from registry facts alone: `FREE_BULK`, `automationStatus: sanctioned`,
`acquisitionClass: AUTOMATED_BULK_DOWNLOAD`, `termsStatus: reviewed_permitted`.
No override.

### Lineage, precisely

```
county real property / GIS offices ──► Statewide Parcel Map Program (ITS Geospatial Services)
                                            │  parcel polygons, all 62 counties
municipal assessors ──► ORPTS 2025 assessment rolls
                                            │  attributes joined on SWIS + tax map number
NYC MapPLUTO (DCP / DOF) ───────────────────┤  the five boroughs
                                            ▼
             statewide standardized parcel product (one schema)
              ├── NYS Tax Parcel Centroid Points  — all 62 counties (points "mathematically derived", inside each polygon)
              └── NYS Tax Parcels Public          — 38 counties that permit redistribution (polygons)
```

NYS did not create the assessor facts. The municipal assessors did (through
ORPTS's roll system); the state aggregates and standardizes them.

---

## 3. Two products, one substrate

| | Centroid points | Public polygons |
|---|---|---|
| Archive | `NYS-Tax-Parcel-Centroid-Points.gdb.zip`, 562,761,366 B | `NYS-Tax-Parcels.zip`, 801,888,277 B |
| Geodatabase | `NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb` | `NYS_2025_Tax_Parcels_Public_2605.gdb` |
| Counties | **62** | **38** (those that let the state redistribute geometry) |
| Rows | **5,510,061** | 3,827,530 |
| Roll year / spatial year | 2025 / 2025 (Westchester 31,992 on 2024 geometry) | identical |
| Attributes | 73 | the same 72 ORPTS/PLUTO attributes (no `ORIG_FID`) + polygon metrics |
| GeoHub count | 5,510,061 | 3,827,530 (+ a 38-feature county footprint layer) |

Measured key for key over the 38 polygon counties: **3,822,116 distinct
(county, SWIS, SBL) keys in both products, 0 polygon-only, 0 centroid-only**,
and equal row counts in every one of the 38 counties. The polygons are an
alternate geometric representation of exactly the same parcel records, with
less coverage.

**Decision.** The centroid product is the **primary canonical source**: it is
statewide (62 vs 38 counties), carries the same assessment substrate, is a
smaller and coherent publisher artifact, and replays from one archive. The
polygon product is **not ingested** — ingesting it would double-ingest
equivalent facts for 38 counties. It is registered as
`ny_statewide_parcel_polygons` with role `VALIDATION_ONLY` and **no mapping** (it
can never count as coverage), and the pipeline **retains its archive as raw
geometry evidence** (downloaded, hashed, kept; never decoded).

---

## 4. Release identity and unattended discovery

The archive URL carries no version. Its one geodatabase does:
`NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb` → roll year **2025**, build
**2605** (May 2026) → reference period **`2025-2605`**, the publisher's own label.

Discovery reads it **before downloading a byte of the body**: one HEAD, then the
ZIP end-of-central-directory record and central directory by HTTP range (two
small GETs; three for a ZIP64 archive). The end record is the one whose own
comment length ends it exactly at the end of the file — a comment containing
the signature is not mistaken for it — and the directory must list exactly the
entries its end record states. The archive must hold **exactly one**
geodatabase, and its name must be a centroid release name.

Where a host stops serving ranges — or advertises `Accept-Ranges: bytes` and
then answers a ranged GET with the whole body, which is cancelled and not asked
for again — the label falls back to the witness's title and publication date
("NYS 2025 Tax Parcel Centroid Points", "Publication Date: May 2026"), and
derivation later refuses an archive whose geodatabase names a different
release, or holds more than one (tested).

| Request | Purpose |
|---|---|
| GET program page | archive links + service links |
| HEAD archive | fingerprint (URL, ETag, length, Last-Modified) |
| 1–2 range GETs | geodatabase name → reference period |
| 3 GETs to the witness | service metadata (title, publication date), layer schema, count |
| HEAD + range GETs + count, polygon archive | companion fingerprint and label |

A same-fingerprint tick is a **NOOP**; a new ETag or length under the same label
is `REPUBLISHED_RELEASE`; a new label is `NEW_RELEASE` with
`schemaValidationRequired` — ingested only if the pinned field-set digest still
matches.

---

## 5. Schema: every field, classified

73 attribute columns (plus the `Shape` point geometry), classified in
`src/connectors/ny-statewide-parcels/field-map.ts`. The geodatabase and the
GeoHub FeatureServer declare the same set; pinned field-set digest
`2c0ad408c074e384f437fcd153ddc10b91dbc97e83c48135c11eee9a77f19b44` (archive =
service = field map).

| Disposition | Count |
|---|---:|
| `CANONICALIZE` | 15 |
| `NORMALIZE` | 36 |
| `KEEP_RAW` | 9 |
| `HISTORIZE` | 1 |
| `RESTRICTED` | 10 |
| `DERIVE_LATER` | 2 |

| Group | Fields |
|---|---|
| Parcel identity | `SWIS` + `SBL` (identity); `PRINT_KEY`, `MUNI_PARCEL_ID` (secondary observations); `SWIS_SBL_ID`, `SWIS_PRINT_KEY_ID` (publisher composites, kept raw); `OBJECTID`, `ORIG_FID` (row positions) |
| County / municipality | `COUNTY_NAME` (routing), `MUNI_NAME`, `CITYTOWN_NAME`, `CITYTOWN_SWIS` |
| Situs | `PARCEL_ADDR`, `LOC_ST_NBR`, `LOC_STREET`, `LOC_UNIT`, `LOC_ZIP` |
| Ownership | `PRIMARY_OWNER`, `ADD_OWNER` (observations); `OWNER_TYPE`, `NYS_NAME`, `NYS_NAME_SOURCE` (publisher classifications) |
| Mailing (**restricted**) | `MAIL_ADDR`, `PO_BOX`, `MAIL_CITY`, `MAIL_STATE`, `MAIL_ZIP`, `ADD_MAIL_*` ×5 |
| Assessment | `LAND_AV`, `TOTAL_AV`, `FULL_MARKET_VAL`, `PROP_CLASS`, `ROLL_SECTION`, `ROLL_YR`, `SCHOOL_CODE`, `SCHOOL_NAME` |
| Structure | `YR_BLT`, `SQFT_LIVING`, `GFA`, `NBR_KITCHENS`, `NBR_FULL_BATHS`, `NBR_BEDROOMS`, `BLDG_STYLE(_DESC)`, `HEAT_TYPE(_DESC)`, `FUEL_TYPE(_DESC)`, `SEWER_*`, `WATER_*`, `UTILITIES*`, `USED_AS_*` |
| Area / location | `ACRES`, `SQ_FT`, `FRONT`, `DEPTH`, `CALC_ACRES`, `GRID_EAST`, `GRID_NORTH`, `DUP_GEO`, `AG_DIST_*`, `SPATIAL_YR` |
| Deed reference | `BOOK`, `PAGE` — `DERIVE_LATER`; a pointer to the last recorded deed, never a transfer |
| Geometry | `Shape` POINT ZM, NAD83 / UTM zone 18N — retained in the archive, not decoded |

**Not in this schema at all:** any tax amount (levy, bill, net, gross), taxable
value, homestead, sale date, sale price, latitude/longitude attributes. Only
fields actually present are claimed.

**There is no `TAX_ID` field.** The statewide join keys the publisher documents
are `SWIS_SBL_ID` and `SWIS_PRINT_KEY_ID` ("uniquely identifies each parcel") and
`MUNI_PARCEL_ID` (ORPTS's link to its other products). None of them is adopted
wholesale as Reivesti identity; see §6.

---

## 6. Property identity

`propertyId = deterministicId('prop','county_parcel', countyFips, SWIS + SBL)` —
the existing county-parcel identity with a New York-defined local parcel key.

### Why SWIS + SBL, measured over all 5,510,061 rows

| Candidate | Finding |
|---|---|
| SBL alone | **not county-unique**: the same SBL occurs in two cities/towns of one county **123,246** times — tax maps are numbered per municipality |
| CITYTOWN_SWIS + SBL | merges roll parcels: **11,523** keys carry several SWIS (9,952 Suffolk, 1,042 Nassau), only 1,039 share geometry, **11,476 have different assessed values** — village portions are separate roll parcels |
| **SWIS + SBL** | the publisher's documented unique key; 5,503,241 distinct keys, 155 repeated (214 extra rows — 44 exact copies of multi-part polygons, the rest distinct ORPTS records sharing an SBL) |
| PRINT_KEY | the formatted SBL; absent in NYC; folding its separators merges **58,239 groups / 117,372 keys** — its punctuation is identity-bearing |
| MUNI_PARCEL_ID | unique, but ORPTS-internal, absent in NYC (and on every roll-less row); not what deeds and transfer reports cite |

SWIS is part of the parcel identifier because the tax map number is only unique
inside the municipality that assigns it. Where a village and its town both
assess one polygon (the publisher's `DUP_GEO` note), the two roll records are
two properties; their `CITYTOWN_SWIS + SBL` **tax-map key** is kept on both as a
candidate link, never as identity.

### Normalization collision audit (every (county, SWIS, SBL))

| Transform | Distinct keys | Collision groups | Raw keys merged |
|---|---:|---:|---:|
| raw | 5,503,241 | 0 | 0 |
| trim | 5,503,240 | 1 | 2 |
| case | 5,503,240 | 1 | 2 |
| separator removal | 5,503,240 | 1 | 2 |
| punctuation removal | 5,503,240 | 1 | 2 |
| leading-zero removal | 5,503,240 | 1 | 2 |

The single merge is a Westchester **water label** with a trailing space — not a
parcel, and refused anyway. The SBL is normalized with the contract's existing
**`PUNCTUATION_PRESERVING`** scheme (`parcel_identifier_scheme_1`): outer
whitespace trimmed, case folded, nothing else. No Minnesota or Wisconsin rule was
copied; no new scheme was needed; the shared contract is unchanged.

### Cross-state parcel-string reuse (live, MN + WI + NY)

`tools/ny-audit.ts pid-reuse` external-sorted all 11,664,439 county-parcel
identifiers of the three estates (Minnesota 2,648,100, Wisconsin 3,513,111, New
York 5,503,228):

| | MN + WI | MN + NY | WI + NY | all three |
|---|---:|---:|---:|---:|
| canonical parcel strings shared across states | 30,988 | **0** | **0** | 0 |
| folded keys shared (how a naive matcher would join) | 32,970 | **0** | **0** | 0 |
| New York's bare SBL (without its SWIS) equal to another state's parcel string | — | 143 | 26 | 0 |

A New York canonical string carries its six-digit SWIS, so it is shared with no
other state; within New York no canonical string spans two counties (Minnesota
has 92,874 such strings, Wisconsin 117,040). Even the bare tax-map numbers that
do coincide with Minnesota or Wisconsin parcel numbers stay separate
properties, because the county is part of the identity. **Property-id
collisions: 0** — every (county, parcel) is its own property.

### Refused rows

| Reason | Rows |
|---|---:|
| no SBL (right-of-way, water, unknown; no roll record) | 6,606 |
| SBL is a label with no digit (Westchester water/unknown) | 19 |
| COUNTY_NAME and SWIS disagree | 0 |
| uncatalogued county | 0 |
| later copy of a (county, SWIS, SBL) already read | 208 |

Rows with a numeric SBL but no ORPTS roll record behind them (13,954 outside
NYC; mostly unknown, right-of-way and water owner types) **are** admitted as
parcels — the county's GIS states them — with no assessment observation and
`roll_record_present: false`.

---

## 7. County routing, including New York City

Two independent statements of the county must agree: `COUNTY_NAME` (folded to
letters, resolved through the federal catalogue — the layer writes `NewYork` and
`StLawrence`) and the **SWIS county code** (the first two SWIS digits, ORPTS's
own: 01–57, and 60–64 for the boroughs). In this release each of the 62
counties carries exactly one SWIS county code and no row disagrees.

| Borough | County | FIPS | SWIS |
|---|---|---|---|
| Bronx | Bronx | 36005 | 600100 |
| Brooklyn | Kings | 36047 | 610100 |
| Manhattan | New York | 36061 | 620100 |
| Queens | Queens | 36081 | 630100 |
| Staten Island | Richmond | 36085 | 640100 |

Each borough is its own county-equivalent partition. Its SBL is the 10-digit BBL,
whose leading borough digit agrees with the county on all 856,670 NYC rows.

| | |
|---|---|
| expected (federal catalogue) | 62 |
| actual | **62** |
| missing / extra | none / none |
| invalid | 0 rows |
| smallest county | Hamilton (36041), 12,947 rows |
| largest county | Suffolk (36103), 586,600 rows |

---

## 8. Field semantics

- **Two lineages, never blended.** Outside NYC, `PROP_CLASS` is ORPTS's 3-digit
  property class and `TOTAL_AV` is assessed at the municipality's own level of
  assessment. In NYC, `PROP_CLASS` is a PLUTO 2-digit land-use code,
  `BLDG_STYLE` a DOF building class, and the assessed value is DOF's. Every value
  carries `property_class_system` / `building_style_system` / `value_basis`, so
  the two are never compared as if alike.
- **Assessed ≠ full market.** `TOTAL_AV` → `totalValue`
  (`value_basis: assessed_at_municipal_level_of_assessment`);
  `FULL_MARKET_VAL` rides beside it (`full_market_value_minor`), never in the
  same slot. `LAND_AV` → `landValue`. Building value is not stated and is not
  derived (total − land would be a derivation, not the roll).
- **The roll year is the time axis.** `ROLL_YR` ("tax year of assessment roll
  attributes", per the data dictionary) = 2025 on every row → `assessmentYear`.
  Two roll years are two observations, never a conflict. `SPATIAL_YR` (2025;
  Westchester partly 2024) is the geometry's vintage.
- **No status or valuation date is stated.** ORPTS: "In most towns, Taxable
  Status Date is March 1 of the year in which the roll is filed" and "Valuation
  Date is July 1 of the year prior to the roll", with the instruction to confirm
  each municipality's own dates with its assessor
  (`tax.ny.gov/pubs_and_bulls/orpts/tentasmtroll.htm`, read 2026-09-30). The
  product carries neither date for any row, in either lineage, so none is
  asserted: `assessmentYear` is the roll year and nothing more precise.
- **No tax amount.** `netTax` is null; `tax` is not claimed. `ROLL_SECTION`
  (taxable / exempt / state land / utility) is a roll-status code.
- **No sale.** `BOOK`/`PAGE` are kept raw (`last_deed_book_raw`,
  `last_deed_page_raw`) and emit no transfer, sale, deed or mortgage fact.
- **Money** is whole dollars in this release (0 sub-cent, 0 fractional, 0
  negative), read through the contract's decimal path into exact cents. Zero is
  a stated zero (TOTAL_AV 0 on 7,116 ORPTS rows). Land above total (343 rows) is
  flagged `land_exceeds_total`, never repaired.
- **Area.** ORPTS sizes a parcel in acres, square feet or frontage × depth and
  writes 0 in the units it did not use (`SQ_FT` is 0 on 4.36 M ORPTS rows). The
  canonical area is the first positive of `ACRES`, `SQ_FT`; if both are 0 it is
  absent (`NOT_APPLICABLE`) and frontage/depth stay raw. `CALC_ACRES` (GIS) is
  kept separately — duplicated geometry repeats it.
- **Year built.** 0 means not recorded (38,687 rows) → null; 1600 … roll year + 1
  accepted (New York has standing 17th-century houses); the raw value is kept.
- **Coordinates.** The centroid is the point geometry, retained in the archive
  and not decoded (the shared FileGDB reader skips geometry; decoding is a
  shared-runtime change deferred to integration — see §14). `GRID_EAST/NORTH` is
  the roll's own grid, "assumed to be State Plane" with no zone stated; it is
  kept raw and never converted.

---

## 9. The full statewide run (2026-09-30, live publisher, unattended)

`df auto ny_statewide_parcels__all_ny_counties`, 1 GB heap cap, into an estate
already holding Minnesota's 59 and Wisconsin's 72 counties — rebuilt in this
container from the base commit with the base code, because the estates of
earlier phases lived on containers that no longer exist. Evidence, aggregate
only, in `reference/ny-statewide/2025-2605/`.

| | |
|---|---:|
| reported (GeoHub FeatureServer witness) | 5,510,061 |
| archive table (valid rows = indexed rows; 0 deleted slots) | 5,510,061 |
| derived and parsed | 5,510,061 |
| **accepted** | **5,503,228** |
| quarantined | **6,833** = 6,606 with no SBL + 19 digit-less labels + 208 later copies of a (county, SWIS, SBL) already read |
| **reconciliation** | 5,503,228 + 6,833 = 5,510,061 — exact; witness difference **0** |
| completeness | `complete` |
| witness cross-check | count, schema digest and release label all agree; no field in one path and not the other |
| canonical properties (all `resolved`, county-parcel authoritative) | **5,503,228** |
| unresolved | 0 |
| conflicts | 190,603, **all** `address_matches_different_pid` (severity `info`): one situs address shared by several distinct parcels — condominium units, village and town portions of one polygon. Flagged, never merged |
| restricted contact observations | 6,276,204 |
| canonical events | 18,129,889 |
| rows without geometry | 0 |
| partitions | 62 county + `organization/us`, all `activated` |
| run id | `run_319d5ae51a23dd4dce1aca63affc5674` |
| normalized digest | `85726d243d40a4f2ea22601020c73bc00a9894d572f44ffedb26d6c7f8a0823f` |
| **global estate digest (MN + WI + NY)** | `5c46d1e308c36aa03dd2bb5ad61f40a75ff97939e577cb83dc9da7a9488caf52` |
| publisher archive | 562,761,366 bytes, sha256 `7c5b51644712692143afc6e927c7c383fef1191fa7f9d8ab47154d81bd90719b` — identical to the independent download made during forensics the day before |
| derived bundle | 5,870,851,846 bytes of plain NDJSON, sha256 `3969c4a08c9f88b61271c3d77c4e16eb44855dce547413e1a2617c7a26f61301` |
| polygon companion | `RETAINED`: 801,888,277 bytes, sha256 `ea803fbdb9ac5e6dfe61f90b38ddfe342274fb00b3e6898de2c7532c79de740f` (identical to forensics); never ingested |

**Counties.** Expected 62 (federal catalogue), actual **62**, missing none,
extra none, invalid rows 0. Accepted rows per county range from **12,945**
(Hamilton) to **586,595** (Suffolk), median 43,442. The five boroughs account
for 856,670 — every New York City row was accepted.

**The discovery that led here** asked `gis.ny.gov` once, `gisdata.ny.gov` twice
by HEAD and twice by range, and `nysgeohub.ny.gov` four times — and the legacy
server **zero** times (measured by a request-recording preload,
`release.json › discoveryRequestsByHost`).

### Performance

Memory in MiB as the runtime samples it; disk sizes in bytes or decimal MB.

| | New York 2025-2605 | Wisconsin V12 (same container) | Minnesota (same container) | Synthetic 5.5 M (DF-0I) |
|---|---:|---:|---:|---:|
| rows | **5,510,061** | 3,574,646 | 2,710,201 | 5,500,000 |
| publisher artifact | 562,761,366 B (zip) | 759,926,092 B (zip) | 2,610,774,016 B (gpkg) | — |
| derived bundle | 5,870,851,846 B | 2,724,190,106 B | 2,526,488,707 B | — |
| discover | 6.7 s | 2.1 s | — | — |
| acquire (download) | 94.7 s | 64.6 s | 105 s | — |
| derive (unzip + read geodatabase) | 131.7 s (14.5 + 115.9) | 76.3 s | 173.8 s | — |
| parse + normalize | 4,618.6 s | 2,616.3 s | 2,392.8 s | — |
| project | 1,492.3 s | 1,427.3 s | 718.6 s | — |
| **pipeline wall** | **6,499 s** (companion 141 s included) | 4,195 s | 3,138 s (runtime only) | 3,566 s |
| **peak heap** | **157 MB** (1,024 MB cap) | 153 MB | 257 MB | 201 MB |
| max RSS | 1,079 MB | 693 MB | 1,058 MB | 575 MB |
| peak external / arrayBuffers | 978 / 968 MB | 631 / 621 MB | 876 / 867 MB | — |
| snapshot indexes on disk | 132 MB | 84 MB | 64 MB | 129 MB |
| peak scratch | 4.36 GiB | — | — | — |
| end-to-end rows/s | 848 | 852 | 864 | 1,542 |
| network-off replay (wall) | 6,236 s | — | — | — |

**No heap regression, and none per row.** Twice Minnesota's rows peaked at 157
MB against Minnesota's 257 — the heap is the emit stage's projection fold, not
anything retained per row. What grows with the row count is the off-heap memory
the design moved there on purpose: the identity index and the 62 snapshot-index
builders, 968 MiB of `ArrayBuffer` at 5.5 M rows (≈184 bytes per row;
Wisconsin's is 182). That is why RSS, not heap, reached 1.08 GB. The heap cap was
not raised. The disk grew by at most 19.9 GiB during the run: the plain bundle
(5.47 GiB), gzip-compressed run tables (7.5 GiB + 0.55 GiB restricted), 62
partitions (4.0 GiB), and projection scratch peaking at 4.36 GiB.

---

## 10. Cross-state isolation

`tools/estate-state.ts` hashed every file of every partition and every snapshot
index (bytes, size, mtime, CURRENT, manifest digests) at each step. Florida is
not assumed present: this branch knows only its own base state.

**The estate New York was ingested into.** Minnesota's 59 and Wisconsin's 72
counties, rebuilt from the base commit with the base code (Minnesota from the
same GeoPackage bytes the artifact catalog certifies, `e3d54ee1…`; Wisconsin
from the certified archive `b22bfaad…`; both reconciled exactly as in DF-0H /
DF-0K). The session's disk cannot hold three statewide estates with every
regenerable output, so after capture `0-baseline` the regenerable Minnesota and
Wisconsin outputs that isolation does not measure were released (14.87 GB: both
derived bundles, both states' canonical run tables, and the Wisconsin publisher
zip, which the catalog lists as `REACQUIRABLE`). Their parcel identifiers were
extracted first, for the reuse audit (6,161,211 = 2,648,100 + 3,513,111).
Capture `0b-before-ny` shows the release touched **no** partition and **no**
index: 132 partitions and 2 indexes unchanged.

| | before NY (0b) → after NY (1) |
|---|---|
| Minnesota county partitions (59) | **0 written** — same files, sizes, mtimes, sha256, generation, row count |
| Wisconsin county partitions (72) | **0 written** — likewise |
| Minnesota / Wisconsin snapshot indexes | **0 written** |
| New York county partitions | 62 added |
| New York snapshot index | 1 added |
| `organization/us` | recomputed (a nation-scoped partition; New York names organizations) |

Across the **whole** proof — ingest, NOOP, both forced attempts, the deletion
of every New York output and the network-off replay — the diff from before New
York to after the replay is the same: 62 New York partitions and 1 New York
index added, `organization/us` recomputed, and **all 131 Minnesota and
Wisconsin partitions and both of their indexes unchanged** (same files, sizes,
mtimes, sha256, generations and row counts).

All 131 Minnesota and Wisconsin partitions carry the same state digest, output
digest, generation and row count before and after (`isolation-diffs.json`).

**`organization/us`** is the one shared partition, and it is recomputed by
design whenever a run names an organization. It folds the organization
observations of every run's canonical rows; because the Minnesota and Wisconsin
run tables had been released for disk, its New York generation folds New
York's observations only. That is a property of this proof environment, not of
the code: on a full estate the same fold spans all three states. The two
pre-New York generations of that partition were left in place throughout.

**The global digest** is `sha256` over the sorted `partitionId<TAB>outputDigest`
lines of every partition manifest — extended by child digests, never refolded.
Recomputed independently from the captured manifests it equals the run's own
report both before New York (`32c5ba05…`, Minnesota + Wisconsin) and after it
(`5c46d1e3…`), and every Minnesota and Wisconsin child digest in it is
unchanged.

---

## 11. Idempotency and network-off replay

### The same release, rediscovered: NOOP

A second `df auto` tick found fingerprint `dc3012911b95…` already ingested by
`run_319d5ae5…` and stopped: `NOOP_SAME_RELEASE`, **no download**, 5.9 s of
discovery and 3.1 s re-verifying the retained polygon archive
(`ALREADY_RETAINED`). Estate diff: **0** partitions and **0** indexes touched
(194 and 3 unchanged).

### The same release, forced

`df auto … --force` re-ingests from the **retained** archive (no publisher
request for the 563 MB), re-deriving the bundle first.

| | first run | forced re-ingest |
|---|---:|---:|
| bundle sha256 | `3969c4a0…` | `3969c4a0…` — re-derived byte-identical |
| run id | `run_319d5ae5…` | **same** |
| new / unchanged / revised / missing | 5,503,228 / 0 / 0 / 0 | **0 / 5,503,228 / 0 / 0** |
| accepted / quarantined / duplicates | 5,503,228 / 6,833 / 208 | identical, per county identical |
| normalized digest | `85726d24…` | **same** |
| global digest | `5c46d1e3…` | **same** |
| county partitions rewritten | — | **0** (62 `skipped`: every delivered row matched the last accepted snapshot) |
| snapshot indexes rewritten | — | **0** |
| `organization/us` | — | recomputed: new generation, **same** output digest and row count (831,085) |

**0 new logical parcels, 0 false revisions, 0 lost rows, 0 changed ids.** Row
order is irrelevant by construction: OBJECTID and ORIG_FID are excluded from
change detection (the fixture test reorders every row and still sees 0
revisions).

**The first forced attempt ran out of disk.** It completed change detection
(the same 0 / 5,503,228 / 0 / 0) and committed its canonical rows under the same
run id, then hit `ENOSPC` in the post-commit organization fold at 36.4 GiB of
the session's ~37 GiB — the external-sort scratch for that fold shares the
derived plane's disk. It activated nothing: a capture afterwards showed all 194
partitions and 3 indexes byte-identical, and its ledger entry (`FAILED`) does
not disturb planning, which keys on the last *completed* ingest. Its failure
report carried a time-based preflight id — shared-runtime behaviour on failure,
§14 proposal 7. The second attempt, above, put the runtime's scratch on
RAM-backed tmpfs (`var/scratch` → `/dev/shm`; ephemeral by design, deleted in a
`finally`; peak 4.36 GiB) and completed: disk growth 13.6 GiB, peak heap 155
MiB, 5,866 s. No code changed between the attempts.

Before each forced attempt, two regenerable outputs were released for disk: the
derived bundle (the run re-derives it — which is itself the byte-identity proof
above) and the run's previous canonical row files (CURRENT left in place;
change detection reads only snapshot indexes and partition manifests).

### Network-off replay

Every derived New York output was deleted — the canonical run tables (derived
and restricted), the 62 county partitions, the snapshot indexes, the checkpoint
and the derived bundle — leaving the retained publisher archive (the evidence)
and the ledger. Then:

```
unshare --net node … src/cli/df.ts auto ny_statewide_parcels__all_ny_counties \
  --replay 7c5b51644712692143afc6e927c7c383fef1191fa7f9d8ab47154d81bd90719b --period 2025-2605
```

in a network namespace whose only interface is loopback (`net:[4026532262]`
against the worker's `net:[4026531833]`, observed on the running process):
neither the publisher nor the egress proxy was reachable.

| | first run | replay, network off |
|---|---|---|
| publisher archive sha256 | `7c5b5164…` | **equal** (the retained bytes, re-verified) |
| derived bundle sha256 | `3969c4a0…` | **equal** — re-derived byte-identical from the archive |
| run id | `run_319d5ae5…` | **equal** |
| normalized digest | `85726d24…` | **equal** |
| global digest | `5c46d1e3…` | **equal** |
| parsed / accepted / quarantined / duplicates | 5,510,061 / 5,503,228 / 6,833 / 208 | **equal**, and per county |
| resolved / conflicts / contacts / events | 5,503,228 / 190,603 / 6,276,204 / 18,129,889 | **equal** |
| 62 county partitions: input digest, output digest, rows | — | **62 of 62 equal**; every data file byte-identical (only `CURRENT` and the manifest's generation and `activatedAt` differ) |
| 62 snapshot-index files | — | **byte-identical** |
| property ids | — | equal (they are the partitions' resolution rows, byte-identical) |
| Minnesota / Wisconsin partitions and indexes | — | **untouched** (131 and 2 unchanged since before New York) |

Replay: 6,236 s wall (derive 137.7 s, parse + normalize 4,776.6 s, project
1,308.4 s), peak heap 150 MiB, RSS 1,053 MiB, disk growth 17.9 GiB, scratch
4.36 GiB on tmpfs.

---

## 12. Source quality, by county

Measured on every one of the 5,510,061 publisher rows by `tools/ny-audit.ts
quality` (`quality.json`): a field counts as present when it is non-blank, and
for area, year built and living area when it is positive (the roll writes 0 for
"not recorded"). Statewide coverage does not mean uniform quality.

| | statewide | min (county) | median | max (county) | counties < 50% |
|---|---:|---:|---:|---:|---:|
| parcel identity (parser accepts) | 99.88% | 98.30% Oneida | 99.98% | 100% Yates | 0 |
| situs address | 99.66% | 88.83% Hamilton | 99.94% | 100% Tioga | 0 |
| situs ZIP | 56.81% | **0%** Nassau | 42.15% | 99.97% Kings | 32 |
| owner name | 99.63% | 98.04% Rockland | 99.93% | 100% Tioga | 0 |
| assessment (`TOTAL_AV`) | 99.62% | 98.05% Rockland | 99.92% | 100% Tioga | 0 |
| class / use (`PROP_CLASS`) | 99.58% | 98.05% Rockland | 99.85% | 100% Tioga | 0 |
| full market value | 84.08% | **0%** the five boroughs | 99.85% | 100% | 5 |
| roll section | 84.08% | **0%** the five boroughs | 99.85% | 100% | 5 |
| parcel area (acres or ft² > 0) | 69.63% | **0%** Nassau | 77.34% | 99.98% Richmond | 6 |
| year built (> 0) | 65.31% | **0%** Nassau | 69.82% | 96.43% Queens | 4 |
| living area (> 0) | 61.03% | **0%** Nassau | 64.84% | 91.33% Queens | 5 |
| mailing address (restricted; counted, never printed) | 83.85% | **0%** the five boroughs | 99.46% | 99.97% Tompkins | 5 |

- **Lineage:** 4,646,766 rows from ORPTS rolls, 856,670 from NYC MapPLUTO. NYC
  rows carry no full market value, roll section, print key, ORPTS parcel id or
  mailing address — the source's shape, not a defect, and not imputed.
- **Nassau** states no ZIP, area, year built or living area on any row; its
  identity, owner, assessment and class are complete.
- **Roll year** 2025 on every row. **Geometry vintage:** only Westchester mixes
  two (31,992 rows on 2024 polygons, 226,153 on 2025).
- **Publisher flags, kept and never repaired:** 101,842 rows share geometry
  (`DUP_GEO`); 343 state land above total; 2 carry a `SWIS_SBL_ID` that
  disagrees with their own SWIS + SBL, 46 a `SWIS_PRINT_KEY_ID` that disagrees
  with SWIS + print key; 13,954 non-NYC parcels have no roll record behind them;
  0 money values fail the contract's decimal parse.
- **Owner types** (`OWNER_TYPE`, a category the state derived from the owner
  names and research — never used to type or merge a party): 8 Private
  5,326,341; −999 Unknown 24,530; 1–7 federal, state, county, city, town,
  village and mixed government 148,558; 9 school district 6,678; 10 road
  right-of-way 2,764; 11 water 1,185; absent 5.

---

## 13. Restricted data and security

- The ten mailing fields are the only restricted fields. Each owner's parts are
  assembled into one `mailing_address` on the restricted plane
  (`permittedUse: record_only`), attached to that owner's observation — the
  additional owner's to the additional owner. No canonical row has a field that
  could hold one; a party observation carries a name, a role and `address: null`.
- Owner names are observations with role `assessor_owner_of_record`,
  `kind: unknown`, `unresolved`. `OWNER_TYPE` is the publisher's derived category
  and never types or merges a party. No name-only merge; no skip tracing.
- The publisher archive and the derived bundle contain the public-record mailing
  strings as published; they are evidence, retained read-only in the artifact
  store, and never a member-facing surface.
- Fixtures are generated at test time from invented values.

### The live leak audit (aggregate only; no value printed)

`tools/ny-audit.ts leak` merge-joined the 5,510,061 publisher rows with the
5,503,228 derived canonical rows in emit order (0 unmatched) and, per parcel,
looked for that parcel's own **mailing-only** lines — mailing lines that are not
simply its situs — inside its own derived row.

| | |
|---|---:|
| mailing-only lines checked | 2,590,716 |
| mailing lines equal to the parcel's own situs (public, not checked) | 3,454,471 |
| positive control: owner names found in their own row | 5,489,023 / 5,489,023 |
| parties carrying an address | **0** |
| derived key names (of 184) that name contact data | **0** |
| restricted contact rows | 6,276,204, files `0600` |
| **mailing-only lines found inside their own derived row, as a substring** | 91,834 |

Every one of those substring hits was then classified by where it sits
(`leak-paths`, run on the rows the forced re-ingest committed — the first
run's had been released for disk. It finds 91,583 hits: 251 fewer, because a
re-ingest's run-specific values — timestamps, event and observation ids, the
change kind — differ from the first run's, and some hits were on those):

- **88,248** are only *part* of a longer public string: the parcel's own situs
  (the mailing line is the situs without its unit or range — 86,772 of them,
  confirmed independently from the raw rows), an owner name, or digits inside
  an identifier, hash or timestamp.
- **3,335** equal a whole string value, and every one is a public field
  carrying its own value: the situs as normalized (`normalized_address`
  identifier 2,683, `canonical_address_key` 1,578 — the owner's mailing address
  *is* the property, written differently), the published owner name (182 — the
  owner field, never a mailing field), and coincidences with public vocabulary:
  "UNKNOWN" = the party kind and finality (48), municipality and school names
  (39), code descriptions (5).

**No mailing value was copied into a canonical row.** That is true by
construction — the mailing parts reach only the restricted contact rows and a
one-way hash inside the ownership field-group digest — and, measured, not one
hit sits in a field that is not the parcel's own public data. Restricted
directories inherit the process umask (`0755`); their files are `0600`
(§14, proposal 6).

---

## 14. Parallel integration (DF-0M Florida runs beside this)

DF-0N was built on the same merged `main` (`e9ada40`) as DF-0M, source-locally,
and changes **no shared architecture**: nothing under `src/runtime`, `src/core`,
`src/canonical`, `src/archive` or `db/migrations`; no new normalization scheme;
no migration. The New York pipeline mirrors Wisconsin's in its own module rather
than generalising Wisconsin's while Florida may be doing the same.

### Shared files touched, and the conflicts to expect

| File | Change | Expected conflict with Florida | Resolution |
|---|---|---|---|
| `src/registry/sources.ts` | +1 import, +3 constants, +2 sources and +1 mapping appended at the ends of `SOURCES` / `MAPPINGS` | likely (both append at the same places) | keep both blocks |
| `src/cli/df.ts` | +1 import; `fields --source ny`; `auto` accepts `ny_statewide_parcels` and dispatches to `runNyAuto` | likely (same `auto` adapter check) | accept both adapter keys, dispatch each |
| `tests/zero-cost-doctrine.test.ts`, `tests/automated-acquisition-gate.test.ts`, `tests/wi-statewide-parcels.test.ts` | national core parcel coverage `131` → `193` | certain (same literals) | **131 + 62 (NY) + Florida's count** |
| `tests/mn-statewide-parcels.test.ts` | the "Minnesota's own 59" filter also excludes `ny_statewide_parcels` | likely | exclude both sources |
| `reference/artifact-catalog.json` | NY entries appended | likely | keep both |
| `README.md` | layout, documentation and status rows; national coverage 59 → 193 | likely (same rows) | keep both rows; coverage = 193 + Florida's count |
| `tools/README.md` | one row | possible | keep both |
| `docs/NATIONAL-COVERAGE.md`, `docs/SOURCE-REGISTRY.md` | a New York section appended to each | likely (both append at the end) | keep both sections; recompute the national total |

New, conflict-free: `src/connectors/ny-statewide-parcels/*`,
`tests/ny-statewide-parcels.test.ts`, `tests/support/ny-fixture.ts`,
`tools/ny-audit.ts`, `docs/NEW-YORK-STATEWIDE-PROPERTY.md`,
`reference/ny-statewide/2025-2605/*`.

**Merge order.** Whichever branch merges second rebases onto the first merged
result, resolves the table above, and re-runs the whole suite (`npm test`, the
PostgreSQL gate as a non-root user, typecheck), then re-runs a live
discovery-only tick for both sources. A replay proof is only re-required if a
resolution touched either connector.

### PROPOSED_SHARED_CHANGE (deferred to post-parallel integration)

1. **FileGDB point-geometry decode** (opt-in, in `src/core/filegdb.ts`). The
   reader skips geometry; decoding NY's POINT ZM and reprojecting NAD83 UTM 18N
   would give 5.5 M `source_centroid` coordinates. It is a new capability, not a
   bug fix, so it was not made here. The geometry is retained in the archive: no
   reacquisition will be needed.
2. **One generic statewide-archive pipeline** extracted from Wisconsin's, New
   York's (and Florida's, if it has one): ledger, NOOP, durable, derive, witness,
   ingest, receipt are the same shape three times.
3. **An evidence-only artifact role / ledger action** for companion archives.
   New York keeps a source-local record file
   (`acquisition/ny_statewide_parcel_polygons.retained.ndjson`) instead of
   inventing a ledger action in shared code.
4. **Coverage assertions derived from the registry** rather than literal
   national totals, which is the one conflict class every new state creates.
5. **`df.filegdb.snapshot/1`** is declared by both Wisconsin and New York; it
   belongs in a shared module.
6. **Restricted run directories inherit the process umask.** The restricted row
   files are `0600`, as documented; the run and generation directories holding
   them are created without a mode, so under the usual `022` umask they are
   `0755` — a listing of run ids, generation ids and table names, never the
   content, is readable by other local users. `mode: 0o700` on those `mkdir`
   calls is a one-line change in `src/runtime/staged-store.ts`. Not made here:
   it is shared runtime, it is not a documented guarantee, and nothing New York
   does depends on it. The live leak audit (§13) reports the directory modes.
7. **A run that fails after acquisition reports a preflight run id.** The
   streaming runtime's failure path labels the run
   `deterministicId('run', …, 'preflight', startedAt)` — a time-based id —
   although it had already derived, and written canonical rows under, the
   evidence run id (`source, mapping, release, artifact sha256, versions`). Seen
   live on the first forced re-ingest (§11): its rows were committed under
   `run_319d5ae5…`, its failure report said `run_bf993fc4…`. Reporting only; no
   row carries the preflight id. Passing the evidence id to `finish` on the
   failure path is a small shared change, deferred.
8. **Scratch belongs on its own volume.** A statewide run's scratch (contribution
   files and external-sort chunks, peaking at 4.4 GiB for New York) shares the
   derived plane's disk today; `var/scratch` as a separately sized mount would
   keep a scratch peak from failing a run whose durable outputs fit.
