import type { MachineType, WorkspaceView } from "@blitzos/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompositeVmProvider } from "../core/providers/composite.js";
import {
  MicrovmPoolProvider,
  parseMicrovmHosts,
  parseMicrovmMachineTypeId,
} from "../core/providers/microvm.js";
import type {
  CreatedVm,
  CreateVmInput,
  VmInspection,
  VmProvider,
} from "../core/providers/types.js";
import {
  FakeProviders,
  appRequest,
  appWithProviders,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

const LAB_TOKEN = "lab-token-01234567890123456789012";
const EDGE_TOKEN = "edge-token-0123456789012345678901";
const SSH_KEY = "ssh-ed25519 AAAAC3Nzatest caller";
const PHONE_HOME_URL = "https://cp.example/workspaces/workspace-id/phone-home/capability";

function hosts(...entries: Array<{ name: string; url: string; tokenVar: string }>): string {
  return JSON.stringify(entries);
}

function provider(
  rawHosts: unknown,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  secrets: Record<string, unknown> = {
    MICROVM_LAB_TOKEN: LAB_TOKEN,
    MICROVM_EDGE_TOKEN: EDGE_TOKEN,
  },
): MicrovmPoolProvider {
  return new MicrovmPoolProvider(
    rawHosts,
    (tokenVar) => Reflect.get(secrets, tokenVar),
    { fetcher },
  );
}

function createInput(machineTypeId: string): CreateVmInput {
  return {
    workspaceId: "workspace-id",
    machineTypeId,
    sshPublicKey: SSH_KEY,
    phoneHomeUrl: PHONE_HOME_URL,
    userData: "generated Hetzner bootstrap is intentionally not forwarded",
  };
}

function capacity(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    total_cpu: 8,
    total_mem_mb: 8_192,
    used_cpu: 0,
    used_mem_mb: 0,
    vm_count: 0,
    max_vms: 4,
    ...overrides,
  };
}

function agentVm(vmId = "vm-1-abcdef123456") {
  return {
    vm_id: vmId,
    workspace_id: "workspace-id",
    slot: 1,
    cpu: 2,
    mem_mb: 2_048,
    host_ip: "192.0.2.10",
    guest_ip: "172.30.21.2",
    ssh_port: 22_001,
    pid: 1234,
    status: "running",
    created_at: "2026-08-13T12:00:00Z",
  };
}

class RecordingVmProvider implements VmProvider {
  readonly calls: string[] = [];

  capabilities() {
    return { volumes: true, maxUserDataBytes: 32 * 1_024 };
  }

  async listMachineTypes(): Promise<MachineType[]> {
    this.calls.push("list");
    return [{
      id: "cx23@fsn1",
      name: "cx23",
      cpuCores: 2,
      memGb: 4,
      diskGb: 40,
      arch: "x86",
      location: "fsn1",
    }];
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    this.calls.push(`create:${input.machineTypeId}`);
    return { id: "42", host: "203.0.113.42", port: 22, user: "blitz" };
  }

  async shutdown(id: string): Promise<void> {
    this.calls.push(`shutdown:${id}`);
  }

  async destroy(id: string): Promise<void> {
    this.calls.push(`destroy:${id}`);
  }

  async inspect(id: string): Promise<VmInspection | null> {
    this.calls.push(`inspect:${id}`);
    return { id, host: "203.0.113.42", port: 22, user: "blitz", state: "running" };
  }
}

