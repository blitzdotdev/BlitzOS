import type { RecipeBootstrap } from "./bootstrap.js";
import { enablementManifestJson, parseManifest } from "./connections/manifest.js";
import { agentRuleIdForOrg } from "./agent-rules.js";
import { checkGithubRepositories, probedRepos } from "./connections/github-repo-check.js";
import { githubCallerCredential } from "./connections/github-repositories.js";
import { revokeWorkspaceLeasesQuery } from "./connections/leases.js";
import { matchesStoredHash } from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { parseWorkspaceEnvironment, WORKSPACE_REQUEST_MAX_BYTES } from "./environment.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  isString,
  isSshPublicKey,
  readJson,
  readText,
  requiredString,
  type JsonValue,
} from "./http.js";
import {
  destroyMachine,
  liveMachines,
  machineFor,
  providerForVmId,
  provisionMachine,
  type ProvisionMachineInput,
} from "./machines.js";
import { issueMachineTokens } from "./oauth.js";
import type { Principal } from "./principals.js";
import {
  isWorkspaceMember,
  requireWorkspaceAdmin,
  webAppWorkspaceForRequest,
  workspaceAccess,
} from "./workspace-access.js";
import { projectWorkspace, projectWorkspaces } from "./workspace-projection.js";
import {
  machinesForWorkspaces,
  workspaceById,
  workspacesForOrg,
  type MachineRow,
  type WorkspaceRow,
} from "./workspace-records.js";
import { randomWorkspaceName } from "./workspace-names.js";
import {
  addWorkspaceMember,
  activeOrgMember,
  parseAddWorkspaceMember,
} from "./workspace-members.js";
import { putWorkspaceCredential } from "./workspace-credentials.js";
import type { WebAppPort } from "./compute/types.js";
import { isWebAppSurfacePath } from "./webapp-surface.js";
import { rewriteWebDavDestination } from "./webapp-proxy.js";
import { requireWorkspaceWebAppAuth, WEBAPP_TOKEN_HEADER } from "./webapp-tickets.js";
import {
  insertWorkspaceRepos,
  parseTemplateRepos,
  workspaceRepos,
  type TemplateRepo,
} from "./template-repos.js";
import { runReadyWorkspaceFileSync, scheduleSync } from "./files/sync.js";
import {
  enforceRateLimit,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type RuntimeFactory,
} from "./runtime.js";
import type {
  AddWorkspaceMemberRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  PollResponse,
} from "./wire.js";
export type { WorkspaceRow } from "./workspace-records.js";

const WORKSPACE_ERROR_MAX_LENGTH = 1_024;

const BOOTSTRAP_ERROR_PREFIX = "bootstrap failed: ";
const PHONE_HOME_REQUEST_FIELDS = Object.freeze([
  "pub_key_ecdsa",
  "pub_key_ed25519",
  "pub_key_rsa",
  "bootstrap_error",
] as const);
const PHONE_HOME_REQUEST_FIELD_SET: ReadonlySet<string> = new Set(
  PHONE_HOME_REQUEST_FIELDS,
);

export interface PhoneHomeSuccessRequest {
  kind: "success";
  hostPublicKey: string;
  canonicalKeys: string[];
}

export interface PhoneHomeFailureRequest {
  kind: "failure";
  message: string;
  canonicalKeys: string[];
}

export type PhoneHomeRequest =
  | PhoneHomeSuccessRequest
  | PhoneHomeFailureRequest;

export interface PhoneHomeResponse {
  box_id: string;
  access_token: string;
  refresh_token: string;
  workspace_id?: string;
  webapp_token?: string;
}

type CreateWorkspaceCredential = NonNullable<CreateWorkspaceRequest["credentials"]>[number];

function parseCreateMembers(value: JsonValue): AddWorkspaceMemberRequest[] {
  if (!Array.isArray(value)) throw new HttpError(400, "members must be an array");
  return value.map((entry) => parseAddWorkspaceMember(entry));
}

function parseCreateCredentials(value: JsonValue): CreateWorkspaceCredential[] {
  if (!Array.isArray(value)) throw new HttpError(400, "credentials must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new HttpError(400, `credentials[${String(index)}] must be an object`);
    }
    const result: CreateWorkspaceCredential = {
      name: requiredString(entry.name, `credentials[${String(index)}].name`, 128),
      value: requiredString(entry.value, `credentials[${String(index)}].value`, 8 * 1024),
    };
    if (entry.label !== undefined && entry.label !== null) {
      result.label = requiredString(entry.label, `credentials[${String(index)}].label`, 128);
    }
    return result;
  });
}

