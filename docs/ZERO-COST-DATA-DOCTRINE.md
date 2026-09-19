# The zero-cost data doctrine

**Reivesti does not pay for core data.**

National coverage is built from free government bulk files, free government APIs,
free sanctioned feeds, free public downloads, free open data, free lawful data
requests, and Reivesti's own first-party data. Paid sources may be documented,
and may even be implemented; they may never be *required* for canonical coverage.

---

## 1. Why this is architecture, not thrift

A canonical estate whose property identities depend on a subscription is an
estate that stops being true when an invoice goes unpaid, a vendor is acquired,
or terms change on renewal. The failure does not announce itself: it arrives as
silently missing rows, months after the decision that caused it, in a system
whose whole purpose is to be the authoritative answer.

Building on free government sources costs more engineering up front and buys a
property that money cannot: **the data keeps working.** A county's open-data
portal has no renewal date.

There is a second, quieter benefit. Free government sources are the *offices of
record*. A vendor aggregation is a copy with a licence attached; the county
assessor's ArcGIS service is the assessment roll. Preferring free almost always
means preferring authoritative.

---

## 2. The rule

A source may become an **active core source** only when all five hold:

| Gate | Requirement |
|---|---|
| **COST** | zero |
| **ACQUISITION** | sanctioned by the publisher, or lawfully delivered to an operator |
| **LICENCE** | terms read, and compatible with the intended use |
| **AUTHORITY** | the body that maintains the record |
| **PROVENANCE** | pinned, digestible, replayable |

A source must **not** become a core source merely because it is useful, because
it is public, because it is technically reachable, because a competitor uses it,
because a subscription exists, or because a browser can be pointed at it.

The rule lives in [`src/registry/policy.ts`](../src/registry/policy.ts) as a pure
evaluator, and again in migration `0007` as a database constraint. Both, on
purpose: a doctrine that exists only in the layer that happens to be running is
not a doctrine.

---

## 3. Cost classification

Cost is its own field, deliberately separate from access type, automation status,
licence status and authority — four questions that get conflated and are
genuinely independent. **A free source may forbid automation. A paid source may
be perfectly lawful to use.** Neither fact is derivable from the other.

### Zero-cost families

Each is a distinct *acquisition shape*: the price is the same, the engineering
and the operational burden are not.

| Class | What it is |
|---|---|
| `FREE_BULK` | a published file or archive, downloadable without payment |
| `FREE_API` | a documented programmatic interface offered without charge |
| `FREE_PUBLIC_DOWNLOAD` | a file a human downloads from a public page — no account, no fee |
| `FREE_OPEN_DATA` | an open-data portal dataset (ArcGIS Hub, Socrata, CKAN) |
| `FREE_WEB_SERVICE` | a queryable service — ArcGIS FeatureServer, WFS, OGC API |
| `FREE_DATA_REQUEST` | obtainable at no charge by a public-records request |
| `FREE_MANUAL_DELIVERY` | an operator receives a recurring file at no charge by arrangement |
| `FIRST_PARTY` | Reivesti's own data |

### Non-zero

`PAID_OPTIONAL`, `PAID_SUBSCRIPTION`, `PAID_PER_RECORD` — usable, documentable,
never required.

### `UNKNOWN_COST`

Not yet established. **Treated as ineligible, not as free.** A row missing a cost
class evaluates to `BLOCKED_COST_UNKNOWN`, because the failure mode this whole
mechanism exists to prevent is a source drifting into core use because nobody
wrote down what it costs.

---

## 4. Verdicts

`assessActivation()` returns exactly one verdict, and the **first failing gate
wins** — so the answer always names the single thing that has to change.

Gate order: role → cost → permission → licence → access → **acquisition
mechanism** → schema → provenance. Access is asked before mechanism deliberately:
for a source awaiting a data request, "nobody has asked yet" is the earlier and
more actionable fact, and the mechanism the request grants is often unknowable
until it is answered.

