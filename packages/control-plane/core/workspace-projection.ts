import type { Db } from "./db.js";
import { rows } from "./db.js";
import type { Principal } from "./principals.js";
import { accessFor, legacyRole } from "./workspace-access.js";
import {
  machinesForWorkspaces,
  workspaceMembers,
  workspaceView,
  type MachineRow,
  type WorkspaceMemberRow,
  type WorkspaceRow,
} from "./workspace-records.js";
import { workspaceCredentialView, type WorkspaceCredentialRow } from "./workspace-credentials.js";
import type { WorkspaceMemberRole, WorkspaceView } from "./wire.js";

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket === undefined) grouped.set(key(item), [item]);
    else bucket.push(item);
  }
  return grouped;
}

/**
 * Builds the wire view for a set of workspaces in four reads, whatever the
 * count.
 *
 * `GET /workspaces` returns every workspace in the organization, and each one
 * now carries its members, their machines, and its credential names. Fetching
 * those per workspace would turn one list into 3N reads on a D1 binding whose
 * cost is per statement, so every child set is loaded once and grouped here.
 */
export async function projectWorkspaces(
  db: Db,
  principal: Principal,
  workspaces: readonly WorkspaceRow[],
): Promise<WorkspaceView[]> {
  if (workspaces.length === 0) return [];
  const ids = workspaces.map(({ id }) => id);
  const placeholders = ids.map((_id, index) => `?${String(index + 1)}`).join(", ");
  const [members, machines, credentials] = await Promise.all([
    workspaceMembers(db, ids),
    machinesForWorkspaces(db, ids),
    rows<WorkspaceCredentialRow>(db, {
      q: `SELECT id, workspace_id, name, label, ciphertext, created_at, updated_at
          FROM workspace_credentials
          WHERE workspace_id IN (${placeholders}) AND revoked_at IS NULL
          ORDER BY name`,
      v: [...ids],
    }),
  ]);
  const membersByWorkspace = groupBy<WorkspaceMemberRow>(members, ({ workspace_id }) => workspace_id);
  const machinesByWorkspace = groupBy<MachineRow>(machines, ({ workspace_id }) => workspace_id);
  const credentialsByWorkspace = groupBy<WorkspaceCredentialRow>(
    credentials,
    ({ workspace_id }) => workspace_id,
  );
  const views: WorkspaceView[] = [];
  for (const workspace of workspaces) {
    const workspaceMemberRows = membersByWorkspace.get(workspace.id) ?? [];
    const stored: WorkspaceMemberRole | null = workspaceMemberRows.find(
      (member) => member.membership_id === principal.membershipId,
    )?.role ?? null;
    const access = accessFor(principal, workspace, stored);
    views.push(workspaceView({
      workspace,
      members: workspaceMemberRows,
      machines: machinesByWorkspace.get(workspace.id) ?? [],
      credentials: (credentialsByWorkspace.get(workspace.id) ?? []).map(workspaceCredentialView),
      membershipId: principal.membershipId,
      myRole: stored,
      role: legacyRole(access),
    }));
  }
  return views;
}

export async function projectWorkspace(
  db: Db,
  principal: Principal,
  workspace: WorkspaceRow,
): Promise<WorkspaceView> {
  const [view] = await projectWorkspaces(db, principal, [workspace]);
  if (view === undefined) throw new Error("workspace projection produced no view");
  return view;
}
