# Minnesota eCRV — Weekly Sales Extract

Source forensics and connector documentation for `mn_ecrv`.
All findings below were verified against official Minnesota Department of Revenue
material on **2026-08-31**.

---

## 1. Authority

| | |
|---|---|
| Authority | Minnesota Department of Revenue |
| Programme | Electronic Certificate of Real Estate Value (eCRV) |
| Statutory basis | Minn. Stat. § 272.115 |
| Filing trigger | Minnesota real property sold or conveyed for consideration over **$3,000**, including any debt assumed |
| Purpose | The department and the county of sale review eCRV information to verify sale terms and support fair property tax assessment |
| Home page | https://www.revenue.state.mn.us/electronic-certificate-real-estate-value-ecrv |
| Support / access contact | ecrv.support@state.mn.us |

---

## 2. Access mechanism

> "If the public search does not meet your needs, you can request access to the
> Weekly Sales Extract files by contacting ecrv.support@state.mn.us."
> — Minnesota Department of Revenue, eCRV page

| | |
|---|---|
| Mechanism | Zipped folder of XML documents, one document per sale, delivered to approved requesters |
| Cadence | **Weekly** |
| Population | **Only eCRVs accepted by a county or city are included** |
| Live access status | **BLOCKED_ON_ACCESS** — access has not been requested or granted |
| `automationStatus` in registry | `manual_only` |
| Public search UI | https://ecrvsearch.revenue.mn.gov/openCustomSearch |

### What is deliberately *not* done

The public completed-eCRV search UI is **not** scraped, and the connector has no
code path that could. There is a separate sanctioned eCRV Web Services API
(SOAP/WSDL, `apim.revenue.mn.gov`) intended for county and city systems; it is
documented here for completeness but is not used, because it is not the bulk
mechanism and its authorisation model is a county-system one.

While `automationStatus` is anything other than `sanctioned`, the runtime refuses
any transport that reaches the publisher. The only transport wired up is
`local_file`, which reads an extract an operator has already obtained lawfully.

---

## 3. Schema

| Schema | Applies to extracts | Status |
|---|---|---|
| Sample XML Schema | up to 2015-10-05 | historical |
| XML Schema 1 | 2015-10-12 → 2019-08-05 | historical |
| XML Schema 2 | 2019-08-12 → 2020-11-02 | historical |
| **XML Schema 3** | **on or after 2020-11-09** | **pinned and in use** |

Pinned file: `fixtures/mn-ecrv/schema/sales-extract-schema-3.xsd`
Source: `revenue.state.mn.us/sites/default/files/2020-10/Sales Extract Schema3 10-9-2020.txt`
sha256: `2bf2edb3094abc7ce0805f1497978646efda6fab929d1aa7a395f7efe483e820`
Compiled schema digest: `77c2295c9f1dd67e9abac20770991fe731e03258ed719febb41d6b08749f46b3`

The connector compiles the department's own XSD at load time and verifies the
file digest first. A tampered or silently republished schema fails immediately
with `SCHEMA_DRIFT` rather than quietly changing behaviour.

**Historical depth.** Extract schema versions are documented back to 2015-10-12.
The department publishes no retention floor for the extract itself, so
`historicalDepth` is recorded as `2015-10-12` — the earliest period for which a
documented schema exists — not as a claim about what is still obtainable.

### Structure

```
ecrvForm
├── headerForm          countyCde, crvNumberId
├── buyersForm          individuals*, organizations*
├── sellersForm         individuals*, organizations*
├── propertyForm        20 elements incl. parcels*, mnPropertyAddresses*,
│                       plannedUses+, usesBeforeSale+, propertyPrograms?
├── salesAgreementForm  20 elements incl. financeArrangements*, personalProperties*
├── supplementaryForm   15 declaration flags and amounts
└── submitterForm       ← declared with NO content model (xs:anyType)
```

151 leaf elements. Every one has a mapping decision in
`src/connectors/mn-ecrv/field-map.ts`, and a test fails if the schema ever
contains a leaf that does not.

`submitterForm` is genuinely unconstrained by the authority — the XSD declares
`<xs:element name="submitterForm"/>` with no type at all. Its contents are
therefore whatever the department chooses to put there, and it may carry submitter
identity. It is retained verbatim in the restricted plane and never parsed into
canonical fields.

### Published enumerations

| Element | Values |
|---|---|
| `financeType` | `CASH`, `CD` (contract for deed), `MORTGAGE`, `ASSUMED` |
| `deedTypeCde` | `WARRNTY`, `QUITCLAIM`, `TRUSTEE`, `PROBATE`, `PERREPDEED`, `CONFORDEED`, `LIMWARRNTY`, `SPECWARNTY`, `OTHER` |
| `interestRateType` | `FIXED`, `VARIABLE` |
| `paymentFor` | `INTANDPRIN`, `INTONLY`, `PRINONLY` |
| `paymentType` | `MNTLY`, `QRTLY`, `SMANNUAL`, `ANNUAL`, `OTHER` |
| `whatIsIncludedInSale` | `A`, `B`, `L` |
| `parcelProgramCode` | `CRP`, `SFIA`, `WRP` |
| `countyCde`, `county` | `01`–`87` |

