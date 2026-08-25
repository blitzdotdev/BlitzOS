import type { Db } from "./db.js";
import { rows } from "./db.js";
import {
  HttpError,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isNumber,
  isRecord,
  isString,
  readJson,
} from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { webAppWorkspaceForRequest, workspaceRole } from "./workspace-access.js";
import type {
  PresenceActivityView,
  PresenceMemberState,
  PresenceMemberView,
  PresenceSnapshotResponse,
  PresenceSurfaceInput,
  PresenceSurfaceView,
  PutPresenceConnectionRequest,
  WorkspaceSessionKind,
} from "./wire.js";
import { PRESENCE_CONNECTION_TTL_MS } from "./wire.js";

const MAX_PRESENCE_BODY_BYTES = 4 * 1024;
/** Connections one snapshot carries. Beyond this the least active connections
 * are dropped and the response says so, rather than failing the whole
 * organization's presence once it grows past a threshold. */
export const MAX_SNAPSHOT_CONNECTIONS = 200;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const EXPIRY_SWEEP_LIMIT = 100;
/** Live connections one membership may hold. A browser with sessionStorage
 * blocked mints a fresh clientId per load, and a hostile member could mint
 * them at will; either way one member must not be able to fill the snapshot
 * on their own. The oldest connections beyond the cap are dropped on PUT. */
export const MAX_CONNECTIONS_PER_MEMBERSHIP = 16;

interface PresenceViewDocument {
  surfaces: PresenceSurfaceInput[];
  focusedSurface: number | null;
}

