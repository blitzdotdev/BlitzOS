import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineId, WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

export type MachineAcpBinaryActionArgs = {
  machineId: MachineId;
  agentType: string;
};

const installRequestsByRuntime = new WeakMap<WorkspaceRuntime, Map<string, Promise<void>>>();

function runDedupedInstall(
  runtime: WorkspaceRuntime,
  machineId: MachineId,
  agentType: string,
  install: () => Promise<void>
): Promise<void> {
  const requests = installRequestsByRuntime.get(runtime) ?? new Map<string, Promise<void>>();
  installRequestsByRuntime.set(runtime, requests);
  const key = `${machineId}\0${agentType}`;
  const existing = requests.get(key);
  if (existing) return existing;
  let request!: Promise<void>;
  request = install().finally(() => {
    if (requests.get(key) === request) {
      requests.delete(key);
    }
  });
  requests.set(key, request);
  return request;
}

/**
 * Registry binaries and managed builtin runtimes share the same status/install
 * round-trip. Onboarding and machine settings use this hook so timeout/error
 * handling stays identical.
 */
export function useMachineAcpBinaryActions(
  runtime: WorkspaceRuntime | null,
  workspaceId: WorkspaceId | null
) {
  const { t } = useTranslation();

  const checkBinaryStatus = useCallback(
    async ({ machineId, agentType }: MachineAcpBinaryActionArgs) => {
      if (!runtime || workspaceId == null) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const responsePromise = runtime.waitForMachineAcpBinaryStatusResponse(machineId, agentType, {
        timeoutMs: 30000,
      });
      runtime.sendControl({ type: 'machine/acp-binary-status', machineId, workspaceId, agentType });
      const response = await responsePromise;
      if (!response) {
        throw new Error(
          t('agents.acpBinary.statusTimeout', 'Could not check the agent download, try again')
        );
      }
      if (!response.success) {
        throw new Error(
          response.error || t('agents.acpBinary.statusError', 'Could not check the agent download')
        );
      }
      if (response.status === 'error') {
        throw new Error(
          response.error || t('agents.acpBinary.statusError', 'Could not check the agent download')
        );
      }
      return {
        status: response.status,
        command: response.command,
        version: response.version,
        current: response.current,
        required: response.required,
      };
    },
    [runtime, t, workspaceId]
  );

  const installBinary = useCallback(
    async ({ machineId, agentType }: MachineAcpBinaryActionArgs) => {
      if (!runtime || workspaceId == null) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      await runDedupedInstall(runtime, machineId, agentType, async () => {
        const responsePromise = runtime.waitForMachineAcpBinaryInstallResponse(
          machineId,
          agentType,
          { timeoutMs: 300000 }
        );
        runtime.sendControl({
          type: 'machine/acp-binary-install',
          machineId,
          workspaceId,
          agentType,
        });
        const response = await responsePromise;
        if (!response) {
          throw new Error(
            t('agents.acpBinary.installTimeout', 'The download timed out, please try again')
          );
        }
        if (!response.success) {
          throw new Error(response.error || t('agents.acpBinary.installError', 'Download failed'));
        }
      });
    },
    [runtime, t, workspaceId]
  );

  return { checkBinaryStatus, installBinary };
}
