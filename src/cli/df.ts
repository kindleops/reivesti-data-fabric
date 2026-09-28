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
 *   df auto <mappingId>               unattended: discover → NOOP | acquire → derive → ingest
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
import {
  GPKG_METADATA_TABLE,
  GPKG_TABLE,
  MN_STATEWIDE_BULK_URL,
  MN_STATEWIDE_LAYER_ID,
  MN_STATEWIDE_SERVICE_URL,
  createMnStatewideParcelConnector,
} from '../connectors/mn-statewide-parcels/index.ts';
import { convertGpkgToBundle } from '../connectors/mn-statewide-parcels/gpkg.ts';
import {
  WI_ABSENT_CONCEPTS,
  WI_ARCGIS_ONLY_FIELDS,
  WI_NOT_INGESTED,
  WI_STATEWIDE_FIELD_MAP,
  wiStatewideDispositionCounts,
} from '../connectors/wi-statewide-parcels/field-map.ts';
import { replayWiFromArchive, runWiStatewidePipeline, type WiPipelineResult } from '../connectors/wi-statewide-parcels/pipeline.ts';
import { durableStoreFromEnv } from '../archive/durable-artifacts.ts';
import { catalog, doctor, pullArtifact, pushArtifact, reacquire, verifyDurable, type CatalogEntry } from './cloud.ts';
import { defaultRegistry } from '../registry/sources.ts';
import { assessActivation } from '../registry/policy.ts';
import {
  buildCoverage,
  coverageGaps,
  nationalCoverageReport,
  TRACKED_CAPABILITIES,
} from '../registry/coverage.ts';
import { GEOGRAPHY_PROVENANCE, US_COUNTY_EQUIVALENTS } from '../registry/us-geography.ts';
import { checkPromotion } from '../discovery/candidates.ts';
import { LEGAL_CAPABILITY_LIMITS, PLATFORM_FAMILIES, SOURCE_CANDIDATES } from '../discovery/catalogue.ts';
import { candidateJurisdictionCount, rankCatalogue } from '../discovery/rank.ts';
import { createPartitionStore } from '../runtime/partition-store.ts';
import { globalDigest } from '../canonical/partitions.ts';
import type { Connector, StreamingConnector } from '../runtime/connector.ts';
import { createNdjsonFabricStore } from '../runtime/fabric-store.ts';
import { runConnector, runReport } from '../runtime/run.ts';
import { DEFAULT_BATCH_CONFIG, runStreamingConnector } from '../runtime/stream-run.ts';
import { createGenerationStore } from '../runtime/staged-store.ts';
import { createRateLimiter } from '../runtime/retry.ts';

