import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MAX_WATCHED_DIRECTORIES,
  DEFAULT_IGNORED_DIRECTORY_NAMES,
  listNonIgnoredWorkspaceDirectories,
} from './directory-walk';
import { normalizeWorkspaceRelativePath } from './workspace-paths';

export type WorkspaceFileWatcherMode = 'directory-list' | 'none';

export type WorkspaceFileWatcherEvent =
  | {
      readonly type: 'started';
      readonly mode: WorkspaceFileWatcherMode;
      readonly watchedDirectoryCount: number;
      readonly watchedFileCount: number;
    }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly path?: string;
    }
  | {
      readonly type: 'changed';
      readonly id: string;
      readonly path: string;
    }
  | {
      readonly type: 'workspace_changed';
      readonly path?: string;
    };

/** A tracked text file the watcher should report content changes for. */
export interface WorkspaceWatchedTextFile {
  /** Opaque identifier echoed back to `onTextFileChanged`. */
  readonly id: string;
  /** Workspace-relative POSIX path. */
  readonly path: string;
}

export interface WorkspaceFileWatcherInput {
  readonly textFiles: readonly WorkspaceWatchedTextFile[];
  /**
   * Directories known to hold (or be) tracked content, watched
   * synchronously at start in addition to the ancestors of `textFiles`.
   * Each seed and its ancestors are watched. Use for subtrees not implied
   * by `textFiles` (e.g. lazily-indexed directories).
   */
  readonly directorySeeds?: readonly string[];
  /**
   * Extra ignore-control files to watch directly (outside the
   * per-directory watches), e.g. a global gitignore or repo-local
   * `.git/info/exclude`. Absolute paths; a change reports a workspace
   * change (relative path if inside the workspace, else the absolute path)
   * and triggers ignore re-discovery. Reconciled on `update()`, so a scan
   * that changes the ignore strategy (re)installs the right aux watches.
   */
  readonly ignoreControlFiles?: readonly string[];
}

export interface WorkspaceFsWatcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): WorkspaceFsWatcher;
}

export type WorkspaceWatchFileSystem = (
  filename: string,
  listener: (eventType: string, filename: string | Buffer | null | undefined) => void
) => WorkspaceFsWatcher;

export interface StartWorkspaceFileWatcherOptions extends WorkspaceFileWatcherInput {
  readonly workspaceRoot: string;
  readonly debounceMs?: number;
  // Ceiling on how long the trailing debounce can stall under sustained
  // event traffic, measured from the first enqueue in a burst. Without it
  // a tool writing faster than `debounceMs` would reset the timer forever.
  readonly maxWaitMs?: number;
  readonly ignoredDirectoryNames?: ReadonlySet<string>;
  readonly maxWatchedDirectories?: number;
  /**
   * Normalizes a workspace-relative path to the key form used to match
   * `textFiles[].path`. Defaults to POSIX + NFC. Inject a stricter
   * normalizer to match a host's own path canonicalization exactly.
   */
  readonly normalizePath?: (relativePath: string) => string;
  /**
   * Test hook for deterministic watcher tests. Production callers should
   * use the default node:fs.watch implementation.
   */
  readonly watchFileSystem?: WorkspaceWatchFileSystem;
  readonly onTextFileChanged: (id: string, path: string) => void;
  readonly onWorkspaceChanged?: (path?: string) => void;
  readonly onEvent?: (event: WorkspaceFileWatcherEvent) => void;
}

export interface WorkspaceFileWatcher {
  readonly mode: WorkspaceFileWatcherMode;
  readonly watchedDirectoryCount: number;
  readonly watchedFileCount: number;
  /**
   * Reconcile the watch set against a new set of tracked files / seeds
   * without tearing the watcher down. Directories newly holding tracked
   * content are watched immediately; existing watches are reused.
   */
  update(next: WorkspaceFileWatcherInput): void;
  close(): void;
}

export type WorkspaceFileWatchPathAction =
  | 'text-change'
  | 'workspace-change'
  | 'text-and-workspace-change';

export function classifyWorkspaceFileWatchPathEvent(input: {
  readonly isTrackedTextPath: boolean;
  readonly isIgnoreControlPath?: boolean;
  readonly eventType?: string;
}): WorkspaceFileWatchPathAction {
  if (input.isIgnoreControlPath === true) return 'workspace-change';
  if (!input.isTrackedTextPath) return 'workspace-change';
  return input.eventType === 'change' ? 'text-change' : 'text-and-workspace-change';
}

