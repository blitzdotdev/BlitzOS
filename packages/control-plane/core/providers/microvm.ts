import { first, transaction, type Db } from "../db.js";
import { bearerToken, safeEqualSecret } from "../crypto.js";
import { HttpError, isRecord, readJson } from "../http.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import type { MachineType } from "../wire.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  SurfacePort,
  VmInspection,
  VmProvider,
} from "./types.js";

const AGENT_JSON_MAX_BYTES = 64 * 1024;
const AGENT_REQUEST_TIMEOUT_MS = 75_000;
const HOST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOKEN_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const AGENT_VM_ID_PATTERN = /^[A-Za-z0-9-]+$/u;
const PROVIDER_ID_PREFIX = "microvm:v1:";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StaticMicrovmHostConfig {
  name: string;
  url: string;
  tokenVar: string;
}

export interface DynamicMicrovmHostConfig {
  name: string;
  tokenVar: string;
  dynamic: true;
}

export type MicrovmHostConfig =
  | StaticMicrovmHostConfig
  | DynamicMicrovmHostConfig;

type ResolvedMicrovmHost = MicrovmHostConfig & { token: string };

interface ActiveMicrovmHost {
  name: string;
  url: string;
  token: string;
}

export interface MicrovmMachineType {
  cpu: number;
  memGb: number;
  hostName: string;
}

export interface MicrovmPoolProviderOptions {
  fetcher?: Fetcher;
  db?: Db;
}

interface MicrovmHostRow {
  url: string | null;
  source: "static" | "registered" | null;
}

interface AgentCapacity {
  totalCpu: number;
  totalMemMb: number;
  usedCpu: number;
  usedMemMb: number;
  vmCount: number;
  maxVms: number;
}

interface AgentVm {
  vmId: string;
  hostIp: string;
  sshPort: number;
  status: "creating" | "running" | "deleting";
}

const RECOGNIZED_SIZES = Object.freeze([
  { cpu: 2, memGb: 2, diskGb: 8 },
  { cpu: 2, memGb: 4, diskGb: 8 },
] as const);

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
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
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
    typeof result !== "string" ||
    result.length === 0 ||
    result.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(result)
  ) {
    throw new Error(`invalid ${description} ${field}`);
  }
  return result;
}

function normalizedHostUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MICROVM_HOSTS url must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("MICROVM_HOSTS url must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

function normalizedRegisteredHostUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "url must be an HTTPS URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be an HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new HttpError(
      400,
      "url must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

function isDynamicHost(
  host: MicrovmHostConfig,
): host is DynamicMicrovmHostConfig {
  return "dynamic" in host && host.dynamic === true;
}

export function parseMicrovmHosts(value: unknown): MicrovmHostConfig[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error("MICROVM_HOSTS must be a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MICROVM_HOSTS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("MICROVM_HOSTS must be a JSON array");

  const names = new Set<string>();
  const urls = new Set<string>();
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`MICROVM_HOSTS[${index}] must be an object`);
    const dynamic = entry.dynamic === true;
    exactFields(
      entry,
      dynamic ? ["name", "tokenVar", "dynamic"] : ["name", "url", "tokenVar"],
      `MICROVM_HOSTS[${index}]`,
    );
    const name = entry.name;
    if (typeof name !== "string" || !HOST_NAME_PATTERN.test(name)) {
      throw new Error(`MICROVM_HOSTS[${index}].name is invalid`);
    }
    if (names.has(name)) throw new Error(`MICROVM_HOSTS contains duplicate name ${name}`);
    names.add(name);

    const tokenVar = entry.tokenVar;
    if (typeof tokenVar !== "string" || !TOKEN_VAR_PATTERN.test(tokenVar)) {
      throw new Error(`MICROVM_HOSTS[${index}].tokenVar is invalid`);
    }
    if (tokenVar === "MICROVM_HOSTS") {
      throw new Error(`MICROVM_HOSTS[${index}].tokenVar must name a secret binding`);
    }
    if (dynamic) return { name, tokenVar, dynamic: true };

    if (typeof entry.url !== "string") {
      throw new Error(`MICROVM_HOSTS[${index}].url must be a string`);
    }
    const url = normalizedHostUrl(entry.url);
    if (urls.has(url)) throw new Error(`MICROVM_HOSTS contains duplicate url ${url}`);
    urls.add(url);
    return { name, url, tokenVar };
  });
}

