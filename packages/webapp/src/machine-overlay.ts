import type { MachineView } from '@blitzos/schema';
import type { MachineAction } from './WorkspaceMembersEditor';

export const MACHINE_ACTION_FAILURE_TITLES = {
  provision: 'Couldn’t provision machine',
  stop: 'Couldn’t stop machine',
  start: 'Couldn’t start machine',
  recreate: 'Couldn’t recreate machine',
  destroy: 'Couldn’t destroy machine',
} satisfies Record<MachineAction, string>;

export type MachineOverlay = {
  machine: MachineView | null;
  pendingAction: MachineAction | null;
};

export function visibleMachine(machine: MachineView | null): MachineView | null {
  return machine?.state === 'destroyed' ? null : machine;
}

export function machineReconciled(
  polled: MachineView | null,
  expected: MachineView | null,
): boolean {
  if (polled === null || expected === null) return polled === expected;
  return polled.id === expected.id && polled.updatedAt >= expected.updatedAt;
}
