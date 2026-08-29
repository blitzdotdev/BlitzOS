import { isWebAppSurfacePath } from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import { connectionsFocusEndpointUrl } from "../src/connections-focus.js";
import { previewFocusEndpointUrl } from "../src/preview.js";
import { standaloneResolver } from "../src/resolver.js";
import { terminalWebSocketUrl } from "../src/workspace-endpoints.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

/** The control plane forwards only the paths in `isWebAppSurfacePath`, so a
 * URL this app builds that falls outside it is a feature that 403s in
 * production. Both sides import the same list; this binds the app's URLs to
 * it so the two cannot drift apart silently. */
describe("webApp box surface", () => {
  const origin = "https://cp.example";
  const workspace = workspaceViewFixture();

  function boxPath(url: string): string {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/workspaces\/[^/]+\/webapp\/7445(.*)$/u);
    if (match === null) throw new Error(`not a webApp URL: ${url}`);
    return match[1] === "" ? "/" : match[1]!;
  }

  it("only builds URLs the control plane will forward", () => {
    const resolver = standaloneResolver({ files: 7445 }, origin);
    const endpoints = resolver.resolve(workspace);
    const urls = [
      endpoints.filesBase,
      `${endpoints.filesBase}notes/report.md`,
      terminalWebSocketUrl(endpoints.terminalUrl),
      resolver.previewUrl(workspace, 3000),
      previewFocusEndpointUrl(endpoints.filesBase),
      connectionsFocusEndpointUrl(endpoints.filesBase),
    ];
    for (const url of urls) {
      expect(isWebAppSurfacePath(boxPath(url)), url).toBe(true);
    }
  });

  it("keeps the box's other doors shut", () => {
    // The agent's home directory sits beside /workspace on the file server,
    // and the gateway answers an administrative drain the browser never may.
    for (const path of [
      "/home/",
      "/home/.claude/.credentials.json",
      "/workspace/%2e%2e/home/.claude.json",
      "/admin/drain",
      "/acp",
    ]) {
      expect(isWebAppSurfacePath(path), path).toBe(false);
    }
  });
});
