/**
 * Bounded-memory property resolution projection.
 *
 * Resolution must fold every identifier observation that points at a property,
 * across every source and every prior run. DF-0C did that by loading the whole
 * canonical estate into memory and grouping with a `Map` — correct, and fatal at
 * county scale.
 *
 * This does the same fold with external sorting. Each run appends compact
 * contribution rows to a file; the projection sorts that file by property id,
 * groups the sorted stream, and folds each group as it passes. Peak memory is
 * one sort chunk plus one property's observations, not the estate.
 *
 * Order-independence survives intact, and is in fact strengthened: sorting makes
 * the input to each fold canonical, so the result cannot depend on ingestion
 * order even in principle.
 */
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { deterministicId } from '../core/hash.ts';
import type { PropertyIdentifierObservation, ResolutionState } from './models.ts';
import type { ParcelAuthority, PropertyConflict, PropertyResolution } from './property-resolution.ts';

/**
 * One identifier observation, flattened to the fields resolution needs.
 *
 * Deliberately short keys: this file has one row per identifier per run, and at
 * county scale the difference between `propertyId` and `p` is tens of megabytes
 * of disk and parse time for no benefit.
 */
export type ResolutionContribution = {
  /** propertyId */ readonly p: string;
  /** countyFips */ readonly c: string;
  /** normalizedParcel */ readonly n: string;
  /** observationId */ readonly o: string;
  /** sourceId */ readonly s: string;
  /** sourceRecordId */ readonly r: string;
  /** resolutionState */ readonly st: ResolutionState;
  /** finality */ readonly f: string;
  /** normalized situs address, when the source supplied one */ readonly a: string | null;
  /** observedAt */ readonly t: string;
};

export function contributionOf(
  observation: PropertyIdentifierObservation,
  address: string | null,
): ResolutionContribution | null {
  if (observation.identifierType !== 'county_parcel' || observation.propertyId === null) return null;
  return {
    p: observation.propertyId,
    c: observation.countyFips ?? '',
    n: observation.normalizedValue,
    o: observation.observationId,
    s: observation.evidence.sourceId,
    r: observation.evidence.sourceRecordId,
    st: observation.resolutionState,
    f: observation.finality,
    a: address,
    t: observation.evidence.observedAt,
  };
}

export type ProjectionResult = {
  readonly propertyCount: number;
  readonly resolvedCount: number;
  readonly provisionalCount: number;
  readonly unresolvedCount: number;
  readonly conflictCount: number;
};

export type ProjectionSinks = {
  resolution(row: PropertyResolution): Promise<void>;
  conflict(row: PropertyConflict): Promise<void>;
};

export type ProjectionOptions = {
  readonly authority: ParcelAuthority;
  readonly runId: string;
  readonly detectedAt: string;
  readonly sort?: SortOptions;
};

/**
 * Folds contributions into resolutions and conflicts, streaming both to sinks.
 *
 * Two passes, each externally sorted:
 *   1. by property id  — resolution, plus the conflicts that concern one parcel
 *   2. by address      — the one conflict kind that concerns several parcels
 *
 * The second pass exists because "one address, several PIDs" cannot be seen from
 * inside a single property's group, and detecting it by re-scanning was the
 * O(n^2) defect this phase removed.
 */
