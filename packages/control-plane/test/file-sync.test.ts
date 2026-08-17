import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateVmInput, WebAppPort } from "../core/providers/types.js";
import {
  parseDavListing,
  runFileSyncSweep,
  runReadyWorkspaceFileSync,
  runWorkspaceFileSync,
  scheduledSyncsSettled,
} from "../core/files/sync.js";
import {
  appRequest,
  appWithProviders,
  createWorkspace,
  FakeProviders,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

interface GuestFile {
  body: string;
  mtime: number;
}

function davResponse(path: string, files: Map<string, GuestFile>): string {
  const entries = [...files].map(([key, file]) => `
<D:response><D:href>${path}${key.split("/").map(encodeURIComponent).join("/")}</D:href>
<D:propstat><D:prop><D:getcontentlength>${new TextEncoder().encode(file.body).byteLength}</D:getcontentlength>
<D:getlastmodified>${new Date(file.mtime).toUTCString()}</D:getlastmodified>
<D:resourcetype></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join("");
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>${entries}
</D:multistatus>`;
}

function davTreeResponse(path: string, files: Map<string, GuestFile>): string {
  const match = /^\/workspace\/shared\/[^/]+\/(.*)$/u.exec(path);
  const encodedDirectory = match?.[1]?.replace(/\/$/u, "") ?? "";
  const directory = encodedDirectory === ""
    ? ""
    : `${encodedDirectory.split("/").map(decodeURIComponent).join("/")}/`;
  const directFiles = new Map<string, GuestFile>();
  const directories = new Set<string>();
  for (const [key, file] of files) {
    if (!key.startsWith(directory)) continue;
    const relative = key.slice(directory.length);
    const separator = relative.indexOf("/");
    if (separator === -1) directFiles.set(relative, file);
    else directories.add(relative.slice(0, separator));
  }
  const directoryEntries = [...directories].map((name) => `
<D:response><D:href>${path}${encodeURIComponent(name)}/</D:href>
<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`).join("");
  return davResponse(path, directFiles).replace("\n</D:multistatus>", `${directoryEntries}\n</D:multistatus>`);
}

class WebDavProviders extends FakeProviders {
  readonly files = new Map<string, GuestFile>();
  readonly transfers: string[] = [];
  // A fresh guest has only /workspace; dufs-compliant MKCOL rejects missing
  // intermediates, so the fake enforces the same 409 to pin the chain logic.
  readonly collections = new Set<string>(["/workspace/"]);
  putMtime = 2_000;

  override async createVm(input: CreateVmInput) {
    return super.createVm(input);
  }

  async proxyWebApp(
    _id: string,
    _port: WebAppPort,
    path: string,
    request: Request,
  ): Promise<Response | null> {
    if (request.method === "PROPFIND") {
      if (this.files.size === 0 && !this.collections.has(path)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(davTreeResponse(path, this.files), {
        status: 207,
        headers: { "Content-Type": "application/xml" },
      });
    }
    if (request.method === "MKCOL") {
      if (this.collections.has(path)) return new Response(null, { status: 405 });
      const parent = `${path.replace(/\/$/u, "").split("/").slice(0, -1).join("/")}/`;
      if (parent !== "/workspace/" && !this.collections.has(parent) && this.files.size === 0) {
        return new Response("missing intermediate collection", { status: 409 });
      }
      this.collections.add(path);
      return new Response(null, { status: 201 });
    }
    const match = /^\/workspace\/shared\/[^/]+\/(.+)$/u.exec(path);
    const encodedKey = match?.[1];
    if (encodedKey === undefined) return new Response("not found", { status: 404 });
    const key = encodedKey.split("/").map(decodeURIComponent).join("/");
    if (request.method === "PUT") {
      this.transfers.push("PUT");
      this.files.set(key, { body: await request.text(), mtime: this.putMtime });
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") {
      this.transfers.push("GET");
      const file = this.files.get(key);
      return file === undefined
        ? new Response("not found", { status: 404 })
        : new Response(file.body, { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("unsupported", { status: 405 });
  }
}

async function attachedFolder(providers: WebDavProviders): Promise<{
  app: ReturnType<typeof appWithProviders>;
  cookie: string;
  folderId: string;
  workspaceId: string;
}> {
  const app = appWithProviders(providers, providers);
  const cookie = await operatorSession(app);
  const folderResponse = await appRequest(app, "/folders", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Shared" }),
  });
  const folderId = (await folderResponse.json<{ folder: { id: string } }>()).folder.id;
  const workspace = await createWorkspace(app, cookie);
  await env.DB.prepare(
    "UPDATE workspaces SET phase = 'ready' WHERE id = ?1",
  ).bind(workspace.id).run();
  const attached = await appRequest(app, `/workspaces/${workspace.id}/folders`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ folderId }),
  });
  expect(attached.status).toBe(201);
  // The attach fires a background convergence pass; settle it so tests own
  // the sync sequencing from here.
  await scheduledSyncsSettled();
  return { app, cookie, folderId, workspaceId: workspace.id };
}

describe("control-plane folder sync", () => {
  beforeEach(resetDatabase);

  it("parses the pinned dufs PROPFIND shape at its one-second mtime precision", () => {
    const root = "/workspace/shared/Team%20Notes/";
    expect(parseDavListing(davResponse(root, new Map([
      ["a & b.txt", { body: "hello", mtime: 2_000 }],
    ])), root)).toEqual({
      files: [{ key: "a & b.txt", size: 5, mtime: 2_000 }],
      directories: [],
    });
  });

  it("converges after the single identical-size echo caused by dufs PUT mtimes", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    const prefix = `org/personal/${folderId}/`;
    await env.BOX_IMAGES.put(`${prefix}note.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    const runtime = testRuntime(providers);

    expect(await runFileSyncSweep(runtime)).toMatchObject({ files: 1 });
    expect(providers.files.get("note.txt")?.body).toBe("remote");
    expect(await runFileSyncSweep(runtime)).toMatchObject({ files: 1 });
    expect((await env.BOX_IMAGES.head(`${prefix}note.txt`))?.customMetadata?.mtime).toBe("2000");
    expect(await runFileSyncSweep(runtime)).toMatchObject({ files: 0 });
    expect(providers.transfers).toEqual(["PUT", "GET"]);
  });

  it("walks nested directories once even when PROPFIND repeats the queried collection", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    providers.files.set("notes/today.txt", { body: "nested", mtime: 2_000 });

    expect(await runFileSyncSweep(testRuntime(providers))).toMatchObject({ files: 1 });
    expect(await env.BOX_IMAGES.get(`org/personal/${folderId}/notes/today.txt`).then(
      (object) => object?.text(),
    )).toBe("nested");
  });

  it("runs an immediate down-sync after a browser object PUT", async () => {
    const providers = new WebDavProviders();
    providers.putMtime = Date.now();
    const { app, cookie, folderId } = await attachedFolder(providers);
    const response = await appRequest(app, `/folders/${folderId}/objects/now.txt`, {
      method: "PUT",
      headers: { Cookie: cookie, "x-blitz-mtime": String(Date.now()) },
      body: "right away",
    });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(providers.files.get("now.txt")?.body).toBe("right away"));
  });

  it("skips a revoked attacher before touching either storage surface", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    await env.BOX_IMAGES.put(`org/personal/${folderId}/blocked.txt`, "blocked", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    await env.DB.prepare(
      "UPDATE memberships SET status = 'disabled' WHERE id = 'personal'",
    ).run();

    expect(await runFileSyncSweep(testRuntime(providers))).toEqual({
      attachments: 0,
      files: 0,
      bytes: 0,
    });
    expect(providers.transfers).toEqual([]);
  });

  it("never uploads a guest-only file for a viewer attachment", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO principals (id, unix_name, harnesses)
         VALUES ('viewer', 'viewer', '[]')`,
      ),
      env.DB.prepare(
        `INSERT INTO users
         (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
         VALUES ('viewer', 'google-viewer', 'viewer@example.com', 'Viewer', NULL, 0, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO memberships (id, user_id, org_id, role, status)
         VALUES ('viewer-membership', 'viewer', 'personal', 'member', 'active')`,
      ),
      env.DB.prepare(
        `INSERT INTO folder_grants
         (id, folder_id, membership_id, role, granted_by_membership_id, created_at)
         VALUES ('viewer-grant', ?1, 'viewer-membership', 'viewer', 'personal', ?2)`,
      ).bind(folderId, now),
      env.DB.prepare(
        `UPDATE folder_attachments SET attached_by_membership_id = 'viewer-membership'
         WHERE folder_id = ?1`,
      ).bind(folderId),
    ]);
    providers.files.set("local.txt", { body: "local", mtime: 2_000 });

    expect(await runFileSyncSweep(testRuntime(providers))).toMatchObject({ files: 0 });
    expect(await env.BOX_IMAGES.head(`org/personal/${folderId}/local.txt`)).toBeNull();
    expect(providers.transfers).toEqual([]);
  });

  it("materializes attached folders as soon as the workspace phones home ready", async () => {
    const providers = new WebDavProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const folderResponse = await appRequest(app, "/folders", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Notes" }),
    });
    const folderId = (await folderResponse.json<{ folder: { id: string } }>()).folder.id;
    await env.BOX_IMAGES.put(`org/personal/${folderId}/note.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    const workspace = await createWorkspace(app, cookie);
    // Attaching to a still-creating workspace is inert until it is ready.
    expect((await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })).status).toBe(201);
    expect(providers.files.size).toBe(0);

    await env.DB.prepare(
      "UPDATE workspaces SET ssh_host = '198.51.100.7', ssh_port = 22, ssh_user = 'blitz' WHERE id = ?1",
    ).bind(workspace.id).run();
    const ready = await appRequest(app, new URL(phoneHomeUrl(providers, workspace.id)).pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
    });
    expect(ready.status).toBe(200);
    await scheduledSyncsSettled();
    expect(providers.files.get("note.txt")?.body).toBe("remote");
  });

  it("materializes a folder onto an already-ready workspace right when it is attached", async () => {
    const providers = new WebDavProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const folderResponse = await appRequest(app, "/folders", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Notes" }),
    });
    const folderId = (await folderResponse.json<{ folder: { id: string } }>()).folder.id;
    await env.BOX_IMAGES.put(`org/personal/${folderId}/note.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    const workspace = await createWorkspace(app, cookie);
    await env.DB.prepare(
      "UPDATE workspaces SET phase = 'ready' WHERE id = ?1",
    ).bind(workspace.id).run();
    expect((await appRequest(app, `/workspaces/${workspace.id}/folders`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })).status).toBe(201);
    await scheduledSyncsSettled();
    expect(providers.files.get("note.txt")?.body).toBe("remote");
  });

  it("scopes runWorkspaceFileSync to a single workspace's attachments", async () => {
    const providers = new WebDavProviders();
    const { app, cookie, folderId, workspaceId } = await attachedFolder(providers);
    const second = await createWorkspace(app, cookie);
    await env.DB.prepare(
      "UPDATE workspaces SET phase = 'ready' WHERE id = ?1",
    ).bind(second.id).run();
    expect((await appRequest(app, `/workspaces/${second.id}/folders`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })).status).toBe(201);
    await scheduledSyncsSettled();
    await env.BOX_IMAGES.put(`org/personal/${folderId}/note.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    expect(await runWorkspaceFileSync(testRuntime(providers), workspaceId))
      .toMatchObject({ attachments: 1 });
  });

  it("creates the guest mount chain for an attached folder with no files yet", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    void folderId;
    expect([...providers.collections].sort()).toEqual([
      "/workspace/",
      "/workspace/shared/",
      "/workspace/shared/Shared/",
    ]);
  });

  it("retries the ready-time pass while the tunnel is still connecting", async () => {
    const providers = new WebDavProviders();
    const { folderId, workspaceId } = await attachedFolder(providers);
    await env.BOX_IMAGES.put(`org/personal/${folderId}/note.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    let failuresLeft = 2;
    const healthy = providers.proxyWebApp.bind(providers);
    providers.proxyWebApp = async (...args: Parameters<WebDavProviders["proxyWebApp"]>) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("tunnel is not connected yet");
      }
      return healthy(...args);
    };
    const result = await runReadyWorkspaceFileSync(
      testRuntime(providers),
      workspaceId,
      [1, 1],
    );
    expect(failuresLeft).toBe(0);
    expect(result.attachments).toBe(1);
    expect(providers.files.get("note.txt")?.body).toBe("remote");
  });

  it("skips remote objects with unusable metadata instead of wedging the folder", async () => {
    const providers = new WebDavProviders();
    const { folderId } = await attachedFolder(providers);
    await env.BOX_IMAGES.put(`org/personal/${folderId}/poison.bin`, "no metadata");
    await env.BOX_IMAGES.put(`org/personal/${folderId}/good.txt`, "remote", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });
    const reports: string[] = [];
    const runtime = { ...testRuntime(providers), reportError: (event: string) => reports.push(event) };
    expect(await runFileSyncSweep(runtime)).toMatchObject({ files: 1 });
    expect(providers.files.get("good.txt")?.body).toBe("remote");
    expect(providers.files.has("poison.bin")).toBe(false);
    expect(reports).toContain("folder_sync_invalid_metadata");
  });
});
