import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  Phase,
  PollResponse,
  RetryAction,
  WorkspaceView,
} from "@blitzos/schema";
import type { Context, Hono } from "hono";
import { buildUserData } from "./cloud-init.js";
import { hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import {
  HttpError,
  isRecord,
  isSshPublicKey,
  readJson,
  readText,
  requiredString,
} from "./http.js";
import { issueBoxTokens } from "./oauth.js";
import type { Principal } from "./principals.js";
import type { AppEnv, AppDependencies } from "./types.js";

export interface WorkspaceRow {
  id: string;
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
}

const retryActions: Record<Phase, RetryAction> = {
  creating: "poll",
  ready: null,
  destroying: "poll",
  destroyed: "create",
  error: "destroy",
};

export function workspaceView(row: WorkspaceRow): WorkspaceView {
  const hasSsh = row.ssh_host !== null && row.ssh_port !== null && row.ssh_user !== null;
  return {
    id: row.id,
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

async function workspaceById(db: D1Database, id: string): Promise<WorkspaceRow | null> {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?1 LIMIT 1").bind(id).first<WorkspaceRow>();
}

function parseCreateWorkspace(value: unknown): CreateWorkspaceRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: CreateWorkspaceRequest = {
    machineTypeId: requiredString(value.machineTypeId, "machineTypeId", 256),
    sshPublicKey: requiredString(value.sshPublicKey, "sshPublicKey"),
  };
  if (!isSshPublicKey(result.sshPublicKey)) {
    throw new HttpError(400, "sshPublicKey must be an SSH public key");
  }
  if (value.volumeId !== undefined) result.volumeId = requiredString(value.volumeId, "volumeId", 256);
  if (value.userData !== undefined) result.userData = requiredString(value.userData, "userData", 48 * 1024);
  return result;
}

async function markCreateError(
  db: D1Database,
  id: string,
  message: string,
  now: number,
): Promise<WorkspaceRow> {
  await db
    .prepare(
      `UPDATE workspaces
       SET phase = 'error', error = ?1, phone_home_hash = NULL,
           revision = revision + 1, updated_at = ?2
       WHERE id = ?3 AND phase = 'creating'`,
    )
    .bind(message, now, id)
    .run();
  const row = await workspaceById(db, id);
  if (row === null) throw new Error("workspace disappeared during create");
  return row;
}

function phoneHomeKeys(value: unknown): string[] {
  if (isRecord(value) && Array.isArray(value.hostPublicKeys)) {
    return value.hostPublicKeys.filter(isSshPublicKey);
  }
  if (!isRecord(value)) return [];
  return ["pub_key_ed25519", "pub_key_ecdsa", "pub_key_rsa", "pub_key_dsa"]
    .map((field) => value[field])
    .filter(isSshPublicKey);
}

async function readPhoneHome(c: Context<AppEnv>): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) return readJson(c.req.raw);
  const text = await readText(c.req.raw);
  const form = new URLSearchParams(text);
  return Object.fromEntries(form.entries());
}

