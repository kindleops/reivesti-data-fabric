#!/usr/bin/env node
/**
 * `df` — the Data Fabric operator CLI.
 *
 * Headless by design: this and the structured run log are the whole operator
 * surface in DF-0B. No admin UI is built in this phase.
 *
 *   df sources                        list registered sources and coverage
 *   df jurisdictions [--state MN]     list catalogued jurisdictions
 *   df fields                         eCRV field inventory and dispositions
 *   df run <mappingId> --file <path> --period <label> [--dry-run]
 *   df replay <mappingId> --artifact <sha256> [--period <label>]
 *   df verify --artifact <sha256>     re-verify retained evidence against its manifest
 *   df runs                           run history
 */
import { createArtifactStore, artifactDir, type ArchivedArtifact } from '../archive/artifact-store.ts';
import { createFilesystemObjectStore } from '../archive/object-store.ts';
import { createContactPlane } from '../contact/contact-plane.ts';
import { systemClock } from '../core/clock.ts';
import { FabricError } from '../core/errors.ts';
import { createLogger } from '../core/logging.ts';
import { createMnEcrvConnector } from '../connectors/mn-ecrv/index.ts';
import { ECRV_COUNTY_ONLY_FIELDS, ECRV_FIELD_MAP, dispositionCounts } from '../connectors/mn-ecrv/field-map.ts';
import { defaultRegistry } from '../registry/sources.ts';
import type { Connector } from '../runtime/connector.ts';
import { createNdjsonFabricStore } from '../runtime/fabric-store.ts';
import { runConnector, runReport } from '../runtime/run.ts';

const VAR_ROOT = process.env['DF_VAR'] ?? 'var';
const ARCHIVE_ROOT_DIR = process.env['DF_ARCHIVE'] ?? `${VAR_ROOT}/archive`;

type Args = { readonly command: string; readonly positional: readonly string[]; readonly flags: Readonly<Record<string, string | boolean>> };

