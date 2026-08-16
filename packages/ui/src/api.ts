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

export interface ControlPlaneClient {
  login(operatorKey: string): Promise<void>;
  logout(): Promise<void>;
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

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    // SAFETY: Successful JSON is delegated to caller-selected T without validation. TODO(deslop-tier-c): decode each endpoint response into its declared domain type.
    return (await response.json()) as T;
  }

  return {
    login: (operatorKey) =>
      request<void>("/sessions", {
        method: "POST",
        headers: { "x-operator-key": operatorKey },
      }),
    logout: () => request<void>("/sessions", { method: "DELETE" }),
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
