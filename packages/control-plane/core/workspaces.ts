import { buildUserData } from "./cloud-init.js";
import { manifestJson, parseManifest } from "./credentials/manifest.js";
import { revokeWorkspaceLeasesQuery } from "./credentials/leases.js";
import { hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
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
import type { WebAppPort, VmProvider } from "./providers/types.js";
import { requireWorkspaceWebAppAuth, WEBAPP_TOKEN_HEADER } from "./webapp-tickets.js";
import {
  attachTemplateFolders,
  templateWorkspaceName,
  workspaceTemplateForCreate,
} from "./workspace-templates.js";
import { runReadyWorkspaceFileSync, scheduleSync } from "./files/sync.js";
import type {
  CoreContext,
  CoreRouter,
  CoreRuntime,
  RuntimeFactory,
} from "./runtime.js";
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  PollResponse,
} from "./wire.js";
export type { WorkspaceRow } from "./workspace-records.js";

const WORKSPACE_ERROR_MAX_LENGTH = 1_024;

/** Only the paths the browser app actually uses may reach a box.
 *
 * The guest exposes far more than the app needs: dufs serves
 * /srv/blitz-files, which symlinks the agent's HOME (holding its OAuth
 * credentials) next to /workspace, and both the gateway and the actor answer
 * /admin/drain — a disconnect-everyone switch — for any valid ticket, with no
 * role check. Those guards live in the guest image, which never upgrades in
 * place, so this allowlist is the only lever that protects boxes already
 * running. Keep it in sync with `standaloneResolver` in the webApp. */
function webAppPathAllowed(port: WebAppPort, path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  // Rejects both raw and percent-encoded traversal out of an allowed prefix.
  if (decoded.split("/").includes("..")) return false;
  if (port === 7444) {
    // The actor's only browser surface is the ACP websocket at the root; its
    // /admin/drain is reached server-side by the revocation drain, never here.
    return decoded === "/";
  }
  if (decoded === "/ports" || decoded === "/previews" || decoded === "/terminal/ws") {
    return true;
  }
  return decoded === "/workspace"
    || decoded.startsWith("/workspace/")
    || decoded.startsWith("/preview/");
}
/** 2026-08-17 19:10 UTC: first moment new VMs booted the ticket-verifying
 * gateway (box image 20260817a). Older VMs byte-compare the static token. */
const TICKET_GATEWAYS_SINCE_MS = 1_786_993_800_000;
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
  return result;
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

function requestWithWebAppCredential(request: Request, credential: string): Request {
  const headers = new Headers(request.headers);
  headers.set(WEBAPP_TOKEN_HEADER, credential);
  return new Request(request, { headers });
}

