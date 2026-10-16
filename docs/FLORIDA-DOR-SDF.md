# Florida DOR Sale Data File (SDF)

**Source id:** `fl_dor_sdf` · **mapping:** `fl_dor_sdf__all_fl_counties` · **scope:** all 67 counties ·
**capabilities:** sale_observation, sale_economics · **gate:** CORE_ELIGIBLE ·
**acquisition:** AUTOMATED_BULK_DOWNLOAD, anonymous GETs, $0 · Main document:
`FLORIDA-STATEWIDE-PROPERTY-FABRIC.md`.

## 1. What a row is — and what it is not

"The SDF includes only parcels that transferred ownership during the year immediately preceding the
January 1 assessment date and the sales that occurred after the January 1 assessment date up to the
required submission date. If a parcel transferred multiple times during that time period, the SDF
lists each separately." (2026 User's Guide, Section 2.)

Every row becomes one **`FL_DOR_SALE_OBSERVATION`**: the property appraiser's record that this parcel
changed ownership in this MONTH, at a price derived from the documentary stamp tax, and how the
appraiser qualified the sale. It is **not**:

- a deed or recorded instrument — the file has no instrument type, grantor or grantee; the book/page
  or clerk number is kept as a reference and no instrument is created from it;
- a transfer declaration — nobody declared anything on it;
- an arm's-length finding or a comparable — see §4;
- a declared consideration — see §3.

The SDF names no party and no address. Nothing in it is restricted.

| Fact | Value (2026 roll, measured 2026-09-29) |
|---|---|
| Files | 67, 34,684,277 bytes zipped; one 23-column layout on every file |
| Rows | 1,726,627 |
| Sale years | 2025: 1,221,543 · 2026: 505,082 · blank: 2 |
| Rows linked to a same-county NAL parcel | 100% |
| Parcels with more than one sale | 238,891 |
| (parcel, SALE_ID_CD) unique | on every row; 8,878 SALE_ID_CD values repeat across parcels in one county |
| Recording reference | book/page 1,207,494 · clerk number 517,298 · neither 1,835 |
| Vacant / improved | V 339,810 · I 1,386,816 · blank 1 |
| Multi-parcel | C 63,369 · D 199,040 |

## 2. Identity

`county + PARCEL_ID (PUNCTUATION_PRESERVING) + SALE_ID_CD` — the appraiser's sale identifier
"remains with the sale for all subsequent SDF submissions", so one sale keeps one identity from the
preliminary roll to the final one. The parcel is length-prefixed in the source record id because both
parts may contain dashes. A row with no SALE_ID_CD is refused: it could not be told apart from the
parcel's other sales.

The SDF never creates a property. Its parcel reference resolves only against the roll or the map;
a sale whose parcel neither lists stays provisional.

## 3. Price

`SALE_PRC` is "the sale price derived from the documentary stamp tax amount" — derived by the
PUBLISHER. It is stored as a `transfer_considerations` row of kind **`SALE_PRICE_DOC_STAMP_DERIVED`**,
exact minor units, `derivationVersion: null` (Reivesti computed nothing). `totalConsideration` on the
transaction stays null, so no query can read a stamp-derived figure as a price the parties stated.
A zero price is a real value (127,410 rows); a blank price is absent with reason `BLANK_SOURCE`
(2 rows). For a qualified multi-parcel sale (code 05) the Department puts the FULL price on every
parcel: it is never summed.

## 4. Qualification codes

The official 2026 list (`src/connectors/fl-dor/qualification.ts`), read exactly. Each code yields:

- the verbatim code;
- a status — QUALIFIED (01–06), DISQUALIFIED (11–14, 16–21, 30–43), PENDING (98, 99), UNKNOWN
  (blank, 15 "removed", anything not on the list);
- the Department's ratio-study statement — INCLUDED (01, 02) or EXCLUDED;
- only the facts the code's own wording states (related party 30, partial interest 16, government
  party 18, financial institution or deed in lieu 12, duress or foreclosure prevention 38, life estate
  14, multi-parcel 05, nominal or non-market instrument 11, …).

There is no GIFT and no FORECLOSURE classification: no code says either. A qualified sale is the
appraiser's ratio-study decision; it is **not** asserted to be a comparable
(`analyticalMetadata.comparable = NOT_ASSERTED`).

| Code | Rows | Code | Rows | Code | Rows |
|---|---:|---|---:|---|---:|
| 01 | 587,911 | 13 | 26 | 34 | 426 |
| 02 | 91,232 | 14 | 84,943 | 35 | 716 |
| 03 | 22,126 | 16 | 11,412 | 36 | 272 |
| 04 | 232 | 17 | 2,906 | 37 | 33,199 |
| 05 | 125,327 | 18 | 16,437 | 38 | 3,550 |
| 06 | 43 | 19 | 14,625 | 39 | 952 |
| 11 | 644,807 | 20 | 103 | 40 | 2,349 |
| 12 | 6,229 | 21 | 359 | 41 | 177 |
| 30 | 51,197 | 31 | 123 | 42 | 11 |
| 32 | 754 | 33 | 496 | 43 | 1,041 |
| 98 | 8,661 | 99 | 13,965 | blank | 20 |

