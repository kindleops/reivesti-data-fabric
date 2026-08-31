/**
 * Bounded-memory projections over the recorded-instrument estate.
 *
 * Three folds, all built on DF-0D's external sort so a multi-million-row
 * historical estate never has to fit in memory:
 *
 *   1. reference resolution   — join references to the instruments they name
 *   2. ownership derivation   — turn qualifying conveyances into intervals
 *   3. transaction candidates — decide whether several sources describe one event
 *
 * Each is a fold over sorted input, so none depends on ingestion order, and each
 * is recomputable from the retained estate rather than maintained incrementally.
 */
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { canonicalJson, deterministicId } from '../core/hash.ts';
import {
  CONVEYANCE_FAMILIES,
  OWNERSHIP_GRADE_LINKS,
  type InstrumentFamily,
  type InstrumentReference,
  type OwnershipObservation,
  type PropertyLinkState,
  type TransactionCandidate,
  type TransactionCandidateState,
  ownershipObservationIdOf,
  transactionCandidateIdOf,
} from './instruments.ts';
import type { SourceEvidence } from './models.ts';

// ---------------------------------------------------------------------------
// 1. Reference resolution
// ---------------------------------------------------------------------------

/** Minimal projection of an instrument, for joining. */
export type InstrumentKey = {
  /** normalizedDocumentNumber */ readonly d: string;
  /** instrumentId */ readonly i: string;
  /** countyFips */ readonly c: string;
  /** registrationSystem */ readonly s: string;
};

/** Minimal projection of a reference, for joining. */
export type ReferenceKey = {
  /** toNormalizedDocumentNumber */ readonly d: string;
  /** referenceId */ readonly r: string;
  /** fromInstrumentId */ readonly f: string;
  /** countyFips */ readonly c: string;
  /** toRegistrationSystem */ readonly s: string;
};

export type ReferenceResolution = {
  readonly referenceId: string;
  readonly fromInstrumentId: string;
  readonly toInstrumentId: string | null;
  readonly resolved: boolean;
  /** Set when several instruments share the referenced number. */
  readonly ambiguousCandidates: readonly string[];
};

export type ReferenceResolutionResult = {
  readonly total: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly ambiguous: number;
};

/**
 * Joins references to their targets by normalized document number.
 *
 * Unresolved references are *emitted*, not dropped. A 2024 satisfaction pointing
 * at a 2009 mortgage is unresolved until backfill reaches 2009, and the pointer
 * is the only record that the lineage exists. Discarding it would mean the
 * lineage silently never appears.
 *
 * A reference whose number matches instruments in more than one registration
 * system stays unresolved and records the candidates: Abstract and Torrens
 * number independently, so an ambiguous match is two different documents.
 */
export async function resolveReferences(
  instruments: () => AsyncIterable<string>,
  references: () => AsyncIterable<string>,
  emit: (resolution: ReferenceResolution) => Promise<void>,
  options: { sort?: SortOptions } = {},
): Promise<ReferenceResolutionResult> {
  const sort = options.sort ?? {};

  // Index instruments by (county, number). Bounded by distinct document numbers
  // in the estate, and only the id is retained per key.
  const byNumber = new Map<string, InstrumentKey[]>();
  for await (const line of instruments()) {
    const k = JSON.parse(line) as InstrumentKey;
    const key = `${k.c}|${k.d}`;
    const list = byNumber.get(key) ?? [];
    list.push(k);
    byNumber.set(key, list);
  }

  let total = 0;
  let resolved = 0;
  let ambiguous = 0;

  const sorted = externalSort(references(), keyOfReference, sort);
  for await (const { items } of groupSorted(sorted, keyOfReference, (l) => JSON.parse(l) as ReferenceKey)) {
    for (const ref of items) {
      total += 1;
      const candidates = byNumber.get(`${ref.c}|${ref.d}`) ?? [];

      // Prefer an exact registration-system match; fall back only when the
      // reference does not state a system.
      const exact = candidates.filter((c) => c.s === ref.s);
      const pool = exact.length > 0 ? exact : (ref.s === 'unknown' ? candidates : []);

      if (pool.length === 1) {
        resolved += 1;
        await emit({
          referenceId: ref.r, fromInstrumentId: ref.f,
          toInstrumentId: (pool[0] as InstrumentKey).i, resolved: true, ambiguousCandidates: [],
        });
      } else if (pool.length > 1) {
        ambiguous += 1;
        await emit({
          referenceId: ref.r, fromInstrumentId: ref.f, toInstrumentId: null, resolved: false,
          ambiguousCandidates: pool.map((c) => c.i).sort(),
        });
      } else {
        await emit({
          referenceId: ref.r, fromInstrumentId: ref.f, toInstrumentId: null, resolved: false, ambiguousCandidates: [],
        });
      }
    }
  }

  return { total, resolved, unresolved: total - resolved, ambiguous };
}

