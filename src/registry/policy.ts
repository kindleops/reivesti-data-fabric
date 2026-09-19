/**
 * The zero-cost data doctrine, as an evaluator rather than a memo.
 *
 * **Reivesti does not pay for core data.** National coverage is built from free
 * government bulk files, free APIs, free sanctioned feeds, free public
 * downloads, free open data, free lawful data requests, and Reivesti's own
 * first-party data. Paid sources may be documented and even implemented; they
 * may never be required for canonical coverage.
 *
 * This is deliberate architecture, not thrift. A canonical estate whose property
 * identities depend on a subscription is an estate that stops being true when an
 * invoice goes unpaid or a vendor changes terms — and the failure arrives as
 * silently missing data, months after the decision that caused it.
 *
 * A source becomes an active CORE source only when **all five** hold:
 *
 *   COST        zero
 *   ACQUISITION sanctioned (or lawfully delivered to an operator)
 *   LICENCE     compatible with the intended use
 *   AUTHORITY   acceptable — the body that maintains the record
 *   PROVENANCE  reproducible — pinned, digestible, replayable
 *
 * Explicitly NOT sufficient, in any combination: that a source is useful, that
 * it is public, that it is technically reachable, that a competitor uses it,
 * that a subscription exists, or that a browser can be pointed at it.
 */
import type {
  AccessRequestState,
  AcquisitionClass,
  CostClass,
  SourceDefinition,
  SourceRole,
} from './types.ts';
import { fail } from '../core/errors.ts';
import { isAutomatedAcquisition, isZeroCost } from './types.ts';

/**
 * The verdict. One value, and the first failing gate wins, so the answer always
 * names the single thing that has to change.
 */
export type ActivationVerdict =
  /** Free, sanctioned, licence-compatible: may become an active core source. */
  | 'CORE_ELIGIBLE'
  /** Lawful and usable, but costs money. Enrichment only, never a dependency. */
  | 'OPTIONAL_PAID'
  /** The terms forbid the intended use. */
  | 'BLOCKED_TERMS'
  /** The terms forbid, or the publisher has not sanctioned, automated retrieval. */
  | 'BLOCKED_AUTOMATION'
  /** Cost has not been established. Unknown is not free. */
  | 'BLOCKED_COST_UNKNOWN'
  /** There is no route to the bytes yet — approval, credentials or delivery pending. */
  | 'BLOCKED_ACCESS'
  /** The layout is unknown or has moved; nothing may be read positionally. */
  | 'BLOCKED_SCHEMA'
  /** Retrieval cannot be pinned, digested and replayed. */
  | 'BLOCKED_PROVENANCE'
  /**
   * Free, lawful, and reachable only by a human. Distinct from
   * BLOCKED_AUTOMATION, which is a permission problem: this is a MECHANISM
   * problem, and the remedy is a different distribution rather than a different
   * reading of the terms.
   */
  | 'BLOCKED_MANUAL_ACQUISITION'
  /** Known, understood, and deliberately not pursued now. */
  | 'DEFERRED';

export type ActivationAssessment = {
  readonly sourceId: string;
  readonly verdict: ActivationVerdict;
  /** The gate that decided it. */
  readonly gate: 'role' | 'cost' | 'automation' | 'acquisition' | 'terms' | 'access' | 'schema' | 'provenance' | 'none';
  readonly reason: string;
  /** What would have to change. Empty when the verdict is already CORE_ELIGIBLE. */
  readonly remedy: string | null;
  readonly costClass: CostClass;
  /** How the bytes arrive. Surfaced so a report can say WHY a source is dormant. */
  readonly acquisitionClass: AcquisitionClass;
  readonly role: SourceRole | null;
  readonly zeroCost: boolean;
};

/**
 * Facts the registry row cannot know on its own.
 *
 * Schema and provenance are properties of the *adapter*, not of the publisher,
 * so they are supplied by the caller rather than guessed from a registry field.
 * Defaults are the conservative ones: a source with no adapter has neither.
 */
export type ActivationContext = {
  /** True when a connector exists whose layout is pinned against the publisher's own schema. */
  readonly schemaPinned?: boolean;
  /** True when retrieval is archived, digested and replayable. */
  readonly provenanceReproducible?: boolean;
  /** Where a free access path has got to, when the source needs one. */
  readonly accessRequestState?: AccessRequestState;
};

/** Roles that are, by definition, not attempts at core activation. */
const NON_CORE_ROLES: ReadonlySet<SourceRole> = new Set<SourceRole>([
  'OPTIONAL_ENRICHMENT', 'VALIDATION_ONLY', 'MANUAL_RESEARCH_ONLY', 'DEFERRED', 'REJECTED',
]);

/**
 * Evaluates one source against the doctrine.
 *
 * Pure and total: the same row always produces the same verdict, and there is no
 * path that returns eligibility by omission. A row missing `costClass` is
 * `BLOCKED_COST_UNKNOWN`, never free by default — the whole failure mode this
 * evaluator exists to prevent is a source drifting into core use because nobody
 * wrote down what it costs.
 */
