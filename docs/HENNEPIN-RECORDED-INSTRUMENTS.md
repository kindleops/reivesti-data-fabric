# Hennepin recorded instruments — RecordEASE

Source forensics and connector documentation for `mn_hennepin_recorder`.
All findings verified against official Hennepin County and Minnesota sources on
**2026-08-31**.

**Live access status: BLOCKED_ON_SANCTIONED_ACCESS.**

---

## 1. The access finding, first

Hennepin's binding subscription agreement — the *Technology and Information
Subscription Agreement* every RecordEASE subscriber signs — states:

> "SUBSCRIBER shall not access the Information by any means other than the
> Application including but not limited to scraping, robots, wanderers,
> crawlers, spiders, etc"

and separately:

> "neither SUBSCRIBER nor any SUBSCRIBER Personnel shall use, disclose, sell,
> market, distribute or otherwise make available the Information during the term
> of this Agreement or at any time thereafter"

The county's land-title-records page repeats the first point in its own words:

> "Multiple parcel data downloads, screen scraping programs or other computer
> extraction techniques are strictly prohibited. We reserve the right to deny
> access to any individual or party determined to be misusing the site."

This is not a rate limit, a robots.txt, or a technical obstacle to work around.
It is an explicit contractual prohibition on exactly the access a connector needs,
it binds RecordEASE Public and RecordEASE Pro alike, and the second clause
constrains redistribution even of data lawfully viewed.

**So nothing in this repository scrapes RecordEASE, and nothing can.** The
connector ships no HTTP client and no network transport; the registry records
`automationStatus: 'prohibited'`, which makes the runtime refuse any
publisher-reaching transport before a byte moves. Both are asserted in tests.

---

## 2. Every access route, classified

| Route | Available | Finding |
|---|---|---|
| **A. Official bulk feed** | No | None published. |
| **B. Official API / web service** | No | RecordEASE exposes no API. Hennepin's ArcGIS server publishes `BOUNDARIES, CLIMATE, ENVIRONMENT, HEALTH, HEAT_WATCH, LAND_PROPERTY, LANDSLIDE_*, PLACES, TRANSPORTATION` — and `LAND_PROPERTY` contains only Address Points, County Parcels and PLS Points. **There is no recorded-document layer.** |
| **C. Official index export** | No | RecordEASE Pro sells per-item document *viewing*, not index export. |
| **D. Subscription automation** | **Prohibited** | The subscription agreement forbids it in terms. |
| **E. Official data request** | **Yes** | Minn. Stat. ch. 13 (Government Data Practices Act) gives a right to public data, at the actual cost of search, retrieval and copying. `recordsrequest@hennepin.us`. Human process, not machine access. |
| **F. Public UI only** | Yes | And automating it is the thing the agreement forbids. |
| **G. Prohibited** | — | Scraping, robots, wanderers, crawlers and spiders are named explicitly. |

**Chosen route: E.** It is the only lawful high-volume path, and it is a request
made by a person, not a crawl.

### Product and cost

| | |
|---|---|
| RecordEASE Public Search | Free, limited index search. Credentials from `ts.recordease.support@hennepin.us`, ~1 business day. |
| RecordEASE Pro | Per item, no monthly fee: **$2.50** per recorded document, per Torrens certificate of title, per recorded plat. Subscription agreement, 1–2 business days. |
| eRecording | Preferred for commercial filers; documents recorded within 1–3 days of submission. |

---

## 3. Minnesota land-record semantics

Hennepin maintains **two legally distinct registration systems**, and the model
keeps them apart because the law does:

| | Abstract | Torrens (registered land) |
|---|---|---|
| Statute | Minn. Stat. ch. 507 | ch. 508 / 508A |
| Office | County Recorder | Registrar of Titles |
| Evidence of title | The chain of recorded documents | A **Certificate of Title** |
| How a document attaches | Recorded | **Memorialised** on the certificate |
| Numbering | Its own series | Its own series |
| Fee shape | $46; +$10 per referenced number over four on assignments, satisfactions and partial releases | $46; +$20 per additional certificate |

Two consequences the schema enforces:

- **Document number alone is not an identity.** Instrument identity is
  `(countyFips, registrationSystem, normalizedDocumentNumber)`. An Abstract
  `A6000001` and a Torrens `A6000001` are two unrelated documents, and a test
  proves they stay separate.
