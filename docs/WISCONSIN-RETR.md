# Wisconsin Real Estate Transfer Returns

The estate's first statewide **transfer** source, and the first thing it holds
that says who sold to whom and for how much.

Authority: **Wisconsin Department of Revenue**. Source id
`wi_dor_retr_historical`. Mapping `wi_retr__all_wi_counties`, all 72 counties.

---

## 1. What a RETR is, and what it is not

Under Wisconsin law a Real Estate Transfer Return must be e-filed with the
county Register of Deeds whenever a conveyance of real estate is recorded. It
carries the parties, the parcels, the consideration, the transfer fee and the
statutory exemption claimed.

**It proves a conveyance was filed. It does not prove a sale happened.** The
conveyance-type list the publisher uses includes gifts, inheritances, divorces,
corrections, partitions, foreclosures, sheriff's deeds and transfers between an
LLC and its own members — and every one of those carries a value field that
would read as a sale price to anything that did not look further. Getting that
distinction right is most of what this connector does; see §6.

---

## 2. Access, and how it was established

Everything below was read from the publisher's own pages on **2026-09-05**.

| | |
|---|---|
| Historical download | My Tax Account → *Download Historical RETR Data* (`tap.revenue.wi.gov/RETRHistoric`) |
| Authentication | **None.** The link sits in MTA's unauthenticated public panel, beside *Log in* |
| Account | Not required |
| CAPTCHA | **None on the download path.** There is one on *File a RETR*, which is a different flow this connector never touches |
| Fee | **$0.** No fee is stated or charged anywhere on the path |
| Coverage | Current year plus five, **by month**. Older data is referred to the 72 county registers of deeds, which is not a bulk source |
| Formats | CSV and XML, one file per month, statewide |
| Terms | A liability disclaimer, quoted in full below |

The old bulk page `revenue.wi.gov/Pages/ERETR/data-home.aspx` now **302s to the
MTA route**, which is the visible half of the 2026 migration described in §3.

### The disclaimer, verbatim

> This site is intended as a general index to Real Estate Transfer Return (RETR)
> data and related assessment information. The State of Wisconsin and the
> Department of Revenue assume no responsibility whatsoever for direct,
> indirect, special, consequential, exemplary, or other damages.
>
> The data contained on this site is intended for informational purposes only
> and is not intended for detailed, site-specific analysis. All information is
> believed accurate but is NOT guaranteed to be without error. It is based on the
> best information available at the time of posting and may not reflect the most
> current records.
>
> By proceeding with a search, you are confirming that you have read this notice
> and you understand and agree with its contents.

It disclaims **liability**. It asserts no rights over the data, imposes no
restriction on use or redistribution, and requires no attribution — which is why
`licenseStatus` is `public_domain` and `termsStatus` is `reviewed_permitted`.

### Why this is `manual_only`, and why that is fine

The month links are JavaScript routes, not URLs. There is no address to `GET`:
the file is generated server-side and handed to the browser. DOR's only
sanctioned programmatic route is the RETR **web services**, and those are for
approved filing-software providers (§4). Driving the portal would be automating
an interactive UI the publisher has not offered for that purpose.

So the classification is `FREE_PUBLIC_DOWNLOAD` + `automationStatus:
manual_only`: **a person clicks once a month; the connector ingests what they
saved, automatically, forever after.** That is a completely ordinary shape for a
government bulk source and costs nothing in fidelity — the artifact is the
publisher's own bytes either way.

---

## 3. Two publication eras

Wisconsin moved RETR into My Tax Account in 2026. What changed is **access
mechanics**; whether the published schema changed is an open question that only
two real files can answer.

| | Legacy (through 2025) | MTA (2026–) |
|---|---|---|
| Entry point | `Pages/ERETR/data-home.aspx` | `tap.revenue.wi.gov/RETRHistoric` (the old URL redirects here) |
| Filing | eRETR | MTA, with a CAPTCHA on the filing flow |
| Historical download | public page | public panel inside MTA, disclaimer-gated |
| Data offered | monthly files | monthly files, current year + five |

They are **one source with one mapping**, not two sources: the acquisition
mechanism moved but the record identity, the partition shape and the publisher
are unchanged. `config.publicationEra` records which era a run's file came from,
so a schema difference between them is attributable rather than mysterious. If a
real schema difference is ever found, that is the point at which they become two
eras in the registry — and not before.

**Current-year data is provisional.** The publisher states that files "list
sales submitted by each county at the time of posting (middle of each month) and
may not reflect all sales that occurred for the time period selected". A recent
month can therefore gain rows on a later download. Old months settle.

---

## 4. The web services are not a public API

`revenue.wi.gov/Pages/Developers/RETR-WebServices-Instructions.aspx` offers five
operations: Submit RETR, Retrieve RETR, Submit Recording, Retrieve RETR –
Recorded Only, and Submit Official Parcel.

