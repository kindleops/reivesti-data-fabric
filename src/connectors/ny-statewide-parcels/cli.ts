/**
 * `df` entry points for New York, kept beside the connector so the shared CLI
 * only dispatches to them.
 *
 *   df auto ny_statewide_parcels__all_ny_counties [--discover-only] [--force]
 *   df auto ny_statewide_parcels__all_ny_counties --replay <archive sha256> --period 2025-2605
 *   df fields --source ny
 */
import { runReport } from '../../runtime/run.ts';
import { NY_ABSENT_CONCEPTS, NY_NOT_INGESTED, NY_STATEWIDE_FIELD_MAP, nyStatewideDispositionCounts } from './field-map.ts';
import { NY_PINNED_FIELD_SET_DIGEST } from './index.ts';
import {
  replayNyFromArchive,
  runNyStatewidePipeline,
  type NyPipelineOptions,
  type NyPipelineResult,
} from './pipeline.ts';

export function nyFieldsReport(): unknown {
  return {
    source: 'ny_statewide_parcels',
    layer: 'NYS_Tax_Parcels_Centroid_Points (File Geodatabase NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb)',
    publishedFields: NY_STATEWIDE_FIELD_MAP.length,
    pinnedFieldSetDigest: NY_PINNED_FIELD_SET_DIGEST,
    dispositions: nyStatewideDispositionCounts(),
    fields: NY_STATEWIDE_FIELD_MAP,
    notIngested: NY_NOT_INGESTED,
    notInThisSchema: NY_ABSENT_CONCEPTS,
  };
}

type Common = Omit<NyPipelineOptions, 'mode' | 'discoverOnly' | 'discovered'>;

/** Runs the unattended cycle (or a replay) and returns what to print and the exit code. */
export async function runNyAuto(
  common: Common,
  flags: Readonly<Record<string, string | boolean>>,
): Promise<{ readonly summary: unknown; readonly exitCode: number } | { readonly usage: string }> {
  let result: NyPipelineResult;
  if (typeof flags['replay'] === 'string') {
    const sha = flags['replay'];
    const period = typeof flags['period'] === 'string' ? flags['period'] : '';
    if (!/^[0-9a-f]{64}$/.test(sha) || !period) return { usage: '--replay needs the publisher archive sha256 and --period\n' };
    result = await replayNyFromArchive({ ...common, publisherSha256: sha, referencePeriod: period });
  } else {
    result = await runNyStatewidePipeline({
      ...common,
      mode: flags['force'] === true ? 'force' : 'scheduled',
      discoverOnly: flags['discover-only'] === true,
      ...(flags['no-companion'] === true ? { retainCompanion: false } : {}),
    });
  }
  return { summary: summarizeNyPipeline(result), exitCode: result.outcome === 'FAILED' ? 1 : 0 };
}

export function summarizeNyPipeline(result: NyPipelineResult): unknown {
  const run = result.run;
  const mb = (n: number) => Math.round(n / 1048576);
  const d = result.discovered;
  return {
    outcome: result.outcome,
    plan: result.plan,
    discovered: d === null ? null : {
      referencePeriod: d.referencePeriod,
      releaseFingerprint: d.releaseFingerprint,
      head: d.head,
      archive: d.archive,
      access: d.access,
      migration: d.migration,
      serviceMatchesArchive: d.serviceMatchesArchive,
      witness: { ...d.witness, fields: d.witness.fields.length },
      programLinks: d.programLinks,
      companion: d.companion,
      companionError: d.companionError,
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
    companion: result.companion,
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
      changeCounts: run.changeCounts,
    } : null,
    canonical: run ? {
      runId: run.run.runId,
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
      skipped: run.skippedPartitions,
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
    durability: result.durability,
    ledger: result.ledger,
  };
}
