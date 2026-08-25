import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import {
  HttpError,
  type JsonValue,
  isBoolean,
  isNumber,
  isRecord,
  isString,
  readJson,
} from "./http.js";
import { isPreviewPath, MAX_PREVIEW_PATH_LENGTH } from "./preview.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

type WebAppAgent = "claude" | "codex";
type OptionalJsonValue = JsonValue | undefined;
type WebAppDrawerSegment = "files" | "previews" | "connections";
/** Panes are side-by-side columns; an absent region is the main (left) pane,
 * so pre-split documents round-trip unchanged. */
type WebAppRegion = "main" | "side";
type WebAppTabType =
  | "claude"
  | "codex"
  | "opencode"
  | "pi"
  | "kimi"
  | "prime"
  | "terminal"
  | "chat"
  | "file"
  | "preview"
  | "panel";

interface WebAppTabV1 {
  id: number;
  type: WebAppTabType;
  chatSessionId?: string;
  chatProvider?: WebAppAgent;
  chatConfig?: {
    model?: string;
    effort?: string;
    permission?: string;
  };
  filePath?: string;
  port?: number;
  url?: string;
  title?: string;
  panel?: WebAppDrawerSegment;
  region?: WebAppRegion;
  path?: string;
  windowOpen?: false;
}

interface WebAppTabsV1 {
  version: 1;
  tabs: WebAppTabV1[];
  archivedTabs?: WebAppTabV1[];
  activeId: number | null;
  nextId: number;
  sideActiveId?: number;
}

/** `open` and `segment` are pre-split fields. The webApp folds them into a
 * panel tab on read and stops writing them; the parser keeps them when a
 * stored document still carries them so that migration input survives a GET. */
interface WebAppDrawerV1 {
  version: 1;
  width: number;
  expanded: string[];
  open?: boolean;
  segment?: WebAppDrawerSegment;
}

export interface GlobalWebAppStateV1 {
  version: 1;
  activeWorkspaceId: string;
  order: string[];
}

export interface WorkspaceWebAppStateV1 {
  version: 1;
  title?: string;
  agentDefault: WebAppAgent;
  tabs: WebAppTabsV1;
  drawer: WebAppDrawerV1;
}

interface StateRow {
  doc: string | null;
  updated_at: number | null;
}

interface StateResponse<Doc> {
  doc: Doc | null;
  updatedAt: number | null;
}

const TAB_TYPES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "kimi",
  "prime",
  "terminal",
  "chat",
  "file",
  "preview",
  "panel",
]);
const SESSION_TITLE_MAX_LENGTH = 64;

function isManagedTab(tab: WebAppTabV1): boolean {
  return tab.type === "chat"
    || tab.type === "terminal"
    || tab.type === "claude"
    || tab.type === "codex"
    || tab.type === "opencode"
    || tab.type === "pi"
    || tab.type === "kimi"
    || tab.type === "prime";
}

function parseManagedTitle(value: OptionalJsonValue, field: string): string | undefined {
  if (value === undefined) return undefined;
  const title = boundedString(value, field, SESSION_TITLE_MAX_LENGTH).trim();
  return title === "" ? undefined : title;
}

function parseWindowOpen(value: OptionalJsonValue, field: string): false | undefined {
  if (value === undefined || value === true) return undefined;
  if (!isBoolean(value)) throw new HttpError(400, `${field} must be a boolean`);
  return false;
}

function boundedString(value: OptionalJsonValue, field: string, maxLength: number): string {
  if (!isString(value) || value.length > maxLength) {
    throw new HttpError(400, `${field} must be a string no longer than ${maxLength}`);
  }
  return value;
}

function positiveId(value: OptionalJsonValue, field: string): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return value;
}

function stringList(value: OptionalJsonValue, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((entry, index) => boundedString(entry, `${field}[${index}]`, 1_024));
}

function parseAgent(value: OptionalJsonValue, field: string): WebAppAgent {
  if (value !== "claude" && value !== "codex") {
    throw new HttpError(400, `${field} must be claude or codex`);
  }
  return value;
}

