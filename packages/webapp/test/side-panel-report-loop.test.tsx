/**
 * Pins the CloudApp half of the side-panel report loop fix.
 *
 * Keep this separate: the precise mechanism remains undetermined, but adding
 * its required render counter to wave3's shared SessionSurface mock makes the
 * mixed shell/rail sequence leave F7's route state stale.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../src/api.js";
import type { SidePanelBinding } from "../src/lody/side-panel.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

installLodyDomStubs();

vi.setConfig({ testTimeout: 60_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

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
  // SAFETY: The Proxy answers every method this mount reaches and rejects the
  // rest by name instead of returning an invalid shape.
  return client as ControlPlaneClient;
}

interface SurfaceRecord {
  renderCount: number;
  sidePanel: SidePanelBinding | undefined;
}

async function mountShell() {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/connections-focus")) {
        return new Response(JSON.stringify({ focus: null }), { status: 200 });
      }
      if (String(input).includes("/preview-focus")) {
        return new Response(JSON.stringify({ focus: null }), { status: 200 });
      }
      return new Response(CATALOG, { status: 200 });
    }),
  );
  vi.doMock("../src/TtydTerminal.js", () => ({
    TERMINAL_SUBMIT_EVENT: "blitz:terminal-submit",
    TtydTerminal: () => null,
  }));
  const surface: SurfaceRecord = { renderCount: 0, sidePanel: undefined };
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (host: {
      surfaces: Array<{ active?: boolean; sidePanel?: SidePanelBinding }>;
    }) => {
      const current = host.surfaces.find((candidate) => candidate.active === true);
      surface.renderCount += 1;
      surface.sidePanel = current?.sidePanel;
      return <div data-testid="lody-surface" />;
    },
  }));

  const { default: CloudApp } = await import("../src/CloudApp.js");
  const { standaloneResolver } = await import("../src/resolver.js");
  const { defaultWorkspaceFiles, defaultWorkspaceWebAppState } = await import(
    "../src/storage.js"
  );
  const state = new Map<string, unknown>();
  state.set("ws-1", {
    ...defaultWorkspaceWebAppState(),
    tabs: {
      version: 1,
      tabs: [{ id: 7, type: "terminal" }],
      activeId: 7,
      nextId: 8,
    },
    drawer: defaultWorkspaceFiles(),
  });
  window.history.replaceState({}, "", "/workspaces/ws-1/chat/terminal/7");
  const view = await render(
    <CloudApp client={shellClient(state)} resolver={standaloneResolver({ files: 7445 })} />,
  );
  await settle();
  await settle();
  await settle();
  return { view, surface };
}

describe("the side-panel report does not rebuild its shell inputs", () => {
  it("keeps host tabs stable and ignores an equal second report", async () => {
    const mounted = await mountShell();
    const binding = mounted.surface.sidePanel;
    expect(binding).toBeDefined();
    if (binding === undefined) throw new Error("the surface has no side-panel binding");
    const hostTabs = binding.hostTabs;
    // One host tab. Connections was the second and is a tab of the
    // workspace-details dialog now, so nothing about it reaches this binding.
    expect(hostTabs.map((tab) => tab.id)).toEqual(["host:browser"]);
    const renderCountBeforeReport = mounted.surface.renderCount;
    const report = {
      open: true,
      activeTabId: "files",
      openedTabIds: ["files"],
      availableOptions: [{ id: "files", disabled: false }],
    };

    await act(async () => {
      binding.onStateChange(report);
    });

    expect(mounted.surface.renderCount).toBe(renderCountBeforeReport + 1);
    expect(mounted.surface.sidePanel?.hostTabs === hostTabs).toBe(true);
    expect(mounted.surface.sidePanel === binding).toBe(true);
    const renderCountAfterReport = mounted.surface.renderCount;

    await act(async () => {
      binding.onStateChange({
        ...report,
        openedTabIds: [...report.openedTabIds],
        availableOptions: report.availableOptions.map((option) => ({ ...option })),
      });
    });

    expect(mounted.surface.renderCount).toBe(renderCountAfterReport);

    await act(async () => {
      binding.onStateChange({ ...report, open: false });
    });

    expect(mounted.surface.renderCount).toBe(renderCountAfterReport + 1);
    await mounted.view.unmount();
  });
});