function keyOfReference(line: string): string {
  return extract(line, '"d":"');
}

// ---------------------------------------------------------------------------
// 2. Ownership derivation
// ---------------------------------------------------------------------------

/** One conveyance, flattened to what ownership needs. */
export type ConveyanceRow = {
  /** propertyId */ readonly p: string;
  /** countyFips */ readonly c: string;
  /** recordedAt, ISO — the sort key within a property */ readonly t: string;
  /** instrumentId */ readonly i: string;
  /** family */ readonly f: InstrumentFamily;
  /** property link state */ readonly l: PropertyLinkState;
  /** grantors: [partyObservationId, normalizedName][] */ readonly go: readonly (readonly [string, string])[];
  /** grantees: [partyObservationId, normalizedName][] */ readonly ge: readonly (readonly [string, string])[];
};

export type OwnershipResult = {
  readonly propertiesTouched: number;
  readonly acquisitions: number;
  readonly dispositions: number;
  readonly skippedNotQualifying: number;
};

/**
 * Derives ownership intervals from qualifying conveyances.
 *
 * Deliberately conservative. A conveyance contributes only when *all* of:
 *   - its family conveys (a Sheriff's Certificate, contract for deed or
 *     correction does not, even though each moves or touches an interest);
 *   - its property link is ownership-grade, so a legal-description guess can
 *     never rewrite who owns something;
 *   - it names at least one grantee, so a one-sided index row is not read as an
 *     acquisition by nobody.
 *
 * A disposition is only recorded for a grantor we have *already observed
 * acquiring* the property. Otherwise the record would assert that someone we
 * never saw acquire the land disposed of it, which is a claim the estate cannot
 * support — it usually just means backfill has not reached their deed.
 */
export async function deriveOwnership(
  conveyances: () => AsyncIterable<string>,
  evidenceFor: (instrumentId: string) => SourceEvidence,
  emit: (observation: OwnershipObservation) => Promise<void>,
  options: { sort?: SortOptions } = {},
): Promise<OwnershipResult> {
  let propertiesTouched = 0;
  let acquisitions = 0;
  let dispositions = 0;
  let skippedNotQualifying = 0;

  const sorted = externalSort(conveyances(), keyOfConveyance, options.sort ?? {});
  for await (const { items } of groupSorted(sorted, keyOfProperty, (l) => JSON.parse(l) as ConveyanceRow)) {
    propertiesTouched += 1;

    // Chronological within the property. The sort key embeds the timestamp, so
    // this is already ordered; sorting again costs nothing and documents intent.
    const ordered = [...items].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i < b.i ? -1 : 1));
    const open = new Map<string, OwnershipObservation>();
    const closed: OwnershipObservation[] = [];

    for (const row of ordered) {
      if (!CONVEYANCE_FAMILIES.has(row.f) || !OWNERSHIP_GRADE_LINKS.has(row.l) || row.ge.length === 0) {
        skippedNotQualifying += 1;
        continue;
      }
      const evidence = evidenceFor(row.i);

      // Grantors first: a conveyance closes the seller's interval before it
      // opens the buyer's, which matters when the same party appears on both
      // sides of a correction-like chain.
      for (const [, normalizedName] of row.go) {
        const existing = open.get(normalizedName);
        if (!existing) continue; // never observed acquiring; not our claim to make
        open.delete(normalizedName);
        closed.push({ ...existing, observedDisposedAt: row.t, disposedByInstrumentId: row.i });
        dispositions += 1;
      }

      for (const [partyObservationId, normalizedName] of row.ge) {
        if (open.has(normalizedName)) continue; // already holding; not a second acquisition
        open.set(normalizedName, {
          ownershipObservationId: ownershipObservationIdOf(row.p, normalizedName),
          propertyId: row.p,
          countyFips: row.c,
          partyObservationId,
          normalizedName,
          observedAcquiredAt: row.t,
          acquiredByInstrumentId: row.i,
          observedDisposedAt: null,
          disposedByInstrumentId: null,
          basis: 'recorded_conveyance',
          evidence,
        });
        acquisitions += 1;
      }
    }

    for (const observation of [...closed, ...open.values()]) await emit(observation);
  }

  return { propertiesTouched, acquisitions, dispositions, skippedNotQualifying };
}

