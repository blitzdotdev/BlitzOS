import type { WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudApp from "../src/CloudApp.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { standaloneResolver } from "../src/resolver.js";
import { render, settle } from "./dom.js";

const createClientSpy = vi.hoisted(() => vi.fn());

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

vi.mock("../src/TtydTerminal.js", () => ({
  TERMINAL_SUBMIT_EVENT: "blitz:terminal-submit",
  TtydTerminal: ({ sessionType }: { sessionType: string }) => (
    <div data-testid="terminal-session">{sessionType}</div>
  ),
}));

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

let storageValues: Map<string, string>;
let writeClipboard: ReturnType<typeof vi.fn>;

function client(): ControlPlaneClient {
  return {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    poll: vi.fn()
      .mockRejectedValueOnce(new ApiRequestError("unauthorized", 401, null))
      .mockResolvedValue({ workspaces: [creating] }),
    create: vi.fn(async () => ({ workspace: creating })),
    destroy: vi.fn(async () => ({ workspace: creating })),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [] })),
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

beforeEach(() => {
  createClientSpy.mockClear();
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
  writeClipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeClipboard },
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

describe("cockpit shell smoke", () => {
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
    expect(view.container.querySelector(".cockpit-rail")?.textContent).toContain("workspace-one");
    expect(view.container.textContent).toContain("Personal");
    await view.unmount();
  });

  it("opens a workspace with local terminal tabs enabled and shows the SSH forward hint", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    storageValues.set("personal:personal:blitz-cockpit-files-v1:workspace-running", JSON.stringify({
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
      '.cockpit-tab-cell [role="tab"]',
    )];
    expect(sessionTabs).toHaveLength(1);
    expect(sessionTabs[0]?.textContent).toContain("Terminal");
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')?.disabled)
      .toBe(false);
    expect(view.container.querySelector('[aria-label="Loading workspace"]')).toBeNull();
    expect(JSON.parse(
      storageValues.get("personal:personal:blitz-cockpit-tabs-v1:workspace-running") ?? "null",
    )).toEqual({
      version: 1,
      tabs: [{ id: 1, type: "terminal" }],
      activeId: 1,
      nextId: 2,
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/chat/layout")))
      .toBe(false);

    const forwardCommand = "ssh -L 7445:localhost:7445 -L 7444:localhost:7444 -N blitz@box.example.test -p 2222";
    const copyForward = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === forwardCommand);
    expect(copyForward).toBeDefined();
    await act(async () => copyForward?.click());
    expect(writeClipboard).toHaveBeenCalledWith(forwardCommand);

    await view.unmount();
  });

  it("hides the SSH forward hint for a microVM workspace", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const microvm = { ...running, machineTypeId: "mv-2c2g@lab" };
    const wire = { ...runningClient(), poll: vi.fn(async () => ({ workspaces: [microvm] })) };
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver(
          { acp: 7444, files: 7445 },
          "https://cp.example.test",
        )}
      />,
    );
    await settle();
    await settle();

    expect(view.container.textContent).not.toContain("ssh -L 7445:");
    expect(view.container.querySelector('[title="Copy SSH forward command"]')).toBeNull();
    expect(createClientSpy).toHaveBeenCalledWith(
      "https://cp.example.test/workspaces/workspace-running/surface/7445/workspace/",
      { withCredentials: true },
    );
    await view.unmount();
  });

  it("shows and copies the full SSH forward command on mobile with a local preview tab active", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    storageValues.set("personal:personal:blitz-cockpit-tabs-v1:workspace-running", JSON.stringify({
      version: 1,
      tabs: [
        { id: 1, type: "terminal" },
        { id: 2, type: "preview", port: 3000 },
      ],
      activeId: 2,
      nextId: 3,
    }));
    storageValues.set("personal:personal:blitz-cockpit-files-v1:workspace-running", JSON.stringify({
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
    expect(activeTab?.closest<HTMLElement>(".cockpit-tab-cell")?.dataset.sessionId).toBe("2");
    const forwardCommand = "ssh -L 7445:localhost:7445 -L 7444:localhost:7444 -N blitz@box.example.test -p 2222";
    const copyForward = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === forwardCommand);
    expect(copyForward).toBeDefined();
    await act(async () => copyForward?.click());
    expect(writeClipboard).toHaveBeenCalledWith(forwardCommand);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/chat/layout")))
      .toBe(false);

    await view.unmount();
  });
});
