import type { WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { $DatabaseRawImpl } from "teenybase/worker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../core/db.js";
import { VmProviderRegistry } from "../core/providers/registry.js";
import {
  MicrovmPoolProvider,
  parseMicrovmHosts,
  parseMicrovmMachineTypeId,
} from "../core/providers/microvm.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  VmInspection,
  VmProvider,
} from "../core/providers/types.js";
import {
  FakeProviders,
  appRequest,
  appWithProviders,
  appWithVmProviders,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

const LAB_TOKEN = "lab-token-01234567890123456789012";
const EDGE_TOKEN = "edge-token-0123456789012345678901";
const SSH_KEY = "ssh-ed25519 AAAAC3Nzatest caller";
const PHONE_HOME_URL = "https://cp.example/workspaces/workspace-id/phone-home/capability";

type HostInput =
  | { name: string; url: string; tokenVar: string }
  | { name: string; tokenVar: string; dynamic: true };

function hosts(...entries: HostInput[]): string {
  return JSON.stringify(entries);
}

function provider(
  rawHosts: unknown,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  secrets: Record<string, unknown> = {
    MICROVM_LAB_TOKEN: LAB_TOKEN,
    MICROVM_EDGE_TOKEN: EDGE_TOKEN,
  },
  db?: Db,
): MicrovmPoolProvider {
  return new MicrovmPoolProvider(
    rawHosts,
    (tokenVar) => Reflect.get(secrets, tokenVar),
    { fetcher, db },
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
  readonly id = "hetzner";
  readonly calls: string[] = [];

  capabilities() {
    return { volumes: true, maxUserDataBytes: 32 * 1_024 };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return /^cx\d+@/u.test(machineTypeId);
  }

  ownsVmId(vmId: string): boolean {
    return /^\d+$/u.test(vmId);
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
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
    const dynamic = { name: "home", tokenVar: "MICROVM_EDGE_TOKEN", dynamic: true } as const;
    expect(parseMicrovmHosts(hosts(valid))).toEqual([valid]);
    expect(parseMicrovmHosts(hosts(valid, dynamic))).toEqual([valid, dynamic]);

    const invalidConfigs: Array<[string, unknown]> = [
      ["JSON", "not-json"],
      ["array", "{}"],
      ["name", hosts({ ...valid, name: "Lab" })],
      ["URL", hosts({ ...valid, url: "file:///tmp/agent" })],
      ["credentials", hosts({ ...valid, url: "https://user:pass@example.com" })],
      ["fields", JSON.stringify([{ ...valid, token: "embedded-secret" }])],
      ["dynamic URL", JSON.stringify([{ ...dynamic, url: "https://home.example" }])],
      ["dynamic false", JSON.stringify([{ ...valid, dynamic: false }])],
      ["dynamic missing marker", JSON.stringify([{ name: "home", tokenVar: "MICROVM_EDGE_TOKEN" }])],
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

  it("resolves pinned hosts from the bootstrapped D1 row on every call", async () => {
    const db = new $DatabaseRawImpl(env.DB);
    const calls: string[] = [];
    const microvm = provider(
      hosts({
        name: "lab",
        url: "https://configured.example",
        tokenVar: "MICROVM_LAB_TOKEN",
      }),
      async (input) => {
        calls.push(String(input));
        return Response.json(capacity());
      },
      undefined,
      db,
    );

    await microvm.syncStaticHosts();
    await microvm.listMachineTypes();
    await env.DB
      .prepare("UPDATE microvm_hosts SET url = ?1 WHERE name = 'lab'")
      .bind("https://persisted.example")
      .run();
    await microvm.listMachineTypes();
    await microvm.syncStaticHosts();
    await microvm.listMachineTypes();

    expect(calls).toEqual([
      "https://configured.example/v1/capacity",
      "https://persisted.example/v1/capacity",
      "https://configured.example/v1/capacity",
    ]);
    await expect(
      env.DB
        .prepare("SELECT source FROM microvm_hosts WHERE name = 'lab'")
        .first<string>("source"),
    ).resolves.toBe("static");
  });

  it("skips an unregistered dynamic host without degrading a pinned host", async () => {
    const db = new $DatabaseRawImpl(env.DB);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const microvm = provider(
      hosts(
        {
          name: "lab",
          url: "https://configured.example",
          tokenVar: "MICROVM_LAB_TOKEN",
        },
        { name: "home", tokenVar: "MICROVM_EDGE_TOKEN", dynamic: true },
      ),
      async (input) => {
        expect(String(input)).toBe("https://configured.example/v1/capacity");
        return Response.json(capacity());
      },
      undefined,
      db,
    );
    await microvm.syncStaticHosts();

    await expect(microvm.listMachineTypes()).resolves.toEqual([
      expect.objectContaining({ id: "mv-2c2g@lab" }),
      expect.objectContaining({ id: "mv-2c4g@lab" }),
    ]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"host":"home"'));
    warning.mockRestore();
  });

  it("resolves a registered dynamic URL from D1 for every provider operation", async () => {
    const db = new $DatabaseRawImpl(env.DB);
    const calls: string[] = [];
    const microvm = provider(
      hosts({ name: "home", tokenVar: "MICROVM_EDGE_TOKEN", dynamic: true }),
      async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/capacity")) return Response.json(capacity());
        if (url.endsWith("/v1/vms") && init?.method === "POST") {
          return Response.json({
            vm_id: "vm-1-abcdef123456",
            host_ip: "192.0.2.10",
            ssh_port: 22_001,
          }, { status: 201 });
        }
        if (url.endsWith("/v1/vms") && init?.method === undefined) {
          return Response.json([agentVm()]);
        }
        if (url.endsWith("/v1/vms/vm-1-abcdef123456")) {
          return new Response(null, { status: 204 });
        }
        if (url.includes("/surface/7445/")) return new Response("surface");
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
      },
      undefined,
      db,
    );
    await microvm.registerHost("home", EDGE_TOKEN, "https://one.trycloudflare.com/");

    const pointAt = async (url: string) => {
      await env.DB
        .prepare("UPDATE microvm_hosts SET url = ?1 WHERE name = 'home'")
        .bind(url)
        .run();
    };
    await microvm.listMachineTypes();
    await pointAt("https://two.trycloudflare.com");
    const created = await microvm.createVm(createInput("mv-2c2g@home"));
    await pointAt("https://three.trycloudflare.com");
    await microvm.inspect(created.id);
    await pointAt("https://four.trycloudflare.com");
    await microvm.proxySurface(
      created.id,
      7445,
      "/ports",
      new Request("https://cp.example/surface"),
    );
    await pointAt("https://five.trycloudflare.com");
    await microvm.destroy(created.id);

    expect(calls).toEqual([
      "https://one.trycloudflare.com/v1/capacity",
      "https://two.trycloudflare.com/v1/vms",
      "https://three.trycloudflare.com/v1/vms",
      "https://four.trycloudflare.com/vms/vm-1-abcdef123456/surface/7445/ports",
      "https://five.trycloudflare.com/v1/vms/vm-1-abcdef123456",
    ]);
  });

  it("returns a 503-style error when a dynamic host has not registered", async () => {
    const db = new $DatabaseRawImpl(env.DB);
    const microvm = provider(
      hosts({ name: "home", tokenVar: "MICROVM_EDGE_TOKEN", dynamic: true }),
      async () => {
        throw new Error("unregistered hosts must not be fetched");
      },
      undefined,
      db,
    );

    await expect(microvm.createVm(createInput("mv-2c2g@home"))).rejects.toMatchObject({
      status: 503,
      message: "dynamic microVM host home is unavailable; waiting for registration",
    });
    await expect(
      microvm.proxySurface(
        "microvm:v1:home:vm-1-abcdef123456",
        7445,
        "/",
        new Request("https://cp.example/surface"),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("lists only recognized sizes fitting each live authenticated host capacity", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = url.includes("edge.example") ? `Bearer ${EDGE_TOKEN}` : `Bearer ${LAB_TOKEN}`;
      expect(init?.headers).toEqual({ Authorization: authorization });
      const headers = init?.headers ?? {};
      expect(Object.keys(headers)).toEqual(["Authorization"]);
      expect("Content-Type" in headers).toBe(false);
      expect(JSON.stringify(headers)).toBe(JSON.stringify({ Authorization: authorization }));
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

  it("accepts legacy and extended capacity responses during a rolling upgrade", async () => {
    const raw = hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" });
    const legacyProvider = provider(raw, async () => Response.json(capacity()));
    const extendedProvider = provider(raw, async () => Response.json(capacity({
      physical_cpu: 4,
      effective_cpu: 8,
    })));

    await expect(legacyProvider.listMachineTypes()).resolves.toHaveLength(2);
    await expect(extendedProvider.listMachineTypes()).resolves.toHaveLength(2);
  });

  it("rejects incomplete or inconsistent extended capacity responses", async () => {
    const raw = hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" });
    const invalidResponses: Array<[string, Record<string, number>]> = [
      ["missing effective CPU", capacity({ physical_cpu: 8 })],
      ["missing physical CPU", capacity({ effective_cpu: 8 })],
      ["non-positive physical CPU", capacity({ physical_cpu: 0, effective_cpu: 8 })],
      ["fractional effective CPU", capacity({ physical_cpu: 4, effective_cpu: 7.5 })],
      ["legacy total differs from effective CPU", capacity({ physical_cpu: 4, effective_cpu: 16 })],
      ["physical CPU exceeds effective CPU", capacity({ physical_cpu: 9, effective_cpu: 8 })],
    ];

    for (const [description, response] of invalidResponses) {
      const microvm = provider(raw, async () => Response.json(response));
      await expect(microvm.listMachineTypes(), description).rejects.toThrow();
    }
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

    const extendedUnknownFieldProvider = provider(raw, async () =>
      Response.json({
        ...capacity({ physical_cpu: 4, effective_cpu: 8 }),
        unexpected: true,
      }),
    );
    await expect(extendedUnknownFieldProvider.listMachineTypes()).rejects.toThrow(
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
      const headers = init?.headers ?? {};
      expect(headers).toEqual({
        Authorization: `Bearer ${LAB_TOKEN}`,
        "Content-Type": "application/json",
      });
      expect(Object.keys(headers)).toEqual(["Authorization", "Content-Type"]);
      expect("Content-Type" in headers).toBe(true);
      expect(JSON.stringify(headers)).toBe(
        JSON.stringify({ Authorization: `Bearer ${LAB_TOKEN}`, "Content-Type": "application/json" }),
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        workspace_id: "workspace-id",
        cpu: 2,
        mem_mb: 2_048,
        ssh_authorized_key: SSH_KEY,
        phone_home_url: PHONE_HOME_URL,
        cp_origin: "https://cp.example",
      });
      expect(Object.keys(body)).toEqual([
        "workspace_id",
        "cpu",
        "mem_mb",
        "ssh_authorized_key",
        "phone_home_url",
        "cp_origin",
      ]);
      expect("ssh_authorized_key" in body).toBe(true);
      expect(JSON.stringify(body)).toBe(
        `{"workspace_id":"workspace-id","cpu":2,"mem_mb":2048,"ssh_authorized_key":"${SSH_KEY}","phone_home_url":"${PHONE_HOME_URL}","cp_origin":"https://cp.example"}`,
      );
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

  it("omits the agent SSH key field for missing and blank provider input", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      },
    );

    for (const sshPublicKey of [undefined, "", " \t\n "]) {
      await microvm.createVm({
        ...createInput("mv-2c2g@lab"),
        sshPublicKey,
      });
    }

    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("ssh_authorized_key");
      expect(Object.keys(body)).toEqual(["workspace_id", "cpu", "mem_mb", "phone_home_url", "cp_origin"]);
      expect("ssh_authorized_key" in body).toBe(false);
      expect(JSON.stringify(body)).toBe(
        `{"workspace_id":"workspace-id","cpu":2,"mem_mb":2048,"phone_home_url":"${PHONE_HOME_URL}","cp_origin":"https://cp.example"}`,
      );
    }
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

  it("does not apply another provider's user-data limit to a microVM create", async () => {
    let createCalls = 0;
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      async (_input, init) => {
        if (init?.method !== "POST") throw new Error("unexpected microVM request");
        createCalls += 1;
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      },
    );
    const cloud = new FakeProviders();
    const app = appWithVmProviders([cloud, microvm], cloud);
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "mv-2c2g@lab",
        userData: "a".repeat(40 * 1_024),
      }),
    });

    expect(response.status).toBe(201);
    expect(createCalls).toBe(1);
    expect(cloud.createCalls).toBe(0);
  });

  it("rejects a microVM volume before inserting a workspace or creating a VM", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("microVM create must not be called");
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );
    const cloud = new FakeProviders();
    const app = appWithVmProviders([cloud, microvm], cloud);
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "mv-2c2g@lab",
        volumeId: "volume-1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "machine type mv-2c2g@lab does not support volumes",
      retryAction: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(0);
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

  it("session-authenticates and streams allowed HTTP surface requests to the agent", async () => {
    const surfaceCalls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      cookie: string | null;
      body: string;
    }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/vms") && init?.method === "POST") {
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      }
      if (url.includes("/vms/vm-1-abcdef123456/surface/7445/")) {
        const headers = new Headers(init?.headers);
        surfaceCalls.push({
          url,
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          cookie: headers.get("cookie"),
          body: init?.body === undefined || init.body === null
            ? ""
            : await new Response(init.body).text(),
        });
        return new Response("guest-response", {
          status: 207,
          headers: { "X-Guest-Surface": "7445" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );
    const app = appWithProviders(microvm, new FakeProviders());
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "mv-2c2g@lab" }),
    });
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(workspace.machineTypeId).toBe("mv-2c2g@lab");

    const unauthorized = await appRequest(
      app,
      `/workspaces/${workspace.id}/surface/7445/ports`,
    );
    expect(unauthorized.status).toBe(401);
    const disallowed = await appRequest(
      app,
      `/workspaces/${workspace.id}/surface/7443/ports`,
      { headers: { Cookie: cookie } },
    );
    expect(disallowed.status).toBe(400);
    const missing = await appRequest(
      app,
      "/workspaces/missing/surface/7445/ports",
      { headers: { Cookie: cookie } },
    );
    expect(missing.status).toBe(404);

    const response = await appRequest(
      app,
      `/workspaces/${workspace.id}/surface/7445/workspace/a%20b?arg=one&arg=two`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "text/plain" },
        body: "stream-me",
      },
    );
    expect(response.status).toBe(207);
    expect(response.headers.get("x-guest-surface")).toBe("7445");
    expect(await response.text()).toBe("guest-response");
    expect(surfaceCalls).toEqual([{
      url: "https://lab.example/vms/vm-1-abcdef123456/surface/7445/workspace/a%20b?arg=one&arg=two",
      method: "PATCH",
      authorization: `Bearer ${LAB_TOKEN}`,
      cookie: null,
      body: "stream-me",
    }]);
  });

  it("rejects surface access for tunnel-less cloud workspaces with a clear 503", async () => {
    const cloud = new FakeProviders();
    const app = appWithProviders(cloud, cloud);
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small" }),
    });
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const response = await appRequest(
      app,
      `/workspaces/${workspace.id}/surface/7445/ports`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "workspace has no surface tunnel",
    });
  });

  it("pipes WebSocket messages in both directions through the agent fetch", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/vms") && init?.method === "POST") {
        return Response.json({
          vm_id: "vm-1-abcdef123456",
          host_ip: "192.0.2.10",
          ssh_port: 22_001,
        }, { status: 201 });
      }
      if (url.endsWith("/vms/vm-1-abcdef123456/surface/7444/?arg=kept")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${LAB_TOKEN}`);
        expect(headers.get("cookie")).toBeNull();
        expect(headers.get("upgrade")).toBe("websocket");
        const pair = new WebSocketPair();
        const upstreamServer = pair[1];
        upstreamServer.accept();
        upstreamServer.addEventListener("message", (event) => {
          upstreamServer.send(`agent:${String(event.data)}`);
        });
        return new Response(null, {
          status: 101,
          headers: { "Sec-WebSocket-Protocol": "acp" },
          webSocket: pair[0],
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    const microvm = provider(
      hosts({ name: "lab", url: "https://lab.example", tokenVar: "MICROVM_LAB_TOKEN" }),
      fetcher,
    );
    const app = appWithProviders(microvm, new FakeProviders());
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "mv-2c2g@lab" }),
    });
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;

    const response = await appRequest(
      app,
      `/workspaces/${workspace.id}/surface/7444?arg=kept`,
      {
        headers: {
          Cookie: cookie,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "acp",
        },
      },
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe("acp");
    const socket = response.webSocket;
    if (socket === null) throw new Error("control-plane response omitted its WebSocket");
    socket.accept();
    const message = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket response timed out")), 2_000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
    });
    socket.send("hello");
    await expect(message).resolves.toBe("agent:hello");
    socket.close(1000, "done");
  });

  it("combines listings and resolves mv creates and encoded lifecycle IDs to microVM while leaving other operations on Hetzner", async () => {
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
    const registry = new VmProviderRegistry([hetzner, microvm]);

    expect((await registry.listMachineTypes()).machineTypes.map(({ id }) => id)).toEqual([
      "cx23@fsn1",
      "mv-2c2g@lab",
      "mv-2c4g@lab",
    ]);
    const cloudVm = await registry
      .forMachineType("cx23@fsn1")
      .createVm(createInput("cx23@fsn1"));
    const microVm = await registry
      .forMachineType("mv-2c2g@lab")
      .createVm(createInput("mv-2c2g@lab"));
    const cloudOwner = registry.forVmId(cloudVm.id);
    const microvmOwner = registry.forVmId(microVm.id);
    if (cloudOwner === undefined || microvmOwner === undefined) {
      throw new Error("created VM has no owning provider");
    }
    await cloudOwner.destroy(cloudVm.id);
    await microvmOwner.shutdown(microVm.id);
    await cloudOwner.inspect(cloudVm.id);
    await expect(
      registry.forVmId("microvm:v1:broken")?.destroy("microvm:v1:broken"),
    ).rejects.toThrow(
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
    expect(registry.get("hetzner")?.capabilities()).toEqual({
      volumes: true,
      maxUserDataBytes: 32 * 1_024,
    });
  });
});
