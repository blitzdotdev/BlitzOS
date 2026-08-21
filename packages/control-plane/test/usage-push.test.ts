import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { WebAppPort } from "../core/providers/types.js";
import { runFileSyncSweep } from "../core/files/sync.js";
import { runUsageCapturePush } from "../core/files/usage-push.js";
import type { SyncBudget } from "../core/files/dav.js";
import {
  appRequest,
  appWithProviders,
  createWorkspace,
  FakeProviders,
  operatorSession,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

interface GuestFile {
  body: string;
  mtime: number;
}

const USAGE_ROOT = "/workspace/shared/agent-usage/";

function davEntryXml(href: string, file?: GuestFile): string {
  const properties = file === undefined
    ? "<D:resourcetype><D:collection/></D:resourcetype>"
    : `<D:getcontentlength>${new TextEncoder().encode(file.body).byteLength}</D:getcontentlength>
<D:getlastmodified>${new Date(file.mtime).toUTCString()}</D:getlastmodified>
<D:resourcetype></D:resourcetype>`;
  return `
<D:response><D:href>${href}</D:href>
<D:propstat><D:prop>${properties}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

/** Depth-1 listing of one directory of the usage tree, dufs-shaped. */
function davListing(path: string, files: Map<string, GuestFile>): string {
  const encodedDirectory = path.slice(USAGE_ROOT.length).replace(/\/$/u, "");
  const directory = encodedDirectory === ""
    ? ""
    : `${encodedDirectory.split("/").map(decodeURIComponent).join("/")}/`;
  const entries: string[] = [davEntryXml(path)];
  const childDirectories = new Set<string>();
  for (const [key, file] of files) {
    if (!key.startsWith(directory)) continue;
    const relative = key.slice(directory.length);
    const separator = relative.indexOf("/");
    if (separator === -1) {
      entries.push(davEntryXml(`${path}${encodeURIComponent(relative)}`, file));
    } else {
      childDirectories.add(relative.slice(0, separator));
    }
  }
  for (const child of childDirectories) {
    entries.push(davEntryXml(`${path}${encodeURIComponent(child)}/`));
  }
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entries.join("")}
</D:multistatus>`;
}

/** A guest whose only WebDAV surface is the read-only usage tree. Any write
 * (PUT, MKCOL, anything but PROPFIND/GET) is recorded as a violation of the
 * push-only contract. */
class UsageGuestProviders extends FakeProviders {
  readonly files = new Map<string, GuestFile>();
  hasUsageRoot = true;
  reads = 0;
  readonly guestWrites: string[] = [];

  async proxyWebApp(
    _id: string,
    _port: WebAppPort,
    path: string,
    request: Request,
  ): Promise<Response | null> {
    if (request.method === "PROPFIND") {
      if (!this.hasUsageRoot || !path.startsWith(USAGE_ROOT)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(davListing(path, this.files), {
        status: 207,
        headers: { "Content-Type": "application/xml" },
      });
    }
    if (request.method === "GET") {
      this.reads += 1;
      const key = path.startsWith(USAGE_ROOT)
        ? path.slice(USAGE_ROOT.length).split("/").map(decodeURIComponent).join("/")
        : null;
      const file = key === null ? undefined : this.files.get(key);
      return file === undefined
        ? new Response("not found", { status: 404 })
        : new Response(file.body, { headers: { "Content-Type": "text/plain" } });
    }
    this.guestWrites.push(`${request.method} ${path}`);
    return new Response(null, { status: 201 });
  }
}

async function capturingWorkspace(providers: UsageGuestProviders): Promise<{
  app: ReturnType<typeof appWithProviders>;
  cookie: string;
  workspaceId: string;
  folderId: string;
}> {
  const app = appWithProviders(providers, providers);
  const cookie = await operatorSession(app);
  const enabled = await appRequest(app, "/orgs/self/usage-capture", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(enabled.status).toBe(200);
  const { folderId } = await enabled.json<{ folderId: string }>();
  const workspace = await createWorkspace(app, cookie);
  await env.DB.prepare("UPDATE workspaces SET phase = 'ready' WHERE id = ?1")
    .bind(workspace.id).run();
  return { app, cookie, workspaceId: workspace.id, folderId };
}

function freshBudget(): SyncBudget {
  return { files: 0, bytes: 0 };
}

describe("agent-usage capture push", () => {
  beforeEach(resetDatabase);

  it("pushes the usage tree under <workspaceId>/ with a meta.json sidecar, push-only", async () => {
    const providers = new UsageGuestProviders();
    const { workspaceId, folderId } = await capturingWorkspace(providers);
    providers.files.set("claude/projects/session-1.jsonl", { body: "claude-blob", mtime: 5_000 });
    providers.files.set("codex/rollout-1.jsonl", { body: "codex-blob", mtime: 6_000 });
    const runtime = testRuntime(providers);
    const prefix = `org/personal/${folderId}/${workspaceId}/`;
    // A remote-only object must be left alone: never copied down, never deleted.
    await env.BOX_IMAGES.put(`${prefix}claude/stale.jsonl`, "remote-only", {
      customMetadata: { mtime: "1000", "edited-by": "Operator" },
    });

    const result = await runUsageCapturePush(runtime, freshBudget());
    expect(result).toEqual({ workspaces: 1, files: 2 });

    expect(await env.BOX_IMAGES.get(`${prefix}claude/projects/session-1.jsonl`)
      .then((object) => object?.text())).toBe("claude-blob");
    expect(await env.BOX_IMAGES.get(`${prefix}codex/rollout-1.jsonl`)
      .then((object) => object?.text())).toBe("codex-blob");
    expect((await env.BOX_IMAGES.head(`${prefix}claude/projects/session-1.jsonl`))
      ?.customMetadata?.mtime).toBe("5000");
    expect(await env.BOX_IMAGES.get(`${prefix}claude/stale.jsonl`)
      .then((object) => object?.text())).toBe("remote-only");

    const meta = await env.BOX_IMAGES.get(`${prefix}meta.json`);
    expect(await meta?.json()).toEqual({
      workspaceId,
      recipeId: null,
      ownerName: "Operator",
      workspaceName: expect.any(String),
    });
    expect(meta?.customMetadata?.mtime).toMatch(/^\d+$/u);

    // Push only: the guest saw no PUT and no MKCOL, and nothing landed in it.
    expect(providers.guestWrites).toEqual([]);
    expect(providers.files.has("claude/stale.jsonl")).toBe(false);

    // Converged: a second pass re-reads listings but transfers nothing.
    const readsAfterFirst = providers.reads;
    expect(await runUsageCapturePush(runtime, freshBudget()))
      .toEqual({ workspaces: 0, files: 0 });
    expect(providers.reads).toBe(readsAfterFirst);

    // The sidecar is rewritten on every pass, so display names stay fresh
    // even when no transcript moved.
    await env.DB.prepare("UPDATE workspaces SET name = 'renamed-run' WHERE id = ?1")
      .bind(workspaceId).run();
    expect(await runUsageCapturePush(runtime, freshBudget()))
      .toEqual({ workspaces: 0, files: 0 });
    expect(await env.BOX_IMAGES.get(`${prefix}meta.json`).then((object) => object?.json()))
      .toMatchObject({ workspaceName: "renamed-run" });

    // A changed transcript is re-pushed.
    providers.files.set("codex/rollout-1.jsonl", { body: "codex-blob-more", mtime: 7_000 });
    expect(await runUsageCapturePush(runtime, freshBudget()))
      .toEqual({ workspaces: 1, files: 1 });
    expect(await env.BOX_IMAGES.get(`${prefix}codex/rollout-1.jsonl`)
      .then((object) => object?.text())).toBe("codex-blob-more");
  });

  it("stamps the launching recipe into meta.json", async () => {
    const providers = new UsageGuestProviders();
    const { app, cookie, workspaceId, folderId } = await capturingWorkspace(providers);
    const template = await appRequest(app, "/workspace-templates", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "usage", machineTypeId: "small", folderIds: [] }),
    });
    const templateId = (await template.json<{ template: { id: string } }>()).template.id;
    const created = await appRequest(app, "/workspace-recipes", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "provenance",
        templateId,
        harness: "codex",
        prompt: "Go.\n",
      }),
    });
    const recipeId = (await created.json<{ recipe: { id: string } }>()).recipe.id;
    await env.DB.prepare("UPDATE workspaces SET recipe_id = ?1 WHERE id = ?2")
      .bind(recipeId, workspaceId).run();
    providers.files.set("claude/projects/a.jsonl", { body: "blob", mtime: 5_000 });

    await runUsageCapturePush(testRuntime(providers), freshBudget());
    const meta = await env.BOX_IMAGES
      .get(`org/personal/${folderId}/${workspaceId}/meta.json`);
    expect(await meta?.json()).toMatchObject({ workspaceId, recipeId });
  });

  it("skips guests without the capture mounts and orgs without capture", async () => {
    const providers = new UsageGuestProviders();
    const { folderId, workspaceId } = await capturingWorkspace(providers);
    providers.hasUsageRoot = false;
    const runtime = testRuntime(providers);

    expect(await runUsageCapturePush(runtime, freshBudget()))
      .toEqual({ workspaces: 0, files: 0 });
    expect(providers.guestWrites).toEqual([]);
    expect(await env.BOX_IMAGES.head(`org/personal/${folderId}/${workspaceId}/meta.json`))
      .toBeNull();

    // Capture off: even a guest with files stays untouched.
    providers.hasUsageRoot = true;
    providers.files.set("claude/projects/a.jsonl", { body: "blob", mtime: 5_000 });
    await env.DB.prepare("UPDATE orgs SET usage_capture = 0 WHERE id = 'personal'").run();
    expect(await runUsageCapturePush(runtime, freshBudget()))
      .toEqual({ workspaces: 0, files: 0 });
    expect(await env.BOX_IMAGES.head(`org/personal/${folderId}/${workspaceId}/meta.json`))
      .toBeNull();
  });

  it("stops exporting when the usage folder is deleted and the org id dangles", async () => {
    // orgs.usage_folder_id deliberately has no foreign key and folder
    // deletion no longer clears it; the inner join on folders is the whole
    // guard, so a dangling id must yield a silent no-op.
    const providers = new UsageGuestProviders();
    const { folderId, workspaceId } = await capturingWorkspace(providers);
    providers.files.set("claude/projects/a.jsonl", { body: "blob", mtime: 5_000 });
    await env.DB.prepare("DELETE FROM folders WHERE id = ?1").bind(folderId).run();

    expect(await runUsageCapturePush(testRuntime(providers), freshBudget()))
      .toEqual({ workspaces: 0, files: 0 });
    expect(providers.guestWrites).toEqual([]);
    expect(await env.BOX_IMAGES.head(`org/personal/${folderId}/${workspaceId}/meta.json`))
      .toBeNull();
  });

  it("rides the file-sync sweep with the shared budget", async () => {
    const providers = new UsageGuestProviders();
    const { folderId, workspaceId } = await capturingWorkspace(providers);
    providers.files.set("claude/projects/a.jsonl", { body: "blob", mtime: 5_000 });

    const swept = await runFileSyncSweep(testRuntime(providers));
    expect(swept.files).toBe(1);
    expect(await env.BOX_IMAGES.get(`org/personal/${folderId}/${workspaceId}/claude/projects/a.jsonl`)
      .then((object) => object?.text())).toBe("blob");
  });
});
