/** Resolving the machine a route names, and grading the caller against
 * plans/MEMBER-MACHINES.md §3.
 *
 * Split out of `core/machines.ts` rather than added to it: that file sits on
 * the 700-line warn, and the house rule is to split on touch. The split earns
 * itself twice over — `core/box-config.ts` registers a machine verb of its own
 * (`POST /machines/:machineId/box-update`) and needs the identical gate, and a
 * second copy of an authorization rule is how the two drift apart. */

import { HttpError } from "./http.js";
import type { Db } from "./db.js";
import type { Principal } from "./principals.js";
import { isWorkspaceAdmin, workspaceAccess } from "./workspace-access.js";
import { workspaceById } from "./workspace-records.js";
import type { MachineRow, WorkspaceRow } from "./workspace-records.js";
import { first } from "./db.js";

export interface MachineTarget {
  workspace: WorkspaceRow;
  machine: MachineRow;
  admin: boolean;
}

export async function machineById(db: Db, id: string): Promise<MachineRow | null> {
  return first<MachineRow>(db, {
    q: "SELECT * FROM machines WHERE id = ?1 LIMIT 1",
    v: [id],
  });
}

/** Resolves the machine a verb names and grades the caller.
 *
 * `own` is what a plain member may do to their own machine (stop, start, ask
 * for a box update). Everything else is workspace-admin work, and an org admin
 * passes through implicit reach.
 *
 * A machine in another org reads as 404, not 403: whether an id exists
 * elsewhere is not this caller's business.
 */
export async function machineTarget(
  db: Db,
  principal: Principal,
  machineId: string,
  scope: "admin" | "own",
): Promise<MachineTarget> {
  const machine = await machineById(db, machineId);
  if (machine === null) throw new HttpError(404, "machine not found");
  const workspace = await workspaceById(db, machine.workspace_id);
  if (workspace === null || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "machine not found");
  }
  const access = await workspaceAccess(db, principal, workspace);
  const admin = isWorkspaceAdmin(access);
  if (!admin) {
    if (scope === "admin") throw new HttpError(403, "workspace admin required");
    if (access.stored !== "member" || machine.membership_id !== principal.membershipId) {
      throw new HttpError(403, "forbidden");
    }
  }
  return { workspace, machine, admin };
}
