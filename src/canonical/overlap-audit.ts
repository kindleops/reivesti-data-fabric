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
 */
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { canonicalJson } from '../core/hash.ts';
import type { CanonicalBundle } from './models.ts';
import { agreementRate, deriveVerdict, type FieldAgreement, type FieldAuthorityDecision } from './source-authority.ts';

/** One source's canonical answer for a parcel, flattened to what comparison needs. */
export type ComparableParcel = {
  /** propertyId */ readonly p: string;
  /** sourceId */ readonly s: string;
  /** countyFips */ readonly c: string;
  readonly fields: Readonly<Record<string, string | null>>;
};

/** The fields compared, in report order. */
export const COMPARED_FIELDS: readonly string[] = [
  'normalized_parcel', 'situs_address', 'owner_name', 'taxpayer_name',
  'year_built', 'parcel_area', 'classification',
  'assessment_total', 'assessment_land', 'assessment_building',
  'tax_total', 'tax_year', 'assessor_sale_date', 'assessor_sale_value',
  'source_edit_date',
];

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
    },
  };
}

export type OverlapAudit = {
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  /** Properties observed by both sources. */
  readonly overlapping: number;
  readonly onlyDirect: number;
  readonly onlyAggregation: number;
  readonly agreements: readonly FieldAgreement[];
  readonly decisions: readonly FieldAuthorityDecision[];
};

export type AuditOptions = {
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  readonly decidedAt: string;
  readonly sort?: SortOptions;
  /** Restrict to one county, so the audit is a partition-scoped question. */
  readonly countyFips?: string;
};

/**
 * Folds both sources' canonical rows into an agreement profile per field.
 *
 * Values are compared twice: byte-identical, and again after case and
 * punctuation folding. The gap between the two is exactly the "same fact,
 * different formatting" population, and reporting it separately stops a
 * formatting difference being mistaken for a conflict.
 */
export async function auditOverlap(
  comparables: () => AsyncIterable<string>,
  options: AuditOptions,
): Promise<OverlapAudit> {
  const blank = (): FieldAgreement => ({
    field: '', bothPopulated: 0, exactMatch: 0, normalizedMatch: 0, conflict: 0,
    onlyDirect: 0, onlyAggregation: 0, neither: 0,
  });
  const tally = new Map<string, { -readonly [K in keyof FieldAgreement]: FieldAgreement[K] }>();
  for (const field of COMPARED_FIELDS) tally.set(field, { ...blank(), field });

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

    for (const field of COMPARED_FIELDS) {
      const row = tally.get(field) as { -readonly [K in keyof FieldAgreement]: FieldAgreement[K] };
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
  }

  const agreements = COMPARED_FIELDS.map((field) => ({ ...(tally.get(field) as FieldAgreement) }));
  const decisions = agreements.map((agreement) => deriveVerdict(agreement, {
    directSourceId: options.directSourceId,
    aggregationSourceId: options.aggregationSourceId,
    decidedAt: options.decidedAt,
  }));

  return {
    directSourceId: options.directSourceId,
    aggregationSourceId: options.aggregationSourceId,
    overlapping,
    onlyDirect,
    onlyAggregation,
    agreements,
    decisions,
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

export { agreementRate };
