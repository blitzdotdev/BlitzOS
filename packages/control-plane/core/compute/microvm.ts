import type { Db } from "../db.js";
import { bearerToken } from "../crypto.js";
import { HttpError, isRecord, isString, readJson } from "../http.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { parseMicrovmHosts } from "./microvm-hosts.js";
import { type Fetcher } from "./json-fetch.js";
import {
  type ActiveMicrovmHost,
  type MicrovmMachineType,
  type ResolvedMicrovmHost,
  RECOGNIZED_MICROVM_SIZES,
  isMicrovmProviderId,
  microvmProviderId,
  parseMicrovmMachineTypeId,
  parseMicrovmProviderId,
  recognizedMicrovmSize,
} from "./microvm-config.js";
import {
  capacityFromAgent,
  createdVmFromAgent,
  MicrovmAgentClient,
  vmFromAgent,
  type CreateAgentVmBody,
} from "./microvm-agent.js";
import {
  prepareMicrovmHostRegistration,
  resolveMicrovmHost,
  syncStaticMicrovmHosts,
} from "./microvm-host-registry.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  ProviderCapabilities,
  WebAppPort,
  VmInspection,
  VmProvider,
} from "./types.js";

export type {
  DynamicMicrovmHostConfig,
  MicrovmHostConfig,
  MicrovmMachineType,
  StaticMicrovmHostConfig,
} from "./microvm-config.js";
export {
  isMicrovmProviderId,
  parseMicrovmMachineTypeId,
} from "./microvm-config.js";
export { parseMicrovmHosts } from "./microvm-hosts.js";

export interface MicrovmPoolProviderOptions {
  fetcher?: Fetcher;
  db?: Db;
}

interface MachineHostSelection {
  host: ResolvedMicrovmHost;
  machine: MicrovmMachineType;
}

interface ProviderHostSelection {
  host: ResolvedMicrovmHost;
  agentVmId: string;
}

export class MicrovmPoolProvider implements VmProvider {
  readonly id = "microvm";
  private readonly hosts: ResolvedMicrovmHost[];
  private readonly hostsByName: ReadonlyMap<string, ResolvedMicrovmHost>;
  private readonly fetcher: Fetcher;
  private readonly db: Db | undefined;
  private readonly agent: MicrovmAgentClient;

  constructor(
    rawHosts: unknown,
    resolveToken: (tokenVar: string) => unknown,
    options: MicrovmPoolProviderOptions = {},
  ) {
    this.hosts = parseMicrovmHosts(rawHosts).map((host) => {
      const token = resolveToken(host.tokenVar);
      if (
        !isString(token) ||
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
    this.agent = new MicrovmAgentClient(
      (host) => this.resolveHost(host),
      this.fetcher,
    );
  }

  capabilities(): ProviderCapabilities {
    // The microVM pool is not offered to users yet. It stays registered so the
    // VMs it already owns keep polling, stopping and destroying; only its
    // machine types leave the create page. Flip offersMachineTypes to true to
    // put them back — no deployment config changes with it.
    return {
      volumes: false,
      maxUserDataBytes: null,
      offersMachineTypes: false,
    };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return parseMicrovmMachineTypeId(machineTypeId) !== null;
  }

  ownsVmId(vmId: string): boolean {
    return isMicrovmProviderId(vmId);
  }

  owns(id: string): boolean {
    return this.ownsVmId(id);
  }

  async syncStaticHosts(): Promise<void> {
    await syncStaticMicrovmHosts(this.db, this.hosts);
  }

  async prepareHostRegistration(
    name: string,
    providedToken: string | null,
  ) {
    return prepareMicrovmHostRegistration(this.hostsByName, this.db, name, providedToken);
  }

  async registerHost(
    name: string,
    providedToken: string | null,
    rawUrl: unknown,
  ): Promise<void> {
    const register = await this.prepareHostRegistration(name, providedToken);
    await register(rawUrl);
  }

  private async resolveHost(host: ResolvedMicrovmHost): Promise<ActiveMicrovmHost> {
    return resolveMicrovmHost(this.db, host);
  }

  private hostForMachineType(machineTypeId: string): MachineHostSelection {
    const machine = parseMicrovmMachineTypeId(machineTypeId);
    if (machine === null) throw new Error(`invalid microVM machine type ${machineTypeId}`);
    if (recognizedMicrovmSize(machine.cpu, machine.memGb) === undefined) {
      throw new Error(`unsupported microVM machine size ${machine.cpu}c${machine.memGb}g`);
    }
    const host = this.hostsByName.get(machine.hostName);
    if (host === undefined) throw new Error(`unknown microVM host ${machine.hostName}`);
    return { host, machine };
  }

  private hostForProviderId(id: string): ProviderHostSelection {
    const parsed = parseMicrovmProviderId(id);
    if (parsed === null) throw new Error("invalid microVM provider ID");
    const host = this.hostsByName.get(parsed.hostName);
    if (host === undefined) throw new Error(`unknown microVM host ${parsed.hostName}`);
    return { host, agentVmId: parsed.agentVmId };
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    const settled = await Promise.allSettled(
      this.hosts.map(async (host) => ({
        host,
        capacity: capacityFromAgent(await this.agent.request(host, "/v1/capacity")),
      })),
    );
    const capacities = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    settled.forEach((result, index) => {
      if (result.status !== "rejected") return;
      // TODO(house-canon): Route structured core logs through the canonical logger.
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
      return RECOGNIZED_MICROVM_SIZES.flatMap((size) => {
        if (size.cpu > freeCpu || size.memGb * 1_024 > freeMemMb) return [];
        return [{
          id: `mv-${size.cpu}c${size.memGb}g@${host.name}`,
          name: `MicroVM ${size.cpu} vCPU / ${size.memGb} GB`,
          cpuCores: size.cpu,
          memGb: size.memGb,
          diskGb: size.diskGb,
          arch: "x86",
          location: host.name,
          // The pool runs on hardware the operator already owns and no vendor
          // sells these by the month. So the pool declares no price.
          monthlyPrice: null,
        } satisfies ProviderMachineType];
      });
    });
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    const { host, machine } = this.hostForMachineType(input.machineTypeId);
    const body: CreateAgentVmBody = {
      // The host keys its guest on this id and it must be unique per VM. A
      // workspace holds one VM per member now, so the MACHINE id goes here;
      // the field keeps its wire name because the host protocol has no
      // fixtures yet and renaming it would be a silent break.
      workspace_id: input.machineId,
      cpu: machine.cpu,
      mem_mb: machine.memGb * 1_024,
    };
    if (input.sshPublicKey !== undefined && input.sshPublicKey.trim() !== "") {
      body.ssh_authorized_key = input.sshPublicKey;
    }
    body.phone_home_url = input.phoneHomeUrl;
    body.cp_origin = new URL(input.phoneHomeUrl).origin;
    const value = await this.agent.request(host, "/v1/vms", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const vm = createdVmFromAgent(value);
    return {
      id: microvmProviderId(host.name, vm.vmId),
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
    await this.agent.request(
      host,
      `/v1/vms/${encodeURIComponent(agentVmId)}`,
      { method: "DELETE" },
      true,
    );
  }

  async inspect(id: string): Promise<VmInspection | null> {
    const { host, agentVmId } = this.hostForProviderId(id);
    const value = await this.agent.request(host, "/v1/vms");
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

  async proxyWebApp(
    id: string,
    port: WebAppPort,
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
      `${activeHost.url}/vms/${encodeURIComponent(agentVmId)}/webapp/${port}${pathAndQuery}`,
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
