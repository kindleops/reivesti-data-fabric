/**
 * The unattended New York statewide parcel pipeline.
 *
 * What a scheduler runs, start to finish, with nobody present:
 *
 *   gate       the activation evaluator must say CORE_ELIGIBLE, from registry
 *              facts alone, before any request leaves the machine
 *   discover   program page → archive + FeatureServer (GeoHub, or wherever the
 *              publisher now points) → archive HEAD + ZIP directory by range →
 *              witness metadata and count
 *   plan       ledger: this exact release already ingested? → NOOP, stop
 *   acquire    one GET, streamed into the artifact store, sha256 on the way
 *   derive     archive → geodatabase → compressed snapshot bundle, from the
 *              RETAINED bytes
 *   check      archive rows, schema and release label against the witness;
 *              a disagreement activates nothing
 *   ingest     the streaming runtime: parse, route, normalise, emit, project,
 *              activate 62 county partitions independently
 *   record     ledger entry, so the next tick is a NOOP
 *   companion  the public polygon archive, retained as raw geometry evidence
 *              under its own fingerprint — never ingested
 *
 * No inbox, no operator download, no file moved by hand. The network is touched
 * only by `discover`, `acquire` and `companion`. `replayNyFromArchive` runs
 * every later step with no network at all, from the retained archive.
 *
 * The shape is Wisconsin's (DF-0K) on purpose. It is implemented here, source-
 * locally, rather than by generalising Wisconsin's pipeline while another state
 * is being built in parallel; folding the two into one generic bulk pipeline is
 * a post-integration refactor, not something to race.
 */
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { artifactDir, type ArchivedArtifact, type StreamingArtifactStore } from '../../archive/artifact-store.ts';
import type { ContactPlane } from '../../contact/contact-plane.ts';
import { type Clock, systemClock } from '../../core/clock.ts';
import { fail } from '../../core/errors.ts';
import { canonicalJson } from '../../core/hash.ts';
import { type Logger, silentLogger } from '../../core/logging.ts';
import { assessActivation } from '../../registry/policy.ts';
import type { Registry } from '../../registry/registry.ts';
import { stateJurisdictionId } from '../../registry/jurisdictions.ts';
import {
  createAcquisitionLedger,
  downloadArchive,
  planAcquisition,
  type AcquisitionPlan,
  type HttpDeps,
  type LedgerEntry,
} from '../../runtime/bulk-acquisition.ts';
import { createCheckpointStore } from '../../runtime/checkpoint.ts';
import { runStreamingConnector, type BatchConfiguration, type StreamRunResult } from '../../runtime/stream-run.ts';
import {
  commitDurable,
  findRelease,
  registerRelease,
  rehydrate,
  type DurableCommit,
  type DurableStore,
} from '../../archive/durable-artifacts.ts';
import { NORMALIZATION_CONTRACT_VERSION } from '../../canonical/normalization-contract.ts';
import { NY_POLYGON_SOURCE_ID } from '../../registry/sources.ts';
import { NY_BUNDLE_FILENAME, deriveNyBundle, gzipLineWriter, type NyBundleDerivation } from './bundle.ts';
import { reconcileNyCounties, type CountyReconciliation } from './counties.ts';
import {
  NY_PINNED_FIELD_SET_DIGEST,
  NY_PINNED_REFERENCE_PERIOD,
  NY_STATEWIDE_PARSER_VERSION,
  NY_STATEWIDE_SOURCE_ID,
  createNyStatewideParcelConnector,
} from './index.ts';
import { NY_CENTROID_LAYER_ID, discoverNyRelease, type NyDiscoveredRelease } from './release.ts';

export const NY_STATEWIDE_MAPPING_ID = 'ny_statewide_parcels__all_ny_counties';

export type NyPipelineOptions = {
  readonly registry: Registry;
  readonly artifactStore: StreamingArtifactStore;
  readonly contactPlane: ContactPlane;
  readonly varRoot: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly http?: HttpDeps;
  /**
   * `scheduled` (default): a release already ingested is a NOOP.
   * `force`: ingest again even if it was — the idempotency proof uses this.
   */
  readonly mode?: 'scheduled' | 'force';
  /** Stop after discovery and planning. Touches no archive. */
  readonly discoverOnly?: boolean;
  /** Injected discovery, for tests and for simulating a newer release. */
  readonly discovered?: NyDiscoveredRelease;
  readonly batch?: Partial<BatchConfiguration>;
  /** Fixture runs only. */
  readonly maxRows?: number;
  /**
   * Retain the public polygon archive as raw geometry evidence (default true).
   * Never ingested either way.
   */
  readonly retainCompanion?: boolean;
  /**
   * The durable artifact store. When present, raw publisher bytes are made
   * durable and verified BEFORE anything is derived or activated, the release
   * is registered there, and a worker that finds the release already durable
   * rehydrates it instead of asking the publisher again.
   */
  readonly durable?: DurableStore | null;
};

