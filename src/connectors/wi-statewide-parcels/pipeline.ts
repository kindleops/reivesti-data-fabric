/**
 * The unattended Wisconsin statewide parcel pipeline.
 *
 * What a scheduler runs, start to finish, with nobody present:
 *
 *   gate       the activation evaluator must say CORE_ELIGIBLE, from registry
 *              facts alone, before any request leaves the machine
 *   discover   landing page → newest archive → HEAD; FeatureServer → witness
 *   plan       ledger: this exact release already ingested? → NOOP, stop
 *   acquire    one GET, streamed into the artifact store, sha256 on the way
 *   derive     archive → geodatabase → snapshot bundle, from the RETAINED bytes
 *   ingest     the streaming runtime: parse, route, normalise, emit, project,
 *              activate 72 county partitions independently
 *   record     ledger entry, so the next tick is a NOOP
 *
 * No inbox, no operator download, no file moved by hand. The only inputs are
 * the registry and the network, and the network is touched only by `discover`
 * and `acquire`. `replayFromArchive` runs every later step with no network at
 * all, from the retained archive.
 */
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { artifactDir, type ArchivedArtifact, type StreamingArtifactStore } from '../../archive/artifact-store.ts';
import type { ContactPlane } from '../../contact/contact-plane.ts';
import { type Clock, systemClock } from '../../core/clock.ts';
import { fail } from '../../core/errors.ts';
import { type Logger, silentLogger } from '../../core/logging.ts';
import { assessActivation } from '../../registry/policy.ts';
import type { Registry } from '../../registry/registry.ts';
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
import { deriveWiBundle, type BundleDerivation } from './bundle.ts';
import {
  commitDurable,
  findRelease,
  registerRelease,
  rehydrate,
  type DurableCommit,
  type DurableStore,
} from '../../archive/durable-artifacts.ts';
import { NORMALIZATION_CONTRACT_VERSION } from '../../canonical/normalization-contract.ts';
import { WI_STATEWIDE_PARSER_VERSION } from './index.ts';
import { reconcileWiCounties, type CountyReconciliation } from './counties.ts';
import {
  WI_PINNED_REFERENCE_PERIOD,
  WI_STATEWIDE_SOURCE_ID,
  createWiStatewideParcelConnector,
} from './index.ts';
import { discoverWiRelease, WI_FEATURE_LAYER_ID, WI_FEATURE_SERVICE_URL, type WiDiscoveredRelease } from './release.ts';

export const WI_STATEWIDE_MAPPING_ID = 'wi_statewide_parcels__all_wi_counties';

export type WiPipelineOptions = {
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
  readonly discovered?: WiDiscoveredRelease;
  readonly batch?: Partial<BatchConfiguration>;
  /** Fixture runs only. */
  readonly maxRows?: number;
  /**
   * The durable artifact store. When present, raw publisher bytes are made
   * durable and verified BEFORE anything is derived or activated, the release
   * is registered there, and a worker that finds the release already durable
   * rehydrates it instead of asking the publisher again. When it is `required`
   * and the commit fails, nothing is activated.
   */
  readonly durable?: DurableStore | null;
};

/** How this run's raw bytes were obtained and kept. */
export type WiDurability = {
  /** Where the raw archive came from for this run. */
  readonly source: 'publisher' | 'workspace' | 'durable_store';
  readonly commit: DurableCommit | null;
  readonly releaseRegistered: boolean;
  readonly rehydrateMs: number | null;
  readonly receiptKey: string | null;
};

export type WiCrossCheck = {
  readonly archiveRows: number;
  readonly serviceCount: number;
  readonly difference: number;
  /** A material disagreement blocks COMPLETE status. Zero tolerance for V12. */
  readonly agrees: boolean;
  readonly serviceLayerName: string;
  readonly archiveTable: string;
  readonly serviceMatchesArchive: boolean;
  /** Attribute columns present in one path and not the other, excluding geometry metrics. */
  readonly onlyInService: readonly string[];
  readonly onlyInArchive: readonly string[];
};

export type WiPipelineResult = {
  readonly outcome: 'NOOP' | 'DISCOVERED' | 'INGESTED' | 'FAILED';
  readonly discovered: WiDiscoveredRelease | null;
  readonly plan: AcquisitionPlan | null;
  readonly publisherArtifact: ArchivedArtifact | null;
  readonly bundleArtifact: ArchivedArtifact | null;
  readonly derivation: BundleDerivation | null;
  readonly crossCheck: WiCrossCheck | null;
  readonly counties: CountyReconciliation | null;
  readonly run: StreamRunResult | null;
  readonly ledger: LedgerEntry | null;
  readonly durability: WiDurability | null;
  readonly timings: Readonly<Record<string, number>>;
  readonly memory: { readonly peakHeapBytes: number; readonly peakRssBytes: number; readonly peakExternalBytes: number };
};

