/**
 * The rail's phase-4 contract (plans/LODY-SESSIONS.md §0.3, §8).
 *
 * Two shapes, one component. With `VITE_BLITZ_LODY_SESSIONS` off the rail is
 * exactly what it was — a New tab bar and a flat row per managed tab — and the
 * shell that ships today is that shape, so it is pinned first. With the flag on
 * the list region becomes a portal host and the rail draws neither.
 *
 * What both share is the DOM path the product knows:
 * `aside.session-rail > div.session-list`, with `div.shell-rhead` between them,
 * unchanged. §0.3 renames exactly those two classes and nothing else, so this
 * asserts the old names are gone and the new ones are where they were.
 */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionRail } from "../src/shell/SessionRail.js";
import type { DriveRailSession } from "../src/shell/rail-sessions.js";
import { render } from "./dom.js";
import { workspaceModelFixture } from "./workspace-fixtures.js";

const workspace = workspaceModelFixture({ title: "rail-workspace" });

const tabs: DriveRailSession[] = [
  { id: "1", label: "claude · tab 1", agent: "claude" },
  { id: "2", label: "bash", agent: "terminal" },
];

function rail(overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  return (
    <SessionRail
      workspace={workspace}
      sessions={tabs}
      activeSessionId="2"
      livePorts={[]}
      previewLinks={[]}
      onSelectSession={() => undefined}
      onSpawnSession={() => undefined}
      onOpenPreview={() => undefined}
      onOpenPreviewLink={() => undefined}
      onOpenMembers={() => undefined}
      onOpenDetails={() => undefined}
      onOpenMachine={() => undefined}
      {...overrides}
    />
  );
}

describe("the session rail", () => {
  it("renames the two classes §0.3 names and keeps the head untouched", async () => {
    const view = await render(rail());
    expect(view.container.querySelector("aside.session-rail")).not.toBeNull();
    expect(view.container.querySelector("aside.session-rail > div.shell-rhead")).not.toBeNull();
    expect(view.container.querySelector("aside.session-rail > div.session-list")).not.toBeNull();
    // The old names are gone from the rail entirely: a selector the product or
    // a test still holds must fail loudly rather than match nothing quietly.
    expect(view.container.querySelector(".shell-rail")).toBeNull();
    expect(view.container.querySelector(".shell-list")).toBeNull();
    await view.unmount();
  });

  it("keeps the native list and the New tab bar when there is no vendored zone", async () => {
    const onSelectSession = vi.fn();
    const view = await render(rail({ onSelectSession }));
    expect(view.container.querySelector('button[aria-label="New tab"]')).not.toBeNull();
    const rows = [...view.container.querySelectorAll<HTMLButtonElement>(".session-list .shell-s")];
    expect(rows.map((row) => row.textContent)).toEqual(["claude · tab 1", "bash"]);
    // The second row is the active one, and it says so where the shell reads it.
    expect(rows[1]?.className).toContain("shell-s--on");
    await act(async () => rows[0]?.click());
    expect(onSelectSession).toHaveBeenCalledWith("1");
    await view.unmount();
  });

  it("hands the list region over and draws nothing itself when one is asked for", async () => {
    let host: HTMLDivElement | null = null;
    const view = await render(rail({ onVendorHost: (node) => { host = node; } }));
    const list = view.container.querySelector<HTMLDivElement>("div.session-list");
    expect(list?.className).toContain("session-list--vendor");
    // The host IS `div.session-list`, so the portal lands exactly where §0.3
    // puts the vendored zone rather than one wrapper deeper.
    expect(host).toBe(list);
    expect(list?.childElementCount).toBe(0);
    // The vendored zone brings its own new-chat affordance, so the native bar
    // stands down; the `+` menu survives in the tab strip and in the Terminals
    // section header (`NewTabControl`).
    expect(view.container.querySelector(".shell-newbar")).toBeNull();
    expect(view.container.querySelector(".shell-s")).toBeNull();
    // The head is untouched by the swap: it is native in both shapes.
    expect(view.container.querySelector(".shell-rhead b")?.textContent).toBe("rail-workspace");
    await view.unmount();
    expect(host).toBeNull();
  });
});