/** How this run's raw bytes were obtained and kept. */
export type NyDurability = {
  readonly source: 'publisher' | 'workspace' | 'durable_store';
  readonly commit: DurableCommit | null;
  readonly releaseRegistered: boolean;
  readonly rehydrateMs: number | null;
  readonly receiptKey: string | null;
};

export type NyCrossCheck = {
  readonly archiveRows: number;
  readonly serviceCount: number;
  readonly difference: number;
  /** Rows, schema and release must all agree. Any disagreement blocks COMPLETE. */
  readonly agrees: boolean;
  readonly countAgrees: boolean;
  readonly schemaAgrees: boolean;
  /** The service's title/publication date name the archive's release. Reported; see `agrees`. */
  readonly releaseAgrees: boolean;
  readonly serviceUrl: string;
  readonly serviceOnLegacyHost: boolean;
  readonly serviceLayerName: string;
  readonly archiveTable: string;
  readonly archiveGeodatabase: string;
  readonly serviceSchemaDigest: string;
  readonly archiveSchemaDigest: string;
  /** Attribute columns present in one path and not the other, excluding geometry metrics. */
  readonly onlyInService: readonly string[];
  readonly onlyInArchive: readonly string[];
};

export type NyCompanionRetention = {
  readonly status: 'RETAINED' | 'ALREADY_RETAINED' | 'NOT_LINKED' | 'FAILED' | 'SKIPPED';
  readonly url: string | null;
  readonly releaseFingerprint: string | null;
  readonly referencePeriod: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly serviceCount: number | null;
  readonly note: string | null;
};

export type NyPipelineResult = {
  readonly outcome: 'NOOP' | 'DISCOVERED' | 'INGESTED' | 'FAILED';
  readonly discovered: NyDiscoveredRelease | null;
  readonly plan: AcquisitionPlan | null;
  readonly publisherArtifact: ArchivedArtifact | null;
  readonly bundleArtifact: ArchivedArtifact | null;
  readonly derivation: NyBundleDerivation | null;
  readonly crossCheck: NyCrossCheck | null;
  readonly counties: CountyReconciliation | null;
  readonly run: StreamRunResult | null;
  readonly ledger: LedgerEntry | null;
  readonly durability: NyDurability | null;
  readonly companion: NyCompanionRetention | null;
  readonly timings: Readonly<Record<string, number>>;
  readonly memory: { readonly peakHeapBytes: number; readonly peakRssBytes: number; readonly peakExternalBytes: number };
};

