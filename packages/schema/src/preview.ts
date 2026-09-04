/** The preview contract three runtimes have to agree on.
 *
 * A preview is a TCP port inside the box that the browser reaches through the
 * gateway at `/preview/<port><path>`. Three independent readers decide whether
 * a port and a path are usable — the `blitz preview open` CLI producer, the Go
 * gateway (`parsePreviewFocus`), and the browser (`parsePreviewFocus`, plus the
 * persisted-tab parser) — and a disagreement is a real defect: a port one side
 * serves and another drops makes the preview vanish, and a path one side
 * accepts and another does not lets a tab point somewhere the reader never
 * meant to allow.
 *
 * The numbers live here, are mirrored by the two runtimes that cannot import
 * TypeScript, and are pinned across all three by
 * packages/schema/fixtures/preview-ports/reserved.json.
 */

/** Ports the box runs its own services on. A preview may never claim one:
 * 22 sshd, 7443 ttyd, 7444 (kept for boxes in the field that still run the
 * retired ACP actor), 7445 this gateway, 7446 the public
 * dufs file server, 17445 the private dufs upstream, 17789 the Lody daemon's
 * single-instance host lease (the one loopback port it cannot be talked out of
 * — everything else it serves is a unix socket). */
export const RESERVED_PREVIEW_PORTS: readonly number[] = [22, 7443, 7444, 7445, 7446, 17445, 17789];

export const MIN_PREVIEW_PORT = 1_024;
export const MAX_PREVIEW_PORT = 65_535;

/** Matches the `tabs.tabs[].path` bound the control plane enforces on the
 * persisted webApp document (packages/control-plane/core/webapp-state.ts). */
export const MAX_PREVIEW_PATH_LENGTH = 4_096;

const reserved: ReadonlySet<number> = new Set(RESERVED_PREVIEW_PORTS);

export function isPreviewPort(port: number): boolean {
  return Number.isInteger(port)
    && port >= MIN_PREVIEW_PORT
    && port <= MAX_PREVIEW_PORT
    && !reserved.has(port);
}

/** A deep-link path is usable only if it is rooted, bounded, and free of `..`
 * segments. The traversal rule is the load-bearing one: the browser normalizes
 * `/preview/<port>/a/../../workspace/` before it ever leaves the tab, so a `..`
 * a reader accepts walks the iframe out of the `/preview/<port>/` prefix onto
 * another box surface. Rooting and traversal are checked identically to the
 * file-tab rule in the control plane's webapp-state parser. */
export function isPreviewPath(path: string): boolean {
  return path.startsWith("/")
    && path.length <= MAX_PREVIEW_PATH_LENGTH
    && !path.split("/").includes("..");
}

/** A file `blitz browser open` may point the browser panel at: an absolute
 * path under `/workspace`, which the gateway serves at its `/workspace/`
 * surface. The same `..` rule as a preview path, for the same reason. */
export function isPreviewFile(file: string): boolean {
  return file.startsWith("/workspace/")
    && file.length <= MAX_PREVIEW_PATH_LENGTH
    && !/[\r\n]/u.test(file)
    && !file.split("/").includes("..");
}

/** An app URL `blitz browser open` may point the browser panel at: https with
 * a host. Whether the host is one the panel embeds is the browser's call. */
export function isPreviewAppUrl(url: string): boolean {
  if (url.length > MAX_PREVIEW_PATH_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host !== "";
  } catch {
    return false;
  }
}
