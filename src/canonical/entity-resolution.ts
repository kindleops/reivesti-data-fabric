/**
 * Organization entity resolution.
 *
 * The job: take an organization name observed on a county record — an assessor
 * owner, an eCRV buyer, a recorded grantee — and decide whether it names a
 * business registered with the Secretary of State.
 *
 * The discipline: **candidate generation and resolution are different things,
 * and only the second makes a claim.** Generating a candidate costs nothing and
 * can be wrong. Resolving is an assertion that two records are the same legal
 * entity, and a wrong one silently corrupts every downstream conclusion about
 * who owns what.
 *
 * So the rules here are deliberately few, deliberately strict, and every one of
 * them is *deterministic*. There is no fuzzy matching in this module. Levenshtein
 * distance, Jaro-Winkler and embedding similarity are all excellent ways to rank
 * candidates for a human, and none of them may establish identity in DF-0F.
 *
 * Every decision carries its evidence and the resolver version that made it, so
 * a better resolver can supersede it later without pretending the earlier
 * decision never happened.
 */
import { fail } from '../core/errors.ts';
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { deterministicId } from '../core/hash.ts';
import type { ResolutionState } from './models.ts';

export const RESOLVER_VERSION = 'org_resolver_1';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Why a link was proposed. Ordered by strength, strongest first.
 *
 * `EXACT_SOURCE_ID` is the only kind that resolves on its own: a county record
 * that carries the registry's own identifier is not guessing.
 */
export type EvidenceType =
  /** The observation carried the registry's own entity identifier. */
  | 'EXACT_SOURCE_ID'
  /** Normalized legal name matched, and that name is unique statewide. */
  | 'EXACT_LEGAL_NAME_UNIQUE'
  /** Normalized legal name matched, but several entities share it. */
  | 'EXACT_LEGAL_NAME_AMBIGUOUS'
  /** Space-insensitive name key matched. Broader, and therefore weaker. */
  | 'COMPACT_NAME'
  /** A registered address matched the observation's address. */
  | 'EXACT_ADDRESS'
  | 'PRIOR_NAME_MATCH'
  | 'ASSUMED_NAME_MATCH'
  /** More than one independent county source proposed the same entity. */
  | 'MULTI_SOURCE_CORROBORATION';

export type EvidenceStrength = 'decisive' | 'strong' | 'supporting' | 'weak';

export const EVIDENCE_STRENGTH: Readonly<Record<EvidenceType, EvidenceStrength>> = {
  EXACT_SOURCE_ID: 'decisive',
  EXACT_LEGAL_NAME_UNIQUE: 'strong',
  EXACT_ADDRESS: 'supporting',
  PRIOR_NAME_MATCH: 'supporting',
  ASSUMED_NAME_MATCH: 'supporting',
  MULTI_SOURCE_CORROBORATION: 'supporting',
  COMPACT_NAME: 'weak',
  EXACT_LEGAL_NAME_AMBIGUOUS: 'weak',
};

export type ResolutionEvidence = {
  readonly evidenceType: EvidenceType;
  readonly strength: EvidenceStrength;
  /** What actually matched, so a reviewer can check the reasoning. */
  readonly value: string;
  readonly sourceId: string;
};

// ---------------------------------------------------------------------------
// Candidates and decisions
// ---------------------------------------------------------------------------

/** One organization name as some county source observed it. */
export type OrganizationObservation = {
  /** partyObservationId */ readonly o: string;
  /** sourceId */ readonly s: string;
  /** raw name */ readonly r: string;
  /** normalized search name */ readonly n: string;
  /** compact name */ readonly k: string;
  /** normalized address, when the source supplied one */ readonly a: string | null;
  /** registry entity id carried by the source, if any */ readonly e: string | null;
};

/** One registered entity, flattened to what matching needs. */
export type EntityCandidateRow = {
  /** entityId */ readonly i: string;
  /** sourceEntityId */ readonly x: string;
  /** normalized legal name */ readonly n: string;
  /** compact legal name */ readonly k: string;
  /** legal name, raw */ readonly r: string;
  /** normalized addresses */ readonly a: readonly string[];
  /** how many entities statewide share this normalized name */ readonly c: number;
};

