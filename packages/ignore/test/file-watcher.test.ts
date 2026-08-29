import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyWorkspaceFileWatchPathEvent,
  startWorkspaceFileWatcher,
  type WorkspaceWatchFileSystem,
  type WorkspaceFileWatcherEvent,
} from '../src/index';

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspace(prefix = 'ignore-watch-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeFsWatcher {
  private closed = false;

  constructor(
    private readonly listener: (
      eventType: string,
      filename: string | Buffer | null | undefined
    ) => void
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  on(_event: 'error', _listener: (error: Error) => void): this {
    return this;
  }

  emit(eventType: string, filename: string | Buffer | null = null): void {
    if (this.closed) return;
    this.listener(eventType, filename);
  }
}

function workspacePath(workspaceRoot: string, relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.length === 0
    ? path.resolve(workspaceRoot)
    : path.resolve(workspaceRoot, ...segments);
}

function createFakeWatchFileSystem(): {
  readonly watchFileSystem: WorkspaceWatchFileSystem;
  readonly emitWorkspaceDirectoryEvent: (
    workspaceRoot: string,
    relativeDir: string,
    eventType: string,
    filename: string
  ) => void;
  readonly emitPathEvent: (absolutePath: string, eventType?: string, filename?: string) => void;
  readonly isWatchingPath: (absolutePath: string) => boolean;
  readonly isWatchingWorkspaceDirectory: (workspaceRoot: string, relativeDir: string) => boolean;
} {
  const watchers = new Map<string, FakeFsWatcher>();
  const watchFileSystem: WorkspaceWatchFileSystem = (filename, listener) => {
    if (!existsSync(filename)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${filename}'`), {
        code: 'ENOENT',
      });
    }
    const watcher = new FakeFsWatcher(listener);
    watchers.set(path.resolve(filename), watcher);
    return watcher;
  };

  const getOpenWatcher = (absolutePath: string): FakeFsWatcher | undefined => {
    const watcher = watchers.get(path.resolve(absolutePath));
    if (!watcher || watcher.isClosed) return undefined;
    return watcher;
  };

  const emitPathEvent = (
    absolutePath: string,
    eventType = 'change',
    filename?: string
  ): void => {
    const watcher = getOpenWatcher(absolutePath);
    if (!watcher) throw new Error(`No open fake watcher for ${absolutePath}`);
    watcher.emit(eventType, filename ?? path.basename(absolutePath));
  };

  const emitWorkspaceDirectoryEvent = (
    workspaceRoot: string,
    relativeDir: string,
    eventType: string,
    filename: string
  ): void => {
    emitPathEvent(workspacePath(workspaceRoot, relativeDir), eventType, filename);
  };

  return {
    watchFileSystem,
    emitWorkspaceDirectoryEvent,
    emitPathEvent,
    isWatchingPath: (absolutePath) => getOpenWatcher(absolutePath) !== undefined,
    isWatchingWorkspaceDirectory: (workspaceRoot, relativeDir) =>
      getOpenWatcher(workspacePath(workspaceRoot, relativeDir)) !== undefined,
  };
}

describe('classifyWorkspaceFileWatchPathEvent', () => {
  it('routes ignore-control + untracked paths to workspace-change and tracked edits to text-change', () => {
    expect(
      classifyWorkspaceFileWatchPathEvent({ isTrackedTextPath: true, isIgnoreControlPath: true })
    ).toBe('workspace-change');
    expect(classifyWorkspaceFileWatchPathEvent({ isTrackedTextPath: false })).toBe(
      'workspace-change'
    );
    expect(
      classifyWorkspaceFileWatchPathEvent({ isTrackedTextPath: true, eventType: 'change' })
    ).toBe('text-change');
    expect(
      classifyWorkspaceFileWatchPathEvent({ isTrackedTextPath: true, eventType: 'rename' })
    ).toBe('text-and-workspace-change');
  });
});

