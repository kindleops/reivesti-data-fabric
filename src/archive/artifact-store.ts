/**
 * Immutable, content-addressed source-evidence archive.
 *
 * Layout:
 *   data-fabric/<sourceId>/<referencePeriod>/sha256-<digest>/
 *     source-original.<ext>
 *     manifest.json                                (retrieval facts, write-once)
 *     interpretation/<parserVersion>__<schemaVersion>.json   (per parse, write-once)
 *
 * Identity is the digest, never the URL and never the filename. A publisher who
 * republishes `weekly.zip` with new bytes produces a second artifact directory;
 * the first one stays exactly as retrieved. Republishing identical bytes is a
 * no-op that still records a fresh sighting on the run, not a new artifact.
 *
 * The retrieval manifest and the interpretation record are separated on purpose.
 * Byte-length, digest and retrieval time are known the moment the bytes land and
 * must never change. Record counts, effective date and parser version are claims
 * a *particular parser version* makes about those bytes, and a later parser may
 * make different claims about the same evidence without rewriting history.
 */
import { fail } from '../core/errors.ts';
import { canonicalJson, contentDigest, sha256 } from '../core/hash.ts';
import type { ObjectStore } from './object-store.ts';

export const ARCHIVE_ROOT = 'data-fabric';

export type AccessMetadata = {
  readonly accessType: string;
  readonly automationStatus: string;
  readonly termsStatus: string;
  readonly licenseStatus: string;
  /** True when the bytes may contain personal contact data or protected identity. */
  readonly carriesRestrictedContact: boolean;
};

export type RetrievalManifest = {
  readonly manifestVersion: 1;
  readonly sourceAuthority: string;
  readonly sourceProgram: string;
  readonly sourceFamily: string;
  readonly sourceId: string;
  readonly releaseId: string;
  readonly referencePeriod: string;
  /** The URL the bytes came from. Provenance — never identity. */
  readonly originalUrl: string | null;
  readonly originalFilename: string;
  readonly retrievedAt: string;
  /** Source-declared effective instant, when the publisher supplies one. */
  readonly effectiveAt: string | null;
  readonly byteLength: number;
  readonly sha256: string;
  readonly jurisdictionIds: readonly string[];
  readonly access: AccessMetadata;
};

export type InterpretationRecord = {
  readonly manifestVersion: 1;
  readonly artifactId: string;
  readonly sha256: string;
  readonly parserVersion: string;
  readonly schemaVersion: string;
  /** Digest of the compiled schema the parser validated against. */
  readonly schemaDigest: string;
  readonly recordCount: number;
  /** Digest over every normalised record: the replay determinism fingerprint. */
  readonly contentDigest: string;
  readonly quarantined: boolean;
  readonly validationErrorCount: number;
};

export type ArchivedArtifact = {
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly storagePath: string;
  readonly manifestPath: string;
  /** false when these exact bytes were already retained: dedupe, not a new artifact. */
  readonly created: boolean;
  readonly manifest: RetrievalManifest;
};

/** Complete provenance view: retrieval facts plus every interpretation of them. */
export type ArtifactManifestView = {
  readonly retrieval: RetrievalManifest;
  readonly interpretations: readonly InterpretationRecord[];
};

export type ArtifactStore = {
  archive(input: ArchiveInput): Promise<ArchivedArtifact>;
  /** Reads bytes back and re-verifies the digest before returning them. */
  read(artifact: Pick<ArchivedArtifact, 'storagePath' | 'sha256'>): Promise<Buffer>;
  readManifest(artifact: Pick<ArchivedArtifact, 'manifestPath'>): Promise<RetrievalManifest>;
  recordInterpretation(artifact: ArchivedArtifact, record: InterpretationRecord): Promise<{ created: boolean }>;
  view(artifact: ArchivedArtifact): Promise<ArtifactManifestView>;
};

export type ArchiveInput = {
  readonly bytes: Uint8Array;
  readonly sourceAuthority: string;
  readonly sourceProgram: string;
  readonly sourceFamily: string;
  readonly sourceId: string;
  readonly releaseId: string;
  /** Publisher's period label, e.g. "2026-W31". Part of the storage path only. */
  readonly referencePeriod: string;
  readonly originalUrl: string | null;
  readonly originalFilename: string;
  readonly retrievedAt: string;
  readonly effectiveAt: string | null;
  readonly jurisdictionIds: readonly string[];
  readonly access: AccessMetadata;
};

