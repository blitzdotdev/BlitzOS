/**
 * TWO FIELD REPORTS AGAINST THE MERGED TERMINAL-TAB STRIP (PR #135), PINNED.
 *
 * 1. **A session tab click does not leave a terminal tab.** With a session open
 *    and a terminal tab active, clicking a SESSION tab in the strip did nothing:
 *    the terminal stayed. The other direction worked. The asymmetry is the whole
 *    defect — selecting one of OUR tabs is an address change we make, and
 *    selecting a conversation tab is `SessionDetail`'s own `useState`, which is
 *    not in the URL, not in an atom and not visible to the host. So
 *    `activeSurfaceTabId` kept naming the terminal, seam patch 5 hunk 15 kept
 *    the terminal mounted and visible, and hunk 13 kept every conversation
 *    surface hidden.
 *
 *    IT IS WIDER THAN THE CLICK. Ten call sites move `activeTabSessionIdRaw` —
 *    the strip click, the strip's `+`, a close, a restore, a fork, a mention
 *    navigation, the next/previous cycle, a promoted draft, the browser panel
 *    and the URL sync — so a notification wired to the click handler alone
 *    leaves nine of them inert. A real browser showed the second one directly:
 *    the `+` created a draft tab that stayed `aria-selected="false"` while the
 *    terminal kept the pane. Seam patch 5 hunks 17-18 put the notification in
 *    the SETTER, which is the one thing all ten share; everything below is what
 *    the host does with it.
 *
 * 2. **"New session" landed on a blank workspace.** The panes give up their tab
 *    strips (§4.6) AND every tab body the moment the address enters the chat
 *    plane, but the host that was supposed to receive them is
 *    `LodySessionsRegion` — which renders nothing at all unless the box answers
 *    `present` and has endpoints. `available` (the signal §4.6 named) is
 *    `capability !== 'absent'`, so it is true throughout `probing`, and a
 *    workspace with no running box stays `probing` for good. From a workspace
 *    URL, "New session" is the first click that moves the address off `null`,
 *    so it is where a member meets it; selecting a terminal tab keeps
 *    `chat !== null`, so that stays blank too.
 *
 *    Its adjacent half is the same button: from `/chat`, "New session" moved an
 *    address that was already there, and `go()` refuses to push the path it is
 *    on. Nothing happened at all.
 *
 * DAEMON-FREE, LIKE THE REGRESSIONS THEMSELVES. Neither defect needed a daemon
 * to happen and neither needs one to pin: what is under test is the shell's own
 * address transitions and the one condition the pane handover follows.
 * `SessionDetail` cannot be mounted in CI (it needs a runtime, a Loro document
 * and Monaco), so hunks 17-18 are pinned at the source by
 * `lody-surface-tabs.test.tsx` — which reads the vendored file and asserts that
 * every writer the wrapper is meant to cover really goes through it — and their
 * EFFECT is driven here through the same binding the router hands the page.
 */
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxEndpoints } from "../src/resolver.js";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodySessionsCapability } from "../src/lody/box-capability.js";
import type { LodyRailSessions, LodyRailState } from "../src/lody/use-lody-rail.js";
import type { SurfaceTabsBinding } from "../src/lody/surface-tabs.js";
import { expectLandingHeading } from "./lody-landing-heading.js";
import { render, settle } from "./dom.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

const ENDPOINTS = {
  terminalUrl: "https://box.invalid/webapp/7681/",
  filesBase: "https://box.invalid/webapp/5000/",
  lodySyncUrl: "wss://box.invalid/webapp/7445/lody/sync",
  lodyRpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
  lodyControlUrl: "https://box.invalid/webapp/7445/lody/control",
  lodyProjectUrl: "https://box.invalid/webapp/7445/lody/project",
  lodyPlatformUrl: "https://box.invalid/webapp/7445/lody/platform",
} satisfies BoxEndpoints;

const SESSIONS_PRESENT = {
  capability: "present",
  onLegacyDefaultTabs: () => {},
} satisfies LodyRailSessions;

