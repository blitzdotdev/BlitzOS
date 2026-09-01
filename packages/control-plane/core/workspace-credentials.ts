import { openRoot, sealRoot } from "./connections/root-crypto.js";
import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { requireWorkspaceAdmin } from "./workspace-access.js";
import { workspaceById, type WorkspaceRow } from "./workspace-records.js";
import type {
  PutWorkspaceCredentialRequest,
  WorkspaceCredentialView,
} from "./wire.js";

/** The env var name an agent asks for. Same alphabet `blitz-cred env` prints
 * assignments in, because the box evals those lines. */
// A leading letter, not a leading underscore: the name also travels as the
// `connection` field of the credential pull wire, whose alphabet starts with
// an alphanumeric. One rule here keeps a name that can be stored from being a
// name that cannot be served.
const CREDENTIAL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

/** A value is a single opaque secret, not a document. The ceiling is the old
 * per-workspace environment budget, so nothing that fitted before is refused. */
export const WORKSPACE_CREDENTIAL_MAX_BYTES = 8 * 1024;

/** How many live credentials one workspace may hold. */
export const WORKSPACE_CREDENTIAL_MAX_COUNT = 50;

/** A comment is one printed line: `blitz-cred list` writes it after a `#`,
 * so it obeys the same alphabet every other blitz-cred output line does. */
export const WORKSPACE_CREDENTIAL_COMMENT_MAX = 256;

/** The AAD every workspace credential is sealed under. It binds a ciphertext
 * to the row it belongs to, so a value cannot be moved to another workspace or
 * renamed onto another variable and still open. */
export function credentialAad(workspaceId: string, name: string): string {
  return `wscred:${workspaceId}:${name}`;
}

/** The envelope migration 0042 writes for values that were plaintext already.
 *
 * SQL cannot run AES-GCM, so `workspaces.environment` could not be sealed as
 * it moved. Those values were plaintext in the database and world-readable on
 * the box, so carrying them across under a named marker loses nothing — and
 * every write through the routes below replaces the marker with a real sealed
 * value. */
const LEGACY_PLAINTEXT_PREFIX = "plaintext:v0:";

/** What a credential looks like to everything except the one reader of a
 * value: a name, its label, when it was added, and the workspace it belongs
 * to. A ciphertext is never selected to answer a names-only question. */
export interface WorkspaceCredentialRow {
  workspace_id: string;
  name: string;
  label: string | null;
  comment: string | null;
  created_at: number;
}

export function workspaceCredentialView(row: WorkspaceCredentialRow): WorkspaceCredentialView {
  return { name: row.name, label: row.label, comment: row.comment, createdAt: row.created_at };
}