async function readPhoneHome(context: CoreContext): Promise<PhoneHomeRequest> {
  return parsePhoneHomeRequest(
    context.req.header("content-type") ?? "",
    await readText(context.req.raw),
  );
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
    const input = parseCreateWorkspace(await readJson(context.req.raw));
    const runtime = runtimeFactory(context);
    const template = input.templateId === undefined
      ? null
      : await workspaceTemplateForCreate(runtime.db, input.templateId, principal.orgId);
    // The template's machine type is the default; an explicit machineTypeId
    // in the request still wins so a template create can be customized.
    const machineTypeId = input.machineTypeId ?? template?.machine_type_id;
    if (machineTypeId === undefined) {
      throw new HttpError(400, "machineTypeId is required");
    }
    const vmProvider = runtime.providers.vmRegistry.forMachineType(machineTypeId);
    const providerCapabilities = vmProvider.capabilities();
    if (input.volumeId !== undefined && !providerCapabilities.volumes) {
      throw new HttpError(
        400,
        `machine type ${machineTypeId} does not support volumes`,
      );
    }
    if (input.volumeId !== undefined) {
      const owned = await first<{ volume_id: string }>(runtime.db, {
        q: `SELECT volume_id FROM volume_ownership
            WHERE volume_id = ?1 AND org_id = ?2 LIMIT 1`,
        v: [input.volumeId, principal.orgId],
      });
      if (owned === null) throw new HttpError(404, "volume not found");
    }
    const id = crypto.randomUUID();
    const capability = randomToken();
    const now = Date.now();
    const phoneHomeUrl = `${new URL(context.req.url).origin}/workspaces/${id}/phone-home/${capability}`;

    const inserted = await rows(runtime.db, {
      q: `INSERT INTO workspaces
          (id, name, owner_id, org_id, owner_membership_id, machine_type_id,
           phase, revision, volume_id, phone_home_hash, manifest, org_share_role,
           created_at, updated_at)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'creating', 1, ?7, ?8, ?9, ?10, ?11, ?11
          WHERE (
            SELECT COUNT(*) FROM workspaces
            WHERE org_id = ?4 AND phase IN ('creating', 'ready', 'destroying', 'error')
          ) < (SELECT vm_limit FROM orgs WHERE id = ?4)
          RETURNING id`,
      v: [
        id,
        input.name ?? (template === null
          ? randomWorkspaceName()
          : await templateWorkspaceName(runtime.db, principal.orgId, template.name)),
        principal.id,
        principal.orgId,
        principal.membershipId,
        machineTypeId,
        input.volumeId ?? null,
        await hashSecret(capability),
        input.manifest === undefined ? null : manifestJson(input.manifest),
        input.orgShareRole ?? null,
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
          );
      const vm = await vmProvider.createVm({
        workspaceId: id,
        machineTypeId,
        sshPublicKey: input.sshPublicKey,
        phoneHomeUrl,
        userData,
      });
      await rows(runtime.db, {
        q: `UPDATE workspaces
            SET vm_id = ?1, updated_at = ?2
            WHERE id = ?3 AND phase = 'creating'`,
        v: [vm.id, Date.now(), id],
      });
      if (input.volumeId !== undefined) {
        await runtime.providers.volume.attachVolume(input.volumeId, vm.id);
      }
      await rows(runtime.db, {
        q: `UPDATE workspaces
            SET ssh_host = ?1, ssh_port = ?2, ssh_user = ?3,
                revision = revision + 1, updated_at = ?4
            WHERE id = ?5 AND phase = 'creating'`,
        v: [vm.host, vm.port, vm.user, Date.now(), id],
      });
    } catch (error) {
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
      const row = await markCreateError(
        runtime.db,
        id,
        providerOperationError(error),
        Date.now(),
      );
      return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row, "owner") }, 201);
    }

    const row = await workspaceById(runtime.db, id);
    if (row === null) throw new Error("workspace disappeared during create");
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row, "owner") }, 201);
  });

  router.get("/workspaces", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const result = await rows<WorkspaceRow>(runtimeFactory(context).db, {
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
      workspaces: result.map((row) => workspaceView(row, workspaceRole(principal, row))),
    });
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
    const suffix = requestURL.pathname.slice(routePrefix.length);
    const path = suffix === "" ? "/" : suffix;
    if (!webAppPathAllowed(port, path)) {
      throw new HttpError(403, "path is not a workspace webApp surface");
    }
    const pathAndQuery = `${path}${requestURL.search}`;
    // Boxes boot the image pinned at their creation and never upgrade in
    // place. VMs from before the 20260817a pin run gateways that only
    // byte-compare the static token, so they keep receiving it.
    // TODO(identity-phase-4): drop the gate once every pre-ticket VM is gone.
    const ticketCapable = row.created_at >= TICKET_GATEWAYS_SINCE_MS;
    // Viewers stay refused on every deployed image. The gateway's read-only
    // force appends "ro" as a THIRD argument, so a request carrying a single
    // arg lands "ro" in blitz-term's session-key slot and the mode defaults
    // back to rw — a writable shell. Its read-only path also creates a
    // missing session, so an observer can spawn agents. Restore viewer
    // access only alongside a box image that fixes both.
    if (access.role === "viewer") {
      throw new HttpError(403, "read-only access arrives when this workspace VM is recycled");
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
    const authenticatedRequest = requestWithWebAppCredential(context.req.raw, credential);
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
      : providerForVmId(runtime, row.vm_id);

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
        await runtime.providers.volume.detachVolume(row.volume_id, row.vm_id);
      }
      await vmProvider.destroy(row.vm_id);
    }

    const workspaceTunnels = runtime.providers.workspaceTunnels;
    if (workspaceTunnels !== undefined) {
      const cleanup = await workspaceTunnels.cleanup(runtime.db, row);
      if (cleanup.errors.length > 0) {
        // Honest destroy: the row stays in destroying with its remaining
        // identifiers; the janitor retries until Cloudflare cleanup lands.
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
