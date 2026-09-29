/**
 * The unattended Florida DOR pipeline — one engine, three sources.
 *
 *   gate       the activation evaluator must return CORE_ELIGIBLE from registry
 *              facts alone, before any request leaves the machine
 *   discover   the PTO library's REST listing → the current roll, per county
 *   plan       ledger: this exact release (every file's URL, ETag, size, time)
 *              already ingested? → NOOP, stop
 *   acquire    one GET per county file into the artifact store; files already
 *              retained are reused; a release manifest pins the set
 *   derive     county files → one statewide snapshot bundle, from RETAINED bytes
 *   ingest     the streaming runtime; 67 county partitions activate independently
 *   record     ledger entry, so the next tick is a NOOP
 *
 * The three Florida sources differ only in what they list, how a county file
 * becomes bundle rows, and which connector reads the bundle. Everything else —
 * the gate, the ledger, the NOOP, the replay, the durability posture — is here
 * once. A replay names the release manifest's sha256 and touches no network.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ArchivedArtifact, StreamingArtifactStore } from '../../archive/artifact-store.ts';
import type { ContactPlane } from '../../contact/contact-plane.ts';
import { type Clock, systemClock } from '../../core/clock.ts';
import { fail } from '../../core/errors.ts';
import { type Logger, silentLogger } from '../../core/logging.ts';
import { assessActivation } from '../../registry/policy.ts';
import type { Registry } from '../../registry/registry.ts';
import {
  createAcquisitionLedger,
  type HttpDeps,
  type LedgerEntry,
} from '../../runtime/bulk-acquisition.ts';
import { createCheckpointStore } from '../../runtime/checkpoint.ts';
import type { StreamingConnector } from '../../runtime/connector.ts';
import { runStreamingConnector, type BatchConfiguration, type StreamRunResult } from '../../runtime/stream-run.ts';
import {
  acquireFlRelease,
  accessOfSource,
  locateArtifact,
  readReleaseManifest,
  type FlAcquisition,
  type FlReleaseManifest,
  type FlReleaseManifestFile,
} from './acquire.ts';
import type { FlRollRelease } from './portal.ts';

/** What a derivation hands the pipeline besides the bundle lines. */
export type FlDerivationSummary = {
  readonly rowsWritten: number;
  readonly sourceSchemaDigest: string;
  /** Rows per county file, keyed by the file's sha256. */
  readonly rowsByFile: Readonly<Record<string, number>>;
  /** Anything the deriver measured that a report should carry. */
  readonly facts: Readonly<Record<string, unknown>>;
};

export type FlDeriveInput = {
  readonly manifest: FlReleaseManifest;
  /** In release-manifest order. */
  readonly files: readonly { readonly entry: FlReleaseManifestFile; readonly artifact: ArchivedArtifact }[];
  readonly artifactStore: StreamingArtifactStore;
  readonly scratchDir: string;
  readonly maxRows?: number;
};

/** One Florida source, as the engine sees it. */
export type FlSourceSpec = {
  readonly sourceId: string;
  readonly mappingId: string;
  readonly kind: FlRollRelease['kind'];
  discover(http: HttpDeps): Promise<FlRollRelease>;
  derive(input: FlDeriveInput, write: (line: string) => Promise<void>): Promise<FlDerivationSummary>;
  connector(referencePeriod: string): StreamingConnector;
  /** The bundle's own filename in the artifact store. */
  readonly bundleFilename: string;
};

export type FlPipelineOptions = {
  readonly registry: Registry;
  readonly artifactStore: StreamingArtifactStore;
  readonly contactPlane: ContactPlane;
  readonly varRoot: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly http?: HttpDeps;
  /** `scheduled` (default): an already-ingested release is a NOOP. `force`: ingest again from retained bytes. */
  readonly mode?: 'scheduled' | 'force';
  readonly discoverOnly?: boolean;
  /** Acquire and pin the release, then stop — no derivation, no ledger entry. */
  readonly acquireOnly?: boolean;
  /** Injected discovery, for tests and for simulating a changed release. */
  readonly discovered?: FlRollRelease;
  readonly batch?: Partial<BatchConfiguration>;
  /** Smoke runs: read this many rows, activate nothing, record TRUNCATED_SMOKE_RUN. */
  readonly maxRows?: number;
  /** A dry run computes every change count and writes nothing: the idempotency probe. */
  readonly dryRun?: boolean;
};

