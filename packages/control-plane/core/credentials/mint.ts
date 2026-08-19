import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { first, rows } from "../db.js";
import { HttpError, isRecord, isString, readJson, requiredString } from "../http.js";
import { authenticateBox } from "../oauth.js";
import {
  createLease,
  listCredentialEvents,
  listLeases,
  revokeLease,
} from "./leases.js";
import {
  connectionDefaultScopes,
  manifestAllows,
  usableByAllows,
} from "./manifest.js";
import { openRoot } from "./root-crypto.js";
import { addProxyRoute } from "./proxy.js";
import { addRequestRoutes, fileRequest } from "./requests.js";
import {
  activeConnections,
  addConnectionRoutes,
  connectionByName,
  resolveMinter,
} from "./registry.js";
import type { Connection, MintResult } from "./types.js";
import { canControlWorkspace } from "../workspace-access.js";

interface WorkspaceCredentialRow {
  id: string;
  owner_id: string;
  phase: string;
  manifest: string | null;
  org_id: string | null;
  owner_membership_id: string | null;
}

interface ParsedMintBody {
  integration?: string;
  scopes?: string[];
}

function parseScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((scope) => isString(scope) && scope.length > 0)
  ) {
    throw new HttpError(400, "scopes must be an array of non-empty strings");
  }
  return [...new Set(value)];
}

/** FROZEN box wire: the shipped box image's blitz-cred sends the request body
 * key "integration" to POST /workspaces/self/credentials. Keep accepting it
 * byte-for-byte; the product noun rename must not touch this route. */
function parseMintBody(value: unknown): ParsedMintBody {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: ParsedMintBody = {};
  if (value.integration !== undefined) {
    result.integration = requiredString(value.integration, "integration", 256);
  }
  if (value.scopes !== undefined) result.scopes = parseScopes(value.scopes);
  if (result.integration === undefined && result.scopes !== undefined) {
    throw new HttpError(400, "scopes require an integration");
  }
  return result;
}

export function authorize(
  principal: Principal,
  workspace: WorkspaceCredentialRow,
  connection: Connection,
  requestedScopes: readonly string[],
): boolean {
  const callerIsAdminOrOwner = canControlWorkspace(principal, workspace);
  const requestFitsCeiling =
    manifestAllows(workspace.manifest, connection.name, requestedScopes) &&
    usableByAllows(connection, principal.id);
  return callerIsAdminOrOwner && requestFitsCeiling;
}

