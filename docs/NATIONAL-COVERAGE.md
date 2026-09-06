# National coverage

How the Fabric represents "what do we have, for where" across the whole United
States — the jurisdiction catalogue, the coverage matrix, and the projection
partitioning that makes 3,222 county-equivalents tractable.

---

## 1. The jurisdiction catalogue

DF-0B enumerated the nation, the states and Minnesota's 87 counties, on the
reasonable theory that county detail could arrive state by state as connectors
did. DF-0G replaces that with the complete federal geography, for one reason:
**a place that is not in the catalogue cannot be reported as uncovered.** It can
only be reported as absent, which is a different and much less useful answer.

### Built from pinned federal files, never from a remembered number

"How many counties are there" has no stable answer. Connecticut replaced eight
counties with nine planning regions; Alaska reorganises boroughs and census
areas; independent cities appear and consolidate. So the catalogue is *derived*
from two Census files, both retained in `reference/geography/` and **verified by
digest at load**:

| File | Role | sha256 |
|---|---|---|
| `2025_Gaz_counties_national.txt` | the current geography | `1914f0d8…` |
| `national_county2020.txt` | 2020 vintage: legal class codes, island areas, and what changed | `9f6e5f6e…` |

If either file changes, the registry refuses to load rather than quietly
producing a different country.

### What it contains

| | |
|---|---|
| county-equivalents total | **3,244** |
| active | **3,222** |
| replaced | 8 (Connecticut) |
| source legacy | 14 (island areas) |
| state-level entities | 57 (50 states + DC + 6 territory-level) |

Legal forms are **not flattened into "county"**, because they are not counties
and the offices that hold their records differ accordingly:

county 3,007 · municipio 78 · parish 64 · independent city 41 · borough 17 ·
census area 11 · planning region 9 · island 6 · municipality 6 · district 3 ·
federal district 1 · territory 1

### Geography that changes

`ACTIVE` · `REPLACED` · `RETIRED` · `SOURCE_LEGACY`

Retired identities are **retained**. A deed recorded in New Haven County in 2019
was recorded there, and rewriting it to a planning region would falsify the
record.

The eight retired Connecticut counties carry `replacedBy: []` — deliberately
empty. The boundaries do not correspond one-to-one, no federal crosswalk asserts
a mapping, and inventing one would relocate historical records into geographies
that did not exist when they were filed.

The 14 island-area entries are `SOURCE_LEGACY`, not `RETIRED`. They appear in the
2020 codes file and not in the 2025 counties Gazetteer, which is a difference in
that product's **scope** — not evidence that American Samoa ceased to exist.

---

## 2. The coverage matrix

Coverage is a **relationship**, not a source property:

```
SOURCE  ↔  JURISDICTIONS  ↔  CAPABILITIES
```

One source covers one county, 87 counties, a state, several states or the whole
country. Materialising 87 source definitions to describe one statewide feed would
be 87 lies about how many sources exist, so the matrix is derived by expanding a
mapping's scope — exactly as the registry already does.

### Coverage states

| State | Meaning |
|---|---|
| `ACTIVE` | a source is live and producing |
| `READY_NOT_ACTIVATED` | verified and lawful; nobody switched it on |
| `BLOCKED_ON_ACCESS` | free and lawful, waiting on a request or delivery |
| `BLOCKED_ON_TERMS` | the terms forbid the use |
| `BLOCKED_ON_COST` | the only known source costs money |
| `DISCOVERED` | a candidate exists, unverified |
| `UNVERIFIED` | **nobody has looked** |
| `UNAVAILABLE` | someone looked; there is no lawful zero-cost source |
| `DEFERRED` | known and postponed |

**`UNVERIFIED` is not `UNAVAILABLE`.** One is a list of places we have not
researched; the other is a list of places with no data. They need opposite
responses, and collapsing them would make the gap report useless.

