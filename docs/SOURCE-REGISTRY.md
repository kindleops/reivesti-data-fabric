# Source Registry

The registry answers a question that must be answerable for jurisdictions we have
not built yet: **what could Reivesti ingest here, and is it allowed to?**

It is independent of every connector implementation. A source can be registered,
reviewed for terms, and scoped to jurisdictions long before an adapter exists.

Code: `src/registry/`. Types: `types.ts`. Seeded data: `sources.ts`.

---

## 1. Jurisdictions

`src/registry/jurisdictions.ts` catalogues the nation, all 50 states plus DC, and
county detail for states a connector has reached. Only Minnesota's 87 counties are
enumerated in DF-0B.

```
us
└── us-mn
    ├── us-county-27001   Aitkin County, Minnesota
    ├── us-county-27053   Hennepin County, Minnesota
    └── … 85 more
```

County reference data (name + FIPS) comes from the U.S. Census Bureau 2020
national county file, retrieved 2026-08-31. The Minnesota county code eCRV uses
(`<countyCde>`, 01–87) is the 1-based alphabetical rank, and the state assigns it
on the same ordering as FIPS, so `fips = 2 × code − 1` holds for all 87 counties
with no exceptions. The table is enumerated explicitly rather than computed, so a
future FIPS revision surfaces as a data change rather than as silently wrong
arithmetic — and the relationship is asserted in tests.

---

## 2. Sources

A `SourceDefinition` records who publishes it, how it is obtained, and on what
terms. The fields that gate behaviour rather than merely describing it:

| Field | Why it matters |
|---|---|
| `automationStatus` | `sanctioned` \| `manual_only` \| `prohibited` \| `unknown`. The runtime refuses any publisher-reaching transport unless this is `sanctioned`. `unknown` is treated as prohibited. |
| `acquisitionClass` | **Whether there is anything to automate**, as opposed to whether automation is permitted. `AUTOMATED_API` \| `AUTOMATED_BULK_DOWNLOAD` \| `AUTOMATED_OPEN_DATA` \| `AUTOMATED_PUBLIC_HTTP` \| `AUTOMATED_BROWSER_ALLOWED` \| `MANUAL_ONLY` \| `PROHIBITED_AUTOMATION` \| `UNKNOWN_AUTOMATION`. Only the five `AUTOMATED_*` classes may carry core coverage; absence is `UNKNOWN_AUTOMATION` and is blocked. See [`AUTOMATED-ACQUISITION.md`](AUTOMATED-ACQUISITION.md). |
| `carriesRestrictedContact` | Routes payloads to the restricted plane and labels the artifact manifest. |
| `termsStatus` / `licenseStatus` | Recorded on every artifact manifest so a downstream consumer can see the terms the bytes arrived under. |
| `sourcePriority` | 1 = highest. Ordering hint for later resolution when sources disagree. |
| `sourceFamily` | The reusable shape. Sources in one family often share an adapter across jurisdictions. |
| `authoritativeForParcelIdentity` | True when the office that *assigns* parcel numbers publishes this feed. Promotes a property from provisional to resolved. Field-specific: it says nothing about who is authoritative for a sale price. |

"Public record" is never treated as "automatable". These are different facts and
the registry keeps them separate.

---

## 3. One source is not one county

This is the point the model exists to get right. Coverage is expressed as a
**scope**, not an enumeration:

| Scope kind | Means | Example |
|---|---|---|
| `nation` | the whole country | a federal dataset |
| `states` | named states, at state level | MN Secretary of State entity registry |
| `all_counties_in_states` | every county in the named states | **MN eCRV: one row covers 87 counties** |
| `counties` | explicit county FIPS | Hennepin assessor |

The registry expands a scope into concrete jurisdictions on demand. Adding an
88th Minnesota county would be a jurisdiction insert, not a mapping migration.

A scope that names jurisdictions the catalogue does not contain **fails loudly**.
Expanding to zero counties would look like a working mapping that ingests
nothing, which is the worst possible failure mode. The Dallas mapping is kept out
of the default registry for exactly this reason — Texas counties are not
catalogued yet — and the failure is asserted in tests.

