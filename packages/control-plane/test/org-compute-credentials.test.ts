import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialMasterKeyFor } from "../core/connections/root-crypto.js";
import { OrgComputeProviderResolver } from "../core/compute/org-credentials.js";
import { VmProviderRegistry } from "../core/compute/registry.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  VmInspection,
  VmProvider,
} from "../core/compute/types.js";
import { runOrphanSweep } from "../core/janitors.js";
import { rawDb } from "../src/raw-db.js";
import {
  appRequest,
  appWithVmProviders,
  CRED_MASTER_KEY,
  FakeProviders,
  operatorSession,
  sameOrgSession,
  testRuntime,
  userSession,
} from "./helpers.js";

interface ProviderCall {
  url: string;
  method: string;
  authorization: string;
  body: string;
}

function providerHttp(options: { rejectHetzner?: boolean } = {}) {
  const calls: ProviderCall[] = [];
  let serverId = 10_000;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
      body: String(init?.body ?? ""),
    });
    if (url.includes("api.hetzner.cloud/v1/servers?per_page=1")) {
      return options.rejectHetzner === true
        ? Response.json({ error: { message: "credential rejected verbatim" } }, { status: 401 })
        : Response.json({ servers: [] });
    }
    if (url.endsWith("api.hetzner.cloud/v1/servers") && init?.method === "POST") {
      serverId += 1;
      return Response.json({
        server: {
          id: serverId,
          public_net: { ipv4: { ip: "203.0.113.40" } },
        },
      });
    }
    if (url.endsWith("api.hetzner.cloud/v1/volumes") && init?.method === "POST") {
      return Response.json({
        volume: {
          id: 20_001,
          name: "org-volume",
          size: 10,
          location: { name: "hil" },
          server: null,
        },
      });
    }
    if (url.includes("api.hetzner.cloud/v1/server_types?")) {
      return Response.json({
        server_types: [{
          id: 1,
          name: "cpx21",
          cores: 3,
          memory: 4,
          disk: 80,
          architecture: "x86",
          deprecated: false,
          locations: [{ name: "hil", available: true, deprecated: false }],
          prices: [{ location: "hil", price_monthly: { gross: "37.49" } }],
        }],
        meta: { pagination: { next_page: null } },
      });
    }
    if (url.endsWith("api.hetzner.cloud/v1/pricing")) {
      return Response.json({ pricing: { currency: "EUR" } });
    }
    if (/api\.hetzner\.cloud\/v1\/servers\/\d+\/actions\/shutdown$/u.test(url)) {
      return Response.json({ action: { id: 1 } });
    }
    if (/api\.hetzner\.cloud\/v1\/servers\/\d+$/u.test(url)) {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const id = Number(url.slice(url.lastIndexOf("/") + 1));
      return Response.json({
        server: {
          id,
          status: "off",
          public_net: { ipv4: { ip: "203.0.113.40" } },
        },
      });
    }
    if (url.includes("sts.us-east-1.amazonaws.com")) {
      return new Response(
        "<GetCallerIdentityResponse><GetCallerIdentityResult>"
          + "<Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/test</Arn>"
          + "<UserId>AIDAEXAMPLE</UserId></GetCallerIdentityResult>"
          + "</GetCallerIdentityResponse>",
        { status: 200, headers: { "content-type": "text/xml" } },
      );
    }
    throw new Error(`unexpected provider URL: ${url}`);
  };
  return { calls, fetcher };
}

async function appFor(
  bindings: {
    HETZNER_API_TOKEN?: string;
    AWS_REGION?: string;
  },
  fake = providerHttp(),
  additionalVmProviders: readonly VmProvider[] = [],
) {
  const key = await credentialMasterKeyFor(CRED_MASTER_KEY);
  const compute = new OrgComputeProviderResolver(rawDb(env.DB), key, bindings, {
    fetcher: fake.fetcher,
  });
  const volumes = new FakeProviders();
  const app = appWithVmProviders(
    [...compute.descriptors(), ...additionalVmProviders],
    volumes,
    undefined,
    compute,
    { forOrg: (orgId, requiredSource) => compute.resolveVolume(orgId, requiredSource) },
  );
  return { app, compute, fake };
}

