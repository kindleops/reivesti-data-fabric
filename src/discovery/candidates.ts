/**
 * Source candidates: what we might ingest, before we have proved we may.
 *
 * A candidate is deliberately a **different type** from a registered source, not
 * a source with a status flag. The difference is epistemic: a `SourceDefinition`
 * asserts facts the Fabric will act on — this is free, this is sanctioned, these
 * are the terms — and a candidate records *hypotheses* about them. Collapsing the
 * two would let an unverified guess about licensing sit in the same field the
 * runtime consults before reaching a publisher.
 *
 * So a candidate carries `*Hypothesis` fields, and every one of them must be
 * backed by evidence before it can be promoted. Promotion is a deliberate act
 * with a checklist, not a status change.
 */
import { deterministicId } from '../core/hash.ts';
import { fail } from '../core/errors.ts';
import { isZeroCost } from '../registry/types.ts';
import type {
  AccessType,
  AutomationStatus,
  Capability,
  CostClass,
  JurisdictionScope,
  LicenseStatus,
  RefreshFrequency,
} from '../registry/types.ts';

/**
 * How much of a claim we actually have.
 *
 * `OFFICIAL_PAGE` and below are hypotheses. Only `VERIFIED` may be promoted, and
 * only `VERIFIED_LIVE` has been proven by retrieving bytes.
 */
export type VerificationLevel =
  /** Someone thinks this exists. No evidence recorded. */
  | 'UNVERIFIED'
  /** An official page describes it. */
  | 'OFFICIAL_PAGE'
  /** Official documentation or metadata describes its interface and layout. */
  | 'OFFICIAL_DOCUMENTATION'
  /** Cost, terms and automation have all been read from official sources. */
  | 'VERIFIED'
  /** Bytes have been retrieved lawfully and parsed. */
  | 'VERIFIED_LIVE'
  /** Investigated and ruled out. The reason is kept. */
  | 'RULED_OUT';

/**
 * A piece of evidence for one claim.
 *
 * Every assertion on a candidate has to point at something a reviewer can open.
 * "It's free" with no link is a rumour, and rumours are how a paid source ends
 * up in a core pipeline.
 */
export type ResearchEvidence = {
  /** The claim this supports, e.g. "cost", "automation", "coverage", "cadence". */
  readonly claim: string;
  /** Official page, terms document, API metadata or documentation. */
  readonly url: string;
  /** What the source actually says. Quoted, not paraphrased into a conclusion. */
  readonly quote: string;
  readonly retrievedAt: string;
  /**
   * Where the evidence came from. Vendor marketing and blog posts are recorded
   * as such and never satisfy a verification gate on their own.
   */
  readonly kind: 'official_authority' | 'official_terms' | 'official_documentation' | 'api_metadata' | 'secondary';
};

/**
 * A technical platform several jurisdictions share.
 *
 * This is the single most important idea for national scale: hundreds of
 * counties publish parcels through ArcGIS FeatureServer, dozens of states use
 * the same recorder vendor, and open-data portals cluster into a handful of
 * products. One connector implementation plus many configurations beats many
 * copy-pasted connectors — but only if the platform is modelled separately from
 * the sources that run on it.
 *
 * The caveat is load-bearing and is stated in the type: **same platform does not
 * mean same schema.** ArcGIS gives a common transport, pagination and metadata
 * contract. It says nothing about whether a county calls its parcel number `PID`,
 * `PARCELID` or `APN`, and semantic normalisation stays per-source.
 */
export type PlatformFamily = {
  readonly platformId: string;
  readonly name: string;
  /** How bytes are fetched. Shared across every jurisdiction on the platform. */
  readonly transportPattern: string;
  readonly authenticationPattern: 'none' | 'api_key' | 'oauth' | 'account' | 'varies';
  readonly paginationPattern: string;
  /** What the platform typically carries. A hint for discovery, not a guarantee. */
  readonly commonCapabilities: readonly Capability[];
  /**
   * True when one connector implementation can serve every jurisdiction on the
   * platform given only configuration. False when the platform standardises
   * transport but not content.
   */
  readonly connectorReusable: boolean;
  /** Why reuse stops where it stops. */
  readonly reuseBoundary: string;
  readonly evidence: readonly ResearchEvidence[];
};