---

## 4. Shared-platform connectors

Many counties run the same vendor platform. The intended pattern:

- One `sourceFamily` (e.g. `county_recorder_index`).
- One adapter keyed on that family.
- One `SourceDefinition` **per county**, because terms, cost and access are
  negotiated per county even when the software is identical.
- Per-county configuration lives in the mapping's `config`, not in adapter code.

Where a vendor genuinely serves many counties under one agreement, a single
source with a `counties` scope listing them is correct instead.

---

## 5. Capabilities

Declared per source/jurisdiction pairing, because the same publisher often covers
different ground in different counties:

`parcel` · `assessor` · `tax` · `ownership` · `transfer` · `deed` · `mortgage` ·
`mortgage_release` · `foreclosure_notice` · `tax_delinquency` · `tax_sale` ·
`lien` · `business_entity` · `permit` · `code_violation` · `court_event` ·
`contact_enrichment`

`registry.sourcesFor(jurisdictionId, capability)` returns candidate sources in
priority order — the basis for later multi-source resolution.

---

## 6. Activation lifecycle

```
planned ──▶ fixture_only ──▶ blocked_on_access ──▶ active ──▶ retired
```

| Status | Meaning | Runtime behaviour |
|---|---|---|
| `planned` | Modelled; no adapter | **Refuses to run** |
| `fixture_only` | Adapter exercised against fixtures only | Runs on local files |
| `blocked_on_access` | Adapter complete; live retrieval awaits credentials or approval | Runs on operator-supplied files; refuses to reach the publisher |
| `active` | Live retrieval permitted and proven | Runs on schedule |
| `retired` | Stopped | **Refuses to run** |

**Hennepin County Parcels is `active`.** It is a public ArcGIS REST service with
no credentials and no licence, so `automationStatus` is `sanctioned` and the
runtime will reach the publisher. Capabilities are only what the layer actually
carries — `parcel`, `assessor`, `ownership`, `tax`. Deliberately *not* declared:
`deed`, `mortgage` and `foreclosure_notice`. The county runs other systems that
hold those, and this feed is not them.

**Hennepin recorded instruments is `blocked_on_access`, and its `automationStatus`
is `prohibited`** — the only source in the registry so marked. Hennepin's
RecordEASE subscription agreement forbids "scraping, robots, wanderers, crawlers,
spiders" by name, so the runtime refuses every publisher-reaching transport for
it and the connector ships no HTTP client at all. This is the distinction the
`automationStatus` field exists to carry: `manual_only` means "no sanctioned
mechanism yet", `prohibited` means "we have read the terms and they say no".
Activation is a Minn. Stat. ch. 13 data-practices request, not a crawl.

**Minnesota Business Bulk Data is `blocked_on_access`, and its `automationStatus`
is `manual_only`** — and the reason is different again from the other two. There
*is* a sanctioned bulk product: the Secretary of State sells the whole register
for $710 commercially (free for news media, journalists, researchers and
non-commercial use). What cannot be automated is the purchase and the signature
on the Electronic Media License Agreement. So the connector ships no network
transport, and the registry now records the licence itself — the fee schedule,
who gets it free, and the three restrictions that constrain product design — in
`SourceDefinition.licenseTerms`. A licensed source's terms belong next to the
source, not in a contract folder nobody reads before writing a feature.

Three sources, three genuinely different verdicts, all from reading the actual
terms: `sanctioned` (Hennepin parcels), `manual_only` because no mechanism exists
yet (eCRV) or because the mechanism is a purchase (MN SOS), and `prohibited`
because the terms say no (RecordEASE).

**MN eCRV is `blocked_on_access`.** The adapter is complete and everything after
retrieval runs today. Moving it to `active` requires exactly two changes, both
recorded in `MN-ECRV.md`: extract access granted by the department, and
`automationStatus` set to `sanctioned` once the delivery mechanism's terms are
reviewed.

---

## 6a. Cost, role and the zero-cost doctrine

DF-0G added two fields that change how every row here is read.

