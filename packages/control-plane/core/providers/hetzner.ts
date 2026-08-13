import { isRecord } from "../http.js";
import type { CreateVolumeRequest, MachineType, Volume } from "../wire.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "./types.js";

const API = "https://api.hetzner.cloud/v1";
export const HETZNER_USER_DATA_MAX_BYTES = 32 * 1024;
const SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 45_000;

export interface HetznerProviderOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortReason: Error,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortReason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function records(value: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    throw new Error(`invalid Hetzner ${field} response`);
  }
  return value[field].filter(isRecord);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`invalid Hetzner ${field}`);
  return result;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number") throw new Error(`invalid Hetzner ${field}`);
  return result;
}

function isDeprecated(value: Record<string, unknown>): boolean {
  return value.deprecated === true || isRecord(value.deprecation);
}

function hetznerErrorMessage(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") {
    return null;
  }
  const message = value.error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return message === "" ? null : message.slice(0, 1_024);
}

function annotateServerTypeIds(
  message: string,
  names: ReadonlyMap<number, string>,
): string {
  return message.replace(/\bserver type (\d+)\b/giu, (match, rawId: string) => {
    const name = names.get(Number(rawId));
    return name === undefined ? match : `${match} (${name})`;
  });
}

function serverTypeIds(message: string): number[] {
  const ids = [...message.matchAll(/\bserver type (\d+)\b/giu)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, 8);
}

function machineId(value: string): { type: string; location: string | null } {
  const separator = value.lastIndexOf("@");
  if (separator === -1) return { type: value, location: null };
  return { type: value.slice(0, separator), location: value.slice(separator + 1) };
}

function volumeFromHetzner(value: Record<string, unknown>): Volume {
  const server = value.server;
  return {
    id: String(numberField(value, "id")),
    name: stringField(value, "name"),
    sizeGb: numberField(value, "size"),
    location: isRecord(value.location) ? stringField(value.location, "name") : "",
    status: typeof server === "number" ? "attached" : "available",
    attachedTo: typeof server === "number" ? String(server) : null,
  };
}

export class HetznerProvider implements VmProvider, VolumeProvider {
  private readonly serverTypeNames = new Map<number, string>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly token: string,
    options: HetznerProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  capabilities(): ProviderCapabilities {
    return { volumes: true, maxUserDataBytes: HETZNER_USER_DATA_MAX_BYTES };
  }

