import type {
  AddWorkspaceMemberRequest,
  AddWorkspaceRepoRequest,
  ApiError,
  ProvisionMemberMachineRequest,
  GrantSessionShareRequest,
  ListSessionSharesResponse,
  ListWorkspaceReposResponse,
  UpdateWorkspaceRequest,
  ListAgentRulesResponse,
  MachineResponse,
  SetMachineTypeRequest,
  UpdateWorkspaceMemberRequest,
  SessionShareView,
  WorkspaceMemberResponse,
  PutAgentRuleRequest,
  PutAgentRuleResponse,
  MintWorkspaceConnectionResponse,
  ListCredentialEventsResponse,
  CredentialEventView,
  ListCredentialRequestsResponse,
  ListCatalogResponse,
  CheckGithubRepositoriesResponse,
  ListConnectionsResponse,
  ListGithubInstallationsResponse,
  ListGithubRepositoriesResponse,
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
  OrgBillingResponse,
  OrgUsageCaptureResponse,
  OrgUsageResponse,
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
import {
  createComputeCredentialsClient,
  type ComputeCredentialsClient,
} from "./compute-credentials-api.js";

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryAction: RetryAction,
    /** Where a person can pay their way past this refusal, on the 402 a seat
     * gate throws. Null on every other error, and on a deployment whose
     * billing service has no checkout surface. */
    public readonly paymentUrl: string | null = null,
  ) {
    super(message);
  }
}

export type CredentialRequestState = "pending" | "approved" | "denied";

export type ConnectReturnTo =
  | "template-new"
  | `template-edit:${string}`
  | "workspace-new";

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

interface MemberListResponse { members: MemberView[] }
interface MemberResponse { member: MemberView }
interface InviteListResponse { invites: InviteView[]; ttlDays: number }
interface CreatedInviteResponse { invite: InviteView; code: string; ttlDays: number }
interface InviteStatusResponse { invite: InviteView; ttlDays: number }

export interface CreateOrgResponse {
  org: NonNullable<MeResponse["org"]>;
  membership: NonNullable<MeResponse["membership"]>;
}

