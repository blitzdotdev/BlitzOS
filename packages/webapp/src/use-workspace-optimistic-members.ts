import { useEffect, useMemo, useState } from 'react';
import type {
  AddWorkspaceMemberRequest,
  MachineView,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient, MemberView } from './api';
import { useErrorReporter } from './error-dialog/ErrorReporter';
import { WORKSPACE_DEFAULT_MACHINE_TYPE } from './MachineTypeSelect';
import type {
  DraftWorkspaceMember,
  MachineAction,
} from './WorkspaceMembersEditor';
import type { CloudWorkspaceModel } from './workspace-store';
import {
  MACHINE_ACTION_FAILURE_TITLES,
  machineReconciled,
  type MachineOverlay,
  visibleMachine,
} from './machine-overlay';

type PendingAdd = {
  member: WorkspaceMemberView;
  requestPending: boolean;
};

type OptimisticMemberOptions = {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  orgMembers: readonly MemberView[];
  refreshWorkspaces: () => void;
};

function addMemberRequest(input: DraftWorkspaceMember): AddWorkspaceMemberRequest {
  const request: AddWorkspaceMemberRequest = {
    membershipId: input.membershipId,
    role: input.role,
  };
  if (input.machineTypeId !== WORKSPACE_DEFAULT_MACHINE_TYPE) {
    request.machineTypeId = input.machineTypeId;
  }
  if (!input.persistentVolume) request.persistentVolume = false;
  return request;
}

/** Local intent sits over polled members until the next poll confirms it.
 * This prevents an in-flight stale poll from making an add/remove or machine
 * transition flash backward. A rejected request drops only its own overlay. */
