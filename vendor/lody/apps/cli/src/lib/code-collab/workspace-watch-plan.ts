import path from 'node:path';
import { CODE_COLLAB_IGNORED_DIRECTORY_NAMES } from './workspace-watch-path-policy';

export type WorkspaceWatchTarget = {
  /** Absolute path to hand to `fs.watch`. */
  readonly directory: string;
  readonly recursive: boolean;
};

export type WorkspaceWatchPlanEntry = {
  readonly name: string;
  readonly isDirectory: boolean;
};

/**
 * Decide which directories under a root actually need an `fs.watch` handle.
 *
 * `fs.watch(root, { recursive: true })` has no exclusion API: on Linux it installs
 * an inotify watch for every descendant directory, `node_modules` and `.git`
 * included. Those dominate a real checkout — one root took a freshly spawned watch
 * worker from 62MB to 415MB of RSS in 20 seconds, which then tripped the
 * coordinator's 256MB recycle budget every ~30s forever, and each recycle marks
 * every root dirty and buys a full rescan.
 *
 * So the root is watched NON-recursively (enough to notice new or removed top-level
 * entries) and every top-level directory that is not ignored gets its own recursive
 * watch. Coverage is unchanged for everything callers care about, because the
 * ignored names are exactly the ones `shouldIgnoreWorkspaceWatchFilename` already
 * discards events for.
 *
 * Nested ignored directories (`apps/web/node_modules`) are deliberately NOT split
 * out. Under pnpm those are symlink farms pointing into the root `.pnpm` store and
 * `fs.watch` does not recurse through symlinks, so the remaining cost is small and
 * not worth one watch handle per package directory.
 */
export function planWorkspaceWatchTargets(
  root: string,
  entries: readonly WorkspaceWatchPlanEntry[]
): WorkspaceWatchTarget[] {
  const targets: WorkspaceWatchTarget[] = [{ directory: root, recursive: false }];
  for (const entry of entries) {
    if (!entry.isDirectory || CODE_COLLAB_IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    targets.push({ directory: path.join(root, entry.name), recursive: true });
  }
  return targets;
}

/**
 * True when an event seen at the ROOT watch could have changed the top-level
 * directory set, meaning the plan has to be recomputed.
 *
 * The root watch is non-recursive, so its filenames are bare top-level names.
 */
export function rootEventMayChangeWatchPlan(filename: string | null): boolean {
  if (filename === null) {
    // No name means we cannot tell what moved; re-plan rather than go blind.
    return true;
  }
  const normalized = filename.replaceAll('\\', '/');
  // A nested path cannot add or remove a TOP-level directory.
  return !normalized.includes('/');
}
