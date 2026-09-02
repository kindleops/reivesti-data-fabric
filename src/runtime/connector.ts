/**
 * The connector contract.
 *
 * The runtime owns the lifecycle: run identity, retrieval timestamps, retries,
 * rate limiting, archival, digesting, idempotency, quarantine, metrics, logging
 * and replay. A connector owns only what is genuinely source-specific — which
 * releases exist, how to turn bytes into records, what those records mean, and
 * what the publisher's schema says.
 *
 * The seven lifecycle stages from the architecture doc map here as:
 *   discover  -> connector
 *   fetch     -> runtime, through the connector's declared transport and request
 *   archive   -> runtime
 *   parse     -> connector
 *   validate  -> connector
 *   normalize -> connector
 *   emit      -> runtime
 */
import type { CanonicalBundle } from '../canonical/models.ts';
import type { SourceEvidence } from '../canonical/models.ts';
import type { ContactObservation } from '../contact/contact-plane.ts';
import type { Logger } from '../core/logging.ts';
import type { SourceDefinition, SourceJurisdictionMapping } from '../registry/types.ts';
import type { ValidationIssue } from '../schema/xsd.ts';
import type { FetchRequest, Transport } from './transport.ts';

// ---------------------------------------------------------------------------
// Release / run / artifact / observation — four distinct things
// ---------------------------------------------------------------------------

/**
 * What the publisher published. A release exists independently of whether we
 * ever fetched it, and one release may be fetched many times.
 */
export type SourceRelease = {
  readonly releaseId: string;
  readonly sourceId: string;
  /** The publisher's own label for this release, e.g. "Weekly Sales Extract 2026-W31". */
  readonly releaseLabel: string;
  /** The period the data describes, not when it was published. */
  readonly referencePeriod: string;
  readonly publicationAt: string | null;
  /** Whether the publisher may still amend this release. */
  readonly finality: 'provisional' | 'final' | 'unknown';
  /** Publisher-declared version of the release's own format, if any. */
  readonly sourceVersion: string | null;
};

export type DiscoveredRelease = {
  readonly release: SourceRelease;
  readonly request: FetchRequest;
};

/** One record as the connector read it out of the artifact. */
export type ParsedRecord = {
  /** Publisher's key for this record, stable across releases. Scoped to the source. */
  readonly sourceRecordId: string;
  /** Deterministic, fully normalised plain data. No Dates, no class instances. */
  readonly record: Readonly<Record<string, unknown>>;
  /** Digest of `record`. Drives revision detection. */
  readonly contentDigest: string;
  /** Digest of the exact source text this record was read from. */
  readonly rawFragmentDigest: string;
  /**
   * Optional per-group digests. A snapshot source restates every row every
   * time, so "changed" is only useful if the run can say what kind of thing
   * changed: 12,000 assessment changes and 40 owner changes, not 12,040 rows.
   */
  readonly fieldGroupDigests?: Readonly<Record<string, string>>;
};

export type ParsedBatch = {
  readonly records: readonly ParsedRecord[];
  /** Digest of the compiled schema the parse was performed against. */
  readonly schemaDigest: string;
  readonly schemaVersion: string;
  /** Elements the source emitted that the pinned schema does not declare. Never dropped silently. */
  readonly unknownFields: readonly string[];
  /** Fields the pinned schema requires that the source omitted. */
  readonly missingFields: readonly string[];
  /** Present for snapshot sources: what the source claimed vs what we retrieved. */
  readonly snapshot?: {
    readonly sourceReportedCount: number | null;
    readonly retrievedCount: number;
    readonly duplicateCount: number;
    readonly sourceSchemaDigest: string | null;
  };
};

export type RecordValidation = {
  readonly sourceRecordId: string;
  readonly issues: readonly ValidationIssue[];
};

export type BatchValidation = {
  /**
   * True when the source's structure no longer matches the pinned schema. Drift
   * quarantines the whole run: a changed schema must never flow into
   * normalisation on the assumption that the changed part was unimportant.
   */
  readonly schemaDrift: boolean;
  readonly driftReasons: readonly string[];
  readonly records: readonly RecordValidation[];
};

/**
 * What the runtime knows about a record that the connector cannot work out on
 * its own: how it compares with the last time we saw it.
 */
export type ChangeContext = {
  readonly kind: 'new' | 'unchanged' | 'revised';
  readonly changedFieldGroups: readonly string[];
  readonly snapshotId: string | null;
};

