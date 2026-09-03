/**
 * WAVE 3 OF THE TERMINAL-TAB FIELD REPORTS, PINNED.
 *
 * PR #135 put terminals inside Lody's session tab strip, #136 made the deep
 * links resolve and #137 made the selection sync both ways. A real-Chromium
 * audit against canary then found what was left, and each `describe` below is
 * one of those findings, named by its audit id.
 *
 * WHAT EACH ONE CAN REACH. Three harnesses, in order of how much they mount:
 *
 * 1. **The shell.** `CloudApp` itself, with the flag on, a box that answers
 *    `present`, and the 3.5 MB surface mocked to a prop recorder. It reaches
 *    everything the SHELL decides: which strip is drawn, which tab body is
 *    mounted, what a spawn selects, what Cmd+B does.
 * 2. **The rail's own component**, with the vendored sidebar mocked, which is
 *    the only way `SessionRailSidebar` renders in CI — the real one needs a
 *    runtime, a Loro document and a daemon.
 * 3. **The source.** `SessionDetail` cannot be mounted in CI at all, so the two
 *    seam hunks this wave adds are pinned by reading the vendored file, the
 *    precedent `lody-surface-tabs.test.tsx` set for hunks 13-18.
 */
import { act, useState, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { ControlPlaneClient } from "../src/api.js";
import type { BoxEndpoints } from "../src/resolver.js";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodyRailState } from "../src/lody/use-lody-rail.js";
import type { WorkspaceTab } from "../src/storage.js";
import { PORTS_POLL_INTERVAL_MS } from "../src/preview.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vendoredSessionDetail = join(
  repoRoot,
  "vendor/lody/packages/components/src/components/sessions/session-detail.tsx",
);

// `FilesSidebar` and the vendored sidebar both measure themselves, and jsdom
// has no `ResizeObserver`.
installLodyDomStubs();

// A shell case is a real `CloudApp` mount behind a workspace poll, a
// capability probe and a persistence round trip; under jsdom that is seconds,
// not milliseconds.
vi.setConfig({ testTimeout: 60_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

// ---------------------------------------------------------------------------
// Harness 1: the shell.
// ---------------------------------------------------------------------------

/** A `/lody/platform` catalog the real parser accepts, so `present` is real. */
const CATALOG = JSON.stringify({
  identity: { userId: "local:11111111-1111-1111-1111-111111111111" },
  machine: { machineId: "m-1" },
  workspaces: [
    { workspaceId: "lw_1", name: "Lody", slug: "local", role: "owner", state: "active" },
  ],
});

const WORKSPACE = workspaceViewFixture({
  id: "ws-1",
  name: "ws-one",
  ssh: { host: "box.example.test", port: 2222, user: "blitz", hostPublicKey: null },
});

const VIEWER = {
  user: {
    id: "user-one",
    email: "person@example.com",
    name: "Person",
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
  org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  organizations: [
    {
      membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
      org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
    },
  ],
};

/**
 * A control-plane client that answers the handful of calls the shell makes on
 * mount and refuses everything else by name.
 *
 * A Proxy rather than the 150-line literal `shell-smoke.test.tsx` writes out:
 * that literal is a list of methods, and a list of methods is exactly what goes
 * stale. What this file needs from the client is six answers.
 */
function shellClient(state: Map<string, unknown>): ControlPlaneClient {
  const answers: Record<string, unknown> = {
    googleLoginUrl: () => "/auth/google/start",
    inviteGoogleLoginUrl: (code: string) => `/auth/google/start?invite=${code}`,
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
    me: async () => VIEWER,
    poll: async () => ({ workspaces: [WORKSPACE] }),
    getGlobalWebAppState: async () => ({ doc: null, updatedAt: null }),
    putGlobalWebAppState: async (doc: unknown) => ({ doc, updatedAt: 1 }),
    getWorkspaceWebAppState: async (workspaceId: string) => ({
      doc: state.get(workspaceId) ?? null,
      updatedAt: state.has(workspaceId) ? 1 : null,
    }),
    putWorkspaceWebAppState: async (workspaceId: string, doc: unknown) => {
      state.set(workspaceId, doc);
      return { doc, updatedAt: 1 };
    },
    listCredentialRequests: async () => ({ requests: [] }),
    listWorkspaceFolders: async () => ({ folders: [] }),
    listSessionShares: async () => ({ granted: [], received: [] }),
    listMachineTypes: async () => ({ machineTypes: [], failures: [] }),
  };
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property in answers) return answers[property];
        return async () => {
          throw new Error(`the shell called ${property}, which this harness does not answer`);
        };
      },
    },
  );
  // SAFETY: every method the shell reaches on mount is answered above; the
  // Proxy refuses the rest by name rather than returning a wrong shape.
  return client as ControlPlaneClient;
}