/** Discover → plan → (NOOP | acquire → derive → ingest) → record. */
export async function runWiStatewidePipeline(options: WiPipelineOptions): Promise<WiPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: 'wi_statewide_parcels' });
  const source = options.registry.source(WI_STATEWIDE_SOURCE_ID);
  const ledger = createAcquisitionLedger(options.varRoot, source.sourceId);
  const timings: Record<string, number> = {};
  const memory = memorySampler();

  try {
    // ---- gate: before any network --------------------------------------------
    const gate = assessActivation(source);
    if (gate.verdict !== 'CORE_ELIGIBLE') {
      fail('CONFIG', `refusing unattended acquisition: ${source.sourceId} is ${gate.verdict}`, { reason: gate.reason });
    }

    // ---- discover ------------------------------------------------------------
    let t = performance.now();
    const discovered = options.discovered ?? await discoverWiRelease(options.http);
    timings['discover'] = Math.round(performance.now() - t);
    logger.info('wi.discovered', {
      release: discovered.referencePeriod, fingerprint: discovered.releaseFingerprint,
      bytes: discovered.head.contentLength, serviceCount: discovered.witness.count,
    });

    // ---- plan ----------------------------------------------------------------
    const plan = await planAcquisition(discovered, ledger, WI_PINNED_REFERENCE_PERIOD);
    const empty = {
      publisherArtifact: null, bundleArtifact: null, derivation: null, crossCheck: null,
      counties: null, run: null,
    };
    if (options.discoverOnly) {
      return { outcome: 'DISCOVERED', discovered, plan, ...empty, ledger: null, durability: null, timings, memory: memory.stop() };
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
      logger.info('wi.noop', { reason: plan.reason });
      return { outcome: 'NOOP', discovered, plan, ...empty, ledger: entry, durability: null, timings, memory: memory.stop() };
    }

    if (plan.action === 'NOOP' && plan.previous.publisherSha256 !== null) {
      // Forced, and this exact release is already retained: re-ingest from the
      // archive we hold. Forcing is a statement about OUR pipeline; it is no
      // reason to make the publisher serve 760 MB again.
      const retained = await locateRetainedArchive(options, discovered.referencePeriod, plan.previous.publisherSha256);
      if (retained !== null) {
        logger.info('wi.force_from_retained', { sha256: retained.sha256 });
        return await deriveAndIngest(options, {
          discovered, plan, publisher: retained, timings, memory, ledger, action: 'REPLAYED', source: 'workspace',
        });
      }
    }

    // ---- durable store: this exact release may already be kept ------------------
    // A fresh worker has an empty ledger and an empty workspace. If the durable
    // store holds a release record for this fingerprint, its bytes are fetched
    // from there by digest — the publisher is not asked again.
    if (options.durable) {
      const known = await findRelease(options.durable, source.sourceId, discovered.referencePeriod, discovered.releaseFingerprint);
      if (known !== null) {
        t = performance.now();
        const local = await locateRetainedArchive(options, known.referencePeriod, known.publisherSha256);
        const restored = local ?? (await rehydrate(options.durable, options.artifactStore, known.publisherSha256)).artifact;
        timings['rehydrate'] = Math.round(performance.now() - t);
        logger.info('wi.rehydrated', { sha256: restored.sha256, from: local ? 'workspace' : 'durable_store' });
        return await deriveAndIngest(options, {
          discovered, plan, publisher: restored, timings, memory, ledger, action: 'REHYDRATED_AND_INGESTED',
          source: local ? 'workspace' : 'durable_store', rehydrateMs: local ? null : timings['rehydrate'] ?? null,
        });
      }
    }

    // ---- acquire ---------------------------------------------------------------
    t = performance.now();
    const mapping = options.registry.mapping(WI_STATEWIDE_MAPPING_ID);
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
    logger.info('wi.acquired', {
      sha256: download.artifact.sha256, bytes: download.artifact.byteLength, deduped: !download.artifact.created,
    });

    return await deriveAndIngest(options, {
      discovered, plan, publisher: download.artifact, timings, memory, ledger,
      action: 'ACQUIRED_AND_INGESTED', source: 'publisher',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('wi.pipeline_failed', { message });
    const entry: LedgerEntry = {
      at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod: options.discovered?.referencePeriod ?? 'unknown',
      releaseFingerprint: options.discovered?.releaseFingerprint ?? 'unknown', action: 'FAILED',
      publisherSha256: null, publisherBytes: null, bundleSha256: null, runId: null, runStatus: 'failed',
      normalizedDigest: null, estateDigest: null, note: message,
    };
    await ledger.append(entry).catch(() => {});
    throw error;
  } finally {
    memory.stop();
  }
}

/**
 * Re-derives and re-ingests from the retained archive. Makes no network request:
 * nothing in this path holds a fetch, and the proof runs it inside a network
 * namespace with no interfaces.
 */
async function locateRetainedArchive(
  options: Pick<WiPipelineOptions, 'artifactStore'>,
  referencePeriod: string,
  sha256: string,
): Promise<ArchivedArtifact | null> {
  const dir = artifactDir(WI_STATEWIDE_SOURCE_ID, referencePeriod, sha256);
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

export async function replayWiFromArchive(
  options: Omit<WiPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'mode'> & {
    readonly publisherSha256: string;
    readonly referencePeriod: string;
  },
): Promise<WiPipelineResult> {
  const source = options.registry.source(WI_STATEWIDE_SOURCE_ID);
  const timings: Record<string, number> = {};
  const local = await locateRetainedArchive(options, options.referencePeriod, options.publisherSha256);
  let publisher = local;
  let rehydrateMs: number | null = null;
  if (publisher === null && options.durable) {
    // A fresh machine: the workspace is empty, the bytes are in the durable store.
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
    return await deriveAndIngest(options, {
      discovered: null, plan: null, publisher, timings, memory,
      ledger: createAcquisitionLedger(options.varRoot, source.sourceId), action: 'REPLAYED',
      source: local ? 'workspace' : 'durable_store', rehydrateMs,
    });
  } finally {
    memory.stop();
  }
}

// ---------------------------------------------------------------------------

type DeriveContext = {
  readonly discovered: WiDiscoveredRelease | null;
  readonly plan: AcquisitionPlan | null;
  readonly publisher: ArchivedArtifact;
  readonly timings: Record<string, number>;
  readonly memory: ReturnType<typeof memorySampler>;
  readonly ledger: ReturnType<typeof createAcquisitionLedger>;
  readonly action: 'ACQUIRED_AND_INGESTED' | 'REHYDRATED_AND_INGESTED' | 'REPLAYED';
  readonly source: WiDurability['source'];
  readonly rehydrateMs?: number | null;
};

async function deriveAndIngest(
  options: Omit<WiPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'mode'>,
  ctx: DeriveContext,
): Promise<WiPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: 'wi_statewide_parcels' });
  const source = options.registry.source(WI_STATEWIDE_SOURCE_ID);
  const { publisher, timings } = ctx;
  const referencePeriod = publisher.manifest.referencePeriod;

  // The archive is re-hashed before a byte of it is interpreted.
  let t = performance.now();
  await options.artifactStore.verify(publisher);
  timings['verify_archive'] = Math.round(performance.now() - t);

  // ---- durable commit: raw bytes before anything derived ---------------------
  // Priority one is the publisher's exact archive. It becomes DURABLE (uploaded,
  // re-read, re-hashed) and REGISTERED before a row is derived or a partition
  // activated. Bytes that just came FROM the durable store are already there.
  let commit: DurableCommit | null = null;
  if (options.durable && ctx.source !== 'durable_store' && options.maxRows === undefined) {
    t = performance.now();
    commit = await commitDurable(options.durable, options.artifactStore, publisher, {
      role: 'publisher_raw', contentType: 'application/zip', now: () => clock.now(),
    });
    timings['durable_commit'] = Math.round(performance.now() - t);
    logger.info('wi.durable', { sha256: commit.sha256, created: commit.created, key: commit.key });
  }

  // ---- derive ----------------------------------------------------------------
  t = performance.now();
  const scratch = join(options.varRoot, 'scratch', `wi-derive-${Date.now().toString(36)}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  let derivation: BundleDerivation | null = null;
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
      originalFilename: 'wi-statewide-parcels.bundle.ndjson',
      // The archive's retrieval time, never now: the bundle must be a pure
      // function of the archive for replay to be a proof.
      retrievedAt: publisher.manifest.retrievedAt,
      effectiveAt: publisher.manifest.effectiveAt,
      jurisdictionIds: publisher.manifest.jurisdictionIds,
      access: publisher.manifest.access,
    },
    async (sink) => {
      derivation = await deriveWiBundle({
        archivePath,
        archiveSha256: publisher.sha256,
        archiveBytes: publisher.byteLength,
        archiveUrl: publisher.manifest.originalUrl,
        archiveFilename: publisher.manifest.originalFilename,
        retrievedAt: publisher.manifest.retrievedAt,
        referencePeriod,
        sourceId: source.sourceId,
        serviceUrl: WI_FEATURE_SERVICE_URL,
        layerId: WI_FEATURE_LAYER_ID,
        scratchDir: scratch,
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      }, (line) => sink.write(`${line}\n`));
    },
  ).finally(() => rm(scratch, { recursive: true, force: true }));
  timings['derive'] = Math.round(performance.now() - t);
  const derived = derivation as BundleDerivation | null;
  if (derived === null) fail('CONFIG', 'bundle derivation produced no summary');
  logger.info('wi.derived', { bundleSha256: bundle.sha256, rows: derived.rowsWritten });

  // ---- cross-check against the FeatureServer witness ---------------------------
  const crossCheck = ctx.discovered === null ? null : crossCheckOf(ctx.discovered, derived);

  // ---- register the release, durably, before activation ------------------------
  let releaseRegistered = false;
  if (options.durable && ctx.discovered !== null && options.maxRows === undefined
    && (crossCheck === null || crossCheck.agrees)) {
    const mapping = options.registry.mapping(WI_STATEWIDE_MAPPING_ID);
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
      parserVersion: WI_STATEWIDE_PARSER_VERSION,
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
  // derived bundle, so the run reads the retained artifact in place rather than
  // copying 3 GB through a second staging pass.
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
    connector: createWiStatewideParcelConnector({ referencePeriod }),
    mappingId: WI_STATEWIDE_MAPPING_ID,
    artifactStore: options.artifactStore,
    contactPlane: options.contactPlane,
    varRoot: options.varRoot,
    clock,
    logger: options.logger ?? silentLogger(),
    referencePeriod,
    resume: true,
    // A statewide release restates all 72 counties; only the ones whose
    // evidence moved are recomputed.
    skipUnchangedPartitions: true,
    ...(options.batch ? { batch: options.batch } : {}),
  });
  timings['ingest'] = Math.round(performance.now() - t);

  const counties = reconcileWiCounties(new Map(Object.entries(run.countyCounts)));
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
  // A replay proves reproducibility; it must not make a later scheduled tick
  // believe a release was acquired that the ledger never saw acquired.
  await ctx.ledger.append(entry);

  // A durable receipt, written before anything is reported: if this machine
  // vanishes now, what happened — inputs, counts, digests — is still known.
  let receiptKey: string | null = null;
  if (options.durable && options.maxRows === undefined) {
    const receipt = {
      receiptVersion: 1,
      ...entry,
      counts: {
        parsed: run.run.metrics.rowsParsed, accepted: run.run.metrics.rowsValid,
        quarantined: run.run.metrics.rowsQuarantined, duplicates: run.run.duplicateCount,
      },
      partitions: run.activations.map((a) => ({ partitionId: a.partitionId, state: a.state, generation: a.generation })),
    };
    receiptKey = `${options.durable.prefix}/receipts/${source.sourceId}/${run.run.runId}/${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}.json`;
    await options.durable.backend.putJson(receiptKey, receipt);
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
    durability: {
      source: ctx.source, commit, releaseRegistered, rehydrateMs: ctx.rehydrateMs ?? null, receiptKey,
    },
    timings,
    memory: ctx.memory.stop(),
  };
}

function crossCheckOf(discovered: WiDiscoveredRelease, derived: BundleDerivation): WiCrossCheck {
  const geometryMetric = /^Shape_{1,2}(Area|Length)$/;
  const archiveFields = new Set(derived.fields.map((f) => f.name).filter((n) => !geometryMetric.test(n)));
  const serviceFields = new Set(discovered.witness.fields.map((f) => f.name).filter((n) => !geometryMetric.test(n)));
  const difference = derived.rowsWritten - discovered.witness.count;
  return {
    archiveRows: derived.rowsWritten,
    serviceCount: discovered.witness.count,
    difference,
    agrees: difference === 0,
    serviceLayerName: discovered.witness.layerName,
    archiveTable: derived.tableName,
    serviceMatchesArchive: discovered.serviceMatchesArchive && discovered.witness.layerName === derived.tableName,
    onlyInService: [...serviceFields].filter((f) => !archiveFields.has(f)).sort(),
    onlyInArchive: [...archiveFields].filter((f) => !serviceFields.has(f)).sort(),
  };
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
