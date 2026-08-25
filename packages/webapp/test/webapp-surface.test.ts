import { isWebAppSurfacePath } from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import { connectionsFocusEndpointUrl } from "../src/connections-focus.js";
import { previewFocusEndpointUrl } from "../src/preview.js";
import { standaloneResolver } from "../src/resolver.js";
import { terminalWebSocketUrl } from "../src/workspace-endpoints.js";

/** The control plane forwards only the paths in `isWebAppSurfacePath`, so a
 * URL this app builds that falls outside it is a feature that 403s in
 * production. Both sides import the same list; this binds the app's URLs to
 * it so the two cannot drift apart silently. */
describe("webApp box surface", () => {
  const origin = "https://cp.example";
  const emptyConnections: string[] = [];
  const workspace = {
    id: "workspace-one",
    name: "workspace-one",
    machineTypeId: "cx23@fsn1",
    phase: "ready",
    retryAction: null,
    canObserve: true,
    launchable: true,
    revision: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ssh: null,
    volumeId: null,
    error: null,
    role: "owner",
    orgShareRole: null,
    owner: { name: "Owner", avatarUrl: null },
    environment: null,
    agentRuleId: null,
    connections: emptyConnections,
  } as const;

  function boxPath(url: string): { port: 7444 | 7445; path: string } {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/workspaces\/[^/]+\/webapp\/(7444|7445)(.*)$/u);
    if (match === null) throw new Error(`not a webApp URL: ${url}`);
    return {
      port: match[1] === "7444" ? 7444 : 7445,
      path: match[2] === "" ? "/" : match[2]!,
    };
  }

  it("only builds URLs the control plane will forward", () => {
    const resolver = standaloneResolver({ acp: 7444, files: 7445 }, origin);
    const endpoints = resolver.resolve(workspace);
    const urls = [
      endpoints.acpUrl,
      endpoints.filesBase,
      `${endpoints.filesBase}notes/report.md`,
      terminalWebSocketUrl(endpoints.terminalUrl),
      resolver.previewUrl(workspace, 3000),
      previewFocusEndpointUrl(endpoints.filesBase),
      connectionsFocusEndpointUrl(endpoints.filesBase),
    ];
    for (const url of urls) {
      const { port, path } = boxPath(url);
      expect(isWebAppSurfacePath(port, path), url).toBe(true);
    }
  });

  it("keeps the box's other doors shut", () => {
    // The agent's home directory sits beside /workspace on the file server,
    // and both the gateway and the actor answer an administrative drain.
    for (const path of [
      "/home/",
      "/home/.claude/.credentials.json",
      "/workspace/%2e%2e/home/.claude.json",
      "/admin/drain",
      "/acp",
    ]) {
      expect(isWebAppSurfacePath(7445, path), path).toBe(false);
    }
    expect(isWebAppSurfacePath(7444, "/admin/drain")).toBe(false);
  });
});
