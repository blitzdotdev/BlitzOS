import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinDefaultModeId } from "@lody/shared/ai";
import {
  createLodyLocalBridge,
  publishLodyLocalBridge,
} from "../src/lody/local-bridge.js";

afterEach(() => {
  delete window.ipc;
  delete window.__LODY_LOCAL_BRIDGE__;
  delete window.__BLITZ_BUILTIN_DEFAULT_MODE_IDS__;
});

describe("the builtin permission-mode host override", () => {
  it("uses the BlitzOS Claude default only while its local bridge is published", () => {
    expect(getBuiltinDefaultModeId("builtin", "claude")).toBe("auto");

    const bridge = createLodyLocalBridge({
      syncUrl: "wss://box.invalid/webapp/7445/lody/sync",
      rpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
      controlUrl: "https://box.invalid/webapp/7445/lody/control",
      projectUrl: "https://box.invalid/webapp/7445/lody/project",
      platformUrl: "https://box.invalid/webapp/7445/lody/platform",
      filesBase: "https://box.invalid/webapp/5000/",
    });
    const unpublish = publishLodyLocalBridge(bridge);
    try {
      expect(getBuiltinDefaultModeId("builtin", "claude")).toBe("bypassPermissions");
      expect(getBuiltinDefaultModeId("builtin", "codex")).toBe("agent-auto-review");
    } finally {
      unpublish();
      bridge.dispose();
    }

    expect(getBuiltinDefaultModeId("builtin", "claude")).toBe("auto");
  });
});
