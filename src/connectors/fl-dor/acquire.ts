/**
 * Unattended acquisition of a Florida DOR release: one GET per county file.
 *
 * A Florida release is not one archive but a FOLDER of them — 67 county rolls,
 * or 67 county shapefiles and two condominium tables. Each file is streamed
 * into the content-addressed artifact store exactly as the Department serves
 * it; its sha256 is its identity. Then the release itself is written down as a
 * small **release manifest** artifact: every file's county, stage, URL, ETag,
 * size, time and sha256, in DOR county order. That manifest's sha256 is what
 * the ledger records and what a replay names, so one digest pins the whole set.
 *
 * A file whose URL, ETag, size and time match one already retained is reused,
 * not downloaded again: when one county moves from preliminary to final, the
 * other 66 are not fetched a second time.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { artifactDir, type AccessMetadata, type ArchivedArtifact, type StreamingArtifactStore } from '../../archive/artifact-store.ts';
import { fail } from '../../core/errors.ts';
import { canonicalJson, sha256 } from '../../core/hash.ts';
import { type Logger, silentLogger } from '../../core/logging.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import type { SourceDefinition } from '../../registry/types.ts';
import { downloadArchive, type DiscoveredArchiveRelease, type HttpDeps } from '../../runtime/bulk-acquisition.ts';
import type { FlCountyFile, FlRollRelease } from './portal.ts';

export const FL_RELEASE_MANIFEST_KIND = 'df.fl_dor.release_manifest/1';

export type FlReleaseManifestFile = {
  readonly dorCode: string;
  readonly countyFips: string;
  readonly role: FlCountyFile['role'];
  readonly stage: FlCountyFile['stage'];
  readonly folder: string;
  readonly name: string;
  readonly url: string;
  readonly etag: string | null;
  readonly bytes: number;
  readonly lastModified: string;
  readonly nameAnomalies: readonly string[];
  readonly sha256: string;
  /** When THESE bytes were first retrieved. A reused file keeps its original retrieval. */
  readonly retrievedAt: string;
};

export type FlReleaseManifest = {
  readonly kind: typeof FL_RELEASE_MANIFEST_KIND;
  readonly sourceId: string;
  readonly releaseKind: FlRollRelease['kind'];
  readonly rollYear: number;
  readonly referencePeriod: string;
  readonly releaseFingerprint: string;
  readonly stageCounts: Readonly<Record<string, number>>;
  readonly missingCounties: readonly string[];
  readonly unrecognized: readonly string[];
  readonly files: readonly FlReleaseManifestFile[];
};

export type FlAcquisition = {
  readonly manifest: FlReleaseManifest;
  /** The release manifest itself, archived. Its sha256 names the release. */
  readonly manifestArtifact: ArchivedArtifact;
  readonly files: readonly { readonly entry: FlReleaseManifestFile; readonly artifact: ArchivedArtifact; readonly reused: boolean }[];
  readonly downloadedBytes: number;
  readonly ms: number;
};

type FileIndexLine = {
  readonly key: string;
  readonly sha256: string;
  readonly referencePeriod: string;
  readonly originalFilename: string;
  readonly retrievedAt: string;
};

/** What the Department says about one file, as the reuse key. */
function fileKey(file: FlCountyFile): string {
  return sha256(canonicalJson({
    url: file.file.url, etag: file.file.etag, bytes: file.file.bytes, lastModified: file.file.lastModified,
  }));
}

export function accessOfSource(source: SourceDefinition): AccessMetadata {
  return {
    accessType: source.accessType,
    automationStatus: source.automationStatus,
    termsStatus: source.termsStatus,
    licenseStatus: source.licenseStatus,
    carriesRestrictedContact: source.carriesRestrictedContact,
  };
}

