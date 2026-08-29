import { first, rows } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import {
  destroyMachine,
  machineFor,
  provisionMachine,
  type ProvisionMachineInput,
} from "./machines.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { requireWorkspaceAdmin } from "./workspace-access.js";
import {
  machineView,
  workspaceById,
  type MachineRow,
  type WorkspaceRow,
} from "./workspace-records.js";
import {
  WORKSPACE_MEMBER_ROLES,
  type AddWorkspaceMemberRequest,
  type UpdateWorkspaceMemberRequest,
  type WorkspaceMemberResponse,
  type WorkspaceMemberRole,
  type WorkspaceMemberView,
} from "./wire.js";

function isWorkspaceMemberRole(value: JsonValue | undefined): value is WorkspaceMemberRole {
  return WORKSPACE_MEMBER_ROLES.some((role) => role === value);
}

export function parseAddWorkspaceMember(value: JsonValue): AddWorkspaceMemberRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const membershipId = requiredString(value.membershipId, "membershipId", 256);
  if (!isWorkspaceMemberRole(value.role)) {
    throw new HttpError(400, "role must be admin, member, or viewer");
  }
  const result: AddWorkspaceMemberRequest = { membershipId, role: value.role };
  if (value.machineTypeId !== undefined && value.machineTypeId !== null) {
    result.machineTypeId = requiredString(value.machineTypeId, "machineTypeId", 256);
  }
  return result;
}

function parseUpdateWorkspaceMember(value: JsonValue): UpdateWorkspaceMemberRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (!isWorkspaceMemberRole(value.role)) {
    throw new HttpError(400, "role must be admin, member, or viewer");
  }
  return { role: value.role };
}

/** The provision input for a member who should have a machine. An existing
 * row is reused so a re-add lands on the member's old disk; both optional
 * fields are set in statements, because "no previous machine" and "a previous
 * machine with no volume" are different facts. */
function memberProvisionInput(
  workspace: WorkspaceRow,
  membershipId: string,
  machineTypeId: string,
  requestOrigin: string,
  existing: MachineRow | null,
): ProvisionMachineInput {
  const input: ProvisionMachineInput = {
    workspace,
    membershipId,
    machineTypeId,
    requestOrigin,
  };
  if (existing !== null) input.machineId = existing.id;
  if (existing?.volume_id != null) input.volumeId = existing.volume_id;
  return input;
}

export interface MemberIdentity {
  id: string;
  name: string;
  avatar_url: string | null;
}

/** An active member of this workspace's organization, or null.
 *
 * The roster is the org's, and this plan does not touch how it grows: a
 * workspace admin may only add somebody who is already an active org member
 * (§2.7). */
export async function activeOrgMember(
  runtime: CoreRuntime,
  orgId: string,
  membershipId: string,
): Promise<MemberIdentity | null> {
  return first<MemberIdentity>(runtime.db, {
    q: `SELECT m.id, u.name, u.avatar_url
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = ?1 AND m.org_id = ?2 AND m.status = 'active' LIMIT 1`,
    v: [membershipId, orgId],
  });
}

/**
 * Adds one member and, when the workspace provisions automatically, their
 * machine.
 *
 * A viewer never gets a machine: viewers watch sessions, they do not run them
 * (§2.2). Everybody else gets one the moment they are added, unless the
 * workspace has `auto_provision` off — then the row exists and the machine
 * arrives on first open or by workspace-admin action.
 */
export async function addWorkspaceMember(
  runtime: CoreRuntime,
  workspace: WorkspaceRow,
  addedBy: string | null,
  input: AddWorkspaceMemberRequest,
  requestOrigin: string,
  member: MemberIdentity,
): Promise<WorkspaceMemberView> {
  const now = Date.now();
  await rows(runtime.db, {
    q: `INSERT INTO workspace_members
        (workspace_id, membership_id, role, added_by_membership_id, added_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(workspace_id, membership_id) DO UPDATE SET role = excluded.role`,
    v: [workspace.id, input.membershipId, input.role, addedBy, now],
  });
  const existing = await machineFor(runtime.db, workspace.id, input.membershipId);
  const wants = input.role !== "viewer" && workspace.auto_provision === 1;
  const machine = wants && (existing === null || existing.state === "destroyed")
    ? await provisionMachine(runtime, memberProvisionInput(
        workspace,
        input.membershipId,
        input.machineTypeId ?? workspace.default_machine_type_id,
        requestOrigin,
        existing,
      ))
    : existing;
  return {
    membershipId: input.membershipId,
    name: member.name,
    avatarUrl: member.avatar_url,
    role: input.role,
    machine: machine === null || machine.state === "destroyed" ? null : machineView(machine),
  };
}

