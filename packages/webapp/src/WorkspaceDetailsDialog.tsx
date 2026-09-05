import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AddWorkspaceMemberRequest,
  ListMachineTypesResponse,
  MachineType,
  TemplateRepoView,
  WorkspaceMemberRole,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient, MemberView } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ModalOverlay } from './ModalOverlay';
import { WORKSPACE_DEFAULT_MACHINE_TYPE } from './MachineTypeSelect';
import {
  WorkspaceMembersEditor,
  type MachineAction,
} from './WorkspaceMembersEditor';
import { WorkspaceConnectionsTab } from './WorkspaceConnectionsTab';
import { WorkspaceCredentialsTab } from './WorkspaceCredentialsTab';
import { WorkspaceSettingsTab } from './WorkspaceSettingsTab';
import type { CloudWorkspaceModel } from './workspace-store';

/** Members, what this workspace's agents may connect to, the org credentials
 * readable here (plans/ORG-CREDENTIALS.md §9 — a filtered view, not a store),
 * and the settings. */
export type WorkspaceDetailsTab = 'members' | 'connections' | 'credentials' | 'settings';

/** Which provider row `blitz connections open <provider>` pointed at, and when
 * the box raised it — `at` is the marker's own `requestedAt`, so the same
 * provider asked for twice re-points the row. */
export type ConnectionsFocus = { provider: string; at: number };

const TAB_LABELS = {
  members: 'Members',
  connections: 'Connections',
  credentials: 'Credentials',
  settings: 'Settings',
} satisfies Record<WorkspaceDetailsTab, string>;

/** "Workspace default" travels as an absent field, not as an empty string
 * the server would have to read as a type id. */
function addMember(input: {
  membershipId: string;
  role: WorkspaceMemberRole;
  machineTypeId: string;
  persistentVolume: boolean;
}): AddWorkspaceMemberRequest {
  const request: AddWorkspaceMemberRequest = {
    membershipId: input.membershipId,
    role: input.role,
  };
  if (input.machineTypeId !== WORKSPACE_DEFAULT_MACHINE_TYPE) {
    request.machineTypeId = input.machineTypeId;
  }
  // True is the server's default, so only the refusal travels.
  if (!input.persistentVolume) request.persistentVolume = false;
  return request;
}

/** The `SetMachineType` confirmation of §6: the disk survives, the VM does
 * not. Held as state so the confirm can run the write it describes. */
type PendingTypeChange = {
  member: WorkspaceMemberView;
  machineTypeId: string;
};

/**
 * The workspace administration surface (plans/MEMBER-MACHINES.md §6).
 *
 * Four tabs: who is in the workspace and what machine each of them holds,
 * what its agents may connect to, the org credentials readable here, and the
 * settings. The old Compute and Storage panels are gone — a workspace has no
 * single machine to describe, so those facts live on the member rows instead.
 *
 * CONNECTIONS IS A TAB HERE AND NOWHERE ELSE. It used to be a panel of the
 * workspace — a rail button, a tab of Lody's side panel, a segment of the
 * mobile sheet — which put a per-workspace switch three presses from the
 * workspace it belonged to and none of them beside the members it shares.
 *
 * The chrome is the pre-#106 one: the header names the workspace, the tab row
 * sits under it, and the two workspace-wide verbs live in the footer rather
 * than at the bottom of one tab.
 */
