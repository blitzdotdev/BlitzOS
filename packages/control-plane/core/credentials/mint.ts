import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { first, rows } from "../db.js";
import { HttpError, isRecord, isString, readJson, requiredString } from "../http.js";
import { authenticateBox } from "../oauth.js";
import {
  createLease,
  listLeases,
  revokeLease,
} from "./leases.js";
import {
  integrationDefaultScopes,
  manifestAllows,
  usableByAllows,
} from "./manifest.js";
import { openRoot } from "./root-crypto.js";
import { addProxyRoute } from "./proxy.js";
import { addRequestRoutes, fileRequest } from "./requests.js";
import {
  activeIntegrations,
  addIntegrationRoutes,
  integrationByName,
  resolveMinter,
} from "./registry.js";
import type { Integration, MintResult } from "./types.js";
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
  integration: Integration,
  requestedScopes: readonly string[],
): boolean {
  const callerIsAdminOrOwner = canControlWorkspace(principal, workspace);
  const requestFitsCeiling =
    manifestAllows(workspace.manifest, integration.name, requestedScopes) &&
    usableByAllows(integration, principal.id);
  return callerIsAdminOrOwner && requestFitsCeiling;
}

async function recordDenied(
  runtime: ReturnType<RuntimeFactory>,
  workspaceId: string,
  boxId: string,
  integrationName: string,
  scopes: readonly string[],
  now: number,
): Promise<void> {
  await rows(runtime.db, {
    q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
        VALUES (NULL, 'denied', ?1, ?2)`,
    v: [
      JSON.stringify({
        integration: integrationName,
        scopes,
        box_id: boxId,
        workspace_id: workspaceId,
        reason: "outside credential ceiling",
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
  integration: Integration,
  scopes: string[],
  denied: "error" | "skip",
): Promise<MintResult | null> {
  const now = Date.now();
  if (!authorize(principal, workspace, integration, scopes)) {
    if (denied === "skip") return null;
    await recordDenied(
      runtime,
      workspace.id,
      boxId,
      integration.name,
      scopes,
      now,
    );
    const requestId = await fileRequest(
      runtime.db,
      workspace.id,
      integration.name,
      scopes,
      now,
    );
    throw new HttpError(
      403,
      "credential mint exceeds the workspace manifest or integration allow-list",
      requestId,
    );
  }
  const minter = resolveMinter(integration);
  if (minter === null) {
    throw new HttpError(409, "integration credential mechanism is unavailable");
  }
  const root =
    integration.root_ciphertext === null
      ? null
      : await openRoot(
          runtime.credentialMasterKey,
          integration.name,
          integration.root_ciphertext,
        );
  const leaseId = crypto.randomUUID();
  const minted = await minter.mint(root, integration, {
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
    integrationId: integration.id,
    integrationName: integration.name,
    scopes: result.grantedScopes ?? scopes,
    result,
    tokenHash,
    now,
  });
  return result;
}

export function addCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addIntegrationRoutes(router, runtimeFactory, requirePrincipal);
  addRequestRoutes(router, runtimeFactory, requirePrincipal);
  addProxyRoute(router, runtimeFactory);

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
      const integration = await integrationByName(runtime.db, input.integration, workspace.org_id);
      if (integration === null) {
        const requestId = await fileRequest(
          runtime.db,
          workspace.id,
          input.integration,
          input.scopes ?? [],
        );
        throw new HttpError(404, "integration not found", requestId);
      }
      const scopes = input.scopes ?? integrationDefaultScopes(integration);
      const result = await mintOne(
        runtime,
        workspace,
        box.id,
        boxPrincipal,
        origin,
        integration,
        scopes,
        "error",
      );
      if (result === null) throw new Error("specific credential mint was skipped");
      return context.json(result);
    }

    const results: MintResult[] = [];
    for (const integration of await activeIntegrations(runtime.db, workspace.org_id)) {
      const result = await mintOne(
        runtime,
        workspace,
        box.id,
        boxPrincipal,
        origin,
        integration,
        integrationDefaultScopes(integration),
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
