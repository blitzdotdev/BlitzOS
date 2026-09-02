import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import { HttpError, isRecord, isString, type JsonValue } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { type CredentialManifest, parseManifest } from "./manifest.js";
import { connectionByName } from "./registry.js";
import { isWorkspaceAdmin, workspaceAccess } from "../workspace-access.js";

type RequestState = "pending" | "approved" | "denied";

interface CredentialRequestRow {
  id: string;
  workspace_id: string;
  connection_name: string;
  requested_scopes: string;
  state: RequestState;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  requester: string | null;
}

export interface CredentialRequester {
  boxId: string;
  userId: string;
}

interface RequestResolutionRow extends CredentialRequestRow {
  owner_id: string;
  manifest: string | null;
  org_id: string | null;
  owner_membership_id: string | null;
}

export interface CredentialRequestView {
  id: string;
  workspace_id: string;
  connection_name: string;
  requested_scopes: string[];
  created_at: number;
  requester: CredentialRequester | null;
}

function scopesJson(scopes: readonly string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

function scopesFromJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((scope) => isString(scope) && scope.length > 0)
    ) {
      return parsed;
    }
  } catch {
    // Stored request data is validated below.
  }
  throw new HttpError(409, "credential request scopes are invalid");
}

export async function fileRequest(
  db: Db,
  workspaceId: string,
  connectionName: string,
  requestedScopes: readonly string[],
  requester: CredentialRequester,
  now = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  const requestedScopesJson = scopesJson(requestedScopes);
  const inserted = await rows<{ id: string }>(db, {
    q: `INSERT INTO credential_requests
        (id, workspace_id, connection_name, requested_scopes, state, created_at,
         resolved_at, resolved_by, requester)
        VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL, NULL, ?6)
        ON CONFLICT DO NOTHING
        RETURNING id`,
    v: [id, workspaceId, connectionName, requestedScopesJson, now, JSON.stringify(requester)],
  });
  if (inserted[0] !== undefined) return inserted[0].id;
  const pending = await first<{ id: string }>(db, {
    q: `SELECT id FROM credential_requests
        WHERE workspace_id = ?1 AND connection_name = ?2
          AND requested_scopes = ?3 AND state = 'pending'
        LIMIT 1`,
    v: [workspaceId, connectionName, requestedScopesJson],
  });
  if (pending === null) throw new Error("pending credential request disappeared");
  return pending.id;
}

async function requestForResolution(
  db: Db,
  requestId: string,
  principal: Principal,
): Promise<RequestResolutionRow> {
  const request = await first<RequestResolutionRow>(db, {
    q: `SELECT request.*, workspace.owner_id, workspace.manifest,
               workspace.org_id, workspace.owner_membership_id
        FROM credential_requests request
        JOIN workspaces workspace ON workspace.id = request.workspace_id
        WHERE request.id = ?1 LIMIT 1`,
    v: [requestId],
  });
  if (request === null || request.org_id !== principal.orgId) {
    throw new HttpError(404, "credential request not found");
  }
  if (!isWorkspaceAdmin(await workspaceAccess(db, principal, {
    id: request.workspace_id,
    org_id: request.org_id,
    owner_membership_id: request.owner_membership_id,
  }))) throw new HttpError(403, "forbidden");
  if (request.state !== "pending") {
    throw new HttpError(409, "credential request is not pending");
  }
  return request;
}

async function requireGrantableConnection(
  db: Db,
  request: RequestResolutionRow,
): Promise<void> {
  if (request.org_id === null) throw new HttpError(409, "workspace has no organization");
  const connection = await connectionByName(db, request.connection_name, request.org_id);
  if (connection === null) {
    throw new HttpError(409, "connection is not configured");
  }
}

/** Approving a request is the person saying yes to this workspace holding this
 * connection, so it writes the name into the ceiling.
 *
 * A NULL column is a workspace created before the column existed. It now
 * denies everything, so approving has to build a real document rather than
 * write NULL back — that write used to be a silent no-op, and the agent that
 * filed the request was refused again on its next pull. */
function widenedManifest(
  storedManifest: string | null,
  connectionName: string,
  requestedScopes: readonly string[],
): string {
  let manifest: CredentialManifest = { integrations: {} };
  if (storedManifest !== null) {
    try {
      manifest = parseManifest(JSON.parse(storedManifest));
    } catch {
      throw new HttpError(409, "workspace credential manifest is invalid");
    }
  }
  const current = manifest.integrations[connectionName];
  if (current === undefined) {
    manifest.integrations[connectionName] = { scopes: [...requestedScopes] };
  } else if (current.scopes !== undefined) {
    // SAFETY: parseManifest establishes that a present scopes member is a string array.
    const allowed = new Set(current.scopes as string[]);
    for (const scope of requestedScopes) allowed.add(scope);
    current.scopes = [...allowed];
  }
  return JSON.stringify(manifest);
}

