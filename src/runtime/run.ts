/**
 * The connector runtime.
 *
 * One function drives every source: discover, fetch, archive, parse, validate,
 * normalize, emit. Adapters plug into it; they never re-implement it.
 *
 * Idempotency is structural rather than defensive. The run id is derived from
 * the evidence and the code that interpreted it — source, mapping, release,
 * artifact digest, connector/parser/normalization versions — so re-ingesting the
 * same bytes with the same code produces the same run id, and the store replaces
 * that run's partition instead of appending a second copy. Change any of those
 * inputs and you get a different run, which is exactly when you want one.
 */
import { type ArchivedArtifact, type ArtifactStore } from '../archive/artifact-store.ts';
import type { CanonicalBundle, CanonicalEvent, SourceEvidence } from '../canonical/models.ts';
import { createRevisionLedger, type ChangeKind, type RevisionLedger, type SourceRecordObservation } from '../canonical/revision.ts';
import type { ContactObservation, ContactPlane } from '../contact/contact-plane.ts';
import { type Clock, systemClock } from '../core/clock.ts';
import { FabricError, fail } from '../core/errors.ts';
import { canonicalJson, deterministicId, sha256 } from '../core/hash.ts';
import { type Logger, silentLogger } from '../core/logging.ts';
import type { Registry } from '../registry/registry.ts';
import type {
  Connector,
  ConnectorContext,
  DiscoveredRelease,
  ParsedBatch,
  RunMetrics,
  SourceRelease,
  SourceRun,
  RunStage,
} from './connector.ts';
import { emptyMetrics } from './connector.ts';
import type { FabricStore } from './fabric-store.ts';
import { assertAutomationPermitted } from './transport.ts';
import type { RateLimiter, RetryPolicy, Sleep } from './retry.ts';

export type RunOptions = {
  readonly registry: Registry;
  readonly connector: Connector;
  readonly mappingId: string;
  readonly artifactStore: ArtifactStore;
  readonly fabricStore: FabricStore;
  readonly contactPlane: ContactPlane;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Parse and normalise, report everything, persist nothing. */
  readonly dryRun?: boolean;
  /** Chooses among discovered releases. Defaults to the first. */
  readonly selectRelease?: (releases: readonly DiscoveredRelease[]) => DiscoveredRelease | undefined;
  readonly rateLimiter?: RateLimiter;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: Sleep;
  /** Skip discovery and retrieval; re-interpret an artifact already retained. */
  readonly replayArtifact?: ArchivedArtifact;
  readonly replayRelease?: SourceRelease;
};

export type RunResult = {
  readonly run: SourceRun;
  readonly bundles: readonly CanonicalBundle[];
  readonly events: readonly CanonicalEvent[];
  readonly contacts: readonly ContactObservation[];
  readonly artifact: ArchivedArtifact | null;
  readonly batch: ParsedBatch | null;
  readonly changeCounts: Readonly<Record<ChangeKind, number>>;
};

