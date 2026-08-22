export type Agent = 'claude' | 'codex';
export type TerminalAgent = Agent | 'opencode' | 'pi' | 'kimi' | 'prime';
export type RestWorkspaceStatus =
  | 'creating'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'parking'
  | 'parked'
  | 'resuming'
  | 'destroying'
  | 'destroyed'
  | 'error';

export type WorkspaceRecord = {
  id: string;
  ownerMembershipId: string;
  canControl: boolean;
  shared?: boolean;
  owner?: {
    name: string;
    avatarUrl: string | null;
  };
  accessRole?: WorkspaceRole | null;
  orgShareRole?: 'editor' | 'viewer' | null;
  machineType?: string | null;
  name: string;
  status: RestWorkspaceStatus;
  errorDetail?: string | null;
  retryAction: RetryAction;
  createdAt: number;
  updatedAt: number;
  /** Connection names the workspace ceiling enables; the drawer's
   * connections panel draws a status row per name. */
  connections?: string[];
};

export type IdentityRecord = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  platformOperator?: boolean;
};

export type MembershipRecord = {
  id: string;
  role: 'admin' | 'member';
};

export type OrgRecord = {
  id: string;
  slug: string;
  name: string;
  vmLimit: number;
};
import type { RetryAction, WorkspaceRole } from '@blitzos/schema';