function parseCreateWorkspace(value: unknown): CreateWorkspaceRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: CreateWorkspaceRequest = {};
  if (value.templateId !== undefined && value.templateId !== null) {
    // The template object is gone: a workspace is its own template, and "new
    // workspace from existing" is `cloneFromWorkspaceId`. Refused rather than
    // ignored, so a caller learns what happened instead of quietly getting a
    // workspace with none of the config they asked for.
    throw new HttpError(
      400,
      "workspace templates were replaced by workspace clones; send cloneFromWorkspaceId",
    );
  }
  if (value.cloneFromWorkspaceId !== undefined && value.cloneFromWorkspaceId !== null) {
    result.cloneFromWorkspaceId = requiredString(
      value.cloneFromWorkspaceId,
      "cloneFromWorkspaceId",
      256,
    );
  }
  const machineTypeId = value.defaultMachineTypeId ?? value.machineTypeId;
  if (machineTypeId !== undefined || result.cloneFromWorkspaceId === undefined) {
    result.defaultMachineTypeId = requiredString(machineTypeId, "defaultMachineTypeId", 256);
  }
  if (value.autoProvision !== undefined) {
    if (!isBoolean(value.autoProvision)) {
      throw new HttpError(400, "autoProvision must be a boolean");
    }
    result.autoProvision = value.autoProvision;
  }
  if (value.members !== undefined) result.members = parseCreateMembers(value.members);
  if (value.credentials !== undefined) {
    result.credentials = parseCreateCredentials(value.credentials);
  }
  if (value.orgShareRole !== undefined && value.orgShareRole !== null) {
    if (value.orgShareRole !== "editor" && value.orgShareRole !== "viewer") {
      throw new HttpError(400, "orgShareRole must be editor or viewer");
    }
    result.orgShareRole = value.orgShareRole;
  }
  if (value.name !== undefined) {
    const name = isString(value.name)
      ? value.name.trim()
      : requiredString(value.name, "name", 64);
    if (name !== "") result.name = requiredString(name, "name", 64);
  }
  if (value.sshPublicKey !== undefined) {
    const sshPublicKey = isString(value.sshPublicKey)
      ? value.sshPublicKey.trim()
      : requiredString(value.sshPublicKey, "sshPublicKey");
    if (sshPublicKey !== "") {
      requiredString(sshPublicKey, "sshPublicKey");
      if (!isSshPublicKey(sshPublicKey)) {
        throw new HttpError(400, "sshPublicKey must be an SSH public key");
      }
      result.sshPublicKey = sshPublicKey;
    }
  }
  if (value.volumeId !== undefined) {
    result.volumeId = requiredString(value.volumeId, "volumeId", 256);
  }
  if (value.userData !== undefined) {
    result.userData = requiredString(value.userData, "userData", 48 * 1024);
  }
  if (value.manifest !== undefined) {
    const manifest = parseManifest(value.manifest);
    // SAFETY: This private parser receives JSON.parse output, so all retained ceiling values are JSON values; parseManifest checks each ceiling object and present scopes array.
    result.manifest = manifest as typeof manifest & CreateWorkspaceRequest["manifest"];
  }
  if (value.connections !== undefined) {
    if (!Array.isArray(value.connections)) {
      throw new HttpError(400, "connections must be an array");
    }
    result.connections = [...new Set(value.connections.map((entry, index) =>
      requiredString(entry, `connections[${String(index)}]`, 64)))];
  }
  if (value.environment !== undefined) {
    result.environment = parseWorkspaceEnvironment(value.environment);
  }
  if (value.agentRuleId !== undefined) {
    if (!(value.agentRuleId === null || isString(value.agentRuleId))) {
      throw new HttpError(400, "agentRuleId must be a string or null");
    }
    result.agentRuleId = value.agentRuleId;
  }
  if (value.repos !== undefined) {
    const repos = parseTemplateRepos(value.repos);
    if (repos.length > 0) {
      if (result.cloneFromWorkspaceId !== undefined) {
        // Refused rather than resolved, exactly as a template create was: a
        // clone's repos describe the starting point a team shares and a
        // request's describe a one-off, so picking a winner here would turn
        // one UI bug into a clone list nobody can explain.
        throw new HttpError(400, "repos cannot be combined with cloneFromWorkspaceId");
      }
      result.repos = repos;
    }
  }
  return result;
}

/** The recreate body is optional: an empty POST restores the workspace as it
 * was. Only the SSH key may be supplied, because it belongs to whoever is
 * asking rather than to the row being restored. */
interface RecreateOverrides {
  sshPublicKey?: string;
}

async function readOptionalJson(request: Request): Promise<RecreateOverrides> {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!isRecord(parsed)) throw new HttpError(400, "request body must be an object");
  if (parsed.sshPublicKey === undefined) return {};
  const sshPublicKey = requiredString(parsed.sshPublicKey, "sshPublicKey").trim();
  if (sshPublicKey === "") return {};
  if (!isSshPublicKey(sshPublicKey)) {
    throw new HttpError(400, "sshPublicKey must be an SSH public key");
  }
  return { sshPublicKey };
}

function canonicalFieldForLegacyHostKey(
  hostKey: string,
): "pub_key_ecdsa" | "pub_key_ed25519" | "pub_key_rsa" {
  const algorithm = hostKey.trim().split(/\s+/u, 1)[0] ?? "";
  if (algorithm.startsWith("ecdsa-")) return "pub_key_ecdsa";
  if (algorithm === "ssh-rsa") return "pub_key_rsa";
  return "pub_key_ed25519";
}

function addLegacyHostKeys(
  adapted: Record<string, unknown>,
  candidate: unknown,
): void {
  if (!Array.isArray(candidate)) return;
  for (const hostKey of candidate.filter(isSshPublicKey)) {
    const field = canonicalFieldForLegacyHostKey(hostKey);
    if (adapted[field] === undefined || adapted[field] === "") {
      adapted[field] = hostKey;
    }
  }
}

