/**
 * Transaction priority (DF-0Q): what to verify next to close the recorded-
 * transaction gap.
 *
 * A SEPARATE score from `rankCandidate`, deliberately. That ranking answers
 * "which source next?" across every capability, and `df sources rank` and its
 * tests rely on its weights. This one answers a narrower question the estate now
 * has to ask first — national coverage for transfer, deed, mortgage, release,
 * lien and foreclosure is ZERO (NATIONAL-INTEGRATION-CERTIFICATION.md §15) — and
 * it weighs things the general ranking cannot see: what one record MEANS, and
 * whether the counties it reaches already have that capability.
 *
 * Eligibility is a gate, never a weight, in three outcomes:
 *
 *   PROMOTABLE          every discovery gate is evidenced (cost, permission,
 *                       mechanism, terms, coverage). The registry's own
 *                       `assessActivation` still decides schema and provenance
 *                       after promotion — a candidate is never "production".
 *   VERIFICATION_QUEUE  nothing known disqualifies it; something is unproven.
 *                       Scored, so the next research pass has an order.
 *   EXCLUDED            a known (or hypothesised) fact disqualifies it: paid,
 *                       prohibited, manual-only, legally unavailable, or its
 *                       semantics do not support what it claims. Never scored.
 */
import { isAutomatedAcquisition, isZeroCost, type Capability } from '../registry/types.ts';
import type { Registry } from '../registry/registry.ts';
import { lifecycleOf, mappingClaims, type DashboardCapability } from '../registry/lifecycle.ts';
import {
  cadenceScore,
  checkPromotion,
  depthScore,
  jurisdictionLeverage,
  knownNonAutomated,
  type PlatformFamily,
  type SourceCandidate,
} from './candidates.ts';
import { LEGAL_CAPABILITY_LIMITS, PLATFORM_FAMILIES } from './catalogue.ts';
import { NATIONAL_PLATFORM_FAMILIES } from './national-catalogue.ts';
import { activeCountyCount, candidateCounties, IMPLEMENTED_PLATFORMS } from './rank.ts';
import { JURISDICTIONS } from '../registry/jurisdictions.ts';
import {
  semanticOverclaims,
  TRANSACTION_CAPABILITIES,
  type TransactionSemanticClass,
} from './transaction-semantics.ts';

export type TransactionEligibility = 'PROMOTABLE' | 'VERIFICATION_QUEUE' | 'EXCLUDED';

export type TransactionPriorityComponents = {
  /** How much one record of the best declared class is worth. A deed index beats a roll echo. */
  readonly semanticValue: number;
  /** Share of (capability × reached county) cells with no automated-core source today. */
  readonly gapClosure: number;
  /** Same square-root leverage as the general ranking. */
  readonly jurisdictionLeverage: number;
  /** Distinct transaction capabilities, of five. */
  readonly instrumentBreadth: number;
  /** Hypothesised mechanism and permission for unattended retrieval. */
  readonly acquisitionReadiness: number;
  readonly engineeringFeasibility: number;
  readonly refreshFrequency: number;
  readonly historicalDepth: number;
};

export type TransactionPriority = {
  readonly candidateId: string;
  readonly sourceName: string;
  readonly authority: string;
  readonly verification: SourceCandidate['verification'];
  readonly semanticClasses: readonly TransactionSemanticClass[];
  /** Transaction capabilities it claims, less any its states legally cannot have. */
  readonly transactionCapabilities: readonly Capability[];
  readonly countyEquivalents: number;
  readonly eligibility: TransactionEligibility;
  /** EXCLUDED: why. VERIFICATION_QUEUE: what is unproven. PROMOTABLE: empty. */
  readonly blockers: readonly string[];
  /** 0 when EXCLUDED. */
  readonly score: number;
  readonly components: TransactionPriorityComponents;
};

export const TRANSACTION_WEIGHTS: Readonly<Record<keyof TransactionPriorityComponents, number>> = {
  semanticValue: 24,
  gapClosure: 20,
  jurisdictionLeverage: 18,
  instrumentBreadth: 10,
  acquisitionReadiness: 10,
  engineeringFeasibility: 6,
  refreshFrequency: 6,
  historicalDepth: 6,
};