export async function liveWorkspaceCredentials(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceCredentialRow[]> {
  return rows<WorkspaceCredentialRow>(db, {
    q: `SELECT workspace_id, name, label, comment, created_at
        FROM workspace_credentials
        WHERE workspace_id = ?1 AND revoked_at IS NULL
        ORDER BY name`,
    v: [workspaceId],
  });
}

/** The value behind one live name, or null when the workspace has no such
 * credential. The only caller is the credential pull wire. */
export async function workspaceCredentialValue(
  db: Db,
  key: CryptoKey,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const row = await first<{ ciphertext: string }>(db, {
    q: `SELECT ciphertext
        FROM workspace_credentials
        WHERE workspace_id = ?1 AND name = ?2 AND revoked_at IS NULL LIMIT 1`,
    v: [workspaceId, name],
  });
  if (row === null) return null;
  if (row.ciphertext.startsWith(LEGACY_PLAINTEXT_PREFIX)) {
    return row.ciphertext.slice(LEGACY_PLAINTEXT_PREFIX.length);
  }
  try {
    return await openRoot(key, credentialAad(workspaceId, name), row.ciphertext);
  } catch {
    // A ciphertext that will not open is a credential nobody can use. Refusing
    // loudly is the honest answer: silently serving nothing would read to an
    // agent as "this workspace never had that key".
    throw new HttpError(409, `workspace credential ${name} cannot be opened`);
  }
}

export function parseWorkspaceCredential(value: JsonValue): PutWorkspaceCredentialRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 128);
  if (!CREDENTIAL_NAME.test(name)) {
    throw new HttpError(400, "name must be an environment variable name");
  }
  const secret = requiredString(value.value, "value", WORKSPACE_CREDENTIAL_MAX_BYTES);
  if (new TextEncoder().encode(secret).byteLength > WORKSPACE_CREDENTIAL_MAX_BYTES) {
    throw new HttpError(
      400,
      `value must be at most ${String(WORKSPACE_CREDENTIAL_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  const result: PutWorkspaceCredentialRequest = { name, value: secret };
  if (value.label !== undefined && value.label !== null) {
    result.label = requiredString(value.label, "label", 128);
  }
  // Tri-state on purpose: absent keeps the live row's comment across a
  // rotation, an explicit null clears it, a string sets it.
  if (value.comment === null) {
    result.comment = null;
  } else if (value.comment !== undefined) {
    const comment = requiredString(value.comment, "comment", WORKSPACE_CREDENTIAL_COMMENT_MAX);
    if (/[\r\n\0]/u.test(comment)) {
      throw new HttpError(400, "comment must be a single line");
    }
    result.comment = comment;
  }
  return result;
}

/** Writes one credential, replacing whatever live row held that name.
 *
 * Add and rotate are the same act: the partial unique index allows one live
 * row per name, so a second write revokes the first in the same statement
 * sequence. The revoked row stays — it is the audit trail of a rotation. */
export async function putWorkspaceCredential(
  runtime: CoreRuntime,
  workspaceId: string,
  membershipId: string,
  input: PutWorkspaceCredentialRequest,
  now = Date.now(),
): Promise<WorkspaceCredentialView> {
  const ciphertext = await sealRoot(
    runtime.credentialMasterKey,
    credentialAad(workspaceId, input.name),
    input.value,
  );
  const live = await liveWorkspaceCredentials(runtime.db, workspaceId);
  if (
    live.length >= WORKSPACE_CREDENTIAL_MAX_COUNT
    && !live.some((row) => row.name === input.name)
  ) {
    throw new HttpError(
      409,
      `a workspace may hold at most ${String(WORKSPACE_CREDENTIAL_MAX_COUNT)} credentials`,
    );
  }
  await rows(runtime.db, {
    q: `UPDATE workspace_credentials SET revoked_at = ?1, updated_at = ?1
        WHERE workspace_id = ?2 AND name = ?3 AND revoked_at IS NULL`,
    v: [now, workspaceId, input.name],
  });
  // Documentation outlives the value it documents: a write that carries no
  // comment keeps the live row's, because a rotation changes the secret, not
  // what the secret is for. An env-file re-import must not erase them.
  const comment = input.comment !== undefined
    ? input.comment
    : live.find((row) => row.name === input.name)?.comment ?? null;
  await rows(runtime.db, {
    q: `INSERT INTO workspace_credentials
        (id, workspace_id, name, label, comment, ciphertext,
         created_by_membership_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    v: [
      crypto.randomUUID(),
      workspaceId,
      input.name,
      input.label ?? null,
      comment,
      ciphertext,
      membershipId,
      now,
    ],
  });
  return { name: input.name, label: input.label ?? null, comment, createdAt: now };
}

async function workspaceForCredentials(
  runtime: CoreRuntime,
  principal: Principal,
  id: string,
): Promise<WorkspaceRow> {
  const workspace = await workspaceById(runtime.db, id);
  if (
    workspace === null
    || workspace.org_id === null
    || workspace.org_id !== principal.orgId
    || workspace.deleted_at !== null
  ) {
    throw new HttpError(404, "workspace not found");
  }
  return workspace;
}

export function addWorkspaceCredentialRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.put("/workspaces/:id/credentials", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForCredentials(runtime, principal, context.req.param("id"));
    await requireWorkspaceAdmin(runtime.db, principal, workspace);
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseWorkspaceCredential(
      await readJson(context.req.raw, WORKSPACE_CREDENTIAL_MAX_BYTES * 2),
    );
    const view = await putWorkspaceCredential(
      runtime,
      workspace.id,
      principal.membershipId,
      input,
    );
    return context.json({ credential: view }, 201);
  });

  /** A revoke refuses the next `blitz-cred` call. Nothing is deleted: the row
   * is the record that this workspace once held that name. */
  router.delete("/workspaces/:id/credentials/:name", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForCredentials(runtime, principal, context.req.param("id"));
    await requireWorkspaceAdmin(runtime.db, principal, workspace);
    const revoked = await rows<{ id: string }>(runtime.db, {
      q: `UPDATE workspace_credentials SET revoked_at = ?1, updated_at = ?1
          WHERE workspace_id = ?2 AND name = ?3 AND revoked_at IS NULL
          RETURNING id`,
      v: [Date.now(), workspace.id, context.req.param("name")],
    });
    if (revoked.length === 0) throw new HttpError(404, "workspace credential not found");
    return context.body(null, 204);
  });
}