Qualified 826,871 · disqualified 877,110 · pending 22,626 · unknown 20. No code outside the published
list occurs in the 2026 files.

## 5. Dates

`SALE_YR` + `SALE_MO` is a SALE_DATE at MONTH precision, stored as `YYYY-MM`. No day is published and
none is invented: `transferDate` is null, and the event's occurredAt carries `occurredAtPrecision:
'month'`. A sale date is never a recording date, a deed date or an assessment date.

## 6. Convergence

TRANSACTION_RESOLUTION folds, per county and property, the SDF's sales with the NAL's and the
cadastral file's echoes of them: an echo with the same month, price and compatible reference
SUPPORTS the sale (`SUPPORTED_MATCH`); a later release re-stating a sale with different content is
one sale with two statements, the newest governing; nothing an echo says creates a second sale. See
§10 of the main document.

## 7. Field inventory

Generated from `src/connectors/fl-sdf/field-map.ts`.

Disposition counts: {"CANONICALIZE":11,"HISTORIZE":1,"KEEP_RAW":8,"NORMALIZE":3}

| # | Field | Type | Group | Disposition | Meaning and treatment |
|---:|---|---|---|---|---|
| 1 | `CO_NO` | Integer(2) | identity | CANONICALIZE | DOR county number, routed to FIPS through the Department's table. |
| 2 | `PARCEL_ID` | String(26) | identity | CANONICALIZE | The parcel that sold, as the appraiser numbers it. Links to the property the roll created; never creates one. |
| 3 | `ASMNT_YR` | Integer(4) | assessment | HISTORIZE | The assessment year whose submission carried this sale. |
| 4 | `ATV_STRT` | Integer(1) | assessment | KEEP_RAW | DOR active stratum of the parcel. |
| 5 | `GRP_NO` | Integer(1) | assessment | KEEP_RAW | DOR group number of the parcel. |
| 6 | `DOR_UC` | Integer(3) | assessment | NORMALIZE | DOR land use code of the parcel at submission — not necessarily its use when it sold. |
| 7 | `NBRHD_CD` | String(10) | geography | KEEP_RAW | Appraiser neighborhood code. |
| 8 | `MKT_AR` | String(3) | geography | KEEP_RAW | Appraiser market area code. |
| 9 | `CENSUS_BK` | String(16) | geography | KEEP_RAW | Census block group of the parcel centre. |
| 10 | `SALE_ID_CD` | String(25) | sale | CANONICALIZE | The appraiser's own sale identifier; "remains with the sale for all subsequent SDF submissions". With the parcel, the sale observation's identity. |
| 11 | `SAL_CHG_CD` | Integer(1) | sale | NORMALIZE | Sale change code (guide: SAL_CHNG_CD): a significant change between the sale and the assessment date — 1 split … 8 incomplete new construction. |
| 12 | `VI_CD` | String(1) | sale | NORMALIZE | V vacant land / I improved property: what the PRICE included, not what the parcel was. |
| 13 | `OR_BOOK` | String(6) | sale | CANONICALIZE | Official record book. A recording reference, not an instrument. |
| 14 | `OR_PAGE` | String(6) | sale | CANONICALIZE | Official record page. |
| 15 | `CLERK_NO` | String(20) | sale | CANONICALIZE | Clerk's instrument number, where the clerk numbers instruments instead of books and pages. |
| 16 | `QUAL_CD` | String(2) | sale | CANONICALIZE | The appraiser's qualification decision, verbatim, read against the official 2026 list. Not a comparable, not a deed type. |
| 17 | `SALE_YR` | Integer(4) | sale | CANONICALIZE | Sale year. With SALE_MO, a SALE_DATE at MONTH precision; no day exists and none is invented. |
| 18 | `SALE_MO` | Integer(2) | sale | CANONICALIZE | Sale month. |
| 19 | `SALE_PRC` | Integer(12) | sale | CANONICALIZE | Price "derived from the documentary stamp tax amount": SALE_PRICE_DOC_STAMP_DERIVED, exact money, 0 is a value and blank is absent. For a qualified multi-parcel sale (code 05) the FULL price is on every parcel and is never summed. |
| 20 | `MULTI_PAR_SAL` | String(1) | sale | CANONICALIZE | C: parcels of one sale share a clerk instrument number; D: they share a book and page. |
| 21 | `RS_ID` | String(4) | provenance | KEEP_RAW | Submission id shared with the county's NAL of the same submission. |
| 22 | `MP_ID` | String(8) | identity | KEEP_RAW | Master parcel identification code. |
| 23 | `STATE_PARCEL_ID` | String(18) | identity | KEEP_RAW | DOR's uniform statewide parcel code (guide: STATE_PAR_ID). Kept as evidence; the NAL attaches it to the property. |
