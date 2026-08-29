import type {
  CreateWorkspaceRequest,
  ListMachineTypesResponse,
  MachineType,
  MachineTypeProviderFailure,
  MachineTypeProviderStatus,
  Volume,
} from '@blitzos/schema';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AgentRulesPicker, type AgentRulesApi } from './AgentRulesPicker';
import type { ControlPlaneClient, MemberView } from './api';
import {
  clearWorkspaceConnectDraft,
  hasConnectReturn,
  readWorkspaceConnectDraft,
  storeWorkspaceConnectDraft,
} from './connect-drafts';
import type { ComputeCredentialsClient } from './compute-credentials-api';
import { isComputeCredentialProvider } from './ComputeCredentialFields';
import { InlineComputeCredentialSetup } from './InlineComputeCredentialSetup';
import { OutlinedLoadingRows } from './LoadingSkeleton';
import { MachineCatalogGrid } from './MachineCatalogGrid';
import { WORKSPACE_DEFAULT_MACHINE_TYPE } from './MachineTypeSelect';
import {
  WorkspaceMembersEditor,
  type DraftWorkspaceMember,
} from './WorkspaceMembersEditor';
import { TemplateRepoPicker } from './files/TemplateRepoPicker';

export type CreateWorkspaceDialogInput = CreateWorkspaceRequest;

/** A credential the create request will carry. This is the only path where a
 * value crosses the wire (plans/MEMBER-MACHINES.md §1 wire types). */
type DraftCredential = { name: string; label: string; value: string };

type CreateWorkspaceDialogProps = {
  busy: boolean;
  error: string | null;
  orgName: string;
  orgId?: string;
  /** Org admin. Workspace creation is org-admin only for now (§3), so a
   * member is told before they fill the form, not after the 403. */
  admin?: boolean;
  saveComputeCredential?: ComputeCredentialsClient['putComputeCredential'];
  client: AgentRulesApi & Pick<
    ControlPlaneClient,
    'connectStartUrl' | 'listGithubInstallations' | 'listGithubRepositories' | 'listMembers'
  >;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  listVolumes: () => Promise<Volume[]>;
  /** The workspace whose config this create copies — "new workspace from
   * existing", which replaced templates (§0). Members and credential values
   * are never copied. */
  cloneFromWorkspaceId?: string | null;
  cloneFromWorkspaceName?: string | null;
  /** Named on the pinned first row of the members editor. */
  viewerName?: string;
  onCancel: () => void;
  onSubmit: (input: CreateWorkspaceDialogInput) => void;
};

