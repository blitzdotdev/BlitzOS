import type { WebAppApiRequest } from './compute-credentials-api';
import {
  asJsonObject,
  isBoolean,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from './type-guards';

/** The platform operator's console client. Session-authed like the rest of
 * the control-plane surface; the server refuses anyone without
 * users.platform_operator, so a 403 here is a person, not a bug. */

export type AdminRole = 'admin' | 'member';
export type AdminMemberStatus = 'invited' | 'active' | 'disabled';
export type AdminInviteState = 'ready' | 'redeemed' | 'revoked' | 'expired';
export type AdminWorkspacePhase = 'creating' | 'ready' | 'destroying' | 'destroyed' | 'error';

export interface AdminOrgMember {
  email: string;
  name: string;
  role: AdminRole;
  status: AdminMemberStatus;
}

export interface AdminOrgInvite {
  id: string;
  email: string | null;
  role: AdminRole;
  state: AdminInviteState;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

export interface AdminOrgWorkspace {
  id: string;
  name: string | null;
  phase: AdminWorkspacePhase;
  machineTypeId: string;
  credentialSource: 'org' | 'deployment';
  createdAt: number;
}

export interface AdminOrgView {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
  /** Creator email; null for the bootstrap organization. */
  createdBy: string | null;
  vmLimit: number;
  /** Null where no billing row exists: the free tier. */
  seatLimit: number | null;
  platformCompute: boolean;
  /** Non-null marks an operator-sponsored trial. */
  trialExpiresAt: number | null;
  members: AdminOrgMember[];
  invites: AdminOrgInvite[];
  /** Everything but destroyed rows: the live estate plus its failures. */
  workspaces: AdminOrgWorkspace[];
}

export interface CreateTrialOrgInput {
  name: string;
  email?: string;
  seatLimit?: number;
  vmLimit?: number;
  trialDays?: number;
}

export interface CreateTrialOrgResponse {
  org: { id: string; slug: string; name: string; vmLimit: number };
  invite: {
    id: string;
    email: string | null;
    role: AdminRole;
    state: AdminInviteState;
    createdAt: number;
    expiresAt: number;
  };
  /** The invite secret, answered exactly once: the link is
   * `${origin}/invite/${code}` and the server stores only its hash. */
  code: string;
  ttlDays: number;
  trialExpiresAt: number;
}

export interface AdminOrgsResponse {
  orgs: AdminOrgView[];
}

export interface AdminClient {
  adminOrgs(signal?: AbortSignal): Promise<AdminOrgsResponse>;
  createTrialOrg(input: CreateTrialOrgInput): Promise<CreateTrialOrgResponse>;
}

function parsedObject(json: string, label: string): JsonObject {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const object = asJsonObject(value);
  if (object === null) throw new Error(`${label} returned an invalid object`);
  return object;
}

function isRole(value: JsonValue | undefined): value is AdminRole {
  return value === 'admin' || value === 'member';
}

function isInviteState(value: JsonValue | undefined): value is AdminInviteState {
  return value === 'ready' || value === 'redeemed' || value === 'revoked' || value === 'expired';
}

function memberEntry(value: JsonValue): AdminOrgMember {
  const member = asJsonObject(value);
  if (
    member === null
    || !isString(member.email)
    || !isString(member.name)
    || !isRole(member.role)
    || (member.status !== 'invited' && member.status !== 'active' && member.status !== 'disabled')
  ) throw new Error('admin orgs returned an invalid member');
  return { email: member.email, name: member.name, role: member.role, status: member.status };
}

function inviteEntry(value: JsonValue): AdminOrgInvite {
  const invite = asJsonObject(value);
  if (
    invite === null
    || !isString(invite.id)
    || !(invite.email === null || isString(invite.email))
    || !isRole(invite.role)
    || !isInviteState(invite.state)
    || !isNumber(invite.createdAt)
    || !isNumber(invite.expiresAt)
    || !(invite.redeemedAt === null || isNumber(invite.redeemedAt))
  ) throw new Error('admin orgs returned an invalid invite');
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    state: invite.state,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt,
  };
}

function workspaceEntry(value: JsonValue): AdminOrgWorkspace {
  const workspace = asJsonObject(value);
  if (
    workspace === null
    || !isString(workspace.id)
    || !(workspace.name === null || isString(workspace.name))
    || (workspace.phase !== 'creating' && workspace.phase !== 'ready'
      && workspace.phase !== 'destroying' && workspace.phase !== 'destroyed'
      && workspace.phase !== 'error')
    || !isString(workspace.machineTypeId)
    || (workspace.credentialSource !== 'org' && workspace.credentialSource !== 'deployment')
    || !isNumber(workspace.createdAt)
  ) throw new Error('admin orgs returned an invalid workspace');
  return {
    id: workspace.id,
    name: workspace.name,
    phase: workspace.phase,
    machineTypeId: workspace.machineTypeId,
    credentialSource: workspace.credentialSource,
    createdAt: workspace.createdAt,
  };
}

function orgView(value: JsonValue): AdminOrgView {
  const org = asJsonObject(value);
  if (
    org === null
    || !isString(org.id)
    || !isString(org.slug)
    || !isString(org.name)
    || !isNumber(org.createdAt)
    || !(org.createdBy === null || isString(org.createdBy))
    || !isNumber(org.vmLimit)
    || !(org.seatLimit === null || isNumber(org.seatLimit))
    || !isBoolean(org.platformCompute)
    || !(org.trialExpiresAt === null || isNumber(org.trialExpiresAt))
    || !Array.isArray(org.members)
    || !Array.isArray(org.invites)
    || !Array.isArray(org.workspaces)
  ) throw new Error('admin orgs returned an invalid organization');
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    createdAt: org.createdAt,
    createdBy: org.createdBy,
    vmLimit: org.vmLimit,
    seatLimit: org.seatLimit,
    platformCompute: org.platformCompute,
    trialExpiresAt: org.trialExpiresAt,
    members: org.members.map(memberEntry),
    invites: org.invites.map(inviteEntry),
    workspaces: org.workspaces.map(workspaceEntry),
  };
}

