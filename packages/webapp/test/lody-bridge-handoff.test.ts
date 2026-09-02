/**
 * `window.ipc` IS A SINGLETON, AND A WORKSPACE SWITCH NOW HANDS IT OVER.
 *
 * The keep-alive pool retains both surfaces while activation hands the one
 * compatibility global from the old owner to the new owner. React may install
 * the incoming bridge before it runs the departing owner's cleanup.
 *
 * The uninstall returned by `installLodyLocalBridge` used to `delete
 * target.ipc` unconditionally, without asking whether the global was still its
 * own. So the OLD surface's cleanup deleted the NEW surface's bridge, and the
 * incoming retained surface's compatibility callers then found no `window.ipc`.
 */
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLodyLocalBridge, installLodyLocalBridge } from "../src/lody/local-bridge.js";
import type { LodyLocalBridgeEndpoints } from "../src/lody/local-bridge.js";
import { useLodySurfaceIpc, useLodySurfaceIpcLifecycle } from "../src/lody/surface-ipc.js";
import { render, settle } from "./dom.js";

function endpointsFor(host: string): LodyLocalBridgeEndpoints {
  return {
    syncUrl: `wss://${host}/webapp/7445/lody/sync`,
    rpcUrl: `https://${host}/webapp/7445/lody/rpc`,
    controlUrl: `https://${host}/webapp/7445/lody/control`,
    projectUrl: `https://${host}/webapp/7445/lody/project`,
    platformUrl: `https://${host}/webapp/7445/lody/platform`,
    filesBase: `https://${host}/webapp/5000/`,
  };
}

/** A stand-in for `window`, so a case never leaves the real global installed. */
function fakeWindow() {
  // SAFETY: publication only reads/writes the two optional Lody bridge globals
  // on this isolated object; no native Window implementation is exercised.
  return {} as unknown as Window & typeof globalThis;
}

afterEach(() => {
  delete window.ipc;
  delete window.__LODY_LOCAL_BRIDGE__;
  vi.restoreAllMocks();
});

function SurfaceBridgeProbe(props: {
  name: string;
  active: boolean;
  bridges: Map<string, NonNullable<Window["ipc"]>>;
}) {
  const held = useLodySurfaceIpc(endpointsFor(`${props.name}.invalid`));
  props.bridges.set(props.name, held.bridge.ipc);
  useLodySurfaceIpcLifecycle(held, props.active);
  return null;
}

describe("handing window.ipc from one box's surface to the next", () => {
  it("leaves the incoming bridge installed when the outgoing one cleans up", () => {
    const target = fakeWindow();
    const outgoing = createLodyLocalBridge(endpointsFor("box-a.invalid"));
    const incoming = createLodyLocalBridge(endpointsFor("box-b.invalid"));

    const uninstallOutgoing = installLodyLocalBridge(outgoing, target);
    // The new surface renders and installs before the old one's effect cleanup
    // runs — that ordering is the whole hazard.
    installLodyLocalBridge(incoming, target);
    uninstallOutgoing();

    // THE REGRESSION: this was `undefined`, and the incoming runtime booted with
    // no bridge to reach its box through.
    expect(target.ipc).toBe(incoming.ipc);
    expect(target.__LODY_LOCAL_BRIDGE__).toBe(true);
  });

  it("still clears the global when the last surface leaves", () => {
    const target = fakeWindow();
    const only = createLodyLocalBridge(endpointsFor("box-a.invalid"));
    const uninstall = installLodyLocalBridge(only, target);
    expect(target.ipc).toBe(only.ipc);

    uninstall();

    // A surface that really is the last one must not leave a dead bridge behind
    // for the next mount to find.
    expect(target.ipc).toBeUndefined();
    expect(target.__LODY_LOCAL_BRIDGE__).toBeUndefined();
  });

  it("disposes its own bridge even when it no longer owns the global", () => {
    const target = fakeWindow();
    const outgoing = createLodyLocalBridge(endpointsFor("box-a.invalid"));
    const incoming = createLodyLocalBridge(endpointsFor("box-b.invalid"));
    const disposeOutgoing = vi.spyOn(outgoing, "dispose");

    const uninstallOutgoing = installLodyLocalBridge(outgoing, target);
    installLodyLocalBridge(incoming, target);
    uninstallOutgoing();

    // Ownership decides the GLOBAL, never the socket: box A's data plane has to
    // close, or a switch leaks a WebSocket per visited workspace.
    expect(disposeOutgoing).toHaveBeenCalledTimes(1);
    expect(target.ipc).toBe(incoming.ipc);
  });

  it("rejects invokes after the bound bridge is disposed", async () => {
    const bridge = createLodyLocalBridge(endpointsFor("box-a.invalid"));
    const invoke = bridge.ipc.invoke;
    bridge.dispose();

    await expect(invoke("loro.isConnected")).rejects.toThrow("lody_ipc_bridge_disposed");
    expect(() => bridge.ipc.send("loro.subscribe", null)).not.toThrow();
  });

  it("reports a daemon identity change observed through the platform door", async () => {
    const continuity: string[] = [];
    let read = 0;
    const fetchImpl = vi.fn(async () => {
      read += 1;
      return new Response(JSON.stringify({
        identity: { userId: "local:user" },
        machine: { machineId: read === 1 ? "machine-a" : "machine-b" },
        workspaces: [{
          workspaceId: read === 1 ? "lw_a" : "lw_b",
          name: "Lody",
          slug: "local",
          role: "admin",
          state: "active",
        }],
      }), { status: 200 });
    });
    const bridge = createLodyLocalBridge({
      ...endpointsFor("box-a.invalid"),
      fetchImpl,
      onContinuity: (event) => continuity.push(event),
    });

    await bridge.ipc.invoke("localPlatform.getSnapshot");
    await bridge.ipc.invoke("localPlatform.getSnapshot");
    expect(continuity).toEqual(["identity-change"]);
    bridge.dispose();
  });

  it("publishes window.ipc from the active retained surface only", async () => {
    const bridges = new Map<string, NonNullable<Window["ipc"]>>();
    const tree = (active: "a" | "b") => createElement(
      "div",
      null,
      createElement(SurfaceBridgeProbe, { name: "a", active: active === "a", bridges }),
      createElement(SurfaceBridgeProbe, { name: "b", active: active === "b", bridges }),
    );
    const view = await render(tree("a"));
    expect(window.ipc).toBe(bridges.get("a"));

    await act(async () => view.root.render(tree("b")));
    expect(window.ipc).toBe(bridges.get("b"));
    await view.unmount();
    await settle();
    expect(window.ipc).toBeUndefined();
  });
});
