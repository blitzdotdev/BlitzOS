import type { Agent, TerminalAgent } from './protocol';
import { isPreviewPort } from './preview';
import {
  asJsonObject,
  isBoolean,
  type JsonValue,
  isNumber,
  isString,
} from './type-guards';

const CHAT_AUTH_DISMISSALS_KEY_PREFIX = 'blitz-chat-auth-dismissals-v1:';
type OptionalJsonValue = JsonValue | undefined;

export type StorageNamespace = {
  orgId: string;
  membershipId: string;
};

type StorageBackend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type WorkspacePreference = {
  title?: string;
  agentDefault?: Agent;
};

export type UiPreferences = {
  version: 1;
  activeWorkspaceId: string;
  railWidth: number;
  order: string[];
  workspaces: Record<string, WorkspacePreference>;
};

export type WorkspaceTab = {
  id: number;
  type: TerminalAgent | 'terminal';
} | {
  id: number;
  type: 'chat';
  chatSessionId?: string;
  chatProvider?: Agent;
} | {
  id: number;
  type: 'file';
  filePath: string;
} | {
  id: number;
  type: 'preview';
  port: number;
};

export type WorkspaceTabs = {
  version: 1;
  tabs: WorkspaceTab[];
  activeId: number | null;
  nextId: number;
};

export type WorkspaceFiles = {
  version: 1;
  open: boolean;
  width: number;
  expanded: string[];
  segment: WorkspaceDrawerSegment;
};

export type WorkspaceDrawerSegment = 'files' | 'leases' | 'requests' | 'events';

export type GlobalWebAppStateV1 = {
  version: 1;
  activeWorkspaceId: string;
  order: string[];
};

export type WorkspaceWebAppStateV1 = {
  version: 1;
  title?: string;
  agentDefault: Agent;
  tabs: WorkspaceTabs;
  drawer: WorkspaceFiles;
};

export type WebAppStateResponse<Doc> = {
  doc: Doc | null;
  updatedAt: number | null;
};

interface RestoredSessionTab {
  id: number;
  type: TerminalAgent | 'terminal' | 'chat';
  chatSessionId?: string;
  chatProvider?: Agent;
}

export function createStorageNamespace(orgId: string, membershipId: string): StorageNamespace {
  return { orgId, membershipId };
}

function namespacePrefix(namespace: StorageNamespace): string {
  return `${namespace.orgId}:${namespace.membershipId}:`;
}

function chatAuthDismissalsStorageKey(
  namespace: StorageNamespace,
  workspaceId: string,
): string {
  return `${namespacePrefix(namespace)}${CHAT_AUTH_DISMISSALS_KEY_PREFIX}${workspaceId}`;
}

function isSafeRelativePath<Value>(value: Value): value is Value & string {
  return isString(value)
    && value.length > 0
    && !value.startsWith('/')
    && !value.split('/').includes('..');
}

export function storedWorkspacePreference(
  title: string,
  serverName: string,
  agentDefault: Agent,
): WorkspacePreference {
  const preference: WorkspacePreference = {};
  if (title !== serverName) preference.title = title;
  preference.agentDefault = agentDefault;
  return preference;
}

export function defaultWorkspaceTabs(): WorkspaceTabs {
  return {
    version: 1,
    tabs: [{ id: 1, type: 'terminal' }],
    activeId: 1,
    nextId: 2,
  };
}

export function defaultWorkspaceFiles(): WorkspaceFiles {
  return {
    version: 1,
    open: true,
    width: 264,
    expanded: [],
    segment: 'files',
  };
}

export function defaultGlobalWebAppState(): GlobalWebAppStateV1 {
  return { version: 1, activeWorkspaceId: '', order: [] };
}

export function defaultWorkspaceWebAppState(): WorkspaceWebAppStateV1 {
  return {
    version: 1,
    agentDefault: 'claude',
    tabs: defaultWorkspaceTabs(),
    drawer: defaultWorkspaceFiles(),
  };
}

