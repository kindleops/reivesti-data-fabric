/**
 * Will this run fit? Asked before anything is downloaded, derived or written.
 *
 * DF-0N's first forced re-ingest ran a 37 GiB execution disk out of space in
 * its last stage, after an hour and a half. Nothing was corrupted — runs are
 * crash-safe — but the run was lost, and the second attempt only fitted
 * because its scratch was moved to RAM by hand. The preflight turns that into
 * a refusal at the start, with the arithmetic:
 *
 *   durable   what the run keeps on the var root's filesystem: the publisher
 *             archive (unless already retained), the derived bundle, the
 *             canonical run tables (a new generation, even on a forced run),
 *             partitions, snapshot indexes and any companion archive;
 *   scratch   the peak of contribution files and external-sort chunks, on
 *             whatever filesystem `var/scratch` resolves to.
 *
 * Same filesystem: durable + scratch must fit. Separate filesystem: each must
 * fit its own, and if scratch is tmpfs it is RAM, so it must also fit free
 * memory with headroom left for the process itself. A margin covers estimate
 * error. Nothing here moves scratch to tmpfs: that is an operator's decision,
 * and the preflight only checks that the decision fits.
 */
import { statfs, realpath, stat, readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { dirname, join } from 'node:path';
import { fail } from '../core/errors.ts';
import type { Logger } from '../core/logging.ts';

const GIB = 1024 ** 3;

export type CapacityPlan = {
  readonly label: string;
  /** Kept on the var root's filesystem, by component. */
  readonly durable: Readonly<Record<string, number>>;
  /** Peak scratch bytes. */
  readonly scratch: number;
};

export type CapacityProbe = {
  availableBytes(path: string): Promise<number>;
  /** Device id of the filesystem holding `path`. */
  device(path: string): Promise<number>;
  isTmpfs(path: string): Promise<boolean>;
  freeMemoryBytes(): number;
};

export type CapacityVerdict = {
  readonly ok: boolean;
  readonly label: string;
  readonly marginFraction: number;
  readonly durableBytes: number;
  readonly scratchBytes: number;
  readonly varRoot: { readonly path: string; readonly availableBytes: number; readonly needBytes: number };
  readonly scratchTarget: {
    readonly path: string;
    readonly sameFilesystem: boolean;
    readonly tmpfs: boolean;
    readonly availableBytes: number;
    readonly needBytes: number;
    readonly freeMemoryBytes: number | null;
    readonly memoryNeedBytes: number | null;
  };
  readonly breakdown: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
};

export const realCapacityProbe: CapacityProbe = {
  async availableBytes(path) {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  },
  async device(path) {
    return (await stat(path)).dev;
  },
  async isTmpfs(path) {
    // statfs type 0x01021994 is TMPFS_MAGIC on Linux; fall back to /proc/mounts.
    const s = await statfs(path).catch(() => null);
    if (s !== null && Number(s.type) === 0x01021994) return true;
    const real = await realpath(path).catch(() => path);
    const mounts = await readFile('/proc/mounts', 'utf8').catch(() => '');
    let best = { mount: '', type: '' };
    for (const line of mounts.split('\n')) {
      const [, mount, type] = line.split(' ');
      if (mount && type && (real === mount || real.startsWith(mount.endsWith('/') ? mount : `${mount}/`)) && mount.length > best.mount.length) {
        best = { mount, type };
      }
    }
    return best.type === 'tmpfs';
  },
  freeMemoryBytes: () => freemem(),
};

/** Measures, and refuses before any destructive step when the run cannot fit. */
export async function preflightCapacity(
  varRoot: string,
  plan: CapacityPlan,
  options: { readonly probe?: CapacityProbe; readonly marginFraction?: number; readonly processHeadroomBytes?: number } = {},
): Promise<CapacityVerdict> {
  const probe = options.probe ?? realCapacityProbe;
  const margin = options.marginFraction ?? 0.1;
  const headroom = options.processHeadroomBytes ?? 2 * GIB;
  const scratchPath = join(varRoot, 'scratch');
  const durableBytes = Object.values(plan.durable).reduce((a, b) => a + Math.max(0, b), 0);
  const scratchBytes = Math.max(0, plan.scratch);
  const grow = (n: number) => Math.ceil(n * (1 + margin));

  // A fresh worker has no var root yet: measure where it will be created.
  const varAt = await nearestExisting(varRoot);
  const varAvailable = await probe.availableBytes(varAt);
  const scratchExists = await stat(scratchPath).then(() => true, () => false);
  const target = scratchExists ? scratchPath : varAt;
  const sameFilesystem = !scratchExists || (await probe.device(target)) === (await probe.device(varAt));
  const tmpfs = !sameFilesystem && await probe.isTmpfs(target);
  const scratchAvailable = sameFilesystem ? varAvailable : await probe.availableBytes(target);

  const reasons: string[] = [];
  const varNeed = sameFilesystem ? grow(durableBytes + scratchBytes) : grow(durableBytes);
  if (varNeed > varAvailable) {
    reasons.push(`var root needs ${gib(varNeed)} (${sameFilesystem ? 'durable + scratch' : 'durable'}, ${Math.round(margin * 100)}% margin) and has ${gib(varAvailable)}`);
  }
  const scratchNeed = grow(scratchBytes);
  if (!sameFilesystem && scratchNeed > scratchAvailable) {
    reasons.push(`scratch filesystem needs ${gib(scratchNeed)} and has ${gib(scratchAvailable)}`);
  }
  const freeMemory = tmpfs ? probe.freeMemoryBytes() : null;
  const memoryNeed = tmpfs ? scratchNeed + headroom : null;
  if (tmpfs && (memoryNeed as number) > (freeMemory as number)) {
    reasons.push(`scratch is tmpfs (RAM): needs ${gib(memoryNeed as number)} of free memory including ${gib(headroom)} process headroom, and ${gib(freeMemory as number)} is free`);
  }
  return {
    ok: reasons.length === 0,
    label: plan.label,
    marginFraction: margin,
    durableBytes,
    scratchBytes,
    varRoot: { path: varRoot, availableBytes: varAvailable, needBytes: varNeed },
    scratchTarget: {
      path: target, sameFilesystem, tmpfs, availableBytes: scratchAvailable, needBytes: scratchNeed,
      freeMemoryBytes: freeMemory, memoryNeedBytes: memoryNeed,
    },
    breakdown: { ...plan.durable, scratch: scratchBytes },
    reasons,
  };
}

/** Throws CONFIG with the verdict when the run cannot fit. */
export function assertCapacity(verdict: CapacityVerdict): void {
  if (verdict.ok) return;
  fail('CONFIG', `insufficient capacity for ${verdict.label}: ${verdict.reasons.join('; ')}`, {
    capacity: verdict,
    remedy: 'free regenerable outputs, use a larger worker, or point var/scratch at a separate volume that fits; nothing was downloaded, derived or written',
  });
}

/**
 * Per-row footprint, measured on a full statewide run. A connector multiplies
 * it by the witness's row count. Estimates, not guarantees: the margin covers
 * the difference, and an estimate that proves low is a bug to correct here.
 */
export type FootprintProfile = {
  readonly source: string;
  readonly measuredOn: string;
  readonly derivedBundleBytesPerRow: number;
  readonly runTableBytesPerRow: number;
  readonly partitionBytesPerRow: number;
  readonly indexBytesPerRow: number;
  readonly organizationBytesPerRow: number;
  readonly scratchPeakBytesPerRow: number;
  /** Publisher archive bytes per source row: estimates rows when only the archive is known (replay). */
  readonly archiveBytesPerRow: number;
};

/** Rows a publisher archive of `bytes` holds, by the profile's measured ratio. Rounded up. */
export function rowsFromArchiveBytes(profile: FootprintProfile, bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / profile.archiveBytesPerRow);
}

