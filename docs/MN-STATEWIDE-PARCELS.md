# Minnesota statewide parcels

**Source id:** `mn_statewide_parcels` · **Adapter:** `mn_statewide_parcels` ·
**Mapping:** `mn_statewide_parcels__opt_in_counties` · **Status:** `active`

The Fabric's first real multi-jurisdiction source: **one source definition, 59
county partitions, 2.71 million parcels**, free and sanctioned. It is also the
first source to reach `CORE_ELIGIBLE` through DF-0G's activation evaluator rather
than by predating it.

---

## 1. Authority and access

| | |
|---|---|
| Authority | Minnesota Geospatial Information Office (MnGeo) |
| Dataset | *Parcels, Compiled from Opt-In Open Data Counties, Minnesota* |
| Portal | Minnesota Geospatial Commons |
| Service | `…/us_mn_state_mngeo/plan_parcels_open/FeatureServer`, layer 1 (parcels), layer 0 (per-county metadata) |
| Bulk | `https://operations.gis.data.mn.gov/api/publicdownload/download/511/plan_parcels_open.gpkg` |
| Cost | **$0.** No account, no credentials, no fee. `FREE_OPEN_DATA` |
| Licence | *"None. Please check sources, scale, accuracy, currentness… Acknowledgement of the publisher would be appreciated."* |
| Capabilities | `parcel`, `assessor`, `ownership`, `tax` |
| Aggregation run | 2026-08-06 |
| Feature count | **2,710,201**, verified identical in the service and the bulk file |
| Counties | **59 of 87**, opt-in |
| Schema | MnGAC Parcel Data Standard v1.1.3, 94 attribute fields |

Verified against the publisher on 2026-08-31. `capabilities: Query,Extract`,
`maxRecordCount` 2000, pagination supported, `objectIdField: objectid`, geometry
`esriGeometryPolygon` in EPSG:26915.

### Zero cost, restated

Nothing was purchased, no subscription exists, no API key was issued and no
vendor sits between Reivesti and the state. Compute and storage are
infrastructure costs, not source-data costs. **If MnGeo introduces a required
fee, this source stops being `CORE_ELIGIBLE`** and the doctrine's answer is to
look for another path, not to pay.

---

## 2. Two sanctioned paths, and why the bulk file wins

The publisher offers the same dataset two ways. Both were measured on 2026-08-31:

| Path | Measurement |
|---|---|
| ArcGIS `resultOffset` paging | **37.6 s** per 2,000 rows |
| ArcGIS `objectIds` batching | **51.5 s** per 2,000 rows |
| → full crawl | 1,356 pages ⇒ **14 to 19 hours** of sustained querying |
| **Bulk GeoPackage** | **2,624,212,992 bytes in about two minutes**, one request |

The bulk file is the default acquisition path. Hammering a state government's
query service for most of a day, when that same government publishes the whole
dataset as a file, is neither considerate nor reliable — and the file is not a
workaround, it is a distribution the publisher lists on the dataset itself.

The ArcGIS transport stays implemented and generic. It is the right path for
sources with no bulk distribution, and it is the verification path for this one —
DF-0H ran it live against this layer to prove it works:

| | |
|---|---|
| features requested | 200 (`--max 200`, one page, 1 s rate limit) |
| source reported count | 2,710,201 — reconciled against the live service |
| parsed / accepted / quarantined | 200 / 200 / 0 |
| routed to | `property/us-county-27037` — county routing on live data |
| peak heap | 53 MB |
| **acquisition time** | **224 seconds** |

Two hundred features took nearly four minutes, because the transport enumerates
the layer's object ids before fetching any of them and this layer has 2,710,201
of them. That is a second, independent confirmation of the 14-19 hour estimate,
and it is a property of the *layer's size* rather than of the transport: the same
code crawls Hennepin's 448,087 parcels perfectly well.

### The bundle contract is the boundary

