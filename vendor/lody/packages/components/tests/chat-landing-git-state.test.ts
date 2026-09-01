import { describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId, MachineMeta, WorkspaceId } from '@lody/shared';
import {
  getLocalProjectBranchLabel,
  getLocalProjectGitStateLoadKey,
  getLocalProjectWorktreeAvailability,
  isLocalProjectMachineOffline,
  resolveLocalProjectBranchSelection,
} from '../src/lib/chat-landing-git-state';

const machineMeta = (overrides: Partial<MachineMeta> = {}): MachineMeta =>
  ({
    id: 'machine-target' as MachineId,
    ...overrides,
  }) as MachineMeta;

describe('isLocalProjectMachineOffline', () => {
  const project = 'machine-target' as MachineId;
  const visibleLocal = 'machine-local' as MachineId;

  it('short-circuits when target is a different, known, offline machine', () => {
    const isMachineOnline = vi.fn(() => false);
    const offline = isLocalProjectMachineOffline({
      projectMachineId: project,
      visibleLocalMachineId: visibleLocal,
      targetMachine: machineMeta(),
      isMachineOnline,
    });
    expect(offline).toBe(true);
    expect(isMachineOnline).toHaveBeenCalledWith(project);
  });

  it('does not short-circuit when target is the visible local machine', () => {
    const isMachineOnline = vi.fn(() => false);
    const offline = isLocalProjectMachineOffline({
      projectMachineId: project,
      visibleLocalMachineId: project,
      targetMachine: machineMeta(),
      isMachineOnline,
    });
    expect(offline).toBe(false);
    expect(isMachineOnline).not.toHaveBeenCalled();
  });

  it('does not short-circuit when target machine is online', () => {
    const offline = isLocalProjectMachineOffline({
      projectMachineId: project,
      visibleLocalMachineId: visibleLocal,
      targetMachine: machineMeta(),
      isMachineOnline: () => true,
    });
    expect(offline).toBe(false);
  });

  it('does not short-circuit when target machine is unknown (workspace meta still bootstrapping)', () => {
    const isMachineOnline = vi.fn(() => false);
    const offline = isLocalProjectMachineOffline({
      projectMachineId: project,
      visibleLocalMachineId: visibleLocal,
      targetMachine: undefined,
      isMachineOnline,
    });
    expect(offline).toBe(false);
    expect(isMachineOnline).not.toHaveBeenCalled();
  });
});

describe('getLocalProjectGitStateLoadKey', () => {
  const baseArgs = {
    workspaceId: 'workspace-1' as WorkspaceId,
    machineId: 'machine-1' as MachineId,
    localProjectId: 'project-1' as LocalProjectId,
    userId: 'user-1',
    machineOnline: false,
    retryNonce: 0,
    hasRuntime: true,
    hasDesktopControl: false,
  };

  it('builds a stable primitive key for the selected local project load', () => {
    expect(getLocalProjectGitStateLoadKey(baseArgs)).toBe(
      'workspace-1:machine-1:project-1:user-1:offline:runtime:0'
    );
  });

  it('changes when retry, user, machine reachability, or loader path changes', () => {
    expect(
      getLocalProjectGitStateLoadKey({
        ...baseArgs,
        retryNonce: 1,
      })
    ).toBe('workspace-1:machine-1:project-1:user-1:offline:runtime:1');

    expect(
      getLocalProjectGitStateLoadKey({
        ...baseArgs,
        userId: 'user-2',
      })
    ).toBe('workspace-1:machine-1:project-1:user-2:offline:runtime:0');

    expect(
      getLocalProjectGitStateLoadKey({
        ...baseArgs,
        machineOnline: true,
      })
    ).toBe('workspace-1:machine-1:project-1:user-1:online:runtime:0');

    expect(
      getLocalProjectGitStateLoadKey({
        ...baseArgs,
        hasDesktopControl: true,
      })
    ).toBe('workspace-1:machine-1:project-1:user-1:offline:desktop:0');
  });

  it('uses a sentinel while the current user is still loading', () => {
    expect(getLocalProjectGitStateLoadKey({ ...baseArgs, userId: null })).toBe(
      'workspace-1:machine-1:project-1:missing-user:offline:runtime:0'
    );
  });

  it('returns null until the selected project identity is complete', () => {
    expect(getLocalProjectGitStateLoadKey({ ...baseArgs, workspaceId: null })).toBeNull();
    expect(getLocalProjectGitStateLoadKey({ ...baseArgs, machineId: null })).toBeNull();
    expect(getLocalProjectGitStateLoadKey({ ...baseArgs, localProjectId: null })).toBeNull();
  });
});

describe('local project Git selection', () => {
  it('distinguishes exact local and remote branch selectors', () => {
    const labels = { local: 'local', remote: 'remote' };
    expect(getLocalProjectBranchLabel('lody:branch:local:origin%2Ffoo', labels)).toBe(
      'origin/foo (local)'
    );
    expect(getLocalProjectBranchLabel('lody:branch:remote:origin:foo', labels)).toBe(
      'origin/foo (remote)'
    );
    expect(getLocalProjectBranchLabel('refs/heads/foo', labels)).toBe('refs/heads/foo');
    expect(getLocalProjectBranchLabel('main', labels)).toBe('main');
  });

  it('does not synthesize a branch or offer worktrees for an empty repository', () => {
    const state = {
      git: true as const,
      branches: [],
      currentBranch: null,
      defaultBranch: null,
      githubRepoFullName: null,
      workingTree: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
    };

    expect(resolveLocalProjectBranchSelection(state, null)).toBeNull();
    expect(getLocalProjectWorktreeAvailability(state)).toBe(false);
  });

  it('keeps a valid previous selection and enables worktrees when refs exist', () => {
    const state = {
      git: true as const,
      branches: ['feature/selected', 'main'],
      currentBranch: null,
      defaultBranch: 'main',
      githubRepoFullName: null,
      workingTree: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
    };

    expect(resolveLocalProjectBranchSelection(state, 'feature/selected')).toBe('feature/selected');
    expect(getLocalProjectWorktreeAvailability(state)).toBe(true);
  });
});
