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
import { isMicrovmProviderId } from "./providers/microvm.js";
import type { SurfacePort, VmProvider } from "./providers/types.js";
import type {
  CoreContext,
  CoreRouter,
  CoreRuntime,
  RuntimeFactory,
} from "./runtime.js";
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  Phase,
  PollResponse,
  RetryAction,
  WorkspaceView,
} from "./wire.js";

export interface WorkspaceRow {
  id: string;
  machine_type_id: string;
  owner_id: string;
  phase: Phase;
  revision: number;
  vm_id: string | null;
  volume_id: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_host_public_key: string | null;
  error: string | null;
  phone_home_hash: string | null;
  phone_home_used: number;
  created_at: number;
  updated_at: number;
  manifest: string | null;
  tunnel_id: string | null;
  surface_hostname: string | null;
  dns_record_id: string | null;
}

const retryActions = {
  creating: "poll",
  ready: null,
  destroying: "poll",
  destroyed: "create",
  error: "destroy",
} satisfies Record<Phase, RetryAction>;

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
}

function machineTypeIdForRow(row: WorkspaceRow): string {
  return row.machine_type_id === "unknown"
      && row.vm_id !== null
      && isMicrovmProviderId(row.vm_id)
    ? "mv-legacy"
    : row.machine_type_id;
}

export function workspaceView(row: WorkspaceRow): WorkspaceView {
  const hasSsh = row.ssh_host !== null && row.ssh_port !== null && row.ssh_user !== null;
  return {
    id: row.id,
    machineTypeId: machineTypeIdForRow(row),
    phase: row.phase,
    retryAction: retryActions[row.phase],
    canObserve: row.phase === "ready",
    launchable: row.phase === "ready",
    revision: row.revision,
    ssh:
      hasSsh && row.phase !== "destroyed"
        ? {
            host: row.ssh_host ?? "",
            port: row.ssh_port ?? 22,
            user: row.ssh_user ?? "root",
            hostPublicKey: row.ssh_host_public_key,
          }
        : null,
    volumeId: row.volume_id,
    error: row.error,
  };
}

