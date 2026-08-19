import { isNumber, isRecord, isString } from "../http.js";
import { fetchBoundedJson, type Fetcher } from "./json-fetch.js";
import {
  type ActiveMicrovmHost,
  type ResolvedMicrovmHost,
  validMicrovmAgentVmId,
} from "./microvm-config.js";

export interface AgentCapacity {
  totalCpu: number;
  totalMemMb: number;
  usedCpu: number;
  usedMemMb: number;
  vmCount: number;
  maxVms: number;
}

export interface AgentVm {
  vmId: string;
  hostIp: string;
  sshPort: number;
  status: "creating" | "running" | "deleting";
}

export interface CreatedAgentVm {
  vmId: string;
  hostIp: string;
  sshPort: number;
}

type AgentRequestHeaders = {
  Authorization: string;
  "Content-Type"?: "application/json";
};

export interface CreateAgentVmBody {
  workspace_id: string;
  cpu: number;
  mem_mb: number;
  ssh_authorized_key?: string;
  phone_home_url?: string;
  cp_origin?: string;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`invalid ${description} fields`);
  }
}

function requiredInteger(
  value: Record<string, unknown>,
  field: string,
  description: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = value[field];
  if (
    !isNumber(result)
    || !Number.isSafeInteger(result)
    || result < minimum
    || result > maximum
  ) {
    throw new Error(`invalid ${description} ${field}`);
  }
  return result;
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  description: string,
): string {
  const result = value[field];
  if (
    !isString(result)
    || result.length === 0
    || result.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(result)
  ) {
    throw new Error(`invalid ${description} ${field}`);
  }
  return result;
}

function agentError(value: unknown): string | null {
  if (!isRecord(value)) return null;
  try {
    exactFields(value, ["error"], "microVM agent error");
  } catch {
    return null;
  }
  if (!isString(value.error)) return null;
  const message = value.error.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return message === "" ? null : message.slice(0, 1_024);
}

export function capacityFromAgent(value: unknown): AgentCapacity {
  if (!isRecord(value)) throw new Error("invalid microVM agent capacity response");
  const hasCpuCapacityDetails = "physical_cpu" in value || "effective_cpu" in value;
  exactFields(
    value,
    hasCpuCapacityDetails
      ? [
          "total_cpu",
          "physical_cpu",
          "effective_cpu",
          "total_mem_mb",
          "used_cpu",
          "used_mem_mb",
          "vm_count",
          "max_vms",
        ]
      : ["total_cpu", "total_mem_mb", "used_cpu", "used_mem_mb", "vm_count", "max_vms"],
    "microVM agent capacity response",
  );
  const capacity = {
    totalCpu: requiredInteger(value, "total_cpu", "microVM agent capacity", 1),
    totalMemMb: requiredInteger(value, "total_mem_mb", "microVM agent capacity", 1),
    usedCpu: requiredInteger(value, "used_cpu", "microVM agent capacity"),
    usedMemMb: requiredInteger(value, "used_mem_mb", "microVM agent capacity"),
    vmCount: requiredInteger(value, "vm_count", "microVM agent capacity"),
    maxVms: requiredInteger(value, "max_vms", "microVM agent capacity", 1),
  };
  if (hasCpuCapacityDetails) {
    const physicalCpu = requiredInteger(value, "physical_cpu", "microVM agent capacity", 1);
    const effectiveCpu = requiredInteger(value, "effective_cpu", "microVM agent capacity", 1);
    if (capacity.totalCpu !== effectiveCpu || physicalCpu > effectiveCpu) {
      throw new Error("invalid microVM agent capacity CPU totals");
    }
  }
  if (
    capacity.usedCpu > capacity.totalCpu
    || capacity.usedMemMb > capacity.totalMemMb
    || capacity.vmCount > capacity.maxVms
  ) {
    throw new Error("invalid microVM agent capacity totals");
  }
  return capacity;
}

export function createdVmFromAgent(value: unknown): CreatedAgentVm {
  if (!isRecord(value)) throw new Error("invalid microVM agent create response");
  exactFields(value, ["vm_id", "host_ip", "ssh_port"], "microVM agent create response");
  const vmId = requiredString(value, "vm_id", "microVM agent create response");
  if (!validMicrovmAgentVmId(vmId)) throw new Error("invalid microVM agent vm_id");
  return {
    vmId,
    hostIp: requiredString(value, "host_ip", "microVM agent create response"),
    sshPort: requiredInteger(value, "ssh_port", "microVM agent create response", 1, 65_535),
  };
}

export function vmFromAgent(value: unknown): AgentVm {
  if (!isRecord(value)) throw new Error("invalid microVM agent VM response");
  const allowed = [
    "vm_id", "workspace_id", "slot", "cpu", "mem_mb", "host_ip", "guest_ip",
    "ssh_port", "status", "created_at",
  ];
  if ("pid" in value) allowed.push("pid");
  exactFields(value, allowed, "microVM agent VM response");
  const vmId = requiredString(value, "vm_id", "microVM agent VM response");
  if (!validMicrovmAgentVmId(vmId)) throw new Error("invalid microVM agent vm_id");
  requiredString(value, "workspace_id", "microVM agent VM response");
  requiredInteger(value, "slot", "microVM agent VM response", 1);
  requiredInteger(value, "cpu", "microVM agent VM response", 1);
  requiredInteger(value, "mem_mb", "microVM agent VM response", 128);
  requiredString(value, "guest_ip", "microVM agent VM response");
  requiredString(value, "created_at", "microVM agent VM response");
  if ("pid" in value) requiredInteger(value, "pid", "microVM agent VM response", 1);
  if (value.status !== "creating" && value.status !== "running" && value.status !== "deleting") {
    throw new Error("invalid microVM agent VM response status");
  }
  return {
    vmId,
    hostIp: requiredString(value, "host_ip", "microVM agent VM response"),
    sshPort: requiredInteger(value, "ssh_port", "microVM agent VM response", 1, 65_535),
    status: value.status,
  };
}

export class MicrovmAgentClient {
  constructor(
    private readonly resolveHost: (
      host: ResolvedMicrovmHost,
    ) => Promise<ActiveMicrovmHost>,
    private readonly fetcher: Fetcher,
  ) {}

  async request(
    host: ResolvedMicrovmHost,
    path: string,
    init?: RequestInit,
    notFoundIsNull = false,
  ): Promise<unknown> {
    const activeHost = await this.resolveHost(host);
    const headers: AgentRequestHeaders = {
      Authorization: `Bearer ${activeHost.token}`,
    };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const { response, body } = await fetchBoundedJson(this.fetcher, `${activeHost.url}${path}`, {
      ...init,
      headers,
    }, {
      responseLabel: "microVM agent",
      bodyDisposition: (candidate) => candidate.status === 204 ? "omit" : "read",
      invalidJsonDisposition: () => "provider-error",
    });
    if (response.status === 204) return null;
    if (response.status === 404 && notFoundIsNull) return null;
    if (!response.ok) {
      const message = agentError(body);
      throw new Error(message ?? `microVM agent request failed with status ${response.status}`);
    }
    return body;
  }
}