function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(token);
  }
  return { command, positional, flags };
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Adapters the CLI can run. A mapping naming anything else cannot be run. */
const ADAPTERS: Readonly<Record<string, (file: string, period: string) => Connector>> = {
  mn_ecrv: (file, period) => createMnEcrvConnector({ localReleases: [{ path: file, referencePeriod: period }] }),
};

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const registry = defaultRegistry();

  switch (command) {
    case 'sources': {
      out(registry.sources.map((s) => ({
        sourceId: s.sourceId,
        authority: s.sourceAuthority,
        program: s.sourceProgram,
        family: s.sourceFamily,
        accessType: s.accessType,
        automationStatus: s.automationStatus,
        licenseStatus: s.licenseStatus,
        carriesRestrictedContact: s.carriesRestrictedContact,
        active: s.active,
        coverage: registry.mappingsForSource(s.sourceId).map((m) => ({
          mappingId: m.mappingId,
          adapterKey: m.adapterKey,
          status: m.status,
          capabilities: m.capabilities,
          jurisdictions: registry.expand(m).length,
        })),
      })));
      return 0;
    }

    case 'jurisdictions': {
      const state = typeof flags['state'] === 'string' ? (flags['state'] as string).toUpperCase() : null;
      out(registry.jurisdictions
        .filter((j) => state === null || j.stateCode === state)
        .map((j) => ({ id: j.jurisdictionId, type: j.jurisdictionType, name: j.name, countyFips: j.countyFips ?? null })));
      return 0;
    }

    case 'fields': {
      out({
        schema: 'sales_extract_schema_3',
        leafElements: ECRV_FIELD_MAP.length,
        dispositions: dispositionCounts(),
        fields: ECRV_FIELD_MAP,
        countyAddedNotInExtract: ECRV_COUNTY_ONLY_FIELDS,
      });
      return 0;
    }

    case 'run':
    case 'replay': {
      const mappingId = positional[0];
      if (!mappingId) {
        process.stderr.write('usage: df run <mappingId> --file <path> --period <label>\n');
        return 2;
      }
      const mapping = registry.mapping(mappingId);
      const build = ADAPTERS[mapping.adapterKey];
      if (!build) {
        process.stderr.write(`mapping "${mappingId}" needs adapter "${mapping.adapterKey}", which is not implemented\n`);
        return 2;
      }

      const period = typeof flags['period'] === 'string' ? (flags['period'] as string) : 'unspecified';
      const file = typeof flags['file'] === 'string' ? (flags['file'] as string) : '';
      const artifactStore = createArtifactStore(createFilesystemObjectStore(ARCHIVE_ROOT_DIR));
      const fabricStore = createNdjsonFabricStore(VAR_ROOT);
      const contactPlane = createContactPlane();
      const logger = createLogger();
      const connector = build(file, period);

      let replay: ArchivedArtifact | undefined;
      if (command === 'replay') {
        const sha = typeof flags['artifact'] === 'string' ? (flags['artifact'] as string) : '';
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          process.stderr.write('replay requires --artifact <sha256>\n');
          return 2;
        }
        replay = await locateArtifact(artifactStore, mapping.sourceId, period, sha);
      } else if (!file) {
        process.stderr.write('run requires --file <path>\n');
        return 2;
      }

      const result = await runConnector({
        registry,
        connector,
        mappingId,
        artifactStore,
        fabricStore,
        contactPlane,
        clock: systemClock,
        logger,
        dryRun: flags['dry-run'] === true,
        ...(replay ? { replayArtifact: replay } : {}),
      });
      out({
        report: runReport(result.run),
        changeCounts: result.changeCounts,
        // Counts only. Contact values never leave the restricted plane.
        restrictedContactObservations: result.contacts.length,
      });
      return result.run.status === 'completed' ? 0 : 1;
    }

    case 'verify': {
      const sha = typeof flags['artifact'] === 'string' ? (flags['artifact'] as string) : '';
      const sourceId = typeof flags['source'] === 'string' ? (flags['source'] as string) : registry.sources[0]?.sourceId ?? '';
      const period = typeof flags['period'] === 'string' ? (flags['period'] as string) : 'unspecified';
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        process.stderr.write('verify requires --artifact <sha256>\n');
        return 2;
      }
      const artifactStore = createArtifactStore(createFilesystemObjectStore(ARCHIVE_ROOT_DIR));
      const artifact = await locateArtifact(artifactStore, sourceId, period, sha);
      // read() re-hashes the bytes and refuses to return them on a mismatch.
      const bytes = await artifactStore.read(artifact);
      out({ verified: true, sha256: sha, byteLength: bytes.byteLength, view: await artifactStore.view(artifact) });
      return 0;
    }

    case 'runs': {
      const fabricStore = createNdjsonFabricStore(VAR_ROOT);
      out((await fabricStore.runs()).map(runReport));
      return 0;
    }

    default: {
      process.stdout.write(
        [
          'df — Reivesti Data Fabric',
          '',
          '  df sources                                        registered sources and coverage',
          '  df jurisdictions [--state MN]                     catalogued jurisdictions',
          '  df fields                                         eCRV field inventory and dispositions',
          '  df run <mappingId> --file <p> --period <label>    ingest a local extract',
          '  df replay <mappingId> --artifact <sha256> --period <label>',
          '  df verify --artifact <sha256> [--source <id>] [--period <label>]',
          '  df runs                                           run history',
          '',
          `  DF_VAR=${VAR_ROOT}  DF_ARCHIVE=${ARCHIVE_ROOT_DIR}`,
          '',
        ].join('\n'),
      );
      return command === 'help' ? 0 : 2;
    }
  }
}

async function locateArtifact(
  artifactStore: ReturnType<typeof createArtifactStore>,
  sourceId: string,
  referencePeriod: string,
  sha256: string,
): Promise<ArchivedArtifact> {
  const dir = artifactDir(sourceId, referencePeriod, sha256);
  const manifestPath = `${dir}/manifest.json`;
  const manifest = await artifactStore.readManifest({ manifestPath });
  const extension = manifest.originalFilename.includes('.')
    ? manifest.originalFilename.slice(manifest.originalFilename.lastIndexOf('.')).toLowerCase()
    : '';
  return {
    artifactId: `artifact_${sha256}`,
    sha256,
    byteLength: manifest.byteLength,
    storagePath: `${dir}/source-original${extension}`,
    manifestPath,
    created: false,
    manifest,
  };
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const fabric = error instanceof FabricError ? error : null;
    process.stderr.write(`${JSON.stringify({
      error: fabric?.kind ?? 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
      detail: fabric?.detail,
    })}\n`);
    process.exitCode = 1;
  });