async function putHetzner(app: Awaited<ReturnType<typeof appFor>>["app"], cookie: string) {
  return putHetznerForOrg(app, cookie, "personal");
}

async function putHetznerForOrg(
  app: Awaited<ReturnType<typeof appFor>>["app"],
  cookie: string,
  orgId: string,
) {
  return appRequest(app, `/orgs/${encodeURIComponent(orgId)}/compute-credentials/hetzner`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "org-test-token" }),
  });
}

class OfferedMicrovmProvider implements VmProvider {
  readonly id = "microvm";

  capabilities() {
    return { volumes: false, offersMachineTypes: true };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return machineTypeId === "mv-2c2g@lab";
  }

  ownsVmId(vmId: string): boolean {
    return vmId.startsWith("mv-lab-");
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    return [{
      id: "mv-2c2g@lab",
      name: "MicroVM 2 vCPU / 2 GB",
      cpuCores: 2,
      memGb: 2,
      diskGb: 20,
      arch: "x86",
      location: "lab",
      monthlyPrice: null,
    }];
  }

  async createVm(_input: CreateVmInput): Promise<CreatedVm> {
    return { id: "mv-lab-1", host: "127.0.0.1", port: 22, user: "blitz" };
  }

  async shutdown(_id: string): Promise<void> {}
  async destroy(_id: string): Promise<void> {}
  async inspect(_id: string): Promise<VmInspection | null> {
    return null;
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM org_compute_credentials"),
  ]);
});

