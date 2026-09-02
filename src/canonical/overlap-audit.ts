/**
 * Two sources, one county: a field-by-field agreement audit.
 *
 * When Hennepin's own parcel service and the state aggregation both describe the
 * same parcel, the estate holds two observations of it — and it keeps both. This
 * module measures how they compare so that field authority is decided from
 * evidence rather than from a preference for "direct" or "standardised".
 *
 * It is a fold over the canonical estate, externally sorted by property, so it
 * runs on 447,000 parcels in bounded memory like everything else. It reads
 * canonical rows rather than raw artifacts on purpose: what matters is whether
 * the two sources produce the same *canonical answer*, not whether their raw
 * columns happen to look alike.
 *
 * ## Two modes, because the first answer was wrong
 *
 * DF-0H ran this audit in what is now `'literal'` mode: compare the strings, then
 * compare them again with case and punctuation folded. It reported four fields in
 * total disagreement across 443,605 parcels — situs address at 0.00%, parcel area
 * at 0.00%, tax total at 5.91%, sale date at 0.00%. Three of those were artifacts
 * of how *we* wrote the values down:
 *
 *   - area: 79902.43 square feet against 1.83 acres, which is the same parcel
 *   - tax: 109672.88 against 109673, because MnGeo's column is an integer
 *   - address: `78TH ST E` against `st_name=78th, st_pos_typ=Street, st_pos_dir=East`
 *   - sale date: `201412` against `2014-12-01`, where the day is padding
 *
 * `'canonical'` mode compares the values the normalization contract produces,
 * with comparators that understand units, precision and rounding. Both modes are
 * kept and both are run, because the point of the exercise is the **difference**
 * between them: `overlapMigrationReport` shows, per field, how many conflicts the
 * contract explained and how many survived. A conflict that survives is a real
 * disagreement between two publishers, and that is a finding worth having.
 *
 * The failure mode to guard against is the opposite one. Normalising until
 * everything agrees would produce a beautiful report and a worthless one, so no
 * comparator here is allowed to fold two genuinely different values together:
 * different unit numbers stay different addresses, different months stay
 * different dates, and a date that means "sold" is never compared against one
 * that means "recorded".
 */
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { canonicalJson } from '../core/hash.ts';
import {
  canonicalArea,
  canonicalDate,
  canonicalMoney,
  compareAreas,
  compareDates,
  compareMoney,
  type AreaUnit,
  type DatePrecision,
} from './normalization-contract.ts';
import type { CanonicalBundle } from './models.ts';
import { agreementRate, deriveVerdict, type FieldAgreement, type FieldAuthorityDecision } from './source-authority.ts';

/** One source's canonical answer for a parcel, flattened to what comparison needs. */
export type ComparableParcel = {
  /** propertyId */ readonly p: string;
  /** sourceId */ readonly s: string;
  /** countyFips */ readonly c: string;
  readonly fields: Readonly<Record<string, string | null>>;
};

/**
 * The literal fields, in report order.
 *
 * These are the DF-0H comparisons, kept verbatim so the before/after report
 * compares like with like rather than against a remembered number.
 */
export const COMPARED_FIELDS: readonly string[] = [
  'normalized_parcel', 'situs_address', 'owner_name', 'taxpayer_name',
  'year_built', 'parcel_area', 'classification',
  'assessment_total', 'assessment_land', 'assessment_building',
  'tax_total', 'tax_year', 'assessor_sale_date', 'assessor_sale_value',
  'source_edit_date',
];

/** How two present values relate under a contract-aware comparator. */
export type FieldComparison = 'EQUAL' | 'EQUIVALENT' | 'DIFFERENT' | 'INCOMPARABLE';

/**
 * A field compared through the normalization contract.
 *
 * `replaces` names the literal field this supersedes, which is what makes the
 * before/after report a comparison rather than two unrelated tables.
 */
export type CanonicalComparedField = {
  readonly field: string;
  readonly replaces: string;
  /** Whether this source stated the fact at all. */
  readonly present: (row: ComparableParcel) => boolean;
  readonly compare: (a: ComparableParcel, b: ComparableParcel) => FieldComparison;
};

const get = (row: ComparableParcel, key: string): string | null => row.fields[key] ?? null;

/**
 * Rebuilds the contract value from what the connector wrote down.
 *
 * The audit deliberately reconstructs through `canonicalArea` rather than
 * comparing the stored square footage directly: the tolerance depends on how
 * many decimals the *source* stated, and only the source value carries that.
 */