function adaptLegacyPhoneHomeRequestForInFlightImages(value: unknown) {
  if (!isRecord(value)) return value;
  const adapted = { ...value };
  let hasLegacyPayload = false;

  // Old in-flight microVM images sent array aliases, pub_key_dsa, and workspace_id.
  // Keep all legacy handling isolated here so canonical parsing stays v1-only.
  for (const field of [
    "hostPublicKeys",
    "host_public_keys",
    "ssh_host_public_keys",
  ] as const) {
    if (!(field in adapted)) continue;
    hasLegacyPayload = true;
    addLegacyHostKeys(adapted, adapted[field]);
    delete adapted[field];
  }
  if ("pub_key_dsa" in adapted) {
    hasLegacyPayload = true;
    const dsaKey = adapted.pub_key_dsa;
    if (
      isSshPublicKey(dsaKey) &&
      (adapted.pub_key_ed25519 === undefined || adapted.pub_key_ed25519 === "")
    ) {
      adapted.pub_key_ed25519 = dsaKey;
    }
    delete adapted.pub_key_dsa;
  }
  const isLegacyFailure = "workspace_id" in adapted && "bootstrap_error" in adapted;
  if (hasLegacyPayload || isLegacyFailure) delete adapted.workspace_id;
  return adapted;
}

function bootstrapFailureMessage(value: unknown): string {
  if (!isString(value) || value.length === 0) {
    throw new HttpError(400, "bootstrap_error must be a non-empty string");
  }
  const detail = value
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .trim();
  if (detail === "") {
    throw new HttpError(400, "bootstrap_error must contain printable text");
  }
  return (
    BOOTSTRAP_ERROR_PREFIX +
    detail.slice(0, WORKSPACE_ERROR_MAX_LENGTH - BOOTSTRAP_ERROR_PREFIX.length)
  );
}

function parseCanonicalPhoneHomeRequest(value: unknown): PhoneHomeRequest {
  if (!isRecord(value)) throw new HttpError(400, "phone-home body must be an object");
  const canonicalKeys = Object.keys(value);
  const unexpected = canonicalKeys.filter(
    (field) => !PHONE_HOME_REQUEST_FIELD_SET.has(field),
  );
  if (unexpected.length > 0) {
    throw new HttpError(400, `phone-home body has unexpected field ${unexpected[0]}`);
  }
  if ("bootstrap_error" in value) {
    return {
      kind: "failure",
      message: bootstrapFailureMessage(value.bootstrap_error),
      canonicalKeys,
    };
  }

  const hostPublicKeys: string[] = [];
  for (const field of ["pub_key_ed25519", "pub_key_ecdsa", "pub_key_rsa"] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === "") continue;
    if (!isSshPublicKey(candidate)) {
      throw new HttpError(400, `${field} must be an SSH public key`);
    }
    hostPublicKeys.push(candidate.trim());
  }
  const hostPublicKey = hostPublicKeys[0];
  if (hostPublicKey === undefined) {
    throw new HttpError(400, "an SSH host public key is required");
  }
  return { kind: "success", hostPublicKey, canonicalKeys };
}