export function createArtifactStore(store: ObjectStore): ArtifactStore {
  return {
    async archive(input) {
      const digest = sha256(input.bytes);
      const dir = artifactDir(input.sourceId, input.referencePeriod, digest);
      const objectKey = `${dir}/source-original${extensionOf(input.originalFilename)}`;
      const manifestKey = `${dir}/manifest.json`;
      const artifactId = `artifact_${digest}`;

      const put = await store.put(objectKey, input.bytes);
      if (put.sha256 !== digest) {
        fail('IMMUTABILITY', 'object store returned a digest that disagrees with the archived bytes', {
          expected: digest,
          actual: put.sha256,
        });
      }

      const manifest: RetrievalManifest = {
        manifestVersion: 1,
        sourceAuthority: input.sourceAuthority,
        sourceProgram: input.sourceProgram,
        sourceFamily: input.sourceFamily,
        sourceId: input.sourceId,
        releaseId: input.releaseId,
        referencePeriod: input.referencePeriod,
        originalUrl: input.originalUrl,
        originalFilename: input.originalFilename,
        retrievedAt: input.retrievedAt,
        effectiveAt: input.effectiveAt,
        byteLength: input.bytes.byteLength,
        sha256: digest,
        jurisdictionIds: [...input.jurisdictionIds].sort(),
        access: input.access,
      };

      // A second retrieval of identical bytes keeps the first manifest. The
      // retrieval time of the original sighting is the historical fact; the new
      // sighting is recorded on the run, not by rewriting the artifact.
      const manifestExists = await store.exists(manifestKey);
      if (!manifestExists) {
        await store.put(manifestKey, encode(manifest));
      }
      const retained = manifestExists ? decode<RetrievalManifest>(await store.get(manifestKey)) : manifest;

      return {
        artifactId,
        sha256: digest,
        byteLength: input.bytes.byteLength,
        storagePath: objectKey,
        manifestPath: manifestKey,
        created: put.created,
        manifest: retained,
      };
    },

    async read(artifact) {
      const bytes = await store.get(artifact.storagePath);
      const actual = sha256(bytes);
      if (actual !== artifact.sha256) {
        fail('REPLAY', 'retained artifact failed digest verification on read', {
          storagePath: artifact.storagePath,
          expected: artifact.sha256,
          actual,
        });
      }
      return bytes;
    },

    async readManifest(artifact) {
      return decode<RetrievalManifest>(await store.get(artifact.manifestPath));
    },

    async recordInterpretation(artifact, record) {
      if (record.sha256 !== artifact.sha256) {
        fail('CONFIG', 'interpretation digest does not match the artifact it describes', {
          artifact: artifact.sha256,
          record: record.sha256,
        });
      }
      const key = `${dirOf(artifact.storagePath)}/interpretation/${safeSegment(record.parserVersion)}__${safeSegment(record.schemaVersion)}.json`;
      // put() refuses a differing rewrite, so an identical re-parse is a no-op
      // and a *changed* result under the same parser version is a hard failure.
      const result = await store.put(key, encode(record));
      return { created: result.created };
    },

    async view(artifact) {
      const retrieval = decode<RetrievalManifest>(await store.get(artifact.manifestPath));
      const keys = await store.list(`${dirOf(artifact.storagePath)}/interpretation`);
      const interpretations: InterpretationRecord[] = [];
      for (const key of keys) interpretations.push(decode<InterpretationRecord>(await store.get(key)));
      return { retrieval, interpretations };
    },
  };
}

export function artifactDir(sourceId: string, referencePeriod: string, digest: string): string {
  return `${ARCHIVE_ROOT}/${safeSegment(sourceId)}/${safeSegment(referencePeriod)}/sha256-${digest}`;
}

function dirOf(key: string): string {
  return key.slice(0, key.lastIndexOf('/'));
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  const ext = filename.slice(dot);
  return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext.toLowerCase() : '';
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) fail('CONFIG', `path segment "${value}" is empty after sanitisation`);
  return cleaned;
}