const areaOf = (row: ComparableParcel) => {
  const value = get(row, 'canonical_area_source_value');
  const unit = get(row, 'canonical_area_source_unit');
  if (value === null || unit === null) return canonicalArea(null, 'square_feet');
  return canonicalArea(value, unit as AreaUnit);
};

const saleDateOf = (row: ComparableParcel) => canonicalDate(
  get(row, 'canonical_sale_date'),
  'SALE_DATE',
  (get(row, 'canonical_sale_date_precision') ?? undefined) as DatePrecision | undefined,
);

const moneyOf = (row: ComparableParcel, key: string) => canonicalMoney(get(row, key), 'minor_units');

/**
 * Every canonical comparison, and the literal one it replaces.
 *
 * Note what is *not* here: owner and taxpayer names, classification, year built.
 * Those already compare as plain strings, and inventing a fuzzy name comparator
 * to raise an agreement rate is exactly the temptation this phase forbids.
 */
export const CANONICAL_COMPARED_FIELDS: readonly CanonicalComparedField[] = [
  {
    field: 'canonical_parcel_area',
    replaces: 'parcel_area',
    present: (row) => get(row, 'canonical_area_source_value') !== null,
    compare: (a, b) => fromArea(compareAreas(areaOf(a), areaOf(b))),
  },
  {
    field: 'canonical_address',
    replaces: 'situs_address',
    present: (row) => get(row, 'canonical_address_key') !== null,
    // The keys are already normalised to components by the contract, so string
    // equality here IS the structured comparison. Anything looser would start
    // merging unit 101 into unit 102.
    //
    // Coarser than `compareAddresses` in one case: when one source states a unit
    // and the other does not, that function says SAME_STREET_DIFFERENT_UNIT and
    // this says DIFFERENT, because the stored key is a string and the street
    // portion cannot be recovered from it unambiguously. Conservative in the
    // right direction — it never merges two homes — and the residual shows up as
    // a conflict to look at rather than as agreement nobody checks.
    compare: (a, b) => (get(a, 'canonical_address_key') === get(b, 'canonical_address_key') ? 'EQUAL' : 'DIFFERENT'),
  },
  {
    field: 'canonical_sale_date',
    replaces: 'assessor_sale_date',
    present: (row) => get(row, 'canonical_sale_date') !== null,
    compare: (a, b) => fromDate(compareDates(saleDateOf(a), saleDateOf(b))),
  },
  {
    field: 'canonical_sale_value',
    replaces: 'assessor_sale_value',
    present: (row) => get(row, 'canonical_sale_value_minor') !== null,
    compare: (a, b) => fromMoney(compareMoney(moneyOf(a, 'canonical_sale_value_minor'), moneyOf(b, 'canonical_sale_value_minor'))),
  },
  {
    field: 'canonical_tax_total',
    replaces: 'tax_total',
    present: (row) => get(row, 'canonical_tax_total_minor') !== null,
    compare: (a, b) => fromMoney(compareMoney(moneyOf(a, 'canonical_tax_total_minor'), moneyOf(b, 'canonical_tax_total_minor'))),
  },
];

function fromArea(agreement: ReturnType<typeof compareAreas>): FieldComparison {
  switch (agreement) {
    case 'EQUAL': return 'EQUAL';
    case 'EQUAL_WITHIN_SOURCE_PRECISION': return 'EQUIVALENT';
    case 'DIFFERENT': return 'DIFFERENT';
    default: return 'INCOMPARABLE';
  }
}

function fromDate(agreement: ReturnType<typeof compareDates>): FieldComparison {
  switch (agreement) {
    case 'EQUAL': return 'EQUAL';
    case 'EQUAL_AT_SHARED_PRECISION': return 'EQUIVALENT';
    case 'DIFFERENT': return 'DIFFERENT';
    // Two dates that mean different things are not a disagreement and not an
    // agreement. Forcing them into either bucket is how a merge goes wrong.
    case 'INCOMPARABLE_SEMANTICS': return 'INCOMPARABLE';
    default: return 'INCOMPARABLE';
  }
}

function fromMoney(agreement: ReturnType<typeof compareMoney>): FieldComparison {
  switch (agreement) {
    case 'EQUAL': return 'EQUAL';
    case 'EQUAL_AT_WHOLE_UNITS': return 'EQUIVALENT';
    case 'DIFFERENT': return 'DIFFERENT';
    default: return 'INCOMPARABLE';
  }
}

/**
 * Extracts one comparable row per (property, source) from a canonical bundle.
 *
 * The two connectors put equivalent facts in different places — that is what a
 * canonical layer is for — so this reads the canonical rows and not the raw
 * attribute names.
 */
