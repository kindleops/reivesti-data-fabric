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

  runs(): Promise<readonly SourceRun[]>;
  run(runId: string): Promise<SourceRun | undefined>;
  bundles(runId?: string): Promise<readonly CanonicalBundle[]>;
  events(runId?: string): Promise<readonly CanonicalEvent[]>;
  /** Every retained source-record observation: the revision ledger's durable seed. */
  sourceObservations(): Promise<readonly SourceRecordObservation[]>;
  contacts(runId?: string): Promise<readonly ContactObservation[]>;
};

type Tables = {
  runs: SourceRun[];
  releases: SourceRelease[];
  artifacts: (ArchivedArtifact & { runId: string })[];
  source_observations: SourceRecordObservation[];
  bundles: (CanonicalBundle & { __runId: string })[];
  events: (CanonicalEvent & { __runId: string })[];
  contacts: (ContactObservation & { __runId: string })[];
};

// ---------------------------------------------------------------------------

export function createMemoryFabricStore(): FabricStore {
  const t: Tables = { runs: [], releases: [], artifacts: [], source_observations: [], bundles: [], events: [], contacts: [] };
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
    async runs() {
      return [...t.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
    },
    async run(runId) {
      return t.runs.find((r) => r.runId === runId);
    },
    async bundles(runId) {
      return t.bundles.filter((b) => runId === undefined || b.__runId === runId);
    },
    async events(runId) {
      return t.events.filter((e) => runId === undefined || e.__runId === runId);
    },
    async sourceObservations() {
      return [...t.source_observations];
    },
    async contacts(runId) {
      return t.contacts.filter((c) => runId === undefined || c.__runId === runId);
    },
  };
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
    async contacts(runId) {
      if (runId === undefined) return readTable<ContactObservation>('contacts');
      const text = await readFile(pathFor('contacts', runId), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ContactObservation);
    },
  };
}