async function recordDenied(
  runtime: ReturnType<RuntimeFactory>,
  workspaceId: string,
  boxId: string,
  connectionName: string,
  scopes: readonly string[],
  now: number,
  principal: Principal,
): Promise<void> {
  await rows(runtime.db, {
    q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
        VALUES (NULL, 'denied', ?1, ?2)`,
    v: [
      // The detail key stays "integration": credential_events is append-only
      // audit data, and rows written before the connection rename cannot be
      // rewritten, so new rows keep the stored key uniform.
      JSON.stringify({
        integration: connectionName,
        scopes,
        box_id: boxId,
        workspace_id: workspaceId,
        reason: "outside credential ceiling",
        acting_principal: {
          userId: principal.id,
          membershipId: principal.membershipId,
        },
      }),
      now,
    ],
  });
}

async function mintOne(
  runtime: ReturnType<RuntimeFactory>,
  workspace: WorkspaceCredentialRow,
  boxId: string,
  principal: Principal,
  origin: string,
  connection: Connection,
  scopes: string[],
  denied: "error" | "skip",
): Promise<MintResult | null> {
  const now = Date.now();
  if (!authorize(principal, workspace, connection, scopes)) {
    if (denied === "skip") return null;
    await recordDenied(
      runtime,
      workspace.id,
      boxId,
      connection.name,
      scopes,
      now,
      principal,
    );
    const requestId = await fileRequest(
      runtime.db,
      workspace.id,
      connection.name,
      scopes,
      { boxId, userId: principal.id },
      now,
    );
    // FROZEN box-route error text (the box CLI classifies by status, but the
    // string predates the rename and stays byte-identical).
    throw new HttpError(
      403,
      "credential mint exceeds the workspace manifest or integration allow-list",
      requestId,
    );
  }
  const minter = resolveMinter(connection);
  if (minter === null) {
    throw new HttpError(409, "integration credential mechanism is unavailable");
  }
  const root =
    connection.root_ciphertext === null
      ? null
      : await openRoot(
          runtime.credentialMasterKey,
          connection.name,
          connection.root_ciphertext,
        );
  const leaseId = crypto.randomUUID();
  const minted = await minter.mint(root, connection, {
    workspaceId: workspace.id,
    boxId,
    principalId: principal.id,
    scopes,
    now,
    origin,
    leaseId,
  });
  const { tokenHash = null, ...result } = minted;
  await createLease(runtime.db, {
    id: leaseId,
    workspaceId: workspace.id,
    boxId,
    connectionId: connection.id,
    connectionName: connection.name,
    scopes: result.grantedScopes ?? scopes,
    result,
    tokenHash,
    now,
    principal,
  });
  return result;
}

export function addCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addConnectionRoutes(router, runtimeFactory, requirePrincipal);
  addRequestRoutes(router, runtimeFactory, requirePrincipal);
  addProxyRoute(router, runtimeFactory);

  // FROZEN box wire: the Go broker in the shipped box image calls this route
  // and decodes the response with DisallowUnknownFields. The path, the body
  // key "integration", the response keys integration/mode/placements/
  // expiresAt, and the error body key request_id may not change.
  router.post("/workspaces/:id/credentials", async (context) => {
    const runtime = runtimeFactory(context);
    const box = await authenticateBox(context.req.raw, runtime.db);
    if (box === null) throw new HttpError(401, "invalid box access token");
    const idParam = context.req.param("id");
    const workspaceId = idParam === "self" ? box.workspaceId : idParam;
    if (box.workspaceId !== workspaceId) {
      throw new HttpError(403, "a box may only mint for its own workspace");
    }
    const workspace = await first<WorkspaceCredentialRow>(runtime.db, {
      q: `SELECT id, owner_id, phase, manifest, org_id, owner_membership_id
          FROM workspaces WHERE id = ?1 LIMIT 1`,
      v: [workspaceId],
    });
    if (workspace === null || workspace.phase !== "ready") {
      throw new HttpError(409, "workspace is not ready for credential minting");
    }
    if (workspace.org_id === null) throw new HttpError(409, "workspace has no organization");
    const membership = await first<{ id: string; role: "admin" | "member" }>(runtime.db, {
      q: `SELECT id, role FROM memberships
          WHERE user_id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
      v: [box.principalId, workspace.org_id],
    });
    const boxPrincipal: Principal = {
      id: box.principalId,
      unixName: "blitz",
      harnesses: [],
      membershipId: membership?.id ?? null,
      orgId: membership === null ? null : workspace.org_id,
      role: membership?.role ?? null,
      platformOperator: box.platformOperator,
    };
    const input = parseMintBody(await readJson(context.req.raw));
    const origin = new URL(context.req.url).origin;
    if (input.integration !== undefined) {
      const connection = await connectionByName(runtime.db, input.integration, workspace.org_id);
      if (connection === null) {
        const requestId = await fileRequest(
          runtime.db,
          workspace.id,
          input.integration,
          input.scopes ?? [],
          { boxId: box.id, userId: boxPrincipal.id },
        );
        // FROZEN box-route error text (see the route comment above).
        throw new HttpError(404, "integration not found", requestId);
      }
      const scopes = input.scopes ?? connectionDefaultScopes(connection);
      const result = await mintOne(
        runtime,
        workspace,
        box.id,
        boxPrincipal,
        origin,
        connection,
        scopes,
        "error",
      );
      if (result === null) throw new Error("specific credential mint was skipped");
      return context.json(result);
    }

    const results: MintResult[] = [];
    for (const connection of await activeConnections(runtime.db, workspace.org_id)) {
      const result = await mintOne(
        runtime,
        workspace,
        box.id,
        boxPrincipal,
        origin,
        connection,
        connectionDefaultScopes(connection),
        "skip",
      );
      if (result !== null) results.push(result);
    }
    return context.json(results);
  });

  router.get("/workspaces/:id/leases", async (context) => {
    const principal = await requirePrincipal(context);
    return context.json({
      leases: await listLeases(
        runtimeFactory(context).db,
        context.req.param("id"),
        principal,
      ),
    });
  });

  router.get("/workspaces/:id/credential-events", async (context) => {
    const principal = await requirePrincipal(context);
    return context.json({
      events: await listCredentialEvents(
        runtimeFactory(context).db,
        context.req.param("id"),
        principal,
      ),
    });
  });

  router.delete("/leases/:id", async (context) => {
    const principal = await requirePrincipal(context);
    await revokeLease(
      runtimeFactory(context).db,
      context.req.param("id"),
      principal,
    );
    return context.body(null, 204);
  });
}
