import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceTemplateView, WorkspaceView } from "@blitzos/schema";
import {
  appRequest,
  harness,
  operatorSession,
  sameOrgSession,
  resetDatabase,
  userSession,
} from "./helpers.js";

function json(body: object) {
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
