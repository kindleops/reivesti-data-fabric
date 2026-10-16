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
 * The fold is FULL_NATIONAL only when nothing expected is missing AND the
 * expected set is known to be whole. Otherwise it is PARTIAL and names the
 * missing runs — or, when nothing is missing but the history is not
 * established, UNVERIFIED.
 *
 * The history is not established when the estate already held a fold written
 * before this rule: that fold recorded no runs, so a run whose evidence was
 * released and which left no partition contribution (a business-registry run,
 * say) is invisible to every later expected set. Such a fold stays UNVERIFIED,
 * and so does every fold after it on that estate, until the estate is rebuilt
 * from a fold that started under the watermark. A PARTIAL fold is still activated —
 * its links are correct for the evidence it saw — but it is never labelled,
 * reported or counted as national. Organization completeness is its own
 * dimension, separate from property completeness and from source coverage.
 *
 * Absence of a manifest field (a fold written before DF-0O) reads UNVERIFIED.
 */
export const ORGANIZATION_COMPLETENESS_RULE = 'organization_completeness_1';

export type OrganizationCompletenessStatus = 'FULL_NATIONAL' | 'PARTIAL' | 'UNVERIFIED';

export type OrganizationCompleteness = {
  readonly rule: string;
  readonly status: OrganizationCompletenessStatus;
  /** Runs whose committed rows the fold had to see. Sorted. */
  readonly expectedRuns: readonly string[];
  /** Runs whose committed rows the fold read. Sorted. */
  readonly contributingRuns: readonly string[];
  /** Expected and not available: their organization evidence is not in the fold. */
  readonly missingRuns: readonly string[];
  /**
   * False when the expected set descends from a fold that recorded no runs
   * (written before DF-0O). Absent on folds that predate this field: true.
   */
  readonly historyEstablished?: boolean;
};

export function assessOrganizationCompleteness(
  expected: Iterable<string>,
  available: Iterable<string>,
  options: { readonly historyEstablished?: boolean } = {},
): OrganizationCompleteness {
  const want = [...new Set(expected)].sort();
  const have = new Set(available);
  const missingRuns = want.filter((r) => !have.has(r));
  const historyEstablished = options.historyEstablished ?? true;
  return {
    rule: ORGANIZATION_COMPLETENESS_RULE,
    status: missingRuns.length > 0 ? 'PARTIAL' : historyEstablished ? 'FULL_NATIONAL' : 'UNVERIFIED',
    expectedRuns: want,
    contributingRuns: [...have].sort(),
    missingRuns,
    historyEstablished,
  };
}

/**
 * Whether a new fold's expected set can be complete, given the fold before it:
 * yes on a fresh estate (no prior fold), yes after a fold that recorded its
 * runs with an established history, no after a fold that recorded nothing.
 */
export function historyEstablishedAfter(prior: { readonly completeness?: OrganizationCompleteness } | null): boolean {
  if (prior === null) return true;
  if (prior.completeness === undefined) return false;
  return prior.completeness.historyEstablished !== false;
}

/** What a reader should say about a fold: its recorded verdict, or UNVERIFIED. */
export function organizationCompletenessOf(
  manifest: { readonly completeness?: OrganizationCompleteness } | null,
): OrganizationCompletenessStatus | 'UNVERIFIED' | 'ABSENT' {
  if (manifest === null) return 'ABSENT';
  return manifest.completeness?.status ?? 'UNVERIFIED';
}
