/**
 * Ranking candidates against the real jurisdiction catalogue.
 *
 * The ranking module itself is pure arithmetic over named components; this is
 * the part that supplies it with facts — how many active county-equivalents a
 * candidate's scope actually reaches, and whether a reusable connector for its
 * platform already exists.
 */
import { expandScope } from '../registry/registry.ts';
import { JURISDICTIONS } from '../registry/jurisdictions.ts';
import type { Capability } from '../registry/types.ts';
import {
  rankCandidates,
  type RankedCandidate,
  type RankingInput,
  type SourceCandidate,
} from './candidates.ts';
import { PLATFORM_FAMILIES, SOURCE_CANDIDATES } from './catalogue.ts';

/**
 * Platforms an implemented connector already speaks.
 *
 * DF-0C/0D's streaming ArcGIS transport is the whole reason a statewide ArcGIS
 * parcel layer is cheap to add: acquisition, pagination, drift detection and
 * bounded-memory crawling are done. What is left is a field map.
 */
export const IMPLEMENTED_PLATFORMS: ReadonlySet<string> = new Set(['arcgis_feature_service']);

/** Authorities that maintain the record for a capability, rather than republishing it. */
function isAuthoritative(candidate: SourceCandidate): boolean {
  const authority = candidate.authority.toLowerCase();
  const stateAggregator = /geospatial|cartographer|office of information technology|department of revenue|orpts/.test(authority);
  const countyOffice = /county|appraisal district|clerk|recorder|assessor/.test(authority);
  return stateAggregator || countyOffice;
}

export function activeCountyCount(): number {
  return JURISDICTIONS.filter((j) => j.jurisdictionType === 'county' && (j.status ?? 'active') === 'active').length;
}

/** How many ACTIVE county-equivalents a candidate's scope reaches. */
export function candidateJurisdictionCount(candidate: SourceCandidate): number {
  const expanded = expandScope(candidate.scope, JURISDICTIONS, `candidate "${candidate.sourceName}"`);
  // A state-scoped candidate expands to the state row, not to its counties, so
  // its leverage is the counties inside those states — which is the number that
  // actually matters when comparing a statewide feed with a single county.
  const stateCodes = new Set(expanded.filter((j) => j.jurisdictionType === 'state').map((j) => j.stateCode));
  const counties = JURISDICTIONS.filter(
    (j) => j.jurisdictionType === 'county'
      && (j.status ?? 'active') === 'active'
      && j.stateCode !== undefined
      && stateCodes.has(j.stateCode),
  ).length;
  const direct = expanded.filter((j) => j.jurisdictionType === 'county' && (j.status ?? 'active') === 'active').length;
  return counties + direct;
}

export function rankingInputFor(candidate: SourceCandidate): RankingInput {
  return {
    candidate,
    jurisdictionCount: candidateJurisdictionCount(candidate),
    totalJurisdictions: activeCountyCount(),
    authoritative: isAuthoritative(candidate),
    platformConnectorExists: candidate.platformId !== null && IMPLEMENTED_PLATFORMS.has(candidate.platformId),
  };
}

export function rankCatalogue(
  candidates: readonly SourceCandidate[] = SOURCE_CANDIDATES,
): readonly RankedCandidate[] {
  return rankCandidates(candidates.map(rankingInputFor));
}

export function platformFamily(platformId: string) {
  return PLATFORM_FAMILIES.find((p) => p.platformId === platformId);
}

/** Candidates that would serve a capability, ranked. */
export function candidatesForCapability(capability: Capability): readonly RankedCandidate[] {
  return rankCatalogue(SOURCE_CANDIDATES.filter((c) => c.capabilities.includes(capability)));
}
