import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import { HttpError } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { parseManifest, usableByAllows } from "./manifest.js";
import { integrationByName } from "./registry.js";

type RequestState = "pending" | "approved" | "denied";

interface CredentialRequestRow {
  id: string;
  workspace_id: string;
  integration_name: string;
  requested_scopes: string;
  state: RequestState;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

interface RequestResolutionRow extends CredentialRequestRow {
  owner_id: string;
  manifest: string | null;
}

export interface CredentialRequestView {
  id: string;
  workspace_id: string;
  integration_name: string;
  requested_scopes: string[];
  created_at: number;
}

function scopesJson(scopes: readonly string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

function scopesFromJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((scope) => typeof scope === "string" && scope.length > 0)
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
  integrationName: string,
  requestedScopes: readonly string[],
  now = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  const requestedScopesJson = scopesJson(requestedScopes);
  const inserted = await rows<{ id: string }>(db, {
    q: `INSERT INTO credential_requests
        (id, workspace_id, integration_name, requested_scopes, state, created_at,
         resolved_at, resolved_by)
        VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL, NULL)
        ON CONFLICT DO NOTHING
        RETURNING id`,
    v: [id, workspaceId, integrationName, requestedScopesJson, now],
  });
  if (inserted[0] !== undefined) return inserted[0].id;
  const pending = await first<{ id: string }>(db, {
    q: `SELECT id FROM credential_requests
        WHERE workspace_id = ?1 AND integration_name = ?2
          AND requested_scopes = ?3 AND state = 'pending'
        LIMIT 1`,
    v: [workspaceId, integrationName, requestedScopesJson],
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
    q: `SELECT request.*, workspace.owner_id, workspace.manifest
        FROM credential_requests request
        JOIN workspaces workspace ON workspace.id = request.workspace_id
        WHERE request.id = ?1 LIMIT 1`,
    v: [requestId],
  });
  if (
    request === null ||
    (principal.id !== "operator" && request.owner_id !== principal.id)
  ) {
    throw new HttpError(404, "credential request not found");
  }
  if (request.state !== "pending") {
    throw new HttpError(409, "credential request is not pending");
  }
  return request;
}

async function requireGrantableIntegration(
  db: Db,
  request: RequestResolutionRow,
): Promise<void> {
  const integration = await integrationByName(db, request.integration_name);
  if (integration === null) {
    throw new HttpError(409, "integration is not configured");
  }
  if (!usableByAllows(integration, request.owner_id)) {
    throw new HttpError(403, "integration is not available to the workspace owner");
  }
}

function widenedManifest(
  storedManifest: string | null,
  integrationName: string,
  requestedScopes: readonly string[],
): string | null {
  if (storedManifest === null) return null;
  let manifest: ReturnType<typeof parseManifest>;
  try {
    manifest = parseManifest(JSON.parse(storedManifest));
  } catch {
    throw new HttpError(409, "workspace credential manifest is invalid");
  }
  const current = manifest.integrations[integrationName];
  if (current === undefined) {
    manifest.integrations[integrationName] = { scopes: [...requestedScopes] };
  } else if (current.scopes !== undefined) {
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
  await requireGrantableIntegration(db, request);
  const requestedScopes = scopesFromJson(request.requested_scopes);
  const manifest = widenedManifest(
    request.manifest,
    request.integration_name,
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
        JSON.stringify({
          integration: request.integration_name,
          scopes: requestedScopes,
          workspace_id: request.workspace_id,
          resolved_by: principal.id,
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
  const resolved = await rows(db, {
    q: `UPDATE credential_requests
        SET state = 'denied', resolved_at = ?1, resolved_by = ?2
        WHERE id = ?3 AND state = 'pending'
        RETURNING id`,
    v: [now, principal.id, request.id],
  });
  if (resolved.length !== 1) {
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
          AND (?2 = 'operator' OR workspace.owner_id = ?2)
        ORDER BY request.created_at, request.id`,
    v: [state, principal.id],
  });
  return requests.map((request) => ({
    id: request.id,
    workspace_id: request.workspace_id,
    integration_name: request.integration_name,
    requested_scopes: scopesFromJson(request.requested_scopes),
    created_at: request.created_at,
  }));
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