const VAR_ROOT = process.env['DF_VAR'] ?? 'var';
/** The repository this CLI runs from — never a machine path. */
const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
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
  mn_statewide_parcels: (o) => createMnStatewideParcelConnector({
    ...(o.file ? { localFile: o.file } : {}),
    referencePeriod: o.period,
    ...(o.live
      ? { live: { referencePeriod: o.period, ...(o.maxFeatures !== undefined ? { maxFeatures: o.maxFeatures } : {}) } }
      : {}),
    fetchBatchSize: o.fetchBatchSize,
    maxConcurrentRequests: o.maxConcurrentRequests,
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
      // Subcommands for source research. `df sources` on its own keeps its old
      // behaviour: the registered sources and their coverage.
      const sub = positional[0];
      if (sub === 'candidates') {
        out(SOURCE_CANDIDATES.map((c) => ({
          candidateId: c.candidateId,
          authority: c.authority,
          name: c.sourceName,
          capabilities: c.capabilities,
          jurisdictions: candidateJurisdictionCount(c),
          costHypothesis: c.costHypothesis,
          automationHypothesis: c.automationHypothesis,
          verification: c.verification,
          platform: c.platformId,
          promotable: checkPromotion(c).ready,
        })));
        return 0;
      }
      if (sub === 'rank') {
        out({
          gate: 'cost must be zero for a CORE candidate; excluded candidates are not scored',
          ranked: rankCatalogue(),
        });
        return 0;
      }
      if (sub === 'inspect') {
        const needle = (positional[1] ?? '').toLowerCase();
        const found = SOURCE_CANDIDATES.find(
          (c) => c.candidateId === positional[1] || c.sourceName.toLowerCase().includes(needle),
        );
        if (!found) {
          process.stderr.write('usage: df sources inspect <candidateId | name fragment>\n');
          return 2;
        }
        out({ candidate: found, jurisdictions: candidateJurisdictionCount(found), promotion: checkPromotion(found) });
        return 0;
      }
      if (sub === 'verify') {
        // Reports what verification a candidate still needs. It does NOT reach
        // any publisher: verification is a research act performed by a person,
        // and an automated discovery bot is explicitly out of scope.
        const found = SOURCE_CANDIDATES.find((c) => c.candidateId === positional[1]
          || c.sourceName.toLowerCase().includes((positional[1] ?? '').toLowerCase()));
        if (!found) {
          process.stderr.write('usage: df sources verify <candidateId | name fragment>\n');
          return 2;
        }
        const check = checkPromotion(found);
        out({
          candidate: found.sourceName,
          verification: found.verification,
          ready: check.ready,
          missing: check.missing,
          evidence: found.evidence.map((e) => ({ claim: e.claim, kind: e.kind, url: e.url })),
        });
        return check.ready ? 0 : 1;
      }
      if (sub === 'platforms') {
        out(PLATFORM_FAMILIES);
        return 0;
      }
      if (sub === 'coverage') {
        const jurisdictionId = positional[1];
        if (!jurisdictionId) {
          process.stderr.write('usage: df sources coverage <jurisdictionId>\n');
          return 2;
        }
        const matrix = buildCoverage(registry);
        out({
          jurisdictionId,
          capabilities: TRACKED_CAPABILITIES.map((capability) => ({
            capability,
            core: matrix.coreStateOf(jurisdictionId, capability),
            any: matrix.anyStateOf(jurisdictionId, capability),
          })),
          entries: matrix.entriesFor(jurisdictionId),
        });
        return 0;
      }
      if (sub === 'gaps') {
        const matrix = buildCoverage(registry);
        out({
          note: 'UNVERIFIED means nobody has looked. It is not the same as UNAVAILABLE.',
          legalLimits: LEGAL_CAPABILITY_LIMITS,
          gaps: coverageGaps(registry, matrix),
        });
        return 0;
      }
      if (sub === 'opportunities') {
        // Verified free candidates that are not yet implemented, best first.
        const implemented = new Set(registry.sources.map((s) => s.sourceName.toLowerCase()));
        out(rankCatalogue()
          .filter((r) => r.excluded === null && !implemented.has(r.sourceName.toLowerCase()))
          .map((r) => ({ ...r, components: undefined, score: r.score })));
        return 0;
      }
      if (sub !== undefined) {
        process.stderr.write(`unknown "df sources" subcommand "${sub}"\n`);
        return 2;
      }
      out(registry.sources.map((s) => ({
        sourceId: s.sourceId,
        authority: s.sourceAuthority,
        program: s.sourceProgram,
        family: s.sourceFamily,
        accessType: s.accessType,
        automationStatus: s.automationStatus,
        licenseStatus: s.licenseStatus,
        costClass: s.costClass ?? 'UNKNOWN_COST',
        role: s.role ?? null,
        activation: assessActivation(s).verdict,
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
      if (flags['source'] === 'wi') {
        out({
          source: 'wi_statewide_parcels',
          layer: 'V1200_WisconsinParcels_2026 (File Geodatabase, V12.0.0)',
          publishedFields: WI_STATEWIDE_FIELD_MAP.length,
          dispositions: wiStatewideDispositionCounts(),
          fields: WI_STATEWIDE_FIELD_MAP,
          notIngested: WI_NOT_INGESTED,
          onlyInFeatureServer: WI_ARCGIS_ONLY_FIELDS,
          notInThisSchema: WI_ABSENT_CONCEPTS,
        });
        return 0;
      }
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
        memoryByStage: Object.fromEntries(Object.entries(result.memoryByStage).map(([stage, m]) => [stage, {
          heapMB: Math.round(m.peakHeapBytes / 1048576),
          externalMB: Math.round(m.peakExternalBytes / 1048576),
          arrayBuffersMB: Math.round(m.peakArrayBufferBytes / 1048576),
          rssMB: Math.round(m.peakRssBytes / 1048576),
        }])),
        batchConfiguration: result.run.batchConfiguration,
      });
      return result.run.status === 'completed' ? 0 : 1;
    }

    case 'auto': {
      // The unattended path. A scheduler runs this with no arguments beyond the
      // mapping; it decides for itself whether there is anything to do.
      const mappingId = positional[0];
      if (!mappingId) {
        process.stderr.write('usage: df auto <mappingId> [--discover-only] [--force] [--replay <sha256> --period <label>]\n');
        return 2;
      }
      const mapping = registry.mapping(mappingId);
      if (mapping.adapterKey !== 'wi_statewide_parcels') {
        process.stderr.write(`adapter "${mapping.adapterKey}" has no unattended acquisition pipeline\n`);
        return 2;
      }
      const objects = createStreamingFilesystemObjectStore(ARCHIVE_ROOT_DIR);
      const common = {
        registry,
        artifactStore: createStreamingArtifactStore(objects),
        contactPlane: createContactPlane({ maxRetained: 1000 }),
        varRoot: VAR_ROOT,
        clock: systemClock,
        logger: createLogger(),
        // Explicit, from DF_ARTIFACT_*; null when no durable store is configured.
        durable: durableStoreFromEnv(),
        ...(typeof flags['max'] === 'string' ? { maxRows: Number(flags['max']) } : {}),
      };
      let result: WiPipelineResult;
      if (typeof flags['replay'] === 'string') {
        const sha = flags['replay'] as string;
        const period = typeof flags['period'] === 'string' ? (flags['period'] as string) : '';
        if (!/^[0-9a-f]{64}$/.test(sha) || !period) {
          process.stderr.write('--replay needs the publisher archive sha256 and --period\n');
          return 2;
        }
        result = await replayWiFromArchive({ ...common, publisherSha256: sha, referencePeriod: period });
      } else {
        result = await runWiStatewidePipeline({
          ...common,
          mode: flags['force'] === true ? 'force' : 'scheduled',
          discoverOnly: flags['discover-only'] === true,
        });
      }
      out(summarizeWiPipeline(result));
      return result.outcome === 'FAILED' ? 1 : 0;
    }

    case 'doctor': {
      const report = await doctor({
        varRoot: VAR_ROOT, archiveRoot: ARCHIVE_ROOT_DIR, repoRoot: REPO_ROOT, probe: flags['probe'] === true,
      });
      out(report);
      return report.ready ? 0 : 1;
    }

    case 'artifacts': {
      const sub = positional[0];
      const workspace = createStreamingArtifactStore(createStreamingFilesystemObjectStore(ARCHIVE_ROOT_DIR));
      const store = durableStoreFromEnv();
      const sha = typeof flags['sha'] === 'string' ? (flags['sha'] as string) : '';
      const { readFileSync } = await import('node:fs');
      const pinned = (JSON.parse(readFileSync(`${REPO_ROOT}/reference/artifact-catalog.json`, 'utf8')) as { entries: CatalogEntry[] }).entries;
      if (sub === 'catalog') {
        out(await catalog({ repoRoot: REPO_ROOT, store, workspace, verify: flags['verify'] === true }));
        return 0;
      }
      if (sub === 'reacquire') {
        const entry = pinned.find((e) => e.sha256 === sha);
        if (!entry) { process.stderr.write('reacquire needs --sha of a catalogued publisher_raw artifact\n'); return 2; }
        const result = await reacquire(entry, workspace, systemClock.now().toISOString());
        let commit = null;
        if (result.restored && store) {
          commit = await pushArtifact(store, workspace, result.artifact, 'publisher_raw', entry.contentType ?? 'application/octet-stream', null);
        }
        out({ restored: result.restored, expected: result.expected, actual: result.actual, bytes: result.bytes, durableCommit: commit,
          verdict: result.restored ? 'EXACT_BYTES_RESTORED' : 'DIFFERENT_BYTES: a new release, NOT a restoration' });
        return result.restored ? 0 : 1;
      }
      if (!store) { process.stderr.write('no durable artifact backend is configured (DF_ARTIFACT_BACKEND)\n'); return 2; }
      if (!/^[0-9a-f]{64}$/.test(sha)) { process.stderr.write(`usage: df artifacts ${sub ?? '<push|pull|verify|catalog|reacquire>'} --sha <sha256>\n`); return 2; }
      if (sub === 'push') {
        const entry = pinned.find((e) => e.sha256 === sha);
        const sourceId = typeof flags['source'] === 'string' ? (flags['source'] as string) : entry?.sourceId ?? '';
        const period = typeof flags['period'] === 'string' ? (flags['period'] as string) : entry?.referencePeriod ?? '';
        const artifact = await locateArtifact(createArtifactStore(createStreamingFilesystemObjectStore(ARCHIVE_ROOT_DIR)), sourceId, period, sha);
        const role = entry?.role === 'derived_bundle' ? 'derived_bundle' : 'publisher_raw';
        out(await pushArtifact(store, workspace, artifact, role, entry?.contentType ?? 'application/octet-stream', null));
        return 0;
      }
      if (sub === 'pull') {
        const restored = await pullArtifact(store, workspace, sha);
        out({ sha256: restored.artifact.sha256, bytes: restored.artifact.byteLength, ms: restored.ms, storagePath: restored.artifact.storagePath, role: restored.manifest.role });
        return 0;
      }
      if (sub === 'verify') {
        const v = await verifyDurable(store, sha);
        out(v);
        return v.state === 'DURABLE' ? 0 : 1;
      }
      process.stderr.write(`unknown "df artifacts" subcommand "${sub}"\n`);
      return 2;
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

    case 'overlap-audit': {
      // Two sources describing one county, compared twice: once with the
      // literal string comparison DF-0H used, and once through the
      // normalization contract. The difference is the report — see
      // docs/CANONICAL-NORMALIZATION.md for why the first answer was wrong.
      const direct = typeof flags['direct'] === 'string' ? (flags['direct'] as string) : '';
      const aggregation = typeof flags['aggregation'] === 'string' ? (flags['aggregation'] as string) : '';
      const county = typeof flags['county'] === 'string' ? (flags['county'] as string) : '';
      if (!direct || !aggregation) {
        process.stderr.write('usage: df overlap-audit --direct <sourceId> --aggregation <sourceId> [--county <fips>]\n');
        return 2;
      }
      const { createGenerationStore } = await import('../runtime/staged-store.ts');
      const { auditOverlap, comparablesFrom, overlapMigrationReport, agreementRate } =
        await import('../canonical/overlap-audit.ts');
      const store = createGenerationStore(VAR_ROOT);
      const shared = {
        directSourceId: direct,
        aggregationSourceId: aggregation,
        decidedAt: new Date().toISOString(),
        sort: { chunkLines: 50_000, scratchDir: `${VAR_ROOT}/scratch` },
        ...(county ? { countyFips: county } : {}),
      };
      const started = Date.now();
      let peak = 0;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 100);
      // Two passes over the same rows. Deliberately not one pass computing both:
      // the literal audit must stay exactly the code DF-0H ran, so the
      // comparison is against a measurement rather than a memory of one.
      const before = await auditOverlap(() => comparablesFrom(store.readTable('bundles')), { ...shared, mode: 'literal' });
      const after = await auditOverlap(() => comparablesFrom(store.readTable('bundles')), { ...shared, mode: 'canonical' });
      clearInterval(sampler);
      out({
        overlapping: after.overlapping,
        onlyDirect: after.onlyDirect,
        onlyAggregation: after.onlyAggregation,
        contractVersions: after.contractVersions,
        ms: Date.now() - started,
        peakHeapMB: Math.round(peak / 1048576),
        migration: overlapMigrationReport(before, after),
        canonical: after.agreements.map((a) => ({
          field: a.field,
          both: a.bothPopulated,
          exact: a.exactMatch,
          normalized: a.normalizedMatch,
          equivalent: a.equivalentMatch,
          conflict: a.conflict,
          incomparable: a.incomparable,
          onlyDirect: a.onlyDirect,
          onlyAggregation: a.onlyAggregation,
          rate: agreementRate(a),
          verdict: after.decisions.find((d) => d.field === a.field)?.verdict,
          basis: after.decisions.find((d) => d.field === a.field)?.basis,
        })),
      });
      return 0;
    }

    case 'gpkg-bundle': {
      // Converts the publisher's bulk GeoPackage into the snapshot bundle the
      // streaming runtime ingests. One request to the publisher instead of the
      // 1,356 paginated queries the same data would take over the API.
      const gpkg = typeof flags['gpkg'] === 'string' ? (flags['gpkg'] as string) : '';
      const outPath = typeof flags['out'] === 'string' ? (flags['out'] as string) : '';
      if (!gpkg || !outPath) {
        process.stderr.write('usage: df gpkg-bundle --gpkg <file.gpkg> --out <bundle.ndjson> [--max N]\n');
        return 2;
      }
      const { createFileLineWriter } = await import('../core/lines.ts');
      const { sha256File } = await import('../core/hash.ts');
      const { readFileSync } = await import('node:fs');
      const metaPath = typeof flags['layer-meta'] === 'string' ? (flags['layer-meta'] as string) : '';
      const liveFields = metaPath
        ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { fields: { name: string; type: string; length?: number }[] }).fields
        : [];
      if (liveFields.length === 0) {
        process.stderr.write('--layer-meta <layer.json> is required: the pinned field-set digest is computed from '
          + "the publisher's own layer metadata, never from the GeoPackage's own column list\n");
        return 2;
      }
      const archiveSha256 = await sha256File(gpkg);
      const writer = await createFileLineWriter(outPath);
      const started = Date.now();
      const result = await convertGpkgToBundle({
        gpkgPath: gpkg,
        table: GPKG_TABLE,
        metadataTable: GPKG_METADATA_TABLE,
        sourceId: 'mn_statewide_parcels',
        serviceUrl: MN_STATEWIDE_SERVICE_URL,
        layerId: MN_STATEWIDE_LAYER_ID,
        liveFields,
        downloadUrl: MN_STATEWIDE_BULK_URL,
        archiveSha256,
        retrievedAt: systemClock.now().toISOString(),
        ...(typeof flags['max'] === 'string' ? { maxRows: Number(flags['max']) } : {}),
      }, (line) => writer.write(line));
      await writer.close();
      out({ ...result, archiveSha256, out: outPath, ms: Date.now() - started });
      return 0;
    }

    case 'policy': {
      // The zero-cost doctrine applied to every registered source, with the
      // gate that decided each verdict and what would have to change.
      out({
        doctrine: 'CORE activation requires zero cost AND sanctioned acquisition AND compatible terms '
          + 'AND acceptable authority AND reproducible provenance.',
        sources: registry.sources.map((s) => assessActivation(s)),
      });
      return 0;
    }

    case 'geography': {
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const c of US_COUNTY_EQUIVALENTS) {
        byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
        byType[c.type] = (byType[c.type] ?? 0) + 1;
      }
      out({
        provenance: GEOGRAPHY_PROVENANCE,
        total: US_COUNTY_EQUIVALENTS.length,
        byStatus,
        byType,
        replaced: US_COUNTY_EQUIVALENTS.filter((c) => c.status === 'replaced')
          .map((c) => ({ fips: c.fips, name: c.name, note: c.note })),
      });
      return 0;
    }

    case 'coverage': {
      const matrix = buildCoverage(registry);
      out(nationalCoverageReport(registry, matrix, systemClock.now().toISOString()));
      return 0;
    }

    case 'partitions': {
      const store = createPartitionStore(VAR_ROOT);
      if (flags['sweep'] === true) {
        out({ abandonedGenerationsRemoved: await store.sweepAbandoned() });
        return 0;
      }
      const manifests = await store.manifests();
      out({
        count: manifests.length,
        globalDigest: globalDigest(manifests),
        partitions: manifests.map((m) => ({
          partitionId: m.partitionId,
          rows: m.rowCount,
          inputRows: m.inputRowCount,
          outputDigest: m.outputDigest,
          resolver: m.resolverVersion,
          activatedAt: m.activatedAt,
        })),
      });
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
          '  df policy                                         zero-cost activation verdict per source',
          '  df geography                                      county-equivalent catalogue and its provenance',
          '  df coverage                                       national coverage report',
          '  df partitions [--sweep]                           projection partitions and the global digest',
          '  df gpkg-bundle --gpkg <f> --out <f> --layer-meta <f>   publisher bulk GeoPackage -> snapshot bundle',
          '',
          '  df sources candidates                             researched source candidates',
          '  df sources rank                                   zero-cost priority ranking',
          '  df sources inspect <id|name>                      one candidate with its evidence',
          '  df sources verify <id|name>                       what a candidate still needs to be promotable',
          '  df sources platforms                              shared source-platform families',
          '  df sources coverage <jurisdictionId>              capability coverage for one place',
          '  df sources gaps                                   coverage gaps by capability and state',
          '  df sources opportunities                          verified free candidates not yet implemented',
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
          '  df overlap-audit --direct <sourceId> --aggregation <sourceId> [--county <fips>]',
          '  df verify --artifact <sha256> [--source <id>] [--period <label>]',
          '  df runs                                           run history',
          '  df auto <mappingId> [--discover-only] [--force]   unattended discover → NOOP | acquire → derive → ingest',
          '  df doctor [--probe]                               is this machine ready to work alone? (secrets: yes/no only)',
          '  df artifacts catalog [--verify]                   known artifacts vs workspace vs durable store',
          '  df artifacts push|pull|verify --sha <sha256>      durable store operations, by digest',
          '  df artifacts reacquire --sha <sha256>             re-download a catalogued raw artifact; exact sha or it is not a restoration',
          '  df auto <mappingId> --replay <sha256> --period <l>   re-derive and re-ingest from the retained archive, no network',
          '',
          `  DF_VAR=${VAR_ROOT}  DF_ARCHIVE=${ARCHIVE_ROOT_DIR}`,
          '',
        ].join('\n'),
      );
      return command === 'help' ? 0 : 2;
    }
  }
}