function parseChatConfig(value: OptionalJsonValue, field: string): NonNullable<WebAppTabV1["chatConfig"]> {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  const config: NonNullable<WebAppTabV1["chatConfig"]> = {};
  for (const key of ["model", "effort", "permission"] as const) {
    if (value[key] !== undefined) config[key] = boundedString(value[key], `${field}.${key}`, 256);
  }
  return config;
}

function parseSegment(value: OptionalJsonValue, field: string): WebAppDrawerSegment {
  // Legacy documents stored earlier segment names ('integrations' most
  // recently); they normalize to the combined connections panel instead of
  // invalidating the whole document. Mirror parsePanel in webapp storage.ts.
  const segment = value === "leases"
      || value === "requests"
      || value === "credentials"
      || value === "events"
      || value === "integrations"
    ? "connections"
    : value;
  if (segment !== "files" && segment !== "previews" && segment !== "connections") {
    throw new HttpError(400, `${field} is invalid`);
  }
  return segment;
}

function parseRegion(value: OptionalJsonValue, field: string): WebAppRegion | undefined {
  if (value === undefined) return undefined;
  if (value !== "main" && value !== "side") {
    throw new HttpError(400, `${field} must be main or side`);
  }
  return value;
}

function withRegion(tab: WebAppTabV1, region: WebAppRegion | undefined): WebAppTabV1 {
  // `main` is the absent-region default; writing it back would change the
  // bytes of every pre-split document that passes through.
  return region === "side" ? { ...tab, region } : tab;
}

function parseTab(value: OptionalJsonValue, index: number): WebAppTabV1 {
  if (!isRecord(value)) throw new HttpError(400, `tabs.tabs[${index}] must be an object`);
  const id = positiveId(value.id, `tabs.tabs[${index}].id`);
  if (!isString(value.type) || !TAB_TYPES.has(value.type)) {
    throw new HttpError(400, `tabs.tabs[${index}].type is invalid`);
  }
  // SAFETY: TAB_TYPES contains exactly the WebAppTabType literals declared above.
  const type = value.type as WebAppTabType;
  const region = parseRegion(value.region, `tabs.tabs[${index}].region`);
  if (type === "file") {
    const filePath = boundedString(value.filePath, `tabs.tabs[${index}].filePath`, 4_096);
    if (filePath === "" || filePath.startsWith("/") || filePath.split("/").includes("..")) {
      throw new HttpError(400, `tabs.tabs[${index}].filePath must be a safe relative path`);
    }
    return withRegion({ id, type, filePath }, region);
  }
  if (type === "panel") {
    return withRegion(
      { id, type, panel: parseSegment(value.panel, `tabs.tabs[${index}].panel`) },
      region,
    );
  }
  if (type === "preview") {
    // Two preview variants ship from the webApp: a local port, and a public
    // link the box published. Rejecting the link variant would 400 the whole
    // shared document and stop every tab from persisting.
    if (value.port !== undefined) {
      const port = positiveId(value.port, `tabs.tabs[${index}].port`);
      if (port > 65_535) throw new HttpError(400, `tabs.tabs[${index}].port is invalid`);
      // A deep-linked preview keeps its route. The webApp's own parser
      // (packages/webapp/src/storage.ts) accepts the same optional field; a
      // server that dropped it silently reset the tab to "/" on every reload.
      if (value.path === undefined) return withRegion({ id, type, port }, region);
      const path = boundedString(value.path, `tabs.tabs[${index}].path`, MAX_PREVIEW_PATH_LENGTH);
      // Rooted and traversal-free, exactly as the filePath rule above: the
      // browser normalizes `/preview/<port>/a/../../workspace/` before the
      // request leaves the tab, so a stored `..` walks the iframe out of the
      // preview prefix onto another box surface.
      if (!isPreviewPath(path)) {
        throw new HttpError(400, `tabs.tabs[${index}].path must be a rooted path without ..`);
      }
      return withRegion({ id, type, port, path }, region);
    }
    const url = boundedString(value.url, `tabs.tabs[${index}].url`, 2_048);
    if (url.trim() === "") throw new HttpError(400, `tabs.tabs[${index}].url is invalid`);
    const title = boundedString(value.title, `tabs.tabs[${index}].title`, 256);
    return withRegion({ id, type, url, title }, region);
  }
  if (type !== "chat") {
    const title = parseManagedTitle(value.title, `tabs.tabs[${index}].title`);
    const tab: WebAppTabV1 = { id, type };
    if (title !== undefined) tab.title = title;
    const windowOpen = parseWindowOpen(value.windowOpen, `tabs.tabs[${index}].windowOpen`);
    if (windowOpen === false) tab.windowOpen = false;
    return withRegion(tab, region);
  }
  const tab: WebAppTabV1 = { id, type };
  const title = parseManagedTitle(value.title, `tabs.tabs[${index}].title`);
  if (title !== undefined) tab.title = title;
  if (value.chatSessionId !== undefined) {
    tab.chatSessionId = boundedString(
      value.chatSessionId,
      `tabs.tabs[${index}].chatSessionId`,
      1_024,
    );
  }
  if (value.chatProvider !== undefined) {
    tab.chatProvider = parseAgent(value.chatProvider, `tabs.tabs[${index}].chatProvider`);
  }
  if (value.chatConfig !== undefined) {
    tab.chatConfig = parseChatConfig(value.chatConfig, `tabs.tabs[${index}].chatConfig`);
  }
  const windowOpen = parseWindowOpen(value.windowOpen, `tabs.tabs[${index}].windowOpen`);
  if (windowOpen === false) tab.windowOpen = false;
  return withRegion(tab, region);
}

