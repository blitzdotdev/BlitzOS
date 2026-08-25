import type { Db, Query } from "../db.js";
import { changed, first, rows, transaction } from "../db.js";
import { HttpError, isNumber, isRecord, isString, type JsonValue } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreRuntime } from "../runtime.js";
import { scopesFromJson } from "./manifest.js";
import type { Lease, MintResult } from "./types.js";
import { canControlWorkspace } from "../workspace-access.js";

interface LeaseRow {
  id: string;
  workspace_id: string;
  box_id: string | null;
  connection_id: string;
  connection_name: string;
  user_id: string | null;
  scopes: string;
  mode: "inject" | "proxy";
  issued_at: number;
  expires_at: number;
  state: Lease["state"];
  owner_id: string;
  org_id: string | null;
  owner_membership_id: string | null;
}

interface CreateLeaseInput {
  id: string;
  workspaceId: string;
  /** Null for a lease a person minted from the connect grid: audit records
   * which box received a credential, and no box received this one yet. */
  boxId: string | null;
  connectionId: string;
  connectionName: string;
  /** The workspace owner, always: a box is one disk and one env, so a lease
   * resolves against the owner's identity even when an editor triggered it. */
  userId: string;
  /** The grant this lease was minted from; null for legacy org-root mints. */
  grantId: string | null;
  scopes: string[];
  result: MintResult;
  tokenHash: string | null;
  now: number;
  principal: Principal;
}

interface CredentialEventRow {
  id: number;
  lease_id: string | null;
  event: "minted" | "revoked" | "denied" | "approved";
  detail: string | null;
  created_at: number;
}

export interface CredentialEventView {
  id: number;
  leaseId: string | null;
  event: CredentialEventRow["event"];
  detail: JsonValue | null;
  createdAt: number;
}

function leaseView(row: LeaseRow): Lease {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    boxId: row.box_id,
    connection: row.connection_name,
    userId: row.user_id,
    scopes: scopesFromJson(row.scopes),
    mode: row.mode,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    state: row.state,
  };
}

export async function createLease(
  db: Db,
  input: CreateLeaseInput,
): Promise<Lease> {
  const scopes = JSON.stringify(input.scopes);
  if ((input.result.mode === "proxy") !== (input.tokenHash !== null)) {
    throw new Error("proxy leases require a token hash");
  }
  await transaction(db, [
    {
      q: `INSERT INTO credential_leases
          (id, workspace_id, box_id, connection_id, user_id, grant_id, scopes,
           mode, token_hash, issued_at, expires_at, state)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active')`,
      v: [
        input.id,
        input.workspaceId,
        input.boxId,
        input.connectionId,
        input.userId,
        input.grantId,
        scopes,
        input.result.mode,
        input.tokenHash,
        input.now,
        input.result.expiresAt,
      ],
    },
    {
      q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
          VALUES (?1, 'minted', ?2, ?3)`,
      v: [
        input.id,
        // The detail key stays "integration": append-only audit rows written
        // before the connection rename keep the same stored key.
        JSON.stringify({
          integration: input.connectionName,
          scopes: input.scopes,
          box_id: input.boxId,
          workspace_id: input.workspaceId,
          acting_principal: {
            userId: input.principal.id,
            membershipId: input.principal.membershipId,
          },
        }),
        input.now,
      ],
    },
  ]);
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    boxId: input.boxId,
    connection: input.connectionName,
    userId: input.userId,
    scopes: input.scopes,
    mode: input.result.mode,
    issuedAt: input.now,
    expiresAt: input.result.expiresAt,
    state: "active",
  };
}

export async function listLeases(
  db: Db,
  workspaceId: string,
  principal: Principal,
): Promise<Lease[]> {
  const workspace = await first<{
    owner_id: string;
    org_id: string | null;
    owner_membership_id: string | null;
    id: string;
  }>(db, {
    q: "SELECT id, owner_id, org_id, owner_membership_id FROM workspaces WHERE id = ?1 LIMIT 1",
    v: [workspaceId],
  });
  if (workspace === null || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!canControlWorkspace(principal, workspace)) throw new HttpError(403, "forbidden");
  const result = await rows<LeaseRow>(db, {
    q: `SELECT lease.*, connection.scoped_name AS connection_name,
               workspace.owner_id, workspace.org_id, workspace.owner_membership_id
        FROM credential_leases lease
        JOIN connections connection ON connection.id = lease.connection_id
        JOIN workspaces workspace ON workspace.id = lease.workspace_id
        WHERE lease.workspace_id = ?1
        ORDER BY lease.issued_at DESC, lease.id`,
    v: [workspaceId],
  });
  return result.map(leaseView);
}

export async function revokeLease(
  db: Db,
  id: string,
  principal: Principal,
  now = Date.now(),
): Promise<void> {
  const row = await first<LeaseRow>(db, {
    q: `SELECT lease.*, connection.scoped_name AS connection_name,
               workspace.owner_id, workspace.org_id, workspace.owner_membership_id
        FROM credential_leases lease
        JOIN connections connection ON connection.id = lease.connection_id
        JOIN workspaces workspace ON workspace.id = lease.workspace_id
        WHERE lease.id = ?1 LIMIT 1`,
    v: [id],
  });
  if (row === null || row.org_id !== principal.orgId) {
    throw new HttpError(404, "credential lease not found");
  }
  if (!canControlWorkspace(principal, row)) throw new HttpError(403, "forbidden");
  if (row.state !== "active") return;
  await transaction(db, [
    {
      q: `UPDATE credential_leases
          SET state = 'revoked', token_hash = NULL
          WHERE id = ?1 AND state = 'active'`,
      v: [id],
    },
    {
      q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
          VALUES (?1, 'revoked', ?2, ?3)`,
      v: [
        id,
        // Audit detail keeps the pre-rename "integration" key (see above).
        JSON.stringify({
          integration: row.connection_name,
          scopes: scopesFromJson(row.scopes),
          box_id: row.box_id,
          workspace_id: row.workspace_id,
          acting_principal: {
            userId: principal.id,
            membershipId: principal.membershipId,
          },
        }),
        now,
      ],
    },
  ]);
}

