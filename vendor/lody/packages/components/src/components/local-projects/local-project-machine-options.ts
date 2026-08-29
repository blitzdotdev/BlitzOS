import type { MachineId, MachineViewMeta } from '@lody/shared';
import type { MachineVisibilityAccess } from '@/lib/visible-machine-index';
import type { RemoteDirectoryPickerMachine } from './use-remote-directory-picker';

export function buildAddLocalProjectMachineOptions({
  visibleMachines,
  accessByMachineId,
  onlineMachineIds,
  localMachineId,
  currentUserId,
  ownerNameByUserId,
}: {
  visibleMachines: ReadonlyMap<MachineId, MachineViewMeta>;
  accessByMachineId: ReadonlyMap<MachineId, MachineVisibilityAccess>;
  onlineMachineIds: ReadonlySet<MachineId>;
  localMachineId: MachineId | null;
  currentUserId: string | null;
  ownerNameByUserId: ReadonlyMap<string, string>;
}): RemoteDirectoryPickerMachine[] {
  if (!currentUserId) {
    return [];
  }

  const options: RemoteDirectoryPickerMachine[] = [];

  for (const [machineId, meta] of visibleMachines) {
    const ownerUserId = accessByMachineId.get(machineId)?.ownerUserId ?? meta.ownerUserId ?? null;
    options.push({
      id: machineId,
      name: meta.name || machineId,
      online: machineId === localMachineId || onlineMachineIds.has(machineId),
      canAddProjects: ownerUserId === currentUserId,
      ownerName: ownerUserId ? (ownerNameByUserId.get(ownerUserId) ?? null) : null,
    });
  }

  options.sort((left, right) => {
    if (left.canAddProjects !== right.canAddProjects) {
      return left.canAddProjects ? -1 : 1;
    }
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  return options;
}
