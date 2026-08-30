import { useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import type { MachineId, MachineViewMeta } from '@lody/shared';

/**
 * `@/hooks/use-online-machines` resolves machines through Convex + the workspace
 * runtime, neither of which exists in the public-site bundle (rendering the real
 * hook throws "VITE_CONVEX_DEPLOY_URL is required"). The preview seeds this atom
 * with its mock machines instead, so `DesktopRunConfigMenu` can list the agent
 * configs seeded into `agentConfigMetaCacheAtom`.
 */
export const landingPreviewMachinesAtom = atom<MachineViewMeta[]>([]);

export function useOnlineMachines(allowedMachineIds?: MachineId[]): MachineViewMeta[] {
  const machines = useAtomValue(landingPreviewMachinesAtom);
  return useMemo(() => {
    if (!allowedMachineIds) return machines;
    const allowed = new Set(allowedMachineIds);
    return machines.filter((machine) => allowed.has(machine.id));
  }, [machines, allowedMachineIds]);
}
