# National source intelligence — recorded transactions (DF-0Q)

A discovery and planning phase. **No source was activated, nothing was ingested,
no coverage claim and no canonical count changed.** This document is the phase's
report; the code that came with it makes its central claims executable
(`tests/transaction-intelligence.test.ts`).

---

## 0. Read this first: what this phase could and could not establish

| | |
|---|---|
| Revision | worked on `40c7435f80ac2ecdf823f49e1b43e0a7ea5c42b7` (PR #6 merge, DF-0P Florida). **Confirmed current**: `git ls-remote origin refs/heads/main` returned this SHA after operator approval — `main` had not moved. |
| Web access | **None.** This runtime has no fetch, search or browser tool, and neither did a sub-agent probed for one. Not one publisher page, API metadata document or terms page was opened. |
| Consequence | Everything in §5 onwards about external publishers is a **hypothesis from prior knowledge** (to mid-2026). Every DF-0Q candidate is `UNVERIFIED` with **no evidence entries** — a quote not read off a page would be invented, and `checkPromotion` exists to stop exactly that. A test holds this. |
| The brief | arrived truncated mid-§8 ("Model judicial vs n…"). The owner's proposed transaction-weighted scoring model ("below") and anything after §8 were **not received**. §10's score is DF-0Q's own design, built to the constraints the brief did state; it is a separate score, so swapping in the owner's weights later is a table edit. |
| Tests | full suite run on this branch (§12). `tsc` and the PostgreSQL gate could not run: `node_modules` is absent in this worktree and nothing was installed. |

What *was* established firmly is everything that lives in the repository: the
coverage audit (§2), the defects in existing discovery data (§3), the semantic
model (§6) and the scoring (§10).

---

## 1. Grounding facts, checked against `main`

| Claim in the brief | Finding |
|---|---|
| 260 automated-core parcel jurisdictions (59+72+62+67) | **Confirmed**, computed: `automatedCoreJurisdictions(registry, 'PARCEL') = 260`, asserted in `national-integration.test.ts` and again by the DF-0Q audit test. |
| 22,754,931 identities as a sum of separate certifications | **Confirmed** (`NATIONAL-INTEGRATION-CERTIFICATION.md` §15). It is a sum of four certifications; no estate holds all four, and NY↔FL was never measured on one estate. |
| Florida "1,726,769 canonical sale observations including source echoes" | **Number confirmed, wording corrected.** `reference/fl-statewide/2026/estate-report.json`: `sales: 1726769` is the count of canonical sales *after* TRANSACTION_RESOLUTION folds echoes in — echoes are not additional rows. 1,660,005 `SUPPORTED_MATCH` (SDF row + echo), 66,622 `SALE_OBSERVATION_ONLY`, 142 `ECHO_ONLY`. So **1,726,627** rest on an SDF row and **142** exist only as a roll/map echo. None is a deed. |
| True recorded transfer/deed/mortgage/release/lien/foreclosure coverage is 0 | **Confirmed: 0** for each, computed (§2). |

---

## 2. Current coverage on merged `main` (computed, not typed)

`automatedCoreJurisdictions(registry, capability)` for each dashboard
capability, asserted by `tests/transaction-intelligence.test.ts` and confirmed by
running `df national` on this branch (identical totals):

| Capability | National automated core | MN (87) | WI (72) | NY (62) | FL (67) | Where it comes from |
|---|---:|---|---|---|---|---|
| PROPERTY (PARCEL) | **260** | 59 | 72 | 62 | 67 | four statewide parcel/roll sources |
| ASSESSMENT | **260** | 59 | 72 | 62 | 67 | same |
| OWNERSHIP_CURRENT | **260** | 59 | 72 | 62 | 67 | same — the roll's owner, not a grantee |
| TAX | **198** | 59 | 72 | not supported | 67 | NY centroids carry no tax amount |
| SALE_OBSERVATION | **126** | 59 (roll echo) | — | — | 67 (SDF) | MN's is a `TAX_ROLL_SALE_ECHO`; FL's an `ASSESSOR_SALE_OBSERVATION` |
| SALE_ECONOMICS | **67** | eCRV `BLOCKED_ACCESS` | RETR `FIXTURE_ONLY` | — | 67 | FL price is doc-stamp-derived, not declared consideration |
| TRANSFER | **0** | eCRV `BLOCKED_ACCESS` | RETR `FIXTURE_ONLY` | — | — | |
| DEED | **0** | 87 `BLOCKED_ACCESS` ⚠ | — | — | — | ⚠ via eCRV — see finding F4 |
| MORTGAGE | **0** | 87 `BLOCKED_ACCESS` ⚠ | — | — | — | ⚠ via eCRV — see F4 |
| MORTGAGE_RELEASE | **0** | 1 `BLOCKED_AUTOMATION` (Hennepin RecordEASE) | — | — | — | |
| LIEN | **0** | 1 `BLOCKED_AUTOMATION` | — | — | — | |
| FORECLOSURE_NOTICE | **0** | — | — | — | — | TX Dallas: 1 county, `UNKNOWN` (unpriced) |

Every other state is absent from the registry, not "0 % covered".

**Sale observations are not recorded deeds.** The 126 SALE_OBSERVATION counties
are an assessor's statement that a sale happened (FL) or a roll repeating one
(MN). The estate holds **no recorded instrument from any county in the
country**, and no automated transfer declaration.

---

## 3. Defects found in existing discovery data, and what was done

| # | Finding | Action |
|---|---|---|
| F1 | The catalogue's Wisconsin RETR candidate claimed `['transfer', 'deed']`. A RETR is filed *with* a deed and is not one. | **Fixed**: `['transfer', 'sale_economics']`, `transactionSemantics: TRANSFER_DECLARATION`. |
| F2 | `LEGAL_CAPABILITY_LIMITS` listed Texas `deed` as legally unavailable. Tex. Tax Code § 22.27 reaches the *price*; Texas deeds are recorded by 254 county clerks. A legal limit means "stop looking", so this told the reader to stop looking for a record that exists. | **Fixed**: `['transfer', 'sale_economics']`. The existing test (`includes('transfer')`) still holds; a new one asserts deed is absent. |
| F3 | `rankCandidate` scored `manual_only` automation at 0.5 and `unknown` at 0.1 — after DF-0J.1A, the ranking **rewarded** the finding that disqualifies a source. RETR, known since DF-0J.1A to have no unattended path, still ranked 4th in `df sources rank`. | **Gate added, no weight changed**: a candidate known to be `MANUAL_ONLY`/`PROHIBITED_AUTOMATION` (new optional `acquisitionHypothesis`) or `manual_only` is now *excluded*, like a paid one. RETR now records `acquisitionHypothesis: MANUAL_ONLY` and drops out with that reason. A test proves the new fields change no other candidate's score. |
| F4 | The **registry** mapping for eCRV claims `deed` and `mortgage`. eCRV is a transfer declaration: it *names* the deed type and *declares* financing. That is why MN shows DEED and MORTGAGE as 87 `BLOCKED_ACCESS` in §2. The same mapping also claims `parcel`, which is why `df national` shows Minnesota PARCEL as 59 active + **28 `BLOCKED_ACCESS`** — the 28 non-opt-in counties have no blocked parcel source, only a transfer declaration that names parcels. | **Reported, not changed.** Editing a registry mapping changes the coverage table, which this phase may not do. `registrySemanticFindings()` computes it; `df sources transactions` prints it; a test pins it as the only overclaim. Decision for the owner (DF-0R): drop `deed`/`mortgage` from the eCRV mapping, or define the dashboard's DEED as "a conveyance is evidenced". |
| F5 | `df sources opportunities` is commented "verified free candidates not yet built" but filters on cost only, never on verification. | Reported. Harmless today. Unverified DF-0Q leads were kept **out** of `SOURCE_CANDIDATES` for this reason (§5). |
| F6 | The catalogue's Wisconsin statewide parcels candidate still reads `OFFICIAL_PAGE`; the source has been live core since DF-0K. `SOURCE-DISCOVERY.md` §6's score table predates DF-0J.1A. | Reported; historical text left as written. |

---

## 4. The doctrine, as the code now applies it to discovery

A source is production-eligible only when: cost is $0, authority is official,
acquisition is fully automated **and** permitted, terms are compatible,
provenance is reproducible, no human download step, no unapproved credential,
and schema/identity semantics are understood. In code:

| Requirement | Discovery-time gate (DF-0Q) | Registry-time gate (existing) |
|---|---|---|
| $0 | `costHypothesis` zero-cost; paid → EXCLUDED; unknown → queue | `assessActivation` cost gate |
| Permitted automation | `automationHypothesis` `sanctioned`; `prohibited` → EXCLUDED | `BLOCKED_AUTOMATION` |
| Automated mechanism | `acquisitionHypothesis` automated; `MANUAL_ONLY` → EXCLUDED | `BLOCKED_MANUAL_ACQUISITION` (DF-0J.1A) |
| Evidence | `checkPromotion`: official evidence for cost, automation, terms, coverage | — |
| Semantics understood | declared `transactionSemantics` must support every claimed capability | `BLOCKED_SCHEMA` |
| Provenance | — | `BLOCKED_PROVENANCE` |

So the best a candidate can be is **PROMOTABLE**, never "production": schema
and provenance are proven after promotion. Today **no transaction candidate is
promotable** (a test asserts it). Nothing here authorises bypassing
authentication, CAPTCHA, rate limits or terms; impersonating a filing vendor; or
using private endpoints behind a search UI. A public interactive portal is not
permission to automate it.

---

## 5. National survey — 50 states + DC (hypotheses)

Recorded in code as 27 `UNVERIFIED` candidates in
`src/discovery/national-catalogue.ts` and 8 platform families (§7). They are
kept apart from `SOURCE_CANDIDATES`, whose header promises every entry was
checked against an official source.

**Legend.** RI = recorded instrument · TD = transfer declaration · ASO =
assessor sale observation · ECHO = roll sale echo · FN = foreclosure notice · TS
= tax sale · AL = auction listing. *ND* = commonly cited as not requiring sale
price disclosure (only Texas is recorded as a verified legal limit). "Lead" means
a candidate exists in code.

| | Estate today | Recording system | Best transaction lead | Notes |
|---|---|---|---|---|
| AL | — | 67 probate judges | none found | |
| AK | — | **state** Recorder's Office (DNR), by recording district | **Lead**: statewide index (RI) | *ND*; district ≠ borough crosswalk needed |
| AZ | — | 15 county recorders | **Lead**: Maricopa Recorder public API (RI) | Affidavit of Property Value filed with deeds; trustee-sale notices are recorded |
| AR | — | county circuit clerks | none found | |
| CA | — | 58 county recorders | **Lead**: LA Assessor (ECHO, no price) | change-of-ownership statements believed confidential (R&T § 481 — verify before recording as a legal limit) |
| CO | — | 64 clerk & recorders | none found | TD-1000 declaration access unknown |
| CT | — | 169 town clerks | **Lead**: OPM Real Estate Sales (ASO, statewide) | county-equivalents are planning regions; town→region via pinned crosswalk |
| DE | — | 3 recorders | none found | |
| DC | — | Recorder of Deeds (OTR) | **Lead**: ITSPE (ECHO) | one county-equivalent, ArcGIS |
| FL | parcel/roll/SDF 67 | 67 clerks (vendor portals) | **Lead**: clerk auction calendars (AL+TS) | parcels all present, so a listing would link by parcel id; vendor terms govern |
| GA | — | **GSCCCA statewide** | **Lead**: GSCCCA indexes + PT-61 (RI+TD) | hypothesised paid subscription → EXCLUDED until a free route is shown |
| HI | — | **state** Bureau of Conveyances (Regular + Land Court) | **Lead**: statewide index (RI) | two systems → identity must carry the system, as Hennepin's does |
| ID | — | county recorders | none | *ND* |
| IL | — | county recorders/clerks | **Leads**: Cook Assessor sales (ASO); IDOR PTAX-203 (TD) | PTAX may be filing-only |
| IN | — | county recorders | **Lead**: DLGF sales disclosure (TD, statewide) | |
| IA | — | **Iowa Land Records portal** (all 99 recorders) | **Lead** (RI) | account-gated search; needs an export or licence, not automation |
| KS | — | registers of deeds | none | *ND* |
| KY | — | county clerks | none found | |
| LA | — | parish clerks of court | none | *ND* |
| ME | — | county registries | none found | transfer tax declarations to Maine Revenue Services — access unknown |
| MD | — | circuit court land records (MDLandRec) | **Lead**: SDAT roll with recent transfers (ECHO) | also the strongest next PARCEL state; MDLandRec is a viewer, not a distribution |
| MA | — | 21 registry districts | none (MassGIS parcels carry last-sale echoes) | parcel lead, not transactional |
| MI | — | county registers | none found | Property Transfer Affidavits held by local assessors |
| MN | parcel 59 | 87 recorders + registrars | eCRV (TD, `BLOCKED_ACCESS`); Hennepin RecordEASE (RI, prohibited) | an eCRV request still yields MANUAL delivery unless the mechanism is automated |
| MS | — | chancery clerks | none | *ND* |
| MO | — | county recorders | none | *ND* |
| MT | — | clerk & recorders | none | *ND* |
| NE | — | registers of deeds | none in code | Real Estate Transfer Statement (Form 521) — access unknown |
| NV | — | county recorders | none found | Declaration of Value |
| NH | — | county registries | none found | |
| NJ | — | 21 county clerks/registers | **Lead**: SR-1A sales file (TD, statewide) | highest-leverage declaration lead |
| NM | — | county clerks | none | *ND* |
| NY | parcel 62 | NYC City Register (ACRIS) + 57 county clerks; Richmond separate | **Leads**: ACRIS (RI, 4 counties); RP-5217 (TD, 57 counties); DOF sales (ASO) | ACRIS is the strongest RI lead nationally; RP-5217 links on SWIS+SBL, the estate's own identity |
| NC | — | 100 registers of deeds | none found | |
| ND | — | county recorders | none | *ND* |
| OH | — | 88 recorders; auditors take DTE 100 | **Lead**: Franklin Auditor transfers (ASO) | stands for the auditor family |
| OK | — | county clerks | none found | |
| OR | — | county clerks | none found | |
| PA | — | 67 recorders of deeds | **Leads**: Philadelphia RTT (RI+TD); Allegheny sales (ASO), tax liens (RI) | |
| RI | — | 39 municipal land evidence records | none found | |
| SC | — | registers of deeds | none found | |
| SD | — | registers of deeds | none found | |
| TN | — | registers of deeds | none in code | Comptroller assessment data reportedly carries sales — access unknown |
| TX | Dallas FN candidate | 254 county clerks | **Lead**: Harris trustee-sale postings (FN) | § 22.27: price and declaration unavailable; deeds are recorded (F2) |
| UT | — | county recorders | none | *ND* |
| VT | — | town clerks | **Lead**: transfer tax returns (TD) | |
| VA | — | circuit court clerks | **Lead**: Secure Remote Access (RI) | hypothesised paid → EXCLUDED |
| WA | — | county auditors | **Leads**: King Assessor sales (ASO); DOR REET (TD) | |
| WV | — | county clerks | none found | |
| WI | parcel 72 | 72 registers of deeds | RETR (TD, manual-only); WCCA (FN, paid) | |
| WY | — | county clerks | none | *ND* |

Territories: none was found with a comparable official machine-accessible
system, and none was researched further.

### The structural findings

1. **No state publishes a free, automated, statewide recorded-instrument
   index that DF-0Q knows of.** The statewide recording systems that exist —
   Georgia's GSCCCA, Iowa Land Records, Hawaii's and Alaska's state recorders,
   Virginia's SRA — are either priced or are search applications. The one
   large recorded-instrument **distribution** recalled is municipal: NYC's
   ACRIS on Socrata, followed by Philadelphia's.
2. **Statewide transfer declarations are the realistic statewide path**: NJ
   SR-1A, Indiana sales disclosures, NY RP-5217, and the two already known
   (MN eCRV, WI RETR). They give `transfer` + `sale_economics`, **not** deeds or
   mortgages.
3. **Mortgages, releases and liens have no statewide free path anywhere in this
   survey.** They exist only where a recorder's own index is published (ACRIS,
   possibly Maricopa) or a court publishes lien dockets (Allegheny).
