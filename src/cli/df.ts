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
import { createArtifactStore, createStreamingArtifactStore, artifactDir, type ArchivedArtifact } from '../archive/artifact-store.ts';
import { createFilesystemObjectStore, createStreamingFilesystemObjectStore } from '../archive/object-store.ts';
import { createContactPlane } from '../contact/contact-plane.ts';
import { systemClock } from '../core/clock.ts';
import { FabricError } from '../core/errors.ts';
import { createLogger } from '../core/logging.ts';
import { createMnEcrvConnector } from '../connectors/mn-ecrv/index.ts';
import {
  createHennepinAssessorConnector,
  createStreamingHennepinConnector,
} from '../connectors/mn-hennepin-assessor/index.ts';
import {
  HENNEPIN_ABSENT_FIELDS,
  HENNEPIN_FIELD_MAP,
  hennepinDispositionCounts,
} from '../connectors/mn-hennepin-assessor/field-map.ts';
import { ECRV_COUNTY_ONLY_FIELDS, ECRV_FIELD_MAP, dispositionCounts } from '../connectors/mn-ecrv/field-map.ts';
import { createHennepinRecorderConnector } from '../connectors/mn-hennepin-recorder/index.ts';
import { createMnSosBusinessConnector } from '../connectors/mn-sos-business/index.ts';
import { defaultRegistry } from '../registry/sources.ts';
import type { Connector, StreamingConnector } from '../runtime/connector.ts';
import { createNdjsonFabricStore } from '../runtime/fabric-store.ts';
import { runConnector, runReport } from '../runtime/run.ts';
import { DEFAULT_BATCH_CONFIG, runStreamingConnector } from '../runtime/stream-run.ts';
import { createGenerationStore } from '../runtime/staged-store.ts';
import { createRateLimiter } from '../runtime/retry.ts';

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

type AdapterOptions = {
  readonly file: string;
  readonly period: string;
  readonly live: boolean;
  readonly maxFeatures: number | undefined;
};

/** Adapters the CLI can run. A mapping naming anything else cannot be run. */
const ADAPTERS: Readonly<Record<string, (o: AdapterOptions) => Connector>> = {
  mn_ecrv: (o) => createMnEcrvConnector({ localReleases: [{ path: o.file, referencePeriod: o.period }] }),
  mn_hennepin_assessor: (o) => createHennepinAssessorConnector(
    o.live
      ? {
        live: {
          referencePeriod: o.period,
          ...(o.maxFeatures !== undefined ? { maxFeatures: o.maxFeatures } : {}),
        },
      }
      : { localReleases: [{ path: o.file, referencePeriod: o.period }] },
  ),
};

type StreamAdapterOptions = {
  readonly file: string;
  readonly period: string;
  readonly live: boolean;
  readonly maxFeatures: number | undefined;
  readonly fetchBatchSize: number;
  readonly maxConcurrentRequests: number;
};

/**
 * Adapters the bounded-memory `stream` command can run.
 *
 * Only the assessor has a live transport. The recorder and the SOS register are
 * both operator-delivered — one because automation is contractually prohibited,
 * the other because the delivery is a purchase — so their entries take a file
 * and nothing else. There is deliberately no way to ask either for `--live`.
 */