interface ShellOptions {
  path: string;
  tabs: WorkspaceTab[];
  activeId: number | null;
  sideActiveId?: number;
  mobile?: boolean;
  /** The `/lody/platform` probe never answers, so the capability stays
   * `probing` for the whole render — the boot window, held open. */
  probePending?: boolean;
}

/** What the mocked surface was handed on its last render. */
interface SurfaceRecord {
  hidden: boolean;
  activeTerminalId: string;
  surfaceTabs: import("../src/lody/surface-tabs.js").SurfaceTabsBinding | undefined;
}

async function mountShell(options: ShellOptions) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const mobile = options.mobile === true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  // The box's `/connections-focus` marker, mutable per case; every other box
  // door answers the platform catalog, which is the only one the shell parses.
  const focusMarker: { body: unknown } = { body: { focus: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/connections-focus")) {
        return new Response(JSON.stringify(focusMarker.body), { status: 200 });
      }
      // A door that never answers holds the capability at `probing`, which is
      // where every cold load starts and where the native strip used to show.
      if (options.probePending === true && String(input).includes("/lody/platform")) {
        return await new Promise<Response>(() => undefined);
      }
      return new Response(CATALOG, { status: 200 });
    }),
  );
  vi.doMock("../src/TtydTerminal.js", () => ({
    TERMINAL_SUBMIT_EVENT: "blitz:terminal-submit",
    TtydTerminal: () => null,
  }));
  const surface: SurfaceRecord = {
    hidden: true,
    activeTerminalId: "",
    surfaceTabs: undefined,
  };
  // The real surface is 3.5 MB of vendored renderer and needs a daemon. This
  // records what the shell hands it and draws the ONE control it portals into
  // the rail — the Terminals `+`, which is the only spawn affordance a
  // flag-on workspace has (§4.1, the native strip being gone).
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (host: {
      surfaces: Array<{
        active?: boolean;
        hidden?: boolean;
        rail?: { activeTerminalId: string; terminalsAction?: ReactNode };
        surfaceTabs?: SurfaceRecord["surfaceTabs"];
      }>;
    }) => {
      const current = host.surfaces.find((item) => item.active === true);
      surface.hidden = current?.hidden === true;
      surface.activeTerminalId = current?.rail?.activeTerminalId ?? "";
      surface.surfaceTabs = current?.surfaceTabs;
      return <div data-testid="lody-surface">{current?.rail?.terminalsAction}</div>;
    },
  }));

  const { default: CloudApp } = await import("../src/CloudApp.js");
  const { standaloneResolver } = await import("../src/resolver.js");
  const { defaultWorkspaceFiles, defaultWorkspaceWebAppState } = await import(
    "../src/storage.js"
  );
  const state = new Map<string, unknown>();
  const base = defaultWorkspaceWebAppState();
  state.set("ws-1", {
    ...base,
    tabs: {
      version: 1,
      tabs: options.tabs,
      activeId: options.activeId,
      nextId: options.tabs.reduce((highest, tab) => Math.max(highest, tab.id), 0) + 1,
      ...(options.sideActiveId === undefined ? {} : { sideActiveId: options.sideActiveId }),
    },
    drawer: defaultWorkspaceFiles(),
  });
  window.history.replaceState({}, "", options.path);
  const view = await render(
    <CloudApp client={shellClient(state)} resolver={standaloneResolver({ files: 7445 })} />,
  );
  // Two settles: the workspace poll, then the capability probe it enables.
  await settle();
  await settle();
  await settle();
  return { view, surface, state, focusMarker };
}

/** The persistence write is debounced 150 ms; a case that reads the stored
 * document has to outlive that. */
async function flushPersistence(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await settle();
}

const paneStrips = (view: { container: HTMLElement }): number =>
  view.container.querySelectorAll(".webapp-pane-strip").length;

