import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { first, rows } from "../db.js";
import { HttpError, requiredString } from "../http.js";
import { authenticateBox } from "../oauth.js";
import { providerManifest, providerRedirectPath } from "./catalog/index.js";
import type { ProviderManifest } from "./catalog/types.js";
import { addConnectRoutes } from "./connect.js";
import { addGithubRepositoryCheckRoutes } from "./github-repo-check.js";
import { addConnectionHealthRoutes } from "./health.js";
import {
  createLease,
  listCredentialEvents,
  listLeases,
  revokeLease,
  revokeWorkspaceConnectionLeasesQuery,
} from "./leases.js";
import {
  connectionDefaultScopes,
  manifestAllows,
  manifestConnectionNames,
  manifestWithConnection,
  manifestWithoutConnection,
  usableByAllows,
} from "./manifest.js";
import { mintFromGrant } from "./minters/grant.js";
import { refreshedAccessToken } from "./minters/oauth.js";
import { openRoot } from "./root-crypto.js";
import { addProxyRoute } from "./proxy.js";
import { mintResultBody, parseMintResult } from "./pull-wire.js";
import { addRequestRoutes, fileRequest } from "./requests.js";
import {
  addConnectionRoutes,
  connectionByName,
  connectionManifestId,
  resolveMinter,
} from "./registry.js";
import type {
  Connection,
  Lease,
  MinterResult,
  MintRequest,
  MintResult,
  WorkspaceConnectionsResponse,
} from "./types.js";
import type { GrantRow } from "./user-grants.js";
import {
  addUserGrantRoutes,
  grantConfig,
  grantFor,
  openGrantSecret,
} from "./user-grants.js";
import { canControlWorkspace } from "../workspace-access.js";

export interface WorkspaceCredentialRow {
  id: string;
  owner_id: string;
  phase: string;
  manifest: string | null;
  org_id: string | null;
  owner_membership_id: string | null;
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
  boxId: string | null,
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
      redirectUri: `${origin}${providerRedirectPath(manifest)}`,
    },
    { ...manifest, auth },
    grant,
  );
  if (access === null) throw new HttpError(409, "connection grant needs re-authorization");
  return { secret: access.accessToken, accessExpiresAt: access.accessExpiresAt };
}

/** What a mint produced: the credential for whoever asked, and the lease row
 * that records the workspace held it. */
export interface MintOutcome {
  result: MintResult;
  lease: Lease;
}

interface MintOneInput {
  workspace: WorkspaceCredentialRow;
  /** Null when a person minted from the webApp rather than a box syncing. */
  boxId: string | null;
  principal: Principal;
  origin: string;
  connection: Connection;
  scopes: string[];
  denied: "error" | "skip";
}