- **Referenced prior document numbers are a first-class recorder concept**, not
  something we inferred. The county charges per referenced number over four.

`registrationSystem` is never guessed. A delivery that does not state it yields
`unknown`, which narrows what identity and reference resolution may conclude.

---

## 4. Document taxonomy

`src/connectors/mn-hennepin-recorder/taxonomy.ts` — 25 expected types, assembled
from Hennepin's own fee schedule, Minn. Stat. ch. 507/508, and the eCRV Schema 3
`deedTypeCde` enumeration already pinned in DF-0B.

The table is **expected types, not observed counts**. Without sanctioned access
there is no count column that could be filled in honestly, and inventing one
would be worse than leaving it null.

Matching is **exact on the normalized label, or nothing**. No fuzzy matching and
no substring heuristics — `TRANSFER ON DEATH DEED` contains "DEED" and conveys
nothing; `SATISFACTION OF MORTGAGE` contains "MORTGAGE" and creates no lien.
Unrecognised types become family `OTHER` with the raw label preserved and
reported on the run, so a human who has seen real data can extend the table.

### Families and what may be derived

| Family | Semantic effect | Conveyance event? |
|---|---|---|
| `CONVEYANCE` | conveys legal title | **yes** |
| `CONTRACT_FOR_DEED` | creates an equitable interest | no — legal title stays with the vendor |
| `MORTGAGE` | creates a lien | no |
| `MORTGAGE_ASSIGNMENT` | transfers the lender's interest | no — **not a new loan** |
| `MORTGAGE_RELEASE` | discharges a lien | no — **not evidence of a sale** |
| `LIEN` / `LIEN_RELEASE` | creates / discharges a lien | no |
| `FORECLOSURE_RELATED` | varies | no — a Sheriff's Certificate transfers subject to redemption |
| `CORRECTION` | amends a prior document | no — **conveys nothing of its own** |
| `LEASE_RELATED`, `TITLE_RELATED`, `OTHER` | varies | no |

Four types deserve their exclusion spelled out, because a naive rule would treat
each as an ownership change and be wrong every time:

- **Contract for deed** — creates an equitable interest; legal title passes years
  later, on payoff.
- **Transfer on death deed** — conveys nothing until the grantor dies, and is
  revocable until then.
- **Sheriff's certificate of sale** — transfers an interest subject to a
  redemption period.
- **Correction deed** — fixes an error in an earlier document. Counting it would
  invent an ownership change that never happened. The fixture chain includes one
  precisely to prove it does not.

---

## 5. Ingestion contract

No sanctioned machine interface exists, so the adapter is written against a
documented **index-export shape**: NDJSON with a header, one row per recorded
document, and a trailer — the same container DF-0D uses, so the entire
bounded-memory pipeline applies unchanged.

```
line 1     header   source, window, expected record count, declared field set
lines 2..n rows     one recorder index row per document
last line  trailer  delivered count, truncation flag
```

Fields the adapter reads: `documentNumber`, `registrationSystem`,
`certificateOfTitleNumber`, `documentType`, `recordedAt`, `documentDate`,
`parties[]` (role, name, sequence, address), `parcelIds[]`,
`legalDescriptions[]`, `referencedDocuments[]`, `considerationAmount`,
`principalAmount`, `maturityDate`, `bookPage`.

Every one corresponds to something the office demonstrably indexes. What is
genuinely unknown is the **delivery container**, and that is isolated to
`parse.ts` — a different format swaps one file.

### Parsing rules

- **Recording dates keep their stated offset.** Minn. Stat. 508.47 has the
  registrar endorse the date, hour and minute of filing; normalising that to UTC
  would restate a statutory fact.
- **Consideration is only ever an indexed field.** Never parsed from a document
  image, never derived from tax stamps or recording fees.
- **Parcel identifiers must be county-shaped** (13 digits) or they are dropped —
  passing a typo through would create a property.
- **Money** is exact integer minor units via string arithmetic.

---

## 6. Property linkage