const TERMINAL_TABS: WorkspaceTab[] = [
  { id: 7, type: "terminal" },
  { id: 9, type: "claude" },
];

describe("F2 — a workspace with tabs always has a tab strip", () => {
  // F2's ANSWER CHANGED. It was "the panes draw their own strip when the
  // surface is hidden"; the native strip is deleted (plans/LODY-TERMINAL-TABS.md
  // §4.6, "PR 2"), so the answer is now that `/workspaces/:id` is not a place
  // the surface is hidden at all — it resolves into the chat plane, where the
  // one strip is. The invariant F2 was defending is unchanged: a workspace with
  // tabs always has a tab strip.
  it("resolves /workspaces/:id into the chat plane instead of the panes", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    // THIS IS THE REFRESH REPORT. A returning member with tabs used to stay
    // here for good: the landing default only fired for a document with ZERO
    // tabs, so every bookmark and every workspace switch landed on the native
    // strip. The root address now normalises, and it REPLACES — the member
    // never asked for the step, so the back button must not walk through it.
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(mounted.surface.hidden, "the surface is on screen").toBe(false);
    expect(paneStrips(mounted.view), "no native strip, ever").toBe(0);
    expect(
      mounted.view.container.querySelector(".webapp-tabstrip"),
      "the deleted strip's markup is gone with it",
    ).toBeNull();
    await mounted.view.unmount();
  });

  it("draws the one strip when the surface is on screen", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    expect(mounted.surface.hidden).toBe(false);
    // One strip, not two: this is the whole of item 4.
    expect(paneStrips(mounted.view)).toBe(0);
    expect(mounted.surface.surfaceTabs?.tabs.map(({ id }) => id)).toEqual([
      "blitz-tab:7",
      "blitz-tab:9",
    ]);
    await mounted.view.unmount();
  });

  it("shows a skeleton, not the old strip, while the probe is still out", async () => {
    // THE OTHER HALF OF THE REFRESH REPORT. `lodySurfaceMounts` needs a box
    // that answered `present`, and the probe starts at `probing` on every cold
    // load — up to 7.5 s of retries. The panes filled that window with the
    // native strip and then swapped it for the session strip; that swap is the
    // flash the member saw. The window now has a state of its own.
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat",
      tabs: TERMINAL_TABS,
      activeId: 7,
      probePending: true,
    });
    expect(paneStrips(mounted.view), "no native strip in the boot window").toBe(0);
    expect(mounted.view.container.querySelector(".webapp-tabstrip")).toBeNull();
    const skeleton = mounted.view.container.querySelector(".webapp-loading-tabstrip");
    expect(skeleton, "the boot window draws a strip skeleton").not.toBeNull();
    await mounted.view.unmount();
  });

  it("draws the tab bodies in exactly one host", async () => {
    // The one-mount invariant, which the deletion must not trade away: two
    // hosts painting one tmux session would be two ttyd sockets on one PTY.
    const strip = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/7",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    expect(strip.surface.surfaceTabs?.tabs.some(({ content }) => content !== null)).toBe(true);
    expect(strip.view.container.querySelectorAll(".webapp-workspace-session")).toHaveLength(0);
    await strip.view.unmount();
  });
});

describe("S1 — a deep-linked terminal is the tab its pane is showing", () => {
  it("writes the addressed id into the pane the tab lives in", async () => {
    // The persisted document says tab 7; the address says tab 9. Nothing
    // reconciled the two, so `renderedSessions` admitted only 7 and the strip
    // drew tab 9 selected over an empty pane.
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/9",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    expect(mounted.surface.surfaceTabs?.activeTabId).toBe("blitz-tab:9");
    const bodies = mounted.surface.surfaceTabs?.tabs ?? [];
    expect(bodies.find(({ id }) => id === "blitz-tab:9")?.content).not.toBeNull();
    // And it is a real write, not a render-local guess: the pane's own active
    // id followed, so the rail, the statusline and a return to the panes all
    // agree with the address.
    await flushPersistence();
    const persisted = mounted.state.get("ws-1") as { tabs: { activeId: number } };
    expect(persisted.tabs.activeId).toBe(9);
    await mounted.view.unmount();
  });
});

