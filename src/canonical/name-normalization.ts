/**
 * Organization name normalization.
 *
 * This exists to generate *candidates*, and for nothing else. The distinction is
 * the whole point of the module:
 *
 *   normalization  → "these two strings might name the same company"
 *   resolution     → "these two observations ARE the same company"
 *
 * Only the second is an identity claim, and normalization is never sufficient
 * evidence for it. `NORTH STAR HOMES LLC` and `NORTHSTAR HOMES LLC` normalize to
 * the same search key here; whether they are one company is a question for the
 * Secretary of State's register, not for a string function.
 *
 * Every operation below is **deterministic and reversible in intent** — it
 * removes formatting that filers apply inconsistently, and nothing else. There
 * is deliberately no phonetic matching, no edit distance, no token dropping and
 * no stemming: each of those merges companies that are genuinely different, and
 * a false merge is worse than a miss.
 *
 * The raw name is always retained by the caller. Nothing here overwrites it.
 */

/**
 * Entity suffixes standardised for search only.
 *
 * A filer may write `L.L.C.`, `LLC`, `L L C` or `LIMITED LIABILITY COMPANY` for
 * the same registration. Folding them lets those four spellings produce one
 * search key. The suffix is *kept*, not stripped: `SMITH LLC` and `SMITH INC`
 * are different companies and must not collide.
 */
const SUFFIX_FORMS: readonly (readonly [RegExp, string])[] = [
  [/\bL\.?\s?L\.?\s?C\.?\b/g, 'LLC'],
  [/\bLIMITED LIABILITY COMPANY\b/g, 'LLC'],
  [/\bL\.?\s?L\.?\s?P\.?\b/g, 'LLP'],
  [/\bLIMITED LIABILITY PARTNERSHIP\b/g, 'LLP'],
  [/\bL\.?\s?L\.?\s?L\.?\s?P\.?\b/g, 'LLLP'],
  [/\bLIMITED PARTNERSHIP\b/g, 'LP'],
  [/\bL\.?\s?P\.?\b/g, 'LP'],
  [/\bINCORPORATED\b/g, 'INC'],
  [/\bINC\.?\b/g, 'INC'],
  [/\bCORPORATION\b/g, 'CORP'],
  [/\bCORP\.?\b/g, 'CORP'],
  [/\bCOMPANY\b/g, 'CO'],
  [/\bCO\.?\b/g, 'CO'],
  [/\bLIMITED\b/g, 'LTD'],
  [/\bLTD\.?\b/g, 'LTD'],
  [/\bNATIONAL ASSOCIATION\b/g, 'NA'],
  [/\bN\.?\s?A\.?\b/g, 'NA'],
  [/\bPROFESSIONAL ASSOCIATION\b/g, 'PA'],
  [/\bASSOCIATION\b/g, 'ASSN'],
];

export type NormalizedName = {
  /** Case, punctuation and suffix folded. The candidate-generation key. */
  readonly search: string;
  /**
   * `search` with internal spaces removed.
   *
   * This is what makes `NORTH STAR HOMES LLC` and `NORTHSTAR HOMES LLC` collide.
   * It is a *broader* key and therefore a weaker signal: it is offered for
   * candidate generation and is never permitted to resolve anything on its own.
   */
  readonly compact: string;
  /** True when folding actually changed something, for auditing a match. */
  readonly changed: boolean;
};

/**
 * Folds a name for candidate lookup.
 *
 * Unicode NFKC first, so a filer's typographic apostrophe and a plain one agree.
 */
export function normalizeOrganizationName(raw: string): NormalizedName {
  const original = raw;

  let value = raw.normalize('NFKC').toUpperCase();

  // Ampersand and "AND" are written interchangeably by filers.
  value = value.replace(/\s*&\s*/g, ' AND ');

  // Punctuation to spaces, deliberately BEFORE suffix folding so `L.L.C.` and
  // `LLC` reach the suffix rules in the same shape.
  value = value.replace(/[.,]/g, ' ');
  value = value.replace(/\s+/g, ' ').trim();

  for (const [pattern, replacement] of SUFFIX_FORMS) {
    value = value.replace(pattern, replacement);
  }

  // Remaining punctuation. Hyphens become spaces rather than vanishing, so
  // `WELL-BUILT` and `WELL BUILT` agree while `WELLBUILT` stays distinct at the
  // `search` level — it only joins them at the weaker `compact` level.
  value = value.replace(/[^A-Z0-9 ]/g, ' ');
  const search = value.replace(/\s+/g, ' ').trim();

  return {
    search,
    compact: search.replace(/ /g, ''),
    changed: search !== original.toUpperCase().trim(),
  };
}

/**
 * True when a name looks like an organization rather than a natural person.
 *
 * Used only to decide *whether to look for a registration at all*. It is a
 * routing hint, never a classification stored as fact: a source that does not
 * say whether a party is a person or a company still does not say it after this
 * function runs, and the party's `kind` stays `unknown`.
 */
export function looksLikeOrganization(raw: string): boolean {
  const { search } = normalizeOrganizationName(raw);
  if (/\b(LLC|LLP|LLLP|LP|INC|CORP|CO|LTD|NA|PA|ASSN|TRUST|BANK|COOPERATIVE|COOP|FUND|HOLDINGS|PARTNERS|GROUP|PROPERTIES|VENTURES|ENTERPRISES)\b/.test(search)) {
    return true;
  }
  // A comma-first personal form ("SMITH, JOHN R") is the assessor roll's usual
  // shape for a natural person.
  if (/^[A-Z'-]+,\s/.test(raw.trim().toUpperCase())) return false;
  return false;
}

/**
 * Groups names that share a normalized key, for collision measurement.
 *
 * Deliberately returns the groups rather than a boolean: the question "is this
 * key safe to resolve on?" is answered by measuring collisions in real data,
 * not by assuming.
 */
export function groupByKey<T>(
  items: Iterable<T>,
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key) ?? [];
    list.push(item);
    out.set(key, list);
  }
  return out;
}
