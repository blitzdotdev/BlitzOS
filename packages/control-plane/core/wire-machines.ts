/** The member-machines wire vocabulary (plans/MEMBER-MACHINES.md §1).
 *
 * Split out of `core/wire.ts` rather than added to it: that file is on the
 * 700-line warn list, and the house rule is to split on touch. `core/wire.ts`
 * re-exports every name here, so nothing else has to know about the seam.
 * Its mirror is `packages/schema/src/workspace.ts`, held equal by
 * `test/wire-drift.test.ts`. */

import type { BoxUpdateOutcome } from "./wire-box-config.js";

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
  membershipId: string;
  error: string | null;
  /** The CONCRETE box image this machine runs, as its host last reported it
   * (or as the deployment pinned it when the machine was created). Null means
   * unknown: a machine created before the host started reporting a tag, which
   * has not attempted an update since. Never compare `boxImage` to a manifest
   * URL — under an R2 manifest ref the URL is identical across rebakes while
   * the tag inside it moves, and the tag is what this field holds. */
  boxImage: string | null;
  /** The CONCRETE box image this deployment installs now. Equal to `boxImage`
   * means up to date; different means an update is available. */
  boxImageTarget: string;
  /** An update has been asked for and the host has not reported back yet. The
   * host polls every five minutes. */
  boxUpdateRequested: boolean;
  /** How the host's last update attempt ended, or null if it never made one.
   * `unsupported` is the honest signal that this host's updater predates the
   * manifest branch and can never self-update. */
  boxUpdateOutcome: BoxUpdateOutcome | null;
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

/** A workspace credential, names only. A value never crosses the wire after
 * the write that created it. The comment says what the key is FOR — it is
 * shown wherever the name is, so an agent or a person can pick the right
 * key without asking. */
export interface WorkspaceCredentialView {
  name: string;
  label: string | null;
  comment: string | null;
  createdAt: number;
}

export interface MachineResponse {
  machine: MachineView;
}

/** Same-location only: the volume stays, the VM is replaced. A type in another
 * location needs a volume move, which is deferred (plan §5). */
export interface SetMachineTypeRequest {
  machineTypeId: string;
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

/** Add or rotate: one live row per (workspace, name), so a second write to a
 * live name replaces its value.
 *
 * `comment` is tri-state: absent keeps the live row's comment across a
 * rotation, an explicit null clears it, a string sets it. Rotation changes
 * the secret, not what the secret is for. */
export interface PutWorkspaceCredentialRequest {
  name: string;
  label?: string;
  comment?: string | null;
  value: string;
}

/** A dotenv text to store key by key. `label` lands on every stored row —
 * callers pass the file name, so a row remembers where it came from.
 * `dryRun` parses and reports without writing; the webApp preview and
 * `blitz-cred import --check` are both this flag. */
export interface ImportWorkspaceCredentialsRequest {
  text: string;
  label?: string;
  dryRun?: boolean;
}

/**
 * What one KEY=value line became. Store-level facts only: `rotated` says a
 * live row held this name and its value changed, never anything about the
 * vendor behind the value. `unchanged` says the incoming value equals the
 * stored one, so nothing was written. A refused line names its reason and the
 * rest of the file still imports.
 */
export interface WorkspaceCredentialImportResult {
  name: string;
  line: number;
  outcome: "stored" | "rotated" | "unchanged" | "refused";
  reason?: string;
}

export interface ImportWorkspaceCredentialsResponse {
  results: WorkspaceCredentialImportResult[];
  linesRead: number;
}