function keyOfConveyance(line: string): string {
  // Property first, then time: groups by property and orders within it.
  return `${extract(line, '"p":"')}|${extract(line, '"t":"')}`;
}

function keyOfProperty(line: string): string {
  return extract(line, '"p":"');
}

// ---------------------------------------------------------------------------
// 3. Transaction candidates
// ---------------------------------------------------------------------------

/** One source's claim that something happened to a property on a date. */
export type TransactionObservationRow = {
  /** propertyId */ readonly p: string;
  /** countyFips */ readonly c: string;
  /** date, ISO */ readonly t: string;
  /** sourceId */ readonly s: string;
  /** kind: ecrv | recorder | assessor */ readonly k: 'ecrv' | 'recorder' | 'assessor';
  /** identifier of the underlying observation */ readonly id: string;
  /** normalized party names involved, sorted */ readonly n: readonly string[];
  /** consideration in minor units, where the source states one */ readonly a: number | null;
};

/** Days within which two sources are taken to be describing the same event. */
export const MATCH_WINDOW_DAYS = 60;

export type CandidateResult = {
  readonly candidates: number;
  readonly supported: number;
  readonly possible: number;
  readonly conflicts: number;
};

/**
 * Groups source observations into transaction candidates.
 *
 * The problem this solves: the assessor echoes a last sale, eCRV declares the
 * sale, and the recorder holds the deed. Emitting three canonical sales would
 * triple-count every transaction in the county. Merging them unconditionally
 * would fuse genuinely different events that happened to share a month.
 *
 * So observations for a property are clustered by date proximity, and each
 * cluster is *classified* rather than merged:
 *
 *   SUPPORTED_MATCH  two or more independent sources, and no disagreement
 *   POSSIBLE_MATCH   they fit together but nothing corroborates strongly
 *   CONFLICT         they cannot all describe one event
 *
 * The underlying observations are never rewritten. A candidate is a view over
 * them, and a `CONFLICT` is a durable statement that the sources disagree —
 * which is far more useful than a silently chosen winner.
 */
