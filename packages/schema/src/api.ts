import type { MachineType } from "./machine.js";
import type { CredentialManifest } from "./credential.js";
import type { WorkspaceEnvironment } from "./environment.js";
import type { Volume } from "./volume.js";
import type { RetryAction, WorkspaceView } from "./workspace.js";

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
  /** Required unless templateId is set; then the template's machine type is the default. */
  machineTypeId?: string;
  /** Creates from a workspace template: its folders attach automatically. */
  templateId?: string;
  /** Shares the new workspace with every active org member at this role. */
  orgShareRole?: "editor" | "viewer";
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
  environment?: WorkspaceEnvironment;
  /** Overrides the template's rule; null (or absent) falls back to the
   * template's rule and then the built-in doc. */
  agentRuleId?: string | null;
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

/** What an organization's limits are and how much of them is in use.
 * `seatLimit` is null where no billing service is attached: that deployment
 * has no cap to show, rather than a large one. */
export interface OrgUsageResponse {
  seatsUsed: number;
  seatLimit: number | null;
  vmsUsed: number;
  vmLimit: number;
}

/** The two places an admin can go in the billing service: buy seats, or change
 * the seats already bought. Both carry the same signed hop. */
export interface OrgBillingLinksResponse {
  checkoutUrl: string;
  portalUrl: string;
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