/**
 * `CloudApp`'s address wiring, and nothing else.
 *
 * The hook, the `ChatAddress` in React state, and the surface-tabs binding
 * `CloudApp` builds out of the hook — which is the whole of what a strip click
 * reaches. `parseAppRoute` is applied to `window.location.pathname` on every
 * mount, so "refresh" in a case below is a re-mount at the address the previous
 * step left behind.
 */
interface Wiring {
  rail: LodyRailState | null;
  binding: SurfaceTabsBinding | null;
}

async function mountWiring(path: string) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  const { surfaceTabId, workspaceTabIdFromSurfaceTabId } = await import(
    "../src/lody/surface-tabs.js"
  );
  window.history.replaceState({}, "", path);
  const seen: Wiring = { rail: null, binding: null };

  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    const rail = useLodyRail(route, setRoute, route.workspaceId ?? "", true, 1, SESSIONS_PRESENT);
    seen.rail = rail;
    seen.binding = {
      tabs: [],
      activeTabId: rail.terminalId === null ? null : surfaceTabId(rail.terminalId),
      onSelect: (tabId) => {
        const workspaceTabId = workspaceTabIdFromSurfaceTabId(tabId);
        if (workspaceTabId !== null) rail.openTerminal(workspaceTabId);
      },
      onClose: () => undefined,
      onDeselect: rail.closeTerminal,
      onSessionMissing: rail.openTerminalOnLanding,
    };
    return null;
  }

  const view = await render(<Host />);
  await settle();
  return { seen, view };
}

describe("a session tab click leaves the terminal tab", () => {
  it("drops the terminal arm and keeps the session the strip is drawn in", async () => {
    const mounted = await mountWiring("/workspaces/ws-1/chat/s-1/terminal/7");
    expect(mounted.seen.rail?.terminalId).toBe("7");
    expect(mounted.seen.rail?.sessionId).toBe("s-1");

    // What seam patch 5 hunk 17 calls: the page selected a conversation tab.
    await act(async () => mounted.seen.binding?.onDeselect());
    await settle();

    // The address keeps the SESSION and loses the terminal, so hunk 13 stops
    // deselecting the conversation surfaces and the member sees the tab they
    // clicked. Sending them to the landing instead would take them off the
    // session whose strip they clicked in.
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    expect(mounted.seen.rail?.terminalId).toBeNull();
    expect(mounted.seen.rail?.sessionId).toBe("s-1");
    expect(mounted.seen.binding?.activeTabId).toBeNull();
    await mounted.view.unmount();
  });

  it("falls back to the landing when the strip has no session under it", async () => {
    const mounted = await mountWiring("/workspaces/ws-1/chat/terminal/7");
    await act(async () => mounted.seen.binding?.onDeselect());
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(mounted.seen.rail?.chat).toBe("landing");
    await mounted.view.unmount();
  });

  it("is inert on every address that names no terminal", async () => {
    for (const path of ["/workspaces/ws-1", "/workspaces/ws-1/chat", "/workspaces/ws-1/chat/s-1"]) {
      const mounted = await mountWiring(path);
      await act(async () => mounted.seen.binding?.onDeselect());
      await settle();
      expect(window.location.pathname, `${path} is unchanged`).toBe(path);
      await mounted.view.unmount();
    }
  });

  it("is the exact inverse of openTerminal, in both hosts", async () => {
    // The pair is what makes one tab array with one selection work: whatever
    // `openTerminal` adds to the address, `closeTerminal` removes, and the host
    // page either arm named survives the round trip.
    for (const [host, withTerminal] of [
      ["/workspaces/ws-1/chat", "/workspaces/ws-1/chat/terminal/7"],
      ["/workspaces/ws-1/chat/s-1", "/workspaces/ws-1/chat/s-1/terminal/7"],
    ] as const) {
      const mounted = await mountWiring(host);
      await act(async () => mounted.seen.rail?.openTerminal("7"));
      await settle();
      expect(window.location.pathname).toBe(withTerminal);
      await act(async () => mounted.seen.binding?.onDeselect());
      await settle();
      expect(window.location.pathname).toBe(host);
      await mounted.view.unmount();
    }
  });
});