A value outside any of these quarantines the run as enum drift.

**On `whatIsIncludedInSale`.** Departmental guidance describes the property type
conveyed as land only, land with buildings, or buildings only, which maps
naturally onto `L` / `A` / `B`. The extract schema does not state the mapping, so
only the **raw code** is treated as authoritative and stored. The label is not
fabricated.

---

## 4. Field coverage

`df fields` prints the full table. Summary of the 151 leaf elements:

| Disposition | Count | Meaning |
|---|---:|---|
| `CANONICALIZE` | 73 | becomes a first-class field or row on a canonical entity |
| `NORMALIZE` | 38 | typed and carried as source-stated characteristics |
| `RESTRICTED_CONTACT` | 15 | routed to the restricted contact plane |
| `KEEP_RAW` | 11 | retained verbatim; no further treatment (all form-local element ids) |
| `IGNORE_WITH_REASON` | 7 | deliberately not carried forward, reason recorded |
| `DERIVE_LATER` | 7 | retained; interpretation deferred rather than guessed |

The seven `IGNORE_WITH_REASON` fields are all form-flow or display flags
(`displayParcel`, `needsAcreageDetails`, `needsBalloonPaymentDate`, …) that
control the state's own web form and say nothing about the property or the sale.

The seven `DERIVE_LATER` fields are the `plannedUses` and `usesBeforeSale`
taxonomy codes. The code list is published with the *web service* schemas, not
with the extract, so the codes are retained and the mapping is deferred rather
than invented.

### Contact-bearing fields (restricted plane only)

`daytimePhone`, `email`, `contactNotes` — on both `individuals` and
`organizations`, for both buyers and sellers (12 paths) — plus
`nonListedComment`, `nonMarketPriceComment` and `submitterForm`.

The two supplementary comment fields are unbounded submitter free text that
routinely names people and describes relationships. They are isolated rather than
published to market intelligence. That is a conservative call: some of their
content is market-relevant, and promoting reviewed content out of the restricted
plane is a later, deliberate decision.

`privateIndicator` marks a party in an address-confidentiality or judicial-privacy
programme. It raises handling requirements (`status: protected_identity`) and is
never a reason to drop the transaction.

---

## 5. County-added data is NOT in the extract

This is the single most important finding, stated by the department directly:

> "Each XML file represents a sale of property and only contains the information
> provided by the submitter; it does not contain any data that may be added by a
> county or city."

Schema 3 bears this out — none of the following appears anywhere in it:

| Absent | Consequence |
|---|---|
| Year built | Comes from an assessor source. DF-0C. |
| Neighborhood code | County assessment neighbourhood. DF-0C. |
| Estimated market value (land / building / total) | County assessor value. DF-0C. |
| Property classification (the D-codes) | County-assigned. DF-0C. |
| **Final parcel IDs** | The extract carries the submitter's **preliminary** PIDs only. Final parcel identity must not be fabricated from them. |
| Sales-ratio study accept/reject + rejection reason | Recorded as `studyEligibilityAvailable: false`, so a later layer cannot read "no rejection" as "accepted". |
| Accept date | The run cannot state *when* a county accepted an eCRV, only that the extract contains accepted eCRVs. |
| Submit date | Absent. `deedContractDate` is the only date the transfer itself carries. |
| Auditor ID | Absent. |
| Sale adjustments | County-entered for the ratio study. |

The public completed-eCRV page and the Weekly Sales Extract are **not** the same
dataset. Anything visible in the public search that is county-added is not in the
extract.

---

## 6. Canonical mapping

| eCRV | Canonical | Note |
|---|---|---|
| `countyCde` + `crvNumberId` | `sourceRecordId` = `MN-<county>-<crv>` | publisher key; evidence, not Reivesti identity |
| `countyCde` | `countyFips`, `jurisdictionId` | via the jurisdiction catalogue |
| `parcels[].parcelId` | `property_identifier[county_parcel]` | `finality: preliminary`, `resolutionState: provisional` |
| `mnPropertyAddresses[]` | `property_identifier[normalized_address]` | **always `unresolved`** — an address never resolves a property |
| `buyersForm` / `sellersForm` | `party_observation` | **always `unresolved`** — a filing is not identity evidence |
| `deedContractDate` | `transaction.transferDate` | wall-clock preserved, never shifted to UTC |
| `deedTypeCde` | `transaction.instrumentTypeCode` | source code, unmapped |
| `totPurchaseAmt` | `transaction.totalConsideration` | exact integer minor units |
| `financeType` + `financeArrangements[]` | `financing_event[]` | `CD` stays `CD` |
| supplementary flags | `transaction.characteristics` | source declarations, uninterpreted |

