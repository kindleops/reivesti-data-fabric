# The automated acquisition gate

**A human is not an acquisition mechanism.**

A source is not a production Reivesti source if obtaining it requires a person to
open a browser, work a session, and place a file somewhere. Not because such a
source is unlawful, or expensive, or bad data — Wisconsin RETR is none of those —
but because a pipeline whose input arrives by hand has no way to distinguish
*"no transfers were recorded that month"* from *"nobody clicked that month."*
Those two states produce identical downstream output and require opposite
responses, and a dataset that cannot tell them apart will eventually report the
second as the first.

## The failure this gate was built from

DF-0J added Wisconsin RETR. Every field in its registry row was true:

| Field | Value | True? |
|---|---|---|
| `costClass` | `FREE_PUBLIC_DOWNLOAD` | yes — no account, no fee |
| `termsStatus` | `reviewed_permitted` | yes — a liability disclaimer, nothing more |
| `licenseStatus` | `public_domain` | yes — Wisconsin public records |
| `automationStatus` | `manual_only` | yes — accurately recorded |
| `role` | `CORE_CANONICAL_SOURCE` | **this is where it went wrong** |

The coverage report then announced transfer coverage for all 72 Wisconsin
counties. Not one byte had ever been retrieved, and none could be.

No single field was a lie. The error was a *conclusion* drawn from four true
facts — free, public, permitted, parsed — none of which is **reachable**. The old
gate even said so out loud: *"`manual_only` is not a failure here: a file an
operator may lawfully receive is acquirable, and everything after delivery is
automated regardless."* Every clause of that is correct and the conclusion is
still wrong, because "everything after delivery" presumes a delivery.

## Two questions, not one

The gate separates what the registry used to conflate:

- **`automationStatus` — permission.** *May* we automate this? A question about
  the publisher's terms.
- **`acquisitionClass` — mechanism.** *Is there anything to automate against?* A
  question about the wire.

Neither implies the other. A publisher can warmly permit automated retrieval of a
file that exists only behind a fifteen-minute session; a stable public URL can sit
behind terms that forbid touching it. **Both must pass.**

## The classes

Automated — a scheduled process retrieves this with nobody present:

| Class | Meaning |
|---|---|
| `AUTOMATED_API` | A documented programmatic interface: REST, SOAP, GraphQL, OGC |
| `AUTOMATED_BULK_DOWNLOAD` | A published archive at a stable, fetchable URL |
| `AUTOMATED_OPEN_DATA` | An open-data platform endpoint: Socrata, CKAN, ArcGIS Hub |
| `AUTOMATED_PUBLIC_HTTP` | A plain public resource — no session, no token, no negotiation |
| `AUTOMATED_BROWSER_ALLOWED` | A headless browser, **where the publisher has said that is acceptable** |

Not automated — none of these may carry core coverage:

| Class | Meaning |
|---|---|
| `MANUAL_ONLY` | Obtainable only by a human action. Lawful, free, and still not production |
| `PROHIBITED_AUTOMATION` | The publisher forbids automated retrieval |
| `UNKNOWN_AUTOMATION` | Not yet established. Ineligible, never assumed automated |

`AUTOMATED_BROWSER_ALLOWED` is deliberately last and never the default. It is the
most fragile to publisher change and the easiest to mistake for permission that
was never given. Prefer, in order: an official export, a documented API, a bulk
archive, an open-data endpoint — and only then a browser.

## How it is enforced

Three places, so that no one of them has to be remembered:

1. **The gate.** `assessActivation` refuses a non-automated source with
   `BLOCKED_MANUAL_ACQUISITION`, distinct from `BLOCKED_AUTOMATION`: one clears by
   finding a different distribution, the other only if the publisher rewrites its
   terms. Same colour on a dashboard, entirely different plan.
2. **Absence is not consent.** A row omitting `acquisitionClass` is
   `UNKNOWN_AUTOMATION` and blocked — the same posture `costClass` already takes.
   Silence is never a yes.
