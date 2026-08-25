import type {
  ListWorkspaceSessionsResponse,
  WorkspaceSessionKind,
  WorkspaceSessionResponse,
  WorkspaceSessionView,
} from '@blitzos/schema';
import {
  parseWorkspaceDoc,
  tabRegion,
  type WorkspaceRegion,
  type WorkspaceTab,
  type WorkspaceTabs,
  type WorkspaceWebAppStateV1,
} from './storage';
import { asJsonObject, isBoolean, type JsonValue, isNumber, isString } from './type-guards';
import { appendTab, withRegionActiveId } from './workspace-panes';

/** Shared terminal / native-chat sessions (`workspace_sessions` on the control
 * plane) and the member-view envelope that carries them. Decoders for the
 * wire; helpers for the two things a tab needs from a session: the key the
 * box terminal attaches to, and how to open the session in the local tab set. */

type OptionalJsonValue = JsonValue | undefined;

export type WorkspaceMemberViewResponse = {
  doc: WorkspaceWebAppStateV1 | null;
  revision: number;
  migratedFromV1: boolean;
  sessions: WorkspaceSessionView[];
};

const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function isWorkspaceSessionKind(value: OptionalJsonValue): value is WorkspaceSessionKind {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'pi':
    case 'kimi':
    case 'prime':
    case 'terminal':
    case 'chat':
      return true;
    default:
      return false;
  }
}

function parseWorkspaceSession(value: OptionalJsonValue): WorkspaceSessionView | null {
  const object = asJsonObject(value);
  if (
    object === null
    || !isString(object.id)
    || !SESSION_KEY_PATTERN.test(object.id)
    || !isString(object.workspaceId)
    || !isWorkspaceSessionKind(object.kind)
    || !(object.title === null || isString(object.title))
    || !isString(object.terminalKey)
    || !SESSION_KEY_PATTERN.test(object.terminalKey)
    || !(object.chatSessionId === null || isString(object.chatSessionId))
    || !(object.chatProvider === null || object.chatProvider === 'claude' || object.chatProvider === 'codex')
    || !isNumber(object.revision)
    || !Number.isSafeInteger(object.revision)
    || object.revision < 1
    || !isNumber(object.createdAt)
    || !Number.isSafeInteger(object.createdAt)
    || !isNumber(object.updatedAt)
    || !Number.isSafeInteger(object.updatedAt)
  ) return null;
  return {
    id: object.id,
    workspaceId: object.workspaceId,
    kind: object.kind,
    title: object.title,
    terminalKey: object.terminalKey,
    chatSessionId: object.chatSessionId,
    chatProvider: object.chatProvider,
    revision: object.revision,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

export function decodeWorkspaceSessionResponse(json: string): WorkspaceSessionResponse {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('workspace session response is invalid JSON');
  }
  const object = asJsonObject(value);
  const session = object === null ? null : parseWorkspaceSession(object.session);
  if (session === null) throw new Error('workspace session response is invalid');
  return { session };
}

export function decodeListWorkspaceSessionsResponse(json: string): ListWorkspaceSessionsResponse {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('workspace sessions response is invalid JSON');
  }
  const object = asJsonObject(value);
  if (object === null || !Array.isArray(object.sessions)) {
    throw new Error('workspace sessions response is invalid');
  }
  const sessions: WorkspaceSessionView[] = [];
  for (const value of object.sessions) {
    const session = parseWorkspaceSession(value);
    if (session === null) throw new Error('workspace sessions response is invalid');
    sessions.push(session);
  }
  return { sessions };
}

export function decodeWorkspaceMemberViewResponse(json: string): WorkspaceMemberViewResponse {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('workspace view response is invalid JSON');
  }
  const object = asJsonObject(value);
  if (
    object === null
    || !isNumber(object.revision)
    || !Number.isSafeInteger(object.revision)
    || object.revision < 0
    || !isBoolean(object.migratedFromV1)
    || !Array.isArray(object.sessions)
  ) throw new Error('workspace view response is invalid');
  const sessions: WorkspaceSessionView[] = [];
  for (const value of object.sessions) {
    const session = parseWorkspaceSession(value);
    if (session === null) throw new Error('workspace view response has invalid sessions');
    sessions.push(session);
  }
  if (object.doc === null) {
    return {
      doc: null,
      revision: object.revision,
      migratedFromV1: object.migratedFromV1,
      sessions,
    };
  }
  const doc = parseWorkspaceDoc(object.doc);
  if (doc === null) throw new Error('workspace view response has invalid doc');
  return {
    doc,
    revision: object.revision,
    migratedFromV1: object.migratedFromV1,
    sessions,
  };
}

/** The tab a shared session opens as. Chat tabs carry the actor session the
 * shared record already pinned, so a second member joins the same chat. */
export function sharedSessionTab(session: WorkspaceSessionView, id: number): WorkspaceTab {
  if (session.kind !== 'chat') return { id, type: session.kind, sessionId: session.id };
  const tab: Extract<WorkspaceTab, { type: 'chat' }> = {
    id,
    type: 'chat',
    sessionId: session.id,
  };
  if (session.chatSessionId !== null) tab.chatSessionId = session.chatSessionId;
  if (session.chatProvider !== null) tab.chatProvider = session.chatProvider;
  return tab;
}

/** The key handed to `blitz-term <kind> <key>`, which names the tmux session
 * in the box. A shared session says which key it runs under — a session
 * migrated from a V1 document keeps its old numeric tab id so the live tmux
 * session survives the upgrade. A tab whose session is not (yet) in the
 * registry falls back to its own identifiers, which is what pre-V2 clients
 * always did. */
export function terminalKeyFor(
  tab: WorkspaceTab,
  sessions: readonly WorkspaceSessionView[],
): string {
  const sessionId = 'sessionId' in tab ? tab.sessionId : undefined;
  if (sessionId === undefined) return String(tab.id);
  return sessions.find((session) => session.id === sessionId)?.terminalKey ?? sessionId;
}

export type OpenedSharedSession = {
  tabs: WorkspaceTabs;
  tabId: number;
  region: WorkspaceRegion;
  /** False when the session was already open and was only selected. */
  created: boolean;
};

/** Opens a shared session in the local tab set without duplicating it: an
 * already-open tab is selected in its own pane, otherwise a new tab referencing
 * the session is appended to `region`. Only the caller's personal view changes;
 * the shared session itself is untouched, which is what lets a deep link from
 * presence land on a collaborator's session without disturbing anyone. */
export function openSharedSessionTab(
  tabs: WorkspaceTabs,
  session: WorkspaceSessionView,
  region: WorkspaceRegion = 'main',
): OpenedSharedSession {
  const existing = tabs.tabs.find((tab) => (
    'sessionId' in tab && tab.sessionId === session.id && tab.type === session.kind
  ));
  if (existing !== undefined) {
    const existingRegion = tabRegion(existing);
    return {
      tabs: withRegionActiveId(tabs, existingRegion, existing.id),
      tabId: existing.id,
      region: existingRegion,
      created: false,
    };
  }
  const tabId = tabs.nextId;
  return {
    tabs: appendTab(tabs, region, (id) => sharedSessionTab(session, id)),
    tabId,
    region,
    created: true,
  };
}