Acquisition is pluggable; nothing downstream is. Both paths emit the same NDJSON
snapshot bundle — header, one feature per line, trailer — so parsing, drift
detection, county routing, partitioning, digesting and replay are identical
whichever way the bytes arrived. The GeoPackage bundle declares its own kind
(`df.gpkg.snapshot/1`) and records the download URL and archive digest in its
header, because claiming bytes came from a crawl when they did not would
misdescribe the artifact's provenance.

Node's built-in `node:sqlite` reads the GeoPackage a row at a time; memory is one
row, never one file.

---

## 3. Reusable ArcGIS runtime versus source semantics

DF-0H audited the DF-0C/0D ArcGIS implementation for what could safely become
generic. The honest finding: **the transport already was.**

| Reusable, unchanged | Source-specific |
|---|---|
| layer metadata fetch and digest | the 94-field map and its dispositions |
| count, OBJECTID enumeration | how a feature parses into a record |
| POST query batching, pagination | what a parcel identifier means |
| retry, throttling, backpressure | which field groups matter |
| streaming archive, checkpoint/resume | semantic normalisation |
| bundle format, trailer detection, drift check, duplicate detection, count reconciliation | capability declarations, restricted fields |

The one genuine refactor was the **parse session**: DF-0C's
`openHennepinStream` turned out to be almost entirely generic snapshot handling,
so it moved to `src/runtime/arcgis-session.ts` and both connectors now supply
four things — a field set, a feature parser, field groups, and what a duplicate
is called. Hennepin's behaviour is unchanged.

What is deliberately **not** generalised is semantic normalisation. A generic
ArcGIS guesser that inferred owner names or parcel numbers from field-name
patterns would be wrong the first time a county named something differently, and
wrong silently. Field maps stay hand-written per source.

---

## 4. Field coverage

All 94 fields are classified in `field-map.ts`: 33 `KEEP_RAW`, 32 `NORMALIZE`,
17 `CANONICALIZE`, 8 `RESTRICTED`, 2 `HISTORIZE`, 2 `IGNORE_WITH_REASON`.

| Group | Fields |
|---|---|
| **Identity** | `co_code` (5-digit FIPS), `county_pin`, `state_pin`, `objectid` |
| **Address** | 17 situs components — house number and affixes, street name/type/directionals, unit, ZIP+4, postal community, CTU |
| **Ownership** | `owner_name`, `owner_more`, `tax_name`, `ownership`, `homestead`; **8 mailing lines → restricted plane** |
| **Assessment** | `emv_land`, `emv_bldg`, `emv_total`, `mkt_year`, `tax_capac`, 4 use classes, 4 exempt classes, `tax_exempt` |
| **Structure** | `year_built`, `fin_sq_ft`, `dwell_type`, `home_style`, `num_units`, garage, basement, heating, cooling |
| **Tax** | `tax_year`, `total_tax`, `spec_asses`, school and watershed districts, Green Acres / Open Space / Ag Preserve |
| **Sale echo** | `sale_date`, `sale_value` — see §5 |
| **Geography** | `co_name`, `ctu_name`, `acres_poly`, `acres_deed`, PLSS section/township/range |
| **Legal** | `lot`, `block`, `plat_name`, `abb_legal` (truncated at 254 chars — not a legal description) |
| **Provenance** | `edit_date`, `exp_date`, `polyptrel`, `n_standard` |

### Not ingested

**Parcel geometry** (`Shape`, MULTIPOLYGON, EPSG:26915) is available and
deliberately excluded: Reivesti has no canonical geometry model, and 2.7 million
polygons would multiply the artifact to store something nothing reads. Recorded
so a future phase adds it deliberately rather than discovering it.

Two fields the direct Hennepin feed does **not** have and this one does:
`fin_sq_ft` and `mkt_year`. The assessment year in particular matters — DF-0C had
to record `assessmentYear: null` for Hennepin because the county layer does not
publish it.

---

## 5. The sale echo is not a sale

The layer carries `sale_date` and `sale_value`. Measured over all 2,710,201 rows:

