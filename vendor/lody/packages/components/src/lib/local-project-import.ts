import {
  getMachineFlockDocId,
  getServerNow,
  machineFlockKeys,
  parseMachineFlockRow,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

export type AddLocalProjectResult = {
  status: 'added' | 'existing';
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
};

type NativeLocalProjectDirectorySelection =
  | { machineId: string; rootPath: string }
  | { error: string }
  | null;

type LocalProjectImportRuntime = Pick<
  WorkspaceRuntime,
  'workspaceId' | 'requestLocalProjectControl'
> & {
  writer: Pick<WorkspaceRuntime['writer'], 'flockRowPutIfAbsent'>;
};

export async function prepareAndWriteLocalProject(args: {
  runtime: LocalProjectImportRuntime;
  machineId: MachineId;
  rootPath: string;
  timeoutMessage: string;
}): Promise<AddLocalProjectResult> {
  const response = await args.runtime.requestLocalProjectControl(
    {
      type: 'local-project/prepare-add',
      machineId: args.machineId,
      workspaceId: args.runtime.workspaceId,
      rootPath: args.rootPath,
    },
    { timeoutMs: 30_000 }
  );
  if (!response) throw new Error(args.timeoutMessage);
  if (!response.ok) throw new Error(response.message);
  if (response.type !== 'local-project/prepare-add') {
    throw new Error(`Unexpected response: ${response.type}`);
  }
  if (response.result.alreadyRegistered) {
    return {
      status: 'existing',
      localProjectId: response.result.localProjectId,
      name: response.result.name,
      rootPath: response.result.rootPath,
    };
  }

  const flockDocId = getMachineFlockDocId(args.runtime.workspaceId, args.machineId);
  const nowMs = getServerNow();
  const project: LocalProjectMeta = {
    id: response.result.localProjectId,
    name: response.result.name,
    rootPath: response.result.rootPath,
    createdAtMs: nowMs,
    lastOpenedAtMs: nowMs,
  };
  const projectKey = machineFlockKeys.localProject(project.id);
  const writeResult = await args.runtime.writer.flockRowPutIfAbsent(
    flockDocId,
    projectKey,
    project
  );
  const storedRow = parseMachineFlockRow(projectKey, writeResult.value);
  const storedProject =
    storedRow?.key[0] === 'localProject' ? (storedRow.value as LocalProjectMeta) : undefined;
  if (!storedProject || storedProject.id !== project.id) {
    throw new Error(`Existing local project row is invalid: ${project.id}`);
  }
  return {
    status: writeResult.inserted ? 'added' : 'existing',
    localProjectId: storedProject.id,
    name: storedProject.name,
    rootPath: storedProject.rootPath,
  };
}

/**
 * The Electron main process owns the native folder picker, but the renderer
 * owns the import mutation. Keep the picker IPC selection-only, then reuse the
 * same machine validation + WorkspaceWriter path as the remote directory UI.
 */
export async function selectAndWriteLocalProject(args: {
  runtime: LocalProjectImportRuntime;
  selectDirectory: () => Promise<NativeLocalProjectDirectorySelection>;
  timeoutMessage: string;
}): Promise<({ machineId: MachineId } & AddLocalProjectResult) | null> {
  const selection = await args.selectDirectory();
  if (!selection) return null;
  if ('error' in selection) throw new Error(selection.error);

  const machineId = selection.machineId.trim() as MachineId;
  const rootPath = selection.rootPath.trim();
  if (!machineId || !rootPath) throw new Error('Invalid local project directory selection');

  const result = await prepareAndWriteLocalProject({
    runtime: args.runtime,
    machineId,
    rootPath,
    timeoutMessage: args.timeoutMessage,
  });
  return { machineId, ...result };
}