export async function acquireFlRelease(options: {
  readonly release: FlRollRelease;
  readonly source: SourceDefinition;
  readonly artifactStore: StreamingArtifactStore;
  readonly varRoot: string;
  readonly now: () => Date;
  readonly http?: HttpDeps;
  readonly logger?: Logger;
}): Promise<FlAcquisition> {
  const { release, source, artifactStore } = options;
  const logger = (options.logger ?? silentLogger()).child({ acquisition: source.sourceId });
  if (release.files.length === 0) fail('SCHEMA_DRIFT', `the ${release.kind} release lists no files`);
  const started = Date.now();
  const indexPath = join(options.varRoot, 'acquisition', `${source.sourceId}.files.ndjson`);
  const index = await readIndex(indexPath);

  const files: FlAcquisition['files'][number][] = [];
  let downloadedBytes = 0;
  for (const countyFile of release.files) {
    const key = fileKey(countyFile);
    const known = index.get(key);
    let artifact: ArchivedArtifact | null = null;
    let retrievedAt: string;
    if (known !== undefined) {
      artifact = await retained(artifactStore, source.sourceId, known);
    }
    if (artifact !== null && known !== undefined) {
      retrievedAt = known.retrievedAt;
      files.push({ entry: entryOf(countyFile, artifact.sha256, retrievedAt), artifact, reused: true });
      continue;
    }
    retrievedAt = options.now().toISOString();
    const perFile: DiscoveredArchiveRelease = {
      sourceId: source.sourceId,
      referencePeriod: release.referencePeriod,
      releaseFingerprint: key,
      head: {
        url: countyFile.file.url, etag: countyFile.file.etag, lastModified: countyFile.file.lastModified,
        contentLength: countyFile.file.bytes, versionId: countyFile.file.versionLabel, acceptRanges: false,
      },
    };
    const download = await downloadArchive(perFile, artifactStore, {
      sourceAuthority: source.sourceAuthority,
      sourceProgram: source.sourceProgram,
      sourceFamily: source.sourceFamily,
      sourceId: source.sourceId,
      releaseId: `${source.sourceId}__${release.referencePeriod}`,
      referencePeriod: release.referencePeriod,
      originalFilename: countyFile.file.name,
      retrievedAt,
      // The Department's own last-modified time for this county's file.
      effectiveAt: countyFile.file.lastModified,
      jurisdictionIds: [countyJurisdictionId(countyFile.county.fips)],
      access: accessOfSource(source),
    }, options.http ?? {});
    artifact = download.artifact;
    downloadedBytes += artifact.byteLength;
    const line: FileIndexLine = {
      key, sha256: artifact.sha256, referencePeriod: release.referencePeriod,
      originalFilename: countyFile.file.name, retrievedAt,
    };
    await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
    await appendFile(indexPath, `${canonicalJson(line)}\n`, { mode: 0o600 });
    index.set(key, line);
    logger.info('fl.file_acquired', {
      county: countyFile.county.dorCode, file: countyFile.file.name, bytes: artifact.byteLength, sha256: artifact.sha256, ms: download.ms,
    });
    files.push({ entry: entryOf(countyFile, artifact.sha256, retrievedAt), artifact, reused: false });
  }

  const manifest: FlReleaseManifest = {
    kind: FL_RELEASE_MANIFEST_KIND,
    sourceId: source.sourceId,
    releaseKind: release.kind,
    rollYear: release.rollYear,
    referencePeriod: release.referencePeriod,
    releaseFingerprint: release.releaseFingerprint,
    stageCounts: release.stageCounts,
    missingCounties: release.missingCounties,
    unrecognized: release.unrecognized,
    files: files.map((f) => f.entry),
  };
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  // The release manifest's retrieval instant is the latest of its files', so
  // it is a pure function of what was fetched — never of when it was written.
  const manifestRetrievedAt = files.map((f) => f.entry.retrievedAt).sort().at(-1) as string;
  const manifestArtifact = await artifactStore.archiveStream({
    sourceAuthority: source.sourceAuthority,
    sourceProgram: source.sourceProgram,
    sourceFamily: source.sourceFamily,
    sourceId: source.sourceId,
    releaseId: `${source.sourceId}__${release.referencePeriod}`,
    referencePeriod: release.referencePeriod,
    originalUrl: null,
    originalFilename: 'fl-dor-release-manifest.json',
    retrievedAt: manifestRetrievedAt,
    effectiveAt: null,
    jurisdictionIds: [...new Set(files.map((f) => countyJurisdictionId(f.entry.countyFips)))].sort(),
    access: accessOfSource(source),
  }, async (sink) => { await sink.write(bytes); });
  return { manifest, manifestArtifact, files, downloadedBytes, ms: Date.now() - started };
}

function entryOf(countyFile: FlCountyFile, sha: string, retrievedAt: string): FlReleaseManifestFile {
  return {
    dorCode: countyFile.county.dorCode,
    countyFips: countyFile.county.fips,
    role: countyFile.role,
    stage: countyFile.stage,
    folder: countyFile.folder,
    name: countyFile.file.name,
    url: countyFile.file.url,
    etag: countyFile.file.etag,
    bytes: countyFile.file.bytes,
    lastModified: countyFile.file.lastModified,
    nameAnomalies: countyFile.nameAnomalies,
    sha256: sha,
    retrievedAt,
  };
}

async function readIndex(path: string): Promise<Map<string, FileIndexLine>> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const out = new Map<string, FileIndexLine>();
  for (const line of text.split('\n')) if (line.trim() !== '') {
    const parsed = JSON.parse(line) as FileIndexLine;
    out.set(parsed.key, parsed);
  }
  return out;
}

/** A retained artifact for a known file, or null when its bytes are no longer in the store. */
async function retained(
  store: StreamingArtifactStore,
  sourceId: string,
  known: FileIndexLine,
): Promise<ArchivedArtifact | null> {
  return locateArtifact(store, sourceId, known.referencePeriod, known.sha256);
}

/** Finds a retained artifact by digest. Never re-downloads. */
export async function locateArtifact(
  store: StreamingArtifactStore,
  sourceId: string,
  referencePeriod: string,
  sha: string,
): Promise<ArchivedArtifact | null> {
  const dir = artifactDir(sourceId, referencePeriod, sha);
  try {
    const manifest = await store.readManifest({ manifestPath: `${dir}/manifest.json` });
    const dot = manifest.originalFilename.lastIndexOf('.');
    const ext = dot === -1 ? '' : manifest.originalFilename.slice(dot).toLowerCase();
    return {
      artifactId: `artifact_${sha}`, sha256: sha, byteLength: manifest.byteLength,
      storagePath: `${dir}/source-original${ext}`, manifestPath: `${dir}/manifest.json`, created: false, manifest,
    };
  } catch {
    return null;
  }
}

/** Reads an archived release manifest back, verifying its kind. */
export async function readReleaseManifest(store: StreamingArtifactStore, artifact: ArchivedArtifact): Promise<FlReleaseManifest> {
  const text = (await readFile(store.localPath(artifact), 'utf8')).trim();
  const parsed = JSON.parse(text) as FlReleaseManifest;
  if (parsed.kind !== FL_RELEASE_MANIFEST_KIND) fail('PARSE', `artifact ${artifact.sha256} is not a Florida release manifest`);
  if (sha256(`${canonicalJson(parsed)}\n`) !== artifact.sha256) fail('IMMUTABILITY', 'release manifest bytes do not match their digest');
  return parsed;
}
