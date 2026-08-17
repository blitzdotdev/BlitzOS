import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceTemplateView, WorkspaceView } from "@blitzos/schema";
import { hashSecret, randomToken } from "../core/crypto.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  userSession,
} from "./helpers.js";

async function sameOrgSession(
  id: string,
  role: "admin" | "member" = "member",
): Promise<{ cookie: string; membershipId: string }> {
  const token = randomToken();
  const membershipId = `${id}-membership`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO principals (id, unix_name, harnesses) VALUES (?1, 'blitz', '[\"codex\"]')",
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?5)`,
    ).bind(id, `google-${id}`, `${id}@example.com`, id, now),
    env.DB.prepare(
      `INSERT INTO memberships (id, user_id, org_id, role, status)
       VALUES (?1, ?2, 'personal', ?3, 'active')`,
    ).bind(membershipId, id, role),
    env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(await hashSecret(token), id, now, now + 60_000, membershipId),
  ]);
  return { cookie: `blitz_session=${token}`, membershipId };
}

function json(body: Record<string, string | string[] | null>) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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

    const created = await appRequest(app, "/workspace-templates", {
      ...json({ name: "web analysis", machineTypeId: "small", folderIds: [orgFolder, privateFolder] }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const template = (await created.json<{ template: WorkspaceTemplateView }>()).template;
    expect(template.machineTypeId).toBe("small");
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
    const sibling = await appRequest(app, "/workspaces", {
      ...json({ templateId: template.id }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    await expect(sibling.json()).resolves.toMatchObject({
      workspace: { name: "web analysis-2" },
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
    expect((await appRequest(app, "/workspaces", {
      ...json({ name: "no-machine" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await appRequest(app, "/workspaces", {
      ...json({ templateId: "missing-template" }),
      headers: { Cookie: owner, "Content-Type": "application/json" },
    })).status).toBe(404);
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
