import { rows } from "../db.js";
import { HttpError } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreRuntime } from "../runtime.js";
import { folderObjectPrefix } from "./keys.js";
import { requireFolderAccess, type FilesActor, type FolderRole } from "./access.js";

/**
 * Paid Workers allow 10,000 subrequests per invocation. A transfer consumes at
 * most two data subrequests (R2 + guest), so 128 transfers reserve more than
 * 97% of the allowance for D1, paginated R2 listings, and Depth:1 PROPFINDs.
 * Hourly Cron Triggers have 15 minutes of CPU time; immediate waitUntil work is
 * stricter at 30 seconds, so a tick also stops before starting more than 256
 * MiB of streaming transfer work.
 */
export const FILE_SYNC_MAX_FILES_PER_TICK = 128;
export const FILE_SYNC_MAX_BYTES_PER_TICK = 256 * 1024 * 1024;

const DAV_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MTIME_METADATA = "mtime";
const EDITED_BY_METADATA = "edited-by";

interface SyncAttachmentRow {
  workspace_id: string;
  vm_id: string;
  tunnel_hostname: string | null;
  folder_id: string;
  folder_name: string;
  attached_by_membership_id: string;
  attacher_user_id: string;
  attacher_org_id: string;
  attacher_role: "admin" | "member";
  owner_name: string;
  guest_path: string | null;
}

interface DavEntry {
  key: string;
  size: number;
  mtime: number;
}

interface DavListing {
  files: DavEntry[];
  directories: string[];
}

interface RemoteEntry {
  object: R2Object;
  key: string;
  size: number;
  mtime: number;
}

interface SyncBudget {
  files: number;
  bytes: number;
}

export interface FileSyncResult {
  attachments: number;
  files: number;
  bytes: number;
}

function syncPrincipal(row: SyncAttachmentRow): Principal {
  return {
    id: row.attacher_user_id,
    unixName: "blitz",
    harnesses: [],
    membershipId: row.attached_by_membership_id,
    orgId: row.attacher_org_id,
    role: row.attacher_role,
    platformOperator: false,
  };
}

/** Published workspace directories keep their original guest path; plain
 * attachments materialize under /workspace/shared/<name>. */
function guestRoot(attachment: SyncAttachmentRow): string {
  const relative = attachment.guest_path ?? `shared/${attachment.folder_name}`;
  return `/workspace/${relative.split("/").map(encodeURIComponent).join("/")}/`;
}