export function parseMicrovmMachineTypeId(value: string): MicrovmMachineType | null {
  const match = /^mv-([1-9]\d*)c([1-9]\d*)g@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u.exec(value);
  if (match === null) return null;
  const cpu = Number(match[1]);
  const memGb = Number(match[2]);
  if (!Number.isSafeInteger(cpu) || !Number.isSafeInteger(memGb) || !Number.isSafeInteger(memGb * 1_024)) {
    return null;
  }
  return { cpu, memGb, hostName: match[3] ?? "" };
}

function recognizedSize(cpu: number, memGb: number) {
  return RECOGNIZED_SIZES.find((size) => size.cpu === cpu && size.memGb === memGb);
}

function providerId(hostName: string, agentVmId: string): string {
  return `${PROVIDER_ID_PREFIX}${encodeURIComponent(hostName)}:${encodeURIComponent(agentVmId)}`;
}

function parseProviderId(value: string): { hostName: string; agentVmId: string } | null {
  if (!value.startsWith(PROVIDER_ID_PREFIX)) return null;
  const encoded = value.slice(PROVIDER_ID_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const hostName = decodeURIComponent(encoded.slice(0, separator));
    const agentVmId = decodeURIComponent(encoded.slice(separator + 1));
    if (!HOST_NAME_PATTERN.test(hostName) || !AGENT_VM_ID_PATTERN.test(agentVmId)) return null;
    return { hostName, agentVmId };
  } catch {
    return null;
  }
}

export function isMicrovmProviderId(value: string): boolean {
  return value.startsWith(PROVIDER_ID_PREFIX);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > AGENT_JSON_MAX_BYTES)
  ) {
    throw new Error("microVM agent response is too large");
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > AGENT_JSON_MAX_BYTES) {
      await reader.cancel();
      throw new Error("microVM agent response is too large");
    }
    chunks.push(result.value);
  }
  if (size === 0) return null;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("microVM agent returned invalid JSON");
  }
}

function agentError(value: unknown): string | null {
  if (!isRecord(value)) return null;
  try {
    exactFields(value, ["error"], "microVM agent error");
  } catch {
    return null;
  }
  if (typeof value.error !== "string") return null;
  const message = value.error.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return message === "" ? null : message.slice(0, 1_024);
}

function capacityFromAgent(value: unknown): AgentCapacity {
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
    capacity.usedCpu > capacity.totalCpu ||
    capacity.usedMemMb > capacity.totalMemMb ||
    capacity.vmCount > capacity.maxVms
  ) {
    throw new Error("invalid microVM agent capacity totals");
  }
  return capacity;
}

function createdVmFromAgent(value: unknown): { vmId: string; hostIp: string; sshPort: number } {
  if (!isRecord(value)) throw new Error("invalid microVM agent create response");
  exactFields(value, ["vm_id", "host_ip", "ssh_port"], "microVM agent create response");
  const vmId = requiredString(value, "vm_id", "microVM agent create response");
  if (!AGENT_VM_ID_PATTERN.test(vmId)) throw new Error("invalid microVM agent vm_id");
  return {
    vmId,
    hostIp: requiredString(value, "host_ip", "microVM agent create response"),
    sshPort: requiredInteger(value, "ssh_port", "microVM agent create response", 1, 65_535),
  };
}

