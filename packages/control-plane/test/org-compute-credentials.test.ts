import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialMasterKeyFor } from "../core/connections/root-crypto.js";
import { OrgComputeProviderResolver } from "../core/compute/org-credentials.js";
import { VmProviderRegistry } from "../core/compute/registry.js";
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
    if (url.includes("api.hetzner.cloud/v1/server_types?")) {
      return Response.json({ server_types: [], meta: { pagination: { next_page: null } } });
    }
    if (url.endsWith("api.hetzner.cloud/v1/pricing")) {
      return Response.json({ pricing: { currency: "EUR" } });
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
) {
  const key = await credentialMasterKeyFor(CRED_MASTER_KEY);
  const compute = new OrgComputeProviderResolver(rawDb(env.DB), key, bindings, {
    fetcher: fake.fetcher,
  });
  const volumes = new FakeProviders();
  const app = appWithVmProviders(compute.descriptors(), volumes, undefined, compute);
  return { app, compute, fake };
}

async function putHetzner(app: Awaited<ReturnType<typeof appFor>>["app"], cookie: string) {
  return appRequest(app, "/orgs/personal/compute-credentials/hetzner", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "org-test-token" }),
  });
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

  it("uses the deployment credential when the org has none", async () => {
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
