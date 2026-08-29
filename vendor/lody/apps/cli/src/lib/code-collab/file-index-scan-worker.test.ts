import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import fileIndexScanWorker from './file-index-scan-worker';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function withGitWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-'));
  try {
    await git(workspaceRoot, ['init']);
    await git(workspaceRoot, ['config', 'user.email', 'test@example.com']);
    await git(workspaceRoot, ['config', 'user.name', 'Test User']);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Test\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\n');
    await git(workspaceRoot, ['add', '.']);
    await git(workspaceRoot, ['commit', '-m', 'initial']);

    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\ntwo\n');
    await writeFile(path.join(workspaceRoot, 'src', 'new.ts'), 'created\nfile\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function withPlainWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-plain-'));
  try {
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Plain\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'plain\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe('fileIndexScanWorker', () => {
  it('builds Git-backed full file-index state off the main service path', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });

      expect(result.kind).toBe('full-state');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.allChangesSource).toBe('git');
      expect(result.fileTreeEntries).toContainEqual(['src', { kind: 'lazy' }]);
      expect(result.fileTreeEntries).toContainEqual(['README.md', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/app.ts', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/new.ts', true]);
      expect(result.allChanges['src/app.ts']).toEqual({ diff: [1, 0] });
      expect(result.allChanges['src/new.ts']).toEqual({ diff: [2, 0] });
      expect(result.fileIndex['src/app.ts']).toEqual({
        kind: 'file',
        change: { diff: [1, 0] },
      });
      expect(result.fileIndex['src/new.ts']).toEqual({
        kind: 'file',
        change: { diff: [2, 0] },
      });
      expect(result.pathCount).toBe(Object.keys(result.fileIndex).length);
    });
  });

  it('builds non-Git full file-index state with provided diff-store changes', async () => {
    await withPlainWorkspace(async (workspaceRoot) => {
      const probe = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });

      expect(probe).toEqual({
        kind: 'full-state',
        status: 'needs-provided-all-changes',
        reason: 'not-git',
      });

      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        providedAllChanges: {
          source: 'diff-store',
          state: {
            'src/app.ts': { diff: [1, 0] },
          },
          computeMs: 7,
        },
      });

      expect(result.kind).toBe('full-state');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.allChangesSource).toBe('diff-store');
      expect(result.allChangesMs).toBe(7);
      expect(result.fileTreeEntries).toContainEqual(['src', { kind: 'lazy' }]);
      expect(result.fileTreeEntries).toContainEqual(['README.md', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/app.ts', true]);
      expect(result.allChanges['src/app.ts']).toEqual({ diff: [1, 0] });
      expect(result.fileIndex['src/app.ts']).toEqual({
        kind: 'file',
        change: { diff: [1, 0] },
      });
      expect(result.pathCount).toBe(Object.keys(result.fileIndex).length);
    });
  });
});