function vmFromAgent(value: unknown): AgentVm {
  if (!isRecord(value)) throw new Error("invalid microVM agent VM response");
  const allowed = [
    "vm_id", "workspace_id", "slot", "cpu", "mem_mb", "host_ip", "guest_ip",
    "ssh_port", "status", "created_at",
  ];
  if ("pid" in value) allowed.push("pid");
  exactFields(value, allowed, "microVM agent VM response");
  const vmId = requiredString(value, "vm_id", "microVM agent VM response");
  if (!AGENT_VM_ID_PATTERN.test(vmId)) throw new Error("invalid microVM agent vm_id");
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

export class MicrovmPoolProvider implements VmProvider {
  private readonly hosts: ResolvedMicrovmHost[];
  private readonly hostsByName: ReadonlyMap<string, ResolvedMicrovmHost>;
  private readonly fetcher: Fetcher;
  private readonly db: Db | undefined;

  constructor(
    rawHosts: unknown,
    resolveToken: (tokenVar: string) => unknown,
    options: MicrovmPoolProviderOptions = {},
  ) {
    this.hosts = parseMicrovmHosts(rawHosts).map((host) => {
      const token = resolveToken(host.tokenVar);
      if (
        typeof token !== "string" ||
        token.length < 32 ||
        /\s/u.test(token)
      ) {
        throw new Error(`${host.tokenVar} does not resolve to a valid microVM host token secret`);
      }
      return { ...host, token };
    });
    this.hostsByName = new Map(this.hosts.map((host) => [host.name, host]));
    this.fetcher = options.fetcher ?? fetch;
    this.db = options.db;
  }

  capabilities(): ProviderCapabilities {
    return { volumes: false, maxUserDataBytes: null };
  }

  owns(id: string): boolean {
    return isMicrovmProviderId(id);
  }

  async syncStaticHosts(): Promise<void> {
    if (this.db === undefined) return;
    const now = Date.now();
    const upserts = this.hosts.flatMap((host) =>
      isDynamicHost(host)
        ? []
        : [{
            q: `INSERT INTO microvm_hosts (name, url, updated_at, source)
                VALUES (?1, ?2, ?3, 'static')
                ON CONFLICT(name) DO UPDATE SET
                  url = excluded.url,
                  updated_at = excluded.updated_at,
                  source = excluded.source
                WHERE microvm_hosts.url IS NOT excluded.url
                   OR microvm_hosts.source IS NOT excluded.source`,
            v: [host.name, host.url, now],
          }],
    );
    if (upserts.length > 0) await transaction(this.db, upserts);
  }

  async prepareHostRegistration(
    name: string,
    providedToken: string | null,
  ): Promise<(rawUrl: unknown) => Promise<void>> {
    const host = this.hostsByName.get(name);
    if (host === undefined) throw new HttpError(404, "microVM host not found");
    if (
      providedToken === null ||
      !(await safeEqualSecret(providedToken, host.token))
    ) {
      throw new HttpError(401, "unauthorized");
    }
    if (!isDynamicHost(host)) {
      throw new HttpError(409, "pinned microVM hosts cannot register");
    }
    return async (rawUrl: unknown) => {
      const url = normalizedRegisteredHostUrl(rawUrl);
      if (this.db === undefined) {
        throw new Error("microVM host registration database is unavailable");
      }
      const [previousRows] = await transaction<MicrovmHostRow>(this.db, [
        {
          q: "SELECT url, source FROM microvm_hosts WHERE name = ?1 LIMIT 1",
          v: [host.name],
        },
        {
          q: `INSERT INTO microvm_hosts (name, url, updated_at, source)
              VALUES (?1, ?2, ?3, 'registered')
              ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                updated_at = excluded.updated_at,
                source = excluded.source
              WHERE microvm_hosts.url IS NOT excluded.url
                 OR microvm_hosts.source IS NOT excluded.source`,
          v: [host.name, url, Date.now()],
        },
      ]);
      const previousUrl = previousRows?.[0]?.url ?? null;
      if (previousUrl !== url) {
        console.log(
          JSON.stringify({
            message: "microVM host URL changed",
            host: host.name,
            old_url: previousUrl,
            new_url: url,
          }),
        );
      }
    };
  }

  async registerHost(
    name: string,
    providedToken: string | null,
    rawUrl: unknown,
  ): Promise<void> {
    const register = await this.prepareHostRegistration(name, providedToken);
    await register(rawUrl);
  }

  private unavailableHost(host: ResolvedMicrovmHost): HttpError {
    return new HttpError(
      503,
      isDynamicHost(host)
        ? `dynamic microVM host ${host.name} is unavailable; waiting for registration`
        : `pinned microVM host ${host.name} is unavailable`,
    );
  }

  private async resolveHost(host: ResolvedMicrovmHost): Promise<ActiveMicrovmHost> {
    if (this.db === undefined) {
      if (isDynamicHost(host)) throw this.unavailableHost(host);
      return { name: host.name, url: host.url, token: host.token };
    }
    const expectedSource = isDynamicHost(host) ? "registered" : "static";
    const row = await first<MicrovmHostRow>(this.db, {
      q: `SELECT url, source FROM microvm_hosts
          WHERE name = ?1 AND source = ?2
          LIMIT 1`,
      v: [host.name, expectedSource],
    });
    if (row?.url === null || row?.url === undefined) {
      throw this.unavailableHost(host);
    }
    try {
      const url = isDynamicHost(host)
        ? normalizedRegisteredHostUrl(row.url)
        : normalizedHostUrl(row.url);
      return { name: host.name, url, token: host.token };
    } catch {
      throw this.unavailableHost(host);
    }
  }

  private async request(
    host: ResolvedMicrovmHost,
    path: string,
    init?: RequestInit,
    notFoundIsNull = false,
  ): Promise<unknown> {
    const activeHost = await this.resolveHost(host);
    const fetcher = this.fetcher;
    const response = await fetcher(`${activeHost.url}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${activeHost.token}`,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    if (response.status === 204) return null;
    const body = await readBoundedJson(response);
    if (response.status === 404 && notFoundIsNull) return null;
    if (!response.ok) {
      const message = agentError(body);
      throw new Error(message ?? `microVM agent request failed with status ${response.status}`);
    }
    return body;
  }

  private hostForMachineType(machineTypeId: string): {
    host: ResolvedMicrovmHost;
    machine: MicrovmMachineType;
  } {
    const machine = parseMicrovmMachineTypeId(machineTypeId);
    if (machine === null) throw new Error(`invalid microVM machine type ${machineTypeId}`);
    if (recognizedSize(machine.cpu, machine.memGb) === undefined) {
      throw new Error(`unsupported microVM machine size ${machine.cpu}c${machine.memGb}g`);
    }
    const host = this.hostsByName.get(machine.hostName);
    if (host === undefined) throw new Error(`unknown microVM host ${machine.hostName}`);
    return { host, machine };
  }

  private hostForProviderId(id: string): {
    host: ResolvedMicrovmHost;
    agentVmId: string;
  } {
    const parsed = parseProviderId(id);
    if (parsed === null) throw new Error("invalid microVM provider ID");
    const host = this.hostsByName.get(parsed.hostName);
    if (host === undefined) throw new Error(`unknown microVM host ${parsed.hostName}`);
    return { host, agentVmId: parsed.agentVmId };
  }

  async listMachineTypes(): Promise<MachineType[]> {
    const settled = await Promise.allSettled(
      this.hosts.map(async (host) => ({
        host,
        capacity: capacityFromAgent(await this.request(host, "/v1/capacity")),
      })),
    );
    const capacities = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    settled.forEach((result, index) => {
      if (result.status !== "rejected") return;
      console.warn(
        JSON.stringify({
          message: "microVM host capacity unavailable",
          host: this.hosts[index]?.name ?? "unknown",
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        }),
      );
    });
    if (capacities.length === 0) {
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    }
    return capacities.flatMap(({ host, capacity }) => {
      if (capacity.vmCount >= capacity.maxVms) return [];
      const freeCpu = capacity.totalCpu - capacity.usedCpu;
      const freeMemMb = capacity.totalMemMb - capacity.usedMemMb;
      return RECOGNIZED_SIZES.flatMap((size) => {
        if (size.cpu > freeCpu || size.memGb * 1_024 > freeMemMb) return [];
        return [{
          id: `mv-${size.cpu}c${size.memGb}g@${host.name}`,
          name: `MicroVM ${size.cpu} vCPU / ${size.memGb} GB`,
          cpuCores: size.cpu,
          memGb: size.memGb,
          diskGb: size.diskGb,
          arch: "x86",
          location: host.name,
        } satisfies MachineType];
      });
    });
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    const { host, machine } = this.hostForMachineType(input.machineTypeId);
    const value = await this.request(host, "/v1/vms", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: input.workspaceId,
        cpu: machine.cpu,
        mem_mb: machine.memGb * 1_024,
        ...(input.sshPublicKey === undefined || input.sshPublicKey.trim() === ""
          ? {}
          : { ssh_authorized_key: input.sshPublicKey }),
        phone_home_url: input.phoneHomeUrl,
        cp_origin: new URL(input.phoneHomeUrl).origin,
      }),
    });
    const vm = createdVmFromAgent(value);
    return {
      id: providerId(host.name, vm.vmId),
      host: vm.hostIp,
      port: vm.sshPort,
      user: "blitz",
    };
  }

  async shutdown(id: string): Promise<void> {
    await this.destroy(id);
  }

  async destroy(id: string): Promise<void> {
    const { host, agentVmId } = this.hostForProviderId(id);
    await this.request(
      host,
      `/v1/vms/${encodeURIComponent(agentVmId)}`,
      { method: "DELETE" },
      true,
    );
  }

  async inspect(id: string): Promise<VmInspection | null> {
    const { host, agentVmId } = this.hostForProviderId(id);
    const value = await this.request(host, "/v1/vms");
    if (!Array.isArray(value)) throw new Error("invalid microVM agent VM list response");
    const matches = value.map(vmFromAgent).filter((vm) => vm.vmId === agentVmId);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error("microVM agent returned duplicate VM IDs");
    const vm = matches[0];
    if (vm === undefined) return null;
    return {
      id,
      host: vm.hostIp,
      port: vm.sshPort,
      user: "blitz",
      state: vm.status === "running" ? "running" : "stopped",
    };
  }

  async proxySurface(
    id: string,
    port: SurfacePort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response | null> {
    if (!this.owns(id)) return null;
    const { host, agentVmId } = this.hostForProviderId(id);
    const activeHost = await this.resolveHost(host);
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    headers.delete("Host");
    headers.set("Authorization", `Bearer ${activeHost.token}`);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const fetcher = this.fetcher;
    return fetcher(
      `${activeHost.url}/vms/${encodeURIComponent(agentVmId)}/surface/${port}${pathAndQuery}`,
      {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
        signal: request.signal,
      },
    );
  }
}

export function addMicrovmHostRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.post("/hosts/:name/register", async (context: CoreContext) => {
    const runtime = runtimeFactory(context);
    const microvm = runtime.providers.microvm;
    if (microvm === undefined) throw new HttpError(404, "microVM host not found");
    const register = await microvm.prepareHostRegistration(
      context.req.param("name"),
      bearerToken(context.req.raw),
    );
    const body = await readJson(context.req.raw);
    if (!isRecord(body)) throw new HttpError(400, "request body must be an object");
    if (Object.keys(body).length !== 1 || !("url" in body)) {
      throw new HttpError(400, "request body must contain only url");
    }
    await register(body.url);
    return context.body(null, 204);
  });
}