function guestObjectPath(root: string, key: string): string {
  return `${root}${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function guestRequest(
  runtime: CoreRuntime,
  workspace: SyncAttachmentRow,
  path: string,
  request: Request,
): Promise<Response> {
  const provider = runtime.providers.vmRegistry.forVmId(workspace.vm_id);
  if (provider?.proxyWebApp !== undefined) {
    const response = await provider.proxyWebApp(workspace.vm_id, 7445, path, request);
    if (response !== null) return response;
    throw new Error("workspace WebDAV proxy returned no response");
  }
  const tunnels = runtime.providers.workspaceTunnels;
  if (tunnels === undefined || workspace.tunnel_hostname === null) {
    throw new Error("workspace WebDAV has no authenticated proxy path");
  }
  return tunnels.proxy(
    workspace.tunnel_hostname,
    workspace.workspace_id,
    7445,
    path,
    request,
  );
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^\d+$/u.test(declared) || Number(declared) > DAV_RESPONSE_MAX_BYTES)
  ) throw new Error("WebDAV PROPFIND response is too large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > DAV_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("WebDAV PROPFIND response is too large");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function xmlText(value: string): string {
  if (value.includes("<")) throw new Error("WebDAV property contains markup");
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const radix = code.startsWith("#x") ? 16 : 10;
    const point = Number.parseInt(code.slice(radix === 16 ? 2 : 1), radix);
    if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff) {
      throw new Error("WebDAV property contains an invalid entity");
    }
    return String.fromCodePoint(point);
  }).trim();
}

function property(block: string, name: string): string | null {
  const prefix = "(?:[A-Za-z_][\\w.-]*:)?";
  const match = new RegExp(
    `<${prefix}${name}\\b[^>]*>([\\s\\S]*?)<\\/${prefix}${name}\\s*>`,
    "iu",
  ).exec(block);
  return match?.[1] === undefined ? null : xmlText(match[1]);
}

function davRelativeKey(href: string, root: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, "https://guest.invalid").pathname;
  } catch {
    throw new Error("WebDAV response contains an invalid href");
  }
  if (!pathname.startsWith(root)) throw new Error("WebDAV href escaped the folder root");
  const encoded = pathname.slice(root.length).replace(/\/$/u, "");
  if (encoded === "") return null;
  try {
    const key = encoded.split("/").map(decodeURIComponent).join("/");
    if (
      key.includes("\\")
      || key.includes("\u0000")
      || key.split("/").some((part) => part === "" || part === "." || part === "..")
    ) throw new Error("WebDAV href contains an invalid path");
    return key;
  } catch (caught) {
    if (caught instanceof Error && caught.message.startsWith("WebDAV href")) throw caught;
    throw new Error("WebDAV href contains invalid URL encoding");
  }
}

export function parseDavListing(xml: string, root: string): DavListing {
  const responsePattern = /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/giu;
  const files: DavEntry[] = [];
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const response of xml.matchAll(responsePattern)) {
    const block = response[1];
    if (block === undefined) continue;
    const href = property(block, "href");
    if (href === null) throw new Error("WebDAV response omitted href");
    const key = davRelativeKey(href, root);
    if (key === null) continue;
    if (seen.has(key)) throw new Error("WebDAV response contains duplicate paths");
    seen.add(key);
    const type = new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?collection(?:\\s[^>]*)?\\s*/>`,
      "iu",
    ).test(block);
    if (type) {
      directories.push(key);
      continue;
    }
    const length = property(block, "getcontentlength");
    const modified = property(block, "getlastmodified");
    if (length === null || !/^\d+$/u.test(length) || modified === null) {
      throw new Error("WebDAV file response omitted size or mtime");
    }
    const size = Number(length);
    const mtime = Date.parse(modified);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtime) || mtime < 0) {
      throw new Error("WebDAV file response contains invalid size or mtime");
    }
    files.push({ key, size, mtime });
  }
  return { files, directories };
}

async function listGuest(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
): Promise<Map<string, DavEntry>> {
  const root = guestRoot(attachment);
  const rootRequest = new Request("https://control-plane.invalid", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  let response = await guestRequest(runtime, attachment, root, rootRequest);
  if (response.status === 404) {
    response = await guestRequest(
      runtime,
      attachment,
      root,
      new Request("https://control-plane.invalid", { method: "MKCOL" }),
    );
    if (response.status !== 201 && response.status !== 405) {
      throw new Error(`WebDAV MKCOL failed with status ${response.status}`);
    }
    await response.body?.cancel();
    return new Map();
  }
  if (response.status !== 207) {
    throw new Error(`WebDAV PROPFIND failed with status ${response.status}`);
  }
  const files = new Map<string, DavEntry>();
  const queue: string[] = [];
  const firstPage = parseDavListing(await boundedText(response), root);
  for (const file of firstPage.files) files.set(file.key, file);
  const seenDirectories = new Set(firstPage.directories);
  queue.push(...firstPage.directories);
  for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index];
    if (directory === undefined) continue;
    const directoryPath = `${guestObjectPath(root, directory)}/`;
    const page = await guestRequest(
      runtime,
      attachment,
      directoryPath,
      new Request("https://control-plane.invalid", {
        method: "PROPFIND",
        headers: { Depth: "1" },
      }),
    );
    if (page.status !== 207) {
      throw new Error(`WebDAV PROPFIND failed with status ${page.status}`);
    }
    const listing = parseDavListing(await boundedText(page), root);
    for (const file of listing.files) files.set(file.key, file);
    for (const child of listing.directories) {
      if (seenDirectories.has(child)) continue;
      seenDirectories.add(child);
      queue.push(child);
    }
  }
  return files;
}