**`costClass`** says what a source costs, as its own classification —
`FREE_BULK`, `FREE_API`, `FREE_OPEN_DATA`, `FREE_WEB_SERVICE`,
`FREE_PUBLIC_DOWNLOAD`, `FREE_DATA_REQUEST`, `FREE_MANUAL_DELIVERY`,
`FIRST_PARTY`, the three `PAID_*` classes, or `UNKNOWN_COST`. It is deliberately
independent of access type, automation status and licence status: a free source
may forbid automation, and a paid source may be perfectly lawful.

**`role`** says what a source is *for*: `CORE_CANONICAL_SOURCE`,
`CORE_SUPPORTING_SOURCE`, `OPTIONAL_ENRICHMENT`, `VALIDATION_ONLY`,
`MANUAL_RESEARCH_ONLY`, `DEFERRED`, `REJECTED`. A source may not be declared core
until it is known to be free — enforced in `createRegistry()` and by a database
constraint.

Together they make "Reivesti does not pay for core data" checkable rather than
remembered. Full doctrine: [ZERO-COST-DATA-DOCTRINE.md](ZERO-COST-DATA-DOCTRINE.md).

**`accessRequest`** tracks free access paths administratively — `NOT_REQUESTED`
through `DELIVERED`, plus `FEE_QUOTED`, which moves a source out of zero-cost
eligibility the moment a free request comes back with a price.

---

## 7. Current registry contents

| Source | Scope | Capabilities | Cost | Verdict | Status | Phase |
|---|---|---|---|---|---|---|
| MN DOR eCRV Weekly Sales Extract | all MN counties (87) | transfer, deed, mortgage, parcel, contact_enrichment | `FREE_DATA_REQUEST` | `BLOCKED_ACCESS` | `blocked_on_access` | DF-0B ✅ |
| Hennepin County Parcels | 27053 | parcel, assessor, ownership, tax | `FREE_OPEN_DATA` | **`CORE_ELIGIBLE`** | **`active`** | DF-0C ✅ |
| Hennepin County recorded instruments | 27053 | deed, mortgage, mortgage_release, lien | `FREE_DATA_REQUEST` | `BLOCKED_AUTOMATION` | `blocked_on_access` | DF-0E ✅ |
| MN Secretary of State Business Bulk Data | MN (state) | business_entity | `PAID_OPTIONAL` | `DEFERRED` | `blocked_on_access` | DF-0F ✅ |
| **MnGeo statewide parcels** | **59 MN counties** | parcel, assessor, ownership, tax | `FREE_OPEN_DATA` | **`CORE_ELIGIBLE`** | **`active`** | DF-0H ✅ |
| Dallas County foreclosure notices | 48113 | foreclosure_notice | `UNKNOWN_COST` | `BLOCKED_COST_UNKNOWN` | `planned` | modelled |

`mn_ecrv`, `mn_hennepin_assessor`, `mn_hennepin_recorder` and `mn_sos_business` have adapters.
Dallas remains modelled-only, but it is no longer held out of the registry:
DF-0G catalogued every US county-equivalent, so its scope resolves. It stays
`planned` with no declared role, because a source may not be called core until
its cost is known. The runtime still refuses to run it.

**One source, 59 counties.** The Minnesota statewide aggregation is a single
source definition with a single mapping whose scope names 59 county FIPS — not 59
source definitions. It is the reference case for the source/jurisdiction
relationship, and the first source activated by DF-0G's evaluator rather than
before it existed.

**Two sources may cover one place.** Hennepin is covered for `parcel` by its own
county service, by the statewide aggregation and by eCRV. The registry keeps all
three; which is *preferred* is a field-level decision recorded in
`source_field_authority`, never a blanket winner. See
[MN-STATEWIDE-PARCELS.md](MN-STATEWIDE-PARCELS.md).

**Coverage is now reportable nationally.** 3,222 active county-equivalents, of
which exactly one has a core-eligible source. See
[NATIONAL-COVERAGE.md](NATIONAL-COVERAGE.md) and `df coverage`.

---

## `wi_statewide_parcels` (DF-0K)

