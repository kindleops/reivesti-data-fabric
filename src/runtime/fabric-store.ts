/**
 * The derived plane: runs, releases, artifact records, source-record
 * observations, canonical bundles and emitted events.
 *
 * Two backends, one interface. The NDJSON backend writes one partition file per
 * (table, run) and replaces it atomically, so re-running a run rewrites exactly
 * that run's rows and nothing else — the property that makes re-ingestion safe
 * to repeat. The memory backend is what tests use.
 *
 * Restricted contact rows are written under a separate `restricted/` root rather
 * than alongside canonical output. Filesystem separation is not a security
 * control on its own, but it makes the boundary visible in every listing and
 * gives deployment a single directory to lock down.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CanonicalBundle, CanonicalEvent } from '../canonical/models.ts';
import type { SourceRecordObservation } from '../canonical/revision.ts';
import type { SnapshotAbsence, SourceSnapshot } from '../canonical/snapshot.ts';
import type { PropertyConflict, PropertyResolution } from '../canonical/property-resolution.ts';
import type { ContactObservation } from '../contact/contact-plane.ts';
import { canonicalJson } from '../core/hash.ts';
import type { ArchivedArtifact } from '../archive/artifact-store.ts';
import type { SourceRelease, SourceRun } from './connector.ts';

export type FabricStore = {
  putRun(run: SourceRun): Promise<void>;
  putRelease(release: SourceRelease): Promise<void>;
  putArtifact(runId: string, artifact: ArchivedArtifact): Promise<void>;
  putSourceObservations(runId: string, rows: readonly SourceRecordObservation[]): Promise<void>;
  putBundles(runId: string, bundles: readonly CanonicalBundle[]): Promise<void>;
  putEvents(runId: string, events: readonly CanonicalEvent[]): Promise<void>;
  putContacts(runId: string, rows: readonly ContactObservation[]): Promise<void>;
  putSnapshot(snapshot: SourceSnapshot): Promise<void>;
  putAbsences(runId: string, rows: readonly SnapshotAbsence[]): Promise<void>;
  putResolutions(rows: readonly PropertyResolution[]): Promise<void>;
  putConflicts(runId: string, rows: readonly PropertyConflict[]): Promise<void>;

  runs(): Promise<readonly SourceRun[]>;
  run(runId: string): Promise<SourceRun | undefined>;
  bundles(runId?: string): Promise<readonly CanonicalBundle[]>;
  events(runId?: string): Promise<readonly CanonicalEvent[]>;
  /** Every retained source-record observation: the revision ledger's durable seed. */
  sourceObservations(): Promise<readonly SourceRecordObservation[]>;
  contacts(runId?: string): Promise<readonly ContactObservation[]>;
  snapshots(sourceId?: string): Promise<readonly SourceSnapshot[]>;
  absences(runId?: string): Promise<readonly SnapshotAbsence[]>;
  resolutions(): Promise<readonly PropertyResolution[]>;
  conflicts(runId?: string): Promise<readonly PropertyConflict[]>;
};

type Tables = {
  runs: SourceRun[];
  releases: SourceRelease[];
  artifacts: (ArchivedArtifact & { runId: string })[];
  source_observations: SourceRecordObservation[];
  bundles: (CanonicalBundle & { __runId: string })[];
  events: (CanonicalEvent & { __runId: string })[];
  contacts: (ContactObservation & { __runId: string })[];
  snapshots: SourceSnapshot[];
  absences: (SnapshotAbsence & { __runId: string })[];
  resolutions: PropertyResolution[];
  conflicts: (PropertyConflict & { __runId: string })[];
};

// ---------------------------------------------------------------------------

export function createMemoryFabricStore(): FabricStore {
  const t: Tables = {
    runs: [], releases: [], artifacts: [], source_observations: [], bundles: [], events: [], contacts: [],
    snapshots: [], absences: [], resolutions: [], conflicts: [],
  };
  const replaceRun = <T extends { runId?: string; __runId?: string }>(rows: T[], runId: string, next: T[]): T[] => [
    ...rows.filter((r) => (r.runId ?? r.__runId) !== runId),
    ...next,
  ];

  return {
    async putRun(run) {
      t.runs = [...t.runs.filter((r) => r.runId !== run.runId), run];
    },
    async putRelease(release) {
      t.releases = [...t.releases.filter((r) => r.releaseId !== release.releaseId), release];
    },
    async putArtifact(runId, artifact) {
      t.artifacts = replaceRun(t.artifacts, runId, [{ ...artifact, runId }]);
    },
    async putSourceObservations(_runId, rows) {
      // Observations are append-only across runs: a prior sighting is history,
      // not something a later run may replace.
      const known = new Set(t.source_observations.map((o) => o.observationId));
      for (const r of rows) if (!known.has(r.observationId)) t.source_observations.push(r);
    },
    async putBundles(runId, bundles) {
      t.bundles = replaceRun(t.bundles, runId, bundles.map((b) => ({ ...b, __runId: runId })));
    },
    async putEvents(runId, events) {
      t.events = replaceRun(t.events, runId, events.map((e) => ({ ...e, __runId: runId })));
    },
    async putContacts(runId, rows) {
      t.contacts = replaceRun(t.contacts, runId, rows.map((c) => ({ ...c, __runId: runId })));
    },
    async putSnapshot(snapshot) {
      t.snapshots = [...t.snapshots.filter((s2) => s2.snapshotId !== snapshot.snapshotId), snapshot];
    },
    async putAbsences(runId, rows) {
      t.absences = replaceRun(t.absences, runId, rows.map((r) => ({ ...r, __runId: runId })));
    },
    async putResolutions(rows) {
      const incoming = new Set(rows.map((r) => r.propertyId));
      t.resolutions = [...t.resolutions.filter((r) => !incoming.has(r.propertyId)), ...rows];
    },
    async putConflicts(runId, rows) {
      t.conflicts = replaceRun(t.conflicts, runId, rows.map((r) => ({ ...r, __runId: runId })));
    },
    async snapshots(sourceId) {
      return t.snapshots
        .filter((s2) => sourceId === undefined || s2.sourceId === sourceId)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.snapshotId.localeCompare(b.snapshotId));
    },
    async absences(runId) {
      return t.absences.filter((a) => runId === undefined || a.__runId === runId).map(untag);
    },
    async resolutions() {
      return [...t.resolutions].sort((a, b) => a.propertyId.localeCompare(b.propertyId));
    },
    async conflicts(runId) {
      return t.conflicts.filter((c) => runId === undefined || c.__runId === runId).map(untag);
    },
    async runs() {
      return [...t.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
    },
    async run(runId) {
      return t.runs.find((r) => r.runId === runId);
    },
    async bundles(runId) {
      // `__runId` is a partition tag, not part of the row. Callers must see the
      // same bytes the NDJSON backend would give them.
      return t.bundles.filter((b) => runId === undefined || b.__runId === runId).map(untag);
    },
    async events(runId) {
      return t.events.filter((e) => runId === undefined || e.__runId === runId).map(untag);
    },
    async sourceObservations() {
      return [...t.source_observations];
    },
    async contacts(runId) {
      return t.contacts.filter((c) => runId === undefined || c.__runId === runId).map(untag);
    },
  };
}

