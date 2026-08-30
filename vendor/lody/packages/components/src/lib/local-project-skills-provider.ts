import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineId,
  ProjectSkillsResult,
  WorkspaceId,
} from '@lody/shared';
import { assertLocalProjectControlResponse } from './local-project-rpc-file-provider';

export type LocalProjectSkillsTransport = {
  listSkills: (args: { readonly skillDirs: readonly string[] }) => Promise<ProjectSkillsResult>;
  listGlobalSkills: () => Promise<ProjectSkillsResult>;
};

export function createLocalProjectSkillsTransport(args: {
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  /** Required to list project-scoped skills; omitted for global-only transports
     (machine-global skills are not bound to any project). */
  readonly localProjectId?: LocalProjectId;
  readonly requestedByUserId: string;
  readonly requestLocalProjectControl: (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectControlResponse | null>;
}): LocalProjectSkillsTransport {
  return {
    listSkills: async ({ skillDirs }) => {
      if (!args.localProjectId) {
        throw new Error('localProjectId is required to list project skills.');
      }
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-skills',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          skillDirs: [...skillDirs],
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-skills').result;
    },
    listGlobalSkills: async () => {
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-global-skills',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-global-skills').result;
    },
  };
}