export function parsePhoneHomeRequest(
  contentType: string,
  body: string,
): PhoneHomeRequest {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  let value: unknown;
  if (mediaType === "application/json") {
    try {
      value = JSON.parse(body);
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  } else if (mediaType === "application/x-www-form-urlencoded") {
    value = Object.fromEntries(new URLSearchParams(body).entries());
  } else {
    throw new HttpError(400, "phone-home content type must be application/json or application/x-www-form-urlencoded");
  }
  return parseCanonicalPhoneHomeRequest(
    adaptLegacyPhoneHomeRequestForInFlightImages(value),
  );
}

export function createPhoneHomeResponse(
  boxId: string,
  accessToken: string,
  refreshToken: string,
  workspaceId?: string,
  webAppToken?: string,
): PhoneHomeResponse {
  const response: PhoneHomeResponse = {
    box_id: boxId,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
  if (workspaceId !== undefined && webAppToken !== undefined) {
    response.workspace_id = workspaceId;
    response.webapp_token = webAppToken;
  }
  return response;
}

/**
 * The one origin every box gateway accepts, on any image.
 *
 * A box writes the control-plane origin into /var/lib/blitz/origin once, at
 * creation, and never updates it. Its gateway then refuses a websocket whose
 * Origin does not equal that string exactly. The gateway also accepts a
 * localhost origin unconditionally, so the proxy presents that instead of the
 * browser's, and `assertWebSocketOrigin` below enforces the CSRF check here
 * where it is stricter.
 */
const BOX_ACCEPTED_ORIGIN = "http://localhost";

function assertWebSocketOrigin(request: Request, requestURL: URL): void {
  if (!isWebSocketUpgrade(request)) return;
  const origin = request.headers.get("origin");
  if (origin !== requestURL.origin) {
    throw new HttpError(403, "websocket origin forbidden");
  }
}

function requestWithWebAppCredential(
  request: Request,
  requestURL: URL,
  workspaceId: string,
  port: WebAppPort,
  credential: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set(WEBAPP_TOKEN_HEADER, credential);
  rewriteWebDavDestination(headers, requestURL, workspaceId, port);
  if (isWebSocketUpgrade(request)) headers.set("origin", BOX_ACCEPTED_ORIGIN);
  return new Request(request, { headers });
}

async function readPhoneHome(context: CoreContext): Promise<PhoneHomeRequest> {
  return parsePhoneHomeRequest(
    context.req.header("content-type") ?? "",
    await readText(context.req.raw),
  );
}

export interface RecipeLaunch {
  recipeId: string;
  bootstrap: RecipeBootstrap;
}

/** The workspace whose config a create clones, or null. Members and
 * credential VALUES never come across (§ wire types): a clone is a template,
 * not a copy of somebody else's team or secrets. */
async function cloneSource(
  db: Db,
  cloneFromWorkspaceId: string | undefined,
  orgId: string,
): Promise<WorkspaceRow | null> {
  if (cloneFromWorkspaceId === undefined) return null;
  const source = await workspaceById(db, cloneFromWorkspaceId);
  if (source === null || source.org_id !== orgId || source.deleted_at !== null) {
    throw new HttpError(404, "workspace to clone was not found");
  }
  return source;
}

/**
 * The one workspace-create path.
 *
 * It writes a configuration row and no VM. Machines come afterwards, one per
 * member the request named plus the creator, each through `provisionMachine`
 * and each subject to the `vm_limit` gate — which is why the quota now
 * refuses the eleventh MACHINE rather than the eleventh workspace.
 *
 * Workspace creation is org-admin only for now (§3). A later revision can
 * open it; opening it is a one-line change here and nowhere else.
 */
export async function performWorkspaceCreate(
  runtime: CoreRuntime,
  principal: Principal,
  requestOrigin: string,
  input: CreateWorkspaceRequest,
  recipe?: RecipeLaunch,
): Promise<WorkspaceRow> {
  const orgId = principal.orgId;
  const membershipId = principal.membershipId;
  if (orgId === null || membershipId === null) {
    throw new HttpError(403, "active membership required");
  }
  if (principal.role !== "admin") {
    throw new HttpError(403, "organization admin required to create a workspace");
  }
  const source = await cloneSource(runtime.db, input.cloneFromWorkspaceId, orgId);
  const defaultMachineTypeId = input.defaultMachineTypeId
    ?? source?.default_machine_type_id;
  if (defaultMachineTypeId === undefined) {
    throw new HttpError(400, "defaultMachineTypeId is required");
  }
  const agentRuleId = input.agentRuleId === undefined
    ? source?.agent_rule_id ?? null
    : await agentRuleIdForOrg(runtime.db, input.agentRuleId, orgId);
  const requestedRepos = input.repos ?? [];
  const requestCredential = requestedRepos.length === 0
    ? null
    : await githubCallerCredential(runtime, principal.id);
  const repos: TemplateRepo[] = source !== null
    ? await workspaceRepos(runtime.db, source.id)
    : await probedRepos(requestedRepos, requestCredential?.token ?? null);
  const privateRepos = repos.filter((repo) => repo.private);
  if (privateRepos.length > 0) {
    // Public repos and ordinary provider ceilings never block create. A private
    // clone is different: bootstrap waits 600 seconds before it records the
    // failure in repo-clone.log, so refuse before any VM or volume work starts.
    const credential = requestCredential
      ?? await githubCallerCredential(runtime, principal.id);
    if (credential === null || credential.kind !== "oauth") {
      throw new HttpError(
        409,
        "connect GitHub through the App before creating a workspace with private repositories",
      );
    }
    if (source !== null) {
      // Only the clone path still owes a probe. Its rows record a verdict some
      // other member's credential produced, so this member's own reach is
      // unproven; a request list was probed a few lines up with this same
      // credential.
      const checks = await checkGithubRepositories(
        privateRepos.map(({ repo }) => repo),
        credential.token,
      );
      const inaccessible = checks.find((check) => check.verdict === "not-found");
      if (inaccessible !== undefined) {
        throw new HttpError(
          409,
          `the GitHub connection cannot reach private repository ${inaccessible.repo}`,
        );
      }
      const failed = checks.find((check) => check.verdict === "unreachable");
      if (failed !== undefined) {
        throw new HttpError(502, `GitHub could not check private repository ${failed.repo}`);
      }
    }
  }
  const requested = [...new Set([
    ...(input.connections ?? []),
    ...(repos.length > 0 ? ["github"] : []),
  ])];
  const id = crypto.randomUUID();
  const now = Date.now();
  const name = input.name ?? randomWorkspaceName();
  await rows(runtime.db, {
    q: `INSERT INTO workspaces
        (id, name, owner_id, org_id, owner_membership_id, default_machine_type_id,
         auto_provision, revision, manifest, agent_rule_id, recipe_id,
         created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?11)`,
    v: [
      id,
      name,
      principal.id,
      orgId,
      membershipId,
      defaultMachineTypeId,
      input.autoProvision === false ? 0 : 1,
      enablementManifestJson(input.manifest, requested),
      agentRuleId,
      recipe?.recipeId ?? null,
      now,
    ],
  });
  await insertWorkspaceRepos(runtime.db, id, repos);
  // The creator is the first workspace admin, always, and never needs a row in
  // members[] to say so.
  await rows(runtime.db, {
    q: `INSERT INTO workspace_members
        (workspace_id, membership_id, role, added_by_membership_id, added_at)
        VALUES (?1, ?2, 'admin', ?2, ?3)`,
    v: [id, membershipId, now],
  });
  // The one path where a credential VALUE is sent. Written before any machine
  // boots, so the first `blitz-cred get` inside the workspace already answers.
  for (const credential of input.credentials ?? []) {
    await putWorkspaceCredential(runtime, id, membershipId, credential, now);
  }
  // Legacy `environment` converts to the same store. The startup script does
  // not: nothing runs one any more (plans/MEMBER-MACHINES.md §1).
  for (const [key, value] of Object.entries(input.environment?.env ?? {})) {
    await putWorkspaceCredential(runtime, id, membershipId, { name: key, value }, now);
  }
  const workspace = await workspaceById(runtime.db, id);
  if (workspace === null) throw new Error("workspace disappeared during create");

  const members: AddWorkspaceMemberRequest[] = [...(input.members ?? [])]
    .filter((member) => member.membershipId !== membershipId);
  if (input.orgShareRole !== undefined) {
    // The org-wide share converts to one row per active member, at the
    // matching workspace role. It is a bulk add now, not a stored default.
    const roster = await rows<{ id: string }>(runtime.db, {
      q: `SELECT id FROM memberships
          WHERE org_id = ?1 AND status = 'active' AND id != ?2
          ORDER BY id`,
      v: [orgId, membershipId],
    });
    const role = input.orgShareRole === "editor" ? "member" : "viewer";
    for (const entry of roster) {
      if (!members.some((member) => member.membershipId === entry.id)) {
        members.push({ membershipId: entry.id, role });
      }
    }
  }

  const creatorMachine: ProvisionMachineInput = {
    workspace,
    membershipId,
    machineTypeId: defaultMachineTypeId,
    requestOrigin,
  };
  if (input.sshPublicKey !== undefined) creatorMachine.sshPublicKey = input.sshPublicKey;
  if (input.userData !== undefined) creatorMachine.userData = input.userData;
  if (input.volumeId !== undefined) creatorMachine.volumeId = input.volumeId;
  if (recipe !== undefined) creatorMachine.recipe = recipe.bootstrap;
  try {
    if (workspace.auto_provision === 1) {
      await provisionMachine(runtime, creatorMachine);
    }
  } catch (error) {
    // A quota, a 413 or a 503 means no machine was ever made. The workspace it
    // was made for is config with nothing behind it, so it goes too and the
    // caller sees the provider's own refusal rather than an empty shell.
    await deleteWorkspaceRow(runtime.db, id);
    throw error;
  }

  for (const member of members) {
    const identity = await activeOrgMember(runtime, orgId, member.membershipId);
    if (identity === null) continue;
    await addWorkspaceMember(runtime, workspace, membershipId, member, requestOrigin, identity);
  }
  const created = await workspaceById(runtime.db, id);
  if (created === null) throw new Error("workspace disappeared during create");
  return created;
}

/** Removes a workspace that never got a machine, with its children. */
async function deleteWorkspaceRow(db: Db, id: string): Promise<void> {
  await transaction(db, [
    { q: "DELETE FROM workspace_credentials WHERE workspace_id = ?1", v: [id] },
    { q: "DELETE FROM workspace_members WHERE workspace_id = ?1", v: [id] },
    { q: "DELETE FROM workspace_repos WHERE workspace_id = ?1", v: [id] },
    { q: "DELETE FROM workspaces WHERE id = ?1", v: [id] },
  ]);
}

/** The machine the requesting member reaches through the webApp proxy.
 *
 * The ticket already carries `membershipId`, so this is a lookup and not a
 * choice. A viewer holds no machine at all, which is the refusal below. */
async function machineForRequest(
  runtime: CoreRuntime,
  workspaceId: string,
  membershipId: string,
): Promise<MachineRow> {
  const machine = await machineFor(runtime.db, workspaceId, membershipId);
  if (machine === null || machine.state === "destroyed") {
    throw new HttpError(
      409,
      "you have no machine in this workspace; a workspace admin provisions one",
    );
  }
  if (machine.vm_id === null) {
    throw new HttpError(409, "your machine in this workspace is not running");
  }
  return machine;
}

export function addWorkspaceRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/workspaces", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    await enforceRateLimit(runtime.vars.requestRateLimiter, `create:${principal.id}`);
    const input = parseCreateWorkspace(await readJson(context.req.raw, WORKSPACE_REQUEST_MAX_BYTES));
    const row = await performWorkspaceCreate(
      runtime,
      principal,
      new URL(context.req.url).origin,
      input,
    );
    return context.json<CreateWorkspaceResponse>(
      { workspace: await projectWorkspace(runtime.db, principal, row) },
      201,
    );
  });

  router.get("/workspaces", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const all = await workspacesForOrg(runtime.db, principal.orgId);
    const views = await projectWorkspaces(runtime.db, principal, all);
    return context.json<PollResponse>({
      // A member sees the workspaces they are in; an org admin sees every one
      // of the organization's, which is the reach they already held.
      workspaces: views.filter((view) => view.role !== null),
    });
  });

  /**
   * Deleted workspaces whose machines still hold a volume.
   *
   * This is the recreate history. `GET /workspaces` hides deleted rows, so
   * without this list the disk that outlived a workspace is invisible and the
   * seven-day window passes unused. A row leaves the list when the janitor
   * reclaims its volume, which is the same moment the recreate stops working.
   *
   * Registered before `/workspaces/:id` so the literal path wins the match.
   */
  router.get("/workspaces/history", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const deleted = await rows<WorkspaceRow>(runtime.db, {
      q: `SELECT w.*, u.name AS owner_name, u.avatar_url AS owner_avatar_url
          FROM workspaces w
          LEFT JOIN memberships owner ON owner.id = w.owner_membership_id
          LEFT JOIN users u ON u.id = owner.user_id
          WHERE w.org_id = ?1 AND w.deleted_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM machines m
              JOIN volume_ownership vol ON vol.volume_id = m.volume_id
              WHERE m.workspace_id = w.id AND vol.org_id = ?1
            )
          ORDER BY w.updated_at DESC, w.id
          LIMIT 100`,
      v: [principal.orgId],
    });
    return context.json<PollResponse>({
      workspaces: await projectWorkspaces(runtime.db, principal, deleted),
    });
  });

  /**
   * Brings a deleted workspace back on its owner's volume.
   *
   * The new workspace is a new row with a new id, because the old row is the
   * tombstone that proves the old VM is gone. It inherits the name, machine
   * type and agent rule of the row it came from. The machine type is inherited
   * rather than chosen, because the volume only attaches inside its own
   * location.
   */
  router.post("/workspaces/:id/recreate", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    await enforceRateLimit(runtime.vars.requestRateLimiter, `create:${principal.id}`);
    const id = context.req.param("id");
    const row = await workspaceById(runtime.db, id);
    if (row === null || row.org_id !== principal.orgId) {
      throw new HttpError(404, "workspace not found");
    }
    if (row.deleted_at === null) {
      throw new HttpError(409, "only a deleted workspace can be recreated");
    }
    const machines = await machinesForWorkspaces(runtime.db, [row.id]);
    const owner = machines.find(
      (machine) => machine.membership_id === row.owner_membership_id,
    ) ?? machines[0];
    if (owner?.volume_id == null) {
      throw new HttpError(409, "workspace kept no volume, so it cannot be recreated");
    }
    // The SSH key is the caller's, not the workspace's: the row never stored
    // one, and a key from weeks ago may not be the key they hold now.
    const overrides = await readOptionalJson(context.req.raw);
    const request: CreateWorkspaceRequest = {
      defaultMachineTypeId: owner.machine_type_id,
      volumeId: owner.volume_id,
    };
    if (overrides.sshPublicKey !== undefined) request.sshPublicKey = overrides.sshPublicKey;
    if (row.name !== null) request.name = row.name;
    if (row.agent_rule_id !== null) request.agentRuleId = row.agent_rule_id;
    // The tombstone lets go first. A create that fails still leaves the volume
    // owned by the org, so the next attempt finds it; a create that succeeds
    // must never leave two rows pointing at one disk.
    await rows(runtime.db, {
      q: "UPDATE machines SET volume_id = NULL, updated_at = ?1 WHERE id = ?2",
      v: [Date.now(), owner.id],
    });
    try {
      const created = await performWorkspaceCreate(
        runtime,
        principal,
        new URL(context.req.url).origin,
        request,
      );
      return context.json<CreateWorkspaceResponse>(
        { workspace: await projectWorkspace(runtime.db, principal, created) },
        201,
      );
    } catch (error) {
      // Hand the volume back to the tombstone so the history row reappears and
      // the operator can try again.
      await rows(runtime.db, {
        q: `UPDATE machines SET volume_id = ?1, updated_at = ?2
            WHERE id = ?3 AND volume_id IS NULL`,
        v: [owner.volume_id, Date.now(), owner.id],
      });
      throw error;
    }
  });

  router.get("/workspaces/:id", async (context) => {
    // The SPA's workspace page shares this path. A browser refresh navigates
    // here with an HTML accept; serve the app shell and keep JSON for fetch
    // callers.
    const runtime = runtimeFactory(context);
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
    const principal = await requirePrincipal(context);
    const row = await workspaceById(runtime.db, context.req.param("id"));
    if (row === null || row.org_id !== principal.orgId || row.deleted_at !== null) {
      throw new HttpError(404, "workspace not found");
    }
    const view = await projectWorkspace(runtime.db, principal, row);
    if (view.role === null) throw new HttpError(403, "forbidden");
    return context.json<CreateWorkspaceResponse>({ workspace: view });
  });

  const webApp = async (context: CoreContext): Promise<Response> => {
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    const access = await webAppWorkspaceForRequest(runtime, requirePrincipal, context, id);
    const row = access.workspace;
    // The proxy routes to the REQUESTING member's machine. A workspace holds
    // one VM per member now, so "the workspace's VM" is not a thing that
    // exists; the ticket already names who is asking.
    const machine = await machineForRequest(runtime, row.id, access.membershipId);
    const vmId = machine.vm_id;
    if (vmId === null) throw new HttpError(409, "workspace is not ready for webapp access");
    const provider = providerForVmId(runtime, vmId);
    const rawPort = context.req.param("port");
    if (rawPort !== "7444" && rawPort !== "7445") {
      throw new HttpError(400, "webApp port must be 7444 or 7445");
    }
    const port: WebAppPort = rawPort === "7444" ? 7444 : 7445;
    const requestURL = new URL(context.req.url);
    const routePrefix = `/workspaces/${encodeURIComponent(id)}/webapp/${rawPort}`;
    if (!requestURL.pathname.startsWith(routePrefix)) {
      throw new HttpError(400, "invalid workspace webApp path");
    }
    assertWebSocketOrigin(context.req.raw, requestURL);
    const suffix = requestURL.pathname.slice(routePrefix.length);
    const path = suffix === "" ? "/" : suffix;
    if (!isWebAppSurfacePath(port, path)) {
      throw new HttpError(403, "path is not a workspace webApp surface");
    }
    const pathAndQuery = `${path}${requestURL.search}`;
    // Boxes boot the image pinned at their creation and never upgrade in
    // place, and each provider ships its guest on its own release channel — so
    // the cutoff comes from the provider that owns this VM, and it is compared
    // against the MACHINE's creation, not the workspace's: a workspace outlives
    // its VMs now, so its own age says nothing about the image in front of us.
    // TODO(identity-phase-4): drop the gate once every pre-ticket VM is gone.
    const capabilities = provider.capabilities();
    const ticketsSince = capabilities.webAppTicketsSinceMs;
    const ticketCapable = ticketsSince !== undefined && machine.created_at >= ticketsSince;
    const viewerGuardsSince = capabilities.webAppViewerGuardsSinceMs;
    const viewerSafe = viewerGuardsSince !== undefined && machine.created_at >= viewerGuardsSince;
    if (access.role === "viewer" && (port === 7444 || !viewerSafe)) {
      throw new HttpError(403, viewerSafe
        ? "viewers cannot drive the workspace agent"
        : "read-only access arrives when this workspace VM is recycled");
    }
    const webAppAuth = requireWorkspaceWebAppAuth(runtime.providers.webAppAuth);
    const credential = ticketCapable
      ? await webAppAuth.mint({
          workspaceId: row.id,
          userId: access.userId,
          membershipId: access.membershipId,
          role: access.role,
        })
      : await webAppAuth.tokenFor(row.id);
    const authenticatedRequest = requestWithWebAppCredential(
      context.req.raw,
      requestURL,
      row.id,
      port,
      credential,
    );
    const workspaceTunnels = runtime.providers.workspaceTunnels;
    let upstream: Response | null;
    try {
      if (provider.proxyWebApp !== undefined) {
        upstream = await provider.proxyWebApp(vmId, port, pathAndQuery, authenticatedRequest);
      } else if (workspaceTunnels !== undefined && machine.tunnel_hostname !== null) {
        upstream = await workspaceTunnels.proxy(
          machine.tunnel_hostname,
          row.id,
          port,
          pathAndQuery,
          authenticatedRequest,
          credential,
        );
      } else {
        throw new HttpError(503, "workspace has no webapp tunnel");
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `workspace webApp proxy is unavailable: ${detail}`);
    }
    if (upstream === null) {
      throw new HttpError(409, "workspace VM is not owned by its resolved provider");
    }
    if (!isWebSocketUpgrade(context.req.raw)) return upstream;
    if (upstream.status !== 101 || upstream.webSocket === null) return upstream;
    return websocketProxyResponse(upstream);
  };

  router.all("/workspaces/:id/webapp/:port", webApp);
  router.all("/workspaces/:id/webapp/:port/*", webApp);

  /** Deletes the workspace: every machine destroys, then the row tombstones.
   * Workspace admins and org admins only (§3). */
  router.delete("/workspaces/:id", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    const row = await workspaceById(runtime.db, id);
    if (row === null || row.org_id !== principal.orgId) {
      throw new HttpError(404, "workspace not found");
    }
    await requireWorkspaceAdmin(runtime.db, principal, row);
    if (row.deleted_at !== null) {
      return context.json<CreateWorkspaceResponse>({
        workspace: await projectWorkspace(runtime.db, principal, row),
      });
    }
    let pending = false;
    for (const machine of await liveMachines(runtime.db, id)) {
      const destroyed = await destroyMachine(runtime, machine);
      if (destroyed.state !== "destroyed") pending = true;
    }
    if (!pending) {
      // Honest destroy: the tombstone is only written once the last machine is
      // actually gone. A workspace whose Cloudflare cleanup is still failing
      // stays live with its machines in `destroying` for the janitor to retry.
      await transaction(runtime.db, [
        revokeWorkspaceLeasesQuery(id),
        { q: "DELETE FROM webapp_state WHERE workspace_id = ?1", v: [id] },
        {
          q: `UPDATE workspaces
              SET deleted_at = ?1, revision = revision + 1, updated_at = ?1
              WHERE id = ?2 AND deleted_at IS NULL`,
          v: [Date.now(), id],
        },
      ]);
    }
    const after = await workspaceById(runtime.db, id);
    if (after === null) throw new Error("workspace disappeared during destroy");
    return context.json<CreateWorkspaceResponse>({
      workspace: await projectWorkspace(runtime.db, principal, after),
    });
  });

  /**
   * Enrollment. The capability is per machine and re-armed at every VM
   * provision, so the machine is resolved by matching the token against the
   * hashes this workspace's machines hold rather than by a workspace-level
   * column. The URL keeps its workspace shape because every deployed guest
   * holds one it was handed at creation and never updates it.
   */
  router.post("/workspaces/:id/phone-home/:token", async (context) => {
    const id = context.req.param("id");
    const token = context.req.param("token");
    const runtime = runtimeFactory(context);
    const db = runtime.db;
    const workspace = await workspaceById(db, id);
    if (workspace === null) throw new HttpError(404, "workspace not found");
    const candidates = await rows<MachineRow>(db, {
      q: `SELECT * FROM machines
          WHERE workspace_id = ?1 AND phone_home_hash IS NOT NULL
          ORDER BY created_at, id`,
      v: [id],
    });
    let row: MachineRow | undefined;
    for (const candidate of candidates) {
      if (await matchesStoredHash(token, candidate.phone_home_hash ?? "")) {
        row = candidate;
        break;
      }
    }
    if (row === undefined) {
      // A spent capability keeps no hash, so a second presentation of one
      // cannot be matched. "Already used" is still the honest answer, and it
      // is the answer this route has always given: a machine that has burnt
      // its capability says so rather than reading as a bad token.
      const spent = await first<{ id: string }>(db, {
        q: `SELECT id FROM machines
            WHERE workspace_id = ?1 AND phone_home_used = 1 LIMIT 1`,
        v: [id],
      });
      throw spent === null
        ? new HttpError(401, "invalid phone_home capability")
        : new HttpError(409, "phone_home capability already used");
    }
    if (row.state !== "provisioning") throw new HttpError(409, "machine is not provisioning");
    const machineId = row.id;
    const phoneHome = await readPhoneHome(context);
    if (phoneHome.kind === "failure") {
      const consumed = await rows(db, {
        q: `UPDATE machines
            SET state = 'error', error = ?1, phone_home_used = 1,
                phone_home_hash = NULL, updated_at = ?2
            WHERE id = ?3 AND state = 'provisioning' AND phone_home_used = 0
              AND phone_home_hash = ?4
            RETURNING id`,
        v: [phoneHome.message, Date.now(), machineId, row.phone_home_hash],
      });
      if (consumed.length !== 1) {
        throw new HttpError(409, "phone_home capability already used");
      }
      return context.body(null, 204);
    }
    if (row.vm_id === null || row.ssh_host === null) {
      throw new HttpError(409, "machine provisioning is not recorded yet");
    }

    const hostKey = phoneHome.hostPublicKey;
    const credentials = await issueMachineTokens();
    const now = Date.now();
    const results = await transaction(db, [
      {
        // The stamp fences a guest that outlives its VM: a family minted for
        // one incarnation stops matching the moment a new VM takes over.
        q: `INSERT INTO machine_token_families
            (machine_id, vm_id, access_hash, refresh_hash, access_issued_at, generation)
            SELECT ?1, ?2, ?3, ?4, ?5, 1 FROM machines
            WHERE id = ?1 AND state = 'provisioning' AND phone_home_used = 0
              AND phone_home_hash = ?6
            ON CONFLICT(machine_id) DO UPDATE SET
              vm_id = excluded.vm_id, access_hash = excluded.access_hash,
              refresh_hash = excluded.refresh_hash,
              previous_refresh_hash = NULL, previous_rotated_at = NULL,
              access_issued_at = excluded.access_issued_at,
              generation = machine_token_families.generation + 1`,
        v: [
          machineId,
          row.vm_id,
          credentials.accessHash,
          credentials.refreshHash,
          now,
          row.phone_home_hash,
        ],
      },
      {
        q: `UPDATE machines
            SET state = 'running', ssh_host_public_key = ?1, phone_home_used = 1,
                phone_home_hash = NULL, error = NULL, updated_at = ?2
            WHERE id = ?3 AND state = 'provisioning' AND phone_home_used = 0
              AND phone_home_hash = ?4
            RETURNING id`,
        v: [hostKey, now, machineId, row.phone_home_hash],
      },
    ]);
    if (results[1]?.length !== 1) {
      throw new HttpError(409, "phone_home capability already used");
    }
    await rows(db, {
      q: `UPDATE workspaces SET revision = revision + 1, updated_at = ?1 WHERE id = ?2`,
      v: [now, workspace.id],
    });
    // The guest just came up: materialize its attached Drive folders now
    // instead of waiting for the next scheduled sweep.
    scheduleSync(runtime, (syncRuntime) => runReadyWorkspaceFileSync(syncRuntime, id));
    const webAppToken = runtime.providers.webAppAuth === undefined
      ? undefined
      : await runtime.providers.webAppAuth.tokenFor(id);
    return context.json<PhoneHomeResponse>(createPhoneHomeResponse(
      machineId,
      credentials.accessToken,
      credentials.refreshToken,
      webAppToken === undefined ? undefined : id,
      webAppToken,
    ));
  });
}

