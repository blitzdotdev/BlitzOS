import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@blitzos/schema";
import { endpointTarget, standaloneResolver, validPort } from "../src/resolver.js";
import { terminalWebSocketUrl } from "../src/CloudApp.js";

const workspace: WorkspaceView = {
  id: "one",
  machineTypeId: "cx23@fsn1",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 1,
  ssh: null,
  volumeId: null,
  error: null,
};

describe("standalone endpoint resolver", () => {
  it("routes the terminal through the configured files origin", () => {
    const resolver = standaloneResolver({ acp: 8444, files: 8445 });
    expect(resolver.resolve(workspace)).toEqual({
      terminalUrl: "http://localhost:8445/terminal/",
      acpUrl: "ws://localhost:8444",
      filesBase: "http://localhost:8445/workspace/",
    });
    expect(resolver.previewUrl(workspace, 3000)).toBe("http://localhost:8445/preview/3000/");
  });

  it("routes microVM surfaces through the control-plane origin without forwards", () => {
    const resolver = standaloneResolver(
      { acp: 8444, files: 8445 },
      "https://cp.example.test/",
    );
    const microvm = { ...workspace, id: "micro vm/one", machineTypeId: "mv-2c2g@lab" };
    expect(resolver.resolve(microvm)).toEqual({
      terminalUrl: "https://cp.example.test/workspaces/micro%20vm%2Fone/surface/7445/terminal/",
      acpUrl: "wss://cp.example.test/workspaces/micro%20vm%2Fone/surface/7444",
      filesBase: "https://cp.example.test/workspaces/micro%20vm%2Fone/surface/7445/workspace/",
    });
    expect(resolver.previewUrl(microvm, 3000)).toBe(
      "https://cp.example.test/workspaces/micro%20vm%2Fone/surface/7445/preview/3000/",
    );
    expect(terminalWebSocketUrl(resolver.resolve(microvm).terminalUrl)).toBe(
      "wss://cp.example.test/workspaces/micro%20vm%2Fone/surface/7445/terminal/ws",
    );
  });

  it("accepts only whole ports from 1 to 65535", () => {
    expect(validPort(1)).toBe(true);
    expect(validPort(65_535)).toBe(true);
    expect(validPort(0)).toBe(false);
    expect(validPort(65_536)).toBe(false);
    expect(validPort(1.5)).toBe(false);
  });

  it("formats resolver URLs as explicit host:port targets", () => {
    expect(endpointTarget("http://localhost:7443/")).toBe("localhost:7443");
    expect(endpointTarget("wss://box.example/ws")).toBe("box.example:443");
    expect(endpointTarget("ws://box.example/ws")).toBe("box.example:80");
  });

  it("constructs the ttyd websocket path at the cockpit boundary", () => {
    expect(terminalWebSocketUrl("http://localhost:7445/terminal/")).toBe("ws://localhost:7445/terminal/ws");
    expect(terminalWebSocketUrl("https://box.example/terminal/")).toBe("wss://box.example/terminal/ws");
  });
});