interface PresenceConnectionRow {
  membership_id: string;
  user_id: string;
  user_name: string | null;
  user_email: string;
  avatar_url: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_org_id: string | null;
  workspace_owner_membership_id: string | null;
  workspace_org_share_role: "editor" | "viewer" | null;
  observer_grant_role: "editor" | "viewer" | null;
  view_json: string;
  focused: number;
  visible: number;
  last_seen_at: number;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  kind: WorkspaceSessionKind;
  title: string | null;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function boundedId(value: JsonValue | undefined, field: string): string {
  if (
    !isString(value)
    || value.length === 0
    || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) throw new HttpError(400, `${field} is invalid`);
  return value;
}

function safeLabel(value: JsonValue | undefined, field: string): string {
  if (!isString(value)) throw new HttpError(400, `${field} is invalid`);
  const label = value.trim();
  if (
    label.length === 0
    || label.length > 128
    || /[/\\\u0000-\u001f\u007f]/u.test(label)
  ) throw new HttpError(400, `${field} is invalid`);
  return label;
}

function parseSurface(value: JsonValue | undefined, index: number): PresenceSurfaceInput {
  if (!isRecord(value) || !isString(value.kind)) {
    throw new HttpError(400, `surfaces[${index}] is invalid`);
  }
  const kind: string = value.kind;
  if (kind === "session") {
    if (!exactKeys(value, ["kind", "sessionId"])) {
      throw new HttpError(400, `surfaces[${index}] is invalid`);
    }
    return { kind: "session", sessionId: boundedId(value.sessionId, `surfaces[${index}].sessionId`) };
  }
  if (kind === "file" || kind === "preview") {
    if (!exactKeys(value, ["kind", "surfaceId", "label"])) {
      throw new HttpError(400, `surfaces[${index}] is invalid`);
    }
    return {
      kind,
      surfaceId: boundedId(value.surfaceId, `surfaces[${index}].surfaceId`),
      label: safeLabel(value.label, `surfaces[${index}].label`),
    };
  }
  if (kind === "panel") {
    if (
      !exactKeys(value, ["kind", "panel"])
      || (value.panel !== "files" && value.panel !== "previews" && value.panel !== "connections")
    ) throw new HttpError(400, `surfaces[${index}] is invalid`);
    return { kind: "panel", panel: value.panel };
  }
  if (kind === "workspace" && exactKeys(value, ["kind"])) {
    return { kind: "workspace" };
  }
  throw new HttpError(400, `surfaces[${index}] is invalid`);
}

function parseViewDocument(value: JsonValue, field = "request"): PresenceViewDocument {
  if (!isRecord(value) || !exactKeys(value, ["surfaces", "focusedSurface"])) {
    throw new HttpError(400, `${field} view is invalid`);
  }
  if (!Array.isArray(value.surfaces) || value.surfaces.length > 2) {
    throw new HttpError(400, `${field}.surfaces must contain at most two items`);
  }
  const surfaces = value.surfaces.map(parseSurface);
  const focusedSurface = value.focusedSurface;
  if (
    focusedSurface !== null
    && (
      !isNumber(focusedSurface)
      || !Number.isSafeInteger(focusedSurface)
      || focusedSurface < 0
      || focusedSurface >= surfaces.length
    )
  ) throw new HttpError(400, `${field}.focusedSurface is invalid`);
  return { surfaces, focusedSurface };
}

function parsePutRequest(value: JsonValue): PutPresenceConnectionRequest {
  if (
    !isRecord(value)
    || !exactKeys(value, ["workspaceId", "surfaces", "focusedSurface", "visible", "focused"])
    || !isBoolean(value.visible)
    || !isBoolean(value.focused)
    || (value.workspaceId !== null && !isString(value.workspaceId))
  ) throw new HttpError(400, "request is invalid");
  if (value.focused && !value.visible) throw new HttpError(400, "a focused connection must be visible");
  const view = parseViewDocument({
    surfaces: value.surfaces ?? null,
    focusedSurface: value.focusedSurface ?? null,
  });
  if (value.workspaceId === null && (view.surfaces.length !== 0 || view.focusedSurface !== null)) {
    throw new HttpError(400, "organization activity cannot include workspace surfaces");
  }
  return {
    workspaceId: value.workspaceId === null ? null : boundedId(value.workspaceId, "workspaceId"),
    surfaces: view.surfaces,
    focusedSurface: view.focusedSurface,
    visible: value.visible,
    focused: value.focused,
  };
}

/** A stored view that today's parser rejects (only reachable after the
 * allowlist changes underneath a live row) degrades to "in the workspace"
 * rather than failing the whole organization's snapshot; the next heartbeat,
 * at most 15 seconds later, rewrites the row. */
const WORKSPACE_ONLY_VIEW: PresenceViewDocument = {
  surfaces: [{ kind: "workspace" }],
  focusedSurface: 0,
};

function storedView(raw: string): PresenceViewDocument {
  try {
    return parseViewDocument(JSON.parse(raw), "stored presence");
  } catch {
    return WORKSPACE_ONLY_VIEW;
  }
}

async function sweepExpired(db: Db, cutoff: number): Promise<void> {
  await rows(db, {
    q: `DELETE FROM presence_connections
        WHERE rowid IN (
          SELECT rowid FROM presence_connections
          WHERE last_seen_at < ?1
          ORDER BY last_seen_at
          LIMIT ?2
        )`,
    v: [cutoff, EXPIRY_SWEEP_LIMIT],
  });
}

async function trimMembershipConnections(db: Db, membershipId: string): Promise<void> {
  await rows(db, {
    q: `DELETE FROM presence_connections
        WHERE membership_id = ?1 AND client_id NOT IN (
          SELECT client_id FROM presence_connections
          WHERE membership_id = ?1
          ORDER BY last_seen_at DESC, client_id
          LIMIT ?2
        )`,
    v: [membershipId, MAX_CONNECTIONS_PER_MEMBERSHIP],
  });
}

async function validateSessions(
  db: Db,
  workspaceId: string,
  surfaces: readonly PresenceSurfaceInput[],
): Promise<void> {
  const sessionIds = surfaces.flatMap((surface) => surface.kind === "session" ? [surface.sessionId] : []);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new HttpError(400, "a session may appear only once");
  }
  if (sessionIds.length === 0) return;
  const sessions = await rows<Pick<SessionRow, "id">>(db, {
    q: `SELECT id FROM workspace_sessions
        WHERE workspace_id = ?1 AND archived_at IS NULL
          AND id IN (${sessionIds.map((_, index) => `?${index + 2}`).join(", ")})`,
    v: [workspaceId, ...sessionIds],
  });
  if (sessions.length !== sessionIds.length) {
    throw new HttpError(400, "presence references an invalid session");
  }
}

function memberState(rowsForMember: readonly PresenceConnectionRow[]): PresenceMemberState {
  if (rowsForMember.some((row) => row.focused === 1 && row.visible === 1)) return "active";
  if (rowsForMember.some((row) => row.visible === 1)) return "online";
  return "away";
}

/** The observer sees exact activity only where the ordinary workspace access
 * rule grants them any role. One rule, shared with every webApp route, so
 * presence can never disclose a workspace its owner could not open. */
function canSeeWorkspace(
  principal: Principal,
  row: PresenceConnectionRow,
): boolean {
  return row.workspace_id !== null && workspaceRole(principal, {
    id: row.workspace_id,
    org_id: row.workspace_org_id,
    owner_membership_id: row.workspace_owner_membership_id,
    grant_role: row.observer_grant_role,
    org_share_role: row.workspace_org_share_role,
  }) !== null;
}

