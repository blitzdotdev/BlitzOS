import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ListMachineTypesResponse,
  MachineType,
  WorkspaceRepoView,
  UpdateWorkspaceRequest,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient, MemberView } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ModalOverlay } from './ModalOverlay';
import { WorkspaceMembersEditor } from './WorkspaceMembersEditor';
import { WorkspaceCredentialsTab } from './WorkspaceCredentialsTab';
import { WorkspaceSettingsTab } from './WorkspaceSettingsTab';
import type { CloudWorkspaceModel, WorkspaceAction } from './workspace-store';
import { caughtErrorMessage } from './error-message';
import { useErrorReporter } from './error-dialog/ErrorReporter';
import { useWorkspaceOptimisticMembers } from './use-workspace-optimistic-members';

/** Members, the org credentials readable here (plans/ORG-CREDENTIALS.md §9
 * — a filtered view, not a store), and the settings. */
export type WorkspaceDetailsTab = 'members' | 'credentials' | 'settings';

const TAB_LABELS = {
  members: 'Members',
  credentials: 'Credentials',
  settings: 'Settings',
} satisfies Record<WorkspaceDetailsTab, string>;

/** The `SetMachineType` confirmation of §6: the disk survives, the VM does
 * not. Held as state so the confirm can run the write it describes. */
type PendingTypeChange = {
  member: WorkspaceMemberView;
  machineTypeId: string;
};

/**
 * The workspace administration surface (plans/MEMBER-MACHINES.md §6).
 *
 * Two tabs: who is in the workspace and what machine each of them holds,
 * and the settings. The old Compute and Storage panels are gone — a
 * workspace has no single machine to describe, so those facts live on the
 * member rows instead.
 *
 * The chrome is the pre-#106 one: the header names the workspace, the tab row
 * sits under it, and the two workspace-wide verbs live in the footer rather
 * than at the bottom of one tab.
 */
