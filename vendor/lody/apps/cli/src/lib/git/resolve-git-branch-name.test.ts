import { describe, expect, it, vi } from 'vitest';
import {
  resolveGitBranch,
  resolveGitBranchName,
  type SessionExec,
} from './resolve-git-branch-name';

describe('resolveGitBranchName', () => {
  it('prefers `git branch --show-current` when non-empty', async () => {
    const exec: SessionExec = vi.fn(async (_cmd, args) => {
      if (args[0] === 'branch') return 'main\n';
      return 'should-not-be-called\n';
    });
    await expect(resolveGitBranchName(exec, '/repo')).resolves.toBe('main');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('falls back to `git rev-parse --abbrev-ref HEAD` when show-current is empty', async () => {
    const exec: SessionExec = vi.fn(async (_cmd, args) => {
      if (args[0] === 'branch') return '\n';
      return 'feature/test\n';
    });
    await expect(resolveGitBranchName(exec, '/repo')).resolves.toBe('feature/test');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('falls back when show-current errors', async () => {
    const exec: SessionExec = vi.fn(async (_cmd, args) => {
      if (args[0] === 'branch') {
        throw new Error('not a git repo');
      }
      return 'feature/test\n';
    });
    await expect(resolveGitBranchName(exec, '/repo')).resolves.toBe('feature/test');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('reports no branch name on a detached HEAD', async () => {
    const exec: SessionExec = vi.fn(async (_cmd, args) => (args[0] === 'branch' ? '\n' : 'HEAD\n'));
    await expect(resolveGitBranchName(exec, '/repo')).resolves.toBeNull();
  });
});

describe('resolveGitBranch', () => {
  it('reports `detached` when git answers HEAD', async () => {
    const exec: SessionExec = vi.fn(async (_cmd, args) => (args[0] === 'branch' ? '\n' : 'HEAD\n'));
    await expect(resolveGitBranch(exec, '/repo')).resolves.toEqual({ kind: 'detached' });
  });

  // Both probes coming back empty means git never answered. Treating that as
  // `detached` is what silently skipped PR detection on a live branch.
  it('reports `unresolved` when both probes return nothing', async () => {
    const exec: SessionExec = vi.fn(async () => '');
    await expect(resolveGitBranch(exec, '/repo')).resolves.toEqual({ kind: 'unresolved' });
  });

  it('reports `unresolved` when both probes throw', async () => {
    const exec: SessionExec = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    await expect(resolveGitBranch(exec, '/repo')).resolves.toEqual({ kind: 'unresolved' });
  });

  it('reports the branch name when git answers', async () => {
    const exec: SessionExec = vi.fn(async () => 'fix/web-initial-stylesheet-retry\n');
    await expect(resolveGitBranch(exec, '/repo')).resolves.toEqual({
      kind: 'branch',
      branch: 'fix/web-initial-stylesheet-retry',
    });
  });
});
