import type { Db, Query } from "../db.js";
import { changed, first, rows, transaction } from "../db.js";
import { HttpError, isString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreRuntime } from "../runtime.js";
import type { Lease, MintResult } from "./types.js";
import { canControlWorkspace } from "../workspace-access.js";

interface LeaseRow {
  id: string;
  workspace_id: string;
  box_id: string | null;
  integration_id: string;
  integration_name: string;
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
  boxId: string;
  integrationId: string;
  integrationName: string;
  scopes: string[];
  result: MintResult;
  tokenHash: string | null;
  now: number;
}

function scopesFromJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => isString(scope))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function leaseView(row: LeaseRow): Lease {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    boxId: row.box_id,
    integration: row.integration_name,
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
          (id, workspace_id, box_id, integration_id, user_id, scopes, mode,
           token_hash, issued_at, expires_at, state)
          VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, 'active')`,
      v: [
        input.id,
        input.workspaceId,
        input.boxId,
        input.integrationId,
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
        JSON.stringify({
          integration: input.integrationName,
          scopes: input.scopes,
          box_id: input.boxId,
          workspace_id: input.workspaceId,
        }),
        input.now,
      ],
    },
  ]);
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    boxId: input.boxId,
    integration: input.integrationName,
    userId: null,
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
    q: `SELECT lease.*, integration.scoped_name AS integration_name,
               workspace.owner_id, workspace.org_id, workspace.owner_membership_id
        FROM credential_leases lease
        JOIN integrations integration ON integration.id = lease.integration_id
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
    q: `SELECT lease.*, integration.scoped_name AS integration_name,
               workspace.owner_id, workspace.org_id, workspace.owner_membership_id
        FROM credential_leases lease
        JOIN integrations integration ON integration.id = lease.integration_id
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
        JSON.stringify({
          integration: row.integration_name,
          scopes: scopesFromJson(row.scopes),
          box_id: row.box_id,
          workspace_id: row.workspace_id,
        }),
        now,
      ],
    },
  ]);
}

export function revokeWorkspaceLeasesQuery(workspaceId: string): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE workspace_id = ?1 AND state = 'active'`,
    v: [workspaceId],
  };
}

export function revokeIntegrationLeasesQuery(integrationId: string): Query {
  return {
    q: `UPDATE credential_leases
        SET state = 'revoked', token_hash = NULL
        WHERE integration_id = ?1 AND state = 'active'`,
    v: [integrationId],
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
