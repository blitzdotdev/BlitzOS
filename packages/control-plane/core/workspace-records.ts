import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import { manifestConnectionNames } from "./connections/manifest.js";
import type {
  BoxPayloadOutcome,
  MachineState,
  MachineView,
  Phase,
  RetryAction,
  WorkspaceMemberRole,
  WorkspaceMemberView,
  WorkspaceView,
} from "./wire.js";
import type { ComputeCredentialSource } from "./compute/types.js";

/**
 * Which plane asked for a machine.
 *
 * An agent acts as its own member, so membership cannot distinguish a person
 * from the agent on their box — it is the same membership. Provenance can, and
 * it is the whole basis of the rule that an agent may destroy only what the
 * agent plane made (`assertMachinePlaneMayDestroy`).
 */
export type CreatedByPlane = "session" | "machine";

/** The workspace row after MEMBER-MACHINES: configuration only. Every VM
 * column moved to `machines` and the sharing ACL moved to
 * `workspace_members`. The workspace credential store is gone with it —
 * static secrets are org-scoped now (plans/ORG-CREDENTIALS.md §3). */
export interface WorkspaceRow {
  id: string;
  name: string | null;
  owner_id: string;
  revision: number;
  default_machine_type_id: string;
  auto_provision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  manifest: string | null;
  agent_rule_id: string | null;
  org_id: string | null;
  owner_membership_id: string | null;
  owner_name?: string | null;
  owner_avatar_url?: string | null;
}

/** One machine row. `boxes` used to hold a second row for the same guest;
 * this is the only one now, and its id is the id the guest presents. */
export interface MachineRow {
  id: string;
  workspace_id: string;
  membership_id: string;
  state: MachineState;
  machine_type_id: string;
  compute_credential_source: ComputeCredentialSource;
  vm_id: string | null;
  volume_id: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_host_public_key: string | null;
  phone_home_hash: string | null;
  phone_home_used: number;
  tunnel_id: string | null;
  tunnel_hostname: string | null;
  dns_record_id: string | null;
  broker_box_id: string | null;
  box_update_requested: number;
  box_image_reported: string | null;
  disk_used_percent: number | null;
  disk_reported_at: number | null;
  payload_reported: string | null;
  daemon_reported: string | null;
  payload_outcome: BoxPayloadOutcome | null;
  payload_reported_at: number | null;
  payload_hold: number;
  /** The plane that asked for this machine: a person's session, or an agent's
   * box credential. An agent may destroy only what the agent plane made. */
  created_by_plane: CreatedByPlane;
  /** 1 while a teardown that KEEPS this machine is in flight — a stop, a
   * recreate, a machine-type change. `destroying` alone cannot say whether the
   * row is coming back, so whoever finalises the teardown reads it here rather
   * than assuming a destroy (migration 0047). */
  destroy_keeps_row: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  membership_id: string;
  role: WorkspaceMemberRole;
  added_at: number;
  member_name?: string | null;
  member_avatar_url?: string | null;
}

/** States that hold a VM slot, so `vm_limit` and `vmsUsed` count the same
 * rows. `destroyed` is the only state that has released its slot. Written
 * once and read by the create-path predicate and the usage report both. */
export const MACHINE_SLOT_STATES =
  "'provisioning', 'running', 'stopped', 'error', 'destroying'";

/** The legacy `WorkspaceView.phase`, projected from one machine's state.
 *
 * The workspace itself has no phase — it is always present. A poller that
 * created a workspace still has to learn when its machine is usable, and this
 * is the field it already watches, so the projection keeps that loop working
 * instead of asking every client to change on the same day the server does. */
const phaseForState = {
  provisioning: "creating",
  running: "ready",
  stopped: "ready",
  error: "error",
  destroying: "destroying",
  destroyed: "destroyed",
} satisfies Record<MachineState, Phase>;

const retryActions = {
  creating: "poll",
  ready: null,
  destroying: "poll",
  destroyed: "create",
  error: "destroy",
} satisfies Record<Phase, RetryAction>;

/** The guest's last disk report, but only for a machine that has a volume to
 * report on. A machine with no volume measures its VM's root disk, which is
 * the provider's business and not a durable thing anybody keeps files on, so
 * the field keeps the name it is given and answers null. The 0-100 range is
 * the column's own CHECK (migration 0045), not something to re-decide here. */
function volumeUsedPercentForRow(row: MachineRow): number | null {
  return row.volume_id === null ? null : row.disk_used_percent;
}