async function workspaceForMemberWrite(
  runtime: CoreRuntime,
  principal: Principal,
  id: string,
): Promise<WorkspaceRow & { org_id: string }> {
  const workspace = await workspaceById(runtime.db, id);
  if (
    workspace === null
    || workspace.org_id === null
    || workspace.org_id !== principal.orgId
    || workspace.deleted_at !== null
  ) {
    throw new HttpError(404, "workspace not found");
  }
  await requireWorkspaceAdmin(runtime.db, principal, workspace);
  // SAFETY: org_id was null-checked immediately above; the intersection only narrows that one property.
  return workspace as WorkspaceRow & { org_id: string };
}

export function addWorkspaceMemberRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/workspaces/:id/members", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForMemberWrite(runtime, principal, context.req.param("id"));
    const input = parseAddWorkspaceMember(await readJson(context.req.raw, 4 * 1024));
    const member = await activeOrgMember(runtime, workspace.org_id, input.membershipId);
    if (member === null) {
      throw new HttpError(400, "a workspace member must be an active organization member");
    }
    const view = await addWorkspaceMember(
      runtime,
      workspace,
      principal.membershipId,
      input,
      new URL(context.req.url).origin,
      member,
    );
    return context.json<WorkspaceMemberResponse>({ member: view }, 201);
  });

  /**
   * Changes a stored role.
   *
   * Demoting somebody to viewer destroys their machine, because a viewer never
   * holds one (§2.2). Promoting a viewer provisions one where the workspace
   * provisions automatically. The role write and the machine act are one
   * request so the two can never disagree.
   */
  router.patch("/workspaces/:id/members/:membershipId", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForMemberWrite(runtime, principal, context.req.param("id"));
    const membershipId = context.req.param("membershipId");
    const input = parseUpdateWorkspaceMember(await readJson(context.req.raw, 4 * 1024));
    const member = await activeOrgMember(runtime, workspace.org_id, membershipId);
    if (member === null) throw new HttpError(404, "workspace member not found");
    const updated = await rows<{ membership_id: string }>(runtime.db, {
      q: `UPDATE workspace_members SET role = ?1
          WHERE workspace_id = ?2 AND membership_id = ?3
          RETURNING membership_id`,
      v: [input.role, workspace.id, membershipId],
    });
    if (updated.length !== 1) throw new HttpError(404, "workspace member not found");
    const existing = await machineFor(runtime.db, workspace.id, membershipId);
    let machine = existing;
    if (input.role === "viewer" && existing !== null && existing.state !== "destroyed") {
      machine = await destroyMachine(runtime, existing);
    } else if (
      input.role !== "viewer"
      && workspace.auto_provision === 1
      && (existing === null || existing.state === "destroyed")
    ) {
      machine = await provisionMachine(runtime, memberProvisionInput(
        workspace,
        membershipId,
        existing?.machine_type_id ?? workspace.default_machine_type_id,
        new URL(context.req.url).origin,
        existing,
      ));
    }
    return context.json<WorkspaceMemberResponse>({
      member: {
        membershipId,
        name: member.name,
        avatarUrl: member.avatar_url,
        role: input.role,
        machine: machine === null || machine.state === "destroyed" ? null : machineView(machine),
      },
    });
  });

  /**
   * Removes a member and destroys their machine.
   *
   * The volume is kept and its seven-day retention clock starts, which is the
   * grace snapshot §2.3 asks for: the disk outlives the removal long enough
   * for an admin to restore it, then the existing sweep reclaims it.
   *
   * The owner cannot be removed. The workspace row names them, so removing
   * their row would leave a workspace whose creator is not in it.
   */
  router.delete("/workspaces/:id/members/:membershipId", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForMemberWrite(runtime, principal, context.req.param("id"));
    const membershipId = context.req.param("membershipId");
    if (membershipId === workspace.owner_membership_id) {
      throw new HttpError(409, "the workspace owner cannot be removed");
    }
    const removed = await rows<{ membership_id: string }>(runtime.db, {
      q: `DELETE FROM workspace_members
          WHERE workspace_id = ?1 AND membership_id = ?2
          RETURNING membership_id`,
      v: [workspace.id, membershipId],
    });
    if (removed.length === 0) throw new HttpError(404, "workspace member not found");
    const machine = await machineFor(runtime.db, workspace.id, membershipId);
    if (machine !== null && machine.state !== "destroyed") {
      await destroyMachine(runtime, machine);
    }
    return context.body(null, 204);
  });
}
