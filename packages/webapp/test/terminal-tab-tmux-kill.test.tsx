/**
 * A CLOSED TERMINAL TAB ENDS ITS TMUX SESSION (QA sweep TABS-1).
 *
 * Closing a terminal tab deleted a row in `webapp_state` and left `term-<id>`
 * running on the box: 20 s after the close `tmux ls` still listed it, and the
 * shell or agent inside it kept its memory. `plans/LODY-TERMINAL-TABS.md` §4.3
 * recorded that as the intended behaviour; the ruling reversed it.
 *
 * The line the fix must not cross is in §4.4: the session outlives its
 * websocket ON PURPOSE, which is what makes a reload, a workspace switch and a
 * lost tunnel re-attach to the scrollback the member left. So the close is the
 * only caller of the kill door, and an unmount is never one.
 *
 * The harness is the shell harness of `lody-terminal-tab-wave3.test.tsx`, cut
 * down to what these cases need: a real `CloudApp` with the flag on and the
 * 3.5 MB surface mocked to a prop recorder, which is the only way to reach the
 * strip's own `onClose` in CI.
 */
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../src/api.js";
import type { WorkspaceTab } from "../src/storage.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

installLodyDomStubs();

// A shell case is a real `CloudApp` mount behind a workspace poll, a
// capability probe and a persistence round trip; under jsdom that is seconds.
vi.setConfig({ testTimeout: 60_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
});

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

/** Answers the handful of calls the shell makes on mount and refuses the rest
 * by name, so a method that starts to matter fails loudly. */
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

interface SurfaceRecord {
  surfaceTabs: import("../src/lody/surface-tabs.js").SurfaceTabsBinding | undefined;
}

/** One request the shell sent to a box door, as this suite reads them. */
interface BoxRequest {
  url: string;
  method: string;
  body: string;
}

const TERMINAL_TABS: WorkspaceTab[] = [
  { id: 7, type: "terminal" },
  { id: 9, type: "claude" },
  { id: 11, type: "file", filePath: "README.md" },
];

async function mountShell(options: { path: string; state?: Map<string, unknown> }) {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const requests: BoxRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url.endsWith("/terminal/kill")) return new Response(null, { status: 204 });
      if (url.includes("/connections-focus")) {
        return new Response(JSON.stringify({ focus: null }), { status: 200 });
      }
      return new Response(CATALOG, { status: 200 });
    }),
  );
  vi.doMock("../src/TtydTerminal.js", () => ({
    TERMINAL_SUBMIT_EVENT: "blitz:terminal-submit",
    TtydTerminal: () => null,
  }));
  const surface: SurfaceRecord = { surfaceTabs: undefined };
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (props: {
      rail?: { newTabControl?: ReactNode };
      surfaceTabs?: SurfaceRecord["surfaceTabs"];
    }) => {
      surface.surfaceTabs = props.surfaceTabs;
      return <div data-testid="lody-surface">{props.rail?.newTabControl}</div>;
    },
  }));

  const { default: CloudApp } = await import("../src/CloudApp.js");
  const { standaloneResolver } = await import("../src/resolver.js");
  const { defaultWorkspaceFiles, defaultWorkspaceWebAppState } = await import("../src/storage.js");
  const state = options.state ?? new Map<string, unknown>();
  if (!state.has("ws-1")) {
    state.set("ws-1", {
      ...defaultWorkspaceWebAppState(),
      tabs: { version: 1, tabs: TERMINAL_TABS, activeId: 7, nextId: 12 },
      drawer: defaultWorkspaceFiles(),
    });
  }
  window.history.replaceState({}, "", options.path);
  const view = await render(
    <CloudApp client={shellClient(state)} resolver={standaloneResolver({ files: 7445 })} />,
  );
  // Two settles for the workspace poll and the capability probe it enables,
  // and a third for the render that follows.
  await settle();
  await settle();
  await settle();
  return { view, surface, state, requests };
}

