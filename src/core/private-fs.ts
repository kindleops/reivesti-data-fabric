/**
 * Owner-only storage for restricted rows, raw publisher bytes and scratch.
 *
 * Files holding mailing addresses were always written `0600`, but the
 * directories above them were created without a mode and so inherited the
 * process umask — `0755` under the usual `022` — leaving run ids, generation
 * ids and table names listable by every local user (DF-0N, proposal 6).
 *
 * `ensurePrivateDir` creates a directory `0700` AND tightens every directory
 * between a named root and it that already existed wider, because a recovered
 * estate, a rehydrated workspace or a store written by older code has its
 * directories already. It never touches anything above the root it is given.
 *
 * `tightenTree` is the audit: it walks a tree and reports (or, with `fix`,
 * removes) every group or other permission bit, keeping the owner's bits —
 * a read-only artifact (`0444`) becomes `0400`, never writable.
 */
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from './errors.ts';

export const OWNER_ONLY_DIR = 0o700;
export const OWNER_ONLY_FILE = 0o600;
/** Retained evidence: readable by its owner, writable by nobody. */
export const OWNER_READ_ONLY_FILE = 0o400;

/**
 * Creates `dir` owner-only, and tightens every directory from `root` down to it.
 *
 * A symbolic link BELOW the root is refused before anything is created or
 * changed: `mkdir` and `chmod` would follow it and act on a directory outside
 * the boundary. The root itself may be a link — an operator pointing
 * `var/scratch` at another volume is a legitimate choice — but it is never
 * chmod-ed through, so the link's target (which may be a shared mount) keeps
 * whatever mode the operator gave it.
 */
export async function ensurePrivateDir(dir: string, root: string): Promise<void> {
  const base = resolve(root);
  const target = resolve(dir);
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail('CONFIG', 'a private directory must lie under its root', { dir: target, root: base });
  }
  const parts = rel === '' ? [] : rel.split(sep);
  const refuseLinks = async (): Promise<void> => {
    let at = base;
    for (const part of parts) {
      at = join(at, part);
      const s = await lstat(at).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (s === null) return;
      if (s.isSymbolicLink()) {
        fail('CONFIG', 'refusing a symbolic link inside a private tree', { path: at, root: base });
      }
    }
  };
  await refuseLinks();
  await mkdir(target, { recursive: true, mode: OWNER_ONLY_DIR });
  // Checked again: a link swapped in between the check and the mkdir is still refused.
  await refuseLinks();
  const rootInfo = await lstat(base);
  if (!rootInfo.isSymbolicLink() && (rootInfo.mode & 0o077) !== 0) {
    await chmod(base, rootInfo.mode & 0o700 | OWNER_ONLY_DIR);
  }
  let at = base;
  for (const part of parts) {
    at = join(at, part);
    const s = await lstat(at);
    if ((s.mode & 0o077) !== 0) await chmod(at, s.mode & 0o700 | OWNER_ONLY_DIR);
  }
}

/** Drops group/other bits from one existing file, keeping the owner's. Never follows a link. */
export async function tightenFile(path: string): Promise<void> {
  const s = await lstat(path);
  if (s.isSymbolicLink()) return;
  if ((s.mode & 0o077) !== 0) await chmod(path, s.mode & 0o700);
}

export type TreePermissionReport = {
  readonly root: string;
  readonly present: boolean;
  /**
   * The root is a symbolic link. Its target is NOT audited (it may be a shared
   * mount), so the tree cannot be certified owner-only from here.
   */
  readonly symlinkRoot: boolean;
  readonly directories: number;
  readonly files: number;
  /** Entries that carried a group or other bit before this pass. */
  readonly directoriesOpen: number;
  readonly filesOpen: number;
  /** Entries this pass tightened (`fix` only). */
  readonly tightened: number;
};

/**
 * Walks `root` and drops every group/other bit, keeping the owner's. Symbolic
 * links inside the tree are reported as files and never followed or changed;
 * a root that is itself a link is reported `symlinkRoot` and not walked.
 */
export async function tightenTree(root: string, options: { readonly fix: boolean }): Promise<TreePermissionReport> {
  const report = { root, present: true, symlinkRoot: false, directories: 0, files: 0, directoriesOpen: 0, filesOpen: 0, tightened: 0 };
  // Only a missing root is "absent"; any other failure (EACCES, ELOOP) is an
  // audit that did not happen, and must not read as a clean one.
  const top = await lstat(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (top === null) return { ...report, present: false };
  if (top.isSymbolicLink()) return { ...report, symlinkRoot: true };
  const visit = async (path: string): Promise<void> => {
    const s = await lstat(path);
    if (s.isSymbolicLink()) { report.files += 1; return; }
    const open = (s.mode & 0o077) !== 0;
    if (s.isDirectory()) {
      report.directories += 1;
      if (open) report.directoriesOpen += 1;
      if (open && options.fix) { await chmod(path, (s.mode & 0o700) | OWNER_ONLY_DIR); report.tightened += 1; }
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    report.files += 1;
    if (open) report.filesOpen += 1;
    if (open && options.fix) { await chmod(path, s.mode & 0o700); report.tightened += 1; }
  };
  await visit(root);
  return report;
}
