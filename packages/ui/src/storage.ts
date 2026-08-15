import type { Agent, TerminalAgent } from './protocol';
import { isPreviewPort } from './preview';

const UI_STORAGE_KEY = 'blitz-cockpit-ui-v1';
const TABS_KEY_PREFIX = 'blitz-cockpit-tabs-v1:';
const FILES_KEY_PREFIX = 'blitz-cockpit-files-v1:';
const CHAT_AUTH_DISMISSALS_KEY_PREFIX = 'blitz-chat-auth-dismissals-v1:';

export type StorageNamespace = {
  orgId: string;
  membershipId: string;
};

type StorageBackend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORED_VIEW_MODE_KEYS = new Set(['view', 'viewmode', 'sessionview', 'panelview']);

function storedViewModeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/gu, '');
}

function normalizeStoredViewModes(value: unknown): { value: unknown; migrated: boolean } {
  if (Array.isArray(value)) {
    let migrated = false;
    const normalized = value.map((entry) => {
      const result = normalizeStoredViewModes(entry);
      migrated ||= result.migrated;
      return result.value;
    });
    return { value: migrated ? normalized : value, migrated };
  }
  if (!value || typeof value !== 'object') return { value, migrated: false };

  let migrated = false;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (
      STORED_VIEW_MODE_KEYS.has(storedViewModeKey(key))
      && (entry === 'doc' || entry === 'document')
    ) {
      migrated = true;
      return [key, 'chat'];
    }
    const result = normalizeStoredViewModes(entry);
    migrated ||= result.migrated;
    return [key, result.value];
  }));
  return { value: migrated ? normalized : value, migrated };
}

function loadStoredJson(storage: StorageBackend, key: string, fallback: string): unknown {
  const result = normalizeStoredViewModes(JSON.parse(storage.getItem(key) ?? fallback));
  if (result.migrated) {
    try {
      storage.setItem(key, JSON.stringify(result.value));
    } catch {
      // A write-back failure must never make otherwise restorable tab state unreadable.
    }
  }
  return result.value;
}

export function createStorageNamespace(orgId: string, membershipId: string): StorageNamespace {
  return { orgId, membershipId };
}

function namespacePrefix(namespace: StorageNamespace): string {
  return `${namespace.orgId}:${namespace.membershipId}:`;
}

function uiStorageKey(namespace: StorageNamespace): string {
  return `${namespacePrefix(namespace)}${UI_STORAGE_KEY}`;
}

function tabsStorageKey(namespace: StorageNamespace, workspaceId: string): string {
  return `${namespacePrefix(namespace)}${TABS_KEY_PREFIX}${workspaceId}`;
}

function filesStorageKey(namespace: StorageNamespace, workspaceId: string): string {
  return `${namespacePrefix(namespace)}${FILES_KEY_PREFIX}${workspaceId}`;
}

function chatAuthDismissalsStorageKey(
  namespace: StorageNamespace,
  workspaceId: string,
): string {
  return `${namespacePrefix(namespace)}${CHAT_AUTH_DISMISSALS_KEY_PREFIX}${workspaceId}`;
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.split('/').includes('..');
}

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

export type WorkspaceDrawerSegment = 'files' | 'leases' | 'requests';

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

export function defaultUiPreferences(): UiPreferences {
  return {
    version: 1,
    activeWorkspaceId: '',
    railWidth: 240,
    order: [],
    workspaces: {},
  };
}

export function loadUiPreferences(
  namespace: StorageNamespace,
  storage: StorageBackend = localStorage,
): UiPreferences {
  try {
    const value = loadStoredJson(storage, uiStorageKey(namespace), '') as Partial<UiPreferences>;
    if (value.version !== 1) return defaultUiPreferences();
    return {
      version: 1,
      activeWorkspaceId: typeof value.activeWorkspaceId === 'string' ? value.activeWorkspaceId : '',
      railWidth: Math.max(190, Math.min(600, Number(value.railWidth) || 240)),
      order: Array.isArray(value.order) ? value.order.filter((id): id is string => typeof id === 'string') : [],
      workspaces: value.workspaces && typeof value.workspaces === 'object' ? value.workspaces : {},
    };
  } catch {
    return defaultUiPreferences();
  }
}

export function saveUiPreferences(
  namespace: StorageNamespace,
  value: UiPreferences,
  storage: StorageBackend = localStorage,
): void {
  storage.setItem(uiStorageKey(namespace), JSON.stringify(value));
}

