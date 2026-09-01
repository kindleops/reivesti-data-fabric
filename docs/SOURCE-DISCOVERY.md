# Source discovery

How the next connector gets chosen from evidence rather than intuition — the
candidate model, the evidence requirement, the platform-family idea that makes
national scale affordable, the ranking, and the first national reconnaissance.

---

## 1. A candidate is not a source

`SourceCandidate` is a **different type** from `SourceDefinition`, not a source
with a status flag. The difference is epistemic:

- A `SourceDefinition` asserts facts the Fabric acts on — this is free, this is
  sanctioned, these are the terms. The runtime consults them before reaching a
  publisher.
- A `SourceCandidate` records **hypotheses** about those facts.

Collapsing the two would let an unverified guess about licensing sit in the field
the automation gate reads. So a candidate's fields are named `costHypothesis`,
`automationHypothesis`, `licenseHypothesis`, and the database table for
candidates deliberately has **no `cost_class` column** — a test asserts it.

### Verification levels

`UNVERIFIED` → `OFFICIAL_PAGE` → `OFFICIAL_DOCUMENTATION` → `VERIFIED` →
`VERIFIED_LIVE`, plus `RULED_OUT`.

Only `VERIFIED` or `VERIFIED_LIVE` may be promoted. `VERIFIED_LIVE` means bytes
have actually been retrieved and parsed.

---

## 2. Evidence

Every claim points at something a reviewer can open: a URL, a **quote** (not a
paraphrase into a conclusion), a retrieval date, and a kind —
`official_authority`, `official_terms`, `official_documentation`, `api_metadata`,
or `secondary`.

`checkPromotion()` requires official (non-secondary) evidence for **cost,
automation, terms and coverage** before a candidate can be promoted. "It's free"
with no link is a rumour, and rumours are how a paid source ends up in a core
pipeline. Vendor marketing and blog posts are recorded as `secondary` and never
satisfy a gate on their own.

---

## 3. Platform families

The single most important idea for national scale.

Hundreds of counties publish parcels through ArcGIS FeatureServer. Open-data
portals cluster into a handful of products. One connector implementation plus
many *configurations* beats many copy-pasted connectors — but only if the
platform is modelled separately from the sources running on it.

| Platform | Reusable? | Where reuse stops |
|---|---|---|
| **Esri ArcGIS FeatureServer / MapServer** | yes | transport, pagination and metadata are identical everywhere; **field names and semantics are not** |
| **ArcGIS Hub DCAT-US catalogue** | yes, for *discovery* | enumerates datasets, licences and service URLs; what it finds still needs verifying |
| **County clerk PDF postings** | no | no shared structure beyond "a PDF on a web page" |

**Same vendor does not mean same schema.** ArcGIS gives a common transport; it
says nothing about whether a county calls its parcel number `PID`, `county_pin`
or `PRINT_KEY`. Acquisition, pagination and drift detection generalise; semantic
normalisation stays per-source. That caveat is a field on the type
(`reuseBoundary`) so it travels with the platform.

### Connector reuse today

DF-0C/0D's streaming ArcGIS transport already speaks `arcgis_feature_service`:
bounded-memory crawling, POST-form queries, pagination, layer-metadata digesting
and drift detection are done. Adding a new ArcGIS parcel source is a field map
and a registry row — which is why every statewide parcel candidate below scores
high on engineering feasibility.

What should **not** be generalised is the semantic layer. The Hennepin connector
knows that `HMSTD_CD1` is a homestead code and that a parcel roll is not a sale;
that knowledge is per-source and belongs there.

---

## 4. Ranking

Deterministic arithmetic over named components — never a learned score. Anyone
who disagrees with a ranking should be able to point at the component they
disagree with, which is trivial with a table and impossible with a model.

**Zero cost is a hard gate, not a weight.** A paid source is not outranked; it is
*excluded*, and the exclusion is reported instead of a score. Making cost a
heavily-weighted factor is precisely how a doctrine erodes.

| Component | Weight |
|---|---|
| jurisdiction leverage | 30 |
| market relevance | 14 |
| capability richness | 12 |
| authority quality | 12 |
| machine readability | 12 |
| automation | 10 |
| engineering feasibility | 8 |
| historical depth | 6 |
| refresh frequency | 6 |

Leverage uses a square root rather than a linear ratio: a statewide source
beating a single county is right, beating it by 254× is not — Dallas alone is
worth more than 254 empty counties.

---

## 5. Workflow

```
df sources candidates              researched candidates and their status
df sources inspect <id|name>       one candidate with all its evidence
df sources verify  <id|name>       what it still needs to be promotable
df sources rank                    zero-cost priority ranking
df sources platforms               shared platform families
df sources coverage <jurisdiction> capability coverage for one place
df sources gaps                    gaps by capability and state
df sources opportunities           verified free candidates not yet built
```