Coverage state is *derived* from the doctrine, not set by hand — there is no
independent status field to drift out of agreement with the cost and licence
fields it is supposed to summarise.

### Where things actually stand

3,222 active jurisdictions; **59** have a core-eligible source, all in Minnesota,
after DF-0H activated the statewide parcel aggregation.

| Capability | Covered | Blocked on access | Blocked on terms | Unverified |
|---|---|---|---|---|
| parcel | **59** | 28 | 0 | 3,135 |
| assessor | **59** | 0 | 0 | 3,163 |
| ownership | **59** | 0 | 0 | 3,163 |
| tax | **59** | 0 | 0 | 3,163 |
| transfer | 0 | 87 | 0 | 3,135 |
| deed | 0 | 87 | 0 | 3,135 |
| mortgage | 0 | 87 | 0 | 3,135 |
| business_entity | 0 | 0 | 0 | 3,221 |

Sources: 5 total — 3 zero-cost, 1 paid optional, 1 unpriced, 1 core-eligible.

One source produced 58 of those 59. That is the leverage argument made concrete:
DF-0G ranked the Minnesota aggregation first on measured jurisdiction reach, and
implementing it multiplied covered jurisdictions by 59 without a new transport.

That table is still the honest state of a system with six connectors, not of a
system with national coverage. **Reconnaissance is
not ingestion**, and the report deliberately counts verified core sources rather
than candidates.

Largest gaps by state, for every capability: Texas (254), Georgia (159),
Virginia (133) — simply the states with the most county-equivalents.

---

## 3. Projection partitioning

### The problem

Through DF-0F the resolution projection folded the **entire estate on every run**.
With one county that is invisible. With 3,222 it means a parcel change in
Hennepin recomputes Alaska.

### The key, and the rejected alternatives

A projection can be split into independent folds **exactly where the identity it
computes is independent** — and nowhere else. The key is a claim about the
domain, and a wrong one silently merges or silently separates records.

**Rejected: partition by source.** Property resolution exists precisely to make
the assessor, eCRV and the recorder converge on one property. Partitioning by
source would put three observations of one parcel in three partitions that never
meet — that does not slow convergence, it removes it.

**Rejected: one partition per property.** Correct and useless: the
address-collision pass compares parcels against each other, so a per-property
partition cannot see the conflict it exists to find. Also millions of directories.

**Chosen: by domain, with the scope the domain's identity actually has.**

| Domain | Scope | Why |
|---|---|---|
| `PROPERTY_RESOLUTION` | county | identity is already `propertyId(countyFips, parcel)` — no cross-county fold can change a result |
| `TRANSACTION_RESOLUTION` | county | candidates match within a property |
| `ORGANIZATION_RESOLUTION` | **nation** | a company observed in Hennepin may be registered in Delaware |
| `PERSON_RESOLUTION` | nation | declared; no producer in this phase |

Organization identity is deliberately **not** county-scoped. Scoping it to the
county would make identity depend on where the observation happened to be seen,
which is the definition of a wrong key. A single national partition is not a
solved nationwide identity model — DF-0G does not need one — but it is a key that
will not have to be unwound to build one. The cost is honest: an organization
partition still re-folds nationally, so that fold has not been made cheaper, only
made atomic and digestible.

Partitioning property by county also **fixed a latent bug**: the address-collision
pass grouped on address alone, so "100 Main St" in Hennepin and in Ramsey would
have been reported as one address with rival parcels. The group key now includes
the county, and partitioning makes it unreachable in the normal path anyway.

### Storage

```
var/derived/partitions/property/us-county-27053/
  contributions/<runId>.ndjson    inputs, one immutable file per run
  CURRENT                          -> gen-...
  gen-.../resolutions.ndjson       outputs
         /conflicts.ndjson
         /manifest.json            digests, counts, resolver version
```

**The inputs are partitioned, not just the outputs.** Partitioning only the
output would have left the input scan O(estate), which is most of the cost.
Recomputing Hennepin opens no Ramsey file.

