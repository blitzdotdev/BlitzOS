/**
 * Seam patch 5, pinned: host-contributed tabs in Lody's session tab strip
 * (plans/LODY-TERMINAL-TABS.md §7.1, §7.7).
 *
 * TWO KINDS OF ASSERTION, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * 1. THE PATCH IS INERT. The whole claim that makes this seam safe to carry —
 *    and safe to upstream — is that with every new prop absent the two vendored
 *    files render byte-for-byte what upstream renders. That is checked against
 *    the real upstream source, committed beside this file as
 *    `upstream-baseline/` (see the README there for provenance and how to
 *    refresh it at a merge). Every line the seam REMOVES from upstream is named
 *    here BY LINE NUMBER, and everything else upstream wrote must still appear,
 *    in order, in the patched file. So a merge that drops a hunk, or an edit
 *    that touches the vendored file anywhere undeclared, fails on the line it
 *    changed.
 *
 *    IT READS NOTHING BUT CHECKED-OUT FILES. The first version of this test
 *    asked `git show <pin>:<upstream path>` for the pristine source, which works
 *    in a full clone of this repository and fails in CI: the checkout resolves
 *    the subtree squash's commit object but its tree carries the upstream paths
 *    at their own root, and a shallow or partial clone may not carry the object
 *    at all. A pin check must not depend on the shape of the clone.
 *
 * 2. THE PATCH WORKS. The real vendored `SessionTabBar` is mounted through our
 *    two hosts and driven: a contributed tab appears, selecting it reports the
 *    namespaced id, closing it reports the namespaced id, and its content is in
 *    the DOM and merely hidden while another tab is active.
 *
 * WHAT IS NOT MOUNTED HERE, AND WHY. `SessionDetail` needs a runtime, a Loro
 * document and a daemon; the suites that mount it skip wherever the daemon is
 * not installed, which is CI. So hunk 15 — the one that mounts host content
 * inside the session page — is pinned by (1) at the source, and its BEHAVIOUR
 * is pinned by (2) through `TerminalTabsHost`, which is the same composition
 * with the same rule (mounted always, `hidden` when inactive).
 */
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import { Provider as JotaiProvider, createStore } from "jotai";
import { RouterProvider } from "@tanstack/react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalPlatformProvider, createStaticStore } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { AuthenticatedConvexContext } from "@lody/components/hooks/use-authenticated-convex";
import { RuntimeProvider } from "@lody/components/providers/runtime-provider";
import { SessionTabBar } from "@lody/components/components/sessions/session-tab-bar";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { initLodyI18n } from "../src/lody/i18n.js";
import { TerminalTabsHost, TerminalTabsStrip } from "../src/lody/TerminalTabsStrip.js";
import {
  SURFACE_TAB_ID_PREFIX,
  SurfaceTabsContext,
  surfaceTabId,
  toSessionSurfaceTabs,
  workspaceTabIdFromSurfaceTabId,
  type SurfaceTabsBinding,
} from "../src/lody/surface-tabs.js";
import type { WebAppTabModel } from "../src/SessionTypeIcon.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { expectLandingHeading } from "./lody-landing-heading.js";
import { render, settle } from "./dom.js";

/**
 * THE SOURCE PIN MOVED, AND THE MOUNT STAYED. Every assertion that reads a
 * vendored file against its pristine upstream baseline now lives in
 * `lody-seam-pin.test.ts`, which imports nothing: the `beforeAll` below pulls
 * the whole vendored renderer in, and on a loaded machine it exceeds its hook
 * budget — at which point vitest reports every test in THIS file as skipped.
 * A pin that a slow machine silently turns off is not a pin. What is left here
 * is claim (2): the patch WORKS, driven through the two real hosts.
 */

const i18n = initLodyI18n();

function Providers(props: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </I18nextProvider>
  );
}

/** The route tree names `SessionDetail`, which pulls Monaco, which decides at
 * MODULE LOAD whether it can register its clipboard commands and throws under
 * jsdom without `document.queryCommandSupported`. A static import here would be
 * hoisted above `installLodyDomStubs()` and take the whole file down. */
let createLodySessionRouter: typeof import("../src/lody/router")["createLodySessionRouter"];

beforeAll(async () => {
  installLodyDomStubs();
  ({ createLodySessionRouter } = await import("../src/lody/router.js"));
}, 120_000);

