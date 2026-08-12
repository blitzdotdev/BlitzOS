import type { CreateVolumeRequest, MachineType, Volume } from "@blitzos/schema";
import { isRecord } from "../http.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "./types.js";

const API = "https://api.hetzner.cloud/v1";

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
  constructor(private readonly token: string) {}

  capabilities(): ProviderCapabilities {
    return { volumes: true };
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
    if (!response.ok) throw new Error(`Hetzner API request failed with status ${response.status}`);
    if (response.status === 204) return null;
    return response.json<unknown>();
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
    return types.flatMap((type) => {
      const locations = Array.isArray(type.locations)
        ? type.locations.filter(isRecord).filter((location) => location.available === true)
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
    };
    if (selected.location !== null) body.location = selected.location;
    const value = await this.request("/servers", { method: "POST", body: JSON.stringify(body) });
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