function encode(value: unknown): Uint8Array {
  // Canonical JSON: re-encoding the same manifest yields the same bytes, so
  // write-once storage treats an identical rewrite as a no-op rather than a clash.
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

function decode<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export { contentDigest };

// ---------------------------------------------------------------------------
// Streaming archival
// ---------------------------------------------------------------------------

import type { ByteSink, StreamingObjectStore } from './object-store.ts';
import { readLines } from '../core/lines.ts';

export type StreamingArchiveInput = Omit<ArchiveInput, 'bytes'>;

export type StreamingArtifactStore = ArtifactStore & {
  /**
   * Archives bytes produced incrementally.
   *
   * The content-addressed key is unknowable until the last byte, so the stream
   * is staged and digested first, then promoted into its digest-named home.
   * A failure anywhere leaves the staging file and no artifact at all: a
   * half-downloaded county can never be mistaken for a complete one.
   */
  archiveStream(
    input: StreamingArchiveInput,
    produce: (sink: ByteSink) => Promise<void>,
  ): Promise<ArchivedArtifact>;

  /** Re-reads the artifact and confirms its digest. Holds nothing. */
  verify(artifact: Pick<ArchivedArtifact, 'storagePath' | 'sha256'>): Promise<void>;

  /**
   * Yields the artifact's lines, verifying the digest FIRST.
   *
   * Verification is a separate pass on purpose. Hashing while yielding would
   * only detect corruption after a consumer had already acted on the corrupt
   * rows, which is worse than useless for a provenance system.
   */
  readLinesVerified(
    artifact: Pick<ArchivedArtifact, 'storagePath' | 'sha256'>,
  ): AsyncGenerator<string>;

  /**
   * The artifact's path on local disk, for formats that need random access —
   * a ZIP's central directory lives at its end. Read-only: retained objects are
   * mode 0444, and a caller must `verify` before trusting what it reads.
   */
  localPath(artifact: Pick<ArchivedArtifact, 'storagePath'>): string;
};

export function createStreamingArtifactStore(store: StreamingObjectStore): StreamingArtifactStore {
  const base = createArtifactStore(store);

  const verify = async (artifact: Pick<ArchivedArtifact, 'storagePath' | 'sha256'>): Promise<void> => {
    const actual = await store.digestOf(artifact.storagePath);
    if (actual.sha256 !== artifact.sha256) {
      fail('REPLAY', 'retained artifact failed digest verification on read', {
        storagePath: artifact.storagePath, expected: artifact.sha256, actual: actual.sha256,
      });
    }
  };

  return {
    ...base,
    verify,

    async archiveStream(input, produce) {
      const staged = await store.stage(produce);
      const dir = artifactDir(input.sourceId, input.referencePeriod, staged.sha256);
      const objectKey = `${dir}/source-original${extensionOf(input.originalFilename)}`;
      const manifestKey = `${dir}/manifest.json`;

      const put = await staged.promote(objectKey);

      const manifest: RetrievalManifest = {
        manifestVersion: 1,
        sourceAuthority: input.sourceAuthority,
        sourceProgram: input.sourceProgram,
        sourceFamily: input.sourceFamily,
        sourceId: input.sourceId,
        releaseId: input.releaseId,
        referencePeriod: input.referencePeriod,
        originalUrl: input.originalUrl,
        originalFilename: input.originalFilename,
        retrievedAt: input.retrievedAt,
        effectiveAt: input.effectiveAt,
        byteLength: staged.byteLength,
        sha256: staged.sha256,
        jurisdictionIds: [...input.jurisdictionIds].sort(),
        access: input.access,
      };

      // As in the buffered path, a second retrieval of identical bytes keeps the
      // first manifest: the original retrieval time is the historical fact.
      const manifestExists = await store.exists(manifestKey);
      if (!manifestExists) await store.put(manifestKey, encodeManifest(manifest));
      const retained = manifestExists
        ? (JSON.parse(new TextDecoder().decode(await store.get(manifestKey))) as RetrievalManifest)
        : manifest;

      return {
        artifactId: `artifact_${staged.sha256}`,
        sha256: staged.sha256,
        byteLength: staged.byteLength,
        storagePath: objectKey,
        manifestPath: manifestKey,
        created: put.created,
        manifest: retained,
      };
    },

    async *readLinesVerified(artifact) {
      await verify(artifact);
      yield* readLines(store.pathOf(artifact.storagePath));
    },

    localPath(artifact) {
      return store.pathOf(artifact.storagePath);
    },
  };
}

function encodeManifest(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}