export function comparableOf(bundle: CanonicalBundle): ComparableParcel | null {
  const identifier = bundle.propertyIdentifiers.find((o) => o.identifierType === 'county_parcel');
  if (identifier === undefined || identifier.propertyId === null) return null;

  const characteristics = bundle.characteristics?.[0];
  const assessment = bundle.assessments?.[0];
  const chars = (characteristics?.characteristics ?? {}) as Record<string, unknown>;

  const owner = bundle.parties.find((party) => party.role === 'assessor_owner_of_record');
  const taxpayer = bundle.parties.find((party) => party.role === 'assessor_taxpayer');

  const area = chars['acres_polygon'] ?? chars['acres_deed'] ?? characteristics?.parcelAreaSqFt ?? null;

  return {
    p: identifier.propertyId,
    s: bundle.transaction.sourceId,
    c: identifier.countyFips ?? '',
    fields: {
      normalized_parcel: identifier.normalizedValue,
      situs_address: str(chars['situs_address']),
      owner_name: owner?.normalizedName ?? null,
      taxpayer_name: taxpayer?.normalizedName ?? null,
      year_built: characteristics?.yearBuilt === null || characteristics?.yearBuilt === undefined
        ? null : String(characteristics.yearBuilt),
      parcel_area: str(area),
      classification: assessment?.propertyTypeName ?? assessment?.propertyTypeCode ?? null,
      assessment_total: assessment?.totalValue ? String(assessment.totalValue.amountMinor) : null,
      assessment_land: assessment?.landValue ? String(assessment.landValue.amountMinor) : null,
      assessment_building: assessment?.buildingValue ? String(assessment.buildingValue.amountMinor) : null,
      tax_total: assessment?.netTax ? String(assessment.netTax.amountMinor)
        : str((assessment?.characteristics as Record<string, unknown> | undefined)?.['total_net_tax_minor']),
      tax_year: str((assessment?.characteristics as Record<string, unknown> | undefined)?.['tax_year'])
        ?? (assessment?.assessmentYear === null || assessment?.assessmentYear === undefined ? null : String(assessment.assessmentYear)),
      // Both connectors label the assessor's sale echo with the same key, which
      // is the point of naming it explicitly in both.
      assessor_sale_date: str(chars['assessor_sale_date'] ?? chars['assessor_last_sale_date']),
      assessor_sale_value: str(chars['assessor_sale_value_minor'] ?? chars['assessor_last_sale_price_minor']),
      source_edit_date: str(chars['source_edit_date']),

      // The contract's own output, carried through so the canonical comparators
      // can reconstruct the values they need rather than re-deriving them from
      // source columns the audit should not know about.
      canonical_area_square_feet: str(chars['canonical_area_square_feet']),
      canonical_area_source_unit: str(chars['canonical_area_source_unit']),
      canonical_area_source_value: str(chars['canonical_area_source_value']),
      canonical_address_key: str(chars['canonical_address_key']),
      canonical_sale_date: str(chars['canonical_sale_date']),
      canonical_sale_date_precision: str(chars['canonical_sale_date_precision']),
      canonical_sale_value_minor: str(chars['canonical_sale_value_minor']),
      canonical_tax_total_minor: str(chars['canonical_tax_total_minor']),
      normalization_contract: str(chars['normalization_contract']),
    },
  };
}

export type OverlapAudit = {
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  readonly mode: AuditMode;
  /** Properties observed by both sources. */
  readonly overlapping: number;
  readonly onlyDirect: number;
  readonly onlyAggregation: number;
  readonly agreements: readonly FieldAgreement[];
  readonly decisions: readonly FieldAuthorityDecision[];
  /**
   * Contract versions seen, per source. A canonical-mode audit across two
   * different contract versions is comparing two different questions.
   */
  readonly contractVersions: Readonly<Record<string, string>>;
};

/**
 * `'literal'` reproduces the DF-0H comparison exactly. `'canonical'` compares
 * through the normalization contract.
 */
export type AuditMode = 'literal' | 'canonical';

export type AuditOptions = {
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  readonly decidedAt: string;
  readonly mode?: AuditMode;
  readonly sort?: SortOptions;
  /** Restrict to one county, so the audit is a partition-scoped question. */
  readonly countyFips?: string;
};

