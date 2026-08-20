import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import {
  HttpError,
  type JsonValue,
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
type WebAppDrawerSegment = "files" | "previews" | "integrations";
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
  | "preview";

interface WebAppTabV1 {
  id: number;
  type: WebAppTabType;
  chatSessionId?: string;
  chatProvider?: WebAppAgent;
  filePath?: string;
  port?: number;
  path?: string;
}

interface WebAppTabsV1 {
  version: 1;
  tabs: WebAppTabV1[];
  activeId: number | null;
  nextId: number;
}

interface WebAppDrawerV1 {
  version: 1;
  open: boolean;
  width: number;
  expanded: string[];
  segment: WebAppDrawerSegment;
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
]);

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

function parseTab(value: OptionalJsonValue, index: number): WebAppTabV1 {
  if (!isRecord(value)) throw new HttpError(400, `tabs.tabs[${index}] must be an object`);
  const id = positiveId(value.id, `tabs.tabs[${index}].id`);
  if (!isString(value.type) || !TAB_TYPES.has(value.type)) {
    throw new HttpError(400, `tabs.tabs[${index}].type is invalid`);
  }
  // SAFETY: TAB_TYPES contains exactly the WebAppTabType literals declared above.
  const type = value.type as WebAppTabType;
  if (type === "file") {
    const filePath = boundedString(value.filePath, `tabs.tabs[${index}].filePath`, 4_096);
    if (filePath === "" || filePath.startsWith("/") || filePath.split("/").includes("..")) {
      throw new HttpError(400, `tabs.tabs[${index}].filePath must be a safe relative path`);
    }
    return { id, type, filePath };
  }
  if (type === "preview") {
    const port = positiveId(value.port, `tabs.tabs[${index}].port`);
    if (port > 65_535) throw new HttpError(400, `tabs.tabs[${index}].port is invalid`);
    // A deep-linked preview keeps its route. The webApp's own parser
    // (packages/webapp/src/storage.ts) accepts the same optional field; a
    // server that dropped it silently reset the tab to "/" on every reload.
    if (value.path === undefined) return { id, type, port };
    const path = boundedString(value.path, `tabs.tabs[${index}].path`, MAX_PREVIEW_PATH_LENGTH);
    // Rooted and traversal-free, exactly as the filePath rule above: the
    // browser normalizes `/preview/<port>/a/../../workspace/` before the
    // request leaves the tab, so a stored `..` walks the iframe out of the
    // preview prefix onto another box surface.
    if (!isPreviewPath(path)) {
      throw new HttpError(400, `tabs.tabs[${index}].path must be a rooted path without ..`);
    }
    return { id, type, port, path };
  }
  if (type !== "chat") return { id, type };
  const tab: WebAppTabV1 = { id, type };
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
  return tab;
}

function parseTabs(value: OptionalJsonValue): WebAppTabsV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tabs)) {
    throw new HttpError(400, "tabs must be a version 1 tabs document");
  }
  if (value.tabs.length > 100) throw new HttpError(400, "tabs may contain at most 100 items");
  const tabs = value.tabs.map(parseTab);
  if (new Set(tabs.map(({ id }) => id)).size !== tabs.length) {
    throw new HttpError(400, "tabs must have unique ids");
  }
  const activeId = value.activeId === null
    ? null
    : positiveId(value.activeId, "tabs.activeId");
  if (activeId !== null && !tabs.some(({ id }) => id === activeId)) {
    throw new HttpError(400, "tabs.activeId must identify a tab");
  }
  const nextId = positiveId(value.nextId, "tabs.nextId");
  if (tabs.some(({ id }) => id >= nextId)) {
    throw new HttpError(400, "tabs.nextId must be greater than every tab id");
  }
  return { version: 1, tabs, activeId, nextId };
}

function parseDrawer(value: OptionalJsonValue): WebAppDrawerV1 {
  if (!isRecord(value) || value.version !== 1 || (value.open !== true && value.open !== false)) {
    throw new HttpError(400, "drawer must be a version 1 drawer document");
  }
  if (!isNumber(value.width) || !Number.isFinite(value.width) || value.width < 200 || value.width > 2000) {
    throw new HttpError(400, "drawer.width must be between 200 and 2000");
  }
  const expanded = stringList(value.expanded, "drawer.expanded", 1_000);
  // Legacy docs stored earlier segment names; they normalize to the combined
  // integrations tab instead of invalidating the whole doc.
  const segment = value.segment === "leases"
      || value.segment === "requests"
      || value.segment === "credentials"
      || value.segment === "events"
    ? "integrations"
    : value.segment;
  if (segment !== "files" && segment !== "previews" && segment !== "integrations") {
    throw new HttpError(400, "drawer.segment is invalid");
  }
  return {
    version: 1,
    open: value.open,
    width: value.width,
    expanded,
    segment,
  };
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
