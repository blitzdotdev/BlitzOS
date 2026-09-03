import { connectionDefaultScopes, manifestConnectionNames } from "./connections/manifest.js";
import { mintOne, type MintWorkspaceRow } from "./connections/mint.js";
import { connectionByName } from "./connections/registry.js";
import { fileRequest } from "./connections/requests.js";
import { first } from "./db.js";
import { HttpError, isRecord, readJson, requiredString } from "./http.js";
import { authenticateBox, machinePrincipal } from "./oauth.js";
import {
  liveOrgCredentials,
  orgCredentialAccess,
  orgCredentialByName,
  orgCredentialValue,
  orgCredentialView,
  parseCredentialComment,
  parseCredentialValue,
  putOrgCredential,
  recordOrgCredentialUse,
  ORG_CREDENTIAL_MAX_BYTES,
  ORG_CREDENTIAL_NAME,
  type OrgCredentialCaller,
  type PutOrgCredentialInput,
} from "./org-credentials.js";
import {
  importOrgCredentials,
  parseImportRequest,
  IMPORT_TEXT_MAX_BYTES,
} from "./org-credential-import.js";
import type { Principal } from "./principals.js";
import type { CoreRouter, RuntimeFactory } from "./runtime.js";
import type {
  AgentCredentialEntry,
  AgentCredentialsResponse,
  AgentCredentialTokenResponse,
  ImportOrgCredentialsResponse,
  PutAgentCredentialRequest,
  PutOrgCredentialResponse,
} from "./wire.js";

/**
 * The agent plane (plans/ORG-CREDENTIALS.md §4): plain HTTP under `/agent/`,
 * box-authed through `boxCaller`. There is no credential CLI any more — an
 * agent drives these routes with curl and a bearer from `blitz-cred
 * api-token`, and the box bakes no wire shape in.
 */

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
export interface MachineCaller {
  workspace: MintWorkspaceRow & { org_id: string };
  machineId: string;
  principal: Principal;
}