/** The prop set `session-detail.tsx` passes today, and nothing else. */
const PRODUCTION_PROPS = {
  variant: "session" as const,
  parentSession: { id: "s-parent", title: "Parent session" },
  childSessions: [{ id: "s-child", title: "Child session" }],
  draftTabs: [],
  archivedChildSessions: [],
  activeTabSessionId: "s-parent",
  onTabSelect: () => undefined,
  onNewTab: () => undefined,
};

describe("the patched SessionTabBar with no host tabs", () => {
  it("draws today's strip, and no tab that is not a session", async () => {
    const view = await render(
      <Providers>
        <SessionTabBar {...PRODUCTION_PROPS} />
      </Providers>,
    );
    await settle();
    const tabs = [...view.container.querySelectorAll("[role='tab']")];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "session-tab-s-parent",
      "session-tab-s-child",
    ]);
    expect(view.container.querySelector("[id^='viewer-tab-']")).toBeNull();
    await view.unmount();
  });
});

const TAB_MODELS: WebAppTabModel[] = [
  { id: "7", label: "claude", agent: "claude", pending: false },
  { id: "9", label: "blitz — zsh", agent: "terminal", pending: false },
];

function binding(overrides: Partial<SurfaceTabsBinding> = {}): SurfaceTabsBinding {
  return {
    tabs: toSessionSurfaceTabs(TAB_MODELS, (id) => (
      <div data-testid={`body-${id}`}>terminal {id}</div>
    )),
    activeTabId: null,
    onSelect: () => undefined,
    onClose: () => undefined,
    onDeselect: () => undefined,
    onSessionMissing: () => undefined,
    ...overrides,
  };
}

describe("the landing host: the same strip, with no session to root it in", () => {
  it("mounts variant='viewer' with no parentSession and draws the host's tabs", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsStrip surfaceTabs={binding()} />
      </Providers>,
    );
    await settle();
    const text = view.container.textContent ?? "";
    expect(text).toContain("claude");
    expect(text).toContain("blitz — zsh");
    // No session tab, no parent tab, and no `+`: `variant="viewer"` says so,
    // and hunks 4-6 are what let a host without a session use it.
    expect(view.container.querySelector("[id^='session-tab-']")).toBeNull();
    expect(view.container.querySelector("button[aria-label='New tab']")).toBeNull();
    await view.unmount();
  });

  it("reports the NAMESPACED id on select and on close", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const view = await render(
      <Providers>
        <TerminalTabsStrip surfaceTabs={binding({ onSelect, onClose })} />
      </Providers>,
    );
    await settle();

    const tab = view.container.querySelector<HTMLElement>("#viewer-tab-blitz-tab\\:7");
    expect(tab, "the strip draws the tab under its namespaced id").not.toBeNull();
    await act(async () => tab?.click());
    expect(onSelect).toHaveBeenCalledWith("blitz-tab:7");

    const close = tab?.querySelector<HTMLElement>("button");
    expect(close, "a host tab is closeable").not.toBeNull();
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledWith("blitz-tab:7");
    // And the id round-trips back into what `webapp_state` and tmux key on.
    expect(workspaceTabIdFromSurfaceTabId("blitz-tab:7")).toBe("7");
    expect(workspaceTabIdFromSurfaceTabId("s-parent")).toBeNull();
    await view.unmount();
  });

  it("keeps every tab's content mounted, merely hidden, across a switch", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsHost
          surfaceTabs={binding({ activeTabId: surfaceTabId("7") })}
          landing={<div data-testid="landing">landing</div>}
        />
      </Providers>,
    );
    await settle();

    // A terminal that unmounted on a tab switch would drop its WebSocket and
    // redraw from tmux on every click. Both bodies and the landing are in the
    // DOM; exactly one of the three is not hidden.
    const seven = view.container.querySelector("[data-surface-tab-id='blitz-tab:7']");
    const nine = view.container.querySelector("[data-surface-tab-id='blitz-tab:9']");
    const landing = view.container.querySelector("[data-surface-tab-id='landing']");
    expect(seven?.querySelector("[data-testid='body-7']")).not.toBeNull();
    expect(nine?.querySelector("[data-testid='body-9']")).not.toBeNull();
    expect(landing?.querySelector("[data-testid='landing']")).not.toBeNull();
    expect(seven?.className).not.toContain("hidden");
    expect(nine?.className).toContain("hidden");
    expect(landing?.className).toContain("hidden");
    await view.unmount();
  });

  it("shows the landing when no host tab is selected", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsHost
          surfaceTabs={binding()}
          landing={<div data-testid="landing">landing</div>}
        />
      </Providers>,
    );
    await settle();
    const landing = view.container.querySelector("[data-surface-tab-id='landing']");
    expect(landing?.className).not.toContain("hidden");
    await view.unmount();
  });
});

