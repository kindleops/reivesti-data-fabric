/**
 * Property resolution across sources.
 *
 * The central DF-0C property, and the reason this is a fold rather than a
 * mutation: **resolution is order-independent.**
 *
 * A property's state is computed by folding every identifier observation that
 * points at it. A fold over a set does not care what order the set was
 * assembled in, so ingesting eCRV and then the assessor gives bit-for-bit the
 * same answer as the assessor and then eCRV. Nothing "upgrades" a prior row;
 * the eCRV observation keeps saying `preliminary` / `provisional` forever,
 * because that is what eCRV said, and rewriting it would destroy the evidence
 * that the promotion was justified.
 *
 * The canonical property id itself is already order-independent: it is a pure
 * function of (countyFips, normalizedParcel). Both sources compute the same id
 * without ever consulting each other. What this module decides is the *state*
 * of that property and which evidence justifies it.
 */
import { deterministicId } from '../core/hash.ts';
import type { PropertyIdentifierObservation, ResolutionState } from './models.ts';

export type PropertyResolution = {
  readonly propertyId: string;
  readonly countyFips: string;
  readonly normalizedParcel: string;
  readonly state: ResolutionState;
  /** The source whose authoritative evidence justifies `resolved`. */
  readonly authoritativeSourceId: string | null;
  readonly authoritativeObservationId: string | null;
  readonly resolutionMethod: string;
  readonly resolvedAt: string | null;
  readonly evidenceObservationIds: readonly string[];
  readonly contributingSourceIds: readonly string[];
};

/**
 * Sources whose parcel identifiers are authoritative for parcel identity in
 * their jurisdiction — the county office that assigns the number.
 *
 * Authority is field- and semantic-specific, never a blanket "county beats
 * state". A county assessor is authoritative for *parcel identity* and not for
 * an accepted transfer price; Minnesota eCRV is authoritative for the latter.
 */
export type ParcelAuthority = {
  /** True when this source's parcel identifiers are county-verified final PIDs. */
  isAuthoritativeForParcelIdentity(sourceId: string): boolean;
};

export function parcelAuthorityFor(authoritativeSourceIds: readonly string[]): ParcelAuthority {
  const set = new Set(authoritativeSourceIds);
  return { isAuthoritativeForParcelIdentity: (sourceId) => set.has(sourceId) };
}

/**
 * Folds identifier observations into a resolution.
 *
 * Only county-scoped parcel identifiers participate. Address identifiers are
 * accepted as evidence of nothing: an address is not a property identity, and a
 * source that supplies only an address leaves the property unresolved.
 */
export function resolveProperty(
  observations: readonly PropertyIdentifierObservation[],
  authority: ParcelAuthority,
): PropertyResolution | null {
  const parcels = observations.filter((o) => o.identifierType === 'county_parcel' && o.propertyId !== null);
  if (parcels.length === 0) return null;

  const first = parcels[0] as PropertyIdentifierObservation;
  const propertyId = first.propertyId as string;
  const countyFips = first.countyFips as string;

  if (parcels.some((o) => o.propertyId !== propertyId)) {
    throw new Error(`resolveProperty received observations for more than one property: ${propertyId}`);
  }

  // Deterministic ordering, so the chosen authoritative observation does not
  // depend on the order rows arrived in.
  const ordered = [...parcels].sort((a, b) => a.observationId.localeCompare(b.observationId));
  const authoritative = ordered.find((o) => authority.isAuthoritativeForParcelIdentity(o.evidence.sourceId)) ?? null;

  let state: ResolutionState;
  let method: string;
  if (authoritative) {
    state = 'resolved';
    method = 'county_parcel_authoritative';
  } else if (ordered.some((o) => o.resolutionState === 'provisional')) {
    state = 'provisional';
    method = 'county_parcel_preliminary';
  } else {
    state = 'unresolved';
    method = 'none';
  }

  // The instant the authoritative evidence was observed, not the instant this
  // fold ran — so recomputing the projection never moves the timestamp.
  const resolvedAt = authoritative ? authoritative.evidence.observedAt : null;

  return {
    propertyId,
    countyFips,
    normalizedParcel: first.normalizedValue,
    state,
    authoritativeSourceId: authoritative?.evidence.sourceId ?? null,
    authoritativeObservationId: authoritative?.observationId ?? null,
    resolutionMethod: method,
    resolvedAt,
    evidenceObservationIds: ordered.map((o) => o.observationId),
    contributingSourceIds: [...new Set(ordered.map((o) => o.evidence.sourceId))].sort(),
  };
}