4. About a dozen states are commonly described as not requiring price
   disclosure. There, the deed is still recorded; only economics is missing.

---

## 6. Transaction semantics

`src/discovery/transaction-semantics.ts`. Every candidate claiming a
transaction capability declares a class, and a class may claim only what its
records can support (a test checks every catalogued candidate):

| Class | One record means | Is not | May claim | Canonical target today |
|---|---|---|---|---|
| RECORDED_INSTRUMENT | a document of stated type and parties was recorded on a date under a number | a sale or price; proof the grantee still owns; for a mortgage, a debt outstanding; for a release, a sale; for a lis pendens, a foreclosure | deed, mortgage, mortgage_release, lien, foreclosure_notice | `RecordedInstrument` + `InstrumentFamily` |
| TRANSFER_DECLARATION | a party declared a conveyance and its consideration to a revenue authority | the deed; a mortgage record; an arm's-length finding unless stated | transfer, sale_economics | `TransactionEvent` (eCRV/RETR connectors) |
| ASSESSOR_SALE_OBSERVATION | an assessor recorded that a parcel sold, at its price, with its ratio-study judgement | deed consideration; a recording; who bought; a comparable | sale_observation, sale_economics | `SaleObservation` `SALE_OBSERVATION` |
| TAX_ROLL_SALE_ECHO | the roll repeats a prior sale on the parcel | a sale by itself; proof the current owner bought; economics | sale_observation | `SaleObservation` `ASSESSOR_SALE_ECHO` |
| FORECLOSURE_NOTICE | a foreclosure was commenced or a sale scheduled | a completed foreclosure; a sale held; the debt | foreclosure_notice | `DistressEvent` notice_of_default / notice_of_sale / lis_pendens |
| TAX_SALE_EVENT | a delinquency, certificate, forfeiture or tax-deed sale | for a certificate, an ownership change; redemption expiry unless stated | tax_delinquency, tax_sale | `DistressEvent` tax_delinquency / tax_sale |
| AUCTION_LISTING | a property is offered at a stated auction | a sale, a result, the legal notice itself | foreclosure_notice, tax_sale | **none yet** — would need a listing type first |