| | |
|---|---|
| `sale_date` populated | 1,019,065 — **37.6%** |
| `sale_value` populated | 1,434,191 — 52.9% |
| `sale_value = 0` | **464,388** — non-arm's-length transfers are included |
| value with no date | 415,126 |
| `sale_date` range | **1879-07-01 to 3009-12-30** |
| rows per parcel | one — **latest sale only, no history** |

A field whose maximum is the year 3009 contains data-entry errors. A field empty
on 62% of parcels is not a transfer record. And one row per parcel means there is
no history to be had.

So the canonical output is an **`ASSESSOR_REPORTED_SALE_OBSERVATION`**: the
county assessor said a sale happened, on a date they recorded, for an amount they
recorded. It rides in the characteristics, clearly labelled. It does **not** fill
`totalConsideration`, it does **not** set `transferDate`, and the connector emits
no `PROPERTY_SALE_OBSERVED`, `REAL_ESTATE_TRANSFER_OBSERVED` or
`FINANCING_OBSERVED`.

**It does not replace eCRV.** eCRV is a filed declaration of consideration with
statutory backing. This is an assessor's recollection. The coverage graph claims
`parcel`, `assessor`, `ownership` and `tax` — and deliberately not `transfer`,
`deed`, `mortgage` or `foreclosure_notice`.

---

## 6. County routing and participation

`co_code` is a five-digit FIPS supplied by the source, and it is the
authoritative routing key. **The county is never inferred from the address**: a
parcel filed into the wrong county partition would acquire a wrong canonical
property id and never be found again. A row whose county is missing, malformed,
or not a catalogued Minnesota county is quarantined.

Participation is opt-in per county and the publisher states it in layer 0 — one
row per Minnesota county with `gac_open_approval`, the acquisition date, and the
county's own upstream URL. As of the 2026-08-06 run: **59 approved, 28 not**, and
the 59 approved counties exactly match the 59 present in the data. Zero
discrepancy.

`reconcileParticipation()` compares each delivery against the pinned expectation
and reports additions, removals and per-county row-count changes. It never fails
the run: a county opting in is good news, and one opting out is news the operator
must see rather than a crash.

### Freshness varies by more than two years

`acqdate` ranges from **2024-05-20 to 2026-08-06**. "The statewide layer" is not
uniformly fresh, and that is the single most important caveat about it — it is
also the evidence behind the field-authority work below.

---

## 7. Canonical identity

Unchanged and county-scoped: `propertyId = deterministicId('prop',
'county_parcel', countyFips, normalizedParcel)`.

Measured in the real delivery:

- **114,740 parcel-identifier strings are reused across county lines.** Two
  counties using the same PIN string is normal, and county scoping is what keeps
  them distinct properties.
- **62,035 rows share a (county, PIN) pair** — multipolygon parcels, and some
  junk placeholder identifiers (one Stearns County group has 2,381 rows with PIN
  `55`, no owner, zero value). The first row is taken; the rest are counted as
  duplicates and quarantined. Nothing is lost, because geometry is not ingested
  and the attribute content is the same parcel's.
- **18,462 rows carry no `county_pin` at all** and therefore have no identity.
  Quarantined; a surrogate would create a property no county recognises.

The publisher's `objectid` is retained as a source identifier and is never
Reivesti identity: ArcGIS reassigns OBJECTIDs, so it is not stable across
snapshots.

---

## 8. The Hennepin overlap

Hennepin now appears in two legitimate free sources: its own ArcGIS service
(DF-0C/0D) and this aggregation. Both are the county's data. Neither is declared
a blanket winner.

Two findings shape the comparison:

- The statewide layer's Hennepin count is **447,044** against the direct feed's
  **448,087** — a 1,043-parcel difference, so coverage genuinely diverges.
- Layer 0 shows Hennepin's upstream is **`gisdata.metc.state.mn.us`, the
  Metropolitan Council** — not the county directly. The aggregation is a second
  hop, acquired 2026-08-04.

`auditOverlap()` folds both sources' canonical rows, grouped by property, and
measures per field: both-populated, exact match, normalised match, conflict,
only-direct, only-aggregation. Verdicts are derived arithmetically:

