import { useCallback, useSyncExternalStore } from 'react';
import type { MachineAcpBinaryProgressMessage, MachineId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

const getEmptySnapshot = (): null => null;

/**
 * Reads the latest ephemeral runtime-install state owned by WorkspaceRuntime.
 * The snapshot is scoped to one machine + agent and is never persisted to Flock.
 */
export function useMachineAcpBinaryProgress(
  runtime: WorkspaceRuntime | null,
  machineId: MachineId | null,
  agentType: string | null
): MachineAcpBinaryProgressMessage | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!runtime || machineId === null || agentType === null) {
        return () => undefined;
      }
      return runtime.subscribeMachineAcpBinaryProgress(machineId, agentType, () => {
        onStoreChange();
      });
    },
    [agentType, machineId, runtime]
  );
  const getSnapshot = useCallback(
    () =>
      runtime && machineId !== null && agentType !== null
        ? runtime.getMachineAcpBinaryProgress(machineId, agentType)
        : null,
    [agentType, machineId, runtime]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getEmptySnapshot);
}
