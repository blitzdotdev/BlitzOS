import type {
  CredentialLeaseView,
  ConnectionView,
  MintResult,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { $DatabaseRawImpl } from "teenybase/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLeaseSweep } from "../core/index.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  testRuntime,
  userSession,
  type BoxCredential,
} from "./helpers.js";

const ROOT = "test-only-static-root-value";
const GITHUB_TOKEN = "test-only-github-installation-token";

function encodePem(label: string, value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

function derElement(
  value: Uint8Array,
  offset: number,
): { tag: number; contentStart: number; contentEnd: number; next: number } {
  const tag = value[offset];
  const lengthByte = value[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new Error("invalid DER");
  let length = lengthByte;
  let contentStart = offset + 2;
  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0) throw new Error("invalid DER");
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      const byte = value[contentStart + index];
      if (byte === undefined) throw new Error("invalid DER");
      length = length * 256 + byte;
    }
    contentStart += lengthBytes;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > value.byteLength) throw new Error("invalid DER");
  return { tag, contentStart, contentEnd, next: contentEnd };
}

function pkcs1FromPkcs8(value: Uint8Array): Uint8Array {
  const outer = derElement(value, 0);
  const version = derElement(value, outer.contentStart);
  const algorithm = derElement(value, version.next);
  const privateKey = derElement(value, algorithm.next);
  if (
    outer.tag !== 0x30 ||
    version.tag !== 0x02 ||
    algorithm.tag !== 0x30 ||
    privateKey.tag !== 0x04
  ) {
    throw new Error("unexpected PKCS#8 structure");
  }
  return value.slice(privateKey.contentStart, privateKey.contentEnd);
}

function decodeBase64Url(value: string): Uint8Array {
  const encoded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function githubKeyPair(): Promise<{
  privatePem: string;
  pkcs1Pem: string;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    privatePem: encodePem("PRIVATE KEY", privateKey),
    pkcs1Pem: encodePem("RSA PRIVATE KEY", pkcs1FromPkcs8(privateKey)),
    publicKey: pair.publicKey,
  };
}

async function createReadyWorkspace(
  app: ReturnType<typeof harness>["app"],
  providers: ReturnType<typeof harness>["providers"],
  cookie: string,
  integrations: Record<string, Record<string, unknown>> | null = null,
): Promise<{ workspace: WorkspaceView; box: BoxCredential }> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      machineTypeId: "small",
      sshPublicKey: "ssh-ed25519 AAAAC3Nzatest credentials",
      ...(integrations === null ? {} : { manifest: { integrations } }),
    }),
  });
  expect(created.status).toBe(201);
  const { workspace } = await created.json<{ workspace: WorkspaceView }>();
  const callback = new URL(phoneHomeUrl(providers, workspace.id));
  const enrolled = await appRequest(app, callback.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostPublicKeys: ["ssh-ed25519 AAAAC3Nzatest host"],
    }),
  });
  expect(enrolled.status).toBe(200);
  return { workspace, box: await enrolled.json<BoxCredential>() };
}

async function putStaticConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name: string,
  options: {
    root?: string;
    scopes?: string[];
    placements?: Record<string, unknown>[];
    owners?: string[];
  } = {},
): Promise<void> {
  const response = await appRequest(app, `/connections/${name}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "hetzner",
      kind: "static",
      custody: "cp",
      root: options.root ?? ROOT,
      config: {
        default_scopes: options.scopes ?? [],
        placements: options.placements ?? [
          { kind: "env", name: "HCLOUD_TOKEN" },
        ],
      },
      ...(options.owners === undefined
        ? {}
        : { usable_by: { owners: options.owners } }),
    }),
  });
  expect(response.status).toBe(204);
}

async function putProxyConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name: string,
  options: {
    baseUrl?: string;
    tokenHeader?: string;
    tokenPrefix?: string;
  } = {},
): Promise<void> {
  const response = await appRequest(app, `/connections/${name}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "static-vendor",
      kind: "static",
      root: ROOT,
      config: {
        placements: [
          { kind: "env", name: "VENDOR_LEASE_TOKEN" },
          { kind: "env", name: "VENDOR_BASE_URL", fill: "proxy-url" },
        ],
        proxy: {
          base_url: options.baseUrl ?? "https://vendor.example/api",
          ...(options.tokenHeader === undefined
            ? {}
            : { token_header: options.tokenHeader }),
          ...(options.tokenPrefix === undefined
            ? {}
            : { token_prefix: options.tokenPrefix }),
        },
      },
    }),
  });
  expect(response.status).toBe(204);
}

