import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  getSessionSharingProjectKey,
  resolveLocalProjectSharingState,
  resolveSessionSharingState,
  shouldShowPrivateSharingStatus,
  shouldShowSessionSharing,
} from '../src/lib/session-sharing';
import type { MachineVisibilityAccess } from '../src/lib/visible-machine-index';
import type { LocalProjectVisibilityAccess } from '../src/lib/visible-local-project-index';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;

function machineAccess(sharedWithTeam: boolean): Map<MachineId, MachineVisibilityAccess> {
  return new Map([
    [
      machineId,
      {
        machineId,
        ownerUserId: 'user-1',
        sharedWithTeam,
        updatedAt: 1,
      },
    ],
  ]);
}

function projectAccess(sharedWithTeam: boolean): Map<string, LocalProjectVisibilityAccess> {
  return new Map([
    [
      getSessionSharingProjectKey(machineId, localProjectId),
      {
        machineId,
        localProjectId,
        ownerUserId: 'user-1',
        sharedWithTeam,
        updatedAt: 1,
      },
    ],
  ]);
}

const baseArgs = {
  currentUserId: 'user-1',
  machineName: 'Studio Mac',
  projectName: 'lody',
  isLoading: false,
};

describe('session sharing', () => {
  it('enables sharing state only for the current multi-member workspace', () => {
    expect(
      shouldShowSessionSharing({
        workspaceId: 'workspace-1',
        activeWorkspaceId: 'workspace-1',
        memberCount: 1,
      })
    ).toBe(false);
    expect(
      shouldShowSessionSharing({
        workspaceId: 'workspace-1',
        activeWorkspaceId: 'workspace-1',
        memberCount: 2,
      })
    ).toBe(true);
    expect(
      shouldShowSessionSharing({
        workspaceId: 'workspace-1',
        activeWorkspaceId: 'workspace-2',
        memberCount: 2,
      })
    ).toBe(false);
    expect(
      shouldShowSessionSharing({
        workspaceId: 'workspace-1',
        activeWorkspaceId: 'workspace-1',
        memberCount: null,
      })
    ).toBe(false);
  });

  it('shows a sharing status only while effective access is private', () => {
    const state = {
      ...baseArgs,
      machineId,
      localProjectId,
      canManage: true,
    };

    expect(shouldShowPrivateSharingStatus({ ...state, visibility: 'private' })).toBe(true);
    expect(shouldShowPrivateSharingStatus({ ...state, visibility: 'team' })).toBe(false);
    expect(shouldShowPrivateSharingStatus({ ...state, visibility: 'unknown' })).toBe(false);
    expect(shouldShowPrivateSharingStatus(undefined)).toBe(false);
  });

  it('treats a non-project conversation as shared when its machine is shared', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'team', canManage: true, machineId });
  });

  it('explains that a private machine keeps a conversation private', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine' });
  });

  it('requires both machine and project sharing for local-project conversations', () => {
    const session = {
      machineId,
      project: { kind: 'local', localProjectId },
    };

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: projectAccess(false),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine-and-project' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: projectAccess(true),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: projectAccess(false),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'project' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: projectAccess(true),
      })
    ).toMatchObject({ visibility: 'team' });
  });

  it('uses the same effective machine-and-project access in project pickers', () => {
    expect(
      resolveLocalProjectSharingState({
        ...baseArgs,
        machineId,
        localProjectId,
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: projectAccess(true),
      })
    ).toMatchObject({
      visibility: 'private',
      privateReason: 'machine',
      canManage: true,
    });
  });

  it('keeps visibility unknown while authoritative access rows are loading', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        isLoading: true,
        session: { machineId },
        machineAccessByMachineId: new Map(),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'unknown', canManage: false });
  });

  it('does not treat the owner fallback as unregistered until access loading settles', () => {
    const fallbackAccess = machineAccess(false);
    fallbackAccess.set(machineId, {
      ...fallbackAccess.get(machineId)!,
      updatedAt: 0,
    });

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        isLoading: true,
        session: { machineId },
        machineAccessByMachineId: fallbackAccess,
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'unknown', canManage: true });
  });

  it('does not offer sharing controls to a non-owner', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        currentUserId: 'user-2',
        session: { machineId },
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'private', canManage: false });
  });

  it('recognizes the owner-only fallback as an unregistered machine', () => {
    const fallbackAccess = machineAccess(false);
    fallbackAccess.set(machineId, {
      ...fallbackAccess.get(machineId)!,
      updatedAt: 0,
    });

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: fallbackAccess,
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({
      visibility: 'private',
      privateReason: 'machine-not-registered',
      canManage: true,
    });
  });
});
