import type { MachineView } from '@blitzos/schema';
import type { ErrorContext } from './error-dialog/ErrorReporter';
import type { MachineAction } from './WorkspaceMembersEditor';
import type { WorkspaceAction } from './workspace-store';

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

export function runMachineOverlayAction({
  action,
  machine,
  request,
  setOverlay,
  commitWorkspaceMutation,
  workspaceId,
  membershipId,
  reportError,
  errorAction,
  title = MACHINE_ACTION_FAILURE_TITLES[action],
}: {
  action: MachineAction;
  machine: MachineView | null;
  request: () => Promise<MachineView | null>;
  setOverlay: (overlay: MachineOverlay | null) => void;
  commitWorkspaceMutation: (action: WorkspaceAction) => void;
  workspaceId: string;
  membershipId: string;
  reportError: (caught: Error, context: ErrorContext) => void;
  errorAction: string;
  title: string | undefined;
}): void {
  setOverlay({ machine, pendingAction: action });
  void request()
    .then((updated) => {
      const nextMachine = visibleMachine(updated);
      commitWorkspaceMutation({
        type: 'workspace_member_machine_updated',
        workspaceId,
        membershipId,
        machine: nextMachine,
      });
      setOverlay(null);
      if (nextMachine?.state === 'error') {
        reportError(new Error(nextMachine.error ?? 'The machine entered an error state.'), {
          title,
          action: errorAction,
          workspaceId,
        });
      }
    })
    .catch((caught: Error) => {
      setOverlay(null);
      reportError(caught, { title, action: errorAction, workspaceId });
    });
}