async function workspaceById(db: Db, id: string): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, {
    q: "SELECT * FROM workspaces WHERE id = ?1 LIMIT 1",
    v: [id],
  });
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
  const result: CreateWorkspaceRequest = {
    machineTypeId: requiredString(value.machineTypeId, "machineTypeId", 256),
  };
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
): PhoneHomeResponse {
  return {
    box_id: boxId,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
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
    const input = parseCreateWorkspace(await readJson(context.req.raw));
    const runtime = runtimeFactory(context);
    const vmProvider = runtime.providers.vmRegistry.forMachineType(
      input.machineTypeId,
    );
    const providerCapabilities = vmProvider.capabilities();
    if (input.volumeId !== undefined && !providerCapabilities.volumes) {
      throw new HttpError(
        400,
        `machine type ${input.machineTypeId} does not support volumes`,
      );
    }
    const id = crypto.randomUUID();
    const capability = randomToken();
    const now = Date.now();
    const phoneHomeUrl = `${new URL(context.req.url).origin}/workspaces/${id}/phone-home/${capability}`;

    const inserted = await rows(runtime.db, {
      q: `INSERT INTO workspaces
          (id, owner_id, machine_type_id, phase, revision, volume_id,
           phone_home_hash, manifest, created_at, updated_at)
          SELECT ?1, ?2, ?3, 'creating', 1, ?4, ?5, ?6, ?7, ?7
          WHERE (
            SELECT COUNT(*) FROM workspaces
            WHERE owner_id = ?2 AND phase IN ('creating', 'ready', 'destroying', 'error')
          ) < ?8
          RETURNING id`,
      v: [
        id,
        principal.id,
        input.machineTypeId,
        input.volumeId ?? null,
        await hashSecret(capability),
        input.manifest === undefined ? null : manifestJson(input.manifest),
        now,
        runtime.vars.maxConcurrentWorkspaces,
      ],
    });
    if (inserted.length !== 1) {
      throw new HttpError(
        409,
        `concurrent workspace quota of ${runtime.vars.maxConcurrentWorkspaces} reached; destroy an existing workspace before creating another`,
      );
    }

    try {
      // The size check runs on a surface-less build so a 413 always fires
      // before any Cloudflare resource exists (the deleted row then owes
      // nothing). The surface install part we append afterwards is small
      // and ours; a razor-edge overflow surfaces as a provider error and
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
      // Providers that cannot proxy their own surface (cloud VMs) get a
      // per-workspace tunnel; identifiers persist onto the row before the
      // VM exists so a crash can never orphan Cloudflare resources.
      const workspaceTunnels = runtime.providers.workspaceTunnels;
      const tunnel = workspaceTunnels !== undefined && vmProvider.proxySurface === undefined
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
        machineTypeId: input.machineTypeId,
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
      return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) }, 201);
    }

    const row = await workspaceById(runtime.db, id);
    if (row === null) throw new Error("workspace disappeared during create");
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) }, 201);
  });

  router.get("/workspaces", async (context) => {
    const principal = await requirePrincipal(context);
    const result = await rows<WorkspaceRow>(runtimeFactory(context).db, {
      q: "SELECT * FROM workspaces WHERE owner_id = ?1 ORDER BY created_at, id",
      v: [principal.id],
    });
    return context.json<PollResponse>({ workspaces: result.map(workspaceView) });
  });

  const surface = async (context: CoreContext): Promise<Response> => {
    const principal = await requirePrincipal(context);
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    const row = await workspaceById(runtime.db, id);
    if (row === null || row.owner_id !== principal.id) {
      throw new HttpError(404, "workspace not found");
    }
    if (row.vm_id === null) {
      throw new HttpError(409, "workspace is not ready for surface access");
    }
    const provider = providerForVmId(runtime, row.vm_id);
    const rawPort = context.req.param("port");
    if (rawPort !== "7444" && rawPort !== "7445") {
      throw new HttpError(400, "surface port must be 7444 or 7445");
    }
    const port: SurfacePort = rawPort === "7444" ? 7444 : 7445;
    const requestURL = new URL(context.req.url);
    const routePrefix = `/workspaces/${encodeURIComponent(id)}/surface/${rawPort}`;
    if (!requestURL.pathname.startsWith(routePrefix)) {
      throw new HttpError(400, "invalid workspace surface path");
    }
    const suffix = requestURL.pathname.slice(routePrefix.length);
    const pathAndQuery = `${suffix === "" ? "/" : suffix}${requestURL.search}`;
    const workspaceTunnels = runtime.providers.workspaceTunnels;
    let upstream: Response | null;
    try {
      if (provider.proxySurface !== undefined) {
        upstream = await provider.proxySurface(
          row.vm_id,
          port,
          pathAndQuery,
          context.req.raw,
        );
      } else if (workspaceTunnels !== undefined && row.surface_hostname !== null) {
        upstream = await workspaceTunnels.proxy(
          row.surface_hostname,
          row.id,
          port,
          pathAndQuery,
          context.req.raw,
        );
      } else {
        throw new HttpError(503, "workspace has no surface tunnel");
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `workspace surface proxy is unavailable: ${detail}`);
    }
    if (upstream === null) {
      throw new HttpError(409, "workspace VM is not owned by its resolved provider");
    }
    if (!isWebSocketUpgrade(context.req.raw)) return upstream;
    if (upstream.status !== 101 || upstream.webSocket === null) return upstream;
    return websocketProxyResponse(upstream);
  };

  router.all("/workspaces/:id/surface/:port", surface);
  router.all("/workspaces/:id/surface/:port/*", surface);

  router.delete("/workspaces/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    let row = await workspaceById(runtime.db, id);
    if (row === null || row.owner_id !== principal.id) {
      throw new HttpError(404, "workspace not found");
    }
    if (row.phase === "destroyed") {
      return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) });
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
        return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(pending) });
      }
    }

    await transaction(runtime.db, [
      revokeWorkspaceLeasesQuery(id),
      { q: "DELETE FROM boxes WHERE workspace_id = ?1", v: [id] },
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
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(destroyed) });
  });

  router.post("/workspaces/:id/phone-home/:token", async (context) => {
    const id = context.req.param("id");
    const token = context.req.param("token");
    const db = runtimeFactory(context).db;
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
    return context.json<PhoneHomeResponse>(createPhoneHomeResponse(
      boxId,
      credentials.accessToken,
      credentials.refreshToken,
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
      closeWebSocket(source, 1011, "surface proxy send failed");
      closeWebSocket(target, 1011, "surface proxy send failed");
    }
  });
  source.addEventListener("close", (event) => {
    closeWebSocket(target, event.code, event.reason);
    closeWebSocket(source, event.code, event.reason);
  });
  source.addEventListener("error", () => {
    closeWebSocket(source, 1011, "surface proxy error");
    closeWebSocket(target, 1011, "surface proxy error");
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
