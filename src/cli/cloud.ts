/**
 * Cloud-worker commands: `df doctor` and `df artifacts …`.
 *
 * Doctor answers one question — can this machine, as configured, do the job
 * without any other machine? — and reports every secret as configured yes/no.
 * A value never leaves the process.
 */
import { execFile } from 'node:child_process';
import { access, constants, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import {
  artifactKey,
  hashObject,
  manifestKey,
} from '../archive/artifact-backend.ts';
import {
  DURABLE_ENV,
  commitDurable,
  durableStoreFromEnv,
  readDurableManifest,
  rehydrate,
  type DurableStore,
} from '../archive/durable-artifacts.ts';
import type { StreamingArtifactStore, ArchivedArtifact } from '../archive/artifact-store.ts';
import { artifactDir } from '../archive/artifact-store.ts';
import { readFileSync } from 'node:fs';

const run = promisify(execFile);

export type DoctorCheck = { readonly check: string; readonly ok: boolean; readonly detail: string };

export async function doctor(options: {
  readonly varRoot: string;
  readonly archiveRoot: string;
  readonly repoRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Write, read back and verify a small probe object in the durable store. */
  readonly probe?: boolean;
}): Promise<{ ready: boolean; checks: readonly DoctorCheck[]; secrets: Readonly<Record<string, 'configured' | 'absent'>> }> {
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  add('node >= 22.18', major > 22 || (major === 22 && minor >= 18), process.version);

  for (const bin of ['git', 'unzip']) {
    const found = await run('sh', ['-c', `command -v ${bin}`]).then(() => true, () => false);
    add(`binary ${bin}`, found || bin === 'unzip', found ? 'present' : bin === 'unzip' ? 'absent (not required: the Fabric reads ZIP itself)' : 'absent');
  }

  for (const [name, dir] of [['var root', options.varRoot], ['workspace archive', options.archiveRoot]] as const) {
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.doctor-${process.pid}`);
      await writeFile(probe, 'ok', { mode: 0o600 });
      await rm(probe);
      add(`${name} writable`, true, dir);
    } catch (e) {
      add(`${name} writable`, false, `${dir}: ${(e as Error).message}`);
    }
  }

  try {
    const fs = await statfs(options.varRoot);
    const freeGb = (fs.bavail * fs.bsize) / 1e9;
    // One Wisconsin release needs ~0.8 GB archive + ~2.7 GB bundle + ~6 GB compressed estate.
    add('disk free >= 12 GB', freeGb >= 12, `${freeGb.toFixed(1)} GB free (DF_DERIVED_GZIP=${env['DF_DERIVED_GZIP'] ?? 'unset'})`);
  } catch (e) {
    add('disk free', false, (e as Error).message);
  }
  add('memory >= 2 GB', totalmem() >= 2e9, `${(totalmem() / 1e9).toFixed(1)} GB total, ${(freemem() / 1e9).toFixed(1)} GB free`);

  const pgBin = join(options.repoRoot, 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`, 'native', 'bin', 'pg_ctl');
  const pg = await access(env['DF_PG_BINDIR'] ? join(env['DF_PG_BINDIR'] as string, 'pg_ctl') : pgBin, constants.X_OK).then(() => true, () => false);
  add('postgres test binaries', pg, pg ? 'available (initdb refuses root: run the PG suite as an unprivileged user)' : 'absent: npm ci installs embedded-postgres');

  const secrets: Record<string, 'configured' | 'absent'> = {};
  for (const name of Object.values(DURABLE_ENV)) secrets[name] = env[name] ? 'configured' : 'absent';

  let store: DurableStore | null = null;
  try {
    store = durableStoreFromEnv(env);
    add('artifact backend', store !== null, store === null
      ? `none configured (${DURABLE_ENV.backend} unset): acquisition works, but raw bytes are NOT durable beyond this machine`
      : `${store.backend.describe().kind} ${store.backend.describe().location} durable=${store.backend.describe().durable} required=${store.required}`);
  } catch (e) {
    add('artifact backend', false, (e as Error).message);
  }

  if (store !== null && options.probe) {
    try {
      // A tiny, unique, content-addressed probe: exercises PUT, HEAD, GET and
      // re-hash end to end with the real credentials.
      const bytes = randomBytes(64);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const dir = join(options.varRoot, 'scratch');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `doctor-probe-${sha}`);
      await writeFile(path, bytes, { mode: 0o600 });
      const key = `${store.prefix}/doctor-probes/${sha}`;
      await store.backend.putFile(key, path, { sha256: sha, bytes: bytes.length, contentType: 'application/octet-stream' });
      const back = await hashObject(store.backend, key);
      await rm(path, { force: true });
      add('artifact backend round trip', back.sha256 === sha, `PUT/HEAD/GET/verify ${back.sha256 === sha ? 'ok' : 'MISMATCH'}`);
    } catch (e) {
      add('artifact backend round trip', false, (e as Error).message);
    }
  }

  add('network mode', true, env['HTTPS_PROXY'] ? 'egress via configured proxy' : 'direct');
  const ready = checks.every((c) => c.ok || c.check.startsWith('binary unzip'));
  return { ready, checks, secrets };
}

// ---------------------------------------------------------------------------

/** Pushes a workspace artifact to the durable store, with full verification. */
export async function pushArtifact(
  store: DurableStore,
  workspace: StreamingArtifactStore,
  artifact: ArchivedArtifact,
  role: 'publisher_raw' | 'derived_bundle',
  contentType: string,
  derivedFrom: string | null,
) {
  return commitDurable(store, workspace, artifact, { role, contentType, derivedFrom, verifyByReread: true });
}

