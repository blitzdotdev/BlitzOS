/**
 * SWITCHING WORKSPACES MUST REBUILD THE SURFACE, BECAUSE IT REBUILDS THE BOX.
 *
 * The field report: create workspace B, switch A → B → A, and the sessions
 * surface never populates until the page is reloaded once. Terminals work
 * throughout, because ttyd never goes through the bridge.
 *
 * The cause was a constant React key. `LodySessionsRegion` mounted the owned
 * surface as `key="own"` — ONE instance covering every workspace the member
 * owns — so a switch handed that instance new props instead of building a new
 * one. `SessionSurface` builds its bridge once per instance
 * (`useLodySurfaceIpc`: `held.current ??= createLodyLocalBridge(endpoints)`)
 * and the bridge closes over the endpoints it was built with, so `window.ipc`
 * kept dialling the PREVIOUS box.
 *
 * The halves then disagreed: the snapshot poller and the capability probe key
 * on `platformUrl`, so they moved to box B and the runtime rebuilt for
 * workspace B — while its data plane still reached box A, which has no rooms
 * for B. No error was raised anywhere; the surface simply stayed empty.
 *
 * The shared branch beside it was always keyed by box
 * (`shared:${ownerMembershipId}`, "switching between two members' shared
 * sessions rebuilds the runtime"). This is the same rule, finally applied to
 * the member's own workspaces.
 */
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxEndpoints } from "../src/resolver.js";
import { render } from "./dom.js";

function boxAt(host: string): BoxEndpoints {
  return {
    terminalUrl: `https://${host}/webapp/7681/`,
    filesBase: `https://${host}/webapp/5000/`,
    lodySyncUrl: `wss://${host}/webapp/7445/lody/sync`,
    lodyRpcUrl: `https://${host}/webapp/7445/lody/rpc`,
    lodyControlUrl: `https://${host}/webapp/7445/lody/control`,
    lodyProjectUrl: `https://${host}/webapp/7445/lody/project`,
    lodyPlatformUrl: `https://${host}/webapp/7445/lody/platform`,
  } satisfies BoxEndpoints;
}

const BOX_A = boxAt("box-a.invalid");
const BOX_B = boxAt("box-b.invalid");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * Mounts the region with a stand-in surface that records the sync URL of every
 * MOUNT — not every render. A remount is the observable difference between a
 * fresh bridge and a stale one, and the mount effect is where it shows.
 */
async function mountRegion() {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const mounts: string[] = [];
  vi.doMock("../src/lody/SessionSurface.js", () => {
    const RecordedSurface = (surfaceProps: { syncUrl: string; active: boolean }) => {
      // RECORDED ONCE PER INSTANCE, not once per render. A `useState`
      // initialiser runs exactly when a component instance is created, which is
      // the same lifetime `useLodySurfaceIpc` binds its bridge to — so this
      // records precisely the event the fix is about. Pushing from the render
      // body instead would count re-renders and pass no matter what the key is.
      useState(() => {
        mounts.push(surfaceProps.syncUrl);
        return null;
      });
      return <div data-testid="surface" data-active={surfaceProps.active} />;
    };
    return {
      default: (props: { endpoints: { syncUrl: string }; surfaceKey: string; active: boolean }) => (
        <RecordedSurface
          key={props.surfaceKey}
          syncUrl={props.endpoints.syncUrl}
          active={props.active}
        />
      ),
    };
  });
  const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");

  const element = (endpoints: BoxEndpoints, visible = true) => (
    <LodySessionsRegion
      endpoints={endpoints}
      sessions="present"
      viewerName="Me"
      viewerAvatarUrl={null}
      workspaceTitle="Workspace"
      visible={visible}
      railHost={null}
      terminals={[]}
      activeTerminalId=""
      onSelectTerminal={() => undefined}
    />
  );

  const view = await render(element(BOX_A));
  const show = async (endpoints: BoxEndpoints, visible = true): Promise<void> => {
    await act(async () => view.root.render(element(endpoints, visible)));
    await act(async () => {
      await Promise.resolve();
    });
  };
  await act(async () => {
    await Promise.resolve();
  });
  return { mounts, show, view };
}

describe("switching between owned workspaces", () => {
  it("builds a new surface for a new box, so the bridge is never stale", async () => {
    const { mounts, show, view } = await mountRegion();
    expect(mounts).toEqual([BOX_A.lodySyncUrl]);

    // A → B. The old instance must not simply be handed B's props: its bridge
    // was built against A and cannot be re-pointed.
    await show(BOX_B);
    expect(mounts).toEqual([BOX_A.lodySyncUrl, BOX_B.lodySyncUrl]);

    // B → A, the half of the report that needed a page reload.
    await show(BOX_A);
    expect(mounts).toEqual([BOX_A.lodySyncUrl, BOX_B.lodySyncUrl, BOX_A.lodySyncUrl]);

    await view.unmount();
  });

  it("does not rebuild while the box stays the same", async () => {
    const { mounts, show, view } = await mountRegion();
    expect(mounts).toHaveLength(1);

    // The shell re-renders on a keystroke, a poll and a tab switch, and
    // `lodyEndpoints` builds a fresh object every time. Rebuilding on that
    // would throw away a live runtime many times a minute — so the key must
    // carry the box's IDENTITY, never the props object's.
    await show({ ...BOX_A });
    await show({ ...BOX_A }, false);
    expect(mounts).toEqual([BOX_A.lodySyncUrl]);
    expect(
      view.container.querySelector("[data-testid='surface']")?.getAttribute("data-active"),
    ).toBe("false");

    await view.unmount();
  });
});