export function planFromProfile(
  label: string,
  profile: FootprintProfile,
  rows: number,
  extra: Readonly<Record<string, number>> = {},
  options: { readonly partitionsAlreadyLive?: boolean } = {},
): CapacityPlan {
  return {
    label,
    durable: {
      derivedBundle: profile.derivedBundleBytesPerRow * rows,
      runTables: profile.runTableBytesPerRow * rows,
      // A forced re-ingest whose partitions are all unchanged writes none.
      partitions: options.partitionsAlreadyLive ? 0 : profile.partitionBytesPerRow * rows,
      snapshotIndexes: options.partitionsAlreadyLive ? 0 : profile.indexBytesPerRow * rows,
      organizationFold: profile.organizationBytesPerRow * rows,
      ...extra,
    },
    scratch: profile.scratchPeakBytesPerRow * rows,
  };
}

/**
 * The one call a connector makes before it downloads, rehydrates, derives or
 * writes anything: plan from the profile, measure, log the verdict, refuse
 * when it does not fit.
 */
export async function preflightRun(
  varRoot: string,
  profile: FootprintProfile,
  label: string,
  rows: number,
  extra: Readonly<Record<string, number>>,
  options: { readonly partitionsAlreadyLive?: boolean; readonly probe?: CapacityProbe | undefined; readonly logger?: Logger | undefined } = {},
): Promise<CapacityVerdict> {
  const verdict = await preflightCapacity(
    varRoot,
    planFromProfile(label, profile, rows, extra, { partitionsAlreadyLive: options.partitionsAlreadyLive ?? false }),
    options.probe ? { probe: options.probe } : {},
  );
  options.logger?.info('capacity.preflight', {
    label, ok: verdict.ok, needBytes: verdict.varRoot.needBytes, availableBytes: verdict.varRoot.availableBytes,
    scratchTmpfs: verdict.scratchTarget.tmpfs, reasons: verdict.reasons,
  });
  assertCapacity(verdict);
  return verdict;
}

async function nearestExisting(path: string): Promise<string> {
  let at = path;
  for (;;) {
    if (await stat(at).then(() => true, () => false)) return at;
    const parent = dirname(at);
    if (parent === at) return at;
    at = parent;
  }
}

function gib(n: number): string {
  return `${(n / GIB).toFixed(2)} GiB`;
}
