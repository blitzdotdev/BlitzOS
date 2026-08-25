import type { WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudApp from "../src/CloudApp.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { standaloneResolver } from "../src/resolver.js";
import {
  defaultWorkspaceFiles,
  defaultWorkspaceWebAppState,
  type WorkspaceWebAppStateV1,
} from "../src/storage.js";
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
    ChatPanel: ({ initialSessionId, sessionIntent, onOpenFile, onSignIn, onStatusChange }: {
      initialSessionId: string | null;
      sessionIntent?: string;
      onOpenFile?: (filePath: string) => void;
      onSignIn?: (provider: "claude" | "codex") => void;
      onStatusChange?: (status: "idle" | "generating" | "needs-attention" | "done" | "error") => void;
    }) => {
      const [mountId] = React.useState(() => `chat-${++webAppHarness.nextMountId}`);
      React.useEffect(() => {
        webAppHarness.mounts("chat", mountId);
        return () => webAppHarness.unmounts("chat", mountId);
      }, [mountId]);
      return (
        <div
          data-testid="chat-session"
          data-initial-session-id={initialSessionId ?? ""}
          data-session-intent={sessionIntent ?? ""}
          data-mount-id={mountId}
        >
          <button
            type="button"
            data-testid="chat-sign-in"
            onClick={() => onSignIn?.("claude")}
          >Sign in to Claude</button>
          <button
            type="button"
            data-testid="chat-sign-in-codex"
            onClick={() => onSignIn?.("codex")}
          >Sign in to Codex</button>
          {(["generating", "needs-attention", "done", "error"] as const).map((status) => (
            <button
              type="button"
              data-testid={`chat-status-${status}`}
              key={status}
              onClick={() => onStatusChange?.(status)}
            >{status}</button>
          ))}
          <button
            type="button"
            data-testid="chat-open-file"
            onClick={() => onOpenFile?.("src/app.ts")}
          >open file</button>
        </div>
      );
    },
  };
});

type TerminalSubmitDetail = { data?: string; enters?: number; sessionKey?: string };

/** Collects what the shell types at terminal tabs until the returned stop. */
function recordTerminalSubmits(): { submits: TerminalSubmitDetail[]; stop: () => void } {
  const submits: TerminalSubmitDetail[] = [];
  const record = (event: Event) => {
    // SAFETY: The shell is the only dispatcher of this event name in the test environment.
    submits.push((event as CustomEvent<TerminalSubmitDetail>).detail);
  };
  window.addEventListener("blitz:terminal-submit", record);
  return { submits, stop: () => window.removeEventListener("blitz:terminal-submit", record) };
}

function selectedSessionId(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLElement>(
    '[aria-label="Workspace sessions"] .webapp-tab-cell [role="tab"][aria-selected="true"]',
  )?.closest<HTMLElement>(".webapp-tab-cell")?.dataset.sessionId;
}

const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;

/** window.location.reload cannot be redefined in place, so the whole object is
 * swapped for one that forwards the URL to the real location and captures the
 * reload. beforeEach puts the real one back. */
function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  const real = window.location;
  const stub: Record<string, unknown> = { reload };
  for (const key of ["href", "pathname", "search", "hash", "origin"]) {
    Object.defineProperty(stub, key, { get: () => Reflect.get(real, key), enumerable: true });
  }
  Object.defineProperty(window, "location", { configurable: true, value: stub });
  return reload;
}

function leaveButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".settings-danger .webapp-action");
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setInputValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setInputValue === undefined) throw new Error("input value setter is unavailable");
  await act(async () => {
    setInputValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const creating: WorkspaceView = {
  id: "workspace-one",
  name: "workspace-one-name",
  machineTypeId: "cx23@fsn1",
  phase: "creating",
  retryAction: "poll",
  canObserve: false,
  launchable: false,
  revision: 1,
  ssh: null,
  volumeId: null,
  error: null,
  role: "owner",
  orgShareRole: null,
  owner: { name: "Owner", avatarUrl: null },
  environment: null,
  agentRuleId: null,
  connections: [],
};

const running: WorkspaceView = {
  id: "workspace-running",
  name: "workspace-running-name",
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
  role: "owner",
  orgShareRole: null,
  owner: { name: "Owner", avatarUrl: null },
  environment: null,
  agentRuleId: null,
  connections: [],
};

const runningTwo: WorkspaceView = {
  ...running,
  id: "workspace-two",
  ssh: {
    ...running.ssh!,
    host: "box-two.example.test",
  },
};

const tenantMe = {
  user: {
    id: "user-one",
    email: "person@example.com",
    name: "Person",
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
  org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  organizations: [{
    membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
    org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  }],
};

let deviceStorageValues: Map<string, string>;
let serverWorkspaceStates: Map<string, WorkspaceWebAppStateV1>;

function client(): ControlPlaneClient {
  return {
    getComputeCredential: vi.fn(async () => { throw new Error("unused"); }),
    putComputeCredential: vi.fn(async () => { throw new Error("unused"); }),
    deleteComputeCredential: vi.fn(async () => undefined),
    googleLoginUrl: () => "/auth/google/start",
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error("unused"); }),
    switchOrg: vi.fn(async () => undefined),
    leaveOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error("unused"); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error("unused"); }),
    revokeInvite: vi.fn(async () => undefined),
    listWorkspaceGrants: vi.fn(async () => ({ grants: [] })),
    createWorkspaceGrant: vi.fn(async () => { throw new Error("unused"); }),
    revokeWorkspaceGrant: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => ({ folders: [] })),
    createFolder: vi.fn(async () => { throw new Error("unused"); }),
    deleteFolder: vi.fn(async () => undefined),
    createFolderGrant: vi.fn(async () => { throw new Error("unused"); }),
    revokeFolderGrant: vi.fn(async () => undefined),
    listFolderObjects: vi.fn(async () => ({ objects: [], cursor: null, truncated: false })),
    downloadFolderObject: vi.fn(async () => new Blob()),
    uploadFolderObject: vi.fn(async () => undefined),
    listWorkspaceFolders: vi.fn(async () => ({ folders: [] })),
    attachFolder: vi.fn(async () => { throw new Error("unused"); }),
    detachFolder: vi.fn(async () => undefined),
    renameFolder: vi.fn(async () => undefined),
  setFolderOrgRole: vi.fn(async () => undefined),
  listAgentRules: vi.fn(async () => ({ rules: [] })),
  putAgentRule: vi.fn(async () => { throw new Error("unused"); }),
  deleteAgentRule: vi.fn(async () => undefined),
  listWorkspaceTemplates: vi.fn(async () => ({ templates: [] })),
  createWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    updateWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
  deleteWorkspaceTemplate: vi.fn(async () => undefined),
  listRecipes: vi.fn(async () => ({ recipes: [] })),
  getRecipe: vi.fn(async () => { throw new Error("unused"); }),
  createRecipe: vi.fn(async () => { throw new Error("unused"); }),
  updateRecipe: vi.fn(async () => { throw new Error("unused"); }),
  deleteRecipe: vi.fn(async () => undefined),
  launchRecipe: vi.fn(async () => { throw new Error("unused"); }),
  getUsageCapture: vi.fn(async () => ({ enabled: false, folderId: null })),
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10 })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
  putUsageCapture: vi.fn(async (enabled: boolean) => ({ enabled, folderId: null })),
  setWorkspaceOrgRole: vi.fn(async () => undefined),
    deleteFolderObject: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => { throw new ApiRequestError("unauthorized", 401, null); }),
    createOrg: vi.fn(async () => ({
      org: tenantMe.org,
      membership: tenantMe.membership,
    })),
    getGlobalWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putGlobalWebAppState: vi.fn(async (doc) => ({ doc, updatedAt: 1 })),
    getWorkspaceWebAppState: vi.fn(async (workspaceId) => ({
      doc: serverWorkspaceStates.get(workspaceId) ?? null,
      updatedAt: serverWorkspaceStates.has(workspaceId) ? 1 : null,
    })),
    putWorkspaceWebAppState: vi.fn(async (workspaceId, doc) => {
      serverWorkspaceStates.set(workspaceId, doc);
      return { doc, updatedAt: 1 };
    }),
    poll: vi.fn(async () => ({ workspaces: [creating] })),
    create: vi.fn(async () => ({ workspace: creating })),
    destroy: vi.fn(async () => ({ workspace: creating })),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [], failures: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listConnections: vi.fn(async () => ({ connections: [] })),
    putConnection: vi.fn(async () => undefined),
    deleteConnection: vi.fn(async () => undefined),
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error("unused"); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, reachable: true })),
    })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
  };
}