### Planning

A run's affected partitions come from the jurisdictions it **actually observed**,
not from its mapping's declared scope: a statewide source mapped to 87 counties
that delivered one county's rows must recompute one partition, and the declared
scope cannot tell the difference. The plan is computed from output, recorded in
the run manifest, and never inferred from file paths.

### Atomicity

Per partition: a new generation directory, then one atomic rename of `CURRENT` —
the DF-0D mechanism unchanged. A failure leaves that partition's previous
projection intact and visible.

**Across partitions there is none, and saying so plainly beats implying
otherwise.** A run touching three counties performs three independent
activations; if the second fails, the first is live and the third is not. That is
safe *because* partitions are independent: a half-applied run leaves every
partition individually consistent, just at different generations.
`partitionActivations` on the run records exactly which succeeded.

### Digests

Every partition manifest carries an order-independent multiset `inputDigest` and
`outputDigest`, the resolver version, row counts and `activatedAt`. The estate's
digest is `sha256` over sorted `partitionId\toutputDigest` lines.

That is what makes national scale work: **one county changes → one child digest
changes → the global digest changes predictably**, without re-reading a row
anywhere else.

### Measured

Synthetic estates; the assertion is on **writes**, not on wall-clock.

| | 100 counties / 500k rows | 300 counties / 1.5M rows |
|---|---|---|
| whole-estate fold (prior behaviour) | 500,000 rows · 7,585 ms | 1,500,000 rows · 24,507 ms |
| partitioned one-county update | 5,001 rows · **143 ms** | 5,001 rows · **158 ms** |
| unaffected partitions rewritten | **0** | **0** |
| peak heap | 54 MB | 120 MB |

The baseline grows with the estate — 3× the data, 3.2× the time. The partitioned
update does not move: 143 ms → 158 ms. That is O(estate) → O(partition),
measured rather than argued.

One honest cost: a **full** rebuild is about 2× slower partitioned (14.3 s vs
7.6 s at 100 counties) because of per-partition overhead. Rebuilds are rare and
updates are every run, so that is the right trade — but it is a real trade.

---

### Multiple sources per jurisdiction

Hennepin is covered by three sources for `parcel`: its own service, the statewide
aggregation, and eCRV's preliminary parcel identifiers. The coverage graph keeps
all three rather than collapsing them to a boolean, because "who else has this?"
is the question that matters when a source breaks. Which one is *preferred* is a
field-level decision — see `source_field_authority`.

## 4. What is deliberately not solved

- **Nationwide person and organization identity.** One national organization
  partition exists so the architecture does not preclude it. Making it cheaper is
  a later phase.
- **The organization fold is still estate-wide.** Partitioned for atomicity and
  digests, not yet for cost.
- **Coverage for 3,221 jurisdictions.** Honestly reported as `UNVERIFIED`.

---

## Wisconsin transfer coverage (DF-0J)

72 county-equivalents gained the `transfer` capability from a single source,
`wi_dor_retr_historical`. That is the largest single-source jurisdiction gain in
the estate so far, and it is a **different capability** from everything before
it: DF-0D through DF-0I built property state, and this is the first statewide
source of transfer state.

Parcel coverage is **unchanged at 59** Minnesota counties. A transfer
declaration states the parcel the parties named; it is not an assessor's roll,
and it does not cover a county for parcel data. The coverage graph enforces
that distinction rather than trusting anyone to remember it.

| Capability | Covered county-equivalents |
|---|---|
| `parcel`, `assessor`, `ownership`, `tax` | 59 (Minnesota) |
| `transfer` | 72 (Wisconsin) |

Minnesota's own transfer source, eCRV, remains `blocked_on_access`: free by
data request, not yet requested. Wisconsin therefore carries transfer coverage
alone, and the two states currently cover disjoint capabilities.