/**
 * What one record is worth to closing the transaction gap. Ordered by how much
 * of a real transaction it can evidence on its own: a recorded instrument names
 * parties, roles and a document; a declaration adds consideration but not the
 * lien picture; an echo only supports a sale someone else stated.
 */
export const SEMANTIC_VALUE: Readonly<Record<TransactionSemanticClass, number>> = {
  RECORDED_INSTRUMENT: 1,
  TRANSFER_DECLARATION: 0.9,
  FORECLOSURE_NOTICE: 0.7,
  TAX_SALE_EVENT: 0.6,
  ASSESSOR_SALE_OBSERVATION: 0.5,
  AUCTION_LISTING: 0.35,
  TAX_ROLL_SALE_ECHO: 0.2,
};

const DASHBOARD_OF: Readonly<Partial<Record<Capability, DashboardCapability>>> = {
  transfer: 'TRANSFER', deed: 'DEED', mortgage: 'MORTGAGE', mortgage_release: 'MORTGAGE_RELEASE', lien: 'LIEN',
  foreclosure_notice: 'FORECLOSURE_NOTICE', sale_observation: 'SALE_OBSERVATION', sale_economics: 'SALE_ECONOMICS',
};

/** County ids with an ACTIVE_AUTOMATED_CORE source claiming a dashboard capability. */
function automatedCoreCounties(registry: Registry, capability: DashboardCapability): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const mapping of registry.mappings) {
    if (!mappingClaims(mapping, capability)) continue;
    if (lifecycleOf(registry.source(mapping.sourceId), mapping).lifecycle !== 'ACTIVE_AUTOMATED_CORE') continue;
    for (const j of registry.expand(mapping)) if (j.jurisdictionType === 'county') ids.add(j.jurisdictionId);
  }
  return ids;
}

const STATE_OF_COUNTY: ReadonlyMap<string, string> = new Map(
  JURISDICTIONS.filter((j) => j.jurisdictionType === 'county' && j.stateCode !== undefined)
    .map((j) => [j.jurisdictionId, j.stateCode as string]),
);

/** Drops a capability only when EVERY state the candidate reaches is legally barred from it. */
function legallyAvailable(capabilities: readonly Capability[], counties: readonly string[]): readonly Capability[] {
  const states = new Set(counties.map((id) => STATE_OF_COUNTY.get(id)).filter((s): s is string => s !== undefined));
  if (states.size === 0) return capabilities;
  return capabilities.filter((cap) => ![...states].every(
    (state) => LEGAL_CAPABILITY_LIMITS.some((l) => l.stateCodes.includes(state) && l.capabilities.includes(cap)),
  ));
}

const FAMILIES: ReadonlyMap<string, PlatformFamily> = new Map(
  [...PLATFORM_FAMILIES, ...NATIONAL_PLATFORM_FAMILIES].map((p) => [p.platformId, p]),
);

/**
 * Implemented transport 1; a reusable family 0.7; no known platform 0.4; a
 * family the catalogue itself marks non-reusable (vendor portals, PDF postings)
 * 0.3 — being on one is evidence of per-county work, not of shared leverage.
 */
function feasibility(platformId: string | null): number {
  if (platformId === null) return 0.4;
  if (IMPLEMENTED_PLATFORMS.has(platformId)) return 1;
  return FAMILIES.get(platformId)?.connectorReusable === false ? 0.3 : 0.7;
}

const qualify = (c: SourceCandidate, reason: string): string =>
  c.verification === 'VERIFIED' || c.verification === 'VERIFIED_LIVE' ? reason : `${reason} (hypothesis; ${c.verification})`;