describe("S3 — a spawn selects the tab the spawn created", () => {
  it("gives two spawns in one tick two ids, and selects the newest", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat",
      tabs: [{ id: 7, type: "terminal" }],
      activeId: 7,
    });
    const plus = mounted.view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="New tab"]',
    );
    expect(plus, "the rail's Terminals + is mounted").not.toBeNull();
    await act(async () => plus?.click());
    const terminal = mounted.view.container.querySelector<HTMLButtonElement>(
      '[role="menu"][aria-label="New tab"] [role="menuitem"]',
    );
    expect(terminal, "the menu offers a session type").not.toBeNull();
    // TWO PRESSES INSIDE ONE REACT BATCH, which is what a double click is —
    // and what the render-time `tabs.nextId` could not survive: both presses
    // read the same id, so the second tab was created and the first was
    // selected twice.
    await act(async () => {
      terminal?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      terminal?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    const ids = (mounted.surface.surfaceTabs?.tabs ?? []).map(({ id }) => id);
    expect(ids, "both spawns created a tab").toEqual([
      "blitz-tab:7",
      "blitz-tab:8",
      "blitz-tab:9",
    ]);
    expect(mounted.surface.surfaceTabs?.activeTabId, "the newest tab is selected").toBe(
      "blitz-tab:9",
    );
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/terminal/9");
    await mounted.view.unmount();
  });
});

describe("S4 — opening a utility panel shows it", () => {
  const chord = async () => {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
      );
    });
    await settle();
  };

  it("selects the Files tab it just created", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/7",
      tabs: [{ id: 7, type: "terminal" }],
      activeId: 7,
    });
    await chord();
    // The tab exists AND the strip is on it. Before the fix `togglePanelTab`
    // wrote a pane selection the strip does not read, so the chord added a tab
    // nobody could see and read as dead.
    expect((mounted.surface.surfaceTabs?.tabs ?? []).map(({ id }) => id)).toContain(
      "blitz-tab:8",
    );
    expect(mounted.surface.surfaceTabs?.activeTabId).toBe("blitz-tab:8");
    await mounted.view.unmount();
  });

  it("closes it again when it is the tab on screen", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/7",
      tabs: [{ id: 7, type: "terminal" }],
      activeId: 7,
    });
    await chord();
    await chord();
    expect((mounted.surface.surfaceTabs?.tabs ?? []).map(({ id }) => id)).toEqual([
      "blitz-tab:7",
    ]);
    await mounted.view.unmount();
  });

  // THE SAME DEFECT, THREE MORE DOORS. Cmd/Ctrl+B was the one the audit named
  // first; the right icon strip and the box's own `blitz connections open`
  // marker took the identical pane-only route and were identically dead.
  it.each(["Files", "teenyapps", "Connections"] as const)(
    "selects the panel the right icon strip's %s button opens",
    async (label) => {
      const mounted = await mountShell({
        path: "/workspaces/ws-1/chat/terminal/7",
        tabs: [{ id: 7, type: "terminal" }],
        activeId: 7,
      });
      const button = mounted.view.container.querySelector<HTMLButtonElement>(
        `.webapp-rail-strip button[aria-label="${label}"]`,
      );
      expect(button, "the right icon strip is mounted").not.toBeNull();
      await act(async () => button?.click());
      await settle();
      expect(mounted.surface.surfaceTabs?.activeTabId).toBe("blitz-tab:8");
      // And a second press still closes it, which is what makes it a toggle.
      await act(async () => button?.click());
      await settle();
      expect((mounted.surface.surfaceTabs?.tabs ?? []).map(({ id }) => id)).toEqual([
        "blitz-tab:7",
      ]);
      await mounted.view.unmount();
    },
  );

  it("selects the Connections panel the box's own focus marker asks for", async () => {
    // `blitz connections open <provider>` raises a marker the browser polls;
    // the whole point of it is that the agent sent the member somewhere, so a
    // panel tab nothing selects is the one outcome it must not have.
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/7",
      tabs: [{ id: 7, type: "terminal" }],
      activeId: 7,
    });
    // The first poll adopts whatever the box already reports as the consumed
    // baseline, which is what stops a workspace switch replaying an old focus;
    // only a strictly newer one opens.
    mounted.focusMarker.body = {
      focus: { version: 1, provider: "github", requestedAt: 1_700_000_000_000 },
    };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PORTS_POLL_INTERVAL_MS + 500));
    });
    await settle();
    expect(mounted.surface.surfaceTabs?.activeTabId).toBe("blitz-tab:8");
    await mounted.view.unmount();
  });
});

