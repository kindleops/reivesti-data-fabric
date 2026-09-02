/**
 * Field-level source authority.
 *
 * Hennepin County now appears in two legitimate sources: its own ArcGIS parcel
 * service, and the state aggregation that republishes it. Both are free, both
 * are sanctioned, both are the county's data. The question is not "which source
 * wins" — that question has no good answer — but **"which source is authoritative
 * for which field"**, which does.
 *
 * Three rules make that safe.
 *
 * **Authority is per field, never per source.** A state aggregation can be
 * fresher on one attribute and thinner on another. Declaring a blanket winner
 * throws away whichever half the loser was better at.
 *
 * **Evidence is never destroyed.** A canonical current value prefers one source;
 * both observations remain in the estate with their own provenance. If they
 * disagree, the disagreement is recorded — it is not resolved by deletion.
 *
 * **A source is retired only on proof, not on redundancy that looks likely.**
 * See `supersessionCheck`.
 */
import type { Capability } from '../registry/types.ts';

/**
 * What the evidence says about two sources' claims on one field.
 *
 * `SEMANTICALLY_DIFFERENT` is the value that stops most bad merges: two sources
 * can populate the same-looking field with different things, and preferring
 * either would be a category error rather than a freshness judgement.
 */
export type FieldAuthorityVerdict =
  | 'PREFER_DIRECT_COUNTY'
  | 'PREFER_STATE_AGGREGATION'
  /** Both are equally good. Either may be read; both are retained. */
  | 'COEQUAL_OBSERVATIONS'
  /** They look like the same field and are not. Never reconcile these. */
  | 'SEMANTICALLY_DIFFERENT'
  /** Not enough evidence yet. The honest default. */
  | 'UNRESOLVED';

export type FieldAuthorityDecision = {
  /** Canonical field or characteristic the decision governs. */
  readonly field: string;
  readonly verdict: FieldAuthorityVerdict;
  /** The measurement that justified it. Never a hunch. */
  readonly basis: string;
  /** Sources compared, in the order the verdict names them. */
  readonly directSourceId: string;
  readonly aggregationSourceId: string;
  readonly decidedAt: string;
};

/** One field's agreement profile across two sources, over a real population. */
export type FieldAgreement = {
  readonly field: string;
  /** Properties where both sources supplied a value. */
  readonly bothPopulated: number;
  /** …and the values were byte-identical. */
  readonly exactMatch: number;
  /** …and they matched after case/punctuation folding. */
  readonly normalizedMatch: number;
  /**
   * …and they stated the same fact in different representations.
   *
   * Square feet against acres, cents against whole dollars, a month against a
   * padded day. Counted separately from `exactMatch` on purpose: the sources
   * really did write different things down, and a report that hid that would be
   * claiming a precision neither publisher offers.
   */
  readonly equivalentMatch: number;
  /** …and they genuinely disagreed. */
  readonly conflict: number;
  /**
   * …and the question does not apply: two dates with different meanings, or a
   * value the contract could not parse. Neither agreement nor conflict, and
   * excluded from the rate rather than quietly counted as one of them.
   */
  readonly incomparable: number;
  readonly onlyDirect: number;
  readonly onlyAggregation: number;
  readonly neither: number;
};

/**
 * Agreement over the population where the question is answerable.
 *
 * `incomparable` rows are removed from the denominator, not scored as failures:
 * a sale date and a recording date that happen to fall on the same day tell you
 * nothing about either source's accuracy.
 */
export function agreementRate(a: FieldAgreement): number {
  const comparable = a.bothPopulated - a.incomparable;
  if (comparable <= 0) return 0;
  const agreed = a.exactMatch + a.normalizedMatch + a.equivalentMatch;
  return Math.round((agreed / comparable) * 10_000) / 10_000;
}

/**
 * Derives a verdict from a measured agreement profile.
 *
 * Deliberately conservative and deliberately arithmetic. The interesting case is
 * coverage: when one source populates a field that the other simply does not
 * have, that is not a disagreement to adjudicate — it is the only source for
 * that field, and preferring it is a statement of fact rather than a judgement.
 */
