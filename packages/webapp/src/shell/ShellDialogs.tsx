import type { ListMachineTypesResponse, Volume, WorkspaceTemplateView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { CreateOrgDialog } from '../components/CreateOrgDialog';
import {
  CreateWorkspaceDialog,
  type CreateWorkspaceDialogInput,
} from '../CreateWorkspaceDialog';
import { ShareWorkspaceDialog } from '../ShareWorkspaceDialog';
import { WorkspaceDetailsDialog } from '../WorkspaceDetailsDialog';
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
  orgDefaultTemplateId: string | null;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  listVolumes: () => Promise<Volume[]>;
  listTemplates: () => Promise<WorkspaceTemplateView[]>;
  onNewTemplate: () => void;
  onCancelCreateWorkspace: () => void;
  onCreateWorkspace: (input: CreateWorkspaceDialogInput) => void;
  shareWorkspaceId: string | null;
  onCloseShare: () => void;
  detailsWorkspaceId: string | null;
  onCloseDetails: () => void;
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
  orgDefaultTemplateId,
  listMachineTypes,
  listVolumes,
  listTemplates,
  onNewTemplate,
  onCancelCreateWorkspace,
  onCreateWorkspace,
  shareWorkspaceId,
  onCloseShare,
  detailsWorkspaceId,
  onCloseDetails,
  onRequestDeleteWorkspace,
  confirmation,
  onCancelConfirmation,
  onConfirmDelete,
}: ShellDialogsProps) {
  const shareWorkspace = shareWorkspaceId === null
    ? undefined
    : workspaces.find(({ id }) => id === shareWorkspaceId);
  const detailsWorkspace = detailsWorkspaceId === null
    ? undefined
    : workspaces.find(({ id }) => id === detailsWorkspaceId);
  const canManageDetails = detailsWorkspace?.accessRole === 'owner'
    || detailsWorkspace?.accessRole === 'admin';
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
          listVolumes={listVolumes}
          listTemplates={listTemplates}
          initialTemplateId={orgDefaultTemplateId}
          // The template page draws this dialog too, since #40. Close it on the
          // way out, or it covers the page it just opened.
          onNewTemplate={onNewTemplate}
          onCancel={onCancelCreateWorkspace}
          onSubmit={onCreateWorkspace}
        />
      )}
      {shareWorkspace && (
        <ShareWorkspaceDialog
          client={client}
          workspaceId={shareWorkspace.id}
          workspaceName={shareWorkspace.title}
          orgName={viewer?.org.name ?? 'your org'}
          orgShareRole={shareWorkspace.orgShareRole}
          owner={shareWorkspace.owner ?? (shareWorkspace.accessRole === 'owner' && viewer
            ? {
                name: viewer.identity.name || viewer.identity.email,
                avatarUrl: viewer.identity.avatarUrl ?? null,
              }
            : null)}
          viewerIsOwner={shareWorkspace.accessRole === 'owner'}
          onClose={onCloseShare}
        />
      )}
      {detailsWorkspace?.canControl && (
        <WorkspaceDetailsDialog
          client={client}
          workspace={detailsWorkspace}
          orgName={viewer?.org.name ?? 'your org'}
          listMachineTypes={listMachineTypes}
          listVolumes={listVolumes}
          onClose={onCloseDetails}
          onDelete={canManageDetails
            ? () => onRequestDeleteWorkspace(detailsWorkspace.id)
            : null}
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
