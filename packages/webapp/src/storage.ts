import type { Agent, TerminalAgent } from './protocol';
import { isPreviewPath, isPreviewPort } from './preview';
import { LODY_SESSIONS_ENABLED } from './lody/flag';
import {
  asJsonObject,
  isBoolean,
  type JsonValue,
  isNumber,
  isString,
} from './type-guards';

type OptionalJsonValue = JsonValue | undefined;

export type StorageNamespace = {
  orgId: string;
  membershipId: string;
};

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

/** Panes are side-by-side columns: `main` renders left, `side` renders right.
 * A tab without a region is a main tab, so pre-split documents round-trip
 * byte-identically. */
export type WorkspaceRegion = 'main' | 'side';

export type ManagedWorkspaceTab = {
  id: number;
  type: TerminalAgent | 'terminal';
  title?: string;
  region?: WorkspaceRegion;
};

export type WorkspaceTab = ManagedWorkspaceTab | {
  id: number;
  type: 'preview';
  port: number;
  path?: string;
  region?: WorkspaceRegion;
} | {
  id: number;
  type: 'preview';
  url: string;
  title: string;
  region?: WorkspaceRegion;
} | {
  id: number;
  /** Connections, opened from the right icon strip. `panel` keeps the drawer
   * segment name as its wire value; legacy spellings (including
   * 'integrations') fold in parsePanel, and the retired Files / teenyapps
   * panels drop on read. */
  type: 'panel';
  panel: WorkspaceDrawerSegment;
  region?: WorkspaceRegion;
};

export type WorkspaceTabs = {
  version: 1;
  tabs: WorkspaceTab[];
  /** Active tab of the main (left) pane. */
  activeId: number | null;
  nextId: number;
  /** Active tab of the side (right) pane; absent while the split is collapsed. */
  sideActiveId?: number;
};

export type WorkspaceFiles = {
  version: 1;
  width: number;
  expanded: string[];
};

/** Wire value of a panel tab. `connections` replaced the persisted
 * 'integrations' value; readers fold the old spelling below. The Files
 * (`files`) and teenyapps (`previews`) panels are retired: a persisted tab or
 * pre-split drawer segment naming one still parses, and yields no tab. */
export type WorkspaceDrawerSegment = 'connections';

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
  type: TerminalAgent | 'terminal';
  title?: string;
}

export const SESSION_TITLE_MAX_LENGTH = 64;

export function isManagedWorkspaceTab(tab: WorkspaceTab): tab is ManagedWorkspaceTab {
  return tab.type === 'terminal'
    || tab.type === 'claude'
    || tab.type === 'codex'
    || tab.type === 'opencode'
    || tab.type === 'pi'
    || tab.type === 'kimi'
    || tab.type === 'prime';
}