/** Discover → plan → (NOOP | acquire → derive → check → ingest) → record → companion. */
export async function runNyStatewidePipeline(options: NyPipelineOptions): Promise<NyPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: 'ny_statewide_parcels' });
  const source = options.registry.source(NY_STATEWIDE_SOURCE_ID);
  const ledger = createAcquisitionLedger(options.varRoot, source.sourceId);
  const timings: Record<string, number> = {};
  const memory = memorySampler();
  // Kept outside the try so a failure after discovery still names the release.
  let discoveredRelease: NyDiscoveredRelease | null = options.discovered ?? null;

  try {
    // ---- gate: before any network --------------------------------------------
    const gate = assessActivation(source);
    if (gate.verdict !== 'CORE_ELIGIBLE') {
      fail('CONFIG', `refusing unattended acquisition: ${source.sourceId} is ${gate.verdict}`, { reason: gate.reason });
    }

    // ---- discover ------------------------------------------------------------
    let t = performance.now();
    const discovered = options.discovered ?? await discoverNyRelease(options.http);
    discoveredRelease = discovered;
    timings['discover'] = Math.round(performance.now() - t);
    logger.info('ny.discovered', {
      release: discovered.referencePeriod, fingerprint: discovered.releaseFingerprint,
      bytes: discovered.head.contentLength, serviceCount: discovered.witness.count,
      witnessHost: discovered.migration.witnessHost, legacy: discovered.migration.dependsOnLegacyHost,
    });

    // ---- plan ----------------------------------------------------------------
    const plan = await planAcquisition(discovered, ledger, NY_PINNED_REFERENCE_PERIOD);
    const empty = {
      publisherArtifact: null, bundleArtifact: null, derivation: null, crossCheck: null, counties: null, run: null,
    };
    if (options.discoverOnly) {
      return { outcome: 'DISCOVERED', discovered, plan, ...empty, ledger: null, durability: null, companion: null, timings, memory: memory.stop() };
    }
    if (plan.action === 'NOOP' && (options.mode ?? 'scheduled') === 'scheduled') {
      const entry: LedgerEntry = {
        at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod: discovered.referencePeriod,
        releaseFingerprint: discovered.releaseFingerprint, action: 'NOOP_SAME_RELEASE',
        publisherSha256: plan.previous.publisherSha256, publisherBytes: plan.previous.publisherBytes,
        bundleSha256: plan.previous.bundleSha256, runId: plan.previous.runId, runStatus: null,
        normalizedDigest: null, estateDigest: null, note: plan.reason,
      };
      await ledger.append(entry);
      logger.info('ny.noop', { reason: plan.reason });
      // The companion is independent evidence: a tick that finds the canonical
      // release unchanged still makes sure its polygons are retained.
      const companion = await retainCompanion(options, discovered, timings);
      return { outcome: 'NOOP', discovered, plan, ...empty, ledger: entry, durability: null, companion, timings, memory: memory.stop() };
    }

    let result: NyPipelineResult | null = null;
    if (plan.action === 'NOOP' && plan.previous.publisherSha256 !== null) {
      // Forced, and this exact release is already retained: re-ingest from the
      // archive we hold. Forcing is a statement about OUR pipeline; it is no
      // reason to make the publisher serve 563 MB again.
      const retained = await locateRetainedArchive(options, discovered.referencePeriod, plan.previous.publisherSha256);
      if (retained !== null) {
        logger.info('ny.force_from_retained', { sha256: retained.sha256 });
        result = await deriveAndIngest(options, {
          discovered, plan, publisher: retained, timings, memory, ledger, action: 'REPLAYED', source: 'workspace',
        });
      }
    }

    // ---- durable store: this exact release may already be kept ------------------
    if (result === null && options.durable) {
      const known = await findRelease(options.durable, source.sourceId, discovered.referencePeriod, discovered.releaseFingerprint);
      if (known !== null) {
        t = performance.now();
        const local = await locateRetainedArchive(options, known.referencePeriod, known.publisherSha256);
        const restored = local ?? (await rehydrate(options.durable, options.artifactStore, known.publisherSha256)).artifact;
        timings['rehydrate'] = Math.round(performance.now() - t);
        logger.info('ny.rehydrated', { sha256: restored.sha256, from: local ? 'workspace' : 'durable_store' });
        result = await deriveAndIngest(options, {
          discovered, plan, publisher: restored, timings, memory, ledger, action: 'REHYDRATED_AND_INGESTED',
          source: local ? 'workspace' : 'durable_store', rehydrateMs: local ? null : timings['rehydrate'] ?? null,
        });
      }
    }

    // ---- acquire ---------------------------------------------------------------
    if (result === null) {
      t = performance.now();
      const mapping = options.registry.mapping(NY_STATEWIDE_MAPPING_ID);
      const download = await downloadArchive(discovered, options.artifactStore, {
        sourceAuthority: source.sourceAuthority,
        sourceProgram: source.sourceProgram,
        sourceFamily: source.sourceFamily,
        sourceId: source.sourceId,
        releaseId: `${source.sourceId}__${discovered.referencePeriod}`,
        referencePeriod: discovered.referencePeriod,
        originalFilename: discovered.archive.filename,
        retrievedAt: clock.now().toISOString(),
        effectiveAt: discovered.head.lastModified === null ? null : new Date(discovered.head.lastModified).toISOString(),
        jurisdictionIds: options.registry.expand(mapping).map((j) => j.jurisdictionId),
        access: accessOf(source),
      }, options.http);
      timings['acquire'] = Math.round(performance.now() - t);
      logger.info('ny.acquired', {
        sha256: download.artifact.sha256, bytes: download.artifact.byteLength, deduped: !download.artifact.created,
      });
      result = await deriveAndIngest(options, {
        discovered, plan, publisher: download.artifact, timings, memory, ledger,
        action: 'ACQUIRED_AND_INGESTED', source: 'publisher',
      });
    }

    // ---- companion: the polygons, as raw evidence ---------------------------------
    const companion = options.maxRows === undefined && result.outcome === 'INGESTED'
      ? await retainCompanion(options, discovered, timings)
      : null;
    return { ...result, companion, memory: memory.stop() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('ny.pipeline_failed', { message });
    const entry: LedgerEntry = {
      at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod: discoveredRelease?.referencePeriod ?? 'unknown',
      releaseFingerprint: discoveredRelease?.releaseFingerprint ?? 'unknown', action: 'FAILED',
      publisherSha256: null, publisherBytes: null, bundleSha256: null, runId: null, runStatus: 'failed',
      normalizedDigest: null, estateDigest: null, note: message,
    };
    await ledger.append(entry).catch(() => {});
    throw error;
  } finally {
    memory.stop();
  }
}