export function assessActivation(
  source: SourceDefinition,
  context: ActivationContext = {},
): ActivationAssessment {
  const costClass: CostClass = source.costClass ?? 'UNKNOWN_COST';
  const role = source.role ?? null;
  const zeroCost = isZeroCost(costClass);

  const acquisitionClass: AcquisitionClass = source.acquisitionClass ?? 'UNKNOWN_AUTOMATION';
  const base = { sourceId: source.sourceId, costClass, acquisitionClass, role, zeroCost };

  // Gate 0 — declared intent. A source declared as enrichment is not competing
  // for core status, and saying so first keeps the later gates about the source
  // rather than about our plans for it.
  if (role !== null && NON_CORE_ROLES.has(role)) {
    if (role === 'REJECTED') {
      return { ...base, verdict: 'DEFERRED', gate: 'role', reason: 'the source was considered and ruled out', remedy: null };
    }
    if (role === 'DEFERRED') {
      // Say WHY it is deferred when the registry already knows. "Postponed" and
      // "postponed because a person has to fetch it by hand" send a reader to
      // two different places, and only one of them is the truth here.
      const why = !isAutomatedAcquisition(acquisitionClass)
        ? `deferred: ${acquisitionClass} — no unattended acquisition path exists`
        : 'deliberately not pursued in the current phase';
      return { ...base, verdict: 'DEFERRED', gate: 'role', reason: why, remedy: null };
    }
    return {
      ...base,
      verdict: zeroCost ? 'DEFERRED' : 'OPTIONAL_PAID',
      gate: 'role',
      reason: `declared ${role}; not a candidate for core activation`,
      remedy: null,
    };
  }

  // Gate 1 — cost. The hard gate, and first among the substantive ones because
  // no amount of quality makes a paid source eligible.
  if (costClass === 'UNKNOWN_COST') {
    return {
      ...base, verdict: 'BLOCKED_COST_UNKNOWN', gate: 'cost',
      reason: 'the cost of this source has not been established, and unknown is not free',
      remedy: 'establish the price from the publisher\'s own fee schedule and set costClass',
    };
  }
  if (!zeroCost) {
    return {
      ...base, verdict: 'OPTIONAL_PAID', gate: 'cost',
      reason: `${costClass}: Reivesti does not pay for core data`,
      remedy: 'find a zero-cost path — a different authority, a state-level source, or a data request — '
        + 'or keep this as optional enrichment that nothing canonical depends on',
    };
  }

  // Gate 2 — permission. Free does not mean permitted.
  if (source.automationStatus === 'prohibited') {
    return {
      ...base, verdict: 'BLOCKED_AUTOMATION', gate: 'automation',
      reason: 'the publisher\'s terms prohibit automated retrieval',
      remedy: 'obtain the data through a sanctioned route — bulk, API, open data or a records request',
    };
  }
  if (source.automationStatus === 'unknown') {
    return {
      ...base, verdict: 'BLOCKED_AUTOMATION', gate: 'automation',
      reason: 'whether the publisher sanctions automated retrieval has not been established',
      remedy: 'read the publisher\'s terms and record automationStatus',
    };
  }

  // Gate 3 — licence.
  if (source.termsStatus === 'not_reviewed') {
    return {
      ...base, verdict: 'BLOCKED_TERMS', gate: 'terms',
      reason: 'the terms have not been read',
      remedy: 'read the publisher\'s terms and record termsStatus',
    };
  }

  // Gate 4 — access. A source that needs a free request is eligible only once
  // the file can actually be obtained. A quoted fee is a cost change, not an
  // access problem, and is reported as such.
  const requestState = context.accessRequestState ?? source.accessRequest?.state ?? 'NOT_REQUIRED';
  if (requestState === 'FEE_QUOTED') {
    return {
      ...base, verdict: 'OPTIONAL_PAID', gate: 'access',
      reason: 'the free request came back with a fee quote, which moves this source out of zero-cost',
      remedy: 'update costClass to the paid class it now is, and keep looking for a free path',
    };
  }
  if (requestState === 'DENIED') {
    return {
      ...base, verdict: 'BLOCKED_ACCESS', gate: 'access',
      reason: 'the access request was denied',
      remedy: 'find a different authority or publication of the same record',
    };
  }
  if (requestState === 'NOT_REQUESTED' || requestState === 'REQUESTED' || requestState === 'AWAITING_RESPONSE') {
    return {
      ...base, verdict: 'BLOCKED_ACCESS', gate: 'access',
      reason: `the free access path is at "${requestState}"; no data has been delivered`,
      remedy: 'complete the access request, and establish whether what is granted is a fetchable '
        + 'endpoint or a file a person receives — the answer decides acquisitionClass',
    };
  }

  // Gate 5 — acquisition MECHANISM. Permission to automate is worthless without
  // something to automate against, and this is the gate that says so.
  //
  // This gate exists because the previous one let a file through on the strength
  // of "an operator may lawfully receive it". That reasoning is how Wisconsin
  // RETR came to supply 72 counties of declared transfer coverage while the
  // inbox it was supposed to arrive in stayed empty. A pipeline cannot tell the
  // difference between a month with no transfers and a month nobody clicked, so
  // a human retrieval step is treated as no retrieval step at all.
  // FREE_MANUAL_DELIVERY says, in the cost field, that an operator receives the
  // file by arrangement. That IS a manual acquisition, so it is treated as one
  // no matter what the acquisition field claims — otherwise the two fields can
  // be set to contradict each other and the more flattering one wins.
  const acquisition: AcquisitionClass = costClass === 'FREE_MANUAL_DELIVERY' ? 'MANUAL_ONLY' : acquisitionClass;
  if (!isAutomatedAcquisition(acquisition)) {
    if (acquisition === 'UNKNOWN_AUTOMATION') {
      return {
        ...base, verdict: 'BLOCKED_MANUAL_ACQUISITION', gate: 'acquisition',
        reason: 'no acquisition mechanism has been established, and unknown is not automated',
        remedy: 'establish how the bytes arrive unattended and set acquisitionClass',
      };
    }
    if (acquisition === 'PROHIBITED_AUTOMATION') {
      return {
        ...base, verdict: 'BLOCKED_AUTOMATION', gate: 'acquisition',
        reason: 'the publisher forbids automated acquisition of this distribution',
        remedy: 'obtain the same record from a publication that permits automated retrieval',
      };
    }
    return {
      ...base, verdict: 'BLOCKED_MANUAL_ACQUISITION', gate: 'acquisition',
      reason: 'the only distribution requires a human to retrieve it, and a human is not a scheduler',
      remedy: 'find an automated distribution of the same record — an API, a bulk archive, an open-data '
        + 'endpoint, or an official recurring export — or keep this dormant until the publisher offers one',
    };
  }

  // Gate 6 — schema. Reading a positional file against an unpinned layout is the
  // failure that must never be silent, so it blocks rather than warns.
  if (context.schemaPinned === false) {
    return {
      ...base, verdict: 'BLOCKED_SCHEMA', gate: 'schema',
      reason: 'the publisher\'s layout is not pinned, so drift could not be detected',
      remedy: 'pin the publisher\'s own schema or documented layout and digest it',
    };
  }

  // Gate 7 — provenance.
  if (context.provenanceReproducible === false) {
    return {
      ...base, verdict: 'BLOCKED_PROVENANCE', gate: 'provenance',
      reason: 'retrieval cannot be archived, digested and replayed',
      remedy: 'route acquisition through the artifact store so the run is reproducible',
    };
  }

  return {
    ...base, verdict: 'CORE_ELIGIBLE', gate: 'none',
    reason: `${costClass}, ${source.automationStatus} acquisition, ${source.termsStatus} terms`,
    remedy: null,
  };
}