export function createStorageNamespace(orgId: string, membershipId: string): StorageNamespace {
  return { orgId, membershipId };
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

/**
 * The tab set a fresh workspace holds.
 *
 * WITH LODY SESSIONS ON IT IS EMPTY, and the workspace opens the CHAT LANDING
 * (plans/LODY-SESSIONS.md §0.4). TUI tabs are opt-in, through the New tab
 * control in the rail's footer — the one spawn affordance left now that the
 * native strip is deleted (plans/LODY-TERMINAL-TABS.md §4.6).
 *
 * THERE IS NO LONGER A SECOND, LEGACY DEFAULT. `terminalFirstWorkspaceTabs()`
 * stood here and seeded `claude` + a side-pane Files panel into a fresh
 * workspace whose BOX turned out to run a pre-Lody image; `useLodyRail` called
 * it from the same decision that would otherwise have opened the landing. It is
 * deleted with the strip, because it wrote exactly the tabs only that strip
 * could draw: on a box with no session plane the honest answer is the rail's
 * "Sessions need a newer machine" notice, not two tabs whose chrome no longer
 * exists. A workspace that ALREADY holds tabs keeps every one of them — this
 * function answers only for a document the server has never seen, so nothing
 * migrates and nothing stored is rewritten.
 *
 * A fresh workspace with the flag off opens straight into Claude, with Files in
 * the side pane, exactly as before.
 */
export function defaultWorkspaceTabs(): WorkspaceTabs {
  if (LODY_SESSIONS_ENABLED) {
    return { version: 1, tabs: [], activeId: null, nextId: 1 };
  }
  return {
    version: 1,
    tabs: [{ id: 1, type: 'claude' }],
    activeId: 1,
    nextId: 2,
  };
}

/** A tab with no stored region lives in the main pane. */
export function tabRegion(tab: WorkspaceTab): WorkspaceRegion {
  return tab.region ?? 'main';
}

/** `main` is the absent-region default, so it is written as an absent key and
 * a document that never split serializes exactly as it did before panes. */
export function withRegion<Tab extends WorkspaceTab>(
  tab: Tab,
  region: WorkspaceRegion,
): Tab {
  if (region === 'main') {
    if (tab.region === undefined) return tab;
    const { region: _dropped, ...rest } = tab;
    // SAFETY: Removing the optional region key leaves the same tab variant.
    return rest as Tab;
  }
  return tab.region === region ? tab : { ...tab, region };
}

/** The drawer opens up to 65% of the viewport beyond the 264px rail, and
 * never less than the old 480px ceiling. */
export function maxDrawerWidth(viewportWidth: number): number {
  return Math.max(480, Math.round((viewportWidth - 264) * 0.65));
}

/** The default pane width is also the floor: the Finder's Name + Modified +
 * Size columns need it, so a drag can widen the pane but never squeeze it. */
export const MIN_DRAWER_WIDTH = 340;

export function clampDrawerWidth(width: number, viewportWidth: number): number {
  return Math.max(MIN_DRAWER_WIDTH, Math.min(maxDrawerWidth(viewportWidth), width));
}

export function defaultWorkspaceFiles(): WorkspaceFiles {
  return {
    version: 1,
    width: MIN_DRAWER_WIDTH,
    expanded: [],
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

/** Re-points an existing port preview tab at a new deep-link. `undefined`
 * clears the route, which is what a plain `blitz preview open <port>` after a
 * deep-linked one means: take the user back to the root of that server.
 *
 * The in-box agent re-runs `blitz preview open` on every server start, so a
 * second "open /dashboard" almost always lands on a port that already has a
 * tab. Selecting that tab without applying the route silently ignored the
 * agent's request. Returns the same array when nothing changes, so a re-open of
 * an unchanged route does not churn the persisted document. */
export function withPreviewTabPath(
  tabs: WorkspaceTab[],
  tabId: number,
  path: string | undefined,
): WorkspaceTab[] {
  const target = tabs.find((tab) => tab.id === tabId);
  if (
    target === undefined
    || target.type !== 'preview'
    || !('port' in target)
    || target.path === path
  ) return tabs;
  const retargeted: WorkspaceTab = path === undefined
    ? { id: target.id, type: 'preview', port: target.port }
    : { id: target.id, type: 'preview', port: target.port, path };
  return tabs.map((tab) => tab.id === tabId ? retargeted : tab);
}

/** Drops a deep-link the server would refuse. The `path` on a preview tab is
 * the one tab field an outside producer sets — `blitz preview open --path`
 * travels from the in-box agent to the focus marker to this document — so it
 * is the one that can arrive out of range. Losing the route beats losing the
 * document. */
function clampedTab(tab: WorkspaceTab): WorkspaceTab {
  if (isManagedWorkspaceTab(tab) && tab.title !== undefined) {
    const title = tab.title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (title !== tab.title) {
      const next = { ...tab };
      if (title === '') delete next.title;
      else next.title = title;
      return next;
    }
  }
  if (tab.type !== 'preview' || !('port' in tab) || tab.path === undefined) return tab;
  if (isPreviewPath(tab.path)) return tab;
  return withRegion({ id: tab.id, type: 'preview', port: tab.port }, tabRegion(tab));
}

/** Keeps the two panes coherent: a side pane only exists while it holds tabs,
 * a pane's active id always names one of its own tabs, and the side pane never
 * outlives an emptied main pane — the split collapses left instead. */
export function normalizedWorkspaceTabs(tabs: WorkspaceTabs): WorkspaceTabs {
  const kept = tabs.tabs;
  const collapse = kept.length > 0 && kept.every((tab) => tabRegion(tab) === 'side');
  const entries = collapse ? kept.map((tab) => withRegion(tab, 'main')) : kept;
  const main = entries.filter((tab) => tabRegion(tab) === 'main');
  const side = entries.filter((tab) => tabRegion(tab) === 'side');
  const requestedActive = collapse ? tabs.sideActiveId ?? tabs.activeId : tabs.activeId;
  const activeId = main.some(({ id }) => id === requestedActive)
    ? requestedActive ?? null
    : main.at(-1)?.id ?? null;
  const sideActiveId = side.some(({ id }) => id === tabs.sideActiveId)
    ? tabs.sideActiveId
    : side.at(-1)?.id;
  const highestId = entries.reduce((highest, tab) => Math.max(highest, tab.id), 0);
  const next: WorkspaceTabs = {
    version: 1,
    tabs: entries,
    activeId,
    nextId: Math.max(tabs.nextId, highestId + 1),
  };
  if (sideActiveId !== undefined) next.sideActiveId = sideActiveId;
  return next;
}

/** The server rejects an out-of-range document whole, and a rejected write
 * takes the entire shared doc — tabs included — down with it. Local state can
 * drift out of range from a resize or a stale device, so clamp to the wire
 * limits here rather than letting one field end persistence. Mirror
 * `parseWorkspaceDoc` in the control plane. */
function clampedDoc(doc: WorkspaceWebAppStateV1): WorkspaceWebAppStateV1 {
  return {
    ...doc,
    tabs: normalizedWorkspaceTabs({ ...doc.tabs, tabs: doc.tabs.tabs.slice(0, 100).map(clampedTab) }),
    drawer: {
      ...doc.drawer,
      width: Math.min(2000, Math.max(200, Math.round(doc.drawer.width))),
      expanded: doc.drawer.expanded.filter((path) => path.length <= 1024).slice(0, 1000),
    },
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
  if (title !== serverName) doc.title = title.slice(0, 256);
  return clampedDoc(doc);
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

function parsePanel(value: OptionalJsonValue): WorkspaceDrawerSegment | null {
  // Older documents stored 'leases'/'requests'/'credentials'/'events', then
  // 'integrations'; they all land on the combined connections panel. Writers
  // only write 'connections'. Mirror parseSegment in the control plane.
  if (
    value === 'leases'
    || value === 'requests'
    || value === 'credentials'
    || value === 'events'
    || value === 'integrations'
    || value === 'connections'
  ) return 'connections';
  return null;
}

/** The Files and teenyapps panels no longer exist. Documents in the field
 * still carry them, as panel tabs and as the pre-split drawer segment, and
 * the control plane still accepts them; here they read as nothing. */
function isRetiredPanel(value: OptionalJsonValue): boolean {
  return value === 'files' || value === 'previews';
}

/** A tab kind this client no longer draws: a 'chat' tab from the retired
 * native-chat surface, a 'file' editor tab, or a retired panel. Dropped on
 * read rather than invalidating the whole document. */
function isRetiredTab(entry: OptionalJsonValue): boolean {
  const tab = asJsonObject(entry);
  if (tab === null) return false;
  if (tab.type === 'chat' || tab.type === 'file') return true;
  return tab.type === 'panel' && isRetiredPanel(tab.panel);
}

function parseTab(entry: OptionalJsonValue, seen: Set<number>): WorkspaceTab | null {
  const object = asJsonObject(entry);
  if (object === null) return null;
  const id = isNumber(object.id) && Number.isSafeInteger(object.id) ? object.id : 0;
  if (id < 1 || seen.has(id) || !isString(object.type)) return null;
  // Pre-split documents carry no region at all; anything else must name a pane.
  if (object.region !== undefined && object.region !== 'main' && object.region !== 'side') {
    return null;
  }
  const region: WorkspaceRegion = object.region === 'side' ? 'side' : 'main';
  seen.add(id);
  if (object.type === 'panel') {
    const panel = parsePanel(object.panel);
    return panel === null ? null : withRegion({ id, type: 'panel', panel }, region);
  }
  if (object.type === 'preview') {
    if (isNumber(object.port) && isPreviewPort(object.port)) {
      if (object.url !== undefined || object.title !== undefined) return null;
      // An unusable deep-link loses the route, not the tab: a `..` segment
      // would walk the iframe out of the `/preview/<port>/` prefix, and an
      // over-long path is a document the server refuses whole.
      const path = isString(object.path) && isPreviewPath(object.path)
        ? object.path
        : undefined;
      return path === undefined
        ? withRegion({ id, type: 'preview', port: object.port }, region)
        : withRegion({ id, type: 'preview', port: object.port, path }, region);
    }
    return object.port === undefined
      && isString(object.url)
      && object.url.trim() !== ''
      && isString(object.title)
      ? withRegion({ id, type: 'preview', url: object.url, title: object.title }, region)
      : null;
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
    if (object.title !== undefined && (
      !isString(object.title) || object.title.length > SESSION_TITLE_MAX_LENGTH
    )) return null;
    const title = isString(object.title) ? object.title.trim() : '';
    // SAFETY: The branch checks every TerminalAgent literal plus terminal.
    const tab: RestoredSessionTab = {
      id,
      type: object.type as TerminalAgent | 'terminal',
    };
    if (title !== '') tab.title = title;
    // SAFETY: The branch checks every TerminalAgent literal plus terminal.
    return withRegion(tab as WorkspaceTab, region);
  }
  return null;
}

function parseTabs(value: OptionalJsonValue): WorkspaceTabs | null {
  const object = asJsonObject(value);
  if (object === null || object.version !== 1 || !Array.isArray(object.tabs)) {
    return null;
  }
  // 'chat' tabs belonged to the retired native-chat surface, 'file' tabs and
  // the Files / teenyapps panel tabs to the retired files panel. A stored one
  // is dropped on read rather than invalidating the whole document, and the
  // ids that pointed at it fall back instead of failing the restore. The
  // control plane's parseTabs keeps accepting every one of them.
  const liveTabs = object.tabs.filter((entry) => !isRetiredTab(entry));
  const droppedLegacyTab = liveTabs.length !== object.tabs.length;
  const seen = new Set<number>();
  const tabs = liveTabs.flatMap((entry) => {
    const tab = parseTab(entry, seen);
    return tab === null ? [] : [tab];
  });
  if (tabs.length !== liveTabs.length) return null;
  const storedActiveId = object.activeId === null
    ? null
    : isNumber(object.activeId) && Number.isSafeInteger(object.activeId)
      ? object.activeId
      : -1;
  const mainTabs = tabs.filter((tab) => tabRegion(tab) === 'main');
  const activeIdIsLive = storedActiveId === null
    || mainTabs.some((tab) => tab.id === storedActiveId);
  if (!activeIdIsLive && !droppedLegacyTab) return null;
  const activeId = activeIdIsLive ? storedActiveId : null;
  const minimumNextId = tabs.reduce((highest, { id }) => Math.max(highest, id), 0) + 1;
  if (
    !isNumber(object.nextId)
    || !Number.isSafeInteger(object.nextId)
    || object.nextId < minimumNextId
  ) {
    return null;
  }
  const restored: WorkspaceTabs = { version: 1, tabs, activeId, nextId: object.nextId };
  if (object.sideActiveId !== undefined) {
    if (
      !isNumber(object.sideActiveId)
      || !Number.isSafeInteger(object.sideActiveId)
    ) return null;
    if (tabs.some((tab) => tab.id === object.sideActiveId && tabRegion(tab) === 'side')) {
      restored.sideActiveId = object.sideActiveId;
    } else if (!droppedLegacyTab) return null;
  }
  return restored;
}

type RestoredDrawer = {
  drawer: WorkspaceFiles;
  /** Present only for pre-split documents, which stored the right panel as an
   * open flag plus one segment instead of a tab. */
  legacy: { open: boolean; segment: WorkspaceDrawerSegment } | null;
};

function parseDrawer(value: OptionalJsonValue): RestoredDrawer | null {
  const object = asJsonObject(value);
  if (
    object === null
    || object.version !== 1
    || !isNumber(object.width)
    || object.width < 200
    || object.width > 2000
    || !Array.isArray(object.expanded)
  ) return null;
  const expanded = object.expanded.filter(isSafeRelativePath);
  if (expanded.length !== object.expanded.length) return null;
  const drawer: WorkspaceFiles = { version: 1, width: object.width, expanded };
  if (object.open === undefined && object.segment === undefined) {
    return { drawer, legacy: null };
  }
  if (!isBoolean(object.open)) return null;
  const segment = parsePanel(object.segment);
  if (segment !== null) return { drawer, legacy: { open: object.open, segment } };
  // A pre-split drawer that showed Files or teenyapps has nothing to become:
  // the panel is gone, so the document restores with the split collapsed.
  return isRetiredPanel(object.segment) ? { drawer, legacy: null } : null;
}

/** Pre-split documents are upgraded, never rejected: the old drawer becomes a
 * panel tab pinned to the side pane, and a closed drawer becomes no tab at all
 * — which is exactly the collapsed split. Nothing else in the document moves. */
function migratedTabs(
  tabs: WorkspaceTabs,
  legacy: { open: boolean; segment: WorkspaceDrawerSegment } | null,
): WorkspaceTabs {
  if (legacy === null || !legacy.open) return tabs;
  // A document that already carries panel tabs was written by a split-aware
  // client; its tab list wins over the stale drawer fields beside it.
  if (tabs.tabs.some((tab) => tab.type === 'panel')) return tabs;
  const id = tabs.nextId;
  const migrated: WorkspaceTabs = {
    version: 1,
    tabs: [...tabs.tabs, { id, type: 'panel', panel: legacy.segment, region: 'side' }],
    activeId: tabs.activeId,
    nextId: id + 1,
    sideActiveId: id,
  };
  return migrated;
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
  const restored = parseDrawer(object.drawer);
  if (tabs === null || restored === null) return null;
  const doc: WorkspaceWebAppStateV1 = {
    version: 1,
    agentDefault: object.agentDefault,
    tabs: normalizedWorkspaceTabs(migratedTabs(tabs, restored.legacy)),
    drawer: restored.drawer,
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
