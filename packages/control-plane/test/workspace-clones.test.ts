import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@blitzos/schema";
import {
  appRequest,
  harness,
  operatorSession,
  sameOrgSession,
  resetDatabase,
  testConnectSecrets,
  userSession,
} from "./helpers.js";

function json(body: object) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Walks the real authorize -> callback round trip. A pasted token cannot
 * stand in for this: private repos in a workspace are App-only, and the two
 * grants are distinguishable to every route that cares. The ambient fetch mock
 * has to answer the token endpoint. */
async function connectGithubApp(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
): Promise<void> {
  testConnectSecrets.set("GITHUB_APP_CLIENT_ID", "github-client-id");
  testConnectSecrets.set("GITHUB_APP_CLIENT_SECRET", "github-client-secret");
  const started = await appRequest(app, "/connect/github/start", {
    headers: { Cookie: cookie },
  });
  expect(started.status).toBe(302);
  const authorize = new URL(started.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state") ?? "";
  const stateCookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = await appRequest(
    app,
    `/connect/github/callback?code=github-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: stateCookie } },
  );
  expect(callback.status).toBe(302);
}

async function createFolder(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name: string,
): Promise<string> {
  const response = await appRequest(app, "/folders", {
    ...json({ name }),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
  expect(response.status).toBe(201);
  return (await response.json<{ folder: { id: string } }>()).folder.id;
}

describe("workspace clones and repos", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it("unmounts the template surface and still validates a create", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);

    // Templates are disabled product-wide (2026-08-29): the routes are not
    // registered, so the API answers 404 rather than an empty list.
    for (const [path, init] of [
      ["/workspace-templates", { headers: { Cookie: owner } }],
      ["/workspace-templates/anything", { headers: { Cookie: owner } }],
      ["/workspace-templates", {
        ...json({ name: "nope", machineTypeId: "small", folderIds: [] }),
        headers: { Cookie: owner, "Content-Type": "application/json" },
      }],
    ] as const) {
      expect((await appRequest(app, path, init)).status, path).toBe(404);
    }

    // A create that names a template is refused rather than quietly ignored.
    const templated = await appRequest(app, "/workspaces", {
      ...json({ templateId: "missing-template" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(templated.status).toBe(400);
    await expect(templated.json()).resolves.toMatchObject({
      error: expect.stringContaining("cloneFromWorkspaceId"),
    });

    expect((await appRequest(app, "/workspaces", {
      ...json({ name: "no-machine" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: "missing-workspace" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(404);
  });

  it("validates repos on a create and force-attaches the github connection", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const post = (body: object, cookie = owner) => appRequest(app, "/workspaces", {
      ...json(body),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });

    for (const bad of ["no-slash", "owner/name/extra", "owner/", "/name", "owner/na me"]) {
      expect((await post({ machineTypeId: "small", repos: [bad] })).status, bad).toBe(400);
    }
    expect((await post({
      machineTypeId: "small",
      repos: Array.from({ length: 17 }, (_entry, index) => `owner/repo-${String(index)}`),
    })).status).toBe(400);
    const collision = await post({
      machineTypeId: "small",
      repos: ["acme/app", "blitz/app"],
    });
    expect(collision.status).toBe(400);
    await expect(collision.json()).resolves.toMatchObject({
      error: expect.stringContaining("clone into the same directory"),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces")
      .first<number>("count")).toBe(0);

    // Duplicates collapse; github rides along because cloning mints through
    // the baked git credential helper.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const created = await post({
      machineTypeId: "small",
      repos: ["blitzdotdev/blitz-core", "acme/tools", "blitzdotdev/blitz-core"],
      connections: ["linear"],
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(workspace.connections).toContain("github");
    expect(workspace.connections).toContain("linear");
    await expect(env.DB.prepare(
      "SELECT repo FROM workspace_repos WHERE workspace_id = ?1 ORDER BY repo",
    ).bind(workspace.id).all<{ repo: string }>()
      .then((result) => result.results.map(({ repo }) => repo))).resolves.toEqual([
        "acme/tools",
        "blitzdotdev/blitz-core",
      ]);
  });

  it("boots a workspace clone with the detached clone loop", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const source = (await (await appRequest(app, "/workspaces", {
      ...json({
        name: "repo starter",
        machineTypeId: "small",
        repos: ["blitzdotdev/blitz-core", "acme/tools"],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ workspace: WorkspaceView }>()).workspace;

    const created = await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: source.id }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain(
      "[ -d /workspace/blitz-core/.git ] || git clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || git -c http.version=HTTP/1.1 clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || cloned=false",
    );
    expect(userData).toContain(
      "[ -d /workspace/tools/.git ] || git clone https://github.com/acme/tools /workspace/tools || git -c http.version=HTTP/1.1 clone https://github.com/acme/tools /workspace/tools || cloned=false",
    );
    // The clone owns its own list, so it is a starting point and not a link.
    await expect(env.DB.prepare(
      "SELECT repo FROM workspace_repos WHERE workspace_id = ?1 ORDER BY repo",
    ).bind(workspace.id).all<{ repo: string }>()
      .then((result) => result.results.map(({ repo }) => repo))).resolves.toEqual([
        "acme/tools",
        "blitzdotdev/blitz-core",
      ]);

    // An ordinary create on the same instance carries none of it.
    const plain = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(plain.status).toBe(201);
    const plainWorkspace = (await plain.json<{ workspace: WorkspaceView }>()).workspace;
    expect(providers.userData.get(plainWorkspace.id) ?? "").not.toContain("git clone");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workspace_repos WHERE workspace_id = ?1",
    ).bind(plainWorkspace.id).first<number>("count")).toBe(0);
  });

  it("clones and stores a request repo list on a plain create", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    // Reachable anonymously, so every repo probes public and no grant is owed.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        repos: ["blitzdotdev/blitz-core", "acme/tools"],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;

    await expect(env.DB.prepare(
      "SELECT repo, private FROM workspace_repos WHERE workspace_id = ?1 ORDER BY repo",
    ).bind(workspace.id).all<{ repo: string; private: number }>()
      .then((result) => result.results)).resolves.toEqual([
        { repo: "acme/tools", private: 0 },
        { repo: "blitzdotdev/blitz-core", private: 0 },
      ]);
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain(
      "[ -d /workspace/blitz-core/.git ] || git clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || git -c http.version=HTTP/1.1 clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || cloned=false",
    );
    // Cloning mints through the box git credential helper, so naming repos
    // stipulates github exactly as naming them on a template does.
    await expect(env.DB.prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<string>("manifest")).resolves.toContain("github");
  });

  it("refuses a create that names both a clone source and its own repos", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const source = (await (await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small", repos: ["blitzdotdev/blitz-core"] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ workspace: WorkspaceView }>()).workspace;

    // Refused, not resolved: a silent winner would turn one UI bug into a
    // clone list nobody can explain from the request that produced it.
    const both = await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: source.id, repos: ["acme/tools"] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toMatchObject({
      error: "repos cannot be combined with cloneFromWorkspaceId",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces")
      .first<number>("count")).toBe(1);
  });

  it("applies the shared repo validators to a request list", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const fetch = vi.spyOn(globalThis, "fetch");

    const cases: Array<[string[], string]> = [
      [["https://github.com/acme/tools"], 'repos entries must be "owner/name"'],
      [
        Array.from({ length: 17 }, (_entry, index) => `acme/repo-${String(index)}`),
        "repos must have at most 16 entries",
      ],
      // Both would clone into /workspace/app and fight over the directory.
      [["acme/app", "other/app"], "clone into the same directory"],
    ];
    for (const [repos, message] of cases) {
      const refused = await appRequest(app, "/workspaces", {
        ...json({ machineTypeId: "small", repos }),
        headers: { Cookie: owner, "Content-Type": "application/json" },
      });
      expect(refused.status, message).toBe(400);
      await expect(refused.json(), message).resolves.toMatchObject({
        error: expect.stringContaining(message),
      });
    }
    // Every one of these is decided at the boundary, before any probe.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a private request repo to a member who holds only a pasted token", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    expect((await appRequest(app, "/connections/grants/github", {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "github",
        token: "github_pat_test-workspace-repo-owner",
      }),
    })).status).toBe(204);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => (
      new Response(null, {
        status: new Headers(init?.headers).has("Authorization") ? 200 : 404,
      })
    ));

    const refused = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small", repos: ["acme/private-tools"] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });

    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect GitHub through the App"),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_repos")
      .first<number>("count")).toBe(0);
  });

  it("refuses a private repo on a clone until that member connects GitHub", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("private-repo-member", "admin");
    expect((await appRequest(app, "/connections/grants/github", {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "github",
        token: "github_pat_test-private-repo-owner",
      }),
    })).status).toBe(204);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({
          access_token: "ghu_test-private-repo-member",
          expires_in: 28_800,
          refresh_token: "ghr_test-private-repo-member",
          refresh_token_expires_in: 15_897_600,
          scope: "",
          token_type: "bearer",
        });
      }
      // The git probe: reachable with a credential, hidden without one, which
      // is what "private but reachable" looks like from the transport.
      return new Response(null, {
        status: new Headers(init?.headers).has("Authorization") ? 200 : 404,
      });
    });
    // The owner holds an App grant, so the source create probes private.
    await connectGithubApp(app, owner);
    const source = (await (await appRequest(app, "/workspaces", {
      ...json({ name: "private starter", machineTypeId: "small", repos: ["acme/private-tools"] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ workspace: WorkspaceView }>()).workspace;

    await expect(env.DB.prepare(
      "SELECT repo, private FROM workspace_repos WHERE workspace_id = ?1",
    ).bind(source.id).first()).resolves.toEqual({ repo: "acme/private-tools", private: 1 });

    const refused = await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: source.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect GitHub"),
    });

    const pasted = await appRequest(app, "/connections/grants/github", {
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "github",
        token: "github_pat_test-private-repo-member",
      }),
    });
    expect(pasted.status).toBe(204);

    // A pasted token still buys nothing here. Its reach is whatever the member
    // chose on github.com, which the product can neither see nor trust, so the
    // clone stays refused until the App grant replaces it.
    expect((await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: source.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(409);

    await connectGithubApp(app, member.cookie);

    const created = await appRequest(app, "/workspaces", {
      ...json({ cloneFromWorkspaceId: source.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(providers.userData.get(workspace.id) ?? "").toContain(
      "git clone https://github.com/acme/private-tools /workspace/private-tools",
    );
  });

  it("gives a member named at create their reach, and clears it on removal", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("neighbor");

    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: member.membershipId, role: "member" }],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;

    // The members editor is the only membership control at create: a named
    // member gets a workspace_members row at the role they were given.
    const detail = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: member.cookie },
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      workspace: { role: "editor", myRole: "member" },
    });
    expect((await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    // Removing the member is what clears their reach; there is no org-wide
    // pointer left to unset.
    expect((await appRequest(app, `/workspaces/${workspace.id}/members/${member.membershipId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    expect((await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    const folder = await createFolder(app, owner, "handbook");
    const path = `/folders/${folder}/objects/${encodeURIComponent("guide.md")}`;
    expect((await appRequest(app, `/folders/${folder}`, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ orgRole: "editor" }),
    })).status).toBe(204);
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member.cookie, "x-blitz-mtime": "10" },
      body: "hello",
    })).status).toBe(204);
    expect((await appRequest(app, `/folders/${folder}`, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ orgRole: "viewer" }),
    })).status).toBe(204);
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member.cookie, "x-blitz-mtime": "11" },
      body: "denied",
    })).status).toBe(403);
    expect((await appRequest(app, `/folders/${folder}/objects`, {
      headers: { Cookie: member.cookie },
    })).status).toBe(200);
  });
});