| Verdict | When |
|---|---|
| `PREFER_DIRECT_COUNTY` / `PREFER_STATE_AGGREGATION` | only one source populates the field |
| `COEQUAL_OBSERVATIONS` | ≥99.9% agreement — neither is better, and saying so beats inventing a preference |
| `SEMANTICALLY_DIFFERENT` | <50% agreement — too low to be staleness; these fields probably do not mean the same thing |
| `UNRESOLVED` | partial disagreement — needs a dated comparison before a preference is defensible |

**Evidence is never destroyed.** A canonical current value may prefer one source;
both observations remain in the estate with their own provenance. Disagreement is
recorded, not resolved by deletion.

### No supersession

The direct Hennepin connector is **not** retired. `supersessionCheck()` requires
redundancy field-for-field, freshness at least equal, no unique fields lost,
provenance retained, and a documented operational reason — and the database
constraint refuses a row unless all four proofs hold. "Broader coverage" is
deliberately not on the list: breadth is a reason to add a source, never a reason
to remove one. Both sources remain in the coverage graph for Hennepin.

---

## 9. Partitioning

One statewide release updates 59 county partitions. DF-0G's semantics apply
unchanged and honestly:

- Each county's previous projection stays active until its replacement succeeds.
- Activation is **per partition**. A run touching 59 counties performs 59
  independent activations, and if one fails the others are unaffected and
  individually consistent, possibly at different generations. The run records
  each activation's outcome rather than claiming global atomicity.
- A county absent from a delivery produces no rows, is not in the plan, and its
  partition is **not rewritten**.

---

## 10. Historical limitation

MnGeo publishes only the **current** aggregation; no archive of prior runs is
offered. So:

- **Source historical depth: none.** There is no ownership or assessment history
  in this source before Reivesti's first observation.
- **Reivesti-observed history begins at activation.** From the first ingest
  onward, successive monthly snapshots create a history the Fabric owns.

Those are different things and the registry records the first as `null` rather
than implying the second.

---

## 11. Restricted data

Eight mailing fields — four owner lines, four taxpayer lines — are personal data
and go to `data_fabric_restricted.contact_observations` as `mailing_address` with
`permittedUse: record_only`. No canonical row this connector emits has a field
that could hold one, and a party observation carries a name and a role with
`address: null`.

Owner and taxpayer names are canonical party observations with `kind: 'unknown'`:
the roll does not say whether an owner is a person or a company, so neither does
the Fabric. All are `unresolved` — the same name on two parcels is not evidence
of the same party, and organization identity remains a separate national-domain
problem with the paid MN SOS source still deferred.

Fixtures are generated by a committed script from invented names and addresses.
No live owner name or mailing address is committed to this repository.

---

## 12. Measured

Full statewide ingest of the retained 2,526,658,472-byte bundle:

| | |
|---|---|
| source reported / parsed | 2,710,201 / 2,710,201 |
| accepted | 2,648,100 |
| quarantined | 62,101 (43,639 duplicate parcels, 18,462 with no identifier) |
| **reconciliation** | 2,648,100 + 62,101 = 2,710,201 — exact |
| county partitions | 59 of 59; partition rows sum exactly to accepted |
| completeness | `complete` |
| acquire / parse+normalize / project | 17 s / 1,555 s / 831 s |
| **peak heap** | **967 MB** against a 1,024 MB cap |
| contact observations | 8,090,905 (restricted plane) |
| canonical events | 7,174,656 |

**Memory is the phase's real limitation and the margin was too thin.** A replay
of the same artifact under the same 1 GB cap ran out of memory at 2,625,000 rows.
Memory is independent of dataset *bytes* — a 2.5 GB artifact streams through
without being held — but grows with distinct record count at roughly 350 MB per
million rows. See STREAMING-INGESTION.md for the structures responsible and the
fix. 2.7 million rows needs about 1.5 GB to be comfortable.

### Partition isolation, on real counties