> "Software providers may request access to one or more RETR web services from
> DOR." … "After meeting the required criteria, you will be authorized to use
> the web services you requested."

These are **filing-software interfaces**, approval-gated, for providers who
submit returns on behalf of filers. "Retrieve RETR" retrieves a return the
caller has a relationship with; it is not statewide bulk retrieval, and reading
it as one would be exactly the mistake DF-0J was told not to make. Reivesti does
not request access and does not use them.

---

## 5. The filing schema is not the dataset schema

This is the sharpest boundary in the source, and the one most likely to be
crossed by accident.

The RETR **form** collects, per the RETR Overview (R. 5-26):

- grantor and grantee **SSN, ITIN or FEIN**
- grantor, grantee, preparer and agent **phone numbers and email addresses**
- financing **amount financed, rate (APR) and term in months**
- marketing method, **days on market**, realtor/broker name and phone
- "value subject to fee"

**None of these appear in the public dataset.** The connector's field map lists
them explicitly under `WI_RETR_FILING_ONLY_FIELDS` so that their absence is a
recorded decision rather than a gap somebody later "fixes" from another source.
In particular: RETR is **not** a source of financing terms. It publishes five
yes/no flags and no amounts.

---

## 6. What the dataset does publish

**78 fields**, pinned in `src/connectors/wi-retr/field-map.ts` from the
publisher's own CSV documentation, with every code list transcribed into
`codes.ts`.

### Two distributions, and only one of them is faithful

The publisher is explicit:

| CSV | XML |
|---|---|
| "Displayed as a table where each row is one return" | "Values are stored in tags" |
| **"Can only show one grantor, one grantee, and one parcel"** | **"Can show all grantors, grantees, and parcels"** |

A return with three grantors and four parcels arrives in the CSV as one row
naming one of each, **with no indication that anything was dropped**. The
connector therefore reads **XML** by default, and every CSV-sourced record
carries `partiesMayBeIncomplete` / `parcelsMayBeIncomplete` so that a reader can
never mistake "the file showed one grantor" for "there was one grantor". A whole
sale attributed to one of four siblings is the failure this prevents.

### Identity

The public dataset carries **no RETR receipt number**. The only identity it
publishes is:

```
county + recorded document number
```

Identity is therefore **county-scoped**, because document numbers repeat freely
across the 72 counties and two counties' document 123456 are two different
transfers. `retrSourceRecordId()` is `wi-retr <countyFips>:<documentNumber>`.

Wisconsin requires a **separate RETR per county** when a conveyance spans county
lines, so county is a property of every record and never has to be inferred from
an address.

### Dates — four of them, and they are not the same

| Field | Meaning |
|---|---|
| `Conveyance Date` | when the property transferred |
| `Recorded Date` | when the county recorded the return |
| `Date Filed` | when a relevant *prior* document was filed |
| `Original Land Contract Date` | when an underlying land contract was signed — decides the fee rate |

All are `MM-dd-yyyy`, and all are read through the DF-0I contract with distinct
semantics, so two of them being equal never makes them the same fact.

### Money — five fields, five facts

| Field | What it is |
|---|---|
| `Sale Price` | what it sold for. **The consideration** |
| `Estimated Value` | a value where there was no price. **Not a price** |
| `Transfer Fee Due` | a **tax**: 30¢ per $100 of value, s. 77.22(1) |
| `Personal Property Excluded` | value carved **out** of the real-estate figure |
| `Personal Property Included` | tax-exempt property carried **in** the figure |

The last two are named almost identically by the publisher and move in opposite
directions. Everything is exact minor units via `canonicalMoney`; `$1,234,567.89`
becomes `123456789n` and the cents survive.

`statedConsideration()` returns the sale price or nothing. It will not fall back
to the estimated value, and it will certainly not return the tax.

---

## 7. Transfer classification

`classify.ts` reads the publisher's own statements — conveyance type, ch. 77.25
exemption, declared relationship, ownership share, rights retained — and emits
**every** applicable classification, each carrying the field and value it came
from. Nothing infers investor behaviour, distress or motive.

```
MARKET_SALE_SUPPORTED · NON_MARKET_TRANSFER_SUPPORTED · RELATIONSHIP_TRANSFER
GIFT_TRANSFER · EXEMPT_TRANSFER · FORECLOSURE_RELATED
PARTIAL_INTEREST_TRANSFER · UNKNOWN_TRANSFER_TYPE
```

`MARKET_SALE_SUPPORTED` is the only positive finding and it has to earn every
condition: conveyance type `Sale`, **and** no declared relationship, **and** full
ownership, **and** no rights retained, **and** no fee exemption, **and** a stated
price above zero, **and** no other classification firing. A sale to a cousin, a
sale of a half-interest, a sale with a retained life estate and a $0 sale are all
excluded.