export type NormalizeResult = {
  readonly bundle: CanonicalBundle;
  /** Contact data goes to the restricted plane, never into the bundle. */
  readonly contacts: readonly ContactObservation[];
  /**
   * Additional canonical rows, keyed by the table they belong to.
   *
   * A recorded-instrument source produces instruments, party roles, property
   * links, legal descriptions and references, none of which fit a bundle shaped
   * around transactions. The runtime persists them verbatim and never
   * interprets them, so a new source family costs a key rather than a change to
   * the pipeline.
   */
  readonly extraRows?: Readonly<Record<string, readonly unknown[]>>;
};

export type ConnectorContext = {
  readonly logger: Logger;
  readonly source: SourceDefinition;
  readonly mapping: SourceJurisdictionMapping;
  readonly runId: string;
  /**
   * A private, run-scoped scratch directory, mode 0700.
   *
   * External sorts spill here rather than sorting a dataset in memory. The
   * runtime creates it, keeps it out of the artifact and derived trees, and
   * removes it when the run ends, whether the run succeeded or failed. Files
   * written into it hold source rows verbatim — including contact-shaped columns
   * the connector has not yet routed to the restricted plane — so nothing here
   * is group- or world-readable.
   */
  readonly scratchDir?: string;
};

export type Connector = {
  readonly adapterKey: string;
  readonly connectorVersion: string;
  /** Bumped whenever parse output could change for identical bytes. */
  readonly parserVersion: string;
  /** Bumped whenever canonical output could change for an identical parsed record. */
  readonly normalizationVersion: string;
  readonly schemaVersion: string;
  readonly transport: Transport;

  discover(ctx: ConnectorContext): Promise<readonly DiscoveredRelease[]>;

  /** Must be pure and deterministic: same bytes in, byte-identical batch out. */
  parse(ctx: ConnectorContext, bytes: Uint8Array, release: SourceRelease): ParsedBatch;

  validate(ctx: ConnectorContext, batch: ParsedBatch): BatchValidation;

  normalize(
    ctx: ConnectorContext,
    parsed: ParsedRecord,
    evidence: SourceEvidence,
    change: ChangeContext,
  ): NormalizeResult;

  /**
   * Declared by sources that publish a state of the world rather than a feed of
   * events. Turns on absence detection and snapshot reconciliation in the
   * runtime; it does not fork the pipeline.
   */
  readonly snapshotSource?: boolean;
};

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'quarantined'
  | 'failed'
  | 'blocked_on_access';

export type RunStage =
  | 'discover'
  | 'fetch'
  | 'archive'
  | 'parse'
  | 'validate'
  | 'normalize'
  | 'emit';

export type RunMetrics = {
  rowsDiscovered: number;
  rowsParsed: number;
  rowsValid: number;
  rowsQuarantined: number;
  rowsEmitted: number;
  rowsUnchanged: number;
  rowsRevised: number;
  rowsNew: number;
  contactObservations: number;
  canonicalEvents: number;
  /** Snapshot sources only: keys earlier snapshots had that this one does not. */
  rowsMissingFromSnapshot: number;
  rowsResolved: number;
  rowsConflicted: number;
};

export function emptyMetrics(): RunMetrics {
  return {
    rowsDiscovered: 0,
    rowsParsed: 0,
    rowsValid: 0,
    rowsQuarantined: 0,
    rowsEmitted: 0,
    rowsUnchanged: 0,
    rowsRevised: 0,
    rowsNew: 0,
    contactObservations: 0,
    canonicalEvents: 0,
    rowsMissingFromSnapshot: 0,
    rowsResolved: 0,
    rowsConflicted: 0,
  };
}

