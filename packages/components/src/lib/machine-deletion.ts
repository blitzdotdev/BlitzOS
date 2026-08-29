import { type MachineId, type MachineMeta } from '@lody/shared';

type MemberLike = {
  userId: string;
  role: string;
};

type DeleteMachineAccessInput = {
  machine: Pick<MachineMeta, 'id' | 'ownerUserId'>;
  /** Presence-based machine liveness (see useMachineOnlineStatus). */
  isOnline: boolean;
  currentUserId: string | null;
  localMachineId?: MachineId | null;
  canManageAllMachines: boolean;
};

type EvaluateMachineDeletionInput = Omit<DeleteMachineAccessInput, 'machine'> & {
  machine: MachineMeta;
};

type PrepareMachineDeletionInput = {
  machine: MachineMeta;
  latestMeta?: Partial<MachineMeta>;
};

export type MachineDeletionDecision =
  | { type: 'allowed'; machine: MachineMeta }
  | { type: 'online'; machine: MachineMeta }
  | { type: 'notAllowed'; machine: MachineMeta };

export function canManageAllMachines(
  currentUserId: string | null,
  members: readonly MemberLike[]
): boolean {
  if (!currentUserId) return false;
  const role = members.find((member) => member.userId === currentUserId)?.role;
  return role === 'owner' || role === 'admin';
}

export function canDeleteOfflineMachine(input: DeleteMachineAccessInput): boolean {
  if (input.isOnline) {
    return false;
  }

  return hasOfflineMachineDeleteAccess(input);
}

export function prepareMachineForDeletion({
  machine,
  latestMeta,
}: PrepareMachineDeletionInput): MachineMeta {
  return {
    ...machine,
    ...(latestMeta ?? {}),
    id: machine.id,
  };
}

export function evaluateMachineDeletion(
  input: EvaluateMachineDeletionInput
): MachineDeletionDecision {
  if (input.isOnline) {
    return { type: 'online', machine: input.machine };
  }

  if (hasOfflineMachineDeleteAccess(input)) {
    return { type: 'allowed', machine: input.machine };
  }

  return { type: 'notAllowed', machine: input.machine };
}

function hasOfflineMachineDeleteAccess({
  machine,
  currentUserId,
  localMachineId,
  canManageAllMachines: hasManageAllMachinesAccess,
}: DeleteMachineAccessInput): boolean {
  if (hasManageAllMachinesAccess) {
    return true;
  }

  if (localMachineId && machine.id === localMachineId) {
    return true;
  }

  return Boolean(currentUserId && machine.ownerUserId === currentUserId);
}
