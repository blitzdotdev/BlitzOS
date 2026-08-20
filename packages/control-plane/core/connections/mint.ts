import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { first, rows } from "../db.js";
import { HttpError, isRecord, isString, readJson, requiredString } from "../http.js";
import { authenticateBox } from "../oauth.js";
import { providerManifest } from "./catalog/index.js";
import type { ProviderManifest } from "./catalog/types.js";
import { tombstoneSurfaces } from "./catalog/surfaces.js";
import { addConnectRoutes } from "./connect.js";
import { addConnectionHealthRoutes } from "./health.js";
import {
  createLease,
  listCredentialEvents,
  listLeases,
  revokeLease,
  staleSurfaceConnections,
} from "./leases.js";
import {
  connectionDefaultScopes,
  manifestAllows,
  scopesFromJson,
  usableByAllows,
} from "./manifest.js";
import { mintFromGrant } from "./minters/grant.js";
import { refreshedAccessToken } from "./minters/oauth.js";
import { openRoot } from "./root-crypto.js";
import { addProxyRoute } from "./proxy.js";
import { addRequestRoutes, fileRequest } from "./requests.js";
import {
  activeConnections,
  addConnectionRoutes,
  connectionByName,
  resolveMinter,
} from "./registry.js";
import type { Connection, MinterResult, MintRequest, MintResult } from "./types.js";
import type { GrantRow } from "./user-grants.js";
import {
  addUserGrantRoutes,
  grantConfig,
  grantFor,
  openGrantSecret,
} from "./user-grants.js";
import { canControlWorkspace } from "../workspace-access.js";

/** A tombstone carries no credential, so its horizon only has to outlast the
 * sync that applied it without shortening the box's freshness window. */
const TOMBSTONE_TTL_MS = 60 * 60 * 1_000;

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
  reason: string,
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
        reason,
        acting_principal: {
          userId: principal.id,
          membershipId: principal.membershipId,
        },
      }),
      now,
    ],
  });
}

/** What the owner consented to when they connected the provider, frozen at
 * that moment (migrations/0018). An empty list is not an empty consent: it is a
 * provider with no scope vocabulary — the generic entry — so there is nothing
 * to bound and the request stands as asked. */
function consentedScopes(grant: GrantRow, requested: readonly string[]): string[] {
  const consented = new Set(scopesFromJson(grant.scopes));
  if (consented.size === 0) return [...requested];
  return requested.filter((scope) => consented.has(scope));
}

/** The workspace's identity spine is its owner: one disk, one env, one value
 * per variable. Every mint resolves against the owner's grants no matter which
 * member's box triggered it. */
async function ownerGrantMint(
  runtime: ReturnType<RuntimeFactory>,
  grant: GrantRow,
  connection: Connection,
  request: MintRequest,
  scopes: string[],
): Promise<MinterResult> {
  const manifest = providerManifest(grant.manifest_id);
  if (manifest === null) {
    throw new HttpError(409, `connection grant names an unknown provider ${grant.manifest_id}`);
  }
  const config = grantConfig(grant);
  const { secret, accessExpiresAt } = await grantSecretForMint(
    runtime,
    manifest,
    grant,
    request.origin,
  );
  return mintFromGrant({
    manifest,
    grant,
    config,
    connection,
    request,
    secret,
    accessExpiresAt,
    scopes,
  });
}

/** A decrypted credential and the moment it dies. The expiry comes back with
 * the secret rather than being re-read off the grant row: a refresh rotates the
 * token and persists a new `access_expires_at`, and the row in hand predates
 * that write. Reading the stale row is how a refreshed grant mints a lease that
 * expired in the past, and every mint after the first expiry answers 409. */
interface MintSecret {
  secret: string;
  accessExpiresAt: number | null;
}