export function workspaceWebAppState(
  title: string,
  serverName: string,
  agentDefault: Agent,
  tabs: WorkspaceTabs,
  drawer: WorkspaceFiles,
): WorkspaceWebAppStateV1 {
  const doc: WorkspaceWebAppStateV1 = {
    version: 1,
    agentDefault,
    tabs,
    drawer,
  };
  if (title !== serverName) doc.title = title;
  return doc;
}

export function reconcileUiPreferences(
  global: GlobalWebAppStateV1,
  workspaceStates: ReadonlyMap<string, WorkspaceWebAppStateV1>,
  liveWorkspaceIds: readonly string[],
): UiPreferences {
  const live = new Set(liveWorkspaceIds);
  const order = [
    ...global.order.filter((id, index) => live.has(id) && global.order.indexOf(id) === index),
    ...liveWorkspaceIds.filter((id) => !global.order.includes(id)),
  ];
  return {
    version: 1,
    activeWorkspaceId: live.has(global.activeWorkspaceId) ? global.activeWorkspaceId : '',
    railWidth: 240,
    order,
    workspaces: Object.fromEntries([...workspaceStates].flatMap(([id, state]) => {
      if (!live.has(id)) return [];
      const preference: WorkspacePreference = { agentDefault: state.agentDefault };
      if (state.title !== undefined) preference.title = state.title;
      return [[id, preference]];
    })),
  };
}

function parseTab(entry: OptionalJsonValue, seen: Set<number>): WorkspaceTab | null {
  const object = asJsonObject(entry);
  if (object === null) return null;
  const id = isNumber(object.id) && Number.isSafeInteger(object.id) ? object.id : 0;
  if (id < 1 || seen.has(id) || !isString(object.type)) return null;
  seen.add(id);
  if (object.type === 'file') {
    return isSafeRelativePath(object.filePath)
      ? { id, type: 'file', filePath: object.filePath }
      : null;
  }
  if (object.type === 'preview') {
    return isNumber(object.port) && isPreviewPort(object.port)
      ? { id, type: 'preview', port: object.port }
      : null;
  }
  if (object.type === 'chat') {
    const tab: RestoredSessionTab = { id, type: 'chat' };
    if (isString(object.chatSessionId)) tab.chatSessionId = object.chatSessionId;
    if (object.chatProvider === 'claude' || object.chatProvider === 'codex') {
      tab.chatProvider = object.chatProvider;
    }
    // SAFETY: The chat branch and checked optional fields establish the chat tab variant.
    return tab as WorkspaceTab;
  }
  if (
    object.type === 'terminal'
    || object.type === 'claude'
    || object.type === 'codex'
    || object.type === 'opencode'
    || object.type === 'pi'
    || object.type === 'kimi'
    || object.type === 'prime'
  ) {
    // SAFETY: The branch checks every TerminalAgent literal plus terminal.
    return { id, type: object.type as TerminalAgent | 'terminal' };
  }
  return null;
}

function parseTabs(value: OptionalJsonValue): WorkspaceTabs | null {
  const object = asJsonObject(value);
  if (object === null || object.version !== 1 || !Array.isArray(object.tabs)) {
    return null;
  }
  const seen = new Set<number>();
  const tabs = object.tabs.flatMap((entry) => {
    const tab = parseTab(entry, seen);
    return tab === null ? [] : [tab];
  });
  if (tabs.length === 0 || tabs.length !== object.tabs.length) return null;
  const activeId = object.activeId === null
    ? null
    : isNumber(object.activeId) && Number.isSafeInteger(object.activeId)
      ? object.activeId
      : -1;
  if (activeId !== null && !tabs.some(({ id }) => id === activeId)) return null;
  const minimumNextId = Math.max(...tabs.map(({ id }) => id)) + 1;
  if (
    !isNumber(object.nextId)
    || !Number.isSafeInteger(object.nextId)
    || object.nextId < minimumNextId
  ) {
    return null;
  }
  return { version: 1, tabs, activeId, nextId: object.nextId };
}