describe("ADJ1 — the rail's terminal highlight follows the address", () => {
  it("names the addressed tab while the surface is up, and nothing on a chat", async () => {
    const onTerminal = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/9",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    expect(onTerminal.surface.activeTerminalId).toBe("9");
    await onTerminal.view.unmount();

    const onLanding = await mountShell({
      path: "/workspaces/ws-1/chat",
      tabs: TERMINAL_TABS,
      activeId: 7,
    });
    // A conversation owns the pane, so no terminal row is current. The old
    // value here was the PANE's focused tab, which is a different question.
    expect(onLanding.surface.activeTerminalId).toBe("");
    await onLanding.view.unmount();

    // THE "WITH THE PANES UP" ARM IS GONE. It read the pane's own focused tab,
    // and on a surface-capable desktop there is no pane address left to read it
    // from: `/workspaces/ws-1` resolves into the chat plane, where a
    // conversation owns the view and no terminal row is current.
    const onRoot = await mountShell({
      path: "/workspaces/ws-1",
      tabs: TERMINAL_TABS,
      activeId: 9,
    });
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    expect(onRoot.surface.activeTerminalId).toBe("");
    await onRoot.view.unmount();
  });
});

describe("F5 — the mobile breakpoint cannot strand a terminal address", () => {
  it("gives the terminal back to the panes and stops naming it in the URL", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/s-1/terminal/9",
      tabs: TERMINAL_TABS,
      activeId: 7,
      mobile: true,
    });
    // Below the breakpoint the vendored strip is not mounted (§5.5), so the
    // chat covered the panes and the URL kept naming a terminal nothing on this
    // layout could draw. The panes take it back — and they take it back with NO
    // strip, because the native one is deleted: on mobile the rail, in the
    // drawer, is the tab list, and its rows carry the close.
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    expect(mounted.surface.hidden).toBe(true);
    expect(paneStrips(mounted.view)).toBe(0);
    // And it is the terminal the address named that the panes show, not the
    // one the document happened to have active.
    await flushPersistence();
    const persisted = mounted.state.get("ws-1") as { tabs: { activeId: number } };
    expect(persisted.tabs.activeId).toBe(9);
    await mounted.view.unmount();
  });

  it("keeps the navigation drawer reachable without the deleted header", async () => {
    // The hamburger was a child of `WebAppHeader` and it is not a tab control:
    // below the breakpoint the rail rides in an off-canvas drawer and this is
    // the only thing that opens it on a loaded workspace page. It moved to
    // `shell/PaneChrome.tsx` rather than going with the strip.
    const mounted = await mountShell({
      path: "/workspaces/ws-1",
      tabs: TERMINAL_TABS,
      activeId: 7,
      mobile: true,
    });
    expect(
      mounted.view.container.querySelector('button[aria-label="Open workspace navigation"]'),
      "mobile keeps a way into the rail",
    ).not.toBeNull();
    expect(paneStrips(mounted.view)).toBe(0);
    await mounted.view.unmount();
  });

  it("replaces rather than pushes, so the back button is not a trap", async () => {
    const mounted = await mountShell({
      path: "/workspaces/ws-1/chat/terminal/9",
      tabs: TERMINAL_TABS,
      activeId: 7,
      mobile: true,
    });
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    // A pushed correction would leave the refused address one Back away, where
    // the same effect would bounce it forward again.
    await act(async () => window.history.back());
    await settle();
    expect(window.location.pathname).not.toBe("/workspaces/ws-1/chat/terminal/9");
    await mounted.view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Harness 2: the address wiring alone, for the verbs the shell cannot reach.
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  terminalUrl: "https://box.invalid/webapp/7681/",
  filesBase: "https://box.invalid/webapp/5000/",
  lodySyncUrl: "wss://box.invalid/webapp/7445/lody/sync",
  lodyRpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
  lodyControlUrl: "https://box.invalid/webapp/7445/lody/control",
  lodyProjectUrl: "https://box.invalid/webapp/7445/lody/project",
  lodyPlatformUrl: "https://box.invalid/webapp/7445/lody/platform",
} satisfies BoxEndpoints;

async function mountRail(path: string) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  window.history.replaceState({}, "", path);
  const seen: { rail: LodyRailState | null } = { rail: null };
  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    seen.rail = useLodyRail(route, setRoute, route.workspaceId ?? "", true, {
      capability: "present",
      surfaceHostsTabs: true,
    });
    return null;
  }
  const view = await render(<Host />);
  await settle();
  return { seen, view };
}

