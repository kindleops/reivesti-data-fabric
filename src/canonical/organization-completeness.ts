/**
 * Is the national organization fold complete? (DF-0O)
 *
 * `organization/us` is folded from the organization observations in every
 * run's committed canonical rows. Nothing used to record WHICH runs those
 * were, so a fold over an estate whose older run tables had been released —
 * DF-0N's proof environment, where only New York's remained — looked exactly
 * like a fold over the whole estate.
 *
 * The rule is a watermark, not a guess:
 *
 *   EXPECTED   every run whose evidence is live in a property partition (its
 *              contribution file is there), every run the PREVIOUS fold read,
 *              and the run doing the fold;
 *   AVAILABLE  every run whose committed canonical rows can be read now.
 *
 * The fold is FULL_NATIONAL only when nothing expected is missing. Otherwise
 * it is PARTIAL and names the missing runs. A PARTIAL fold is still activated —
 * its links are correct for the evidence it saw — but it is never labelled,
 * reported or counted as national. Organization completeness is its own
 * dimension, separate from property completeness and from source coverage.
 *
 * Absence of a manifest field (a fold written before DF-0O) reads UNVERIFIED.
 */
export const ORGANIZATION_COMPLETENESS_RULE = 'organization_completeness_1';

export type OrganizationCompletenessStatus = 'FULL_NATIONAL' | 'PARTIAL';

export type OrganizationCompleteness = {
  readonly rule: string;
  readonly status: OrganizationCompletenessStatus;
  /** Runs whose committed rows the fold had to see. Sorted. */
  readonly expectedRuns: readonly string[];
  /** Runs whose committed rows the fold read. Sorted. */
  readonly contributingRuns: readonly string[];
  /** Expected and not available: their organization evidence is not in the fold. */
  readonly missingRuns: readonly string[];
};

export function assessOrganizationCompleteness(
  expected: Iterable<string>,
  available: Iterable<string>,
): OrganizationCompleteness {
  const want = [...new Set(expected)].sort();
  const have = new Set(available);
  const missingRuns = want.filter((r) => !have.has(r));
  return {
    rule: ORGANIZATION_COMPLETENESS_RULE,
    status: missingRuns.length === 0 ? 'FULL_NATIONAL' : 'PARTIAL',
    expectedRuns: want,
    contributingRuns: [...have].sort(),
    missingRuns,
  };
}

/** What a reader should say about a fold: its recorded verdict, or UNVERIFIED. */
export function organizationCompletenessOf(
  manifest: { readonly completeness?: OrganizationCompleteness } | null,
): OrganizationCompletenessStatus | 'UNVERIFIED' | 'ABSENT' {
  if (manifest === null) return 'ABSENT';
  return manifest.completeness?.status ?? 'UNVERIFIED';
}
