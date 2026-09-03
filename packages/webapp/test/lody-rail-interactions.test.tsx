/**
 * WHAT THE RAIL'S CLICKS DO WHEN THE PANES OWN THE VIEW
 * (plans/LODY-RUNTIME-DESIGN.md §15, the third canary dogfood's reports 1-3).
 *
 * All three reports are one defect. The rail's vendored zone is drawn whether
 * or not the chat surface is on screen — it is the workspace's session list —
 * so its rows and its "+ New session" are clickable from the panes. Phase 4
 * wired both to the SURFACE's own router, which moves a page nobody can see:
 * with `ChatAddress === null` the surface is hidden, and `useLodyRail.mirror`
 * deliberately ignores a navigation made while the panes own the view, so the
 * address never learns about the click and the surface is never revealed.
 *
 * The fix is that a rail click is an ADDRESS change. `CloudApp` hands the
 * shell's own `openSession` and `openLanding` down through
 * `LodySessionsRegion` into the rail binding, and the surface follows the
 * address the way a deep link does.
 *
 * DAEMON-FREE ON PURPOSE. The phase-4 exit test drives the real vendored row,
 * and it skips without a 21 MB `lody` bundle — which is CI, which is why this
 * regression reached a member (§12.4 says the same thing about a different
 * one). What is asserted here is the wiring between the rail and the address,
 * which is where the defect was and which needs no daemon: `SessionSurface` is
 * mocked to capture the rail binding it is handed, and the binding's own
 * callbacks are then invoked exactly as a row click invokes them.
 */
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxEndpoints } from "../src/resolver.js";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodyRailBinding } from "../src/lody/SessionSurface.js";
import type { LodyRailSessions, LodyRailState } from "../src/lody/use-lody-rail.js";
import { render, settle } from "./dom.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
  for (const host of document.querySelectorAll(".session-list--vendor")) host.remove();
});

// A whole `BoxEndpoints`, `satisfies`-checked rather than asserted, because the
// region reads every field and hands them to the surface. The surface is mocked
// here, so nothing dials any of them.
const ENDPOINTS = {
  terminalUrl: "https://box.invalid/webapp/7681/",
  filesBase: "https://box.invalid/webapp/5000/",
  lodySyncUrl: "wss://box.invalid/webapp/7445/lody/sync",
  lodyRpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
  lodyControlUrl: "https://box.invalid/webapp/7445/lody/control",
  lodyProjectUrl: "https://box.invalid/webapp/7445/lody/project",
  lodyPlatformUrl: "https://box.invalid/webapp/7445/lody/platform",
} satisfies BoxEndpoints;

/**
 * The box answered `/lody/platform`, which is every case below: what is under
 * test here is not the pre-Lody fallback (`lody-old-box-fallback.test.tsx`).
 *
 * `surfaceHostsTabs: false` — the layout where THE PANES OWN THE VIEW, which is
 * the whole subject of this file. Where the session strip draws the tabs there
 * is no pane address to hand the view back to: the workspace root normalises
 * into the chat plane, because the native strip that used to serve it is deleted
 * (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"). Mobile and a box with no session
 * plane are what is left, and they are what these cases describe.
 */
const SESSIONS_PRESENT = {
  capability: "present",
  surfaceHostsTabs: false,
} satisfies LodyRailSessions;

interface MountResult {
  /** What the region handed the surface, captured on every render. */
  surface: { hidden: boolean | undefined; rail: LodyRailBinding | undefined };
  /** The hook's own state, the way `CloudApp` holds it. */
  seen: { rail: LodyRailState | null };
  view: Awaited<ReturnType<typeof render>>;
}

/**
 * The `CloudApp` wiring, minus everything that is not the rail: the address in
 * React state, the hook that owns it, and the region that carries the rail
 * binding to the surface.
 */
async function mountRegion(options: { path: string; tabCount: number }): Promise<MountResult> {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const surface: MountResult["surface"] = { hidden: undefined, rail: undefined };
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (props: { hidden?: boolean; rail?: LodyRailBinding }) => {
      surface.hidden = props.hidden;
      surface.rail = props.rail;
      return null;
    },
  }));
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  window.history.replaceState({}, "", options.path);

  const seen: MountResult["seen"] = { rail: null };
  // The rail draws its list region whether or not the surface is on screen, so
  // the host exists from the first render. That is what makes the region mount
  // while the panes own the view — and what makes the bug reachable.
  const railHost = document.createElement("div");
  railHost.className = "session-list session-list--vendor";
  document.body.append(railHost);

  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    const rail = useLodyRail(
      route,
      setRoute,
      route.workspaceId ?? "",
      true,
      SESSIONS_PRESENT,
    );
    seen.rail = rail;
    return (
      <LodySessionsRegion
        endpoints={ENDPOINTS}
        sessions={SESSIONS_PRESENT.capability}
        viewerName="Me"
        viewerAvatarUrl={null}
        workspaceTitle="Workspace"
        visible={rail.visible}
        railHost={railHost}
        onOpenSession={rail.openSession}
        onOpenLanding={rail.openLanding}
        onOpenArchive={rail.openArchive}
      />
    );
  }

  const view = await render(<Host />);
  // The region loads the surface through `lazy`, so one microtask turn.
  await settle();
  return { surface, seen, view };
}