describe("the whole transition cycle, and a refresh at every stop", () => {
  it("landing → terminal → session → terminal → session-via-strip → landing", async () => {
    const { parseAppRoute } = await import("../src/sessions-page-state.js");
    /** Re-parsing the address is what a reload does, so an address that cannot
     * be parsed back is a stop a refresh would lose. */
    const refresh = (expected: unknown) => {
      const route = parseAppRoute(window.location.pathname);
      expect(route.workspaceId, window.location.pathname).toBe("ws-1");
      expect(route.page === "webApp" ? route.chat : null, window.location.pathname).toEqual(
        expected,
      );
    };

    const mounted = await mountWiring("/workspaces/ws-1/chat");
    refresh("landing");

    await act(async () => mounted.seen.rail?.openTerminal("7"));
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/terminal/7");
    refresh({ terminalId: "7" });

    await act(async () => mounted.seen.rail?.openSession("s-1"));
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    refresh({ sessionId: "s-1" });

    // A terminal opened while a session is on screen becomes a tab of THAT
    // session's strip, not the landing's.
    await act(async () => mounted.seen.rail?.openTerminal("7"));
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1/terminal/7");
    refresh({ sessionId: "s-1", terminalId: "7" });

    // The reported bug: back to the conversation from inside the session strip.
    await act(async () => mounted.seen.binding?.onDeselect());
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/s-1");
    refresh({ sessionId: "s-1" });

    await act(async () => mounted.seen.rail?.openLanding());
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    refresh("landing");
    await mounted.view.unmount();
  });

  it("re-mounts at each stop with the same selection, which is what a reload is", async () => {
    for (const [path, terminalId, sessionId] of [
      ["/workspaces/ws-1/chat", null, null],
      ["/workspaces/ws-1/chat/terminal/7", "7", null],
      ["/workspaces/ws-1/chat/s-1", null, "s-1"],
      ["/workspaces/ws-1/chat/s-1/terminal/7", "7", "s-1"],
    ] as const) {
      const mounted = await mountWiring(path);
      expect(mounted.seen.rail?.terminalId, path).toBe(terminalId);
      expect(mounted.seen.rail?.sessionId, path).toBe(sessionId);
      // And the strip draws the same tab it drew before the reload.
      expect(mounted.seen.binding?.activeTabId, path).toBe(
        terminalId === null ? null : `blitz-tab:${terminalId}`,
      );
      await mounted.view.unmount();
    }
  });
});

describe("the panes are handed over only to a host that is on screen", () => {
  /** `LodySessionsRegion`'s own mount condition, which is what `CloudApp` now
   * asks before it takes the pane strips and the pane bodies away. */
  async function mounts(
    endpoints: BoxEndpoints | null,
    sessions: LodySessionsCapability,
  ): Promise<boolean> {
    vi.resetModules();
    vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
    const { lodySurfaceMounts } = await import("../src/lody/LodySessionsRegion.js");
    return lodySurfaceMounts(endpoints, sessions);
  }

  it("is false while the probe is unsettled, where available is already true", async () => {
    // The regression, stated as the two answers disagreeing. `available` is
    // `capability !== 'absent'` — deliberately optimistic, so the rail does not
    // flicker — and the panes cannot afford that optimism, because it costs
    // them every tab body they were drawing.
    expect(await mounts(ENDPOINTS, "probing")).toBe(false);
    expect(await mounts(ENDPOINTS, "absent")).toBe(false);
    expect(await mounts(ENDPOINTS, "present")).toBe(true);
  });

  it("is false while the workspace has no running box", async () => {
    // And this is the state that never leaves `probing`: with no platform URL
    // the capability hook returns before it asks anything, so a workspace whose
    // machine is asleep would have surrendered its panes for good.
    expect(await mounts(null, "present")).toBe(false);
    expect(await mounts(null, "probing")).toBe(false);
  });

  it("is false with the flag off, whatever the box says", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "false");
    const { lodySurfaceMounts } = await import("../src/lody/LodySessionsRegion.js");
    expect(lodySurfaceMounts(ENDPOINTS, "present")).toBe(false);
  });
});