async function locateRetainedArchive(
  options: Pick<NyPipelineOptions, 'artifactStore'>,
  referencePeriod: string,
  sha256: string,
  sourceId: string = NY_STATEWIDE_SOURCE_ID,
): Promise<ArchivedArtifact | null> {
  const dir = artifactDir(sourceId, referencePeriod, sha256);
  try {
    const manifest = await options.artifactStore.readManifest({ manifestPath: `${dir}/manifest.json` });
    const ext = manifest.originalFilename.slice(manifest.originalFilename.lastIndexOf('.')).toLowerCase();
    return {
      artifactId: `artifact_${sha256}`, sha256, byteLength: manifest.byteLength,
      storagePath: `${dir}/source-original${ext}`, manifestPath: `${dir}/manifest.json`, created: false, manifest,
    };
  } catch {
    return null;
  }
}

/**
 * Re-derives and re-ingests from the retained archive. Makes no network request:
 * nothing in this path holds a fetch, and the proof runs it inside a network
 * namespace with no interfaces.
 */
export async function replayNyFromArchive(
  options: Omit<NyPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'mode' | 'retainCompanion'> & {
    readonly publisherSha256: string;
    readonly referencePeriod: string;
  },
): Promise<NyPipelineResult> {
  const source = options.registry.source(NY_STATEWIDE_SOURCE_ID);
  const timings: Record<string, number> = {};
  const local = await locateRetainedArchive(options, options.referencePeriod, options.publisherSha256);
  let publisher = local;
  let rehydrateMs: number | null = null;
  if (publisher === null && options.durable) {
    const restored = await rehydrate(options.durable, options.artifactStore, options.publisherSha256);
    publisher = restored.artifact;
    rehydrateMs = restored.ms;
    timings['rehydrate'] = restored.ms;
  }
  if (publisher === null) {
    fail('REPLAY', 'no retained archive with that sha256 for that release, in the workspace or a durable store', {
      sha256: options.publisherSha256, referencePeriod: options.referencePeriod,
    });
  }
  const memory = memorySampler();
  try {
    const result = await deriveAndIngest(options, {
      discovered: null, plan: null, publisher, timings, memory,
      ledger: createAcquisitionLedger(options.varRoot, source.sourceId), action: 'REPLAYED',
      source: local ? 'workspace' : 'durable_store', rehydrateMs,
    });
    return { ...result, companion: null };
  } finally {
    memory.stop();
  }
}

// ---------------------------------------------------------------------------

type DeriveContext = {
  readonly discovered: NyDiscoveredRelease | null;
  readonly plan: AcquisitionPlan | null;
  readonly publisher: ArchivedArtifact;
  readonly timings: Record<string, number>;
  readonly memory: ReturnType<typeof memorySampler>;
  readonly ledger: ReturnType<typeof createAcquisitionLedger>;
  readonly action: 'ACQUIRED_AND_INGESTED' | 'REHYDRATED_AND_INGESTED' | 'REPLAYED';
  readonly source: NyDurability['source'];
  readonly rehydrateMs?: number | null;
};