export function CreateWorkspaceDialog({
  busy,
  error,
  orgName,
  orgId = '',
  admin = false,
  saveComputeCredential,
  client,
  listMachineTypes,
  listVolumes,
  cloneFromWorkspaceId = null,
  cloneFromWorkspaceName = null,
  viewerName = 'You',
  onCancel,
  onSubmit,
}: CreateWorkspaceDialogProps) {
  const returningFromConnect = hasConnectReturn();
  const [restoredDraft] = useState(readWorkspaceConnectDraft);
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [machineFailures, setMachineFailures] = useState<MachineTypeProviderFailure[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<MachineTypeProviderStatus[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [orgMembers, setOrgMembers] = useState<MemberView[]>([]);
  const [selectedMachineType, setSelectedMachineType] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentRuleId, setAgentRuleId] = useState<string | null>(
    restoredDraft?.agentRuleId ?? null,
  );
  const [repos, setRepos] = useState<string[]>(restoredDraft?.repos ?? []);
  const [members, setMembers] = useState<DraftWorkspaceMember[]>([]);
  const [credentials, setCredentials] = useState<DraftCredential[]>([]);
  const submitted = useRef(false);
  const selectedMachine = machines.find(({ id }) => id === selectedMachineType);
  const supportsVolumes = selectedMachine?.supportsVolumes ?? false;
  const credentialRequiredProviders = providerStatuses.flatMap(({ providerId, access }) =>
    access === 'credential-required' && isComputeCredentialProvider(providerId)
      ? [providerId]
      : []);

  const installMachineTypes = useCallback((result: ListMachineTypesResponse) => {
    setMachines(result.machineTypes);
    setMachineFailures(result.failures);
    setProviderStatuses(result.providerStatuses ?? []);
    setSelectedMachineType((current) =>
      result.machineTypes.some(({ id }) => id === current)
        ? current
        : result.machineTypes[0]?.id ?? '');
  }, []);

  useEffect(() => {
    if (!busy) submitted.current = false;
  }, [busy]);

  useEffect(() => {
    if (returningFromConnect) clearWorkspaceConnectDraft();
  }, [returningFromConnect]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
    setMachineFailures([]);
    void Promise.allSettled([
      listMachineTypes(),
      listVolumes(),
      client.listMembers(),
    ]).then(([machineResult, volumeResult, memberResult]) => {
      if (!mounted) return;
      setOrgMembers(memberResult.status === 'fulfilled' ? memberResult.value.members : []);
      if (machineResult.status === 'rejected') {
        setLoadError(machineResult.reason instanceof Error
          ? machineResult.reason.message
          : 'Machine types could not be loaded.');
        setLoading(false);
        return;
      }
      installMachineTypes(machineResult.value);
      setVolumes(volumeResult.status === 'fulfilled' ? volumeResult.value : []);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [client, installMachineTypes, listMachineTypes, listVolumes]);

  const machineFailureItems = machineFailures.map((failure) => (
    <li key={failure.providerId}>{failure.providerId}: {failure.error}</li>
  ));
  const storeDraft = () => {
    storeWorkspaceConnectDraft({ templateId: null, agentRuleId, repos });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitted.current) return;
    if (selectedMachineType === '') return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const sshPublicKey = String(data.get('sshPublicKey') ?? '').trim();
    const volumeId = String(data.get('volumeId') ?? '');
    const orgShareRole = String(data.get('orgShareRole') ?? '');
    submitted.current = true;
    const input: CreateWorkspaceDialogInput = {
      machineTypeId: selectedMachineType,
    };
    if (name) input.name = name;
    if (sshPublicKey) input.sshPublicKey = sshPublicKey;
    if (volumeId) input.volumeId = volumeId;
    if (orgShareRole === 'editor' || orgShareRole === 'viewer') input.orgShareRole = orgShareRole;
    if (repos.length > 0) input.repos = repos;
    if (agentRuleId !== null) input.agentRuleId = agentRuleId;
    if (cloneFromWorkspaceId !== null) input.cloneFromWorkspaceId = cloneFromWorkspaceId;
    if (members.length > 0) {
      input.members = members.map((member) => (
        member.machineTypeId === WORKSPACE_DEFAULT_MACHINE_TYPE
          ? { membershipId: member.membershipId, role: member.role }
          : {
            membershipId: member.membershipId,
            role: member.role,
            machineTypeId: member.machineTypeId,
          }
      ));
    }
    const namedCredentials = credentials.filter(
      (credential) => credential.name.trim() !== '' && credential.value !== '',
    );
    if (namedCredentials.length > 0) {
      input.credentials = namedCredentials.map((credential) => (
        credential.label.trim() === ''
          ? { name: credential.name.trim(), value: credential.value }
          : {
            name: credential.name.trim(),
            label: credential.label.trim(),
            value: credential.value,
          }
      ));
    }
    onSubmit(input);
  };

  const updateCredential = (index: number, patch: Partial<DraftCredential>) => {
    setCredentials((current) => current.map((credential, at) =>
      at === index ? { ...credential, ...patch } : credential));
  };

  return (
    <div className="create-workspace-screen" role="presentation">
      <form
        className="create-workspace-dialog"
        aria-label="Create workspace"
        onSubmit={submit}
      >
        <header className="create-workspace-header">
          <div className="create-workspace-header__title">
            <h1>{cloneFromWorkspaceName === null
              ? 'Create workspace'
              : `New workspace from “${cloneFromWorkspaceName}”`}</h1>
          </div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        <div className="create-workspace-main">
          {(error ?? loadError) !== null && (
            <div className="create-workspace-notices">
              <p className="webapp-form-message" role="alert">{error ?? loadError}</p>
            </div>
          )}
          {!admin && (
            // Told up front rather than after the server's 403: creating a
            // workspace is an org-admin power for now (§3).
            <div className="create-workspace-notices">
              <p className="webapp-form-message" role="status">
                Only an admin at {orgName} can create a workspace.
              </p>
            </div>
          )}

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Name</h2>
              <p>Optional. Leave blank to get a random name.</p>
            </div>
            <label className="blueprint-field">
              Workspace name
              <input
                name="name"
                aria-label="Workspace name (optional)"
                maxLength={64}
                placeholder="e.g. brave-otter"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Default machine type</h2>
              <p>
                What a member's machine is unless their row names another one.
                A machine type is never a restriction on this workspace.
              </p>
            </div>
            {loading ? (
              <OutlinedLoadingRows count={4} ariaLabel="Loading machine types" />
            ) : (
              <>
                <InlineComputeCredentialSetup
                  providers={credentialRequiredProviders}
                  orgId={orgId}
                  admin={admin}
                  saveCredential={saveComputeCredential}
                  onSaved={async () => {
                    installMachineTypes(await listMachineTypes());
                  }}
                />
                {machines.length > 0 && machineFailures.length > 0 && (
                  /* One provider can fail while the others answer. Canary hid a
                   * dead Hetzner token for an hour: only an empty catalog
                   * showed the provider error. */
                  <div className="webapp-form-message" role="alert">
                    Some machine types are missing. These providers are unavailable:
                    <ul>{machineFailureItems}</ul>
                  </div>
                )}
                {machines.length > 0 ? (
                  <MachineCatalogGrid
                    machines={machines}
                    selectedMachineType={selectedMachineType}
                    onSelect={setSelectedMachineType}
                  />
                ) : credentialRequiredProviders.length === 0 && machineFailures.length > 0 ? (
                  <div className="blueprint-selection__empty" role="alert">
                    <p>No machine types are available.</p>
                    <ul>{machineFailureItems}</ul>
                  </div>
                ) : credentialRequiredProviders.length === 0 ? (
                  <div className="blueprint-selection__empty">No machine types are available.</div>
                ) : null}
              </>
            )}
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Members</h2>
              <p>
                Existing members of {orgName}. Each one gets their own machine
                the moment the workspace exists; a viewer gets none.
              </p>
            </div>
            <WorkspaceMembersEditor
              mode={{ kind: 'draft', members, onChange: setMembers }}
              orgMembers={orgMembers}
              machines={machines}
              defaultMachineTypeId={selectedMachineType}
              viewerName={viewerName}
            />
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Credentials</h2>
              <p>
                Names and values every member machine reads with{' '}
                <code>blitz-cred</code>. This is the only time a value is sent;
                it never comes back out.
              </p>
            </div>
            {credentials.map((credential, index) => (
              // The index is the identity here: two blank rows are two rows,
              // and a name is editable, so neither can key the list.
              // eslint-disable-next-line react/no-array-index-key
              <div className="create-credential-row" key={index}>
                <input
                  aria-label={`Credential ${String(index + 1)} name`}
                  placeholder="STRIPE_API_KEY"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={credential.name}
                  onChange={(event) => updateCredential(index, { name: event.currentTarget.value })}
                />
                <input
                  aria-label={`Credential ${String(index + 1)} label`}
                  placeholder="Label (optional)"
                  value={credential.label}
                  onChange={(event) => updateCredential(index, { label: event.currentTarget.value })}
                />
                <input
                  aria-label={`Credential ${String(index + 1)} value`}
                  type="password"
                  autoComplete="off"
                  placeholder="Value"
                  value={credential.value}
                  onChange={(event) => updateCredential(index, { value: event.currentTarget.value })}
                />
                <button
                  type="button"
                  aria-label={`Remove credential ${String(index + 1)}`}
                  onClick={() => setCredentials((current) =>
                    current.filter((_credential, at) => at !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="webapp-action"
              type="button"
              onClick={() => setCredentials((current) =>
                [...current, { name: '', label: '', value: '' }])}
            >
              Add credential
            </button>
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Volume</h2>
              <p>Optionally attach an available volume.</p>
            </div>
            <label className="blueprint-field">
              Volume
              <select name="volumeId" defaultValue="" disabled={!supportsVolumes}>
                <option value="">No volume</option>
                {volumes.map((volume) => (
                  <option key={volume.id} value={volume.id} disabled={volume.status !== 'available'}>
                    {volume.name} · {volume.sizeGb} GB · {volume.location} · {volume.status}
                  </option>
                ))}
              </select>
              {!supportsVolumes && selectedMachine !== undefined && (
                <span>Volumes are not supported by this machine provider.</span>
              )}
            </label>
          </section>

          {/* A clone already carries its source's repository list, and the two
            * sources never mix — a body naming both is refused with a 400. */}
          {cloneFromWorkspaceId === null && <section className="blueprint-selection tplf-repos">
            <div className="blueprint-selection__heading">
              <h2>Repositories</h2>
              <p>GitHub repositories cloned into /workspace when this workspace starts.</p>
            </div>
            <TemplateRepoPicker
              client={client}
              connectHref={client.connectStartUrl('github', undefined, 'workspace-new')}
              onConnect={storeDraft}
              value={repos}
              onChange={setRepos}
            />
          </section>}

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Sharing</h2>
              <p>Who at {orgName} can open this workspace. You can change it later.</p>
            </div>
            <label className="blueprint-field">
              Access
              <select name="orgShareRole" defaultValue="" aria-label="Workspace sharing">
                <option value="">Only the members above</option>
                <option value="editor">Everyone at {orgName} can edit</option>
                <option value="viewer">Everyone at {orgName} can view</option>
              </select>
            </label>
          </section>

          <section className="blueprint-selection blueprint-setup-script">
            <div className="blueprint-selection__heading">
              <h2>SSH public key (optional)</h2>
              <p>Optional. Without a key the workspace is webapp-only. Recreate the workspace to add one later.</p>
            </div>
            <textarea
              name="sshPublicKey"
              aria-label="SSH public key (optional)"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </section>

          <details className="blueprint-advanced">
            <summary>Advanced</summary>
            <div className="blueprint-advanced__content">
              <AgentRulesPicker
                client={client}
                value={agentRuleId}
                onChange={setAgentRuleId}
              />
            </div>
          </details>
        </div>

        <footer className="create-workspace-actions">
          <button className="blueprint-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="create-workspace-primary"
            type="submit"
            disabled={busy || loading || selectedMachineType === ''}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </footer>
      </form>
    </div>
  );
}
