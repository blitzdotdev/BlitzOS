import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { type MachineId, type MachineViewMeta } from '@lody/shared';
import { localProbeResultAtom } from '@/atoms/local-probe';
import { useOnlineMachineIds } from './use-machine-online-status';
import { useVisibleMachineMetas } from './use-visible-machine-metas';

/**
 * Returns online machines, optionally filtered by allowed IDs.
 * Shared between MachineSelector and AgentSelector to avoid duplicated filtering logic.
 */
export function useOnlineMachines(allowedMachineIds?: MachineId[]): MachineViewMeta[] {
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: false });
  const localProbeResult = useAtomValue(localProbeResultAtom);
  const onlineMachineIds = useOnlineMachineIds();

  const allowedSet = useMemo(() => {
    if (!allowedMachineIds) return null;
    return new Set(allowedMachineIds);
  }, [allowedMachineIds]);

  return useMemo(() => {
    const online = Array.from(machines.values()).filter(
      (m) => m.id === localProbeResult?.machineId || onlineMachineIds.has(m.id)
    );
    return allowedSet ? online.filter((m) => allowedSet.has(m.id)) : online;
  }, [machines, localProbeResult?.machineId, allowedSet, onlineMachineIds]);
}