function proxyHandle(result: MintResult): {
  leaseId: string;
  proxyUrl: string;
  token: string;
} {
  const tokenPlacement = result.placements.find(
    (placement) =>
      placement.kind === "env" && placement.name === "VENDOR_LEASE_TOKEN",
  );
  const urlPlacement = result.placements.find(
    (placement) =>
      placement.kind === "env" && placement.name === "VENDOR_BASE_URL",
  );
  if (
    tokenPlacement?.kind !== "env" ||
    urlPlacement?.kind !== "env"
  ) {
    throw new Error("proxy placements are missing");
  }
  const leaseId = new URL(urlPlacement.value).pathname.split("/").at(-1);
  if (leaseId === undefined || leaseId.length === 0) {
    throw new Error("proxy lease id is missing");
  }
  return {
    leaseId,
    proxyUrl: urlPlacement.value,
    token: tokenPlacement.value,
  };
}

async function putGithubConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  root: string,
): Promise<Response> {
  return appRequest(app, "/connections/github", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "github",
      kind: "app-jwt",
      custody: "cp",
      root,
      config: {
        app_id: "123456",
        installation_id: "987654",
        repositories: ["requested-repo"],
        permissions: { contents: "write" },
      },
    }),
  });
}

async function mint(
  app: ReturnType<typeof harness>["app"],
  workspaceId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return appRequest(app, `/workspaces/${workspaceId}/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function principalSession(id: string): Promise<string> {
  return userSession(id);
}

describe("credential control plane", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs a bounded RS256 app JWT and records GitHub's granted scope truth", async () => {
    const { privatePem, publicKey } = await githubKeyPair();
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      github: { scopes: ["requested:scope"] },
    });
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    let authorization = "";
    let requestBody = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe(
          "https://api.github.com/app/installations/987654/access_tokens",
        );
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("accept")).toBe("application/vnd.github+json");
        authorization = headers.get("authorization") ?? "";
        requestBody = String(init?.body);
        return Response.json({
          token: GITHUB_TOKEN,
          expires_at: expiresAt,
          repositories: [{ name: "granted-repo" }],
          permissions: { contents: "read", issues: "write" },
        });
      },
    );
    const startedAt = Math.floor(Date.now() / 1000);

    const response = await mint(app, workspace.id, box.access_token, {
      integration: "github",
      scopes: ["requested:scope"],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(requestBody)).toEqual({
      repositories: ["requested-repo"],
      permissions: { contents: "write" },
    });
    const result = await response.json<MintResult>();
    expect(result).toEqual({
      integration: "github",
      mode: "inject",
      placements: [
        { kind: "env", name: "GH_TOKEN", value: GITHUB_TOKEN },
        { kind: "env", name: "GITHUB_TOKEN", value: GITHUB_TOKEN },
      ],
      expiresAt: Date.parse(expiresAt),
      grantedScopes: ["repo:granted-repo", "contents:read", "issues:write"],
    });

    const jwt = authorization.replace(/^Bearer\s+/u, "");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw new Error("github app JWT was malformed");
    }
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    ) as { iat: number; exp: number; iss: string };
    const finishedAt = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBeGreaterThanOrEqual(startedAt - 61);
    expect(payload.iat).toBeLessThanOrEqual(finishedAt - 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
    expect(payload.exp).toBeGreaterThan(finishedAt);
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decodeBase64Url(encodedSignature),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      ),
    ).toBe(true);
    const lease = await env.DB
      .prepare("SELECT scopes FROM credential_leases WHERE workspace_id = ?1")
      .bind(workspace.id)
      .first<{ scopes: string }>();
    expect(JSON.parse(lease?.scopes ?? "null")).toEqual([
      "repo:granted-repo",
      "contents:read",
      "issues:write",
    ]);
  });

  it("rejects a PKCS#1-labeled GitHub App root with the conversion command", async () => {
    const { pkcs1Pem } = await githubKeyPair();
    const { app } = harness();
    const cookie = await operatorSession(app);

    const response = await putGithubConnection(app, cookie, pkcs1Pem);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "private key must be a PKCS#8 PEM; convert PKCS#1 with: openssl pkcs8 -topk8 -nocrypt",
      retryAction: null,
    });
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM connections")
        .first<number>("count"),
    ).toBe(0);
  });

  it("maps a GitHub 401 to a value-free 502 and creates no lease", async () => {
    const { privatePem } = await githubKeyPair();
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      github: {},
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { token: "must-not-escape-vendor-error-body" },
        { status: 401 },
      ),
    );

    const response = await mint(app, workspace.id, box.access_token, {
      integration: "github",
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: "github rejected the app JWT (key or clock)",
      retryAction: null,
    });
    expect(JSON.stringify(body)).not.toContain("must-not-escape-vendor-error-body");
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(0);
  });

  it("stores a static connection and fills inject placement templates at mint", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
      placements: [
        { kind: "env", name: "HCLOUD_TOKEN" },
        { kind: "file", path: "/run/credentials/hcloud", mode: 0o600 },
        { kind: "file", path: "/run/credentials/default" },
        { kind: "unset-env", name: "OLD_HCLOUD_TOKEN" },
      ],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: ["servers:read"] },
    });

    const response = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    expect(result.mode).toBe("inject");
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(result.placements).toEqual([
      { kind: "env", name: "HCLOUD_TOKEN", value: ROOT },
      {
        kind: "file",
        path: "/run/credentials/hcloud",
        mode: 0o600,
        value: ROOT,
      },
      { kind: "file", path: "/run/credentials/default", value: ROOT },
      { kind: "unset-env", name: "OLD_HCLOUD_TOKEN" },
    ]);
    const explicitMode = result.placements[1];
    expect(Object.keys(explicitMode ?? {})).toEqual(["kind", "path", "value", "mode"]);
    expect(explicitMode && "mode" in explicitMode).toBe(true);
    expect(JSON.stringify(explicitMode)).toBe(
      `{"kind":"file","path":"/run/credentials/hcloud","value":"${ROOT}","mode":384}`,
    );
    const omittedMode = result.placements[2];
    expect(Object.keys(omittedMode ?? {})).toEqual(["kind", "path", "value"]);
    expect(omittedMode && "mode" in omittedMode).toBe(false);
    expect(JSON.stringify(omittedMode)).toBe(
      `{"kind":"file","path":"/run/credentials/default","value":"${ROOT}"}`,
    );
    const stored = await env.DB
      .prepare("SELECT config, root_ciphertext FROM connections WHERE scoped_name = ?1")
      .bind("hetzner-prod")
      .first<{ config: string; root_ciphertext: string }>();
    expect(stored?.root_ciphertext).not.toBe(ROOT);
    expect(stored?.config).not.toContain(ROOT);
    expect(
      await env.DB
        .prepare("SELECT user_id FROM credential_leases WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<string>("user_id"),
    ).toBe("operator");
    const mintEvent = await env.DB
      .prepare("SELECT detail FROM credential_events WHERE event = 'minted' ORDER BY id DESC LIMIT 1")
      .first<string>("detail");
    expect(JSON.parse(mintEvent ?? "null")).toMatchObject({
      workspace_id: workspace.id,
      acting_principal: { userId: "operator", membershipId: "personal" },
    });
  });

  it("mints a default-custody proxy token and streams a header-swapped call", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "static-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "static-proxy": {},
    });

    const minted = await mint(app, workspace.id, box.access_token, {
      integration: "static-proxy",
    });

    expect(minted.status).toBe(200);
    const result = await minted.json<MintResult>();
    const handle = proxyHandle(result);
    expect(result).toMatchObject({ integration: "static-proxy", mode: "proxy" });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(handle.proxyUrl).toBe(`https://cp.example/proxy/${handle.leaseId}`);
    expect(handle.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const storedLease = await env.DB
      .prepare(
        `SELECT lease.token_hash, connection.custody
         FROM credential_leases lease
         JOIN connections connection ON connection.id = lease.connection_id
         WHERE lease.id = ?1`,
      )
      .bind(handle.leaseId)
      .first<{ token_hash: string; custody: string }>();
    expect(storedLease?.custody).toBe("proxy");
    expect(storedLease?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(storedLease?.token_hash).not.toContain(handle.token);

    let upstreamBody = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe(
          "https://vendor.example/api/v1/messages?stream=true&limit=2",
        );
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${ROOT}`);
        expect(headers.get("authorization")).not.toContain(handle.token);
        upstreamBody = await new Response(init?.body).text();
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("vendor-"));
              controller.enqueue(encoder.encode("stream"));
              controller.close();
            },
          }),
          {
            status: 201,
            headers: { "x-vendor-response": "streamed" },
          },
        );
      },
    );

    const proxied = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v1/messages?stream=true&limit=2`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: "request-stream",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(upstreamBody).toBe("request-stream");
    expect(proxied.status).toBe(201);
    expect(proxied.headers.get("x-vendor-response")).toBe("streamed");
    expect(await proxied.text()).toBe("vendor-stream");
  });

  it("uses a configured x-api-key header with an empty prefix in both directions", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "x-key-proxy", {
      baseUrl: "https://keys.example",
      tokenHeader: "x-api-key",
      tokenPrefix: "",
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "x-key-proxy": {},
    });
    const minted = await mint(app, workspace.id, box.access_token, {
      integration: "x-key-proxy",
    });
    const handle = proxyHandle(await minted.json<MintResult>());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe("https://keys.example/v2/check?raw=1");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe(ROOT);
        expect(headers.get("authorization")).toBeNull();
        return new Response("x-key-ok");
      },
    );

    const response = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v2/check?raw=1`,
      { headers: { "x-api-key": handle.token } },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("x-key-ok");
  });

  it("never accepts a proxy lease token from the URL path or query", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "url-reject-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "url-reject-proxy": {},
    });
    const minted = await mint(app, workspace.id, box.access_token, {
      integration: "url-reject-proxy",
    });
    const handle = proxyHandle(await minted.json<MintResult>());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("must not be reached"),
    );

    const pathToken = await appRequest(
      app,
      `/proxy/${handle.leaseId}/${handle.token}/v1?also=${handle.token}`,
      { headers: { Authorization: `Bearer ${handle.token}` } },
    );
    const queryToken = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v1?token=${handle.token}`,
      { headers: { Authorization: `Bearer ${handle.token}` } },
    );

    expect(pathToken.status).toBe(401);
    expect(queryToken.status).toBe(401);
    expect(await pathToken.text()).toBe("");
    expect(await queryToken.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns detail-free 401s for revoked and independently expired proxy leases", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "dead-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "dead-proxy": {},
    });
    const firstMint = await mint(app, workspace.id, box.access_token, {
      integration: "dead-proxy",
    });
    const revoked = proxyHandle(await firstMint.json<MintResult>());
    expect(
      (
        await appRequest(app, `/leases/${revoked.leaseId}`, {
          method: "DELETE",
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases WHERE id = ?1")
        .bind(revoked.leaseId)
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });

    const secondMint = await mint(app, workspace.id, box.access_token, {
      integration: "dead-proxy",
    });
    const expired = proxyHandle(await secondMint.json<MintResult>());
    await env.DB
      .prepare("UPDATE credential_leases SET expires_at = ?1 WHERE id = ?2")
      .bind(Date.now() - 1, expired.leaseId)
      .run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("must not be reached"),
    );

    const revokedResponse = await appRequest(
      app,
      `/proxy/${revoked.leaseId}/v1`,
      { headers: { Authorization: `Bearer ${revoked.token}` } },
    );
    const expiredResponse = await appRequest(
      app,
      `/proxy/${expired.leaseId}/v1`,
      { headers: { Authorization: `Bearer ${expired.token}` } },
    );

    expect(revokedResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(await revokedResponse.text()).toBe("");
    expect(await expiredResponse.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a mint outside the manifest and allow-list and writes a value-free event", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
      owners: ["operator"],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: ["servers:read"] },
    });

    const response = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "credential mint exceeds the workspace manifest or integration allow-list",
      request_id: expect.any(String),
    });
    const event = await env.DB
      .prepare(
        "SELECT lease_id, event, detail FROM credential_events ORDER BY id DESC LIMIT 1",
      )
      .first<{ lease_id: string | null; event: string; detail: string }>();
    expect(event?.lease_id).toBeNull();
    expect(event?.event).toBe("denied");
    expect(event?.detail).not.toContain(ROOT);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(0);
  });

  it("deduplicates denied mints, lists the request shape, and approves an actual retry", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: [] },
    });

    const firstDenied = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    const secondDenied = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    const firstBody = await firstDenied.json<{ request_id: string }>();
    const secondBody = await secondDenied.json<{ request_id: string }>();

    expect(firstDenied.status).toBe(403);
    expect(secondDenied.status).toBe(403);
    expect(secondBody.request_id).toBe(firstBody.request_id);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_requests")
        .first<number>("count"),
    ).toBe(1);

    const listed = await appRequest(app, "/requests", {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      requests: [
        {
          id: firstBody.request_id,
          workspace_id: workspace.id,
          connection_name: "hetzner-prod",
          requested_scopes: ["servers:read"],
          requester: { boxId: box.box_id, userId: "operator" },
          created_at: expect.any(Number),
        },
      ],
    });

    const approved = await appRequest(
      app,
      `/requests/${firstBody.request_id}/approve`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    expect(approved.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, resolved_by FROM credential_requests WHERE id = ?1")
        .bind(firstBody.request_id)
        .first(),
    ).toEqual({ state: "approved", resolved_by: "operator" });
    const storedManifest = await env.DB
      .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<string>("manifest");
    expect(JSON.parse(storedManifest ?? "null")).toEqual({
      integrations: { "hetzner-prod": { scopes: ["servers:read"] } },
    });
    const event = await env.DB
      .prepare(
        "SELECT lease_id, event, detail FROM credential_events WHERE event = 'approved'",
      )
      .first<{ lease_id: string | null; event: string; detail: string }>();
    expect(event).toMatchObject({ lease_id: null, event: "approved" });
    expect(JSON.parse(event?.detail ?? "null")).toEqual({
      integration: "hetzner-prod",
      scopes: ["servers:read"],
      workspace_id: workspace.id,
      resolved_by: "operator",
      acting_principal: { userId: "operator", membershipId: "personal" },
    });

    const retried = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    expect(retried.status).toBe(200);
    expect(await retried.json<MintResult>()).toMatchObject({
      integration: "hetzner-prod",
      mode: "inject",
      placements: [{ kind: "env", name: "HCLOUD_TOKEN", value: ROOT }],
    });
  });

  it("denies a pending request without widening the workspace manifest", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: [] },
    });
    const deniedMint = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });
    const { request_id: requestId } = await deniedMint.json<{ request_id: string }>();
    const before = await env.DB
      .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<string>("manifest");

    const denied = await appRequest(app, `/requests/${requestId}/deny`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(denied.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, resolved_by FROM credential_requests WHERE id = ?1")
        .bind(requestId)
        .first(),
    ).toEqual({ state: "denied", resolved_by: "operator" });
    expect(
      await env.DB
        .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
        .bind(workspace.id)
        .first<string>("manifest"),
    ).toBe(before);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_events WHERE event = 'approved'")
        .first<number>("count"),
    ).toBe(0);
    const events = await appRequest(app, `/workspaces/${workspace.id}/credential-events`, {
      headers: { Cookie: cookie },
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          leaseId: null,
          event: "denied",
          detail: expect.objectContaining({
            workspace_id: workspace.id,
            resolution: "denied",
            acting_principal: { userId: "operator", membershipId: "personal" },
          }),
        }),
      ]),
    });
    expect(
      (await mint(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
        scopes: ["servers:write"],
      })).status,
    ).toBe(403);
  });

  it("does not let a non-owner approve another workspace's request", async () => {
    const { app, providers } = harness();
    const operatorCookie = await operatorSession(app);
    const ownerCookie = await principalSession("workspace-owner");
    const strangerCookie = await principalSession("stranger");
    await putStaticConnection(app, operatorCookie, "hetzner-prod", {
      owners: ["workspace-owner"],
    });
    const { workspace, box } = await createReadyWorkspace(
      app,
      providers,
      ownerCookie,
      { "hetzner-prod": { scopes: [] } },
    );
    const deniedMint = await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });
    const { request_id: requestId } = await deniedMint.json<{ request_id: string }>();

    const response = await appRequest(app, `/requests/${requestId}/approve`, {
      method: "POST",
      headers: { Cookie: strangerCookie },
    });

    expect(response.status).toBe(404);
    expect(
      await env.DB
        .prepare("SELECT state FROM credential_requests WHERE id = ?1")
        .bind(requestId)
        .first<string>("state"),
    ).toBe("pending");
    const strangerFeed = await appRequest(app, "/requests?state=pending", {
      headers: { Cookie: strangerCookie },
    });
    expect(await strangerFeed.json()).toEqual({ requests: [] });
  });

  it("files and deduplicates requests for explicitly named missing connections", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {});

    const first = await mint(app, workspace.id, box.access_token, {
      integration: "future-provider",
      scopes: ["repo:read"],
    });
    const second = await mint(app, workspace.id, box.access_token, {
      integration: "future-provider",
      scopes: ["repo:read"],
    });
    const firstBody = await first.json<{ error: string; request_id: string }>();
    const secondBody = await second.json<{ error: string; request_id: string }>();

    expect(first.status).toBe(404);
    expect(firstBody).toEqual({
      error: "integration not found",
      request_id: expect.any(String),
    });
    expect(secondBody.request_id).toBe(firstBody.request_id);
    expect(
      await env.DB
        .prepare(
          `SELECT connection_name, requested_scopes, state
           FROM credential_requests WHERE id = ?1`,
        )
        .bind(firstBody.request_id)
        .first(),
    ).toEqual({
      connection_name: "future-provider",
      requested_scopes: '["repo:read"]',
      state: "pending",
    });
  });

  it("revokes a lease by clearing its token hash in the same state update", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    expect(
      (await mint(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
      })).status,
    ).toBe(200);
    const lease = await env.DB
      .prepare("SELECT id FROM credential_leases LIMIT 1")
      .first<{ id: string }>();
    if (lease === null) throw new Error("mint did not create a lease");
    await env.DB
      .prepare("UPDATE credential_leases SET token_hash = 'test-proxy-hash' WHERE id = ?1")
      .bind(lease.id)
      .run();

    const response = await appRequest(app, `/leases/${lease.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases WHERE id = ?1")
        .bind(lease.id)
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });
  });

  it("destroys a workspace with an active lease while preserving revoked audit", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    expect(
      (await mint(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
      })).status,
    ).toBe(200);

    const response = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM boxes WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM box_token_families WHERE box_id = ?1")
        .bind(box.box_id)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB
        .prepare(
          "SELECT box_id, state FROM credential_leases WHERE workspace_id = ?1",
        )
        .bind(workspace.id)
        .first(),
    ).toEqual({ box_id: null, state: "revoked" });
  });

  it("expires overdue active leases without deleting their audit rows", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });
    await env.DB
      .prepare(
        "UPDATE credential_leases SET expires_at = 10, token_hash = 'overdue-token-hash'",
      )
      .run();

    expect(await runLeaseSweep(testRuntime(providers), 11)).toBe(1);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases")
        .first(),
    ).toEqual({ state: "expired", token_hash: null });
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(1);
  });

  it("returns an array when a sync-style request mints every allowed connection", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      placements: [{ kind: "env", name: "HCLOUD_TOKEN" }],
    });
    await putStaticConnection(app, cookie, "resend-prod", {
      root: "test-only-resend-root",
      placements: [{ kind: "env", name: "RESEND_API_KEY" }],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": {},
      "resend-prod": {},
    });

    void workspace;
    const response = await mint(app, "self", box.access_token, {});

    expect(response.status).toBe(200);
    const result = await response.json<MintResult[]>();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result.map(({ integration, placements }) => [integration, placements[0]])).toEqual([
      ["hetzner-prod", { kind: "env", name: "HCLOUD_TOKEN", value: ROOT }],
      ["resend-prod", { kind: "env", name: "RESEND_API_KEY", value: "test-only-resend-root" }],
    ]);
  });

  it("lists connection status without config, plaintext values, or ciphertext", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");

    const response = await appRequest(app, "/connections", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ connections: ConnectionView[] }>();
    expect(body).toEqual({
      connections: [
        {
          name: "hetzner-prod",
          provider: "hetzner",
          kind: "static",
          custody: "cp",
          status: "active",
          createdBy: "operator",
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain("root_ciphertext");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain('"value"');
  });

  it("deletes a connection as a soft kill switch and revokes its active leases", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    const response = await appRequest(app, "/connections/hetzner-prod", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB
        .prepare(
          "SELECT revoked_at IS NOT NULL AS revoked, root_ciphertext FROM connections WHERE scoped_name = ?1",
        )
        .bind("hetzner-prod")
        .first(),
    ).toEqual({ revoked: 1, root_ciphertext: null });
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases")
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });
  });

  it("lists minted leases through the session-authenticated audit route", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mint(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    const response = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const body = await response.json<{ leases: CredentialLeaseView[] }>();

    expect(response.status).toBe(200);
    expect(body.leases).toHaveLength(1);
    expect(body.leases[0]).toMatchObject({
      workspaceId: workspace.id,
      boxId: box.box_id,
      connection: "hetzner-prod",
      state: "active",
      mode: "inject",
    });
    expect(JSON.stringify(body)).not.toContain(ROOT);
  });

  /** FROZEN box wire: the Go broker baked into the shipped box image decodes
   * POST /workspaces/self/credentials with DisallowUnknownFields. This pins
   * the request body key "integration" and the exact response key set
   * integration/mode/placements/expiresAt so the connection rename can never
   * leak into the box-facing route. */
  it("keeps the frozen box mint wire: body key integration, exact response keys", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": {},
    });

    const response = await mint(app, "self", box.access_token, {
      integration: "hetzner-prod",
    });

    expect(response.status).toBe(200);
    const raw: unknown = JSON.parse(await response.text());
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("mint response was not a JSON object");
    }
    expect(Object.keys(raw).sort()).toEqual([
      "expiresAt",
      "integration",
      "mode",
      "placements",
    ]);
    expect((raw as MintResult).integration).toBe("hetzner-prod");
    const placement = (raw as MintResult).placements[0];
    expect(placement).toEqual({ kind: "env", name: "HCLOUD_TOKEN", value: ROOT });
    expect(Object.keys(placement ?? {})).toEqual(["kind", "name", "value"]);
  });

  it("keeps /integrations as an alias of the canonical /connections routes", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    const put = await appRequest(app, "/integrations/alias-token", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "hetzner",
        kind: "static",
        custody: "cp",
        root: ROOT,
        config: { placements: [{ kind: "env", name: "HCLOUD_TOKEN" }] },
      }),
    });
    expect(put.status).toBe(204);

    const aliasList = await appRequest(app, "/integrations", {
      headers: { Cookie: cookie },
    });
    const canonicalList = await appRequest(app, "/connections", {
      headers: { Cookie: cookie },
    });
    expect(aliasList.status).toBe(200);
    const canonicalBody = await canonicalList.json();
    await expect(aliasList.json()).resolves.toEqual(canonicalBody);
    expect(canonicalBody).toMatchObject({
      connections: [{ name: "alias-token", status: "active" }],
    });

    const remove = await appRequest(app, "/integrations/alias-token", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(remove.status).toBe(204);
  });
});