export function loadWorkspaceTabs(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): WorkspaceTabs {
  try {
    const value = JSON.parse(storage.getItem(tabsStorageKey(namespace, workspaceId)) ?? 'null');
    if (!value || value.version !== 1 || !Array.isArray(value.tabs)) {
      return defaultWorkspaceTabs();
    }
    const seen = new Set<number>();
    const tabs: WorkspaceTab[] = (value.tabs as unknown[]).flatMap(
      (entry: unknown): WorkspaceTab[] => {
        if (!entry || typeof entry !== 'object') return [];
        const tab = entry as Partial<WorkspaceTab>;
        const type = String(tab.type);
        if (
          !Number.isSafeInteger(tab.id)
          || Number(tab.id) < 1
          || seen.has(Number(tab.id))
          || ![
            'claude',
            'codex',
            'opencode',
            'pi',
            'kimi',
            'prime',
            'terminal',
            'chat',
            'file',
            'preview',
          ].includes(type)
        ) return [];
        const filePath = 'filePath' in tab ? tab.filePath : undefined;
        if (
          type === 'file'
          && !isSafeRelativePath(filePath)
        ) return [];
        const port = 'port' in tab ? tab.port : undefined;
        if (
          type === 'preview'
          && (typeof port !== 'number' || !isPreviewPort(port))
        ) return [];
        const id = Number(tab.id);
        seen.add(id);
        if (type === 'file') {
          return [{ id, type: 'file', filePath: filePath as string }];
        }
        if (type === 'preview') {
          return [{ id, type: 'preview', port: port as number }];
        }
        return [{
          id,
          type: type as TerminalAgent | 'terminal' | 'chat',
          ...(type === 'chat' && 'chatSessionId' in tab && typeof tab.chatSessionId === 'string'
            ? { chatSessionId: tab.chatSessionId }
            : {}),
          ...(type === 'chat' && 'chatProvider' in tab
            && (tab.chatProvider === 'claude' || tab.chatProvider === 'codex')
            ? { chatProvider: tab.chatProvider }
            : {}),
        } as WorkspaceTab];
      },
    );
    if (tabs.length === 0) return defaultWorkspaceTabs();
    const activeId = tabs.some(({ id }) => id === value.activeId)
      ? Number(value.activeId)
      : tabs[0]?.id ?? null;
    const minimumNextId = Math.max(0, ...tabs.map(({ id }) => id)) + 1;
    return {
      version: 1,
      tabs,
      activeId,
      nextId: Number.isSafeInteger(value.nextId) && value.nextId >= minimumNextId
        ? value.nextId
        : minimumNextId,
    };
  } catch {
    return defaultWorkspaceTabs();
  }
}

export function saveWorkspaceTabs(
  namespace: StorageNamespace,
  workspaceId: string,
  value: WorkspaceTabs,
  storage: StorageBackend = localStorage,
): void {
  storage.setItem(tabsStorageKey(namespace, workspaceId), JSON.stringify(value));
}

export function removeWorkspaceTabs(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): void {
  storage.removeItem(tabsStorageKey(namespace, workspaceId));
}

export function loadWorkspaceFiles(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): WorkspaceFiles {
  try {
    const value = JSON.parse(
      storage.getItem(filesStorageKey(namespace, workspaceId)) ?? 'null',
    ) as Partial<WorkspaceFiles> | null;
    if (!value || value.version !== 1) return defaultWorkspaceFiles();
    return {
      version: 1,
      open: typeof value.open === 'boolean' ? value.open : true,
      width: Math.max(200, Math.min(480, Number(value.width) || 264)),
      expanded: Array.isArray(value.expanded)
        ? [...new Set(value.expanded.filter(isSafeRelativePath))]
        : [],
      segment: value.segment === 'leases' || value.segment === 'requests'
        ? value.segment
        : 'files',
    };
  } catch {
    return defaultWorkspaceFiles();
  }
}

export function saveWorkspaceFiles(
  namespace: StorageNamespace,
  workspaceId: string,
  value: WorkspaceFiles,
  storage: StorageBackend = localStorage,
): void {
  storage.setItem(filesStorageKey(namespace, workspaceId), JSON.stringify(value));
}

export function removeWorkspaceFiles(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): void {
  storage.removeItem(filesStorageKey(namespace, workspaceId));
}

export function loadDismissedChatAuthProviders(
  namespace: StorageNamespace,
  workspaceId: string,
  storage: StorageBackend = localStorage,
): Agent[] {
  try {
    const value = JSON.parse(
      storage.getItem(chatAuthDismissalsStorageKey(namespace, workspaceId)) ?? 'null',
    ) as { version?: unknown; providers?: unknown } | null;
    if (!value || value.version !== 1 || !Array.isArray(value.providers)) return [];
    return [...new Set(value.providers.filter(
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
