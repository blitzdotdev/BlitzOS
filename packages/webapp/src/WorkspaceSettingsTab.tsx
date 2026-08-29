import { useState } from 'react';
import type {
  MachineType,
  TemplateRepoView,
  UpdateWorkspaceRequest,
} from '@blitzos/schema';
import { AgentRulesPicker, type AgentRulesApi } from './AgentRulesPicker';
import { machineTypeLabel } from './MachineCatalogGrid';
import { machineTypeOptions } from './MachineTypeSelect';
import { WebAppSelectMenu } from './WebAppSelectMenu';
import type { CloudWorkspaceModel } from './workspace-store';

function dateLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** The four settings fields as one draft. Held locally so a poll landing
 * mid-edit does not overwrite what somebody is typing; Save sends only what
 * actually changed, which is what makes an absent field mean "leave it". */
type SettingsDraft = {
  name: string;
  defaultMachineTypeId: string;
  autoProvision: boolean;
  agentRuleId: string | null;
};

function draftFor(workspace: CloudWorkspaceModel): SettingsDraft {
  return {
    name: workspace.serverName,
    defaultMachineTypeId: workspace.defaultMachineTypeId,
    autoProvision: workspace.autoProvision,
    agentRuleId: workspace.agentRuleId,
  };
}

/** The changed fields, or null when nothing moved. A settings write with an
 * empty body is a round trip that says nothing, so the button stays disabled
 * until there is something to say. */
export function settingsChanges(
  workspace: CloudWorkspaceModel,
  draft: SettingsDraft,
): UpdateWorkspaceRequest | null {
  const changes: UpdateWorkspaceRequest = {};
  const name = draft.name.trim();
  if (name !== '' && name !== workspace.serverName) changes.name = name;
  if (draft.defaultMachineTypeId !== workspace.defaultMachineTypeId) {
    changes.defaultMachineTypeId = draft.defaultMachineTypeId;
  }
  if (draft.autoProvision !== workspace.autoProvision) {
    changes.autoProvision = draft.autoProvision;
  }
  if (draft.agentRuleId !== workspace.agentRuleId) changes.agentRuleId = draft.agentRuleId;
  return Object.keys(changes).length === 0 ? null : changes;
}

/** The workspace's clone list. Add and remove write one row each; the box
 * clones at boot, so the note names when a change actually lands. */
function ReposEditor({
  repos,
  canManage,
  onAdd,
  onRemove,
}: {
  repos: TemplateRepoView[];
  canManage: boolean;
  onAdd: (repo: string) => void;
  onRemove: (repo: string) => void;
}) {
  const [repo, setRepo] = useState('');
  const submit = () => {
    if (repo.trim() === '') return;
    onAdd(repo.trim());
    setRepo('');
  };
  return (
    <div className="workspace-repos">
      <h2>Repositories</h2>
      <p className="workspace-details-note">
        Cloned into <code>/workspace</code> when a machine boots. A change here
        reaches a machine the next time it is provisioned or recreated.
      </p>
      <div className="workspace-repo-rows">
        {repos.length === 0 && (
          <p className="workspace-members-empty">No repositories yet.</p>
        )}
        {repos.map((entry) => (
          <div className="workspace-repo-row" key={entry.repo}>
            <span className="workspace-repo-name">
              <strong>{entry.repo}</strong>
              {entry.private && <small>private</small>}
            </span>
            {canManage && (
              <button
                className="webapp-action"
                type="button"
                aria-label={`Remove ${entry.repo}`}
                onClick={() => onRemove(entry.repo)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="workspace-repo-add">
          <label className="blueprint-field">
            Add a repository
            <input
              aria-label="Repository"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="owner/name"
              value={repo}
              onChange={(event) => setRepo(event.currentTarget.value)}
            />
          </label>
          <button
            className="webapp-action"
            type="button"
            disabled={repo.trim() === ''}
            onClick={submit}
          >
            Add repository
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Settings tab of plan §6: name, default machine type, auto-provision,
 * agent rules and repos. Clone and delete are workspace-wide verbs, so they
 * sit in the dialog footer rather than at the bottom of this tab.
 *
 * Every field here is workspace-admin work (§3), so a member reads the values
 * and an admin edits them. The default machine type applies to machines
 * provisioned after the write — an existing machine carries its own type, and
 * moving one is `SetMachineType` on the Members tab.
 */
export function WorkspaceSettingsTab({
  client,
  workspace,
  machines,
  repos,
  canManage,
  onSave,
  onAddRepo,
  onRemoveRepo,
}: {
  client: AgentRulesApi;
  workspace: CloudWorkspaceModel;
  machines: MachineType[];
  repos: TemplateRepoView[];
  canManage: boolean;
  onSave: (input: UpdateWorkspaceRequest) => void;
  onAddRepo: (repo: string) => void;
  onRemoveRepo: (repo: string) => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFor(workspace));
  const changes = settingsChanges(workspace, draft);
  const defaultMachine = machines.find(({ id }) => id === draft.defaultMachineTypeId);
  return (
    <section
      id="workspace-details-settings-panel"
      role="tabpanel"
      aria-label="Settings"
      className="workspace-details-settings"
    >
      <h2>Workspace</h2>
      {canManage ? (
        <div className="workspace-settings-form">
          <label className="blueprint-field">
            Name
            <input
              aria-label="Workspace name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={draft.name}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setDraft((current) => ({ ...current, name }));
              }}
            />
          </label>
          <div className="blueprint-field">
            Default machine type
            <WebAppSelectMenu
              ariaLabel="Default machine type"
              className="machine-type-select"
              value={draft.defaultMachineTypeId}
              options={machineTypeOptions(machines)}
              onChange={(defaultMachineTypeId) =>
                setDraft((current) => ({ ...current, defaultMachineTypeId }))}
            />
            <small>Applies to new machines; each member's type is their own.</small>
          </div>
          <label className="blueprint-field workspace-settings-toggle">
            <input
              type="checkbox"
              aria-label="Provision a machine when a member is added"
              checked={draft.autoProvision}
              onChange={(event) => {
                const autoProvision = event.currentTarget.checked;
                setDraft((current) => ({ ...current, autoProvision }));
              }}
            />
            Provision a machine when a member is added
          </label>
          <AgentRulesPicker
            client={client}
            value={draft.agentRuleId}
            onChange={(agentRuleId) => setDraft((current) => ({ ...current, agentRuleId }))}
          />
          <button
            className="webapp-action webapp-action--primary"
            type="button"
            disabled={changes === null}
            onClick={() => { if (changes !== null) onSave(changes); }}
          >
            Save settings
          </button>
        </div>
      ) : (
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
        </dl>
      )}
      <dl className="workspace-details-list">
        <div><dt>Your role</dt><dd>{workspace.myRole ?? 'Organization admin'}</dd></div>
        <div><dt>Connections</dt><dd>{workspace.connections.length}</dd></div>
        <div><dt>Created</dt><dd>{dateLabel(workspace.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(workspace.updatedAt)}</dd></div>
      </dl>
      <ReposEditor
        repos={repos}
        canManage={canManage}
        onAdd={onAddRepo}
        onRemove={onRemoveRepo}
      />
    </section>
  );
}
