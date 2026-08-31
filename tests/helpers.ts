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
import { createHennepinAssessorConnector } from '../src/connectors/mn-hennepin-assessor/index.ts';
import { defaultRegistry } from '../src/registry/sources.ts';
import { createMemoryFabricStore, type FabricStore } from '../src/runtime/fabric-store.ts';
import { runConnector, type RunOptions, type RunResult } from '../src/runtime/run.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(REPO, 'fixtures', 'mn-ecrv');
export const SYNTHETIC = join(FIXTURES, 'synthetic');

export const MAPPING_ID = 'mn_ecrv__all_mn_counties';
export const HENNEPIN_MAPPING_ID = 'hennepin_assessor__hennepin';
export const HENNEPIN_FIXTURES = join(REPO, 'fixtures', 'hennepin');
export const RUN_INSTANT = '2026-08-31T12:00:00.000Z';

export function fixture(name: string): string {
  return join(SYNTHETIC, name);
}

export function hennepinFixture(name: string): string {
  return join(HENNEPIN_FIXTURES, name);
}

export function fixtureXml(name: string): string {
  return readFileSync(fixture(name), 'utf8');
}

export function tempRoot(prefix = 'df-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