describe("F7 — a dead session with a live terminal keeps the strip", () => {
  it("moves the terminal to the landing's host and leaves the session behind", async () => {
    const mounted = await mountRail("/workspaces/ws-1/chat/s-dead/terminal/7");
    await act(async () => mounted.seen.rail?.openTerminalOnLanding());
    await settle();
    // The landing host draws the same strip with no session to root it in
    // (§3.4), so the terminal the member was looking at survives a session id
    // the daemon does not have.
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/terminal/7");
    expect(mounted.seen.rail?.terminalId).toBe("7");
    expect(mounted.seen.rail?.sessionId).toBeNull();
    await mounted.view.unmount();
  });

  it("is inert on an address with no session to be missing", async () => {
    for (const path of [
      "/workspaces/ws-1/chat/terminal/7",
      "/workspaces/ws-1/chat/s-1",
      "/workspaces/ws-1/chat",
    ]) {
      const mounted = await mountRail(path);
      await act(async () => mounted.seen.rail?.openTerminalOnLanding());
      await settle();
      expect(window.location.pathname, path).toBe(path);
      await mounted.view.unmount();
    }
    // The workspace ROOT is not in that list any more: it is not an address the
    // shell rests on, because the strip that would draw its tabs is deleted.
    // `openTerminalOnLanding` is still inert there — what moves the address is
    // the normalisation, and it moves it exactly once.
    const root = await mountRail("/workspaces/ws-1");
    await act(async () => root.seen.rail?.openTerminalOnLanding());
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat");
    await root.view.unmount();
  });

  it("replaces the address it refused", async () => {
    const mounted = await mountRail("/workspaces/ws-1/chat/s-dead/terminal/7");
    await act(async () => mounted.seen.rail?.openTerminalOnLanding());
    await settle();
    await act(async () => window.history.back());
    await settle();
    expect(window.location.pathname).not.toBe("/workspaces/ws-1/chat/s-dead/terminal/7");
    await mounted.view.unmount();
  });
});

describe("F7 — seam patch 5 hunks 19-20, pinned at the source", () => {
  // `SessionDetail` needs a runtime, a Loro document and Monaco, so CI cannot
  // mount it. What must be true is that the prop exists AND is called from the
  // not-found branch — a declared prop nothing invokes is the exact shape of
  // the defect it fixes.
  const detail = () => readFileSync(vendoredSessionDetail, "utf8");

  it("declares the prop", () => {
    expect(detail()).toContain("onSessionMissing?: (sessionId: string) => void;");
  });

  it("calls it from the not-found branch, above the analytics once-gate", () => {
    const source = detail();
    const call = source.indexOf("onSessionMissingRef.current?.(sessionId);");
    const onceGate = source.indexOf("if (!fireDetailNotFoundOnce(sessionId)) {");
    expect(call, "the host is told").toBeGreaterThan(-1);
    expect(onceGate).toBeGreaterThan(-1);
    // Above the gate: the host moves an address with it, and an address can
    // come back, so it must not be a once-per-session event.
    expect(call).toBeLessThan(onceGate);
    // Through a ref, so a fresh host closure does not re-run upstream's effect.
    expect(source).toContain("const onSessionMissingRef = useRef(onSessionMissing);");
  });

  it("is threaded from our side of the seam", () => {
    const router = readFileSync(join(repoRoot, "packages/webapp/src/lody/router.tsx"), "utf8");
    expect(router).toContain("onSessionMissing: surfaceTabs.onSessionMissing");
    const shell = readFileSync(join(repoRoot, "packages/webapp/src/CloudApp.tsx"), "utf8");
    expect(shell).toContain("lodyRail.openTerminalOnLanding();");
  });
});

// ---------------------------------------------------------------------------
// Harness 3: the pieces that mount on their own.
// ---------------------------------------------------------------------------