function parseDrawer(value: OptionalJsonValue): WorkspaceFiles | null {
  const object = asJsonObject(value);
  if (
    object === null
    || object.version !== 1
    || !isBoolean(object.open)
    || !isNumber(object.width)
    || object.width < 200
    || object.width > 480
    || !Array.isArray(object.expanded)
  ) return null;
  const expanded = object.expanded.filter(isSafeRelativePath);
  if (expanded.length !== object.expanded.length) return null;
  const segment = object.segment === 'leases' || object.segment === 'requests' || object.segment === 'events'
    ? object.segment
    : object.segment === 'files'
      ? 'files'
      : null;
  return segment === null
    ? null
    : { version: 1, open: object.open, width: object.width, expanded, segment };
}

function parseGlobalDoc(value: OptionalJsonValue): GlobalWebAppStateV1 | null {
  const object = asJsonObject(value);
  if (
    object === null
    || object.version !== 1
    || !isString(object.activeWorkspaceId)
    || !Array.isArray(object.order)
    || !object.order.every(isString)
  ) return null;
  return { version: 1, activeWorkspaceId: object.activeWorkspaceId, order: object.order };
}

function parseWorkspaceDoc(value: OptionalJsonValue): WorkspaceWebAppStateV1 | null {
  const object = asJsonObject(value);
  if (object === null || object.version !== 1) return null;
  if (object.agentDefault !== 'claude' && object.agentDefault !== 'codex') return null;
  const tabs = parseTabs(object.tabs);
  const drawer = parseDrawer(object.drawer);
  if (tabs === null || drawer === null) return null;
  const doc: WorkspaceWebAppStateV1 = {
    version: 1,
    agentDefault: object.agentDefault,
    tabs,
    drawer,
  };
  if (object.title !== undefined) {
    if (!isString(object.title)) return null;
    doc.title = object.title;
  }
  return doc;
}

function decodeStateResponse<Doc>(
  json: string,
  parseDoc: (value: OptionalJsonValue) => Doc | null,
): WebAppStateResponse<Doc> {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('webApp state response is invalid JSON');
  }
  const object = asJsonObject(value);
  if (object === null) throw new Error('webApp state response is invalid');
  const updatedAt = object.updatedAt === null
    ? null
    : isNumber(object.updatedAt) && Number.isSafeInteger(object.updatedAt)
      ? object.updatedAt
      : undefined;
  if (updatedAt === undefined) throw new Error('webApp state response has invalid updatedAt');
  if (object.doc === null) return { doc: null, updatedAt };
  const doc = parseDoc(object.doc);
  if (doc === null) throw new Error('webApp state response has invalid doc');
  return { doc, updatedAt };
}

export function decodeGlobalWebAppStateResponse(
  json: string,
): WebAppStateResponse<GlobalWebAppStateV1> {
  return decodeStateResponse(json, parseGlobalDoc);
}

export function decodeWorkspaceWebAppStateResponse(
  json: string,
): WebAppStateResponse<WorkspaceWebAppStateV1> {
  return decodeStateResponse(json, parseWorkspaceDoc);
}

export function loadDismissedChatAuthProviders(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): Agent[] {
  try {
    const value = JSON.parse(
      storage.getItem(chatAuthDismissalsStorageKey(namespace, workspaceId)) ?? 'null',
    );
    const object = asJsonObject(value);
    if (object === null || object.version !== 1 || !Array.isArray(object.providers)) {
      return [];
    }
    return [...new Set(object.providers.filter(
      (provider): provider is Agent => provider === 'claude' || provider === 'codex',
    ))];
  } catch {
    return [];
  }
}

export function saveDismissedChatAuthProviders(
  namespace: StorageNamespace,
  workspaceId: string,
  providers: Agent[],
  storage: StorageBackend = localStorage,
): void {
  const valid = [...new Set(providers.filter(
    (provider): provider is Agent => provider === 'claude' || provider === 'codex',
  ))];
  if (valid.length === 0) {
    storage.removeItem(chatAuthDismissalsStorageKey(namespace, workspaceId));
    return;
  }
  storage.setItem(
    chatAuthDismissalsStorageKey(namespace, workspaceId),
    JSON.stringify({ version: 1, providers: valid }),
  );
}

export function removeDismissedChatAuthProviders(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): void {
  storage.removeItem(chatAuthDismissalsStorageKey(namespace, workspaceId));
}
