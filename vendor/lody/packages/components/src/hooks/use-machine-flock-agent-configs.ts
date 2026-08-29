import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { type MachineId } from '@lody/shared';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useMachineFlockRowsByMachineIds } from '@/hooks/use-machine-flock-rows';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';

type UseMachineFlockAgentConfigsOptions = {
  syncRemote?: boolean;
};

function normalizeMachineIds(
  machineIds: readonly (MachineId | string | null | undefined)[]
): MachineId[] {
  return Array.from(
    new Set(
      machineIds
        .map((machineId) => (typeof machineId === 'string' ? machineId.trim() : ''))
        .filter((machineId): machineId is MachineId => machineId.length > 0)
    )
  ).sort();
}

export function useMachineFlockAgentConfigs(
  options: UseMachineFlockAgentConfigsOptions = {}
): void {
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: false });
  const machineIds = useMemo(() => [...machines.keys()], [machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds, options);
}

export function useMachineFlockAgentConfigsForMachineIds(
  requestedMachineIds: readonly (MachineId | string | null | undefined)[],
  options: UseMachineFlockAgentConfigsOptions = {}
): void {
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const machineIdsKey = useMemo(
    () => normalizeMachineIds(requestedMachineIds).join('\0'),
    [requestedMachineIds]
  );
  const machineIds = useMemo(
    () => (machineIdsKey ? (machineIdsKey.split('\0') as MachineId[]) : []),
    [machineIdsKey]
  );
  const remoteMachineIds = useMemo(
    () => machineIds.filter((machineId) => onlineMachineIds.has(machineId)),
    [machineIds, onlineMachineIds]
  );
  useMachineFlockRowsByMachineIds(machineIds, {
    // A setup is the unpublished half of a provider row, so every surface that
    // reads configs also needs it for progress, retry, and login recovery.
    families: ['agentConfig', 'providerSetup'],
    readLocal: true,
    syncRemote: options.syncRemote ?? true,
    remoteMachineIds,
  });
}
