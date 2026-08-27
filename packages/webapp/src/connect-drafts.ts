import type {
  TemplateConnectionView,
  WorkspaceEnvironment,
} from '@blitzos/schema';
import { asJsonObject, isBoolean, isString, type JsonValue } from './type-guards';

export type TemplateConnectReturnTo = 'template-new' | `template-edit:${string}`;

export interface TemplateConnectDraft {
  name: string;
  machineTypeId: string;
  attachedIds: string[];
  connections: TemplateConnectionView[];
  shareWithOrg: boolean;
  environment: WorkspaceEnvironment;
  agentRuleId: string | null;
  isOrgDefault: boolean;
  repos: string[];
}

export interface WorkspaceConnectDraft {
  /** null is a real answer, not a missing one: the repo picker only appears
   * with no template selected, so that is the state most likely to be
   * mid-edit when the member leaves for github.com. */
  templateId: string | null;
  environment: WorkspaceEnvironment;
  agentRuleId: string | null;
  repos: string[];
}

const TEMPLATE_DRAFT_PREFIX = 'blitz:github-connect-draft:';
const WORKSPACE_DRAFT_KEY = `${TEMPLATE_DRAFT_PREFIX}workspace-new`;

export function hasConnectReturn(): boolean {
  return new URLSearchParams(window.location.search).has('connect');
}

export function templateConnectReturnTo(
  editTemplateId: string | undefined,
): TemplateConnectReturnTo {
  return editTemplateId === undefined
    ? 'template-new'
    : `template-edit:${editTemplateId}`;
}

function stringList(value: JsonValue | undefined): string[] | null {
  return Array.isArray(value) && value.every(isString) ? value : null;
}

function draftEnvironment(value: JsonValue | undefined): WorkspaceEnvironment | null {
  const parsed = asJsonObject(value);
  const parsedEnv = asJsonObject(parsed?.env);
  const startupScript = parsed?.startupScript;
  if (parsed === null || parsedEnv === null) return null;
  if (startupScript !== null && !isString(startupScript)) return null;
  const env: WorkspaceEnvironment['env'] = {};
  for (const [name, entry] of Object.entries(parsedEnv)) {
    if (!isString(entry)) return null;
    env[name] = entry;
  }
  return { env, startupScript };
}

function templateDraft(serialized: string): TemplateConnectDraft | null {
  let value: JsonValue;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsed = asJsonObject(value);
  const attachedIds = stringList(parsed?.attachedIds);
  const repos = stringList(parsed?.repos);
  const environment = draftEnvironment(parsed?.environment);
  if (
    parsed === null
    || !isString(parsed.name)
    || !isString(parsed.machineTypeId)
    || attachedIds === null
    || !Array.isArray(parsed.connections)
    || !isBoolean(parsed.shareWithOrg)
    || environment === null
    || !(parsed.agentRuleId === null || isString(parsed.agentRuleId))
    || !isBoolean(parsed.isOrgDefault)
    || repos === null
  ) return null;
  const connections: TemplateConnectionView[] = [];
  for (const entry of parsed.connections) {
    const connection = asJsonObject(entry);
    if (connection === null || !isString(connection.provider)) return null;
    connections.push({ provider: connection.provider });
  }
  return {
    name: parsed.name,
    machineTypeId: parsed.machineTypeId,
    attachedIds,
    connections,
    shareWithOrg: parsed.shareWithOrg,
    environment,
    agentRuleId: parsed.agentRuleId,
    isOrgDefault: parsed.isOrgDefault,
    repos,
  };
}

function workspaceDraft(serialized: string): WorkspaceConnectDraft | null {
  let value: JsonValue;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsed = asJsonObject(value);
  const environment = draftEnvironment(parsed?.environment);
  const repos = stringList(parsed?.repos);
  if (
    parsed === null
    || !(parsed.templateId === null || (isString(parsed.templateId) && parsed.templateId !== ''))
    || environment === null
    || !(parsed.agentRuleId === null || isString(parsed.agentRuleId))
    || repos === null
  ) return null;
  return {
    templateId: parsed.templateId,
    environment,
    agentRuleId: parsed.agentRuleId,
    repos,
  };
}

export function readTemplateConnectDraft(
  returnTo: TemplateConnectReturnTo,
): TemplateConnectDraft | null {
  if (!hasConnectReturn()) return null;
  const stored = window.sessionStorage.getItem(`${TEMPLATE_DRAFT_PREFIX}${returnTo}`);
  return stored === null ? null : templateDraft(stored);
}

export function storeTemplateConnectDraft(
  returnTo: TemplateConnectReturnTo,
  draft: TemplateConnectDraft,
): void {
  window.sessionStorage.setItem(
    `${TEMPLATE_DRAFT_PREFIX}${returnTo}`,
    JSON.stringify(draft),
  );
}

export function clearTemplateConnectDraft(returnTo: TemplateConnectReturnTo): void {
  window.sessionStorage.removeItem(`${TEMPLATE_DRAFT_PREFIX}${returnTo}`);
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