/**
 * Folds both sources' canonical rows into an agreement profile per field.
 *
 * In literal mode values are compared twice: byte-identical, and again after
 * case and punctuation folding. The gap between the two is the "same fact,
 * different formatting" population. In canonical mode the contract comparators
 * add a third outcome, `equivalent` — same fact, different representation, where
 * the difference is unit, precision or rounding rather than spelling.
 */
export async function auditOverlap(
  comparables: () => AsyncIterable<string>,
  options: AuditOptions,
): Promise<OverlapAudit> {
  const mode: AuditMode = options.mode ?? 'literal';
  const canonicalFields = mode === 'canonical' ? CANONICAL_COMPARED_FIELDS : [];
  // In canonical mode the superseded literal fields are dropped from the tally:
  // reporting `parcel_area` at 0% next to `canonical_parcel_area` at 99% invites
  // someone to quote the wrong one.
  const superseded = new Set(canonicalFields.map((f) => f.replaces));
  const literalFields = COMPARED_FIELDS.filter((f) => !superseded.has(f));

  const blank = (field: string): Mutable<FieldAgreement> => ({
    field, bothPopulated: 0, exactMatch: 0, normalizedMatch: 0, equivalentMatch: 0,
    conflict: 0, incomparable: 0, onlyDirect: 0, onlyAggregation: 0, neither: 0,
  });
  const tally = new Map<string, Mutable<FieldAgreement>>();
  for (const field of literalFields) tally.set(field, blank(field));
  for (const field of canonicalFields) tally.set(field.field, blank(field.field));

  const contractVersions: Record<string, string> = {};
  let overlapping = 0;
  let onlyDirect = 0;
  let onlyAggregation = 0;

  const grouped = groupSorted(
    externalSort(comparables(), keyOfProperty, options.sort ?? {}),
    keyOfProperty,
    (line) => JSON.parse(line) as ComparableParcel,
  );

  for await (const { items } of grouped) {
    const direct = items.find((i) => i.s === options.directSourceId);
    const aggregation = items.find((i) => i.s === options.aggregationSourceId);
    if (options.countyFips !== undefined) {
      const county = (direct ?? aggregation)?.c;
      if (county !== options.countyFips) continue;
    }

    if (direct && aggregation) overlapping += 1;
    else if (direct) { onlyDirect += 1; continue; }
    else if (aggregation) { onlyAggregation += 1; continue; }
    else continue;

    for (const row of [direct, aggregation]) {
      const version = get(row, 'normalization_contract');
      if (version !== null) contractVersions[row.s] = version;
    }

    for (const field of literalFields) {
      const row = tally.get(field) as Mutable<FieldAgreement>;
      const a = direct.fields[field] ?? null;
      const b = aggregation.fields[field] ?? null;

      if (a === null && b === null) { row.neither += 1; continue; }
      if (a !== null && b === null) { row.onlyDirect += 1; continue; }
      if (a === null && b !== null) { row.onlyAggregation += 1; continue; }

      row.bothPopulated += 1;
      if (a === b) row.exactMatch += 1;
      else if (fold(a as string) === fold(b as string)) row.normalizedMatch += 1;
      else row.conflict += 1;
    }

    for (const field of canonicalFields) {
      const row = tally.get(field.field) as Mutable<FieldAgreement>;
      const hasA = field.present(direct);
      const hasB = field.present(aggregation);

      if (!hasA && !hasB) { row.neither += 1; continue; }
      if (hasA && !hasB) { row.onlyDirect += 1; continue; }
      if (!hasA && hasB) { row.onlyAggregation += 1; continue; }

      row.bothPopulated += 1;
      switch (field.compare(direct, aggregation)) {
        case 'EQUAL': row.exactMatch += 1; break;
        case 'EQUIVALENT': row.equivalentMatch += 1; break;
        case 'DIFFERENT': row.conflict += 1; break;
        case 'INCOMPARABLE': row.incomparable += 1; break;
      }
    }
  }

  const order = [...literalFields, ...canonicalFields.map((f) => f.field)];
  const agreements = order.map((field) => ({ ...(tally.get(field) as FieldAgreement) }));
  const decisions = agreements.map((agreement) => deriveVerdict(agreement, {
    directSourceId: options.directSourceId,
    aggregationSourceId: options.aggregationSourceId,
    decidedAt: options.decidedAt,
  }));

  return {
    directSourceId: options.directSourceId,
    aggregationSourceId: options.aggregationSourceId,
    mode,
    overlapping,
    onlyDirect,
    onlyAggregation,
    agreements,
    decisions,
    contractVersions,
  };
}

// ---------------------------------------------------------------------------
// Before and after
// ---------------------------------------------------------------------------