export type EntityLinkDecision = {
  readonly linkId: string;
  readonly partyObservationId: string;
  readonly observationSourceId: string;
  readonly observedName: string;
  /** Null when nothing was proposed, or when several were and none dominates. */
  readonly entityId: string | null;
  readonly state: ResolutionState;
  readonly evidence: readonly ResolutionEvidence[];
  /** Every entity considered. Retained even when the decision is ambiguous. */
  readonly candidateEntityIds: readonly string[];
  readonly resolverVersion: string;
  readonly decidedAt: string;
  /** Why it is not resolved, when it is not. */
  readonly reason: string | null;
};

export function linkIdOf(partyObservationId: string, resolverVersion: string): string {
  return deterministicId('entitylink', partyObservationId, resolverVersion);
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export type ResolutionRules = {
  /**
   * Allow a statewide-unique exact normalized legal name to resolve.
   *
   * Off by default, and that is the important part. Enabling it is a decision to
   * be made **after** measuring name collisions in the real register — see
   * `measureNameCollisions`. Picking a rule first and hoping the data fits is
   * how false merges get shipped.
   */
  readonly allowUniqueLegalName: boolean;
  /**
   * Require a corroborating address before a unique-name resolution counts.
   * Only meaningful when `allowUniqueLegalName` is on.
   */
  readonly requireAddressCorroboration: boolean;
};

/**
 * What DF-0F ships with.
 *
 * Only an exact registry identifier resolves. Everything else is a candidate.
 * That is a conservative starting point by design: the collision audit has not
 * been run against real data, because the licensed delivery has not arrived.
 */
export const DEFAULT_RULES: ResolutionRules = {
  allowUniqueLegalName: false,
  requireAddressCorroboration: true,
};

/**
 * Decides one observation against its candidates.
 *
 * Pure and order-independent: candidates are sorted before use, so the same set
 * always produces the same decision regardless of how it was assembled.
 */
export function decide(
  observation: OrganizationObservation,
  candidates: readonly EntityCandidateRow[],
  rules: ResolutionRules,
  decidedAt: string,
): EntityLinkDecision {
  const ordered = [...candidates].sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
  const evidence: ResolutionEvidence[] = [];

  const base = {
    linkId: linkIdOf(observation.o, RESOLVER_VERSION),
    partyObservationId: observation.o,
    observationSourceId: observation.s,
    observedName: observation.r,
    candidateEntityIds: ordered.map((c) => c.i),
    resolverVersion: RESOLVER_VERSION,
    decidedAt,
  };

  // Rule A — the registry's own identifier. Decisive: the source is not guessing.
  if (observation.e !== null) {
    const match = ordered.find((c) => c.x === observation.e);
    if (match) {
      evidence.push({ evidenceType: 'EXACT_SOURCE_ID', strength: 'decisive', value: observation.e, sourceId: observation.s });
      return { ...base, entityId: match.i, state: 'resolved', evidence, reason: null };
    }
  }

  if (ordered.length === 0) {
    return { ...base, entityId: null, state: 'unresolved', evidence, reason: 'no registered entity matched this name' };
  }

  const nameMatches = ordered.filter((c) => c.n === observation.n);
  const compactMatches = ordered.filter((c) => c.k === observation.k);

  // Rule B — exact normalized legal name, unique statewide.
  if (nameMatches.length === 1) {
    const only = nameMatches[0] as EntityCandidateRow;
    const uniqueStatewide = only.c === 1;
    evidence.push({
      evidenceType: uniqueStatewide ? 'EXACT_LEGAL_NAME_UNIQUE' : 'EXACT_LEGAL_NAME_AMBIGUOUS',
      strength: uniqueStatewide ? 'strong' : 'weak',
      value: observation.n,
      sourceId: observation.s,
    });

    const addressAgrees = observation.a !== null && only.a.includes(observation.a);
    if (addressAgrees) {
      evidence.push({ evidenceType: 'EXACT_ADDRESS', strength: 'supporting', value: observation.a as string, sourceId: observation.s });
    }

    if (!uniqueStatewide) {
      return {
        ...base, entityId: null, state: 'ambiguous', evidence,
        reason: `${only.c} entities statewide share this normalized name`,
      };
    }
    if (!rules.allowUniqueLegalName) {
      return {
        ...base, entityId: null, state: 'provisional', evidence,
        reason: 'name-only resolution is disabled until a statewide collision audit justifies it',
      };
    }
    if (rules.requireAddressCorroboration && !addressAgrees) {
      return {
        ...base, entityId: null, state: 'provisional', evidence,
        reason: 'a unique name matched but no address corroborates it',
      };
    }
    return { ...base, entityId: only.i, state: 'resolved', evidence, reason: null };
  }

  if (nameMatches.length > 1) {
    evidence.push({ evidenceType: 'EXACT_LEGAL_NAME_AMBIGUOUS', strength: 'weak', value: observation.n, sourceId: observation.s });
    return {
      ...base, entityId: null, state: 'ambiguous', evidence,
      reason: `${nameMatches.length} registered entities share this exact normalized name`,
    };
  }

  // Rule C — the compact key only. Broader, and never decisive: it is what makes
  // "NORTH STAR HOMES LLC" and "NORTHSTAR HOMES LLC" collide, which is useful for
  // finding a candidate and worthless as proof.
  if (compactMatches.length > 0) {
    evidence.push({ evidenceType: 'COMPACT_NAME', strength: 'weak', value: observation.k, sourceId: observation.s });
    return {
      ...base,
      entityId: null,
      state: compactMatches.length === 1 ? 'provisional' : 'ambiguous',
      evidence,
      reason: compactMatches.length === 1
        ? 'matched only on the space-insensitive key, which is too weak to resolve alone'
        : `${compactMatches.length} entities match the space-insensitive key`,
    };
  }

  return { ...base, entityId: null, state: 'unresolved', evidence, reason: 'no registered entity matched this name' };
}

// ---------------------------------------------------------------------------
// Collision measurement
// ---------------------------------------------------------------------------

export type CollisionReport = {
  readonly totalEntities: number;
  readonly distinctLegalNames: number;
  readonly distinctNormalizedNames: number;
  readonly distinctCompactNames: number;
  /** Normalized names shared by more than one entity. */
  readonly collidingNormalizedNames: number;
  readonly entitiesInNormalizedCollision: number;
  readonly collidingCompactNames: number;
  readonly entitiesInCompactCollision: number;
  /** Addresses shared by more than one entity — common and expected. */
  readonly sharedAddresses: number;
  readonly largestNameCollision: number;
  /** The fraction of entities whose normalized name is statewide-unique. */
  readonly normalizedUniquenessRate: number;
};

/**
 * Measures how safe a name-based rule would be, over the whole register.
 *
 * Streamed and externally sorted, because the register is millions of rows and
 * the whole point of asking is to answer it on real data rather than a sample.
 * The answer decides whether `allowUniqueLegalName` may be turned on — never the
 * other way round.
 */
export async function measureNameCollisions(
  entities: () => AsyncIterable<string>,
  options: { sort?: SortOptions } = {},
): Promise<CollisionReport> {
  const sort = options.sort ?? {};

  let totalEntities = 0;
  let distinctNormalizedNames = 0;
  let collidingNormalizedNames = 0;
  let entitiesInNormalizedCollision = 0;
  let largestNameCollision = 0;
  const rawNames = new Set<string>();

  const byName = groupSorted(
    externalSort(entities(), keyOfNormalizedName, sort),
    keyOfNormalizedName,
    (line) => JSON.parse(line) as EntityCandidateRow,
  );
  for await (const { items } of byName) {
    totalEntities += items.length;
    distinctNormalizedNames += 1;
    for (const item of items) rawNames.add(item.r);
    if (items.length > 1) {
      collidingNormalizedNames += 1;
      entitiesInNormalizedCollision += items.length;
      largestNameCollision = Math.max(largestNameCollision, items.length);
    }
  }

  let distinctCompactNames = 0;
  let collidingCompactNames = 0;
  let entitiesInCompactCollision = 0;
  const byCompact = groupSorted(
    externalSort(entities(), keyOfCompactName, sort),
    keyOfCompactName,
    (line) => JSON.parse(line) as EntityCandidateRow,
  );
  for await (const { items } of byCompact) {
    distinctCompactNames += 1;
    if (items.length > 1) {
      collidingCompactNames += 1;
      entitiesInCompactCollision += items.length;
    }
  }

  let sharedAddresses = 0;
  const byAddress = groupSorted(
    externalSort(addressLines(entities), (l) => extract(l, '"a":"'), sort),
    (l) => extract(l, '"a":"'),
    (line) => JSON.parse(line) as { a: string; i: string },
  );
  for await (const { items } of byAddress) {
    if (new Set(items.map((x) => x.i)).size > 1) sharedAddresses += 1;
  }

  return {
    totalEntities,
    distinctLegalNames: rawNames.size,
    distinctNormalizedNames,
    distinctCompactNames,
    collidingNormalizedNames,
    entitiesInNormalizedCollision,
    collidingCompactNames,
    entitiesInCompactCollision,
    sharedAddresses,
    largestNameCollision,
    normalizedUniquenessRate: totalEntities === 0
      ? 0
      : Math.round(((totalEntities - entitiesInNormalizedCollision) / totalEntities) * 10_000) / 10_000,
  };
}

async function* addressLines(entities: () => AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of entities()) {
    const row = JSON.parse(line) as EntityCandidateRow;
    for (const a of row.a) {
      if (a !== '') yield JSON.stringify({ a, i: row.i });
    }
  }
}