export async function projectResolutions(
  contributions: () => AsyncIterable<string>,
  sinks: ProjectionSinks,
  options: ProjectionOptions,
): Promise<ProjectionResult> {
  let propertyCount = 0;
  let resolvedCount = 0;
  let provisionalCount = 0;
  let unresolvedCount = 0;
  let conflictCount = 0;

  const emitConflict = async (row: PropertyConflict): Promise<void> => {
    conflictCount += 1;
    await sinks.conflict(row);
  };

  // --- pass 1: group by property ------------------------------------------
  const byProperty = groupSorted(
    externalSort(contributions(), keyOfProperty, options.sort ?? {}),
    keyOfProperty,
    (line) => JSON.parse(line) as ResolutionContribution,
  );

  for await (const { items } of byProperty) {
    // Deterministic order inside the group, so the chosen authoritative
    // observation never depends on arrival order.
    items.sort((a, b) => (a.o < b.o ? -1 : a.o > b.o ? 1 : 0));
    const anchor = items[0] as ResolutionContribution;

    const authoritative = items.find((i) => options.authority.isAuthoritativeForParcelIdentity(i.s)) ?? null;
    const state: ResolutionState = authoritative
      ? 'resolved'
      : items.some((i) => i.st === 'provisional') ? 'provisional' : 'unresolved';
    const method = authoritative
      ? 'county_parcel_authoritative'
      : state === 'provisional' ? 'county_parcel_preliminary' : 'none';

    await sinks.resolution({
      propertyId: anchor.p,
      countyFips: anchor.c,
      normalizedParcel: anchor.n,
      state,
      authoritativeSourceId: authoritative?.s ?? null,
      authoritativeObservationId: authoritative?.o ?? null,
      resolutionMethod: method,
      // The instant the authoritative evidence was observed, not when this fold
      // ran, so recomputing the projection never moves the timestamp.
      resolvedAt: authoritative?.t ?? null,
      evidenceObservationIds: items.map((i) => i.o),
      contributingSourceIds: [...new Set(items.map((i) => i.s))].sort(),
    });

    propertyCount += 1;
    if (state === 'resolved') resolvedCount += 1;
    else if (state === 'provisional') provisionalCount += 1;
    else unresolvedCount += 1;

    const conflict = (
      kind: PropertyConflict['conflictKind'],
      severity: PropertyConflict['severity'],
      detail: Record<string, unknown>,
      observationIds: readonly string[],
    ): PropertyConflict => ({
      conflictId: deterministicId('conflict', kind, anchor.c, anchor.n, options.runId),
      propertyId: anchor.p,
      countyFips: anchor.c,
      normalizedParcel: anchor.n,
      conflictKind: kind,
      severity,
      detail,
      observationIds: [...observationIds].sort(),
      detectedAt: options.detectedAt,
      runId: options.runId,
      status: 'open',
    });

    const addresses = [...new Set(items.map((i) => i.a).filter((a): a is string => a !== null))].sort();
    if (addresses.length > 1) {
      await emitConflict(conflict('same_pid_different_address', 'warn', { addresses }, items.map((i) => i.o)));
    }

    const authoritativeRecords = new Set(
      items.filter((i) => options.authority.isAuthoritativeForParcelIdentity(i.s)).map((i) => `${i.s} ${i.r}`),
    );
    if (authoritativeRecords.size > 1) {
      await emitConflict(conflict('duplicate_authoritative_row', 'blocking',
        { sourceRecordIds: [...authoritativeRecords].sort() },
        items.filter((i) => options.authority.isAuthoritativeForParcelIdentity(i.s)).map((i) => i.o)));
    }

    if (!authoritative && items.some((i) => i.st === 'provisional')) {
      await emitConflict(conflict('pid_absent_from_authoritative_source', 'info',
        { contributingSources: [...new Set(items.map((i) => i.s))].sort() }, items.map((i) => i.o)));
    }
  }

  // --- pass 2: group by address -------------------------------------------
  const withAddress = async function* (): AsyncGenerator<string> {
    for await (const line of contributions()) {
      if ((JSON.parse(line) as ResolutionContribution).a !== null) yield line;
    }
  };

  const byAddress = groupSorted(
    externalSort(withAddress(), keyOfAddress, options.sort ?? {}),
    keyOfAddress,
    (line) => JSON.parse(line) as ResolutionContribution,
  );

  for await (const { items } of byAddress) {
    const properties = [...new Set(items.map((i) => i.p))].sort();
    if (properties.length <= 1) continue;
    const anchor = items[0] as ResolutionContribution;
    await emitConflict({
      conflictId: deterministicId('conflict', 'address_matches_different_pid', anchor.c, anchor.a ?? '', options.runId),
      propertyId: null,
      countyFips: anchor.c,
      normalizedParcel: null,
      conflictKind: 'address_matches_different_pid',
      severity: 'info',
      detail: { address: anchor.a, propertyIds: properties },
      observationIds: items.map((i) => i.o).sort(),
      detectedAt: options.detectedAt,
      runId: options.runId,
      status: 'open',
    });
  }

  return { propertyCount, resolvedCount, provisionalCount, unresolvedCount, conflictCount };
}

/**
 * Sort keys are extracted textually rather than by parsing the whole row.
 * `JSON.parse` on every comparison would dominate the sort at county scale.
 */
function keyOfProperty(line: string): string {
  return extract(line, '"p":"');
}

/**
 * Address grouping is keyed by COUNTY AND address, never by address alone.
 *
 * "100 Main St" exists in most of the 3,222 county-equivalents. Grouping on the
 * address alone would have reported a same-address conflict spanning states —
 * and, worse, listed parcels from different counties as if they were rival
 * identities for one property. Partitioning makes this unreachable in the normal
 * path; the key makes it unreachable at all.
 */
function keyOfAddress(line: string): string {
  return `${extract(line, '"c":"')}\u0000${extract(line, '"a":"')}`;
}

function extract(line: string, marker: string): string {
  const at = line.indexOf(marker);
  if (at === -1) return '';
  const from = at + marker.length;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}
