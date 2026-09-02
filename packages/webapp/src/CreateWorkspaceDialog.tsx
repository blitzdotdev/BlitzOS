import type {
  CreateWorkspaceRequest,
  ListMachineTypesResponse,
  MachineType,
  MachineTypeProviderFailure,
  MachineTypeProviderStatus,
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

// There is no credentials section here, and none is coming back: secrets are
// stored at organization level from Settings → Credentials, and a workspace
// reads the ones granted to it (plans/ORG-CREDENTIALS.md §9).

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
  const [orgMembers, setOrgMembers] = useState<MemberView[]>([]);
  const [selectedMachineType, setSelectedMachineType] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentRuleId, setAgentRuleId] = useState<string | null>(
    restoredDraft?.agentRuleId ?? null,
  );
  const [repos, setRepos] = useState<string[]>(restoredDraft?.repos ?? []);
  const [members, setMembers] = useState<DraftWorkspaceMember[]>([]);
  const submitted = useRef(false);
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
      client.listMembers(),
    ]).then(([machineResult, memberResult]) => {
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
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [client, installMachineTypes, listMachineTypes]);

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
    submitted.current = true;
    const input: CreateWorkspaceDialogInput = {
      machineTypeId: selectedMachineType,
    };
    if (name) input.name = name;
    if (repos.length > 0) input.repos = repos;
    if (agentRuleId !== null) input.agentRuleId = agentRuleId;
    if (cloneFromWorkspaceId !== null) input.cloneFromWorkspaceId = cloneFromWorkspaceId;
    if (members.length > 0) {
      input.members = members.map((member) => {
        const row: NonNullable<CreateWorkspaceDialogInput['members']>[number] = {
          membershipId: member.membershipId,
          role: member.role,
        };
        if (member.machineTypeId !== WORKSPACE_DEFAULT_MACHINE_TYPE) {
          row.machineTypeId = member.machineTypeId;
        }
        // True is the server's default, so only the refusal travels.
        if (!member.persistentVolume) row.persistentVolume = false;
        return row;
      });
    }
    onSubmit(input);
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
            <div className="cfg-section-head">
              <h2 className="cfg-title">Name</h2>
              <p className="cfg-desc">Optional. Leave blank to get a random name.</p>
            </div>
            <label className="cfg-field">
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
            <div className="cfg-section-head">
              <h2 className="cfg-title">Default machine type</h2>
              <p className="cfg-desc">
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
            <div className="cfg-section-head">
              <h2 className="cfg-title">Members</h2>
              <p className="cfg-desc">
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

          {/* A clone already carries its source's repository list, and the two
            * sources never mix — a body naming both is refused with a 400. */}
          {cloneFromWorkspaceId === null && <section className="blueprint-selection tplf-repos">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Repositories</h2>
              <p className="cfg-desc">GitHub repositories cloned into /workspace when this workspace starts.</p>
            </div>
            <TemplateRepoPicker
              client={client}
              connectHref={client.connectStartUrl('github', undefined, 'workspace-new')}
              onConnect={storeDraft}
              value={repos}
              onChange={setRepos}
            />
          </section>}

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
