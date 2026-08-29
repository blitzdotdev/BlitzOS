import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AddWorkspaceMemberRequest,
  ListMachineTypesResponse,
  MachineType,
  PutWorkspaceCredentialRequest,
  WorkspaceMemberRole,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient, MemberView } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { machineTypeLabel } from './MachineCatalogGrid';
import { ModalOverlay } from './ModalOverlay';
import { WORKSPACE_DEFAULT_MACHINE_TYPE } from './MachineTypeSelect';
import {
  WorkspaceMembersEditor,
  type MachineAction,
} from './WorkspaceMembersEditor';
import type { CloudWorkspaceModel } from './workspace-store';

export type WorkspaceDetailsTab = 'members' | 'credentials' | 'settings';

const TAB_LABELS = {
  members: 'Members',
  credentials: 'Credentials',
  settings: 'Settings',
} satisfies Record<WorkspaceDetailsTab, string>;

function dateLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** "Workspace default" travels as an absent field, not as an empty string
 * the server would have to read as a type id. */
function addMember(input: {
  membershipId: string;
  role: WorkspaceMemberRole;
  machineTypeId: string;
}): AddWorkspaceMemberRequest {
  const request: AddWorkspaceMemberRequest = {
    membershipId: input.membershipId,
    role: input.role,
  };
  if (input.machineTypeId !== WORKSPACE_DEFAULT_MACHINE_TYPE) {
    request.machineTypeId = input.machineTypeId;
  }
  return request;
}

/** The `SetMachineType` confirmation of §6: the disk survives, the VM does
 * not. Held as state so the confirm can run the write it describes. */
type PendingTypeChange = {
  member: WorkspaceMemberView;
  machineTypeId: string;
};