function runningClient(): ControlPlaneClient {
  return {
    ...client(),
    me: vi.fn(async () => tenantMe),
    poll: vi.fn(async () => ({ workspaces: [running] })),
  };
}

/** Seeds the shared workspace document. `sideActiveId` opens the second pane;
 * without it every tab given here lives in the single main pane. */
function saveTabs(
  workspaceId: string,
  tabs: Array<Record<string, unknown>>,
  activeId: number | null,
  sideActiveId?: number,
): void {
  const state = defaultWorkspaceWebAppState();
  serverWorkspaceStates.set(workspaceId, {
    ...state,
    tabs: {
      version: 1,
      // SAFETY: Each caller below supplies complete tab objects accepted by the state decoder.
      tabs: tabs as WorkspaceWebAppStateV1["tabs"]["tabs"],
      activeId,
      nextId: tabs.reduce((highest, tab) => Math.max(highest, Number(tab.id)), 0) + 1,
      ...(sideActiveId === undefined ? {} : { sideActiveId }),
    },
    drawer: defaultWorkspaceFiles(),
  });
}

beforeEach(() => {
  createClientSpy.mockClear();
  webAppHarness.mounts.mockClear();
  webAppHarness.nextMountId = 0;
  webAppHarness.unmounts.mockClear();
  Object.defineProperty(window, "location", realLocation);
  window.history.replaceState({}, "", "/");
  deviceStorageValues = new Map<string, string>();
  serverWorkspaceStates = new Map<string, WorkspaceWebAppStateV1>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => deviceStorageValues.get(key) ?? null,
      setItem: (key: string, value: string) => deviceStorageValues.set(key, value),
      removeItem: (key: string) => deviceStorageValues.delete(key),
      clear: () => deviceStorageValues.clear(),
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
  it("renders Google login after an unauthenticated /me", async () => {
    const wire = client();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();

    const link = view.container.querySelector<HTMLAnchorElement>('a[href="/auth/google/start"]');
    expect(link?.textContent).toContain("Continue with Google");
    await view.unmount();
  });

  it("renders the real organization and workspace after /me", async () => {
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector(".drive-rail")?.textContent).toContain("workspace-running");
    expect(view.container.textContent).toContain("Example");
    await view.unmount();
  });

  it("creates an organization from the identity-only onboarding page", async () => {
    const createOrg = vi.fn(async () => ({
      org: tenantMe.org,
      membership: tenantMe.membership,
    }));
    const wire = {
      ...runningClient(),
      me: vi.fn()
        .mockResolvedValueOnce({ ...tenantMe, membership: null, org: null })
        .mockResolvedValue(tenantMe),
      createOrg,
    };
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();

    expect(view.container.querySelectorAll("input")).toHaveLength(1);
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    const input = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setInputValue === undefined) throw new Error("input value setter is unavailable");
    await act(async () => {
      setInputValue.call(input, "Example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    await settle();

    expect(createOrg).toHaveBeenCalledWith("Example");
    expect(view.container.querySelector(".drive-rail")?.textContent).toContain("workspace-running");
    await view.unmount();
  });

  it("closes the create-workspace dialog when it hands off to the template page", async () => {
    window.history.replaceState({}, "", "/templates");
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Create workspace"]',
    )?.click());
    expect(view.container.querySelector('form[aria-label="Create workspace"]')).not.toBeNull();

    const newTemplate = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".template-grid > button",
    )].find((tile) => tile.textContent?.includes("New template"))!;
    await act(async () => newTemplate.click());
    await settle();

    // Every rail branch draws this dialog since #40, the template page too. It
    // must leave, or it covers the page it just opened.
    expect(window.location.pathname).toBe("/templates/new");
    expect(view.container.querySelector('form[aria-label="Create workspace"]')).toBeNull();
    expect(view.container.querySelector('form[aria-label="Create workspace template"]'))
      .not.toBeNull();

    await view.unmount();
  });

  it("creates a second organization from the rail organization menu", async () => {
    const createOrg = vi.fn(async () => ({
      org: { id: "org-two", slug: "side", name: "Side", vmLimit: 10 },
      membership: { id: "membership-two", role: "admin" as const, status: "active" as const },
    }));
    const reload = stubReload();
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), createOrg }}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await click(view.container.querySelector<HTMLButtonElement>(".webapp-org-button"));
    const create = view.container.querySelector<HTMLButtonElement>(".webapp-org-menu-create");
    expect(create?.textContent).toContain("Create organization");
    await click(create);

    const dialog = document.querySelector<HTMLElement>('[aria-label="Create organization"]');
    expect(dialog).not.toBeNull();
    await typeInto(dialog!.querySelector<HTMLInputElement>('input[name="name"]')!, "Side");
    await act(async () => {
      dialog!.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(createOrg).toHaveBeenCalledWith("Side");
    // POST /orgs rebinds the session, so the shell reloads into the new org.
    expect(reload).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("leaves the organization from settings, once another member exists", async () => {
    const leaveOrg = vi.fn(async () => undefined);
    const reload = stubReload();
    window.history.replaceState({}, "", "/settings/members");
    const view = await render(
      <CloudApp
        client={{
          ...runningClient(),
          leaveOrg,
          listMembers: vi.fn(async () => ({
            members: [
              { id: "membership-one", email: "person@example.com", name: "Person", avatarUrl: null, role: "admin" as const, status: "active" as const },
              { id: "membership-two", email: "other@example.com", name: "Other", avatarUrl: null, role: "admin" as const, status: "active" as const },
            ],
          })),
        }}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const leave = leaveButton(view.container);
    expect(leave?.disabled).toBe(false);
    await click(leave);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".webapp-confirmation-actions button")]
      .find((button) => button.textContent === "Yes, leave");
    expect(confirm).not.toBeUndefined();
    await click(confirm);
    await settle();

    expect(leaveOrg).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("disables Leave for the only active member of an organization", async () => {
    const leaveOrg = vi.fn(async () => undefined);
    stubReload();
    window.history.replaceState({}, "", "/settings/members");
    const view = await render(
      <CloudApp
        client={{
          ...runningClient(),
          leaveOrg,
          listMembers: vi.fn(async () => ({
            members: [
              { id: "membership-one", email: "person@example.com", name: "Person", avatarUrl: null, role: "admin" as const, status: "active" as const },
              // A disabled row must not count as company.
              { id: "membership-two", email: "gone@example.com", name: "Gone", avatarUrl: null, role: "member" as const, status: "disabled" as const },
            ],
          })),
        }}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const leave = leaveButton(view.container);
    expect(leave?.disabled).toBe(true);
    expect(view.container.querySelector(".settings-danger")?.textContent)
      .toContain("You are the only member");
    await click(leave);
    expect(document.querySelector(".webapp-confirmation-actions")).toBeNull();
    expect(leaveOrg).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("opens a workspace with terminal tabs enabled through control-plane surfaces", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
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
    expect(serverWorkspaceStates.get("workspace-running")?.tabs).toEqual({
      version: 1,
      tabs: [{ id: 1, type: "terminal" }],
      activeId: 1,
      nextId: 2,
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/chat/layout")))
      .toBe(false);

    await view.unmount();
  });

  it("does not re-send the shared doc when the workspace poll re-renders it", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const afterLoad = vi.mocked(wire.putWorkspaceWebAppState).mock.calls.length;

    // Every poll rebuilds the workspace records, which re-runs the save
    // effect. An idle tab must stay silent: the doc is shared, and re-sending
    // a held snapshot would outrank another account's newer save.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
    }

    expect(vi.mocked(wire.putWorkspaceWebAppState).mock.calls.length).toBe(afterLoad);
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs)
      .toEqual([{ id: 1, type: "terminal" }]);

    await view.unmount();
  });

  it("renders default tabs but never persists them when the state read fails", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const wire = runningClient();
    wire.getWorkspaceWebAppState = vi.fn(async () => {
      throw new ApiRequestError("state unavailable", 500, null);
    });
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();
    // Wait out the 150ms save debounce before asserting nothing was written:
    // the workspace doc is shared, so a failed read must not push defaults.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const sessionTabs = [...view.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Workspace sessions"] .webapp-tab-cell [role="tab"]',
    )];
    // The default tab set is Claude alone in the main pane; Files rides in
    // the side pane. Remote control runs detached with no tab of its own, so
    // there is no default terminal tab any more.
    expect(sessionTabs).toHaveLength(1);
    expect(sessionTabs[0]?.textContent ?? "").toMatch(/claude/i);
    expect(vi.mocked(wire.putWorkspaceWebAppState)).not.toHaveBeenCalled();
    expect(serverWorkspaceStates.size).toBe(0);

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
      'https://cp.example.test/workspaces/workspace-running/webapp/7445/workspace/',
      { withCredentials: true, remoteBasePath: '/workspace' },
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
    saveTabs("workspace-running", [
      { id: 1, type: "terminal" },
      { id: 2, type: "preview", port: 3000 },
    ], 2);

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
    expect(chat.dataset.sessionIntent).toBe("load");
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

  it("marks a newly spawned Chat for creation and a legacy id-less Chat for recovery", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "chat", chatProvider: "claude" }], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector<HTMLElement>("[data-testid='chat-session']")
      ?.dataset.sessionIntent).toBe("recover");
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-new-tab-spawn",
    )?.click());
    const chatAction = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-agent-menu [role='menuitem']",
    )].find(({ textContent }) => textContent?.trim() === "Chat");
    await act(async () => chatAction?.click());
    const chats = [...view.container.querySelectorAll<HTMLElement>("[data-testid='chat-session']")];
    expect(chats).toHaveLength(2);
    expect(chats.at(-1)?.dataset.sessionIntent).toBe("create");
    await view.unmount();
  });

  it("shows native Chat states in the rail and acknowledges background results", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatSessionId: "chat-one" },
      { id: 2, type: "terminal" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const railSession = (id: string) => view.container.querySelector<HTMLButtonElement>(
      `[data-rail-session-id="${id}"]`,
    );
    const chatStatus = (status: string) => view.container.querySelector<HTMLButtonElement>(
      `[data-testid="chat-status-${status}"]`,
    );

    await act(async () => chatStatus("generating")?.click());
    expect(railSession("1")?.querySelector('[aria-label="generating"]')).not.toBeNull();
    await act(async () => chatStatus("needs-attention")?.click());
    expect(railSession("1")?.textContent).toContain("needs input");

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    await act(async () => chatStatus("done")?.click());
    expect(railSession("1")?.textContent).toContain("done");
    expect(railSession("1")?.classList.contains("webapp-session--unread")).toBe(true);
    await act(async () => railSession("1")?.click());
    expect(railSession("1")?.textContent).not.toContain("done");
    expect(railSession("1")?.classList.contains("webapp-session--unread")).toBe(false);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    await act(async () => chatStatus("error")?.click());
    expect(railSession("1")?.textContent).toContain("error");
    await act(async () => railSession("1")?.click());
    expect(railSession("1")?.textContent).not.toContain("error");

    await act(async () => chatStatus("done")?.click());
    expect(railSession("1")?.textContent).not.toContain("done");
    expect(railSession("2")?.querySelector(".webapp-session-state, .webapp-session-spinner"))
      .toBeNull();

    await view.unmount();
  });

  it("focuses an existing file tab when Chat opens a workspace-file link", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatSessionId: "chat-one" },
      { id: 2, type: "file", filePath: "src/app.ts" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-open-file"]',
    )?.click());

    expect(selectedSessionId(view.container)).toBe("2");
    expect(view.container.querySelectorAll(".webapp-tab-cell")).toHaveLength(2);
    await view.unmount();
  });

  it("persists managed-session archive, restore, and permanent removal", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", title: "Release chat", chatSessionId: "chat-one" },
      { id: 2, type: "terminal" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const chatCell = () => view.container.querySelector<HTMLElement>(
      ".webapp-tab-cell[data-session-id='1']",
    );
    await act(async () => chatCell()?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const archive = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )].find(({ textContent }) => textContent === "Archive");
    await act(async () => archive?.click());
    expect(chatCell()).toBeNull();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      "[aria-label='Archived sessions']",
    )?.click());
    expect(view.container.querySelector(".webapp-archive-label")?.textContent).toBe("Release chat");
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-archive-restore",
    )?.click());
    expect(chatCell()).not.toBeNull();
    expect(selectedSessionId(view.container)).toBe("1");

    await act(async () => chatCell()?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )].find(({ textContent }) => textContent === "Archive")?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      "[aria-label='Archived sessions']",
    )?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-archive-delete",
    )?.click());
    expect(view.container.textContent).toContain("Remove session from Blitz?");
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(({ textContent }) => textContent === "Remove permanently")?.click());
    expect(view.container.querySelector(".webapp-archive-row")).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const saved = serverWorkspaceStates.get("workspace-running")?.tabs;
    expect(saved?.tabs.map(({ id }) => id)).toEqual([2]);
    expect(saved?.archivedTabs).toBeUndefined();
    expect(saved?.nextId).toBe(3);
    await view.unmount();
  });

  it("closes only the active session window and reopens it from the workspace rail", async () => {
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
    expect(view.container.querySelector('.webapp-tab-cell[data-session-id="1"]')).toBeNull();
    expect(view.container.querySelector('[data-rail-session-id="1"]')).not.toBeNull();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-rail-session-id="1"]',
    )?.click());
    expect(view.container.querySelector('.webapp-tab-cell[data-session-id="1"]')).not.toBeNull();
    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )).not.toBeNull();
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.archivedTabs).toBeUndefined();

    await view.unmount();
  });

  it("shows resume after the last session window closes and reopens that session", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatSessionId: "chat-one" },
      { id: 2, type: "panel", panel: "files", region: "side" },
    ], 1, 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close Chat"]',
    )?.click());
    expect(view.container.textContent).toContain("Resume your session");
    expect(view.container.textContent).toContain(
      "Your session is still running. Open it from the workspace rail to continue.",
    );
    expect(view.container.querySelector('[data-rail-session-id="1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="chat-session"]')).toBeNull();
    expect(view.container.querySelector(".webapp-panes--split")).not.toBeNull();

    expect([...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .some(({ textContent }) => textContent === "Resume session")).toBe(false);
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-rail-session-id="1"]',
    )?.click());
    expect(view.container.textContent).not.toContain("Resume your session");
    expect(view.container.querySelector('[data-testid="chat-session"]')).not.toBeNull();
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs[0]).toMatchObject({
      id: 1,
      type: "chat",
      chatSessionId: "chat-one",
    });
    await view.unmount();
  });

  it("shows the start state when a workspace has no sessions", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [], null);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.textContent).toContain("Start a session");
    expect(view.container.textContent).toContain(
      "Create a session to start working in this workspace.",
    );
    expect([...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .some(({ textContent }) => textContent === "New Chat")).toBe(false);
    await view.unmount();
  });

  it("uses plural resume copy when several session windows are closed", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", windowOpen: false },
      { id: 2, type: "terminal", windowOpen: false },
    ], null);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.textContent).toContain("Resume your session");
    expect(view.container.textContent).toContain(
      "Your sessions are still running. Open one from the workspace rail to continue.",
    );
    await view.unmount();
  });

  it("keeps the panels an off-canvas sheet and one tab strip on mobile", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    saveTabs(
      "workspace-running",
      [
        { id: 1, type: "terminal" },
        { id: 2, type: "panel", panel: "previews", region: "side" },
      ],
      1,
      2,
    );
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // No rail, no split: one strip holding only the session tabs, with the
    // panel living in the drawer the mobile layout already had.
    expect(view.container.querySelector(".webapp-rail-strip")).toBeNull();
    expect(view.container.querySelectorAll(".webapp-pane-strip")).toHaveLength(1);
    expect([...view.container.querySelectorAll(
      '[aria-label="Workspace sessions"] .webapp-tab-cell',
    )]).toHaveLength(1);
    const drawer = view.container.querySelector("#webapp-workspace-drawer")!;
    const segments = [...drawer.querySelectorAll('[role="tab"]')]
      .map((tab) => tab.textContent);
    expect(segments).toEqual(["Files", "teenyapps", "Connections"]);
    expect(drawer.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("teenyapps");

    await view.unmount();
  });

  it("splits the tab area from the right icon strip and collapses it again", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelectorAll(".webapp-pane-strip")).toHaveLength(1);
    const filesIcon = view.container.querySelector<HTMLButtonElement>(
      '.webapp-rail-strip button[aria-label="Files"]',
    )!;
    await act(async () => filesIcon.click());

    const strips = [...view.container.querySelectorAll<HTMLElement>(".webapp-pane-strip")];
    expect(strips.map((strip) => strip.dataset.region)).toEqual(["main", "side"]);
    expect(strips[1]?.querySelector('[role="tab"]')?.textContent).toContain("Files");
    expect(filesIcon.getAttribute("aria-pressed")).toBe("true");

    // Clicking the same icon while its tab is in front closes the panel, and
    // the side pane goes with it.
    await act(async () => filesIcon.click());
    expect(view.container.querySelectorAll(".webapp-pane-strip")).toHaveLength(1);
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs)
      .toEqual([{ id: 1, type: "terminal" }]);
  });

  it("keeps a visited terminal mounted when its tab is dragged into the other pane", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs(
      "workspace-running",
      [
        { id: 1, type: "terminal" },
        { id: 2, type: "panel", panel: "files", region: "side" },
        { id: 3, type: "claude" },
      ],
      1,
      2,
    );
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const terminal = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )!;
    const mountId = terminal.dataset.mountId;
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.dataset.region).toBe("main");

    const handle = view.container.querySelector<HTMLElement>(
      '.webapp-pane-strip[data-region="main"] .webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )!;
    const panes = view.container.querySelector<HTMLElement>(".webapp-panes")!;
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    });
    await act(async () => {
      // jsdom reports zero-size boxes, so the pointer resolves to the last
      // pane and the drop is a plain tab move into it.
      panes.dispatchEvent(new MouseEvent("dragover", { bubbles: true, clientX: 50 }));
      panes.dispatchEvent(new MouseEvent("drop", { bubbles: true, clientX: 50 }));
    });

    const moved = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="1"]',
    );
    expect(moved).toBe(terminal);
    expect(moved?.dataset.mountId).toBe(mountId);
    expect(moved?.closest<HTMLElement>(".webapp-workspace-session")?.dataset.region).toBe("side");
    expect(webAppHarness.unmounts).not.toHaveBeenCalled();
    // Two mounts, not a remount: the terminal kept its instance and the tab
    // the main pane promoted behind it opened for the first time.
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);
    // Wait out the 150ms save debounce: the move has to reach the shared doc.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs.find(
      (tab) => tab.id === 1,
    )).toEqual({ id: 1, type: "terminal", region: "side" });

    await view.unmount();
  });

  it("drives the open claude tab into its login flow from chat", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatProvider: "claude", chatSessionId: "chat-one" },
      { id: 2, type: "claude" },
    ], 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // Visit chat second, so the claude pane is already mounted behind it.
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());
    const recorder = recordTerminalSubmits();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-sign-in"]',
    )?.click());

    expect(selectedSessionId(view.container)).toBe("2");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    recorder.stop();

    // The slash command and its submit are separate writes, and both are
    // addressed at the claude tab rather than at whatever happens to be
    // selected when they land.
    expect(recorder.submits).toEqual([
      { data: "/login", enters: 0, sessionKey: "2" },
      { data: "\r", enters: 0, sessionKey: "2" },
    ]);

    await view.unmount();
  });

  it("opens a claude tab for the login flow when none is running", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatProvider: "claude", chatSessionId: "chat-one" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const recorder = recordTerminalSubmits();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-sign-in"]',
    )?.click());

    expect(selectedSessionId(view.container)).toBe("2");
    const terminal = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="2"]',
    );
    expect(terminal?.textContent).toBe("claude");
    expect(terminal?.dataset.active).toBe("true");
    expect(recorder.submits).toEqual([]);

    // A tab that was not open yet has to connect and let the TUI take the pty
    // before anything typed at it is read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    });
    recorder.stop();
    expect(recorder.submits).toEqual([
      { data: "/login", enters: 0, sessionKey: "2" },
      { data: "\r", enters: 0, sessionKey: "2" },
    ]);

    await view.unmount();
  });

  it("opens a fresh codex device-auth tab without typing the localhost login command", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatProvider: "codex", chatSessionId: "chat-one" },
      { id: 2, type: "codex" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const recorder = recordTerminalSubmits();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-sign-in-codex"]',
    )?.click());

    expect(selectedSessionId(view.container)).toBe("3");
    const terminal = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="3"]',
    );
    expect(terminal?.textContent).toBe("codex");
    expect(terminal?.dataset.active).toBe("true");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    });
    recorder.stop();
    expect(recorder.submits).toEqual([]);

    await view.unmount();
  });

  it("drops an abandoned sign-in instead of re-arming it on the way back", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatProvider: "claude", chatSessionId: "chat-one" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ acp: 7444, files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const recorder = recordTerminalSubmits();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-sign-in"]',
    )?.click());
    expect(selectedSessionId(view.container)).toBe("2");

    // Leaving the tab inside the warm-up window is the reader abandoning the
    // flow, not pausing it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());
    expect(recorder.submits).toEqual([]);

    // Coming back to that tab must not resume the request. The pane is a live
    // agent TUI by then, and `/login` plus Enter typed into it mid-session
    // interrupts whatever the reader was actually doing there.
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    });
    recorder.stop();
    expect(recorder.submits).toEqual([]);

    await view.unmount();
  });

  it("tears down retained panes when switching workspaces", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    saveTabs("workspace-two", [{ id: 1, type: "terminal" }], 1);
    const wire = {
      ...runningClient(),
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
