import type {
  PresenceActivityView,
  PresenceMemberState,
  PresenceMemberView,
  PresenceSnapshotResponse,
  PresenceSurfaceView,
  PutPresenceConnectionRequest,
  WorkspaceSessionKind,
} from '@blitzos/schema';
import { asJsonObject, isBoolean, isNumber, isString, type JsonValue } from './type-guards';
import type { WorkspaceTab } from './storage';

function sessionKind(value: JsonValue | undefined): WorkspaceSessionKind | null {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'pi':
    case 'kimi':
    case 'prime':
    case 'terminal':
    case 'chat':
      return value;
    default:
      return null;
  }
}

function surface(value: JsonValue | undefined): PresenceSurfaceView | null {
  const object = asJsonObject(value);
  if (object === null) return null;
  const parsedSessionKind = sessionKind(object.sessionKind);
  if (
    object.kind === 'session'
    && isString(object.sessionId)
    && parsedSessionKind !== null
    && (object.title === null || isString(object.title))
  ) {
    return {
      kind: 'session',
      sessionId: object.sessionId,
      sessionKind: parsedSessionKind,
      title: object.title,
    };
  }
  if (
    (object.kind === 'file' || object.kind === 'preview')
    && isString(object.surfaceId)
    && isString(object.label)
  ) return { kind: object.kind, surfaceId: object.surfaceId, label: object.label };
  if (
    object.kind === 'panel'
    && (object.panel === 'files' || object.panel === 'previews' || object.panel === 'connections')
  ) {
    return { kind: 'panel', panel: object.panel };
  }
  return object.kind === 'workspace' ? { kind: 'workspace' } : null;
}

function activity(value: JsonValue | undefined): PresenceActivityView | null {
  const object = asJsonObject(value);
  if (
    object === null
    || !isBoolean(object.visible)
    || !isBoolean(object.focused)
    || !isNumber(object.lastSeenAt)
    || !Number.isSafeInteger(object.lastSeenAt)
  ) return null;
  const base = {
    visible: object.visible,
    focused: object.focused,
    lastSeenAt: object.lastSeenAt,
  };
  if (object.location === 'organization') return { ...base, location: 'organization' };
  if (object.location === 'other-workspace') return { ...base, location: 'other-workspace' };
  if (
    object.location !== 'workspace'
    || !isString(object.workspaceId)
    || !isString(object.workspaceName)
    || !Array.isArray(object.surfaces)
  ) return null;
  const surfaces: PresenceSurfaceView[] = [];
  for (const value of object.surfaces) {
    const parsed = surface(value);
    if (parsed === null) return null;
    surfaces.push(parsed);
  }
  if (
    object.focusedSurface !== null
    && (
      !isNumber(object.focusedSurface)
      || !Number.isSafeInteger(object.focusedSurface)
      || object.focusedSurface < 0
      || object.focusedSurface >= surfaces.length
    )
  ) return null;
  return {
    ...base,
    location: 'workspace',
    workspaceId: object.workspaceId,
    workspaceName: object.workspaceName,
    surfaces,
    focusedSurface: object.focusedSurface,
  };
}

function memberState(value: JsonValue | undefined): PresenceMemberState | null {
  return value === 'active' || value === 'online' || value === 'away' ? value : null;
}

function member(value: JsonValue | undefined): PresenceMemberView | null {
  const object = asJsonObject(value);
  const state = object === null ? null : memberState(object.state);
  if (
    object === null
    || !isString(object.membershipId)
    || !isString(object.userId)
    || !isString(object.name)
    || !(object.avatarUrl === null || isString(object.avatarUrl))
    || state === null
    || !Array.isArray(object.activities)
  ) return null;
  const activities: PresenceActivityView[] = [];
  for (const value of object.activities) {
    const parsed = activity(value);
    if (parsed === null) return null;
    activities.push(parsed);
  }
  return {
    membershipId: object.membershipId,
    userId: object.userId,
    name: object.name,
    avatarUrl: object.avatarUrl,
    state,
    activities,
  };
}

export function decodePresenceSnapshotResponse(json: string): PresenceSnapshotResponse {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('presence response is invalid JSON');
  }
  const object = asJsonObject(value);
  if (
    object === null
    || !isNumber(object.serverTime)
    || !Number.isSafeInteger(object.serverTime)
    || !isNumber(object.expiresAfterMs)
    || !Number.isSafeInteger(object.expiresAfterMs)
    || !Array.isArray(object.members)
  ) throw new Error('presence response is invalid');
  const members: PresenceMemberView[] = [];
  for (const value of object.members) {
    const parsed = member(value);
    if (parsed === null) throw new Error('presence response has invalid members');
    members.push(parsed);
  }
  return {
    serverTime: object.serverTime,
    expiresAfterMs: object.expiresAfterMs,
    members,
  };
}

function safeBasename(path: string): string {
  const name = path.split(/[/\\]/u).filter(Boolean).at(-1) ?? 'File';
  return name.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128) || 'File';
}

function tabSurface(tab: WorkspaceTab) {
  switch (tab.type) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'pi':
    case 'kimi':
    case 'prime':
    case 'terminal':
    case 'chat':
      return tab.sessionId === undefined
        ? null
        : { kind: 'session' as const, sessionId: tab.sessionId };
    case 'file':
      return { kind: 'file' as const, surfaceId: `tab-${tab.id}`, label: safeBasename(tab.filePath) };
    case 'preview':
      return { kind: 'preview' as const, surfaceId: `tab-${tab.id}`, label: 'Preview' };
    case 'panel':
      return { kind: 'panel' as const, panel: tab.panel };
  }
}

export function presenceViewForTabs(
  workspaceId: string | null,
  tabs: readonly WorkspaceTab[],
  visibleTabIds: readonly number[],
  focusedTabId: number | null,
): Pick<PutPresenceConnectionRequest, 'workspaceId' | 'surfaces' | 'focusedSurface'> {
  if (workspaceId === null) return { workspaceId: null, surfaces: [], focusedSurface: null };
  const selected = [...new Set(visibleTabIds)].slice(0, 2).flatMap((id) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) return [];
    const normalized = tabSurface(tab);
    return normalized === null ? [] : [{ tabId: id, surface: normalized }];
  });
  if (selected.length === 0) {
    return { workspaceId, surfaces: [{ kind: 'workspace' }], focusedSurface: 0 };
  }
  const focusedIndex = focusedTabId === null
    ? null
    : selected.findIndex(({ tabId }) => tabId === focusedTabId);
  return {
    workspaceId,
    surfaces: selected.map(({ surface }) => surface),
    focusedSurface: focusedIndex === null || focusedIndex < 0 ? null : focusedIndex,
  };
}
