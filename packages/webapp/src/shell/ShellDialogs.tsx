import type { ListMachineTypesResponse } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { CreateOrgDialog } from '../components/CreateOrgDialog';
import {
  CreateWorkspaceDialog,
  type CreateWorkspaceDialogInput,
} from '../CreateWorkspaceDialog';
import {
  WorkspaceDetailsDialog,
  type WorkspaceDetailsTab,
} from '../WorkspaceDetailsDialog';
import { MyMachineDialog } from '../MyMachineDialog';
import type { CloudWorkspaceModel } from '../workspace-store';

/** The workspace this dialog stack is about to delete, and the name the
 * confirmation shows. */
export type WebAppConfirmation = {
  workspaceId: string;
  label: string;
};

export type ShellDialogsProps = {
  client: ControlPlaneClient;
  viewer: TenantMe | null;
  workspaces: CloudWorkspaceModel[];
  showCreateOrg: boolean;
  onCreateOrg: (name: string) => Promise<void>;
  onCloseCreateOrg: () => void;
  showCreateWorkspace: boolean;
  createWorkspaceBusy: boolean;
  createWorkspaceError: string | null;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  /** Runs the workspace poll now, so a dialog write reaches the rows without
   * waiting for the next tick. Keep it stable across renders. */
  refreshWorkspaces: () => void;
  /** The workspace a "new workspace from existing" copies, or null. */
  cloneFromWorkspaceId: string | null;
  onCancelCreateWorkspace: () => void;
  onCreateWorkspace: (input: CreateWorkspaceDialogInput) => void;
  /** Which workspace the details dialog is about, and which tab it opens on.
   * The rail's people icon opens Members; the ⋯ icon opens the default.
   * `focusAddMember` is the tile menu's Invite, which lands on Members with
   * the picker ready to type into. */
  details: {
    workspaceId: string;
    tab: WorkspaceDetailsTab;
    focusAddMember?: boolean;
  } | null;
  onCloseDetails: () => void;
  /** The workspace whose "My machine" panel is open, or null. */
  machineWorkspaceId: string | null;
  onCloseMachine: () => void;
  onCloneWorkspace: (workspaceId: string) => void;
  onRequestDeleteWorkspace: (workspaceId: string) => void;
  confirmation: WebAppConfirmation | null;
  onCancelConfirmation: () => void;
  onConfirmDelete: () => void;
};

/** Every modal the shell can raise from the rail, in one stack. Each route
 * branch renders it once, so the same dialog opens identically everywhere. */
export function ShellDialogs({
  client,
  viewer,
  workspaces,
  showCreateOrg,
  onCreateOrg,
  onCloseCreateOrg,
  showCreateWorkspace,
  createWorkspaceBusy,
  createWorkspaceError,
  listMachineTypes,
  refreshWorkspaces,
  cloneFromWorkspaceId,
  onCancelCreateWorkspace,
  onCreateWorkspace,
  details,
  onCloseDetails,
  machineWorkspaceId,
  onCloseMachine,
  onCloneWorkspace,
  onRequestDeleteWorkspace,
  confirmation,
  onCancelConfirmation,
  onConfirmDelete,
}: ShellDialogsProps) {
  const cloneSource = cloneFromWorkspaceId === null
    ? undefined
    : workspaces.find(({ id }) => id === cloneFromWorkspaceId);
  const detailsWorkspace = details === null
    ? undefined
    : workspaces.find(({ id }) => id === details.workspaceId);
  const machineWorkspace = machineWorkspaceId === null
    ? undefined
    : workspaces.find(({ id }) => id === machineWorkspaceId);
  // Workspace admin, or an org admin reaching in implicitly (§3): the wire
  // reports the second as a null stored role on a workspace they can open.
  const canManageDetails = detailsWorkspace?.myRole === 'admin'
    || detailsWorkspace?.myRole === null;
  return (
    <>
      {showCreateOrg && (
        <CreateOrgDialog onCreate={onCreateOrg} onCancel={onCloseCreateOrg} />
      )}
      {showCreateWorkspace && (
        <CreateWorkspaceDialog
          busy={createWorkspaceBusy}
          error={createWorkspaceError}
          orgName={viewer?.org.name ?? 'your org'}
          orgId={viewer?.org.id ?? ''}
          admin={viewer?.membership.role === 'admin'}
          saveComputeCredential={client.putComputeCredential}
          client={client}
          listMachineTypes={listMachineTypes}
          cloneFromWorkspaceId={cloneFromWorkspaceId}
          cloneFromWorkspaceName={cloneSource?.title ?? null}
          viewerName={viewer?.identity.name || viewer?.identity.email || 'You'}
          onCancel={onCancelCreateWorkspace}
          onSubmit={onCreateWorkspace}
        />
      )}
      {detailsWorkspace?.canControl && details !== null && (
        <WorkspaceDetailsDialog
          key={detailsWorkspace.id}
          client={client}
          workspace={detailsWorkspace}
          listMachineTypes={listMachineTypes}
          refreshWorkspaces={refreshWorkspaces}
          initialTab={details.tab}
          focusAddMember={details.focusAddMember ?? false}
          onClose={onCloseDetails}
          onClone={() => onCloneWorkspace(detailsWorkspace.id)}
          onDelete={canManageDetails
            ? () => onRequestDeleteWorkspace(detailsWorkspace.id)
            : null}
        />
      )}
      {machineWorkspace !== undefined && (
        <MyMachineDialog
          key={`${machineWorkspace.id}:${viewer?.membership.id ?? ''}`}
          client={client}
          workspace={machineWorkspace}
          membershipId={viewer?.membership.id ?? null}
          listMachineTypes={listMachineTypes}
          refreshWorkspaces={refreshWorkspaces}
          onClose={onCloseMachine}
        />
      )}
      {confirmation && (
        <ConfirmationDialog
          title="Delete workspace?"
          description={`Are you sure you want to delete “${confirmation.label}”? This destroys the workspace and cannot be undone.`}
          confirmLabel="Yes, delete"
          cancelLabel="No"
          onCancel={onCancelConfirmation}
          onConfirm={onConfirmDelete}
        />
      )}
    </>
  );
}