/**
 * What the contract changed for one field.
 *
 * `explainedByNormalization` is the number this phase exists to produce: parcels
 * the old comparison called a conflict and the contract can account for. It is
 * reported alongside `remainingConflicts`, never instead of it — the second
 * number is the one that means something.
 */
export type FieldMigration = {
  readonly literalField: string;
  readonly canonicalField: string;
  readonly bothPopulated: number;
  readonly literalAgreementRate: number;
  readonly canonicalAgreementRate: number;
  readonly literalConflicts: number;
  readonly remainingConflicts: number;
  readonly explainedByNormalization: number;
  readonly incomparable: number;
  /** Why the difference existed, stated by the adapter that knows. */
  readonly cause: string;
};

export type OverlapMigrationReport = {
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  readonly overlapping: number;
  readonly fields: readonly FieldMigration[];
  /** Fields the contract did not touch, so nobody assumes it touched everything. */
  readonly unchangedFields: readonly string[];
};

/**
 * Known causes, so the report says *why* rather than just *how much*.
 *
 * Each of these was established from a specific real parcel; see
 * `docs/CANONICAL-NORMALIZATION.md` for the values.
 */
const MIGRATION_CAUSES: Readonly<Record<string, string>> = {
  canonical_parcel_area: 'the direct source publishes square feet and the aggregation publishes acres rounded to two decimals',
  canonical_address: 'the direct source packs street name, type and directional into one field; the aggregation splits them',
  canonical_sale_date: 'the direct source states YYYYMM; the aggregation pads a day it does not have',
  canonical_sale_value: 'scale only, where the sources agree',
  canonical_tax_total: "the aggregation's tax column is an integer, so cents are lost",
};

/**
 * Compares a literal-mode audit against a canonical-mode audit of the same data.
 *
 * Both audits must come from the same population, or the differences are not
 * attributable to the comparators.
 */
export function overlapMigrationReport(before: OverlapAudit, after: OverlapAudit): OverlapMigrationReport {
  if (before.mode !== 'literal' || after.mode !== 'canonical') {
    throw new Error('a migration report compares a literal audit against a canonical audit, in that order');
  }
  if (before.overlapping !== after.overlapping) {
    throw new Error(
      `the two audits saw different populations (${before.overlapping} and ${after.overlapping} overlapping properties); `
      + 'the difference would not be attributable to normalization',
    );
  }

  const beforeByField = new Map(before.agreements.map((a) => [a.field, a]));
  const afterByField = new Map(after.agreements.map((a) => [a.field, a]));

  const fields = CANONICAL_COMPARED_FIELDS.map((definition): FieldMigration => {
    const literal = beforeByField.get(definition.replaces);
    const canonical = afterByField.get(definition.field);
    if (literal === undefined || canonical === undefined) {
      throw new Error(`the audits do not both cover ${definition.replaces} / ${definition.field}`);
    }
    return {
      literalField: definition.replaces,
      canonicalField: definition.field,
      bothPopulated: canonical.bothPopulated,
      literalAgreementRate: agreementRate(literal),
      canonicalAgreementRate: agreementRate(canonical),
      literalConflicts: literal.conflict,
      remainingConflicts: canonical.conflict,
      // Clamped at zero: if the contract somehow found MORE conflicts, that is a
      // finding to report as a negative rate, not a negative "explained" count.
      explainedByNormalization: Math.max(0, literal.conflict - canonical.conflict),
      incomparable: canonical.incomparable,
      cause: MIGRATION_CAUSES[definition.field] ?? 'not characterised',
    };
  });

  const replaced = new Set(CANONICAL_COMPARED_FIELDS.map((f) => f.replaces));
  return {
    directSourceId: before.directSourceId,
    aggregationSourceId: before.aggregationSourceId,
    overlapping: before.overlapping,
    fields,
    unchangedFields: COMPARED_FIELDS.filter((f) => !replaced.has(f)),
  };
}

/** Emits comparable rows from a stream of canonical bundles. */
export async function* comparablesFrom(bundles: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of bundles) {
    const comparable = comparableOf(JSON.parse(line) as CanonicalBundle);
    if (comparable !== null) yield canonicalJson(comparable);
  }
}

function keyOfProperty(line: string): string {
  const at = line.indexOf('"p":"');
  if (at === -1) return '';
  const from = at + 5;
  const to = line.indexOf('"', from);
  return to === -1 ? '' : line.slice(from, to);
}

/** Case and punctuation folding only. No street-type expansion, no guessing. */
function fold(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export { agreementRate };
