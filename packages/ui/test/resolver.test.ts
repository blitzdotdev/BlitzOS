import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@blitzos/schema";
import { endpointTarget, standaloneResolver, validPort } from "../src/resolver.js";

const workspace: WorkspaceView = {
  id: "one",
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
  it("uses only the configured localhost ports", () => {
    const resolver = standaloneResolver({ terminal: 8443, acp: 8444, files: 8445 });
    expect(resolver.resolve(workspace)).toEqual({
      terminalUrl: "http://localhost:8443/",
      acpUrl: "ws://localhost:8444",
      filesBase: "http://localhost:8445/workspace/",
    });
    expect(resolver.previewUrl(workspace, 3000)).toBe("http://localhost:3000/");
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
});