Ingesting the 448,087-row direct Hennepin artifact into the completed 59-county
estate rewrote exactly two partitions:

```
rewritten: [ "organization/us", "property/us-county-27053" ]
```

**58 real county partitions: zero writes.** The organization partition is
nation-scoped by design, so it recomputes on any run that names an organization
— the documented cost of that key, not an isolation failure.

### The overlap, measured

443,605 properties observed by both sources; 4,482 only in the direct feed;
3,439 only in the aggregation. **Neither is a superset**, which is on its own
enough to refuse supersession.

| Field | Both | Agreement | Verdict |
|---|---|---|---|
| `normalized_parcel` | 443,605 | 100.00% | COEQUAL |
| `assessment_land` | 443,605 | 99.99% | COEQUAL |
| `assessment_total` / `_building` | 443,605 | 99.97% | COEQUAL |
| `year_built` | 420,222 | 100.00%, +23,383 only in aggregation | COEQUAL |
| `assessor_sale_value` | 443,605 | 99.33% | UNRESOLVED |
| `taxpayer_name` | 443,605 | 99.24% | UNRESOLVED |
| `owner_name` | 443,605 | 99.18% | UNRESOLVED |
| `classification` | 442,980 | 76.84% | UNRESOLVED |
| `tax_year` | 0 — **443,605 only in aggregation** | — | PREFER_STATE_AGGREGATION |
| `situs_address` | 443,605 | 0.00% | SEMANTICALLY_DIFFERENT |
| `parcel_area` | 443,605 | 0.00% | SEMANTICALLY_DIFFERENT |
| `tax_total` | 443,605 | 5.91% | SEMANTICALLY_DIFFERENT |
| `assessor_sale_date` | 390,003 | 0.00% | SEMANTICALLY_DIFFERENT |

The parcel identifier — the thing that makes them the same property — agrees
perfectly, and assessment values agree to within 0.03%. Convergence is sound.

**But three of the four `SEMANTICALLY_DIFFERENT` verdicts are OUR fault, not the
sources'.** `parcel_area` is square feet on one side and acres on the other.
`situs_address` is two different string-assembly conventions in two of our own
normalisers. And `assessor_sale_date` disagrees on 100% of 390,003 parcels while
`assessor_sale_value` agrees on 99.33% — a value cannot match while its date
never does unless the date *formats* differ.

So the audit found something more useful than a ranking between two publishers:
**inconsistent canonicalisation between two Reivesti connectors.** That is
recorded as a P1. It is exactly the class of defect that stays invisible until
two sources describe the same thing, and it is an argument for the overlap audit
existing at all.

### Replay, network off

The retained artifact replayed into a fresh estate with no network access
(`acquire: 1 ms` — the bytes came from the artifact store):

| | original | replay |
|---|---|---|
| artifact sha256 | `5f9251f9…` | **identical** |
| run id | `run_a64397ed…` | **identical** |
| normalized digest | `bbef1b39…` | **identical** |
| global estate digest | `29d0fcbe…` | **identical** |
| parsed / accepted / quarantined | 2,710,201 / 2,648,100 / 62,101 | **identical** |
| per-county output digests | 59 partitions | **59 of 59 identical** |

Peak heap on replay was 1,677 MB against a 2,560 MB cap — higher than the
original 967 MB under a 1,024 MB cap, because V8 defers major collection when it
has room. The working set is genuinely below both figures; what the 1 GB OOM
proves is that the *margin* at that cap is too thin, not that 1.6 GB is retained.

---

## 13. Retention

Retained, because they are the evidence:

- the bulk GeoPackage sha256 `31a5f1c3a32919e242e1d14b7499c8a7eaea2b6f6b3d138b801d9733468a5232`
- the converted snapshot bundle and its archived artifact, with manifest
- the run's normalized digest, the 59 per-county partition digests, and the
  global estate digest
- the pinned layer metadata and field-set digest
- the run report

Regenerable derived projections may be deleted under disk pressure; the artifact
and the digests may not.
