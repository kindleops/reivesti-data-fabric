/**
 * Captures, and compares, the on-disk state of a derived estate.
 *
 *   node tools/estate-state.ts capture <varRoot> > before.json
 *   node tools/estate-state.ts diff before.json after.json
 *
 * The isolation proof needs more than "the digests are the same": a partition
 * rewritten with identical content would pass a digest check and still be a
 * write. So every file under every partition and every snapshot index is
 * hashed, and its size and mtime recorded, along with the CURRENT generation
 * pointer and the manifest's own digests. `diff` names every partition in which
 * ANYTHING changed — a new file, a new generation, a touched mtime.
 *
 * Aggregate-only by construction: it reads bytes to hash them and reports
 * digests, counts and timestamps. No row content is ever printed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

type FileState = { readonly path: string; readonly bytes: number; readonly mtimeMs: number; readonly sha256: string };
type PartitionState = {
  readonly partitionId: string;
  readonly current: string | null;
  readonly outputDigest: string | null;
  readonly inputDigest: string | null;
  readonly rowCount: number | null;
  readonly files: readonly FileState[];
  /** Digest over every file's path, size, mtime and content. Any write moves it. */
  readonly stateDigest: string;
};

async function sha(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out.sort();
}

async function stateOf(root: string, dir: string, id: string): Promise<PartitionState> {
  const files: FileState[] = [];
  for (const p of await walk(dir)) {
    const s = await stat(p);
    files.push({ path: relative(root, p), bytes: s.size, mtimeMs: s.mtimeMs, sha256: await sha(p) });
  }
  const current = await readFile(join(dir, 'CURRENT'), 'utf8').then((t) => t.trim()).catch(() => null);
  let manifest: Record<string, unknown> | null = null;
  if (current) {
    manifest = await readFile(join(dir, current, 'manifest.json'), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  }
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.bytes}\0${f.mtimeMs}\0${f.sha256}\n`);
  return {
    partitionId: id,
    current,
    outputDigest: (manifest?.['outputDigest'] as string | undefined) ?? null,
    inputDigest: (manifest?.['inputDigest'] as string | undefined) ?? null,
    rowCount: (manifest?.['rowCount'] as number | undefined) ?? null,
    files,
    stateDigest: h.digest('hex'),
  };
}

async function capture(varRoot: string): Promise<unknown> {
  const partitions: PartitionState[] = [];
  const base = join(varRoot, 'derived', 'partitions');
  for (const domain of (await readdir(base).catch(() => [])).sort()) {
    for (const scope of (await readdir(join(base, domain)).catch(() => [])).sort()) {
      partitions.push(await stateOf(varRoot, join(base, domain, scope), `${domain}/${scope}`));
    }
  }
  const indexes: PartitionState[] = [];
  const indexBase = join(varRoot, 'indexes');
  for (const source of (await readdir(indexBase).catch(() => [])).sort()) {
    indexes.push(await stateOf(varRoot, join(indexBase, source), `index/${source}`));
  }
  return { capturedAt: new Date().toISOString(), varRoot, partitions, indexes };
}

type Captured = { partitions: PartitionState[]; indexes: PartitionState[] };

function diff(before: Captured, after: Captured): unknown {
  const compare = (a: readonly PartitionState[], b: readonly PartitionState[]) => {
    const was = new Map(a.map((p) => [p.partitionId, p]));
    const now = new Map(b.map((p) => [p.partitionId, p]));
    const added = [...now.keys()].filter((k) => !was.has(k)).sort();
    const removed = [...was.keys()].filter((k) => !now.has(k)).sort();
    const changed = [...now.keys()].filter((k) => was.has(k) && was.get(k)!.stateDigest !== now.get(k)!.stateDigest).sort();
    const unchanged = [...now.keys()].filter((k) => was.has(k) && was.get(k)!.stateDigest === now.get(k)!.stateDigest);
    return { added, removed, changed, unchangedCount: unchanged.length };
  };
  return { partitions: compare(before.partitions, after.partitions), indexes: compare(before.indexes, after.indexes) };
}

const [command, a, b] = process.argv.slice(2);
if (command === 'capture' && a) {
  process.stdout.write(`${JSON.stringify(await capture(a))}\n`);
} else if (command === 'diff' && a && b) {
  const load = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as Captured;
  process.stdout.write(`${JSON.stringify(diff(await load(a), await load(b)), null, 2)}\n`);
} else {
  process.stderr.write('usage: estate-state.ts capture <varRoot> | diff <before.json> <after.json>\n');
  process.exitCode = 2;
}