async function mintOne(
  runtime: ReturnType<RuntimeFactory>,
  input: MintOneInput,
): Promise<MintOutcome | null> {
  const { workspace, boxId, principal, connection, denied } = input;
  const now = Date.now();
  /** Both denials answer 403 and file a request: the box classifies by status,
   * and the inbox is how a person turns either one into a yes. A person who
   * clicked Connect is already that person, so their own refusal comes back as
   * the error rather than landing in their own inbox. */
  const deny = async (reason: string, message: string): Promise<null> => {
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
    const requestId = boxId === null ? undefined : await fileRequest(
      runtime.db,
      workspace.id,
      connection.name,
      input.scopes,
      { boxId, userId: principal.id },
      now,
    );
    throw new HttpError(403, message, requestId);
  };
  if (!authorize(principal, workspace, connection, input.scopes)) {
    return deny(
      "outside credential ceiling",
      `this workspace is not connected to ${connection.name}`,
    );
  }
  const grant = await grantFor(runtime.db, workspace.owner_id, connection.name);
  const minter = grant === null ? resolveMinter(connection) : null;
  if (grant === null && (minter === null || connection.root_ciphertext === null)) {
    // The connection is declared but nobody's identity backs it. That is the
    // connect inbox, not a failure: 404 is the status the box turns into
    // "not configured", and it carries the request id the panel resolves.
    if (denied === "skip") return null;
    const requestId = boxId === null ? undefined : await fileRequest(
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
  // The scopes pass through. A grant's stored scope list is the full manifest
  // vocabulary now, not a per-grant choice: a pasted key carries whatever the
  // person created it with, an OAuth token carries what the provider issued,
  // and neither can be narrowed after the fact. The workspace ceiling above is
  // the gate that still means something.
  const scopes = input.scopes;
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
  // Control-plane bookkeeping is stripped here: `tokenHash` is what the proxy
  // compares against and must never leave the control plane.
  const { tokenHash = null, grantedScopes, ...result } = minted;
  // The new lease supersedes the one this pair already held. Minting used to
  // stack another active row every time, so the panel showed duplicates and
  // the older proxy token stayed live for its whole TTL. Scoped to this
  // connection, so one pull never touches another provider.
  //
  // Accepted tradeoff: a value an agent exported into a shell that is still
  // open dies on the next pull. Pulling is cheap and per-use by design, so the
  // right answer to a dead value is to ask again.
  await rows(runtime.db, revokeWorkspaceConnectionLeasesQuery(workspace.id, connection.id));
  const lease = await createLease(runtime.db, {
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
  return { result, lease };
}

/** Connecting a provider inside the webApp: one workspace, one connection, one
 * lease, minted through the same machinery a box pull uses so the ceiling and
 * the owner's consent bound it identically. It proves the credential works
 * while the person is still looking at the panel. */
export async function mintWorkspaceConnection(
  runtime: ReturnType<RuntimeFactory>,
  input: {
    workspace: WorkspaceCredentialRow;
    principal: Principal;
    origin: string;
    connection: Connection;
    denied: "error" | "skip";
  },
): Promise<MintOutcome | null> {
  return mintOne(runtime, {
    workspace: input.workspace,
    boxId: null,
    principal: input.principal,
    origin: input.origin,
    connection: input.connection,
    // The grid asks for the connection, never for a scope list.
    scopes: connectionDefaultScopes(input.connection),
    denied: input.denied,
  });
}

/** The tail of an OAuth round trip that began inside a workspace. The round
 * trip was a Connect, so it does what Connect does: it writes the provider
 * into this workspace's manifest, then mints once to prove the grant works.
 *
 * Only a person who may control the workspace reaches here — `connect.ts`
 * checks that before the workspace id is signed into the OAuth state — so the
 * manifest write is the same authorized act the panel's Connect performs.
 *
 * Handed to the connect routes rather than imported by them, so `connect.ts`
 * stays a leaf of this module instead of importing back into it. */
async function connectAfterGrant(
  runtime: ReturnType<RuntimeFactory>,
  input: {
    workspaceId: string;
    principal: Principal;
    origin: string;
    connectionName: string;
  },
): Promise<boolean> {
  const workspace = await workspaceForMint(runtime, input.workspaceId);
  if (workspace === null || workspace.org_id === null
    || workspace.org_id !== input.principal.orgId) return false;
  if (!canControlWorkspace(input.principal, workspace)) return false;
  const connection = await connectionByName(
    runtime.db,
    input.connectionName,
    workspace.org_id,
  );
  if (connection === null) return false;
  const manifest = manifestWithConnection(workspace.manifest, connection.name);
  await rows(runtime.db, {
    q: "UPDATE workspaces SET manifest = ?1 WHERE id = ?2",
    v: [manifest, workspace.id],
  });
  try {
    const outcome = await mintWorkspaceConnection(runtime, {
      workspace: { ...workspace, manifest },
      principal: input.principal,
      origin: input.origin,
      connection,
      denied: "skip",
    });
    return outcome !== null;
  } catch (caught) {
    // A provider that needs re-authorization or is unconfigured on this
    // instance answers 409 from deep inside the minter. The grant is real
    // regardless, so the round trip lands rather than erroring the browser.
    if (caught instanceof HttpError) return false;
    throw caught;
  }
}

/** The workspace fields every mint needs, without the rest of the row. */
export async function workspaceForMint(
  runtime: ReturnType<RuntimeFactory>,
  workspaceId: string,
): Promise<WorkspaceCredentialRow | null> {
  return first<WorkspaceCredentialRow>(runtime.db, {
    q: `SELECT id, owner_id, phase, manifest, org_id, owner_membership_id
        FROM workspaces WHERE id = ?1 LIMIT 1`,
    v: [workspaceId],
  });
}

/** Static org-root minting predates per-user grants. It serves every row that
 * carries a sealed root, which the admin form on the template page still
 * creates: `PUT /connections/:name` is the org-credential path.
 *
 * The catalog owns the header shape when it knows the provider. A stored
 * cp-custody row carries no header, and Discord needs `Bot `, not `Bearer `:
 * an agent told to send `Bearer` reads Discord's 401 as a broken credential
 * and asks the person to reconnect a connection that was never broken. */
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
  const minted = await minter.mint(root, connection, request);
  const manifest = providerManifest(
    connectionManifestId(connection) ?? connection.provider,
  );
  return manifest === null ? minted : { ...minted, header: manifest.tokenHeader };
}

/** The workspace and provider a Connect or Disconnect names, once the caller
 * has proved they may control that workspace. Both routes need the identical
 * three checks, and a Disconnect that skipped one would be a way to edit
 * somebody else's ceiling. */
async function controllableWorkspaceConnection(
  runtime: ReturnType<RuntimeFactory>,
  context: CoreContext,
  principal: Principal,
): Promise<{ workspace: WorkspaceCredentialRow; name: string }> {
  const workspaceId = requiredString(context.req.param("id"), "id", 64);
  const name = requiredString(context.req.param("name"), "name", 256);
  const workspace = await workspaceForMint(runtime, workspaceId);
  if (workspace === null || workspace.org_id === null
    || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!canControlWorkspace(principal, workspace)) throw new HttpError(403, "forbidden");
  return { workspace, name };
}

/** A box asking on its own behalf. The box holds no person's session, so the
 * principal is assembled from the workspace's org membership: an agent inside
 * the box acts as the member who owns the box, and nothing wider. */
interface BoxCaller {
  workspace: WorkspaceCredentialRow;
  boxId: string;
  principal: Principal;
}

async function boxCaller(
  runtime: ReturnType<RuntimeFactory>,
  request: Request,
): Promise<BoxCaller> {
  const box = await authenticateBox(request, runtime.db);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.workspaceId === null) throw new HttpError(409, "box has no workspace");
  const workspace = await first<WorkspaceCredentialRow>(runtime.db, {
    q: `SELECT id, owner_id, phase, manifest, org_id, owner_membership_id
        FROM workspaces WHERE id = ?1 LIMIT 1`,
    v: [box.workspaceId],
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
  return {
    workspace,
    boxId: box.id,
    principal: {
      id: box.principalId,
      unixName: "blitz",
      harnesses: [],
      membershipId: membership?.id ?? null,
      orgId: membership === null ? null : workspace.org_id,
      role: membership?.role ?? null,
      platformOperator: box.platformOperator,
    },
  };
}

/** What an agent inside a box may ask for, and how it asks.
 *
 * Nothing is delivered ahead of use. The box reads the allow-list to know what
 * it may ask for, and mints one credential at the moment it needs it. The
 * manifest is read on every call, so a Disconnect in the panel takes effect on
 * the very next pull rather than at the next sync cadence. */
function addBoxConnectionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/workspaces/self/connections", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace } = await boxCaller(runtime, context.req.raw);
    return context.json<WorkspaceConnectionsResponse>({
      connections: manifestConnectionNames(workspace.manifest).sort(),
    });
  });

  // 403 with a request id is the refusal an agent can act on: the id is the
  // inbox row the member answers, and `blitz connections open <provider>` is
  // how the agent sends them there.
  router.post("/workspaces/self/connections/:name/token", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, boxId, principal } = await boxCaller(runtime, context.req.raw);
    const name = requiredString(context.req.param("name"), "name", 256);
    const connection = await connectionByName(runtime.db, name, workspace.org_id ?? "");
    if (connection === null) {
      const requestId = await fileRequest(
        runtime.db,
        workspace.id,
        name,
        [],
        { boxId, userId: principal.id },
      );
      throw new HttpError(404, `connection ${name} is not configured`, requestId);
    }
    const outcome = await mintOne(runtime, {
      workspace,
      boxId,
      principal,
      origin: new URL(context.req.url).origin,
      connection,
      scopes: connectionDefaultScopes(connection),
      denied: "error",
    });
    if (outcome === null) throw new Error("box credential mint was skipped");
    return context.json(parseMintResult(mintResultBody(outcome.result)));
  });
}

