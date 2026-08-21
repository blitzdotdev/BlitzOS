import type { CoreRuntime } from "../runtime.js";

/**
 * Guest WebDAV transfer plumbing shared by the two sync legs: the two-way
 * folder-attachment pass in `sync.ts` and the push-only agent-usage capture
 * in `usage-push.ts`. Split out of `sync.ts` (which was brushing the
 * 700-line warn) when the second consumer arrived.
 *
 * Paid Workers allow 10,000 subrequests per invocation. A transfer consumes
 * at most two data subrequests (R2 + guest), so 128 transfers reserve more
 * than 97% of the allowance for D1, paginated R2 listings, and Depth:1
 * PROPFINDs. Hourly Cron Triggers have 15 minutes of CPU time; immediate
 * waitUntil work is stricter at 30 seconds, so a tick also stops before
 * starting more than 256 MiB of streaming transfer work. Both legs of a tick
 * share one budget.
 */
export const FILE_SYNC_MAX_FILES_PER_TICK = 128;
export const FILE_SYNC_MAX_BYTES_PER_TICK = 256 * 1024 * 1024;

const DAV_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
/** One PROPFIND per directory: past this many the tick reports the truncation
 * and syncs what it listed rather than blowing the subrequest allowance. */
const FILE_SYNC_MAX_GUEST_DIRECTORIES = 512;
export const MTIME_METADATA = "mtime";
export const EDITED_BY_METADATA = "edited-by";

/** The routing identity a guest transfer needs: which workspace, its VM for
 * provider proxying, and its tunnel hostname for the cloud-VM path. */
export interface GuestChannel {
  workspace_id: string;
  vm_id: string;
  tunnel_hostname: string | null;
}

export interface DavEntry {
  key: string;
  size: number;
  mtime: number;
}

export interface DavListing {
  files: DavEntry[];
  directories: string[];
}

export interface RemoteEntry {
  object: R2Object;
  key: string;
  size: number;
  mtime: number;
}

export interface SyncBudget {
  files: number;
  bytes: number;
}

export function guestObjectPath(root: string, key: string): string {
  return `${root}${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function guestRequest(
  runtime: CoreRuntime,
  channel: GuestChannel,
  path: string,
  request: Request,
): Promise<Response> {
  const provider = runtime.providers.vmRegistry.forVmId(channel.vm_id);
  if (provider?.proxyWebApp !== undefined) {
    const response = await provider.proxyWebApp(channel.vm_id, 7445, path, request);
    if (response !== null) return response;
    throw new Error("workspace WebDAV proxy returned no response");
  }
  const tunnels = runtime.providers.workspaceTunnels;
  if (tunnels === undefined || channel.tunnel_hostname === null) {
    throw new Error("workspace WebDAV has no authenticated proxy path");
  }
  return tunnels.proxy(
    channel.tunnel_hostname,
    channel.workspace_id,
    7445,
    path,
    request,
  );
}

async function boundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`file exceeds the ${String(maxBytes)}-byte buffered-transfer cap`);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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

/** Depth-1 PROPFIND walk of the guest tree under `root`. Returns null when
 * the root does not exist guest-side; the caller decides whether that means
 * "materialize it" (folder attachments) or "nothing to do" (usage push). */
export async function listGuestTree(
  runtime: CoreRuntime,
  channel: GuestChannel,
  root: string,
): Promise<Map<string, DavEntry> | null> {
  const rootRequest = new Request("https://control-plane.invalid", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  const response = await guestRequest(runtime, channel, root, rootRequest);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 207) {
    throw new Error(`WebDAV PROPFIND failed with status ${response.status}`);
  }
  const files = new Map<string, DavEntry>();
  const queue: string[] = [];
  let truncated = false;
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
      channel,
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
      if (seenDirectories.size >= FILE_SYNC_MAX_GUEST_DIRECTORIES) {
        truncated = true;
        continue;
      }
      seenDirectories.add(child);
      queue.push(child);
    }
  }
  if (truncated) {
    runtime.reportError(
      "folder_sync_listing_truncated",
      new Error(`guest listing capped at ${String(FILE_SYNC_MAX_GUEST_DIRECTORIES)} directories under ${root}`),
    );
  }
  return files;
}

/** Returns null for objects whose metadata is unusable so one foreign or
 * corrupt object can never wedge the folder's sync forever. */
function remoteEntry(object: R2Object, prefix: string): RemoteEntry | null {
  const value = object.customMetadata?.[MTIME_METADATA];
  if (value === undefined || !/^\d+$/u.test(value)) {
    return null;
  }
  const mtime = Number(value);
  if (!Number.isSafeInteger(mtime)) return null;
  return { object, key: object.key.slice(prefix.length), size: object.size, mtime };
}

export async function listRemoteUnder(
  runtime: CoreRuntime,
  prefix: string,
): Promise<Map<string, RemoteEntry>> {
  const objects = new Map<string, RemoteEntry>();
  let skipped = 0;
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
      if (entry === null) skipped += 1;
      else objects.set(entry.key, entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  if (skipped > 0) {
    runtime.reportError(
      "folder_sync_invalid_metadata",
      new Error(`skipped ${String(skipped)} objects under ${prefix}`),
    );
  }
  return objects;
}

export function reserve(budget: SyncBudget, size: number): boolean {
  if (budget.files >= FILE_SYNC_MAX_FILES_PER_TICK) return false;
  if (size > FILE_SYNC_MAX_BYTES_PER_TICK - budget.bytes) return false;
  budget.files += 1;
  budget.bytes += size;
  return true;
}

export async function copyUp(
  runtime: CoreRuntime,
  channel: GuestChannel,
  root: string,
  guest: DavEntry,
  objectKey: string,
  editedBy: string,
): Promise<void> {
  const response = await guestRequest(
    runtime,
    channel,
    guestObjectPath(root, guest.key),
    new Request("https://control-plane.invalid"),
  );
  if (!response.ok || response.body === null) {
    throw new Error(`WebDAV GET failed with status ${response.status}`);
  }
  // R2 put needs a known length. When the tunnel compressed the response,
  // the runtime hands us the decompressed body but keeps the compressed
  // content-length, so no declared size can be trusted — buffer those,
  // bounded by the chunk cap. Identity responses pin to the GET's own
  // content-length, falling back to the DAV listing.
  const metadata = new Headers(response.headers);
  metadata.delete("content-encoding");
  metadata.delete("content-length");
  const customMetadata = {
    [MTIME_METADATA]: String(guest.mtime),
    [EDITED_BY_METADATA]: editedBy,
  };
  if (response.headers.get("content-encoding") !== null) {
    await runtime.fileObjects.put(
      objectKey,
      await boundedBytes(response, FILE_SYNC_MAX_BYTES_PER_TICK),
      { httpMetadata: metadata, customMetadata },
    );
    return;
  }
  const declared = response.headers.get("content-length");
  const pinnedSize = declared !== null && /^\d+$/u.test(declared)
    ? Number(declared)
    : guest.size;
  await runtime.fileObjects.put(
    objectKey,
    response.body.pipeThrough(new FixedLengthStream(pinnedSize)),
    { httpMetadata: metadata, customMetadata },
  );
}
