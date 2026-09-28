/**
 * Snapshot source semantics.
 *
 * eCRV is an append-only feed of filings. A county assessor roll is the opposite
 * shape: a periodic photograph of a state of the world. Three consequences, and
 * this module exists for exactly those:
 *
 *  1. A row's ABSENCE from the latest snapshot is a fact about the snapshot, not
 *     about the world. "Not in the September file" is not "demolished", and it
 *     is certainly not "delete the property". Absence is recorded as its own
 *     observation, and the prior observations stay exactly where they are.
 *
 *  2. A row that comes back after being absent is a REAPPEARANCE, which usually
 *     means the earlier absence was a source artefact — a parcel mid-split, a
 *     partial export — rather than a real-world event.
 *
 *  3. "Changed" is only useful if you can say *what* changed. Rows are digested
 *     per field group, so a run can report that 12,000 parcels changed only
 *     their assessment and 40 changed their owner.
 *
 * The new/unchanged/changed classification itself is NOT reimplemented here: the
 * existing revision ledger already does it, and a parallel mechanism would be a
 * second source of truth. This module adds only what a snapshot needs that a
 * feed does not.
 */
import { deterministicId } from '../core/hash.ts';

export type SnapshotChangeKind =
  | 'new_parcel_observed'
  | 'unchanged_parcel'
  | 'parcel_attributes_changed'
  | 'parcel_missing_from_latest_source'
  | 'parcel_reappeared';

/** How the runtime's generic change kinds map onto snapshot vocabulary. */
export const SNAPSHOT_CHANGE_KIND: Readonly<Record<'new' | 'unchanged' | 'revised' | 'reappeared', SnapshotChangeKind>> = {
  new: 'new_parcel_observed',
  unchanged: 'unchanged_parcel',
  revised: 'parcel_attributes_changed',
  // Absent from the previous accepted snapshot, present in an earlier one.
  reappeared: 'parcel_reappeared',
};

export type SnapshotCompleteness = 'complete' | 'partial' | 'unverifiable';

/**
 * One snapshot of one source, with the reconciliation evidence that says whether
 * we actually got all of it. Without `sourceReportedCount`, "we ingested the
 * whole county" is an assertion; with it, it is a measurement.
 */
export type SourceSnapshot = {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly releaseId: string | null;
  readonly artifactId: string | null;
  readonly runId: string | null;
  readonly referencePeriod: string;
  readonly capturedAt: string;
  readonly sourceReportedCount: number | null;
  readonly retrievedCount: number;
  readonly parsedCount: number;
  readonly acceptedCount: number;
  readonly quarantinedCount: number;
  readonly duplicateCount: number;
  readonly completeness: SnapshotCompleteness;
  readonly sourceSchemaDigest: string | null;
};

export function snapshotId(sourceId: string, referencePeriod: string): string {
  return deterministicId('snap', sourceId, referencePeriod);
}

export function reconcile(
  sourceReportedCount: number | null,
  retrievedCount: number,
): SnapshotCompleteness {
  if (sourceReportedCount === null) return 'unverifiable';
  return sourceReportedCount === retrievedCount ? 'complete' : 'partial';
}

/**
 * One parcel row as seen in one snapshot. Append-only across snapshots: a later
 * snapshot inserts new rows and never edits these.
 */
export type ParcelSnapshotObservation = {
  readonly observationId: string;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly countyFips: string;
  readonly normalizedParcel: string;
  readonly propertyId: string | null;
  readonly changeKind: SnapshotChangeKind;
  readonly contentDigest: string;
  readonly changedFieldGroups: readonly string[];
  readonly sourceStatusCode: string | null;
  readonly runId: string;
  readonly observedAt: string;
};

export function parcelObservationId(snapshotIdValue: string, sourceRecordId: string): string {
  return deterministicId('parcelobs', snapshotIdValue, sourceRecordId);
}

// ---------------------------------------------------------------------------
// Absence
// ---------------------------------------------------------------------------

export type SnapshotAbsence = {
  readonly observationId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly snapshotId: string;
  readonly runId: string;
  readonly observedAt: string;
  readonly lastSeenSnapshotId: string;
  readonly changeKind: 'parcel_missing_from_latest_source';
};

export type AbsenceInput = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly runId: string;
  readonly observedAt: string;
  /** Keys seen in any prior snapshot of this source, with the last one that saw them. */
  readonly previouslySeen: ReadonlyMap<string, string>;
  /** Keys present in the snapshot being processed now. */
  readonly presentNow: ReadonlySet<string>;
};

/**
 * Keys that earlier snapshots contained and this one does not.
 *
 * Deliberately not called "deleted". Nothing downstream may read this as a
 * statement that the parcel ceased to exist; a partial export produces exactly
 * the same signal as a genuine retirement, and only later snapshots can tell
 * them apart.
 */
export function detectAbsences(input: AbsenceInput): readonly SnapshotAbsence[] {
  const out: SnapshotAbsence[] = [];
  for (const [sourceRecordId, lastSeenSnapshotId] of input.previouslySeen) {
    if (input.presentNow.has(sourceRecordId)) continue;
    out.push({
      observationId: deterministicId('absence', input.snapshotId, sourceRecordId),
      sourceId: input.sourceId,
      sourceRecordId,
      snapshotId: input.snapshotId,
      runId: input.runId,
      observedAt: input.observedAt,
      lastSeenSnapshotId,
      changeKind: 'parcel_missing_from_latest_source',
    });
  }
  return out.sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));
}

/** True when a key is present now and its most recent prior signal was absence. */
export function isReappearance(
  sourceRecordId: string,
  absencesByKey: ReadonlyMap<string, SnapshotAbsence>,
): boolean {
  return absencesByKey.has(sourceRecordId);
}

// ---------------------------------------------------------------------------
// Field grouping
// ---------------------------------------------------------------------------

/**
 * Digests a record per named group so a diff can say which *kind* of thing
 * changed. Reporting "40 owner changes" is actionable; "40 rows changed" is not.
 */
export function fieldGroupDigests(
  groups: Readonly<Record<string, unknown>>,
  digest: (value: unknown) => string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(groups).sort()) out[key] = digest(groups[key]);
  return out;
}

export function changedGroups(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>>,
): readonly string[] {
  if (!before) return [];
  return Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .sort();
}
