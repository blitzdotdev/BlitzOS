import { useMemo, useState } from 'react';
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
import type {
  CloudWorkspaceModel,
  WorkspaceAction,
} from './workspace-store';
import {
  type MachineOverlay,
  runMachineOverlayAction,
} from './machine-overlay';

type OptimisticMemberOptions = {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  orgMembers: readonly MemberView[];
  commitWorkspaceMutation: (action: WorkspaceAction) => void;
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

/** Local intent sits over polled members only while its request is in flight.
 * A successful response is committed to the workspace store immediately; a
 * rejection drops only its own overlay and reveals the preceding server row. */
export function useWorkspaceOptimisticMembers({
  client,
  workspace,
  orgMembers,
  commitWorkspaceMutation,
}: OptimisticMemberOptions) {
  const [pendingAdds, setPendingAdds] = useState<Map<string, WorkspaceMemberView>>(
    () => new Map(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(() => new Set());
  const [pendingRoleUpdates, setPendingRoleUpdates] = useState<Map<string, WorkspaceMemberView>>(
    () => new Map(),
  );
  const [machineOverlays, setMachineOverlays] = useState<Map<string, MachineOverlay>>(
    () => new Map(),
  );
  const reportError = useErrorReporter();
  const workspaceId = workspace.id;

  const displayedMembers = useMemo(() => {
    const serverIds = new Set(workspace.members.map(({ membershipId }) => membershipId));
    const members = workspace.members
      .filter(({ membershipId }) => !pendingRemoves.has(membershipId))
      .map((member) => {
        const roleUpdate = pendingRoleUpdates.get(member.membershipId) ?? member;
        const machineOverlay = machineOverlays.get(member.membershipId);
        return machineOverlay === undefined
          ? roleUpdate
          : { ...roleUpdate, machine: machineOverlay.machine };
      });
    for (const [membershipId, pending] of pendingAdds) {
      if (serverIds.has(membershipId) || pendingRemoves.has(membershipId)) continue;
      const overlay = machineOverlays.get(membershipId);
      members.push(overlay === undefined ? pending : { ...pending, machine: overlay.machine });
    }
    return members;
  }, [
    machineOverlays,
    pendingAdds,
    pendingRemoves,
    pendingRoleUpdates,
    workspace.members,
  ]);

  const pendingMembershipIds = useMemo(() => {
    const membershipIds = new Set(pendingAdds.keys());
    for (const membershipId of pendingRoleUpdates.keys()) membershipIds.add(membershipId);
    return membershipIds;
  }, [pendingAdds, pendingRoleUpdates]);
  const pendingMachineActions = useMemo(() => {
    const actions = new Map<string, MachineAction>();
    if (workspace.autoProvision) {
      for (const [membershipId, pending] of pendingAdds) {
        if (pending.role !== 'viewer') actions.set(membershipId, 'provision');
      }
      for (const [membershipId, pending] of pendingRoleUpdates) {
        const preceding = workspace.members.find((member) => (
          member.membershipId === membershipId
        ));
        if (preceding?.role === 'viewer' && pending.role !== 'viewer') {
          actions.set(membershipId, 'provision');
        }
      }
    }
    for (const [membershipId, overlay] of machineOverlays) {
      if (overlay.pendingAction !== null) actions.set(membershipId, overlay.pendingAction);
    }
    return actions;
  }, [
    machineOverlays,
    pendingAdds,
    pendingRoleUpdates,
    workspace.autoProvision,
    workspace.members,
  ]);

  const addWorkspaceMember = (input: DraftWorkspaceMember) => {
    const identity = orgMembers.find(({ id }) => id === input.membershipId);
    const optimistic: WorkspaceMemberView = {
      membershipId: input.membershipId,
      name: identity?.name || identity?.email || input.membershipId,
      avatarUrl: identity?.avatarUrl ?? null,
      role: input.role,
      machine: null,
    };
    setPendingAdds((current) => new Map(current).set(input.membershipId, optimistic));
    void client.addWorkspaceMember(workspaceId, addMemberRequest(input))
      .then(({ member }) => {
        commitWorkspaceMutation({
          type: 'workspace_member_upserted',
          workspaceId,
          member,
        });
        setPendingAdds((current) => {
          const next = new Map(current);
          next.delete(input.membershipId);
          return next;
        });
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
      .then(() => {
        commitWorkspaceMutation({
          type: 'workspace_member_removed',
          workspaceId,
          membershipId: member.membershipId,
        });
        setPendingRemoves((current) => {
          const next = new Set(current);
          next.delete(member.membershipId);
          return next;
        });
      })
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

  const updateWorkspaceMemberRole = (
    member: WorkspaceMemberView,
    role: WorkspaceMemberView['role'],
  ) => {
    setPendingRoleUpdates((current) => new Map(current).set(member.membershipId, {
      ...member,
      role,
    }));
    void client.updateWorkspaceMember(workspaceId, member.membershipId, { role })
      .then(({ member: updated }) => {
        commitWorkspaceMutation({
          type: 'workspace_member_upserted',
          workspaceId,
          member: updated,
        });
        setPendingRoleUpdates((current) => {
          const next = new Map(current);
          next.delete(member.membershipId);
          return next;
        });
      })
      .catch((caught) => {
        setPendingRoleUpdates((current) => {
          const next = new Map(current);
          next.delete(member.membershipId);
          return next;
        });
        reportError(caught, {
          title: 'Couldn’t change member role',
          action: `Updating ${member.name} in ${workspace.title}.`,
          workspaceId,
        });
      });
  };

  const runMachineAction = (
    member: WorkspaceMemberView,
    action: MachineAction,
    request: () => Promise<MachineView | null>,
    title?: string,
  ) => {
    runMachineOverlayAction({
      action,
      machine: member.machine,
      request,
      setOverlay: (overlay) => {
        setMachineOverlays((current) => {
          const next = new Map(current);
          if (overlay === null) next.delete(member.membershipId);
          else next.set(member.membershipId, overlay);
          return next;
        });
      },
      commitWorkspaceMutation,
      workspaceId,
      membershipId: member.membershipId,
      reportError,
      errorAction: `${member.name}’s machine in ${workspace.title}.`,
      title,
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
    updateWorkspaceMemberRole,
    removeWorkspaceMember,
    runMachineAction,
    machineAction,
  };
}
