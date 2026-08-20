import type {
  AgentRuleView,
  ListAgentRulesResponse,
  PutAgentRuleRequest,
  PutAgentRuleResponse,
} from '@blitzos/schema';
import { useEffect, useId, useState } from 'react';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ModalOverlay } from './ModalOverlay';

/** The slice of the control-plane client this picker needs. `ControlPlaneClient`
 * satisfies it structurally, so both create screens pass their own client. */
export interface AgentRulesApi {
  listAgentRules(): Promise<ListAgentRulesResponse>;
  putAgentRule(id: string, input: PutAgentRuleRequest): Promise<PutAgentRuleResponse>;
  deleteAgentRule(id: string): Promise<void>;
}

const NEW_RULE_OPTION = '__new__';

interface Draft {
  /** null while editing the built-in doc or drafting a new rule: saving mints
   * an id, which is what makes editing the default copy-on-write. */
  id: string | null;
  name: string;
  content: string;
}

/** Picks the agent-rules document a workspace or template hands its agents.
 * The list the server returns leads with the built-in doc (`id: null`), so
 * "edit the default" is just an edit whose save has no id yet. */
export function AgentRulesPicker({
  client,
  value,
  onChange,
}: {
  client: AgentRulesApi;
  value: string | null;
  onChange: (agentRuleId: string | null) => void;
}) {
  const [rules, setRules] = useState<AgentRuleView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const nameId = useId();
  const contentId = useId();

  useEffect(() => {
    let mounted = true;
    void client.listAgentRules()
      .then(({ rules: loaded }) => {
        if (mounted) setRules(loaded);
      })
      .catch(() => {
        if (mounted) setRules([]);
      });
    return () => { mounted = false; };
  }, [client]);

  const builtIn = rules.find(({ builtIn: flag }) => flag) ?? null;
  const selected = value === null ? null : rules.find(({ id }) => id === value) ?? null;

  const openDraft = (rule: AgentRuleView | null) => {
    setError(null);
    setConfirmingDelete(false);
    // A new rule and a copy of the default both start from the built-in text:
    // the doc is the thing being adjusted, not replaced from scratch.
    setDraft({
      id: rule?.id ?? null,
      name: rule === null || rule.builtIn ? '' : rule.name,
      content: rule?.content ?? builtIn?.content ?? '',
    });
  };

  const save = async () => {
    if (draft === null || busy) return;
    const name = draft.name.trim();
    if (name === '' || draft.content.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const id = draft.id ?? crypto.randomUUID();
      // The PUT returns the canonical row, so the list is updated from it
      // rather than re-fetched: one round trip, and no window where the save
      // succeeded but the select cannot name what it just selected.
      const { rule } = await client.putAgentRule(id, { name, content: draft.content });
      setRules((current) => current.some((entry) => entry.id === rule.id)
        ? current.map((entry) => entry.id === rule.id ? rule : entry)
        : [...current, rule]);
      onChange(rule.id);
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The rule could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (draft === null || draft.id === null || busy) return;
    setBusy(true);
    setError(null);
    // The confirmation has done its job; a failure is reported in the editor
    // behind it, not under a dialog still asking the same question.
    setConfirmingDelete(false);
    try {
      const removed = draft.id;
      await client.deleteAgentRule(removed);
      setRules((current) => current.filter((entry) => entry.id !== removed));
      if (value === removed) onChange(null);
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The rule could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="blueprint-agent-rules">
      <div className="blueprint-selection__heading">
        <h2>Agent rules</h2>
        <p>
          The always-loaded instructions your agents read in this workspace.
          Leave it on the default unless your team needs its own.
        </p>
      </div>
      <div className="blueprint-agent-rules-row">
        <label className="blueprint-field" htmlFor={selectId}>
          Rules document
        </label>
        <select
          id={selectId}
          aria-label="Agent rules document"
          value={value ?? ''}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next === NEW_RULE_OPTION) {
              openDraft(null);
              return;
            }
            onChange(next === '' ? null : next);
          }}
        >
          <option value="">{builtIn?.name ?? 'Default (built-in)'}</option>
          {rules.filter(({ builtIn: flag }) => !flag).map((rule) => (
            <option key={rule.id ?? rule.name} value={rule.id ?? ''}>{rule.name}</option>
          ))}
          <option value={NEW_RULE_OPTION}>New rule…</option>
        </select>
        <button
          className="blueprint-agent-rules-edit"
          type="button"
          onClick={() => openDraft(selected ?? builtIn)}
        >
          Edit
        </button>
      </div>

      {draft !== null && (
        <ModalOverlay dismissible={!busy} onDismiss={() => setDraft(null)}>
          <section
            className="blueprint-agent-rules-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={draft.id === null ? 'New agent rules' : 'Edit agent rules'}
            // The picker lives inside the create form; a stray Enter in the name
            // field would submit that form instead of saving the rule.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault();
                void save();
              }
            }}
          >
            <header className="blueprint-agent-rules-header">
              <h3>{draft.id === null ? 'New rules document' : 'Edit rules document'}</h3>
              <button
                type="button"
                aria-label="Close rules editor"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                ×
              </button>
            </header>
            <div className="blueprint-agent-rules-body">
              {error !== null && (
                <p className="webapp-form-message" role="alert">{error}</p>
              )}
              {draft.id === null && (
                <p className="blueprint-agent-rules-note">
                  Saving creates a rules document for your org and selects it
                  here. The built-in default is never changed in place.
                </p>
              )}
              <label className="blueprint-field" htmlFor={nameId}>
                Name
              </label>
              <input
                id={nameId}
                aria-label="Agent rules name"
                maxLength={120}
                placeholder="e.g. House rules"
                value={draft.name}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  setDraft((current) => current === null ? current : { ...current, name });
                }}
              />
              <label className="blueprint-field" htmlFor={contentId}>
                Rules
              </label>
              <textarea
                id={contentId}
                className="blueprint-agent-rules-content"
                aria-label="Agent rules content"
                maxLength={256 * 1024}
                placeholder="# Rules for agents in this workspace"
                value={draft.content}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => {
                  const content = event.currentTarget.value;
                  setDraft((current) => current === null ? current : { ...current, content });
                }}
              />
            </div>
            <footer className="blueprint-agent-rules-actions">
              {draft.id !== null && (
                <button
                  className="blueprint-agent-rules-delete"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </button>
              )}
              <button
                className="blueprint-cancel"
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                className="create-workspace-primary"
                type="button"
                disabled={busy || draft.name.trim() === '' || draft.content.trim() === ''}
                onClick={() => { void save(); }}
              >
                {busy ? 'Saving…' : 'Save rules'}
              </button>
            </footer>
          </section>
        </ModalOverlay>
      )}

      {/* Rendered after the editor overlay so it paints on top of it. */}
      {confirmingDelete && draft !== null && draft.id !== null && (
        <ConfirmationDialog
          title="Delete rules document?"
          description={`Delete “${draft.name}”? Templates and workspaces that use it fall back to Default (built-in). This cannot be undone.`}
          confirmLabel="Yes, delete"
          cancelLabel="No"
          onConfirm={() => { void remove(); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