export function transactionPriority(candidate: SourceCandidate, registry: Registry): TransactionPriority {
  const c = candidate;
  const counties = candidateCounties(c);
  const claimed = c.capabilities.filter((cap) => TRANSACTION_CAPABILITIES.has(cap));
  const capabilities = legallyAvailable(claimed, counties);
  const classes = c.transactionSemantics ?? [];

  // --- eligibility -------------------------------------------------------
  const excluded: string[] = [];
  if (c.verification === 'RULED_OUT') excluded.push('ruled out');
  if (claimed.length === 0) excluded.push('claims no transaction capability');
  else if (capabilities.length === 0) excluded.push('every transaction capability it claims is legally unavailable in its states');
  const overclaimed = semanticOverclaims(c.capabilities, c.transactionSemantics);
  if (overclaimed.length > 0) {
    excluded.push(`declared semantics [${classes.join(', ') || 'none'}] cannot support: ${overclaimed.join(', ')}`);
  }
  if (!isZeroCost(c.costHypothesis) && c.costHypothesis !== 'UNKNOWN_COST') {
    excluded.push(qualify(c, `${c.costHypothesis}: Reivesti does not pay for core data`));
  }
  if (c.automationHypothesis === 'prohibited' || c.acquisitionHypothesis === 'PROHIBITED_AUTOMATION') {
    excluded.push(qualify(c, 'automated acquisition is prohibited by the publisher'));
  } else if (knownNonAutomated(c)) {
    excluded.push(qualify(c, 'no unattended acquisition path: a human is not an acquisition mechanism'));
  }

  const unproven = new Set<string>();
  if (c.costHypothesis === 'UNKNOWN_COST') unproven.add('cost not established; unknown is not free');
  if (c.automationHypothesis !== 'sanctioned') unproven.add('publisher permission for automated retrieval not established');
  if (c.acquisitionHypothesis === undefined || !isAutomatedAcquisition(c.acquisitionHypothesis)) {
    unproven.add('no automated acquisition mechanism established');
  }
  for (const missing of checkPromotion(c).missing) unproven.add(missing);

  const eligibility: TransactionEligibility = excluded.length > 0
    ? 'EXCLUDED'
    : unproven.size > 0 ? 'VERIFICATION_QUEUE' : 'PROMOTABLE';

  // --- score -------------------------------------------------------------
  let uncovered = 0;
  let cells = 0;
  for (const cap of capabilities) {
    const dashboard = DASHBOARD_OF[cap];
    const covered = dashboard === undefined ? new Set<string>() : automatedCoreCounties(registry, dashboard);
    for (const county of counties) {
      cells += 1;
      if (!covered.has(county)) uncovered += 1;
    }
  }
  const acquisitionAutomated = c.acquisitionHypothesis !== undefined && isAutomatedAcquisition(c.acquisitionHypothesis);
  const components: TransactionPriorityComponents = {
    semanticValue: classes.length === 0 ? 0 : Math.max(...classes.map((k) => SEMANTIC_VALUE[k])),
    gapClosure: cells === 0 ? 0 : uncovered / cells,
    jurisdictionLeverage: jurisdictionLeverage(counties.length, activeCountyCount()),
    instrumentBreadth: Math.min(1, capabilities.length / 5),
    acquisitionReadiness: (acquisitionAutomated ? 0.6 : 0.15) + (c.automationHypothesis === 'sanctioned' ? 0.4 : 0.1),
    engineeringFeasibility: feasibility(c.platformId),
    refreshFrequency: cadenceScore(c.cadence),
    historicalDepth: depthScore(c.historicalDepth),
  };

  let score = 0;
  if (eligibility !== 'EXCLUDED') {
    for (const [name, weight] of Object.entries(TRANSACTION_WEIGHTS)) {
      score += weight * components[name as keyof TransactionPriorityComponents];
    }
  }

  return {
    candidateId: c.candidateId,
    sourceName: c.sourceName,
    authority: c.authority,
    verification: c.verification,
    semanticClasses: classes,
    transactionCapabilities: capabilities,
    countyEquivalents: counties.length,
    eligibility,
    blockers: eligibility === 'EXCLUDED' ? excluded : [...unproven],
    score: Math.round(score * 100) / 100,
    components,
  };
}

const ELIGIBILITY_ORDER: readonly TransactionEligibility[] = ['PROMOTABLE', 'VERIFICATION_QUEUE', 'EXCLUDED'];

/**
 * Every candidate that claims a transaction capability, in research order:
 * promotable first, then the verification queue, then exclusions — each by
 * score, then id, so equal scores never shuffle.
 */
export function rankTransactionCandidates(
  candidates: readonly SourceCandidate[],
  registry: Registry,
): readonly TransactionPriority[] {
  return candidates
    .filter((c) => c.capabilities.some((cap) => TRANSACTION_CAPABILITIES.has(cap)))
    .map((c) => transactionPriority(c, registry))
    .sort((a, b) => ELIGIBILITY_ORDER.indexOf(a.eligibility) - ELIGIBILITY_ORDER.indexOf(b.eligibility)
      || b.score - a.score
      || a.candidateId.localeCompare(b.candidateId));
}
