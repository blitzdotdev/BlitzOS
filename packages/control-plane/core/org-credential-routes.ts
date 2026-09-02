import { HttpError, isRecord, readJson, requiredString } from "./http.js";
import {
  callerFor,
  liveOrgCredentials,
  orgCredentialAccess,
  orgCredentialByName,
  orgCredentialView,
  parseGrantList,
  parseOrgCredentialWrite,
  putOrgCredential,
  replaceOrgCredentialGrants,
  requestedOrgId,
  revokeOrgCredential,
  ORG_CREDENTIAL_MAX_BYTES,
  type PutOrgCredentialInput,
} from "./org-credentials.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { legacyRole, workspaceAccess } from "./workspace-access.js";
import { workspaceById } from "./workspace-records.js";
import type {
  ListOrgCredentialsResponse,
  PutOrgCredentialResponse,
  ReplaceOrgCredentialGrantsResponse,
} from "./wire.js";

/** The session plane (plans/ORG-CREDENTIALS.md §7): what the webApp calls.
 * All under `requireMembershipPrincipal`; the agent plane lives in
 * `core/agent-routes.ts` and shares the store functions. */
export function addOrgCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/orgs/:id/credentials", async (context) => {
    const workspaceId = new URL(context.req.url).searchParams.get("workspaceId");
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    const sessionCaller = callerFor(principal);
    let readCaller = sessionCaller;
    if (workspaceId !== null) {
      const id = requiredString(workspaceId, "workspaceId", 64);
      const workspace = await workspaceById(runtime.db, id);
      if (
        workspace === null
        || workspace.org_id !== orgId
        || workspace.deleted_at !== null
      ) {
        throw new HttpError(404, "workspace not found");
      }
      if (legacyRole(await workspaceAccess(runtime.db, principal, workspace)) === null) {
        throw new HttpError(403, "forbidden");
      }
      // This view answers whether the credential reaches the workspace. Org
      // admin authority still controls whether the returned grants are editable.
      readCaller = { workspaceId: id, membershipId: principal.membershipId, orgRole: "member" };
    }
    const credentials = await liveOrgCredentials(runtime.db, orgId);
    const visible = credentials.flatMap((credential) => {
      const readAccess = orgCredentialAccess(credential, readCaller);
      if (!readAccess.read) return [];
      const includeGrants = workspaceId === null
        ? readAccess.write
        : orgCredentialAccess(credential, sessionCaller).write;
      return [orgCredentialView(credential, includeGrants)];
    });
    return context.json<ListOrgCredentialsResponse>({ credentials: visible });
  });

  router.put("/orgs/:id/credentials", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseOrgCredentialWrite(
      await readJson(context.req.raw, ORG_CREDENTIAL_MAX_BYTES * 4),
    );
    const existing = await orgCredentialByName(runtime.db, orgId, input.name);
    // Create is open to any active member (§12); rotate needs write.
    if (existing !== null && !orgCredentialAccess(existing, callerFor(principal)).write) {
      throw new HttpError(403, `write access to ${input.name} required`);
    }
    const write: PutOrgCredentialInput = { name: input.name, value: input.value };
    if (input.comment !== undefined) write.comment = input.comment;
    const outcome = await putOrgCredential(runtime, orgId, principal.membershipId, write);
    // A create that names grants still keeps the creator's own write grant
    // (§12) unless the request names that membership itself — narrowing
    // yourself is deliberate; being locked out by an omission is not.
    const grants = input.grants !== undefined && outcome.created
      && !input.grants.some((grant) =>
        grant.subjectKind === "membership" && grant.subjectId === principal.membershipId)
      ? [...input.grants, {
          subjectKind: "membership" as const,
          subjectId: principal.membershipId,
          access: "write" as const,
        }]
      : input.grants;
    const credential = grants === undefined
      ? outcome.credential
      : await replaceOrgCredentialGrants(
          runtime,
          outcome.credential,
          principal.membershipId,
          grants,
        );
    return context.json<PutOrgCredentialResponse>(
      { credential: orgCredentialView(credential, true) },
      outcome.created ? 201 : 200,
    );
  });

  router.put("/orgs/:id/credentials/:name/grants", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const name = requiredString(context.req.param("name"), "name", 128);
    const credential = await orgCredentialByName(runtime.db, orgId, name);
    if (credential === null) throw new HttpError(404, "org credential not found");
    if (!orgCredentialAccess(credential, callerFor(principal)).write) {
      throw new HttpError(403, `write access to ${name} required`);
    }
    const body = await readJson(context.req.raw);
    if (!isRecord(body)) throw new HttpError(400, "request body must be an object");
    const grants = parseGrantList(body.grants ?? []);
    const updated = await replaceOrgCredentialGrants(
      runtime,
      credential,
      principal.membershipId,
      grants,
    );
    return context.json<ReplaceOrgCredentialGrantsResponse>({
      credential: orgCredentialView(updated, true),
    });
  });

  router.delete("/orgs/:id/credentials/:name", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const orgId = requestedOrgId(context, principal);
    const name = requiredString(context.req.param("name"), "name", 128);
    const credential = await orgCredentialByName(runtime.db, orgId, name);
    if (credential === null) throw new HttpError(404, "org credential not found");
    if (!orgCredentialAccess(credential, callerFor(principal)).write) {
      throw new HttpError(403, `write access to ${name} required`);
    }
    if (!await revokeOrgCredential(runtime, orgId, name)) {
      throw new HttpError(404, "org credential not found");
    }
    return context.body(null, 204);
  });
}