function remoteEntry(object: R2Object, prefix: string): RemoteEntry {
  const value = object.customMetadata?.[MTIME_METADATA];
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`folder object ${object.key} has invalid mtime metadata`);
  }
  const mtime = Number(value);
  if (!Number.isSafeInteger(mtime)) {
    throw new Error(`folder object ${object.key} has invalid mtime metadata`);
  }
  return { object, key: object.key.slice(prefix.length), size: object.size, mtime };
}

async function listRemote(
  runtime: CoreRuntime,
  orgId: string,
  folderId: string,
): Promise<Map<string, RemoteEntry>> {
  const prefix = folderObjectPrefix(orgId, folderId);
  const objects = new Map<string, RemoteEntry>();
  let cursor: string | undefined;
  do {
    const page = await runtime.fileObjects.list({
      prefix,
      cursor,
      limit: 1_000,
      include: ["customMetadata"],
    });
    for (const object of page.objects) {
      const entry = remoteEntry(object, prefix);
      objects.set(entry.key, entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

function reserve(budget: SyncBudget, size: number): boolean {
  if (budget.files >= FILE_SYNC_MAX_FILES_PER_TICK) return false;
  if (size > FILE_SYNC_MAX_BYTES_PER_TICK - budget.bytes) return false;
  budget.files += 1;
  budget.bytes += size;
  return true;
}

async function copyDown(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  root: string,
  remote: RemoteEntry,
): Promise<void> {
  const object = await runtime.fileObjects.get(remote.object.key);
  if (object === null) return;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-length", String(object.size));
  const response = await guestRequest(
    runtime,
    attachment,
    guestObjectPath(root, remote.key),
    new Request("https://control-plane.invalid", {
      method: "PUT",
      headers,
      body: object.body,
    }),
  );
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw new Error(`WebDAV PUT failed with status ${response.status}`);
  }
  await response.body?.cancel();
}

async function copyUp(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  root: string,
  guest: DavEntry,
  objectKey: string,
): Promise<void> {
  const response = await guestRequest(
    runtime,
    attachment,
    guestObjectPath(root, guest.key),
    new Request("https://control-plane.invalid"),
  );
  if (!response.ok || response.body === null) {
    throw new Error(`WebDAV GET failed with status ${response.status}`);
  }
  await runtime.fileObjects.put(objectKey, response.body, {
    httpMetadata: response.headers,
    customMetadata: {
      [MTIME_METADATA]: String(guest.mtime),
      [EDITED_BY_METADATA]: attachment.owner_name,
    },
  });
}

function canUpload(role: FolderRole): boolean {
  return role !== "viewer";
}

async function syncAttachment(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  budget: SyncBudget,
): Promise<boolean> {
  const actor: FilesActor = {
    principal: syncPrincipal(attachment),
    editedBy: attachment.owner_name,
  };
  let folder: Awaited<ReturnType<typeof requireFolderAccess>>;
  try {
    // Revocation is enforced here before the tick touches R2 or the guest.
    folder = await requireFolderAccess(runtime.db, attachment.folder_id, actor, "read");
  } catch (caught) {
    if (caught instanceof HttpError && (caught.status === 403 || caught.status === 404)) {
      return false;
    }
    throw caught;
  }
  const root = guestRoot(attachment);
  const [remoteFiles, guestFiles] = await Promise.all([
    listRemote(runtime, folder.org_id, folder.id),
    listGuest(runtime, attachment),
  ]);
  let uploaded = false;
  const keys = new Set([...remoteFiles.keys(), ...guestFiles.keys()]);
  for (const key of [...keys].sort()) {
    const remote = remoteFiles.get(key);
    const guest = guestFiles.get(key);
    if (remote === undefined && guest !== undefined) {
      if (!canUpload(folder.role) || !reserve(budget, guest.size)) continue;
      await copyUp(
        runtime,
        attachment,
        root,
        guest,
        `${folderObjectPrefix(folder.org_id, folder.id)}${guest.key}`,
      );
      uploaded = true;
      continue;
    }
    if (remote !== undefined && guest === undefined) {
      if (!reserve(budget, remote.size)) continue;
      await copyDown(runtime, attachment, root, remote);
      continue;
    }
    if (remote === undefined || guest === undefined) continue;
    if (remote.size === guest.size && remote.mtime === guest.mtime) continue;
    if (remote.mtime >= guest.mtime) {
      if (!reserve(budget, remote.size)) continue;
      await copyDown(runtime, attachment, root, remote);
    } else if (canUpload(folder.role) && reserve(budget, guest.size)) {
      await copyUp(
        runtime,
        attachment,
        root,
        guest,
        `${folderObjectPrefix(folder.org_id, folder.id)}${guest.key}`,
      );
      uploaded = true;
    }
  }
  if (uploaded) {
    await rows(runtime.db, {
      q: "UPDATE folders SET updated_at = ?1 WHERE id = ?2",
      v: [Date.now(), folder.id],
    });
  }
  // There is deliberately no delete state. R2 restores guest-side deletions;
  // for editor+ attachments, guest files restore R2-side deletions. Viewer-only
  // guest files are ignored because that role is strictly down-sync.
  return true;
}

async function attachmentRows(
  runtime: CoreRuntime,
  folderId?: string,
): Promise<SyncAttachmentRow[]> {
  return rows<SyncAttachmentRow>(runtime.db, {
    q: `SELECT attachment.workspace_id, workspace.vm_id,
               workspace.tunnel_hostname, attachment.folder_id,
               folder.name AS folder_name,
               attachment.attached_by_membership_id,
               attacher.user_id AS attacher_user_id,
               attacher.org_id AS attacher_org_id,
               attacher.role AS attacher_role,
               owner_user.name AS owner_name, attachment.guest_path
        FROM folder_attachments attachment
        JOIN folders folder ON folder.id = attachment.folder_id
        JOIN workspaces workspace
          ON workspace.id = attachment.workspace_id
         AND workspace.phase = 'ready'
         AND workspace.vm_id IS NOT NULL
        JOIN memberships attacher
          ON attacher.id = attachment.attached_by_membership_id
         AND attacher.status = 'active'
        JOIN memberships owner ON owner.id = workspace.owner_membership_id
        JOIN users owner_user ON owner_user.id = owner.user_id
        ${folderId === undefined ? "" : "WHERE attachment.folder_id = ?1"}
        ORDER BY attachment.created_at, attachment.workspace_id, attachment.folder_id`,
    v: folderId === undefined ? [] : [folderId],
  });
}

async function runAttachments(
  runtime: CoreRuntime,
  attachments: SyncAttachmentRow[],
): Promise<FileSyncResult> {
  const budget: SyncBudget = { files: 0, bytes: 0 };
  let synced = 0;
  for (const attachment of attachments) {
    if (budget.files >= FILE_SYNC_MAX_FILES_PER_TICK) break;
    try {
      if (await syncAttachment(runtime, attachment, budget)) synced += 1;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("folder sync failed");
      runtime.reportError("folder_sync_failed", error);
    }
  }
  return { attachments: synced, files: budget.files, bytes: budget.bytes };
}

export async function runFileSyncSweep(runtime: CoreRuntime): Promise<FileSyncResult> {
  return runAttachments(runtime, await attachmentRows(runtime));
}

export async function runFolderSync(
  runtime: CoreRuntime,
  folderId: string,
): Promise<FileSyncResult> {
  return runAttachments(runtime, await attachmentRows(runtime, folderId));
}

export function scheduleFolderSync(runtime: CoreRuntime, folderId: string): void {
  const sync = runFolderSync(runtime, folderId).catch((caught) => {
    const error = caught instanceof Error ? caught : new Error("folder sync failed");
    runtime.reportError("folder_sync_failed", error);
  });
  try {
    runtime.waitUntil(sync);
  } catch (caught) {
    // Some local/managed adapters do not expose waitUntil after the response
    // lifecycle closes. The promise was already started, so the write remains
    // successful and the scheduled sweep is still the durability backstop.
    const error = caught instanceof Error ? caught : new Error("folder sync scheduling failed");
    runtime.reportError("folder_sync_schedule_failed", error);
  }
}
