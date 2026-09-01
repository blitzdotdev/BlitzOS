/**
 * WHAT A WORKSPACE DOES WHEN ITS MACHINE RUNS A PRE-LODY IMAGE
 * (plans/LODY-SESSIONS.md §13.2, plans/LODY-RUNTIME-DESIGN.md §17 — the fourth
 * canary dogfood).
 *
 * The field report: a box on an older image has no `/lody/*` door, its gateway
 * falls the path through to dufs, dufs answers 403 — and the webapp read that
 * 403 as "the daemon is not ready yet", forever. `fetchLodyPlatformSnapshot`
 * folds every non-ok status into `null`, so the surface's poller never settled,
 * the gated branch never mounted, `error` stayed `null` so no notice rendered
 * either, and a 403 went into the console every 500 ms. The member read the
 * whole thing as "the feature does not work".
 *
 * Four properties, in the order the fix applies them:
 *
 * 1. The probe TELLS 403/404 APART from a network error and a 5xx. One is a
 *    fact about the image; the others are a box that is still coming up.
 * 2. A structural absence is probed ONCE. No retry, no poll, no console error.
 * 3. It costs no chunk: `SessionSurface` — 3.5 MB of vendored renderer — must
 *    not be imported for a box that cannot use a byte of it.
 * 4. The workspace gets the FULL flag-off experience back: the New tab bar, one
 *    native row per managed tab, the terminal-first fresh default, and one
 *    quiet line saying why.
 *
 * DAEMON-FREE. Everything here is the wiring between a status code and a rail,
 * which is where the defect was; the daemon suites are unchanged and stay the
 * proof that the NEW image's path still works.
 *
 * WAVE 4 ADDS THE SECOND STRUCTURAL ABSENCE, and it arrives on a status this
 * file used to read as transient. An org member with no machine in a workspace
 * is refused by the CONTROL PLANE with 409 before anything reaches a box, so the
 * probe retried five times, concluded `present`, mounted the surface, and left
 * the member watching "connecting" for as long as they were willing to. The
 * fallback it needs is the one already here; what is new is telling that 409
 * apart from the two transient ones, and saying a different sentence.
 */
import { act, useState } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxEndpoints } from "../src/resolver.js";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodyRailState } from "../src/lody/use-lody-rail.js";
import type { LodySessionsCapability } from "../src/lody/box-capability.js";
import { SessionRail } from "../src/shell/SessionRail.js";
import { WorkPanes, type WorkPanesProps } from "../src/shell/WorkPanes.js";
import type { ControlPlaneClient } from "../src/api.js";
import { render, settle } from "./dom.js";
import { workspaceModelFixture } from "./workspace-fixtures.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

const here = dirname(fileURLToPath(import.meta.url));

const PLATFORM_URL = "https://box.invalid/webapp/7445/lody/platform";

const ENDPOINTS = {
  terminalUrl: "https://box.invalid/webapp/7681/",
  filesBase: "https://box.invalid/webapp/5000/",
  lodySyncUrl: "wss://box.invalid/webapp/7445/lody/sync",
  lodyRpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
  lodyControlUrl: "https://box.invalid/webapp/7445/lody/control",
  lodyProjectUrl: "https://box.invalid/webapp/7445/lody/project",
  lodyPlatformUrl: PLATFORM_URL,
} satisfies BoxEndpoints;

/** A catalog the real parser accepts, so the `present` path is a real one. */
const CATALOG = JSON.stringify({
  identity: { userId: "local:11111111-1111-1111-1111-111111111111" },
  machine: { machineId: "m-1" },
  workspaces: [
    { workspaceId: "lw_1", name: "Lody", slug: "local", role: "owner", state: "active" },
  ],
});

function answering(...statuses: number[]) {
  let call = 0;
  return vi.fn(async () => {
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
    call += 1;
    return new Response(status === 200 ? CATALOG : "Forbidden", { status });
  });
}

/** The control plane's own envelope (`core/app.ts`: `{ error, retryAction }`),
 * which is the only thing that can answer 409 on this path. */
function refusing(message: string) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ error: message, retryAction: null }), { status: 409 }),
  );
}

/** The exact sentence `machineForRequest` throws, read out of the control plane
 * rather than restated here. */
function noMachineRefusal(): string {
  const source = readFileSync(
    join(here, "..", "..", "control-plane", "core", "workspaces.ts"),
    "utf8",
  );
  const match = /"(you have no machine in this workspace[^"]*)"/u.exec(source);
  expect(match, "core/workspaces.ts still refuses a machineless member by name").not.toBeNull();
  return match?.[1] ?? "";
}