export function addWorkspaceRoutes(
  app: Hono<AppEnv>,
  deps: AppDependencies,
  requirePrincipal: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/workspaces", async (c) => {
    const principal = await requirePrincipal(c);
    const input = parseCreateWorkspace(await readJson(c.req.raw));
    const id = crypto.randomUUID();
    const capability = randomToken();
    const now = Date.now();
    const phoneHomeUrl = `${new URL(c.req.url).origin}/workspaces/${id}/phone-home/${capability}`;

    await c.env.DB
      .prepare(
        `INSERT INTO workspaces
         (id, owner_id, phase, revision, volume_id, phone_home_hash, created_at, updated_at)
         VALUES (?1, ?2, 'creating', 1, ?3, ?4, ?5, ?5)`,
      )
      .bind(id, principal.id, input.volumeId ?? null, await hashSecret(capability), now)
      .run();

    try {
      const vm = await deps.vmProvider.createVm({
        workspaceId: id,
        machineTypeId: input.machineTypeId,
        sshPublicKey: input.sshPublicKey,
        userData: buildUserData(input.sshPublicKey, phoneHomeUrl, input.userData),
      });
      await c.env.DB
        .prepare(
          `UPDATE workspaces
           SET vm_id = ?1, updated_at = ?2
           WHERE id = ?3 AND phase = 'creating'`,
        )
        .bind(vm.id, Date.now(), id)
        .run();
      if (input.volumeId !== undefined) {
        await deps.volumeProvider.attachVolume(input.volumeId, vm.id);
      }
      await c.env.DB
        .prepare(
          `UPDATE workspaces
           SET ssh_host = ?1, ssh_port = ?2, ssh_user = ?3,
               revision = revision + 1, updated_at = ?4
           WHERE id = ?5 AND phase = 'creating'`,
        )
        .bind(vm.host, vm.port, vm.user, Date.now(), id)
        .run();
    } catch {
      const row = await markCreateError(c.env.DB, id, "provider operation failed", Date.now());
      return c.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) }, 201);
    }

    const row = await workspaceById(c.env.DB, id);
    if (row === null) throw new Error("workspace disappeared during create");
    return c.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) }, 201);
  });

  app.get("/workspaces", async (c) => {
    const principal = await requirePrincipal(c);
    const result = await c.env.DB
      .prepare("SELECT * FROM workspaces WHERE owner_id = ?1 ORDER BY created_at, id")
      .bind(principal.id)
      .all<WorkspaceRow>();
    return c.json<PollResponse>({ workspaces: result.results.map(workspaceView) });
  });

  app.delete("/workspaces/:id", async (c) => {
    const principal = await requirePrincipal(c);
    const id = c.req.param("id");
    let row = await workspaceById(c.env.DB, id);
    if (row === null || row.owner_id !== principal.id) throw new HttpError(404, "workspace not found");
    if (row.phase === "destroyed") {
      return c.json<CreateWorkspaceResponse>({ workspace: workspaceView(row) });
    }

    await c.env.DB
      .prepare(
        `UPDATE workspaces
         SET phase = 'destroying', error = NULL, phone_home_hash = NULL,
             revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND phase IN ('creating', 'ready', 'error')`,
      )
      .bind(Date.now(), id)
      .run();
    row = await workspaceById(c.env.DB, id);
    if (row === null) throw new Error("workspace disappeared during destroy");

    if (row.volume_id !== null && row.vm_id !== null) {
      await deps.volumeProvider.detachVolume(row.volume_id, row.vm_id);
    }
    if (row.vm_id !== null) await deps.vmProvider.destroy(row.vm_id);

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM boxes WHERE workspace_id = ?1").bind(id),
      c.env.DB
        .prepare(
          `UPDATE workspaces
           SET phase = 'destroyed', vm_id = NULL, ssh_host = NULL, ssh_port = NULL,
               ssh_user = NULL, ssh_host_public_key = NULL, error = NULL,
               revision = revision + 1, updated_at = ?1
           WHERE id = ?2 AND phase = 'destroying'`,
        )
        .bind(Date.now(), id),
    ]);
    const destroyed = await workspaceById(c.env.DB, id);
    if (destroyed === null) throw new Error("workspace disappeared after destroy");
    return c.json<CreateWorkspaceResponse>({ workspace: workspaceView(destroyed) });
  });

  app.post("/workspaces/:id/phone-home/:token", async (c) => {
    const id = c.req.param("id");
    const token = c.req.param("token");
    const row = await workspaceById(c.env.DB, id);
    if (row === null) throw new HttpError(404, "workspace not found");
    if (row.phone_home_used === 1) throw new HttpError(409, "phone_home capability already used");
    if (
      row.phone_home_hash === null ||
      !(await matchesStoredHash(token, row.phone_home_hash))
    ) {
      throw new HttpError(401, "invalid phone_home capability");
    }
    if (row.phase !== "creating") throw new HttpError(409, "workspace is not creating");
    if (row.vm_id === null || row.ssh_host === null) {
      throw new HttpError(409, "workspace provisioning is not recorded yet");
    }

    const hostKey = phoneHomeKeys(await readPhoneHome(c))[0];
    if (hostKey === undefined) throw new HttpError(400, "an SSH host public key is required");
    const credentials = await issueBoxTokens();
    const boxId = crypto.randomUUID();
    const now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO boxes (id, principal_id, workspace_id, created_at)
           SELECT ?1, owner_id, id, ?2 FROM workspaces
           WHERE id = ?3 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?4`,
        )
        .bind(boxId, now, id, row.phone_home_hash),
      c.env.DB
        .prepare(
          `INSERT INTO box_token_families
           (box_id, access_hash, refresh_hash, access_issued_at, generation)
           SELECT ?1, ?2, ?3, ?4, 1 FROM workspaces
           WHERE id = ?5 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?6`,
        )
        .bind(
          boxId,
          credentials.accessHash,
          credentials.refreshHash,
          now,
          id,
          row.phone_home_hash,
        ),
      c.env.DB
        .prepare(
          `UPDATE workspaces
           SET phase = 'ready', ssh_host_public_key = ?1, phone_home_used = 1,
               phone_home_hash = NULL, revision = revision + 1, updated_at = ?2
           WHERE id = ?3 AND phase = 'creating' AND phone_home_used = 0 AND phone_home_hash = ?4`,
        )
        .bind(hostKey, now, id, row.phone_home_hash),
    ]);
    if (results[2]?.meta.changes !== 1) throw new HttpError(409, "phone_home capability already used");
    return c.json({
      box_id: boxId,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      token_type: "Bearer",
      expires_in: credentials.expiresIn,
    });
  });
}
