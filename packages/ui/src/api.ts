import type {
  ApiError,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  ListMachineTypesResponse,
  ListVolumesResponse,
  PollResponse,
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

export interface ControlPlaneClient {
  login(operatorKey: string): Promise<void>;
  logout(): Promise<void>;
  poll(signal?: AbortSignal): Promise<PollResponse>;
  create(input: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse>;
  destroy(id: string): Promise<CreateWorkspaceResponse>;
  listMachineTypes(): Promise<ListMachineTypesResponse>;
  listVolumes(): Promise<ListVolumesResponse>;
}

export function createControlPlaneClient(baseUrl = ""): ControlPlaneClient {
  const base = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, credentials: "include" });
    if (!response.ok) {
      let error: ApiError = { error: `Request failed (${response.status})`, retryAction: null };
      try {
        error = (await response.json()) as ApiError;
      } catch {
        // The status is still authoritative when an intermediary returns non-JSON.
      }
      throw new ApiRequestError(error.error, response.status, error.retryAction);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    login: (operatorKey) =>
      request<void>("/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${operatorKey}` },
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
  };
}