async function deriveAndIngest(
  options: Omit<NyPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'mode' | 'retainCompanion'>,
  ctx: DeriveContext,
): Promise<NyPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: 'ny_statewide_parcels' });
  const source = options.registry.source(NY_STATEWIDE_SOURCE_ID);
  const { publisher, timings } = ctx;
  const referencePeriod = publisher.manifest.referencePeriod;

  // The archive is re-hashed before a byte of it is interpreted.
  let t = performance.now();
  await options.artifactStore.verify(publisher);
  timings['verify_archive'] = Math.round(performance.now() - t);

  // ---- durable commit: raw bytes before anything derived ---------------------
  // A replay is a reproducibility proof and must run with no network at all:
  // it may READ the durable store but never writes to it.
  const writesDurable = options.durable && ctx.action !== 'REPLAYED' && options.maxRows === undefined;
  let commit: DurableCommit | null = null;
  if (writesDurable && ctx.source !== 'durable_store') {
    t = performance.now();
    try {
      commit = await commitDurable(options.durable, options.artifactStore, publisher, {
        role: 'publisher_raw', contentType: 'application/zip', now: () => clock.now(),
      });
      logger.info('ny.durable', { sha256: commit.sha256, created: commit.created, key: commit.key });
    } catch (error) {
      if (options.durable.required) throw error;
      logger.warn('ny.durable_commit_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    timings['durable_commit'] = Math.round(performance.now() - t);
  }

  // ---- derive ----------------------------------------------------------------
  t = performance.now();
  const scratch = join(options.varRoot, 'scratch', `ny-derive-${Date.now().toString(36)}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  let derivation: NyBundleDerivation | null = null;
  const archivePath = options.artifactStore.localPath(publisher);
  const bundle = await options.artifactStore.archiveStream(
    {
      sourceAuthority: source.sourceAuthority,
      sourceProgram: source.sourceProgram,
      sourceFamily: source.sourceFamily,
      sourceId: source.sourceId,
      releaseId: publisher.manifest.releaseId,
      referencePeriod,
      originalUrl: null,
      originalFilename: NY_BUNDLE_FILENAME,
      // The archive's retrieval time, never now: the bundle must be a pure
      // function of the archive for replay to be a proof.
      retrievedAt: publisher.manifest.retrievedAt,
      effectiveAt: publisher.manifest.effectiveAt,
      jurisdictionIds: publisher.manifest.jurisdictionIds,
      access: publisher.manifest.access,
    },
    async (sink) => {
      const gz = gzipLineWriter(sink);
      derivation = await deriveNyBundle({
        archivePath,
        archiveSha256: publisher.sha256,
        archiveBytes: publisher.byteLength,
        archiveUrl: publisher.manifest.originalUrl,
        archiveFilename: publisher.manifest.originalFilename,
        retrievedAt: publisher.manifest.retrievedAt,
        referencePeriod,
        sourceId: source.sourceId,
        layerId: NY_CENTROID_LAYER_ID,
        scratchDir: scratch,
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      }, (line) => gz.write(line));
      await gz.close();
    },
  ).finally(() => rm(scratch, { recursive: true, force: true }));
  timings['derive'] = Math.round(performance.now() - t);
  const derived = derivation as NyBundleDerivation | null;
  if (derived === null) fail('CONFIG', 'bundle derivation produced no summary');
  logger.info('ny.derived', { bundleSha256: bundle.sha256, rows: derived.rowsWritten, bytes: bundle.byteLength });

  // ---- cross-check against the FeatureServer witness ---------------------------
  const crossCheck = ctx.discovered === null ? null : crossCheckOf(ctx.discovered, derived);
  if (crossCheck !== null && !crossCheck.agrees && options.maxRows === undefined) {
    // Before the checkpoint and before the runtime: a release the pipeline
    // would label failed must never become the live estate. The retained
    // archive stays; the ledger records FAILED under this fingerprint, so the
    // next tick plans the release again rather than trusting it.
    logger.error('ny.witness_disagrees', {
      archiveRows: crossCheck.archiveRows, serviceCount: crossCheck.serviceCount,
      schemaAgrees: crossCheck.schemaAgrees, releaseAgrees: crossCheck.releaseAgrees,
    });
    const entry: LedgerEntry = {
      at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod,
      releaseFingerprint: ctx.discovered?.releaseFingerprint ?? 'replay', action: 'FAILED',
      publisherSha256: publisher.sha256, publisherBytes: publisher.byteLength, bundleSha256: bundle.sha256,
      runId: null, runStatus: 'crosscheck_disagrees',
      normalizedDigest: null, estateDigest: null,
      note: `archive ${crossCheck.archiveRows} rows / schema ${crossCheck.archiveSchemaDigest.slice(0, 12)}, `
        + `FeatureServer witness ${crossCheck.serviceCount} / ${crossCheck.serviceSchemaDigest.slice(0, 12)}: nothing activated`,
    };
    await ctx.ledger.append(entry);
    return {
      outcome: 'FAILED', discovered: ctx.discovered, plan: ctx.plan, publisherArtifact: publisher, bundleArtifact: bundle,
      derivation: derived, crossCheck, counties: null, run: null, ledger: entry,
      durability: { source: ctx.source, commit, releaseRegistered: false, rehydrateMs: ctx.rehydrateMs ?? null, receiptKey: null },
      companion: null, timings, memory: ctx.memory.stop(),
    };
  }

  // ---- register the release, durably, before activation ------------------------
  let releaseRegistered = false;
  if (writesDurable && options.durable && ctx.discovered !== null && (commit !== null || ctx.source === 'durable_store')
    && (crossCheck === null || crossCheck.agrees)) {
    const mapping = options.registry.mapping(NY_STATEWIDE_MAPPING_ID);
    await registerRelease(options.durable, {
      recordVersion: 1,
      sourceId: source.sourceId,
      referencePeriod,
      releaseId: publisher.manifest.releaseId,
      releaseFingerprint: ctx.discovered.releaseFingerprint,
      publisherSha256: publisher.sha256,
      publisherBytes: publisher.byteLength,
      publisherUrl: publisher.manifest.originalUrl,
      publisherFilename: publisher.manifest.originalFilename,
      retrievedAt: publisher.manifest.retrievedAt,
      publicationAt: publisher.manifest.effectiveAt,
      schemaDigest: derived.sourceSchemaDigest,
      parserVersion: NY_STATEWIDE_PARSER_VERSION,
      normalizationContract: NORMALIZATION_CONTRACT_VERSION,
      acquisitionClass: source.acquisitionClass ?? 'UNKNOWN_AUTOMATION',
      termsStatus: source.termsStatus,
      licenseStatus: source.licenseStatus,
      jurisdictionIds: options.registry.expand(mapping).map((j) => j.jurisdictionId),
      finality: 'final',
    });
    releaseRegistered = true;
  }

  // ---- ingest ----------------------------------------------------------------
  // The runtime's own resume mechanism: a verified checkpoint naming the
  // derived bundle, so the run reads the retained artifact in place.
  await createCheckpointStore(options.varRoot).write({
    version: 1,
    sourceId: source.sourceId,
    referencePeriod,
    releaseId: bundle.manifest.releaseId,
    artifactId: bundle.artifactId,
    sha256: bundle.sha256,
    byteLength: bundle.byteLength,
    storagePath: bundle.storagePath,
    manifestPath: bundle.manifestPath,
    completedAt: clock.now().toISOString(),
  });

  t = performance.now();
  const run = await runStreamingConnector({
    registry: options.registry,
    connector: createNyStatewideParcelConnector({ referencePeriod }),
    mappingId: NY_STATEWIDE_MAPPING_ID,
    artifactStore: options.artifactStore,
    contactPlane: options.contactPlane,
    varRoot: options.varRoot,
    clock,
    logger: options.logger ?? silentLogger(),
    referencePeriod,
    resume: true,
    // A truncated smoke run proves the path end to end; it must never replace a
    // live index, write absence for the rows it did not read, or activate.
    dryRun: options.maxRows !== undefined,
    // A statewide release restates all 62 counties; only the ones whose
    // evidence moved are recomputed.
    skipUnchangedPartitions: true,
    ...(options.batch ? { batch: options.batch } : {}),
  });
  timings['ingest'] = Math.round(performance.now() - t);

  const counties = reconcileNyCounties(new Map(Object.entries(run.countyCounts)), derived.rowsByCountyName);
  const completed = run.run.status === 'completed' && (crossCheck === null || crossCheck.agrees || options.maxRows !== undefined);

  const entry: LedgerEntry = {
    at: clock.now().toISOString(),
    sourceId: source.sourceId,
    referencePeriod,
    releaseFingerprint: ctx.discovered?.releaseFingerprint ?? 'replay',
    action: !completed ? 'FAILED' : options.maxRows !== undefined ? 'TRUNCATED_SMOKE_RUN' : ctx.action,
    publisherSha256: publisher.sha256,
    publisherBytes: publisher.byteLength,
    bundleSha256: bundle.sha256,
    runId: run.run.runId,
    runStatus: completed ? run.run.status : `${run.run.status}${crossCheck?.agrees === false ? '+crosscheck_disagrees' : ''}`,
    normalizedDigest: run.run.normalizedDigest,
    estateDigest: run.globalDigest,
    note: ctx.plan?.action === 'ACQUIRE' ? ctx.plan.reason : null,
  };
  await ctx.ledger.append(entry);

  // A durable receipt, written before anything is reported.
  let receiptKey: string | null = null;
  if (writesDurable && options.durable) {
    const receipt = {
      receiptVersion: 1,
      ...entry,
      counts: {
        parsed: run.run.metrics.rowsParsed, accepted: run.run.metrics.rowsValid,
        quarantined: run.run.metrics.rowsQuarantined, duplicates: run.run.duplicateCount,
      },
      partitions: run.activations.map((a) => ({ partitionId: a.partitionId, state: a.state, generation: a.generation })),
    };
    const key = `${options.durable.prefix}/receipts/${source.sourceId}/${run.run.runId}/${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}.json`;
    try {
      await options.durable.backend.putJson(key, receipt);
      receiptKey = key;
    } catch (error) {
      if (options.durable.required) throw error;
      logger.warn('ny.durable_receipt_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    outcome: completed ? 'INGESTED' : 'FAILED',
    discovered: ctx.discovered,
    plan: ctx.plan,
    publisherArtifact: publisher,
    bundleArtifact: bundle,
    derivation: derived,
    crossCheck,
    counties,
    run,
    ledger: entry,
    durability: { source: ctx.source, commit, releaseRegistered, rehydrateMs: ctx.rehydrateMs ?? null, receiptKey },
    companion: null,
    timings,
    memory: ctx.memory.stop(),
  };
}

export function crossCheckOf(discovered: NyDiscoveredRelease, derived: NyBundleDerivation): NyCrossCheck {
  const geometryMetric = /^Shape_{1,2}(Area|Length)$/;
  const archiveFields = new Set(derived.fields.map((f) => f.name).filter((n) => !geometryMetric.test(n)));
  const serviceFields = new Set(discovered.witness.fields.map((f) => f.name).filter((n) => !geometryMetric.test(n)));
  const difference = derived.rowsWritten - discovered.witness.count;
  const countAgrees = difference === 0;
  // The service must be serving the schema the connector was pinned to, as the
  // archive is. A witness on another schema is not a witness to this release.
  const schemaAgrees = discovered.witness.fieldSetDigest === derived.sourceSchemaDigest
    && derived.sourceSchemaDigest === NY_PINNED_FIELD_SET_DIGEST;
  const releaseAgrees = discovered.witness.label !== null
    && discovered.witness.label.referencePeriod === derived.label.referencePeriod;
  return {
    archiveRows: derived.rowsWritten,
    serviceCount: discovered.witness.count,
    difference,
    // The release label is reported but not required: the publisher's own
    // metadata has been seen to lag (a GeoHub layer description still says
    // 2024 under a 2025 service title). Rows and schema are the hard checks.
    agrees: countAgrees && schemaAgrees,
    countAgrees,
    schemaAgrees,
    releaseAgrees,
    serviceUrl: discovered.witness.serviceUrl,
    serviceOnLegacyHost: discovered.witness.onLegacyHost,
    serviceLayerName: discovered.witness.layerName,
    archiveTable: derived.tableName,
    archiveGeodatabase: derived.geodatabase,
    serviceSchemaDigest: discovered.witness.fieldSetDigest,
    archiveSchemaDigest: derived.sourceSchemaDigest,
    onlyInService: [...serviceFields].filter((f) => !archiveFields.has(f)).sort(),
    onlyInArchive: [...archiveFields].filter((f) => !serviceFields.has(f)).sort(),
  };
}

// ---------------------------------------------------------------------------
// The polygon companion
// ---------------------------------------------------------------------------

type CompanionRecord = {
  readonly at: string;
  readonly releaseFingerprint: string;
  readonly referencePeriod: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
};

function companionRecordPath(varRoot: string): string {
  return join(varRoot, 'acquisition', `${NY_POLYGON_SOURCE_ID}.retained.ndjson`);
}

/**
 * Retains the public polygon archive as raw evidence: one GET into the
 * artifact store, sha256 on the way, under its own fingerprint — and a NOOP
 * when that fingerprint is already retained and still verifies.
 *
 * Never ingested: the same parcels are canonical through the centroids, and a
 * failure here is recorded, never allowed to undo the canonical ingest.
 */
async function retainCompanion(
  options: NyPipelineOptions,
  discovered: NyDiscoveredRelease,
  timings: Record<string, number>,
): Promise<NyCompanionRetention> {
  const clock = options.clock ?? systemClock;
  const none = { url: null, releaseFingerprint: null, referencePeriod: null, sha256: null, bytes: null, serviceCount: null };
  if (options.retainCompanion === false) return { status: 'SKIPPED', ...none, note: 'companion retention disabled' };
  const companion = discovered.companion;
  if (companion === null && discovered.companionError !== null) {
    return { status: 'FAILED', ...none, note: `polygon archive discovery failed: ${discovered.companionError}` };
  }
  if (companion === null) return { status: 'NOT_LINKED', ...none, note: 'the program page links no public polygon archive' };
  const referencePeriod = companion.label?.referencePeriod ?? discovered.referencePeriod;
  const base = {
    url: companion.url, releaseFingerprint: companion.releaseFingerprint, referencePeriod, serviceCount: companion.serviceCount,
  };
  const t = performance.now();
  try {
    const polygonSource = options.registry.source(NY_POLYGON_SOURCE_ID);
    if (polygonSource.automationStatus !== 'sanctioned') fail('CONFIG', `${NY_POLYGON_SOURCE_ID} is not sanctioned for automated retrieval`);
    const path = companionRecordPath(options.varRoot);
    const records = (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as CompanionRecord);
    const known = records.findLast((r) => r.releaseFingerprint === companion.releaseFingerprint);
    if (known !== undefined) {
      const retained = await locateRetainedArchive(options, known.referencePeriod, known.sha256, NY_POLYGON_SOURCE_ID);
      if (retained !== null) {
        await options.artifactStore.verify(retained);
        return { status: 'ALREADY_RETAINED', ...base, sha256: known.sha256, bytes: known.bytes, note: null };
      }
    }
    const download = await downloadArchive(
      { sourceId: NY_POLYGON_SOURCE_ID, referencePeriod, releaseFingerprint: companion.releaseFingerprint, head: companion.head },
      options.artifactStore,
      {
        sourceAuthority: polygonSource.sourceAuthority,
        sourceProgram: polygonSource.sourceProgram,
        sourceFamily: polygonSource.sourceFamily,
        sourceId: NY_POLYGON_SOURCE_ID,
        releaseId: `${NY_POLYGON_SOURCE_ID}__${referencePeriod}`,
        referencePeriod,
        originalFilename: companion.filename,
        retrievedAt: clock.now().toISOString(),
        effectiveAt: companion.head.lastModified === null ? null : new Date(companion.head.lastModified).toISOString(),
        // The publishing state. The archive covers the 38 counties that permit
        // redistribution; it is never expanded into coverage.
        jurisdictionIds: [stateJurisdictionId('NY')],
        access: accessOf(polygonSource),
      },
      options.http,
    );
    const record: CompanionRecord = {
      at: clock.now().toISOString(), releaseFingerprint: companion.releaseFingerprint, referencePeriod,
      sha256: download.artifact.sha256, bytes: download.artifact.byteLength, url: companion.url,
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${canonicalJson(record)}\n`, { mode: 0o600 });
    return { status: 'RETAINED', ...base, sha256: record.sha256, bytes: record.bytes, note: null };
  } catch (error) {
    return { status: 'FAILED', ...base, sha256: null, bytes: null, note: error instanceof Error ? error.message : String(error) };
  } finally {
    timings['companion'] = Math.round(performance.now() - t);
  }
}

function accessOf(source: ReturnType<Registry['source']>) {
  return {
    accessType: source.accessType,
    automationStatus: source.automationStatus,
    termsStatus: source.termsStatus,
    licenseStatus: source.licenseStatus,
    carriesRestrictedContact: source.carriesRestrictedContact,
  };
}

function memorySampler() {
  let peakHeapBytes = 0;
  let peakRssBytes = 0;
  let peakExternalBytes = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakHeapBytes = Math.max(peakHeapBytes, m.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, m.rss);
    peakExternalBytes = Math.max(peakExternalBytes, m.external);
  };
  const timer = setInterval(sample, 50);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return { peakHeapBytes, peakRssBytes, peakExternalBytes };
    },
  };
}