describe('startWorkspaceFileWatcher', () => {
  it('detects in-place edits to a tracked text file', async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, 'README.md'), 'hello');

    const fakeWatch = createFakeWatchFileSystem();
    const changed: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'readme', path: 'README.md' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: (id) => changed.push(id),
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, ''));
      await writeFile(path.join(root, 'README.md'), 'changed');
      fakeWatch.emitWorkspaceDirectoryEvent(root, '', 'change', 'README.md');
      await waitFor(() => changed.includes('readme'));
    } finally {
      watcher.close();
    }
  });

  it('does not watch node_modules: writes there raise no workspace events', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'a');

    const fakeWatch = createFakeWatchFileSystem();
    const events: WorkspaceFileWatcherEvent[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'idx', path: 'src/index.ts' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: () => undefined,
      onEvent: (event) => events.push(event),
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'src'));
      events.length = 0;
      await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'b');
      fakeWatch.emitWorkspaceDirectoryEvent(root, '', 'rename', 'node_modules');
      await delay(20);
      const nodeModulesEvents = events.filter(
        (event) =>
          (event.type === 'workspace_changed' || event.type === 'changed') &&
          typeof (event as { path?: string }).path === 'string' &&
          (event as { path: string }).path.split('/')[0] === 'node_modules'
      );
      expect(nodeModulesEvents).toEqual([]);
      expect(fakeWatch.isWatchingWorkspaceDirectory(root, 'node_modules')).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('dynamically watches a directory created after start', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');

    const fakeWatch = createFakeWatchFileSystem();
    const workspaceChanges: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'idx', path: 'src/index.ts' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: (changedPath) => {
        if (changedPath) workspaceChanges.push(changedPath);
      },
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'src'));
      await mkdir(path.join(root, 'src', 'feature'));
      fakeWatch.emitWorkspaceDirectoryEvent(root, 'src', 'rename', 'feature');
      await waitFor(() => workspaceChanges.includes('src/feature'));
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'src/feature'));
      await writeFile(path.join(root, 'src', 'feature', 'new.ts'), 'export const x = 1;');
      fakeWatch.emitWorkspaceDirectoryEvent(root, 'src/feature', 'rename', 'new.ts');
      await waitFor(() => workspaceChanges.includes('src/feature/new.ts'));
    } finally {
      watcher.close();
    }
  });

  it('does not watch inside a gitignored directory created after start', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    await writeFile(path.join(root, '.gitignore'), 'dist/\n');

    const fakeWatch = createFakeWatchFileSystem();
    const workspaceChanges: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'idx', path: 'src/index.ts' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: (changedPath) => {
        if (changedPath) workspaceChanges.push(changedPath);
      },
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'src'));
      await mkdir(path.join(root, 'dist'));
      fakeWatch.emitWorkspaceDirectoryEvent(root, '', 'rename', 'dist');
      await waitFor(() => workspaceChanges.includes('dist'));
      await delay(20);
      expect(fakeWatch.isWatchingWorkspaceDirectory(root, 'dist')).toBe(false);
      await writeFile(path.join(root, 'dist', 'bundle.js'), 'a');
      await writeFile(path.join(root, 'dist', 'bundle.js'), 'ab');
      expect(workspaceChanges.filter((change) => change.startsWith('dist/'))).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('unwatches a directory subtree when it is removed', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    await writeFile(path.join(root, 'src', 'feature', 'a.ts'), 'export const a = 1;');

    const fakeWatch = createFakeWatchFileSystem();
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [
        { id: 'idx', path: 'src/index.ts' },
        { id: 'a', path: 'src/feature/a.ts' },
      ],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: () => undefined,
    });
    try {
      // root + src + src/feature
      await waitFor(() => watcher.watchedDirectoryCount === 3);
      await rm(path.join(root, 'src', 'feature'), { recursive: true, force: true });
      fakeWatch.emitWorkspaceDirectoryEvent(root, 'src', 'rename', 'feature');
      await waitFor(() => watcher.watchedDirectoryCount === 2);
      expect(fakeWatch.isWatchingWorkspaceDirectory(root, 'src/feature')).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('emits a diagnostic when the watched-directory cap is reached', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');

    const fakeWatch = createFakeWatchFileSystem();
    const events: WorkspaceFileWatcherEvent[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'idx', path: 'src/index.ts' }],
      maxWatchedDirectories: 1,
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: () => undefined,
      onEvent: (event) => events.push(event),
    });
    try {
      await waitFor(() =>
        events.some(
          (event) => event.type === 'error' && event.message.includes('Watch directory cap reached')
        )
      );
      expect(watcher.watchedDirectoryCount).toBe(1);
      // Reported only once.
      expect(
        events.filter(
          (event) => event.type === 'error' && event.message.includes('Watch directory cap reached')
        )
      ).toHaveLength(1);
    } finally {
      watcher.close();
    }
  });

  it('watches a directory that becomes un-ignored via a .gitignore edit (even when empty)', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    // `staging/` exists but is empty and ignored at startup.
    await mkdir(path.join(root, 'staging'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'staging/\n');

    const fakeWatch = createFakeWatchFileSystem();
    const workspaceChanges: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'idx', path: 'src/index.ts' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: (changedPath) => {
        if (changedPath) workspaceChanges.push(changedPath);
      },
    });
    try {
      // Root + src are watched; the ignored empty `staging` is not.
      await waitFor(() => watcher.watchedDirectoryCount === 2);
      expect(fakeWatch.isWatchingWorkspaceDirectory(root, 'staging')).toBe(false);
      await writeFile(path.join(root, '.gitignore'), '');
      fakeWatch.emitWorkspaceDirectoryEvent(root, '', 'change', '.gitignore');
      await waitFor(() => watcher.watchedDirectoryCount === 3);
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'staging'));
      await writeFile(path.join(root, 'staging', 'new.ts'), 'export const x = 1;');
      fakeWatch.emitWorkspaceDirectoryEvent(root, 'staging', 'rename', 'new.ts');
      await waitFor(() => workspaceChanges.includes('staging/new.ts'));
    } finally {
      watcher.close();
    }
  });

  it('update() lets a newly tracked file be reloaded on edit', async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, 'README.md'), 'hello');

    const fakeWatch = createFakeWatchFileSystem();
    const changed: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'readme', path: 'README.md' }],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: (id) => changed.push(id),
      onWorkspaceChanged: () => undefined,
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, ''));
      await mkdir(path.join(root, 'docs'));
      await writeFile(path.join(root, 'docs', 'a.md'), 'first');

      watcher.update({
        textFiles: [
          { id: 'readme', path: 'README.md' },
          { id: 'docs-a', path: 'docs/a.md' },
        ],
      });
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, 'docs'));
      await writeFile(path.join(root, 'docs', 'a.md'), 'second');
      fakeWatch.emitWorkspaceDirectoryEvent(root, 'docs', 'change', 'a.md');
      await waitFor(() => changed.includes('docs-a'));
    } finally {
      watcher.close();
    }
  });

  it('reports ignore-control file changes (relative path inside workspace, absolute outside)', async () => {
    const root = await makeWorkspace();
    const outsideDir = await makeWorkspace('ignore-watch-global-');
    const localExclude = path.join(root, 'localexclude');
    const globalIgnore = path.join(outsideDir, 'globalignore');
    await writeFile(localExclude, '');
    await writeFile(globalIgnore, '');
    await writeFile(path.join(root, 'README.md'), 'hello');

    const fakeWatch = createFakeWatchFileSystem();
    const workspaceChanges: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'readme', path: 'README.md' }],
      ignoreControlFiles: [globalIgnore, localExclude],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: (changedPath) => {
        if (changedPath) workspaceChanges.push(changedPath);
      },
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, ''));
      await waitFor(() => fakeWatch.isWatchingPath(localExclude));
      await waitFor(() => fakeWatch.isWatchingPath(globalIgnore));
      await writeFile(localExclude, '*.log\n');
      fakeWatch.emitPathEvent(localExclude);
      await waitFor(() => workspaceChanges.includes('localexclude'));
      await writeFile(globalIgnore, '*.tmp\n');
      fakeWatch.emitPathEvent(globalIgnore);
      await waitFor(() => workspaceChanges.includes(globalIgnore));
    } finally {
      watcher.close();
    }
  });

  it('update() installs a newly added ignore-control file watch', async () => {
    const root = await makeWorkspace();
    const outsideDir = await makeWorkspace('ignore-watch-global-');
    await writeFile(path.join(root, 'README.md'), 'hello');
    // An out-of-workspace control file (like a global gitignore) that only
    // becomes part of the ignore strategy on a later scan. It is NOT covered
    // by any per-directory watch, so only the aux ignore-control watch can
    // observe it — exercising update()'s reconciliation.
    const lateGlobal = path.join(outsideDir, 'globalignore');
    await writeFile(lateGlobal, '');

    const fakeWatch = createFakeWatchFileSystem();
    const workspaceChanges: string[] = [];
    const watcher = startWorkspaceFileWatcher({
      workspaceRoot: root,
      textFiles: [{ id: 'readme', path: 'README.md' }],
      ignoreControlFiles: [],
      debounceMs: 1,
      watchFileSystem: fakeWatch.watchFileSystem,
      onTextFileChanged: () => undefined,
      onWorkspaceChanged: (changedPath) => {
        if (changedPath) workspaceChanges.push(changedPath);
      },
    });
    try {
      await waitFor(() => fakeWatch.isWatchingWorkspaceDirectory(root, ''));
      // Not watched yet → editing it produces nothing.
      expect(fakeWatch.isWatchingPath(lateGlobal)).toBe(false);
      await writeFile(lateGlobal, '*.a\n');
      await delay(20);
      expect(workspaceChanges).not.toContain(lateGlobal);

      // A scan update introduces the control file; update() must install it.
      watcher.update({
        textFiles: [{ id: 'readme', path: 'README.md' }],
        ignoreControlFiles: [lateGlobal],
      });
      await waitFor(() => fakeWatch.isWatchingPath(lateGlobal));
      await writeFile(lateGlobal, '*.b\n');
      fakeWatch.emitPathEvent(lateGlobal);
      await waitFor(() => workspaceChanges.includes(lateGlobal));
    } finally {
      watcher.close();
    }
  });
});
