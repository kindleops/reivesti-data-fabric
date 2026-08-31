import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createArtifactStore, artifactDir, type ArchiveInput } from '../src/archive/artifact-store.ts';
import { createFilesystemObjectStore } from '../src/archive/object-store.ts';
import { isFabricError } from '../src/core/errors.ts';
import { sha256 } from '../src/core/hash.ts';
import { tempRoot } from './helpers.ts';

const ACCESS = {
  accessType: 'manual_import',
  automationStatus: 'manual_only',
  termsStatus: 'reviewed_restricted',
  licenseStatus: 'unknown',
  carriesRestrictedContact: true,
} as const;

function input(bytes: string, overrides: Partial<ArchiveInput> = {}): ArchiveInput {
  return {
    bytes: new TextEncoder().encode(bytes),
    sourceAuthority: 'Minnesota Department of Revenue',
    sourceProgram: 'eCRV',
    sourceFamily: 'state_transfer_declaration',
    sourceId: 'mn_dor_ecrv_weekly_sales_extract',
    releaseId: 'rel-2026-W31',
    referencePeriod: '2026-W31',
    originalUrl: 'https://example.invalid/weekly.zip',
    originalFilename: 'weekly.zip',
    retrievedAt: '2026-08-31T12:00:00.000Z',
    effectiveAt: null,
    jurisdictionIds: ['us-county-27053'],
    access: ACCESS,
    ...overrides,
  };
}

test('identical bytes dedupe to one artifact rather than a second copy', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const first = await store.archive(input('<r>same</r>'));
  const second = await store.archive(input('<r>same</r>', { retrievedAt: '2026-09-07T12:00:00.000Z' }));

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.storagePath, second.storagePath);
  // The first sighting's retrieval time is the historical fact and is not
  // rewritten by a later identical download.
  assert.equal(second.manifest.retrievedAt, '2026-08-31T12:00:00.000Z');
});

test('different bytes under the same filename become separate artifacts', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const a = await store.archive(input('<r>week 31</r>'));
  const b = await store.archive(input('<r>week 32</r>'));

  assert.notEqual(a.sha256, b.sha256);
  assert.notEqual(a.storagePath, b.storagePath);
  assert.equal(a.manifest.originalFilename, b.manifest.originalFilename);
  // Both remain readable: the first is not replaced by the second.
  assert.equal(new TextDecoder().decode(await store.read(a)), '<r>week 31</r>');
  assert.equal(new TextDecoder().decode(await store.read(b)), '<r>week 32</r>');
});

test('the object store refuses to overwrite a retained object', async () => {
  const root = tempRoot();
  const objects = createFilesystemObjectStore(root);
  await objects.put('data-fabric/x/y/a.bin', new TextEncoder().encode('original'));
  await assert.rejects(
    () => objects.put('data-fabric/x/y/a.bin', new TextEncoder().encode('replacement')),
    (e: unknown) => isFabricError(e, 'IMMUTABILITY'),
  );
  assert.equal(new TextDecoder().decode(await objects.get('data-fabric/x/y/a.bin')), 'original');
});

test('the storage path is the digest, so a mutable URL cannot become identity', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const a = await store.archive(input('<r>v1</r>', { originalUrl: 'https://example.invalid/latest.xml' }));
  const b = await store.archive(input('<r>v2</r>', { originalUrl: 'https://example.invalid/latest.xml' }));
  assert.ok(a.storagePath.includes(`sha256-${a.sha256}`));
  assert.ok(b.storagePath.includes(`sha256-${b.sha256}`));
  assert.equal(a.manifest.originalUrl, b.manifest.originalUrl);
});

test('reading an artifact re-verifies its digest and refuses tampered bytes', async () => {
  const root = tempRoot();
  const store = createArtifactStore(createFilesystemObjectStore(root));
  const archived = await store.archive(input('<r>authentic</r>'));

  const onDisk = join(root, ...archived.storagePath.split('/'));
  chmodSync(onDisk, 0o644);
  writeFileSync(onDisk, '<r>tampered</r>');

  await assert.rejects(() => store.read(archived), (e: unknown) => isFabricError(e, 'REPLAY'));
});

