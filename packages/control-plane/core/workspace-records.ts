import type { Db } from "./db.js";
import { first } from "./db.js";
import { isMicrovmProviderId } from "./compute/microvm.js";
import { manifestConnectionNames } from "./connections/manifest.js";
import { workspaceEnvironmentFromJson } from "./environment.js";
import type { Phase, RetryAction, WorkspaceView } from "./wire.js";

export interface WorkspaceRow {
  id: string;
  name: string | null;
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
  environment: string | null;
  files_ready: number;
  agent_rule_id: string | null;
  recipe_id: string | null;
  tunnel_id: string | null;
  tunnel_hostname: string | null;
  dns_record_id: string | null;
  org_id: string | null;
  owner_membership_id: string | null;
  org_share_role?: "editor" | "viewer" | null;
  owner_name?: string | null;
  owner_avatar_url?: string | null;
  grant_role?: "editor" | "viewer" | null;
}

const retryActions = {
  creating: "poll",
  ready: null,
  destroying: "poll",
  destroyed: "create",
  error: "destroy",
} satisfies Record<Phase, RetryAction>;

function machineTypeIdForRow(row: WorkspaceRow): string {
  return row.machine_type_id === "unknown"
      && row.vm_id !== null
      && isMicrovmProviderId(row.vm_id)
    ? "mv-legacy"
    : row.machine_type_id;
}

export function workspaceView(
  row: WorkspaceRow,
  role: WorkspaceView["role"] = "owner",
  reportError?: (code: string, error: Error) => void,
): WorkspaceView {
  const hasSsh = row.ssh_host !== null && row.ssh_port !== null && row.ssh_user !== null;
  const canOpen = role !== null;
  const view: WorkspaceView = {
    id: row.id,
    name: row.name ?? row.id,
    machineTypeId: machineTypeIdForRow(row),
    phase: row.phase,
    retryAction: retryActions[row.phase],
    canObserve: canOpen && row.phase === "ready",
    launchable: canOpen && row.phase === "ready",
    revision: row.revision,
    ssh: canOpen && hasSsh && row.phase !== "destroyed"
      ? {
          host: row.ssh_host ?? "",
          port: row.ssh_port ?? 22,
          user: row.ssh_user ?? "root",
          hostPublicKey: row.ssh_host_public_key,
        }
      : null,
    volumeId: row.volume_id,
    error: row.error,
    role,
    orgShareRole: row.org_share_role ?? null,
    owner: {
      name: row.owner_name ?? row.owner_id,
      avatarUrl: row.owner_avatar_url ?? null,
    },
    // Env values and the startup script are workspace configuration, not
    // catalogue data. GET /workspaces returns every row in the org, so this is
    // gated on the viewer's role exactly like `ssh` above: a member with no
    // grant and no share must not read either.
    environment: canOpen ? workspaceEnvironmentFromJson(row.environment, reportError) : null,
    agentRuleId: row.agent_rule_id,
    // The stipulated set, not the connected set: the connections panel draws
    // one status row per name and reads connectedness off the lease list.
    connections: canOpen ? manifestConnectionNames(row.manifest) : [],
  };
  // Provenance, not configuration: which recipe launched this workspace.
  if (row.recipe_id !== null) view.recipeId = row.recipe_id;
  return view;
}

export async function workspaceById(db: Db, id: string): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, {
    q: `SELECT w.*, u.name AS owner_name, u.avatar_url AS owner_avatar_url
        FROM workspaces w
        LEFT JOIN memberships owner ON owner.id = w.owner_membership_id
        LEFT JOIN users u ON u.id = owner.user_id
        WHERE w.id = ?1 LIMIT 1`,
    v: [id],
  });
}
