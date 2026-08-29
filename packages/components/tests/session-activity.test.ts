import { describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';

import { touchSessionActivityMeta } from '../src/hooks/use-session-actions';
import type { WorkspaceRuntime } from '../src/atoms/runtime';

function createRuntime(
  metas: Record<string, SessionMeta | { deleted: true }>
): Pick<WorkspaceRuntime, 'repo' | 'writer'> {
  return {
    repo: {
      getDocMeta: vi.fn(async (roomId: string) => {
        const meta = metas[roomId];
        if (!meta) return undefined;
        if ('deleted' in meta) return { deleted: true, meta: {} };
        return { meta };
      }),
      upsertDocMeta: vi.fn(async () => undefined),
    } as unknown as WorkspaceRuntime['repo'],
    writer: {
      upsertDocMeta: vi.fn(async () => undefined),
    } as unknown as WorkspaceRuntime['writer'],
  };
}

describe('touchSessionActivityMeta', () => {
  it('rolls child tab activity up to the parent session', async () => {
    const parentId = 'parent-session' as SessionId;
    const childId = 'child-session' as SessionId;
    const parentRoomId = getSessionRoomId(parentId);
    const childRoomId = getSessionRoomId(childId);
    const runtime = createRuntime({
      [parentRoomId]: {
        id: parentId,
        machineId: 'machine-1',
        createdAt: '2026-05-24T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        lastMessageAt: 100,
        lastReadAt: 90,
      } as SessionMeta,
      [childRoomId]: {
        id: childId,
        machineId: 'machine-1',
        createdAt: '2026-05-24T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        parentSessionId: parentId,
        lastMessageAt: 120,
        lastReadAt: 110,
      } as SessionMeta,
    });

    await touchSessionActivityMeta(runtime as WorkspaceRuntime, childId, {
      lastMessageAt: 200,
      lastReadAt: 200,
    });

    expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(childRoomId, {
      lastMessageAt: 200,
      lastReadAt: 200,
    });
    expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(parentRoomId, {
      lastMessageAt: 200,
      lastReadAt: 200,
    });
  });

  it('does not move parent timestamps backwards', async () => {
    const parentId = 'parent-session' as SessionId;
    const childId = 'child-session' as SessionId;
    const parentRoomId = getSessionRoomId(parentId);
    const childRoomId = getSessionRoomId(childId);
    const runtime = createRuntime({
      [parentRoomId]: {
        id: parentId,
        machineId: 'machine-1',
        createdAt: '2026-05-24T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        lastMessageAt: 500,
        lastReadAt: 450,
      } as SessionMeta,
      [childRoomId]: {
        id: childId,
        machineId: 'machine-1',
        createdAt: '2026-05-24T00:00:00.000Z',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        parentSessionId: parentId,
        lastMessageAt: 100,
        lastReadAt: 100,
      } as SessionMeta,
    });

    await touchSessionActivityMeta(runtime as WorkspaceRuntime, childId, {
      lastMessageAt: 200,
      lastReadAt: 200,
    });

    expect(runtime.writer.upsertDocMeta).toHaveBeenCalledWith(childRoomId, {
      lastMessageAt: 200,
      lastReadAt: 200,
    });
    expect(runtime.writer.upsertDocMeta).not.toHaveBeenCalledWith(parentRoomId, expect.anything());
  });
});