export function machineView(row: MachineRow): MachineView {
  return {
    id: row.id,
    state: row.state,
    machineTypeId: row.machine_type_id,
    volumeId: row.volume_id,
    volumeUsedPercent: volumeUsedPercentForRow(row),
    payloadVersion: row.payload_reported,
    daemonVersion: row.daemon_reported,
    payloadOutcome: row.payload_outcome,
    payloadReportedAt: row.payload_reported_at,
    membershipId: row.membership_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WorkspaceProjection {
  workspace: WorkspaceRow;
  members: WorkspaceMemberRow[];
  machines: MachineRow[];
  /** The membership asking. Null for an unauthenticated or membership-less
   * caller; the legacy fields then fall back to the workspace default. */
  membershipId: string | null;
  /** The caller's stored workspace role, or null for implicit org-admin reach. */
  myRole: WorkspaceMemberRole | null;
  /** The legacy four-value access role the webApp and the ticket both use. */
  role: WorkspaceView["role"];
}

export function workspaceView(projection: WorkspaceProjection): WorkspaceView {
  const { workspace: row, membershipId, role } = projection;
  const byMembership = new Map(projection.machines.map((machine) => [machine.membership_id, machine]));
  const mine = membershipId === null ? undefined : byMembership.get(membershipId);
  const canOpen = role !== null;
  // A deleted workspace reads as destroyed whatever its machines say: the
  // tombstone is the workspace's own answer, and it outlives them.
  const phase: Phase = row.deleted_at !== null
    ? "destroyed"
    : mine === undefined ? "ready" : phaseForState[mine.state];
  const hasSsh = mine?.ssh_host != null && mine.ssh_port !== null && mine.ssh_user !== null;
  const members: WorkspaceMemberView[] = projection.members.map((member) => {
    const machine = byMembership.get(member.membership_id);
    return {
      membershipId: member.membership_id,
      name: member.member_name ?? member.membership_id,
      avatarUrl: member.member_avatar_url ?? null,
      role: member.role,
      machine: machine === undefined || machine.state === "destroyed"
        ? null
        : machineView(machine),
    };
  });
  const view: WorkspaceView = {
    id: row.id,
    name: row.name ?? row.id,
    machineTypeId: mine?.machine_type_id ?? row.default_machine_type_id,
    phase,
    retryAction: retryActions[phase],
    canObserve: canOpen && phase === "ready",
    launchable: canOpen && phase === "ready",
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ssh: canOpen && hasSsh && mine !== undefined && row.deleted_at === null
      ? {
          host: mine.ssh_host ?? "",
          port: mine.ssh_port ?? 22,
          user: mine.ssh_user ?? "root",
          hostPublicKey: mine.ssh_host_public_key,
        }
      : null,
    volumeId: mine?.volume_id ?? null,
    error: mine?.error ?? null,
    role,
    owner: {
      name: row.owner_name ?? row.owner_id,
      avatarUrl: row.owner_avatar_url ?? null,
    },
    agentRuleId: row.agent_rule_id,
    connections: canOpen ? manifestConnectionNames(row.manifest) : [],
    orgId: row.org_id,
    ownerMembershipId: row.owner_membership_id,
    defaultMachineTypeId: row.default_machine_type_id,
    autoProvision: row.auto_provision === 1,
    myRole: projection.myRole,
    members: canOpen ? members : [],
  };
  return view;
}

const WORKSPACE_SELECT = `SELECT w.*, u.name AS owner_name, u.avatar_url AS owner_avatar_url
    FROM workspaces w
    LEFT JOIN memberships owner ON owner.id = w.owner_membership_id
    LEFT JOIN users u ON u.id = owner.user_id`;

export async function workspaceById(db: Db, id: string): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, { q: `${WORKSPACE_SELECT} WHERE w.id = ?1 LIMIT 1`, v: [id] });
}

export async function workspacesForOrg(db: Db, orgId: string): Promise<WorkspaceRow[]> {
  return rows<WorkspaceRow>(db, {
    q: `${WORKSPACE_SELECT} WHERE w.org_id = ?1 AND w.deleted_at IS NULL
        ORDER BY w.created_at, w.id`,
    v: [orgId],
  });
}

export async function workspaceMembers(
  db: Db,
  workspaceIds: readonly string[],
): Promise<WorkspaceMemberRow[]> {
  if (workspaceIds.length === 0) return [];
  const placeholders = workspaceIds.map((_id, index) => `?${String(index + 1)}`).join(", ");
  return rows<WorkspaceMemberRow>(db, {
    q: `SELECT wm.workspace_id, wm.membership_id, wm.role, wm.added_at,
               u.name AS member_name, u.avatar_url AS member_avatar_url
        FROM workspace_members wm
        JOIN memberships m ON m.id = wm.membership_id
        JOIN users u ON u.id = m.user_id
        WHERE wm.workspace_id IN (${placeholders})
        ORDER BY wm.added_at, wm.membership_id`,
    v: [...workspaceIds],
  });
}

export async function machinesForWorkspaces(
  db: Db,
  workspaceIds: readonly string[],
): Promise<MachineRow[]> {
  if (workspaceIds.length === 0) return [];
  const placeholders = workspaceIds.map((_id, index) => `?${String(index + 1)}`).join(", ");
  return rows<MachineRow>(db, {
    q: `SELECT * FROM machines WHERE workspace_id IN (${placeholders})
        ORDER BY created_at, id`,
    v: [...workspaceIds],
  });
}
