import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ImportWorkspaceCredentialsRequest,
  ImportWorkspaceCredentialsResponse,
  ListMachineTypesResponse,
  MachineType,
  PutWorkspaceCredentialRequest,
  TemplateRepoView,
  UpdateWorkspaceRequest,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient, MemberView } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ModalOverlay } from './ModalOverlay';
import { WorkspaceMembersEditor } from './WorkspaceMembersEditor';
import { WorkspaceSettingsTab } from './WorkspaceSettingsTab';
import type { CloudWorkspaceModel, WorkspaceAction } from './workspace-store';
import { caughtErrorMessage } from './error-message';
import { useErrorReporter } from './error-dialog/ErrorReporter';
import { useWorkspaceOptimisticMembers } from './use-workspace-optimistic-members';

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
  onImportError,
}: {
  credentials: CloudWorkspaceModel['credentials'];
  canManage: boolean;
  onPut: (input: PutWorkspaceCredentialRequest) => Promise<void>;
  onRevoke: (name: string) => Promise<void>;
  onImport: (input: ImportWorkspaceCredentialsRequest) => Promise<ImportWorkspaceCredentialsResponse>;
  onImportError: (caught: Error) => void;
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
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [revokingNames, setRevokingNames] = useState<Set<string>>(() => new Set());
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
        .catch((caught) => {
          if (!stale) {
            setImportError(caughtErrorMessage(caught, 'The credential preview could not be loaded.'));
          }
        });
    }, IMPORT_PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [importText, importLabel, onImport]);

  const runImport = () => {
    if (importing) return;
    const request: ImportWorkspaceCredentialsRequest = { text: importText };
    if (importLabel !== '') request.label = importLabel;
    setImporting(true);
    onImport(request)
      .then((response) => {
        setImportError(null);
        setImported(response);
        setImportText('');
        setImportLabel('');
      })
      .catch(onImportError)
      .finally(() => setImporting(false));
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
    if (name.trim() === '' || value === '' || saving) return;
    const input: PutWorkspaceCredentialRequest = { name: name.trim(), value };
    if (label.trim() !== '') input.label = label.trim();
    // Absent keeps a rotated key's comment; the field left empty is absence,
    // not a clear, so rotating through this form cannot erase one.
    if (comment.trim() !== '') input.comment = comment.trim();
    setSaving(true);
    void onPut(input)
      .then(() => {
        setName('');
        setLabel('');
        setComment('');
        setValue('');
      })
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };
  const revoke = (credentialName: string) => {
    setRevokingNames((current) => new Set(current).add(credentialName));
    void onRevoke(credentialName)
      .catch(() => undefined)
      .finally(() => {
        setRevokingNames((current) => {
          const next = new Set(current);
          next.delete(credentialName);
          return next;
        });
      });
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
                  aria-label={'Revoke ' + credential.name}
                  disabled={revokingNames.has(credential.name)}
                  onClick={() => revoke(credential.name)}
                >
                  {revokingNames.has(credential.name) ? 'Revoking…' : 'Revoke'}
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
              disabled={importing}
              onClick={() => fileInput.current?.click()}
            >
              Choose file…
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              aria-label="Choose an env file"
              disabled={importing}
              onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
            />
            <span className="credential-import-summary">
              {importLabel === '' ? 'or paste below' : importLabel}
            </span>
          </div>
          <textarea
            aria-label="Env file text"
            disabled={importing}
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
              disabled={importing || preview === null || importCount(preview) === 0}
              onClick={runImport}
            >
              {importing
                ? 'Importing…'
                : preview === null
                  ? 'Import'
                  : 'Import ' + importCount(preview) + ' key'
                    + (importCount(preview) === 1 ? '' : 's')}
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
              disabled={saving}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="cfg-field">
            Label (optional)
            <input
              aria-label="Credential label"
              disabled={saving}
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="cfg-field">
            Comment (optional)
            <input
              aria-label="Credential comment"
              placeholder="what this key is for — agents read this"
              disabled={saving}
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
              disabled={saving}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <div className="cfg-actions">
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={saving || name.trim() === '' || value === ''}
              onClick={submit}
            >
              {saving ? 'Saving…' : 'Save credential'}
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
  commitWorkspaceMutation,
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
  const [repos, setRepos] = useState<TemplateRepoView[]>([]);
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

  const putCredential = useCallback(async (input: PutWorkspaceCredentialRequest) => {
    try {
      const { credential } = await client.putWorkspaceCredential(workspaceId, input);
      commitWorkspaceMutation({
        type: 'workspace_credential_upserted',
        workspaceId,
        credential,
      });
    } catch (caught) {
      reportError(
        caught instanceof Error ? caught : new Error('The action could not be completed.'),
        {
          title: 'Couldn’t save credential',
          action: 'Saving ' + input.name + ' in ' + workspace.title + '.',
          workspaceId,
        },
      );
      throw caught;
    }
  }, [client, commitWorkspaceMutation, reportError, workspace.title, workspaceId]);

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

  const revokeCredential = useCallback(async (name: string) => {
    try {
      await client.revokeWorkspaceCredential(workspaceId, name);
      commitWorkspaceMutation({
        type: 'workspace_credential_removed',
        workspaceId,
        name,
      });
    } catch (caught) {
      reportError(caught instanceof Error ? caught : new Error('The credential could not be revoked.'), {
        title: 'Couldn’t revoke credential',
        action: 'Revoking ' + name + ' from ' + workspace.title + '.',
        workspaceId,
      });
      throw caught;
    }
  }, [client, commitWorkspaceMutation, reportError, workspace.title, workspaceId]);

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
            <CredentialsTab
              credentials={workspace.credentials}
              canManage={canManage}
              onPut={putCredential}
              onRevoke={revokeCredential}
              onImport={importCredentials}
              onImportError={(caught) => reportError(caught, {
                title: 'Couldn’t import credentials',
                action: `Importing credentials into ${workspace.title}.`,
                workspaceId,
              })}
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
