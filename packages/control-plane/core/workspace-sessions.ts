import type { Db, Query } from "./db.js";
import { first, rows, transaction } from "./db.js";
import {
  HttpError,
  type JsonValue,
  isNumber,
  isRecord,
  isString,
  readJson,
} from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import {
  parseWorkspaceDoc,
  type WebAppTabV1,
  type WorkspaceWebAppStateV1,
} from "./webapp-state.js";
import { webAppWorkspaceForRequest, type WebAppWorkspaceAccess } from "./workspace-access.js";
import {
  type CreateWorkspaceSessionRequest,
  type ListWorkspaceSessionsResponse,
  type UpdateWorkspaceSessionRequest,
  type WorkspaceSessionKind,
  type WorkspaceSessionResponse,
  type WorkspaceSessionView,
} from "./wire.js";

type OptionalJsonValue = JsonValue | undefined;

interface SessionRow {
  id: string;
  workspace_id: string;
  kind: WorkspaceSessionKind;
  title: string | null;
  metadata_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ViewRow {
  doc: string;
  revision: number;
}

interface LegacyRow {
  doc: string;
}

interface SessionMetadata {
  chatSessionId: string | null;
  chatProvider: "claude" | "codex" | null;
}

export interface WorkspaceMemberViewResponse {
  doc: WorkspaceWebAppStateV1 | null;
  revision: number;
  migratedFromV1: boolean;
  sessions: WorkspaceSessionView[];
}

function boundedString(value: OptionalJsonValue, field: string, maxLength: number): string {
  if (!isString(value) || value.length > maxLength) {
    throw new HttpError(400, `${field} must be a string no longer than ${maxLength}`);
  }
  return value;
}

function sessionId(value: string, field = "session id"): string {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HttpError(400, `${field} is invalid`);
  }
  return value;
}

function positiveRevision(value: OptionalJsonValue, field: string, allowZero = false): number {
  if (
    !isNumber(value)
    || !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
  ) throw new HttpError(400, `${field} is invalid`);
  return value;
}

function parseKind(value: OptionalJsonValue): WorkspaceSessionKind {
  switch (value) {
    case "claude":
    case "codex":
    case "opencode":
    case "pi":
    case "kimi":
    case "prime":
    case "terminal":
    case "chat":
      return value;
    default:
      throw new HttpError(400, "kind is invalid");
  }
}

function optionalTitle(value: OptionalJsonValue): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const title = boundedString(value, "title", 256).trim();
  return title === "" ? null : title;
}

function parseCreate(value: OptionalJsonValue): CreateWorkspaceSessionRequest {
  if (!isRecord(value)) throw new HttpError(400, "request must be an object");
  const request: CreateWorkspaceSessionRequest = { kind: parseKind(value.kind) };
  const title = optionalTitle(value.title);
  if (title !== undefined && title !== null) request.title = title;
  return request;
}

function nullableBoundedString(
  value: OptionalJsonValue,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const parsed = boundedString(value, field, maxLength);
  return parsed === "" ? null : parsed;
}

function parseUpdate(value: OptionalJsonValue): UpdateWorkspaceSessionRequest {
  if (!isRecord(value)) throw new HttpError(400, "request must be an object");
  const request: UpdateWorkspaceSessionRequest = {
    revision: positiveRevision(value.revision, "revision"),
  };
  const title = optionalTitle(value.title);
  if (title !== undefined) request.title = title;
  const chatSessionId = nullableBoundedString(value.chatSessionId, "chatSessionId", 1_024);
  if (chatSessionId !== undefined) request.chatSessionId = chatSessionId;
  if (value.chatProvider !== undefined) {
    if (value.chatProvider !== null && value.chatProvider !== "claude" && value.chatProvider !== "codex") {
      throw new HttpError(400, "chatProvider is invalid");
    }
    request.chatProvider = value.chatProvider;
  }
  return request;
}

