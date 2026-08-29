import type { MachineType } from "./machine.js";
import type { CredentialManifest } from "./credential.js";
import type { Volume } from "./volume.js";
import type { RetryAction, WorkspaceMemberRole, WorkspaceView } from "./workspace.js";

export interface MachineTypeProviderFailure {
  providerId: string;
  error: string;
}

export interface MachineTypeProviderStatus {
  providerId: string;
  access: "org" | "deployment" | "credential-required";
}

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
  /** Present on current servers. Optional keeps older API clients and test
   * doubles source-compatible while they adopt inline credential setup. */
  providerStatuses?: MachineTypeProviderStatus[];
}

export interface CreateWorkspaceRequest {
  /** Legacy spelling of `defaultMachineTypeId`; either satisfies the
   * requirement, and `defaultMachineTypeId` wins when both are sent. */
  machineTypeId?: string;
  /** The default a machine takes when nothing else names one. */
  defaultMachineTypeId?: string;
  /** Provision and start a machine on every member add. Default true. */
  autoProvision?: boolean;
  /** Existing org members, added immediately. The creator is the first
   * workspace admin and never needs a row here. */
  members?: {
    membershipId: string;
    role: WorkspaceMemberRole;
    machineTypeId?: string;
    /** Default true; false gives that member's machine no volume. */
    persistentVolume?: boolean;
  }[];
  /** The only path where a credential value is sent. */
  credentials?: { name: string; label?: string; comment?: string; value: string }[];
  /** Copies config — default machine type, agent rule, repos, credential
   * NAMES are not copied and neither are members. The workspace is the
   * template now, so this is "new workspace from existing". */
  cloneFromWorkspaceId?: string;
  /** Retired with the template tables (plans/MEMBER-MACHINES.md §0). Sending
   * one is refused rather than ignored. */
  templateId?: string;
  /** Optional display name; blank means the server picks a random one. */
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  /** User-data is readable inside the VM; never put secrets here. */
  userData?: string;
  manifest?: CredentialManifest;
  /** Providers to enable in the new workspace. The manifest stays the ceiling;
   * this is the provision list, and the ceiling wins on conflict. */
  connections?: string[];
  /** Overrides the clone source's rule; null (or absent) falls back to the
   * source's rule and then the built-in doc. */
  agentRuleId?: string | null;
  /** GitHub repositories ("owner/name") the box clones into /workspace. Only
   * for a create with no clone source: a cloned workspace already carries its
   * own list, and a request that names both is refused rather than merged. */
  repos?: string[];
}

export interface CreateWorkspaceResponse {
  workspace: WorkspaceView;
}

export interface PollResponse {
  /** A poll is authoritative and can add, update, or remove rows. */
  workspaces: WorkspaceView[];
}

export interface RegisterKeysResponse {
  memberUnixName: string;
  broker: {
    host: string;
    port: number;
    sshHostPublicKey: string;
  };
}

export interface ApiError {
  error: string;
  retryAction: RetryAction;
  /** Where a person can pay their way past this refusal. Present only on the
   * 402 a seat gate throws, and only where the deployment has a billing
   * service with a checkout surface — a refusal with nowhere to go is still a
   * refusal, it just cannot offer a way out. */
  paymentUrl?: string;
}

/** The one write a private billing service makes. Two integers and one flag;
 * no plan name, ever. `platformCompute` is optional and absent means 0: the
 * body states an organization's whole entitlement, so a write that omits the
 * flag says the organization does not have it, exactly as a missing row does.
 */
export interface EntitlementsRequest {
  seatLimit: number;
  vmLimit: number;
  platformCompute?: boolean;
}

/** What an organization's limits are and how much of them is in use.
 * `seatLimit` is null where no billing service is attached: that deployment
 * has no cap to show, rather than a large one. `platformCompute` is why a
 * workspace create is refused or allowed without an organization credential,
 * so an admin can see the reason rather than guess at it. */
export interface OrgUsageResponse {
  seatsUsed: number;
  seatLimit: number | null;
  vmsUsed: number;
  vmLimit: number;
  platformCompute: boolean;
}

/** Where an admin goes to deal with billing, carrying a signed hop. One link,
 * not one per errand: the billing service reads the hop and offers buying or
 * the portal depending on what the organization already has, so choosing here
 * would only be a second opinion about the same fact. */
export interface OrgBillingResponse {
  url: string;
}

export interface CreateVolumeRequest {
  name: string;
  sizeGb: number;
  location: string;
}

export interface CreateVolumeResponse {
  volume: Volume;
}

export interface ListVolumesResponse {
  volumes: Volume[];
}

export interface DeleteVolumeResponse {
  id: string;
}

export const INVITE_TTL_DAYS = 7;