| Verdict | Meaning |
|---|---|
| `CORE_ELIGIBLE` | free, sanctioned, licence-compatible |
| `OPTIONAL_PAID` | lawful and useful; costs money; never a dependency |
| `BLOCKED_COST_UNKNOWN` | nobody has priced it |
| `BLOCKED_AUTOMATION` | terms forbid, or have not sanctioned, automated retrieval |
| `BLOCKED_TERMS` | the terms have not been read, or forbid the use |
| `BLOCKED_ACCESS` | free and lawful; the file is not in hand |
| `BLOCKED_MANUAL_ACQUISITION` | free and lawful; only a **human** can fetch it (DF-0J.1A) |
| `BLOCKED_SCHEMA` | the layout is not pinned |
| `BLOCKED_PROVENANCE` | retrieval cannot be archived, digested and replayed |
| `DEFERRED` | known, understood, deliberately not pursued |

---

## 5. Roles

A separate axis, and the one that stops a paid optional source from quietly
becoming load-bearing:

`CORE_CANONICAL_SOURCE` · `CORE_SUPPORTING_SOURCE` · `OPTIONAL_ENRICHMENT` ·
`VALIDATION_ONLY` · `MANUAL_RESEARCH_ONLY` · `DEFERRED` · `REJECTED`

**A source may not even be *declared* core until it is known to be free.** That
is enforced in `createRegistry()` and by the `sources_core_role_is_zero_cost`
constraint. Declaring intent before establishing cost is exactly how a paid
source ends up in a canonical position.

---

## 6. Acquisition automation IS required (revised, DF-0J.1A)

> **This section previously said the opposite.** It held that a file arriving by
> a lawful recurring request was core eligible, because "the operator's download
> is one manual step; everything after delivery is automated regardless." That
> reasoning is preserved here because it is the exact error the estate made, and
> it is a persuasive one.

Three questions, kept apart:

- **Acquisition permission** — *may* software fetch the bytes? (`automationStatus`)
- **Acquisition mechanism** — *is there anything to fetch?* (`acquisitionClass`)
- **Ingestion automation** — is everything after delivery automated?

The third was never in doubt and was never the problem. The second was missing
entirely, and its absence let Wisconsin RETR — free, public, permitted, fully
parsed, and impossible to retrieve — count as core coverage for 72 counties.

**A human is not an acquisition mechanism.** A pipeline whose input arrives by
hand cannot tell *"no transfers were recorded"* from *"nobody clicked"*, and
those need opposite responses. So a source whose only distribution requires a
person is `DEFERRED`, never core, however free and however lawful.

The old objection — that requiring automation rules out a large fraction of
American public records — is true and is accepted. The answer is that those
records are not *covered*; calling them covered did not make them retrievable.

`FREE` and `PROHIBITED` together is still refused, as it always was — see
Hennepin RecordEASE. What is new is that `FREE` and `MANUAL_ONLY` is refused too.

Full treatment: [`AUTOMATED-ACQUISITION.md`](AUTOMATED-ACQUISITION.md).

---

## 7. Access-request lifecycle

Free access paths have administrative state: `NOT_REQUIRED`, `NOT_REQUESTED`,
`REQUESTED`, `AWAITING_RESPONSE`, `APPROVED`, `DENIED`, `FEE_QUOTED`,
`DELIVERED`.

This is source *operations* metadata — where a request has got to, never what the
data contains. It matters because of one transition: **a free request that comes
back with a fee quote changes the source's cost class.** The evaluator returns
`OPTIONAL_PAID` with the remedy "keep looking for a free path", and the database
refuses to hold a quoted fee alongside a zero-cost class.

---

## 8. When the best source is paid

1. Record it as `PAID_OPTIONAL`. Do not delete the work.
2. Keep looking: a different authority, a higher-level state source, a
   lower-level county source, an alternate official publication, a data request.
3. If no zero-cost path exists, mark the capability honestly unavailable or
   deferred.

**Do not weaken the rule.** And do not confuse the two reasons a capability can
be missing:

- **`BLOCKED_ON_COST`** — the record exists and someone wants money for it. Keep
  looking.
- **`UNAVAILABLE` (legal)** — the record does not lawfully exist. Stop.

Texas is the worked example. Tex. Tax Code § 22.27 makes sale prices
confidential, so no amount of money buys a lawful government transfer-price feed
there. Reporting that as a cost blocker would send someone searching forever.
`LEGAL_CAPABILITY_LIMITS` records it as what it is.

---

## 9. Current classification