function keyOfNormalizedName(line: string): string {
  return extract(line, '"n":"');
}

function keyOfCompactName(line: string): string {
  return extract(line, '"k":"');
}

function extract(line: string, marker: string): string {
  const at = line.indexOf(marker);
  if (at === -1) return '';
  const from = at + marker.length;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}

// ---------------------------------------------------------------------------
// Candidate generation over the estate
// ---------------------------------------------------------------------------

export type ResolutionSummary = {
  readonly observations: number;
  readonly resolved: number;
  readonly provisional: number;
  readonly ambiguous: number;
  readonly unresolved: number;
};

/**
 * Decides every organization observation against the register.
 *
 * This is a two-pass, disk-backed sort-merge join, and it is written that way on
 * purpose: Minnesota's register is well over a million entities, and an
 * in-memory index of it would reintroduce exactly the `dataset <= memory`
 * assumption DF-0D removed. Peak memory here is one key group plus one
 * observation's candidate set, never the register.
 *
 *   pass 1  both sides emit one line per *lookup key* they can be found by —
 *           normalized name, compact name, registry id. Sorted together and
 *           grouped by key, each group pairs the entities and observations that
 *           share that key.
 *   pass 2  the pairs are sorted by observation and grouped, so one observation
 *           arrives with all of its candidates and `decide` runs on the set.
 *
 * Every observation is emitted in pass 1 whether or not it matched anything, so
 * an observation with no candidates still produces a decision rather than
 * silently vanishing.
 */
