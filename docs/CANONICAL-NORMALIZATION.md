# The canonical normalization contract

One versioned contract, shared by every connector, for how a value is written
down. Version `canonical_normalization_v1`, implemented in
`src/canonical/normalization-contract.ts` and `src/canonical/address.ts`.

---

## 1. What was wrong

DF-0H ingested 2.7 million Minnesota parcels from the state aggregation and
compared the 443,605 Hennepin parcels against Hennepin's own assessor service.
The audit reported four fields in **total disagreement**:

| Field | Agreement | What we concluded then |
|---|---:|---|
| `situs_address` | 0.00% | "the sources disagree on every address" |
| `parcel_area` | 0.00% | "the sources disagree on every area" |
| `assessor_sale_date` | 0.00% | "the sources disagree on every sale date" |
| `tax_total` | 5.91% | "the sources agree on 1 parcel in 17" |

Three of those four conclusions were false, and the fourth was misleading. The
sources were describing the same parcels correctly. **We** were writing the
values down in ways that could not be compared.

Each cause was established from one real parcel, PID `0102724110003`:

### Area — a unit difference

```
Hennepin   PARCEL_AREA = 79902.43      (square feet)
MnGeo      acres_poly  = 1.83          (acres = 79,714.8 square feet)
```

The two differ by 0.24%, which is exactly MnGeo rounding acreage to two decimal
places. A comparison of the raw numbers reports a conflict on every parcel in
the county, because 79902.43 is never equal to 1.83.

### Tax — a scale difference

```
Hennepin   TAX_TOT   = 109672.88
MnGeo      total_tax = 109673          (integer column)
```

MnGeo's column cannot hold cents. The 5.91% agreement rate is not a data quality
signal; it is approximately the share of Hennepin parcels whose tax happens to
land on a whole dollar.

### Sale date — a precision difference

```
Hennepin   SALE_DATE = '201412'                    (YYYYMM: a year and a month)
MnGeo      sale_date = 2014-12-01T00:00:00.000Z    (day padded)
```

All 390,589 of MnGeo's Hennepin sale dates end in `-01`. The day is padding.
Hennepin does not publish a day at all. Comparing `'201412'` against
`'2014-12-01'` as strings disagrees on every row; comparing them as *dates*
requires knowing that one of them is not claiming a day.

### Address — a structure difference

```
Hennepin   STREET_NM = '78TH ST E           '      (name, type, directional, packed)
MnGeo      st_name = '78th'  st_pos_typ = 'Street'  st_pos_dir = 'East'
```

Both mean *2901 78th Street East*. DF-0H assembled a display string from each and
compared the strings.

> An earlier DF-0H note claimed MnGeo "dropped the E directional". That was
> wrong: `st_pos_dir = 'East'` is present, and the column simply had not been
> selected. The correction is recorded here because the wrong version was used to
> justify a field-authority preference.

---

## 2. What the contract guarantees

### Absence is not zero

`AbsenceReason` distinguishes `MISSING`, `NULL_SOURCE`, `BLANK_SOURCE`,
`NOT_APPLICABLE`, `INVALID`, `SUPPRESSED` and `UNKNOWN`. A value of zero is
**never** absent — `absenceOf(0)` returns `null`. A tax bill of $0.00 and an
unknown tax bill are different facts about a parcel and are stored differently.

### Area

Stored in square feet with the source unit and source value retained:

```ts
canonicalArea(1.83, 'acres')
// { squareFeet: 79714.8, acres: 1.83, sourceValue: 1.83,
//   sourceUnit: 'acres', conversion: 'acres_to_square_feet' }
```

`compareAreas` returns `EQUAL`, `EQUAL_WITHIN_SOURCE_PRECISION`, `DIFFERENT`,
`ONE_ABSENT` or `BOTH_ABSENT`. A stated value denotes an interval half a unit
wide either side of it — `1.83` acres means somewhere in `[1.825, 1.835)`, which
is ±218 square feet — and two observations agree when those intervals can
overlap. So 79902.43 sq ft and 1.83 acres compare
`EQUAL_WITHIN_SOURCE_PRECISION`, 43,560 square feet and 1 acre compare `EQUAL`,
and 5,000 sq ft against 0.12 acres compares `DIFFERENT` because `[5009, 5445)`
does not contain 5,000.

### Money

`bigint` minor units, parsed from the decimal string. Never binary floating
point: `1234.565 * 100` is `123456.49999999999` in IEEE 754, and a cent lost per
parcel is a cent lost 2.7 million times.