function sessionSurface(
  surface: PresenceSurfaceInput,
  workspaceId: string,
  sessions: ReadonlyMap<string, SessionRow>,
): PresenceSurfaceView | null {
  if (surface.kind !== "session") return surface;
  const session = sessions.get(surface.sessionId);
  if (session === undefined || session.workspace_id !== workspaceId) return null;
  return {
    kind: "session",
    sessionId: session.id,
    sessionKind: session.kind,
    title: session.title,
  };
}

function activityFor(
  principal: Principal,
  row: PresenceConnectionRow,
  sessions: ReadonlyMap<string, SessionRow>,
): PresenceActivityView {
  const base = {
    visible: row.visible === 1,
    focused: row.focused === 1,
    lastSeenAt: row.last_seen_at,
  };
  if (row.workspace_id === null) return { ...base, location: "organization" };
  if (row.workspace_name === null || !canSeeWorkspace(principal, row)) {
    return { ...base, location: "other-workspace" };
  }
  const view = storedView(row.view_json);
  const normalizedSurfaces = view.surfaces.flatMap((surface, sourceIndex) => {
    const normalized = sessionSurface(surface, row.workspace_id ?? "", sessions);
    return normalized === null ? [] : [{ sourceIndex, surface: normalized }];
  });
  const focusedSurface = view.focusedSurface === null
    ? null
    : normalizedSurfaces.findIndex(({ sourceIndex }) => sourceIndex === view.focusedSurface);
  return {
    ...base,
    location: "workspace",
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    surfaces: normalizedSurfaces.map(({ surface }) => surface),
    focusedSurface: focusedSurface === null || focusedSurface < 0 ? null : focusedSurface,
  };
}

function mergeRedactedActivity(
  activities: PresenceActivityView[],
  activity: PresenceActivityView,
): void {
  if (activity.location !== "other-workspace") {
    activities.push(activity);
    return;
  }
  const existing = activities.find((candidate) => candidate.location === "other-workspace");
  if (existing === undefined) {
    activities.push(activity);
    return;
  }
  existing.visible = existing.visible || activity.visible;
  existing.focused = existing.focused || activity.focused;
  existing.lastSeenAt = Math.max(existing.lastSeenAt, activity.lastSeenAt);
}

async function snapshot(
  db: Db,
  principal: Principal,
  now: number,
): Promise<PresenceSnapshotResponse> {
  if (principal.orgId === null || principal.membershipId === null) {
    throw new HttpError(403, "active membership required");
  }
  // Expired rows are filtered by the cutoff below and swept on the write
  // paths, so the org's most frequent request stays a pure read.
  const cutoff = now - PRESENCE_CONNECTION_TTL_MS;
  const queried = await rows<PresenceConnectionRow>(db, {
    q: `SELECT pc.membership_id, m.user_id, u.name AS user_name, u.email AS user_email,
               u.avatar_url, pc.workspace_id, w.name AS workspace_name,
               w.org_id AS workspace_org_id,
               w.owner_membership_id AS workspace_owner_membership_id,
               w.org_share_role AS workspace_org_share_role,
               observer_grant.role AS observer_grant_role,
               pc.view_json, pc.focused, pc.visible, pc.last_seen_at
        FROM presence_connections pc
        JOIN memberships m ON m.id = pc.membership_id AND m.status = 'active'
        JOIN users u ON u.id = m.user_id
        LEFT JOIN workspaces w
          ON w.id = pc.workspace_id AND w.org_id = m.org_id AND w.phase != 'destroyed'
        LEFT JOIN workspace_grants observer_grant
          ON observer_grant.workspace_id = pc.workspace_id
         AND observer_grant.membership_id = ?2
        WHERE m.org_id = ?1 AND pc.last_seen_at >= ?3
          AND (pc.workspace_id IS NULL OR w.id IS NOT NULL)
        ORDER BY pc.focused DESC, pc.visible DESC, pc.last_seen_at DESC
        LIMIT ?4`,
    v: [principal.orgId, principal.membershipId, cutoff, MAX_SNAPSHOT_CONNECTIONS + 1],
  });
  // The ORDER BY puts focused, then visible, then most recent connections
  // first, so what a truncated snapshot drops is the least active tail.
  let truncated = queried.length > MAX_SNAPSHOT_CONNECTIONS;
  const connectionRows = truncated ? queried.slice(0, MAX_SNAPSHOT_CONNECTIONS) : queried;

  const referencedSessionIds = new Set<string>();
  for (const row of connectionRows) {
    if (row.workspace_id === null || !canSeeWorkspace(principal, row)) continue;
    for (const surface of storedView(row.view_json).surfaces) {
      if (surface.kind === "session") referencedSessionIds.add(surface.sessionId);
    }
  }
  const sessionIds = [...referencedSessionIds];
  const sessionRows = sessionIds.length === 0
    ? []
    : await rows<SessionRow>(db, {
        q: `SELECT id, workspace_id, kind, title FROM workspace_sessions
            WHERE archived_at IS NULL
              AND id IN (${sessionIds.map((_, index) => `?${index + 1}`).join(", ")})`,
        v: sessionIds,
      });
  const sessions = new Map(sessionRows.map((session) => [session.id, session]));

  const grouped = new Map<string, PresenceConnectionRow[]>();
  for (const row of connectionRows) {
    const current = grouped.get(row.membership_id) ?? [];
    current.push(row);
    grouped.set(row.membership_id, current);
  }
  const stateOrder = { active: 0, online: 1, away: 2 } as const;
  const members: PresenceMemberView[] = [...grouped.values()].map((memberRows) => {
    const firstRow = memberRows[0];
    if (firstRow === undefined) throw new Error("presence member group is empty");
    const activities: PresenceActivityView[] = [];
    for (const row of memberRows) mergeRedactedActivity(activities, activityFor(principal, row, sessions));
    return {
      membershipId: firstRow.membership_id,
      userId: firstRow.user_id,
      name: firstRow.user_name?.trim() || firstRow.user_email,
      avatarUrl: firstRow.avatar_url,
      state: memberState(memberRows),
      activities,
    };
  }).sort((left, right) => (
    stateOrder[left.state] - stateOrder[right.state]
    || left.name.localeCompare(right.name)
    || left.membershipId.localeCompare(right.membershipId)
  ));
  const encoder = new TextEncoder();
  const encodedBytes = (): number => encoder.encode(JSON.stringify({
    serverTime: now,
    expiresAfterMs: PRESENCE_CONNECTION_TTL_MS,
    truncated,
    members,
  })).byteLength;
  // Members are sorted most active first, so the byte cap also sheds the tail.
  while (encodedBytes() > MAX_SNAPSHOT_BYTES && members.length > 0) {
    members.pop();
    truncated = true;
  }
  return { serverTime: now, expiresAfterMs: PRESENCE_CONNECTION_TTL_MS, truncated, members };
}

