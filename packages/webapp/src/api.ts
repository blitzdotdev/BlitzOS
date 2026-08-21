import type {
  ApiError,
  ListAgentRulesResponse,
  PutAgentRuleRequest,
  PutAgentRuleResponse,
  ListCredentialLeasesResponse,
  MintWorkspaceConnectionResponse,
  ListCredentialEventsResponse,
  CredentialEventView,
  ListCredentialRequestsResponse,
  ListCatalogResponse,
  ListConnectionsResponse,
  ListProviderHealthResponse,
  ListUserGrantsResponse,
  PutUserGrantRequest,
  CreateRecipeRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  CreateWorkspaceTemplateRequest,
  CreateWorkspaceTemplateResponse,
  ListMachineTypesResponse,
  ListRecipesResponse,
  ListWorkspaceTemplatesResponse,
  ListVolumesResponse,
  OrgUsageCaptureResponse,
  PollResponse,
  PutConnectionRequest,
  RecipeResponse,
  RetryAction,
} from "@blitzos/schema";
import {
  decodeGlobalWebAppStateResponse,
  decodeWorkspaceWebAppStateResponse,
  type GlobalWebAppStateV1,
  type WebAppStateResponse,
  type WorkspaceWebAppStateV1,
} from "./storage.js";
import {
  asJsonObject,
  isBoolean,
  type JsonObject,
  type JsonValue,
  isNumber,
  isString,
} from "./type-guards.js";
import {
  createFileLibraryClient,
  type FileLibraryClient,
} from "./file-library-api.js";

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryAction: RetryAction,
  ) {
    super(message);
  }
}

export type CredentialRequestState = "pending" | "approved" | "denied";

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    platformOperator: boolean;
  };
  membership: {
    id: string;
    role: "admin" | "member";
    status: "active";
  } | null;
  org: {
    id: string;
    slug: string;
    name: string;
    vmLimit: number;
  } | null;
  organizations: Array<{
    membership: NonNullable<MeResponse["membership"]>;
    org: NonNullable<MeResponse["org"]>;
  }>;
}

export interface MemberView {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
}

export interface InviteView {
  id: string;
  email: string | null;
  role: "admin" | "member";
  state: "ready" | "redeemed" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  org?: { id: string; name: string };
}

export interface WorkspaceGrantView {
  id: string;
  membershipId: string;
  role: "editor" | "viewer";
  createdAt: number;
  member: { name: string; email: string; avatarUrl: string | null };
}

interface MemberListResponse { members: MemberView[] }
interface MemberResponse { member: MemberView }
interface InviteListResponse { invites: InviteView[]; ttlDays: number }
interface CreatedInviteResponse { invite: InviteView; code: string; ttlDays: number }
interface InviteStatusResponse { invite: InviteView; ttlDays: number }
interface GrantListResponse { grants: WorkspaceGrantView[] }
interface GrantResponse { grant: WorkspaceGrantView }

export interface CreateOrgResponse {
  org: NonNullable<MeResponse["org"]>;
  membership: NonNullable<MeResponse["membership"]>;
}