async function grantSecretForMint(
  runtime: ReturnType<RuntimeFactory>,
  manifest: ProviderManifest,
  grant: GrantRow,
  origin: string,
): Promise<MintSecret> {
  if (grant.kind === "pat") {
    const secret = await openGrantSecret(runtime.credentialMasterKey, grant, "refresh");
    if (secret === null) throw new HttpError(409, "connection grant has no stored key");
    return { secret, accessExpiresAt: null };
  }
  const auth = manifest.auth;
  if (auth === null) throw new HttpError(409, "connection grant needs re-authorization");
  const clientId = runtime.vars.connectSecret(auth.clientIdVar);
  const clientSecret = runtime.vars.connectSecret(auth.clientSecretVar);
  if (clientId === undefined || clientSecret === undefined) {
    throw new HttpError(409, `${manifest.title} is not configured on this instance`);
  }
  const access = await refreshedAccessToken(
    {
      db: runtime.db,
      key: runtime.credentialMasterKey,
      clientId,
      clientSecret,
      redirectUri: `${origin}${auth.redirectPath}`,
    },
    { ...manifest, auth },
    grant,
  );
  if (access === null) throw new HttpError(409, "connection grant needs re-authorization");
  return { secret: access.accessToken, accessExpiresAt: access.accessExpiresAt };
}

interface MintOneInput {
  workspace: WorkspaceCredentialRow;
  boxId: string;
  principal: Principal;
  origin: string;
  connection: Connection;
  scopes: string[];
  /** True when the box named the scopes. A named scope the owner never
   * consented to is an error; an unnamed default that falls outside consent is
   * simply narrowed, because a narrower consent must still deliver a narrower
   * credential rather than nothing at all. */
  scopesAreExplicit: boolean;
  denied: "error" | "skip";
}

async function mintOne(
  runtime: ReturnType<RuntimeFactory>,
  input: MintOneInput,
): Promise<MintResult | null> {
  const { workspace, boxId, principal, connection, denied } = input;
  const now = Date.now();
  const deny = async (reason: string, status: 403, message: string): Promise<null> => {
    if (denied === "skip") return null;
    await recordDenied(
      runtime,
      workspace.id,
      boxId,
      connection.name,
      input.scopes,
      now,
      principal,
      reason,
    );
    const requestId = await fileRequest(
      runtime.db,
      workspace.id,
      connection.name,
      input.scopes,
      { boxId, userId: principal.id },
      now,
    );
    throw new HttpError(status, message, requestId);
  };
  if (!authorize(principal, workspace, connection, input.scopes)) {
    // FROZEN box-route error text (the box CLI classifies by status, but the
    // string predates the rename and stays byte-identical).
    return deny(
      "outside credential ceiling",
      403,
      "credential mint exceeds the workspace manifest or integration allow-list",
    );
  }
  const grant = await grantFor(runtime.db, workspace.owner_id, connection.name);
  const minter = grant === null ? resolveMinter(connection) : null;
  if (grant === null && (minter === null || connection.root_ciphertext === null)) {
    // The connection is declared but nobody's identity backs it. That is the
    // connect inbox, not a failure: 404 is the status the box turns into
    // "not configured", and it carries the request id the panel resolves.
    if (denied === "skip") return null;
    const requestId = await fileRequest(
      runtime.db,
      workspace.id,
      connection.name,
      input.scopes,
      { boxId, userId: principal.id },
      now,
    );
    throw new HttpError(
      404,
      `connection ${connection.name} has no grant for the workspace owner`,
      requestId,
    );
  }
  // The consent the owner gave at connect time is the outer bound on every
  // mint. Without this the workspace ceiling is the only gate, and a ceiling
  // that names no scopes allows all of them — so a box could ask for `write`
  // against a grant the owner deliberately connected read-only.
  let scopes = input.scopes;
  if (grant !== null) {
    scopes = consentedScopes(grant, input.scopes);
    if (input.scopesAreExplicit && scopes.length !== input.scopes.length) {
      const excess = input.scopes.filter((scope) => !scopes.includes(scope));
      return deny(
        "outside owner consent",
        403,
        `credential mint exceeds the scopes ${connection.name} was connected with: ${excess.join(", ")}`,
      );
    }
  }
  const leaseId = crypto.randomUUID();
  const request: MintRequest = {
    workspaceId: workspace.id,
    boxId,
    principalId: principal.id,
    scopes,
    now,
    origin: input.origin,
    leaseId,
  };
  const minted = grant === null
    ? await legacyRootMint(runtime, connection, request)
    : await ownerGrantMint(runtime, grant, connection, request, scopes);
  // Everything a minter adds beyond the frozen four keys is stripped here: the
  // shipped box decodes this body with DisallowUnknownFields, so one extra key
  // fails the decode and the whole credential sync aborts.
  const { tokenHash = null, grantedScopes, ...result } = minted;
  await createLease(runtime.db, {
    id: leaseId,
    workspaceId: workspace.id,
    boxId,
    connectionId: connection.id,
    connectionName: connection.name,
    userId: workspace.owner_id,
    grantId: grant?.id ?? null,
    scopes: grantedScopes ?? scopes,
    result,
    tokenHash,
    now,
    principal,
  });
  return result;
}

