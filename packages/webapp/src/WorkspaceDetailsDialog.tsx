import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AddWorkspaceMemberRequest,
  ImportWorkspaceCredentialsRequest,
  ImportWorkspaceCredentialsResponse,
  ListMachineTypesResponse,
  MachineType,
  PutWorkspaceCredentialRequest,
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
import { WorkspaceSettingsTab } from './WorkspaceSettingsTab';
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

/** How long the paste sits still before the preview asks the server. The
 * preview is a real dry run — same parser, same outcomes — so it must not
 * fire per keystroke. */
export const IMPORT_PREVIEW_DEBOUNCE_MS = 400;

function importCount(preview: ImportWorkspaceCredentialsResponse): number {
  return preview.results.filter(
    ({ outcome }) => outcome === 'stored' || outcome === 'rotated',
  ).length;
}

function importSummary(response: ImportWorkspaceCredentialsResponse): string {
  const parts = [`${response.linesRead} lines read`];
  for (const outcome of ['stored', 'rotated', 'unchanged', 'refused'] as const) {
    const count = response.results.filter((result) => result.outcome === outcome).length;
    if (count > 0) parts.push(`${count} ${outcome}`);
  }
  return parts.join(' · ');
}

function CredentialsTab({
  credentials,
  canManage,
  onPut,
  onRevoke,
  onImport,
}: {
  credentials: CloudWorkspaceModel['credentials'];
  canManage: boolean;
  onPut: (input: PutWorkspaceCredentialRequest) => void;
  onRevoke: (name: string) => void;
  onImport: (input: ImportWorkspaceCredentialsRequest) => Promise<ImportWorkspaceCredentialsResponse>;
}) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');
  const [value, setValue] = useState('');
  const [importText, setImportText] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const [preview, setPreview] = useState<ImportWorkspaceCredentialsResponse | null>(null);
  const [imported, setImported] = useState<ImportWorkspaceCredentialsResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The preview IS the import, minus the writes: the same request with
  // `dryRun` set, so what the rows promise is what the button will do.
  useEffect(() => {
    setPreview(null);
    if (importText.trim() === '') {
      setImportError(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      const request: ImportWorkspaceCredentialsRequest = { text: importText, dryRun: true };
      if (importLabel !== '') request.label = importLabel;
      onImport(request)
        .then((response) => {
          if (stale) return;
          setImportError(null);
          setPreview(response);
        })
        .catch((caught: Error) => {
          if (!stale) setImportError(caught.message);
        });
    }, IMPORT_PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [importText, importLabel, onImport]);

  const runImport = () => {
    const request: ImportWorkspaceCredentialsRequest = { text: importText };
    if (importLabel !== '') request.label = importLabel;
    onImport(request)
      .then((response) => {
        setImportError(null);
        setImported(response);
        setImportText('');
        setImportLabel('');
      })
      .catch((caught: Error) => setImportError(caught.message));
  };

  const chooseFile = (file: File | undefined) => {
    if (file === undefined) return;
    void file.text().then((text) => {
      setImported(null);
      setImportLabel(file.name);
      setImportText(text);
    });
  };
  const submit = () => {
    if (name.trim() === '' || value === '') return;
    const input: PutWorkspaceCredentialRequest = { name: name.trim(), value };
    if (label.trim() !== '') input.label = label.trim();
    // Absent keeps a rotated key's comment; the field left empty is absence,
    // not a clear, so rotating through this form cannot erase one.
    if (comment.trim() !== '') input.comment = comment.trim();
    onPut(input);
    setName('');
    setLabel('');
    setComment('');
    setValue('');
  };
  return (
    <section
      id="workspace-details-credentials-panel"
      role="tabpanel"
      aria-label="Credentials"
      className="workspace-details-credentials"
    >
      <div className="cfg-section">
        <div className="cfg-section-head">
          <h2 className="cfg-title">Credentials</h2>
          <p className="cfg-desc">
            Workspace credentials reach every member machine through{' '}
            <code>blitz-cred</code>. A value is write-only: it never comes back
            out of the store, so a rotation replaces it rather than editing it.
          </p>
        </div>
        <div className="workspace-credential-rows">
          {credentials.length === 0 && (
            <p className="workspace-members-empty">No workspace credentials yet.</p>
          )}
          {credentials.map((credential) => (
            <div className="workspace-credential-row" key={credential.name}>
              <span className="workspace-credential-name">
                <strong>{credential.name}</strong>
                {(credential.comment ?? credential.label) !== null && (
                  <small>{credential.comment ?? credential.label}</small>
                )}
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
      </div>
      {canManage && (
        <div className="credential-import">
          <div className="credential-import-head">
            <h2>Import a .env file</h2>
            <span>each KEY=value line becomes one credential</span>
          </div>
          <div className="credential-import-source">
            <button
              className="webapp-action"
              type="button"
              onClick={() => fileInput.current?.click()}
            >
              Choose file…
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              aria-label="Choose an env file"
              onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
            />
            <span className="credential-import-summary">
              {importLabel === '' ? 'or paste below' : importLabel}
            </span>
          </div>
          <textarea
            aria-label="Env file text"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="# paste .env text — values stay here until you import"
            value={importText}
            onChange={(event) => {
              setImported(null);
              setImportText(event.currentTarget.value);
            }}
          />
          {importError !== null && (
            <p className="workspace-details-error" role="alert">{importError}</p>
          )}
          {preview !== null && (
            <div className="credential-import-preview" aria-live="polite">
              {preview.results.map((result) => (
                <div className="credential-import-row" key={`${result.line}:${result.name}`}>
                  <span>
                    <strong>{result.name}</strong>
                    <small>
                      {result.reason === undefined
                        ? `line ${result.line}`
                        : `line ${result.line} — ${result.reason}`}
                    </small>
                  </span>
                  <span className={`import-chip import-chip--${result.outcome}`}>
                    {result.outcome === 'rotated' ? 'rotates' : result.outcome}
                  </span>
                </div>
              ))}
            </div>
          )}
          {preview !== null && (
            <p className="credential-import-summary">{importSummary(preview)}</p>
          )}
          {imported !== null && (
            <p className="credential-import-summary" role="status">
              Imported: {importSummary(imported)}. Every member machine reads the
              new values on its next <code>blitz-cred</code> pull.
            </p>
          )}
          <div className="credential-import-actions">
            <p>
              Agents do the same with <code>blitz-cred import .env</code>. Values
              never appear in results.
            </p>
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={preview === null || importCount(preview) === 0}
              onClick={runImport}
            >
              {preview === null
                ? 'Import'
                : `Import ${importCount(preview)} key${importCount(preview) === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
      {canManage && (
        <div className="cfg-section">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Add or rotate</h2>
          </div>
          <label className="cfg-field">
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
          <label className="cfg-field">
            Label (optional)
            <input
              aria-label="Credential label"
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="cfg-field">
            Comment (optional)
            <input
              aria-label="Credential comment"
              placeholder="what this key is for — agents read this"
              value={comment}
              onChange={(event) => setComment(event.currentTarget.value)}
            />
          </label>
          <label className="cfg-field">
            Value
            <input
              aria-label="Credential value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <div className="cfg-actions">
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={name.trim() === '' || value === ''}
              onClick={submit}
            >
              Save credential
            </button>
          </div>
        </div>
      )}
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
  onClose,
  onClone,
  onDelete,
}: {
  client: ControlPlaneClient;
  workspace: CloudWorkspaceModel;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  /** Runs the workspace poll now. The rows this dialog administers are the
   * polled ones, so a settled write asks for the next poll rather than
   * leaving the list stale until the 15 s tick. Must be stable: the import
   * preview's debounce watches the callback it is given. */
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
   * write runs that poll at once: the credential a member just saved, and the
   * one they just revoked, are rows only the poll can produce. */
  const run = useCallback((action: Promise<unknown>) => {
    void action
      .then(() => {
        setError(null);
        refreshWorkspaces();
      })
      .catch((caught: Error) => setError(caught.message));
  }, [refreshWorkspaces]);

  /** The import shares one call with its preview, so only the run that writes
   * asks for a poll — a dry run has nothing for it to find. */
  const importCredentials = useCallback(
    async (input: ImportWorkspaceCredentialsRequest) => {
      const response = await client.importWorkspaceCredentials(workspaceId, input);
      if (input.dryRun !== true) refreshWorkspaces();
      return response;
    },
    [client, refreshWorkspaces, workspaceId],
  );

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
          {tab === 'credentials' && (
            <CredentialsTab
              credentials={workspace.credentials}
              canManage={canManage}
              onPut={(input) => run(client.putWorkspaceCredential(workspace.id, input))}
              onRevoke={(name) => run(client.revokeWorkspaceCredential(workspace.id, name))}
              onImport={importCredentials}
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