export async function pullArtifact(store: DurableStore, workspace: StreamingArtifactStore, sha256: string) {
  return rehydrate(store, workspace, sha256);
}

/** Re-hashes a durable object end to end against its key. */
export async function verifyDurable(store: DurableStore, sha256: string) {
  const manifest = await readDurableManifest(store, sha256);
  const head = await store.backend.head(artifactKey(store.prefix, sha256));
  if (head === null) return { sha256, state: 'MISSING_BYTES' as const, manifest: manifest !== null };
  const actual = await hashObject(store.backend, artifactKey(store.prefix, sha256));
  const ok = actual.sha256 === sha256 && (manifest === null || actual.bytes === manifest.bytes);
  return {
    sha256, state: ok ? ('DURABLE' as const) : ('CORRUPT' as const), bytes: actual.bytes,
    manifest: manifest !== null, verifiedAt: new Date().toISOString(), key: artifactKey(store.prefix, sha256),
    manifestKey: manifestKey(store.prefix, sha256),
  };
}

export type CatalogEntry = {
  readonly sha256: string | null;
  readonly sourceId: string;
  readonly role: string;
  readonly bytes: number | null;
  readonly referencePeriod: string | null;
  readonly publisherUrl: string | null;
  readonly publisherFilename: string | null;
  readonly contentType: string | null;
  readonly contentEncoding: string;
  readonly firstSeenAt: string | null;
  readonly expectedState: string;
  readonly note: string;
};

/**
 * The known-artifact catalog: Git's pinned expectations, reconciled against
 * what the workspace and the durable store actually hold.
 */
export async function catalog(options: {
  readonly repoRoot: string;
  readonly store: DurableStore | null;
  readonly workspace: StreamingArtifactStore;
  readonly verify?: boolean;
}) {
  const pinned = JSON.parse(readFileSync(join(options.repoRoot, 'reference', 'artifact-catalog.json'), 'utf8')) as { entries: CatalogEntry[] };
  const out = [];
  for (const entry of pinned.entries) {
    let workspace = false;
    if (entry.referencePeriod && entry.sha256 !== null) {
      const dir = artifactDir(entry.sourceId, entry.referencePeriod, entry.sha256);
      workspace = await options.workspace.readManifest({ manifestPath: `${dir}/manifest.json` }).then(() => true, () => false);
    }
    let durable: string = options.store === null ? 'NO_DURABLE_BACKEND' : 'MISSING_BYTES';
    let verifiedAt: string | null = null;
    if (entry.sha256 === null) {
      // Only a prefix was ever recorded: nothing can be looked up by digest.
      out.push({ ...entry, workspaceCopy: false, durableCopy: 'DIGEST_INCOMPLETE', lastVerifiedAt: null, state: entry.expectedState });
      continue;
    }
    if (options.store !== null) {
      const head = await options.store.backend.head(artifactKey(options.store.prefix, entry.sha256));
      if (head !== null) {
        if (options.verify) {
          const v = await verifyDurable(options.store, entry.sha256);
          durable = v.state;
          verifiedAt = 'verifiedAt' in v ? v.verifiedAt ?? null : null;
        } else durable = head.bytes === entry.bytes ? 'DURABLE_UNVERIFIED' : 'SIZE_MISMATCH';
      }
    }
    const state = durable === 'DURABLE' || durable === 'DURABLE_UNVERIFIED' ? 'DURABLE'
      : workspace ? 'EPHEMERAL_ONLY' : entry.expectedState;
    out.push({ ...entry, workspaceCopy: workspace, durableCopy: durable, lastVerifiedAt: verifiedAt, state });
  }
  return out;
}

/**
 * Re-downloads a catalogued raw artifact from its publisher and accepts it as a
 * RESTORATION only if the sha256 is exactly the catalogued one. Different bytes
 * are a new release, kept under their own digest and reported as such — never
 * relabelled as the old one.
 */
export async function reacquire(
  entry: CatalogEntry,
  workspace: StreamingArtifactStore,
  retrievedAt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ restored: boolean; expected: string | null; actual: string; bytes: number; artifact: ArchivedArtifact }> {
  if (entry.role !== 'publisher_raw' || entry.publisherUrl === null || entry.referencePeriod === null) {
    throw new Error('only a catalogued publisher_raw artifact with a URL can be reacquired');
  }
  const url = entry.publisherUrl;
  const artifact = await workspace.archiveStream({
    sourceAuthority: entry.sourceId, sourceProgram: entry.sourceId, sourceFamily: 'reacquisition',
    sourceId: entry.sourceId, releaseId: `${entry.sourceId}__${entry.referencePeriod}`, referencePeriod: entry.referencePeriod,
    originalUrl: url, originalFilename: entry.publisherFilename ?? 'artifact', retrievedAt, effectiveAt: null,
    jurisdictionIds: [],
    access: { accessType: 'bulk_download', automationStatus: 'sanctioned', termsStatus: 'reviewed_permitted', licenseStatus: 'open_with_attribution', carriesRestrictedContact: true },
  }, async (sink) => {
    const r = await fetchImpl(url);
    if (!r.ok || r.body === null) throw new Error(`GET ${url} returned ${r.status}`);
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) await sink.write(chunk);
  });
  return { restored: artifact.sha256 === entry.sha256, expected: entry.sha256, actual: artifact.sha256, bytes: artifact.byteLength, artifact };
}
