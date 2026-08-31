/**
 * The streaming connector runtime.
 *
 * Same seven stages as the buffered runtime, same guarantees, bounded memory.
 * Nothing about the pipeline's meaning changes; what changes is that no stage
 * ever holds the dataset.
 *
 *   acquire     transport writes straight into a staged, digested artifact
 *   parse       one line at a time, one record at a time
 *   classify    against a fixed-width binary key index, not a Map of strings
 *   normalize   per record, released immediately after it is written
 *   persist     appended to a staged generation, activated by one atomic rename
 *   project     resolution folded by external sort, not by loading the estate
 *
 * Two invariants are load-bearing and are asserted in tests rather than assumed:
 *
 *  - Batch size changes nothing. Ids, digests and output are identical at batch
 *    size 1 and 5,000, because nothing is derived from batch membership.
 *  - A crash cannot activate a partial estate. Canonical rows go to a new
 *    generation directory; only a successful commit swaps the CURRENT pointer.
 */
import { performance } from 'node:perf_hooks';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchivedArtifact, StreamingArtifactStore } from '../archive/artifact-store.ts';
import type { CanonicalBundle, PropertyIdentifierObservation, SourceEvidence } from '../canonical/models.ts';
import {
  type PropertyConflict,
  type PropertyResolution,
  parcelAuthorityFor,
} from '../canonical/property-resolution.ts';
import { contributionOf, projectResolutions } from '../canonical/resolution-projection.ts';
import {
  SnapshotIndexBuilder,
  type SnapshotIndex,
  readSnapshotIndex,
  writeSnapshotIndex,
} from '../canonical/snapshot-index.ts';
import { SNAPSHOT_CHANGE_KIND, type SnapshotChangeKind, type SourceSnapshot, reconcile, snapshotId as makeSnapshotId } from '../canonical/snapshot.ts';
import type { ContactObservation, ContactPlane } from '../contact/contact-plane.ts';
import { type Clock, systemClock } from '../core/clock.ts';
import { FabricError, fail } from '../core/errors.ts';
import { MultisetDigest, canonicalJson, deterministicId, sha256 } from '../core/hash.ts';
import { createFileLineWriter, type LineWriter, readLines } from '../core/lines.ts';
import { type Logger, silentLogger } from '../core/logging.ts';
import type { Registry } from '../registry/registry.ts';
import { isStreamingTransport } from './arcgis-stream.ts';
import {
  type ChangeContext,
  type Connector,
  type ConnectorContext,
  type RunStage,
  type SourceRelease,
  type SourceRun,
  type StreamingConnector,
  emptyMetrics,
  isStreamingConnector,
} from './connector.ts';
import { createGenerationStore, type GenerationStore, type StagedTable } from './staged-store.ts';
import { createCheckpointStore } from './checkpoint.ts';
import { assertAutomationPermitted } from './transport.ts';
import type { RateLimiter, RetryPolicy, Sleep } from './retry.ts';

export type BatchConfiguration = {
  /** Rows per source query. Clamped to the layer's own maximum. */
  readonly fetchBatchSize: number;
  /** Requests in flight. Output order is preserved regardless. */
  readonly maxConcurrentRequests: number;
  /** Lines held in memory per external-sort chunk. */
  readonly sortChunkLines: number;
  /** Rows between checkpoint writes during canonicalization. */
  readonly checkpointEveryRows: number;
};

export const DEFAULT_BATCH_CONFIG: BatchConfiguration = {
  fetchBatchSize: 2000,
  maxConcurrentRequests: 2,
  sortChunkLines: 50_000,
  checkpointEveryRows: 25_000,
};

export type StreamRunOptions = {
  readonly registry: Registry;
  readonly connector: Connector;
  readonly mappingId: string;
  readonly artifactStore: StreamingArtifactStore;
  readonly contactPlane: ContactPlane;
  /** Root for the derived plane, snapshot indexes and checkpoints. */
  readonly varRoot: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly dryRun?: boolean;
  readonly batch?: Partial<BatchConfiguration>;
  readonly rateLimiter?: RateLimiter;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: Sleep;
  /** Re-interpret retained evidence. No network is touched. */
  readonly replayArtifact?: ArchivedArtifact;
  readonly referencePeriod?: string;
  /** Local snapshot bundle to ingest instead of crawling. */
  readonly localFile?: string;
  /**
   * Reuse a completed acquisition for this (source, period) if one is recorded
   * and still verifies. Turns a failed canonicalisation into a cheap retry
   * instead of a second 1.1 GB download.
   */
  readonly resume?: boolean;
};

