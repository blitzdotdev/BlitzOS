/**
 * The flag's two halves (plans/LODY-SESSIONS.md §0.4, phase 4 item F).
 *
 * `LODY_SESSIONS_ENABLED` is read at MODULE LOAD, so every case here stubs the
 * environment variable and then imports — `vi.resetModules()` between, or the
 * second import would answer with the first one's constant.
 *
 * The rule under test: with the flag ON, a FRESH workspace holds no tabs and
 * opens the chat landing. With it off, nothing moves. And in neither case does
 * a workspace that already has a persisted document change — that document is
 * read from the server and never passes through `defaultWorkspaceTabs`.
 */
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodyRailSessions, LodyRailState } from "../src/lody/use-lody-rail.js";
import { render, settle } from "./dom.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

async function loadStorage(flag: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", flag ? "true" : "false");
  return await import("../src/storage.js");
}

/** The box answered `/lody/platform`, which is every case below: what is under
 * test here is not the pre-Lody fallback (`lody-old-box-fallback.test.tsx`).
 *
 * `surfaceHostsTabs` is `CloudApp`'s `surfaceTabsEnabled`: the session strip
 * draws this workspace's tabs. It is what decides whether the workspace ROOT is
 * normalised into the chat plane, and the cases below set it both ways. */
const SESSIONS_PRESENT = {
  capability: "present",
  surfaceHostsTabs: true,
} satisfies LodyRailSessions;

/** The same box, on a layout that cannot draw the strip — mobile. */
const SESSIONS_PRESENT_NO_STRIP = {
  capability: "present",
  surfaceHostsTabs: false,
} satisfies LodyRailSessions;

/** Mounts the hook with a route it also owns, the way `CloudApp` does. */
async function mountRail(options: {
  flag: boolean;
  path: string;
  tabsLoaded?: boolean;
  surfaceHostsTabs?: boolean;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", options.flag ? "true" : "false");
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  window.history.replaceState({}, "", options.path);
  const seen: { rail: LodyRailState | null; route: AppRoute | null } = { rail: null, route: null };

  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    const rail = useLodyRail(
      route,
      setRoute,
      route.workspaceId ?? "",
      options.tabsLoaded ?? true,
      options.surfaceHostsTabs === false ? SESSIONS_PRESENT_NO_STRIP : SESSIONS_PRESENT,
    );
    seen.rail = rail;
    seen.route = route;
    return null;
  }

  const view = await render(<Host />);
  await settle();
  return { seen, view };
}

describe("the fresh-workspace default", () => {
  it("keeps today's Claude tab with the flag off", async () => {
    const { defaultWorkspaceTabs } = await loadStorage(false);
    const tabs = defaultWorkspaceTabs();
    expect(tabs.tabs.map((tab) => tab.type)).toEqual(["claude", "panel"]);
    expect(tabs.activeId).toBe(1);
  });

  it("opens a fresh workspace with no tabs at all when sessions are on", async () => {
    const { defaultWorkspaceTabs } = await loadStorage(true);
    const tabs = defaultWorkspaceTabs();
    // §0.4: TUI tabs become opt-in. No tab is what `useLodyRail` reads as
    // "fresh", and it is what puts the chat landing on screen.
    expect(tabs.tabs).toEqual([]);
    expect(tabs.activeId).toBeNull();
    expect(tabs.nextId).toBe(1);
  });

  it("still round-trips a stored document, so no existing workspace migrates", async () => {
    const { decodeWorkspaceWebAppStateResponse } = await loadStorage(true);
    const stored = decodeWorkspaceWebAppStateResponse(
      JSON.stringify({
        updatedAt: 1,
        doc: {
          version: 1,
          agentDefault: "claude",
          tabs: { version: 1, tabs: [{ id: 7, type: "claude" }], activeId: 7, nextId: 8 },
          drawer: { version: 1, width: 340, expanded: [] },
        },
      }),
    );
    expect(stored.doc?.tabs.tabs).toEqual([{ id: 7, type: "claude" }]);
    expect(stored.doc?.tabs.activeId).toBe(7);
  });
});

describe("useLodyRail", () => {
  it("is inert with the flag off, and leaves the address where it found it", async () => {
    const { seen, view } = await mountRail({
      flag: false,
      path: "/workspaces/ws-1",
    });
    expect(seen.rail?.visible).toBe(false);
    expect(seen.rail?.onVendorHost).toBeUndefined();
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    await view.unmount();
  });

  it("sends a fresh workspace to the chat landing, without a history entry", async () => {
    const before = window.history.length;
    const { seen, view } = await mountRail({
      flag: true,
      path: "/workspaces/ws-1",
    });
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(seen.rail?.visible).toBe(true);
    expect(seen.rail?.sessionId).toBeNull();
    // `replaceState`, so the back button is not given a step the member never
    // took — the landing IS where they arrived.
    expect(window.history.length).toBe(before);
    await view.unmount();
  });

  it("sends a workspace that already HAS tabs to the landing too", async () => {
    // THIS IS THE REFRESH REPORT, and the assertion is the inverse of the one
    // that stood here. §0.4 ran once per workspace and only for a document with
    // ZERO tabs, so a returning member with tabs stayed on `/workspaces/:id` —
    // where the panes drew the native strip — for good. That strip is deleted
    // (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"), so the root address has no tab
    // control and is not somewhere anybody may be left.
    const before = window.history.length;
    const { seen, view } = await mountRail({
      flag: true,
      path: "/workspaces/ws-1",
    });
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(seen.rail?.visible).toBe(true);
    expect(window.history.length, "a correction replaces").toBe(before);
    await view.unmount();
  });

  it("leaves the root alone on a layout that draws no strip", async () => {
    // Mobile, and a box with no session plane. There is no strip to send them
    // to, so the panes keep the view and the rail is the tab list.
    const { seen, view } = await mountRail({
      flag: true,
      path: "/workspaces/ws-1",
      surfaceHostsTabs: false,
    });
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    expect(seen.rail?.visible).toBe(false);
    await view.unmount();
  });

  it("waits for the persisted document before deciding", async () => {
    const { seen, view } = await mountRail({
      flag: true,
      path: "/workspaces/ws-1",
      tabsLoaded: false,
    });
    // Nothing is known yet, so nothing is decided: a workspace whose tabs are
    // still in flight must not flash the landing and then leave it.
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    expect(seen.rail?.visible).toBe(false);
    await view.unmount();
  });

  it("navigates, mirrors and closes without fighting itself", async () => {
    // On the layout where `closeChat` still MEANS something: the panes are the
    // tab host there, so handing the view back is not immediately undone by the
    // root normalisation.
    const { seen, view } = await mountRail({
      flag: true,
      path: "/workspaces/ws-1",
      surfaceHostsTabs: false,
    });
    await act(async () => seen.rail?.openSession("s-1"));
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    expect(seen.rail?.sessionId).toBe("s-1");

    // The surface reporting the address it is already on must be a no-op, or
    // the two directions would push a history entry per resolved navigation.
    const settled = window.history.length;
    await act(async () => seen.rail?.mirror("s-1"));
    expect(window.history.length).toBe(settled);

    // The surface navigating itself — the landing's send creates a session and
    // goes to it — moves the address.
    await act(async () => seen.rail?.mirror("s-2"));
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-2");

    // A terminal row takes the view back, and then a background navigation
    // inside the hidden surface must NOT take it away again.
    await act(async () => seen.rail?.closeChat());
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    expect(seen.rail?.visible).toBe(false);
    await act(async () => seen.rail?.mirror("s-3"));
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    await view.unmount();
  });
});
