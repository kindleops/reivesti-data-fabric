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
| `carriesRestrictedContact` | Routes payloads to the restricted plane and labels the artifact manifest. |
| `termsStatus` / `licenseStatus` | Recorded on every artifact manifest so a downstream consumer can see the terms the bytes arrived under. |
| `sourcePriority` | 1 = highest. Ordering hint for later resolution when sources disagree. |
| `sourceFamily` | The reusable shape. Sources in one family often share an adapter across jurisdictions. |

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

**MN eCRV is `blocked_on_access`.** The adapter is complete and everything after
retrieval runs today. Moving it to `active` requires exactly two changes, both
recorded in `MN-ECRV.md`: extract access granted by the department, and
`automationStatus` set to `sanctioned` once the delivery mechanism's terms are
reviewed.

---

## 7. Current registry contents

| Source | Scope | Capabilities | Status | Phase |
|---|---|---|---|---|
| MN DOR eCRV Weekly Sales Extract | all MN counties (87) | transfer, deed, mortgage, parcel, contact_enrichment | `blocked_on_access` | DF-0B ✅ |
| Hennepin County assessor | 27053 | parcel, assessor, ownership, tax | `planned` | DF-0C |
| Hennepin County recorded instruments | 27053 | deed, mortgage, mortgage_release, lien | `planned` | DF-0D |
| MN Secretary of State entities | MN (state) | business_entity | `planned` | DF-0E |
| Dallas County foreclosure notices | 48113 | foreclosure_notice | `planned`, jurisdiction not catalogued | DF-0F |

Only `mn_ecrv` has an adapter. The rest exist so the registry shape is exercised
against the real variety of upcoming sources before an adapter locks the design in.
