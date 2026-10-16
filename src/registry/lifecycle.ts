/**
 * The national source graph, reconciled (DF-0O).
 *
 * Three states and ten sources in, "is this source live?" had three partial
 * answers: the doctrine's activation verdict, the mapping's status, and the
 * acquisition class. Each was right about its own question and none answered
 * the operator's: what does this source contribute today, and if nothing, why
 * not? `lifecycleOf` derives ONE answer per mapping from those three facts —
 * there is no lifecycle field to set by hand and drift — and
 * `capabilityCoverage` turns it into the per-state, per-capability table the
 * national dashboard reports, with NOT_SUPPORTED where no source in the
 * registry so much as claims the capability.
 *
 * Registry lifecycle is a statement about the REGISTRY. Whether a run's
 * evidence is certified, materialized, durably kept or deployed is a separate
 * question with separate evidence (docs/NATIONAL-INTEGRATION-CERTIFICATION.md);
 * nothing here reads the estate.
 */
import type { Registry } from './registry.ts';
import { assessActivation, type ActivationVerdict } from './policy.ts';
import { isAutomatedAcquisition, type Capability, type SourceDefinition, type SourceJurisdictionMapping } from './types.ts';

export type SourceLifecycle =
  /** Free, sanctioned automation, active mapping, retrieved by a scheduled process with no human present. */
  | 'ACTIVE_AUTOMATED_CORE'
  /** Passes every doctrine gate; no active automated mapping yet. */
  | 'CORE_ELIGIBLE_NOT_INGESTED'
  /** Free and lawful; waiting on a request, credential or delivery (verdict BLOCKED_ACCESS). */
  | 'BLOCKED_ACCESS'
  /** Free and lawful, reachable only by a human. */
  | 'BLOCKED_MANUAL_ACQUISITION'
  /** The terms forbid, or have not sanctioned, automated retrieval or the use. */
  | 'BLOCKED_AUTOMATION'
  /** Costs money: enrichment at most, never core. */
  | 'PAID_OPTIONAL'
  /** Known and deliberately not pursued now. */
  | 'DEFERRED'
  /** A connector exists and is exercised by fixtures only; no live evidence. */
  | 'FIXTURE_ONLY'
  /** Not yet established (cost unknown, schema or provenance unproven). */
  | 'UNKNOWN';

/** Best first. A jurisdiction's lifecycle for a capability is the best of its mappings'. */
export const LIFECYCLE_ORDER: readonly SourceLifecycle[] = [
  'ACTIVE_AUTOMATED_CORE', 'CORE_ELIGIBLE_NOT_INGESTED', 'BLOCKED_ACCESS', 'BLOCKED_MANUAL_ACQUISITION',
  'BLOCKED_AUTOMATION', 'PAID_OPTIONAL', 'DEFERRED', 'FIXTURE_ONLY', 'UNKNOWN',
];

export type LifecycleAssessment = {
  readonly sourceId: string;
  readonly mappingId: string | null;
  readonly lifecycle: SourceLifecycle;
  readonly verdict: ActivationVerdict;
  readonly mappingStatus: SourceJurisdictionMapping['status'] | null;
  readonly acquisitionClass: SourceDefinition['acquisitionClass'];
  readonly jurisdictions: number;
  readonly capabilities: readonly Capability[];
  readonly reason: string;
};

/**
 * One mapping's lifecycle, from the doctrine verdict, the mapping status and the
 * acquisition class. The first rule that applies wins.
 */