export async function resolveOrganizations(
  observations: () => AsyncIterable<string>,
  entities: () => AsyncIterable<string>,
  rules: ResolutionRules,
  decidedAt: string,
  emit: (decision: EntityLinkDecision) => Promise<void>,
  options: { sort?: SortOptions } = {},
): Promise<ResolutionSummary> {
  const sort = options.sort ?? {};

  // ---- pass 1: join on every lookup key -----------------------------------

  async function* keyed(): AsyncGenerator<string> {
    for await (const line of entities()) {
      const row = JSON.parse(line) as EntityCandidateRow;
      for (const key of entityKeys(row)) {
        yield JSON.stringify({ k: key, s: 'e', v: row });
      }
    }
    for await (const line of observations()) {
      const obs = JSON.parse(line) as OrganizationObservation;
      for (const key of observationKeys(obs)) {
        yield JSON.stringify({ k: key, s: 'o', v: obs });
      }
    }
  }

  type KeyedLine = { k: string; s: 'e' | 'o'; v: EntityCandidateRow | OrganizationObservation };

  async function* pairs(): AsyncGenerator<string> {
    // Every observation, matched or not, so pass 2 sees all of them.
    for await (const line of observations()) {
      const obs = JSON.parse(line) as OrganizationObservation;
      yield JSON.stringify({ o: obs.o, obs });
    }

    const grouped = groupSorted(
      externalSort(keyed(), (l) => extract(l, '"k":"'), sort),
      (l) => extract(l, '"k":"'),
      (l) => JSON.parse(l) as KeyedLine,
    );
    for await (const { items } of grouped) {
      const ents: EntityCandidateRow[] = [];
      const obs: OrganizationObservation[] = [];
      for (const item of items) {
        if (item.s === 'e') ents.push(item.v as EntityCandidateRow);
        else obs.push(item.v as OrganizationObservation);
      }
      // A key nothing was observed under costs nothing to skip, which is the
      // usual case: most of the register is never mentioned by a county record.
      if (ents.length === 0 || obs.length === 0) continue;
      for (const o of obs) {
        for (const e of ents) yield JSON.stringify({ o: o.o, cand: e });
      }
    }
  }

  // ---- pass 2: one observation with all its candidates ---------------------

  type PairLine = { o: string; obs?: OrganizationObservation; cand?: EntityCandidateRow };

  let resolved = 0;
  let provisional = 0;
  let ambiguous = 0;
  let unresolved = 0;
  let count = 0;

  const byObservation = groupSorted(
    externalSort(pairs(), (l) => extract(l, '"o":"'), sort),
    (l) => extract(l, '"o":"'),
    (l) => JSON.parse(l) as PairLine,
  );

  for await (const { key, items } of byObservation) {
    let observation: OrganizationObservation | null = null;
    const candidates = new Map<string, EntityCandidateRow>();
    for (const item of items) {
      if (item.obs !== undefined) observation = item.obs;
      // Deduped: an entity found by both its name and its compact key is one
      // candidate, not two.
      if (item.cand !== undefined) candidates.set(item.cand.i, item.cand);
    }
    if (observation === null) {
      // Only reachable if a caller feeds candidate pairs for an observation the
      // observation stream does not contain. Refusing beats inventing one.
      return fail('VALIDATION', `resolution pairs reference unknown observation "${key}"`);
    }
    const observed: OrganizationObservation = observation;

    count += 1;
    const decision = decide(observed, [...candidates.values()], rules, decidedAt);
    if (decision.state === 'resolved') resolved += 1;
    else if (decision.state === 'provisional') provisional += 1;
    else if (decision.state === 'ambiguous') ambiguous += 1;
    else unresolved += 1;

    await emit(decision);
  }

  return { observations: count, resolved, provisional, ambiguous, unresolved };
}

/** The keys an entity can be found by. Empty keys are skipped, never joined on. */
function entityKeys(row: EntityCandidateRow): readonly string[] {
  const keys: string[] = [];
  if (row.n !== '') keys.push(`n:${row.n}`);
  if (row.k !== '' && row.k !== row.n) keys.push(`k:${row.k}`);
  if (row.x !== '') keys.push(`x:${row.x}`);
  return keys;
}

function observationKeys(obs: OrganizationObservation): readonly string[] {
  const keys: string[] = [];
  if (obs.n !== '') keys.push(`n:${obs.n}`);
  if (obs.k !== '' && obs.k !== obs.n) keys.push(`k:${obs.k}`);
  if (obs.e !== null && obs.e !== '') keys.push(`x:${obs.e}`);
  return keys;
}
