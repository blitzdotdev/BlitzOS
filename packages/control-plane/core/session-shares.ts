/**
 * Opt-in per-session sharing (plans/LODY-SHARING.md, plans/LODY-SESSIONS.md
 * §0.1).
 *
 * A Lody session is private to the member whose box runs it. A row in
 * `session_shares` is one deliberate grant to one other member of the same
 * workspace, and this module owns three things: the rows, the routes that write
 * them, and the ticket claim the proxy mints from them.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT KNOW. Which sessions exist. The daemon
 * on the owner's box is the only thing that does, so `session_id` is opaque
 * bounded text here and a row naming a session nobody holds grants access to
 * nothing — the relay's ACL is an intersection with what the daemon actually
 * has (§1.1).
 */
import { first, rows } from "./db.js";
import type { Db } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import {
  isWorkspaceAdmin,
  storedRole,
  workspaceAccess,
  type WorkspaceAccess,
} from "./workspace-access.js";
import { drainWorkspaceMemberConnections } from "./workspace-drain.js";
import { workspaceById, type WorkspaceRow } from "./workspace-records.js";
import { MAX_TICKET_SHARE_SESSIONS, type WebAppShareClaim } from "./webapp-tickets.js";
import type {
  GrantSessionShareRequest,
  ListSessionSharesResponse,
  SessionShareLevel,
  SessionShareView,
} from "./wire.js";

/** A session id the daemon minted. Bounded, not validated: see the module
 * comment. */
const MAX_SESSION_ID_LENGTH = 256;

interface SessionShareRow {
  id: string;
  session_id: string;
  owner_membership_id: string;
  grantee_membership_id: string;
  level: SessionShareLevel;
  created_at: number;
  created_by_membership_id: string;
}

function shareView(row: SessionShareRow): SessionShareView {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerMembershipId: row.owner_membership_id,
    granteeMembershipId: row.grantee_membership_id,
    level: row.level,
    createdAt: row.created_at,
    createdByMembershipId: row.created_by_membership_id,
  };
}

const SHARE_COLUMNS =
  "id, session_id, owner_membership_id, grantee_membership_id, level, created_at, created_by_membership_id";

/** Every grant a member holds on ONE other member's machine, newest first.
 *
 * This is the mint path and it runs on every proxied request to a shared box, so
 * it is one indexed read and it is capped in SQL rather than in JavaScript. */
export async function sharesOnTargetMachine(
  db: Db,
  workspaceId: string,
  granteeMembershipId: string,
  targetMembershipId: string,
): Promise<SessionShareRow[]> {
  return await rows<SessionShareRow>(db, {
    q: `SELECT ${SHARE_COLUMNS} FROM session_shares
        WHERE workspace_id = ?1 AND grantee_membership_id = ?2
          AND owner_membership_id = ?3
        ORDER BY created_at DESC, id DESC
        LIMIT ?4`,
    v: [workspaceId, granteeMembershipId, targetMembershipId, MAX_TICKET_SHARE_SESSIONS],
  });
}

/**
 * The `share` claim for a request routed at `targetMembershipId`, or `null`
 * when the caller has no business on that machine.
 *
 * Two rules beyond reading the rows, both from §1.2 and §3.3:
 *
 * - A workspace admin holds `scope: "all"` whether or not rows exist. Their
 *   `write` list is still only their REAL read-write grants, never populated
 *   from the role — which is what makes the implicit access read-only.
 * - A grantee whose workspace role is `viewer` has every row demoted to `read`.
 *   Demotion to viewer must not leave a live write grant, and the ROW is left
 *   alone rather than rewritten, so a re-promotion restores it.
 */
export async function shareClaimForTarget(
  db: Db,
  workspaceId: string,
  grantee: { membershipId: string; access: WorkspaceAccess },
  targetMembershipId: string,
): Promise<WebAppShareClaim | null> {
  const granted = await sharesOnTargetMachine(
    db,
    workspaceId,
    grantee.membershipId,
    targetMembershipId,
  );
  const admin = isWorkspaceAdmin(grantee.access);
  if (granted.length === 0 && !admin) return null;
  const writable = grantee.access.stored === "viewer" ? [] : granted.filter((row) => row.level === "rw");
  const write = writable.map((row) => row.session_id);
  const read = granted
    .map((row) => row.session_id)
    .filter((sessionId) => !write.includes(sessionId));
  return { target: targetMembershipId, scope: admin ? "all" : "sessions", read, write };
}