/** Whether the caller may use this workspace's credentials and machines. */
export async function canUseWorkspace(
  runtime: CoreRuntime,
  principal: Principal,
  workspace: WorkspaceRow,
): Promise<boolean> {
  return isWorkspaceMember(await workspaceAccess(runtime.db, principal, workspace));
}

export async function workspaceMachineCount(db: Db, workspaceId: string): Promise<number> {
  const row = await first<{ count: number }>(db, {
    q: "SELECT COUNT(*) AS count FROM machines WHERE workspace_id = ?1 AND state != 'destroyed'",
    v: [workspaceId],
  });
  return row?.count ?? 0;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close(code, reason);
  } catch {
    // The peer may have completed the close between the state check and call.
  }
}

function pipeWebSocket(source: WebSocket, target: WebSocket): void {
  source.addEventListener("message", (event) => {
    try {
      target.send(event.data);
    } catch {
      closeWebSocket(source, 1011, "webapp proxy send failed");
      closeWebSocket(target, 1011, "webapp proxy send failed");
    }
  });
  source.addEventListener("close", (event) => {
    closeWebSocket(target, event.code, event.reason);
    closeWebSocket(source, event.code, event.reason);
  });
  source.addEventListener("error", () => {
    closeWebSocket(source, 1011, "webapp proxy error");
    closeWebSocket(target, 1011, "webapp proxy error");
  });
}

function websocketProxyResponse(upstream: Response): Response {
  const upstreamSocket = upstream.webSocket;
  if (upstreamSocket === null) return upstream;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  upstreamSocket.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstreamSocket.accept({ allowHalfOpen: true });
  server.accept({ allowHalfOpen: true });
  pipeWebSocket(server, upstreamSocket);
  pipeWebSocket(upstreamSocket, server);
  return new Response(null, {
    status: 101,
    headers: upstream.headers,
    webSocket: client,
  });
}