export interface ControlPlaneClient extends FileLibraryClient, ComputeCredentialsClient {
  googleLoginUrl(): string;
  inviteGoogleLoginUrl(code: string): string;
  inviteStatus(code: string): Promise<{ invite: InviteView; ttlDays: number }>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  createOrg(name: string): Promise<CreateOrgResponse>;
  switchOrg(orgId: string): Promise<void>;
  leaveOrg(): Promise<void>;
  listMembers(): Promise<{ members: MemberView[] }>;
  updateMember(id: string, input: { role?: "admin" | "member"; status?: "disabled" | "active" }): Promise<{ member: MemberView }>;
  listInvites(): Promise<{ invites: InviteView[]; ttlDays: number }>;
  createInvite(input: { email?: string; role: "admin" | "member" }): Promise<{ invite: InviteView; code: string; ttlDays: number }>;
  revokeInvite(id: string): Promise<void>;
  /** Adds an active org member (plans/MEMBER-MACHINES.md §2.1). Where the
   * workspace auto-provisions, the answer already carries their machine. */
  addWorkspaceMember(
    workspaceId: string,
    input: AddWorkspaceMemberRequest,
  ): Promise<WorkspaceMemberResponse>;
  /** The role write and the machine act are one request: demoting to viewer
   * destroys the machine, promoting a viewer provisions one. */
  updateWorkspaceMember(
    workspaceId: string,
    membershipId: string,
    input: UpdateWorkspaceMemberRequest,
  ): Promise<WorkspaceMemberResponse>;
  removeWorkspaceMember(workspaceId: string, membershipId: string): Promise<void>;
  /** Provisions the machine a member row does not hold yet: the workspace does
   * not auto-provision, or theirs was destroyed. A viewer is refused. */
  provisionMemberMachine(
    workspaceId: string,
    membershipId: string,
    input: ProvisionMemberMachineRequest,
  ): Promise<WorkspaceMemberResponse>;
  /** The workspace settings write. Absent fields are left alone, and a new
   * default machine type moves only what is provisioned after it. */
  updateWorkspace(
    workspaceId: string,
    input: UpdateWorkspaceRequest,
  ): Promise<CreateWorkspaceResponse>;
  /** The workspace's own clone list; a change lands on the next provision. */
  listWorkspaceRepos(workspaceId: string): Promise<ListWorkspaceReposResponse>;
  addWorkspaceRepo(
    workspaceId: string,
    input: AddWorkspaceRepoRequest,
  ): Promise<ListWorkspaceReposResponse>;
  removeWorkspaceRepo(workspaceId: string, repo: string): Promise<void>;
  /** Both halves of session sharing on one screen: `granted` is what the
   * caller may manage, `received` is what other members shared with them
   * (plans/LODY-SHARING.md §1.3). `sessionId` narrows `granted` to the session
   * the share dialog is open on. */
  listSessionShares(
    workspaceId: string,
    sessionId?: string,
  ): Promise<ListSessionSharesResponse>;
  /** Grant, or change an existing grant's level — the write upserts on
   * (workspace, session, grantee), so both are this one call. */
  grantSessionShare(
    workspaceId: string,
    input: GrantSessionShareRequest,
  ): Promise<SessionShareView>;
  revokeSessionShare(workspaceId: string, shareId: string): Promise<void>;
  provisionMachine(machineId: string): Promise<MachineResponse>;
  stopMachine(machineId: string): Promise<MachineResponse>;
  startMachine(machineId: string): Promise<MachineResponse>;
  recreateMachine(machineId: string): Promise<MachineResponse>;
  /** Same-location only: the VM is replaced and the volume — the disk — stays.
   * Another location is refused until the volume move lands (§5). */
  setMachineType(machineId: string, input: SetMachineTypeRequest): Promise<MachineResponse>;
  destroyMachine(machineId: string): Promise<MachineResponse>;
  // TODO(org-credentials-ui): org credential client methods
  // (GET/PUT /orgs/:id/credentials*) land with the new panel
  // (plans/ORG-CREDENTIALS.md §9). The workspace credential store is deleted.
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
  orgUsage(): Promise<OrgUsageResponse>;
  billing(): Promise<OrgBillingResponse>;
  putUsageCapture(enabled: boolean): Promise<OrgUsageCaptureResponse>;
  listMachineTypes(): Promise<ListMachineTypesResponse>;
  listVolumes(): Promise<ListVolumesResponse>;
  listConnections(signal?: AbortSignal): Promise<ListConnectionsResponse>;
  putConnection(name: string, input: PutConnectionRequest): Promise<void>;
  deleteConnection(name: string): Promise<void>;
  listConnectionCatalog(signal?: AbortSignal): Promise<ListCatalogResponse>;
  listConnectionGrants(signal?: AbortSignal): Promise<ListUserGrantsResponse>;
  listGithubInstallations(signal?: AbortSignal): Promise<ListGithubInstallationsResponse>;
  listGithubRepositories(signal?: AbortSignal): Promise<ListGithubRepositoriesResponse>;
  checkGithubRepositories(repos: string[]): Promise<CheckGithubRepositoriesResponse>;
  putConnectionGrant(provider: string, input: PutUserGrantRequest): Promise<void>;
  deleteConnectionGrant(provider: string): Promise<void>;
  listProviderHealth(signal?: AbortSignal): Promise<ListProviderHealthResponse>;
  /** Full-page navigation target: the provider redirect cannot ride fetch.
   * Workspace ids return with a lease; named surfaces use the control plane's
   * closed returnTo set; callers that supply neither still return to settings. */
  connectStartUrl(
    provider: string,
    workspaceId?: string,
    returnTo?: ConnectReturnTo,
  ): string;
  /** Connects a provider in one workspace: adds it to that workspace's
   * allow-list, then mints once so a broken credential says so now. */
  mintWorkspaceConnection(
    workspaceId: string,
    connectionName: string,
  ): Promise<MintWorkspaceConnectionResponse>;
  /** Disconnects a provider from one workspace. The account's authorization
   * survives, so the member's other workspaces keep working. */
  disconnectWorkspaceConnection(
    workspaceId: string,
    connectionName: string,
  ): Promise<void>;
  listCredentialEvents(workspaceId: string, signal?: AbortSignal): Promise<ListCredentialEventsResponse>;
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

