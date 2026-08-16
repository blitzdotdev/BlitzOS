import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { OPERATOR_KEY, operatorSession, resetDatabase } from "./helpers.js";

const DYNAMIC_TOKEN = "dynamic-host-token-0123456789012345";
const PINNED_TOKEN = "pinned-host-token-012345678901234567";

function dynamicHosts(): string {
  return JSON.stringify([
    { name: "home", tokenVar: "MICROVM_DYNAMIC_TOKEN", dynamic: true },
  ]);
}

function pinnedHosts(url = "https://pinned.example"): string {
  return JSON.stringify([
    { name: "prod", url, tokenVar: "MICROVM_PINNED_TOKEN" },
  ]);
}

function bindings(microvmHosts: string): Record<string, unknown> {
  return {
    ...env,
    MICROVM_HOSTS: microvmHosts,
    MICROVM_DYNAMIC_TOKEN: DYNAMIC_TOKEN,
    MICROVM_PINNED_TOKEN: PINNED_TOKEN,
    HETZNER_API_TOKEN: "test-only-hetzner-token",
    JWT_SECRET_MAIN: "test-only-jwt-secret",
    OPERATOR_API_KEY: OPERATOR_KEY,
    RESPOND_WITH_ERRORS: false,
    RESPOND_WITH_QUERY_LOG: false,
  };
}

async function workerRequest(
  microvmHosts: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const executionContext = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://cp.example${path}`, init),
    bindings(microvmHosts) as never,
    executionContext,
  );
  await waitOnExecutionContext(executionContext);
  return response;
}

