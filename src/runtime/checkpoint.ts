/**
 * Acquisition checkpoints.
 *
 * A full-county run has two long, independently failable halves: downloading
 * 1.1 GB, and canonicalising it. Without a checkpoint, a failure in the second
 * half means repeating the first — 225 requests against a county's open-data
 * service to fetch bytes we already have on disk.
 *
 * So acquisition records what it produced. A resumed run reads the checkpoint,
 * confirms the artifact is still present and still hashes to what was recorded,
 * and skips straight to canonicalisation.
 *
 * The checkpoint is a pointer, never a cache: it holds no source data, and it is
 * only ever trusted after the artifact it names has been re-verified. A stale or
 * tampered checkpoint therefore degrades to a normal crawl rather than to a
 * wrong answer.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../core/errors.ts';

export type AcquisitionCheckpoint = {
  readonly version: 1;
  readonly sourceId: string;
  readonly referencePeriod: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly storagePath: string;
  readonly manifestPath: string;
  readonly completedAt: string;
};

export type CheckpointStore = {
  read(sourceId: string, referencePeriod: string): Promise<AcquisitionCheckpoint | null>;
  write(checkpoint: AcquisitionCheckpoint): Promise<void>;
  clear(sourceId: string, referencePeriod: string): Promise<void>;
  list(): Promise<readonly AcquisitionCheckpoint[]>;
};

export function createCheckpointStore(varRoot: string): CheckpointStore {
  const dir = join(varRoot, 'checkpoints');
  const pathFor = (sourceId: string, referencePeriod: string): string =>
    join(dir, `${segment(sourceId)}__${segment(referencePeriod)}.json`);

  return {
    async read(sourceId, referencePeriod) {
      try {
        const parsed = JSON.parse(await readFile(pathFor(sourceId, referencePeriod), 'utf8')) as AcquisitionCheckpoint;
        // A checkpoint from a different format is ignored rather than guessed at.
        if (parsed.version !== 1) return null;
        if (parsed.sourceId !== sourceId || parsed.referencePeriod !== referencePeriod) return null;
        if (!/^[0-9a-f]{64}$/.test(parsed.sha256)) return null;
        return parsed;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return null;
      }
    },

    async write(checkpoint) {
      await mkdir(dir, { recursive: true });
      const path = pathFor(checkpoint.sourceId, checkpoint.referencePeriod);
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
    },

    async clear(sourceId, referencePeriod) {
      await rm(pathFor(sourceId, referencePeriod), { force: true });
    },

    async list() {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      } catch {
        return [];
      }
      const out: AcquisitionCheckpoint[] = [];
      for (const file of files) {
        try {
          out.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as AcquisitionCheckpoint);
        } catch {
          // A corrupt checkpoint is skipped, not fatal: it only ever saves work.
        }
      }
      return out;
    },
  };
}

function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) fail('CONFIG', `checkpoint path segment "${value}" is empty after sanitisation`);
  return cleaned;
}