| State | Meaning | May move ownership |
|---|---|---|
| `DIRECT_PARCEL` | the index stated a county parcel identifier | **yes** |
| `STRONG_DOCUMENT_PROPERTY_LINK` | the source's own document-to-property index tied them | **yes** |
| `PROVISIONAL` | a legal description parsed confidently to exactly one known property | no |
| `AMBIGUOUS` | several properties fit and none dominates | no |
| `UNRESOLVED` | no defensible link | no |

Address is **never** a property link, at any grade.

The recorder's indexed PID resolves the property to `provisional`, not
`resolved`: the assessor roll is the office that *assigns* parcel numbers, and
the recorder indexes them. When both sources are present the assessor supplies
the authoritative identifier and the property resolves — which is exactly the
DF-0C convergence machinery, unchanged.

### Legal descriptions

Raw text is the record; the parse is a convenience. The parser reports a status
and a confidence, carries a version, and fails open to `unparsed`. Descriptions
that mention several lots, carve an exception, or run to metes and bounds are
capped at low confidence *even when the regexes matched*, because what they
matched is one fragment of something more complicated. Nothing a parse produces
may raise a link above `PROVISIONAL`.

---

## 7. The reference graph

Assignments, satisfactions, releases and corrections name prior documents.
Those pointers are modelled explicitly, and:

> **An unresolved reference is retained, never dropped.**

A 2024 satisfaction referencing a 2009 mortgage is unresolved until backfill
reaches 2009. Discarding the pointer would destroy the lineage at exactly the
moment it was about to become useful. The table stores the document *number* and
resolves the id later; a test ingests the satisfaction alone, confirms the
pointer survives unresolved, then ingests the 2009 mortgage and confirms the same
reference resolves.

A number matching instruments in more than one registration system stays
unresolved with the candidates recorded — two systems means two documents, not an
ambiguity to break by guessing.

---

## 8. Ownership: what may and may not be concluded

DF-0C gave `ASSESSOR_OWNER_OBSERVED` — who the tax roll bills today. DF-0E adds
`CONVEYANCE_OBSERVED` and, from a fold over conveyances, ownership intervals.

Every field is named `observed*` deliberately. An interval with an acquisition
and no disposition means *"we have seen them acquire and have not seen them
convey away"* — which is not "they own it today".

A conveyance contributes to ownership only when **all** of:

1. the family conveys (excludes contract for deed, sheriff's certificate,
   transfer on death deed, correction);
2. the property link is ownership-grade (`DIRECT_PARCEL` or
   `STRONG_DOCUMENT_PROPERTY_LINK`) — a legal-description guess can never rewrite
   who owns something;
3. at least one grantee is named.

A **disposition is only recorded for a grantor already observed acquiring** the
property. Otherwise the estate would assert that someone it never saw acquire had
disposed — which usually just means backfill has not reached their deed.

The assessor owner observation stays separate evidence throughout. Two
vocabularies, deliberately not unified: the roll says who is billed, the recorder
says who signed a document.

---

## 9. Mortgage lifecycle

```
MORTGAGE_RECORDED ──assignment──▶ MORTGAGE_ASSIGNED ──satisfaction──▶ MORTGAGE_RELEASED
```

Held together by the reference graph, and bounded by what the record supports:

- An **assignment is not a new loan.** It moves the lender's interest and carries
  no principal of its own.
- A **satisfaction is not evidence of a sale.** The payoff amount is not
  recorded and the reason is not stated. It commonly follows a sale *or* a
  refinance, and the record does not say which.
- **No payoff amount is ever inferred**, and no profitability or investor status
  is derived from anything here.

Lender lineage is kept separate from property ownership lineage.

---

## 10. Cross-source convergence, and not triple-counting

Three sources can describe one sale:

| Source | Authoritative for |
|---|---|
| eCRV | the sale and its economics |
| Assessor roll | parcel identity, current-roll owner, assessed values |
| Recorder | recording date, document number, document type, parties to the instrument |

Authority is **field-specific**. There is no "recorder beats assessor" rule, and
none of them is authoritative for everything.

Emitting three canonical sales would triple-count every transaction in the
county. Merging them unconditionally would fuse different events that shared a
month. So observations are clustered by property and date proximity and the
cluster is **classified, never merged**:

| State | Meaning |
|---|---|
| `SUPPORTED_MATCH` | two or more independent sources, sharing a party, with no disagreement |
| `POSSIBLE_MATCH` | they fit together but nothing corroborates strongly |
| `CONFLICT` | they cannot all be true of one event — kept, flagged, never resolved by picking a winner |
| `UNRESOLVED` | a single source alone |

The underlying observations are never rewritten. A `CONFLICT` is a durable
statement that the sources disagree, which is far more useful than a silent
choice.

---

## 11. Document images

Not ingested, and deliberately out of scope.

Images are **$2.50 each** and viewing them is what the RecordEASE Pro
subscription sells; bulk retrieval is the prohibited activity. Their storage and
licensing profile is entirely different from index metadata, so image ingestion
belongs behind its own capability and its own decision — not smuggled in as part
of a metadata connector.

Index metadata first. If a structured field turns out to exist only in the image,
that is a finding to escalate, not a reason to start downloading.

---

## 12. Backfill and incremental plan

**Historical backfill** — partition by recording-date range. Each partition
produces its own content-addressed artifact and reconciles against a
count the office states for that window. Resumable, deterministic and
duplicate-safe by construction, because artifact identity is the digest.

**Incremental** — a recording-date watermark with a deliberate overlap window,
never `last_document_number + 1`. Documents are indexed after they are recorded,
corrections arrive late, and monotonic completeness is not something RecordEASE
guarantees.

**Revision vs correction** — two different things, kept apart:
- a *correction instrument* is a new document that references an older one;
- a *source revision* is the office restating an existing index row.

Neither overwrites history.

No window may be called complete without a stated denominator. A delivery whose
declared count does not match what arrived is quarantined, not reported short.

---

## 13. Security

Recorded documents name people and carry their addresses. Two rules hold:

- Party names are canonical observations — as eCRV buyer/seller names already
  are — and every one is `unresolved`. "NORTHSTAR HOMES LLC" and "NORTH STAR
  HOMES, LLC" are two observations. Identity resolution is a later, dedicated
  phase.
- The subscription agreement forbids redistribution of the Information, which
  constrains what any downstream product may expose. `licenseStatus` is
  `restricted` so that constraint travels with the data.

Raw artifacts stay private and server-side. No skip tracing.

---

## 14. Known gaps

1. **No live data has been parsed.** Everything is exercised against synthetic
   fixtures. The delivery format is the honest unknown.
2. **No observed type counts**, for the same reason.
3. **Historical depth is unpublished.** Hennepin's pages do not state how far
   back the index reaches; the data request should ask.
4. **`STRONG_DOCUMENT_PROPERTY_LINK` has no producer yet.** The state exists and
   qualifies for ownership, but nothing emits it until a delivery is seen to
   carry the county's own document-to-property index.
5. **Legal-description matching is not wired to property resolution.** The
   parser, the confidence model and the match key all exist; no code promotes a
   link on them, deliberately, until there is real data to measure against.
6. **The DF-0B `recorded_instruments` placeholder still exists** alongside
   `recorded_instrument_documents`. Consolidating them is a tracked cleanup; a
   `DROP` that ships is a `DROP` that can run somewhere unexpected.

---

## 15. Activation

1. **Request the index** under Minn. Stat. ch. 13 from `recordsrequest@hennepin.us`.
   Ask specifically for: the recording index for a date range; the fields listed
   in §5; whether Abstract and Torrens can be distinguished; whether referenced
   document numbers are included; how far back the index reaches; and the cost
   of search, retrieval and copying.
2. **Record the outcome in the registry** — `termsStatus`, `licenseStatus`, and
   the real delivery mechanism. Do not change `automationStatus` from
   `prohibited` unless the county grants automated access in writing; a
   data-practices delivery is a lawful *file*, not a licence to crawl.
3. **Ingest the delivery:**
   ```
   df stream hennepin_recorder__hennepin --file ./hennepin-index-2024.ndjson --period 2024 --dry-run
   ```
   Confirm `unknownFields` lists only genuinely new document types, and that
   the declared count reconciles.
4. **Extend the taxonomy** for any unrecognised types, then re-run without
   `--dry-run`.
5. **Replay** the artifact and confirm the digests match.

Step 2 is the only step that could ever permit automated retrieval, and it
requires the county to say so.