describe("microVM host registration", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects absent and incorrect host bearer tokens", async () => {
    for (const authorization of [undefined, "Bearer wrong-host-token"]) {
      const response = await workerRequest(
        dynamicHosts(),
        "/hosts/home/register",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorization === undefined ? {} : { Authorization: authorization }),
          },
          body: JSON.stringify({ url: "https://home.trycloudflare.com" }),
        },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
    }
  });

  it("returns 404 for an unconfigured host name", async () => {
    const response = await workerRequest(
      dynamicHosts(),
      "/hosts/unknown/register",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DYNAMIC_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://home.trycloudflare.com" }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "microVM host not found" });
  });

  it("returns 409 when a pinned host attempts to register", async () => {
    const response = await workerRequest(
      pinnedHosts(),
      "/hosts/prod/register",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PINNED_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://other.example" }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "pinned microVM hosts cannot register",
    });
  });

  it("checks host, bearer, and pinned status before parsing malformed JSON", async () => {
    const cases = [
      {
        name: "unknown host",
        hosts: dynamicHosts(),
        path: "/hosts/unknown/register",
        authorization: `Bearer ${DYNAMIC_TOKEN}`,
        status: 404,
        error: "microVM host not found",
      },
      {
        name: "missing bearer",
        hosts: dynamicHosts(),
        path: "/hosts/home/register",
        authorization: undefined,
        status: 401,
        error: "unauthorized",
      },
      {
        name: "wrong bearer",
        hosts: dynamicHosts(),
        path: "/hosts/home/register",
        authorization: "Bearer wrong-host-token",
        status: 401,
        error: "unauthorized",
      },
      {
        name: "authenticated pinned host",
        hosts: pinnedHosts(),
        path: "/hosts/prod/register",
        authorization: `Bearer ${PINNED_TOKEN}`,
        status: 409,
        error: "pinned microVM hosts cannot register",
      },
      {
        name: "authenticated dynamic host",
        hosts: dynamicHosts(),
        path: "/hosts/home/register",
        authorization: `Bearer ${DYNAMIC_TOKEN}`,
        status: 400,
        error: "invalid JSON",
      },
    ];

    for (const testCase of cases) {
      const response = await workerRequest(testCase.hosts, testCase.path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(testCase.authorization === undefined
            ? {}
            : { Authorization: testCase.authorization }),
        },
        body: '{"url":',
      });
      expect(response.status, testCase.name).toBe(testCase.status);
      await expect(response.json(), testCase.name).resolves.toMatchObject({
        error: testCase.error,
      });
    }
  });

  it("requires an exact object containing only url", async () => {
    for (const body of [
      null,
      [],
      {},
      { url: "https://home.trycloudflare.com", extra: true },
    ]) {
      const response = await workerRequest(
        dynamicHosts(),
        "/hosts/home/register",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DYNAMIC_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("accepts only a credential-free HTTPS URL without query or fragment", async () => {
    for (const url of [
      "not-a-url",
      "http://home.trycloudflare.com",
      "https://user:pass@home.trycloudflare.com",
      "https://home.trycloudflare.com?query=1",
      "https://home.trycloudflare.com/#fragment",
    ]) {
      const response = await workerRequest(
        dynamicHosts(),
        "/hosts/home/register",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DYNAMIC_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
        },
      );
      expect(response.status, url).toBe(400);
    }
  });

  it("upserts a dynamic URL and logs old-to-new only when the URL changes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const register = (url: string) => workerRequest(
      dynamicHosts(),
      "/hosts/home/register",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DYNAMIC_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      },
    );

    expect((await register("https://first.trycloudflare.com/")).status).toBe(204);
    expect((await register("https://first.trycloudflare.com")).status).toBe(204);
    expect((await register("https://second.trycloudflare.com")).status).toBe(204);

    await expect(
      env.DB
        .prepare("SELECT name, url, source FROM microvm_hosts WHERE name = 'home'")
        .first(),
    ).resolves.toEqual({
      name: "home",
      url: "https://second.trycloudflare.com",
      source: "registered",
    });
    const changes = log.mock.calls.flatMap(([value]) => {
      if (typeof value !== "string" || !value.startsWith("{")) return [];
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed.message === "microVM host URL changed" ? [parsed] : [];
    });
    expect(changes).toEqual([
      {
        message: "microVM host URL changed",
        host: "home",
        old_url: null,
        new_url: "https://first.trycloudflare.com",
      },
      {
        message: "microVM host URL changed",
        host: "home",
        old_url: "https://first.trycloudflare.com",
        new_url: "https://second.trycloudflare.com",
      },
    ]);
  });

  it("refreshes pinned rows on each Worker request without touching registrations", async () => {
    expect((await workerRequest(pinnedHosts("https://one.example"), "/missing")).status).toBe(404);
    expect((await workerRequest(pinnedHosts("https://two.example"), "/missing")).status).toBe(404);
    await expect(
      env.DB
        .prepare("SELECT url, source FROM microvm_hosts WHERE name = 'prod'")
        .first(),
    ).resolves.toEqual({ url: "https://two.example", source: "static" });

    expect((await workerRequest(dynamicHosts(), "/hosts/home/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DYNAMIC_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://home.trycloudflare.com" }),
    })).status).toBe(204);
    expect((await workerRequest(dynamicHosts(), "/missing")).status).toBe(404);
    await expect(
      env.DB
        .prepare("SELECT url, source FROM microvm_hosts WHERE name = 'home'")
        .first(),
    ).resolves.toEqual({
      url: "https://home.trycloudflare.com",
      source: "registered",
    });
  });

  it("returns 503 and removes the provisional row when create targets an unregistered host", async () => {
    const cookie = await operatorSession();
    const response = await workerRequest(dynamicHosts(), "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "mv-2c2g@home" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "dynamic microVM host home is unavailable; waiting for registration",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).resolves.toBe(0);
  });

  it("returns 503 when a dynamic host registration disappears before webapp access", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        vm_id: "vm-1-abcdef123456",
        host_ip: "192.0.2.10",
        ssh_port: 22_001,
      }, { status: 201 }),
    );
    expect((await workerRequest(dynamicHosts(), "/hosts/home/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DYNAMIC_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://home.trycloudflare.com" }),
    })).status).toBe(204);
    const cookie = await operatorSession();
    const created = await workerRequest(dynamicHosts(), "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "mv-2c2g@home" }),
    });
    const workspace = await created.json<{ workspace: { id: string } }>();
    await env.DB.prepare("DELETE FROM microvm_hosts WHERE name = 'home'").run();

    const response = await workerRequest(
      dynamicHosts(),
      `/workspaces/${workspace.workspace.id}/webapp/7445/ports`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "dynamic microVM host home is unavailable; waiting for registration",
    });
  });
});
