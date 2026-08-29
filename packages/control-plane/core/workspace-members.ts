import { first, rows } from "./db.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import {
  destroyMachine,
  machineFor,
  provisionMachine,
  type ProvisionMachineInput,
} from "./machines.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { storedRole, workspaceForAdminWrite } from "./workspace-access.js";
import {
  machineView,
  type MachineRow,
  type WorkspaceRow,
} from "./workspace-records.js";
import {
  WORKSPACE_MEMBER_ROLES,
  type AddWorkspaceMemberRequest,
  type ProvisionMemberMachineRequest,
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
  if (value.persistentVolume !== undefined && value.persistentVolume !== null) {
    if (!isBoolean(value.persistentVolume)) {
      throw new HttpError(400, "persistentVolume must be a boolean");
    }
    result.persistentVolume = value.persistentVolume;
  }
  return result;
}

function parseProvisionMemberMachine(value: JsonValue): ProvisionMemberMachineRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: ProvisionMemberMachineRequest = {};
  if (value.machineTypeId !== undefined && value.machineTypeId !== null) {
    result.machineTypeId = requiredString(value.machineTypeId, "machineTypeId", 256);
  }
  if (value.persistentVolume !== undefined && value.persistentVolume !== null) {
    if (!isBoolean(value.persistentVolume)) {
      throw new HttpError(400, "persistentVolume must be a boolean");
    }
    result.persistentVolume = value.persistentVolume;
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
  persistentVolume?: boolean,
): ProvisionMachineInput {
  const input: ProvisionMachineInput = {
    workspace,
    membershipId,
    machineTypeId,
    requestOrigin,
  };
  if (existing !== null) input.machineId = existing.id;
  if (existing?.volume_id != null) input.volumeId = existing.volume_id;
  if (persistentVolume !== undefined) input.persistentVolume = persistentVolume;
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
        input.persistentVolume,
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

export function addWorkspaceMemberRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/workspaces/:id/members", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForAdminWrite(runtime.db, principal, context.req.param("id"));
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
    const workspace = await workspaceForAdminWrite(runtime.db, principal, context.req.param("id"));
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
   * Provisions the machine a member row does not hold yet (§2.1).
   *
   * Two ways to get here: the workspace has `auto_provision` off, so adding
   * somebody wrote the row and nothing else; or their machine was destroyed
   * and the row survives with its volume. Both land on the same act, and the
   * old row is reused where there is one, so the member comes back on their
   * own disk rather than an empty one.
   *
   * A viewer is refused rather than quietly given one: a viewer never holds a
   * machine (§2.2), and the way to give them one is the role write. A member
   * who already has a live machine is refused too — this route creates, and
   * `start` and `recreate` are the verbs for one that exists.
   *
   * The body is `{}` where the machine takes the workspace default.
   */
  router.post("/workspaces/:id/members/:membershipId/machine", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForAdminWrite(runtime.db, principal, context.req.param("id"));
    const membershipId = context.req.param("membershipId");
    const input = parseProvisionMemberMachine(await readJson(context.req.raw, 4 * 1024));
    const member = await activeOrgMember(runtime, workspace.org_id, membershipId);
    const role = await storedRole(runtime.db, workspace.id, membershipId);
    if (member === null || role === null) throw new HttpError(404, "workspace member not found");
    if (role === "viewer") {
      throw new HttpError(409, "a viewer never holds a machine; change their role first");
    }
    const existing = await machineFor(runtime.db, workspace.id, membershipId);
    if (existing !== null && existing.state !== "destroyed") {
      throw new HttpError(409, `this member already has a machine; it is ${existing.state}`);
    }
    const machine = await provisionMachine(runtime, memberProvisionInput(
      workspace,
      membershipId,
      input.machineTypeId ?? existing?.machine_type_id ?? workspace.default_machine_type_id,
      new URL(context.req.url).origin,
      existing,
      input.persistentVolume,
    ));
    return context.json<WorkspaceMemberResponse>({
      member: {
        membershipId,
        name: member.name,
        avatarUrl: member.avatar_url,
        role,
        machine: machineView(machine),
      },
    }, 201);
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
    const workspace = await workspaceForAdminWrite(runtime.db, principal, context.req.param("id"));
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
