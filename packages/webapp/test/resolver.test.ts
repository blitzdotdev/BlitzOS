import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@blitzos/schema";
import { standaloneResolver } from "../src/resolver.js";
import { terminalWebSocketUrl } from "../src/CloudApp.js";

const workspace: WorkspaceView = {
  id: "one",
  name: "brave-otter",
  machineTypeId: "cx23@fsn1",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 1,
  ssh: null,
  volumeId: null,
  error: null,
  role: "owner",
  orgShareRole: null,
  connections: [],
  owner: { name: "Owner", avatarUrl: null },
  environment: null,
  agentRuleId: null,
};

describe("standalone endpoint resolver", () => {
  it("routes all workspace surfaces through the control-plane origin", () => {
    const resolver = standaloneResolver("https://cp.example.test/");
    const target = { ...workspace, id: "workspace one/two" };
    expect(resolver.resolve(target)).toEqual({
      terminalUrl: "https://cp.example.test/workspaces/workspace%20one%2Ftwo/webapp/7445/terminal/",
      acpUrl: "wss://cp.example.test/workspaces/workspace%20one%2Ftwo/webapp/7444",
      filesBase: "https://cp.example.test/workspaces/workspace%20one%2Ftwo/webapp/7445/workspace/",
    });
    expect(resolver.previewUrl(target, 3000)).toBe(
      "https://cp.example.test/workspaces/workspace%20one%2Ftwo/webapp/7445/preview/3000/",
    );
    expect(terminalWebSocketUrl(resolver.resolve(target).terminalUrl)).toBe(
      "wss://cp.example.test/workspaces/workspace%20one%2Ftwo/webapp/7445/terminal/ws",
    );
  });

  it("constructs the ttyd websocket path at the webapp boundary", () => {
    expect(terminalWebSocketUrl("http://localhost:7445/terminal/")).toBe("ws://localhost:7445/terminal/ws");
    expect(terminalWebSocketUrl("https://box.example/terminal/")).toBe("wss://box.example/terminal/ws");
  });
});
