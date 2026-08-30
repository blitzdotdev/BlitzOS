import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listNonIgnoredWorkspaceDirectories } from '../src/index';

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ignore-dir-walk-'));
  tempRoots.push(root);
  return root;
}

describe('listNonIgnoredWorkspaceDirectories', () => {
  it('lists non-ignored directories (including empty ones) and skips node_modules/.git/gitignored', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src', 'sub'), { recursive: true });
    await mkdir(path.join(root, 'empty'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.git', 'objects'), { recursive: true });
    await mkdir(path.join(root, 'build', 'out'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'build/\n');

    const directories = await listNonIgnoredWorkspaceDirectories({ workspaceRoot: root });

    expect(directories).toContain('');
    expect(directories).toContain('src');
    expect(directories).toContain('src/sub');
    // Empty directories must be watched too, so files later created inside
    // them are detected.
    expect(directories).toContain('empty');
    expect(directories.some((directory) => directory.split('/')[0] === 'node_modules')).toBe(false);
    expect(directories.some((directory) => directory.split('/')[0] === '.git')).toBe(false);
    expect(directories.some((directory) => directory.split('/')[0] === 'build')).toBe(false);
  });

  it('walks a subtree from startDirectory honoring ancestor gitignore', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'src', 'sub', 'deep'), { recursive: true });
    await mkdir(path.join(root, 'other'), { recursive: true });

    const directories = await listNonIgnoredWorkspaceDirectories({
      workspaceRoot: root,
      startDirectory: 'src',
    });

    expect(directories).toEqual(['src', 'src/sub', 'src/sub/deep']);
  });

  it('returns nothing when the start directory itself is ignored', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'dist', 'out'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'dist/\n');

    expect(
      await listNonIgnoredWorkspaceDirectories({ workspaceRoot: root, startDirectory: 'dist' })
    ).toEqual([]);
    expect(
      await listNonIgnoredWorkspaceDirectories({
        workspaceRoot: root,
        startDirectory: 'node_modules',
      })
    ).toEqual([]);
  });

  it('respects nested .gitignore and honors maxDirectories', async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true });
    await mkdir(path.join(root, 'pkg', 'generated'), { recursive: true });
    await writeFile(path.join(root, 'pkg', '.gitignore'), 'generated/\n');

    const directories = await listNonIgnoredWorkspaceDirectories({ workspaceRoot: root });
    expect(directories).toContain('pkg');
    expect(directories).toContain('pkg/src');
    expect(directories).not.toContain('pkg/generated');

    const capped = await listNonIgnoredWorkspaceDirectories({
      workspaceRoot: root,
      maxDirectories: 1,
    });
    expect(capped).toEqual(['']);
  });
});
