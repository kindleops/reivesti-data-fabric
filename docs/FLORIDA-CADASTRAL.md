# Florida statewide cadastral (PAR shapefiles)

**Source id:** `fl_statewide_cadastral` · **mapping:** `fl_statewide_cadastral__all_fl_counties` ·
**scope:** all 67 counties · **capability:** parcel · **gate:** CORE_ELIGIBLE ·
**acquisition:** AUTOMATED_BULK_DOWNLOAD, anonymous GETs, $0 · Main document:
`FLORIDA-STATEWIDE-PROPERTY-FABRIC.md`.

## 1. Which cadastral artifact, and why

Three official paths publish Florida parcel geometry. They were re-verified on 2026-09-29:

| Path | State | Verdict |
|---|---|---|
| FGIO `Florida_Statewide_Cadastral` FeatureServer (polygons) | answers **499 Token Required** | not anonymous → not used |
| FGIO `Florida_Statewide_Parcel_Centroid_Version` layer 0 | anonymous; 10,831,924 features; `ASMNT_YR` 2025 | a year behind → not the current source |
| DOR PTO Data Portal `Map Data/2026F/2026F PAR/` | anonymous GETs; 67 county zips + 2 condo tables; posted 2026-08-07; joined to the 2026 preliminary roll | **primary acquisition path** |

The PAR files are what the FGIO layers are refreshed from: each county property appraiser's parcel
shapefile, joined by the Department to the roll. They are one coherent annual release, retrieved
with the same machinery as the NAL and SDF. ArcGIS plays no role in acquisition.

| Fact | Value |
|---|---|
| Files | 69 (67 county shapefiles + Miami-Dade and St. Johns condominium tables), 4,141,216,126 bytes |
| Records (the .dbf headers' own counts) | 10,951,117 — read and reconciled exactly |
| Joined to a roll record | 10,853,778 · unjoined (`CO_NO` 0) 97,339 |
| `PARCELNO` = joined `PARCEL_ID` | on every joined record (0 differ) |
| Parcel ids drawn as more than one polygon | 98,490 ids, 231,025 extra polygons |
| Deleted .dbf records | 0 |
| Geometry | Polygon 8,743,075 · PolygonZ 2,208,042 · null 0 · unclosed ring 243 · zero area 179 · multi-part 309,066 |
| Coordinate systems | State Plane Florida North / East / West, US survey feet (NAD83, HARN and 2011 realizations) — per county, named in each .prj |
| .dbf layout | 118 columns in every county; only `PARCELNO`'s width differs (10–254) |

## 2. What the map contributes, and what it does not

The .dbf carries the roll joined to each polygon. Those joined columns are the NAL's own facts, from
the same preliminary roll, so they are **projected once — from the NAL** — and compared with it by the
cross-source audit (main document §9). From this source the Fabric takes only what nothing else
provides:

1. **Identity from the parcel fabric**: the county's parcel number on its own polygon, authoritative,
   computed with the same PUNCTUATION_PRESERVING rule as the NAL so the two converge.
2. **A geometry summary**: shape type, parts, vertices, bounding box, planimetric area and centroid in
   the file's own coordinate system. The area is labelled `gis_area_square_feet` with derivation
   `shoelace_source_crs_1` (US survey feet converted to international feet); it is never the
   assessor's land area (the NAL's `LND_SQFOOT`) and never a legal acreage. Polygons themselves stay in
   the retained archive; canonical polygons and reprojection are a later phase.
3. **Sale support**: the joined sale echo becomes `FL_DOR_PAR_SALE_ECHO` observations that
   TRANSACTION_RESOLUTION attaches to the SDF sale — a third statement of one sale, never a second.

## 3. Refusals

| Reason | Count | Treatment |
|---|---:|---|
| `UNJOINED_POLYGON` (`CO_NO` 0) | 97,339 | quarantined: water, right-of-way and common areas the county draws and the roll does not assess |
| duplicate identity (second polygon of one parcel) | 231,025 | the first polygon in file order stands; the rest are counted, retained in the archive |
| deleted .dbf record | 0 | refused if present |
| `CO_NO` routing to another county's file | 0 | refused as ambiguous routing if present |

