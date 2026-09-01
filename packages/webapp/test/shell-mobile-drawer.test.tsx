/**
 * The mobile drawer, with the vendored zone in it (phase 4 exit test, item G).
 *
 * Below 899px `ShellNav`'s wrapper stops being `display: contents` and becomes
 * the off-canvas drawer that carries the strip AND the rail. Phase 4 replaces
 * the rail's list with a portal host, and the risk that buys is structural: a
 * host handed over by ref could plausibly be created outside the drawer, or the
 * drawer could stop opening because the rail no longer renders rows. So this
 * asserts the whole path — open, host present INSIDE the drawer, scrim, close —
 * at mobile width, in both rail shapes.
 *
 * The breakpoint is read out of `strip-rail.css` rather than repeated here: a
 * test that hard-codes 899 keeps passing after somebody moves the media query.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ShellNav } from "../src/shell/ShellNav.js";
import { render } from "./dom.js";
import { workspaceModelFixture } from "./workspace-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const railCss = readFileSync(join(here, "..", "src", "strip-rail.css"), "utf8");

/** The one media query the drawer lives in. */
function drawerBreakpoint(): number {
  const block = /@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/u.exec(railCss);
  if (block === null) throw new Error("strip-rail.css has no max-width media query");
  if (!block[2]?.includes(".shell-nav--open")) {
    throw new Error("the drawer's open rule left the max-width media query");
  }
  return Number(block[1]);
}

const workspace = workspaceModelFixture({ title: "drawer-workspace" });

function nav(overrides: Partial<Parameters<typeof ShellNav>[0]> = {}) {
  return (
    <ShellNav
      workspaces={[workspace]}
      viewer={null}
      activeWorkspaceId={workspace.id}
      activeWorkspace={workspace}
      showRail
      sessions={[{ id: "1", label: "claude · tab 1", agent: "claude" }]}
      activeSessionId="1"
      livePorts={[]}
      previewLinks={[]}
      drawerOpen={false}
      onSelectWorkspace={() => undefined}
      onRenameWorkspace={() => undefined}
      onOpenWorkspaceSettings={() => undefined}
      onInviteToWorkspace={() => undefined}
      onCreateWorkspace={() => undefined}
      onSwitchOrg={() => undefined}
      onCreateOrg={() => undefined}
      onOpenDrive={() => undefined}
      onOpenSettings={() => undefined}
      onSelectSession={() => undefined}
      onCloseSession={() => undefined}
      onSpawnSession={() => undefined}
      onOpenPreview={() => undefined}
      onOpenPreviewLink={() => undefined}
      onOpenWorkspaceMembers={() => undefined}
      onOpenWorkspaceDetails={() => undefined}
      onOpenWorkspaceMachine={() => undefined}
      onCloseDrawer={() => undefined}
      {...overrides}
    />
  );
}

describe("the mobile navigation drawer", () => {
  it("opens, scrims and closes with the vendored zone inside it", async () => {
    const breakpoint = drawerBreakpoint();
    // jsdom does not lay out, so the width is asserted rather than measured:
    // what this test proves is the DOM and the callbacks, and the CSS above is
    // what makes that DOM a drawer at this width.
    window.innerWidth = breakpoint - 99;
    expect(window.innerWidth).toBeLessThan(breakpoint);

    const onCloseDrawer = vi.fn();
    const seen: { host: HTMLDivElement | null } = { host: null };
    const view = await render(
      nav({ drawerOpen: true, onCloseDrawer, onVendorHost: (node) => { seen.host = node; } }),
    );

    const drawer = view.container.querySelector<HTMLDivElement>(".shell-nav");
    expect(drawer?.className).toContain("shell-nav--open");
    // The rail rides in the drawer, and so does the vendored zone: a portal
    // host outside it would be a sidebar the drawer cannot reach.
    expect(drawer?.querySelector("aside.session-rail")).not.toBeNull();
    expect(seen.host).not.toBeNull();
    expect(drawer?.contains(seen.host)).toBe(true);
    expect(seen.host?.className).toContain("session-list--vendor");

    const scrim = view.container.querySelector<HTMLButtonElement>(".shell-nav-scrim");
    expect(scrim?.className).toContain("shell-nav-scrim--open");
    await act(async () => scrim?.click());
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("closes the drawer and drops the scrim with the flag off", async () => {
    window.innerWidth = drawerBreakpoint() - 99;
    const view = await render(nav({ drawerOpen: false }));
    expect(view.container.querySelector(".shell-nav")?.className).not.toContain("shell-nav--open");
    expect(view.container.querySelector(".shell-nav-scrim")?.className).not.toContain(
      "shell-nav-scrim--open",
    );
    // Flag off: the rail is still the native list, drawer or not.
    expect(view.container.querySelector(".session-list .shell-s")).not.toBeNull();
    expect(view.container.querySelector(".session-list--vendor")).toBeNull();
    await view.unmount();
  });
});
