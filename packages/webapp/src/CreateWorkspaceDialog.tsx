import type { CreateWorkspaceRequest, MachineType, Volume, WorkspaceTemplateView } from '@blitzos/schema';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AgentRulesPicker, type AgentRulesApi } from './AgentRulesPicker';
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
  client: AgentRulesApi;
  listMachineTypes: () => Promise<MachineType[]>;
  listVolumes: () => Promise<Volume[]>;
  listTemplates: () => Promise<WorkspaceTemplateView[]>;
  onNewTemplate: () => void;
  onCancel: () => void;
  onSubmit: (input: CreateWorkspaceDialogInput) => void;
};

export function CreateWorkspaceDialog({
  busy,
  error,
  orgName,
  client,
  listMachineTypes,
  listVolumes,
  listTemplates,
  onNewTemplate,
  onCancel,
  onSubmit,
}: CreateWorkspaceDialogProps) {
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [templates, setTemplates] = useState<WorkspaceTemplateView[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedMachineType, setSelectedMachineType] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState(EMPTY_WORKSPACE_ENVIRONMENT);
  const [agentRuleId, setAgentRuleId] = useState<string | null>(null);
  const submitted = useRef(false);
  const selectedMachine = machines.find(({ id }) => id === selectedMachineType);
  const supportsVolumes = selectedMachine?.supportsVolumes ?? false;

  useEffect(() => {
    if (!busy) submitted.current = false;
  }, [busy]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
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
      setMachines(machineResult.value);
      setSelectedMachineType((current) => current || machineResult.value[0]?.id || '');
      setVolumes(volumeResult.status === 'fulfilled' ? volumeResult.value : []);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [listMachineTypes, listVolumes, listTemplates]);

  const selectedTemplate = templates.find(({ id }) => id === selectedTemplateId) ?? null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitted.current) return;
    if (selectedTemplate !== null) {
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
                      setSelectedTemplateId(active ? null : template.id);
                      setEnvironment(active
                        ? EMPTY_WORKSPACE_ENVIRONMENT
                        : template.environment ?? EMPTY_WORKSPACE_ENVIRONMENT);
                      setAgentRuleId(active ? null : template.agentRuleId);
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
            ) : machines.length > 0 ? (
              <MachineCatalogGrid
                machines={machines}
                selectedMachineType={selectedMachineType}
                onSelect={setSelectedMachineType}
              />
            ) : (
              <div className="blueprint-selection__empty">No machine types are available.</div>
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
            disabled={busy || (selectedTemplate === null && (loading || selectedMachineType === ''))}
          >
            {busy ? 'Creating…' : selectedTemplate === null ? 'Create workspace' : `Create from ${selectedTemplate.name}`}
          </button>
        </footer>
      </form>
    </div>
  );
}