describe("F8 — the agent-auth banner belongs to session content", () => {
  it("is not drawn while a host tab owns the pane", () => {
    // The banner says a CONVERSATION's agent is signed out and carries that
    // conversation's sign-in panel. Above the strip while a terminal owns the
    // pane it is a band about something the member is not looking at.
    const owners = readFileSync(
      join(repoRoot, "packages/webapp/src/lody/surface-active-owners.tsx"),
      "utf8",
    );
    expect(owners).toContain(
      "const { surfaceTabs } = useLodySurfaceActiveState();",
    );
    expect(owners).toContain(
      "if (surfaceTabs !== undefined && surfaceTabs.activeTabId !== null) return null;",
    );
    // Rendered through one gate in this owner, so there is no second call site
    // to forget when the active host-tab state changes.
    expect(owners).toContain("export function LodySurfaceAgentAuthNotice(props: {");
    expect(owners.match(/<LodyAgentAuthNotice/gu)).toHaveLength(1);
  });
});

describe("ADJ2 — the agent-config bootstrap runs once per box", () => {
  it("survives a shell render that hands it a fresh endpoints object", async () => {
    vi.resetModules();
    let bootstraps = 0;
    vi.doMock("../src/lody/agent-configs.js", () => ({
      BLITZ_CLAUDE_CONFIG_ID: "blitz-claude",
      BLITZ_CLAUDE_EXECUTABLE: "/usr/local/bin/claude",
      bootstrapLodyAgentConfigs: async () => {
        bootstraps += 1;
      },
      refreshLodyAcpCapabilities: async () => undefined,
    }));
    vi.doMock("../src/lody/local-projects.js", () => ({
      mirrorLocalProjectsToMachineMeta: async () => undefined,
      publishBoxReposAsWorkspaceRepos: async () => [],
    }));
    const { LodyAgentConfigGate } = await import("../src/lody/agent-config-gate.js");
    const { runtimeAtom } = await import("@lody/components/atoms/runtime");
    const store = createStore();
    // SAFETY: the vendor type seam erases `runtimeAtom` to `any`; the value is
    // only ever read back by the mocked bootstrap above.
    store.set(runtimeAtom, { workspaceId: "lw_1" });

    const endpoints = () => ({
      syncUrl: ENDPOINTS.lodySyncUrl,
      rpcUrl: ENDPOINTS.lodyRpcUrl,
      controlUrl: ENDPOINTS.lodyControlUrl,
      projectUrl: ENDPOINTS.lodyProjectUrl,
      platformUrl: ENDPOINTS.lodyPlatformUrl,
      filesBase: ENDPOINTS.filesBase,
    });
    function Host(props: { version: number }) {
      return (
        <LodyAgentConfigGate
          store={store}
          machineId="m-1"
          endpoints={endpoints()}
        >
          <div data-version={props.version} />
        </LodyAgentConfigGate>
      );
    }
    const view = await render(<Host version={0} />);
    await settle();
    expect(bootstraps, "one bootstrap on mount").toBe(1);
    // `LodySessionsRegion` builds the endpoints object inline, so every shell
    // render hands the gate a new one. Keyed on the object, that tore the
    // subscription down and re-ran a Flock round trip, a machine-meta mirror,
    // a project publish and an ACP capability sweep — per render.
    for (const version of [1, 2, 3]) {
      await act(async () => view.root.render(<Host version={version} />));
      await settle();
    }
    expect(bootstraps, "and none for a re-render of the same box").toBe(1);
    await view.unmount();
  });
});