/** Drops the memory backend's partition tag so rows match the NDJSON backend. */
function untag<T extends { __runId?: string }>(row: T): Omit<T, '__runId'> {
  const { __runId: _tag, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------

const RESTRICTED_TABLES: ReadonlySet<string> = new Set(['contacts']);

export function createNdjsonFabricStore(root: string): FabricStore {
  const pathFor = (table: string, partition: string): string =>
    join(root, RESTRICTED_TABLES.has(table) ? 'restricted' : 'derived', table, `${partition}.ndjson`);

  const write = async (table: string, partition: string, rows: readonly unknown[]): Promise<void> => {
    const path = pathFor(table, partition);
    await mkdir(dirname(path), { recursive: true });
    const body = rows.map((r) => canonicalJson(r)).join('\n');
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, rows.length > 0 ? `${body}\n` : '', { mode: RESTRICTED_TABLES.has(table) ? 0o600 : 0o644 });
    await rename(tmp, path); // atomic partition replace
  };

  const readTable = async <T>(table: string): Promise<T[]> => {
    const dir = dirname(pathFor(table, 'x'));
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort();
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const f of files) {
      const text = await readFile(join(dir, f), 'utf8');
      for (const line of text.split('\n')) if (line) out.push(JSON.parse(line) as T);
    }
    return out;
  };

  return {
    putRun: (run) => write('runs', run.runId, [run]),
    putRelease: (release) => write('releases', release.releaseId, [release]),
    putArtifact: (runId, artifact) => write('artifacts', runId, [{ ...artifact, runId }]),
    async putSourceObservations(runId, rows) {
      await write('source_observations', runId, rows);
    },
    putBundles: (runId, bundles) => write('bundles', runId, bundles),
    putEvents: (runId, events) => write('events', runId, events),
    putContacts: (runId, rows) => write('contacts', runId, rows),
    putSnapshot: (snapshot) => write('snapshots', snapshot.snapshotId, [snapshot]),
    putAbsences: (runId, rows) => write('absences', runId, rows),
    putResolutions: (rows) => write('resolutions', 'current', rows),
    putConflicts: (runId, rows) => write('conflicts', runId, rows),

    async runs() {
      const rows = await readTable<SourceRun>('runs');
      return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
    },
    async run(runId) {
      return (await readTable<SourceRun>('runs')).find((r) => r.runId === runId);
    },
    async bundles(runId) {
      if (runId === undefined) return readTable<CanonicalBundle>('bundles');
      const text = await readFile(pathFor('bundles', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CanonicalBundle);
    },
    async events(runId) {
      if (runId === undefined) return readTable<CanonicalEvent>('events');
      const text = await readFile(pathFor('events', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CanonicalEvent);
    },
    sourceObservations: () => readTable<SourceRecordObservation>('source_observations'),
    async snapshots(sourceId) {
      const rows = await readTable<SourceSnapshot>('snapshots');
      return rows
        .filter((s2) => sourceId === undefined || s2.sourceId === sourceId)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.snapshotId.localeCompare(b.snapshotId));
    },
    async absences(runId) {
      if (runId === undefined) return readTable<SnapshotAbsence>('absences');
      const text = await readFile(pathFor('absences', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as SnapshotAbsence);
    },
    resolutions: () => readTable<PropertyResolution>('resolutions'),
    async conflicts(runId) {
      if (runId === undefined) return readTable<PropertyConflict>('conflicts');
      const text = await readFile(pathFor('conflicts', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as PropertyConflict);
    },
    async contacts(runId) {
      if (runId === undefined) return readTable<ContactObservation>('contacts');
      const text = await readFile(pathFor('contacts', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ContactObservation);
    },
  };
}