describe("organization compute credentials", () => {
  it("round-trips sealed storage into workspace creation and never returns ciphertext", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await operatorSession(app);

    const stored = await putHetzner(app, cookie);
    expect(stored.status).toBe(200);
    const putMetadata = await stored.json<Record<string, unknown>>();
    expect(putMetadata).toMatchObject({ provider: "hetzner", created_by: "personal" });
    expect(putMetadata).toHaveProperty("validated_at");

    const row = await env.DB.prepare(
      `SELECT ciphertext FROM org_compute_credentials
       WHERE org_id = 'personal' AND provider = 'hetzner'`,
    ).first<{ ciphertext: string }>();
    expect(row?.ciphertext).toBeTruthy();
    expect(row?.ciphertext).not.toContain("org-test-token");

    fake.calls.length = 0;
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });
    expect(created.status).toBe(201);
    const createCall = fake.calls.find(
      (call) => call.url.endsWith("/servers") && call.method === "POST",
    );
    expect(createCall?.authorization).toBe("Bearer org-test-token");
    const workspaceSource = await env.DB.prepare(
      "SELECT compute_credential_source FROM workspaces LIMIT 1",
    ).first<{ compute_credential_source: string | null }>();
    expect(workspaceSource?.compute_credential_source).toBe("org");

    const fetched = await appRequest(
      app,
      "/orgs/personal/compute-credentials/hetzner",
      { headers: { Cookie: cookie } },
    );
    expect(fetched.status).toBe(200);
    const getMetadata = await fetched.json<Record<string, unknown>>();
    expect(getMetadata).toEqual({
      provider: "hetzner",
      validated_at: putMetadata.validated_at,
      created_by: "personal",
    });
    expect(JSON.stringify(getMetadata)).not.toContain("org-test-token");
    expect(JSON.stringify(getMetadata)).not.toContain(row?.ciphertext ?? "missing-ciphertext");
  });

  it("lets an org containing the platform operator use the deployment credential", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });

    expect(created.status).toBe(201);
    const createCall = fake.calls.find(
      (call) => call.url.endsWith("/servers") && call.method === "POST",
    );
    expect(createCall?.authorization).toBe("Bearer deployment-test-token");
    const workspaceSource = await env.DB.prepare(
      "SELECT compute_credential_source FROM workspaces LIMIT 1",
    ).first<{ compute_credential_source: string | null }>();
    expect(workspaceSource?.compute_credential_source).toBe("deployment");
  });

  it("requires a tenant org credential before creating a cloud workspace", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await userSession("tenant-without-key");
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });

    expect(created.status).toBe(402);
    await expect(created.json()).resolves.toEqual({
      error: "hetzner compute credential required; an organization admin can add one at /orgs/tenant-without-key-org/compute-credentials/hetzner",
      retryAction: null,
    });
    expect(fake.calls).toEqual([]);
    expect(await env.DB.prepare(
      "SELECT id FROM workspaces WHERE org_id = 'tenant-without-key-org' LIMIT 1",
    ).first()).toBeNull();
  });

  it("names AWS and its credential route when an AWS tenant has no key", async () => {
    const { app, fake } = await appFor({ AWS_REGION: "us-east-1" });
    const cookie = await userSession("aws-tenant-without-key");
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "aws-t3.medium@us-east-1" }),
    });

    expect(created.status).toBe(402);
    await expect(created.json()).resolves.toEqual({
      error: "aws compute credential required; an organization admin can add one at /orgs/aws-tenant-without-key-org/compute-credentials/aws",
      retryAction: null,
    });
    expect(fake.calls).toEqual([]);
  });

  it("creates a tenant cloud workspace with the validated org credential", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await userSession("tenant-with-key");
    expect((await putHetznerForOrg(app, cookie, "tenant-with-key-org")).status).toBe(200);
    fake.calls.length = 0;

    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });

    expect(created.status).toBe(201);
    const createCall = fake.calls.find(
      (call) => call.url.endsWith("/servers") && call.method === "POST",
    );
    expect(createCall?.authorization).toBe("Bearer org-test-token");
    expect(await env.DB.prepare(
      "SELECT compute_credential_source FROM workspaces WHERE org_id = 'tenant-with-key-org' LIMIT 1",
    ).first()).toMatchObject({ compute_credential_source: "org" });
  });

  it("loads the machine catalog with the caller org credential", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await operatorSession(app);
    expect((await putHetzner(app, cookie)).status).toBe(200);
    fake.calls.length = 0;

    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(fake.calls.some((call) => call.url.includes("/server_types?"))).toBe(true);
    expect(fake.calls.some((call) => call.url.endsWith("/pricing"))).toBe(true);
    expect(fake.calls.map((call) => call.authorization)).toEqual([
      "Bearer org-test-token",
      "Bearer org-test-token",
    ]);
  });

  it("hides tenant cloud machines until a credential is validated", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await userSession("tenant-catalog");

    const before = await appRequest(app, "/machine-types", { headers: { Cookie: cookie } });
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toEqual({
      machineTypes: [],
      failures: [],
      providerStatuses: [{ providerId: "hetzner", access: "credential-required" }],
    });
    expect(fake.calls).toEqual([]);

    expect((await putHetznerForOrg(app, cookie, "tenant-catalog-org")).status).toBe(200);
    fake.calls.length = 0;
    const after = await appRequest(app, "/machine-types", { headers: { Cookie: cookie } });
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({
      machineTypes: [{ id: "cpx21@hil", providerId: "hetzner" }],
      failures: [],
      providerStatuses: [{ providerId: "hetzner", access: "org" }],
    });
    expect(fake.calls.map((call) => call.authorization)).toEqual([
      "Bearer org-test-token",
      "Bearer org-test-token",
    ]);
  });

  it("does not gate host-registered microVM machine types", async () => {
    const microvm = new OfferedMicrovmProvider();
    const fake = providerHttp();
    const { app } = await appFor(
      { HETZNER_API_TOKEN: "deployment-test-token" },
      fake,
      [microvm],
    );
    const cookie = await userSession("tenant-microvm");

    const response = await appRequest(app, "/machine-types", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      machineTypes: [{
        id: "mv-2c2g@lab",
        providerId: "microvm",
        supportsVolumes: false,
        name: "MicroVM 2 vCPU / 2 GB",
        cpuCores: 2,
        memGb: 2,
        diskGb: 20,
        arch: "x86",
        location: "lab",
        monthlyPrice: null,
      }],
      failures: [],
      providerStatuses: [{ providerId: "hetzner", access: "credential-required" }],
    });
    expect(fake.calls).toEqual([]);
  });

  it("destroys and sweeps legacy NULL-source workspaces with the deployment credential", async () => {
    const { app, compute, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await userSession("tenant-legacy");
    expect((await putHetznerForOrg(app, cookie, "tenant-legacy-org")).status).toBe(200);
    fake.calls.length = 0;

    const createdIds: string[] = [];
    for (const name of ["legacy-delete", "legacy-sweep"]) {
      const response = await appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "cpx21@hil", name }),
      });
      expect(response.status).toBe(201);
      const body = await response.json<{ workspace: { id: string } }>();
      createdIds.push(body.workspace.id);
    }
    const deleteId = createdIds[0];
    const sweepId = createdIds[1];
    if (deleteId === undefined || sweepId === undefined) throw new Error("workspace ids missing");
    await env.DB.prepare(
      "UPDATE workspaces SET compute_credential_source = NULL WHERE id IN (?1, ?2)",
    ).bind(deleteId, sweepId).run();
    expect((await appRequest(
      app,
      "/orgs/tenant-legacy-org/compute-credentials/hetzner",
      { method: "DELETE", headers: { Cookie: cookie } },
    )).status).toBe(204);

    fake.calls.length = 0;
    const removed = await appRequest(app, `/workspaces/${encodeURIComponent(deleteId)}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(removed.status).toBe(200);
    expect(fake.calls.filter((call) => call.url.includes("/servers/10001")))
      .not.toHaveLength(0);
    expect(fake.calls.every((call) => call.authorization === "Bearer deployment-test-token"))
      .toBe(true);

    await env.DB.prepare(
      "UPDATE workspaces SET phase = 'destroying' WHERE id = ?1",
    ).bind(sweepId).run();
    const fallback = new FakeProviders();
    const base = testRuntime(fallback);
    const runtime = {
      ...base,
      providers: {
        ...base.providers,
        vmRegistry: new VmProviderRegistry(
          compute.descriptors(),
          async (provider, orgId, requiredSource) => compute.handles(provider.id)
            ? compute.resolve(provider.id, orgId, requiredSource)
            : null,
        ),
        volume: {
          forOrg: (orgId: string, requiredSource?: "org" | "deployment" | null) =>
            compute.resolveVolume(orgId, requiredSource),
        },
        compute,
      },
    };
    fake.calls.length = 0;
    expect(await runOrphanSweep(runtime)).toBe(1);
    expect(fake.calls.filter((call) => call.url.includes("/servers/10002")))
      .not.toHaveLength(0);
    expect(fake.calls.every((call) => call.authorization === "Bearer deployment-test-token"))
      .toBe(true);
  });

  it("pins volume operations to the credential source that created the volume", async () => {
    const { app, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await operatorSession(app);
    expect((await putHetzner(app, cookie)).status).toBe(200);
    fake.calls.length = 0;

    const created = await appRequest(app, "/volumes", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "org-volume", sizeGb: 10, location: "hil" }),
    });
    expect(created.status).toBe(201);
    expect(fake.calls[0]?.authorization).toBe("Bearer org-test-token");
    expect(
      await env.DB.prepare(
        "SELECT compute_credential_source FROM volume_ownership WHERE volume_id = '20001'",
      ).first(),
    ).toMatchObject({ compute_credential_source: "org" });

    expect((await appRequest(app, "/orgs/personal/compute-credentials/hetzner", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    fake.calls.length = 0;
    const removed = await appRequest(app, "/volumes/20001", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(removed.status).toBe(409);
    expect(fake.calls).toEqual([]);
    expect(
      await env.DB.prepare("SELECT volume_id FROM volume_ownership WHERE volume_id = '20001'").first(),
    ).not.toBeNull();
  });

  it("returns 409 at workspace creation when neither credential exists", async () => {
    const { app, fake } = await appFor({});
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });

    expect(created.status).toBe(409);
    await expect(created.json()).resolves.toEqual({
      error: "org has no hetzner credential",
      retryAction: null,
    });
    expect(fake.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM workspaces LIMIT 1").first()).toBeNull();
  });

  it("validates before storage and returns the provider error verbatim", async () => {
    const fake = providerHttp({ rejectHetzner: true });
    const { app } = await appFor({}, fake);
    const cookie = await operatorSession(app);
    const response = await putHetzner(app, cookie);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "credential rejected verbatim",
      retryAction: null,
    });
    expect(
      await env.DB.prepare("SELECT provider FROM org_compute_credentials LIMIT 1").first(),
    ).toBeNull();
  });

  it("requires an organization admin for PUT, GET, and DELETE", async () => {
    const { app, fake } = await appFor({});
    const adminCookie = await operatorSession(app);
    expect((await putHetzner(app, adminCookie)).status).toBe(200);
    const member = await sameOrgSession("compute-member");
    fake.calls.length = 0;

    const put = await putHetzner(app, member.cookie);
    const get = await appRequest(app, "/orgs/personal/compute-credentials/hetzner", {
      headers: { Cookie: member.cookie },
    });
    const remove = await appRequest(app, "/orgs/personal/compute-credentials/hetzner", {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    });

    expect([put.status, get.status, remove.status]).toEqual([403, 403, 403]);
    expect(fake.calls).toEqual([]);
    expect(
      await env.DB.prepare("SELECT provider FROM org_compute_credentials LIMIT 1").first(),
    ).toMatchObject({ provider: "hetzner" });
  });

  it("logs and skips an orphan whose org credential was deleted", async () => {
    const { app, compute, fake } = await appFor({ HETZNER_API_TOKEN: "deployment-test-token" });
    const cookie = await operatorSession(app);
    expect((await putHetzner(app, cookie)).status).toBe(200);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "cpx21@hil" }),
    });
    expect(created.status).toBe(201);
    await env.DB.prepare("UPDATE workspaces SET phase = 'destroying'").run();
    const deleted = await appRequest(
      app,
      "/orgs/personal/compute-credentials/hetzner",
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(deleted.status).toBe(204);

    const fallback = new FakeProviders();
    const base = testRuntime(fallback);
    const reportError = vi.fn<(event: string, error: Error) => void>();
    const runtime = {
      ...base,
      providers: {
        ...base.providers,
        vmRegistry: new VmProviderRegistry(
          compute.descriptors(),
          async (provider, orgId, requiredSource) => compute.handles(provider.id)
            ? compute.resolve(provider.id, orgId, requiredSource)
            : null,
        ),
        volume: {
          forOrg: (orgId: string, requiredSource?: "org" | "deployment" | null) =>
            compute.resolveVolume(orgId, requiredSource),
        },
        compute,
      },
      reportError,
    };
    fake.calls.length = 0;

    expect(await runOrphanSweep(runtime)).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[0]).toBe("orphan_sweep_compute_credential_skipped");
    expect(reportError.mock.calls[0]?.[1].message).toContain("org has no hetzner credential");
    expect(
      await env.DB.prepare("SELECT vm_id FROM workspaces LIMIT 1").first<{ vm_id: string | null }>(),
    ).toMatchObject({ vm_id: expect.any(String) });
  });

  it("validates AWS credentials with a signed STS GetCallerIdentity call", async () => {
    const { app, fake } = await appFor({ AWS_REGION: "us-east-1" });
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/orgs/personal/compute-credentials/aws", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        accessKeyId: "AKIDTESTONLY",
        secretAccessKey: "secret-test-only",
        sessionToken: "session-test-only",
      }),
    });

    expect(response.status).toBe(200);
    const sts = fake.calls.find((call) => call.url.includes("sts.us-east-1.amazonaws.com"));
    expect(new URLSearchParams(sts?.body).get("Action")).toBe("GetCallerIdentity");
    expect(sts?.authorization).toContain("Credential=AKIDTESTONLY/");
    expect(JSON.stringify(await response.json())).not.toContain("secret-test-only");
  });
});