describe("ADJ1 — the rail rows themselves", () => {
  /** `SessionRailSidebar` reads nine vendored modules and the real ones need a
   * runtime, a Loro document and a daemon. Every mock below is a pass-through:
   * what is under test is the one rule this file owns, which rows are current. */
  async function mountSidebar(props: { surfaceVisible: boolean; activeTerminalId: string }) {
    vi.resetModules();
    const { atom } = await import("jotai");
    vi.doMock("@lody/components/components/loro-sidebar", () => ({
      LoroSidebar: (sidebar: { afterSessionListContent?: ReactNode }) => (
        <div>{sidebar.afterSessionListContent}</div>
      ),
    }));
    vi.doMock("@lody/components/components/session-list", () => ({
      SessionList: () => null,
    }));
    vi.doMock("@lody/components/components/sidebar-row-shared", () => ({
      SidebarSectionHeader: (header: { label: string }) => <h2>{header.label}</h2>,
    }));
    vi.doMock("@lody/components/atoms/runtime", () => ({
      activeWorkspaceRuntimeAtom: atom({ workspaceId: "lw_1" }),
    }));
    vi.doMock("@lody/components/atoms", () => ({ userAtom: atom({ id: "u-1" }) }));
    vi.doMock("@lody/components/hooks/use-visible-session-metas", () => ({
      useVisibleSessionMetas: () => ({ sessions: [], allActiveSessions: [], isLoading: false }),
    }));
    vi.doMock("@lody/components/hooks/use-machine-online-status", () => ({
      useOnlineMachineIds: () => new Set<string>(),
    }));
    vi.doMock("@lody/components/hooks/use-session-actions", () => ({
      useSessionActions: () => ({
        updateSessionTitle: async () => undefined,
        archiveSession: async () => undefined,
        setSessionPinned: async () => undefined,
      }),
    }));
    vi.doMock("@lody/components/components/sessions/session-list-rows", () => ({
      buildSessionListRows: () => [],
    }));
    const { SessionRailSidebar } = await import("../src/lody/SessionRailSidebar.js");
    const view = await render(
      <SessionRailSidebar
        terminals={[
          { id: "7", label: "bash", agent: "terminal" },
          { id: "9", label: "claude", agent: "claude" },
        ]}
        activeTerminalId={props.activeTerminalId}
        activeSessionId={null}
        surfaceVisible={props.surfaceVisible}
        onSelectTerminal={() => undefined}
        onSelectSession={() => undefined}
        onOpenLanding={() => undefined}
      />,
    );
    await settle();
    const current = [...view.container.querySelectorAll<HTMLElement>(".shell-s--on")].map(
      (row) => row.textContent ?? "",
    );
    return { view, current };
  }

  it("highlights the terminal a terminal TAB is showing", async () => {
    // The old rule was `active={!surfaceVisible}`: a terminal row lost its
    // highlight exactly when its terminal came on screen.
    const mounted = await mountSidebar({ surfaceVisible: true, activeTerminalId: "9" });
    expect(mounted.current).toEqual(["claude"]);
    await mounted.view.unmount();
  });

  it("highlights nothing while a conversation owns the pane", async () => {
    const mounted = await mountSidebar({ surfaceVisible: true, activeTerminalId: "" });
    expect(mounted.current).toEqual([]);
    await mounted.view.unmount();
  });

  it("keeps the panes' own answer, first row included, while the panes are up", async () => {
    const mounted = await mountSidebar({ surfaceVisible: false, activeTerminalId: "" });
    expect(mounted.current).toEqual(["bash"]);
    await mounted.view.unmount();
  });
});

describe("S2 — the command palette, and why it is a documented limitation", () => {
  it("has no dispatcher in the BlitzOS mount at all", () => {
    // `session.archiveCurrent`, `session.closeFocusedTab` and the next/previous
    // tab cycle resolve against `activeTabSessionId` and know nothing about a
    // host tab — and none of them can be reached here. The registry's
    // capture-phase keydown listener is attached by `AppInitializer`, which
    // only `routes/__root.tsx` mounts; the palette is only mounted by
    // `routes/$workspaceName/_auth.tsx`. This surface mounts neither (see
    // `SessionSurface.tsx`'s "what we do not mount" note), so no command
    // reaches `execute()`.
    const vendor = join(repoRoot, "vendor/lody/packages/components/src");
    expect(readFileSync(join(vendor, "components/AppInitializer.tsx"), "utf8"))
      .toContain("commands.attach(window);");
    expect(readFileSync(join(vendor, "routes/__root.tsx"), "utf8"))
      .toContain("AppInitializer");
    expect(readFileSync(join(vendor, "routes/$workspaceName/_auth.tsx"), "utf8"))
      .toContain("<CommandPalette />");

    // Our tree mounts neither, and this is what would have to change first.
    const ourSources = ["SessionSurface.tsx", "router.tsx"].map((file) =>
      readFileSync(join(repoRoot, "packages/webapp/src/lody", file), "utf8"),
    ).join("\n");
    expect(ourSources).not.toContain("AppInitializer");
    expect(ourSources).not.toContain("CommandPalette");
    expect(ourSources).not.toContain("commands.attach");

    // And the limitation is written down where a merge agent will read it.
    expect(readFileSync(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"), "utf8"))
      .toContain("session.archiveCurrent");
  });
});
