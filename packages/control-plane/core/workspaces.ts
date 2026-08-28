import { boxHostname, type RecipeBootstrap } from "./bootstrap.js";
import { buildUserData, type BootShaping } from "./cloud-init.js";
import { enablementManifestJson, parseManifest } from "./connections/manifest.js";
import { agentRuleIdForOrg } from "./agent-rules.js";
import { checkGithubRepositories, probedRepos } from "./connections/github-repo-check.js";
import { githubCallerCredential } from "./connections/github-repositories.js";
import { revokeWorkspaceLeasesQuery } from "./connections/leases.js";
import { mintWorkspaceConnection, workspaceForMint } from "./connections/mint.js";
import { connectionByName } from "./connections/registry.js";
import { hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { VM_SLOT_PHASES } from "./entitlements.js";
import {
  parseWorkspaceEnvironment,
  workspaceEnvironmentFromJson,
  storedWorkspaceEnvironment,
  WORKSPACE_REQUEST_MAX_BYTES,
} from "./environment.js";
import {
  HttpError,
  isRecord,
  isString,
  isSshPublicKey,
  readJson,
  readText,
  requiredString,
} from "./http.js";
import { issueBoxTokens } from "./oauth.js";
import type { Principal } from "./principals.js";
import { canControlWorkspace, webAppWorkspaceForRequest, workspaceRole } from "./workspace-access.js";
import { workspaceById, workspaceView, type WorkspaceRow } from "./workspace-records.js";
import { randomWorkspaceName } from "./workspace-names.js";
import {
  markVolumeAttachedQuery,
  markVolumeDetachedQuery,
  provisionWorkspaceVolume,
} from "./workspace-volumes.js";
import type { CreateVmInput, WebAppPort, VmProvider } from "./compute/types.js";
import { resolveWorkspacePlacement } from "./compute/workspace-placement.js";
import { isWebAppSurfacePath } from "./webapp-surface.js";
import { rewriteWebDavDestination } from "./webapp-proxy.js";
import { requireWorkspaceWebAppAuth, WEBAPP_TOKEN_HEADER } from "./webapp-tickets.js";
import {
  insertWorkspaceRepos,
  parseTemplateRepos,
  templateRepos,
  type TemplateRepo,
} from "./template-repos.js";
import {
  attachTemplateFolders,
  templateConnections,
  templateWorkspaceName,
  workspaceTemplateForCreate,
} from "./workspace-templates.js";
import { runReadyWorkspaceFileSync, scheduleSync } from "./files/sync.js";
import {
  enforceRateLimit,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type RuntimeFactory,
} from "./runtime.js";
import type {
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


function providerForVmId(runtime: CoreRuntime, vmId: string): VmProvider {
  const provider = runtime.providers.vmRegistry.forVmId(vmId);
  if (provider === undefined) {
    throw new HttpError(409, `no VM provider owns VM ID ${vmId}`);
  }
  return provider;
}

function parseCreateWorkspace(value: unknown): CreateWorkspaceRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: CreateWorkspaceRequest = {};
  if (value.templateId !== undefined) {
    result.templateId = requiredString(value.templateId, "templateId", 256);
  }
  if (value.machineTypeId !== undefined || result.templateId === undefined) {
    result.machineTypeId = requiredString(value.machineTypeId, "machineTypeId", 256);
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
    // Same validator the template save runs: "owner/name", a cap of sixteen,
    // and no two repos that would clone into one /workspace directory.
    const repos = parseTemplateRepos(value.repos);
    if (repos.length > 0) {
      if (result.templateId !== undefined) {
        // Refused rather than resolved. A template's repos describe a starting
        // point a team shares and a request's describe a one-off, so picking a
        // winner here would turn one UI bug into a clone list nobody can
        // explain from the request that produced it.
        throw new HttpError(400, "repos cannot be combined with templateId");
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

async function markCreateError(
  db: Db,
  id: string,
  message: string,
  now: number,
): Promise<WorkspaceRow> {
  await rows(db, {
    q: `UPDATE workspaces
        SET phase = 'error', error = ?1, phone_home_hash = NULL,
            revision = revision + 1, updated_at = ?2
        WHERE id = ?3 AND phase = 'creating'`,
    v: [message, now, id],
  });
  const row = await workspaceById(db, id);
  if (row === null) throw new Error("workspace disappeared during create");
  return row;
}

function providerOperationError(error: unknown): string {
  if (!(error instanceof Error)) return "provider operation failed";
  const detail = error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return detail === "" ? "provider operation failed" : `provider operation failed: ${detail}`;
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
 * Origin does not equal that string exactly. Moving the app to a new domain
 * therefore broke every workspace created before the move: plain requests kept
 * working, because the gateway only downgrades CORS headers for those, while
 * every websocket answered 403. Terminals and chat hung with no server-side
 * error to find, because the box was behaving correctly.
 *
 * The gateway also accepts a localhost origin unconditionally, so the proxy
 * presents that instead of the browser's. The CSRF protection the box's check
 * provided is not lost — assertWebSocketOrigin below enforces it here, before
 * the request is ever forwarded, and it is stricter: it requires an exact
 * match where the old path accepted anything the box happened to be told.
 */
const BOX_ACCEPTED_ORIGIN = "http://localhost";

/**
 * Rejects a websocket upgrade that did not come from this deployment.
 *
 * A websocket carries cookies cross-site and is not subject to CORS, so this
 * is the CSRF gate for every box surface reached through the proxy. It runs
 * before any credential is minted.
 */
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
  // Only for the upgrade: a plain request needs no rewrite, and leaving its
  // Origin alone keeps the box's CORS answer truthful.
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

/** The one workspace-create path. POST /workspaces and POST
 * /workspace-recipes/:id/launch both land here, so a recipe launch rides the exact
 * template flows — machine-type default, environment, agent rule, folder
 * attach with the launcher as principal, and the vm_limit 409 — instead of a
 * parallel copy. Returns the created row, which may already be in phase
 * 'error' when the provider call failed; request-shaped failures (quota 409,
 * oversized user data 413, provider 503) throw exactly as the route always
 * has. */
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
  const template = input.templateId === undefined
    ? null
    : await workspaceTemplateForCreate(runtime.db, input.templateId, orgId);
  // The template's machine type is the default; an explicit machineTypeId
  // in the request still wins so a template create can be customized.
  const machineTypeId = input.machineTypeId ?? template?.machine_type_id;
  if (machineTypeId === undefined) {
    throw new HttpError(400, "machineTypeId is required");
  }
  const environment = input.environment
    ?? workspaceEnvironmentFromJson(template?.environment ?? null);
  // The request wins, then the template's rule, then null — which the box
  // read resolves to the built-in doc. Resolved once, at create, so the
  // workspace keeps the rule it started with even if the template moves on.
  const agentRuleId = input.agentRuleId === undefined
    ? template?.agent_rule_id ?? null
    : await agentRuleIdForOrg(runtime.db, input.agentRuleId, orgId);
  // Enablement, not provisioning: a template names providers, the creator
  // supplies the identity, and the workspace ceiling records what may mint.
  const templateConnectionList = template === null
    ? []
    : await templateConnections(runtime.db, template.id);
  // A workspace clones the template's repos or the ones the request named,
  // never a merge of the two — the request parser already refused a body that
  // carried both, so this is a choice with nothing left to arbitrate. Template
  // rows arrive with the privacy a save probed; a request list arrives as bare
  // names, so its privacy is derived here rather than believed.
  const requestedRepos = input.repos ?? [];
  const requestCredential = requestedRepos.length === 0
    ? null
    : await githubCallerCredential(runtime, principal.id);
  const repos: TemplateRepo[] = template !== null
    ? await templateRepos(runtime.db, template.id)
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
    if (template !== null) {
      // Only the template path still owes a probe. Its rows record a verdict
      // some other member's credential produced, possibly months ago, so this
      // member's own reach is still unproven. A request list was probed a few
      // lines up with this same credential, and sixteen repos cost two
      // subrequests each — asking GitHub twice would spend a Worker's whole
      // subrequest allowance to learn nothing new.
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
  // Creation never mints a connection. The names land in the allow-list below,
  // and an agent pulls a credential when it needs one. Minting here used to
  // leave a live proxy lease token nobody held, which is a capability with no
  // holder. A stipulated provider with no grant behind it still creates unless
  // a private template repo requires GitHub during bootstrap.
  const requested = [...new Set([
    ...templateConnectionList.map(({ provider }) => provider),
    ...(input.connections ?? []),
    // Cloning reads through the baked git credential helper, which mints from
    // the workspace ceiling. Naming repos therefore stipulates github, exactly
    // as naming them on a template does — idempotent, since a template that
    // carries repos already lists it.
    ...(repos.length > 0 ? ["github"] : []),
  ])];
  const vmResolution = await resolveWorkspacePlacement(
    runtime.db,
    runtime.providers.vmRegistry,
    orgId,
    machineTypeId,
    input.volumeId,
  );
  const vmProvider = vmResolution.provider;
  const providerCapabilities = vmProvider.capabilities();
  // Usage capture is an org switch, not a recipe one: every workspace of a
  // capturing org boots with the transcript mounts so its runs join the
  // corpus (plans/RECIPES.md, decision 4).
  const orgCapture = await first<{ usage_capture: number }>(runtime.db, {
    q: "SELECT usage_capture FROM orgs WHERE id = ?1 LIMIT 1",
    v: [orgId],
  });
  const shaping: BootShaping = {
    usageCapture: orgCapture?.usage_capture === 1,
  };
  // Ask the provider that will own this VM for its own bootstrap lines. A
  // provider that answers nothing gets a script with no other provider's lines
  // in it (plans/PROVIDER-BOOTSTRAP.md).
  const providerAptSetup = vmProvider.bootstrapAptSetup?.();
  if (providerAptSetup !== undefined) shaping.providerAptSetup = providerAptSetup;
  if (recipe !== undefined) shaping.recipe = recipe.bootstrap;
  // Template repos ride the bootstrap as a detached clone loop; an empty
  // list stays absent so the emitted bytes match every pre-repo pin.
  if (repos.length > 0) shaping.repos = repos.map(({ repo }) => repo);
  const id = crypto.randomUUID();
  const capability = randomToken();
  const now = Date.now();
  const phoneHomeUrl = `${requestOrigin}/workspaces/${id}/phone-home/${capability}`;
  const name = input.name ?? (template === null
    ? randomWorkspaceName()
    : await templateWorkspaceName(runtime.db, orgId, template.name));
  // Claude's Remote Control names its target after the box hostname. Give the
  // box the workspace name. Without it every workspace shows the same hex
  // container id in claude.ai/code, and a person cannot pick one. The boot
  // script renders once, here. A later rename does not reach the box.
  shaping.boxHostname = boxHostname(name, id);

  const inserted = await rows(runtime.db, {
    q: `INSERT INTO workspaces
        (id, name, owner_id, org_id, owner_membership_id, machine_type_id,
         phase, revision, volume_id, phone_home_hash, manifest, org_share_role,
         environment, agent_rule_id, recipe_id, compute_credential_source,
         created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'creating', 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15
        WHERE (
          SELECT COUNT(*) FROM workspaces
          WHERE org_id = ?4 AND phase IN (${VM_SLOT_PHASES})
        ) < (SELECT vm_limit FROM orgs WHERE id = ?4)
        RETURNING id`,
    v: [
      id,
      name,
      principal.id,
      orgId,
      membershipId,
      machineTypeId,
      input.volumeId ?? null,
      await hashSecret(capability),
      enablementManifestJson(input.manifest, requested),
      input.orgShareRole ?? null,
      storedWorkspaceEnvironment(environment ?? undefined),
      agentRuleId,
      recipe?.recipeId ?? null,
      vmResolution.credentialSource,
      now,
    ],
  });
  if (inserted.length !== 1) {
    throw new HttpError(
      409,
      "organization workspace quota reached; destroy an existing workspace before creating another",
    );
  }
  if (template !== null) {
    await attachTemplateFolders(runtime.db, template.id, id, principal, now);
  }
  // Declared out here so the catch below can reclaim a volume whose workspace
  // never reached a VM. It bills monthly and nothing else can reach it.
  let autoVolumeId: string | undefined;
  try {
    // The size check runs on a tunnel-less build so a 413 always fires
    // before any Cloudflare resource exists (the deleted row then owes
    // nothing). The token install part we append afterwards is small
    // and ours; a razor-edge overflow webApps as a provider error and
    // the janitor reclaims the tunnel.
    const baseUserData = buildUserData(
      input.sshPublicKey,
      phoneHomeUrl,
      runtime.vars.boxImageRef,
      input.userData,
      runtime.vars.boxImageTag,
      runtime.vars.boxImageSha256,
      undefined,
      shaping,
    );
    const maxUserDataBytes = providerCapabilities.maxUserDataBytes ?? null;
    if (maxUserDataBytes !== null) {
      const encoder = new TextEncoder();
      const callerBytes = encoder.encode(input.userData ?? "").byteLength;
      const totalBytes = encoder.encode(baseUserData).byteLength;
      const generatedBytes = totalBytes - callerBytes;
      if (totalBytes > maxUserDataBytes) {
        throw new HttpError(
          413,
          `userData exceeds the provider limit: caller UTF-8 bytes ${callerBytes} + generated bootstrap bytes ${generatedBytes} = ${totalBytes} > ${maxUserDataBytes}`,
        );
      }
    }
    // The workspace's own disk. It holds /var/lib/blitz, which is the docker
    // store and /workspace both, so a destroyed workspace can come back on it.
    // An explicit volumeId from the caller wins. A provider that cannot place
    // a volume answers null, and the workspace runs on the VM's own disk
    // exactly as it did before.
    const autoVolume = input.volumeId !== undefined
      ? null
      : await provisionWorkspaceVolume({
          db: runtime.db,
          provider: vmProvider,
          createVolume: async (volumeName, sizeGb, location) => {
            const resolved = await runtime.providers.volume.forOrg(
              orgId,
              vmResolution.credentialSource,
            );
            return resolved.provider.createVolume({
              name: volumeName,
              sizeGb,
              location,
            });
          },
          deleteVolume: async (volumeId) => {
            const resolved = await runtime.providers.volume.forOrg(
              orgId,
              vmResolution.credentialSource,
            );
            await resolved.provider.deleteVolume(volumeId);
          },
          workspaceId: id,
          workspaceName: name,
          machineTypeId,
          orgId,
          membershipId,
          credentialSource: vmResolution.credentialSource,
          now: Date.now(),
        });
    if (autoVolume !== null) {
      autoVolumeId = autoVolume.id;
      await rows(runtime.db, {
        q: `UPDATE workspaces SET volume_id = ?1, updated_at = ?2
            WHERE id = ?3 AND phase = 'creating'`,
        v: [autoVolume.id, Date.now(), id],
      });
    }
    const volumeId = input.volumeId ?? autoVolume?.id;
    // Providers that cannot proxy their own webApp endpoints (cloud VMs) get a
    // per-workspace tunnel; identifiers persist onto the row before the
    // VM exists so a crash can never orphan Cloudflare resources.
    const workspaceTunnels = runtime.providers.workspaceTunnels;
    const tunnel = workspaceTunnels !== undefined && vmProvider.proxyWebApp === undefined
      ? await workspaceTunnels.provision(runtime.db, id)
      : undefined;
    const userData = tunnel === undefined
      ? baseUserData
      : buildUserData(
          input.sshPublicKey,
          phoneHomeUrl,
          runtime.vars.boxImageRef,
          input.userData,
          runtime.vars.boxImageTag,
          runtime.vars.boxImageSha256,
          tunnel,
          shaping,
        );
    // A provider that attaches during create hands the guest a disk that is
    // already present at first boot. The bootstrap scans /dev/disk/by-id once,
    // with no retry, so attaching afterwards raced that scan and could leave
    // the box with no persistent disk and no error.
    const attachesAtCreate = providerCapabilities.attachesVolumesAtCreate === true;
    const createInput: CreateVmInput = {
      workspaceId: id,
      machineTypeId,
      sshPublicKey: input.sshPublicKey,
      phoneHomeUrl,
      userData,
    };
    if (attachesAtCreate && volumeId !== undefined) createInput.volumeIds = [volumeId];
    const vm = await vmProvider.createVm(createInput);
    await rows(runtime.db, {
      q: `UPDATE workspaces
          SET vm_id = ?1, updated_at = ?2
          WHERE id = ?3 AND phase = 'creating'`,
      v: [vm.id, Date.now(), id],
    });
    if (volumeId !== undefined && !attachesAtCreate) {
      const volume = await runtime.providers.volume.forOrg(
        orgId,
        vmResolution.credentialSource,
      );
      await volume.provider.attachVolume(volumeId, vm.id);
    }
    if (volumeId !== undefined) {
      // A reused volume is live again, so its retention clock stops.
      await rows(runtime.db, markVolumeAttachedQuery(volumeId));
    }
    await rows(runtime.db, {
      q: `UPDATE workspaces
          SET ssh_host = ?1, ssh_port = ?2, ssh_user = ?3,
              revision = revision + 1, updated_at = ?4
          WHERE id = ?5 AND phase = 'creating'`,
      v: [vm.host, vm.port, vm.user, Date.now(), id],
    });
  } catch (error) {
    // The workspace never got a VM, so its auto-created volume holds nothing
    // and no later path can reach it. Leaving it behind bills every month.
    if (autoVolumeId !== undefined) {
      try {
        const resolved = await runtime.providers.volume.forOrg(
          orgId,
          vmResolution.credentialSource,
        );
        await resolved.provider.deleteVolume(autoVolumeId);
        await transaction(runtime.db, [
          {
            q: "DELETE FROM volume_ownership WHERE volume_id = ?1 AND org_id = ?2",
            v: [autoVolumeId, orgId],
          },
          {
            q: "UPDATE workspaces SET volume_id = NULL WHERE id = ?1",
            v: [id],
          },
        ]);
      } catch (cleanupError) {
        // The volume outlives the failed create. Say so: it bills until an
        // operator removes it, and silence here reads as a clean rollback.
        runtime.reportError(
          "workspace_create_volume_cleanup_failed",
          cleanupError instanceof Error
            ? cleanupError
            : new Error(`volume ${autoVolumeId} survived a failed create`),
        );
      }
    }
    if (
      error instanceof HttpError &&
      (error.status === 503 || error.status === 413)
    ) {
      await rows(runtime.db, {
        q: "DELETE FROM workspaces WHERE id = ?1 AND phase = 'creating' RETURNING id",
        v: [id],
      });
      throw error;
    }
    return markCreateError(
      runtime.db,
      id,
      providerOperationError(error),
      Date.now(),
    );
  }

  // Recorded only once the VM exists. The 503 and 413 branches above delete
  // the workspace row outright, and a child row would hold that delete open;
  // an errored create never boots, so it has nothing to clone anyway.
  await insertWorkspaceRepos(runtime.db, id, repos);
  const row = await workspaceById(runtime.db, id);
  if (row === null) throw new Error("workspace disappeared during create");
  return row;
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
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row, "owner") }, 201);
  });

  router.get("/workspaces", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const result = await rows<WorkspaceRow>(runtime.db, {
      q: `SELECT w.*, grant.role AS grant_role,
                 owner_user.name AS owner_name,
                 owner_user.avatar_url AS owner_avatar_url
          FROM workspaces w
          JOIN memberships owner ON owner.id = w.owner_membership_id
          JOIN users owner_user ON owner_user.id = owner.user_id
          LEFT JOIN workspace_grants grant
            ON grant.workspace_id = w.id AND grant.membership_id = ?1
          WHERE w.org_id = ?2 AND w.phase != 'destroyed'
          ORDER BY w.created_at, w.id`,
      v: [principal.membershipId, principal.orgId],
    });
    return context.json<PollResponse>({
      workspaces: result.map((row) =>
        workspaceView(row, workspaceRole(principal, row), runtime.reportError)),
    });
  });

  /**
   * Destroyed workspaces whose volume is still alive.
   *
   * This is the recreate history. `GET /workspaces` hides destroyed rows, so
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
    const result = await rows<WorkspaceRow>(runtime.db, {
      q: `SELECT w.*, grant.role AS grant_role,
                 owner_user.name AS owner_name,
                 owner_user.avatar_url AS owner_avatar_url
          FROM workspaces w
          JOIN memberships owner ON owner.id = w.owner_membership_id
          JOIN users owner_user ON owner_user.id = owner.user_id
          JOIN volume_ownership vol ON vol.volume_id = w.volume_id
          LEFT JOIN workspace_grants grant
            ON grant.workspace_id = w.id AND grant.membership_id = ?1
          WHERE w.org_id = ?2 AND w.phase = 'destroyed'
            AND w.volume_id IS NOT NULL AND vol.org_id = ?2
          ORDER BY w.updated_at DESC, w.id
          LIMIT 100`,
      v: [principal.membershipId, principal.orgId],
    });
    return context.json<PollResponse>({
      workspaces: result.map((row) =>
        workspaceView(row, workspaceRole(principal, row), runtime.reportError)),
    });
  });

  /**
   * Brings a destroyed workspace back on its own volume.
   *
   * The new workspace is a new row with a new id, because the old row is the
   * tombstone that proves the old VM is gone. It inherits the name, machine
   * type, volume, environment, agent rule and share role of the row it came
   * from. The machine type is inherited rather than chosen, because the volume
   * only attaches inside its own location.
   *
   * The volume moves to the new row and the old row lets go of it, so one
   * volume is never claimed by two workspaces.
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
    if (row.phase !== "destroyed") {
      throw new HttpError(409, "only a destroyed workspace can be recreated");
    }
    if (row.volume_id === null) {
      throw new HttpError(409, "workspace kept no volume, so it cannot be recreated");
    }
    // The SSH key is the caller's, not the workspace's: the row never stored
    // one, and a key from weeks ago may not be the key they hold now. Without
    // this the recreated box came up with no authorized key at all and the
    // owner could not reach their own restored disk. Proven on a real
    // destroy/recreate pair on 2026-08-27.
    const overrides = await readOptionalJson(context.req.raw);
    const request: CreateWorkspaceRequest = {
      machineTypeId: row.machine_type_id,
      volumeId: row.volume_id,
    };
    if (overrides.sshPublicKey !== undefined) request.sshPublicKey = overrides.sshPublicKey;
    if (row.name !== null) request.name = row.name;
    if (row.agent_rule_id !== null) request.agentRuleId = row.agent_rule_id;
    if (row.org_share_role !== null && row.org_share_role !== undefined) {
      request.orgShareRole = row.org_share_role;
    }
    const environment = workspaceEnvironmentFromJson(row.environment);
    if (environment !== null) request.environment = environment;
    // The tombstone lets go first. A create that fails still leaves the volume
    // owned by the org, so the next attempt finds it; a create that succeeds
    // must never leave two rows pointing at one disk.
    await rows(runtime.db, {
      q: `UPDATE workspaces SET volume_id = NULL, updated_at = ?1
          WHERE id = ?2 AND phase = 'destroyed'`,
      v: [Date.now(), id],
    });
    try {
      const created = await performWorkspaceCreate(
        runtime,
        principal,
        new URL(context.req.url).origin,
        request,
      );
      return context.json<CreateWorkspaceResponse>(
        { workspace: workspaceView(created, "owner") },
        201,
      );
    } catch (error) {
      // Hand the volume back to the tombstone so the history row reappears and
      // the operator can try again. Without this a failed recreate hides the
      // disk until the retention clock deletes it.
      await rows(runtime.db, {
        q: `UPDATE workspaces SET volume_id = ?1, updated_at = ?2
            WHERE id = ?3 AND phase = 'destroyed' AND volume_id IS NULL`,
        v: [row.volume_id, Date.now(), id],
      });
      throw error;
    }
  });

  router.get("/workspaces/:id", async (context) => {
    // The SPA's workspace page shares this path. A browser refresh navigates
    // here with an HTML accept; serve the app shell and keep JSON for fetch
    // callers. Deeper /workspaces/:id/* paths (the webApp proxy) never take
    // this branch.
    const runtime = runtimeFactory(context);
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
    const principal = await requirePrincipal(context);
    const row = await workspaceById(runtime.db, context.req.param("id"));
    if (row === null || row.org_id !== principal.orgId || row.phase === "destroyed") {
      throw new HttpError(404, "workspace not found");
    }
    const grant = principal.membershipId === null
      ? null
      : await first<{ role: "editor" | "viewer" }>(runtimeFactory(context).db, {
          q: `SELECT role FROM workspace_grants
              WHERE workspace_id = ?1 AND membership_id = ?2 LIMIT 1`,
          v: [row.id, principal.membershipId],
        });
    row.grant_role = grant?.role ?? null;
    const role = workspaceRole(principal, row);
    if (role === null) throw new HttpError(403, "forbidden");
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row, role) });
  });

  const webApp = async (context: CoreContext): Promise<Response> => {
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    const access = await webAppWorkspaceForRequest(runtime, requirePrincipal, context, id);
    const row = access.workspace;
    if (row.vm_id === null) {
      throw new HttpError(409, "workspace is not ready for webapp access");
    }
    const provider = providerForVmId(runtime, row.vm_id);
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
    // place, and each provider ships its guest on its own release channel —
    // so the cutoff comes from the provider that owns this VM, never from a
    // single global date.
    // TODO(identity-phase-4): drop the gate once every pre-ticket VM is gone.
    const capabilities = provider.capabilities();
    const ticketsSince = capabilities.webAppTicketsSinceMs;
    const ticketCapable = ticketsSince !== undefined && row.created_at >= ticketsSince;
    // A viewer needs a guest that actually holds the line: earlier images
    // could be talked into a writable shell, and their observer path spawned
    // sessions on demand. The agent port stays closed to viewers on every
    // image — the actor still accepts any valid ticket once connected.
    const viewerGuardsSince = capabilities.webAppViewerGuardsSinceMs;
    const viewerSafe = viewerGuardsSince !== undefined && row.created_at >= viewerGuardsSince;
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
        upstream = await provider.proxyWebApp(
          row.vm_id,
          port,
          pathAndQuery,
          authenticatedRequest,
        );
      } else if (workspaceTunnels !== undefined && row.tunnel_hostname !== null) {
        upstream = await workspaceTunnels.proxy(
          row.tunnel_hostname,
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

  router.delete("/workspaces/:id", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const orgId = principal.orgId;
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    let row = await workspaceById(runtime.db, id);
    if (row === null || row.org_id !== principal.orgId) {
      throw new HttpError(404, "workspace not found");
    }
    if (!canControlWorkspace(principal, row)) throw new HttpError(403, "forbidden");
    if (row.phase === "destroyed") {
      return context.json<CreateWorkspaceResponse>({
        workspace: workspaceView(row, workspaceRole(principal, row)),
      });
    }
    const vmProvider = row.vm_id === null
      ? undefined
      : (await runtime.providers.vmRegistry.resolveVmId(
          row.vm_id,
          orgId,
          row.compute_credential_source ?? "deployment",
        ))?.provider;
    if (row.vm_id !== null && vmProvider === undefined) {
      throw new HttpError(409, `no VM provider owns VM ID ${row.vm_id}`);
    }

    await rows(runtime.db, {
      q: `UPDATE workspaces
          SET phase = 'destroying', error = NULL, phone_home_hash = NULL,
              revision = revision + 1, updated_at = ?1
          WHERE id = ?2 AND phase IN ('creating', 'ready', 'error')`,
      v: [Date.now(), id],
    });
    row = await workspaceById(runtime.db, id);
    if (row === null) throw new Error("workspace disappeared during destroy");

    if (row.vm_id !== null && vmProvider !== undefined) {
      if (row.volume_id !== null) {
        await vmProvider.shutdown(row.vm_id);
        const volume = await runtime.providers.volume.forOrg(
          orgId,
          row.compute_credential_source ?? "deployment",
        );
        await volume.provider.detachVolume(row.volume_id, row.vm_id);
        // The retention clock starts here. The volume is the only copy of
        // /workspace once the VM is gone, so the destroy stays reversible
        // until the janitor reclaims it.
        await rows(runtime.db, markVolumeDetachedQuery(row.volume_id, Date.now()));
      }
      await vmProvider.destroy(row.vm_id);
    }

    const workspaceTunnels = runtime.providers.workspaceTunnels;
    if (workspaceTunnels !== undefined) {
      const cleanup = await workspaceTunnels.cleanup(runtime.db, row);
      if (cleanup.errors.length > 0) {
        // Honest destroy: the row stays in destroying with its remaining
        // identifiers; the janitor retries until Cloudflare cleanup lands.
        //
        // Report them. The caller gets a 200 and the janitor's own transition
        // sets `error` back to NULL, so these errors are the only account of
        // why a destroy needed two attempts, and dropping them is what made
        // the first such destroy unexplainable.
        runtime.reportError(
          "workspace_destroy_cleanup_incomplete",
          new Error(`workspace ${id}: ${cleanup.errors.join("; ")}`),
        );
        const pending = await workspaceById(runtime.db, id);
        if (pending === null) throw new Error("workspace disappeared during destroy");
        return context.json<CreateWorkspaceResponse>({
          workspace: workspaceView(pending, workspaceRole(principal, pending)),
        });
      }
    }

    await transaction(runtime.db, [
      revokeWorkspaceLeasesQuery(id),
      { q: "DELETE FROM boxes WHERE workspace_id = ?1", v: [id] },
      { q: "DELETE FROM webapp_state WHERE workspace_id = ?1", v: [id] },
      {
        q: `UPDATE workspaces
            SET phase = 'destroyed', vm_id = NULL, ssh_host = NULL, ssh_port = NULL,
                ssh_user = NULL, ssh_host_public_key = NULL, error = NULL,
                revision = revision + 1, updated_at = ?1
            WHERE id = ?2 AND phase = 'destroying'`,
        v: [Date.now(), id],
      },
    ]);
    const destroyed = await workspaceById(runtime.db, id);
    if (destroyed === null) throw new Error("workspace disappeared after destroy");
    return context.json<CreateWorkspaceResponse>({
      workspace: workspaceView(destroyed, workspaceRole(principal, destroyed)),
    });
  });

  router.post("/workspaces/:id/phone-home/:token", async (context) => {
    const id = context.req.param("id");
    const token = context.req.param("token");
    const runtime = runtimeFactory(context);
    const db = runtime.db;
    const row = await workspaceById(db, id);
    if (row === null) throw new HttpError(404, "workspace not found");
    if (row.phone_home_used === 1) {
      throw new HttpError(409, "phone_home capability already used");
    }
    if (
      row.phone_home_hash === null ||
      !(await matchesStoredHash(token, row.phone_home_hash))
    ) {
      throw new HttpError(401, "invalid phone_home capability");
    }
    if (row.phase !== "creating") throw new HttpError(409, "workspace is not creating");
    const phoneHome = await readPhoneHome(context);
    if (phoneHome.kind === "failure") {
      const consumed = await rows(db, {
        q: `UPDATE workspaces
            SET phase = 'error', error = ?1, phone_home_used = 1,
                phone_home_hash = NULL, revision = revision + 1, updated_at = ?2
            WHERE id = ?3 AND phase = 'creating' AND phone_home_used = 0
              AND phone_home_hash = ?4
            RETURNING id`,
        v: [phoneHome.message, Date.now(), id, row.phone_home_hash],
      });
      if (consumed.length !== 1) {
        throw new HttpError(409, "phone_home capability already used");
      }
      return context.body(null, 204);
    }
    if (row.vm_id === null || row.ssh_host === null) {
      throw new HttpError(409, "workspace provisioning is not recorded yet");
    }

    const hostKey = phoneHome.hostPublicKey;
    const credentials = await issueBoxTokens();
    const boxId = crypto.randomUUID();
    const now = Date.now();
    const results = await transaction(db, [
      {
        q: `INSERT INTO boxes (id, principal_id, workspace_id, created_at)
            SELECT ?1, owner_id, id, ?2 FROM workspaces
            WHERE id = ?3 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?4`,
        v: [boxId, now, id, row.phone_home_hash],
      },
      {
        q: `INSERT INTO box_token_families
            (box_id, access_hash, refresh_hash, access_issued_at, generation)
            SELECT ?1, ?2, ?3, ?4, 1 FROM workspaces
            WHERE id = ?5 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?6`,
        v: [
          boxId,
          credentials.accessHash,
          credentials.refreshHash,
          now,
          id,
          row.phone_home_hash,
        ],
      },
      {
        q: `UPDATE workspaces
            SET phase = 'ready', ssh_host_public_key = ?1, phone_home_used = 1,
                phone_home_hash = NULL, revision = revision + 1, updated_at = ?2
            WHERE id = ?3 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?4
            RETURNING id`,
        v: [hostKey, now, id, row.phone_home_hash],
      },
    ]);
    if (results[2]?.length !== 1) {
      throw new HttpError(409, "phone_home capability already used");
    }
    // The guest just came up: materialize its attached Drive folders now
    // instead of waiting for the next scheduled sweep, retrying briefly while
    // the tunnel finishes connecting.
    scheduleSync(runtime, (syncRuntime) => runReadyWorkspaceFileSync(syncRuntime, id));
    const webAppToken = runtime.providers.webAppAuth === undefined
      ? undefined
      : await runtime.providers.webAppAuth.tokenFor(id);
    return context.json<PhoneHomeResponse>(createPhoneHomeResponse(
      boxId,
      credentials.accessToken,
      credentials.refreshToken,
      webAppToken === undefined ? undefined : id,
      webAppToken,
    ));
  });
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