export function WorkspaceDetailsDialog({
  client,
  workspace,
  listMachineTypes,
  initialTab = 'members',
  commitWorkspaceMutation,
  focusAddMember = false,
  viewerMembershipId = null,
  orgName = 'the organization',
  orgWorkspaces = [],
  onClose,
  onClone,
  onDelete,
}: {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  /** The signed-in member, so the Credentials tab can tell their own
   * membership grant from the rest. */
  viewerMembershipId?: string | null;
  orgName?: string;
  /** The org's workspaces, for the grant picker in the credential form. */
  orgWorkspaces?: ReadonlyArray<{ id: string; name: string }>;
  commitWorkspaceMutation: (action: WorkspaceAction) => void;
  initialTab?: WorkspaceDetailsTab;
  /** Opens with the add-member field focused, for the tile menu's Invite. */
  focusAddMember?: boolean;
  onClose: () => void;
  onClone: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [orgMembers, setOrgMembers] = useState<MemberView[]>([]);
  // The repo list is not on `WorkspaceView`: it is settings a poll has no
  // reason to carry, so the dialog reads it once and keeps what each write
  // answers with.
  const [repos, setRepos] = useState<WorkspaceRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceDetailsTab>(initialTab);
  const [pendingTypeChange, setPendingTypeChange] = useState<PendingTypeChange | null>(null);
  const reportError = useErrorReporter();

  // Workspace admin runs the workspace; an org admin passes every ✓ in that
  // column through implicit reach, which the wire reports as a null role on a
  // workspace they can still open (§3).
  const canManage = workspace.myRole === 'admin' || workspace.myRole === null;
  const workspaceId = workspace.id;
  const optimistic = useWorkspaceOptimisticMembers({
    client,
    workspace,
    orgMembers,
    commitWorkspaceMutation,
  });

  // Invite lands on the picker rather than on the close button: the one thing
  // it opened the dialog to do is type a teammate's name.
  useEffect(() => { if (!focusAddMember) closeButton.current?.focus(); }, [focusAddMember]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      listMachineTypes(),
      client.listMembers(),
      client.listWorkspaceRepos(workspaceId),
    ])
      .then(([machineResponse, memberResponse, repoResponse]) => {
        if (cancelled) return;
        setMachines(machineResponse.machineTypes);
        setOrgMembers(memberResponse.members);
        setRepos(repoResponse.repos);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caughtErrorMessage(caught, 'Could not load workspace details.'));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, listMachineTypes, workspaceId]);

  const saveSettings = useCallback(async (input: UpdateWorkspaceRequest) => {
    try {
      const { workspace: updated } = await client.updateWorkspace(workspaceId, input);
      commitWorkspaceMutation({
        type: 'workspace_settings_updated',
        workspaceId,
        settings: {
          serverName: updated.name,
          defaultMachineTypeId: updated.defaultMachineTypeId,
          autoProvision: updated.autoProvision,
          agentRuleId: updated.agentRuleId,
          updatedAt: updated.updatedAt,
        },
      });
      return {
        name: updated.name,
        defaultMachineTypeId: updated.defaultMachineTypeId,
        autoProvision: updated.autoProvision,
        agentRuleId: updated.agentRuleId,
      };
    } catch (caught) {
      reportError(caught instanceof Error ? caught : new Error('The settings could not be saved.'), {
        title: 'Couldn’t save workspace settings',
        action: 'Saving settings for ' + workspace.title + '.',
        workspaceId,
      });
      throw caught;
    }
  }, [client, commitWorkspaceMutation, reportError, workspace.title, workspaceId]);

  /** A repo write answers with the list it produced, so the panel shows what
   * the server holds rather than what the browser hoped for. A remove answers
   * 204, and the row the server agreed to delete is the one dropped here. */
  const addRepo = (repo: string) => {
    void client.addWorkspaceRepo(workspaceId, { repo })
      .then((response) => { setRepos(response.repos); })
      .catch((caught) => reportError(caught, {
        title: 'Couldn’t add repository',
        action: `Adding ${repo} to ${workspace.title}.`,
        workspaceId,
      }));
  };

  const removeRepo = (repo: string) => {
    void client.removeWorkspaceRepo(workspaceId, repo)
      .then(() => {
        setRepos((current) => current.filter((entry) => entry.repo !== repo));
      })
      .catch((caught) => reportError(caught, {
        title: 'Couldn’t remove repository',
        action: `Removing ${repo} from ${workspace.title}.`,
        workspaceId,
      }));
  };

  const changeMachineType = (member: WorkspaceMemberView, machineTypeId: string) => {
    // A machine that does not exist has no type to change; the row's type
    // select only writes once there is a VM behind it.
    if (member.machine === null) {
      reportError(new Error('This member has no machine yet, so there is no type to change.'), {
        title: 'Couldn’t change machine type',
        action: `${member.name}’s machine in ${workspace.title}.`,
        workspaceId,
      });
      return;
    }
    setPendingTypeChange({ member, machineTypeId });
  };

  return (
    <ModalOverlay onDismiss={onClose}>
      <section
        className="workspace-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Workspace details for ${workspace.title}`}
      >
        <header className="workspace-details-header">
          <h1>Workspace details <em>“{workspace.title}”</em></h1>
          <button ref={closeButton} type="button" aria-label="Close workspace details" onClick={onClose}>×</button>
        </header>
        <div className="workspace-details-tabs" role="tablist" aria-label="Workspace detail views">
          {(['members', 'credentials', 'settings'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              aria-controls={`workspace-details-${candidate}-panel`}
              onClick={() => setTab(candidate)}
            >
              {TAB_LABELS[candidate]}
            </button>
          ))}
        </div>
        <div className="workspace-details-body">
          {loading && <p className="workspace-details-status" role="status">Loading workspace details…</p>}
          {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
          {tab === 'members' && (
            <section
              id="workspace-details-members-panel"
              role="tabpanel"
              aria-label="Members"
              className="workspace-details-members"
            >
              <div className="cfg-section">
                <div className="cfg-section-head">
                  <h2 className="cfg-title">Who has access</h2>
                </div>
                <WorkspaceMembersEditor
                  mode={{
                    kind: 'live',
                    members: optimistic.displayedMembers,
                    readOnly: !canManage,
                    ownerMembershipId: workspace.ownerMembershipId,
                    pendingMembershipIds: optimistic.pendingMembershipIds,
                    pendingMachineActions: optimistic.pendingMachineActions,
                    onAdd: optimistic.addWorkspaceMember,
                    onRoleChange: optimistic.updateWorkspaceMemberRole,
                    onMachineTypeChange: changeMachineType,
                    onMachineAction: optimistic.machineAction,
                    onRemove: optimistic.removeWorkspaceMember,
                  }}
                  orgMembers={orgMembers}
                  machines={machines}
                  defaultMachineTypeId={workspace.defaultMachineTypeId}
                  autoFocusAdd={focusAddMember}
                />
              </div>
            </section>
          )}
          {tab === 'credentials' && (
            <WorkspaceCredentialsTab
              client={client}
              workspaceId={workspaceId}
              workspaceName={workspace.title}
              orgName={orgName}
              viewerMembershipId={viewerMembershipId}
              orgMembers={orgMembers}
              workspaces={orgWorkspaces}
            />
          )}
          {tab === 'settings' && (
            <WorkspaceSettingsTab
              client={client}
              workspace={workspace}
              machines={machines}
              repos={repos}
              canManage={canManage}
              onSave={saveSettings}
              onAddRepo={addRepo}
              onRemoveRepo={removeRepo}
            />
          )}
        </div>
        {(onClone !== null || onDelete !== null) && (
          <footer className="workspace-details-footer cfg-footer">
            {onClone && (
              <button className="webapp-action" type="button" onClick={onClone}>
                New workspace from this one
              </button>
            )}
            {onDelete && (
              <button className="cfg-danger-action" type="button" onClick={onDelete}>
                Delete workspace
              </button>
            )}
          </footer>
        )}
      </section>
      {pendingTypeChange !== null && (
        <ConfirmationDialog
          title="Change machine type?"
          description={`This replaces ${pendingTypeChange.member.name}'s VM with a ${pendingTypeChange.machineTypeId} one. It keeps the disk — the volume and everything on it survives — but running sessions restart.`}
          confirmLabel="Yes, change the type"
          onCancel={() => setPendingTypeChange(null)}
          onConfirm={() => {
            const change = pendingTypeChange;
            const machine = change.member.machine;
            setPendingTypeChange(null);
            if (machine === null) return;
            optimistic.runMachineAction(
              change.member,
              'recreate',
              () => client.setMachineType(machine.id, {
                machineTypeId: change.machineTypeId,
              }).then(({ machine: updated }) => updated),
              'Couldn’t change machine type',
            );
          }}
        />
      )}
    </ModalOverlay>
  );
}