export interface ControlPlaneClient extends FileLibraryClient {
  googleLoginUrl(): string;
  inviteGoogleLoginUrl(code: string): string;
  inviteStatus(code: string): Promise<{ invite: InviteView; ttlDays: number }>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  createOrg(name: string): Promise<CreateOrgResponse>;
  switchOrg(orgId: string): Promise<void>;
  listMembers(): Promise<{ members: MemberView[] }>;
  updateMember(id: string, input: { role?: "admin" | "member"; status?: "disabled" | "active" }): Promise<{ member: MemberView }>;
  listInvites(): Promise<{ invites: InviteView[]; ttlDays: number }>;
  createInvite(input: { email?: string; role: "admin" | "member" }): Promise<{ invite: InviteView; code: string; ttlDays: number }>;
  revokeInvite(id: string): Promise<void>;
  listWorkspaceGrants(workspaceId: string): Promise<{ grants: WorkspaceGrantView[] }>;
  createWorkspaceGrant(workspaceId: string, membershipId: string, role: "editor" | "viewer"): Promise<{ grant: WorkspaceGrantView }>;
  revokeWorkspaceGrant(workspaceId: string, grantId: string): Promise<void>;
  getGlobalWebAppState(): Promise<WebAppStateResponse<GlobalWebAppStateV1>>;
  putGlobalWebAppState(
    doc: GlobalWebAppStateV1,
  ): Promise<WebAppStateResponse<GlobalWebAppStateV1>>;
  getWorkspaceWebAppState(
    workspaceId: string,
  ): Promise<WebAppStateResponse<WorkspaceWebAppStateV1>>;
  putWorkspaceWebAppState(
    workspaceId: string,
    doc: WorkspaceWebAppStateV1,
  ): Promise<WebAppStateResponse<WorkspaceWebAppStateV1>>;
  poll(signal?: AbortSignal): Promise<PollResponse>;
  create(input: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse>;
  destroy(id: string): Promise<CreateWorkspaceResponse>;
  listAgentRules(): Promise<ListAgentRulesResponse>;
  putAgentRule(id: string, input: PutAgentRuleRequest): Promise<PutAgentRuleResponse>;
  deleteAgentRule(id: string): Promise<void>;
  listWorkspaceTemplates(): Promise<ListWorkspaceTemplatesResponse>;
  createWorkspaceTemplate(
    input: CreateWorkspaceTemplateRequest,
  ): Promise<CreateWorkspaceTemplateResponse>;
  updateWorkspaceTemplate(
    id: string,
    input: CreateWorkspaceTemplateRequest,
  ): Promise<CreateWorkspaceTemplateResponse>;
  deleteWorkspaceTemplate(id: string): Promise<void>;
  listRecipes(): Promise<ListRecipesResponse>;
  getRecipe(id: string): Promise<RecipeResponse>;
  createRecipe(input: CreateRecipeRequest): Promise<RecipeResponse>;
  updateRecipe(id: string, input: CreateRecipeRequest): Promise<RecipeResponse>;
  deleteRecipe(id: string): Promise<void>;
  /** Launches a workspace from the recipe; answers with the same envelope as
   * create, so callers reuse the create-workspace navigation flow. */
  launchRecipe(id: string): Promise<CreateWorkspaceResponse>;
  getUsageCapture(): Promise<OrgUsageCaptureResponse>;
  putUsageCapture(enabled: boolean): Promise<OrgUsageCaptureResponse>;
  setWorkspaceOrgRole(workspaceId: string, role: "editor" | "viewer" | null): Promise<void>;
  listMachineTypes(): Promise<ListMachineTypesResponse>;
  listVolumes(): Promise<ListVolumesResponse>;
  listConnections(signal?: AbortSignal): Promise<ListConnectionsResponse>;
  putConnection(name: string, input: PutConnectionRequest): Promise<void>;
  deleteConnection(name: string): Promise<void>;
  listConnectionCatalog(signal?: AbortSignal): Promise<ListCatalogResponse>;
  listConnectionGrants(signal?: AbortSignal): Promise<ListUserGrantsResponse>;
  putConnectionGrant(provider: string, input: PutUserGrantRequest): Promise<void>;
  deleteConnectionGrant(provider: string): Promise<void>;
  listProviderHealth(signal?: AbortSignal): Promise<ListProviderHealthResponse>;
  /** Full-page navigation target: the provider redirect cannot ride fetch.
   * A workspace id sends the round trip back to that workspace with the lease
   * already minted; without one it is an account authorization and lands in
   * settings. */
  connectStartUrl(provider: string, workspaceId?: string): string;
  listLeases(workspaceId: string, signal?: AbortSignal): Promise<ListCredentialLeasesResponse>;
  /** Connects a provider in one workspace: mints the lease that makes the
   * workspace hold it, from the grant the account already carries. */
  mintWorkspaceConnection(
    workspaceId: string,
    connectionName: string,
  ): Promise<MintWorkspaceConnectionResponse>;
  listCredentialEvents(workspaceId: string, signal?: AbortSignal): Promise<ListCredentialEventsResponse>;
  revokeLease(id: string): Promise<void>;
  listCredentialRequests(
    signal?: AbortSignal,
    state?: CredentialRequestState,
  ): Promise<ListCredentialRequestsResponse>;
  approveCredentialRequest(id: string): Promise<void>;
  denyCredentialRequest(id: string): Promise<void>;
}

export function createControlPlaneClient(baseUrl = ""): ControlPlaneClient {
  const base = baseUrl.replace(/\/$/, "");

  async function request<T>(
    path: string,
    init: RequestInit = {},
    decode?: (json: string) => T,
  ): Promise<T> {
    const response = await rawRequest(path, init);
    if (response.status === 204) {
      // SAFETY: Callers are expected to request void for 204 endpoints, but the generic is not constrained here. TODO(deslop-tier-c): encode no-content endpoints so T must be void.
      return undefined as T;
    }
    if (decode !== undefined) return decode(await response.text());
    // SAFETY: Legacy endpoint JSON is delegated to caller-selected T without validation. TODO(deslop-tier-c): decode each remaining endpoint response into its declared domain type.
    return (await response.json()) as T;
  }

  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${base}${path}`, { ...init, credentials: "include" });
    if (!response.ok) {
      let error: ApiError = { error: `Request failed (${response.status})`, retryAction: null };
      try {
        // SAFETY: response.json establishes JSON only; ApiError fields are not checked. TODO(deslop-tier-c): validate the error envelope before replacing the status-derived fallback.
        error = (await response.json()) as ApiError;
      } catch {
        // The status is still authoritative when an intermediary returns non-JSON.
      }
      throw new ApiRequestError(error.error, response.status, error.retryAction ?? null);
    }
    return response;
  }

  function decodeMe(json: string): MeResponse {
    let value: JsonValue;
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error("/me returned invalid JSON");
    }
    const object = asJsonObject(value);
    const user = object === null ? null : asJsonObject(object.user);
    if (object === null || user === null) {
      throw new Error("/me returned an invalid user");
    }
    if (
      !isString(user.id)
      || !isString(user.email)
      || !isString(user.name)
      || !(user.avatarUrl === null || isString(user.avatarUrl))
      || !isBoolean(user.platformOperator)
    ) throw new Error("/me returned an invalid user");
    let membership: MeResponse["membership"] = null;
    if (object.membership !== null) {
      const candidate = asJsonObject(object.membership);
      if (
        candidate === null
        || !isString(candidate.id)
        || (candidate.role !== "admin" && candidate.role !== "member")
        || candidate.status !== "active"
      ) throw new Error("/me returned an invalid membership");
      membership = {
        id: candidate.id,
        role: candidate.role,
        status: candidate.status,
      };
    }
    let org: MeResponse["org"] = null;
    if (object.org !== null) {
      const candidate = asJsonObject(object.org);
      if (
        candidate === null
        || !isString(candidate.id)
        || !isString(candidate.slug)
        || !isString(candidate.name)
        || !isNumber(candidate.vmLimit)
        || !Number.isSafeInteger(candidate.vmLimit)
      ) throw new Error("/me returned an invalid organization");
      org = {
        id: candidate.id,
        slug: candidate.slug,
        name: candidate.name,
        vmLimit: candidate.vmLimit,
      };
    }
    if ((membership === null) !== (org === null)) {
      throw new Error("/me membership and organization must both be present or absent");
    }
    const organizationsValue = Array.isArray(object.organizations) ? object.organizations : null;
    if (organizationsValue === null) throw new Error("/me returned invalid organizations");
    const organizations: MeResponse["organizations"] = organizationsValue.map((entry) => {
      const item = asJsonObject(entry);
      const itemMembership = item === null ? null : asJsonObject(item.membership);
      const itemOrg = item === null ? null : asJsonObject(item.org);
      if (
        itemMembership === null
        || !isString(itemMembership.id)
        || (itemMembership.role !== "admin" && itemMembership.role !== "member")
        || itemMembership.status !== "active"
        || itemOrg === null
        || !isString(itemOrg.id)
        || !isString(itemOrg.slug)
        || !isString(itemOrg.name)
        || !isNumber(itemOrg.vmLimit)
      ) throw new Error("/me returned invalid organizations");
      return {
        membership: { id: itemMembership.id, role: itemMembership.role, status: "active" },
        org: { id: itemOrg.id, slug: itemOrg.slug, name: itemOrg.name, vmLimit: itemOrg.vmLimit },
      };
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        platformOperator: user.platformOperator,
      },
      membership,
      org,
      organizations,
    };
  }

  function decodeCreateOrg(json: string): CreateOrgResponse {
    let value: JsonValue;
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error("create-org returned invalid JSON");
    }
    const object = asJsonObject(value);
    const org = object === null ? null : asJsonObject(object.org);
    const membership = object === null ? null : asJsonObject(object.membership);
    if (
      org === null
      || !isString(org.id)
      || !isString(org.slug)
      || !isString(org.name)
      || !isNumber(org.vmLimit)
      || !Number.isSafeInteger(org.vmLimit)
      || membership === null
      || !isString(membership.id)
      || (membership.role !== "admin" && membership.role !== "member")
      || membership.status !== "active"
    ) throw new Error("create-org returned an invalid organization");
    return {
      org: { id: org.id, slug: org.slug, name: org.name, vmLimit: org.vmLimit },
      membership: {
        id: membership.id,
        role: membership.role,
        status: membership.status,
      },
    };
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

  function memberView(value: JsonValue, label: string): MemberView {
    const member = asJsonObject(value);
    if (
      member === null
      || !isString(member.id)
      || !isString(member.email)
      || !isString(member.name)
      || !(member.avatarUrl === null || isString(member.avatarUrl))
      || (member.role !== "admin" && member.role !== "member")
      || (member.status !== "active" && member.status !== "disabled")
    ) throw new Error(`${label} returned an invalid member`);
    return {
      id: member.id,
      email: member.email,
      name: member.name,
      avatarUrl: member.avatarUrl,
      role: member.role,
      status: member.status,
    };
  }

  function decodeMembers(json: string): MemberListResponse {
    const object = parsedObject(json, "members");
    if (!Array.isArray(object.members)) throw new Error("members returned an invalid list");
    return { members: object.members.map((member) => memberView(member, "members")) };
  }

  function decodeMember(json: string): MemberResponse {
    const object = parsedObject(json, "member");
    return { member: memberView(object.member ?? null, "member") };
  }

  function inviteView(value: JsonValue, label: string): InviteView {
    const invite = asJsonObject(value);
    if (
      invite === null
      || !isString(invite.id)
      || !(invite.email === null || isString(invite.email))
      || (invite.role !== "admin" && invite.role !== "member")
      || (invite.state !== "ready" && invite.state !== "redeemed" && invite.state !== "revoked" && invite.state !== "expired")
      || !isNumber(invite.createdAt)
      || !isNumber(invite.expiresAt)
      || !(invite.redeemedAt === null || isNumber(invite.redeemedAt) || invite.redeemedAt === undefined)
    ) throw new Error(`${label} returned an invalid invite`);
    const view: InviteView = {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      state: invite.state,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      redeemedAt: isNumber(invite.redeemedAt) ? invite.redeemedAt : null,
    };
    if (invite.org !== undefined) {
      const org = asJsonObject(invite.org);
      if (org === null || !isString(org.id) || !isString(org.name)) {
        throw new Error(`${label} returned an invalid organization`);
      }
      view.org = { id: org.id, name: org.name };
    }
    return view;
  }

  function decodeInvites(json: string): InviteListResponse {
    const object = parsedObject(json, "invites");
    if (!Array.isArray(object.invites) || !isNumber(object.ttlDays)) {
      throw new Error("invites returned an invalid list");
    }
    return { invites: object.invites.map((invite) => inviteView(invite, "invites")), ttlDays: object.ttlDays };
  }

  function decodeCreatedInvite(json: string): CreatedInviteResponse {
    const object = parsedObject(json, "create invite");
    if (!isString(object.code) || !isNumber(object.ttlDays)) {
      throw new Error("create invite returned invalid data");
    }
    return { invite: inviteView(object.invite ?? null, "create invite"), code: object.code, ttlDays: object.ttlDays };
  }

  function decodeInviteStatus(json: string): InviteStatusResponse {
    const object = parsedObject(json, "invite status");
    if (!isNumber(object.ttlDays)) throw new Error("invite status returned invalid data");
    return { invite: inviteView(object.invite ?? null, "invite status"), ttlDays: object.ttlDays };
  }

  function grantView(value: JsonValue, label: string): WorkspaceGrantView {
    const grant = asJsonObject(value);
    const member = grant === null ? null : asJsonObject(grant.member);
    if (
      grant === null
      || !isString(grant.id)
      || !isString(grant.membershipId)
      || (grant.role !== "editor" && grant.role !== "viewer")
      || !isNumber(grant.createdAt)
      || member === null
      || !isString(member.name)
      || !isString(member.email)
      || !(member.avatarUrl === null || isString(member.avatarUrl))
    ) throw new Error(`${label} returned an invalid grant`);
    return {
      id: grant.id,
      membershipId: grant.membershipId,
      role: grant.role,
      createdAt: grant.createdAt,
      member: { name: member.name, email: member.email, avatarUrl: member.avatarUrl },
    };
  }

  function decodeGrants(json: string): GrantListResponse {
    const object = parsedObject(json, "workspace grants");
    if (!Array.isArray(object.grants)) throw new Error("workspace grants returned an invalid list");
    return { grants: object.grants.map((grant) => grantView(grant, "workspace grants")) };
  }

  function decodeGrant(json: string): GrantResponse {
    const object = parsedObject(json, "workspace grant");
    return { grant: grantView(object.grant ?? null, "workspace grant") };
  }

  function decodeCredentialEvents(json: string): ListCredentialEventsResponse {
    const object = parsedObject(json, "credential events");
    if (!Array.isArray(object.events)) throw new Error("credential events returned an invalid list");
    const events: CredentialEventView[] = object.events.map((value) => {
      const event = asJsonObject(value);
      if (
        event === null
        || !isNumber(event.id)
        || !Number.isSafeInteger(event.id)
        || !(event.leaseId === null || isString(event.leaseId))
        || (event.event !== "minted" && event.event !== "revoked" && event.event !== "denied" && event.event !== "approved")
        || !isNumber(event.createdAt)
      ) throw new Error("credential events returned an invalid event");
      return {
        id: event.id,
        leaseId: event.leaseId,
        event: event.event,
        detail: event.detail ?? null,
        createdAt: event.createdAt,
      };
    });
    return { events };
  }

  return {
    ...createFileLibraryClient(rawRequest),
    googleLoginUrl: () => `${base}/auth/google/start`,
    inviteGoogleLoginUrl: (code) => `${base}/auth/google/start?invite=${encodeURIComponent(code)}`,
    inviteStatus: (code) => request<{ invite: InviteView; ttlDays: number }>(`/invite/${encodeURIComponent(code)}`, {}, decodeInviteStatus),
    logout: () => request<void>("/sessions", { method: "DELETE" }),
    me: () => request<MeResponse>("/me", {}, decodeMe),
    createOrg: (name) =>
      request<CreateOrgResponse>("/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }, decodeCreateOrg),
    switchOrg: (orgId) => request<void>("/sessions/switch-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    }),
    listMembers: () => request<{ members: MemberView[] }>("/members", {}, decodeMembers),
    updateMember: (id, input) => request<{ member: MemberView }>(`/members/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }, decodeMember),
    listInvites: () => request<{ invites: InviteView[]; ttlDays: number }>("/invites", {}, decodeInvites),
    createInvite: (input) => request<{ invite: InviteView; code: string; ttlDays: number }>("/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }, decodeCreatedInvite),
    revokeInvite: (id) => request<void>(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listWorkspaceGrants: (workspaceId) => request<{ grants: WorkspaceGrantView[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/grants`, {}, decodeGrants,
    ),
    createWorkspaceGrant: (workspaceId, membershipId, role) => request<{ grant: WorkspaceGrantView }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/grants`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, role }),
      }, decodeGrant,
    ),
    revokeWorkspaceGrant: (workspaceId, grantId) => request<void>(
      `/workspaces/${encodeURIComponent(workspaceId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
    getGlobalWebAppState: () =>
      request<WebAppStateResponse<GlobalWebAppStateV1>>(
        "/webapp-state",
        {},
        decodeGlobalWebAppStateResponse,
      ),
    putGlobalWebAppState: (doc) =>
      request<WebAppStateResponse<GlobalWebAppStateV1>>(
        "/webapp-state",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc),
        },
        decodeGlobalWebAppStateResponse,
      ),
    getWorkspaceWebAppState: (workspaceId) =>
      request<WebAppStateResponse<WorkspaceWebAppStateV1>>(
        `/workspaces/${encodeURIComponent(workspaceId)}/webapp-state`,
        {},
        decodeWorkspaceWebAppStateResponse,
      ),
    putWorkspaceWebAppState: (workspaceId, doc) =>
      request<WebAppStateResponse<WorkspaceWebAppStateV1>>(
        `/workspaces/${encodeURIComponent(workspaceId)}/webapp-state`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc),
        },
        decodeWorkspaceWebAppStateResponse,
      ),
    poll: (signal) => request<PollResponse>("/workspaces", { signal }),
    create: (input) =>
      request<CreateWorkspaceResponse>("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    destroy: (id) =>
      request<CreateWorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    listAgentRules: () => request<ListAgentRulesResponse>("/agent-rules"),
    putAgentRule: (id, input) =>
      request<PutAgentRuleResponse>(`/agent-rules/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteAgentRule: (id) =>
      request<void>(`/agent-rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listWorkspaceTemplates: () =>
      request<ListWorkspaceTemplatesResponse>("/workspace-templates"),
    createWorkspaceTemplate: (input) =>
      request<CreateWorkspaceTemplateResponse>("/workspace-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    updateWorkspaceTemplate: (id, input) =>
      request<CreateWorkspaceTemplateResponse>(`/workspace-templates/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteWorkspaceTemplate: (id) =>
      request<void>(`/workspace-templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    listRecipes: () => request<ListRecipesResponse>("/workspace-recipes"),
    getRecipe: (id) => request<RecipeResponse>(`/workspace-recipes/${encodeURIComponent(id)}`),
    createRecipe: (input) =>
      request<RecipeResponse>("/workspace-recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    updateRecipe: (id, input) =>
      request<RecipeResponse>(`/workspace-recipes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteRecipe: (id) =>
      request<void>(`/workspace-recipes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    launchRecipe: (id) =>
      request<CreateWorkspaceResponse>(`/workspace-recipes/${encodeURIComponent(id)}/launch`, {
        method: "POST",
      }),
    getUsageCapture: () => request<OrgUsageCaptureResponse>("/orgs/self/usage-capture"),
    putUsageCapture: (enabled) =>
      request<OrgUsageCaptureResponse>("/orgs/self/usage-capture", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    setWorkspaceOrgRole: (workspaceId, role) =>
      request<void>(`/workspaces/${encodeURIComponent(workspaceId)}/org-role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      }),
    listMachineTypes: () => request<ListMachineTypesResponse>("/machine-types"),
    listVolumes: () => request<ListVolumesResponse>("/volumes"),
    listConnections: (signal) =>
      request<ListConnectionsResponse>("/connections", { signal }),
    putConnection: (name, input) =>
      request<void>(`/connections/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteConnection: (name) =>
      request<void>(`/connections/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    listConnectionCatalog: (signal) =>
      request<ListCatalogResponse>("/connections/catalog", { signal }),
    listConnectionGrants: (signal) =>
      request<ListUserGrantsResponse>("/connections/grants", { signal }),
    putConnectionGrant: (provider, input) =>
      request<void>(`/connections/grants/${encodeURIComponent(provider)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteConnectionGrant: (provider) =>
      request<void>(`/connections/grants/${encodeURIComponent(provider)}`, {
        method: "DELETE",
      }),
    listProviderHealth: (signal) =>
      request<ListProviderHealthResponse>("/connections/health", { signal }),
    connectStartUrl: (provider, workspaceId) =>
      `${base}/connect/${encodeURIComponent(provider)}/start${
        workspaceId === undefined
          ? ""
          : `?workspaceId=${encodeURIComponent(workspaceId)}`
      }`,
    listLeases: (workspaceId, signal) =>
      request<ListCredentialLeasesResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/leases`,
        { signal },
      ),
    listCredentialEvents: (workspaceId, signal) =>
      request<ListCredentialEventsResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/credential-events`,
        { signal },
        decodeCredentialEvents,
      ),
    mintWorkspaceConnection: (workspaceId, connectionName) =>
      request<MintWorkspaceConnectionResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionName)}/lease`,
        { method: "POST" },
      ),
    revokeLease: (id) =>
      request<void>(`/leases/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listCredentialRequests: (signal, state = "pending") =>
      request<ListCredentialRequestsResponse>(`/requests?state=${state}`, { signal }),
    approveCredentialRequest: (id) =>
      request<void>(`/requests/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      }),
    denyCredentialRequest: (id) =>
      request<void>(`/requests/${encodeURIComponent(id)}/deny`, {
        method: "POST",
      }),
  };
}
