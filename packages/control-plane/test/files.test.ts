import { FILES_MULTIPART_CHUNK_BYTES } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret, randomToken } from "../core/crypto.js";
import {
  appRequest,
  createWorkspace,
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

async function createFolder(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name = "Shared",
): Promise<string> {
  const response = await appRequest(app, "/folders", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ folder: { id: string } }>()).folder.id;
}

function objectPath(folderId: string, key: string): string {
  return `/folders/${folderId}/objects/${encodeURIComponent(key)}`;
}

async function grant(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  folderId: string,
  membershipId: string,
  role: "editor" | "viewer",
): Promise<string> {
  const response = await appRequest(app, `/folders/${folderId}/grants`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ membershipId, role }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ grant: { id: string } }>()).grant.id;
}

describe("organization file library", () => {
  beforeEach(resetDatabase);

  it("keeps the migrated folder schemas at the authoritative exact column sets", async () => {
    const folderColumns = await env.DB.prepare("PRAGMA table_info(folders)").all<{ name: string }>();
    const grantColumns = await env.DB.prepare("PRAGMA table_info(folder_grants)").all<{ name: string }>();
    expect(folderColumns.results.map(({ name }) => name)).toEqual([
      "id",
      "org_id",
      "name",
      "created_by_membership_id",
      "created_at",
      "updated_at",
      "org_role",
    ]);
    expect(grantColumns.results.map(({ name }) => name)).toEqual([
      "id",
      "folder_id",
      "membership_id",
      "role",
      "granted_by_membership_id",
      "created_at",
    ]);
    const attachmentColumns = await env.DB.prepare("PRAGMA table_info(folder_attachments)").all<{ name: string }>();
    expect(attachmentColumns.results.map(({ name }) => name)).toEqual([
      "workspace_id",
      "folder_id",
      "attached_by_membership_id",
      "created_at",
      "guest_path",
    ]);
  });

  it("lists every org folder while preserving 404/403 and viewer/editor boundaries", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("member");
    const outsider = await userSession("outsider");
    const folderId = await createFolder(app, owner);
    const path = objectPath(folderId, "notes/today.txt");

    await expect(appRequest(app, "/folders", { headers: { Cookie: member.cookie } }).then((response) => response.json())).resolves.toEqual({ folders: [{
      id: folderId,
      name: "Shared",
      role: null,
      orgRole: null,
      owner: { name: expect.any(String), avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }] });
    expect((await appRequest(app, `/folders/${folderId}/objects`, { headers: { Cookie: member.cookie } })).status).toBe(403);
    expect((await appRequest(app, `/folders/${folderId}/objects`, { headers: { Cookie: outsider } })).status).toBe(404);

    await grant(app, owner, folderId, member.membershipId, "viewer");
    const viewerList = await appRequest(app, "/folders", { headers: { Cookie: member.cookie } });
    await expect(viewerList.json()).resolves.toEqual({ folders: [{
      id: folderId,
      name: "Shared",
      role: "viewer",
      orgRole: null,
      owner: { name: expect.any(String), avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }] });
    const ownerList = await appRequest(app, "/folders", { headers: { Cookie: owner } });
    await expect(ownerList.json()).resolves.toMatchObject({ folders: [{
      id: folderId,
      role: "owner",
      grants: [{ membershipId: member.membershipId, role: "viewer" }],
    }] });
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member.cookie, "x-blitz-mtime": "10" },
      body: "viewer write",
    })).status).toBe(403);
    expect((await appRequest(app, `/folders/${folderId}/objects`, { headers: { Cookie: member.cookie } })).status).toBe(200);

    await grant(app, owner, folderId, member.membershipId, "editor");
    const write = await appRequest(app, path, {
      method: "PUT",
      headers: {
        Cookie: member.cookie,
        "Content-Type": "text/plain",
        "x-blitz-mtime": "1700000000000",
      },
      body: "last edit",
    });
    expect(write.status).toBe(204);
    const listing = await appRequest(app, `/folders/${folderId}/objects`, {
      headers: { Cookie: owner },
    });
    await expect(listing.json()).resolves.toEqual({
      objects: [{
        key: "notes/today.txt",
        size: 9,
        mtime: 1_700_000_000_000,
        editedBy: "member",
      }],
      cursor: null,
      truncated: false,
    });
    const download = await appRequest(app, path, { headers: { Cookie: member.cookie } });
    expect(await download.text()).toBe("last edit");
    expect(download.headers.get("x-blitz-mtime")).toBe("1700000000000");
    expect(download.headers.get("x-blitz-edited-by")).toBe("member");
  });

  it("rejects traversal, leading slashes, empty segments, and malformed mtimes", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const folderId = await createFolder(app, owner);
    for (const key of ["../secret", "/root", "a//b", "a/./b", "a/../b", "a\\b"]) {
      const response = await appRequest(app, objectPath(folderId, key), {
        method: "PUT",
        headers: { Cookie: owner, "x-blitz-mtime": "1" },
        body: "blocked",
      });
      expect(response.status, key).toBe(400);
    }
    expect((await appRequest(app, objectPath(folderId, "valid.txt"), {
      method: "PUT",
      headers: { Cookie: owner, "x-blitz-mtime": "1.5" },
      body: "blocked",
    })).status).toBe(400);
  });

  it("re-checks an editor grant on every multipart chunk and stops after revoke", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const editor = await sameOrgSession("chunk-editor");
    const folderId = await createFolder(app, owner);
    const grantId = await grant(app, owner, folderId, editor.membershipId, "editor");
    const base = `${objectPath(folderId, "large.bin")}/multipart`;
    const created = await appRequest(app, base, {
      method: "POST",
      headers: { Cookie: editor.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mtime: 99 }),
    });
    const { uploadId } = await created.json<{ uploadId: string }>();
    const firstPart = await appRequest(app, `${base}/${encodeURIComponent(uploadId)}/1`, {
      method: "PUT",
      headers: { Cookie: editor.cookie },
      body: new Uint8Array(FILES_MULTIPART_CHUNK_BYTES),
    });
    expect(firstPart.status).toBe(200);

    expect((await appRequest(app, `/folders/${folderId}/grants/${grantId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    const nextPart = await appRequest(app, `${base}/${encodeURIComponent(uploadId)}/2`, {
      method: "PUT",
      headers: { Cookie: editor.cookie },
      body: new Uint8Array([1]),
    });
    expect(nextPart.status).toBe(403);
  });

  it("completes an R2 binding multipart upload with an eight MiB part and a short last part", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const folderId = await createFolder(app, owner);
    const base = `${objectPath(folderId, "binding.bin")}/multipart`;
    const created = await appRequest(app, base, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ mtime: 777 }),
    });
    const { uploadId } = await created.json<{ uploadId: string }>();
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const [partNumber, body] of [
      [1, new Uint8Array(FILES_MULTIPART_CHUNK_BYTES)],
      [2, new Uint8Array([7])],
    ] as const) {
      const response = await appRequest(
        app,
        `${base}/${encodeURIComponent(uploadId)}/${partNumber}`,
        { method: "PUT", headers: { Cookie: owner }, body },
      );
      expect(response.status).toBe(200);
      parts.push(await response.json<{ partNumber: number; etag: string }>());
    }
    expect((await appRequest(app, `${base}/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    })).status).toBe(204);
    const downloaded = await appRequest(app, objectPath(folderId, "binding.bin"), {
      headers: { Cookie: owner },
    });
    expect((await downloaded.arrayBuffer()).byteLength).toBe(FILES_MULTIPART_CHUNK_BYTES + 1);
    expect(downloaded.headers.get("x-blitz-mtime")).toBe("777");
    expect(downloaded.headers.get("x-blitz-edited-by")).toBe("Operator");
  });

  it("deletes grants, every paginated object page, and the folder row", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("cleanup-member");
    const folderId = await createFolder(app, owner);
    await grant(app, owner, folderId, member.membershipId, "viewer");
    const prefix = `org/personal/${folderId}/`;
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => (
      env.BOX_IMAGES.put(`${prefix}${index}.txt`, String(index), {
        customMetadata: { mtime: "1", "edited-by": "Operator" },
      })
    )));
    const response = await appRequest(app, `/folders/${folderId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    });
    expect(response.status).toBe(204);
    expect((await env.BOX_IMAGES.list({ prefix })).objects).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM folders WHERE id = ?1").bind(folderId).first<number>("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM folder_grants WHERE folder_id = ?1").bind(folderId).first<number>("count")).toBe(0);
  });

  it("attaches an accessible folder and hides the attachment after revoke", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const collaborator = await sameOrgSession("workspace-owner");
    const workspace = await createWorkspace(app, collaborator.cookie);
    const folderId = await createFolder(app, owner, "Agent Notes");

    expect((await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: collaborator.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })).status).toBe(403);
    const grantId = await grant(app, owner, folderId, collaborator.membershipId, "editor");
    const attached = await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: collaborator.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    });
    expect(attached.status).toBe(201);
    await expect(attached.json()).resolves.toMatchObject({
      folder: { id: folderId, name: "Agent Notes", role: "editor" },
    });

    expect((await appRequest(app, `/folders/${folderId}/grants/${grantId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    await expect(appRequest(app, `/workspaces/${workspace.id}/folders`, {
      headers: { Cookie: collaborator.cookie },
    }).then((response) => response.json())).resolves.toEqual({ folders: [] });
  });

  it("detaches a folder from a controlled workspace", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const workspace = await createWorkspace(app, owner);
    const folderId = await createFolder(app, owner, "Detachable");
    expect((await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })).status).toBe(201);
    const listed = await appRequest(app, "/folders", { headers: { Cookie: owner } });
    await expect(listed.json()).resolves.toMatchObject({
      folders: [{ id: folderId, attachedWorkspaceIds: [workspace.id] }],
    });

    expect((await appRequest(app, `/workspaces/${workspace.id}/folders/${folderId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    expect((await appRequest(app, `/workspaces/${workspace.id}/folders/${folderId}`, {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(404);
    await expect(appRequest(app, `/workspaces/${workspace.id}/folders`, {
      headers: { Cookie: owner },
    }).then((response) => response.json())).resolves.toEqual({ folders: [] });
  });

  it("publishes with a guest path and rejects traversal", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const workspace = await createWorkspace(app, owner);
    const folderId = await createFolder(app, owner, "published-api");
    expect((await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, guestPath: "../etc" }),
    })).status).toBe(400);
    const attached = await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, guestPath: "api/server" }),
    });
    expect(attached.status).toBe(201);
    await expect(attached.json()).resolves.toMatchObject({
      folder: { id: folderId, guestPath: "api/server" },
    });
    await expect(appRequest(app, `/workspaces/${workspace.id}/folders`, {
      headers: { Cookie: owner },
    }).then((response) => response.json())).resolves.toMatchObject({
      folders: [{ id: folderId, guestPath: "api/server" }],
    });
  });

  it("renames a folder for controllers only and rejects unsafe names", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("rename-member");
    const folderId = await createFolder(app, owner, "Before");
    await grant(app, owner, folderId, member.membershipId, "editor");

    expect((await appRequest(app, `/folders/${folderId}`, {
      method: "PATCH",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "after" }),
    })).status).toBe(403);
    expect((await appRequest(app, `/folders/${folderId}`, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../escape" }),
    })).status).toBe(400);
    expect((await appRequest(app, `/folders/${folderId}`, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "after" }),
    })).status).toBe(204);
    const listed = await appRequest(app, "/folders", { headers: { Cookie: owner } });
    await expect(listed.json()).resolves.toMatchObject({
      folders: [{ id: folderId, name: "after" }],
    });
  });

  it("deletes an object for editors and refuses viewers", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("delete-member");
    const folderId = await createFolder(app, owner, "Prunable");
    const path = objectPath(folderId, "notes/prune.txt");
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "x-blitz-mtime": "10" },
      body: "bytes",
    })).status).toBe(204);

    await grant(app, owner, folderId, member.membershipId, "viewer");
    expect((await appRequest(app, path, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);
    await grant(app, owner, folderId, member.membershipId, "editor");
    expect((await appRequest(app, path, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(204);
    expect((await appRequest(app, path, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(404);
    expect((await appRequest(app, path, { headers: { Cookie: owner } })).status).toBe(404);
  });

  it("stores empty files and skips objects with unusable metadata instead of failing the listing", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const folderId = await createFolder(app, owner);
    expect((await appRequest(app, objectPath(folderId, ".gitkeep"), {
      method: "PUT",
      headers: { Cookie: owner, "x-blitz-mtime": "5", "content-length": "0" },
    })).status).toBe(204);
    await env.BOX_IMAGES.put(`org/personal/${folderId}/foreign.bin`, "no metadata here");

    const listing = await appRequest(app, `/folders/${folderId}/objects`, {
      headers: { Cookie: owner },
    });
    expect(listing.status).toBe(200);
    const body = await listing.json<{ objects: { key: string; size: number }[] }>();
    expect(body.objects).toEqual([{
      key: ".gitkeep",
      size: 0,
      mtime: 5,
      editedBy: expect.any(String),
    }]);
    const fetched = await appRequest(app, objectPath(folderId, ".gitkeep"), {
      headers: { Cookie: owner },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("");
  });

  it("aborts an in-flight multipart upload on request", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const folderId = await createFolder(app, owner);
    const created = await appRequest(app, `${objectPath(folderId, "big.bin")}/multipart`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ mtime: 7 }),
    });
    expect(created.status).toBe(201);
    const { uploadId } = await created.json<{ uploadId: string }>();
    expect((await appRequest(
      app,
      `${objectPath(folderId, "big.bin")}/multipart/${encodeURIComponent(uploadId)}`,
      { method: "DELETE", headers: { Cookie: owner } },
    )).status).toBe(204);
  });
});
