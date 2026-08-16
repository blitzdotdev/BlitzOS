import type { WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudApp from "../src/CloudApp.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { standaloneResolver } from "../src/resolver.js";
import { render, settle } from "./dom.js";

const createClientSpy = vi.hoisted(() => vi.fn());
const webAppHarness = vi.hoisted(() => ({
  mounts: vi.fn(),
  nextMountId: 0,
  unmounts: vi.fn(),
}));

vi.mock("webdav", async () => {
  const actual = await vi.importActual<typeof import("webdav")>("webdav");
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      createClientSpy(...args);
      return actual.createClient(...args);
    },
  };
});

vi.mock("../src/TtydTerminal.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    TERMINAL_SUBMIT_EVENT: "blitz:terminal-submit",
    TtydTerminal: ({ active, sessionKey, sessionType }: {
      active?: boolean;
      sessionKey: string;
      sessionType: string;
    }) => {
      const [mountId] = React.useState(() => `terminal-${++webAppHarness.nextMountId}`);
      React.useEffect(() => {
        webAppHarness.mounts("terminal", mountId);
        return () => webAppHarness.unmounts("terminal", mountId);
      }, [mountId]);
      return (
        <div
          data-testid="terminal-session"
          data-active={String(active)}
          data-mount-id={mountId}
          data-session-key={sessionKey}
        >{sessionType}</div>
      );
    },
  };
});

vi.mock("../src/chat/ChatPanel.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatPanel: ({ initialSessionId }: { initialSessionId: string | null }) => {
      const [mountId] = React.useState(() => `chat-${++webAppHarness.nextMountId}`);
      React.useEffect(() => {
        webAppHarness.mounts("chat", mountId);
        return () => webAppHarness.unmounts("chat", mountId);
      }, [mountId]);
      return (
        <div
          data-testid="chat-session"
          data-initial-session-id={initialSessionId ?? ""}
          data-mount-id={mountId}
        />
      );
    },
  };
});

const creating: WorkspaceView = {
  id: "workspace-one",
  machineTypeId: "cx23@fsn1",
  phase: "creating",
  retryAction: "poll",
  canObserve: false,
  launchable: false,
  revision: 1,
  ssh: null,
  volumeId: null,
  error: null,
};

const running: WorkspaceView = {
  id: "workspace-running",
  machineTypeId: "cx23@fsn1",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 2,
  ssh: {
    host: "box.example.test",
    port: 2222,
    user: "blitz",
    hostPublicKey: null,
  },
  volumeId: null,
  error: null,
};

const runningTwo: WorkspaceView = {
  ...running,
  id: "workspace-two",
  ssh: {
    ...running.ssh!,
    host: "box-two.example.test",
  },
};

let storageValues: Map<string, string>;

function client(): ControlPlaneClient {
  return {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    poll: vi.fn()
      .mockRejectedValueOnce(new ApiRequestError("unauthorized", 401, null))
      .mockResolvedValue({ workspaces: [creating] }),
    create: vi.fn(async () => ({ workspace: creating })),
    destroy: vi.fn(async () => ({ workspace: creating })),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [], failures: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listIntegrations: vi.fn(async () => ({ integrations: [] })),
    putIntegration: vi.fn(async () => undefined),
    deleteIntegration: vi.fn(async () => undefined),
    listLeases: vi.fn(async () => ({ leases: [] })),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
  };
}

function runningClient(): ControlPlaneClient {
  return {
    ...client(),
    poll: vi.fn(async () => ({ workspaces: [running] })),
  };
}

function saveTabs(
  workspaceId: string,
  tabs: Array<Record<string, unknown>>,
  activeId: number,
): void {
  storageValues.set(`personal:personal:blitz-webapp-tabs-v1:${workspaceId}`, JSON.stringify({
    version: 1,
    tabs,
    activeId,
    nextId: Math.max(...tabs.map((tab) => Number(tab.id))) + 1,
  }));
}

