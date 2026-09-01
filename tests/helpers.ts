import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore, type ArtifactStore } from '../src/archive/artifact-store.ts';
import { createFilesystemObjectStore, type ObjectStore } from '../src/archive/object-store.ts';
import { createContactPlane, type ContactPlane } from '../src/contact/contact-plane.ts';
import { fixedClock } from '../src/core/clock.ts';
import { captureLogger } from '../src/core/logging.ts';
import { createMnEcrvConnector, type EcrvConnectorOptions } from '../src/connectors/mn-ecrv/index.ts';
import {
  createHennepinAssessorConnector,
  createStreamingHennepinConnector,
} from '../src/connectors/mn-hennepin-assessor/index.ts';
import { createStreamingArtifactStore, type StreamingArtifactStore } from '../src/archive/artifact-store.ts';
import { createHennepinRecorderConnector } from '../src/connectors/mn-hennepin-recorder/index.ts';
import { createMnSosBusinessConnector } from '../src/connectors/mn-sos-business/index.ts';
import { createStreamingFilesystemObjectStore } from '../src/archive/object-store.ts';
import { runStreamingConnector, type StreamRunOptions, type StreamRunResult } from '../src/runtime/stream-run.ts';
import { createGenerationStore, type GenerationStore } from '../src/runtime/staged-store.ts';
import { createPartitionStore, type PartitionStore, type PartitionTable } from '../src/runtime/partition-store.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { createMemoryFabricStore, type FabricStore } from '../src/runtime/fabric-store.ts';
import { runConnector, type RunOptions, type RunResult } from '../src/runtime/run.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(REPO, 'fixtures', 'mn-ecrv');
export const SYNTHETIC = join(FIXTURES, 'synthetic');

export const MAPPING_ID = 'mn_ecrv__all_mn_counties';
export const HENNEPIN_MAPPING_ID = 'hennepin_assessor__hennepin';
export const HENNEPIN_FIXTURES = join(REPO, 'fixtures', 'hennepin');
export const RECORDER_MAPPING_ID = 'hennepin_recorder__hennepin';
export const RECORDER_FIXTURES = join(REPO, 'fixtures', 'hennepin-recorder');
export const SOS_MAPPING_ID = 'mn_sos__statewide';
export const SOS_FIXTURES = join(REPO, 'fixtures', 'mn-sos');
/** The eCRV filing that names the same Hennepin parcel as the other two sources. */
export const ECRV_CONVERGENCE_FIXTURE = join(SYNTHETIC, '07-hennepin-convergence-preliminary-pid.xml');
export const RUN_INSTANT = '2026-08-31T12:00:00.000Z';

export function fixture(name: string): string {
  return join(SYNTHETIC, name);
}

export function hennepinFixture(name: string): string {
  return join(HENNEPIN_FIXTURES, name);
}

export function sosFixture(name: string): string {
  return join(SOS_FIXTURES, name);
}

export function recorderFixture(name: string): string {
  return join(RECORDER_FIXTURES, name);
}

export function fixtureXml(name: string): string {
  return readFileSync(fixture(name), 'utf8');
}

