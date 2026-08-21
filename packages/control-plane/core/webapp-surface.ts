/** The paths the browser app may reach on a workspace box.
 *
 * A box exposes far more than the app uses — the agent's home directory sat
 * beside /workspace on the file server, and both the gateway and the actor
 * answer an administrative drain — so the proxy forwards only these paths.
 *
 * This is a copy of `@blitzos/schema`'s `webapp-surface`, kept because core
 * stays portable and imports nothing outside itself (see
 * `test/core-imports.test.ts`). The two are pinned together by
 * `test/webapp-surface-drift.test.ts`, the same way `wire.ts` mirrors the
 * schema types. */

export const WEBAPP_AGENT_SURFACES = ["/"] as const;
export const WEBAPP_FILES_SURFACES = ["/ports", "/previews", "/preview-focus", "/terminal/ws"] as const;
export const WEBAPP_FILES_SURFACE_PREFIXES = ["/workspace/", "/preview/"] as const;

export function isWebAppSurfacePath(port: 7444 | 7445, path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  // Rejects traversal out of an allowed prefix, raw and percent-encoded.
  if (decoded.split("/").includes("..")) return false;
  if (port === 7444) return WEBAPP_AGENT_SURFACES.some((surface) => surface === decoded);
  if (WEBAPP_FILES_SURFACES.some((surface) => surface === decoded)) return true;
  if (decoded === "/workspace") return true;
  return WEBAPP_FILES_SURFACE_PREFIXES.some((prefix) => decoded.startsWith(prefix));
}