export function deriveVerdict(
  agreement: FieldAgreement,
  options: { readonly directSourceId: string; readonly aggregationSourceId: string; readonly decidedAt: string },
): FieldAuthorityDecision {
  const rate = agreementRate(agreement);
  const base = { field: agreement.field, ...options };

  // Only one source carries it at all.
  if (agreement.bothPopulated === 0 && agreement.onlyDirect > 0 && agreement.onlyAggregation === 0) {
    return { ...base, verdict: 'PREFER_DIRECT_COUNTY', basis: `only the direct county source populates this field (${agreement.onlyDirect} properties)` };
  }
  if (agreement.bothPopulated === 0 && agreement.onlyAggregation > 0 && agreement.onlyDirect === 0) {
    return { ...base, verdict: 'PREFER_STATE_AGGREGATION', basis: `only the state aggregation populates this field (${agreement.onlyAggregation} properties)` };
  }
  if (agreement.bothPopulated === 0) {
    return { ...base, verdict: 'UNRESOLVED', basis: 'no property has a value from both sources' };
  }
  if (agreement.bothPopulated - agreement.incomparable <= 0) {
    return {
      ...base, verdict: 'SEMANTICALLY_DIFFERENT',
      basis: `all ${agreement.incomparable} populated pairs are incomparable — the two fields do not answer the same question`,
    };
  }

  // Near-total agreement: neither is better, and saying so beats inventing a
  // preference that would then be relied on.
  if (rate >= 0.999) {
    const equivalent = agreement.equivalentMatch === 0 ? ''
      : `, of which ${agreement.equivalentMatch} agree only after unit or precision normalization`;
    return {
      ...base, verdict: 'COEQUAL_OBSERVATIONS',
      basis: `${(rate * 100).toFixed(2)}% agreement over ${agreement.bothPopulated} properties${equivalent}`,
    };
  }

  // Wholesale disagreement is not a freshness problem. Two sources that agree on
  // almost nothing are almost certainly not reporting the same thing.
  if (rate < 0.5) {
    return {
      ...base, verdict: 'SEMANTICALLY_DIFFERENT',
      basis: `only ${(rate * 100).toFixed(2)}% agreement over ${agreement.bothPopulated} properties — too low to be `
        + 'staleness; these fields probably do not mean the same thing',
    };
  }

  // Partial disagreement is where freshness lives, and the profile alone cannot
  // settle it. Refusing to guess is the point.
  return {
    ...base, verdict: 'UNRESOLVED',
    basis: `${(rate * 100).toFixed(2)}% agreement over ${agreement.bothPopulated} properties, `
      + `${agreement.conflict} conflicts — needs a dated comparison before a preference is defensible`,
  };
}

/**
 * Whether one source may be retired in favour of another.
 *
 * Every condition must hold, and the function returns the ones that do not.
 * "The new source covers more counties" is not on the list: breadth is a reason
 * to add a source, never a reason to remove one.
 */
export type SupersessionCheck = {
  readonly redundantFieldForField: boolean;
  readonly freshnessAtLeastEqual: boolean;
  readonly noUniqueFieldsLost: boolean;
  readonly provenanceRemains: boolean;
  readonly operationalReason: string | null;
};

export type SupersessionVerdict = {
  readonly maySupersede: boolean;
  readonly blockers: readonly string[];
};

export function supersessionCheck(check: SupersessionCheck): SupersessionVerdict {
  const blockers: string[] = [];
  if (!check.redundantFieldForField) blockers.push('the replacement is not redundant field for field');
  if (!check.freshnessAtLeastEqual) blockers.push('the replacement is not at least as fresh');
  if (!check.noUniqueFieldsLost) blockers.push('unique fields would be lost');
  if (!check.provenanceRemains) blockers.push('prior provenance would become unavailable');
  if (check.operationalReason === null) blockers.push('no operational reason to retire the source was documented');
  return { maySupersede: blockers.length === 0, blockers };
}

/**
 * Which source is preferred for a capability in a jurisdiction, and which merely
 * support it.
 *
 * The coverage graph keeps ALL sources for a capability rather than collapsing
 * them to one boolean, because "who else has this?" is the question that matters
 * when a source breaks.
 */
export type CapabilitySourcePreference = {
  readonly jurisdictionId: string;
  readonly capability: Capability;
  /** Preferred where a field-level decision established one; null while unresolved. */
  readonly preferredSourceId: string | null;
  readonly supportingSourceIds: readonly string[];
  readonly lastVerifiedAt: string;
  readonly basis: string;
};