export type FlPipelineResult = {
  readonly outcome: 'NOOP' | 'DISCOVERED' | 'ACQUIRED' | 'INGESTED' | 'DRY_RUN' | 'FAILED';
  readonly release: FlRollRelease | null;
  readonly acquisition: FlAcquisition | null;
  readonly manifestArtifact: ArchivedArtifact | null;
  readonly bundleArtifact: ArchivedArtifact | null;
  readonly derivation: FlDerivationSummary | null;
  readonly run: StreamRunResult | null;
  readonly ledger: LedgerEntry | null;
  readonly timings: Readonly<Record<string, number>>;
  readonly memory: { readonly peakHeapBytes: number; readonly peakRssBytes: number; readonly peakExternalBytes: number };
};

export async function runFlPipeline(spec: FlSourceSpec, options: FlPipelineOptions): Promise<FlPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: spec.sourceId });
  const source = options.registry.source(spec.sourceId);
  const ledger = createAcquisitionLedger(options.varRoot, source.sourceId);
  const timings: Record<string, number> = {};
  const memory = memorySampler();
  let release: FlRollRelease | null = options.discovered ?? null;
  const empty = { acquisition: null, manifestArtifact: null, bundleArtifact: null, derivation: null, run: null };

  try {
    const gate = assessActivation(source);
    if (gate.verdict !== 'CORE_ELIGIBLE') {
      fail('CONFIG', `refusing unattended acquisition: ${source.sourceId} is ${gate.verdict}`, { reason: gate.reason });
    }

    let t = performance.now();
    release = options.discovered ?? await spec.discover(options.http ?? {});
    timings['discover'] = Math.round(performance.now() - t);
    logger.info('fl.discovered', {
      kind: release.kind, rollYear: release.rollYear, files: release.files.length,
      stages: release.stageCounts, fingerprint: release.releaseFingerprint,
    });
    if (release.missingCounties.length > 0) {
      logger.warn('fl.counties_missing', { missing: release.missingCounties });
    }

    const previous = await ledger.completedFor(release.releaseFingerprint);
    if (options.discoverOnly) {
      return { outcome: 'DISCOVERED', release, ...empty, ledger: null, timings, memory: memory.stop() };
    }
    if (previous !== null && (options.mode ?? 'scheduled') === 'scheduled' && !options.acquireOnly) {
      const entry: LedgerEntry = {
        at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod: release.referencePeriod,
        releaseFingerprint: release.releaseFingerprint, action: 'NOOP_SAME_RELEASE',
        publisherSha256: previous.publisherSha256, publisherBytes: previous.publisherBytes,
        bundleSha256: previous.bundleSha256, runId: previous.runId, runStatus: null,
        normalizedDigest: null, estateDigest: null,
        note: `release ${release.referencePeriod} (fingerprint ${release.releaseFingerprint.slice(0, 12)}) was already ingested by run ${previous.runId ?? '?'}`,
      };
      await ledger.append(entry);
      logger.info('fl.noop', { fingerprint: release.releaseFingerprint });
      return { outcome: 'NOOP', release, ...empty, ledger: entry, timings, memory: memory.stop() };
    }

    t = performance.now();
    const acquisition = await acquireFlRelease({
      release, source, artifactStore: options.artifactStore, varRoot: options.varRoot,
      now: () => clock.now(), ...(options.http ? { http: options.http } : {}), logger,
    });
    timings['acquire'] = Math.round(performance.now() - t);
    logger.info('fl.acquired', {
      files: acquisition.files.length, reused: acquisition.files.filter((f) => f.reused).length,
      downloadedBytes: acquisition.downloadedBytes, manifest: acquisition.manifestArtifact.sha256,
    });
    if (options.acquireOnly) {
      return {
        outcome: 'ACQUIRED', release, ...empty, acquisition, manifestArtifact: acquisition.manifestArtifact,
        ledger: null, timings, memory: memory.stop(),
      };
    }

    return await deriveAndIngest(spec, options, {
      manifest: acquisition.manifest, manifestArtifact: acquisition.manifestArtifact,
      files: acquisition.files.map((f) => ({ entry: f.entry, artifact: f.artifact })),
      release, acquisition, timings, memory,
      action: previous !== null ? 'REPLAYED' : 'ACQUIRED_AND_INGESTED',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('fl.pipeline_failed', { message });
    await ledger.append({
      at: clock.now().toISOString(), sourceId: source.sourceId, referencePeriod: release?.referencePeriod ?? 'unknown',
      releaseFingerprint: release?.releaseFingerprint ?? 'unknown', action: 'FAILED',
      publisherSha256: null, publisherBytes: null, bundleSha256: null, runId: null, runStatus: 'failed',
      normalizedDigest: null, estateDigest: null, note: message,
    }).catch(() => {});
    throw error;
  } finally {
    memory.stop();
  }
}

/**
 * Re-derives and re-ingests a release from retained bytes alone, named by its
 * release manifest's sha256. Holds no fetch: the certification runs it inside
 * a network namespace with no interfaces.
 */
export async function replayFlRelease(
  spec: FlSourceSpec,
  options: Omit<FlPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'acquireOnly' | 'mode'> & {
    readonly releaseManifestSha256: string;
    readonly referencePeriod: string;
  },
): Promise<FlPipelineResult> {
  const memory = memorySampler();
  try {
    const manifestArtifact = await locateArtifact(options.artifactStore, spec.sourceId, options.referencePeriod, options.releaseManifestSha256);
    if (manifestArtifact === null) {
      fail('REPLAY', 'no retained release manifest with that sha256 for that period', {
        sha256: options.releaseManifestSha256, referencePeriod: options.referencePeriod,
      });
    }
    await options.artifactStore.verify(manifestArtifact);
    const manifest = await readReleaseManifest(options.artifactStore, manifestArtifact);
    const files: { entry: FlReleaseManifestFile; artifact: ArchivedArtifact }[] = [];
    for (const entry of manifest.files) {
      const artifact = await locateArtifact(options.artifactStore, spec.sourceId, manifest.referencePeriod, entry.sha256);
      if (artifact === null) {
        fail('REPLAY', `the release names ${entry.name} (${entry.sha256.slice(0, 12)}…), which is not retained`, {
          remedy: 'reacquire it from the publisher; only an equal sha256 restores it',
        });
      }
      files.push({ entry, artifact });
    }
    return await deriveAndIngest(spec, options, {
      manifest, manifestArtifact, files, release: null, acquisition: null, timings: {}, memory, action: 'REPLAYED',
    });
  } finally {
    memory.stop();
  }
}

type IngestContext = {
  readonly manifest: FlReleaseManifest;
  readonly manifestArtifact: ArchivedArtifact;
  readonly files: readonly { readonly entry: FlReleaseManifestFile; readonly artifact: ArchivedArtifact }[];
  readonly release: FlRollRelease | null;
  readonly acquisition: FlAcquisition | null;
  readonly timings: Record<string, number>;
  readonly memory: ReturnType<typeof memorySampler>;
  readonly action: LedgerEntry['action'];
};

async function deriveAndIngest(
  spec: FlSourceSpec,
  options: Omit<FlPipelineOptions, 'http' | 'discovered' | 'discoverOnly' | 'acquireOnly' | 'mode'>,
  ctx: IngestContext,
): Promise<FlPipelineResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({ pipeline: spec.sourceId });
  const source = options.registry.source(spec.sourceId);
  const ledger = createAcquisitionLedger(options.varRoot, source.sourceId);
  const { manifest, timings } = ctx;

  // Every county file is re-hashed before a byte of it is interpreted.
  let t = performance.now();
  for (const f of ctx.files) await options.artifactStore.verify(f.artifact);
  timings['verify'] = Math.round(performance.now() - t);

  // ---- derive: county files → one statewide bundle, a pure function of them ----
  t = performance.now();
  const scratch = join(options.varRoot, 'scratch', `fl-derive-${Date.now().toString(36)}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  let derivation: FlDerivationSummary | null = null;
  const bundle = await options.artifactStore.archiveStream(
    {
      sourceAuthority: source.sourceAuthority,
      sourceProgram: source.sourceProgram,
      sourceFamily: source.sourceFamily,
      sourceId: source.sourceId,
      releaseId: `${source.sourceId}__${manifest.referencePeriod}`,
      referencePeriod: manifest.referencePeriod,
      originalUrl: null,
      originalFilename: spec.bundleFilename,
      // The release manifest's retrieval instant, never "now": the bundle must
      // be a pure function of retained evidence for a replay to be a proof.
      retrievedAt: ctx.manifestArtifact.manifest.retrievedAt,
      effectiveAt: null,
      jurisdictionIds: ctx.manifestArtifact.manifest.jurisdictionIds,
      access: accessOfSource(source),
    },
    async (sink) => {
      derivation = await spec.derive({
        manifest, files: ctx.files, artifactStore: options.artifactStore, scratchDir: scratch,
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      }, (line) => sink.write(`${line}\n`));
    },
  ).finally(() => rm(scratch, { recursive: true, force: true }));
  timings['derive'] = Math.round(performance.now() - t);
  const derived = derivation as FlDerivationSummary | null;
  if (derived === null) fail('CONFIG', 'bundle derivation produced no summary');
  logger.info('fl.derived', { bundle: bundle.sha256, rows: derived.rowsWritten });

  // ---- ingest ---------------------------------------------------------------
  await createCheckpointStore(options.varRoot).write({
    version: 1,
    sourceId: source.sourceId,
    referencePeriod: manifest.referencePeriod,
    releaseId: bundle.manifest.releaseId,
    artifactId: bundle.artifactId,
    sha256: bundle.sha256,
    byteLength: bundle.byteLength,
    storagePath: bundle.storagePath,
    manifestPath: bundle.manifestPath,
    completedAt: clock.now().toISOString(),
  });
  const dryRun = options.dryRun === true || options.maxRows !== undefined;
  t = performance.now();
  const run = await runStreamingConnector({
    registry: options.registry,
    connector: spec.connector(manifest.referencePeriod),
    mappingId: spec.mappingId,
    artifactStore: options.artifactStore,
    contactPlane: options.contactPlane,
    varRoot: options.varRoot,
    clock,
    logger: options.logger ?? silentLogger(),
    referencePeriod: manifest.referencePeriod,
    resume: true,
    // A truncated smoke run or an idempotency probe computes everything and
    // replaces nothing: no live index, no absence, no activation.
    dryRun,
    // A statewide roll restates every county; only the ones whose evidence
    // moved are recomputed.
    skipUnchangedPartitions: true,
    ...(options.batch ? { batch: options.batch } : {}),
  });
  timings['ingest'] = Math.round(performance.now() - t);

  const completed = run.run.status === 'completed';
  const action: LedgerEntry['action'] = !completed ? 'FAILED'
    : options.maxRows !== undefined ? 'TRUNCATED_SMOKE_RUN'
    : ctx.action;
  const entry: LedgerEntry = {
    at: clock.now().toISOString(),
    sourceId: source.sourceId,
    referencePeriod: manifest.referencePeriod,
    releaseFingerprint: manifest.releaseFingerprint,
    action,
    // The release manifest names every county file; its digest pins them all.
    publisherSha256: ctx.manifestArtifact.sha256,
    publisherBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    bundleSha256: bundle.sha256,
    runId: run.run.runId,
    runStatus: run.run.status,
    normalizedDigest: run.run.normalizedDigest,
    estateDigest: run.globalDigest,
    note: options.dryRun ? 'dry run: nothing written' : null,
  };
  // A dry run proves idempotency; it must not be mistaken for an ingestion.
  if (!options.dryRun) await ledger.append(entry);

  return {
    outcome: options.dryRun ? 'DRY_RUN' : completed ? 'INGESTED' : 'FAILED',
    release: ctx.release,
    acquisition: ctx.acquisition,
    manifestArtifact: ctx.manifestArtifact,
    bundleArtifact: bundle,
    derivation: derived,
    run,
    ledger: entry,
    timings,
    memory: ctx.memory.stop(),
  };
}

export function memorySampler() {
  let peakHeapBytes = 0;
  let peakRssBytes = 0;
  let peakExternalBytes = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakHeapBytes = Math.max(peakHeapBytes, m.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, m.rss);
    peakExternalBytes = Math.max(peakExternalBytes, m.external + m.arrayBuffers);
  };
  sample();
  const timer = setInterval(sample, 250);
  timer.unref();
  let stopped: { peakHeapBytes: number; peakRssBytes: number; peakExternalBytes: number } | null = null;
  return {
    stop() {
      if (stopped === null) {
        sample();
        clearInterval(timer);
        stopped = { peakHeapBytes, peakRssBytes, peakExternalBytes };
      }
      return stopped;
    },
  };
}
