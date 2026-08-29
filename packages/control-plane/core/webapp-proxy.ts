import type { WebAppPort } from "./compute/types.js";
import { HttpError } from "./http.js";

/**
 * WebDAV MOVE and COPY carry their target in an absolute Destination header.
 * The request URL loses the public control-plane prefix before it reaches the
 * guest, so the header must lose that same prefix. Otherwise dufs interprets
 * `/workspaces/:id/webapp/:port/...` as a path in the guest filesystem.
 */
export function rewriteWebDavDestination(
  headers: Headers,
  requestURL: URL,
  workspaceId: string,
  port: WebAppPort,
): void {
  const value = headers.get("destination");
  if (value === null) return;

  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    throw new HttpError(400, "WebDAV Destination must be an absolute URL");
  }
  const prefix = `/workspaces/${encodeURIComponent(workspaceId)}/webapp/${String(port)}`;
  const path = destination.pathname.startsWith(`${prefix}/`)
    ? destination.pathname.slice(prefix.length)
    : destination.pathname === prefix
      ? "/"
      : null;
  if (
    destination.origin !== requestURL.origin
    || destination.search !== ""
    || destination.hash !== ""
    || path === null
    || (path !== "/workspace" && !path.startsWith("/workspace/"))
  ) {
    throw new HttpError(400, "WebDAV Destination must stay on this workspace surface");
  }
  headers.set("destination", path);
}