export function lifecycleOf(source: SourceDefinition, mapping: SourceJurisdictionMapping | null): {
  readonly lifecycle: SourceLifecycle;
  readonly reason: string;
} {
  const verdict = assessActivation(source).verdict;
  if (mapping?.status === 'fixture_only') {
    return { lifecycle: 'FIXTURE_ONLY', reason: `mapping is fixture_only (source verdict ${verdict})` };
  }
  switch (verdict) {
    case 'OPTIONAL_PAID':
      return { lifecycle: 'PAID_OPTIONAL', reason: 'costs money; never a core dependency' };
    case 'DEFERRED':
      return { lifecycle: 'DEFERRED', reason: 'deliberately postponed' };
    case 'BLOCKED_MANUAL_ACQUISITION':
      return { lifecycle: 'BLOCKED_MANUAL_ACQUISITION', reason: 'reachable only by a human' };
    case 'BLOCKED_AUTOMATION':
    case 'BLOCKED_TERMS':
      return { lifecycle: 'BLOCKED_AUTOMATION', reason: `doctrine verdict ${verdict}` };
    case 'BLOCKED_ACCESS':
      return { lifecycle: 'BLOCKED_ACCESS', reason: 'free route pending a request, credential or delivery' };
    case 'BLOCKED_COST_UNKNOWN':
    case 'BLOCKED_SCHEMA':
    case 'BLOCKED_PROVENANCE':
      return { lifecycle: 'UNKNOWN', reason: `doctrine verdict ${verdict}` };
    case 'CORE_ELIGIBLE':
      // Automated means sanctioned automation as well as an automated class:
      // the runtime refuses to fetch anything not marked `sanctioned`.
      if (mapping !== null && mapping.status === 'active' && source.active && source.automationStatus === 'sanctioned'
        && source.acquisitionClass !== undefined && isAutomatedAcquisition(source.acquisitionClass)) {
        return { lifecycle: 'ACTIVE_AUTOMATED_CORE', reason: `active mapping, ${source.acquisitionClass}` };
      }
      return {
        lifecycle: 'CORE_ELIGIBLE_NOT_INGESTED',
        reason: mapping === null ? 'no mapping' : `mapping ${mapping.status}, ${source.acquisitionClass ?? 'acquisition class unrecorded'}`,
      };
  }
}