test('the manifest records the minimum provenance set and reproduces on read', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const archived = await store.archive(input('<r>manifest</r>'));
  const reread = await store.readManifest(archived);

  assert.deepEqual(reread, archived.manifest);
  for (const field of [
    'sourceAuthority', 'sourceProgram', 'sourceFamily', 'sourceId', 'releaseId',
    'originalUrl', 'originalFilename', 'retrievedAt', 'effectiveAt',
    'byteLength', 'sha256', 'jurisdictionIds', 'access',
  ] as const) {
    assert.ok(field in reread, `manifest is missing ${field}`);
  }
  assert.equal(reread.sha256, sha256('<r>manifest</r>'));
  assert.equal(reread.byteLength, '<r>manifest</r>'.length);
  assert.equal(reread.access.carriesRestrictedContact, true);
});

test('an interpretation is recorded per parser+schema and cannot change silently', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const archived = await store.archive(input('<r>interp</r>'));
  const record = {
    manifestVersion: 1 as const,
    artifactId: archived.artifactId,
    sha256: archived.sha256,
    parserVersion: 'p1',
    schemaVersion: 's3',
    schemaDigest: 'abc',
    recordCount: 3,
    contentDigest: 'digest-1',
    quarantined: false,
    validationErrorCount: 0,
  };

  assert.deepEqual(await store.recordInterpretation(archived, record), { created: true });
  // Re-running the same parser over the same bytes is idempotent.
  assert.deepEqual(await store.recordInterpretation(archived, record), { created: false });
  // A *different* result from the same parser version is a contradiction, and
  // write-once storage turns it into a failure instead of a silent overwrite.
  await assert.rejects(
    () => store.recordInterpretation(archived, { ...record, contentDigest: 'digest-2' }),
    (e: unknown) => isFabricError(e, 'IMMUTABILITY'),
  );

  const view = await store.view(archived);
  assert.equal(view.interpretations.length, 1);
  assert.equal(view.retrieval.sha256, archived.sha256);
});

test('a newer parser may reinterpret the same evidence without rewriting history', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const archived = await store.archive(input('<r>reinterp</r>'));
  const base = {
    manifestVersion: 1 as const,
    artifactId: archived.artifactId,
    sha256: archived.sha256,
    schemaVersion: 's3',
    schemaDigest: 'abc',
    recordCount: 3,
    quarantined: false,
    validationErrorCount: 0,
  };
  await store.recordInterpretation(archived, { ...base, parserVersion: 'p1', contentDigest: 'd1' });
  await store.recordInterpretation(archived, { ...base, parserVersion: 'p2', contentDigest: 'd2' });

  const view = await store.view(archived);
  assert.equal(view.interpretations.length, 2);
  assert.deepEqual(view.interpretations.map((i) => i.parserVersion).sort(), ['p1', 'p2']);
});

test('artifact paths are namespaced by source and reference period', () => {
  const dir = artifactDir('mn_dor_ecrv_weekly_sales_extract', '2026-W31', 'a'.repeat(64));
  assert.equal(dir, `data-fabric/mn_dor_ecrv_weekly_sales_extract/2026-W31/sha256-${'a'.repeat(64)}`);
});

test('an interpretation that names a different artifact is rejected', async () => {
  const store = createArtifactStore(createFilesystemObjectStore(tempRoot()));
  const archived = await store.archive(input('<r>mismatch</r>'));
  await assert.rejects(
    () => store.recordInterpretation(archived, {
      manifestVersion: 1, artifactId: archived.artifactId, sha256: 'b'.repeat(64),
      parserVersion: 'p1', schemaVersion: 's3', schemaDigest: 'x',
      recordCount: 0, contentDigest: 'y', quarantined: false, validationErrorCount: 0,
    }),
    (e: unknown) => isFabricError(e, 'CONFIG'),
  );
});