export function WorkspaceDetailsDialog({
  client,
  workspace,
  listMachineTypes,
  refreshWorkspaces,
  initialTab = 'members',
  focusAddMember = false,
  focusProvider = null,
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
  /** The provider the box pointed at, when the dialog was opened by a
   * `connections-focus` marker rather than by a click. */
  focusProvider?: ConnectionsFocus | null;
  /** The signed-in member, so the Credentials tab can tell their own
   * own membership from the rest. */
  viewerMembershipId?: string | null;
  orgName?: string;
  /** The org's workspaces, for the access picker in the credential form. */
  orgWorkspaces?: ReadonlyArray<{ id: string; name: string }>;
  /** Runs the workspace poll now. The rows this dialog administers are the
   * polled ones, so a settled write asks for the next poll rather than
   * leaving the list stale until the 15 s tick. */
  refreshWorkspaces: () => void;
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
  const [repos, setRepos] = useState<TemplateRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceDetailsTab>(initialTab);
  const [pendingTypeChange, setPendingTypeChange] = useState<PendingTypeChange | null>(null);

  // Workspace admin runs the workspace; an org admin passes every ✓ in that
  // column through implicit reach, which the wire reports as a null role on a
  // workspace they can still open (§3).
  const canManage = workspace.myRole === 'admin' || workspace.myRole === null;
  const workspaceId = workspace.id;

  // Invite lands on the picker rather than on the close button: the one thing
  // it opened the dialog to do is type a teammate's name.
  useEffect(() => { if (!focusAddMember) closeButton.current?.focus(); }, [focusAddMember]);
  // The host asks for a tab by prop, and it asks again on an already-open
  // dialog: `blitz connections open` arrives while the member may be reading
  // Members. Seeding state once left that ask on the floor.
  useEffect(() => { setTab(initialTab); }, [initialTab]);
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
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message || 'Could not load workspace details.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, listMachineTypes, workspaceId]);

  /** Every write reports its own failure and leaves the poll to refresh the
   * rows, so no edit invents a row the server has not agreed to. A settled
   * write runs that poll at once. */
  const run = useCallback((action: Promise<unknown>) => {
    void action
      .then(() => {
        setError(null);
        refreshWorkspaces();
      })
      .catch((caught: Error) => setError(caught.message));
  }, [refreshWorkspaces]);

  const machineAction = (
    member: WorkspaceMemberView,
    action: MachineAction,
    options: { persistentVolume: boolean },
  ) => {
    const machine = member.machine;
    // A member with no machine has no id to act on, so their one verb goes to
    // the route keyed by the membership instead. The row's type select shows
    // the workspace default until a machine exists, so nothing overrides it.
    if (machine === null) {
      if (action === 'provision') {
        run(client.provisionMemberMachine(
          workspaceId,
          member.membershipId,
          options.persistentVolume ? {} : { persistentVolume: false },
        ));
      }
      return;
    }
    if (action === 'provision') run(client.provisionMachine(machine.id));
    if (action === 'stop') run(client.stopMachine(machine.id));
    if (action === 'start') run(client.startMachine(machine.id));
    if (action === 'recreate') run(client.recreateMachine(machine.id));
    if (action === 'destroy') run(client.destroyMachine(machine.id));
  };

  /** A repo write answers with the list it produced, so the panel shows what
   * the server holds rather than what the browser hoped for. A remove answers
   * 204, and the row the server agreed to delete is the one dropped here. */
  const addRepo = (repo: string) => {
    void client.addWorkspaceRepo(workspaceId, { repo })
      .then((response) => { setRepos(response.repos); setError(null); })
      .catch((caught: Error) => setError(caught.message));
  };

  const removeRepo = (repo: string) => {
    void client.removeWorkspaceRepo(workspaceId, repo)
      .then(() => {
        setRepos((current) => current.filter((entry) => entry.repo !== repo));
        setError(null);
      })
      .catch((caught: Error) => setError(caught.message));
  };

  const changeMachineType = (member: WorkspaceMemberView, machineTypeId: string) => {
    // A machine that does not exist has no type to change; the row's type
    // select only writes once there is a VM behind it.
    if (member.machine === null) {
      setError('This member has no machine yet, so there is no type to change.');
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
          {(['members', 'connections', 'credentials', 'settings'] as const).map((candidate) => (
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
                  members: workspace.members,
                  readOnly: !canManage,
                  ownerMembershipId: workspace.ownerMembershipId,
                  onAdd: (input) => run(client.addWorkspaceMember(workspace.id, addMember(input))),
                  onRoleChange: (membershipId, role: WorkspaceMemberRole) =>
                    run(client.updateWorkspaceMember(workspace.id, membershipId, { role })),
                  onMachineTypeChange: changeMachineType,
                  onMachineAction: machineAction,
                  onRemove: (member) =>
                    run(client.removeWorkspaceMember(workspace.id, member.membershipId)),
                }}
                orgMembers={orgMembers}
                machines={machines}
                defaultMachineTypeId={workspace.defaultMachineTypeId}
                  autoFocusAdd={focusAddMember}
                />
              </div>
            </section>
          )}
          {tab === 'connections' && (
            <WorkspaceConnectionsTab
              client={client}
              workspaceId={workspaceId}
              connections={workspace.connections}
              readOnly={workspace.accessRole === 'viewer'}
              focusProvider={focusProvider}
              onChanged={refreshWorkspaces}
            />
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
              onSave={(input) => run(client.updateWorkspace(workspaceId, input))}
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
            const machine = pendingTypeChange.member.machine;
            setPendingTypeChange(null);
            if (machine === null) return;
            run(client.setMachineType(machine.id, {
              machineTypeId: pendingTypeChange.machineTypeId,
            }));
          }}
        />
      )}
    </ModalOverlay>
  );
}