/** Every mapping's lifecycle, plus one row per source that has no mapping at all. */
export function sourceLifecycles(registry: Registry): readonly LifecycleAssessment[] {
  const out: LifecycleAssessment[] = [];
  for (const source of registry.sources) {
    const mappings = registry.mappings.filter((m) => m.sourceId === source.sourceId);
    const verdict = assessActivation(source).verdict;
    if (mappings.length === 0) {
      const { lifecycle, reason } = lifecycleOf(source, null);
      out.push({
        sourceId: source.sourceId, mappingId: null, lifecycle, verdict, mappingStatus: null,
        acquisitionClass: source.acquisitionClass, jurisdictions: 0, capabilities: [], reason,
      });
      continue;
    }
    for (const mapping of mappings) {
      const { lifecycle, reason } = lifecycleOf(source, mapping);
      out.push({
        sourceId: source.sourceId, mappingId: mapping.mappingId, lifecycle, verdict, mappingStatus: mapping.status,
        acquisitionClass: source.acquisitionClass, jurisdictions: registry.expand(mapping).length,
        capabilities: mapping.capabilities, reason,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capability coverage
// ---------------------------------------------------------------------------

/**
 * The capabilities the national dashboard reports. Most are registry
 * capabilities by another name. The two sale capabilities are the registry's
 * own `sale_observation` / `sale_economics` where a mapping declares them
 * (Florida's SDF, DF-0M), and otherwise derived from what a source's
 * connector actually emits — never from a column existing:
 *
 *   SALE_OBSERVATION  a publisher's statement that a sale happened: an
 *                     appraiser's sale record (FL SDF) or an assessor's echo
 *                     (MN, ASSESSOR_REPORTED_SALE_OBSERVATION). Not a deed.
 *   SALE_ECONOMICS    the sale's price as published: a filed declaration of
 *                     consideration (eCRV, RETR) or a publisher-derived price
 *                     (FL, SALE_PRICE_DOC_STAMP_DERIVED).
 */
export const DASHBOARD_CAPABILITIES = [
  'PARCEL', 'ASSESSOR', 'OWNERSHIP_CURRENT', 'TAX', 'SALE_OBSERVATION', 'SALE_ECONOMICS',
  'TRANSFER', 'DEED', 'MORTGAGE', 'MORTGAGE_RELEASE', 'LIEN', 'FORECLOSURE_NOTICE',
] as const;
export type DashboardCapability = (typeof DASHBOARD_CAPABILITIES)[number];

/** Sources whose connector emits ASSESSOR_REPORTED_SALE_OBSERVATION. */
export const SALE_OBSERVATION_SOURCES: ReadonlySet<string> = new Set(['mn_statewide_parcels']);
/** Sources that are filed declarations of consideration. */
export const SALE_ECONOMICS_SOURCES: ReadonlySet<string> = new Set([
  'mn_dor_ecrv_weekly_sales_extract', 'wi_dor_retr_historical',
]);

const REGISTRY_CAPABILITY: Readonly<Partial<Record<DashboardCapability, Capability>>> = {
  PARCEL: 'parcel', ASSESSOR: 'assessor', OWNERSHIP_CURRENT: 'ownership', TAX: 'tax', TRANSFER: 'transfer',
  DEED: 'deed', MORTGAGE: 'mortgage', MORTGAGE_RELEASE: 'mortgage_release', LIEN: 'lien',
  FORECLOSURE_NOTICE: 'foreclosure_notice',
};

/** Whether a mapping claims a dashboard capability. */
export function mappingClaims(mapping: SourceJurisdictionMapping, capability: DashboardCapability): boolean {
  if (capability === 'SALE_OBSERVATION') {
    return mapping.capabilities.includes('sale_observation')
      || (SALE_OBSERVATION_SOURCES.has(mapping.sourceId) && mapping.capabilities.includes('parcel'));
  }
  if (capability === 'SALE_ECONOMICS') {
    return mapping.capabilities.includes('sale_economics')
      || (SALE_ECONOMICS_SOURCES.has(mapping.sourceId) && mapping.capabilities.includes('transfer'));
  }
  const registryCapability = REGISTRY_CAPABILITY[capability];
  return registryCapability !== undefined && mapping.capabilities.includes(registryCapability);
}

export type CoverageCell = SourceLifecycle | 'NOT_SUPPORTED';

export type StateCapabilityCoverage = {
  readonly stateCode: string;
  readonly countyEquivalents: number;
  readonly capability: DashboardCapability;
  /** County-equivalents by their best lifecycle for this capability. NOT_SUPPORTED: no source claims it. */
  readonly byLifecycle: Readonly<Partial<Record<CoverageCell, number>>>;
  readonly sources: readonly string[];
};

/**
 * Per state and capability, how many county-equivalents are served at each
 * lifecycle. Only states some mapping touches are listed; every other state is
 * NOT_SUPPORTED everywhere by construction.
 */
export function capabilityCoverage(registry: Registry): readonly StateCapabilityCoverage[] {
  const counties = registry.jurisdictions.filter((j) => j.jurisdictionType === 'county' && (j.status ?? 'active') === 'active');
  const expanded = registry.mappings.map((mapping) => ({
    mapping,
    lifecycle: lifecycleOf(registry.source(mapping.sourceId), mapping).lifecycle,
    jurisdictions: new Set(registry.expand(mapping).map((j) => j.jurisdictionId)),
  }));
  const states = new Set<string>();
  for (const e of expanded) {
    for (const j of counties) if (e.jurisdictions.has(j.jurisdictionId) && j.stateCode) states.add(j.stateCode);
  }
  const rank = (c: CoverageCell): number => (c === 'NOT_SUPPORTED' ? LIFECYCLE_ORDER.length : LIFECYCLE_ORDER.indexOf(c));
  const out: StateCapabilityCoverage[] = [];
  for (const stateCode of [...states].sort()) {
    const inState = counties.filter((j) => j.stateCode === stateCode);
    for (const capability of DASHBOARD_CAPABILITIES) {
      const claiming = expanded.filter((e) => mappingClaims(e.mapping, capability));
      const byLifecycle: Partial<Record<CoverageCell, number>> = {};
      const sources = new Set<string>();
      for (const j of inState) {
        let best: CoverageCell = 'NOT_SUPPORTED';
        for (const e of claiming) {
          if (!e.jurisdictions.has(j.jurisdictionId)) continue;
          sources.add(e.mapping.sourceId);
          if (rank(e.lifecycle) < rank(best)) best = e.lifecycle;
        }
        byLifecycle[best] = (byLifecycle[best] ?? 0) + 1;
      }
      out.push({ stateCode, countyEquivalents: inState.length, capability, byLifecycle, sources: [...sources].sort() });
    }
  }
  return out;
}

/**
 * County-equivalents with an ACTIVE_AUTOMATED_CORE source for a capability,
 * nationally. Computed from the registry, never a literal: a total that is
 * typed in is a total that survives the source that justified it.
 */
export function automatedCoreJurisdictions(registry: Registry, capability: DashboardCapability = 'PARCEL'): number {
  const ids = new Set<string>();
  for (const mapping of registry.mappings) {
    if (!mappingClaims(mapping, capability)) continue;
    if (lifecycleOf(registry.source(mapping.sourceId), mapping).lifecycle !== 'ACTIVE_AUTOMATED_CORE') continue;
    for (const j of registry.expand(mapping)) if (j.jurisdictionType === 'county') ids.add(j.jurisdictionId);
  }
  return ids.size;
}