/**
 * "+ New session" from the landing, where the address cannot move.
 *
 * `go()` refuses to push the path it is already on — that is what stops a rail
 * row stacking a history entry per click — so from `/chat` the whole button was
 * a no-op: no navigation, no new draft, nothing. What a member means by it is a
 * FRESH composer, and the surface has upstream's own mechanism for that, so
 * `SessionSurface.openLanding({ resetDraft: true })` is what the shell adds to
 * the address move.
 *
 * Mounts the REAL surface, because the thing under test is its navigation and
 * not a description of one. The daemon is a stubbed `/lody/platform` answer and
 * the agent-config gate is opened, since neither is what this is about: the
 * gate holds the router back until a Loro round trip lands, which cannot happen
 * without a box.
 */
describe("+ New session, from the landing", () => {
  it("navigates even though the address is already there", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
    vi.doMock("../src/lody/agent-config-gate", () => ({
      LodyAgentConfigGate: (props: { children: ReactNode }) => props.children,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              identity: { userId: "local:11111111-1111-1111-1111-111111111111" },
              machine: { machineId: "m-1" },
              workspaces: [
                { workspaceId: "lw_1", name: "Lody", slug: "local", role: "owner", state: "active" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const { installLodyDomStubs } = await import("./lody-dom-stubs.js");
    installLodyDomStubs();
    const { SessionSurface } = await import("../src/lody/SessionSurface.js");
    type Api = import("../src/lody/SessionSurface.js").LodySessionSurfaceApi;

    let api: Api | null = null;
    const view = await render(
      <SessionSurface
        endpoints={{
          syncUrl: ENDPOINTS.lodySyncUrl,
          rpcUrl: ENDPOINTS.lodyRpcUrl,
          controlUrl: ENDPOINTS.lodyControlUrl,
          projectUrl: ENDPOINTS.lodyProjectUrl,
          platformUrl: ENDPOINTS.lodyPlatformUrl,
          filesBase: ENDPOINTS.filesBase,
        }}
        viewer={{ name: "Me", avatarUrl: null }}
        workspaceTitle="Workspace"
        onApiReady={(next) => {
          api = next;
        }}
      />,
    );
    await settle();
    await settle();
    expect(api, "the surface published its api").not.toBeNull();
    // The surface opens on the landing, so this is the state the button was
    // dead in.
    expectLandingHeading(view.container.textContent, "the surface opens on the landing");

    // What the button is FOR: a composer with nothing in it. The prompt is a
    // controlled textarea, so it is driven the way the browser drives it — and
    // re-queried every time, because a reset remounts the composer.
    const composer = () => view.container.querySelector("textarea");
    const type = async (text: string) => {
      const element = composer();
      expect(element, "the landing draws its composer").not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(element, text);
        element?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
      expect(composer()?.value, "the draft is in the composer").toBe(text);
    };

    await type("half a thought");

    // The pre-fix path: the shell's address move is refused because the address
    // is already the landing, and re-opening it changes nothing the landing can
    // see, so the draft survives and the button reads as dead.
    await act(async () => (api as Api | null)?.openLanding());
    await settle();
    expect(composer()?.value, "re-opening the same address is not a new session").toBe(
      "half a thought",
    );

    await act(async () => (api as Api | null)?.openLanding({ resetDraft: true }));
    await settle();
    expect(composer()?.value, "+ New session gives a fresh composer").toBe("");

    // And a SECOND press works too: the landing drops a reset key it has
    // already applied, so a constant key would make every press after the
    // first a no-op all over again.
    await type("another thought");
    await act(async () => (api as Api | null)?.openLanding({ resetDraft: true }));
    await settle();
    expect(composer()?.value, "and so does the next one").toBe("");

    // Still the landing, not a blank pane.
    expectLandingHeading(view.container.textContent, "still the landing, not a blank pane");
    await view.unmount();
  }, 180_000);
});