export async function approve(
  db: Db,
  requestId: string,
  principal: Principal,
  now = Date.now(),
): Promise<void> {
  const request = await requestForResolution(db, requestId, principal);
  await requireGrantableConnection(db, request);
  const requestedScopes = scopesFromJson(request.requested_scopes);
  const manifest = widenedManifest(
    request.manifest,
    request.connection_name,
    requestedScopes,
  );
  const result = await transaction(db, [
    {
      q: `UPDATE workspaces SET manifest = ?1
          WHERE id = ?2 AND EXISTS (
            SELECT 1 FROM credential_requests
            WHERE id = ?3 AND state = 'pending'
          )`,
      v: [manifest, request.workspace_id, request.id],
    },
    {
      q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
          SELECT NULL, 'approved', ?1, ?2
          WHERE EXISTS (
            SELECT 1 FROM credential_requests
            WHERE id = ?3 AND state = 'pending'
          )`,
      v: [
        // Audit detail keeps the pre-rename "integration" key: credential_events
        // is append-only and older rows cannot be rewritten.
        JSON.stringify({
          integration: request.connection_name,
          scopes: requestedScopes,
          workspace_id: request.workspace_id,
          resolved_by: principal.id,
          acting_principal: {
            userId: principal.id,
            membershipId: principal.membershipId,
          },
        }),
        now,
        request.id,
      ],
    },
    {
      q: `UPDATE credential_requests
          SET state = 'approved', resolved_at = ?1, resolved_by = ?2
          WHERE id = ?3 AND state = 'pending'
          RETURNING id`,
      v: [now, principal.id, request.id],
    },
  ]);
  if (result[2]?.length !== 1) {
    throw new HttpError(409, "credential request is not pending");
  }
}

export async function deny(
  db: Db,
  requestId: string,
  principal: Principal,
  now = Date.now(),
): Promise<void> {
  const request = await requestForResolution(db, requestId, principal);
  const result = await transaction(db, [
    {
      q: `UPDATE credential_requests
          SET state = 'denied', resolved_at = ?1, resolved_by = ?2
          WHERE id = ?3 AND state = 'pending'
          RETURNING id`,
      v: [now, principal.id, request.id],
    },
    {
      q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
          SELECT NULL, 'denied', ?1, ?2
          WHERE EXISTS (
            SELECT 1 FROM credential_requests
            WHERE id = ?3 AND state = 'denied' AND resolved_at = ?2
          )`,
      v: [
        // Audit detail keeps the pre-rename "integration" key (see approve).
        JSON.stringify({
          integration: request.connection_name,
          scopes: scopesFromJson(request.requested_scopes),
          workspace_id: request.workspace_id,
          resolution: "denied",
          acting_principal: {
            userId: principal.id,
            membershipId: principal.membershipId,
          },
        }),
        now,
        request.id,
      ],
    },
  ]);
  if (result[0]?.length !== 1) {
    throw new HttpError(409, "credential request is not pending");
  }
}

export async function listRequests(
  db: Db,
  principal: Principal,
  state: RequestState,
): Promise<CredentialRequestView[]> {
  const requests = await rows<CredentialRequestRow>(db, {
    q: `SELECT request.*
        FROM credential_requests request
        JOIN workspaces workspace ON workspace.id = request.workspace_id
        WHERE request.state = ?1
          AND workspace.org_id = ?2
          AND (?3 = 'admin' OR workspace.owner_membership_id = ?4)
        ORDER BY request.created_at, request.id`,
    v: [state, principal.orgId, principal.role, principal.membershipId],
  });
  return requests.map((request) => ({
    id: request.id,
    workspace_id: request.workspace_id,
    connection_name: request.connection_name,
    requested_scopes: scopesFromJson(request.requested_scopes),
    created_at: request.created_at,
    requester: requesterFromJson(request.requester),
  }));
}

function requesterFromJson(value: string | null): CredentialRequester | null {
  if (value === null) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(409, "credential request requester is invalid");
  }
  if (
    !isRecord(parsed)
    || Object.keys(parsed).sort().join(",") !== "boxId,userId"
  ) throw new HttpError(409, "credential request requester is invalid");
  if (!isString(parsed.boxId) || !isString(parsed.userId)) {
    throw new HttpError(409, "credential request requester is invalid");
  }
  return { boxId: parsed.boxId, userId: parsed.userId };
}

function requestState(value: string | null): RequestState {
  const state = value ?? "pending";
  if (state !== "pending" && state !== "approved" && state !== "denied") {
    throw new HttpError(400, "state must be pending, approved, or denied");
  }
  return state;
}

export function addRequestRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/requests", async (context) => {
    const principal = await requirePrincipal(context);
    const state = requestState(new URL(context.req.url).searchParams.get("state"));
    return context.json({
      requests: await listRequests(runtimeFactory(context).db, principal, state),
    });
  });

  router.post("/requests/:id/approve", async (context) => {
    const principal = await requirePrincipal(context);
    await approve(runtimeFactory(context).db, context.req.param("id"), principal);
    return context.body(null, 204);
  });

  router.post("/requests/:id/deny", async (context) => {
    const principal = await requirePrincipal(context);
    await deny(runtimeFactory(context).db, context.req.param("id"), principal);
    return context.body(null, 204);
  });
}
