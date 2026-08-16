import type {
  ApiError,
  ListCredentialLeasesResponse,
  ListCredentialRequestsResponse,
  ListIntegrationsResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  ListMachineTypesResponse,
  ListVolumesResponse,
  PollResponse,
  PutIntegrationRequest,
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
  type JsonValue,
  isNumber,
  isString,
} from "./type-guards.js";

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
    status: "invited" | "active" | "disabled";
  } | null;
  org: {
    id: string;
    slug: string;
    name: string;
    vmLimit: number;
  } | null;
}

export interface CreateOrgResponse {
  org: NonNullable<MeResponse["org"]>;
  membership: NonNullable<MeResponse["membership"]>;
}

export interface ControlPlaneClient {
  googleLoginUrl(): string;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  createOrg(name: string): Promise<CreateOrgResponse>;
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
  listMachineTypes(): Promise<ListMachineTypesResponse>;
  listVolumes(): Promise<ListVolumesResponse>;
  listIntegrations(signal?: AbortSignal): Promise<ListIntegrationsResponse>;
  putIntegration(name: string, input: PutIntegrationRequest): Promise<void>;
  deleteIntegration(name: string): Promise<void>;
  listLeases(workspaceId: string, signal?: AbortSignal): Promise<ListCredentialLeasesResponse>;
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
    if (response.status === 204) {
      // SAFETY: Callers are expected to request void for 204 endpoints, but the generic is not constrained here. TODO(deslop-tier-c): encode no-content endpoints so T must be void.
      return undefined as T;
    }
    if (decode !== undefined) return decode(await response.text());
    // SAFETY: Legacy endpoint JSON is delegated to caller-selected T without validation. TODO(deslop-tier-c): decode each remaining endpoint response into its declared domain type.
    return (await response.json()) as T;
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
        || (
          candidate.status !== "invited"
          && candidate.status !== "active"
          && candidate.status !== "disabled"
        )
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
      || (
        membership.status !== "invited"
        && membership.status !== "active"
        && membership.status !== "disabled"
      )
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

  return {
    googleLoginUrl: () => `${base}/auth/google/start`,
    logout: () => request<void>("/sessions", { method: "DELETE" }),
    me: () => request<MeResponse>("/me", {}, decodeMe),
    createOrg: (name) =>
      request<CreateOrgResponse>("/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }, decodeCreateOrg),
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
    listMachineTypes: () => request<ListMachineTypesResponse>("/machine-types"),
    listVolumes: () => request<ListVolumesResponse>("/volumes"),
    listIntegrations: (signal) =>
      request<ListIntegrationsResponse>("/integrations", { signal }),
    putIntegration: (name, input) =>
      request<void>(`/integrations/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    deleteIntegration: (name) =>
      request<void>(`/integrations/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    listLeases: (workspaceId, signal) =>
      request<ListCredentialLeasesResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/leases`,
        { signal },
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
