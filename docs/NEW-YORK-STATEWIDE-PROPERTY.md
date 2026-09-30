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
2026-09-29):

| | |
|---|---|
| Legacy environment | `https://gisservices.its.ny.gov/arcgis/rest/services` (ArcGIS Server 10.81) |
| GeoHub environment | `https://nysgeohub.ny.gov/arcgis/rest/services` (ArcGIS Enterprise 11.5) |
| Legacy vector services | **stopped receiving updates on 2026-09-18**; "remain online through October" |
| Planned retirement | **10/2026** (every parcel service: centroids, public polygons, state-owned) |
| URLs | "all GeoHub service URLs are different than the legacy URLs" |

| Centroid service | URL | Status on 2026-09-29 |
|---|---|---|
| GeoHub | `…/Parcels/NYS_Tax_Parcel_Centroid_Points/FeatureServer` | live, 11.5, `serviceItemId a83d82c6…`, `maxRecordCount` 2000, `Query,Extract`, **5,510,061** |
| Legacy | `…/NYS_Tax_Parcel_Centroid_Points/FeatureServer` | still answering, 10.81, `maxRecordCount` 1000, 5,510,061, **frozen since 2026-09-18** |

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

**Remaining legacy hostname dependency: none.** In the live run the archive came
from `gisdata.ny.gov`, the witness from `nysgeohub.ny.gov` via the program page,
and the legacy server was never contacted.

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

### Refused rows

| Reason | Rows |
|---|---:|
| no SBL (right-of-way, water, unknown; no roll record) | 6,606 |
| SBL is a label with no digit (Westchester water/unknown) | 19 |
| COUNTY_NAME and SWIS disagree | 0 |
| uncatalogued county | 0 |
| duplicate (county, SWIS, SBL) | (§9) |

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
- **The roll year is the time axis.** `ROLL_YR` = 2025 on every row →
  `assessmentYear`. Two roll years are two observations, never a conflict.
  `SPATIAL_YR` (2025; Westchester partly 2024) is the geometry's vintage.
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

## 9. The full statewide run

*(filled from the live run)*

---

## 10. Cross-state isolation

*(filled from the live run)*

---

## 11. Idempotency and network-off replay

*(filled from the live run)*

---

## 12. Source quality, by county

*(filled from the live run)*

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
| `README.md`, `tools/README.md` | one row each | possible | keep both |

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