Only `RECORDED_INSTRUMENT` may claim deed, mortgage, release or lien.

---

## 7. Platform families (transaction-relevant)

| Family | Reusable | Where reuse stops |
|---|---|---|
| ArcGIS FeatureServer *(existing, implemented)* | yes | field semantics per source |
| Government file at a stable URL *(implemented: `bulk-acquisition.ts`)* | yes | discovery and field map per publisher |
| Socrata SODA | yes | **release identity**: a SODA dataset is a mutable table, not a versioned file. The release has to be *our* full export, content-addressed, with `rowsUpdatedAt` + count as the NOOP witness. This is the one design problem to solve before ACRIS. |
| CKAN Action/DataStore | yes | DataStore tables share the Socrata problem; file resources do not |
| CARTO SQL | no | few publishers |
| SharePoint REST listing *(proven for FL DOR)* | no | anonymous listing is per-site configuration |
| Recorder vendor portals | **no** | shared software is not shared permission; per-county terms often forbid automation (RecordEASE). No connector without written sanction or a published export. |
| Court case portals | no | bulk is commonly a paid licence |
| Auction vendor platforms | no | vendor's terms; the official record is elsewhere |

---

## 8. Mortgages and liens

What an instrument-level source must supply before mortgage/lien capability is
claimed — the Hennepin model (`instruments.ts`, `HENNEPIN-RECORDED-INSTRUMENTS.md`)
already has a place for each:

- instrument identity scoped by county **and registration system**, document
  number or book/page;
- recording date (and document date, separately);
- document type, raw and normalised to `InstrumentFamily` by exact label only;
- party roles (mortgagor/mortgagee, assignor/assignee, trustor/trustee/beneficiary);
- the **stated** principal where the instrument states one — never a balance;
- references to prior instruments, which is how a release or assignment is tied
  to its mortgage (ACRIS publishes a References table; Hennepin charges per
  referenced number);
- legal description / parcel reference for property linkage.

Not to be built: balances, payoff estimates, "free and clear" inferences, or
any consumer credit profile. A satisfaction proves a lien was released, not
that a sale happened. UCC fixture filings and federal/state tax liens are
recorded at county level, so they arrive through the same recorded-instrument
path or not at all.

---

## 9. Foreclosure and distress

**Judicial** foreclosure (e.g. NY, NJ, FL, IL, PA, OH, WI, CT): the case filing
and lis pendens → judgment → notice of sale → sheriff/referee sale → deed,
possibly a redemption period. The first official signal is a **court** record.
**Non-judicial** (e.g. TX, CA, AZ, GA, WA, NV, MN by advertisement, MI by
advertisement): notice of default where required → notice of trustee's sale
(recorded and/or posted/published) → trustee sale → trustee's deed. The first
signal is a **recorded or posted notice**. (State classifications are general
knowledge, to verify per state.)