`df sources verify` **reports what is missing; it reaches no publisher.**
Verification is research performed by a person. There is deliberately no
automated discovery bot: crawling the internet looking for government data is
exactly the behaviour the access doctrine exists to prevent.

---

## 6. First national reconnaissance

Checked against official sources on 2026-08-31. The brief was to find
high-leverage free source *families*, not to research 3,222 counties.

### The structural finding

**State governments already aggregate their counties.** Minnesota, Wisconsin and
New York each publish a statewide parcel layer assembled from county submissions
and standardised to a state schema, free. One connector against a state
aggregation is worth dozens against individual counties.

| Candidate | Jurisdictions | Cost | Verification | Score |
|---|---|---|---|---|
| **MN — Parcels, Compiled from Opt-In Open Data Counties** | 87 (59 opted in) | `FREE_OPEN_DATA` | `VERIFIED_LIVE` | **79.55** |
| NY — NYS Tax Parcel Centroid Points | 62 | `FREE_OPEN_DATA` | `VERIFIED_LIVE` | 72.36 |
| WI — Statewide Parcel Map (V12) | 72 | `FREE_PUBLIC_DOWNLOAD` | `OFFICIAL_PAGE` | 64.01 |
| WI — DOR Real Estate Transfer Returns | 72 | `FREE_PUBLIC_DOWNLOAD` | `OFFICIAL_PAGE` | 63.07 |
| TX — Dallas County foreclosure notices | 1 | `FREE_PUBLIC_DOWNLOAD` | `OFFICIAL_PAGE` | 44.16 |
| TX — county appraisal districts (254 CADs) | 254 | `UNKNOWN_COST` | `UNVERIFIED` | **excluded** |

### Minnesota statewide parcels — measured, not assumed

- **2,710,201 parcels**, 59 of 87 counties, one schema (MnGAC Parcel Data
  Standard v1.1.3)
- ArcGIS FeatureServer, `Query,Extract`, `maxRecordCount` 2000, pagination
  supported — **the transport the Hennepin connector already implements**
- 94 fields: owner and taxpayer names, estimated market values, tax year and
  amount, structure characteristics, and `sale_date` / `sale_value`
- Licence: *"None. Please check sources, scale, accuracy, currentness… "*
  Acknowledgement appreciated, not required.
- Hennepin is inside the 59, so it both supersedes and corroborates the existing
  single-county connector.

### New York

5,510,061 parcel centroids across every NY county, 73 ORPTS assessment-roll
fields, ArcGIS FeatureServer, annual. Centroids not polygons — a limitation for
boundary work, irrelevant for identity and attributes.

### Wisconsin

All 72 counties, **twelve annual versions (V1 2015 → V12 2026)** — more statewide
history than anything else found. *"This data is provided free of charge."*
Separately, the DOR publishes historical **Real Estate Transfer Returns**:
Wisconsin's analogue of eCRV, and unlike eCRV it advertises a public download
rather than a request process. A statewide transfer source with stated
consideration is the most valuable capability Reivesti can hold, so this deserves
the next verification pass.

### Texas — the limit that is not about money

Texas is a **non-disclosure state**. Tex. Tax Code § 22.27 shields sale prices
provided to appraisal offices, and governmental entities cannot compel
disclosure. So:

- there is no statewide transfer/sale-economics source, and **no amount of money
  buys one** — this is `UNAVAILABLE` (legal), not `BLOCKED_ON_COST`;
- parcel and assessor data come from 254 independent county appraisal districts,
  each on its own terms — recorded as one `UNVERIFIED` candidate rather than 254
  guesses;
- Dallas foreclosure notices are free to view but posted as individual PDFs by
  city and month: cheap to acquire, expensive to extract, one county.

`LEGAL_CAPABILITY_LIMITS` records the § 22.27 finding, because "keep looking" is
the right answer to a paid source and the wrong answer to a record that does not
lawfully exist.

### Minnesota SOS — no free commercial path

Free bulk business data is available *only* to news media, journalists,
researchers and non-commercial users. Reivesti is a commercial product and does
not qualify. There is no zero-cost path; the source stays `PAID_OPTIONAL` /
`DEFERRED`, and the MBLS public search is **not** scraped as a substitute.

---

## 7. Recommended next connector

**Minnesota statewide opt-in parcels** (`FREE_OPEN_DATA`, ArcGIS FeatureServer,
59 counties, 2.7M parcels).

- Highest ranked, and for reasons visible in the components: 59× the jurisdiction
  leverage of the current Hennepin connector, on a platform whose connector is
  already built and proven at 448,087 parcels.
- Immediately exercises the new machinery for real: 59 property partitions rather
  than one, which is what DF-0G's partitioning exists for.
- Standardised schema across counties means one field map, not 59.
- Zero cost, sanctioned transport, licence read.

Second: **Wisconsin RETR** — verify the download terms, and if free it is the
first statewide *transfer* source in the estate.
