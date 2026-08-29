import { describe, expect, it } from 'vitest';
import type {
  LocalProjectControlRequest,
  LocalProjectHistoryProvider,
  LocalProjectId,
  MachineId,
  WorkspaceId,
} from '@lody/shared';

import { precheckLocalProjectHistoryRequest } from '../src/lib/local-project-history-precheck';

const MACHINE = 'machine-1' as MachineId;
const WORKSPACE = 'workspace-1' as WorkspaceId;
const LOCAL_PROJECT = 'proj-1' as LocalProjectId;
const CODEX_PROVIDER = { cliType: 'builtin', agentType: 'codex' } as const;

function syncRequest(
  overrides: Partial<{
    machineId: MachineId;
    workspaceId: WorkspaceId;
    localProjectId: LocalProjectId;
    provider: LocalProjectHistoryProvider;
    requestedByUserId: string | undefined;
    type: LocalProjectControlRequest['type'];
  }> = {}
): LocalProjectControlRequest {
  return {
    type: overrides.type ?? 'local-project/sync-history',
    machineId: overrides.machineId ?? MACHINE,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    localProjectId: overrides.localProjectId ?? LOCAL_PROJECT,
    provider: overrides.provider ?? CODEX_PROVIDER,
    requestedByUserId: 'requestedByUserId' in overrides ? overrides.requestedByUserId : 'user-1',
  } as LocalProjectControlRequest;
}

function setupRequest(
  type:
    | 'local-project/get-worktree-setup'
    | 'local-project/set-worktree-setup'
    | 'local-project/get-worktree-cleanup'
    | 'local-project/set-worktree-cleanup'
): LocalProjectControlRequest {
  return {
    type,
    machineId: MACHINE,
    workspaceId: WORKSPACE,
    localProjectId: LOCAL_PROJECT,
    requestedByUserId: 'user-1',
    ...(type === 'local-project/set-worktree-setup' || type === 'local-project/set-worktree-cleanup'
      ? { config: { scripts: { bash: 'pnpm install' } } }
      : {}),
  } as LocalProjectControlRequest;
}

describe('precheckLocalProjectHistoryRequest', () => {
  it('accepts a well-formed history sync request', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest(),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result).toEqual({
      ok: true,
      request: syncRequest(),
      requesterUserId: 'user-1',
    });
  });

  it('rejects machine_mismatch when machineId differs from the local machine', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({ machineId: 'other-machine' as MachineId }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('machine_mismatch');
      expect(result.message).toContain(MACHINE);
    }
  });

  it('rejects unsupported request types (e.g., a non-history dispatch on this code path)', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({ type: 'local-project/list-files' }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_request');
      expect(result.message).toContain('local-project/list-files');
    }
  });

  it('rejects invalid_request when requestedByUserId is missing', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({ requestedByUserId: undefined }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_request');
      expect(result.message).toContain('requestedByUserId');
    }
  });

  it('rejects invalid_request when requestedByUserId is whitespace only', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({ requestedByUserId: '   ' }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_request');
    }
  });

  it('rejects workspace_not_found when workspaceId does not match this connection', () => {
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({ workspaceId: 'wrong-workspace' as WorkspaceId }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('workspace_not_found');
      expect(result.message).toContain(WORKSPACE);
    }
  });

  it.each(['local-project/sync-history', 'local-project/import-history'] as const)(
    'accepts every history request type: %s',
    (type) => {
      const baseRequest = syncRequest({ type });
      const request: LocalProjectControlRequest =
        type === 'local-project/import-history'
          ? ({ ...baseRequest, acpSessionIds: ['source-acp-id'] } as LocalProjectControlRequest)
          : baseRequest;
      const result = precheckLocalProjectHistoryRequest({
        request,
        expectedMachineId: MACHINE,
        expectedWorkspaceId: WORKSPACE,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.request.type).toBe(type);
      }
    }
  );

  it.each([
    'local-project/get-worktree-setup',
    'local-project/set-worktree-setup',
    'local-project/get-worktree-cleanup',
    'local-project/set-worktree-cleanup',
  ] as const)('accepts worktree config request type: %s', (type) => {
    const request = setupRequest(type);
    const result = precheckLocalProjectHistoryRequest({
      request,
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.type).toBe(type);
      expect(result.requesterUserId).toBe('user-1');
    }
  });

  it('runs machine_mismatch BEFORE type validation (defense-in-depth)', () => {
    // Even an unsupported request type from the wrong machine must report
    // machine_mismatch first so we never leak workspace identity to attackers.
    const result = precheckLocalProjectHistoryRequest({
      request: syncRequest({
        machineId: 'attacker-machine' as MachineId,
        type: 'local-project/list-files',
      }),
      expectedMachineId: MACHINE,
      expectedWorkspaceId: WORKSPACE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('machine_mismatch');
    }
  });
});