export function computeWorkspaceFileWatcherMaxWaitMs(debounceMs: number): number {
  // Preserve a 500ms ceiling for the common 50ms debounce, but let
  // low-latency harnesses use their smaller windows instead of inheriting
  // an unrelated half-second floor.
  return Math.max(debounceMs * 10, 50);
}

// Watching is split across one non-recursive `fs.watch` per non-ignored
// directory rather than a single recursive watch on the workspace root. A
// recursive watch on Linux walks (and installs inotify watches on) the
// *entire* tree — overwhelmingly `node_modules`/`.git`, which never hold
// editable text and churn constantly — and Node offers no way to exclude
// paths from it. Per-directory watches let us skip ignored directories
// outright (rejected: filtering recursive events post-hoc still pays the
// walk + watch-budget cost and floods us with ignored-dir events that each
// trigger a rescan).
export function startWorkspaceFileWatcher(
  options: StartWorkspaceFileWatcherOptions
): WorkspaceFileWatcher {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const debounceMs = options.debounceMs ?? 50;
  const maxWaitMs = options.maxWaitMs ?? computeWorkspaceFileWatcherMaxWaitMs(debounceMs);
  const ignoredDirectoryNames = options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES;
  const maxWatchedDirectories = options.maxWatchedDirectories ?? DEFAULT_MAX_WATCHED_DIRECTORIES;
  const normalizePath = options.normalizePath ?? normalizeWorkspaceRelativePath;
  const watchFileSystem: WorkspaceWatchFileSystem =
    options.watchFileSystem ?? ((filename, listener) => watch(filename, listener));

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const firstEnqueuedAt = new Map<string, number>();
  // Directory watchers keyed by workspace-relative POSIX path ('' = root).
  const directoryWatchers = new Map<string, WorkspaceFsWatcher>();
  // Ignore-control file watchers keyed by their (absolute) path, so the set
  // can be reconciled on update() when the scan's ignore strategy changes.
  const ignoreControlWatchers = new Map<string, WorkspaceFsWatcher>();
  // Subtree discovery walks in flight, keyed by start dir, to avoid
  // duplicate concurrent walks of the same path.
  const discovering = new Set<string>();
  let closed = false;

  let textFiles: readonly WorkspaceWatchedTextFile[] = [];
  let textFilesByPath = new Map<string, WorkspaceWatchedTextFile>();
  const setTextFiles = (next: readonly WorkspaceWatchedTextFile[]): void => {
    textFiles = next;
    textFilesByPath = new Map(next.map((file) => [normalizePath(file.path), file] as const));
  };
  setTextFiles(options.textFiles);

  const notifyWorkspaceChanged = (changedPath?: string): void => {
    options.onWorkspaceChanged?.(changedPath);
    options.onEvent?.({
      type: 'workspace_changed',
      ...(changedPath === undefined ? {} : { path: changedPath }),
    });
  };

  const enqueue = (file: WorkspaceWatchedTextFile): void => {
    if (closed) return;
    const now = Date.now();
    const existing = timers.get(file.id);
    if (existing) clearTimeout(existing);
    let burstStartedAt = firstEnqueuedAt.get(file.id);
    if (burstStartedAt === undefined) {
      burstStartedAt = now;
      firstEnqueuedAt.set(file.id, now);
    }
    // Cap the trailing delay so firing never exceeds `burstStartedAt +
    // maxWaitMs`. Under steady-state silence `debounceMs` wins; under a
    // storm the ceiling forces a fire.
    const remainingCeiling = Math.max(0, burstStartedAt + maxWaitMs - now);
    const delay = Math.min(debounceMs, remainingCeiling);
    timers.set(
      file.id,
      setTimeout(() => {
        timers.delete(file.id);
        firstEnqueuedAt.delete(file.id);
        if (closed) return;
        options.onTextFileChanged(file.id, file.path);
        options.onEvent?.({ type: 'changed', id: file.id, path: file.path });
      }, delay)
    );
  };

  const enqueueRelativePath = (rawPath: string, eventType?: string): void => {
    if (closed) return;
    const normalized = normalizeWatchPath(rawPath);
    if (normalized === undefined) return;
    if (hasIgnoredDirectorySegment(normalized)) return;
    const file = textFilesByPath.get(normalized);
    const isIgnoreControlPath = isWorkspaceIgnoreControlPath(normalized);
    const action = classifyWorkspaceFileWatchPathEvent({
      isTrackedTextPath: file !== undefined,
      isIgnoreControlPath,
      eventType,
    });
    // A `.gitignore` edit can (un)ignore a directory that holds no tracked
    // files yet. Such a directory never shows up in a scan/update (git
    // ls-files is unchanged), so re-walk the tree here to start watching
    // anything freshly un-ignored — otherwise files later created inside it
    // would go unnoticed.
    if (isIgnoreControlPath) scheduleIgnoreRediscovery();
    if (action === 'text-change' && file) {
      enqueue(file);
      return;
    }
    if (action === 'text-and-workspace-change' && file) {
      notifyWorkspaceChanged(normalized);
      enqueue(file);
      return;
    }
    notifyWorkspaceChanged(normalized);
    if (file) enqueue(file);
  };

  const normalizeWatchPath = (rawPath: string): string | undefined => {
    if (rawPath.length === 0 || rawPath.includes('\0')) return undefined;
    const relativePath = path.isAbsolute(rawPath) ? path.relative(workspaceRoot, rawPath) : rawPath;
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return undefined;
    }
    try {
      return normalizePath(relativePath.split(path.sep).join('/'));
    } catch {
      return undefined;
    }
  };

  const hasIgnoredDirectorySegment = (normalizedPath: string): boolean =>
    normalizedPath.split('/').some((segment) => ignoredDirectoryNames.has(segment));

  const absoluteDirectoryPath = (relativeDir: string): string =>
    relativeDir === '' ? workspaceRoot : path.join(workspaceRoot, ...relativeDir.split('/'));

  const closeDirectoryWatch = (relativeDir: string): void => {
    const watcher = directoryWatchers.get(relativeDir);
    if (!watcher) return;
    watcher.close();
    directoryWatchers.delete(relativeDir);
  };

  const unwatchSubtree = (relativeDir: string): void => {
    // Never drop the root watch through subtree removal — losing it would
    // blind us to all new top-level entries.
    if (relativeDir === '') return;
    const prefix = `${relativeDir}/`;
    for (const key of [...directoryWatchers.keys()]) {
      if (key === relativeDir || key.startsWith(prefix)) {
        closeDirectoryWatch(key);
      }
    }
  };

  let watchCapReported = false;
  const ensureDirectoryWatched = (relativeDir: string): void => {
    if (closed) return;
    if (directoryWatchers.has(relativeDir)) return;
    if (directoryWatchers.size >= maxWatchedDirectories) {
      if (!watchCapReported) {
        watchCapReported = true;
        // Surface the truncation once. Past the cap we stop installing
        // direct watches and the remaining directories rely on rescans, so
        // a partial watch set must not be mistaken for full coverage.
        options.onEvent?.({
          type: 'error',
          message: `Watch directory cap reached (${maxWatchedDirectories}); remaining directories rely on rescans, not direct watches.`,
        });
      }
      return;
    }
    const absolute = absoluteDirectoryPath(relativeDir);
    let watcher: WorkspaceFsWatcher;
    try {
      watcher = watchFileSystem(absolute, (eventType, filename) => {
        onDirectoryEvent(relativeDir, eventType, filename);
      });
    } catch (error) {
      emitError(error, absolute);
      return;
    }
    watcher.on('error', (error) => {
      emitError(error, absolute);
      // A directory watch typically errors when its directory is removed;
      // drop it so a later recreation can be re-watched cleanly.
      closeDirectoryWatch(relativeDir);
    });
    directoryWatchers.set(relativeDir, watcher);
  };

  const walkAndWatchFrom = async (startDirectory: string): Promise<void> => {
    try {
      const directories = await listNonIgnoredWorkspaceDirectories({
        workspaceRoot,
        startDirectory,
        ignoredDirectoryNames,
        maxDirectories: maxWatchedDirectories,
      });
      if (closed) return;
      for (const directory of directories) ensureDirectoryWatched(directory);
    } catch (error) {
      emitError(error, absoluteDirectoryPath(startDirectory));
    }
  };

  const discoverAndWatch = async (relativeDir: string): Promise<void> => {
    if (closed || discovering.has(relativeDir)) return;
    discovering.add(relativeDir);
    try {
      await walkAndWatchFrom(relativeDir);
    } finally {
      discovering.delete(relativeDir);
    }
  };

  // Full-tree re-discovery (root walk) is coalesced, not deduped-and-dropped:
  // a trigger that arrives while a walk is in flight sets a pending bit so
  // exactly one more walk runs afterwards. This closes the race where a
  // `.gitignore` edit lands after the in-flight walk already read that
  // directory and would otherwise be missed until the next ignore-control
  // event or rescan.
  let fullDiscoveryRunning = false;
  let fullDiscoveryPending = false;
  const runFullDiscovery = (): void => {
    fullDiscoveryPending = true;
    if (fullDiscoveryRunning) return;
    fullDiscoveryRunning = true;
    void (async () => {
      try {
        // `closed` is checked via break (not in the loop condition) because
        // it is mutated only by close(), externally to this loop.
        while (fullDiscoveryPending) {
          fullDiscoveryPending = false;
          if (closed) break;
          await walkAndWatchFrom('');
        }
      } finally {
        fullDiscoveryRunning = false;
      }
    })();
  };

  // Re-run the full ignore-aware walk after an ignore-control change so
  // newly un-ignored directories become watched. Add-only: a now-ignored
  // directory keeps its watch until it is removed (harmless — its events
  // just trigger rescans that correctly exclude it, as the recursive watcher
  // did before).
  const scheduleIgnoreRediscovery = (): void => {
    runFullDiscovery();
  };

  const reconcileDirectoryEntry = async (relativePath: string, basename: string): Promise<void> => {
    if (closed) return;
    const absolute = absoluteDirectoryPath(relativePath);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      // The entry no longer exists (or is unreadable): if we watched it as
      // a directory, drop that subtree.
      if (directoryWatchers.has(relativePath)) unwatchSubtree(relativePath);
      return;
    }
    if (closed) return;
    if (!stats.isDirectory()) {
      // A directory we watched was replaced by a file (or it's a symlink,
      // which lstat reports as a non-directory and we never descend into).
      if (directoryWatchers.has(relativePath)) unwatchSubtree(relativePath);
      return;
    }
    if (ignoredDirectoryNames.has(basename)) return;
    if (directoryWatchers.has(relativePath)) return;
    // Walk the new subtree (honoring `.gitignore`) so freshly created
    // nested directories are watched without waiting for a rescan.
    await discoverAndWatch(relativePath);
  };

  const onDirectoryEvent = (
    relativeDir: string,
    eventType: string,
    filename: string | Buffer | null | undefined
  ): void => {
    if (closed) return;
    const basename =
      filename === null || filename === undefined
        ? ''
        : Buffer.isBuffer(filename)
          ? filename.toString()
          : filename;
    if (basename.length === 0) {
      // The platform dropped the filename: we can't tell what changed, so
      // request a rescan, conservatively re-check every tracked file, and
      // re-discover directories in case the unknown change added one.
      notifyWorkspaceChanged();
      for (const file of textFiles) enqueue(file);
      runFullDiscovery();
      return;
    }
    const relativeChild = relativeDir === '' ? basename : `${relativeDir}/${basename}`;
    enqueueRelativePath(relativeChild, eventType);
    // 'rename' is the only event type that can add or remove a directory;
    // reconcile our watch set so new subtrees become watched (and removed
    // ones dropped) without depending on an unrelated rescan firing.
    if (eventType === 'rename') {
      void reconcileDirectoryEntry(relativeChild, basename);
    }
  };

  const emitError = (error: unknown, errorPath: string): void => {
    options.onEvent?.({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      path: errorPath,
    });
  };

  const seedDirectories = (input: WorkspaceFileWatcherInput): void => {
    for (const relativeDir of skeletonDirectories(input)) ensureDirectoryWatched(relativeDir);
  };

  // The `.git` directory is skipped wholesale and the global gitignore lives
  // outside the workspace, so neither is reached by the per-directory watches.
  // Both can still change which files are ignored, so watch the specific
  // ignore-control files directly. Reconciled (add/drop) on update() so a scan
  // that changes the ignore strategy — e.g. `git init` introduces a
  // `.git/info/exclude`, or core.excludesFile is reconfigured — installs the
  // right watches instead of being stuck with the construction-time set.
  const reconcileIgnoreControlWatchers = (files: readonly string[]): void => {
    const desired = new Set(files.filter((file) => file.length > 0));
    for (const watchedPath of [...ignoreControlWatchers.keys()]) {
      if (desired.has(watchedPath)) continue;
      ignoreControlWatchers.get(watchedPath)?.close();
      ignoreControlWatchers.delete(watchedPath);
    }
    for (const watchedPath of desired) {
      if (ignoreControlWatchers.has(watchedPath)) continue;
      // Report the in-workspace relative path (e.g. `.git/info/exclude`) so it
      // reads like any other workspace change; out-of-tree files (the global
      // gitignore) keep their absolute path.
      const reportedPath = normalizeWatchPath(watchedPath) ?? watchedPath;
      try {
        const watcher = watchFileSystem(watchedPath, () => {
          notifyWorkspaceChanged(reportedPath);
          scheduleIgnoreRediscovery();
        });
        watcher.on('error', (error) => emitError(error, watchedPath));
        ignoreControlWatchers.set(watchedPath, watcher);
      } catch (error) {
        emitError(error, watchedPath);
      }
    }
  };

  const watchingEnabled = options.textFiles.length > 0 || options.onWorkspaceChanged !== undefined;
  let mode: WorkspaceFileWatcherMode = 'none';
  if (watchingEnabled) {
    // Synchronously cover every directory currently holding tracked content
    // (cheap: no fs walk), then asynchronously extend to directories with no
    // tracked files (e.g. empty dirs) so files later created there are still
    // detected.
    seedDirectories(options);
    runFullDiscovery();
    mode = directoryWatchers.size > 0 ? 'directory-list' : 'none';
  }
  reconcileIgnoreControlWatchers(options.ignoreControlFiles ?? []);

  const watcher: WorkspaceFileWatcher = {
    get mode() {
      return mode;
    },
    get watchedDirectoryCount() {
      return directoryWatchers.size;
    },
    get watchedFileCount() {
      return textFiles.length;
    },
    update: (next: WorkspaceFileWatcherInput): void => {
      if (closed) return;
      setTextFiles(next.textFiles);
      // Directory watches are add-only here: directories newly holding tracked
      // content get watched immediately, while removed directories are dropped
      // via their own 'rename' events (or on close), directories created
      // mid-session via the dynamic reconcile path, and directories that become
      // un-ignored via the ignore-control re-discovery path — so update() stays
      // bounded and never re-walks the tree itself. Ignore-control files ARE
      // reconciled (add/drop) so a changed ignore strategy is reflected.
      seedDirectories(next);
      reconcileIgnoreControlWatchers(next.ignoreControlFiles ?? []);
    },
    close: () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      firstEnqueuedAt.clear();
      for (const directoryWatcher of directoryWatchers.values()) directoryWatcher.close();
      directoryWatchers.clear();
      for (const controlWatcher of ignoreControlWatchers.values()) controlWatcher.close();
      ignoreControlWatchers.clear();
    },
  };

  options.onEvent?.({
    type: 'started',
    mode,
    watchedDirectoryCount: directoryWatchers.size,
    watchedFileCount: textFiles.length,
  });
  return watcher;
}

function isWorkspaceIgnoreControlPath(normalizedPath: string): boolean {
  return normalizedPath === '.gitignore' || normalizedPath.endsWith('/.gitignore');
}

// Directories that currently hold tracked content: every ancestor of a
// tracked file plus each directory seed and its ancestors, always including
// the workspace root (''). Derived purely from the input, so it never lists
// ignored directories.
function skeletonDirectories(input: WorkspaceFileWatcherInput): readonly string[] {
  const directories = new Set<string>(['']);
  const addAncestorDirectories = (relativePath: string, includeSelf: boolean): void => {
    const segments = relativePath.split('/').filter(Boolean);
    const limit = includeSelf ? segments.length : segments.length - 1;
    let current = '';
    for (let index = 0; index < limit; index += 1) {
      current = current === '' ? segments[index]! : `${current}/${segments[index]!}`;
      directories.add(current);
    }
  };
  for (const file of input.textFiles) addAncestorDirectories(file.path, false);
  for (const seed of input.directorySeeds ?? []) addAncestorDirectories(seed, true);
  return [...directories];
}