/**
 * The chat landing, through the REAL route tree rather than through
 * `TerminalTabsHost` alone.
 *
 * The field report was "New session lands on a blank /chat", and the first
 * suspicion was this composition: a landing host that needs a tab array it does
 * not have during the navigation, or a strip that returns `null` and takes the
 * body with it. It does neither, and that is worth a test rather than a
 * paragraph — `ChatRoute` is the ONE mount point where our own markup stands
 * between the router and the vendored page, so a future change to it can blank
 * the landing without touching anything else.
 */
const LANDING_SLUG = "fixture";
const LANDING_WORKSPACE_ID = "lw_blitz_fixture";

const landingPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: "authenticated",
    user: { id: "local:blitz-fixture", name: "Fixture", image: null },
  }),
  workspaces: createStaticStore({
    status: "ready",
    workspaces: [
      { id: LANDING_WORKSPACE_ID, name: "Fixture", slug: LANDING_SLUG, role: "owner" },
    ],
    activeWorkspaceId: LANDING_WORKSPACE_ID,
  }),
});

/** Their Storybook preview's settled signed-out Convex value, which is what
 * `src/lody/platform.tsx` supplies in production too. */
const SIGNED_OUT_CONVEX = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

async function mountChatRoute(surfaceTabs: SurfaceTabsBinding | null) {
  const router = createLodySessionRouter(LANDING_SLUG, { workspaceId: LANDING_WORKSPACE_ID });
  await act(async () => {
    await router.navigate({
      to: "/$workspaceName/chat",
      params: { workspaceName: LANDING_SLUG },
    });
  });
  const view = await render(
    <JotaiProvider store={createStore()}>
      <PlatformContext.Provider value={landingPlatform}>
        <AuthenticatedConvexContext.Provider value={SIGNED_OUT_CONVEX}>
          <Providers>
            <RuntimeProvider>
              <SurfaceTabsContext.Provider value={surfaceTabs}>
                <RouterProvider router={router} />
              </SurfaceTabsContext.Provider>
            </RuntimeProvider>
          </Providers>
        </AuthenticatedConvexContext.Provider>
      </PlatformContext.Provider>
    </JotaiProvider>,
  );
  await settle();
  return view;
}

describe("the chat landing route, mounted for real", () => {
  it("draws the landing with a host binding, and with none", async () => {
    for (const value of [null, binding()]) {
      const view = await mountChatRoute(value);
      // The composer's own words, so this is the landing and not merely a
      // non-empty div: "renders BLANK — no landing, no draft chat UI".
      expectLandingHeading(view.container.textContent, "the landing drew itself");
      await view.unmount();
    }
  }, 120_000);

  it("draws the landing beside the strip, not instead of it", async () => {
    const view = await mountChatRoute(binding());
    expect(view.container.querySelector("#viewer-tab-blitz-tab\\:7")).not.toBeNull();
    expectLandingHeading(view.container.textContent, "the landing is beside the strip");
    await view.unmount();
  }, 120_000);

  it("draws the selected terminal, with the landing mounted and hidden", async () => {
    const view = await mountChatRoute(binding({ activeTabId: surfaceTabId("7") }));
    const seven = view.container.querySelector("[data-surface-tab-id='blitz-tab:7']");
    const landing = view.container.querySelector("[data-surface-tab-id='landing']");
    expect(seven?.className).not.toContain("hidden");
    expect(landing?.className).toContain("hidden");
    // The landing holds the member's unsent draft, so it is hidden and never
    // unmounted — the same rule the terminals get.
    expectLandingHeading(landing?.textContent, "the hidden landing is still mounted");
    await view.unmount();
  }, 120_000);
});

describe("the id namespace", () => {
  it("cannot collide with a session id, a viewer id or a draft id", () => {
    expect(surfaceTabId(7)).toBe("blitz-tab:7");
    expect(SURFACE_TAB_ID_PREFIX).toBe("blitz-tab:");
    for (const foreign of ["s-1", "file:/a/b.ts", "diff:/a/b.ts", "draft-1", "terminal"]) {
      expect(foreign.startsWith(SURFACE_TAB_ID_PREFIX)).toBe(false);
    }
  });
});
