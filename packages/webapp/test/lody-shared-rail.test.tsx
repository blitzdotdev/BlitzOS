/**
 * The grantee's half of the rail, without a box
 * (plans/LODY-SHARING.md §8 steps 3 and 4, §10.2).
 *
 * Three claims, none of which needs a daemon:
 *
 * 1. `useSharedSessions` turns the control plane's `received` list into rows,
 *    and draws them BEFORE any box has answered — a grant that exists is a row
 *    whether or not the owner's machine is awake.
 * 2. It titles those rows from the owner's box, over the projected `meta` room,
 *    and survives a box that answers nothing.
 * 3. Clicking one is an ADDRESS, and the address decides which box the second
 *    surface is mounted against and at what level.
 *
 * The rail's own markup is exercised through `SharedSessionRows` inside
 * `SessionRailSidebar`, which is daemon-gated, so what is asserted here is the
 * data and the navigation. The row is three spans and a click handler; the
 * thing that could be wrong is which grant it names.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListSessionSharesResponse, WorkspaceView } from "@blitzos/schema";
import type { AppRoute } from "../src/sessions-page-state.js";
import type { LodyRailSessions, LodyRailState } from "../src/lody/use-lody-rail.js";
import type { SharedSessionsState } from "../src/lody/use-shared-sessions.js";
import { render, settle } from "./dom.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

// SAFETY: the hook reads `id` and `members`; the resolver reads `id`. Stating
// every other field of a `WorkspaceView` would say nothing about this test and
// would have to be restated at every schema change.
const workspace = {
  id: "ws-1",
  members: [
    { membershipId: "mem-owner", name: "Ada", avatarUrl: null, role: "editor", machine: null },
    { membershipId: "mem-me", name: "Me", avatarUrl: null, role: "editor", machine: null },
  ],
} as unknown as WorkspaceView;

const RECEIVED: ListSessionSharesResponse = {
  granted: [],
  received: [
    {
      id: "share-1",
      sessionId: "sess-alpha",
      ownerMembershipId: "mem-owner",
      granteeMembershipId: "mem-me",
      level: "ro",
      createdAt: 1,
      createdByMembershipId: "mem-owner",
    },
    {
      id: "share-2",
      sessionId: "sess-beta",
      ownerMembershipId: "mem-owner",
      granteeMembershipId: "mem-me",
      level: "rw",
      createdAt: 2,
      createdByMembershipId: "mem-owner",
    },
  ],
};

/** A `/lody/platform` answer and one `meta` room, standing in for a box. */
/** The box answered `/lody/platform`, which is every case below: what is under
 * test here is not the pre-Lody fallback (`lody-old-box-fallback.test.tsx`). */
const SESSIONS_PRESENT = {
  capability: "present",
  surfaceHostsTabs: true,
} satisfies LodyRailSessions;

