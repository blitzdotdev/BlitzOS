/** The paths the browser app may reach on a workspace box.
 *
 * A box exposes far more than the app uses — the agent's home directory sat
 * beside /workspace on the file server, and the gateway answers an
 * administrative drain — so the control plane forwards only these paths. That
 * makes this list a contract between two packages: the webApp builds URLs
 * from it, the control plane refuses anything outside it. Adding a surface to
 * one side without the other silently breaks the feature (or silently widens
 * the box), so both sides import this and both are tested against it.
 */

/** Exact paths served on port 7445. */
export const WEBAPP_FILES_SURFACES = ["/diag", "/ports", "/previews", "/preview-focus", "/connections-focus", "/terminal/ws"] as const;

/** Path prefixes served on port 7445. `/workspace` also matches exactly. */
export const WEBAPP_FILES_SURFACE_PREFIXES = ["/workspace/", "/preview/"] as const;

export function isWebAppSurfacePath(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  // Rejects traversal out of an allowed prefix, raw and percent-encoded.
  if (decoded.split("/").includes("..")) return false;
  if (WEBAPP_FILES_SURFACES.some((surface) => surface === decoded)) return true;
  if (decoded === "/workspace") return true;
  return WEBAPP_FILES_SURFACE_PREFIXES.some((prefix) => decoded.startsWith(prefix));
}