function CredentialsTab({
  credentials,
  canManage,
  onPut,
  onRevoke,
}: {
  credentials: CloudWorkspaceModel['credentials'];
  canManage: boolean;
  onPut: (input: PutWorkspaceCredentialRequest) => void;
  onRevoke: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const submit = () => {
    if (name.trim() === '' || value === '') return;
    const input: PutWorkspaceCredentialRequest = { name: name.trim(), value };
    if (label.trim() !== '') input.label = label.trim();
    onPut(input);
    setName('');
    setLabel('');
    setValue('');
  };
  return (
    <section
      id="workspace-details-credentials-panel"
      role="tabpanel"
      aria-label="Credentials"
      className="workspace-details-credentials"
    >
      <p className="workspace-details-note">
        Workspace credentials reach every member machine through{' '}
        <code>blitz-cred</code>. A value is write-only: it never comes back out
        of the store, so a rotation replaces it rather than editing it.
      </p>
      <div className="workspace-credential-rows">
        {credentials.length === 0 && (
          <p className="workspace-members-empty">No workspace credentials yet.</p>
        )}
        {credentials.map((credential) => (
          <div className="workspace-credential-row" key={credential.name}>
            <span className="workspace-credential-name">
              <strong>{credential.name}</strong>
              {credential.label !== null && <small>{credential.label}</small>}
            </span>
            <span className="workspace-credential-added">{dateLabel(credential.createdAt)}</span>
            {canManage && (
              <button
                className="webapp-action"
                type="button"
                aria-label={`Revoke ${credential.name}`}
                onClick={() => onRevoke(credential.name)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="workspace-credential-add">
          <h2>Add or rotate</h2>
          <label className="blueprint-field">
            Name
            <input
              aria-label="Credential name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="STRIPE_API_KEY"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="blueprint-field">
            Label (optional)
            <input
              aria-label="Credential label"
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="blueprint-field">
            Value
            <input
              aria-label="Credential value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <button
            className="webapp-action webapp-action--primary"
            type="button"
            disabled={name.trim() === '' || value === ''}
            onClick={submit}
          >
            Save credential
          </button>
        </div>
      )}
    </section>
  );
}

function SettingsTab({
  workspace,
  machines,
  canManage,
  onClone,
  onDelete,
}: {
  workspace: CloudWorkspaceModel;
  machines: MachineType[];
  canManage: boolean;
  onClone: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const defaultMachine = machines.find(({ id }) => id === workspace.defaultMachineTypeId);
  return (
    <section
      id="workspace-details-settings-panel"
      role="tabpanel"
      aria-label="Settings"
      className="workspace-details-settings"
    >
      <dl className="workspace-details-list">
        <div><dt>Name</dt><dd>{workspace.serverName}</dd></div>
        <div>
          <dt>Default machine type</dt>
          <dd>
            {defaultMachine?.name ?? machineTypeLabel(workspace.defaultMachineTypeId)}
            <small> — applies to new machines; each member's type is their own.</small>
          </dd>
        </div>
        <div>
          <dt>Provision on add</dt>
          <dd>{workspace.autoProvision ? 'On' : 'Off'}</dd>
        </div>
        <div><dt>Your role</dt><dd>{workspace.myRole ?? 'Organization admin'}</dd></div>
        <div><dt>Connections</dt><dd>{workspace.connections.length}</dd></div>
        <div><dt>Created</dt><dd>{dateLabel(workspace.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(workspace.updatedAt)}</dd></div>
      </dl>
      {canManage && (
        // TODO(member-machines): the settings write needs a workspace update
        // route. The control plane has no PATCH /workspaces/:id, so name,
        // default machine type, auto_provision, agent rules and repos are
        // read-only here rather than controls that silently do nothing.
        <p className="workspace-details-note">
          Editing these settings needs a workspace update route, which the
          control plane does not serve yet. Clone this workspace to start one
          with different settings.
        </p>
      )}
      <div className="workspace-details-settings-actions">
        {onClone && (
          <button className="webapp-action" type="button" onClick={onClone}>
            New workspace from this one
          </button>
        )}
        {onDelete && (
          <button className="workspace-details-delete" type="button" onClick={onDelete}>
            Delete workspace
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The workspace administration surface (plans/MEMBER-MACHINES.md §6).
 *
 * Three tabs: who is in the workspace and what machine each of them holds,
 * the workspace credential names, and the settings. The old Compute and
 * Storage panels are gone — a workspace has no single machine to describe,
 * so those facts live on the member rows instead.
 */
export function WorkspaceDetailsDialog({
  client,
  workspace,
  listMachineTypes,
  initialTab = 'members',
  onClose,
  onClone,
  onDelete,
}: {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  initialTab?: WorkspaceDetailsTab;
  onClose: () => void;
  onClone: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [orgMembers, setOrgMembers] = useState<MemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceDetailsTab>(initialTab);
  const [pendingTypeChange, setPendingTypeChange] = useState<PendingTypeChange | null>(null);

  // Workspace admin runs the workspace; an org admin passes every ✓ in that
  // column through implicit reach, which the wire reports as a null role on a
  // workspace they can still open (§3).
  const canManage = workspace.myRole === 'admin' || workspace.myRole === null;

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([listMachineTypes(), client.listMembers()])
      .then(([machineResponse, memberResponse]) => {
        if (cancelled) return;
        setMachines(machineResponse.machineTypes);
        setOrgMembers(memberResponse.members);
        setError(null);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message || 'Could not load workspace details.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, listMachineTypes]);

  /** Every write reports its own failure and leaves the poll to refresh the
   * rows, so no edit invents a row the server has not agreed to. */
  const run = useCallback((action: Promise<unknown>) => {
    void action.then(() => setError(null)).catch((caught: Error) => setError(caught.message));
  }, []);

  const machineAction = (member: WorkspaceMemberView, action: MachineAction) => {
    const machine = member.machine;
    if (action === 'provision') {
      if (machine === null) {
        setError('This member has no machine row yet. Change their role to provision one.');
        return;
      }
      run(client.provisionMachine(machine.id));
      return;
    }
    if (machine === null) return;
    if (action === 'stop') run(client.stopMachine(machine.id));
    if (action === 'start') run(client.startMachine(machine.id));
    if (action === 'recreate') run(client.recreateMachine(machine.id));
    if (action === 'destroy') run(client.destroyMachine(machine.id));
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
          <h1>Workspace <em>“{workspace.title}”</em></h1>
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
              />
            </section>
          )}
          {tab === 'credentials' && (
            <CredentialsTab
              credentials={workspace.credentials}
              canManage={canManage}
              onPut={(input) => run(client.putWorkspaceCredential(workspace.id, input))}
              onRevoke={(name) => run(client.revokeWorkspaceCredential(workspace.id, name))}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              workspace={workspace}
              machines={machines}
              canManage={canManage}
              onClone={onClone}
              onDelete={onDelete}
            />
          )}
        </div>
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