describe("microVM pool provider", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("parses general mv-<cpu>c<memGb>g@<host> machine IDs and rejects malformed IDs", () => {
    expect(parseMicrovmMachineTypeId("mv-2c2g@lab")).toEqual({
      cpu: 2,
      memGb: 2,
      hostName: "lab",
    });
    expect(parseMicrovmMachineTypeId("mv-16c64g@west-2")).toEqual({
      cpu: 16,
      memGb: 64,
      hostName: "west-2",
    });
    for (const invalid of [
      "mv-0c2g@lab",
      "mv-2c0g@lab",
      "mv-02c2g@lab",
      "mv-2c2g@Lab",
      "mv-2c2g@lab/other",
      "cx23@fsn1",
    ]) {
      expect(parseMicrovmMachineTypeId(invalid), invalid).toBeNull();
    }
  });

  it("rejects invalid MICROVM_HOSTS names, URLs, fields, duplicates, tokenVar, and unresolved tokens without exposing secrets", () => {
    const valid = { name: "lab", url: "http://192.0.2.10:8086", tokenVar: "MICROVM_LAB_TOKEN" };
    expect(parseMicrovmHosts(hosts(valid))).toEqual([valid]);

    const invalidConfigs: Array<[string, unknown]> = [
      ["JSON", "not-json"],
      ["array", "{}"],
      ["name", hosts({ ...valid, name: "Lab" })],
      ["URL", hosts({ ...valid, url: "file:///tmp/agent" })],
      ["credentials", hosts({ ...valid, url: "https://user:pass@example.com" })],
      ["fields", JSON.stringify([{ ...valid, token: "embedded-secret" }])],
      ["duplicate name", hosts(valid, { ...valid, url: "https://second.example" })],
      ["duplicate url", hosts(valid, { ...valid, name: "second" })],
      ["tokenVar", hosts({ ...valid, tokenVar: "lowercase-token" })],
      ["nonsecret tokenVar", hosts({ ...valid, tokenVar: "MICROVM_HOSTS" })],
    ];
    for (const [description, raw] of invalidConfigs) {
      expect(() => parseMicrovmHosts(raw), description).toThrow();
    }

    expect(() =>
      provider(hosts(valid), async () => Response.json({}), {}),
    ).toThrow("MICROVM_LAB_TOKEN does not resolve");
    const secretValue = "do-not-print-this-secret value";
    expect(() =>
      provider(hosts(valid), async () => Response.json({}), {
        MICROVM_LAB_TOKEN: secretValue,
      }),
    ).toThrowError(expect.not.stringContaining(secretValue));
  });

  it("lists only recognized sizes fitting each live authenticated host capacity", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({
        Authorization: url.includes("edge.example") ? `Bearer ${EDGE_TOKEN}` : `Bearer ${LAB_TOKEN}`,
      });
      if (url === "https://lab.example/v1/capacity") {
        return Response.json(capacity({ used_cpu: 4, used_mem_mb: 2_048 }));
      }
      if (url === "https://edge.example/base/v1/capacity") {
        return Response.json(capacity({
          total_cpu: 4,
          total_mem_mb: 4_096,
          used_cpu: 2,
          used_mem_mb: 1_024,
        }));
      }
      if (url === "https://full.example/v1/capacity") {
        return Response.json(capacity({ vm_count: 4 }));
      }
      throw new Error(`unexpected request ${url}`);
    });
    const microvm = provider(
      hosts(
        { name: "lab", url: "https://lab.example/", tokenVar: "MICROVM_LAB_TOKEN" },
        { name: "edge", url: "https://edge.example/base/", tokenVar: "MICROVM_EDGE_TOKEN" },
        { name: "full", url: "https://full.example", tokenVar: "MICROVM_LAB_TOKEN" },
      ),
      fetcher,
    );

    expect(await microvm.listMachineTypes()).toEqual([
      {
        id: "mv-2c2g@lab",
        name: "MicroVM 2 vCPU / 2 GB",
        cpuCores: 2,
        memGb: 2,
        diskGb: 8,
        arch: "x86",
        location: "lab",
      },
      {
        id: "mv-2c4g@lab",
        name: "MicroVM 2 vCPU / 4 GB",
        cpuCores: 2,
        memGb: 4,
        diskGb: 8,
        arch: "x86",
        location: "lab",
      },
      {
        id: "mv-2c2g@edge",
        name: "MicroVM 2 vCPU / 2 GB",
        cpuCores: 2,
        memGb: 2,
        diskGb: 8,
        arch: "x86",
        location: "edge",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("invokes a stored fetcher without a receiver", async () => {
    let observedThis: unknown = "not called";
    async function fetcher(this: unknown): Promise<Response> {
      observedThis = this;
      return Response.json(capacity());
    }
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );

    await expect(microvm.listMachineTypes()).resolves.toHaveLength(2);
    expect(observedThis).toBeUndefined();
  });

  it("rejects agent capacity errors, malformed fields, and oversized JSON before buffering", async () => {
    const raw = hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" });
    const errorProvider = provider(raw, async () =>
      Response.json({ error: "host is draining" }, { status: 503 }),
    );
    await expect(errorProvider.listMachineTypes()).rejects.toThrow(/^host is draining$/u);

    const malformedProvider = provider(raw, async () =>
      Response.json({ ...capacity(), unexpected: true }),
    );
    await expect(malformedProvider.listMachineTypes()).rejects.toThrow(
      "invalid microVM agent capacity response fields",
    );

    const oversizedProvider = provider(raw, async () =>
      new Response("{}", { headers: { "Content-Length": "65537" } }),
    );
    await expect(oversizedProvider.listMachineTypes()).rejects.toThrow(
      "microVM agent response is too large",
    );
  });

  it("sends the exact agent create payload and maps its response to an encoded provider identity and blitz SSH", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${LAB_TOKEN}`,
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        workspace_id: "workspace-id",
        cpu: 2,
        mem_mb: 2_048,
        ssh_authorized_key: SSH_KEY,
        phone_home_url: PHONE_HOME_URL,
        cp_origin: "https://cp.example",
      });
      return Response.json({
        vm_id: "vm-1-abcdef123456",
        host_ip: "192.0.2.10",
        ssh_port: 22_001,
      }, { status: 201 });
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example/", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );

    const created = await microvm.createVm(createInput("mv-2c2g@lab"));

    expect(created).toEqual({
      id: "microvm:v1:lab:vm-1-abcdef123456",
      host: "192.0.2.10",
      port: 22_001,
      user: "blitz",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://lab.example/v1/vms");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toHaveProperty("cp_origin", new URL(PHONE_HOME_URL).origin);

    const invalidPortProvider = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      async () => Response.json({
        vm_id: "vm-1-abcdef123456",
        host_ip: "192.0.2.10",
        ssh_port: 65_536,
      }, { status: 201 }),
    );
    await expect(
      invalidPortProvider.createVm(createInput("mv-2c2g@lab")),
    ).rejects.toThrow("invalid microVM agent create response ssh_port");
  });

  it("inspects, gracefully shuts down, and idempotently destroys through the encoded host identity", async () => {
    let listCalls = 0;
    let deleteCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/vms") && init?.method === "POST") {
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      }
      if (url.endsWith("/v1/vms") && init?.method === undefined) {
        listCalls += 1;
        return Response.json(listCalls === 1 ? [agentVm()] : []);
      }
      if (url.endsWith("/v1/vms/vm-1-abcdef123456") && init?.method === "DELETE") {
        deleteCalls += 1;
        return deleteCalls === 1
          ? new Response(null, { status: 204 })
          : Response.json({ error: "not found" }, { status: 404 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );
    const created = await microvm.createVm(createInput("mv-2c4g@lab"));

    await expect(microvm.inspect(created.id)).resolves.toEqual({
      ...created,
      state: "running",
    });
    await expect(microvm.shutdown(created.id)).resolves.toBeUndefined();
    await expect(microvm.destroy(created.id)).resolves.toBeUndefined();
    await expect(microvm.inspect(created.id)).resolves.toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });

  it("surfaces an agent create message through the control plane with the exact provider error prefix", async () => {
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      async () => Response.json({ error: "insufficient microVM capacity" }, { status: 409 }),
    );
    const app = appWithProviders(microvm, new FakeProviders());
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "mv-2c2g@lab",
        sshPublicKey: SSH_KEY,
      }),
    });
    const body = await response.json<{ workspace: WorkspaceView }>();

    expect(response.status).toBe(201);
    expect(body.workspace.phase).toBe("error");
    expect(body.workspace.error).toBe(
      "provider operation failed: insufficient microVM capacity",
    );
  });

  it("accepts the guest enrollment contract and publishes the lab SSH endpoint", async () => {
    let callback = "";
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { phone_home_url?: unknown };
        if (typeof request.phone_home_url !== "string") {
          throw new Error("create request omitted phone_home_url");
        }
        callback = request.phone_home_url;
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.168.5.25",
          ssh_port: 22_001,
        }, { status: 201 });
      },
    );
    const app = appWithProviders(microvm, new FakeProviders());
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "mv-2c2g@lab",
        sshPublicKey: SSH_KEY,
      }),
    });
    const creating = await created.json<{ workspace: WorkspaceView }>();

    expect(created.status).toBe(201);
    expect(creating.workspace.phase).toBe("creating");
    expect(callback).toContain(`/workspaces/${creating.workspace.id}/phone-home/`);

    const enrolled = await appRequest(
      app,
      new URL(callback).pathname,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: creating.workspace.id,
          host_public_keys: ["ssh-ed25519 AAAAmicrovmhost"],
          ssh_host_public_keys: ["ssh-ed25519 AAAAmicrovmhost"],
        }),
      },
    );
    const polled = await appRequest(app, "/workspaces", {
      headers: { Cookie: cookie },
    });
    const ready = (await polled.json<{ workspaces: WorkspaceView[] }>()).workspaces[0];

    expect(enrolled.status).toBe(200);
    expect(ready).toMatchObject({
      id: creating.workspace.id,
      phase: "ready",
      ssh: {
        host: "192.168.5.25",
        port: 22_001,
        user: "blitz",
        hostPublicKey: "ssh-ed25519 AAAAmicrovmhost",
      },
    });
  });

  it("combines listings and routes mv creates and encoded lifecycle IDs to microVM while leaving other operations on Hetzner", async () => {
    const hetzner = new RecordingVmProvider();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/capacity")) return Response.json(capacity());
      if (url.endsWith("/v1/vms") && init?.method === "POST") {
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      }
      if (url.endsWith("/v1/vms/vm-1-abcdef123456") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );
    const composite = new CompositeVmProvider(hetzner, microvm);

    expect((await composite.listMachineTypes()).map(({ id }) => id)).toEqual([
      "cx23@fsn1",
      "mv-2c2g@lab",
      "mv-2c4g@lab",
    ]);
    const cloudVm = await composite.createVm(createInput("cx23@fsn1"));
    const microVm = await composite.createVm(createInput("mv-2c2g@lab"));
    await composite.destroy(cloudVm.id);
    await composite.shutdown(microVm.id);
    await composite.inspect(cloudVm.id);
    await expect(composite.destroy("microvm:v1:broken")).rejects.toThrow(
      "invalid microVM provider ID",
    );

    expect(hetzner.calls).toEqual([
      "list",
      "create:cx23@fsn1",
      "destroy:42",
      "inspect:42",
    ]);
    expect(fetcher.mock.calls.some(([input, init]) =>
      String(input).endsWith("/v1/vms/vm-1-abcdef123456") && init?.method === "DELETE"
    )).toBe(true);
    expect(composite.capabilities()).toEqual({
      volumes: true,
      maxUserDataBytes: 32 * 1_024,
    });
  });
});