export type StreamRunResult = {
  readonly run: SourceRun;
  readonly artifact: ArchivedArtifact | null;
  readonly snapshot: SourceSnapshot | null;
  readonly resolutions: readonly PropertyResolution[];
  readonly conflicts: readonly PropertyConflict[];
  readonly timings: Readonly<Record<string, number>>;
  readonly peakHeapBytes: number;
};

export async function runStreamingConnector(options: StreamRunOptions): Promise<StreamRunResult> {
  const clock = options.clock ?? systemClock;
  const logger = (options.logger ?? silentLogger()).child({
    adapterKey: options.connector.adapterKey,
    mappingId: options.mappingId,
  });
  const batch: BatchConfiguration = { ...DEFAULT_BATCH_CONFIG, ...options.batch };
  const dryRun = options.dryRun ?? false;
  const startedAt = clock.now().toISOString();

  const mapping = options.registry.mapping(options.mappingId);
  const source = options.registry.source(mapping.sourceId);
  const { connector, artifactStore, contactPlane, varRoot } = options;

  const timings: Record<string, number> = {};
  let peakHeapBytes = 0;
  const sampler = setInterval(() => {
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  }, 25);

  let stage: RunStage = 'discover';
  let artifact: ArchivedArtifact | null = null;
  let release: SourceRelease | null = null;
  let snapshot: SourceSnapshot | null = null;
  const metrics = emptyMetrics();
  const scratch = join(varRoot, 'scratch', `run-${Date.now().toString(36)}`);

  const finish = (status: SourceRun['status'], extra: Partial<SourceRun>): SourceRun => ({
    runId: extra.runId ?? deterministicId('run', source.sourceId, mapping.mappingId, 'preflight', startedAt),
    sourceId: source.sourceId,
    mappingId: mapping.mappingId,
    releaseId: release?.releaseId ?? null,
    adapterKey: connector.adapterKey,
    connectorVersion: connector.connectorVersion,
    parserVersion: connector.parserVersion,
    normalizationVersion: connector.normalizationVersion,
    schemaVersion: connector.schemaVersion,
    schemaDigest: snapshot?.sourceSchemaDigest ?? null,
    startedAt,
    completedAt: clock.now().toISOString(),
    status,
    stage,
    dryRun,
    replayOf: options.replayArtifact?.artifactId ?? null,
    artifactId: artifact?.artifactId ?? null,
    artifactSha256: artifact?.sha256 ?? null,
    metrics,
    validationErrorCount: 0,
    unknownFields: [],
    missingFields: [],
    failureKind: null,
    failureMessage: null,
    normalizedDigest: null,
    snapshotId: snapshot?.snapshotId ?? null,
    snapshotCompleteness: snapshot?.completeness ?? null,
    sourceSchemaDigest: snapshot?.sourceSchemaDigest ?? null,
    artifactByteLength: artifact?.byteLength ?? null,
    sourceReportedCount: snapshot?.sourceReportedCount ?? null,
    discoveredIdCount: null,
    downloadedCount: snapshot?.retrievedCount ?? null,
    duplicateCount: snapshot?.duplicateCount ?? 0,
    sourceChangedDuringRead: false,
    canonicalDigest: null,
    batchConfiguration: { ...batch },
    streamed: true,
    ...extra,
  });

  const store: GenerationStore = createGenerationStore(varRoot);
  let staged: Awaited<ReturnType<GenerationStore['beginRun']>> | null = null;

  try {
    if (mapping.adapterKey !== connector.adapterKey) {
      fail('CONFIG', `mapping "${mapping.mappingId}" expects adapter "${mapping.adapterKey}", got "${connector.adapterKey}"`);
    }
    if (mapping.status === 'planned' || mapping.status === 'retired') {
      fail('CONFIG', `mapping "${mapping.mappingId}" is ${mapping.status}; activate it in the registry before running`);
    }
    if (!source.active) fail('CONFIG', `source "${source.sourceId}" is not active`);
    if (!isStreamingConnector(connector)) {
      fail('CONFIG', `connector "${connector.adapterKey}" is not a streaming connector`);
    }
    await mkdir(scratch, { recursive: true });

    // ---- acquire ----------------------------------------------------------
    const acquireStart = performance.now();
    const checkpoints = createCheckpointStore(varRoot);
    let resumedFromCheckpoint = false;

    if (!options.replayArtifact && options.resume && options.referencePeriod) {
      const checkpoint = await checkpoints.read(source.sourceId, options.referencePeriod);
      if (checkpoint) {
        const candidate: ArchivedArtifact = {
          artifactId: checkpoint.artifactId,
          sha256: checkpoint.sha256,
          byteLength: checkpoint.byteLength,
          storagePath: checkpoint.storagePath,
          manifestPath: checkpoint.manifestPath,
          created: false,
          manifest: await artifactStore.readManifest({ manifestPath: checkpoint.manifestPath }),
        };
        // A checkpoint is a pointer, never a cache. It is only trusted once the
        // artifact it names has been re-hashed, so a stale or tampered
        // checkpoint degrades to a normal crawl rather than to a wrong answer.
        try {
          await artifactStore.verify(candidate);
          artifact = candidate;
          release = releaseFromManifest(candidate);
          resumedFromCheckpoint = true;
          logger.info('stream.resumed', { artifactId: candidate.artifactId, sha256: candidate.sha256 });
        } catch {
          logger.warn('stream.checkpoint_stale', { sha256: checkpoint.sha256, action: 're-acquiring' });
          await checkpoints.clear(source.sourceId, options.referencePeriod);
        }
      }
    }

    if (resumedFromCheckpoint) {
      stage = 'archive';
    } else if (options.replayArtifact) {
      stage = 'archive';
      artifact = options.replayArtifact;
      release = releaseFromManifest(artifact);
      logger.info('stream.replay', { artifactId: artifact.artifactId, sha256: artifact.sha256 });
    } else {
      const referencePeriod = options.referencePeriod
        ?? fail('CONFIG', 'a streaming run needs a referencePeriod');
      release = {
        releaseId: `${source.sourceId}__${referencePeriod}`,
        sourceId: source.sourceId,
        releaseLabel: `${source.sourceName} ${referencePeriod}`,
        referencePeriod,
        publicationAt: null,
        finality: 'unknown',
        sourceVersion: connector.schemaVersion,
      };

      const archiveInput = {
        sourceAuthority: source.sourceAuthority,
        sourceProgram: source.sourceProgram,
        sourceFamily: source.sourceFamily,
        sourceId: source.sourceId,
        releaseId: release.releaseId,
        referencePeriod,
        retrievedAt: clock.now().toISOString(),
        jurisdictionIds: options.registry.expand(mapping).map((j) => j.jurisdictionId),
        access: {
          accessType: source.accessType,
          automationStatus: source.automationStatus,
          termsStatus: source.termsStatus,
          licenseStatus: source.licenseStatus,
          carriesRestrictedContact: source.carriesRestrictedContact,
        },
      };

      stage = 'fetch';
      if (options.localFile) {
        // An operator-supplied bundle: copied through the same staging and
        // digesting path, so a local run and a crawled run are identical after
        // acquisition.
        artifact = await artifactStore.archiveStream(
          { ...archiveInput, originalUrl: null, originalFilename: baseName(options.localFile), effectiveAt: null },
          async (sink) => {
            for await (const line of readLines(options.localFile as string)) await sink.write(`${line}\n`);
          },
        );
      } else {
        const transport = connector.transport;
        assertAutomationPermitted(transport, source.automationStatus, source.sourceId);
        if (!isStreamingTransport(transport)) {
          // No streaming transport and no local file. Give the connector a
          // chance to say why — a source whose terms forbid automation has a
          // much more useful answer than "transport unsupported", and that
          // answer should reach the operator.
          await connector.discover(ctxForDiscovery(logger, source, mapping));
          fail('CONFIG', `transport for "${source.sourceId}" does not support streaming acquisition`);
        }
        let meta: Awaited<ReturnType<typeof transport.fetchStream>> | null = null;
        artifact = await artifactStore.archiveStream(
          { ...archiveInput, originalUrl: null, originalFilename: 'snapshot.ndjson', effectiveAt: null },
          async (sink) => {
            meta = await transport.fetchStream(
              { locator: `${source.sourceHomepage}` },
              {
                logger,
                ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
                ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
                ...(options.sleep ? { sleep: options.sleep } : {}),
              },
              sink,
            );
          },
        );
        if (meta) logger.info('stream.acquired', { retrieved: (meta as { trailer: { retrievedFeatureCount: number } }).trailer.retrievedFeatureCount });
      }
      stage = 'archive';
      logger.info('stream.archived', {
        artifactId: artifact.artifactId, sha256: artifact.sha256, byteLength: artifact.byteLength, deduped: !artifact.created,
      });
      // Recorded only once acquisition has fully succeeded, so a checkpoint can
      // never point at a partial download.
      if (!dryRun) {
        await checkpoints.write({
          version: 1,
          sourceId: source.sourceId,
          referencePeriod: release.referencePeriod,
          releaseId: release.releaseId,
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          storagePath: artifact.storagePath,
          manifestPath: artifact.manifestPath,
          completedAt: clock.now().toISOString(),
        });
      }
    }
    timings['acquire'] = Math.round(performance.now() - acquireStart);

    // Every acquisition branch must have produced both. Asserting it here keeps
    // the rest of the pipeline free of null checks that could only fire because
    // a future branch forgot to assign.
    if (!artifact || !release) fail('CONFIG', 'acquisition produced no artifact');
    const acquired = artifact;
    const acquiredRelease = release;

    const runId = deterministicId(
      'run', source.sourceId, mapping.mappingId, acquiredRelease.releaseId, acquired.sha256,
      connector.connectorVersion, connector.parserVersion, connector.normalizationVersion,
    );
    const runLogger = logger.child({ runId });
    const ctx: ConnectorContext = { logger: runLogger, source, mapping, runId };

    // ---- parse + validate (header only, so drift aborts early) -------------
    stage = 'parse';
    const parseStart = performance.now();
    const streaming = connector as StreamingConnector;
    const session = await streaming.openStream(ctx, artifactStore.readLinesVerified(acquired));

    if (session.earlyDriftReasons.length > 0) {
      runLogger.error('stream.schema_drift', { reasons: session.earlyDriftReasons });
      return result(finish('quarantined', {
        runId, failureKind: 'SCHEMA_DRIFT', failureMessage: session.earlyDriftReasons.join('; '),
      }));
    }

    // ---- prepare the streaming estate --------------------------------------
    stage = 'normalize';
    const snapshotKey = makeSnapshotId(source.sourceId, acquiredRelease.referencePeriod);
    const indexPath = join(varRoot, 'indexes', `${safeSegment(source.sourceId)}.idx`);
    const priorIndex: SnapshotIndex = dryRun ? await readSnapshotIndex(indexPath) : await readSnapshotIndex(indexPath);
    const nextIndex = new SnapshotIndexBuilder(Math.max(1024, priorIndex.size));

    staged = dryRun ? null : await store.beginRun(runId);
    const contributionsPath = join(scratch, 'contributions.ndjson');
    const contributionsWriter: LineWriter = await createFileLineWriter(contributionsPath);

    const normalizedDigest = new MultisetDigest();
    const observedAt = acquired.manifest.retrievedAt;
    const changeCounts: Record<SnapshotChangeKind, number> = {
      new_parcel_observed: 0, unchanged_parcel: 0, parcel_attributes_changed: 0,
      parcel_missing_from_latest_source: 0, parcel_reappeared: 0,
    };
    let validationErrorCount = 0;
    let processed = 0;

    for await (const { parsed, issues } of session.records()) {
      metrics.rowsParsed += 1;

      if (issues.length > 0) {
        validationErrorCount += issues.length;
        metrics.rowsQuarantined += 1;
        runLogger.warn('record.quarantined', {
          sourceRecordId: parsed.sourceRecordId,
          issues: issues.slice(0, 3).map((i) => `${i.code} ${i.path}`),
        });
        continue;
      }
      metrics.rowsValid += 1;

      const groupDigest = sha256(canonicalJson(parsed.fieldGroupDigests ?? {}));
      const comparison = priorIndex.compareAndMark(parsed.sourceRecordId, parsed.contentDigest, groupDigest);
      nextIndex.add(parsed.sourceRecordId, parsed.contentDigest, groupDigest);

      const kind = comparison.kind === 'absent' ? 'new' : comparison.kind === 'unchanged' ? 'unchanged' : 'revised';
      changeCounts[SNAPSHOT_CHANGE_KIND[kind]] += 1;
      if (kind === 'new') metrics.rowsNew += 1;
      else if (kind === 'unchanged') metrics.rowsUnchanged += 1;
      else metrics.rowsRevised += 1;

      const evidence: SourceEvidence = {
        sourceId: source.sourceId,
        sourceRecordId: parsed.sourceRecordId,
        artifactId: acquired.artifactId,
        runId,
        observedAt,
        effectiveAt: acquired.manifest.effectiveAt,
        rawRecordHash: parsed.rawFragmentDigest,
        parserVersion: connector.parserVersion,
        normalizationVersion: connector.normalizationVersion,
      };
      const change: ChangeContext = {
        kind,
        // Which groups moved is only knowable against the prior index, which
        // stores one combined group digest. A finer breakdown would need the
        // per-group digests of the previous snapshot, which is a per-row cost
        // the index deliberately does not pay.
        changedFieldGroups: comparison.kind === 'changed' && comparison.groupsChanged ? ['*'] : [],
        snapshotId: snapshotKey,
      };

      const { bundle, contacts, extraRows } = connector.normalize(ctx, parsed, evidence, change);

      // Everything below writes and releases. Nothing accumulates.
      normalizedDigest.add(canonicalJson(evidenceProjectionOf(bundle)));
      if (staged) {
        await staged.write('bundles', bundle);
        for (const event of bundle.events) await staged.write('events', event);
        for (const contact of contacts) await staged.write('contacts', contact);
        // Connector-specific canonical rows, written verbatim. The runtime does
        // not know what an instrument reference means and does not need to.
        for (const [table, rows] of Object.entries(extraRows ?? {})) {
          for (const row of rows) await staged.write(table as StagedTable, row);
        }
      }
      // The durable, permission-gated record is the restricted partition written
      // above. The plane keeps a bounded window so an operator can inspect
      // recent rows without the run holding a county of mailing addresses.
      for (const contact of contacts) contactPlane.record(contact as ContactObservation);
      for (const line of contributionLines(bundle)) await contributionsWriter.write(line);

      metrics.rowsEmitted += 1;
      metrics.canonicalEvents += bundle.events.length;
      metrics.contactObservations += contacts.length;

      processed += 1;
      if (processed % batch.checkpointEveryRows === 0) {
        runLogger.info('stream.progress', {
          processed, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        });
      }
    }

    const summary = session.finish();
    timings['parse_normalize'] = Math.round(performance.now() - parseStart);

    // ---- reconciliation ----------------------------------------------------
    stage = 'validate';
    const reported = summary.snapshot?.sourceReportedCount ?? null;
    const retrieved = summary.snapshot?.retrievedCount ?? metrics.rowsParsed;
    snapshot = {
      snapshotId: snapshotKey,
      sourceId: source.sourceId,
      releaseId: acquiredRelease.releaseId,
      artifactId: acquired.artifactId,
      runId,
      referencePeriod: acquiredRelease.referencePeriod,
      capturedAt: observedAt,
      sourceReportedCount: reported,
      retrievedCount: retrieved,
      parsedCount: metrics.rowsParsed,
      acceptedCount: metrics.rowsValid,
      quarantinedCount: metrics.rowsQuarantined,
      duplicateCount: summary.snapshot?.duplicateCount ?? 0,
      completeness: reconcile(reported, retrieved),
      sourceSchemaDigest: summary.snapshot?.sourceSchemaDigest ?? null,
    };

    if (summary.driftReasons.length > 0) {
      await contributionsWriter.close();
      await staged?.abort();
      runLogger.error('stream.quarantined', { reasons: summary.driftReasons });
      return result(finish('quarantined', {
        runId,
        failureKind: 'SCHEMA_DRIFT',
        failureMessage: summary.driftReasons.join('; '),
        validationErrorCount,
        unknownFields: summary.unknownFields,
        sourceChangedDuringRead: summary.snapshot?.sourceChangedDuringRead ?? false,
      }));
    }

    // ---- absence -----------------------------------------------------------
    const unseen = priorIndex.unseenKeyHashes();
    metrics.rowsMissingFromSnapshot = unseen.length;
    changeCounts.parcel_missing_from_latest_source = unseen.length;
    if (unseen.length > 0 && staged) {
      // Recorded by key hash: the absent row's full key lives in the prior
      // snapshot's own partition, and duplicating it here would put a
      // dataset-sized string table back into memory.
      for (const keyHash of unseen) {
        await staged.write('absences', {
          observationId: deterministicId('absence', snapshotKey, keyHash.toString(16)),
          sourceId: source.sourceId,
          sourceRecordKeyHash: keyHash.toString(16),
          snapshotId: snapshotKey,
          runId,
          observedAt,
          changeKind: 'parcel_missing_from_latest_source',
        });
      }
      runLogger.warn('stream.absences', {
        missing: unseen.length,
        note: 'absent from the latest snapshot; NOT interpreted as removed from the world',
      });
    }

    await contributionsWriter.close();

    // ---- project resolution ------------------------------------------------
    stage = 'emit';
    const projectStart = performance.now();
    const authority = parcelAuthorityFor(
      options.registry.sources.filter((s) => s.authoritativeForParcelIdentity === true).map((s) => s.sourceId),
    );
    const canonicalDigest = new MultisetDigest();
    const resolutions: PropertyResolution[] = [];
    const conflicts: PropertyConflict[] = [];
    const keepSamples = 200;

    // Estate-wide, deliberately not per-source. The fold reads every source's
    // contributions, so keying the output by the current run's source meant the
    // same estate landed in a different file depending on which source ran last
    // — and left the other file stale. With one source that was invisible.
    const resolutionsPath = join(varRoot, 'derived', 'resolutions', 'current.ndjson');
    const conflictsPath = join(varRoot, 'derived', 'conflicts', `${safeSegment(runId)}.ndjson`);
    const resolutionWriter = dryRun ? null : await createFileLineWriter(`${resolutionsPath}.tmp`);
    const conflictWriter = dryRun ? null : await createFileLineWriter(`${conflictsPath}.tmp`);

    const projection = await projectResolutions(
      () => allContributions(store, contributionsPath, runId),
      {
        async resolution(row) {
          canonicalDigest.add(canonicalJson(row));
          if (resolutions.length < keepSamples) resolutions.push(row);
          await resolutionWriter?.write(canonicalJson(row));
        },
        async conflict(row) {
          if (conflicts.length < keepSamples) conflicts.push(row);
          await conflictWriter?.write(canonicalJson(row));
        },
      },
      { authority, runId, detectedAt: observedAt, sort: { chunkLines: batch.sortChunkLines, scratchDir: scratch } },
    );
    await resolutionWriter?.close();
    await conflictWriter?.close();
    metrics.rowsResolved = projection.resolvedCount;
    metrics.rowsConflicted = projection.conflictCount;
    timings['project'] = Math.round(performance.now() - projectStart);

    // ---- activate ----------------------------------------------------------
    if (staged) {
      await staged.commit();
      await promote(`${resolutionsPath}.tmp`, resolutionsPath);
      await promote(`${conflictsPath}.tmp`, conflictsPath);
      await writeSnapshotIndex(indexPath, nextIndex.build());
    }

    runLogger.info('stream.finished', {
      rows: metrics.rowsParsed,
      resolved: projection.resolvedCount,
      conflicts: projection.conflictCount,
      completeness: snapshot.completeness,
      peakHeapMB: Math.round(peakHeapBytes / 1048576),
    });

    return result(finish(metrics.rowsQuarantined > 0 && metrics.rowsEmitted === 0 ? 'quarantined' : 'completed', {
      runId,
      normalizedDigest: normalizedDigest.value(),
      canonicalDigest: canonicalDigest.value(),
      validationErrorCount,
      unknownFields: summary.unknownFields,
      sourceReportedCount: reported,
      downloadedCount: retrieved,
      discoveredIdCount: retrieved,
      duplicateCount: snapshot.duplicateCount,
      sourceChangedDuringRead: summary.snapshot?.sourceChangedDuringRead ?? false,
    }), resolutions, conflicts);
  } catch (error) {
    await staged?.abort();
    const fabric = error instanceof FabricError ? error : null;
    logger.error('stream.failed', {
      stage, kind: fabric?.kind ?? 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
      detail: fabric?.detail,
    });
    return result(finish(fabric?.kind === 'ACCESS_BLOCKED' ? 'blocked_on_access' : 'failed', {
      failureKind: fabric?.kind ?? 'UNEXPECTED',
      failureMessage: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    clearInterval(sampler);
    await rm(scratch, { recursive: true, force: true });
  }

  function result(
    run: SourceRun,
    resolutions: readonly PropertyResolution[] = [],
    conflicts: readonly PropertyConflict[] = [],
  ): StreamRunResult {
    return { run, artifact, snapshot, resolutions, conflicts, timings, peakHeapBytes };
  }
}

// ---------------------------------------------------------------------------

/**
 * Every contribution the estate holds: prior runs' persisted bundles plus this
 * run's freshly written file.
 *
 * Read as a stream. Loading the estate to fold it is the thing this phase
 * exists to stop doing.
 */
async function* allContributions(
  store: GenerationStore,
  currentPath: string,
  currentRunId: string,
): AsyncGenerator<string> {
  for (const runId of await store.listRuns()) {
    if (runId === currentRunId) continue; // the current run is read from scratch, uncommitted
    for await (const line of store.readRunTable(runId, 'bundles')) {
      const bundle = JSON.parse(line) as CanonicalBundle;
      for (const contribution of contributionLines(bundle)) yield contribution;
    }
  }
  yield* readLines(currentPath);
}

function contributionLines(bundle: CanonicalBundle): readonly string[] {
  const address = bundle.propertyIdentifiers
    .find((o) => o.identifierType === 'normalized_address')?.normalizedValue ?? null;
  const out: string[] = [];
  for (const observation of bundle.propertyIdentifiers) {
    const contribution = contributionOf(observation as PropertyIdentifierObservation, address);
    if (contribution) out.push(canonicalJson(contribution));
  }
  return out;
}

/** Mirrors the buffered runtime's digest scope exactly. */
const HISTORY_DEPENDENT_EVENTS: ReadonlySet<string> = new Set(['PARCEL_ATTRIBUTES_CHANGED']);

function evidenceProjectionOf(bundle: CanonicalBundle): unknown {
  const { parcelObservations: _diff, events, ...rest } = bundle;
  return { ...rest, events: events.filter((e) => !HISTORY_DEPENDENT_EVENTS.has(e.eventType)) };
}

/** A minimal context for the discovery call made purely to surface a refusal. */
function ctxForDiscovery(
  logger: Logger,
  source: ConnectorContext['source'],
  mapping: ConnectorContext['mapping'],
): ConnectorContext {
  return { logger, source, mapping, runId: 'preflight' };
}

function releaseFromManifest(artifact: ArchivedArtifact): SourceRelease {
  const m = artifact.manifest;
  return {
    releaseId: m.releaseId,
    sourceId: m.sourceId,
    releaseLabel: `${m.sourceProgram} ${m.referencePeriod}`,
    referencePeriod: m.referencePeriod,
    publicationAt: m.effectiveAt,
    finality: 'unknown',
    sourceVersion: null,
  };
}

async function promote(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  await rename(from, to);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) fail('CONFIG', `path segment "${value}" is empty after sanitisation`);
  return cleaned;
}