export async function boxCaller(
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
  const readyWorkspace = { ...workspace, org_id: workspace.org_id };
  const membership = await first<{ id: string; role: "admin" | "member" }>(runtime.db, {
    q: `SELECT id, role FROM memberships
        WHERE id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
    v: [box.membershipId, workspace.org_id],
  });
  return {
    workspace: readyWorkspace,
    machineId: box.id,
    principal: machinePrincipal(
      box,
      membership === null
        ? null
        : { id: membership.id, orgId: workspace.org_id, role: membership.role },
    ),
  };
}

/** The §6 caller context for a machine: the machine's workspace, and its
 * member resolved at call time. A workspace grant covers every member machine
 * in that workspace; a membership grant follows the person onto any of their
 * machines in the org. */
function machineCredentialCaller(caller: MachineCaller): OrgCredentialCaller {
  return {
    workspaceId: caller.workspace.id,
    membershipId: caller.principal.membershipId,
    orgRole: caller.principal.role,
  };
}

export function addAgentRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  /** What an agent may ask for, and what it may change. Nothing is delivered
   * ahead of use: the list is names, scopes and comments, never a value. The
   * manifest and the grants are read on every call, so a Disconnect or a
   * grant edit takes effect on the very next request. */
  router.get("/agent/credentials", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    const access = machineCredentialCaller(caller);
    const orgCredentials = await liveOrgCredentials(runtime.db, caller.workspace.org_id);
    const entries: AgentCredentialEntry[] = [
      ...manifestConnectionNames(caller.workspace.manifest).map(
        (name): AgentCredentialEntry => ({
          name,
          scope: "connection",
          comment: null,
          writable: false,
        }),
      ),
      ...orgCredentials.flatMap((credential): AgentCredentialEntry[] => {
        const decision = orgCredentialAccess(credential, access);
        if (!decision.read) return [];
        return [{
          name: credential.name,
          scope: "org",
          comment: credential.comment,
          writable: decision.write,
        }];
      }),
    ].sort((a, b) => {
      // Plain byte order, deliberately not localeCompare: the list must sort
      // the same on every runtime that renders it.
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
      return 0;
    });
    return context.json<AgentCredentialsResponse>({ credentials: entries });
  });

  /** Resolution (§6): org connection row → org credential the caller may
   * read → file the request and 404. The 404 carries the request id the
   * connect inbox resolves, and `blitz connections open <provider>` is how
   * the agent sends the person there. */
  router.post("/agent/credentials/:name/token", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    const { workspace, machineId, principal } = caller;
    const name = requiredString(context.req.param("name"), "name", 256);
    const orgId = caller.workspace.org_id;
    const connection = await connectionByName(runtime.db, name, orgId);
    if (connection !== null) {
      const outcome = await mintOne(runtime, {
        workspace,
        machineId,
        principal,
        origin: new URL(context.req.url).origin,
        connection,
        scopes: connectionDefaultScopes(connection),
        denied: "error",
      });
      if (outcome === null) throw new Error("agent credential mint was skipped");
      const { result } = outcome;
      return context.json<AgentCredentialTokenResponse>({
        name: result.connection,
        scope: "connection",
        token: result.token,
        env: result.env,
        header: result.header,
        expiresAt: result.expiresAt,
      });
    }
    const credential = await orgCredentialByName(runtime.db, orgId, name);
    if (
      credential !== null
      && orgCredentialAccess(credential, machineCredentialCaller(caller)).read
    ) {
      const value = await orgCredentialValue(
        runtime.db,
        runtime.credentialMasterKey,
        orgId,
        name,
      );
      if (value !== null) {
        const now = Date.now();
        await recordOrgCredentialUse(runtime, {
          credentialId: credential.id,
          name,
          workspaceId: workspace.id,
          machineId,
          principal,
        }, now);
        return context.json<AgentCredentialTokenResponse>({
          name,
          scope: "org",
          token: value,
          env: [{ name, value }],
        });
      }
    }
    const requestId = await fileRequest(
      runtime.db,
      workspace.id,
      name,
      [],
      { boxId: machineId, userId: principal.id },
    );
    throw new HttpError(404, `connection ${name} is not configured`, requestId);
  });

  /** One deliberate write from a machine: create (any active member, who
   * receives the write grant, §12) or rotate (needs write). It exists so an
   * agent can store an important key WITH the comment that explains it, which
   * the bulk dotenv door deliberately cannot do. */
  router.put("/agent/credentials/:name", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    if (caller.principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const name = requiredString(context.req.param("name"), "name", 128);
    if (!ORG_CREDENTIAL_NAME.test(name)) {
      throw new HttpError(400, "name must be an environment variable name");
    }
    const body = await readJson(context.req.raw, ORG_CREDENTIAL_MAX_BYTES * 2);
    if (!isRecord(body)) throw new HttpError(400, "request body must be an object");
    const input: PutAgentCredentialRequest = { value: parseCredentialValue(body.value) };
    const comment = parseCredentialComment(body.comment);
    if (comment !== undefined) input.comment = comment;
    const orgId = caller.workspace.org_id;
    const existing = await orgCredentialByName(runtime.db, orgId, name);
    if (
      existing !== null
      && !orgCredentialAccess(existing, machineCredentialCaller(caller)).write
    ) {
      throw new HttpError(403, `write access to ${name} required`);
    }
    const write: PutOrgCredentialInput = { name, value: input.value };
    if (input.comment !== undefined) write.comment = input.comment;
    const outcome = await putOrgCredential(
      runtime,
      orgId,
      caller.principal.membershipId,
      write,
    );
    return context.json<PutOrgCredentialResponse>(
      { credential: orgCredentialView(outcome.credential, true) },
      outcome.created ? 201 : 200,
    );
  });

  /** The env-file import, agent door. Same parser and same per-line gates as
   * the session door, resolved from the machine's member at call time, so
   * what an agent may import is precisely what its person may. */
  router.post("/agent/credentials/dotenv", async (context) => {
    const runtime = runtimeFactory(context);
    const caller = await boxCaller(runtime, context.req.raw);
    const membershipId = caller.principal.membershipId;
    if (membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseImportRequest(await readJson(context.req.raw, IMPORT_TEXT_MAX_BYTES * 2));
    return context.json<ImportOrgCredentialsResponse>(
      await importOrgCredentials(runtime, caller.workspace.org_id, {
        workspaceId: caller.workspace.id,
        membershipId,
        orgRole: caller.principal.role,
      }, input),
    );
  });
}