Mapped onto the existing `DistressEventType`: notice_of_default, lis_pendens,
notice_of_sale, foreclosure_sale, tax_delinquency, tax_sale. **Proposed, not
built**: `foreclosure_judgment`, `trustee_deed` / `sheriff_deed` (both are also
RECORDED_INSTRUMENT conveyances), `redemption_expired`, and an auction-listing
event — each a statement of what one record says, none an inference that a
foreclosure completed. Bankruptcy (PACER) is per-page priced and out of
doctrine; newspaper notice aggregators are run by press associations under
their own terms, and are not the authority.

---

## 10. Transaction priority — a separate score

`src/discovery/transaction-priority.ts`, `df sources transactions`. The general
`rankCandidate` weights are **unchanged**.

**Eligibility is a gate with three outcomes**, not a weight:

- `PROMOTABLE` — every discovery gate evidenced (§4). None today.
- `VERIFICATION_QUEUE` — nothing known disqualifies; something unproven. Scored,
  to order the next research pass. Blockers list exactly what is unproven.
- `EXCLUDED` — paid, prohibited, manual-only, ruled out, legally unavailable in
  every state it reaches, or claiming what its semantics cannot support. Score 0.
  An exclusion resting on an unverified hypothesis says so.

| Component | Weight | Meaning |
|---|---:|---|
| semantic value | 24 | RI 1.0 · TD 0.9 · FN 0.7 · TS 0.6 · ASO 0.5 · AL 0.35 · ECHO 0.2 |
| gap closure | 20 | share of (claimed capability × reached county) cells with no automated-core source now |
| jurisdiction leverage | 18 | the general ranking's square-root leverage |
| instrument breadth | 10 | distinct transaction capabilities, of five |
| acquisition readiness | 10 | hypothesised automated mechanism (0.6) + sanctioned permission (0.4) |
| engineering feasibility | 6 | implemented transport 1 · reusable family 0.7 · none 0.4 · non-reusable family 0.3 |
| refresh frequency | 6 | as the general ranking |
| historical depth | 6 | as the general ranking |

