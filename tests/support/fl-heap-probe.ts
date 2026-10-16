/**
 * Ingests N synthetic NAL rows through the whole Florida pipeline and prints
 * the run's peak heap per stage. Spawned by the bounded-memory test under a
 * small --max-old-space-size, so a row-linear structure fails by crashing
 * rather than by a threshold someone tuned.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStreamingArtifactStore } from '../../src/archive/artifact-store.ts';
import { createStreamingFilesystemObjectStore } from '../../src/archive/object-store.ts';
import { createContactPlane } from '../../src/contact/contact-plane.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { defaultRegistry } from '../../src/registry/sources.ts';
import { runFlPipeline } from '../../src/connectors/fl-dor/pipeline.ts';
import { FL_NAL_SPEC } from '../../src/connectors/fl-nal/index.ts';
import { tempRoot } from '../helpers.ts';
import { LAFAYETTE, flFixturePortal, syntheticNalZip } from './fl-roll-fixture.ts';

const n = Number(process.argv[2]);
const root = tempRoot('df-fl-heap-');
try {
  const portal = flFixturePortal({ nal: { '44': [] } });
  portal.put('Tax Roll Data Files/NAL/2026P/Lafayette 44 Preliminary NAL 2026.zip', syntheticNalZip(LAFAYETTE, n));
  const r = await runFlPipeline(FL_NAL_SPEC, {
    registry: defaultRegistry(),
    artifactStore: createStreamingArtifactStore(createStreamingFilesystemObjectStore(join(root, 'archive'))),
    contactPlane: createContactPlane({ maxRetained: 0 }),
    varRoot: join(root, 'var'),
    clock: fixedClock('2026-09-29T12:00:00.000Z'),
    http: { fetchImpl: portal.fetchImpl, sleep: async () => {} },
    canonicalRetention: 'digest_only',
  });
  process.stdout.write(`${JSON.stringify({
    outcome: r.outcome,
    rows: r.run?.run.metrics.rowsValid,
    peakHeapBytes: r.run?.peakHeapBytes,
    stages: Object.fromEntries(Object.entries(r.run?.memoryByStage ?? {}).map(([k, v]) => [k, v.peakHeapBytes])),
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