export function tempRoot(prefix = 'df-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A complete streaming estate: archive, generation store and var root. */
export type StreamHarness = {
  readonly root: string;
  readonly varRoot: string;
  readonly artifactStore: StreamingArtifactStore;
  readonly contactPlane: ContactPlane;
  readonly store: GenerationStore;
  run(file: string, overrides?: Partial<StreamRunOptions> & { period?: string }): Promise<StreamRunResult>;
  /** Runs the Hennepin recorder connector over a local index delivery. */
  runRecorder(file: string, overrides?: Partial<StreamRunOptions> & { period?: string }): Promise<StreamRunResult>;
  /** Runs the Minnesota SOS connector over a licensed delivery bundle. */
  runSos(file: string, overrides?: Partial<StreamRunOptions> & { period?: string; chunkLines?: number }): Promise<StreamRunResult>;
  /** Every canonical bundle currently activated, across all runs. */
  bundles(): Promise<unknown[]>;
  /** Rows from any staged table, across all runs. */
  table(name: string): Promise<unknown[]>;
  rows(table: 'bundles' | 'events' | 'absences' | 'contacts'): Promise<unknown[]>;
  resolutions(): Promise<unknown[]>;
  partitionConflicts(): Promise<unknown[]>;
  entityLinks(): Promise<unknown[]>;
  readonly partitions: PartitionStore;
};

/** Every row of one partition table, across every partition in the estate. */
export async function partitionRows(varRoot: string, table: PartitionTable): Promise<unknown[]> {
  const store = createPartitionStore(varRoot);
  const out: unknown[] = [];
  for (const key of await store.listPartitions()) {
    for await (const line of store.readTable(key, table)) out.push(JSON.parse(line));
  }
  return out;
}

export function streamHarness(options: { root?: string; contactPlane?: ContactPlane } = {}): StreamHarness {
  const root = options.root ?? tempRoot('df-stream-');
  const varRoot = join(root, 'var');
  const artifactStore = createStreamingArtifactStore(createStreamingFilesystemObjectStore(join(root, 'archive')));
  const contactPlane = options.contactPlane ?? createContactPlane();
  const store = createGenerationStore(varRoot);

  const readAll = async (table: 'bundles' | 'events' | 'absences' | 'contacts'): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const line of store.readTable(table)) out.push(JSON.parse(line));
    return out;
  };

  return {
    root,
    varRoot,
    artifactStore,
    contactPlane,
    store,
    async run(file, overrides = {}) {
      const period = overrides.period ?? '2026-08';
      const { period: _ignored, ...rest } = overrides;
      return runStreamingConnector({
        registry: defaultRegistry(),
        connector: createStreamingHennepinConnector(),
        mappingId: HENNEPIN_MAPPING_ID,
        artifactStore,
        contactPlane,
        varRoot,
        clock: fixedClock(RUN_INSTANT),
        logger: captureLogger().logger,
        referencePeriod: period,
        localFile: file,
        ...rest,
      });
    },
    async runRecorder(file, overrides = {}) {
      const period = overrides.period ?? '2024-2025';
      const { period: _ignored, ...rest } = overrides;
      return runStreamingConnector({
        registry: defaultRegistry(),
        connector: createHennepinRecorderConnector({ localFile: file, referencePeriod: period }),
        mappingId: RECORDER_MAPPING_ID,
        artifactStore,
        contactPlane,
        varRoot,
        clock: fixedClock(RUN_INSTANT),
        logger: captureLogger().logger,
        referencePeriod: period,
        localFile: file,
        ...rest,
      });
    },
    async runSos(file, overrides = {}) {
      const period = overrides.period ?? '2026-08';
      const { period: _ignored, chunkLines, ...rest } = overrides;
      return runStreamingConnector({
        registry: defaultRegistry(),
        connector: createMnSosBusinessConnector({
          localFile: file,
          referencePeriod: period,
          // Deliberately tiny in tests: a chunk size that forces many spill
          // files is the point, because the output must not depend on it.
          sort: { chunkLines: chunkLines ?? 4, scratchDir: join(varRoot, 'scratch') },
        }),
        mappingId: SOS_MAPPING_ID,
        artifactStore,
        contactPlane,
        varRoot,
        clock: fixedClock(RUN_INSTANT),
        logger: captureLogger().logger,
        referencePeriod: period,
        localFile: file,
        ...rest,
      });
    },
    async table(name) {
      const out: unknown[] = [];
      for await (const line of store.readTable(name as 'bundles')) out.push(JSON.parse(line));
      return out;
    },
    bundles: () => readAll('bundles'),
    rows: readAll,
    // Resolutions now live one partition per county, so the estate-wide view is
    // a union across partitions rather than a single file. That IS the change:
    // no run writes an estate-wide file any more.
    async resolutions() {
      return partitionRows(varRoot, 'resolutions');
    },
    async partitionConflicts() {
      return partitionRows(varRoot, 'conflicts');
    },
    async entityLinks() {
      return partitionRows(varRoot, 'entity_links');
    },
    partitions: createPartitionStore(varRoot),
  };
}

export type Harness = {
  readonly objectStore: ObjectStore;
  readonly artifactStore: ArtifactStore;
  readonly fabricStore: FabricStore;
  readonly contactPlane: ContactPlane;
  readonly root: string;
  run(files: readonly string[], overrides?: Partial<RunOptions> & { period?: string }): Promise<RunResult>;
  /** Runs the Hennepin snapshot connector over a local snapshot bundle. */
  runHennepin(file: string, overrides?: Partial<RunOptions> & { period?: string }): Promise<RunResult>;
};

/** A complete, isolated Data Fabric estate on a temp directory. */
export function harness(options: { root?: string; fabricStore?: FabricStore; contactPlane?: ContactPlane } = {}): Harness {
  const root = options.root ?? tempRoot();
  const objectStore = createFilesystemObjectStore(root);
  const artifactStore = createArtifactStore(objectStore);
  const fabricStore = options.fabricStore ?? createMemoryFabricStore();
  const contactPlane = options.contactPlane ?? createContactPlane();

  return {
    objectStore,
    artifactStore,
    fabricStore,
    contactPlane,
    root,
    async run(files, overrides = {}) {
      const period = overrides.period ?? '2026-W31';
      const connectorOptions: EcrvConnectorOptions = {
        localReleases: files.map((f) => ({ path: f, referencePeriod: period })),
      };
      const { period: _ignored, ...runOverrides } = overrides;
      return runConnector({
        registry: defaultRegistry(),
        connector: createMnEcrvConnector(connectorOptions),
        mappingId: MAPPING_ID,
        artifactStore,
        fabricStore,
        contactPlane,
        clock: fixedClock(RUN_INSTANT),
        logger: captureLogger().logger,
        ...runOverrides,
      });
    },

    async runHennepin(file, overrides = {}) {
      const period = overrides.period ?? '2026-08';
      const { period: _ignored, ...runOverrides } = overrides;
      return runConnector({
        registry: defaultRegistry(),
        connector: createHennepinAssessorConnector({ localReleases: [{ path: file, referencePeriod: period }] }),
        mappingId: HENNEPIN_MAPPING_ID,
        artifactStore,
        fabricStore,
        contactPlane,
        clock: fixedClock(RUN_INSTANT),
        logger: captureLogger().logger,
        ...runOverrides,
      });
    },
  };
}

/** Minimal valid eCRV document, editable through a replacement list. */
export function mutate(xml: string, replacements: readonly (readonly [string, string])[]): string {
  let out = xml;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`mutate: "${from}" not found in fixture`);
    out = out.replace(from, to);
  }
  return out;
}