Gap closure is why a Florida sale-observation lead scores 0 there (all 67
counties already have one) while a Florida deed source scores 1 (none have
that) — the score steers towards the capability the estate lacks, not towards
another copy of one it has.

### Current queue (computed)

From the test run on this branch (`rankTransactionCandidates` over both
catalogues). Every entry is UNVERIFIED or OFFICIAL_PAGE; the order is **what to
verify first**, not a forecast of what will pass. Iowa's place, for example,
reflects what a statewide recorder index would be worth if an export exists —
the verification question is precisely whether one does.

| # | Candidate | Class | Counties | Score |
|---:|---|---|---:|---:|
| 1 | NYC ACRIS Real Property (Master/Legals/Parties/References) | RI | 4 | 72.20 |
| 2 | Maricopa County Recorder public API | RI | 1 | 65.90 |
| 3 | Iowa Land Records (all 99 recorders) | RI | 99 | 64.44 |
| 4 | Philadelphia Real Estate Transfers (RTT) | RI + TD | 1 | 63.70 |
| 5 | Indiana DLGF sales disclosures | TD | 92 | 62.89 |
| 6 | Allegheny tax liens (filings, satisfactions) | RI | 1 | 62.10 |
| 7 | Alaska State Recorder | RI | 30 | 61.92 |
| 8 | Hawaii Bureau of Conveyances | RI | 5 | 61.66 |
| 9 | Connecticut OPM Real Estate Sales | ASO | 9 | 59.79 |
| 10 | Illinois PTAX-203 | TD | 102 | 58.75 |
| 11 | New Jersey SR-1A | TD | 21 | 58.50 |
| 12 | Cook County Assessor sales | ASO | 1 | 57.50 |
| 13 | NY ORPTS RP-5217 | TD | 57 | 56.97 |
| 14 | Washington REET | TD | 39 | 56.06 |
| 15 | NYC DOF rolling sales | ASO | 5 | 55.48 |
| 16 | Florida clerk auction calendars | AL + TS | 67 | 54.71 |
| 17 | Vermont transfer tax returns | TD | 14 | 54.31 |
| 18 | Allegheny sales | ASO | 1 | 52.10 |
| 19–20 | Harris / Dallas trustee-sale postings | FN | 1 each | 48.30 |
| 21–22 | King County sales; Franklin County transfers | ASO | 1 each | 46.40 |
| 23–25 | Maryland SDAT, DC ITSPE, LA Assessor | ECHO | 24 / 1 / 1 | 45.62 / 44.70 / 43.80 |
| — | **Excluded**: WI RETR (manual-only), WCCA (paid), Virginia SRA (paid), GSCCCA (paid) | | | 0 |