describe("a rail click while the panes own the view", () => {
  it("opens a session the daemon holds, and reveals the surface", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 1 });
    expect(mounted.seen.rail?.visible).toBe(false);
    expect(mounted.surface.hidden).toBe(true);

    await act(async () => mounted.surface.rail?.onOpenSession?.("s-1"));
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    expect(mounted.seen.rail?.sessionId).toBe("s-1");
    expect(mounted.seen.rail?.visible).toBe(true);
    expect(mounted.surface.hidden).toBe(false);
    await mounted.view.unmount();
  });

  it("opens the landing from + New session", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 1 });
    await act(async () => mounted.surface.rail?.onOpenLanding?.());
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(mounted.seen.rail?.sessionId).toBeNull();
    expect(mounted.surface.hidden).toBe(false);
    await mounted.view.unmount();
  });

  it("opens the landing with a terminal tab in the panes, and leaves the tab alone", async () => {
    // Report 3 differs from report 2 only in that a terminal tab is the thing
    // being covered. It is the same address move, and nothing about the tab is
    // touched: `webapp_state` never learns about a chat session.
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 3 });
    await act(async () => mounted.surface.rail?.onOpenLanding?.());
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(mounted.surface.hidden).toBe(false);
    await mounted.view.unmount();
  });

  it("hands the rail the SHELL's navigators and not the surface's own", async () => {
    // The regression pin. With the surface's router here instead, every case
    // above passes through a page nobody can see: this is the identity that
    // says which of the two the vendored sidebar will call.
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 1 });
    expect(mounted.surface.rail?.onOpenSession).toBe(mounted.seen.rail?.openSession);
    expect(mounted.surface.rail?.onOpenLanding).toBe(mounted.seen.rail?.openLanding);
    await mounted.view.unmount();
  });
});

describe("the rail's other two directions, unchanged", () => {
  it("still opens a session from the landing", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1/chat", tabCount: 0 });
    expect(mounted.seen.rail?.visible).toBe(true);
    await act(async () => mounted.surface.rail?.onOpenSession?.("s-2"));
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-2");
    await mounted.view.unmount();
  });

  it("costs no history entry when the open session's row is clicked again", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1/chat/s-1", tabCount: 1 });
    const settled = window.history.length;
    await act(async () => mounted.surface.rail?.onOpenSession?.("s-1"));
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    expect(window.history.length).toBe(settled);
    await mounted.view.unmount();
  });
});

/**
 * THE ARCHIVE IS AN ADDRESS, and these are the two failures that make it one.
 *
 * The archive page names no session, so the surface resolves it exactly as it
 * resolves the landing: `null`. Two things follow, and both would be silent:
 * `mirror(null)` would read the page the member just opened as a departure from
 * it and push the address to `/chat`, and the effect that drives the surface
 * FROM the address would then push the surface back to the landing. The member
 * would see the archive for one frame.
 */
describe("the archive address", () => {
  it("opens from the rail's footer entry, and reveals the surface", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 1 });
    expect(mounted.seen.rail?.visible).toBe(false);

    await act(async () => mounted.surface.rail?.onOpenArchive?.());
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/archive");
    expect(mounted.seen.rail?.archive).toBe(true);
    expect(mounted.seen.rail?.sessionId, "the archive names no session").toBeNull();
    expect(mounted.seen.rail?.visible).toBe(true);
    expect(mounted.surface.hidden).toBe(false);
    await mounted.view.unmount();
  });

  it("hands the rail the SHELL's archive navigator, like the other two", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1", tabCount: 1 });
    expect(mounted.surface.rail?.onOpenArchive).toBe(mounted.seen.rail?.openArchive);
    await mounted.view.unmount();
  });

  it("survives the surface reporting no session, which is what the page reports", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1/chat/archive", tabCount: 1 });
    expect(mounted.seen.rail?.archive).toBe(true);

    // `onActiveSessionChange` fires on every resolved navigation, and the
    // archive resolves to `null`. Without the guard this is the line that took
    // the member back to the landing.
    await act(async () => mounted.seen.rail?.mirror(null));
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/archive");
    expect(mounted.seen.rail?.archive).toBe(true);
    await mounted.view.unmount();
  });

  it("still follows the surface to a session, which is a row click on that page", async () => {
    const mounted = await mountRegion({ path: "/workspaces/ws-1/chat/archive", tabCount: 1 });
    await act(async () => mounted.seen.rail?.mirror("s-9"));
    await settle();

    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-9");
    expect(mounted.seen.rail?.archive).toBe(false);
    expect(mounted.seen.rail?.sessionId).toBe("s-9");
    await mounted.view.unmount();
  });

  it("is a reserved segment, never a session whose id spells `archive`", async () => {
    // `workspaceChatPath` never emits `/chat/archive` for a session, and the
    // parser reads the reserved branch first — the same rule `shared` and
    // `terminal` follow.
    const mounted = await mountRegion({ path: "/workspaces/ws-1/chat/archive", tabCount: 0 });
    expect(mounted.seen.rail?.sessionId).toBeNull();
    expect(mounted.seen.rail?.terminalId).toBeNull();
    await mounted.view.unmount();
  });
});