## 4. dBASE cannot say "blank" for a number

A dBASE numeric has no null: where the roll has no second sale, `SALE_YR2` and `SALE_PRC2` read 0
while the text columns beside them are blank. A sale slot is therefore "stated" by its text columns
or a non-zero year, never by a zero number; a zero price in a stated slot is read as zero, the only
meaning the format allows. The cross-source audit counts these as `DBF_ZERO_FOR_BLANK`, not as
disagreement.

## 5. The condominium tables

`miamidade_condos_2026.zip` (352,530 unit points, 186 columns) and `stjohnscondos_2026.zip` (18,112
rows, 12 columns, no shapefile) list condominium units inside building polygons. They carry owner
names and mailing addresses. They are retained and verified with the release and not interpreted: no
canonical consumer for them exists in this phase, and nothing restricted in them reaches any plane.

## 6. Field inventory

Generated from `src/connectors/fl-cadastral/field-map.ts`. A joined column inherits the NAL's
restriction; every other joined column is `IGNORE_WITH_REASON` here because the NAL projects it.

Disposition counts: {"CANONICALIZE":23,"IGNORE_WITH_REASON":75,"RESTRICTED":20}

| # | Field | Type | Group | Disposition | Meaning and treatment |
|---:|---|---|---|---|---|
| 1 | `PARCELNO` | String | identity | CANONICALIZE | The polygon's parcel number in the county's GIS. Equal to the joined PARCEL_ID on every joined record measured; the width is the county's own. |
| 2 | `OID_` | Double(9) | provenance | IGNORE_WITH_REASON | Row object id of the shapefile export: a position, renumbered by every export, never identity. |
| 3 | `CO_NO` | Double(19) | identity | CANONICALIZE | DOR county number of the JOINED roll record; 0 where the polygon joined no roll record, which is quarantined as UNJOINED_POLYGON. |
| 4 | `PARCEL_ID` | String(30) | identity | CANONICALIZE | The joined roll's parcel id: with the county, the canonical identity — the same key the NAL computes, so the map and the roll converge. |
| 5 | `FILE_T` | String(1) | provenance | IGNORE_WITH_REASON | Joined FILE_T: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 6 | `ASMNT_YR` | Double(19) | assessment | IGNORE_WITH_REASON | Joined ASMNT_YR: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 7 | `BAS_STRT` | String(2) | assessment | IGNORE_WITH_REASON | Joined BAS_STRT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 8 | `ATV_STRT` | String(2) | assessment | IGNORE_WITH_REASON | Joined ATV_STRT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 9 | `GRP_NO` | String(1) | assessment | IGNORE_WITH_REASON | Joined GRP_NO: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 10 | `DOR_UC` | String(4) | assessment | IGNORE_WITH_REASON | Joined DOR_UC: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 11 | `PA_UC` | String(2) | assessment | IGNORE_WITH_REASON | Joined PA_UC: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 12 | `SPASS_CD` | String(1) | assessment | IGNORE_WITH_REASON | Joined SPASS_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 13 | `JV` | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 14 | `JV_CHNG` | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_CHNG: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 15 | `JV_CHNG_CD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_CHNG_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 16 | `AV_SD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_SD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 17 | `AV_NSD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_NSD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 18 | `TV_SD` | Double(19) | tax | IGNORE_WITH_REASON | Joined TV_SD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 19 | `TV_NSD` | Double(19) | tax | IGNORE_WITH_REASON | Joined TV_NSD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 20 | `JV_HMSTD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_HMSTD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 21 | `AV_HMSTD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_HMSTD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 22 | `JV_NON_HMS` (NAL `JV_NON_HMSTD_RESD`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_NON_HMSTD_RESD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 23 | `AV_NON_HMS` (NAL `AV_NON_HMSTD_RESD`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_NON_HMSTD_RESD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 24 | `JV_RESD_NO` (NAL `JV_RESD_NON_RESD`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_RESD_NON_RESD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 25 | `AV_RESD_NO` (NAL `AV_RESD_NON_RESD`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_RESD_NON_RESD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 26 | `JV_CLASS_U` (NAL `JV_CLASS_USE`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_CLASS_USE: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 27 | `AV_CLASS_U` (NAL `AV_CLASS_USE`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_CLASS_USE: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 28 | `JV_H2O_REC` (NAL `JV_H2O_RECHRGE`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_H2O_RECHRGE: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 29 | `AV_H2O_REC` (NAL `AV_H2O_RECHRGE`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_H2O_RECHRGE: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 30 | `JV_CONSRV_` (NAL `JV_CONSRV_LND`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_CONSRV_LND: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 31 | `AV_CONSRV_` (NAL `AV_CONSRV_LND`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_CONSRV_LND: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 32 | `JV_HIST_CO` (NAL `JV_HIST_COM_PROP`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_HIST_COM_PROP: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 33 | `AV_HIST_CO` (NAL `AV_HIST_COM_PROP`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_HIST_COM_PROP: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 34 | `JV_HIST_SI` (NAL `JV_HIST_SIGNF`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_HIST_SIGNF: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 35 | `AV_HIST_SI` (NAL `AV_HIST_SIGNF`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_HIST_SIGNF: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 36 | `JV_WRKNG_W` (NAL `JV_WRKNG_WTRFNT`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined JV_WRKNG_WTRFNT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 37 | `AV_WRKNG_W` (NAL `AV_WRKNG_WTRFNT`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined AV_WRKNG_WTRFNT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 38 | `NCONST_VAL` | Double(19) | assessment | IGNORE_WITH_REASON | Joined NCONST_VAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 39 | `DEL_VAL` | Double(19) | assessment | IGNORE_WITH_REASON | Joined DEL_VAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 40 | `PAR_SPLT` | Double(19) | assessment | IGNORE_WITH_REASON | Joined PAR_SPLT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 41 | `DISTR_CD` | Double(19) | assessment | IGNORE_WITH_REASON | Joined DISTR_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 42 | `DISTR_YR` | Double(19) | assessment | IGNORE_WITH_REASON | Joined DISTR_YR: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 43 | `LND_VAL` | Double(19) | assessment | IGNORE_WITH_REASON | Joined LND_VAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 44 | `LND_UNTS_C` (NAL `LND_UNTS_CD`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined LND_UNTS_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 45 | `NO_LND_UNT` (NAL `NO_LND_UNTS`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined NO_LND_UNTS: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 46 | `LND_SQFOOT` | Double(19) | geography | IGNORE_WITH_REASON | Joined LND_SQFOOT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 47 | `DT_LAST_IN` (NAL `DT_LAST_INSPT`) | Double(19) | structure | IGNORE_WITH_REASON | Joined DT_LAST_INSPT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 48 | `IMP_QUAL` | String(3) | structure | IGNORE_WITH_REASON | Joined IMP_QUAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 49 | `CONST_CLAS` (NAL `CONST_CLASS`) | Double(19) | structure | IGNORE_WITH_REASON | Joined CONST_CLASS: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 50 | `EFF_YR_BLT` | Double(19) | structure | IGNORE_WITH_REASON | Joined EFF_YR_BLT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 51 | `ACT_YR_BLT` | Double(19) | structure | IGNORE_WITH_REASON | Joined ACT_YR_BLT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 52 | `TOT_LVG_AR` (NAL `TOT_LVG_AREA`) | Double(19) | structure | IGNORE_WITH_REASON | Joined TOT_LVG_AREA: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 53 | `NO_BULDNG` | Double(19) | structure | IGNORE_WITH_REASON | Joined NO_BULDNG: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 54 | `NO_RES_UNT` (NAL `NO_RES_UNTS`) | Double(19) | structure | IGNORE_WITH_REASON | Joined NO_RES_UNTS: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 55 | `SPEC_FEAT_` (NAL `SPEC_FEAT_VAL`) | Double(19) | assessment | IGNORE_WITH_REASON | Joined SPEC_FEAT_VAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 56 | `M_PAR_SAL1` (NAL `MULTI_PAR_SAL1`) | String(1) | sale | CANONICALIZE | Joined sale echo (MULTI_PAR_SAL1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 57 | `QUAL_CD1` | String(2) | sale | CANONICALIZE | Joined sale echo (QUAL_CD1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 58 | `VI_CD1` | String(1) | sale | CANONICALIZE | Joined sale echo (VI_CD1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 59 | `SALE_PRC1` | Double(19) | sale | CANONICALIZE | Joined sale echo (SALE_PRC1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 60 | `SALE_YR1` | Double(19) | sale | CANONICALIZE | Joined sale echo (SALE_YR1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 61 | `SALE_MO1` | String(2) | sale | CANONICALIZE | Joined sale echo (SALE_MO1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 62 | `OR_BOOK1` | String(6) | sale | CANONICALIZE | Joined sale echo (OR_BOOK1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 63 | `OR_PAGE1` | String(6) | sale | CANONICALIZE | Joined sale echo (OR_PAGE1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 64 | `CLERK_NO1` | String(20) | sale | CANONICALIZE | Joined sale echo (CLERK_NO1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 65 | `S_CHNG_CD1` (NAL `SAL_CHNG_CD1`) | Double(19) | sale | CANONICALIZE | Joined sale echo (SAL_CHNG_CD1). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 66 | `M_PAR_SAL2` (NAL `MULTI_PAR_SAL2`) | String(1) | sale | CANONICALIZE | Joined sale echo (MULTI_PAR_SAL2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 67 | `QUAL_CD2` | String(2) | sale | CANONICALIZE | Joined sale echo (QUAL_CD2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 68 | `VI_CD2` | String(1) | sale | CANONICALIZE | Joined sale echo (VI_CD2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 69 | `SALE_PRC2` | Double(19) | sale | CANONICALIZE | Joined sale echo (SALE_PRC2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 70 | `SALE_YR2` | Double(19) | sale | CANONICALIZE | Joined sale echo (SALE_YR2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 71 | `SALE_MO2` | String(2) | sale | CANONICALIZE | Joined sale echo (SALE_MO2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 72 | `OR_BOOK2` | String(6) | sale | CANONICALIZE | Joined sale echo (OR_BOOK2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 73 | `OR_PAGE2` | String(6) | sale | CANONICALIZE | Joined sale echo (OR_PAGE2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 74 | `CLERK_NO2` | String(20) | sale | CANONICALIZE | Joined sale echo (CLERK_NO2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 75 | `S_CHNG_CD2` (NAL `SAL_CHNG_CD2`) | Double(19) | sale | CANONICALIZE | Joined sale echo (SAL_CHNG_CD2). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale. |
| 76 | `OWN_NAME` | String(33) | ownership | IGNORE_WITH_REASON | Joined OWN_NAME: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 77 | `OWN_ADDR1` | String(40) | ownership | RESTRICTED | Joined OWN_ADDR1: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 78 | `OWN_ADDR2` | String(40) | ownership | RESTRICTED | Joined OWN_ADDR2: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 79 | `OWN_CITY` | String(40) | ownership | RESTRICTED | Joined OWN_CITY: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 80 | `OWN_STATE` | String(30) | ownership | RESTRICTED | Joined OWN_STATE: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 81 | `OWN_ZIPCD` | Double(19) | ownership | RESTRICTED | Joined OWN_ZIPCD: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 82 | `OWN_STATE_` (NAL `OWN_STATE_DOM`) | String(2) | ownership | RESTRICTED | Joined OWN_STATE_DOM: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 83 | `FIDU_NAME` | String(33) | ownership | RESTRICTED | Joined FIDU_NAME: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 84 | `FIDU_ADDR1` | String(40) | ownership | RESTRICTED | Joined FIDU_ADDR1: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 85 | `FIDU_ADDR2` | String(40) | ownership | RESTRICTED | Joined FIDU_ADDR2: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 86 | `FIDU_CITY` | String(40) | ownership | RESTRICTED | Joined FIDU_CITY: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 87 | `FIDU_STATE` | String(30) | ownership | RESTRICTED | Joined FIDU_STATE: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 88 | `FIDU_ZIPCD` | String(5) | ownership | RESTRICTED | Joined FIDU_ZIPCD: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 89 | `FIDU_CD` | Double(19) | ownership | IGNORE_WITH_REASON | Joined FIDU_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 90 | `S_LEGAL` | String(35) | legal | IGNORE_WITH_REASON | Joined S_LEGAL: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 91 | `APP_STAT` | String(1) | ownership | RESTRICTED | Joined APP_STAT: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 92 | `CO_APP_STA` (NAL `CO_APP_STAT`) | String(1) | ownership | RESTRICTED | Joined CO_APP_STAT: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 93 | `MKT_AR` | String(3) | geography | IGNORE_WITH_REASON | Joined MKT_AR: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 94 | `NBRHD_CD` | String(10) | geography | IGNORE_WITH_REASON | Joined NBRHD_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 95 | `PUBLIC_LND` | String(1) | ownership | IGNORE_WITH_REASON | Joined PUBLIC_LND: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 96 | `TAX_AUTH_C` (NAL `TAX_AUTH_CD`) | String(5) | tax | IGNORE_WITH_REASON | Joined TAX_AUTH_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 97 | `TWN` | String(3) | legal | IGNORE_WITH_REASON | Joined TWN: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 98 | `RNG` | String(3) | legal | IGNORE_WITH_REASON | Joined RNG: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 99 | `SEC` | String(3) | legal | IGNORE_WITH_REASON | Joined SEC: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 100 | `CENSUS_BK` | String(16) | geography | IGNORE_WITH_REASON | Joined CENSUS_BK: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 101 | `PHY_ADDR1` | String(40) | address | IGNORE_WITH_REASON | Joined PHY_ADDR1: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 102 | `PHY_ADDR2` | String(40) | address | IGNORE_WITH_REASON | Joined PHY_ADDR2: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 103 | `PHY_CITY` | String(40) | address | IGNORE_WITH_REASON | Joined PHY_CITY: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 104 | `PHY_ZIPCD` | Double(19) | address | IGNORE_WITH_REASON | Joined PHY_ZIPCD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 105 | `ALT_KEY` | String(26) | identity | IGNORE_WITH_REASON | Joined ALT_KEY: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 106 | `ASS_TRNSFR` (NAL `ASS_TRNSFR_FG`) | String(1) | tax | RESTRICTED | Joined ASS_TRNSFR_FG: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 107 | `PREV_HMSTD` (NAL `PREV_HMSTD_OWN`) | Double(19) | tax | RESTRICTED | Joined PREV_HMSTD_OWN: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 108 | `ASS_DIF_TR` (NAL `ASS_DIF_TRNS`) | Double(19) | tax | RESTRICTED | Joined ASS_DIF_TRNS: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 109 | `CONO_PRV_H` (NAL `CONO_PRV_HM`) | Double(19) | tax | RESTRICTED | Joined CONO_PRV_HM: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 110 | `PARCEL_ID_` (NAL `PARCEL_ID_PRV_HMSTD`) | String(30) | tax | RESTRICTED | Joined PARCEL_ID_PRV_HMSTD: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 111 | `YR_VAL_TRN` (NAL `YR_VAL_TRNSF`) | Double(19) | tax | RESTRICTED | Joined YR_VAL_TRNSF: restricted in the NAL and here. Retained in the archive; reaches no plane from this source. |
| 112 | `SEQ_NO` | Double(19) | provenance | IGNORE_WITH_REASON | Joined SEQ_NO: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 113 | `RS_ID` | String(4) | provenance | IGNORE_WITH_REASON | Joined RS_ID: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 114 | `MP_ID` | String(8) | identity | IGNORE_WITH_REASON | Joined MP_ID: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 115 | `STATE_PAR_` (NAL `STATE_PAR_ID`) | String(18) | identity | IGNORE_WITH_REASON | Joined STATE_PAR_ID: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 116 | `SPC_CIR_CD` | Double(19) | provenance | IGNORE_WITH_REASON | Joined SPC_CIR_CD: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 117 | `SPC_CIR_YR` | Double(19) | provenance | IGNORE_WITH_REASON | Joined SPC_CIR_YR: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
| 118 | `SPC_CIR_TX` (NAL `SPC_CIR_TXT`) | String(50) | provenance | IGNORE_WITH_REASON | Joined SPC_CIR_TXT: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit. |