The general ranking, recomputed on this branch: MN parcels 79.55, WI parcels
73.01, NY centroids 72.36, Dallas notices 44.16; WI RETR now **excluded**
(previously ranked with a score), Texas CADs excluded (unpriced) as before.

---

## 11. Roadmap — what DF-0R should be (recommendation; DF-0R not started)

1. **Run a verification pass with web access.** The next step is *reading*,
   not coding: for each of the top queue entries, record official evidence for
   cost, automation, terms and coverage (API metadata JSON, the terms page
   quote, a row count) and move it to `OFFICIAL_DOCUMENTATION`/`VERIFIED` or
   `RULED_OUT`. Start with ACRIS, then the statewide declarations (NJ SR-1A, NY
   RP-5217, IN), then Philadelphia and Maricopa.
2. **If ACRIS verifies: first recorded-instrument source in the estate** (4
   NYC counties), on the Hennepin recorded-instrument model, with a Socrata
   transport that solves release identity (§7) and a BBL → SWIS+SBL crosswalk
   to link to the existing New York parcels.
3. **If a statewide declaration verifies**: first automated `TRANSFER`
   coverage, reusing the eCRV/RETR transfer-declaration model.
4. **Decide F4** (eCRV's deed/mortgage claim) before any recorded-instrument
   source goes live, so DEED means one thing on the dashboard.
5. **Do not** build against GSCCCA, Virginia SRA, WCCA, PACER, recorder vendor
   portals or auction vendor sites, and do not automate any search UI.

Parcel expansion (Maryland, DC, Massachusetts) is real but comes after the
transaction work, per the brief.

---

## 12. Verification and what was not done

- `npm test`, baseline at `40c7435` before any change: 919 tests, 905 pass,
  1 fail, 13 skipped. With DF-0Q: 937 tests, 923 pass, 1 fail, 13 skipped — all 18 new
  tests in `tests/transaction-intelligence.test.ts` pass. The one failure in
  both runs is `migration-execution.test.ts`, which cannot import `pg` because
  `node_modules` is absent in this worktree: environmental and pre-existing.
- `df national` run directly on this branch: totals identical to §2.
- Not run: `tsc --noEmit`, the PostgreSQL gate (no `node_modules`);
  `df sources transactions` directly (still approval-gated) — it is exercised
  through the CLI by a passing test.
- Not done: any publisher contact; any verification-level promotion; any
  registry, mapping, coverage or canonical change; DF-0R.
