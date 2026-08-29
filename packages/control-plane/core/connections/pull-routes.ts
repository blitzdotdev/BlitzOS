import { first, rows } from "../db.js";
import { HttpError, requiredString } from "../http.js";
import { authenticateBox } from "../oauth.js";
import type { Principal } from "../principals.js";
import type { CoreRouter, RuntimeFactory } from "../runtime.js";
import {
  liveWorkspaceCredentials,
  workspaceCredentialValue,
} from "../workspace-credentials.js";
import { connectionDefaultScopes, manifestConnectionNames } from "./manifest.js";
import { mintResultBody, parseMintResult } from "./pull-wire.js";
import { connectionByName } from "./registry.js";
import { fileRequest } from "./requests.js";
import type { MintResult, WorkspaceConnectionsResponse } from "./types.js";
import type { MintOneInput, MintOutcome, MintWorkspaceRow } from "./mint.js";

type MintOne = (
  runtime: ReturnType<RuntimeFactory>,
  input: MintOneInput,
) => Promise<MintOutcome | null>;

/**
 * A machine asking on its own behalf.
 *
 * There is no session here, so the acting principal is resolved from
 * `machines.membership_id` AT CALL TIME. Nothing about who the guest acts as
 * is stored beside its credential: the row that used to hold it pinned the
 * workspace OWNER, so every member's box minted as one person and every audit
 * row was written in that person's name. The machine's member IS the identity
 * now — nothing is borrowed, and there is no disclosure to make.
 */
interface MachineCaller {
  workspace: MintWorkspaceRow;
  machineId: string;
  principal: Principal;
}

async function boxCaller(
  runtime: ReturnType<RuntimeFactory>,
  request: Request,
): Promise<MachineCaller> {
  const box = await authenticateBox(request, runtime.db);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.workspaceId === null || box.membershipId === null) {
    throw new HttpError(409, "box has no workspace");
  }
  const workspace = await first<MintWorkspaceRow>(runtime.db, {
    q: `SELECT id, owner_id, manifest, org_id, owner_membership_id
        FROM workspaces WHERE id = ?1 AND deleted_at IS NULL LIMIT 1`,
    v: [box.workspaceId],
  });
  if (workspace === null) {
    throw new HttpError(409, "workspace is not ready for credential minting");
  }
  if (workspace.org_id === null) throw new HttpError(409, "workspace has no organization");
  const membership = await first<{ id: string; role: "admin" | "member" }>(runtime.db, {
    q: `SELECT id, role FROM memberships
        WHERE id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
    v: [box.membershipId, workspace.org_id],
  });
  return {
    workspace,
    machineId: box.id,
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

/** How long a workspace-credential answer stays valid to the asking agent.
 *
 * A workspace credential is a stored static, so there is nothing to expire
 * server-side. The pull wire requires an expiry all the same, and a short one
 * is the honest number: it says "ask again", which is the whole delivery
 * model, and it is what makes a revoke take effect on the next call. */
const WORKSPACE_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

/** The workspace-plane answer: the sealed value, served through the same wire
 * a connection mint uses so the box needs no second code path (§4 step 2). */
function workspaceCredentialMint(name: string, value: string, now: number): MintResult {
  return {
    connection: name,
    mode: "inject",
    token: value,
    env: [{ name, value }],
    header: { name: "Authorization", prefix: "Bearer " },
    expiresAt: now + WORKSPACE_CREDENTIAL_TTL_MS,
  };
}

/** One audit row per workspace-credential use. There is no lease to hang it
 * on — a workspace credential has no connection row — so the event names the
 * machine and its member directly. */
async function recordWorkspaceCredentialUse(
  runtime: ReturnType<RuntimeFactory>,
  workspaceId: string,
  machineId: string,
  name: string,
  principal: Principal,
  now: number,
): Promise<void> {
  await rows(runtime.db, {
    q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
        VALUES (NULL, 'minted', ?1, ?2)`,
    v: [
      JSON.stringify({
        workspace_credential: name,
        box_id: machineId,
        workspace_id: workspaceId,
        acting_principal: {
          userId: principal.id,
          membershipId: principal.membershipId,
        },
      }),
      now,
    ],
  });
}

/** What an agent inside a machine may ask for, and how it asks.
 *
 * Nothing is delivered ahead of use. The box reads the allow-list to know what
 * it may ask for, and mints one credential at the moment it needs it. The
 * allow-list is the workspace's connection ceiling PLUS its workspace
 * credential names, because `blitz-cred` is the single door to both planes
 * (plans/MEMBER-MACHINES.md §4). The manifest and the credential list are read
 * on every call, so a Disconnect or a revoke takes effect on the very next
 * pull rather than at the next sync cadence. */
function addBoxConnectionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  mintOne: MintOne,
): void {
  router.get("/workspaces/self/connections", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace } = await boxCaller(runtime, context.req.raw);
    const credentials = await liveWorkspaceCredentials(runtime.db, workspace.id);
    return context.json<WorkspaceConnectionsResponse>({
      connections: [...new Set([
        ...manifestConnectionNames(workspace.manifest),
        ...credentials.map(({ name }) => name),
      ])].sort(),
    });
  });

  // 403 with a request id is the refusal an agent can act on: the id is the
  // inbox row the member answers, and `blitz connections open <provider>` is
  // how the agent sends them there.
  router.post("/workspaces/self/connections/:name/token", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, machineId, principal } = await boxCaller(runtime, context.req.raw);
    const name = requiredString(context.req.param("name"), "name", 256);
    const connection = await connectionByName(runtime.db, name, workspace.org_id ?? "");
    if (connection === null) {
      // Personal plane first, then the workspace plane (§4). A connection is
      // the personal plane, so reaching here means the member has no grant
      // under this name and the workspace's own store is the next answer.
      const value = await workspaceCredentialValue(
        runtime.db,
        runtime.credentialMasterKey,
        workspace.id,
        name,
      );
      if (value !== null) {
        const now = Date.now();
        await recordWorkspaceCredentialUse(
          runtime,
          workspace.id,
          machineId,
          name,
          principal,
          now,
        );
        return context.json(parseMintResult(
          mintResultBody(workspaceCredentialMint(name, value, now)),
        ));
      }
      const requestId = await fileRequest(
        runtime.db,
        workspace.id,
        name,
        [],
        { boxId: machineId, userId: principal.id },
      );
      throw new HttpError(404, `connection ${name} is not configured`, requestId);
    }
    const outcome = await mintOne(runtime, {
      workspace,
      machineId,
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

export { addBoxConnectionRoutes };