describe("reading the platform door's status", () => {
  it("separates a structural absence from a box that is still coming up", async () => {
    const { readLodyDoorStatus } = await import("../src/lody/box-capability.js");
    // The two an old image produces. Nothing else is worth asking twice about.
    expect(readLodyDoorStatus(403)).toBe("absent");
    expect(readLodyDoorStatus(404)).toBe("absent");
    // The bridge's own "the daemon has not written its catalog yet", a tunnel
    // blip, and a ticket that wants refreshing. All three resolve on their own.
    expect(readLodyDoorStatus(503)).toBe("retry");
    expect(readLodyDoorStatus(502)).toBe("retry");
    expect(readLodyDoorStatus(401)).toBe("retry");
    expect(readLodyDoorStatus(200)).toBe("present");
  });

  it("tells the machineless 409 apart from the two transient ones", async () => {
    const { readNoMachineRefusal, probeLodySessionsDoor } = await import(
      "../src/lody/box-capability.js"
    );
    // The refusal `machineForRequest` writes, as the control plane writes it.
    expect(readNoMachineRefusal(JSON.stringify({ error: noMachineRefusal() }))).toBe(true);
    // The other two 409s that route can produce. Both are a box between states,
    // and both resolve without anybody doing anything — so both stay `retry`
    // and the member gets the surface once the machine is up.
    for (const message of [
      "your machine in this workspace is not running",
      "workspace is not ready for webapp access",
    ]) {
      expect(readNoMachineRefusal(JSON.stringify({ error: message })), message).toBe(false);
      expect(await probeLodySessionsDoor(PLATFORM_URL, { fetchImpl: refusing(message) })).toBe(
        "retry",
      );
    }
    // A body that is not the envelope says nothing, and the safe direction is
    // transient: it costs four more probes, never a wrong verdict.
    expect(readNoMachineRefusal("<html>nope</html>")).toBe(false);
    expect(readNoMachineRefusal("null")).toBe(false);
    expect(
      await probeLodySessionsDoor(PLATFORM_URL, { fetchImpl: refusing(noMachineRefusal()) }),
    ).toBe("noMachine");
  });

  it("reads a network error as transient, because it says nothing about the image", async () => {
    const { probeLodySessionsDoor } = await import("../src/lody/box-capability.js");
    const failing = vi.fn(async () => {
      throw new Error("connection refused");
    });
    expect(await probeLodySessionsDoor(PLATFORM_URL, { fetchImpl: failing })).toBe("retry");
    expect(await probeLodySessionsDoor(PLATFORM_URL, { fetchImpl: answering(403) })).toBe("absent");
  });
});

/** Mounts the capability hook alone, the way `CloudApp` holds it. */
async function mountCapability(fetchImpl: typeof fetch, url: string | null = PLATFORM_URL) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const { useLodySessionsCapability } = await import("../src/lody/box-capability.js");
  const seen: { capability: LodySessionsCapability } = { capability: "probing" };
  function Host() {
    seen.capability = useLodySessionsCapability(url, fetchImpl);
    return null;
  }
  const view = await render(<Host />);
  return { seen, view };
}