| | |
|---|---|
| Authority | Wisconsin State Cartographer's Office / Wisconsin Land Information Program (DOA) |
| Family | `state_parcel_aggregation` |
| Cost / acquisition | `FREE_BULK` / `AUTOMATED_BULK_DOWNLOAD`, `sanctioned`, `reviewed_permitted`, `open_with_attribution` |
| Role / verdict | `CORE_CANONICAL_SOURCE` / **`CORE_ELIGIBLE`** (gate: none) |
| Mapping | `wi_statewide_parcels__all_wi_counties` — ONE mapping, 72 counties, `active` |
| Capabilities | `parcel`, `assessor`, `ownership`, `tax` — and deliberately not `transfer`, `deed`, `mortgage`, `lien`, `foreclosure_notice` |
| Cadence / depth | annual (V13 announced for 2027-06-30); V1 (2015) through V12 (2026) published |
| Restricted | `PSTLADRESS` (owner mailing address) |
| Parcel identity | authoritative; `PUNCTUATION_PRESERVING` scheme |

One source, 72 counties, through one mapping — not 72 definitions. See
`WISCONSIN-STATEWIDE-PARCELS.md`.

## `wi_dor_retr_historical` (DF-0J)

Wisconsin Department of Revenue, Real Estate Transfer Return historical data.
The estate's first statewide **transfer** source.

| | |
|---|---|
| costClass | `FREE_PUBLIC_DOWNLOAD` — $0, no account, no CAPTCHA on the download path |
| automationStatus | `manual_only` — permitted, but there is no URL to fetch |
| **acquisitionClass** | **`MANUAL_ONLY`** — session-bound portal, no addressable resource (DF-0J.1A) |
| termsStatus | `reviewed_permitted` — liability disclaimer only, no rights asserted |
| licenseStatus | `public_domain` |
| **role** | **`DEFERRED`** — dormant; contributes no coverage |
| capabilities | `transfer` only |
| jurisdictions | 72 Wisconsin counties, one mapping |
| historicalDepth | 5 years rolling, by month |
| carriesRestrictedContact | **true** — grantor, grantee, agent and tax-bill mailing addresses |
| authoritativeForParcelIdentity | **false** — a declaration states a parcel; it is not the roll |

Deliberately not claimed: `deed`, `mortgage`, `foreclosure_notice`. See
`docs/WISCONSIN-RETR.md` §13 for why each was refused.

## Florida (DF-0M): `fl_statewide_cadastral`, `fl_dor_nal`, `fl_dor_sdf`

Three sources, one publisher library, one engine (`src/connectors/fl-dor/`), each modelled and gated
on its own facts. All three: Florida Department of Revenue, Property Tax Oversight; public PTO Data
Portal; anonymous GETs; `FREE_BULK` / `AUTOMATED_BULK_DOWNLOAD`; terms reviewed and permitting;
public records; quoted fee $0; verdict **CORE_ELIGIBLE** from registry facts alone.

| Source | Capabilities | Authoritative for parcel identity | Restricted contact | Docs |
|---|---|---|---|---|
| `fl_statewide_cadastral` | parcel | yes — the county's own number on its own polygon | no plane: the joined owner/mailing columns are the NAL's | `FLORIDA-CADASTRAL.md` |
| `fl_dor_nal` | parcel, assessor, ownership, tax | yes — the appraiser's roll | mailing, domicile and care-of blocks → restricted plane | `FLORIDA-DOR-NAL.md` |
| `fl_dor_sdf` | sale_observation, sale_economics | no — a sale names a parcel, it never defines one | none: the SDF names no party | `FLORIDA-DOR-SDF.md` |

Two capabilities were added for the SDF, and they are deliberately narrower than `transfer`:
`sale_observation` (an appraiser's record that a parcel sold, in a month, and how the sale was
qualified — not a deed, instrument or declaration) and `sale_economics` (its consideration as the
publisher derives it, from the documentary stamp tax). `deed`, `mortgage`, `lien`,
`foreclosure_notice` and `transfer` are NOT claimed for Florida.