export function useWorkspaceOptimisticMembers({
  client,
  workspace,
  orgMembers,
  refreshWorkspaces,
}: OptimisticMemberOptions) {
  const [pendingAdds, setPendingAdds] = useState<Map<string, PendingAdd>>(
    () => new Map(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(() => new Set());
  const [machineOverlays, setMachineOverlays] = useState<Map<string, MachineOverlay>>(
    () => new Map(),
  );
  const reportError = useErrorReporter();
  const workspaceId = workspace.id;

  useEffect(() => {
    const serverByMembership = new Map(
      workspace.members.map((member) => [member.membershipId, member]),
    );
    setPendingAdds((current) => {
      const next = new Map(current);
      for (const membershipId of current.keys()) {
        if (serverByMembership.has(membershipId)) next.delete(membershipId);
      }
      return next.size === current.size ? current : next;
    });
    setPendingRemoves((current) => {
      const next = new Set(current);
      for (const membershipId of current) {
        if (!serverByMembership.has(membershipId)) next.delete(membershipId);
      }
      return next.size === current.size ? current : next;
    });
    setMachineOverlays((current) => {
      const next = new Map(current);
      for (const [membershipId, overlay] of current) {
        if (overlay.pendingAction !== null) continue;
        const polled = serverByMembership.get(membershipId)?.machine ?? null;
        if (machineReconciled(polled, overlay.machine)) next.delete(membershipId);
      }
      return next.size === current.size ? current : next;
    });
  }, [workspace.members]);

  const displayedMembers = useMemo(() => {
    const serverIds = new Set(workspace.members.map(({ membershipId }) => membershipId));
    const members = workspace.members
      .filter(({ membershipId }) => !pendingRemoves.has(membershipId))
      .map((member) => {
        const overlay = machineOverlays.get(member.membershipId);
        return overlay === undefined ? member : { ...member, machine: overlay.machine };
      });
    for (const [membershipId, pending] of pendingAdds) {
      if (serverIds.has(membershipId) || pendingRemoves.has(membershipId)) continue;
      const overlay = machineOverlays.get(membershipId);
      members.push(overlay === undefined
        ? pending.member
        : { ...pending.member, machine: overlay.machine });
    }
    return members;
  }, [machineOverlays, pendingAdds, pendingRemoves, workspace.members]);

  const pendingMembershipIds = useMemo(() => {
    const membershipIds = new Set<string>();
    for (const [membershipId, pending] of pendingAdds) {
      if (pending.requestPending) membershipIds.add(membershipId);
    }
    return membershipIds;
  }, [pendingAdds]);
  const pendingMachineActions = useMemo(() => {
    const actions = new Map<string, MachineAction>();
    if (workspace.autoProvision) {
      for (const [membershipId, pending] of pendingAdds) {
        if (pending.requestPending && pending.member.role !== 'viewer') {
          actions.set(membershipId, 'provision');
        }
      }
    }
    for (const [membershipId, overlay] of machineOverlays) {
      if (overlay.pendingAction !== null) actions.set(membershipId, overlay.pendingAction);
    }
    return actions;
  }, [machineOverlays, pendingAdds, workspace.autoProvision]);

  const addWorkspaceMember = (input: DraftWorkspaceMember) => {
    const identity = orgMembers.find(({ id }) => id === input.membershipId);
    const optimistic: WorkspaceMemberView = {
      membershipId: input.membershipId,
      name: identity?.name || identity?.email || input.membershipId,
      avatarUrl: identity?.avatarUrl ?? null,
      role: input.role,
      machine: null,
    };
    setPendingAdds((current) => new Map(current).set(input.membershipId, {
      member: optimistic,
      requestPending: true,
    }));
    void client.addWorkspaceMember(workspaceId, addMemberRequest(input))
      .then(({ member }) => {
        setPendingAdds((current) => {
          if (!current.has(input.membershipId)) return current;
          return new Map(current).set(input.membershipId, {
            member,
            requestPending: false,
          });
        });
        refreshWorkspaces();
      })
      .catch((caught) => {
        setPendingAdds((current) => {
          const next = new Map(current);
          next.delete(input.membershipId);
          return next;
        });
        reportError(caught, {
          title: 'Couldn’t add member',
          action: `Adding ${optimistic.name} to ${workspace.title}.`,
          workspaceId,
        });
      });
  };

  const removeWorkspaceMember = (member: WorkspaceMemberView) => {
    setPendingRemoves((current) => new Set(current).add(member.membershipId));
    void client.removeWorkspaceMember(workspaceId, member.membershipId)
      .then(refreshWorkspaces)
      .catch((caught) => {
        setPendingRemoves((current) => {
          const next = new Set(current);
          next.delete(member.membershipId);
          return next;
        });
        reportError(caught, {
          title: 'Couldn’t remove member',
          action: `Removing ${member.name} from ${workspace.title}.`,
          workspaceId,
        });
      });
  };

  const runMachineAction = (
    member: WorkspaceMemberView,
    action: MachineAction,
    request: () => Promise<MachineView | null>,
    title = MACHINE_ACTION_FAILURE_TITLES[action],
  ) => {
    setMachineOverlays((current) => new Map(current).set(member.membershipId, {
      machine: member.machine,
      pendingAction: action,
    }));
    void request()
      .then((machine) => {
        const updated = visibleMachine(machine);
        setMachineOverlays((current) => new Map(current).set(member.membershipId, {
          machine: updated,
          pendingAction: null,
        }));
        if (updated?.state === 'error') {
          reportError(new Error(updated.error ?? 'The machine entered an error state.'), {
            title,
            action: `${member.name}’s machine in ${workspace.title}.`,
            workspaceId,
          });
        }
        refreshWorkspaces();
      })
      .catch((caught) => {
        setMachineOverlays((current) => {
          const next = new Map(current);
          next.delete(member.membershipId);
          return next;
        });
        reportError(caught, {
          title,
          action: `${member.name}’s machine in ${workspace.title}.`,
          workspaceId,
        });
      });
  };

  const machineAction = (
    member: WorkspaceMemberView,
    action: MachineAction,
    options: { persistentVolume: boolean },
  ) => {
    const machine = member.machine;
    if (machine === null) {
      if (action === 'provision') {
        runMachineAction(member, action, () => client.provisionMemberMachine(
          workspaceId,
          member.membershipId,
          options.persistentVolume ? {} : { persistentVolume: false },
        ).then(({ member: updated }) => updated.machine));
      }
      return;
    }
    const request = action === 'provision' ? client.provisionMachine
      : action === 'stop' ? client.stopMachine
      : action === 'start' ? client.startMachine
      : action === 'recreate' ? client.recreateMachine
      : client.destroyMachine;
    runMachineAction(
      member,
      action,
      () => request(machine.id).then(({ machine: updated }) => updated),
    );
  };

  return {
    displayedMembers,
    pendingMembershipIds,
    pendingMachineActions,
    addWorkspaceMember,
    removeWorkspaceMember,
    runMachineAction,
    machineAction,
  };
}
