import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTemplateView, WorkspaceView } from "@blitzos/schema";
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

describe("workspace templates", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it("updates a template, preserving folders the editor can no longer read", async () => {
    const { app } = harness();
    await operatorSession(app);
    const member = await sameOrgSession("author");
    const bystander = await sameOrgSession("bystander");

    const lent = await appRequest(app, "/folders", {
      ...json({ name: "lent-notes" }),
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    });
    const folderId = (await lent.json<{ folder: { id: string } }>()).folder.id;
    const granted = await appRequest(app, `/folders/${folderId}/grants`, {
      ...json({ membershipId: member.membershipId, role: "editor" }),
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    });
    const grantId = (await granted.json<{ grant: { id: string } }>()).grant.id;

    const created = await appRequest(app, "/workspace-templates", {
      ...json({ name: "draft", machineTypeId: "small", folderIds: [folderId] }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const template = (await created.json<{ template: WorkspaceTemplateView }>()).template;

    // The lender revokes access; the creator keeps editing rights on the
    // template itself but can no longer read the attached folder.
    expect((await appRequest(app, `/folders/${folderId}/grants/${grantId}`, {
      method: "DELETE",
      headers: { Cookie: bystander.cookie },
    })).status).toBe(204);

    // A same-org member who is neither creator nor admin cannot edit.
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({ name: "hijack", machineTypeId: "small", folderIds: [] }),
      method: "PUT",
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);

    // The creator renames while keeping the now-unreadable folder attached.
    const renamed = await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({ name: "field study", machineTypeId: "small", folderIds: [folderId] }),
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(renamed.status).toBe(200);
    const view = (await renamed.json<{ template: WorkspaceTemplateView }>()).template;
    expect(view.name).toBe("field study");
    expect(view.folders.map(({ id, role }) => [id, role])).toEqual([[folderId, null]]);

    // Adding a folder the editor cannot read still fails.
    const secret = await appRequest(app, "/folders", {
      ...json({ name: "other-notes" }),
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    });
    const secretId = (await secret.json<{ folder: { id: string } }>()).folder.id;
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({ name: "field study 3", machineTypeId: "small", folderIds: [folderId, secretId] }),
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
  });

  it("creates, lists, applies, and deletes a template with per-viewer folder access", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("colleague");

    const orgFolder = await createFolder(app, owner, "datasets");
    const privateFolder = await createFolder(app, owner, "secrets");
    expect((await appRequest(app, `/folders/${orgFolder}`, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ orgRole: "viewer" }),
    })).status).toBe(204);

    const templateEnvironment = {
      env: { API_ORIGIN: "https://api.example" },
      startupScript: "npm install\n",
    };
    const created = await appRequest(app, "/workspace-templates", {
      ...json({
        name: "web analysis",
        machineTypeId: "small",
        folderIds: [orgFolder, privateFolder],
        environment: templateEnvironment,
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const template = (await created.json<{ template: WorkspaceTemplateView }>()).template;
    expect(template.machineTypeId).toBe("small");
    expect(template.environment).toEqual(templateEnvironment);

    // PUT takes the full create shape, so it replaces the environment too.
    const edited = { env: { API_ORIGIN: "https://api.example/v2" }, startupScript: null };
    const updated = await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({
        name: "web analysis",
        machineTypeId: "small",
        folderIds: [orgFolder, privateFolder],
        environment: edited,
      }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ template: WorkspaceTemplateView }>()).template.environment)
      .toEqual(edited);
    expect(await env.DB.prepare("SELECT environment FROM workspace_templates WHERE id = ?1")
      .bind(template.id).first<string>("environment")).toBe(JSON.stringify(edited));
    // Restore the created environment for the workspace assertions below.
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({
        name: "web analysis",
        machineTypeId: "small",
        folderIds: [orgFolder, privateFolder],
        environment: templateEnvironment,
      }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(template.folders.map(({ role }) => role)).toEqual(["owner", "owner"]);

    const memberList = await appRequest(app, "/workspace-templates", {
      headers: { Cookie: member.cookie },
    });
    const listed = (await memberList.json<{ templates: WorkspaceTemplateView[] }>()).templates;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.createdBy.name).toBe("Operator");
    expect(new Map(listed[0]?.folders.map(({ id, role }) => [id, role]))).toEqual(new Map([
      [orgFolder, "viewer"],
      [privateFolder, null],
    ]));

    const fromTemplate = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id, orgShareRole: "editor" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(fromTemplate.status).toBe(201);
    const workspace = (await fromTemplate.json<{ workspace: WorkspaceView }>()).workspace;
    expect(workspace.machineTypeId).toBe("small");
    expect(workspace.orgShareRole).toBe("editor");
    expect(workspace.name).toBe("web analysis");
    expect(workspace.environment).toEqual(templateEnvironment);
    const sibling = await appRequest(app, "/workspaces", {
      ...json({
        templateId: template.id,
        environment: { env: { OVERRIDE: "yes" }, startupScript: null },
      }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    await expect(sibling.json()).resolves.toMatchObject({
      workspace: {
        name: "web analysis-2",
        environment: { env: { OVERRIDE: "yes" }, startupScript: null },
      },
    });
    const named = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id, name: "my own name" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    await expect(named.json()).resolves.toMatchObject({
      workspace: { name: "my own name" },
    });
    const attached = await env.DB.prepare(
      `SELECT folder_id, attached_by_membership_id FROM folder_attachments
       WHERE workspace_id = ?1 ORDER BY folder_id`,
    ).bind(workspace.id).all<{ folder_id: string; attached_by_membership_id: string }>();
    expect(attached.results).toEqual([
      { folder_id: orgFolder, attached_by_membership_id: member.membershipId },
    ]);

    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);
    const outsider = await userSession("outsider");
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      method: "DELETE",
      headers: { Cookie: outsider },
    })).status).toBe(404);
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    await expect(appRequest(app, "/workspace-templates", {
      headers: { Cookie: owner },
    }).then((response) => response.json())).resolves.toEqual({ templates: [] });
    // Template deletion never detaches folders from live workspaces.
    const survivors = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM folder_attachments WHERE workspace_id = ?1",
    ).bind(workspace.id).first<number>("count");
    expect(survivors).toBe(1);
  });

  it("rejects template creates on inaccessible folders and workspace creates missing a machine type", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("limited");
    const privateFolder = await createFolder(app, owner, "private");

    expect((await appRequest(app, "/workspace-templates", {
      ...json({ name: "nope", machineTypeId: "small", folderIds: [privateFolder] }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, "/workspace-templates", {
      ...json({
        name: "bad environment",
        machineTypeId: "small",
        folderIds: [],
        environment: { env: { "NOT-VALID": "x" }, startupScript: null },
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await appRequest(app, "/workspaces", {
      ...json({ name: "no-machine" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await appRequest(app, "/workspaces", {
      ...json({ templateId: "missing-template" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(404);
  });

  it("keeps the org-default pointer a single admin-gated swap that deletes clear", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("colleague");
    const orgDefault = async (): Promise<string | null> =>
      (await env.DB.prepare("SELECT default_template_id FROM orgs WHERE id = 'personal'")
        .first<{ default_template_id: string | null }>())?.default_template_id ?? null;

    // Ticking the default is org state: members are refused before any write.
    expect((await appRequest(app, "/workspace-templates", {
      ...json({ name: "member try", machineTypeId: "small", folderIds: [], isOrgDefault: true }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_templates")
      .first<number>("count")).toBe(0);

    const created = await appRequest(app, "/workspace-templates", {
      ...json({ name: "starter", machineTypeId: "small", folderIds: [], isOrgDefault: true }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const first = (await created.json<{ template: WorkspaceTemplateView }>()).template;
    expect(first.isOrgDefault).toBe(true);
    expect(await orgDefault()).toBe(first.id);

    // A second default swaps the single pointer; no sweep, no second default.
    const second = (await (await appRequest(app, "/workspace-templates", {
      ...json({ name: "newer", machineTypeId: "small", folderIds: [], isOrgDefault: true }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ template: WorkspaceTemplateView }>()).template;
    expect(second.isOrgDefault).toBe(true);
    const listed = (await (await appRequest(app, "/workspace-templates", {
      headers: { Cookie: member.cookie },
    })).json<{ templates: WorkspaceTemplateView[] }>()).templates;
    expect(new Map(listed.map(({ id, isOrgDefault }) => [id, isOrgDefault]))).toEqual(new Map([
      [first.id, false],
      [second.id, true],
    ]));

    // Omitting the field on PUT leaves the org pointer alone — it is org
    // state, and a template edit that never mentions it must not move it.
    expect((await appRequest(app, `/workspace-templates/${second.id}`, {
      ...json({ name: "newer v2", machineTypeId: "small", folderIds: [] }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(await orgDefault()).toBe(second.id);

    // A member PUT that tries to tick is refused even on their own template.
    const memberOwned = (await (await appRequest(app, "/workspace-templates", {
      ...json({ name: "member draft", machineTypeId: "small", folderIds: [] }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).json<{ template: WorkspaceTemplateView }>()).template;
    expect((await appRequest(app, `/workspace-templates/${memberOwned.id}`, {
      ...json({ name: "member draft", machineTypeId: "small", folderIds: [], isOrgDefault: true }),
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect(await orgDefault()).toBe(second.id);

    // False clears only when the pointer is at this template.
    expect((await appRequest(app, `/workspace-templates/${first.id}`, {
      ...json({ name: "starter", machineTypeId: "small", folderIds: [], isOrgDefault: false }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(await orgDefault()).toBe(second.id);
    expect((await appRequest(app, `/workspace-templates/${second.id}`, {
      ...json({ name: "newer v2", machineTypeId: "small", folderIds: [], isOrgDefault: false }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(await orgDefault()).toBeNull();

    // Deleting the default auto-clears the pointer rather than dangling it.
    expect((await appRequest(app, `/workspace-templates/${second.id}`, {
      ...json({ name: "newer v2", machineTypeId: "small", folderIds: [], isOrgDefault: true }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(await orgDefault()).toBe(second.id);
    expect((await appRequest(app, `/workspace-templates/${second.id}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    expect(await orgDefault()).toBeNull();
  });

  it("validates template repos and force-attaches the github connection", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const post = (body: object, cookie = owner) => appRequest(app, "/workspace-templates", {
      ...json(body),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });

    for (const bad of ["no-slash", "owner/name/extra", "owner/", "/name", "owner/na me"]) {
      const refused = await post({
        name: "bad repos",
        machineTypeId: "small",
        folderIds: [],
        repos: [bad],
      });
      expect(refused.status, bad).toBe(400);
    }
    expect((await post({
      name: "too many",
      machineTypeId: "small",
      folderIds: [],
      repos: Array.from({ length: 17 }, (_, i) => `owner/repo-${String(i)}`),
    })).status).toBe(400);
    const collision = await post({
      name: "collision",
      machineTypeId: "small",
      folderIds: [],
      repos: ["acme/app", "blitz/app"],
    });
    expect(collision.status).toBe(400);
    await expect(collision.json()).resolves.toMatchObject({
      error: expect.stringContaining("clone into the same directory"),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_templates")
      .first<number>("count")).toBe(0);

    // Duplicates collapse; the view answers sorted; github rides along.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const created = await post({
      name: "repo starter",
      machineTypeId: "small",
      folderIds: [],
      repos: ["blitzdotdev/blitz-core", "acme/tools", "blitzdotdev/blitz-core"],
      connections: [{ provider: "linear" }],
    });
    expect(created.status).toBe(201);
    const template = (await created.json<{ template: WorkspaceTemplateView }>()).template;
    expect(template.repos).toEqual([
      { repo: "acme/tools", private: false },
      { repo: "blitzdotdev/blitz-core", private: false },
    ]);
    expect(template.connections).toContainEqual({ provider: "github" });
    expect(template.connections).toContainEqual({ provider: "linear" });

    // Creation never blocks on connections: no github grant exists, yet the
    // create succeeds and the ceiling stipulates github for the workspace
    // connections panel to surface.
    const instantiated = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(instantiated.status).toBe(201);
    const { workspace } = await instantiated.json<{ workspace: WorkspaceView }>();
    expect(workspace.connections).toContain("github");

    // PUT is a full replace: dropping the repos drops the rows.
    expect((await appRequest(app, `/workspace-templates/${template.id}`, {
      ...json({ name: "repo starter", machineTypeId: "small", folderIds: [], repos: [] }),
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_template_repos")
      .first<number>("count")).toBe(0);
  });

  it("boots a create from a repos template with the detached clone loop", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const template = (await (await appRequest(app, "/workspace-templates", {
      ...json({
        name: "repo starter",
        machineTypeId: "small",
        folderIds: [],
        repos: ["blitzdotdev/blitz-core", "acme/tools"],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ template: WorkspaceTemplateView }>()).template;

    const created = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain(
      "[ -d /workspace/blitz-core/.git ] || git clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || cloned=false",
    );
    expect(userData).toContain(
      "[ -d /workspace/tools/.git ] || git clone https://github.com/acme/tools /workspace/tools || cloned=false",
    );
    // The workspace owns the list whichever source chose it, so the template
    // path lands in the same table the picker path writes.
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

  it("clones and stores a request repo list when no template is selected", async () => {
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
      "[ -d /workspace/blitz-core/.git ] || git clone https://github.com/blitzdotdev/blitz-core /workspace/blitz-core || cloned=false",
    );
    // Cloning mints through the box git credential helper, so naming repos
    // stipulates github exactly as naming them on a template does.
    await expect(env.DB.prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<string>("manifest")).resolves.toContain("github");
  });

  it("refuses a create that names both a template and its own repos", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const template = (await (await appRequest(app, "/workspace-templates", {
      ...json({
        name: "repo starter",
        machineTypeId: "small",
        folderIds: [],
        repos: ["blitzdotdev/blitz-core"],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ template: WorkspaceTemplateView }>()).template;

    // Refused, not resolved: a silent winner would turn one UI bug into a
    // clone list nobody can explain from the request that produced it.
    const both = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id, repos: ["acme/tools"] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toMatchObject({
      error: "repos cannot be combined with templateId",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces")
      .first<number>("count")).toBe(0);
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

  it("refuses a private template repo until that member connects GitHub", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("private-repo-member");
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
    const template = (await (await appRequest(app, "/workspace-templates", {
      ...json({
        name: "private starter",
        machineTypeId: "small",
        folderIds: [],
        repos: ["acme/private-tools"],
      }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).json<{ template: WorkspaceTemplateView }>()).template;

    expect(template.repos).toEqual([{ repo: "acme/private-tools", private: true }]);
    await expect(env.DB.prepare(
      "SELECT repo, private FROM workspace_template_repos WHERE template_id = ?1",
    ).bind(template.id).first()).resolves.toEqual({ repo: "acme/private-tools", private: 1 });

    const refused = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect GitHub"),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces")
      .first<number>("count")).toBe(0);

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
    const stillRefused = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(stillRefused.status).toBe(409);

    await connectGithubApp(app, member.cookie);

    const created = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(providers.userData.get(workspace.id) ?? "").toContain(
      "git clone https://github.com/acme/private-tools /workspace/private-tools",
    );
  });

  it("resolves org-wide sharing for workspaces and folders and clears it on demand", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("neighbor");

    const created = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small", orgShareRole: "editor" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;

    const detail = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: member.cookie },
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      workspace: { role: "editor", orgShareRole: "editor" },
    });
    expect((await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    expect((await appRequest(app, `/workspaces/${workspace.id}/org-role`, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ role: null }),
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