  private async request(
    path: string,
    init?: RequestInit,
    notFoundIsNull = false,
  ): Promise<unknown> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    if (response.status === 404 && notFoundIsNull) return null;
    if (!response.ok) {
      let message: string | null = null;
      try {
        message = hetznerErrorMessage(await response.json<unknown>());
      } catch {
        // Fall back to the status-only error below for malformed provider responses.
      }
      if (message === null) {
        throw new Error(`Hetzner API request failed with status ${response.status}`);
      }
      await this.resolveServerTypeNames(message);
      throw new Error(annotateServerTypeIds(message, this.serverTypeNames));
    }
    if (response.status === 204) return null;
    return response.json<unknown>();
  }

  private async resolveServerTypeNames(message: string): Promise<void> {
    await Promise.all(
      serverTypeIds(message).map(async (id) => {
        if (this.serverTypeNames.has(id)) return;
        try {
          const response = await fetch(`${API}/server_types/${id}`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (!response.ok) return;
          const value = await response.json<unknown>();
          if (!isRecord(value) || !isRecord(value.server_type)) return;
          const responseId = value.server_type.id;
          const name = value.server_type.name;
          if (
            responseId === id &&
            typeof name === "string" &&
            /^[a-z0-9-]{1,128}$/iu.test(name)
          ) {
            this.serverTypeNames.set(id, name);
          }
        } catch {
          // Preserve the original provider error if the best-effort lookup fails.
        }
      }),
    );
  }

  private async list(path: string, field: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
      const value = await this.request(`${path}?per_page=50&page=${page}`);
      result.push(...records(value, field));
      const nextPage =
        isRecord(value) &&
        isRecord(value.meta) &&
        isRecord(value.meta.pagination) &&
        typeof value.meta.pagination.next_page === "number"
          ? value.meta.pagination.next_page
          : null;
      if (nextPage === null) return result;
      page = nextPage;
    }
  }

  async listMachineTypes(): Promise<MachineType[]> {
    const types = await this.list("/server_types", "server_types");
    for (const type of types) {
      const id = type.id;
      const name = type.name;
      if (typeof id === "number" && Number.isSafeInteger(id) && typeof name === "string") {
        this.serverTypeNames.set(id, name);
      }
    }
    return types.flatMap((type) => {
      if (isDeprecated(type)) return [];
      const locations = Array.isArray(type.locations)
        ? type.locations
            .filter(isRecord)
            .filter((location) => location.available === true && !isDeprecated(location))
        : [];
      return locations.map((location) => {
        const name = stringField(type, "name");
        const architecture = type.architecture;
        const locationName = stringField(location, "name");
        return {
          id: `${name}@${locationName}`,
          name,
          cpuCores: numberField(type, "cores"),
          memGb: numberField(type, "memory"),
          diskGb: numberField(type, "disk"),
          arch: architecture === "arm" ? "arm64" : "x86",
          location: locationName,
        } satisfies MachineType;
      });
    });
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    const selected = machineId(input.machineTypeId);
    const body: Record<string, unknown> = {
      name: `blitz-${input.workspaceId.slice(0, 12)}`,
      server_type: selected.type,
      image: "ubuntu-24.04",
      user_data: input.userData,
      labels: {
        "blitz-workspace": input.workspaceId,
        "blitz-purpose": "workspace",
      },
    };
    if (selected.location !== null) body.location = selected.location;
    const value = await this.request("/servers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!isRecord(value) || !isRecord(value.server)) throw new Error("invalid Hetzner server response");
    const server = value.server;
    const ipv4 =
      isRecord(server.public_net) &&
      isRecord(server.public_net.ipv4) &&
      typeof server.public_net.ipv4.ip === "string"
        ? server.public_net.ipv4.ip
        : null;
    if (ipv4 === null) throw new Error("Hetzner server has no public IPv4 address");
    return { id: String(numberField(server, "id")), host: ipv4, port: 22, user: "blitz" };
  }

  async shutdown(id: string): Promise<void> {
    const encodedId = encodeURIComponent(id);
    const deadline = this.now() + SHUTDOWN_TIMEOUT_MS;
    const deadlineError = new Error("Hetzner graceful shutdown deadline exceeded");
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, SHUTDOWN_TIMEOUT_MS);
    const { signal } = controller;

    try {
      const action = await abortable(
        this.request(
          `/servers/${encodedId}/actions/shutdown`,
          { method: "POST", body: "{}", signal },
          true,
        ),
        signal,
        deadlineError,
      );
      if (action === null) return;

      while (this.now() < deadline) {
        const value = await abortable(
          this.request(`/servers/${encodedId}`, { signal }, true),
          signal,
          deadlineError,
        );
        if (value === null) return;
        if (!isRecord(value) || !isRecord(value.server)) {
          throw new Error("invalid Hetzner server response");
        }
        if (stringField(value.server, "status") === "off") return;
        const remaining = deadline - this.now();
        if (remaining > 0) {
          await abortable(
            this.sleep(Math.min(SHUTDOWN_POLL_INTERVAL_MS, remaining)),
            signal,
            deadlineError,
          );
        }
      }
    } catch (error) {
      if (error !== deadlineError) throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async destroy(id: string): Promise<void> {
    await this.request(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
  }

  async inspect(id: string): Promise<VmInspection | null> {
    const value = await this.request(`/servers/${encodeURIComponent(id)}`, undefined, true);
    if (value === null) return null;
    if (!isRecord(value) || !isRecord(value.server)) throw new Error("invalid Hetzner server response");
    const server = value.server;
    const ipv4 =
      isRecord(server.public_net) &&
      isRecord(server.public_net.ipv4) &&
      typeof server.public_net.ipv4.ip === "string"
        ? server.public_net.ipv4.ip
        : null;
    if (ipv4 === null) throw new Error("Hetzner server has no public IPv4 address");
    return {
      id: String(numberField(server, "id")),
      host: ipv4,
      port: 22,
      user: "blitz",
      state: server.status === "running" ? "running" : "stopped",
    };
  }

  async createVolume(input: CreateVolumeRequest): Promise<Volume> {
    const value = await this.request("/volumes", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        size: input.sizeGb,
        location: input.location,
        format: "ext4",
      }),
    });
    if (!isRecord(value) || !isRecord(value.volume)) throw new Error("invalid Hetzner volume response");
    return volumeFromHetzner(value.volume);
  }

  async attachVolume(volumeId: string, vmId: string): Promise<void> {
    const server = Number(vmId);
    if (!Number.isSafeInteger(server)) throw new Error("invalid Hetzner server ID");
    await this.request(`/volumes/${encodeURIComponent(volumeId)}/actions/attach`, {
      method: "POST",
      body: JSON.stringify({ server, automount: true }),
    });
  }

  async detachVolume(volumeId: string, vmId: string): Promise<void> {
    const value = await this.request(`/volumes/${encodeURIComponent(volumeId)}`, undefined, true);
    if (value === null) return;
    if (!isRecord(value) || !isRecord(value.volume)) throw new Error("invalid Hetzner volume response");
    if (value.volume.server !== Number(vmId)) return;
    await this.request(`/volumes/${encodeURIComponent(volumeId)}/actions/detach`, {
      method: "POST",
      body: "{}",
    });
  }

  async deleteVolume(id: string): Promise<void> {
    await this.request(`/volumes/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
  }

  async listVolumes(): Promise<Volume[]> {
    return (await this.list("/volumes", "volumes")).map(volumeFromHetzner);
  }
}
