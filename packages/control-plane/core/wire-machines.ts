/** The member-machines wire vocabulary (plans/MEMBER-MACHINES.md §1).
 *
 * Split out of `core/wire.ts` rather than added to it: that file is on the
 * 700-line warn list, and the house rule is to split on touch. `core/wire.ts`
 * re-exports every name here, so nothing else has to know about the seam.
 * Its mirror is `packages/schema/src/workspace.ts`, held equal by
 * `test/wire-drift.test.ts`. */

import type { BoxPayloadOutcome } from "./wire-box-payload.js";

/** The stored workspace role (plans/MEMBER-MACHINES.md §3). `admin` here is
 * workspace admin, which is not the org role of the same name: an org admin
 * reaches every workspace of the org implicitly without holding a row. */
export const WORKSPACE_MEMBER_ROLES = ["admin", "member", "viewer"] as const;

export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const MACHINE_STATES = [
  "provisioning",
  "running",
  "stopped",
  "error",
  "destroying",
  "destroyed",
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

/** One member's VM. The volume is the durable half and survives a machine-type
 * change; `vmId` never crosses the wire, because a provider identifier is not
 * a product concept. */
export interface MachineView {
  id: string;
  state: MachineState;
  /** This machine's type. The workspace holds only a default. */
  machineTypeId: string;
  volumeId: string | null;
  /** How full the machine's persistent volume is, 0-100, as the guest last
   * measured it. Null means the question has no answer yet: there is no
   * volume, or no guest has reported one (every box image before the reporter
   * shipped). Null is never 0 — an unmeasured disk is not an empty one. */
  volumeUsedPercent: number | null;
  /** The payload and daemon versions from the guest's last payload report.
   * Null means this machine has not reported since the payload channel
   * shipped. */
  payloadVersion: string | null;
  daemonVersion: string | null;
  payloadOutcome: BoxPayloadOutcome | null;
  payloadReportedAt: number | null;
  membershipId: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The guest's own disk report (`POST /workspaces/self/machine-stats`).
 * `diskUsedPercent` is an integer 0-100, the used percentage of the filesystem
 * holding the state directory. Anything else is a 400: a machine reporting
 * nonsense about its disk must not overwrite the last true figure. */
export interface MachineStatsRequest {
  diskUsedPercent: number;
}

export interface WorkspaceMemberView {
  membershipId: string;
  name: string;
  avatarUrl: string | null;
  role: WorkspaceMemberRole;
  /** Null when nothing is provisioned: `autoProvision` is off, or the member
   * is a viewer, who never holds a machine. */
  machine: MachineView | null;
}

export interface MachineResponse {
  machine: MachineView;
}

/** Same-location only: the volume stays, the VM is replaced. A type in another
 * location needs a volume move, which is deferred (plan §5). */
export interface SetMachineTypeRequest {
  machineTypeId: string;
}

/** Enables or disables payload delivery for one machine. A hold leaves the
 * deployment-wide pin in place and makes only this machine's box-config
 * answer `payload: null`. */
export interface SetMachinePayloadHoldRequest {
  payloadHold: boolean;
}

export interface AddWorkspaceMemberRequest {
  membershipId: string;
  role: WorkspaceMemberRole;
  /** Per-member override of the workspace default. */
  machineTypeId?: string;
  /** Whether this member's machine gets its own persistent volume. Default
   * true. False provisions the VM with no disk of its own, so nothing on it
   * survives the VM — for a throwaway machine that has nothing to keep. */
  persistentVolume?: boolean;
}

export interface UpdateWorkspaceMemberRequest {
  role: WorkspaceMemberRole;
}

/** Provisions a machine for a member row that holds none — the manual half of
 * §2.1, for a workspace whose `autoProvision` is off or a member whose machine
 * was destroyed. A viewer is refused: they never hold one (§2.2). */
export interface ProvisionMemberMachineRequest {
  /** Overrides the workspace default for this one machine (§1a). */
  machineTypeId?: string;
  /** Whether this member's machine gets its own persistent volume. Default
   * true. False provisions the VM with no disk of its own, so nothing on it
   * survives the VM — for a throwaway machine that has nothing to keep. */
  persistentVolume?: boolean;
}

export interface WorkspaceMemberResponse {
  member: WorkspaceMemberView;
}

/**
 * The workspace settings write (§3, first matrix row). Every field is
 * optional and an absent one is left alone, so a caller who edits the name
 * does not have to restate the rest.
 *
 * `defaultMachineTypeId` is a default, never a restriction: changing it moves
 * FUTURE provisions and touches no existing machine (§1a). `agentRuleId` takes
 * an explicit null to fall back to the built-in doc.
 */
export interface UpdateWorkspaceRequest {
  name?: string;
  defaultMachineTypeId?: string;
  autoProvision?: boolean;
  agentRuleId?: string | null;
}