function parseLevel(value: JsonValue | undefined): SessionShareLevel {
  if (value === "ro" || value === "rw") return value;
  throw new HttpError(400, "level must be 'ro' or 'rw'");
}

function parseGrant(value: JsonValue): GrantSessionShareRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const request: GrantSessionShareRequest = {
    sessionId: requiredString(value.sessionId, "sessionId", MAX_SESSION_ID_LENGTH),
    granteeMembershipId: requiredString(value.granteeMembershipId, "granteeMembershipId", 128),
    level: parseLevel(value.level),
  };
  if (value.ownerMembershipId !== undefined) {
    request.ownerMembershipId = requiredString(value.ownerMembershipId, "ownerMembershipId", 128);
  }
  return request;
}

interface ShareCaller {
  workspace: WorkspaceRow;
  membershipId: string;
  access: WorkspaceAccess;
}

/** Resolves the caller against the workspace. 404 rather than 403 for another
 * org's workspace, like every other route here. */
async function shareCaller(
  db: Db,
  principal: Principal,
  id: string,
): Promise<ShareCaller> {
  const workspace = await workspaceById(db, id);
  if (
    workspace === null
    || principal.orgId === null
    || workspace.org_id !== principal.orgId
    || workspace.deleted_at !== null
  ) throw new HttpError(404, "workspace not found");
  const access = await workspaceAccess(db, principal, workspace);
  if (access.stored === null && !access.orgAdmin && !access.owner) {
    throw new HttpError(403, "forbidden");
  }
  if (principal.membershipId === null) throw new HttpError(403, "active membership required");
  return { workspace, membershipId: principal.membershipId, access };
}