function stubOwnerBox(titles: Record<string, string> | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        // The narrowed catalog a shared `/lody/platform` request receives
        // (`fixtures/lody-share-claim/catalog-shared.json`).
        JSON.stringify({
          identity: { userId: "local:owner" },
          workspaces: [
            {
              workspaceId: "lw_owner",
              name: "Lody",
              slug: "lody",
              role: "owner",
              state: "active",
            },
          ],
          machine: { machineId: "machine-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  class StubSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {
      setTimeout(() => {
        this.onopen?.();
        if (titles === null) {
          // A box that refuses the room settles the read instead of hanging it.
          this.onmessage?.({ data: JSON.stringify({ type: "error", code: "room_forbidden" }) });
          return;
        }
        this.onmessage?.({
          data: JSON.stringify({
            type: "joined",
            room: { scope: "meta" },
            payload: {
              kind: "flock-json",
              bundle: {
                version: 1,
                entries: Object.fromEntries(
                  Object.entries(titles).map(([sessionId, title]) => [
                    `["m","session-${sessionId}","title"]`,
                    { c: "1,0,peer", d: title },
                  ]),
                ),
              },
            },
          }),
        });
      }, 0);
    }
    send(frame: string): void {
      this.sent.push(frame);
    }
    close(): void {
      /* the read is one frame long */
    }
  }
  vi.stubGlobal("WebSocket", StubSocket);
}

interface Mounted {
  rail: LodyRailState | null;
  shared: SharedSessionsState | null;
  route: AppRoute | null;
}

async function mount(options: {
  path: string;
  listSessionShares?: () => Promise<ListSessionSharesResponse>;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const { useLodyRail } = await import("../src/lody/use-lody-rail.js");
  const { useSharedSessions } = await import("../src/lody/use-shared-sessions.js");
  const { parseAppRoute } = await import("../src/sessions-page-state.js");
  const { standaloneResolver } = await import("../src/resolver.js");
  window.history.replaceState({}, "", options.path);
  const resolver = standaloneResolver({ files: 7445 }, "https://cp.example");
  const client = {
    listSessionShares:
      options.listSessionShares ?? (async () => RECEIVED),
  };
  const seen: Mounted = { rail: null, shared: null, route: null };

  function Host() {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
    const rail = useLodyRail(route, setRoute, route.workspaceId ?? "", true, SESSIONS_PRESENT);
    const shared = useSharedSessions({ client, workspace, resolver, chat: rail.chat });
    seen.rail = rail;
    seen.shared = shared;
    seen.route = route;
    return null;
  }

  const view = await render(<Host />);
  // Four turns: the grants fetch, the owner's `/lody/platform` read, the meta
  // frame, and the render that carries the titles. Each is a resolved promise
  // rather than a timer, so this is ordering and not a wait.
  for (let turn = 0; turn < 4; turn += 1) await settle();
  return { seen, view };
}

describe("the rail's shared sessions", () => {
  it("draws a row per received grant before any box answers", async () => {
    stubOwnerBox(null);
    const { seen, view } = await mount({ path: "/workspaces/ws-1/chat" });
    expect(seen.shared?.rows.map((row) => [row.sessionId, row.level, row.ownerName])).toEqual([
      ["sess-alpha", "ro", "Ada"],
      ["sess-beta", "rw", "Ada"],
    ]);
    // No title, and no error: the box said nothing and the rows still exist.
    expect(seen.shared?.rows.every((row) => row.title === null)).toBe(true);
    await view.unmount();
  });

  it("titles them from the owner's projected meta room", async () => {
    stubOwnerBox({ "sess-alpha": "the granted session", "sess-beta": "the co-driven one" });
    const { seen, view } = await mount({ path: "/workspaces/ws-1/chat" });
    expect(seen.shared?.rows.map((row) => row.title)).toEqual([
      "the granted session",
      "the co-driven one",
    ]);
    await view.unmount();
  });

  it("has no rows and dials nothing when the control plane refuses", async () => {
    stubOwnerBox({ "sess-alpha": "never read" });
    const { seen, view } = await mount({
      path: "/workspaces/ws-1/chat",
      listSessionShares: async () => {
        throw new Error("403");
      },
    });
    expect(seen.shared?.rows).toEqual([]);
    expect(seen.shared?.open).toBe(null);
    await view.unmount();
  });

  it("opens one against the owner's box, at the level the grant says", async () => {
    stubOwnerBox({ "sess-beta": "the co-driven one" });
    const { seen, view } = await mount({ path: "/workspaces/ws-1/chat" });
    seen.rail?.openSharedSession("mem-owner", "sess-beta");
    await settle();
    expect(window.location.pathname).toBe("/workspaces/ws-1/chat/shared/mem-owner/sess-beta");
    expect(seen.shared?.open).toEqual({
      ownerMembershipId: "mem-owner",
      sessionId: "sess-beta",
      level: "rw",
      endpoints: expect.objectContaining({
        lodySyncUrl: "wss://cp.example/workspaces/ws-1/shared/mem-owner/webapp/7445/lody/sync",
      }),
    });
    // The grantee's OWN surface keeps no session address while somebody else's
    // is open: it is a different runtime against a different box, and the two
    // must not be told to show the same id.
    expect(seen.rail?.sessionId).toBe(null);
    await view.unmount();
  });

  it("mounts nothing for an address no grant backs", async () => {
    stubOwnerBox({});
    const { seen, view } = await mount({
      path: "/workspaces/ws-1/chat/shared/mem-owner/sess-revoked",
    });
    expect(seen.route).toMatchObject({
      chat: { sessionId: "sess-revoked", sharedFrom: "mem-owner" },
    });
    // A deep link to a revoked grant dials no box. The alternative is a ticket
    // mint the control plane answers 403 to, and a blank surface either way.
    expect(seen.shared?.open).toBe(null);
    await view.unmount();
  });

  it("reads a read-only grant as read-only, which is what suppresses the composer", async () => {
    stubOwnerBox({});
    const { seen, view } = await mount({
      path: "/workspaces/ws-1/chat/shared/mem-owner/sess-alpha",
    });
    expect(seen.shared?.open?.level).toBe("ro");
    await view.unmount();
  });
});

/**
 * A grantee's surface gets NO host tabs (plans/LODY-TERMINAL-TABS.md §5.1).
 *
 * A terminal is an arbitrary shell on the OWNER's box, and no share level in
 * `plans/LODY-SESSIONS.md` §0.1 grants that — the same reason the bridge
 * refuses `/control` outright and narrows `/platform` to three fields. There is
 * no gateway path, no bridge door and no ACL to write, because there is nothing
 * to permit. So the binding is withheld at the region, before the surface that
 * would draw it is even chosen.
 */
async function mountRegion(sharedOpen: unknown | null) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const props: { surfaceTabs?: unknown }[] = [];
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (received: { surfaceTabs?: unknown }) => {
      props.push(received);
      return null;
    },
  }));
  const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");
  const endpoints = {
    terminalUrl: "https://box.invalid/webapp/7681/",
    filesBase: "https://box.invalid/webapp/5000/",
    lodySyncUrl: "wss://box.invalid/webapp/7445/lody/sync",
    lodyRpcUrl: "https://box.invalid/webapp/7445/lody/rpc",
    lodyControlUrl: "https://box.invalid/webapp/7445/lody/control",
    lodyProjectUrl: "https://box.invalid/webapp/7445/lody/project",
    lodyPlatformUrl: "https://box.invalid/webapp/7445/lody/platform",
  };
  const surfaceTabs = {
    tabs: [{ id: "blitz-tab:7", label: "claude", content: null }],
    activeTabId: null,
    onSelect: () => undefined,
    onClose: () => undefined,
  };
  const view = await render(
    // SAFETY: the region's own props are fully stated; `sharedOpen` and the
    // endpoints are the two shapes this test varies, and the surface below is
    // a mock that only records what it was handed.
    <LodySessionsRegion
      endpoints={endpoints as never}
      sessions="present"
      viewerName="Me"
      viewerAvatarUrl={null}
      workspaceTitle="Workspace"
      visible
      railHost={null}
      terminals={[]}
      activeTerminalId=""
      onSelectTerminal={() => undefined}
      surfaceTabs={surfaceTabs as never}
      sharedOpen={sharedOpen as never}
    />,
  );
  await settle();
  return { props, view };
}

describe("host tabs and a shared surface", () => {
  it("hands the binding to the member's OWN surface", async () => {
    const { props, view } = await mountRegion(null);
    expect(props.at(-1)?.surfaceTabs).toBeDefined();
    await view.unmount();
  });

  it("hands it to no surface mounted against another member's box", async () => {
    const { props, view } = await mountRegion({
      ownerMembershipId: "mem-owner",
      sessionId: "sess-beta",
      level: "rw",
      endpoints: {
        terminalUrl: "https://owner.invalid/webapp/7681/",
        filesBase: "https://owner.invalid/webapp/5000/",
        lodySyncUrl: "wss://owner.invalid/webapp/7445/lody/sync",
        lodyRpcUrl: "https://owner.invalid/webapp/7445/lody/rpc",
        lodyControlUrl: "https://owner.invalid/webapp/7445/lody/control",
        lodyProjectUrl: "https://owner.invalid/webapp/7445/lody/project",
        lodyPlatformUrl: "https://owner.invalid/webapp/7445/lody/platform",
      },
    });
    expect(props.at(-1)?.surfaceTabs).toBeUndefined();
    await view.unmount();
  });
});