function parseTabs(value: OptionalJsonValue): WebAppTabsV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tabs)) {
    throw new HttpError(400, "tabs must be a version 1 tabs document");
  }
  const archivedValues = value.archivedTabs === undefined ? [] : value.archivedTabs;
  if (!Array.isArray(archivedValues)) {
    throw new HttpError(400, "tabs.archivedTabs must be an array");
  }
  if (value.tabs.length + archivedValues.length > 100) {
    throw new HttpError(400, "tabs may contain at most 100 active and archived items");
  }
  const tabs = value.tabs.map(parseTab);
  const archivedTabs = archivedValues.map(parseTab);
  if (!archivedTabs.every(isManagedTab)) {
    throw new HttpError(400, "tabs.archivedTabs may only contain managed sessions");
  }
  const allTabs = [...tabs, ...archivedTabs];
  if (new Set(allTabs.map(({ id }) => id)).size !== allTabs.length) {
    throw new HttpError(400, "tabs must have unique ids");
  }
  const activeId = value.activeId === null
    ? null
    : positiveId(value.activeId, "tabs.activeId");
  if (activeId !== null && !tabs.some((tab) => tab.id === activeId
    && tab.windowOpen !== false
    && tab.region !== "side")) {
    throw new HttpError(400, "tabs.activeId must identify a main-pane tab");
  }
  const nextId = positiveId(value.nextId, "tabs.nextId");
  if (allTabs.some(({ id }) => id >= nextId)) {
    throw new HttpError(400, "tabs.nextId must be greater than every tab id");
  }
  const parsed: WebAppTabsV1 = { version: 1, tabs, activeId, nextId };
  if (archivedTabs.length > 0) parsed.archivedTabs = archivedTabs;
  if (value.sideActiveId !== undefined) {
    const sideActiveId = positiveId(value.sideActiveId, "tabs.sideActiveId");
    if (!tabs.some((tab) => tab.id === sideActiveId
      && tab.windowOpen !== false
      && tab.region === "side")) {
      throw new HttpError(400, "tabs.sideActiveId must identify a side-pane tab");
    }
    parsed.sideActiveId = sideActiveId;
  }
  return parsed;
}