`compareMoney` returns `EQUAL`, `EQUAL_AT_WHOLE_UNITS`, `DIFFERENT`, or an
absence outcome. `EQUAL_AT_WHOLE_UNITS` is deliberately not folded into `EQUAL`:
109672.88 against 109673 really is a small loss of information, and a report that
called it exact would be claiming a precision the aggregation does not offer.

The whole-unit tolerance applies **only when one side actually has no cents**.
100.50 against 100.99 is two different tax bills, and rounding both to 101 to
call them equivalent would manufacture exactly the agreement this contract exists
to stop manufacturing.

### Dates

An ISO calendar date plus the precision the **source** stated (`day`, `month`,
`year`) and a `semantic` (`SALE_DATE`, `RECORDING_DATE`, `SOURCE_EDIT_DATE`, …).

- `'201412'` parses as December 2014 at `month` precision. The `yyyymm` and
  `yyyy` forms are recognised **before** the numeric branch, so `201412` is not
  mistaken for an epoch value.
- A source that pads a day it does not have declares its real precision through
  the adapter: only the adapter can know that all of MnGeo's sale dates end in
  `-01` for a structural reason. A declaration can only make precision
  **coarser** than the text supports, never finer — no amount of publisher
  documentation turns `2014` into a day.
- Epoch values are read in **UTC**. Reading them locally would shift a parcel
  edited near midnight by a day, which is precisely how two connectors reading
  the same field end up disagreeing on every row.
- `compareDates` returns `INCOMPARABLE_SEMANTICS` when the two dates mean
  different things. A sale date and a recording date that fall on the same day
  are not agreement.
- An implausible date is **retained and flagged**, never corrected. MnGeo really
  does publish a sale date in the year 3009.

### Addresses

Structured components, not a display string. The comparison key is
`house number + street + unit` — city, state and ZIP are deliberately excluded,
because the key answers "do these two observations state the same address", never
"which property is this".

`compareAddresses` returns `EQUAL`, `EQUAL_AFTER_NORMALIZATION`,
`SAME_STREET_DIFFERENT_UNIT`, `DIFFERENT`, `ONE_ABSENT` or `BOTH_ABSENT`.
`SAME_STREET_DIFFERENT_UNIT` exists so that unit 101 and unit 102 never merge:
they are two homes.

Splitting Hennepin's packed `STREET_NM` is **adapter work, not contract work**
(`src/connectors/mn-hennepin-assessor/street.ts`). Only someone reading
Hennepin's own layer knows that column packs three things. The splitter is
conservative: a trailing token becomes a directional or street type only when it
is unambiguously one, and `PARK` is deliberately absent from the street-type
table because "Lyndale Park" is a street name. Missing an equivalence is
recoverable; inventing one is not.

### Identifiers

Leading zeros are preserved and parcel identifiers are never converted to
numbers. `0102724110003` and `102724110003` are different identifiers.
Identifiers carry their jurisdiction scope, so the same parcel string in two
counties is two identifiers.

### No canonical address display string

The contract stores `canonical_address_key` and the components. It does **not**
store an assembled display string. An earlier draft did, joining city, state and
ZIP, and produced `"MINNEAPOLIS MN 55401"` — byte-identical to a taxpayer mailing
line in the restricted plane, which failed the PII leak scan. The components are
public situs data either way, but a canonical field that reproduces a restricted
value verbatim defeats leak scanning, and a scan that cries wolf is a scan nobody
reads. `situs_address` already carries a human-readable form.

---

## 2a. Checked against the real layer, not against an idea of it

Every rule above was verified by running the parsers over the retained
447,044-row Hennepin artifact. The first 100,000–120,000 rows say:

| What | Measured |
|---|---|
| `SALE_DATE` in `YYYYMM` | 88,412 of 100,000 |
| `SALE_DATE` blank — **spaces, not null** | 10,816 |
| `SALE_DATE` absent | 772 |
| `PARCEL_AREA` fractional square feet | 99,949 |
| `PARCEL_AREA` whole square feet | 51 |
| `TAX_TOT` with cents | 94,106 |
| **`TAX_TOT` a whole number of dollars** | **5,122 (5.1%)** |

That last row is the DF-0H mystery, solved arithmetically. The audit reported
5.91% agreement on tax total against MnGeo's integer column; 5.1% of Hennepin
parcels have a whole-dollar tax bill. They are the same population. Nothing was
wrong with either publisher's data.

The blank sale dates matter too: they are **spaces**, not nulls, so a contract
that only checked for `null` would have parsed `'      '` into something. It
resolves to `BLANK_SOURCE`.

### Two things the real data changed