/** Static org-root minting predates per-user grants. It stays for rows that
 * already carry a root; new product surface never creates one. */
async function legacyRootMint(
  runtime: ReturnType<RuntimeFactory>,
  connection: Connection,
  request: MintRequest,
): Promise<MinterResult> {
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
  return minter.mint(root, connection, request);
}

/** Tombstone results ride the same wire a live mint does: `inject` mode with
 * `unset-env` names and an empty-valued file. They create no lease, because
 * they carry no credential. */
async function surfaceTombstones(
  runtime: ReturnType<RuntimeFactory>,
  workspaceId: string,
  mintedConnectionIds: readonly string[],
  now = Date.now(),
): Promise<MintResult[]> {
  const results: MintResult[] = [];
  for (const stale of await staleSurfaceConnections(
    runtime.db,
    workspaceId,
    mintedConnectionIds,
    now,
  )) {
    const declared = parseConnectionSurfaceConfig(stale.config);
    if (declared === null) continue;
    const manifest = providerManifest(declared.manifestId);
    if (manifest === null) continue;
    results.push({
      // FROZEN box wire key: the shipped broker requires "integration".
      integration: stale.connection_name,
      mode: "inject",
      placements: tombstoneSurfaces(
        manifest,
        stale.connection_name,
        declared.environmentNames,
      ),
      expiresAt: now + TOMBSTONE_TTL_MS,
    });
  }
  return results;
}

interface ConnectionSurfaceConfig {
  manifestId: string;
  environmentNames: string[];
}

/** Catalog connections record which manifest wrote their surfaces and under
 * which names. A legacy static row has neither and needs no tombstone: its
 * environment file is replaced wholesale by the sync, and it wrote no skill. */
function parseConnectionSurfaceConfig(value: string): ConnectionSurfaceConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isString(parsed.manifest_id)) return null;
  const placements = Array.isArray(parsed.placements) ? parsed.placements : [];
  const environmentNames: string[] = [];
  for (const placement of placements) {
    if (isRecord(placement) && placement.kind === "env" && isString(placement.name)) {
      environmentNames.push(placement.name);
    }
  }
  return { manifestId: parsed.manifest_id, environmentNames };
}

export function addCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addConnectionRoutes(router, runtimeFactory, requirePrincipal);
  addUserGrantRoutes(router, runtimeFactory, requirePrincipal);
  addConnectionHealthRoutes(router, runtimeFactory, requirePrincipal);
  addConnectRoutes(router, runtimeFactory, requirePrincipal);
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
      const result = await mintOne(runtime, {
        workspace,
        boxId: box.id,
        principal: boxPrincipal,
        origin,
        connection,
        scopes: input.scopes ?? connectionDefaultScopes(connection),
        scopesAreExplicit: input.scopes !== undefined,
        denied: "error",
      });
      if (result === null) throw new Error("specific credential mint was skipped");
      return context.json(result);
    }

    const results: MintResult[] = [];
    const minted: string[] = [];
    for (const connection of await activeConnections(runtime.db, workspace.org_id)) {
      const result = await mintOne(runtime, {
        workspace,
        boxId: box.id,
        principal: boxPrincipal,
        origin,
        connection,
        scopes: connectionDefaultScopes(connection),
        scopesAreExplicit: false,
        denied: "skip",
      });
      if (result === null) continue;
      results.push(result);
      minted.push(connection.id);
    }
    results.push(...(await surfaceTombstones(runtime, workspace.id, minted)));
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
