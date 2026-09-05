import { asJsonObject, isString, type JsonValue } from './type-guards';

export interface WorkspaceConnectDraft {
  agentRuleId: string | null;
  repos: string[];
}

const WORKSPACE_DRAFT_KEY = 'blitz:github-connect-draft:workspace-new';

export function hasConnectReturn(): boolean {
  return new URLSearchParams(window.location.search).has('connect');
}

function stringList(value: JsonValue | undefined): string[] | null {
  return Array.isArray(value) && value.every(isString) ? value : null;
}

function workspaceDraft(serialized: string): WorkspaceConnectDraft | null {
  let value: JsonValue;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsed = asJsonObject(value);
  const repos = stringList(parsed?.repos);
  if (
    parsed === null
    || !(parsed.agentRuleId === null || isString(parsed.agentRuleId))
    || repos === null
  ) return null;
  return {
    agentRuleId: parsed.agentRuleId,
    repos,
  };
}

export function readWorkspaceConnectDraft(): WorkspaceConnectDraft | null {
  if (!hasConnectReturn()) return null;
  const stored = window.sessionStorage.getItem(WORKSPACE_DRAFT_KEY);
  return stored === null ? null : workspaceDraft(stored);
}

export function storeWorkspaceConnectDraft(draft: WorkspaceConnectDraft): void {
  window.sessionStorage.setItem(WORKSPACE_DRAFT_KEY, JSON.stringify(draft));
}

export function clearWorkspaceConnectDraft(): void {
  window.sessionStorage.removeItem(WORKSPACE_DRAFT_KEY);
}