**Hennepin's own street abbreviations.** Running `splitPackedStreet` over 100,000
rows recognised a street type in 82.5% of non-blank values. The trailing tokens
it could not place were, in order: `LA` 3,067 times, `UNASSIGNED` 1,967, `TR`
954, `CUR` 382, `BROADWAY` 281. `LA`, `TR` and `CUR` are the county's
abbreviations for Lane, Trail and Curve and were added, taking recognition to
about 87%. `BROADWAY` was left alone: it is a street name every time.

**`ADDRESS UNASSIGNED` is not an address.** Hennepin writes it into `STREET_NM`
for parcels with no address yet — 2,420 times in 120,000 rows, always with a null
house number. Treated as a street name, all of them would share one canonical
address key, and an overlap audit would report them as agreeing on their address.
They agree on having none, so the adapter maps the placeholder to absent.

Neither of these could have been found by reading the field documentation, and
neither is a contract concern: both live in the Hennepin adapter, next to the
source that produced them.

---

## 2b. Where the boundary is

Two different questions, answered in two different places, and most of the DF-0H
defects came from answering one of them in the wrong one.

| | Question | Lives in |
|---|---|---|
| **Source adapter** | *What does this publisher's field mean?* | `src/connectors/<source>/` |
| **Canonical contract** | *How does Reivesti represent that meaning?* | `src/canonical/normalization-contract.ts` |

Worked through, for the case that started this:

```
MnGeo publishes   acres_poly = 1.83
  adapter says    "this column is acreage"        →  canonicalArea(1.83, 'acres')
  contract says   "areas are square feet, and the source unit is kept"
                                                  →  { squareFeet: 79714.8, acres: 1.83,
                                                       sourceUnit: 'acres' }
```

The adapter never decides that areas are stored in square feet; the contract
never guesses that a column called `acres_poly` holds acres. Everything
source-specific in DF-0I sits on the adapter side and could not have sat
anywhere else:

- Hennepin's `STREET_NM` packs name, type and directional into one field.
- Hennepin's `SALE_DATE` is `YYYYMM`, so the adapter declares `month` precision.
- MnGeo pads every sale day to `-01`, so its adapter declares `month` too.
- Hennepin writes `ADDRESS UNASSIGNED` where a parcel has no address.
- `TAX_TOT` is dollars and cents; MnGeo's `total_tax` is an integer column.

None of those are inferable from the shape of a value, and a generic normaliser
that tried would be guessing. Field meaning stays with the field.

---

## 3. Versioning and replay

Every connector stamps `normalization_contract` on the rows it emits, and the
run's digest scope includes the contract version alongside the parser and
normalizer versions:

```ts
normalizationScope({ parserVersion, normalizationVersion })
// "canonical_normalization_v1|parser=mn_statewide_parser_1|normalizer=mn_statewide_normalizer_2"
```

Changing the contract therefore changes the run's normalized digest **on
purpose**. That is the point: representation drift must never look idempotent. A
replay of identical bytes under a new contract version produces a different
digest, and the run report says which version changed rather than reporting a
corrupted replay.

Two things this deliberately does not touch:

- **The raw artifact digest is unchanged.** The contract governs how values are
  represented downstream of the bytes; the bytes are evidence and are never
  rewritten. A replay verifies the same `sha256` it always did.
- **The resolver version is already covered.** Entity-link decisions embed
  `RESOLVER_VERSION` in their `linkId`, so a resolver change moves the
  organization partition's digest and therefore the estate digest, without
  needing to be named in `normalizationScope` — which scopes the *normalized*
  digest over canonical rows, where the resolver has no say.

The connectors' normalization versions were bumped to `mn_statewide_normalizer_2`
and `mn_hennepin_norm_2` when the contract landed.

---

## 4. What the contract deliberately does not do

**It does not maximise agreement.** Normalising until everything matches produces
a report that says 100% and means nothing. Every comparator here is required to
keep genuinely different values apart, and the test suite asserts the conflicts
that survive as carefully as the ones that resolve:

- different unit numbers stay different addresses
- different months stay different dates
- 5,000 square feet and 2 acres stay different areas
- a sale date is never compared against a recording date

**It does not do fuzzy name matching.** Owner and taxpayer names are compared as
strings. A fuzzy comparator would raise the agreement rate and lower its meaning.

**It does not mutate raw evidence.** Source values are retained verbatim
alongside the canonical form. Every conversion records what it converted from.

---

## 5. What changed in the Hennepin overlap audit

The audit now runs in two modes over the same rows — `'literal'`, which is
exactly the DF-0H comparison, and `'canonical'` — and
`overlapMigrationReport(before, after)` reports the difference per field:
how many conflicts the contract explains, how many remain, and the cause. The
remaining conflicts are the finding. See `docs/MN-STATEWIDE-PARCELS.md` for the
measured results.