function isJsonValue<Value>(value: Value): value is Value & JsonValue {
  if (value === null || isString(value) || value === true || value === false) return true;
  if (isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function eventDetail(value: string | null): JsonValue | null {
  if (value === null) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(409, "credential event detail is invalid");
  }
  if (!isJsonValue(parsed)) throw new HttpError(409, "credential event detail is invalid");
  return parsed;
}

export async function listCredentialEvents(
  db: Db,
  workspaceId: string,
  principal: Principal,
): Promise<CredentialEventView[]> {
  const workspace = await first<{
    id: string;
    org_id: string | null;
    owner_membership_id: string | null;
  }>(db, {
    q: "SELECT id, org_id, owner_membership_id FROM workspaces WHERE id = ?1 LIMIT 1",
    v: [workspaceId],
  });
  if (workspace === null || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!canControlWorkspace(principal, workspace)) throw new HttpError(403, "forbidden");
  const events = await rows<CredentialEventRow>(db, {
    q: `SELECT event.id, event.lease_id, event.event, event.detail, event.created_at
        FROM credential_events event
        LEFT JOIN credential_leases lease ON lease.id = event.lease_id
        WHERE lease.workspace_id = ?1 OR json_extract(event.detail, '$.workspace_id') = ?1
        ORDER BY event.created_at DESC, event.id DESC`,
    v: [workspaceId],
  });
  return events.map((event) => ({
    id: event.id,
    leaseId: event.lease_id,
    event: event.event,
    detail: eventDetail(event.detail),
    createdAt: event.created_at,
  }));
}

export function revokeWorkspaceLeasesQuery(workspaceId: string): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE workspace_id = ?1 AND state = 'active'`,
    v: [workspaceId],
  };
}

export function revokeConnectionLeasesQuery(connectionId: string): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE connection_id = ?1 AND state = 'active'`,
    v: [connectionId],
  };
}

/** One workspace holds one live lease per connection. Minting again supersedes
 * the lease before it with the same revocation the grant-replace path uses —
 * a superseded lease is revoked, not a state of its own. */
export function revokeWorkspaceConnectionLeasesQuery(
  workspaceId: string,
  connectionId: string,
): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE workspace_id = ?1 AND connection_id = ?2 AND state = 'active'`,
    v: [workspaceId, connectionId],
  };
}

/** Revoking a grant kills every box that borrowed it, in the same transaction
 * that clears the ciphertext. */
export function revokeGrantLeasesQuery(grantId: string): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE grant_id = ?1 AND state = 'active'`,
    v: [grantId],
  };
}

export async function runLeaseSweep(
  runtime: CoreRuntime,
  now = Date.now(),
): Promise<number> {
  return changed(runtime.db, {
    q: `UPDATE credential_leases
        SET state = 'expired', token_hash = NULL
        WHERE state = 'active' AND expires_at <= ?1
        RETURNING id`,
    v: [now],
  });
}
