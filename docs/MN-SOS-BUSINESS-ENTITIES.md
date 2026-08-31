# Minnesota Secretary of State — Business Bulk Data

**Source id:** `mn_sos_business_entities` · **Adapter:** `mn_sos_business` ·
**Mapping:** `mn_sos__statewide` · **Status:** `blocked_on_access`

The first authoritative source of *organization* identity in the Fabric. Every
prior source names companies — an assessor owner, an eCRV buyer, a recorded
grantee — and none of them can say whether the company exists, when it was
formed, whether it is still registered, or who filed for it. A state register
can.

What this source is **for** is narrow and worth stating up front: giving Reivesti
authoritative evidence about the organizations that *already appear* in county
observations. It is not an entity-merging engine, and DF-0F deliberately resolves
almost nothing (see [Resolution](#resolution)).

---

## 1. Access route

**There is a sanctioned bulk product.** This is the important difference from
Hennepin RecordEASE, where automation is contractually prohibited. Minnesota
sells the whole register.

| Product | What it contains | Price |
|---|---|---|
| **Business Bulk Data** | every business record, active **and inactive** | **$710** commercial, one-time |
| Active Business Data | active registrations only | $30 one-time, or $30/week for refreshes |
| Business name search | a single name lookup | $35 |

Free copies of the bulk data are available to news media, journalists,
researchers and non-commercial requesters, who must agree not to sell or publish
the entirety or any substantial portion of the database.

Delivery is through the **MBLS Portal** (`mblsportal.sos.state.mn.us`): a
registered account buys the product, and the ZIP appears under *Transaction
History*. The file is generated at the beginning of each month. Updates are not
included — they require a separate agreement.

**So the blocker is a purchase and a signature, and neither is something software
may perform.** `automationStatus` is `manual_only`; the connector has no network
transport at all, and the runtime refuses any publisher-reaching transport for
this source. Reivesti does **not** scrape the MBLS public search as a substitute:
that is a different access route under different terms and is not the licensed
product.

### Why not "Active Business Data" at $30?

Because it omits every inactive registration — which is precisely the population
that matters when tracing a dissolved seller entity or a company that stopped
renewing after selling its property. Buying the cheap product would silently
narrow the estate in exactly the place the estate is most useful.

---

## 2. Licence

The delivery arrives under an **Electronic Media License Agreement**, made under
the authority of **Minn. Stat. § 13.03 subd. 3**. Reviewed 2026-08-31. The
operative paragraphs:

> **A.1** — OSS grants to the Licensee a non-exclusive, non-transferable license
> to *publish and make available in the normal course of its business to its
> customers*, subject to paragraph C1, in electronic media readable form, certain
> public records… **Nothing in this agreement prohibits Licensee from charging its
> customers a fee for access to the Records.**

> **C.1** — Licensee shall be allowed to use the Records only in the normal course
> of its business, **except that Licensee may not resell in bulk or repackage in
> bulk any substantial part of the Records.** Licensee shall not sub-license the
> Records without the express written consent of OSS.

Also: **C.2** the Records remain OSS property; **C.7** they may not be presented
as the *Official* records of the office, though a statement that they were
obtained from OSS computerized files is permitted; **B.2** no updates are
included; **B.5** delivery within 10 days of fee clearance; **F** terminable on
notice, with no obligation to delete what was already received.

### What that means for Reivesti

**Materially permissive for the intended use.** Serving a member an answer about
one company — who owns this LLC's registration, when was it formed, is it still
active — is squarely "the normal course of business", and charging for access is
expressly contemplated. What is forbidden is *shipping the register*.

The boundary is therefore not "may a member see this field?" but **"is this a
derived answer about one entity, or a redistribution of the database?"**. That
judgement is encoded per row rather than left implicit:

| `LicenseClass` | Meaning |
|---|---|
| `RAW_LICENSED` | the delivered bytes. Server-side only; never served to anyone. |
| `NORMALIZED_PRIVATE` | parsed rows, one-to-one with the delivery. Internal processing. |
| `CANONICAL_INTERNAL` | canonical entities and resolution evidence. Internal use. |
| `DERIVED_MEMBER_SAFE` | a derived answer about a specific entity, in the normal course of business. |
| `PUBLIC_SAFE` | **nothing in DF-0F is classified this way.** |

The registry carries the terms too (`SourceDefinition.licenseTerms`), so the
constraint sits next to the source rather than in a contract folder nobody reads
before writing a feature. A delivery whose manifest declares terms that do *not*
permit serving customers **quarantines the run before a single row is read**.

Nothing in this phase redistributes anything, so no licence limit is currently
being approached. The limit to watch is bulk export: any future feature that
would hand a member more than an answer about specific entities needs the terms
re-read first.

---

## 3. The delivered file

**One heterogeneous CSV inside a ZIP.** Uncompressed it may exceed **2.5 GB**.
Fields are enclosed in double quotes; an embedded quote is doubled.

Three record types share the file, distinguished by **column 2**, each with a
different column count, all keyed by **Master ID** — a 36-character GUID that is
static, unique, and never recycled.

| Type | Rows | Columns |
|---|---|---|
| `01` | master: one per registration | 22 |
| `02` | filing history | 9 |
| `03` | name / address | 15 |

Column layouts and the Appendix II vocabularies (17 business types, 10 party name
types, 17 address types) are transcribed verbatim in
[`src/connectors/mn-sos-business/domain.ts`](../src/connectors/mn-sos-business/domain.ts)
and pinned by digest. A delivery declaring a different implementation-guide
version quarantines the run — reading a positional CSV against a layout the
publisher has changed is precisely the failure that must never be silent.

### Three properties of the data that shaped the model

**Names and addresses are CURRENT ONLY.** The `03` rows carry what was active
when the file was generated. There is no name history in the delivery, so the
connector emits **no `PRIOR_NAME` observations at all**. A name history is a
Reivesti derivation across monthly deliveries; claiming one from a single file
would be a fabrication. A *name change* is nonetheless visible — as a `02` filing
with action `Name Change`, which is a fact the file does state.

**An assumed name is its own master row** (business type `59`), with no documented
link back to the business that filed it. None is invented. The assumed-name
record becomes an entity in its own right, flagged `is_legal_entity: false`, and
any connection to a parent is left to the evidence-scored resolver where it can
be reviewed.

**The file is not promised to be grouped or sorted.** So the parser does not
assume it is — see below.

---

## 4. Ingestion

Bounded memory throughout, using the DF-0D streaming machinery unchanged.

```
manifest (line 1)  →  CSV rows  →  external sort by Master ID  →  grouped records
```

Rows are spilled to a **disk-backed external sort keyed by Master ID** and read
back as complete groups. Peak memory is one sort chunk plus one business, never
the register. This buys order-independence for free: any permutation of the input
file yields byte-identical canonical output, which is asserted in tests against a
deliberately reshuffled copy of the same delivery.

Nothing is dropped. Three kinds of bad row become **quarantined records** with a
stated reason, so the run report accounts for every row in the delivery:

- a row that cannot be parsed (wrong width, undocumented record type)
- an **orphan** — a filing or name row whose master is absent
- a **duplicate master** — a Master ID on two master rows, which contradicts the
  guide's own uniqueness statement

Unknown domain codes are a different case: they are **reported and retained**,
never mapped to a nearest neighbour and never a reason to fail. Appendix II is a
snapshot of a live register that adds codes.

### Proven at register scale

The real register is roughly a million businesses. The nearest honest proof
available without the licensed file is a synthetic register of the same shape,
generated at 300,000 businesses and **deliberately written ungrouped** so the
sort is doing real work:

| | |
|---|---|
| businesses | 300,000 |
| CSV rows | 1,200,000 |
| delivery bytes | 170,436,210 |
| heap cap | 768 MB (`--max-old-space-size=768`) |
| **peak heap** | **151 MB** |
| heap across the crawl | flat, 48–90 MB |
| parse + normalize | 101 s |
| organization-link projection | 28 s |
| entities emitted | 300,000, zero quarantined |
| digest at `sortChunkLines` 50,000 and 5,000 | identical (`ec2a37c1…`) |

Nothing about that scales with the register: memory is one sort chunk plus one
business, and the link projection is a sort-merge join, not an index.

That run found a real defect worth recording. `externalSort` named its spill
directory `sort-<pid>-<timestamp>`, so two sorts started in the same millisecond
shared a directory and clobbered each other's `run-N.ndjson` files. It had never
fired, because every earlier use was sequential — the organization-link join is
the first place one sort feeds another. It surfaced as a JSON parse error a
million rows in, and is fixed with a process-local counter.

### Operator procedure

The connector consumes a **delivery bundle**: the manifest as line 1, then the CSV
verbatim.

```sh
unzip -p business_bulk_data.zip business_bulk_data.csv > /tmp/mn-sos.csv
cat delivery-manifest.json /tmp/mn-sos.csv > /var/df/mn-sos-2026-08.bundle
node src/cli/df.ts stream mn_sos__statewide --file /var/df/mn-sos-2026-08.bundle --period 2026-08
```

The manifest records what was bought, under which agreement, when the publisher
generated the file, and the archive's sha256. It is line 1 rather than a sidecar
so the licence travels *inside the immutable artifact*, and so drift and licence
checks happen before any row is read. The concatenation costs one extra copy of
the file on disk; the intermediate can be removed once the run has archived.

`fileGeneratedAt` from the manifest — not the ingestion clock — is the
`observedAt` on every name and address, because that is when the register says
they were true.

---

## 5. Snapshot semantics

The bulk file restates the whole register each month, so it is a `snapshotSource`
and absence detection applies. A Master ID present in July and gone in August is
recorded as **absent from the delivery**.

That is a fact about the *delivery*, not about the company. A registration that
leaves the file has not necessarily ceased to exist, and nothing downstream may
read it as a dissolution. The absence rows contain no such word, and a test
asserts it.

Field-group digests (`identity`, `status`, `filings`, `names`, `addresses`,
`parties`) let a run report *what kind* of thing changed — 900 status changes and
12 name changes, not 912 rows.

---

## 6. Resolution

The whole point of this section is one distinction:

> **Candidate generation is not resolution.** Generating a candidate costs nothing
> and can be wrong. Resolving asserts that two records are the same legal entity,
> and a wrong assertion silently corrupts every downstream conclusion about who
> owns what.

Name normalization ([`name-normalization.ts`](../src/canonical/name-normalization.ts))
exists **only** to generate candidates. It folds case, punctuation, `&`/`AND`, and
suffix spellings — `L.L.C.`, `LLC`, `L L C`, `LIMITED LIABILITY COMPANY` all
become `LLC`. The suffix is *kept*: `SMITH LLC` and `SMITH INC` are different
companies. There is deliberately **no phonetic matching, no edit distance, no
token dropping and no stemming** — each merges companies that are genuinely
different, and a false merge is worse than a miss.

A second, weaker key removes internal spaces, which is what makes
`NORTH STAR HOMES LLC` and `NORTHSTAR HOMES LLC` collide. It may propose a
candidate and may never resolve one.

### The rules DF-0F actually ships

| Evidence | Strength | Resolves? |
|---|---|---|
| `EXACT_SOURCE_ID` — the observation carried the registry's own id | decisive | **yes** |
| `EXACT_LEGAL_NAME_UNIQUE` — exact normalized name, unique statewide | strong | no (rule disabled) |
| `EXACT_ADDRESS`, `PRIOR_NAME_MATCH`, `ASSUMED_NAME_MATCH`, `MULTI_SOURCE_CORROBORATION` | supporting | no |
| `COMPACT_NAME`, `EXACT_LEGAL_NAME_AMBIGUOUS` | weak | no |

`DEFAULT_RULES` is `{ allowUniqueLegalName: false, requireAddressCorroboration: true }`.
**Only an exact registry identifier resolves.** Everything else produces a
candidate and a `provisional`, `ambiguous` or `unresolved` decision with its
evidence retained.

That is conservative *by construction, not by timidity*: enabling the unique-name
rule is a decision to be made **after** measuring name collisions in the real
register, and `measureNameCollisions()` exists to measure them — streamed and
externally sorted, over the whole file, when a licensed delivery arrives. Picking
a rule first and hoping the data fits is how false merges get shipped.

Every decision carries its evidence, its candidate set and the resolver version
that made it, so a better resolver supersedes an earlier judgement instead of
pretending it never happened. Decisions live in
`var/derived/entity-links/current.ndjson` and in `business_entity_links`, keyed
`(party_observation_id, resolver_version)`.

The projection itself
([`organization-projection.ts`](../src/canonical/organization-projection.ts)) is a
two-pass disk-backed sort-merge join. Nothing indexes the register in memory.

### Collision measurement

`measureNameCollisions()` streams the whole register — externally sorted, no
in-memory index — and returns the numbers a name rule has to be justified by:
distinct legal names, distinct normalized names, distinct compact names, how many
entities sit in a name collision, how many addresses are shared, the largest
collision, and the statewide uniqueness rate.

**It has not been run on the real register, because the licensed delivery has not
been purchased.** On the 18-entity synthetic fixture — built to contain
collisions deliberately, so this is a lower bound on messiness, not an estimate:

| | |
|---|---|
| entities | 18 |
| distinct normalized names | 16 |
| normalized names shared by >1 entity | 2 (4 entities) |
| compact-key collisions | 3 (6 entities) |
| addresses shared by >1 entity | 2 |
| normalized uniqueness rate | 0.7778 |

The real numbers are the ones that matter and they are step 5 of the activation
checklist.

---

## 7. Refresh strategy

The bulk file is a monthly regeneration and **updates are not included** — B.2 of
the agreement makes them a separate arrangement. So there are three options, and
the choice is deliberately deferred until real data exists:

**Monthly bulk re-ingest.** Buy the file again, ingest it as a new snapshot. The
runtime already handles this: unchanged entities cost nothing, changes surface as
field-group deltas, and absences are recorded as absences. This is the honest
default and needs no new machinery.

**Active Business Data as a supplement** ($30 one-time, or $30/week). It carries
active registrations only, so it can never *replace* the bulk file — the inactive
population is exactly what matters when tracing a dissolved seller entity, and a
weekly diet of active-only data would slowly rot the estate's view of everything
that lapsed. Its honest role is a **freshness supplement between bulk deliveries**:
useful for catching a newly formed LLC quickly, never authoritative about absence.
Consuming it would need one change the model already anticipates — a delivery that
covers a subset must not drive absence detection, so it would be ingested as a
non-snapshot release.

**Targeted name search** ($35 per lookup). A per-question cost, not a data source.
Not modelled.

Recommendation: monthly bulk, with Active Business Data added only if a concrete
product need for sub-monthly freshness appears. Nothing is scheduled today.

---

## 8. UCC is a separate source family, and is not started

Minnesota's Secretary of State separately sells **UCC data** — the financing
statements filed against business assets. It is genuinely valuable to Reivesti as
a *financing and lien* signal, and it is deliberately **out of scope for DF-0F**.

The reason is semantic, not commercial. A UCC filing is a lien against collateral,
not a fact about a business registration; its parties are debtors and secured
parties rather than officers and agents; its lifecycle (initial statement,
amendment, continuation, termination, lapse after five years) is its own model;
and linking a UCC debtor to a business registration is the same evidence problem
this phase just solved for names, with an extra layer of collateral description on
top. It needs its own phase and its own licence review.

Recorded here so the gap is a decision rather than an oversight. Nothing in this
repository ingests UCC data.

---

## 9. Restricted data

Filings name **natural persons** — registered agents, organizers, incorporators,
officers. Their names are authoritative registry facts and are stored. Their
addresses are not stored on any canonical row: they go to
`data_fabric_restricted.contact_observations` as `mailing_address` with
`permittedUse: record_only`.

The guarantee is structural, not procedural: **no table in the business model has
an address, phone or email column for a party**, and a test enumerates the columns
to prove it. A filing address is evidence that an address was stated on a filing.
It is not permission to write to it.

There is no contact enrichment, no phone or email — Minnesota states outright
that phone numbers are not available from that office — and no skip tracing.

---

## 10. Tables

| Table | Holds |
|---|---|
| `business_entities` | one registration, keyed by `(source_id, source_entity_id)` |
| `business_entity_names` | every name of an entity, with its type |
| `business_entity_addresses` | business addresses only |
| `business_entity_filings` | filing history, raw action retained |
| `business_filing_parties` | parties named on filings — names and roles, no addresses |
| `business_entity_links` | the only bridge from an observed party name to a registration |

Migration `0006_data_fabric_business_entities.sql`. **Draft; not applied to any
Reivesti database.**

---

## 11. Activation checklist

1. Purchase Business Bulk Data through the MBLS Portal ($710 commercial), or
   apply for a free copy if the use qualifies.
2. Sign the Electronic Media License Agreement.
3. Download the ZIP from Transaction History; record its sha256 in the manifest.
4. Build the delivery bundle and run `df stream mn_sos__statewide`.
5. Run `measureNameCollisions` over the real register and record the result.
6. **Only then** decide whether `allowUniqueLegalName` may be enabled, and with
   what corroboration.
7. Set the mapping status to `active`.

Steps 1–3 are human actions. Nothing in this repository will perform them.