/**
 * True when a source may currently be depended on for canonical coverage.
 *
 * Both halves matter. A source can be CORE_ELIGIBLE and still be declared as
 * supporting rather than canonical; and a source declared canonical that fails a
 * gate must not count, which is exactly the case the coverage report has to get
 * right.
 */
export function isCoreActivatable(
  source: SourceDefinition,
  context: ActivationContext = {},
): boolean {
  if (assessActivation(source, context).verdict !== 'CORE_ELIGIBLE') return false;
  const role = source.role;
  return role === 'CORE_CANONICAL_SOURCE' || role === 'CORE_SUPPORTING_SOURCE';
}

/**
 * Sources KNOWN to cost money. Nothing canonical may require one.
 *
 * Deliberately not `!isZeroCost(...)`: that would sweep `UNKNOWN_COST` in with
 * the paid ones, and "we have not priced it" is a different fact from "it costs
 * money". Both are excluded from core coverage — by `isZeroCostSource` below —
 * but they need different actions, and a report that calls an unresearched
 * source "paid" sends someone to find a budget instead of a fee schedule.
 */
export function isPaidSource(source: SourceDefinition): boolean {
  const cost = source.costClass ?? 'UNKNOWN_COST';
  return cost === 'PAID_OPTIONAL' || cost === 'PAID_SUBSCRIPTION' || cost === 'PAID_PER_RECORD';
}

/** Sources KNOWN to be free. Only these may count toward core coverage. */
export function isZeroCostSource(source: SourceDefinition): boolean {
  return isZeroCost(source.costClass ?? 'UNKNOWN_COST');
}

/**
 * A source may only be DECLARED core once it is known to be free.
 *
 * Mirrors the `sources_core_role_is_zero_cost` constraint in migration 0007, so
 * the same rule holds whether a row is built in TypeScript or inserted by hand.
 * Declaring intent before establishing cost is how a paid source drifts into a
 * canonical position.
 */
export function assertRolePermitted(source: SourceDefinition): void {
  const role = source.role;
  if (role !== 'CORE_CANONICAL_SOURCE' && role !== 'CORE_SUPPORTING_SOURCE') return;
  if (isZeroCostSource(source)) return;
  fail('CONFIG', `source "${source.sourceId}" is declared ${role} but its cost class is ${source.costClass ?? 'UNKNOWN_COST'}`, {
    remedy: 'establish a zero-cost path first, or declare a non-core role',
  });
}