export function addCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addConnectionRoutes(router, runtimeFactory, requirePrincipal);
  addGithubRepositoryCheckRoutes(router, requirePrincipal);
  addUserGrantRoutes(router, runtimeFactory, requirePrincipal);
  addConnectionHealthRoutes(router, runtimeFactory, requirePrincipal);
  addConnectRoutes(router, runtimeFactory, requirePrincipal, connectAfterGrant);
  addRequestRoutes(router, runtimeFactory, requirePrincipal);
  addProxyRoute(router, runtimeFactory);

  addBoxConnectionRoutes(router, runtimeFactory);

  /** Connect, from the webApp. It writes the provider into this workspace's
   * manifest, then mints once so the person learns straight away whether the
   * credential behind it actually works. Session-authed and owner-or-admin.
   *
   * The manifest write comes first because the mint reads it: minting first
   * would refuse the very connection this call is authorizing. */
  router.post("/workspaces/:id/connections/:name/lease", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const { workspace, name } = await controllableWorkspaceConnection(
      runtime,
      context,
      principal,
    );
    const connection = await connectionByName(runtime.db, name, workspace.org_id ?? "");
    if (connection === null) throw new HttpError(404, `connection ${name} not found`);
    const manifest = manifestWithConnection(workspace.manifest, name);
    await rows(runtime.db, {
      q: "UPDATE workspaces SET manifest = ?1 WHERE id = ?2",
      v: [manifest, workspace.id],
    });
    const outcome = await mintWorkspaceConnection(runtime, {
      workspace: { ...workspace, manifest },
      principal,
      origin: new URL(context.req.url).origin,
      connection,
      denied: "error",
    });
    if (outcome === null) throw new Error("workspace connect mint was skipped");
    return context.json({ lease: outcome.lease });
  });

  /** Disconnect, from the webApp. It removes the provider from THIS
   * workspace's manifest and kills whatever this workspace already holds.
   *
   * The member's grant survives, so their other workspaces keep working and
   * reconnecting here is one click. Revoking everywhere is a different act and
   * lives in settings. The lease revoke is not optional bookkeeping: a proxy
   * lease token stays usable until its row dies, and a capability must not
   * outlive the grant that authorized it. */
  router.delete("/workspaces/:id/connections/:name", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const { workspace, name } = await controllableWorkspaceConnection(
      runtime,
      context,
      principal,
    );
    await rows(runtime.db, {
      q: "UPDATE workspaces SET manifest = ?1 WHERE id = ?2",
      v: [manifestWithoutConnection(workspace.manifest, name), workspace.id],
    });
    const connection = await connectionByName(runtime.db, name, workspace.org_id ?? "");
    if (connection !== null) {
      await rows(
        runtime.db,
        revokeWorkspaceConnectionLeasesQuery(workspace.id, connection.id),
      );
    }
    return context.body(null, 204);
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