export type SourceCandidate = {
  readonly candidateId: string;
  readonly authority: string;
  readonly sourceName: string;
  /** What it would cover. Expanded by the registry exactly like a real mapping. */
  readonly scope: JurisdictionScope;
  readonly capabilities: readonly Capability[];
  readonly officialUrl: string;

  // --- hypotheses. Not facts. Not consulted by the runtime. ---------------
  readonly accessHypothesis: AccessType;
  readonly costHypothesis: CostClass;
  readonly automationHypothesis: AutomationStatus;
  readonly licenseHypothesis: LicenseStatus;
  readonly bulkAvailable: boolean | null;
  readonly apiAvailable: boolean | null;
  readonly openDataPortal: boolean | null;
  readonly historicalDepth: string | null;
  readonly cadence: RefreshFrequency | null;
  /** Suspected shared platform, if any. */
  readonly platformId: string | null;

  readonly verification: VerificationLevel;
  readonly lastResearchedAt: string;
  readonly evidence: readonly ResearchEvidence[];
  readonly notes: string;
};

export function candidateId(authority: string, sourceName: string): string {
  return deterministicId('candidate', authority, sourceName);
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export type PromotionCheck = {
  readonly ready: boolean;
  readonly missing: readonly string[];
};

/**
 * Whether a candidate may become a registered source.
 *
 * Every claim the registry will act on has to be evidenced first. This is the
 * gate that stops "I'm fairly sure it's free" from becoming a `costClass` the
 * activation evaluator then trusts.
 */
export function checkPromotion(candidate: SourceCandidate): PromotionCheck {
  const missing: string[] = [];
  const claims = new Set(candidate.evidence.map((e) => e.claim));
  const official = new Set(
    candidate.evidence.filter((e) => e.kind !== 'secondary').map((e) => e.claim),
  );

  if (candidate.verification === 'RULED_OUT') {
    return { ready: false, missing: ['the candidate was ruled out'] };
  }
  if (candidate.verification !== 'VERIFIED' && candidate.verification !== 'VERIFIED_LIVE') {
    missing.push(`verification is ${candidate.verification}; must be VERIFIED or VERIFIED_LIVE`);
  }
  for (const claim of ['cost', 'automation', 'terms', 'coverage']) {
    if (!claims.has(claim)) missing.push(`no evidence recorded for "${claim}"`);
    else if (!official.has(claim)) missing.push(`"${claim}" rests only on secondary evidence`);
  }
  if (candidate.costHypothesis === 'UNKNOWN_COST') {
    missing.push('cost is still UNKNOWN_COST');
  }
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * The components of a candidate's priority, each computed and each exposed.
 *
 * Deliberately arithmetic on named factors rather than a learned score. Anyone
 * arguing that the next connector should be X instead of Y should be able to
 * point at the component they disagree with — which is impossible if the ranking
 * is a model output, and trivial if it is a table.
 */
export type PriorityComponents = {
  /** How many active county-equivalents it would reach. The dominant factor. */
  readonly jurisdictionLeverage: number;
  /** How many distinct capabilities it carries. */
  readonly capabilityRichness: number;
  /** Whether the publisher is the office that maintains the record. */
  readonly authorityQuality: number;
  /** Bulk file or API beats a page a human downloads. */
  readonly machineReadability: number;
  /** Sanctioned automation beats manual delivery. */
  readonly automation: number;
  /** Years of history available. */
  readonly historicalDepth: number;
  readonly refreshFrequency: number;
  /** Lower effort scores higher. Shared platforms are cheaper. */
  readonly engineeringFeasibility: number;
  /** How much the capability matters to Reivesti's actual product. */
  readonly marketRelevance: number;
};

export type RankedCandidate = {
  readonly candidateId: string;
  readonly sourceName: string;
  readonly authority: string;
  readonly score: number;
  readonly components: PriorityComponents;
  /** Set when the zero-cost gate excluded it. Score is then irrelevant. */
  readonly excluded: string | null;
};

const WEIGHTS: Readonly<Record<keyof PriorityComponents, number>> = {
  jurisdictionLeverage: 30,
  capabilityRichness: 12,
  authorityQuality: 12,
  machineReadability: 12,
  automation: 10,
  historicalDepth: 6,
  refreshFrequency: 6,
  engineeringFeasibility: 8,
  marketRelevance: 14,
};

/** Capabilities weighted by what Reivesti actually does with them. */
const MARKET_WEIGHT: Partial<Record<Capability, number>> = {
  transfer: 1, deed: 1, mortgage: 0.95, foreclosure_notice: 0.95, ownership: 0.9,
  parcel: 0.85, assessor: 0.8, tax_delinquency: 0.8, lien: 0.7, tax_sale: 0.7,
  mortgage_release: 0.6, tax: 0.55, business_entity: 0.5, court_event: 0.4,
  code_violation: 0.35, permit: 0.3, contact_enrichment: 0.1,
};

const MACHINE_READABILITY: Partial<Record<AccessType, number>> = {
  api: 1, bulk_download: 0.9, object_storage: 0.8, sftp: 0.7,
  soap: 0.6, vendor_export: 0.5, manual_import: 0.35,
};

const AUTOMATION_SCORE: Record<AutomationStatus, number> = {
  sanctioned: 1, manual_only: 0.5, unknown: 0.1, prohibited: 0,
};

const CADENCE_SCORE: Partial<Record<RefreshFrequency, number>> = {
  continuous: 1, daily: 0.95, weekly: 0.85, biweekly: 0.75, monthly: 0.65,
  quarterly: 0.4, annual: 0.25, irregular: 0.2, unknown: 0.1,
};

export type RankingInput = {
  readonly candidate: SourceCandidate;
  /** Active county-equivalents the scope expands to. Supplied by the registry. */
  readonly jurisdictionCount: number;
  /** Total active county-equivalents, for normalisation. */
  readonly totalJurisdictions: number;
  /** True when the authority is the office of record for the capability. */
  readonly authoritative: boolean;
  /** True when a reusable platform connector already exists. */
  readonly platformConnectorExists: boolean;
};

/**
 * Scores a candidate. Zero cost is a **hard gate**, not a weight.
 *
 * A paid source cannot outrank a free one by being better, because it is not
 * competing: it is excluded, and the exclusion is reported instead of a score.
 * Making cost a heavily-weighted factor rather than a gate is precisely how a
 * doctrine erodes.
 */
export function rankCandidate(input: RankingInput): RankedCandidate {
  const c = input.candidate;
  const base = { candidateId: c.candidateId, sourceName: c.sourceName, authority: c.authority };

  const components: PriorityComponents = {
    jurisdictionLeverage: input.totalJurisdictions === 0
      ? 0
      // Square root, not linear: a statewide source beating a county source is
      // right; beating it by 254x is not, because coverage is not the only thing
      // that matters and Dallas alone is worth more than 254 empty counties.
      : Math.min(1, Math.sqrt(input.jurisdictionCount / input.totalJurisdictions) * 2.2),
    capabilityRichness: Math.min(1, c.capabilities.length / 5),
    authorityQuality: input.authoritative ? 1 : 0.5,
    machineReadability: MACHINE_READABILITY[c.accessHypothesis] ?? 0.3,
    automation: AUTOMATION_SCORE[c.automationHypothesis],
    historicalDepth: depthScore(c.historicalDepth),
    refreshFrequency: c.cadence === null ? 0.1 : (CADENCE_SCORE[c.cadence] ?? 0.1),
    engineeringFeasibility: input.platformConnectorExists ? 1 : (c.platformId !== null ? 0.7 : 0.5),
    marketRelevance: c.capabilities.length === 0
      ? 0
      : Math.max(...c.capabilities.map((cap) => MARKET_WEIGHT[cap] ?? 0.2)),
  };

  if (!isZeroCost(c.costHypothesis)) {
    return {
      ...base, components, score: 0,
      excluded: c.costHypothesis === 'UNKNOWN_COST'
        ? 'cost has not been established; unknown is not free'
        : `${c.costHypothesis}: Reivesti does not pay for core data`,
    };
  }
  if (c.automationHypothesis === 'prohibited') {
    return { ...base, components, score: 0, excluded: 'automated acquisition is prohibited by the publisher' };
  }

  let score = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    score += weight * components[name as keyof PriorityComponents];
  }
  return { ...base, components, score: Math.round(score * 100) / 100, excluded: null };
}

/** Deterministic ordering: score, then id, so equal scores never shuffle. */
export function rankCandidates(inputs: readonly RankingInput[]): readonly RankedCandidate[] {
  return inputs
    .map(rankCandidate)
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
}

function depthScore(depth: string | null): number {
  if (depth === null) return 0.1;
  const year = Number(depth.slice(0, 4));
  if (!Number.isFinite(year)) return 0.1;
  const years = 2026 - year;
  if (years <= 0) return 0.1;
  return Math.min(1, years / 25);
}

/** Guards a candidate list against duplicate ids, which would double-count leverage. */
export function assertUniqueCandidates(candidates: readonly SourceCandidate[]): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.candidateId)) fail('CONFIG', `duplicate candidateId for "${c.sourceName}"`);
    seen.add(c.candidateId);
  }
}