3. **Contradictions resolve against the optimistic field.** `FREE_MANUAL_DELIVERY`
   states *in the cost field* that a person receives the file. Declaring
   `AUTOMATED_API` beside it is a contradiction, and the manual reading wins.
   Otherwise the two fields can be set to disagree and the flattering one governs.

Eight regression tests in [`tests/automated-acquisition-gate.test.ts`](../tests/automated-acquisition-gate.test.ts)
hold this in place.

## What it cost

Declared core coverage fell from **131 jurisdictions to 59**, and national
transfer coverage from 72 counties to **zero**.

Nothing about the data changed. The 72 Wisconsin counties were never really
covered; the report was describing an intention. A number that flatters us is
worse than a smaller one that is true, because only the smaller one gets fixed.

Both statewide transfer sources are now visibly blocked, for different reasons
that need different work:

- **Wisconsin RETR** — parsed, tested, dormant. Needs an automated distribution
  that does not exist today.
- **Minnesota eCRV** — needs a request nobody has sent, and the delivery mechanism
  it grants is unknown until someone asks.

Transfer data is the estate's largest open gap, and the coverage report is now
required to keep saying so.

## For a new source

Answer both questions before setting `role`:

1. Can a scheduled process retrieve this with nobody watching? → `acquisitionClass`
2. Does the publisher permit that? → `automationStatus`

If the honest answer to the first is "a person downloads it", the source may still
be worth building a connector for — RETR's is finished and tested — but it is
`DEFERRED`, not core, and it does not count toward coverage.

## The first source built to the gate: Wisconsin statewide parcels (DF-0K)

DF-0J.1A took Wisconsin's 72 counties out of core coverage because nothing
could fetch RETR. DF-0K puts 72 back for **parcel** coverage — and this time the
acquisition is a program, not a person:

```
df auto wi_statewide_parcels__all_wi_counties
```

| Step | What happens | Network |
|---|---|---|
| gate | `assessActivation` must return `CORE_ELIGIBLE` from registry facts, or nothing is requested | none |
| discover | SCO landing page → newest `V*_Uncompressed.zip` link; HEAD it; FeatureServer layer metadata + count as a witness | 3 GET + 1 HEAD |
| plan | the acquisition ledger: this exact release fingerprint (URL, ETag, length, Last-Modified, object version) already ingested? → **NOOP**, stop | none |
| acquire | one streamed GET into the content-addressed artifact store; length and ETag checked; a short or changed body leaves no artifact | 1 GET |
| derive | archive → File Geodatabase → snapshot bundle, from the **retained** bytes, deterministically | none |
| ingest | the streaming runtime; 72 county partitions activated independently | none |
| record | ledger line; the next tick is a NOOP | none |

The generic half — ledger, fingerprint, NOOP planning, HEAD, streamed download
into the artifact store — is `src/runtime/bulk-acquisition.ts` and knows nothing
about Wisconsin. The Wisconsin half is discovery (`release.ts`) and derivation
(`bundle.ts`).

Guarantees a scheduler can rely on:

- **Same release → NOOP.** No download, no parse, no projection. Measured on the
  live publisher: see `WISCONSIN-STATEWIDE-PARCELS.md` §11.
- **New release → planned**, with `schemaValidationRequired` when it is not the
  release the field map was pinned against. It is then ingested only if the
  pinned field-set digest still matches; a changed schema quarantines the run
  before a row is read and activates nothing.
- **Republished release** (same version, new bytes) → planned as
  `REPUBLISHED_RELEASE`.
- **A truncated smoke run** (`--max`) is ledgered as `TRUNCATED_SMOKE_RUN` and can
  never make a later tick believe the release was ingested.
- **Replay** (`--replay <sha256> --period <label>`) re-derives and re-ingests from
  the retained archive with no network at all.

See also: [`ZERO-COST-DATA-DOCTRINE.md`](ZERO-COST-DATA-DOCTRINE.md),
[`SOURCE-REGISTRY.md`](SOURCE-REGISTRY.md), [`WISCONSIN-RETR.md`](WISCONSIN-RETR.md).
