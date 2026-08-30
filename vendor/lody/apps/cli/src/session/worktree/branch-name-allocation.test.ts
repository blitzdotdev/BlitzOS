import { describe, expect, it } from 'vitest';
import type { SessionExec } from '@/lib/git/resolve-git-branch-name';
import {
  hasLocalBranchNameConflict,
  isManagedWorktreeBranchName,
  renameBranchWithAvailableSuffix,
  resolveAvailableBranchName,
} from './branch-name-allocation';

describe('isManagedWorktreeBranchName', () => {
  it('recognizes GitHub and shared-local placeholder branches', () => {
    expect(isManagedWorktreeBranchName('session/12345678')).toBe(true);
    expect(isManagedWorktreeBranchName('lody/123456789abc')).toBe(true);
    expect(isManagedWorktreeBranchName('feat/user-owned')).toBe(false);
  });
});

describe('resolveAvailableBranchName', () => {
  it('adds increasing suffixes without reusing an existing branch', () => {
    expect(resolveAvailableBranchName('fix/branch-collision', ['fix/branch-collision'])).toBe(
      'fix/branch-collision-2'
    );
    expect(
      resolveAvailableBranchName('fix/branch-collision', [
        'fix/branch-collision',
        'fix/branch-collision-2',
      ])
    ).toBe('fix/branch-collision-3');
  });

  it('avoids git ref namespace collisions', () => {
    expect(hasLocalBranchNameConflict('feat/topic', ['feat/topic/child'])).toBe(true);
    expect(resolveAvailableBranchName('feat/topic', ['feat/topic/child'])).toBe('feat/topic-2');
    expect(hasLocalBranchNameConflict('feat/topic', ['feat'])).toBe(true);
    expect(resolveAvailableBranchName('feat/topic', ['feat'])).toBe('feat-2/topic');
  });

  it('keeps a suffixed generated branch within its length budget', () => {
    const desired = `fix/${'a'.repeat(46)}`;
    const result = resolveAvailableBranchName(desired, [desired], { maxLength: 50 });

    expect(result).toHaveLength(50);
    expect(result).toMatch(/-2$/);
  });
});

const createFakeGit = (options: {
  currentBranch: string;
  branches: string[];
  ambiguousBranchNames?: string[];
  raceOnFirstRenameTo?: string;
}) => {
  let currentBranch = options.currentBranch;
  const branches = new Set(options.branches);
  let renameAttempts = 0;

  const exec: SessionExec = async (_command, args) => {
    if (args[0] === 'for-each-ref') {
      const usesCanonicalBranchNames = args.includes('--format=%(refname:lstrip=2)');
      return Array.from(branches)
        .sort()
        .map((branchName) =>
          !usesCanonicalBranchNames && options.ambiguousBranchNames?.includes(branchName)
            ? `heads/${branchName}`
            : branchName
        )
        .join('\n');
    }
    if (args[0] === 'branch' && args[1] === '--show-current') {
      return currentBranch;
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return currentBranch;
    }
    if (args[0] === 'branch' && args[1] === '-m') {
      const oldBranch = args[2] ?? '';
      const newBranch = args[3] ?? '';
      renameAttempts += 1;
      if (renameAttempts === 1 && options.raceOnFirstRenameTo === newBranch) {
        branches.add(newBranch);
      }
      if (
        oldBranch !== currentBranch ||
        !branches.has(oldBranch) ||
        hasLocalBranchNameConflict(newBranch, branches)
      ) {
        return '';
      }
      branches.delete(oldBranch);
      branches.add(newBranch);
      currentBranch = newBranch;
      return '';
    }
    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  };

  return {
    exec,
    getCurrentBranch: () => currentBranch,
    getBranches: () => branches,
    getRenameAttempts: () => renameAttempts,
  };
};

describe('renameBranchWithAvailableSuffix', () => {
  it('renames a managed branch to a fresh suffixed name', async () => {
    const git = createFakeGit({
      currentBranch: 'session/12345678',
      branches: ['session/12345678', 'fix/branch-collision'],
    });

    await expect(
      renameBranchWithAvailableSuffix({
        exec: git.exec,
        workdir: '/repo',
        currentBranch: 'session/12345678',
        desiredBranchName: 'fix/branch-collision',
        maxLength: 50,
      })
    ).resolves.toBe('fix/branch-collision-2');
    expect(git.getCurrentBranch()).toBe('fix/branch-collision-2');
    expect(git.getBranches()).toContain('fix/branch-collision');
  });

  it('uses the canonical branch name when a tag has the same short name', async () => {
    const git = createFakeGit({
      currentBranch: 'session/12345678',
      branches: ['session/12345678', 'fix/branch-collision'],
      ambiguousBranchNames: ['fix/branch-collision'],
    });

    await expect(
      renameBranchWithAvailableSuffix({
        exec: git.exec,
        workdir: '/repo',
        currentBranch: 'session/12345678',
        desiredBranchName: 'fix/branch-collision',
        maxLength: 50,
      })
    ).resolves.toBe('fix/branch-collision-2');
    expect(git.getCurrentBranch()).toBe('fix/branch-collision-2');
    expect(git.getBranches()).toContain('fix/branch-collision');
  });

  it('retries with a suffix when another creator wins the first candidate', async () => {
    const git = createFakeGit({
      currentBranch: 'lody/123456789abc',
      branches: ['lody/123456789abc'],
      raceOnFirstRenameTo: 'feat/new-task',
    });

    await expect(
      renameBranchWithAvailableSuffix({
        exec: git.exec,
        workdir: '/repo',
        currentBranch: 'lody/123456789abc',
        desiredBranchName: 'feat/new-task',
        maxLength: 50,
      })
    ).resolves.toBe('feat/new-task-2');
    expect(git.getRenameAttempts()).toBe(2);
    expect(git.getCurrentBranch()).toBe('feat/new-task-2');
  });
});