### Semantics preserved on purpose

- **Contract for deed is not a mortgage.** `financeType = CD` is retained as `CD`.
  Folding it into `MORTGAGE` would erase the distinction that makes the record
  worth ingesting.
- **`principalResidence` is buyer intent about one transaction**, recorded as
  `characteristics.buyer_intends_principal_residence`. It never becomes a standing
  owner-occupancy fact about the property.
- **`relatedInd` is transaction-level.** It never becomes a standing fact about
  either party.
- **`legalActionInd` is not a foreclosure.** It declares that the sale arose from a
  legal proceeding. No `DISTRESS_EVENT` is emitted from an eCRV.
- **Study ineligibility never erases a transaction.** A sale excluded from the
  sales-ratio study still happened.

### Events emitted

| Event | Emitted when |
|---|---|
| `REAL_ESTATE_TRANSFER_OBSERVED` | always, one per filing |
| `PROPERTY_SALE_OBSERVED` | a property resolved **and** consideration > 0 — so a $0 gift is a transfer but not a sale; one event per resolved property |
| `FINANCING_OBSERVED` | a financing arrangement with a principal amount exists — so a declared `CASH` type records the declaration but observes no financing |

Never emitted from an eCRV: `BUYER_IS_INVESTOR`, `CASH_BUYER`, `ACTIVE_BUYER`,
`FORECLOSURE`. Nothing in this record supports them.

### Parsing rules

- **Currency** — exact integer minor units via string arithmetic. `"1234567.89"`
  becomes `123456789`, not the `123456788.99999999` a naive float multiply gives.
  More than two fractional digits is refused, never rounded.
- **Dates** — a `dateTime` with no timezone offset is a wall-clock statement by the
  submitter and is preserved verbatim. Converting a local midnight to UTC can move
  the date by a day, and a transfer date that moves is a different fact.
- **Booleans** — only `true`/`false`/`1`/`0`. Anything else is a parse failure, not
  a silent `false`.
- **Empty** — an empty element is absence, and absence is `null`. Never zero.
- **Multiplicity** — multiple buyers, sellers, parcels, addresses, uses and
  financing arrangements are all preserved as separate rows, never concatenated.

---

## 7. Known gaps

1. **No live extract has been parsed.** Everything is validated against the
   department's XSD and synthetic fixtures. The first live file may reveal
   element ordering, empty-element or encoding conventions the XSD does not
   constrain. Schema-order enforcement can be relaxed per run
   (`validateInstance(..., { enforceOrder: false })`) if the live feed reorders.
2. **Zip layout unverified.** The reader handles nested directories and both
   stored and deflated entries, but the real archive's internal structure and
   file naming are unseen.
3. **Extract size unknown.** Parsing is in-memory per artifact. A statewide weekly
   file is likely tens of MB, which is fine; an annual backfill may need streaming.
4. **`whatIsIncludedInSale` labels** are inferred from departmental guidance, not
   from the extract schema. Only the raw code is stored.
5. **Use taxonomy codes are unmapped** (`DERIVE_LATER`).
6. **Property identity is provisional**, and stays that way until a county source
   confirms a final PID.
7. **Reissue behaviour unknown.** Whether the department reissues a week's extract,
   and whether a corrected eCRV reappears in a later extract, is untested against
   live data. The revision machinery handles both; which one actually occurs is
   unverified.

---

## 8. Exactly how to activate live ingestion

1. **Request access.** Email ecrv.support@state.mn.us for Weekly Sales Extract
   access, stating the intended use.
2. **Review the delivered terms.** Record the outcome in the registry:
   `termsStatus`, `licenseStatus`, and the actual delivery mechanism
   (`accessType`: `bulk_download`, `sftp`, or `object_storage`).
3. **Ingest the first file manually, before automating anything:**
   ```
   df run mn_ecrv__all_mn_counties --file ./extract-2026-W31.zip --period 2026-W31 --dry-run
   ```
   Confirm `rowsQuarantined = 0` and `unknownFields = []`. If the run quarantines
   on drift, the reported unknown fields tell you precisely what changed; update
   the pinned schema, its sha256 and the field map **together**.
4. **Re-run without `--dry-run`**, then replay the artifact and confirm the
   `normalizedDigest` matches.
5. **Only then**, if and only if the department's terms sanction automated
   retrieval: set `automationStatus` to `sanctioned`, wire the matching transport,
   and move the mapping from `blocked_on_access` to `active`.

Step 5 is the only step that permits the runtime to contact the publisher, and it
requires a human decision recorded in the registry.
