/**
 * Bounded-memory organization-link projection.
 *
 * The question this answers: *for every organization name a county record has
 * mentioned, which state registration — if any — does the evidence justify
 * linking it to?*
 *
 * It is a projection, not an ingestion step, for the same reason property
 * resolution is: the answer depends on the whole estate, so it must be recomputed
 * as a fold over everything rather than decided one record at a time. And like
 * property resolution it is a **fold, never an in-place mutation** — running it
 * twice, or in a different order, produces the same file.
 *
 * Everything here is externally sorted. Minnesota's register alone is over a
 * million entities; an in-memory index of it would put back exactly the
 * `dataset <= memory` assumption DF-0D removed.
 */
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { canonicalJson } from '../core/hash.ts';
import { createFileLineWriter, readLines } from '../core/lines.ts';
import {
  resolveOrganizations,
  type EntityCandidateRow,
  type EntityLinkDecision,
  type OrganizationObservation,
  type ResolutionRules,
  type ResolutionSummary,
} from './entity-resolution.ts';
import { looksLikeOrganization, normalizeOrganizationName } from './name-normalization.ts';
import { normalizeAddress, type BusinessAddressObservation, type BusinessEntityRecord } from './organizations.ts';
import type { PartyObservation } from './models.ts';

/**
 * One party observation, reduced to what candidate matching needs.
 *
 * Returns null for anything that does not look like an organization. That test
 * is a **routing hint only**: it decides whether to go looking for a
 * registration, and it never writes a classification back onto the party, whose
 * `kind` stays exactly as the source left it.
 */
export function organizationObservationOf(
  party: PartyObservation,
): OrganizationObservation | null {
  if (party.kind === 'person') return null;
  if (party.kind !== 'organization' && !looksLikeOrganization(party.rawName)) return null;

  const name = normalizeOrganizationName(party.rawName);
  if (name.search === '') return null;

  return {
    o: party.observationId,
    s: party.evidence.sourceId,
    r: party.rawName,
    n: name.search,
    k: name.compact,
    a: party.address === null ? null : normalizeAddress(party.address),
    // No county source in the estate carries a Secretary of State identifier
    // today. The field exists because one might, and because that is the only
    // evidence strong enough to resolve on its own.
    e: null,
  };
}

/** One registered entity, reduced the same way. Counts are filled in later. */
function candidateSeed(entity: BusinessEntityRecord): Omit<EntityCandidateRow, 'a' | 'c'> {
  return {
    i: entity.entityId,
    x: entity.sourceEntityId,
    n: entity.normalizedName,
    k: entity.compactName,
    r: entity.legalName,
  };
}

export type OrganizationProjectionOptions = {
  readonly rules: ResolutionRules;
  readonly decidedAt: string;
  readonly sort?: SortOptions;
  /** Directory for the intermediate candidate file. Defaults to an OS temp dir. */
  readonly scratchDir?: string;
};

/**
 * Builds the candidate side of the join and resolves every observation against it.
 *
 * Two preparatory passes, both disk-backed:
 *
 *   join    entities and their addresses are keyed by entity id, sorted together
 *           and grouped, so each entity arrives with its own addresses and
 *           nothing else is held.
 *   count   the joined rows are sorted by normalized name and grouped, which is
 *           what makes `c` — how many entities statewide share this name —
 *           computable without an index of the register. That number is the
 *           difference between a name being evidence and being a coincidence.
 */
export async function projectOrganizationLinks(
  observations: () => AsyncIterable<string>,
  entities: () => AsyncIterable<string>,
  addresses: () => AsyncIterable<string>,
  emit: (decision: EntityLinkDecision) => Promise<void>,
  options: OrganizationProjectionOptions,
): Promise<ResolutionSummary> {
  const sort = options.sort ?? {};
  const scratch = options.scratchDir ?? await mkdtemp(join(tmpdir(), 'df-orglink-'));
  const candidatePath = join(scratch, 'entity-candidates.ndjson');

  try {
    // ---- pass 1: attach each entity's addresses --------------------------
    async function* keyedByEntity(): AsyncGenerator<string> {
      for await (const line of entities()) {
        const entity = JSON.parse(line) as BusinessEntityRecord;
        yield JSON.stringify({ i: entity.entityId, s: 'e', v: candidateSeed(entity) });
      }
      for await (const line of addresses()) {
        const address = JSON.parse(line) as BusinessAddressObservation;
        yield JSON.stringify({ i: address.entityId, s: 'a', v: address.normalizedAddress });
      }
    }

    type EntityJoinLine = { i: string; s: 'e' | 'a'; v: Omit<EntityCandidateRow, 'a' | 'c'> | string };

    async function* joined(): AsyncGenerator<string> {
      const grouped = groupSorted(
        externalSort(keyedByEntity(), (l) => extract(l, '"i":"'), sort),
        (l) => extract(l, '"i":"'),
        (l) => JSON.parse(l) as EntityJoinLine,
      );
      for await (const { items } of grouped) {
        let seed: Omit<EntityCandidateRow, 'a' | 'c'> | null = null;
        const addrs = new Set<string>();
        for (const item of items) {
          if (item.s === 'e') seed = item.v as Omit<EntityCandidateRow, 'a' | 'c'>;
          else addrs.add(item.v as string);
        }
        // An address row whose entity is not in the estate is skipped rather
        // than turned into an entity: an address is not a registration.
        if (seed === null) continue;
        yield JSON.stringify({ ...seed, a: [...addrs].sort() });
      }
    }

    // ---- pass 2: statewide name-collision counts --------------------------
    const writer = await createFileLineWriter(candidatePath);
    const byName = groupSorted(
      externalSort(joined(), (l) => extract(l, '"n":"'), sort),
      (l) => extract(l, '"n":"'),
      (l) => JSON.parse(l) as Omit<EntityCandidateRow, 'c'>,
    );
    for await (const { items } of byName) {
      for (const item of items) {
        await writer.write(canonicalJson({ ...item, c: items.length } satisfies EntityCandidateRow));
      }
    }
    await writer.close();

    return await resolveOrganizations(
      observations,
      () => readLines(candidatePath),
      options.rules,
      options.decidedAt,
      emit,
      { sort },
    );
  } finally {
    if (options.scratchDir === undefined) await rm(scratch, { recursive: true, force: true });
    else await rm(candidatePath, { force: true });
  }
}

function extract(line: string, marker: string): string {
  const at = line.indexOf(marker);
  if (at === -1) return '';
  const from = at + marker.length;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}
