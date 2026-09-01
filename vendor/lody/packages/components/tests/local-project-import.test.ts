import { describe, expect, it, vi } from 'vitest';
import {
  getMachineFlockDocId,
  machineFlockKeys,
  type LocalProjectControlResponse,
  type LocalProjectMeta,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import {
  prepareAndWriteLocalProject,
  selectAndWriteLocalProject,
} from '../src/lib/local-project-import';

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;

function prepared(alreadyRegistered = false): LocalProjectControlResponse {
  return {
    ok: true,
    type: 'local-project/prepare-add',
    result: {
      localProjectId: 'project-1',
      name: 'lody',
      rootPath: '/repo/lody',
      alreadyRegistered,
    },
  };
}

function runtimeWithResponse(response: LocalProjectControlResponse, existing?: LocalProjectMeta) {
  const rows = existing
    ? [{ key: machineFlockKeys.localProject(existing.id), value: existing }]
    : [];
  return {
    workspaceId,
    requestLocalProjectControl: vi.fn(async () => response),
    repo: {
      openFlockDoc: vi.fn(async () => ({
        flock: {
          scan: vi.fn(() => rows),
        },
      })),
    },
    writer: {
      flockRowPutIfAbsent: vi.fn(async (_docId, _key, value: LocalProjectMeta) =>
        existing ? { inserted: false, value: existing } : { inserted: true, value }
      ),
    },
  };
}

describe('prepareAndWriteLocalProject', () => {
  it('writes a newly prepared project through the workspace writer', async () => {
    const runtime = runtimeWithResponse(prepared());

    const result = await prepareAndWriteLocalProject({
      runtime,
      machineId,
      rootPath: '/repo/lody',
      timeoutMessage: 'Timed out',
    });

    expect(runtime.requestLocalProjectControl).toHaveBeenCalledWith(
      {
        type: 'local-project/prepare-add',
        machineId,
        workspaceId,
        rootPath: '/repo/lody',
      },
      { timeoutMs: 30_000 }
    );
    expect(runtime.writer.flockRowPutIfAbsent).toHaveBeenCalledOnce();
    const [docId, key, project] = runtime.writer.flockRowPutIfAbsent.mock.calls[0]!;
    expect(docId).toBe(getMachineFlockDocId(workspaceId, machineId));
    expect(key).toEqual(machineFlockKeys.localProject('project-1'));
    expect(project).toMatchObject({
      id: 'project-1',
      name: 'lody',
      rootPath: '/repo/lody',
    });
    expect(project).not.toHaveProperty('history');
    expect(result).toMatchObject({ status: 'added' });
  });

  it('does not overwrite an already registered row', async () => {
    const runtime = runtimeWithResponse(prepared(true));

    const result = await prepareAndWriteLocalProject({
      runtime,
      machineId,
      rootPath: '/repo/lody',
      timeoutMessage: 'Timed out',
    });

    expect(runtime.writer.flockRowPutIfAbsent).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'existing',
      localProjectId: 'project-1',
      name: 'lody',
      rootPath: '/repo/lody',
    });
  });

  it('preserves renderer-local history when offline prepare could not confirm registration', async () => {
    const existing: LocalProjectMeta = {
      id: 'project-1',
      name: 'lody',
      rootPath: '/repo/lody',
      createdAtMs: 1,
      history: {
        codex: {
          lastListedAt: 2,
          sessions: {
            external: { acpSessionId: 'external', title: 'Existing session' },
          },
        },
      },
    };
    const runtime = runtimeWithResponse(prepared(false), existing);

    const result = await prepareAndWriteLocalProject({
      runtime,
      machineId,
      rootPath: '/repo/lody',
      timeoutMessage: 'Timed out',
    });

    expect(runtime.writer.flockRowPutIfAbsent).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 'existing',
      localProjectId: existing.id,
      name: existing.name,
      rootPath: existing.rootPath,
    });
  });

  it('rejects a malformed existing durable row instead of trusting its shape', async () => {
    const runtime = runtimeWithResponse(prepared(false));
    runtime.writer.flockRowPutIfAbsent.mockResolvedValue({
      inserted: false,
      value: { id: 'project-1', name: 'missing root path' },
    });

    await expect(
      prepareAndWriteLocalProject({
        runtime,
        machineId,
        rootPath: '/repo/lody',
        timeoutMessage: 'Timed out',
      })
    ).rejects.toThrow('Existing local project row is invalid: project-1');
  });

  it('keeps the native picker selection-only and writes from the renderer', async () => {
    const runtime = runtimeWithResponse(prepared());
    const selectDirectory = vi.fn(async () => ({
      machineId,
      rootPath: '/repo/lody',
    }));

    const result = await selectAndWriteLocalProject({
      runtime,
      selectDirectory,
      timeoutMessage: 'Timed out',
    });

    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(runtime.writer.flockRowPutIfAbsent).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'added',
      machineId,
      localProjectId: 'project-1',
    });
  });
});
