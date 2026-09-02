/**
 * `window.ipc` IS A SINGLETON, AND A WORKSPACE SWITCH NOW HANDS IT OVER.
 *
 * `LodySessionsRegion` keys the owned surface `own:${lodySyncUrl}`, so switching
 * workspaces unmounts one `SessionSurface` and mounts another. Both install a
 * bridge at `window.ipc`, and for a moment both exist: React mounts the new
 * subtree and only then runs the departing one's cleanup.
 *
 * The uninstall returned by `installLodyLocalBridge` used to `delete
 * target.ipc` unconditionally, without asking whether the global was still its
 * own. So the OLD surface's cleanup deleted the NEW surface's bridge, and the
 * new runtime — whose boot effect runs before its parent re-asserts the install,
 * because React runs child effects first — found no `window.ipc` at all. Its
 * local data plane never attached, nothing synced, and the rail's session list
 * stayed empty until the member reloaded the page. A reload has no departing
 * surface, which is exactly why it looked like a fix.
 *
 * Before the per-box key this could not happen: one surface owned the global for
 * the life of the tab, so an unconditional delete was always its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLodyLocalBridge, installLodyLocalBridge } from "../src/lody/local-bridge.js";
import type { LodyLocalBridgeEndpoints } from "../src/lody/local-bridge.js";

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
  return {} as unknown as Window & typeof globalThis;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