export function addSessionShareRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  /**
   * Both halves of one screen (§1.3): `granted` is what the caller may manage,
   * `received` is what other members shared with them. One route, because the
   * share dialog reads the first and the rail reads the second, and two routes
   * would be two round trips on the same page.
   */
  router.get("/workspaces/:id/session-shares", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const caller = await shareCaller(runtime.db, principal, context.req.param("id"));
    const sessionId = new URL(context.req.url).searchParams.get("sessionId");
    const admin = isWorkspaceAdmin(caller.access);
    const granted = await rows<SessionShareRow>(runtime.db, {
      q: `SELECT ${SHARE_COLUMNS} FROM session_shares
          WHERE workspace_id = ?1
            AND (?2 = 1 OR owner_membership_id = ?3)
            AND (?4 IS NULL OR session_id = ?4)
          ORDER BY created_at DESC, id DESC`,
      v: [caller.workspace.id, admin ? 1 : 0, caller.membershipId, sessionId],
    });
    const received = await rows<SessionShareRow>(runtime.db, {
      q: `SELECT ${SHARE_COLUMNS} FROM session_shares
          WHERE workspace_id = ?1 AND grantee_membership_id = ?2
          ORDER BY created_at DESC, id DESC`,
      v: [caller.workspace.id, caller.membershipId],
    });
    return context.json<ListSessionSharesResponse>({
      granted: granted.map(shareView),
      received: received.map(shareView),
    });
  });

  /**
   * Grant, or change a grant's level.
   *
   * `ownerMembershipId` defaults to the caller, which is an owner sharing their
   * own session. A workspace admin may name another member — that is how §0.1's
   * "workspace admins grant/revoke" works without the admin owning the session
   * — and nobody else may.
   *
   * The owner is NOT verified against the box. The control plane cannot ask a
   * machine "do you hold this session?" without a box-facing call that does not
   * exist, so a wrong owner routes the grantee at a machine that answers
   * `session_not_found`, and grants nothing (§1.1).
   */
  router.put("/workspaces/:id/session-shares", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const caller = await shareCaller(runtime.db, principal, context.req.param("id"));
    const input = parseGrant(await readJson(context.req.raw, 4 * 1024));
    const admin = isWorkspaceAdmin(caller.access);
    const owner = input.ownerMembershipId ?? caller.membershipId;
    if (owner !== caller.membershipId && !admin) {
      throw new HttpError(403, "only the session's owner or a workspace admin may share it");
    }
    if (input.granteeMembershipId === owner) {
      throw new HttpError(400, "a session is already available to its owner");
    }
    const granteeRole = await storedRole(
      runtime.db,
      caller.workspace.id,
      input.granteeMembershipId,
    );
    // Membership in THIS workspace, not just the org: a share is a workspace
    // act, and an org colleague who is not in the workspace has no seat here.
    const granteeIsOwner = caller.workspace.owner_membership_id === input.granteeMembershipId;
    if (granteeRole === null && !granteeIsOwner) {
      throw new HttpError(404, "that member is not in this workspace");
    }
    if (input.level === "rw" && granteeRole === "viewer") {
      throw new HttpError(400, "a workspace viewer may only receive read-only access");
    }
    const existing = await first<SessionShareRow>(runtime.db, {
      q: `SELECT ${SHARE_COLUMNS} FROM session_shares
          WHERE workspace_id = ?1 AND session_id = ?2 AND grantee_membership_id = ?3`,
      v: [caller.workspace.id, input.sessionId, input.granteeMembershipId],
    });
    if (existing !== null) {
      const updated = await first<SessionShareRow>(runtime.db, {
        q: `UPDATE session_shares SET level = ?2, owner_membership_id = ?3
            WHERE id = ?1 RETURNING ${SHARE_COLUMNS}`,
        v: [existing.id, input.level, owner],
      });
      if (updated === null) throw new Error("session share disappeared during update");
      return context.json<SessionShareView>(shareView(updated), 200);
    }
    const created = await first<SessionShareRow>(runtime.db, {
      q: `INSERT INTO session_shares
            (id, workspace_id, session_id, owner_membership_id, grantee_membership_id,
             level, created_at, created_by_membership_id)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          RETURNING ${SHARE_COLUMNS}`,
      v: [
        crypto.randomUUID(),
        caller.workspace.id,
        input.sessionId,
        owner,
        input.granteeMembershipId,
        input.level,
        Date.now(),
        caller.membershipId,
      ],
    });
    if (created === null) throw new Error("session share insert produced no row");
    return context.json<SessionShareView>(shareView(created), 201);
  });

  /**
   * Revoke.
   *
   * Two things happen and only the first is durable: the row goes, so the next
   * mint answers 403; and the grantee's live connections to the owner's box are
   * closed. A failed drain does not fail the revoke — the row is already gone
   * and the next connect is refused either way — but the difference between
   * "revoked" and "revoked and disconnected" is a minute of a live session, so
   * it is attempted (§5).
   */
  router.delete("/workspaces/:id/session-shares/:shareId", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const caller = await shareCaller(runtime.db, principal, context.req.param("id"));
    const admin = isWorkspaceAdmin(caller.access);
    const removed = await first<SessionShareRow>(runtime.db, {
      q: `DELETE FROM session_shares
          WHERE workspace_id = ?1 AND id = ?2 AND (?3 = 1 OR owner_membership_id = ?4)
          RETURNING ${SHARE_COLUMNS}`,
      v: [caller.workspace.id, context.req.param("shareId"), admin ? 1 : 0, caller.membershipId],
    });
    if (removed === null) throw new HttpError(404, "session share not found");
    const stillShared = await first<{ id: string }>(runtime.db, {
      q: `SELECT id FROM session_shares
          WHERE workspace_id = ?1 AND grantee_membership_id = ?2 AND owner_membership_id = ?3
          LIMIT 1`,
      v: [caller.workspace.id, removed.grantee_membership_id, removed.owner_membership_id],
    });
    // Only when nothing is left: a drain closes EVERY connection the grantee
    // holds to that box, so doing it while other grants survive would cut the
    // sessions they still hold.
    //
    // And it cannot fail the revoke. The row is already gone, so the grantee's
    // next connect is refused whatever happens here; answering 500 would tell
    // the caller to retry a delete that already succeeded, and would leave the
    // UI showing a grant that no longer exists (§5).
    if (stillShared === null) {
      try {
        await drainWorkspaceMemberConnections(
          runtime,
          caller.workspace.id,
          removed.owner_membership_id,
          removed.grantee_membership_id,
        );
      } catch {
        // See above. What is lost is the seconds between here and the ticket's
        // own 60-second expiry, on a connection the next request cannot renew.
      }
    }
    return context.body(null, 204);
  });
}