function metadataFromJson(value: string): SessionMetadata {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("stored workspace session metadata is invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("stored workspace session metadata is invalid");
  const chatSessionId = parsed.chatSessionId === undefined || parsed.chatSessionId === null
    ? null
    : isString(parsed.chatSessionId)
      ? parsed.chatSessionId
      : undefined;
  const chatProvider = parsed.chatProvider === undefined || parsed.chatProvider === null
    ? null
    : parsed.chatProvider === "claude" || parsed.chatProvider === "codex"
      ? parsed.chatProvider
      : undefined;
  if (chatSessionId === undefined || chatProvider === undefined) {
    throw new Error("stored workspace session metadata is invalid");
  }
  return { chatSessionId, chatProvider };
}

function sessionView(row: SessionRow): WorkspaceSessionView {
  const metadata = metadataFromJson(row.metadata_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    chatSessionId: metadata.chatSessionId,
    chatProvider: metadata.chatProvider,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionKindForTab(tab: WebAppTabV1): WorkspaceSessionKind | null {
  switch (tab.type) {
    case "claude":
    case "codex":
    case "opencode":
    case "pi":
    case "kimi":
    case "prime":
    case "terminal":
    case "chat":
      return tab.type;
    default:
      return null;
  }
}

function legacyId(workspaceId: string, tabId: number): string {
  return `legacy-${workspaceId}-${tabId}`;
}

function withLegacySessionIds(
  workspaceId: string,
  doc: WorkspaceWebAppStateV1,
): WorkspaceWebAppStateV1 {
  return {
    ...doc,
    tabs: {
      ...doc.tabs,
      tabs: doc.tabs.tabs.map((tab) => sessionKindForTab(tab) !== null && tab.sessionId === undefined
        ? { ...tab, sessionId: legacyId(workspaceId, tab.id) }
        : tab),
    },
  };
}

function parseStoredWorkspaceDoc(raw: string): WorkspaceWebAppStateV1 {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stored webApp state is invalid JSON");
  }
  return parseWorkspaceDoc(parsed);
}

async function legacyWorkspaceDoc(db: Db, workspaceId: string): Promise<WorkspaceWebAppStateV1 | null> {
  const row = await first<LegacyRow>(db, {
    q: `SELECT doc FROM webapp_state
        WHERE workspace_id = ?1
        ORDER BY updated_at DESC LIMIT 1`,
    v: [workspaceId],
  });
  return row === null ? null : withLegacySessionIds(workspaceId, parseStoredWorkspaceDoc(row.doc));
}

function syntheticLegacySessions(
  workspaceId: string,
  doc: WorkspaceWebAppStateV1,
): WorkspaceSessionView[] {
  return doc.tabs.tabs.flatMap((tab): WorkspaceSessionView[] => {
    const kind = sessionKindForTab(tab);
    if (kind === null || tab.sessionId === undefined) return [];
    return [{
      id: tab.sessionId,
      workspaceId,
      kind,
      title: null,
      chatSessionId: tab.chatSessionId ?? null,
      chatProvider: tab.chatProvider ?? null,
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    }];
  });
}

async function activeSessions(db: Db, workspaceId: string): Promise<WorkspaceSessionView[]> {
  return (await rows<SessionRow>(db, {
    q: `SELECT id, workspace_id, kind, title, metadata_json, revision,
               created_at, updated_at, archived_at
        FROM workspace_sessions
        WHERE workspace_id = ?1 AND archived_at IS NULL
        ORDER BY created_at, id`,
    v: [workspaceId],
  })).map(sessionView);
}

async function legacyFallbackSessions(
  db: Db,
  workspaceId: string,
  doc: WorkspaceWebAppStateV1,
): Promise<WorkspaceSessionView[]> {
  const active = await activeSessions(db, workspaceId);
  const persisted = new Set((await rows<Pick<SessionRow, "id">>(db, {
    q: "SELECT id FROM workspace_sessions WHERE workspace_id = ?1",
    v: [workspaceId],
  })).map((row) => row.id));
  return [
    ...active,
    ...syntheticLegacySessions(workspaceId, doc).filter((session) => !persisted.has(session.id)),
  ];
}

function requireLiveWorkspace(access: WebAppWorkspaceAccess): void {
  if (access.workspace.phase === "destroyed") throw new HttpError(404, "workspace not found");
}

function requireSessionEditor(access: WebAppWorkspaceAccess): void {
  if (access.role === "viewer") throw new HttpError(403, "forbidden");
}

function sessionReferences(doc: WorkspaceWebAppStateV1): Map<string, WorkspaceSessionKind> {
  const references = new Map<string, WorkspaceSessionKind>();
  for (const tab of doc.tabs.tabs) {
    const kind = sessionKindForTab(tab);
    if (kind === null) continue;
    if (tab.sessionId === undefined) {
      throw new HttpError(400, `tabs.tabs[${tab.id}].sessionId is required`);
    }
    const id = sessionId(tab.sessionId, `tabs.tabs[${tab.id}].sessionId`);
    if (references.has(id)) throw new HttpError(400, "sessionId may appear only once in a view");
    references.set(id, kind);
  }
  return references;
}

function legacySessionQueries(
  workspaceId: string,
  membershipId: string,
  doc: WorkspaceWebAppStateV1,
  now: number,
): Query[] {
  return doc.tabs.tabs.flatMap((tab): Query[] => {
    const kind = sessionKindForTab(tab);
    if (kind === null || tab.sessionId === undefined) return [];
    const metadata: SessionMetadata = {
      chatSessionId: tab.chatSessionId ?? null,
      chatProvider: tab.chatProvider ?? null,
    };
    return [{
      q: `INSERT INTO workspace_sessions
          (id, workspace_id, kind, title, metadata_json, created_by_membership_id,
           revision, created_at, updated_at, archived_at)
          VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1, ?6, ?6, NULL)
          ON CONFLICT(id) DO NOTHING`,
      v: [tab.sessionId, workspaceId, kind, JSON.stringify(metadata), membershipId, now],
    }];
  });
}

async function validateViewSessions(
  db: Db,
  workspaceId: string,
  doc: WorkspaceWebAppStateV1,
  legacy: WorkspaceWebAppStateV1 | null,
): Promise<void> {
  const requested = sessionReferences(doc);
  if (requested.size === 0) return;
  const existing = await rows<Pick<SessionRow, "id" | "workspace_id" | "kind" | "archived_at">>(db, {
    q: `SELECT id, workspace_id, kind, archived_at FROM workspace_sessions
        WHERE id IN (${[...requested].map((_, index) => `?${index + 1}`).join(", ")})`,
    v: [...requested.keys()],
  });
  const valid = new Map<string, WorkspaceSessionKind>();
  const persisted = new Set<string>();
  for (const row of existing) {
    persisted.add(row.id);
    if (row.workspace_id === workspaceId && row.archived_at === null) {
      valid.set(row.id, row.kind);
    }
  }
  if (legacy !== null) {
    for (const [id, kind] of sessionReferences(legacy)) {
      // A persisted row wins over the compatibility document even when it is
      // archived. Otherwise a second member's first V2 save could resurrect a
      // shared session that another editor deliberately archived.
      if (!persisted.has(id)) valid.set(id, kind);
    }
  }
  for (const [id, kind] of requested) {
    if (valid.get(id) !== kind) throw new HttpError(400, "view references an invalid session");
  }
}

async function sessionById(db: Db, workspaceId: string, id: string): Promise<SessionRow | null> {
  return first<SessionRow>(db, {
    q: `SELECT id, workspace_id, kind, title, metadata_json, revision,
               created_at, updated_at, archived_at
        FROM workspace_sessions WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`,
    v: [id, workspaceId],
  });
}

export function addWorkspaceSessionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  const accessFor = async (context: CoreContext): Promise<WebAppWorkspaceAccess> => {
    const access = await webAppWorkspaceForRequest(
      runtimeFactory(context),
      requirePrincipal,
      context,
      context.req.param("id"),
    );
    requireLiveWorkspace(access);
    return access;
  };

  router.get("/workspaces/:id/view", async (context) => {
    const access = await accessFor(context);
    const db = runtimeFactory(context).db;
    const row = await first<ViewRow>(db, {
      q: `SELECT doc, revision FROM workspace_member_views
          WHERE workspace_id = ?1 AND membership_id = ?2 LIMIT 1`,
      v: [access.workspace.id, access.membershipId],
    });
    if (row !== null) {
      return context.json<WorkspaceMemberViewResponse>({
        doc: parseStoredWorkspaceDoc(row.doc),
        revision: row.revision,
        migratedFromV1: false,
        sessions: await activeSessions(db, access.workspace.id),
      });
    }
    const legacy = await legacyWorkspaceDoc(db, access.workspace.id);
    return context.json<WorkspaceMemberViewResponse>({
      doc: legacy,
      revision: 0,
      migratedFromV1: legacy !== null,
      sessions: legacy === null
        ? await activeSessions(db, access.workspace.id)
        : await legacyFallbackSessions(db, access.workspace.id, legacy),
    });
  });

  router.put("/workspaces/:id/view", async (context) => {
    const access = await accessFor(context);
    const body = await readJson(context.req.raw);
    if (!isRecord(body)) throw new HttpError(400, "request must be an object");
    const revision = positiveRevision(body.revision, "revision", true);
    const doc = parseWorkspaceDoc(body.doc);
    const db = runtimeFactory(context).db;
    const legacy = revision === 0 ? await legacyWorkspaceDoc(db, access.workspace.id) : null;
    await validateViewSessions(db, access.workspace.id, doc, legacy);
    const now = Date.now();
    const sessionQueries = legacy === null
      ? []
      : legacySessionQueries(access.workspace.id, access.membershipId, legacy, now);
    const viewQuery: Query = revision === 0
      ? {
          q: `INSERT INTO workspace_member_views
              (workspace_id, membership_id, revision, doc, updated_at)
              VALUES (?1, ?2, 1, ?3, ?4)
              ON CONFLICT(workspace_id, membership_id) DO NOTHING
              RETURNING revision`,
          v: [access.workspace.id, access.membershipId, JSON.stringify(doc), now],
        }
      : {
          q: `UPDATE workspace_member_views
              SET revision = revision + 1, doc = ?3, updated_at = ?4
              WHERE workspace_id = ?1 AND membership_id = ?2 AND revision = ?5
              RETURNING revision`,
          v: [access.workspace.id, access.membershipId, JSON.stringify(doc), now, revision],
        };
    const results = await transaction<{ revision: number }>(db, [...sessionQueries, viewQuery]);
    const changed = results.at(-1)?.[0];
    if (changed === undefined) throw new HttpError(409, "workspace view changed; reload and retry");
    return context.json<WorkspaceMemberViewResponse>({
      doc,
      revision: changed.revision,
      migratedFromV1: false,
      sessions: await activeSessions(db, access.workspace.id),
    });
  });

  router.get("/workspaces/:id/sessions", async (context) => {
    const access = await accessFor(context);
    return context.json<ListWorkspaceSessionsResponse>({
      sessions: await activeSessions(runtimeFactory(context).db, access.workspace.id),
    });
  });

  router.post("/workspaces/:id/sessions", async (context) => {
    const access = await accessFor(context);
    requireSessionEditor(access);
    const input = parseCreate(await readJson(context.req.raw));
    const now = Date.now();
    const id = crypto.randomUUID();
    const metadata: SessionMetadata = { chatSessionId: null, chatProvider: null };
    await rows(runtimeFactory(context).db, {
      q: `INSERT INTO workspace_sessions
          (id, workspace_id, kind, title, metadata_json, created_by_membership_id,
           revision, created_at, updated_at, archived_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7, NULL)`,
      v: [
        id,
        access.workspace.id,
        input.kind,
        input.title ?? null,
        JSON.stringify(metadata),
        access.membershipId,
        now,
      ],
    });
    const row = await sessionById(runtimeFactory(context).db, access.workspace.id, id);
    if (row === null) throw new Error("workspace session disappeared after create");
    return context.json<WorkspaceSessionResponse>({ session: sessionView(row) }, 201);
  });

  router.patch("/workspaces/:id/sessions/:sessionId", async (context) => {
    const access = await accessFor(context);
    requireSessionEditor(access);
    const id = sessionId(context.req.param("sessionId"));
    const db = runtimeFactory(context).db;
    const current = await sessionById(db, access.workspace.id, id);
    if (current === null || current.archived_at !== null) {
      throw new HttpError(404, "workspace session not found");
    }
    const input = parseUpdate(await readJson(context.req.raw));
    if (
      current.kind !== "chat"
      && (input.chatSessionId !== undefined || input.chatProvider !== undefined)
    ) throw new HttpError(400, "chat metadata is valid only for chat sessions");
    const metadata = metadataFromJson(current.metadata_json);
    const nextMetadata: SessionMetadata = {
      chatSessionId: input.chatSessionId === undefined ? metadata.chatSessionId : input.chatSessionId,
      chatProvider: input.chatProvider === undefined ? metadata.chatProvider : input.chatProvider,
    };
    const now = Date.now();
    const updated = await rows<SessionRow>(db, {
      q: `UPDATE workspace_sessions
          SET title = ?1, metadata_json = ?2, revision = revision + 1, updated_at = ?3
          WHERE id = ?4 AND workspace_id = ?5 AND revision = ?6 AND archived_at IS NULL
          RETURNING id, workspace_id, kind, title, metadata_json, revision,
                    created_at, updated_at, archived_at`,
      v: [
        input.title === undefined ? current.title : input.title,
        JSON.stringify(nextMetadata),
        now,
        id,
        access.workspace.id,
        input.revision,
      ],
    });
    const row = updated[0];
    if (row === undefined) throw new HttpError(409, "workspace session changed; reload and retry");
    return context.json<WorkspaceSessionResponse>({ session: sessionView(row) });
  });

  router.delete("/workspaces/:id/sessions/:sessionId", async (context) => {
    const access = await accessFor(context);
    requireSessionEditor(access);
    const id = sessionId(context.req.param("sessionId"));
    const revision = Number(context.req.header("if-match"));
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, "If-Match must be the session revision");
    }
    const archived = await rows(runtimeFactory(context).db, {
      q: `UPDATE workspace_sessions
          SET archived_at = ?1, updated_at = ?1, revision = revision + 1
          WHERE id = ?2 AND workspace_id = ?3 AND revision = ?4 AND archived_at IS NULL
          RETURNING id`,
      v: [Date.now(), id, access.workspace.id, revision],
    });
    if (archived.length !== 1) {
      const current = await sessionById(runtimeFactory(context).db, access.workspace.id, id);
      if (current === null || current.archived_at !== null) {
        throw new HttpError(404, "workspace session not found");
      }
      throw new HttpError(409, "workspace session changed; reload and retry");
    }
    return context.body(null, 204);
  });
}