export function addPresenceRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.put("/presence/connections/:clientId", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.membershipId === null || principal.orgId === null) {
      throw new HttpError(403, "active membership required");
    }
    const clientId = boundedId(context.req.param("clientId"), "clientId");
    const input = parsePutRequest(await readJson(context.req.raw, MAX_PRESENCE_BODY_BYTES));
    const db = runtimeFactory(context).db;
    if (input.workspaceId !== null) {
      const access = await webAppWorkspaceForRequest(
        runtimeFactory(context),
        async () => principal,
        context,
        input.workspaceId,
      );
      if (access.workspace.phase === "destroyed") throw new HttpError(404, "workspace not found");
      await validateSessions(db, input.workspaceId, input.surfaces);
    }
    const now = Date.now();
    await sweepExpired(db, now - PRESENCE_CONNECTION_TTL_MS);
    const view: PresenceViewDocument = {
      surfaces: input.surfaces,
      focusedSurface: input.focusedSurface,
    };
    await rows(db, {
      q: `INSERT INTO presence_connections
          (membership_id, client_id, workspace_id, view_json, focused, visible,
           last_seen_at, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
          ON CONFLICT(membership_id, client_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            view_json = excluded.view_json,
            focused = excluded.focused,
            visible = excluded.visible,
            last_seen_at = excluded.last_seen_at`,
      v: [
        principal.membershipId,
        clientId,
        input.workspaceId,
        JSON.stringify(view),
        input.focused ? 1 : 0,
        input.visible ? 1 : 0,
        now,
      ],
    });
    await trimMembershipConnections(db, principal.membershipId);
    return context.body(null, 204);
  });

  router.delete("/presence/connections/:clientId", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.membershipId === null) throw new HttpError(403, "active membership required");
    const clientId = boundedId(context.req.param("clientId"), "clientId");
    const db = runtimeFactory(context).db;
    await rows(db, {
      q: "DELETE FROM presence_connections WHERE membership_id = ?1 AND client_id = ?2",
      v: [principal.membershipId, clientId],
    });
    await sweepExpired(db, Date.now() - PRESENCE_CONNECTION_TTL_MS);
    return context.body(null, 204);
  });

  router.get("/presence", async (context) => {
    const principal = await requirePrincipal(context);
    return context.json(await snapshot(runtimeFactory(context).db, principal, Date.now()));
  });
}