function decodeAdminOrgs(json: string): AdminOrgsResponse {
  const object = parsedObject(json, 'admin orgs');
  if (!Array.isArray(object.orgs)) throw new Error('admin orgs returned an invalid list');
  return { orgs: object.orgs.map(orgView) };
}

function decodeCreatedTrialOrg(json: string): CreateTrialOrgResponse {
  const object = parsedObject(json, 'create trial org');
  const org = asJsonObject(object.org ?? null);
  const invite = asJsonObject(object.invite ?? null);
  if (
    org === null
    || !isString(org.id)
    || !isString(org.slug)
    || !isString(org.name)
    || !isNumber(org.vmLimit)
    || invite === null
    || !isString(invite.id)
    || !(invite.email === null || isString(invite.email))
    || !isRole(invite.role)
    || !isInviteState(invite.state)
    || !isNumber(invite.createdAt)
    || !isNumber(invite.expiresAt)
    || !isString(object.code)
    || !isNumber(object.ttlDays)
    || !isNumber(object.trialExpiresAt)
  ) throw new Error('create trial org returned invalid data');
  return {
    org: { id: org.id, slug: org.slug, name: org.name, vmLimit: org.vmLimit },
    invite: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      state: invite.state,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    },
    code: object.code,
    ttlDays: object.ttlDays,
    trialExpiresAt: object.trialExpiresAt,
  };
}

export function createAdminClient(request: WebAppApiRequest): AdminClient {
  return {
    adminOrgs: (signal) =>
      request<AdminOrgsResponse>('/admin/orgs', { signal }, decodeAdminOrgs),
    createTrialOrg: (input) =>
      request<CreateTrialOrgResponse>('/admin/trial-orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }, decodeCreatedTrialOrg),
  };
}