export async function runConnector(options: RunOptions): Promise<RunResult> {
  const clock = options.clock ?? systemClock;
  const baseLogger = options.logger ?? silentLogger();
  const dryRun = options.dryRun ?? false;
  const { registry, connector, artifactStore, fabricStore, contactPlane } = options;

  const mapping = registry.mapping(options.mappingId);
  const source = registry.source(mapping.sourceId);
  const startedAt = clock.now().toISOString();

  const logger = baseLogger.child({
    adapterKey: connector.adapterKey,
    sourceId: source.sourceId,
    mappingId: mapping.mappingId,
    dryRun,
  });

  let stage: RunStage = 'discover';
  let artifact: ArchivedArtifact | null = null;
  let release: SourceRelease | null = options.replayRelease ?? null;
  let batch: ParsedBatch | null = null;
  const metrics = emptyMetrics();
  const changeCounts: Record<ChangeKind, number> = { new: 0, unchanged: 0, revised: 0 };
  let validationErrorCount = 0;

  const finish = async (
    status: SourceRun['status'],
    extra: Partial<SourceRun> = {},
  ): Promise<RunResult> => {
    const run: SourceRun = {
      runId: extra.runId ?? preflightRunId(source.sourceId, mapping.mappingId, startedAt),
      sourceId: source.sourceId,
      mappingId: mapping.mappingId,
      releaseId: release?.releaseId ?? null,
      adapterKey: connector.adapterKey,
      connectorVersion: connector.connectorVersion,
      parserVersion: connector.parserVersion,
      normalizationVersion: connector.normalizationVersion,
      schemaVersion: connector.schemaVersion,
      schemaDigest: batch?.schemaDigest ?? null,
      startedAt,
      completedAt: clock.now().toISOString(),
      status,
      stage,
      dryRun,
      replayOf: options.replayArtifact ? options.replayArtifact.artifactId : null,
      artifactId: artifact?.artifactId ?? null,
      artifactSha256: artifact?.sha256 ?? null,
      metrics,
      validationErrorCount,
      unknownFields: batch?.unknownFields ?? [],
      missingFields: batch?.missingFields ?? [],
      failureKind: null,
      failureMessage: null,
      normalizedDigest: null,
      ...extra,
    };
    logger.info('run.finished', {
      runId: run.runId,
      status: run.status,
      stage: run.stage,
      artifactSha256: run.artifactSha256,
      metrics: run.metrics,
      normalizedDigest: run.normalizedDigest,
    });
    if (!dryRun) {
      if (release) await fabricStore.putRelease(release);
      await fabricStore.putRun(run);
    }
    // Terminal shape only. The success path spreads its own canonical output
    // over this before returning.
    return { run, bundles: [], events: [], contacts: [], artifact, batch, changeCounts };
  };

  const ctx: ConnectorContext = { logger, source, mapping, runId: 'pending' };

  try {
    if (mapping.adapterKey !== connector.adapterKey) {
      fail('CONFIG', `mapping "${mapping.mappingId}" expects adapter "${mapping.adapterKey}", got "${connector.adapterKey}"`);
    }
    if (mapping.status === 'planned' || mapping.status === 'retired') {
      fail('CONFIG', `mapping "${mapping.mappingId}" is ${mapping.status}; activate it in the registry before running`);
    }
    if (!source.active) fail('CONFIG', `source "${source.sourceId}" is not active`);

    // ---- discover + fetch + archive -------------------------------------
    if (options.replayArtifact) {
      stage = 'archive';
      artifact = options.replayArtifact;
      release ??= releaseFromManifest(artifact);
      logger.info('run.replay', { artifactId: artifact.artifactId, sha256: artifact.sha256 });
    } else {
      const discovered = await connector.discover(ctx);
      metrics.rowsDiscovered = discovered.length;
      const chosen = (options.selectRelease ?? ((r) => r[0]))(discovered);
      if (!chosen) fail('TRANSPORT', `connector "${connector.adapterKey}" discovered no releases`);
      release = chosen.release;
      logger.info('run.release_selected', { releaseId: release.releaseId, referencePeriod: release.referencePeriod });

      stage = 'fetch';
      // Refuses before a single byte crosses the wire when the publisher has
      // not sanctioned automated retrieval.
      assertAutomationPermitted(connector.transport, source.automationStatus, source.sourceId);
      const payload = await connector.transport.fetch(chosen.request, {
        logger,
        ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
        ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });

      stage = 'archive';
      artifact = await artifactStore.archive({
        bytes: payload.bytes,
        sourceAuthority: source.sourceAuthority,
        sourceProgram: source.sourceProgram,
        sourceFamily: source.sourceFamily,
        sourceId: source.sourceId,
        releaseId: release.releaseId,
        referencePeriod: release.referencePeriod,
        originalUrl: payload.originalUrl,
        originalFilename: payload.originalFilename,
        retrievedAt: clock.now().toISOString(),
        effectiveAt: payload.effectiveAt ?? release.publicationAt,
        jurisdictionIds: registry.expand(mapping).map((j) => j.jurisdictionId),
        access: {
          accessType: source.accessType,
          automationStatus: source.automationStatus,
          termsStatus: source.termsStatus,
          licenseStatus: source.licenseStatus,
          carriesRestrictedContact: source.carriesRestrictedContact,
        },
      });
      logger.info('run.archived', {
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        deduped: !artifact.created,
      });
    }

    const runId = evidenceRunId(source.sourceId, mapping.mappingId, release, artifact, connector);
    const runCtx: ConnectorContext = { ...ctx, runId };
    const runLogger = logger.child({ runId });

    // ---- parse ------------------------------------------------------------
    stage = 'parse';
    // Read back through the store so the parse always sees verified bytes,
    // whether this is a fresh retrieval or a replay.
    const bytes = await artifactStore.read(artifact);
    batch = connector.parse(runCtx, bytes, release);
    metrics.rowsParsed = batch.records.length;
    runLogger.info('run.parsed', {
      records: batch.records.length,
      schemaVersion: batch.schemaVersion,
      schemaDigest: batch.schemaDigest,
      unknownFields: batch.unknownFields.length,
      missingFields: batch.missingFields.length,
    });

    // ---- validate ---------------------------------------------------------
    stage = 'validate';
    const validation = connector.validate(runCtx, batch);
    const issuesByRecord = new Map(validation.records.map((r) => [r.sourceRecordId, r.issues] as const));
    validationErrorCount = validation.records.reduce((n, r) => n + r.issues.length, 0);

    if (validation.schemaDrift) {
      metrics.rowsQuarantined = batch.records.length;
      runLogger.error('run.schema_drift', {
        reasons: validation.driftReasons,
        unknownFields: batch.unknownFields,
        missingFields: batch.missingFields,
      });
      await recordInterpretation(artifactStore, artifact, connector, batch, 0, '', true, validationErrorCount, dryRun);
      return await finish('quarantined', {
        runId,
        failureKind: 'SCHEMA_DRIFT',
        failureMessage: validation.driftReasons.join('; '),
      });
    }

    // ---- normalize --------------------------------------------------------
    stage = 'normalize';
    const ledger: RevisionLedger = createRevisionLedger(
      dryRun ? [] : await fabricStore.sourceObservations(),
    );
    const observedAt = artifact.manifest.retrievedAt;

    // Two collections on purpose. `allBundles` is every valid record in the
    // artifact, normalised, and is what the artifact's interpretation digest
    // describes: a property of the evidence and the code, not of what happened
    // to be in the store beforehand. The others are only what this run writes.
    const allBundles: CanonicalBundle[] = [];
    const bundles: CanonicalBundle[] = [];
    const events: CanonicalEvent[] = [];
    const contacts: ContactObservation[] = [];
    const newObservations: SourceRecordObservation[] = [];

    for (const parsed of batch.records) {
      const issues = issuesByRecord.get(parsed.sourceRecordId) ?? [];
      if (issues.length > 0) {
        metrics.rowsQuarantined += 1;
        runLogger.warn('record.quarantined', {
          sourceRecordId: parsed.sourceRecordId,
          issues: issues.slice(0, 5).map((i) => `${i.code} ${i.path}`),
          issueCount: issues.length,
        });
        continue;
      }
      metrics.rowsValid += 1;

      const decision = ledger.classify({
        sourceId: source.sourceId,
        sourceRecordId: parsed.sourceRecordId,
        artifactId: artifact.artifactId,
        runId,
        observedAt,
        contentDigest: parsed.contentDigest,
        parserVersion: connector.parserVersion,
      });
      changeCounts[decision.kind] += 1;

      const evidence: SourceEvidence = {
        sourceId: source.sourceId,
        sourceRecordId: parsed.sourceRecordId,
        artifactId: artifact.artifactId,
        runId,
        observedAt,
        effectiveAt: artifact.manifest.effectiveAt,
        rawRecordHash: parsed.rawFragmentDigest,
        parserVersion: connector.parserVersion,
        normalizationVersion: connector.normalizationVersion,
      };
      const result = connector.normalize(runCtx, parsed, evidence);
      allBundles.push(result.bundle);

      if (decision.kind === 'unchanged') {
        // Already retained, byte-identical. It still counts toward the
        // artifact's digest, but there is nothing new to write or emit.
        metrics.rowsUnchanged += 1;
        continue;
      }
      if (decision.kind === 'new') metrics.rowsNew += 1;
      else metrics.rowsRevised += 1;

      newObservations.push(decision.observation);
      bundles.push(result.bundle);
      events.push(...result.bundle.events);
      contacts.push(...result.contacts);
      metrics.rowsEmitted += 1;
    }

    // ---- emit -------------------------------------------------------------
    stage = 'emit';
    metrics.canonicalEvents = events.length;
    metrics.contactObservations = contacts.length;

    // Digest over the canonical reading of the whole artifact, order-independent.
    // Same evidence plus same code must give the same value on every machine and
    // in every order, whether or not the derived store already held the records.
    const normalizedDigest = sha256(
      allBundles.map((b) => sha256(canonicalJson(b))).sort().join('\n'),
    );

    if (!dryRun) {
      for (const c of contacts) contactPlane.record(c);
      await fabricStore.putSourceObservations(runId, newObservations);
      await fabricStore.putBundles(runId, bundles);
      await fabricStore.putEvents(runId, events);
      await fabricStore.putContacts(runId, contacts);
    }
    await recordInterpretation(
      artifactStore, artifact, connector, batch, allBundles.length, normalizedDigest, false, validationErrorCount, dryRun,
    );

    const result = await finish(metrics.rowsQuarantined > 0 && metrics.rowsEmitted === 0 ? 'quarantined' : 'completed', {
      runId,
      normalizedDigest,
    });
    return { ...result, bundles, events, contacts };
  } catch (error) {
    const fabric = error instanceof FabricError ? error : null;
    logger.error('run.failed', {
      stage,
      kind: fabric?.kind ?? 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
      detail: fabric?.detail,
    });
    const status = fabric?.kind === 'ACCESS_BLOCKED' ? 'blocked_on_access' : 'failed';
    return finish(status, {
      failureKind: fabric?.kind ?? 'UNEXPECTED',
      failureMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-interpret retained evidence. Reads the bytes back from the archive, verifies
 * the digest, and runs the identical pipeline with no network involved.
 */
export async function replayArtifact(
  options: Omit<RunOptions, 'replayArtifact'> & { artifact: ArchivedArtifact },
): Promise<RunResult> {
  return runConnector({ ...options, replayArtifact: options.artifact });
}

// ---------------------------------------------------------------------------

function evidenceRunId(
  sourceId: string,
  mappingId: string,
  release: SourceRelease,
  artifact: ArchivedArtifact,
  connector: Connector,
): string {
  return deterministicId(
    'run',
    sourceId,
    mappingId,
    release.releaseId,
    artifact.sha256,
    connector.connectorVersion,
    connector.parserVersion,
    connector.normalizationVersion,
  );
}

function preflightRunId(sourceId: string, mappingId: string, startedAt: string): string {
  // Used only for runs that never reached an artifact, e.g. access refused.
  return deterministicId('run', sourceId, mappingId, 'preflight', startedAt);
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

async function recordInterpretation(
  artifactStore: ArtifactStore,
  artifact: ArchivedArtifact,
  connector: Connector,
  batch: ParsedBatch,
  recordCount: number,
  normalizedDigest: string,
  quarantined: boolean,
  validationErrorCount: number,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  await artifactStore.recordInterpretation(artifact, {
    manifestVersion: 1,
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    parserVersion: connector.parserVersion,
    schemaVersion: batch.schemaVersion,
    schemaDigest: batch.schemaDigest,
    recordCount,
    contentDigest: normalizedDigest,
    quarantined,
    validationErrorCount,
  });
}

export type RunReport = {
  readonly runId: string;
  readonly source: string;
  readonly release: string | null;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly artifactSha256: string | null;
  readonly schemaVersion: string;
  readonly schemaDigest: string | null;
  readonly metrics: RunMetrics;
  readonly validationErrorCount: number;
  readonly unknownFields: readonly string[];
  readonly normalizedDigest: string | null;
  readonly failure: string | null;
};

/** The concise operator view of a run. No UI in this phase; this is the report. */
export function runReport(run: SourceRun): RunReport {
  return {
    runId: run.runId,
    source: run.sourceId,
    release: run.releaseId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    artifactSha256: run.artifactSha256,
    schemaVersion: run.schemaVersion,
    schemaDigest: run.schemaDigest,
    metrics: run.metrics,
    validationErrorCount: run.validationErrorCount,
    unknownFields: run.unknownFields,
    normalizedDigest: run.normalizedDigest,
    failure: run.failureKind ? `${run.failureKind}: ${run.failureMessage}` : null,
  };
}
