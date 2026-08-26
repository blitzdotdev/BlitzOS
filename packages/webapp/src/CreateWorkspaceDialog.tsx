import type {
  CreateWorkspaceRequest,
  ListMachineTypesResponse,
  MachineType,
  MachineTypeProviderFailure,
  MachineTypeProviderStatus,
  Volume,
  WorkspaceTemplateView,
} from '@blitzos/schema';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AgentRulesPicker, type AgentRulesApi } from './AgentRulesPicker';
import type { ComputeCredentialsClient } from './compute-credentials-api';
import { isComputeCredentialProvider } from './ComputeCredentialFields';
import { InlineComputeCredentialSetup } from './InlineComputeCredentialSetup';
import { OutlinedLoadingRows } from './LoadingSkeleton';
import { MachineCatalogGrid, machineTypeLabel } from './MachineCatalogGrid';
import {
  EMPTY_WORKSPACE_ENVIRONMENT,
  EnvironmentEditor,
  populatedEnvironment,
} from './EnvironmentEditor';

export type CreateWorkspaceDialogInput = CreateWorkspaceRequest;

type CreateWorkspaceDialogProps = {
  busy: boolean;
  error: string | null;
  orgName: string;
  orgId?: string;
  admin?: boolean;
  saveComputeCredential?: ComputeCredentialsClient['putComputeCredential'];
  client: AgentRulesApi;
  listMachineTypes: () => Promise<ListMachineTypesResponse>;
  listVolumes: () => Promise<Volume[]>;
  listTemplates: () => Promise<WorkspaceTemplateView[]>;
  /** Template to preselect — the org default. Seeded once (environment and
   * agent rule included) when both the id and the loaded list carry it; the
   * member can still deselect. */
  initialTemplateId?: string | null;
  onNewTemplate: () => void;
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
  listTemplates,
  initialTemplateId,
  onNewTemplate,
  onCancel,
  onSubmit,
}: CreateWorkspaceDialogProps) {
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [machineFailures, setMachineFailures] = useState<MachineTypeProviderFailure[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<MachineTypeProviderStatus[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [templates, setTemplates] = useState<WorkspaceTemplateView[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    initialTemplateId ?? null,
  );
  const [selectedMachineType, setSelectedMachineType] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState(EMPTY_WORKSPACE_ENVIRONMENT);
  const [agentRuleId, setAgentRuleId] = useState<string | null>(null);
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

  // Seeding needs the template row, not just its id: selecting a template
  // also loads its environment and agent rule, exactly like a click on the
  // tile. Runs at most once — the prop may arrive after the list (or the
  // list after the prop), and a member who deselected must stay deselected.
  const seededTemplate = useRef(false);
  useEffect(() => {
    if (seededTemplate.current || initialTemplateId === null || initialTemplateId === undefined) {
      return;
    }
    const template = templates.find(({ id }) => id === initialTemplateId);
    if (template === undefined) return;
    seededTemplate.current = true;
    setSelectedTemplateId(template.id);
    setEnvironment(template.environment ?? EMPTY_WORKSPACE_ENVIRONMENT);
    setAgentRuleId(template.agentRuleId);
  }, [templates, initialTemplateId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
    setMachineFailures([]);
    void Promise.allSettled([
      listMachineTypes(),
      listVolumes(),
      listTemplates(),
    ]).then(([machineResult, volumeResult, templateResult]) => {
      if (!mounted) return;
      setTemplates(templateResult.status === 'fulfilled' ? templateResult.value : []);
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
  }, [installMachineTypes, listMachineTypes, listVolumes, listTemplates]);

  const selectedTemplate = templates.find(({ id }) => id === selectedTemplateId) ?? null;
  const machineFailureItems = machineFailures.map((failure) => (
    <li key={failure.providerId}>{failure.providerId}: {failure.error}</li>
  ));
  // The blank tile and the toggle-off share this, so the two paths cannot drift.
  const clearTemplate = () => {
    setSelectedTemplateId(null);
    setEnvironment(EMPTY_WORKSPACE_ENVIRONMENT);
    setAgentRuleId(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitted.current) return;
    if (selectedTemplate !== null) {
      // Creation never blocks on connections: the server enables every
      // stipulated provider on the ceiling, mints what the creator's grants
      // already back, and the workspace connections panel collects the rest.
      submitted.current = true;
      const input: CreateWorkspaceDialogInput = {
        templateId: selectedTemplate.id,
        orgShareRole: 'editor',
      };
      const configured = populatedEnvironment(environment);
      if (configured !== undefined) input.environment = configured;
      else if (selectedTemplate.environment !== null) input.environment = environment;
      // Sent whenever it differs from what the template already carries, so an
      // explicit "back to Default" is not read as "leave the template's rule".
      if (agentRuleId !== selectedTemplate.agentRuleId) input.agentRuleId = agentRuleId;
      onSubmit(input);
      return;
    }
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
    const configured = populatedEnvironment(environment);
    if (configured !== undefined) input.environment = configured;
    if (agentRuleId !== null) input.agentRuleId = agentRuleId;
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
          <div className="create-workspace-header__title"><h1>Create workspace</h1></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        <div className="create-workspace-main">
          {(error || loadError) && (
            <div className="create-workspace-notices">
              <p className="webapp-form-message" role="alert">{error ?? loadError}</p>
            </div>
          )}

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Templates</h2>
              <p>Start from a shared setup. Its machine type and Drive folders come attached.</p>
            </div>
            <div className="template-grid">
              {/* The dialog opens on the org default. Before this tile the only
                * way to a blank workspace was a second click on that default.
                * Nobody could see that, so the choice gets a tile of its own. */}
              <button
                className={`template-tile${selectedTemplateId === null ? ' template-tile--selected' : ''}`}
                type="button"
                aria-pressed={selectedTemplateId === null}
                onClick={clearTemplate}
              >
                <strong>No template</strong>
              </button>
              {templates.map((template) => {
                const missing = template.folders.filter(({ role }) => role === null).length;
                const active = template.id === selectedTemplateId;
                return (
                  <button
                    className={`template-tile${active ? ' template-tile--selected' : ''}`}
                    type="button"
                    key={template.id}
                    aria-pressed={active}
                    onClick={() => {
                      if (active) {
                        clearTemplate();
                        return;
                      }
                      setSelectedTemplateId(template.id);
                      setEnvironment(template.environment ?? EMPTY_WORKSPACE_ENVIRONMENT);
                      setAgentRuleId(template.agentRuleId);
                    }}
                  >
                    <strong>{template.name}</strong>
                    <span>{machineTypeLabel(template.machineTypeId)}</span>
                    <span>
                      {template.folders.length === 1 ? '1 folder' : `${template.folders.length} folders`}
                      {' · by '}{template.createdBy.name}
                    </span>
                    {missing > 0 && (
                      <span className="template-tile__warn">
                        {missing === 1 ? '1 folder' : `${missing} folders`} you cannot access yet
                      </span>
                    )}
                  </button>
                );
              })}
              <button className="template-tile template-tile--new" type="button" onClick={onNewTemplate}>
                <strong>+ New template</strong>
                <span>Name it, pick folders, share it with {orgName}</span>
              </button>
            </div>
          </section>

          {selectedTemplate !== null && (
            <section className="blueprint-selection">
              <div className="blueprint-selection__heading">
                <h2>{selectedTemplate.name}</h2>
                <p>
                  {machineTypeLabel(selectedTemplate.machineTypeId)}
                  {' · shared with everyone at '}{orgName}
                  {' · the workspace is named after the template'}
                </p>
              </div>
              {selectedTemplate.folders.length > 0 && (
                <ul className="template-folder-list">
                  {selectedTemplate.folders.map((folder) => (
                    <li key={folder.id}>
                      {folder.name}
                      {folder.role === null ? ' — no access yet, will not sync' : ''}
                    </li>
                  ))}
                </ul>
              )}
              {selectedTemplate.connections.length > 0 && (
                <ul className="template-connection-list">
                  {/* Names only: connecting happens inside the workspace,
                    * from its connections panel, after create. */}
                  {selectedTemplate.connections.map((connection) => (
                    <li key={connection.provider}>
                      {connection.provider}
                      {' · connect from the workspace connections panel'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {selectedTemplate === null && <section className="blueprint-selection">
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
          </section>}

          {selectedTemplate === null && <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Machine type</h2>
              <p>Select the compute location and size for this workspace.</p>
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
          </section>}

          {selectedTemplate === null && <section className="blueprint-selection">
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
          </section>}

          {selectedTemplate === null && <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Sharing</h2>
              <p>Who at {orgName} can open this workspace. You can change it later.</p>
            </div>
            <label className="blueprint-field">
              Access
              <select name="orgShareRole" defaultValue="editor" aria-label="Workspace sharing">
                <option value="editor">Everyone at {orgName} can edit</option>
                <option value="viewer">Everyone at {orgName} can view</option>
                <option value="">Only me and people I invite</option>
              </select>
            </label>
          </section>}

          {selectedTemplate === null && <section className="blueprint-selection blueprint-setup-script">
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
          </section>}

          <details className="blueprint-advanced">
            <summary>Advanced</summary>
            <div className="blueprint-advanced__content">
              <EnvironmentEditor
                key={selectedTemplateId ?? 'workspace'}
                initial={selectedTemplate?.environment ?? EMPTY_WORKSPACE_ENVIRONMENT}
                onChange={setEnvironment}
              />
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
            disabled={busy
              || (selectedTemplate === null && (loading || selectedMachineType === ''))}
          >
            {busy ? 'Creating…' : selectedTemplate === null ? 'Create workspace' : `Create from ${selectedTemplate.name}`}
          </button>
        </footer>
      </form>
    </div>
  );
}