function parseDrawer(value: OptionalJsonValue): WebAppDrawerV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new HttpError(400, "drawer must be a version 1 drawer document");
  }
  if (!isNumber(value.width) || !Number.isFinite(value.width) || value.width < 200 || value.width > 2000) {
    throw new HttpError(400, "drawer.width must be between 200 and 2000");
  }
  const drawer: WebAppDrawerV1 = {
    version: 1,
    width: value.width,
    expanded: stringList(value.expanded, "drawer.expanded", 1_000),
  };
  // Pre-split documents pair an open flag with one segment. Both are kept
  // verbatim so a webApp reading the stored row can still fold them into a
  // panel tab; split-aware writes simply omit them.
  if (value.open === undefined && value.segment === undefined) return drawer;
  if (value.open !== true && value.open !== false) {
    throw new HttpError(400, "drawer.open must be a boolean");
  }
  drawer.open = value.open;
  drawer.segment = parseSegment(value.segment, "drawer.segment");
  return drawer;
}

function parseGlobalDoc(value: OptionalJsonValue): GlobalWebAppStateV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new HttpError(400, "doc must be a version 1 global webApp state document");
  }
  return {
    version: 1,
    activeWorkspaceId: boundedString(value.activeWorkspaceId, "doc.activeWorkspaceId", 256),
    order: stringList(value.order, "doc.order", 1_000),
  };
}

function parseWorkspaceDoc(value: OptionalJsonValue): WorkspaceWebAppStateV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new HttpError(400, "doc must be a version 1 workspace webApp state document");
  }
  const result: WorkspaceWebAppStateV1 = {
    version: 1,
    agentDefault: parseAgent(value.agentDefault, "doc.agentDefault"),
    tabs: parseTabs(value.tabs),
    drawer: parseDrawer(value.drawer),
  };
  if (value.title !== undefined) {
    const title = boundedString(value.title, "doc.title", 256).trim();
    if (title !== "") result.title = title;
  }
  return result;
}

function parseStoredDoc<Doc>(
  row: StateRow,
  parser: (value: OptionalJsonValue) => Doc,
): StateResponse<Doc> {
  if (row.doc === null) return { doc: null, updatedAt: null };
  let value: JsonValue;
  try {
    value = JSON.parse(row.doc);
  } catch {
    throw new Error("stored webApp state is invalid JSON");
  }
  return { doc: parser(value), updatedAt: row.updated_at };
}