beforeEach(() => {
  createClientSpy.mockClear();
  webAppHarness.mounts.mockClear();
  webAppHarness.nextMountId = 0;
  webAppHarness.unmounts.mockClear();
  window.history.replaceState({}, "", "/");
  storageValues = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", {
    headers: { "content-type": "text/html" },
  })));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("webapp shell smoke", () => {
  it("renders operator login, then the v2 rail after adapter me and workspaces load", async () => {
    const wire = client();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();

    expect(view.container.querySelector('input[name="operatorKey"]')).not.toBeNull();
    const input = view.container.querySelector<HTMLInputElement>('input[name="operatorKey"]')!;
    input.value = "operator-secret";
    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    await settle();
    await settle();

    expect(wire.login).toHaveBeenCalledWith("operator-secret");
    expect(view.container.querySelector(".webapp-rail")?.textContent).toContain("workspace-one");
    expect(view.container.textContent).toContain("Personal");
    await view.unmount();
  });

  it("opens a workspace with terminal tabs enabled through control-plane surfaces", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    storageValues.set("personal:personal:blitz-webapp-files-v1:workspace-running", JSON.stringify({
      version: 1,
      open: false,
      width: 264,
      expanded: [],
      segment: "files",
    }));
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const sessionTabs = [...view.container.querySelectorAll<HTMLButtonElement>(
      '.webapp-tab-cell [role="tab"]',
    )];
    expect(sessionTabs).toHaveLength(1);
    expect(sessionTabs[0]?.textContent).toContain("Terminal");
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')?.disabled)
      .toBe(false);
    expect(view.container.querySelector('[aria-label="Loading workspace"]')).toBeNull();
    expect(JSON.parse(
      storageValues.get("personal:personal:blitz-webapp-tabs-v1:workspace-running") ?? "null",
    )).toEqual({
      version: 1,
      tabs: [{ id: 1, type: "terminal" }],
      activeId: 1,
      nextId: 2,
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/chat/layout")))
      .toBe(false);

    await view.unmount();
  });

  it("routes non-microVM workspace files through the control plane", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver(
          { acp: 7444, files: 7445 },
          "https://cp.example.test",
        )}
      />,
    );
    await settle();
    await settle();

    expect(createClientSpy).toHaveBeenCalledWith(
      "https://cp.example.test/workspaces/workspace-running/webapp/7445/workspace/",
      { withCredentials: true },
    );
    await view.unmount();
  });

  it("shows a control-plane preview tab on mobile", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    storageValues.set("personal:personal:blitz-webapp-tabs-v1:workspace-running", JSON.stringify({
      version: 1,
      tabs: [
        { id: 1, type: "terminal" },
        { id: 2, type: "preview", port: 3000 },
      ],
      activeId: 2,
      nextId: 3,
    }));
    storageValues.set("personal:personal:blitz-webapp-files-v1:workspace-running", JSON.stringify({
      version: 1,
      open: false,
      width: 264,
      expanded: [],
      segment: "files",
    }));

    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const activeTab = view.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    expect(activeTab?.textContent).toBe(":3000");
    expect(activeTab?.closest<HTMLElement>(".webapp-tab-cell")?.dataset.sessionId).toBe("2");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/chat/layout")))
      .toBe(false);

    await view.unmount();
  });

  it("retains visited terminal and chat panes while hiding inactive panes", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "terminal" },
      { id: 2, type: "chat", chatProvider: "claude", chatSessionId: "chat-two" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const terminal = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]')!;
    expect(view.container.querySelector('[data-testid="chat-session"]')).toBeNull();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    const chat = view.container.querySelector<HTMLElement>('[data-testid="chat-session"]')!;
    expect(chat.dataset.initialSessionId).toBe("chat-two");
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(true);
    expect(chat.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(false);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());
    expect(view.container.querySelector('[data-testid="terminal-session"]')).toBe(terminal);
    expect(view.container.querySelector('[data-testid="chat-session"]')).toBe(chat);
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(false);
    expect(chat.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(true);
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it("reuses retained terminal instances and unmounts a visited tab when closed", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "terminal" },
      { id: 2, type: "claude" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const first = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )!;
    const firstMountId = first.dataset.mountId;
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());

    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )).toBe(first);
    expect(first.dataset.mountId).toBe(firstMountId);
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close Terminal"]',
    )?.click());
    expect(first.isConnected).toBe(false);
    expect(webAppHarness.unmounts).toHaveBeenCalledWith("terminal", firstMountId);
    expect(view.container.querySelectorAll('[data-testid="terminal-session"]')).toHaveLength(1);

    await view.unmount();
  });

  it("tears down retained panes when switching workspaces", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    saveTabs("workspace-two", [{ id: 1, type: "terminal" }], 1);
    const wire = {
      ...client(),
      poll: vi.fn(async () => ({ workspaces: [running, runningTwo] })),
    };
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const first = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]')!;
    const firstMountId = first.dataset.mountId;
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-workspace[data-workspace-id="workspace-two"] .webapp-workspace-button',
    )?.click());
    await settle();

    const second = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]')!;
    expect(first.isConnected).toBe(false);
    expect(second).not.toBe(first);
    expect(webAppHarness.unmounts).toHaveBeenCalledWith("terminal", firstMountId);
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);

    await view.unmount();
  });
});