/** Folds a mixed pile of observations into one resolution per property. */
export function resolveAll(
  observations: readonly PropertyIdentifierObservation[],
  authority: ParcelAuthority,
): readonly PropertyResolution[] {
  const byProperty = new Map<string, PropertyIdentifierObservation[]>();
  for (const o of observations) {
    if (o.identifierType !== 'county_parcel' || o.propertyId === null) continue;
    const list = byProperty.get(o.propertyId) ?? [];
    list.push(o);
    byProperty.set(o.propertyId, list);
  }
  const out: PropertyResolution[] = [];
  for (const list of byProperty.values()) {
    const resolution = resolveProperty(list, authority);
    if (resolution) out.push(resolution);
  }
  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export type ConflictKind =
  | 'same_pid_different_address'
  | 'duplicate_authoritative_row'
  | 'pid_absent_from_authoritative_source'
  | 'address_matches_different_pid';

export type PropertyConflict = {
  readonly conflictId: string;
  readonly propertyId: string | null;
  readonly countyFips: string;
  readonly normalizedParcel: string | null;
  readonly conflictKind: ConflictKind;
  readonly severity: 'info' | 'warn' | 'blocking';
  readonly detail: Readonly<Record<string, unknown>>;
  readonly observationIds: readonly string[];
  readonly detectedAt: string;
  readonly runId: string;
  /** Conflicts are closed by a human or by better evidence, never by ingestion. */
  readonly status: 'open' | 'accepted' | 'dismissed';
};

export type ConflictInput = {
  readonly observations: readonly PropertyIdentifierObservation[];
  readonly authority: ParcelAuthority;
  readonly runId: string;
  readonly detectedAt: string;
  /** Normalised situs address per observation id, where a source supplies one. */
  readonly addressByObservation: ReadonlyMap<string, string>;
};

/**
 * Detects disagreements that must NOT be resolved by guessing.
 *
 * None of these mutate anything. A conflict is a flag for a human or for better
 * evidence; ingestion never picks a winner.
 */
export function detectConflicts(input: ConflictInput): readonly PropertyConflict[] {
  const out: PropertyConflict[] = [];
  const parcels = input.observations.filter((o) => o.identifierType === 'county_parcel' && o.propertyId !== null);

  const byProperty = new Map<string, PropertyIdentifierObservation[]>();
  for (const o of parcels) {
    const list = byProperty.get(o.propertyId as string) ?? [];
    list.push(o);
    byProperty.set(o.propertyId as string, list);
  }

  const make = (
    kind: ConflictKind,
    severity: PropertyConflict['severity'],
    propertyId: string | null,
    countyFips: string,
    normalizedParcel: string | null,
    detail: Record<string, unknown>,
    observationIds: readonly string[],
  ): PropertyConflict => ({
    conflictId: deterministicId('conflict', kind, countyFips, normalizedParcel ?? '', input.runId),
    propertyId,
    countyFips,
    normalizedParcel,
    conflictKind: kind,
    severity,
    detail,
    observationIds: [...observationIds].sort(),
    detectedAt: input.detectedAt,
    runId: input.runId,
    status: 'open',
  });

  for (const [propertyId, list] of byProperty) {
    const ordered = [...list].sort((a, b) => a.observationId.localeCompare(b.observationId));
    const anchor = ordered[0] as PropertyIdentifierObservation;
    const countyFips = anchor.countyFips as string;

    // C: same PID, materially different address across sources.
    const addresses = new Map<string, string[]>();
    for (const o of ordered) {
      const address = input.addressByObservation.get(o.observationId);
      if (!address) continue;
      const list2 = addresses.get(address) ?? [];
      list2.push(o.observationId);
      addresses.set(address, list2);
    }
    if (addresses.size > 1) {
      out.push(make('same_pid_different_address', 'warn', propertyId, countyFips, anchor.normalizedValue,
        { addresses: [...addresses.keys()].sort() }, ordered.map((o) => o.observationId)));
    }

    // H: two authoritative rows for one canonical PID inside one source.
    const authoritative = ordered.filter((o) => input.authority.isAuthoritativeForParcelIdentity(o.evidence.sourceId));
    const bySourceRecord = new Set(authoritative.map((o) => `${o.evidence.sourceId} ${o.evidence.sourceRecordId}`));
    if (bySourceRecord.size > 1) {
      out.push(make('duplicate_authoritative_row', 'blocking', propertyId, countyFips, anchor.normalizedValue,
        { sourceRecordIds: [...bySourceRecord].sort() }, authoritative.map((o) => o.observationId)));
    }

    // D: a preliminary PID that the authoritative source does not contain.
    // Informational: the parcel may simply not be in the slice we hold.
    if (authoritative.length === 0 && ordered.some((o) => o.resolutionState === 'provisional')) {
      out.push(make('pid_absent_from_authoritative_source', 'info', propertyId, countyFips, anchor.normalizedValue,
        { contributingSources: [...new Set(ordered.map((o) => o.evidence.sourceId))].sort() },
        ordered.map((o) => o.observationId)));
    }
  }

  // B: one address, several distinct PIDs. Reported, never merged — merging on
  // an address is how two units in one building become one property.
  //
  // Built in a single pass. An earlier version re-scanned every parcel for each
  // conflicting address, which is O(n^2): at 5,000 rows it cost 14 ms and at
  // 50,000 it cost 206 seconds. Shared addresses are common in a real county
  // (stacked condominium parcels), so the pathological case was the normal one.
  const byAddress = new Map<string, { properties: Set<string>; observationIds: string[]; countyFips: string }>();
  for (const o of parcels) {
    const address = input.addressByObservation.get(o.observationId);
    if (!address) continue;
    const bucket = byAddress.get(address)
      ?? { properties: new Set<string>(), observationIds: [], countyFips: o.countyFips as string };
    bucket.properties.add(o.propertyId as string);
    bucket.observationIds.push(o.observationId);
    byAddress.set(address, bucket);
  }
  for (const [address, bucket] of byAddress) {
    if (bucket.properties.size <= 1) continue;
    out.push(make('address_matches_different_pid', 'info', null, bucket.countyFips, null,
      { address, propertyIds: [...bucket.properties].sort() }, bucket.observationIds));
  }

  return out.sort((a, b) => a.conflictId.localeCompare(b.conflictId));
}