const STREAMING_ADAPTERS: Readonly<Record<string, (o: StreamAdapterOptions) => StreamingConnector>> = {
  mn_hennepin_assessor: (o) => createStreamingHennepinConnector({
    ...(o.live
      ? { live: { referencePeriod: o.period, ...(o.maxFeatures !== undefined ? { maxFeatures: o.maxFeatures } : {}) } }
      : {}),
    fetchBatchSize: o.fetchBatchSize,
    maxConcurrentRequests: o.maxConcurrentRequests,
  }),
  mn_hennepin_recorder: (o) => createHennepinRecorderConnector({
    ...(o.file ? { localFile: o.file } : {}),
    referencePeriod: o.period,
  }),
  mn_sos_business: (o) => createMnSosBusinessConnector({
    ...(o.file ? { localFile: o.file } : {}),
    referencePeriod: o.period,
  }),
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
      if (flags['source'] === 'hennepin') {
        out({
          source: 'mn_hennepin_county_parcels',
          layer: 'Hennepin County Parcels (LAND_PROPERTY/1)',
          publishedFields: HENNEPIN_FIELD_MAP.length,
          dispositions: hennepinDispositionCounts(),
          fields: HENNEPIN_FIELD_MAP,
          notInThisSource: HENNEPIN_ABSENT_FIELDS,
        });
        return 0;
      }
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
      const live = flags['live'] === true;
      const maxRaw = typeof flags['max'] === 'string' ? Number(flags['max']) : undefined;
      if (maxRaw !== undefined && (!Number.isInteger(maxRaw) || maxRaw < 1)) {
        process.stderr.write('--max must be a positive integer\n');
        return 2;
      }
      const connector = build({ file, period, live, maxFeatures: maxRaw });

      let replay: ArchivedArtifact | undefined;
      if (command === 'replay') {
        const sha = typeof flags['artifact'] === 'string' ? (flags['artifact'] as string) : '';
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          process.stderr.write('replay requires --artifact <sha256>\n');
          return 2;
        }
        replay = await locateArtifact(artifactStore, mapping.sourceId, period, sha);
      } else if (!file && !live) {
        process.stderr.write('run requires --file <path>, or --live for a sanctioned API source\n');
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
        propertyResolutions: {
          total: result.resolutions.length,
          resolved: result.resolutions.filter((r) => r.state === 'resolved').length,
          provisional: result.resolutions.filter((r) => r.state === 'provisional').length,
        },
        conflicts: result.conflicts.map((c) => ({
          kind: c.conflictKind, severity: c.severity, parcel: c.normalizedParcel,
        })),
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

    case 'stream': {
      // The bounded-memory path. Handles a full county; the buffered `run`
      // command does not, and says so rather than dying at 400,000 rows.
      const mappingId = positional[0];
      if (!mappingId) {
        process.stderr.write('usage: df stream <mappingId> [--file <p> | --live] --period <label> [--max N]\n');
        return 2;
      }
      const mapping = registry.mapping(mappingId);
      const buildStream = STREAMING_ADAPTERS[mapping.adapterKey];
      if (!buildStream) {
        process.stderr.write(`adapter "${mapping.adapterKey}" has no streaming implementation\n`);
        return 2;
      }

      const period = typeof flags['period'] === 'string' ? (flags['period'] as string) : 'unspecified';
      const file = typeof flags['file'] === 'string' ? (flags['file'] as string) : '';
      const live = flags['live'] === true;
      const max = typeof flags['max'] === 'string' ? Number(flags['max']) : undefined;
      const rateMs = typeof flags['rate-ms'] === 'string' ? Number(flags['rate-ms']) : 400;
      const batchSize = typeof flags['batch'] === 'string' ? Number(flags['batch']) : DEFAULT_BATCH_CONFIG.fetchBatchSize;
      const concurrency = typeof flags['concurrency'] === 'string'
        ? Number(flags['concurrency']) : DEFAULT_BATCH_CONFIG.maxConcurrentRequests;

      if (!live && !file && flags['artifact'] === undefined) {
        process.stderr.write('stream requires --file <path>, --live, or --artifact <sha256>\n');
        return 2;
      }

      const objects = createStreamingFilesystemObjectStore(ARCHIVE_ROOT_DIR);
      const artifactStore = createStreamingArtifactStore(objects);
      const contactPlane = createContactPlane({ maxRetained: 1000 });

      let replay: ArchivedArtifact | undefined;
      if (typeof flags['artifact'] === 'string') {
        const sha = flags['artifact'] as string;
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          process.stderr.write('--artifact expects a sha256\n');
          return 2;
        }
        replay = await locateArtifact(createArtifactStore(objects), mapping.sourceId, period, sha);
      }

      const result = await runStreamingConnector({
        registry,
        connector: buildStream({
          file,
          period,
          live,
          maxFeatures: max,
          fetchBatchSize: batchSize,
          maxConcurrentRequests: concurrency,
        }),
        mappingId,
        artifactStore,
        contactPlane,
        varRoot: VAR_ROOT,
        clock: systemClock,
        logger: createLogger(),
        dryRun: flags['dry-run'] === true,
        referencePeriod: period,
        resume: flags['resume'] === true,
        ...(file ? { localFile: file } : {}),
        ...(replay ? { replayArtifact: replay } : {}),
        rateLimiter: createRateLimiter(rateMs),
        batch: { fetchBatchSize: batchSize, maxConcurrentRequests: concurrency },
      });

      out({
        report: runReport(result.run),
        reconciliation: {
          sourceReportedCount: result.run.sourceReportedCount,
          downloadedCount: result.run.downloadedCount,
          parsed: result.run.metrics.rowsParsed,
          accepted: result.run.metrics.rowsValid,
          quarantined: result.run.metrics.rowsQuarantined,
          duplicates: result.run.duplicateCount,
          missingFromSnapshot: result.run.metrics.rowsMissingFromSnapshot,
          completeness: result.run.snapshotCompleteness,
          sourceChangedDuringRead: result.run.sourceChangedDuringRead,
        },
        canonical: {
          resolved: result.run.metrics.rowsResolved,
          conflicts: result.run.metrics.rowsConflicted,
          canonicalDigest: result.run.canonicalDigest,
        },
        timings: result.timings,
        peakHeapMB: Math.round(result.peakHeapBytes / 1048576),
        batchConfiguration: result.run.batchConfiguration,
      });
      return result.run.status === 'completed' ? 0 : 1;
    }

    case 'checkpoints': {
      const { createCheckpointStore } = await import('../runtime/checkpoint.ts');
      out(await createCheckpointStore(VAR_ROOT).list());
      return 0;
    }

    case 'sweep': {
      // Reclaims generation directories a crashed run left behind. Never touches
      // the generation a CURRENT pointer names.
      const removed = await createGenerationStore(VAR_ROOT).sweepAbandoned();
      out({ abandonedGenerationsRemoved: removed });
      return 0;
    }

    case 'runs': {
      const fabricStore = createNdjsonFabricStore(VAR_ROOT);
      out((await fabricStore.runs()).map(runReport));
      return 0;
    }

    case 'resolutions': {
      const fabricStore = createNdjsonFabricStore(VAR_ROOT);
      const rows = await fabricStore.resolutions();
      out({
        total: rows.length,
        byState: rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.state] = (acc[r.state] ?? 0) + 1;
          return acc;
        }, {}),
        properties: rows.map((r) => ({
          propertyId: r.propertyId,
          parcel: `${r.countyFips}:${r.normalizedParcel}`,
          state: r.state,
          authority: r.authoritativeSourceId,
          sources: r.contributingSourceIds,
        })),
      });
      return 0;
    }

    case 'conflicts': {
      const fabricStore = createNdjsonFabricStore(VAR_ROOT);
      const rows = await fabricStore.conflicts();
      out(rows.filter((c) => c.status !== 'dismissed').map((c) => ({
        kind: c.conflictKind,
        severity: c.severity,
        parcel: c.normalizedParcel,
        detail: c.detail,
      })));
      return 0;
    }

    case 'entity-links': {
      // Organization-name → state-registration decisions, INCLUDING the refusals.
      // A run that resolves nothing has still decided something, and an operator
      // needs to see why before anyone proposes loosening a rule.
      const { readFile } = await import('node:fs/promises');
      const path = `${VAR_ROOT}/derived/entity-links/current.ndjson`;
      const text = await readFile(path, 'utf8').catch(() => '');
      const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
        observedName: string; observationSourceId: string; state: string;
        entityId: string | null; candidateEntityIds: string[];
        evidence: { evidenceType: string; strength: string }[]; reason: string | null;
      });
      const byState: Record<string, number> = {};
      for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
      out({
        summary: { decisions: rows.length, byState },
        decisions: rows.map((r) => ({
          name: r.observedName,
          source: r.observationSourceId,
          state: r.state,
          entityId: r.entityId,
          candidates: r.candidateEntityIds.length,
          evidence: r.evidence.map((e) => `${e.evidenceType}(${e.strength})`),
          reason: r.reason,
        })),
      });
      return 0;
    }

    default: {
      process.stdout.write(
        [
          'df — Reivesti Data Fabric',
          '',
          '  df sources                                        registered sources and coverage',
          '  df jurisdictions [--state MN]                     catalogued jurisdictions',
          '  df fields [--source hennepin]                     field inventory and dispositions',
          '  df resolutions                                    canonical property resolution state',
          '  df conflicts                                      open cross-source conflicts',
          '  df entity-links                                   organization → registration decisions, refusals included',
          '  df run <mappingId> --file <p> --period <label>    ingest a local extract',
          '  df run <mappingId> --live --period <l> [--max N]  ingest from a sanctioned API source',
          '',
          '  df stream <mappingId> --live --period <l>          bounded-memory ingest (full county)',
          '    [--max N] [--batch 2000] [--concurrency 2] [--rate-ms 400] [--dry-run] [--resume]',
          '  df stream <mappingId> --file <p> --period <l>      bounded-memory ingest of a local bundle',
          '  df stream <mappingId> --artifact <sha256> --period <l>   replay, no network',
          '  df sweep                                          reclaim abandoned run generations',
          '  df checkpoints                                    completed acquisitions available to --resume',
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