describe("the capability probe", () => {
  it("settles on absent after ONE 403, and never asks again", async () => {
    const fetchImpl = answering(403);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { seen, view } = await mountCapability(fetchImpl);
    await settle();
    expect(seen.capability).toBe("absent");
    // The retry-spam this replaces was a 403 every 500 ms for the life of the
    // page. One probe, and then the answer is held.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // One quiet line, and nothing on the error channel: an older image is a
    // fact about the fleet, not a fault.
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("settles on noMachine after ONE 409 that names the reason, and never asks again", async () => {
    const fetchImpl = refusing(noMachineRefusal());
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { seen, view } = await mountCapability(fetchImpl);
    await settle();
    expect(seen.capability).toBe("noMachine");
    // The retry budget is what made this an endless "connecting": five probes,
    // then the optimistic `present`, then a platform poller with nothing behind
    // the address. One probe now, and the answer is held.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("settles on present when the door answers, without a retry", async () => {
    const fetchImpl = answering(200);
    const { seen, view } = await mountCapability(fetchImpl);
    await settle();
    expect(seen.capability).toBe("present");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("retries a transient failure and takes the answer that arrives", async () => {
    vi.useFakeTimers();
    // A box coming up: the bridge 503s until the daemon writes its catalog.
    const fetchImpl = answering(503, 503, 200);
    const { seen, view } = await mountCapability(fetchImpl);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(seen.capability).toBe("present");
    await view.unmount();
  });

  it("bounds the retries, and ends on present rather than stranding a good box", async () => {
    vi.useFakeTimers();
    const fetchImpl = answering(503);
    const { seen, view } = await mountCapability(fetchImpl);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Five attempts across the four delays, and then it stops asking. The
    // optimistic ending is deliberate: the surface has its own poller for a
    // slow daemon, and a good box on the legacy rail would lose the feature.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(seen.capability).toBe("present");
    await view.unmount();
  });

  it("asks nothing while the workspace has no running box", async () => {
    const fetchImpl = answering(200);
    const { seen, view } = await mountCapability(fetchImpl, null);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    // A machine that comes back on a NEW image is asked again, because the
    // answer never outlives the box it was about.
    expect(seen.capability).toBe("probing");
    await view.unmount();
  });
});

/**
 * The pane column, with nothing in it.
 *
 * Every prop below is required and none of them is what is under test. Since
 * the native strip was deleted (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2") the
 * column draws NO tab strip in any column of §6's table, which is what the
 * cases below assert: an old image does not get one back.
 */
function workPanesProps(sessionsPending: boolean): WorkPanesProps {
  return {
    // SAFETY: no rendered session means no surface asks the client for
    // anything; stating a whole `ControlPlaneClient` would say nothing here.
    client: {} as ControlPlaneClient,
    panesRef: { current: null },
    visibleRegions: ["main"],
    renderedSessions: [],
    surfaceRegion: () => "main",
    paneActiveId: () => null,
    paneFallback: () => null,
    sidePaneWidth: 320,
    paneResizing: false,
    sessionsPending,
    mobile: false,
    drawerOpen: false,
    canEditWorkspaceLayout: true,
    activeWorkspace: undefined,
    activeWorkspaceId: "ws-1",
    activeWorkspaceRunning: true,
    activeSessionUrl: null,
    activeFilesBase: null,
    filesClient: null,
    filesSidebar: null,
    orgName: "Org",
    workspaceWakingStage: undefined,
    livePorts: [],
    previewLinks: [],
    pendingRequests: [],
    pendingRequestsError: null,
    connectionsFocus: null,
    onOpenDrawer: () => undefined,
    onOpenPreview: () => false,
    onOpenPreviewLink: () => false,
    onResolveRequest: async () => undefined,
    onFileDirtyChange: () => undefined,
    onFilesRefresh: () => undefined,
    onUnauthorized: () => undefined,
    onSignInUrl: () => undefined,
    onBeginPaneResize: () => undefined,
  };
}

interface Mounted {
  seen: { rail: LodyRailState | null };
  /** How many times the 3.5 MB surface module was imported. */
  surfaceImports: () => number;
}

/**
 * The `CloudApp` wiring, minus everything that is not the fallback: the probe,
 * the rail hook that reads it, and the region that decides whether to import.
 *
 * The surface is mocked with a factory that COUNTS ITS OWN EVALUATION. A
 * `vi.doMock` factory runs on first import and never before, so a count of zero
 * is the assertion that the chunk was never fetched.
 */
async function mountFallback(options: {
  fetchImpl: typeof fetch;
  path: string;
}): Promise<Mounted & { view: Awaited<ReturnType<typeof render>> }> {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  let imports = 0;
  vi.doMock("../src/lody/SessionSurface.js", () => {
    imports += 1;
    return { default: () => null };
  });
  const { useLodySessionsCapability } = await import("../src/lody/box-capability.js");
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  window.history.replaceState({}, "", options.path);

  const seen: Mounted["seen"] = { rail: null };
  // The rail draws its list region from the first render, which is what makes
  // the region mount before the member ever asks for a session.
  const railHost = document.createElement("div");
  railHost.className = "session-list session-list--vendor";
  document.body.append(railHost);

  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    const capability = useLodySessionsCapability(ENDPOINTS.lodyPlatformUrl, options.fetchImpl);
    const rail = useLodyRail(route, setRoute, route.workspaceId ?? "", true, {
      capability,
      // `CloudApp`'s `surfaceTabsEnabled`. A box with no session plane never
      // draws the strip, so its workspace root is NOT normalised into the chat
      // plane — it keeps the panes, and the rail's notice says why.
      surfaceHostsTabs: capability === "present",
    });
    seen.rail = rail;
    return (
      <>
      <WorkPanes {...workPanesProps(capability === "probing")} />
      <LodySessionsRegion
        endpoints={ENDPOINTS}
        sessions={capability}
        viewerName="Me"
        viewerAvatarUrl={null}
        workspaceTitle="Workspace"
        visible={rail.visible}
        railHost={rail.onVendorHost === undefined ? null : railHost}
        terminals={[{ id: "12", label: "bash", agent: "terminal" }]}
        activeTerminalId="12"
        onSelectTerminal={() => undefined}
        onOpenSession={rail.openSession}
        onOpenLanding={rail.openLanding}
      />
      </>
    );
  }

  const view = await render(<Host />);
  await settle();
  return { seen, surfaceImports: () => imports, view };
}

describe("a workspace whose box serves no session daemon", () => {
  it("gives the rail back its native shape and imports no chunk", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mounted = await mountFallback({
      fetchImpl: answering(403),
      path: "/workspaces/ws-1",
    });
    // `onVendorHost` absent IS the legacy rail: `SessionRail` draws the New tab
    // bar and one row per managed tab exactly when it is.
    expect(mounted.seen.rail?.onVendorHost).toBeUndefined();
    expect(mounted.seen.rail?.visible).toBe(false);
    expect(mounted.surfaceImports()).toBe(0);
    // plans/LODY-TERMINAL-TABS.md §4.5 and §4.6: the strip suppression is gated
    // on the SAME signal, and only that signal. A box that cannot run the
    // surface keeps the native pane strip, because that strip is the only tab
    // control it has.
    expect(mounted.seen.rail?.available).toBe(false);
    // AND IT DOES NOT GET THE NATIVE STRIP BACK. §4.6 kept the pane strip for
    // exactly this box; "PR 2" deleted the strip outright, so the honest answer
    // for a machine that cannot run the surface is the rail's notice below and
    // not a tab strip nothing else in the product still draws.
    expect(mounted.view.container.querySelector(".webapp-pane-strip")).toBeNull();
    expect(mounted.view.container.querySelector(".webapp-tabstrip")).toBeNull();
    await mounted.view.unmount();
  });

  it("leaves a fresh workspace on the panes and seeds no legacy tabs", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mounted = await mountFallback({
      fetchImpl: answering(403),
      path: "/workspaces/ws-1",
    });
    // The address stays put: a chat landing this box cannot serve is not
    // somewhere to send anybody. `terminalFirstWorkspaceTabs()` used to be
    // written in here and is deleted with the strip — it seeded exactly the
    // tabs only that strip could draw.
    expect(window.location.pathname).toBe("/workspaces/ws-1");
    await mounted.view.unmount();
  });

  it("falls back exactly as it does for an old image when the member has no machine", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mounted = await mountFallback({
      fetchImpl: refusing(noMachineRefusal()),
      path: "/workspaces/ws-1",
    });
    // The rail behaves identically for both structural absences — that is what
    // `lodySessionsUnavailable` is for, and it is why a fourth reading needed no
    // new branch in `useLodyRail` or in the chunk gate.
    expect(mounted.seen.rail?.onVendorHost).toBeUndefined();
    expect(mounted.seen.rail?.visible).toBe(false);
    expect(mounted.seen.rail?.available).toBe(false);
    expect(mounted.surfaceImports()).toBe(0);
    expect(mounted.view.container.querySelector(".webapp-pane-strip")).toBeNull();
    await mounted.view.unmount();
  });

  it("holds a deep-linked chat address off the panes rather than showing nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mounted = await mountFallback({
      fetchImpl: answering(403),
      path: "/workspaces/ws-1/chat/s-1",
    });
    // The address survives — a reload on a recreated machine finds it again —
    // but nothing believes a chat is on screen, so the panes stay visible.
    expect(mounted.seen.rail?.visible).toBe(false);
    expect(mounted.surfaceImports()).toBe(0);
    await mounted.view.unmount();
  });

  it("changes nothing on a box that answers: the surface mounts and the zone stays", async () => {
    const mounted = await mountFallback({
      fetchImpl: answering(200),
      path: "/workspaces/ws-1/chat",
    });
    expect(mounted.seen.rail?.onVendorHost).not.toBeUndefined();
    expect(mounted.seen.rail?.visible).toBe(true);
    expect(mounted.surfaceImports()).toBe(1);
    // The other half of §4.6: on a box that serves the surface the terminals
    // are tabs of Lody's strip, so the native one is not drawn at all.
    expect(mounted.seen.rail?.available).toBe(true);
    expect(mounted.view.container.querySelector(".webapp-pane-strip")).toBeNull();
    await mounted.view.unmount();
  });

  it("imports nothing while the probe is still out", async () => {
    // A fetch that never settles: the probe is in flight for the whole render.
    const pending = vi.fn(() => new Promise<Response>(() => undefined));
    const mounted = await mountFallback({
      fetchImpl: pending,
      path: "/workspaces/ws-1/chat",
    });
    // The vendored ZONE is kept, so a good box does not flicker from legacy to
    // vendored; the CHUNK is not, because one round trip is far cheaper than
    // 3.5 MB fetched for a box that may not be able to use it.
    expect(mounted.seen.rail?.onVendorHost).not.toBeUndefined();
    expect(mounted.surfaceImports()).toBe(0);
    await mounted.view.unmount();
  });
});