export type SourceRun = {
  readonly runId: string;
  readonly sourceId: string;
  readonly mappingId: string;
  readonly releaseId: string | null;
  readonly adapterKey: string;
  readonly connectorVersion: string;
  readonly parserVersion: string;
  readonly normalizationVersion: string;
  readonly schemaVersion: string;
  readonly schemaDigest: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: RunStatus;
  readonly stage: RunStage;
  readonly dryRun: boolean;
  readonly replayOf: string | null;
  readonly artifactId: string | null;
  readonly artifactSha256: string | null;
  readonly metrics: RunMetrics;
  readonly validationErrorCount: number;
  readonly unknownFields: readonly string[];
  readonly missingFields: readonly string[];
  readonly failureKind: string | null;
  readonly failureMessage: string | null;
  /** Digest over every canonical bundle emitted. Two runs over the same evidence must match. */
  readonly normalizedDigest: string | null;
  readonly snapshotId: string | null;
  /** complete / partial / unverifiable, from count reconciliation. */
  readonly snapshotCompleteness: string | null;
  /** Digest over the source's own field/schema metadata at capture time. */
  readonly sourceSchemaDigest: string | null;
  readonly artifactByteLength: number | null;
  readonly sourceReportedCount: number | null;
  readonly discoveredIdCount: number | null;
  readonly downloadedCount: number | null;
  readonly duplicateCount: number;
  /** True when the source's own count moved while we were reading it. */
  readonly sourceChangedDuringRead: boolean;
  /** Digest over canonical property resolutions produced by this run. */
  readonly canonicalDigest: string | null;
  readonly batchConfiguration: Readonly<Record<string, number | string | null>>;
  /**
   * Which projection partitions this run recomputed, and how each activation
   * went. Persisted with the run rather than reconstructed from file paths: what
   * was recomputed is an auditable fact, and a multi-partition run is not
   * globally atomic, so the per-partition outcome is the only honest record.
   */
  readonly partitionPlan?: readonly string[];
  readonly partitionActivations?: readonly {
    readonly partitionId: string;
    readonly state: string;
    readonly generation: string | null;
  }[];
  /** Digest over every partition in the estate, built from their child digests. */
  readonly estateDigest?: string | null;
  readonly streamed: boolean;
};

// ---------------------------------------------------------------------------
// Streaming connectors
// ---------------------------------------------------------------------------

import type { ValidationIssue as StreamValidationIssue } from '../schema/xsd.ts';

/** One record read from a streamed artifact, with its own validation verdict. */
export type StreamedRecord = {
  readonly parsed: ParsedRecord;
  readonly issues: readonly StreamValidationIssue[];
  /**
   * The identity partition this row belongs to — a county FIPS for a
   * parcel source, absent for a source whose identity is nation-scoped.
   *
   * Snapshot indexes are kept per partition, so a delivery covering five
   * counties reads and rewrites five small indexes instead of one national one,
   * and a county's absence detection is answered from that county's own prior
   * state. Only the connector can say which partition a row is in; the runtime
   * cannot read a county out of an opaque identity string.
   */
  readonly partitionKey?: string;
};

/**
 * Facts a streamed parse can only report once the last line has been read:
 * how many rows there actually were, and whether the crawl reconciled.
 */
export type StreamSummary = {
  readonly driftReasons: readonly string[];
  readonly unknownFields: readonly string[];
  readonly missingFields: readonly string[];
  readonly snapshot?: {
    readonly sourceReportedCount: number | null;
    readonly retrievedCount: number;
    readonly duplicateCount: number;
    readonly sourceSchemaDigest: string | null;
    readonly sourceChangedDuringRead: boolean;
  };
  /**
   * Fingerprint hits the duplicate index rejected after checking the full key.
   *
   * Reported, never a drift reason. A rejected collision is the exactness check
   * doing its job: no false duplicate was produced, and quarantining a
   * multi-million-row delivery because two sha256 prefixes matched would be a
   * manufactured failure. Zero is the expected value; a non-zero one is worth
   * seeing precisely because it proves the check is load-bearing.
   */
  readonly identityFingerprintCollisions?: number;
};

/**
 * A parse in progress over a line stream.
 *
 * The header is read eagerly by `openStream`, so schema drift is detectable
 * before a single record is normalised — there is no point streaming 448,000
 * rows through a parser that is about to be told the schema moved.
 */
export type StreamingParseSession = {
  readonly schemaVersion: string;
  readonly schemaDigest: string;
  /** Non-empty means: quarantine now, do not read records. */
  readonly earlyDriftReasons: readonly string[];
  /**
   * Rows the delivery declares, when it declares any.
   *
   * Advisory: it sizes buffers before the first row is read, and is never used
   * to decide whether a run is complete — that is the trailer's job, from the
   * count the publisher reported at the end.
   */
  readonly declaredRowCount?: number;
  records(): AsyncGenerator<StreamedRecord>;
  /** Valid only after `records()` is exhausted. */
  finish(): StreamSummary;
};

export type StreamingConnector = Connector & {
  readonly streaming: true;
  openStream(ctx: ConnectorContext, lines: AsyncIterable<string>): Promise<StreamingParseSession>;
};

export function isStreamingConnector(connector: Connector): connector is StreamingConnector {
  return (connector as StreamingConnector).streaming === true;
}