const killRequests = (requests: BoxRequest[]): BoxRequest[] =>
  requests.filter(({ url }) => url.endsWith("/terminal/kill"));

/** The persistence write is debounced 150 ms. */
async function flushPersistence(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await settle();
}

describe("TABS-1 — a closed terminal tab ends its tmux session", () => {
  it("asks the box to end the session the closed tab was attached to", async () => {
    const mounted = await mountShell({ path: "/workspaces/ws-1/chat/terminal/7" });
    await act(async () => {
      mounted.surface.surfaceTabs?.onClose("blitz-tab:7");
    });
    await settle();

    const kills = killRequests(mounted.requests);
    expect(kills).toHaveLength(1);
    // The type and the key are what `blitz-term` turns back into `term-7` —
    // the same pair `/terminal/ws` carries, so both name one tmux session.
    expect(kills[0]?.method).toBe("POST");
    expect(JSON.parse(kills[0]?.body ?? "{}")).toEqual({ type: "terminal", key: "7" });
    // A sibling gateway door, addressed off the files base the resolver
    // already hands out.
    expect(kills[0]?.url.endsWith("/webapp/7445/terminal/kill")).toBe(true);

    // And the close still happened: the kill is not a substitute for it.
    await flushPersistence();
    const persisted = mounted.state.get("ws-1") as { tabs: { tabs: WorkspaceTab[] } };
    expect(persisted.tabs.tabs.map(({ id }) => id)).toEqual([9, 11]);
    await mounted.view.unmount();
  });

  it("ends only the closed tab's session, whatever kind it is", async () => {
    const mounted = await mountShell({ path: "/workspaces/ws-1/chat/terminal/9" });
    await act(async () => {
      mounted.surface.surfaceTabs?.onClose("blitz-tab:9");
    });
    await settle();
    expect(JSON.parse(killRequests(mounted.requests)[0]?.body ?? "{}"))
      .toEqual({ type: "claude", key: "9" });
    await mounted.view.unmount();
  });

  it("asks for nothing when the closed tab has no session behind it", async () => {
    // A file tab is a viewer over dufs. There is no `file-11` to end.
    const mounted = await mountShell({ path: "/workspaces/ws-1/chat/terminal/11" });
    await act(async () => {
      mounted.surface.surfaceTabs?.onClose("blitz-tab:11");
    });
    await settle();
    expect(killRequests(mounted.requests)).toEqual([]);
    await mounted.view.unmount();
  });

  it("leaves the session running across a reload", async () => {
    // THE HALF THAT MUST NOT REGRESS. A reload tears the whole tree down and
    // builds it again from the same persisted document. Every terminal
    // unmounts, every websocket closes, and not one session may end: the
    // member comes back to the scrollback they left.
    const state = new Map<string, unknown>();
    const first = await mountShell({ path: "/workspaces/ws-1/chat/terminal/7", state });
    await first.view.unmount();
    await settle();
    expect(killRequests(first.requests)).toEqual([]);

    const second = await mountShell({ path: "/workspaces/ws-1/chat/terminal/7", state });
    expect(killRequests(second.requests)).toEqual([]);
    // The tab list survived the reload, which is what there is to re-attach to.
    expect(second.surface.surfaceTabs?.tabs.map(({ id }) => id))
      .toEqual(["blitz-tab:7", "blitz-tab:9", "blitz-tab:11"]);
    await second.view.unmount();
  });

  it("leaves the session running when the address moves off the tab", async () => {
    // A navigation selects another tab, or leaves the strip for the panes.
    // Neither is a close.
    const mounted = await mountShell({ path: "/workspaces/ws-1/chat/terminal/7" });
    await act(async () => {
      mounted.surface.surfaceTabs?.onSelect("blitz-tab:9");
    });
    await settle();
    expect(killRequests(mounted.requests)).toEqual([]);
    await mounted.view.unmount();
    expect(killRequests(mounted.requests)).toEqual([]);
  });
});