export async function matchTransactionCandidates(
  observations: () => AsyncIterable<string>,
  evidenceFor: (row: TransactionObservationRow) => SourceEvidence,
  emit: (candidate: TransactionCandidate) => Promise<void>,
  options: { sort?: SortOptions; windowDays?: number } = {},
): Promise<CandidateResult> {
  const windowMs = (options.windowDays ?? MATCH_WINDOW_DAYS) * 86_400_000;
  let candidates = 0;
  let supported = 0;
  let possible = 0;
  let conflicts = 0;

  const sorted = externalSort(observations(), keyOfObservation, options.sort ?? {});
  for await (const { items } of groupSorted(sorted, keyOfProperty, (l) => JSON.parse(l) as TransactionObservationRow)) {
    const ordered = [...items].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1));

    let cluster: TransactionObservationRow[] = [];
    const flush = async (): Promise<void> => {
      if (cluster.length === 0) return;
      const candidate = classify(cluster, evidenceFor);
      candidates += 1;
      if (candidate.state === 'SUPPORTED_MATCH') supported += 1;
      else if (candidate.state === 'POSSIBLE_MATCH') possible += 1;
      else if (candidate.state === 'CONFLICT') conflicts += 1;
      await emit(candidate);
      cluster = [];
    };

    for (const row of ordered) {
      const anchor = cluster[0];
      if (anchor && Date.parse(row.t) - Date.parse(anchor.t) > windowMs) await flush();
      cluster.push(row);
    }
    await flush();
  }

  return { candidates, supported, possible, conflicts };
}

function classify(
  cluster: readonly TransactionObservationRow[],
  evidenceFor: (row: TransactionObservationRow) => SourceEvidence,
): TransactionCandidate {
  const anchor = cluster[0] as TransactionObservationRow;
  const kinds = new Set(cluster.map((r) => r.k));
  const disagreements: string[] = [];

  // Independent sources stating materially different considerations are not
  // describing the same event, or one of them is wrong. Either way it is not a
  // supported match, and picking one would be inventing an answer.
  const amounts = [...new Set(cluster.map((r) => r.a).filter((a): a is number => a !== null))];
  if (amounts.length > 1) {
    const spread = Math.max(...amounts) - Math.min(...amounts);
    // A tolerance, because rounding and recording fees legitimately differ.
    if (spread > Math.max(100_00, Math.min(...amounts) * 0.02)) {
      disagreements.push(`consideration differs across sources: ${amounts.sort((a, b) => a - b).join(' vs ')}`);
    }
  }

  // Party overlap is the strongest corroboration available without resolving
  // identity. Its absence is not proof of conflict — sources index different
  // roles — so it downgrades rather than conflicts.
  const nameSets = cluster.filter((r) => r.n.length > 0).map((r) => new Set(r.n));
  let sharesParty = nameSets.length < 2;
  for (let i = 0; i < nameSets.length && !sharesParty; i++) {
    for (let j = i + 1; j < nameSets.length && !sharesParty; j++) {
      for (const name of nameSets[i] as Set<string>) {
        if ((nameSets[j] as Set<string>).has(name)) { sharesParty = true; break; }
      }
    }
  }

  let state: TransactionCandidateState;
  if (disagreements.length > 0) state = 'CONFLICT';
  else if (kinds.size >= 2 && sharesParty) state = 'SUPPORTED_MATCH';
  else if (kinds.size >= 2) {
    state = 'POSSIBLE_MATCH';
    disagreements.push('no party name is shared across the corroborating sources');
  } else state = 'UNRESOLVED';

  return {
    candidateId: transactionCandidateIdOf(anchor.p, anchor.t),
    propertyId: anchor.p,
    countyFips: anchor.c,
    anchorDate: anchor.t,
    state,
    supportingSourceIds: [...new Set(cluster.map((r) => r.s))].sort(),
    ecrvTransactionId: cluster.find((r) => r.k === 'ecrv')?.id ?? null,
    recorderInstrumentId: cluster.find((r) => r.k === 'recorder')?.id ?? null,
    assessorSaleEcho: cluster.find((r) => r.k === 'assessor')?.id ?? null,
    disagreements: [...disagreements].sort(),
    evidence: evidenceFor(anchor),
  };
}

function keyOfObservation(line: string): string {
  return `${extract(line, '"p":"')}|${extract(line, '"t":"')}`;
}

// ---------------------------------------------------------------------------

/** Textual key extraction, to avoid parsing every row during a sort. */
function extract(line: string, marker: string): string {
  const at = line.indexOf(marker);
  if (at === -1) return '';
  const from = at + marker.length;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}

export function contributionLine(value: unknown): string {
  return canonicalJson(value);
}

export { deterministicId };