| Source | Cost | Acquisition | Role | Verdict |
|---|---|---|---|---|
| Hennepin County Parcels | `FREE_OPEN_DATA` | `AUTOMATED_OPEN_DATA` | `CORE_CANONICAL_SOURCE` | **`CORE_ELIGIBLE`** |
| MN statewide parcels | `FREE_OPEN_DATA` | `AUTOMATED_BULK_DOWNLOAD` | `CORE_CANONICAL_SOURCE` | **`CORE_ELIGIBLE`** |
| MN eCRV Weekly Sales Extract | `FREE_DATA_REQUEST` | `UNKNOWN_AUTOMATION` | `CORE_CANONICAL_SOURCE` | `BLOCKED_ACCESS` — request not yet made |
| Hennepin recorded instruments | `FREE_DATA_REQUEST` | `PROHIBITED_AUTOMATION` | `CORE_CANONICAL_SOURCE` | `BLOCKED_AUTOMATION` — RecordEASE terms |
| **WI DOR RETR historical** | `FREE_PUBLIC_DOWNLOAD` | `MANUAL_ONLY` | `DEFERRED` | `DEFERRED` — no unattended path (DF-0J.1A) |
| MN SOS Business Bulk Data | `PAID_OPTIONAL` | `MANUAL_ONLY` | `DEFERRED` | `DEFERRED` — $710, not purchased |
| Dallas foreclosure notices | `UNKNOWN_COST` | `UNKNOWN_AUTOMATION` | *(undeclared)* | `BLOCKED_COST_UNKNOWN` |

Note what did **not** happen to the Minnesota SOS connector: it was not deleted.
It remains implemented, tested and inactive, and a regression test proves the
estate works without it.

---

## 10. The non-dependency proof

`tests/zero-cost-doctrine.test.ts` builds a registry with every paid source
removed and asserts the core Fabric still operates — scopes still expand,
coverage still resolves, Hennepin is still `ACTIVE`. Separately:

- no paid source is authoritative for parcel identity or any canonical key;
- a paid source's coverage entries all carry `countsAsCore: false`, so Minnesota
  reports **no** core business-entity coverage rather than pretending;
- the database refuses to let a paid source hold a core role.

The point is not that paid sources are forbidden. It is that removing them can
never be a breaking change.

---

## Wisconsin RETR: free, public, permitted — and withdrawn (DF-0J → DF-0J.1A)

Wisconsin's RETR historical data is the doctrine's cleanest illustration that
**cost, permission and mechanism are three different questions.**

| Question | Answer |
|---|---|
| Source-data fee | **$0** |
| Account or credentials | none |
| CAPTCHA on the download path | none |
| Terms | a liability disclaimer that asserts no rights over the data |
| Terms prohibit automation | **no** |
| `robots.txt` | absent on the portal host; nothing addresses RETR |
| **Retrievable by a machine** | **no** |

DF-0J classified it `FREE_PUBLIC_DOWNLOAD` + `manual_only` and called it
**CORE_ELIGIBLE**, reasoning that a human clicks once a month and the connector
does the rest forever after. DF-0J.1A withdrew that.

Probing the public endpoint established why it cannot be automated.
`tap.revenue.wi.gov/RETRHistoric` redirects into My Tax Account, a Fast
Enterprises GenTax single-page application whose HTML shell contains no content
at all — every view, the download included, is assembled by XHR. Each call must
carry a `tap-session` cookie **and** a `FAST_VERLAST__` server-state token, both
reissued on every response, inside a session that expires after fifteen minutes.
There is no month URL: the links are JavaScript hash routes and the file is
generated server-side per request.

Both legacy distributions were checked and are gone — the old eRETR data page and
the `propertyinfo.revenue.wi.gov` sales search now redirect into the same portal.
There is no second way in. DOR's one sanctioned programmatic route, the RETR web
services, is approval-gated to filing-software providers and offers no bulk
historical retrieval.

Nothing here is a prohibition, and nothing was circumvented. The finding is
simply that **there is no mechanism**, and no amount of permission substitutes
for one. RETR is now `MANUAL_ONLY` and `DEFERRED`. Its connector, parser,
classifier and consideration model stay in the tree, tested against fixtures,
dormant until Wisconsin publishes an automated distribution.

The opposite mistake was available and refused twice. "Retrieve RETR" appears in
DOR's web-services list, and reading that as public bulk retrieval would have
promoted a source on a misreading of an approval-gated filing interface.
