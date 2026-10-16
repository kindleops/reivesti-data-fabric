/**
 * Scratch directories with an owner (DF-0O).
 *
 * Every run's scratch lives at `var/scratch/<kind>-<stamp>` and is removed by
 * the run in a `finally`. A process that is killed — OOM, a container reclaim,
 * `kill -9` — never reaches that `finally`, and its contribution files and sort
 * spills stay behind. Before DF-0O nothing said whose they were, so the only
 * cleanup was by hand, and the tempting one (`rm -rf /tmp/*`, or all of
 * `var/scratch`) also deletes a LIVE run's scratch from under it.
 *
 * Each scratch directory now carries `.owner.json`: pid, host, boot id, start
 * time and what it is for. A directory is an orphan only when its owner is
 * provably gone: same host and boot, and the pid is not alive (or is alive but
 * started after the directory did, so it is a reused pid). Only orphans are
 * ever removed. A directory with no marker (written before DF-0O, or by
 * something else) is reported UNOWNED and left alone; so is anything owned by
 * another host or an earlier boot that cannot be checked from here. Nothing
 * outside `var/scratch` is touched.
 */
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { OWNER_ONLY_FILE, ensurePrivateDir } from '../core/private-fs.ts';

export const SCRATCH_OWNER_FILE = '.owner.json';

export type ScratchOwner = {
  readonly pid: number;
  readonly host: string;
  readonly bootId: string | null;
  readonly startedAt: string;
  readonly purpose: string;
};

export type ScratchStatus = 'LIVE' | 'ORPHANED' | 'UNOWNED' | 'UNVERIFIABLE';

export type ScratchEntry = {
  readonly name: string;
  readonly path: string;
  readonly status: ScratchStatus;
  readonly owner: ScratchOwner | null;
  readonly bytes: number;
  readonly reason: string;
};

export type ScratchHost = {
  readonly host: string;
  readonly bootId: string | null;
  /** True when a process with this pid exists. */
  isAlive(pid: number): boolean;
  /** When the process with this pid started, if known. */
  processStartedAt(pid: number): Promise<Date | null>;
};

export async function currentScratchHost(): Promise<ScratchHost> {
  const bootId = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((s) => s.trim(), () => null);
  const bootTime = await readFile('/proc/stat', 'utf8')
    .then((s) => Number(/^btime (\d+)$/m.exec(s)?.[1] ?? Number.NaN), () => Number.NaN);
  const ticks = 100; // USER_HZ on every Linux this runs on
  return {
    host: hostname(),
    bootId,
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM: it exists, it is just not ours to signal.
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    async processStartedAt(pid) {
      if (!Number.isFinite(bootTime)) return null;
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
      if (stat === null) return null;
      // Field 22 (starttime), counted after the parenthesised command name.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = Number(fields[19]);
      return Number.isFinite(start) ? new Date((bootTime + start / ticks) * 1000) : null;
    },
  };
}

/** Creates an owner-only scratch directory and stamps it with this process as owner. */
export async function claimScratch(varRoot: string, kind: string, host?: ScratchHost): Promise<string> {
  const root = join(varRoot, 'scratch');
  const dir = join(root, `${kind}-${Date.now().toString(36)}-${process.pid}`);
  await ensurePrivateDir(dir, root);
  const h = host ?? await currentScratchHost();
  const owner: ScratchOwner = {
    pid: process.pid, host: h.host, bootId: h.bootId, startedAt: new Date().toISOString(), purpose: kind,
  };
  await writeFile(join(dir, SCRATCH_OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: OWNER_ONLY_FILE });
  return dir;
}

/** Every directory under `var/scratch`, with whether its owner is still running. Read-only. */
export async function listScratch(varRoot: string, host?: ScratchHost): Promise<ScratchEntry[]> {
  const root = join(varRoot, 'scratch');
  const names = await readdir(root).catch(() => [] as string[]);
  const h = host ?? await currentScratchHost();
  const out: ScratchEntry[] = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    const owner = await readFile(join(path, SCRATCH_OWNER_FILE), 'utf8')
      .then((s) => JSON.parse(s) as ScratchOwner, () => null);
    const bytes = await treeBytes(path);
    out.push({ name, path, owner, bytes, ...(await judge(owner, h)) });
  }
  return out;
}

async function judge(owner: ScratchOwner | null, h: ScratchHost): Promise<{ status: ScratchStatus; reason: string }> {
  if (owner === null || !Number.isInteger(owner.pid)) {
    return { status: 'UNOWNED', reason: `no ${SCRATCH_OWNER_FILE}: not provably anyone's, left alone` };
  }
  if (owner.host !== h.host || owner.bootId === null || owner.bootId !== h.bootId) {
    return { status: 'UNVERIFIABLE', reason: 'owned by another host or boot; its liveness cannot be checked here' };
  }
  if (!h.isAlive(owner.pid)) return { status: 'ORPHANED', reason: `owner pid ${owner.pid} is not running` };
  const started = await h.processStartedAt(owner.pid);
  if (started !== null && started.getTime() > Date.parse(owner.startedAt) + 1000) {
    return { status: 'ORPHANED', reason: `pid ${owner.pid} was reused by a process started after this scratch` };
  }
  return { status: 'LIVE', reason: `owner pid ${owner.pid} is running` };
}

/** Removes ORPHANED scratch directories only. Returns what it removed and what it left. */
export async function cleanOrphanedScratch(varRoot: string, host?: ScratchHost): Promise<{
  readonly removed: readonly ScratchEntry[];
  readonly kept: readonly ScratchEntry[];
}> {
  const entries = await listScratch(varRoot, host);
  const removed: ScratchEntry[] = [];
  const kept: ScratchEntry[] = [];
  for (const entry of entries) {
    if (entry.status === 'ORPHANED') {
      await rm(entry.path, { recursive: true, force: true });
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { removed, kept };
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await treeBytes(p);
    else total += await lstat(p).then((s) => s.size, () => 0);
  }
  return total;
}
