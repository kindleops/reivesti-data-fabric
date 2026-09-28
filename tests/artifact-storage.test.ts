/**
 * Durable artifact storage: the contract every backend must honour, and the
 * lifecycle that makes an execution machine disposable.
 *
 * Every contract test runs against LOCAL (always) and against a real
 * S3-protocol peer that enforces SigV4 and IAM (moto, when installed — skipped
 * loudly otherwise). No test contacts a cloud provider.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactKey,
  createLocalBackend,
  downloadVerified,
  hashObject,
  manifestKey,
  releaseKey,
  type ArtifactBackend,
} from '../src/archive/artifact-backend.ts';
import { createS3Backend } from '../src/archive/s3-backend.ts';
import {
  assertNoSilentDowngrade,
  commitDurable,
  durableStoreFromEnv,
  rehydrate,
  type DurableStore,
} from '../src/archive/durable-artifacts.ts';
import { createStreamingArtifactStore } from '../src/archive/artifact-store.ts';
import { createStreamingFilesystemObjectStore } from '../src/archive/object-store.ts';
import { isFabricError } from '../src/core/errors.ts';
import { startTestS3, type TestS3 } from './support/s3-server.ts';

let s3: TestS3 | null = null;
before(async () => {
  s3 = await startTestS3();
  if (s3 === null) {
    process.stdout.write('# S3 CONTRACT TESTS SKIPPED: moto_server not found (set DF_TEST_MOTO_SERVER or create .s3env)\n');
  }
});
after(async () => { await s3?.stop(); });

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function s3Backend(overrides: Partial<Parameters<typeof createS3Backend>[0]> = {}): ArtifactBackend {
  if (!s3) throw new Error('no s3');
  return createS3Backend({
    endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket,
    accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey,
    partBytes: 5 * 1024 * 1024, sleep: async () => {}, ...overrides,
  });
}

type Kind = 'LOCAL' | 'S3';
function backends(): { kind: Kind; make: () => ArtifactBackend }[] {
  const out: { kind: Kind; make: () => ArtifactBackend }[] = [{ kind: 'LOCAL', make: () => createLocalBackend(tmp('df-durable-'), { durable: true }) }];
  if (s3) out.push({ kind: 'S3', make: () => s3Backend() });
  return out;
}

function file(bytes: Buffer): { path: string; sha256: string; bytes: number } {
  const dir = tmp('df-src-');
  const path = join(dir, 'blob');
  writeFileSync(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

const unique = () => `t${Date.now()}${Math.random().toString(36).slice(2)}`;

// ===========================================================================
// Identity and keys
// ===========================================================================

test('keys are derived from the content hash alone', () => {
  const sha = 'b22bfaad251676f7fad76b57649060dd5d2280c4b5c3efa4bb82d8c35957e7df';
  assert.equal(artifactKey('reivesti-data-fabric', sha), `reivesti-data-fabric/artifacts/sha256/b2/${sha}`);
  assert.equal(manifestKey('p', sha), `p/manifests/sha256/b2/${sha}.json`);
  assert.equal(releaseKey('p', 'wi_statewide_parcels', 'V12.0.0-2026', 'cb68'), 'p/releases/wi_statewide_parcels/V12.0.0-2026/cb68.json');
  assert.throws(() => artifactKey('p', 'latest'), /not a sha256/);
  for (const k of [artifactKey('p', sha), manifestKey('p', sha)]) assert.ok(!/latest|current|\d{4}-\d{2}-\d{2}T/.test(k));
});

// ===========================================================================
// Backend contract, run against every backend
// ===========================================================================

for (const kind of ['LOCAL', 'S3'] as const) {
  const available = () => backends().find((b) => b.kind === kind);

  test(`[${kind}] upload, HEAD, stream and exact byte count`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const f = file(randomBytes(11 * 1024 * 1024 + 3)); // spans multipart parts on S3
    const key = `${unique()}/artifacts/sha256/${f.sha256.slice(0, 2)}/${f.sha256}`;
    assert.deepEqual(await backend.putFile(key, f.path, { sha256: f.sha256, bytes: f.bytes, contentType: 'application/zip' }), { created: true });
    const head = await backend.head(key);
    assert.equal(head?.bytes, f.bytes);
    assert.equal(head?.declaredSha256, f.sha256);
    assert.deepEqual(await hashObject(backend, key), { sha256: f.sha256, bytes: f.bytes });
  });

  test(`[${kind}] the same bytes twice deduplicate`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const f = file(randomBytes(4096));
    const key = `${unique()}/${f.sha256}`;
    await backend.putFile(key, f.path, { sha256: f.sha256, bytes: f.bytes, contentType: 'x' });
    assert.deepEqual(await backend.putFile(key, f.path, { sha256: f.sha256, bytes: f.bytes, contentType: 'x' }), { created: false });
  });

  test(`[${kind}] different bytes can never replace an existing key`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const a = file(randomBytes(4096));
    const other = file(randomBytes(5000));
    const key = `${unique()}/${a.sha256}`;
    await backend.putFile(key, a.path, { sha256: a.sha256, bytes: a.bytes, contentType: 'x' });
    await assert.rejects(
      backend.putFile(key, other.path, { sha256: other.sha256, bytes: other.bytes, contentType: 'x' }),
      (e: unknown) => isFabricError(e) && e.kind === 'IMMUTABILITY',
    );
    assert.deepEqual(await hashObject(backend, key), { sha256: a.sha256, bytes: a.bytes }, 'the original bytes stand');
  });

  test(`[${kind}] a missing object is null on HEAD and an error on read`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    assert.equal(await backend.head(`${unique()}/none`), null);
    await assert.rejects(backend.stream(`${unique()}/none`), /does not exist/);
  });

  test(`[${kind}] write-once JSON: the first record stands and a disagreement is reported`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const key = `${unique()}/m.json`;
    assert.deepEqual(await backend.putJson(key, { v: 1 }), { created: true, identical: true });
    assert.deepEqual(await backend.putJson(key, { v: 1 }), { created: false, identical: true });
    assert.deepEqual(await backend.putJson(key, { v: 2 }), { created: false, identical: false });
    assert.deepEqual(await backend.getJson(key), { v: 1 });
  });

  test(`[${kind}] a corrupted object is detected on verified download`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const real = file(randomBytes(4096));
    const impostor = file(randomBytes(4096));
    const key = `${unique()}/${real.sha256}`;
    if (kind === 'LOCAL') {
      // The local backend re-hashes at write time and would refuse the impostor,
      // so the corruption happens behind its back, as bit rot would.
      await backend.putFile(key, real.path, { sha256: real.sha256, bytes: real.bytes, contentType: 'x' });
      const onDisk = join(backend.describe().location, ...key.split('/'));
      chmodSync(onDisk, 0o600);
      writeFileSync(onDisk, readFileSync(impostor.path));
    } else {
      // Stored under the real digest's key, but the bytes are not the real ones.
      await backend.putFile(key, impostor.path, { sha256: real.sha256, bytes: real.bytes, contentType: 'x' });
    }
    await assert.rejects(
      downloadVerified(backend, key, { sha256: real.sha256, bytes: real.bytes }, join(tmp('df-dl-'), 'out')),
      /failed verification/,
    );
  });

  test(`[${kind}] listing by prefix`, async (t) => {
    const b = available(); if (!b) return t.skip('backend unavailable');
    const backend = b.make();
    const p = unique();
    await backend.putJson(`${p}/r/a.json`, {});
    await backend.putJson(`${p}/r/b.json`, {});
    // A slash-free prefix: moto (the test peer) mis-verifies SigV4 when the
    // signed query contains an encoded "/" — boto3 fails identically. The
    // client encodes it as AWS specifies; see docs/ARTIFACT-STORAGE.md.
    assert.deepEqual(await backend.list(p), [`${p}/r/a.json`, `${p}/r/b.json`]);
  });
}

// ===========================================================================
// S3-specific: the protocol peer enforces what a private bucket must
// ===========================================================================

test('[S3] the bucket is private: an anonymous read is refused', async (t) => {
  if (!s3) return t.skip('moto unavailable');
  const backend = s3Backend();
  const key = `${unique()}/private.json`;
  await backend.putJson(key, { secret: false });
  const anonymous = await fetch(`${s3.endpoint}/${s3.bucket}/${key}`);
  assert.equal(anonymous.status, 403);
});

test('[S3] a wrong secret and another bucket are refused, and nothing leaks into the error', async (t) => {
  if (!s3) return t.skip('moto unavailable');
  const wrong = 'WRONG-SECRET-VALUE-0123456789';
  await assert.rejects(s3Backend({ secretAccessKey: wrong }).getJson('x/y.json'), (e: unknown) => {
    const text = `${(e as Error).message} ${JSON.stringify(e)}`;
    return /403/.test(text) && !text.includes(wrong) && !text.includes(s3!.secretAccessKey);
  });
  await assert.rejects(s3Backend({ bucket: 'someone-elses' }).getJson('x/y.json'), /403 AccessDenied/);
});

test('[S3] an interrupted multipart upload leaves no object behind', async (t) => {
  if (!s3) return t.skip('moto unavailable');
  let parts = 0;
  const failing: typeof fetch = async (input, init) => {
    if (String(input).includes('partNumber=2')) {
      parts += 1;
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    return fetch(input, init);
  };
  const f = file(randomBytes(11 * 1024 * 1024));
  const key = `${unique()}/${f.sha256}`;
  await assert.rejects(s3Backend({ fetchImpl: failing }).putFile(key, f.path, { sha256: f.sha256, bytes: f.bytes, contentType: 'x' }));
  assert.equal(parts, 1, 'a 403 is an answer and is not retried');
  assert.equal(await s3Backend().head(key), null, 'the aborted upload is not an object');
});

test('[S3] a transient failure is retried and the upload completes', async (t) => {
  if (!s3) return t.skip('moto unavailable');
  let failed = false;
  const flaky: typeof fetch = async (input, init) => {
    if (!failed && String(input).includes('partNumber=1')) {
      failed = true;
      return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
    }
    return fetch(input, init);
  };
  const f = file(randomBytes(6 * 1024 * 1024));
  const key = `${unique()}/${f.sha256}`;
  await s3Backend({ fetchImpl: flaky }).putFile(key, f.path, { sha256: f.sha256, bytes: f.bytes, contentType: 'x' });
  assert.ok(failed);
  assert.deepEqual(await hashObject(s3Backend(), key), { sha256: f.sha256, bytes: f.bytes });
});

// ===========================================================================
// Configuration: explicit backend, no silent downgrade, secrets never echoed
// ===========================================================================

test('no backend configured is null, and REQUIRED without a backend fails', () => {
  assert.equal(durableStoreFromEnv({}), null);
  assert.throws(() => durableStoreFromEnv({ DF_ARTIFACT_DURABILITY: 'required' }), /no durable backend is configured/);
});

test('a local backend on execution disk never passes as durable when durability is required', () => {
  assert.throws(() => durableStoreFromEnv({
    DF_ARTIFACT_BACKEND: 'local', DF_ARTIFACT_LOCAL_ROOT: tmp('x-'), DF_ARTIFACT_DURABILITY: 'required',
  }), /not durable/);
  const declared = durableStoreFromEnv({
    DF_ARTIFACT_BACKEND: 'local', DF_ARTIFACT_LOCAL_ROOT: tmp('x-'), DF_ARTIFACT_DURABILITY: 'required', DF_ARTIFACT_LOCAL_DURABLE: '1',
  });
  assert.equal(declared?.backend.describe().durable, true, 'only an explicit operator declaration makes a directory durable');
  assert.throws(() => assertNoSilentDowngrade({ backend: createLocalBackend(tmp('y-')), prefix: 'p', required: true }), /not durable/);
});

test('missing S3 credentials are named, never echoed, and generic AWS_* placeholders are ignored', () => {
  const secret = 'do-not-print-me-9f8e7d';
  assert.throws(
    () => durableStoreFromEnv({
      DF_ARTIFACT_BACKEND: 's3', DF_ARTIFACT_S3_ENDPOINT: 'https://x', DF_ARTIFACT_S3_REGION: 'us-west-2',
      DF_ARTIFACT_BUCKET: 'b', DF_ARTIFACT_SECRET_ACCESS_KEY: secret,
      AWS_ACCESS_KEY_ID: 'proxy-placeholder', AWS_SECRET_ACCESS_KEY: 'proxy-placeholder',
    }),
    (e: unknown) => /DF_ARTIFACT_ACCESS_KEY_ID/.test((e as Error).message) && !JSON.stringify(e).includes(secret)
      && !(e as Error).message.includes(secret),
  );
});

test('an S3 backend defaults to REQUIRED durability', () => {
  const store = durableStoreFromEnv({
    DF_ARTIFACT_BACKEND: 's3', DF_ARTIFACT_S3_ENDPOINT: 'https://s3.example', DF_ARTIFACT_S3_REGION: 'us-west-2',
    DF_ARTIFACT_BUCKET: 'b', DF_ARTIFACT_ACCESS_KEY_ID: 'a', DF_ARTIFACT_SECRET_ACCESS_KEY: 's',
  });
  assert.equal(store?.required, true);
  assert.equal(store?.backend.describe().kind, 'S3_COMPATIBLE');
  assert.ok(!store?.backend.describe().location.includes('s'.repeat(1) + '@'), 'location carries no credential');
});

// ===========================================================================
// Lifecycle: commit and rehydrate
// ===========================================================================

async function workspaceArtifact(bytes: Buffer) {
  const workspace = createStreamingArtifactStore(createStreamingFilesystemObjectStore(tmp('df-ws-')));
  const artifact = await workspace.archiveStream({
    sourceAuthority: 'Test', sourceProgram: 'Test', sourceFamily: 'test', sourceId: 'wi_statewide_parcels',
    releaseId: 'r1', referencePeriod: 'V12.0.0-2026', originalUrl: 'https://publisher.example/archive.zip',
    originalFilename: 'archive.zip', retrievedAt: '2026-09-28T03:56:42.969Z', effectiveAt: '2026-06-30T21:11:02.000Z',
    jurisdictionIds: ['us-county-55001'],
    access: { accessType: 'bulk_download', automationStatus: 'sanctioned', termsStatus: 'reviewed_permitted', licenseStatus: 'open_with_attribution', carriesRestrictedContact: true },
  }, async (sink) => { await sink.write(bytes); });
  return { workspace, artifact };
}

for (const kind of ['LOCAL', 'S3'] as const) {
  test(`[${kind}] commit runs STAGING → HASH_VERIFIED → DURABLE → REGISTERED, and a fresh workspace rehydrates by digest`, async (t) => {
    const b = backends().find((x) => x.kind === kind); if (!b) return t.skip('backend unavailable');
    const store: DurableStore = { backend: b.make(), prefix: unique(), required: true };
    const { workspace, artifact } = await workspaceArtifact(randomBytes(7 * 1024 * 1024));
    const commit = await commitDurable(store, workspace, artifact, { role: 'publisher_raw', contentType: 'application/zip' });
    assert.deepEqual(commit.phases.map((p) => p.phase), ['STAGING', 'HASH_VERIFIED', 'DURABLE', 'REGISTERED']);
    assert.equal(commit.verifiedByReread, true);

    const fresh = createStreamingArtifactStore(createStreamingFilesystemObjectStore(tmp('df-fresh-')));
    const restored = await rehydrate(store, fresh, artifact.sha256);
    assert.equal(restored.artifact.sha256, artifact.sha256);
    assert.equal(restored.artifact.byteLength, artifact.byteLength);
    // The ORIGINAL retrieval facts come back, not the time of this download.
    assert.equal(restored.artifact.manifest.retrievedAt, '2026-09-28T03:56:42.969Z');
    assert.equal(restored.artifact.manifest.originalUrl, 'https://publisher.example/archive.zip');
    assert.equal(restored.manifest.role, 'publisher_raw');
    assert.equal(restored.manifest.contentEncoding, 'identity', 'the digest is of the publisher bytes as-is');
  });
}

test('a staged file that no longer matches its content id is never made durable', async () => {
  const store: DurableStore = { backend: createLocalBackend(tmp('d-'), { durable: true }), prefix: 'p', required: true };
  const { workspace, artifact } = await workspaceArtifact(randomBytes(2048));
  const path = workspace.localPath(artifact);
  chmodSync(path, 0o600);
  writeFileSync(path, randomBytes(2048));
  await assert.rejects(commitDurable(store, workspace, artifact, { role: 'publisher_raw', contentType: 'x' }), /does not match its content id/);
  assert.equal(await store.backend.head(artifactKey('p', artifact.sha256)), null, 'nothing reached the durable store');
});

test('rehydration refuses bytes that do not hash to the requested digest', async () => {
  const backend = createLocalBackend(tmp('d-'), { durable: true });
  const store: DurableStore = { backend, prefix: 'p', required: true };
  const { workspace, artifact } = await workspaceArtifact(randomBytes(2048));
  await commitDurable(store, workspace, artifact, { role: 'publisher_raw', contentType: 'x' });
  // Corrupt the durable copy behind the backend's back.
  const root = backend.describe().location;
  const objectPath = join(root, ...artifactKey('p', artifact.sha256).split('/'));
  chmodSync(objectPath, 0o600);
  writeFileSync(objectPath, randomBytes(2048));
  const fresh = createStreamingArtifactStore(createStreamingFilesystemObjectStore(tmp('df-fresh-')));
  await assert.rejects(rehydrate(store, fresh, artifact.sha256), /do not match the requested digest/);
});

test('durable manifests carry storage identity, never credentials or signed URLs', async (t) => {
  if (!s3) return t.skip('moto unavailable');
  const store: DurableStore = { backend: s3Backend(), prefix: unique(), required: true };
  const { workspace, artifact } = await workspaceArtifact(randomBytes(1024));
  await commitDurable(store, workspace, artifact, { role: 'publisher_raw', contentType: 'x' });
  const manifest = JSON.stringify(await store.backend.getJson(manifestKey(store.prefix, artifact.sha256)));
  for (const forbidden of [s3.accessKeyId, s3.secretAccessKey, 'X-Amz-Signature', 'X-Amz-Credential', 'authorization']) {
    assert.ok(!manifest.includes(forbidden), `manifest contains ${forbidden}`);
  }
});

// ===========================================================================
// Portability: no machine is part of the architecture
// ===========================================================================

test('no source, test, tool or config file depends on a specific machine path', () => {
  const root = join(import.meta.dirname, '..');
  const forbidden = /\/Users\/|\/home\/user\b|\/home\/[a-z]+\/|\/opt\/homebrew|~\/Desktop|~\/Downloads|\bC:\\\\/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.s3env', 'var', 'pg-sandbox'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // The two files that DEFINE the forbidden patterns are the only exceptions.
      else if (/\.(ts|json|sh|sql|ya?ml)$/.test(e.name) && !p.endsWith(join('tests', 'artifact-storage.test.ts'))
        && !p.endsWith(join('workflows', 'ci.yml'))) {
        if (forbidden.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(root.length + 1));
      }
    }
  };
  for (const dir of ['src', 'tests', 'tools', 'db', '.github']) walk(join(root, dir));
  for (const f of ['package.json', 'tsconfig.json']) if (forbidden.test(readFileSync(join(root, f), 'utf8'))) offenders.push(f);
  assert.deepEqual(offenders, []);
});