function summarizeWiPipeline(result: WiPipelineResult): unknown {
  const run = result.run;
  const mb = (n: number) => Math.round(n / 1048576);
  return {
    outcome: result.outcome,
    plan: result.plan,
    discovered: result.discovered === null ? null : {
      referencePeriod: result.discovered.referencePeriod,
      releaseFingerprint: result.discovered.releaseFingerprint,
      head: result.discovered.head,
      archive: result.discovered.archive,
      access: result.discovered.access,
      serviceMatchesArchive: result.discovered.serviceMatchesArchive,
      witness: { ...result.discovered.witness, fields: result.discovered.witness.fields.length },
    },
    publisherArtifact: result.publisherArtifact && {
      sha256: result.publisherArtifact.sha256, bytes: result.publisherArtifact.byteLength,
      filename: result.publisherArtifact.manifest.originalFilename, url: result.publisherArtifact.manifest.originalUrl,
      retrievedAt: result.publisherArtifact.manifest.retrievedAt, effectiveAt: result.publisherArtifact.manifest.effectiveAt,
      path: result.publisherArtifact.storagePath,
    },
    bundleArtifact: result.bundleArtifact && { sha256: result.bundleArtifact.sha256, bytes: result.bundleArtifact.byteLength },
    derivation: result.derivation && { ...result.derivation, fields: result.derivation.fields.length },
    crossCheck: result.crossCheck,
    counties: result.counties,
    report: run ? runReport(run.run) : null,
    reconciliation: run ? {
      sourceReportedCount: run.run.sourceReportedCount,
      downloadedCount: run.run.downloadedCount,
      parsed: run.run.metrics.rowsParsed,
      accepted: run.run.metrics.rowsValid,
      quarantined: run.run.metrics.rowsQuarantined,
      duplicates: run.run.duplicateCount,
      new: run.run.metrics.rowsNew,
      unchanged: run.run.metrics.rowsUnchanged,
      revised: run.run.metrics.rowsRevised,
      missingFromSnapshot: run.run.metrics.rowsMissingFromSnapshot,
      completeness: run.run.snapshotCompleteness,
    } : null,
    canonical: run ? {
      normalizedDigest: run.run.normalizedDigest,
      globalDigest: run.globalDigest,
      resolved: run.run.metrics.rowsResolved,
      conflicts: run.run.metrics.rowsConflicted,
      contactObservations: run.run.metrics.contactObservations,
      canonicalEvents: run.run.metrics.canonicalEvents,
    } : null,
    partitions: run ? {
      planned: run.partitionPlan.partitions.length,
      activations: run.activations.map((a) => ({ partitionId: a.partitionId, state: a.state, generation: a.generation })),
      uncovered: run.uncoveredPartitions,
    } : null,
    countyCounts: run?.countyCounts ?? null,
    timings: { pipeline: result.timings, runtime: run?.timings ?? null },
    memory: {
      pipelinePeakHeapMB: mb(result.memory.peakHeapBytes),
      pipelinePeakRssMB: mb(result.memory.peakRssBytes),
      pipelinePeakExternalMB: mb(result.memory.peakExternalBytes),
      runtimePeakHeapMB: run ? mb(run.peakHeapBytes) : null,
      byStage: run ? Object.fromEntries(Object.entries(run.memoryByStage).map(([stage, m]) => [stage, {
        heapMB: mb(m.peakHeapBytes), externalMB: mb(m.peakExternalBytes),
        arrayBuffersMB: mb(m.peakArrayBufferBytes), rssMB: mb(m.peakRssBytes),
      }])) : null,
    },
    ledger: result.ledger,
  };
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
