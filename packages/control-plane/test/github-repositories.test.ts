import type {
  ListGithubInstallationsResponse,
  ListGithubRepositoriesResponse,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  testConnectSecrets,
} from "./helpers.js";

type Harness = ReturnType<typeof harness>;

async function connectPat(app: Harness["app"], cookie: string, token: string): Promise<void> {
  const response = await appRequest(app, "/connections/grants/github", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ manifestId: "github", token }),
  });
  expect(response.status).toBe(204);
}

async function connectOauth(app: Harness["app"], cookie: string): Promise<void> {
  testConnectSecrets.set("GITHUB_APP_CLIENT_ID", "github-client-id");
  testConnectSecrets.set("GITHUB_APP_CLIENT_SECRET", "github-client-secret");
  const started = await appRequest(app, "/connect/github/start", {
    headers: { Cookie: cookie },
  });
  expect(started.status).toBe(302);
  const authorize = new URL(started.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname)
    .toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.has("scope")).toBe(false);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const state = authorize.searchParams.get("state") ?? "";
  const stateCookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const exchange = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    access_token: "ghu_test-user-token",
    expires_in: 28_800,
    refresh_token: "ghr_test-refresh-token",
    refresh_token_expires_in: 15_897_600,
    scope: "",
    token_type: "bearer",
  }));
  const callback = await appRequest(
    app,
    `/connect/github/callback?code=github-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: stateCookie } },
  );
  exchange.mockRestore();
  expect(callback.status).toBe(302);
}

describe("GitHub installation and repository listings", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an active membership and a GitHub grant", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const fetch = vi.spyOn(globalThis, "fetch");

    for (const path of [
      "/connections/github/installations",
      "/connections/github/repositories",
    ]) {
      const missing = await appRequest(app, path, { headers: { Cookie: cookie } });
      expect(missing.status, path).toBe(409);
    }
    expect(fetch).not.toHaveBeenCalled();

    await env.DB.prepare("UPDATE sessions SET membership_id = NULL").run();
    for (const path of [
      "/connections/github/installations",
      "/connections/github/repositories",
    ]) {
      const inactive = await appRequest(app, path, { headers: { Cookie: cookie } });
      expect(inactive.status, path).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the personal repository fallback for a pasted token and follows Link", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const token = "github_pat_test-repository-list";
    await connectPat(app, cookie, token);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (url.includes("page=2")) {
        return Response.json([{ full_name: "acme/private", private: true }]);
      }
      return Response.json(
        [{ full_name: "member/public", private: false }],
        {
          headers: {
            Link: '<https://api.github.com/user/repos?page=2&per_page=8>; rel="next"',
          },
        },
      );
    });

    const response = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json<ListGithubRepositoriesResponse>()).resolves.toEqual({
      source: "personal-token",
      repositories: [
        { repo: "member/public", accountLogin: "member", private: false },
        { repo: "acme/private", accountLogin: "acme", private: true },
      ],
      truncated: false,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member"
      + "&per_page=8",
    );
    expect(requests.map(({ authorization }) => authorization))
      .toEqual([`Bearer ${token}`, `Bearer ${token}`]);
  });

  it("pages installations and merges the user-token repository intersection", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await connectOauth(app, cookie);
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer ghu_test-user-token");
      const url = String(input);
      requests.push(url);
      if (url.includes("/installations/11/repositories")) {
        return Response.json({ repositories: [
          { full_name: "acme/public", private: false },
          { full_name: "acme/private", private: true },
        ] });
      }
      if (url.includes("/installations/22/repositories")) {
        return Response.json({ repositories: [
          { full_name: "member/tools", private: false },
        ] });
      }
      if (url.includes("page=2")) {
        return Response.json({ installations: [{
          id: 22,
          account: { login: "member", type: "User" },
          repository_selection: "all",
        }] });
      }
      return Response.json(
        { installations: [{
          id: 11,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
        }] },
        {
          headers: {
            Link: '<https://api.github.com/user/installations?page=2&per_page=8>; rel="next"',
          },
        },
      );
    });

    const installations = await appRequest(app, "/connections/github/installations", {
      headers: { Cookie: cookie },
    });
    expect(installations.status).toBe(200);
    await expect(installations.json<ListGithubInstallationsResponse>()).resolves.toEqual({
      installations: [
        {
          id: 11,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "selected",
        },
        {
          id: 22,
          accountLogin: "member",
          accountType: "User",
          repositorySelection: "all",
        },
      ],
    });

    requests.length = 0;
    const repositories = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: cookie },
    });
    expect(repositories.status).toBe(200);
    await expect(repositories.json<ListGithubRepositoriesResponse>()).resolves.toEqual({
      source: "installations",
      repositories: [
        { repo: "acme/public", accountLogin: "acme", private: false },
        { repo: "acme/private", accountLogin: "acme", private: true },
        { repo: "member/tools", accountLogin: "member", private: false },
      ],
      truncated: false,
    });
    expect(requests).toEqual([
      "https://api.github.com/user/installations?per_page=8",
      "https://api.github.com/user/installations?page=2&per_page=8",
      "https://api.github.com/user/installations/11/repositories?per_page=8",
      "https://api.github.com/user/installations/22/repositories?per_page=8",
    ]);
  });

  it("refuses a cross-origin pagination link before it can receive the token", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await connectPat(app, cookie, "github_pat_test-pagination-origin");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([], {
      headers: { Link: '<https://attacker.example/repos?page=2>; rel="next"' },
    }));

    const response = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