describe("the rail's notice", () => {
  async function railWith(overrides: Partial<Parameters<typeof SessionRail>[0]>) {
    return await render(
      <SessionRail
        workspace={workspaceModelFixture({ title: "rail-workspace" })}
        sessions={[{ id: "1", label: "bash", agent: "terminal" }]}
        activeSessionId="1"
        livePorts={[]}
        previewLinks={[]}
        onSelectSession={() => undefined}
        onCloseSession={() => undefined}
        onSpawnSession={() => undefined}
        onOpenPreview={() => undefined}
        onOpenPreviewLink={() => undefined}
        onOpenMembers={() => undefined}
        onOpenDetails={() => undefined}
        onOpenMachine={() => undefined}
        {...overrides}
      />,
    );
  }

  it("says why the sessions are missing, beside the rail it fell back to", async () => {
    const onOpenMachine = vi.fn();
    const view = await railWith({ sessionsNeedNewerMachine: true, onOpenMachine });
    const notice = view.container.querySelector(".rail-notice");
    expect(notice?.textContent).toContain("Sessions need a newer machine");
    // The whole flag-off rail is still there: this is one line above it, not a
    // screen instead of it.
    expect(view.container.querySelector('button[aria-label="New tab"]')).not.toBeNull();
    expect(view.container.querySelectorAll(".session-list .shell-s")).toHaveLength(1);

    const action = notice?.querySelector<HTMLButtonElement>(".rail-notice__a");
    expect(action?.textContent).toBe("Recreate this workspace's machine to enable sessions");
    await act(async () => action?.click());
    // The dialog with the Recreate button in it, opened by the wire the rail
    // head already held.
    expect(onOpenMachine).toHaveBeenCalledWith("workspace-one");
    await view.unmount();
  });

  it("says the member has no machine here, and who provisions one", async () => {
    const onOpenMachine = vi.fn();
    const view = await railWith({ sessionsNeedMachine: true, onOpenMachine });
    const notice = view.container.querySelector(".rail-notice");
    expect(notice?.textContent).toContain("You have no machine in this workspace");
    // Not the old-image sentence: there is nothing here to recreate.
    expect(notice?.textContent).not.toContain("Recreate");
    // The same flag-off rail underneath, for the same reason.
    expect(view.container.querySelector('button[aria-label="New tab"]')).not.toBeNull();

    const action = notice?.querySelector<HTMLButtonElement>(".rail-notice__a");
    expect(action?.textContent).toBe("Open My machine to provision one");
    await act(async () => action?.click());
    // "My machine" is where Provision is, and it is the dialog that tells a
    // non-admin whom to ask.
    expect(onOpenMachine).toHaveBeenCalledWith("workspace-one");
    await view.unmount();
  });

  it("tells a member who cannot open the dialog whom to ask instead", async () => {
    const view = await railWith({
      workspace: workspaceModelFixture({ title: "rail-workspace", canControl: false }),
      sessionsNeedMachine: true,
    });
    const notice = view.container.querySelector(".rail-notice");
    expect(notice?.querySelector(".rail-notice__a")).toBeNull();
    expect(notice?.querySelector(".rail-notice__d")?.textContent).toBe(
      "Ask a workspace admin to provision one for you",
    );
    await view.unmount();
  });

  it("is absent on every box that serves sessions", async () => {
    const view = await railWith({});
    expect(view.container.querySelector(".rail-notice")).toBeNull();
    await view.unmount();
  });
});