A set rather than a label, because real returns are several of these at once:
*"Parent/child or grandparent/grandchild - part sale/part gift"* with partial
ownership is simultaneously a relationship transfer, a gift and a partial
interest, and flattening it would throw away two thirds of what the county was
told.

Exemptions are matched on the **statutory code**, never the publisher's label —
the label list contains at least one typo ("6d - Partisanship/qualification" is
s. 178.0901 *partnership* qualification), and a label can be reworded without
the statute changing.

---

## 8. Deriving value from the fee, and when not to

s. 77.22(1) is explicit: **30 cents per $100 of value or fraction thereof**, and
10 cents for deeds satisfying a land contract dated 1971-12-17 to 1981-08-31.
That formula is published and invertible, which is the bar DF-0J sets before
deriving anything.

`deriveValueFromFee()` returns a **band, not a number** — "or fraction thereof"
rounds value up to the next $100 before charging, so a $300 fee means a value in
`($99,900.01, $100,000.00]`. A single figure would be false precision.

It refuses, deliberately, when:

- **an exemption was claimed** — no fee was owed, so a zero fee says nothing
  about value. Inverting it would manufacture hundreds of thousands of worthless
  "$0 sales" a year;
- **the fee is absent or zero**;
- **a land contract date falls in the 1971–1981 window** — the rate is a third of
  the usual one, and applying the wrong rate understates value threefold;
- **the land contract date is unparseable** — the rate cannot be chosen;
- **the fee is not a whole number of rate units** — it did not come from this
  formula at whole-$100 granularity.

Every derived figure carries `derivationVersion`, and **an observed Sale Price
always outranks a derived estimate.**

---

## 9. Parties

Grantors and grantees are **unresolved party observations**. DF-0J does not
solve organization identity: names are normalised for search and never merged,
and no paid Secretary-of-State dependency is introduced. `WI_ORGANIZATION_PARTY_TYPES`
marks which of the 21 party types name an organization rather than a natural
person, so that a future resolver is never offered a person's name — that is the
only use it has here.

The return preserves filed order (`ordinal`), the source's own party type, and
the free-text explanations.

---

## 10. Restricted data

Public record does not mean unrestricted product field. The dataset publishes:

| Field | Why it is restricted |
|---|---|
| `Grantor Address`, `Grantee Address` | **mailing** addresses — a natural person's home address in the ordinary case |
| `Grantor Country`, `Grantee Country` | part of the same contact record |
| `Grantor/Grantee Agent Name` and address | a named individual acting for a party |
| `Preparer Name` | neither party to the transfer |
| `Tax Bill Name` and `Tax Bill Address` | the same shape of fact as a Hennepin taxpayer line, and treated the same way |

All route to the restricted contact plane. Party **names** are not restricted —
a grantor's name is the transfer. Their home address is not.

The property's **`Physical Address`** is situs data and stays canonical, exactly
as Hennepin's is.

---

## 11. Property linkage

A RETR states the parcel the parties said was conveyed. That is a claim about a
parcel, not an assessor's roll, so `authoritativeForParcelIdentity` is **false**
and RETR creates **provisional** canonical properties under the existing
county-scoped rules. A future Wisconsin parcel source can corroborate or
contradict them.

Parcel numbers keep their leading zeros and are never numeric. The CSV prefixes
each with a **tab** so Excel will not eat the zeros; the tab is a transport
artefact and is stripped, the zeros are identity and are not.

**Address alone never establishes property identity.** No exception.

One transfer with four parcels produces **one** transfer observation and four
property relationships — never four transfers. A return may list up to ten
parcels before the remainder overflows into the legal description, which is a
real ceiling worth knowing about.

---

## 12. Amendments

Wisconsin supports amending a RETR both before and after recording. An amendment
**updates the return in place** and keeps its receipt number; a correction to the
*instrument* requires a whole new RETR with a new document number.

Reivesti therefore models an amendment as a **new revision of the same
observation**, keyed by county + document number, with the prior evidence
retained. Old evidence is never mutated out of existence — the revision ledger
that DF-0B built for exactly this is what carries it.

---

## 13. Coverage claimed

`transfer`, across 72 Wisconsin counties. Deliberately **not** claimed:

- **`deed`** — RETR reports a recording document number, which is evidence that a
  deed exists, not the deed itself. No instrument is created from it.
- **`mortgage`, `mortgage_release`, `lien`** — five yes/no financing flags with no
  amounts, parties or instruments.
- **`foreclosure_notice`** — a foreclosure *conveyance type* is a transfer that
  followed a foreclosure, not the notice or the judgment.

---

## 14. What is not proven yet

The connector's semantics — classification, consideration, derivation, identity,
dates, restricted routing — are tested against the publisher's pinned
documentation. **The live ingest is not yet run**: the download requires a human
click (§2), and until a real monthly file has been ingested this document makes
no claim about row counts, reconciliation, memory, replay determinism or
partition isolation. Those are the next step, not a result.