  const jsonHeaders = { "Content-Type": "application/json" };

  /** The four machine lifecycle verbs are one POST with no body and the same
   * envelope back, so they share a call rather than four copies of it. */
  function machineAction(
    machineId: string,
    action: "provision" | "stop" | "start" | "recreate",
  ): Promise<MachineResponse> {
    return request<MachineResponse>(
      `/machines/${encodeURIComponent(machineId)}/${action}`,
      { method: "POST" },
    );
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
      throw new ApiRequestError(
        error.error,
        response.status,
        error.retryAction ?? null,
        error.paymentUrl ?? null,
      );
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
    ...createComputeCredentialsClient(request),
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
    leaveOrg: () => request<void>("/members/self", { method: "DELETE" }),
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
    addWorkspaceMember: (workspaceId, input) => request<WorkspaceMemberResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    updateWorkspaceMember: (workspaceId, membershipId, input) => request<WorkspaceMemberResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    removeWorkspaceMember: (workspaceId, membershipId) => request<void>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" },
    ),
    updateWorkspace: (workspaceId, input) => request<CreateWorkspaceResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    listWorkspaceRepos: (workspaceId) => request<ListWorkspaceReposResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/repos`,
    ),
    addWorkspaceRepo: (workspaceId, input) => request<ListWorkspaceReposResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/repos`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    // "owner/name" is two path segments, because a slash inside one parameter
    // is not something the router hands back intact.
    removeWorkspaceRepo: (workspaceId, repo) => request<void>(
      `/workspaces/${encodeURIComponent(workspaceId)}/repos/${repo.split("/").map(encodeURIComponent).join("/")}`,
      { method: "DELETE" },
    ),
    listSessionShares: (workspaceId, sessionId) => request<ListSessionSharesResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/session-shares`
        + (sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`),
    ),
    grantSessionShare: (workspaceId, input) => request<SessionShareView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/session-shares`,
      { method: "PUT", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    revokeSessionShare: (workspaceId, shareId) => request<void>(
      `/workspaces/${encodeURIComponent(workspaceId)}/session-shares/${encodeURIComponent(shareId)}`,
      { method: "DELETE" },
    ),
    provisionMemberMachine: (workspaceId, membershipId, input) => request<WorkspaceMemberResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}/machine`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    provisionMachine: (machineId) => machineAction(machineId, "provision"),
    stopMachine: (machineId) => machineAction(machineId, "stop"),
    startMachine: (machineId) => machineAction(machineId, "start"),
    recreateMachine: (machineId) => machineAction(machineId, "recreate"),
    setMachineType: (machineId, input) => request<MachineResponse>(
      `/machines/${encodeURIComponent(machineId)}/machine-type`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) },
    ),
    destroyMachine: (machineId) => request<MachineResponse>(
      `/machines/${encodeURIComponent(machineId)}`,
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
    orgUsage: () => request<OrgUsageResponse>("/orgs/self/usage"),
    billing: () => request<OrgBillingResponse>("/orgs/self/billing"),
    putUsageCapture: (enabled) =>
      request<OrgUsageCaptureResponse>("/orgs/self/usage-capture", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
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
    listGithubInstallations: (signal) =>
      request<ListGithubInstallationsResponse>("/connections/github/installations", { signal }),
    listGithubRepositories: (signal) =>
      request<ListGithubRepositoriesResponse>("/connections/github/repositories", { signal }),
    checkGithubRepositories: (repos) =>
      request<CheckGithubRepositoriesResponse>("/connections/github/repositories/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos }),
      }),
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
    connectStartUrl: (provider, workspaceId, returnTo) => {
      const query = new URLSearchParams();
      if (workspaceId !== undefined) query.set("workspaceId", workspaceId);
      if (returnTo !== undefined) query.set("returnTo", returnTo);
      const serialized = query.toString();
      return `${base}/connect/${encodeURIComponent(provider)}/start${
        serialized === "" ? "" : `?${serialized}`
      }`;
    },
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
    disconnectWorkspaceConnection: (workspaceId, connectionName) =>
      request<void>(
        `/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionName)}`,
        { method: "DELETE" },
      ),
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
