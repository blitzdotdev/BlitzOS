import type {
  FeedResponse,
  ListMachineTypesResponse,
  PollResponse,
  RegisterKeysResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAZY_SWEEP_INTERVAL_MS,
  maybeScheduleLazySweep,
  runInvariantSweep,
  runOrphanSweep,
} from "../core/index.js";
import { buildUserData } from "../core/cloud-init.js";
import { hashSecret } from "../core/crypto.js";
import { HetznerProvider } from "../core/providers/hetzner.js";
import worker from "../src/worker.js";
import {
  OPERATOR_KEY,
  appWithProviders,
  appRequest,
  createWorkspace,
  enrollBox,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

interface WorkspaceResponse {
  workspace: WorkspaceView;
}

describe("control plane security and lifecycle", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an absent or wrong operator key with 401", async () => {
    const { app } = harness();
    const absent = await appRequest(app, "/sessions", { method: "POST" });
    const wrong = await appRequest(app, "/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(absent.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("mints sessions with a 30-day default expiry and honors SESSION_TTL_DAYS", async () => {
    const { app } = harness();
    const defaultResponse = await appRequest(app, "/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
    });
    const defaultSetCookie = defaultResponse.headers.get("set-cookie") ?? "";
    expect(defaultSetCookie).toContain("Max-Age=2592000");
    const defaultCookie = defaultSetCookie.split(";", 1)[0] ?? "";
    const defaultToken = decodeURIComponent(defaultCookie.slice(defaultCookie.indexOf("=") + 1));
    const defaultRow = await env.DB
      .prepare("SELECT created_at, expires_at FROM sessions WHERE token_hash = ?1")
      .bind(await hashSecret(defaultToken))
      .first<{ created_at: number; expires_at: number }>();
    expect(defaultRow).not.toBeNull();
    expect((defaultRow?.expires_at ?? 0) - (defaultRow?.created_at ?? 0)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );

    const overridden = await appRequest(
      app,
      "/sessions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
      },
      { SESSION_TTL_DAYS: "2" },
    );
    expect(overridden.headers.get("set-cookie")).toContain("Max-Age=172800");
    const overrideCookie = overridden.headers.get("set-cookie")?.split(";", 1)[0];
    if (overrideCookie === undefined) throw new Error("override session cookie is missing");
    const overrideToken = decodeURIComponent(overrideCookie.slice(overrideCookie.indexOf("=") + 1));
    const overrideRow = await env.DB
      .prepare("SELECT created_at, expires_at FROM sessions WHERE token_hash = ?1")
      .bind(await hashSecret(overrideToken))
      .first<{ created_at: number; expires_at: number }>();
    expect(overrideRow).not.toBeNull();
    expect((overrideRow?.expires_at ?? 0) - (overrideRow?.created_at ?? 0)).toBe(
      2 * 24 * 60 * 60 * 1000,
    );
  });

  it("returns 401 for expired sessions", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();

    const response = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", retryAction: null });
  });

  it("deletes expired sessions from scheduled and lazy janitors", async () => {
    const { providers } = harness();
    await env.DB
      .prepare(
        `INSERT INTO principals (id, unix_name, harnesses)
         VALUES ('janitor-principal', 'janitor', '[]')`,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, principal_id, created_at)
         VALUES ('scheduled-expired', 'janitor-principal', 0)`,
      )
      .run();

    const executionContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }),
      env as never,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash = 'scheduled-expired'")
        .first<number>("count"),
    ).toBe(0);

    await env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, principal_id, created_at, expires_at)
         VALUES ('lazy-expired', 'janitor-principal', 0, 0)`,
      )
      .run();
    let scheduled: Promise<unknown> | undefined;
    const runtime = {
      ...testRuntime(providers),
      waitUntil(promise: Promise<unknown>) {
        scheduled = promise;
      },
    };
    maybeScheduleLazySweep(runtime, "/sessions");
    await scheduled;
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash = 'lazy-expired'")
        .first<number>("count"),
    ).toBe(0);
  });

  it("lists machine types for an authenticated operator", async () => {
    const { app, providers } = harness();
    const unauthenticated = await appRequest(app, "/machine-types");
    expect(unauthenticated.status).toBe(401);

    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json<ListMachineTypesResponse>()).toEqual({
      machineTypes: await providers.listMachineTypes(),
    });
  });

  it("creates workspaces without an SSH key and normalizes blank keys to absence", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);

    for (const sshPublicKey of [undefined, "", " \t\n "]) {
      const response = await appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          machineTypeId: "small",
          ...(sshPublicKey === undefined ? {} : { sshPublicKey }),
        }),
      });

      expect(response.status).toBe(201);
      const { workspace } = await response.json<WorkspaceResponse>();
      const userData = providers.userData.get(workspace.id);
      expect(userData).toBeDefined();
      expect(userData).not.toContain("ssh_authorized_keys");
      expect(userData).not.toContain("SSH_PUBLIC_KEY");
      expect(userData).toContain(": >/var/lib/blitz/authorized_key");
      expect(userData).toContain(
        "src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly",
      );
      expect(providers.sshPublicKeys.get(workspace.id)).toBeUndefined();
    }
    expect(providers.createCalls).toBe(3);
  });

  it("trims an SSH public key before passing it downstream", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const sshPublicKey = "ssh-ed25519 AAAAC3Nzatest caller";
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", sshPublicKey: ` \t${sshPublicKey}\n ` }),
    });

    expect(response.status).toBe(201);
    const { workspace } = await response.json<WorkspaceResponse>();
    expect(providers.sshPublicKeys.get(workspace.id)).toBe(sshPublicKey);
    expect(providers.userData.get(workspace.id)).toContain(
      `readonly SSH_PUBLIC_KEY='${sshPublicKey}'`,
    );
  });

  it("keeps SSH public key validation strict for a provided nonempty value", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", sshPublicKey: "not-a-key" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sshPublicKey must be an SSH public key",
      retryAction: null,
    });
    expect(providers.createCalls).toBe(0);
  });

  it("filters deprecated Hetzner machine types and locations from the API response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            name: "cx22",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: {
              announced: "2025-10-16T06:00:00Z",
              unavailable_after: "2025-12-31T23:59:59Z",
            },
            locations: [{ name: "fsn1", available: true, deprecation: null }],
          },
          {
            name: "cpx22",
            cores: 2,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              {
                name: "fsn1",
                available: true,
                deprecation: {
                  announced: "2026-01-01T00:00:00Z",
                  unavailable_after: "2026-06-01T00:00:00Z",
                },
              },
              { name: "nbg1", available: true, deprecation: null },
            ],
          },
          {
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "fsn1", available: true, deprecation: null }],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token");
    const app = appWithProviders(provider, provider);
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json<ListMachineTypesResponse>();
    expect(body.machineTypes.map(({ id }) => id)).toEqual(["cpx22@nbg1", "cx23@fsn1"]);
  });

  it("excludes Hetzner machine types with no currently available placement", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            id: 104,
            name: "cx22",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [
              { id: 1, name: "fsn1", available: false, deprecation: null },
              { id: 2, name: "nbg1", available: false, deprecation: null },
            ],
          },
          {
            id: 105,
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [],
          },
          {
            id: 106,
            name: "cpx22",
            cores: 2,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              { id: 2, name: "nbg1", available: true, deprecation: null },
            ],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token");

    expect((await provider.listMachineTypes()).map(({ id }) => id)).toEqual([
      "cpx22@nbg1",
    ]);
  });

  it("maps numeric Hetzner type IDs back to names in surfaced provider errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          server_types: [
            {
              id: 104,
              name: "cx22",
              cores: 2,
              memory: 4,
              disk: 40,
              architecture: "x86",
              deprecation: null,
              locations: [
                { id: 1, name: "fsn1", available: true, deprecation: null },
              ],
            },
          ],
          meta: { pagination: { next_page: null } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_input", message: "server type 104 is deprecated" } },
          { status: 422 },
        ),
      );
    const provider = new HetznerProvider("test-token");
    await provider.listMachineTypes();

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow("server type 104 (cx22) is deprecated");
  });

  it("resolves numeric Hetzner type IDs for direct creates without a warm cache", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_input", message: "server type 104 is deprecated" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          server_type: {
            id: 104,
            name: "cx22",
          },
        }),
      );
    const provider = new HetznerProvider("test-token");

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow("server type 104 (cx22) is deprecated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.hetzner.cloud/v1/server_types/104",
    );
  });

  it("does not guess a requested Hetzner type name for an unrelated numeric ID", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_input", message: "server type 105 is unavailable" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const provider = new HetznerProvider("test-token");

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow(/^server type 105 is unavailable$/u);
  });

  it("includes the provider rejection message in the workspace error view", async () => {
    const { app, providers } = harness();
    providers.onCreate = async () => {
      throw new Error("server type 104 is deprecated");
    };
    const cookie = await operatorSession(app);
    const created = await createWorkspace(app, cookie);

    const response = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    const body = await response.json<PollResponse>();

    expect(created.phase).toBe("error");
    expect(body.workspaces[0]?.error).toBe(
      "provider operation failed: server type 104 is deprecated",
    );
  });

  it("enforces the default 10-workspace per-principal concurrent quota", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    for (let index = 0; index < 10; index += 1) {
      expect((await createWorkspace(app, cookie)).phase).toBe("creating");
    }

    const rejected = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
      }),
    });

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error:
        "concurrent workspace quota of 10 reached; destroy an existing workspace before creating another",
      retryAction: null,
    });
    expect(providers.createCalls).toBe(10);
  });

  it("honors MAX_CONCURRENT_WORKSPACES and counts every non-destroyed lifecycle state", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const now = Date.now();
    for (const [index, phase] of ["creating", "ready", "destroying", "error"].entries()) {
      await env.DB
        .prepare(
          `INSERT INTO workspaces
           (id, owner_id, phase, revision, created_at, updated_at)
           VALUES (?1, 'operator', ?2, 1, ?3, ?3)`,
        )
        .bind(`quota-${index}`, phase, now)
        .run();
    }
    await env.DB
      .prepare(
        `INSERT INTO workspaces
         (id, owner_id, phase, revision, created_at, updated_at)
         VALUES ('old-tombstone', 'operator', 'destroyed', 1, ?1, ?1)`,
      )
      .bind(now)
      .run();
    const request = () =>
      appRequest(
        app,
        "/workspaces",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            machineTypeId: "small",
            sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
          }),
        },
        { MAX_CONCURRENT_WORKSPACES: "4" },
      );

    const rejected = await request();
    expect(rejected.status).toBe(409);
    expect(providers.createCalls).toBe(0);

    await env.DB
      .prepare("UPDATE workspaces SET phase = 'destroyed' WHERE phase = 'error'")
      .run();
    expect((await request()).status).toBe(201);
    expect(providers.createCalls).toBe(1);
  });

  it("atomically enforces concurrent quota requests without leaking a workspace row", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const request = () =>
      appRequest(
        app,
        "/workspaces",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            machineTypeId: "small",
            sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
          }),
        },
        { MAX_CONCURRENT_WORKSPACES: "1" },
      );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(providers.createCalls).toBe(1);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE owner_id = 'operator'")
        .first<number>("count"),
    ).toBe(1);
  });

  it("scopes the concurrent workspace quota to the authenticated principal", async () => {
    const { app, providers } = harness();
    const operatorCookie = await operatorSession(app);
    expect(
      (
        await appRequest(
          app,
          "/workspaces",
          {
            method: "POST",
            headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
            body: JSON.stringify({
              machineTypeId: "small",
              sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
            }),
          },
          { MAX_CONCURRENT_WORKSPACES: "1" },
        )
      ).status,
    ).toBe(201);

    const secondToken = "second-principal-session";
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO principals (id, unix_name, harnesses)
           VALUES ('second-principal', 'second', '[]')`,
        ),
      env.DB
        .prepare(
          `INSERT INTO sessions (token_hash, principal_id, created_at, expires_at)
           VALUES (?1, 'second-principal', ?2, ?3)`,
        )
        .bind(await hashSecret(secondToken), Date.now(), Date.now() + 60_000),
    ]);

    const second = await appRequest(
      app,
      "/workspaces",
      {
        method: "POST",
        headers: {
          Cookie: `blitz_session=${secondToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          machineTypeId: "small",
          sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        }),
      },
      { MAX_CONCURRENT_WORKSPACES: "1" },
    );

    expect(second.status).toBe(201);
    expect(providers.createCalls).toBe(2);
    expect(
      await env.DB
        .prepare(
          `SELECT COUNT(DISTINCT owner_id) AS count FROM workspaces
           WHERE phase <> 'destroyed'`,
        )
        .first<number>("count"),
    ).toBe(2);
  });

  it("rejects UTF-8 userData over the provider limit before creating a VM", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const callerUserData = "🙂".repeat(8_000);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        userData: callerUserData,
      }),
    });

    expect(response.status).toBe(413);
    const body = await response.json<{ error: string; retryAction: null }>();
    expect(body.retryAction).toBeNull();
    expect(body.error).toMatch(
      /^userData exceeds the provider limit: caller UTF-8 bytes 32000 \+ generated bootstrap bytes \d+ = \d+ > 32768$/u,
    );
    expect(providers.createCalls).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(0);
    expect(new HetznerProvider("test-token").capabilities()).toEqual({
      volumes: true,
      maxUserDataBytes: 32 * 1024,
    });
  });

  it("accepts exactly the request-specific Hetzner UTF-8 userData budget", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const sshPublicKey = "ssh-ed25519 AAAAC3Nzatest caller";
    const sampleUserData = buildUserData(
      sshPublicKey,
      `https://cp.example/workspaces/${"0".repeat(36)}/phone-home/${"a".repeat(43)}`,
      env.BOX_IMAGE_REF,
      "a",
      env.BOX_IMAGE_TAG,
      env.BOX_IMAGE_SHA256,
    );
    const generatedBytes = new TextEncoder().encode(sampleUserData).byteLength - 1;
    const exactCallerBytes = 32 * 1024 - generatedBytes;
    expect(exactCallerBytes).toBeGreaterThan(0);

    const request = (userData: string) =>
      appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", sshPublicKey, userData }),
      });
    const accepted = await request("a".repeat(exactCallerBytes));

    expect(accepted.status).toBe(201);
    expect(providers.createCalls).toBe(1);
    const [createdUserData] = providers.userData.values();
    expect(new TextEncoder().encode(createdUserData).byteLength).toBe(32 * 1024);

    const rejected = await request("a".repeat(exactCallerBytes + 1));
    expect(rejected.status).toBe(413);
    expect(providers.createCalls).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(1);
  });

  it("rejects a wrong phone_home token and rejects the capability's second use", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);

    const wrong = await app.request(
      `${callback}wrong`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(wrong.status).toBe(401);

    const first = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const second = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it("records a bootstrap failure with the exact workspace error message", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);

    const failure = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          bootstrap_error: "docker pull exhausted retries",
        }),
      },
      { DB: env.DB },
    );
    expect(failure.status).toBe(204);

    const response = await appRequest(app, "/workspaces", {
      headers: { Cookie: cookie },
    });
    const body = await response.json<PollResponse>();
    expect(body.workspaces[0]).toMatchObject({
      id: workspace.id,
      phase: "error",
      error: "bootstrap failed: docker pull exhausted retries",
    });
  });

  it("consumes a valid bootstrap failure capability before later success or reuse", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const failureRequest = () =>
      app.request(
        callback,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ bootstrap_error: "apt install failed" }),
        },
        { DB: env.DB },
      );

    expect((await failureRequest()).status).toBe(204);
    const laterSuccess = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const reusedFailure = await failureRequest();

    expect(laterSuccess.status).toBe(409);
    expect(reusedFailure.status).toBe(409);
    expect(
      await env.DB
        .prepare(
          `SELECT phase, error, phone_home_hash, phone_home_used
           FROM workspaces WHERE id = ?1`,
        )
        .bind(workspace.id)
        .first(),
    ).toEqual({
      phase: "error",
      error: "bootstrap failed: apt install failed",
      phone_home_hash: null,
      phone_home_used: 1,
    });
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM boxes WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<number>("count"),
    ).toBe(0);
  });

  it("sanitizes and bounds the stored bootstrap failure shown to operators", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const prefix = "bootstrap failed: ";
    const sanitizedDetail = `disk full retry ${"x".repeat(2_000)}`;

    const failure = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          bootstrap_error: `disk\u0000full\r\nretry\t${"x".repeat(2_000)}`,
        }),
      },
      { DB: env.DB },
    );
    expect(failure.status).toBe(204);

    const response = await appRequest(app, "/workspaces", {
      headers: { Cookie: cookie },
    });
    const error = (await response.json<PollResponse>()).workspaces[0]?.error;
    expect(error).toBe(prefix + sanitizedDetail.slice(0, 1_024 - prefix.length));
    expect(error).toHaveLength(1_024);
    expect(error).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("rejects a box A token acting as box B in the registry", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    const response = await appRequest(app, `/boxes/${boxB.box_id}/broker`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${boxA.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: "broker-b.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbrokerb",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects broker box A pulling broker box B's slice", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    for (const [box, host] of [
      [boxA, "broker-a.example"],
      [boxB, "broker-b.example"],
    ] as const) {
      const enrollment = await appRequest(app, `/boxes/${box.box_id}/broker`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${box.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host,
          port: 22,
          sshHostPublicKey: "ssh-ed25519 AAAAbroker",
        }),
      });
      expect(enrollment.status).toBe(204);
    }
    const response = await appRequest(app, `/boxes/${boxB.box_id}/feed`, {
      headers: { Authorization: `Bearer ${boxA.access_token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a refresh token after it has rotated away", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const box = await enrollBox(app, cookie);
    const refresh = () =>
      appRequest(app, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: box.refresh_token,
        }),
      });

    expect((await refresh()).status).toBe(200);
    const rotatedAway = await refresh();
    expect(rotatedAway.status).toBe(400);
    expect(await rotatedAway.json()).toEqual({ error: "invalid_grant" });
  });

  it("keeps destroyed terminal and returns the same tombstone", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const first = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = await first.json<WorkspaceResponse>();
    const second = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(await second.json()).toEqual(tombstone);
    expect(tombstone.workspace.phase).toBe("destroyed");
    expect(providers.destroyCalls).toBe(1);
  });

  it("runs create → phone_home → ready → destroy → tombstone with strictly increasing revisions", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const revisions: number[] = [];
    providers.onCreate = async (id) => {
      const revision = await env.DB
        .prepare("SELECT revision FROM workspaces WHERE id = ?1")
        .bind(id)
        .first<number>("revision");
      if (revision !== null) revisions.push(revision);
    };
    providers.onDestroy = async (id) => {
      const revision = await env.DB
        .prepare("SELECT revision FROM workspaces WHERE id = ?1")
        .bind(id)
        .first<number>("revision");
      if (revision !== null) revisions.push(revision);
    };

    const volumeResponse = await appRequest(app, "/volumes", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "state", sizeGb: 20, location: "test" }),
    });
    const volume = await volumeResponse.json<{ volume: { id: string } }>();
    const creating = await createWorkspace(app, cookie, volume.volume.id);
    revisions.push(creating.revision);
    expect(creating.phase).toBe("creating");

    const callback = phoneHomeUrl(providers, creating.id);
    const phoneHome = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(phoneHome.status).toBe(200);
    const credential = await phoneHome.json<{ access_token: string; refresh_token: string }>();
    expect(credential.access_token).not.toBe(credential.refresh_token);

    const poll = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    const ready = (await poll.json<PollResponse>()).workspaces[0];
    expect(ready?.phase).toBe("ready");
    if (ready === undefined) throw new Error("workspace missing from poll");
    revisions.push(ready.revision);

    const destroy = await appRequest(app, `/workspaces/${creating.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = (await destroy.json<WorkspaceResponse>()).workspace;
    revisions.push(tombstone.revision);
    expect(tombstone.phase).toBe("destroyed");
    expect(tombstone.ssh).toBeNull();
    expect(tombstone.volumeId).toBe(volume.volume.id);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect(providers.detachCalls).toBe(1);
    expect(providers.volumes.get(volume.volume.id)?.status).toBe("available");
  });

  it("assigns workspace keys to the least-loaded broker and serves ETag/304", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const broker = await enrollBox(app, cookie);
    expect(
      (
        await appRequest(app, `/boxes/${broker.box_id}/broker`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${broker.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host: "broker.example",
            port: 22,
            sshHostPublicKey: "ssh-ed25519 AAAAbroker",
          }),
        })
      ).status,
    ).toBe(204);

    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const ready = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const box = await ready.json<{ box_id: string; access_token: string }>();
    const registration = await appRequest(app, `/boxes/${box.box_id}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${box.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keys: [
          { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
          { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
        ],
      }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json<RegisterKeysResponse>()).toEqual({
      memberUnixName: "operator",
      broker: {
        host: "broker.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbroker",
      },
    });

    const feed = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(feed.status).toBe(200);
    const etag = feed.headers.get("etag");
    const body = await feed.json<FeedResponse>();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      unixName: "operator",
      harnesses: ["claude", "codex"],
    });
    expect(body.members[0]?.keys).toEqual(
      expect.arrayContaining([
        { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
        { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
      ]),
    );
    if (etag === null) throw new Error("feed ETag missing");
    const notModified = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: {
        Authorization: `Bearer ${broker.access_token}`,
        "If-None-Match": etag,
      },
    });
    expect(notModified.status).toBe(304);

    const removed = await appRequest(app, `/boxes/${broker.box_id}/broker`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(removed.status).toBe(204);
    const assignment = await env.DB
      .prepare("SELECT broker_box_id FROM boxes WHERE id = ?1")
      .bind(box.box_id)
      .first<string>("broker_box_id");
    expect(assignment).toBeNull();
  });

  it("sweeps stale creation to error and completes orphaned destroy work", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await env.DB
      .prepare("UPDATE workspaces SET updated_at = 0 WHERE id = ?1")
      .bind(workspace.id)
      .run();
    const runtime = testRuntime(providers);
    expect(await runInvariantSweep(runtime, 2 * 60 * 60 * 1000)).toBe(1);
    const errored = await env.DB
      .prepare("SELECT phase, revision FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<{ phase: string; revision: number }>();
    expect(errored).toEqual({ phase: "error", revision: 3 });

    await env.DB
      .prepare("UPDATE workspaces SET phase = 'destroying', revision = revision + 1 WHERE id = ?1")
      .bind(workspace.id)
      .run();
    expect(await runOrphanSweep(runtime)).toBe(1);
    const destroyed = await env.DB
      .prepare("SELECT phase, revision FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<{ phase: string; revision: number }>();
    expect(destroyed).toEqual({ phase: "destroyed", revision: 5 });

    await env.DB
      .prepare(
        `INSERT INTO workspaces
         (id, owner_id, phase, revision, created_at, updated_at)
         VALUES ('scheduled-stale', 'operator', 'creating', 1, 0, 0)`,
      )
      .run();
    const executionContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }),
      env as never,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(
      await env.DB
        .prepare("SELECT phase FROM workspaces WHERE id = 'scheduled-stale'")
        .first<string>("phase"),
    ).toBe("error");

    let scheduled: Promise<unknown> | undefined;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingRuntime = {
      ...runtime,
      db: {
        rawSQL() {
          return {
            async run(): Promise<never> {
              throw new Error("expected lazy sweep failure");
            },
          };
        },
        rawSQLTransaction() {
          return { async run(): Promise<never> { throw new Error("unexpected"); } };
        },
      },
      waitUntil(promise: Promise<unknown>) {
        scheduled = promise;
      },
    };
    const nextLazyWindow = Date.now() + LAZY_SWEEP_INTERVAL_MS;
    vi.spyOn(Date, "now").mockReturnValue(nextLazyWindow);
    expect(() => maybeScheduleLazySweep(failingRuntime, "/workspaces")).not.toThrow();
    await scheduled;
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("lazy control-plane sweep failed"),
    );
  });
});