async function globalState(db: Db, principalId: string): Promise<StateRow> {
  return (await first<StateRow>(db, {
    q: `SELECT doc, updated_at FROM webapp_state
        WHERE principal_id = ?1 AND workspace_id IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    v: [principalId],
  })) ?? { doc: null, updated_at: null };
}

async function workspaceState(
  db: Db,
  principal: Principal,
  workspaceId: string,
): Promise<StateRow | null> {
  // The workspace doc is shared state: every reader gets the newest row no
  // matter which principal wrote it, so all accounts see one tab set and
  // attach the same guest sessions. Any share (grant or org-wide, viewer
  // included) may read; writes stay editor-gated in the PUT below.
  return first<StateRow>(db, {
    q: `SELECT s.doc, s.updated_at
        FROM workspaces w
        LEFT JOIN webapp_state s ON s.workspace_id = w.id
        LEFT JOIN workspace_grants grant
          ON grant.workspace_id = w.id AND grant.membership_id = ?2
        WHERE w.id = ?1 AND w.org_id = ?3
          AND (w.owner_membership_id = ?2 OR ?4 = 'admin'
            OR grant.role IS NOT NULL OR w.org_share_role IS NOT NULL)
        ORDER BY s.updated_at DESC
        LIMIT 1`,
    v: [workspaceId, principal.membershipId, principal.orgId, principal.role],
  });
}

/** The highest tab counter any principal has stored for this workspace.
 * Unreadable rows are skipped rather than failing the write: the floor is a
 * safety rail, and a doc nobody can parse cannot be naming live sessions. */
async function storedNextId(db: Db, workspaceId: string): Promise<number> {
  const stored = await rows<{ doc: string }>(db, {
    q: "SELECT doc FROM webapp_state WHERE workspace_id = ?1",
    v: [workspaceId],
  });
  let floor = 0;
  for (const row of stored) {
    let value: JsonValue;
    try {
      value = JSON.parse(row.doc);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const tabs = value.tabs;
    if (!isRecord(tabs) || !isNumber(tabs.nextId) || !Number.isSafeInteger(tabs.nextId)) continue;
    floor = Math.max(floor, tabs.nextId);
  }
  return floor;
}

async function throwWorkspaceAccessError(
  db: Db,
  workspaceId: string,
  orgId: string | null,
): Promise<never> {
  const workspace = await first<{ org_id: string | null }>(db, {
    q: "SELECT org_id FROM workspaces WHERE id = ?1 AND phase != 'destroyed' LIMIT 1",
    v: [workspaceId],
  });
  if (workspace === null || workspace.org_id !== orgId) {
    throw new HttpError(404, "workspace not found");
  }
  throw new HttpError(403, "forbidden");
}

export function addWebAppStateRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/webapp-state", async (context) => {
    const principal = await requirePrincipal(context);
    const row = await globalState(runtimeFactory(context).db, principal.id);
    return context.json(parseStoredDoc(row, parseGlobalDoc));
  });

  router.put("/webapp-state", async (context) => {
    const principal = await requirePrincipal(context);
    const doc = parseGlobalDoc(await readJson(context.req.raw));
    const now = Date.now();
    await transaction(runtimeFactory(context).db, [
      {
        q: "DELETE FROM webapp_state WHERE principal_id = ?1 AND workspace_id IS NULL",
        v: [principal.id],
      },
      {
        q: `INSERT INTO webapp_state (principal_id, workspace_id, doc, updated_at)
            VALUES (?1, NULL, ?2, ?3)`,
        v: [principal.id, JSON.stringify(doc), now],
      },
    ]);
    return context.json<StateResponse<GlobalWebAppStateV1>>({ doc, updatedAt: now });
  });

  router.get("/workspaces/:id/webapp-state", async (context) => {
    const principal = await requirePrincipal(context);
    const row = await workspaceState(
      runtimeFactory(context).db,
      principal,
      context.req.param("id"),
    );
    const found = row ?? await throwWorkspaceAccessError(
        runtimeFactory(context).db,
        context.req.param("id"),
        principal.orgId,
      );
    return context.json(parseStoredDoc(found, parseWorkspaceDoc));
  });

  router.put("/workspaces/:id/webapp-state", async (context) => {
    const principal = await requirePrincipal(context);
    const doc = parseWorkspaceDoc(await readJson(context.req.raw));
    const now = Date.now();
    const db = runtimeFactory(context).db;
    // A tab id names a tmux session on the shared guest, so an id must never
    // be handed out twice: a doc that rewinds nextId would give a new tab an
    // id whose session is still running, silently attaching it to someone
    // else's agent. The counter is therefore workspace-wide and only rises,
    // whichever client writes.
    doc.tabs.nextId = Math.max(doc.tabs.nextId, await storedNextId(db, context.req.param("id")));
    // Writes keep one row per (principal, workspace); readers take the newest
    // row, so the doc behaves as shared last-write-wins state with no schema
    // change. Editors via a personal grant or org-wide sharing may write.
    const updated = await rows(db, {
      q: `INSERT INTO webapp_state (principal_id, workspace_id, doc, updated_at)
          SELECT ?1, w.id, ?3, ?4 FROM workspaces w
          LEFT JOIN workspace_grants grant
            ON grant.workspace_id = w.id AND grant.membership_id = ?5
          WHERE w.id = ?2 AND w.org_id = ?6 AND w.phase != 'destroyed'
            AND (w.owner_membership_id = ?5 OR ?7 = 'admin'
              OR grant.role = 'editor' OR w.org_share_role = 'editor')
          ON CONFLICT(principal_id, workspace_id) DO UPDATE
          SET doc = excluded.doc, updated_at = excluded.updated_at
          RETURNING principal_id`,
      v: [
        principal.id,
        context.req.param("id"),
        JSON.stringify(doc),
        now,
        principal.membershipId,
        principal.orgId,
        principal.role,
      ],
    });
    if (updated.length !== 1) {
      await throwWorkspaceAccessError(
        runtimeFactory(context).db,
        context.req.param("id"),
        principal.orgId,
      );
    }
    return context.json<StateResponse<WorkspaceWebAppStateV1>>({ doc, updatedAt: now });
  });
}
