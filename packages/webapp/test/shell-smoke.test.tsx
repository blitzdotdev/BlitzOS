import type { PresenceSnapshotResponse, WorkspaceSessionView, WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudApp from "../src/CloudApp.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { standaloneResolver } from "../src/resolver.js";
import { decodeWorkspaceMemberViewResponse } from "../src/workspace-sessions.js";
import {
  defaultWorkspaceFiles,
  defaultWorkspaceWebAppState,
  type WorkspaceWebAppStateV1,
} from "../src/storage.js";
import { render, settle } from "./dom.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

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

function railSessions(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(
    '[aria-label^="Sessions in "] button',
  )];
}

function railSessionLabels(container: HTMLElement): string[] {
  return railSessions(container).map(({ textContent }) => textContent ?? "");
}

function railSession(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return railSessions(container).find((row) => row.textContent === label);
}

function createOrgItem(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(
    '[role="menu"][aria-label="Organizations"] [role="menuitem"]',
  )].find((item) => item.textContent?.includes("Create organization"));
}

/** The mobile navigation toggle reports the drawer state, so no test needs to
 * reach for the rail's open class. */
function navigationExpanded(container: HTMLElement): string | null {
  return container.querySelector('button[aria-label="Open workspace navigation"]')
    ?.getAttribute("aria-expanded") ?? null;
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
  // The danger zone and its verb are `.cfg-danger` / `.cfg-danger-action`
  // since the settings-surface system landed (src/settings-surface.css).
  return container.querySelector<HTMLButtonElement>(".cfg-danger .cfg-danger-action");
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

const creating: WorkspaceView = workspaceViewFixture({
  id: "workspace-one",
  name: "workspace-one-name",
  phase: "creating",
  retryAction: "poll",
  canObserve: false,
  launchable: false,
});

const running: WorkspaceView = workspaceViewFixture({
  id: "workspace-running",
  name: "workspace-running-name",
  revision: 2,
  updatedAt: 1_700_000_005_000,
  ssh: {
    host: "box.example.test",
    port: 2222,
    user: "blitz",
    hostPublicKey: null,
  },
});

const runningTwo: WorkspaceView = {
  ...running,
  id: "workspace-two",
  // A distinct name so the rail entry can be found by its accessible name.
  name: "workspace-two-name",
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
let serverWorkspaceSessions: Map<string, WorkspaceSessionView[]>;

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
    addWorkspaceMember: vi.fn(async () => { throw new Error("unused"); }),
    provisionMemberMachine: vi.fn(async () => { throw new Error("unused"); }),
    updateWorkspace: vi.fn(async () => { throw new Error("unused"); }),
    listWorkspaceRepos: vi.fn(async () => ({ repos: [] })),
    listSessionShares: vi.fn(async () => ({ granted: [], received: [] })),
    grantSessionShare: vi.fn(async () => { throw new Error("unused"); }),
    revokeSessionShare: vi.fn(async () => undefined),
    addWorkspaceRepo: vi.fn(async () => { throw new Error("unused"); }),
    removeWorkspaceRepo: vi.fn(async () => { throw new Error("unused"); }),
    updateWorkspaceMember: vi.fn(async () => { throw new Error("unused"); }),
    removeWorkspaceMember: vi.fn(async () => undefined),
    provisionMachine: vi.fn(async () => { throw new Error("unused"); }),
    stopMachine: vi.fn(async () => { throw new Error("unused"); }),
    startMachine: vi.fn(async () => { throw new Error("unused"); }),
    recreateMachine: vi.fn(async () => { throw new Error("unused"); }),
    setMachineType: vi.fn(async () => { throw new Error("unused"); }),
    destroyMachine: vi.fn(async () => { throw new Error("unused"); }),
    putWorkspaceCredential: vi.fn(async () => undefined),
    importWorkspaceCredentials: vi.fn(async () => { throw new Error('unused'); }),
    revokeWorkspaceCredential: vi.fn(async () => undefined),
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
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
  putUsageCapture: vi.fn(async (enabled: boolean) => ({ enabled, folderId: null })),
    deleteFolderObject: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => { throw new ApiRequestError("unauthorized", 401, null); }),
    createOrg: vi.fn(async () => ({
      org: tenantMe.org,
      membership: tenantMe.membership,
    })),
    getGlobalWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putGlobalWebAppState: vi.fn(async (doc) => ({ doc, updatedAt: 1 })),
    // Seeded docs take the production read path: the real client decodes
    // (and normalizes) every response before the shell sees it.
    getWorkspaceWebAppState: vi.fn(async (workspaceId) => decodeWorkspaceMemberViewResponse(
      JSON.stringify({
        doc: serverWorkspaceStates.get(workspaceId) ?? null,
        revision: serverWorkspaceStates.has(workspaceId) ? 1 : 0,
        migratedFromV1: false,
        sessions: serverWorkspaceSessions.get(workspaceId) ?? [],
      }),
    )),
    putWorkspaceWebAppState: vi.fn(async (workspaceId, doc, revision) => {
      serverWorkspaceStates.set(workspaceId, doc);
      return {
        doc,
        revision: revision + 1,
        migratedFromV1: false,
        sessions: serverWorkspaceSessions.get(workspaceId) ?? [],
      };
    }),
    listWorkspaceSessions: vi.fn(async (workspaceId) => ({
      sessions: serverWorkspaceSessions.get(workspaceId) ?? [],
    })),
    createWorkspaceSession: vi.fn(async (workspaceId, input) => {
      const current = serverWorkspaceSessions.get(workspaceId) ?? [];
      const session: WorkspaceSessionView = {
        id: `session-${current.length + 1}`,
        workspaceId,
        kind: input.kind,
        title: input.title ?? null,
        terminalKey: `session-${current.length + 1}`,
        chatSessionId: null,
        chatProvider: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      serverWorkspaceSessions.set(workspaceId, [...current, session]);
      return { session };
    }),
    updateWorkspaceSession: vi.fn(async (workspaceId, sessionId, input) => {
      const current = serverWorkspaceSessions.get(workspaceId) ?? [];
      const existing = current.find((session) => session.id === sessionId);
      if (existing === undefined) throw new Error('missing session');
      const session: WorkspaceSessionView = {
        ...existing,
        revision: existing.revision + 1,
        title: input.title === undefined ? existing.title : input.title,
        chatSessionId: input.chatSessionId === undefined
          ? existing.chatSessionId
          : input.chatSessionId,
        chatProvider: input.chatProvider === undefined ? existing.chatProvider : input.chatProvider,
      };
      serverWorkspaceSessions.set(
        workspaceId,
        current.map((entry) => entry.id === sessionId ? session : entry),
      );
      return { session };
    }),
    archiveWorkspaceSession: vi.fn(async () => undefined),
    putPresenceConnection: vi.fn(async () => undefined),
    deletePresenceConnection: vi.fn(async () => undefined),
    getPresence: vi.fn(async () => ({
      serverTime: 1,
      expiresAfterMs: 35_000,
      truncated: false,
      members: [],
    })),
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
    listGithubInstallations: vi.fn(async () => ({ installations: [] })),
    listGithubRepositories: vi.fn(async () => ({
      source: "installations" as const,
      repositories: [],
      truncated: false,
    })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, verdict: "public" as const })),
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

function sharedSession(
  id: string,
  kind: WorkspaceSessionView["kind"],
  terminalKey = id,
): WorkspaceSessionView {
  return {
    id,
    workspaceId: "workspace-running",
    kind,
    title: null,
    terminalKey,
    chatSessionId: null,
    chatProvider: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
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
  window.sessionStorage.clear();
  deviceStorageValues = new Map<string, string>();
  serverWorkspaceStates = new Map<string, WorkspaceWebAppStateV1>();
  serverWorkspaceSessions = new Map<string, WorkspaceSessionView[]>();
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
        resolver={standaloneResolver({ files: 7445 })}
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('button[aria-label="workspace-running-name"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Example");
    await view.unmount();
  });

  it("adds a workspace discovered by the background workspace refresh", async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce({ workspaces: [running] })
      .mockResolvedValue({ workspaces: [running, runningTwo] });
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), poll }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();
    expect(view.container.querySelector('[data-workspace-id="workspace-two"]')).toBeNull();

    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();

    expect(view.container.querySelector('[data-workspace-id="workspace-two"]')).not.toBeNull();
    await view.unmount();
  });

  it("returns to workspace details when workspace deletion is cancelled", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const detailsButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace details for workspace-running-name"]',
    );
    await act(async () => detailsButton?.click());
    await settle();
    expect(view.container.querySelector('[role="dialog"][aria-label^="Workspace details for"]')).not.toBeNull();

    // Delete lives on the Settings tab now; the dialog opens on Members.
    const settingsTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "Settings");
    await act(async () => settingsTab?.click());
    const deleteButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Delete workspace");
    await act(async () => deleteButton?.click());
    expect(view.container.textContent).toContain("Delete workspace?");

    const cancelButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "No");
    await act(async () => cancelButton?.click());
    expect(view.container.textContent).not.toContain("Delete workspace?");
    expect(view.container.querySelector('[role="dialog"][aria-label^="Workspace details for"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Delete workspace");
    expect(wire.destroy).not.toHaveBeenCalled();

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
        resolver={standaloneResolver({ files: 7445 })}
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
    expect(view.container.querySelector('button[aria-label="workspace-running-name"]')).not.toBeNull();
    await view.unmount();
  });

  it("reopens the create dialog on the GitHub workspace return route", async () => {
    window.history.replaceState({}, "", "/workspaces/new?connect=ok&provider=github");
    window.sessionStorage.setItem(
      'blitz:github-connect-draft:workspace-new',
      JSON.stringify({
        templateId: 'template-private',
        environment: { env: {}, startupScript: null },
        agentRuleId: null,
      }),
    );
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('form[aria-label="Create workspace"]')).not.toBeNull();
    expect(window.sessionStorage.getItem('blitz:github-connect-draft:workspace-new')).toBeNull();
    await view.unmount();
  });

  it("opens the Create organization dialog from inside a workspace", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Organization: Example"]'));
    await click(createOrgItem(view.container));
    expect(document.querySelector('[aria-label="Create organization"]')).not.toBeNull();
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Organization: Example"]'));
    const create = createOrgItem(view.container);
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
        resolver={standaloneResolver({ files: 7445 })}
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const leave = leaveButton(view.container);
    expect(leave?.disabled).toBe(true);
    expect(view.container.querySelector(".cfg-danger")?.textContent)
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
        resolver={standaloneResolver({ files: 7445 })}
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
    await view.unmount();
  });

  it("renders workspace and shared-session presence and joins from the popover", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession(
      "session-one",
      "claude",
      "session-one",
    )]);
    saveTabs("workspace-running", [
      { id: 1, type: "claude", sessionId: "session-one" },
    ], 1);
    const presenceSnapshot: PresenceSnapshotResponse = {
      serverTime: 10,
      expiresAfterMs: 35_000,
      truncated: false,
      members: [
        {
          membershipId: "membership-one",
          userId: "user-one",
          name: "Person",
          avatarUrl: null,
          state: "active",
          activities: [{ location: "organization", focused: true, visible: true, lastSeenAt: 10 }],
        },
        {
          membershipId: "membership-two",
          userId: "user-two",
          name: "Ada",
          avatarUrl: null,
          state: "active",
          activities: [{
            location: "workspace",
            workspaceId: "workspace-running",
            workspaceName: "workspace-running",
            surfaces: [{
              kind: "session",
              sessionId: "session-one",
              sessionKind: "claude",
              title: "Pairing",
            }],
            focusedSurface: 0,
            focused: true,
            visible: true,
            lastSeenAt: 10,
          }],
        },
      ],
    };
    const wire: ControlPlaneClient = {
      ...runningClient(),
      getPresence: vi.fn(async () => presenceSnapshot),
    };
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(wire.getPresence).toHaveBeenCalled();
    expect(view.container.querySelector(
      '.shell-wtile[data-workspace-id="workspace-running"] .shell-wtile__presence',
    )?.textContent).toContain('A');
    expect(view.container.querySelector(
      '[data-rail-session-id="session-one"] .webapp-session-presence',
    )?.textContent).toContain('A');
    expect(view.container.querySelector('.webapp-tab-presence')?.textContent).toContain('A');
    const trigger = view.container.querySelector<HTMLButtonElement>('.org-presence-trigger');
    expect(trigger?.getAttribute('aria-label')).toBe('1 collaborator online: Ada');
    await act(async () => trigger?.click());
    const activity = [...view.container.querySelectorAll<HTMLButtonElement>(
      '.org-presence-member__activities button',
    )].find((button) => button.textContent?.includes('Pairing'));
    await act(async () => activity?.click());
    await settle();

    expect(window.location.pathname).toBe('/workspaces/workspace-running');
    expect(window.location.search).toBe('');
    expect(view.container.querySelector('.org-presence-popover')?.hasAttribute('hidden')).toBe(true);
    await view.unmount();
  });

  it("discovers a collaborator-created shared session without opening it as a personal tab", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-1", "claude")]);
    saveTabs("workspace-running", [
      { id: 1, type: "claude", sessionId: "session-1" },
    ], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('[data-rail-session-id="session-1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-rail-session-id="session-2"]')).toBeNull();
    expect(view.container.querySelectorAll(
      '[aria-label="Workspace sessions"] .webapp-tab-cell',
    )).toHaveLength(1);

    serverWorkspaceSessions.set("workspace-running", [
      sharedSession("session-1", "claude"),
      sharedSession("session-2", "codex"),
    ]);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();

    const sharedCodex = view.container.querySelector<HTMLButtonElement>(
      '[data-rail-session-id="session-2"]',
    );
    expect(sharedCodex?.textContent).toContain('Codex');
    // Discovery does not mutate this member's personal tab layout.
    expect(view.container.querySelectorAll(
      '[aria-label="Workspace sessions"] .webapp-tab-cell',
    )).toHaveLength(1);

    await act(async () => sharedCodex?.click());
    await settle();
    expect(view.container.querySelectorAll(
      '[aria-label="Workspace sessions"] .webapp-tab-cell',
    )).toHaveLength(2);
    expect(view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="session-2"]',
    )?.dataset.active).toBe('true');
    await view.unmount();
  });

  it("ends a shared session for everyone, warning first when someone else is in it", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-one", "claude")]);
    saveTabs("workspace-running", [{ id: 1, type: "claude", sessionId: "session-one" }], 1);
    const presenceSnapshot: PresenceSnapshotResponse = {
      serverTime: 10,
      expiresAfterMs: 35_000,
      truncated: false,
      members: [{
        membershipId: "membership-two",
        userId: "user-two",
        name: "Ada",
        avatarUrl: null,
        state: "active",
        activities: [{
          location: "workspace",
          workspaceId: "workspace-running",
          workspaceName: "workspace-running",
          surfaces: [{
            kind: "session",
            sessionId: "session-one",
            sessionKind: "claude",
            title: "Pairing",
          }],
          focusedSurface: 0,
          focused: true,
          visible: true,
          lastSeenAt: 10,
        }],
      }],
    };
    const wire: ControlPlaneClient = {
      ...runningClient(),
      getPresence: vi.fn(async () => presenceSnapshot),
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ ended: true })
    ));
    vi.stubGlobal("fetch", fetcher);
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(".webapp-tab-close")?.click());
    const confirm = view.container.querySelector<HTMLElement>(".webapp-tab-close-confirm");
    expect(confirm?.textContent).toContain("Ada");
    expect(wire.archiveWorkspaceSession).not.toHaveBeenCalled();

    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-tab-close-confirm__actions button",
    )].find((button) => button.textContent === "End session")?.click());
    await settle();
    expect(wire.archiveWorkspaceSession)
      .toHaveBeenCalledWith("workspace-running", "session-one", 1);
    const endCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/terminal/session/end"));
    expect(endCall).toBeDefined();
    expect(JSON.parse(String(endCall?.[1]?.body)))
      .toEqual({ kind: "claude", key: "session-one" });
    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="session-one"]',
    )).toBeNull();
    await view.unmount();
  });

  it("ends a solo shared session immediately, with no warning", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-solo", "codex")]);
    saveTabs("workspace-running", [{ id: 1, type: "codex", sessionId: "session-solo" }], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(".webapp-tab-close")?.click());
    expect(view.container.querySelector(".webapp-tab-close-confirm")).toBeNull();
    await settle();
    expect(wire.archiveWorkspaceSession)
      .toHaveBeenCalledWith("workspace-running", "session-solo", 1);
    await view.unmount();
  });

  it("does not re-send the confirmed personal view when a workspace poll re-renders it", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
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

  it("attaches a migrated tab to the tmux session it was already running under", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    // A V1 tab with id 7 ran in tmux `claude-7`. The migration gave it a
    // durable id; the key handed to the box must still be `7`.
    serverWorkspaceSessions.set("workspace-running", [sharedSession(
      "legacy-workspace-running-7",
      "claude",
      "7",
    )]);
    saveTabs("workspace-running", [
      { id: 7, type: "claude", sessionId: "legacy-workspace-running-7" },
    ], 7);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const terminal = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]');
    expect(terminal?.dataset.sessionKey).toBe("7");

    await view.unmount();
  });

  it("opens a collaborator's shared session from a deep link without touching the shared record", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running?session=session-2");
    serverWorkspaceSessions.set("workspace-running", [
      sharedSession("session-1", "claude"),
      sharedSession("session-2", "terminal"),
    ]);
    saveTabs("workspace-running", [{ id: 1, type: "claude", sessionId: "session-1" }], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();
    await settle();

    const terminals = [...view.container.querySelectorAll<HTMLElement>(
      '[data-testid="terminal-session"]',
    )];
    expect(terminals.map((terminal) => terminal.dataset.sessionKey)).toEqual(["session-1", "session-2"]);
    expect(terminals.map((terminal) => terminal.dataset.active)).toEqual(["false", "true"]);
    // The link was consumed: a reload must not reopen it, and the shared
    // session itself was neither created nor modified — only this member's
    // own view gained a tab.
    expect(window.location.search).toBe("");
    expect(wire.createWorkspaceSession).not.toHaveBeenCalled();
    expect(wire.updateWorkspaceSession).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const saved = vi.mocked(wire.putWorkspaceWebAppState).mock.calls.at(-1)?.[1];
    expect(saved?.tabs.tabs.map((tab) => ("sessionId" in tab ? tab.sessionId : null)))
      .toEqual(["session-1", "session-2"]);

    await view.unmount();
  });

  it("refreshes the session registry when a deep link names a session created since load", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running?session=session-2");
    // The view response only knows session-1: session-2 was created by a
    // collaborator after this client last saved.
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-1", "claude")]);
    saveTabs("workspace-running", [{ id: 1, type: "claude", sessionId: "session-1" }], 1);
    const wire: ControlPlaneClient = {
      ...runningClient(),
      listWorkspaceSessions: vi.fn(async () => ({
        sessions: [sharedSession("session-1", "claude"), sharedSession("session-2", "terminal")],
      })),
    };
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();
    await settle();
    await settle();

    // The active-workspace registry poll may win the race with the deep-link
    // fallback; either path must discover the collaborator-created session.
    expect(wire.listWorkspaceSessions).toHaveBeenCalled();
    const terminals = [...view.container.querySelectorAll<HTMLElement>(
      '[data-testid="terminal-session"]',
    )];
    expect(terminals.map((terminal) => terminal.dataset.sessionKey)).toEqual(["session-1", "session-2"]);
    expect(window.location.search).toBe("");
    await view.unmount();
  });

  it("marks no rail session current while a file tab is in front", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-1", "claude")]);
    saveTabs("workspace-running", [
      { id: 1, type: "claude", sessionId: "session-1" },
      { id: 2, type: "file", filePath: "notes.md" },
    ], 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const row = view.container.querySelector<HTMLElement>('[data-rail-session-id="session-1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-current')).toBeNull();
    expect(row?.classList.contains('shell-s--on')).toBe(false);
    await view.unmount();
  });

  it("drops a personal-view tab when its shared session has been archived", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{
      id: 1,
      type: "terminal",
      sessionId: "archived-session",
    }], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('[data-testid="terminal-session"]')).toBeNull();

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
        resolver={standaloneResolver({ files: 7445 })}
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
          { files: 7445 },
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const activeTab = view.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    expect(activeTab?.textContent).toBe(":3000");
    expect(activeTab?.closest<HTMLElement>(".webapp-tab-cell")?.dataset.sessionId).toBe("2");
    await view.unmount();
  });

  /** The mobile sheet is the only way to reach Files, teenyapps and
   * Connections on a phone: there is no icon rail below the breakpoint. Its
   * segment cannot come from the tab model, because a panel tab that would be
   * the only tab collapses out of the side region, so reading that region
   * pinned the sheet to Files and the other two tabs did nothing. */
  it("switches the mobile drawer between all three sections", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);

    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // The statusline button is the way in.
    const drawerButton = view.container.querySelector<HTMLButtonElement>(
      ".webapp-statusline__files",
    );
    if (drawerButton === null) throw new Error("mobile has no drawer button");
    await act(async () => drawerButton.click());

    const drawer = view.container.querySelector<HTMLElement>("#webapp-workspace-drawer");
    if (drawer === null) throw new Error("mobile drawer did not render");
    const segment = (label: string) => [
      ...drawer.querySelectorAll<HTMLButtonElement>(".workspace-drawer-segments button"),
    ].find((button) => (button.textContent ?? "").includes(label));
    const selected = () => drawer
      .querySelector<HTMLElement>(".webapp-tab-cell--active")
      ?.textContent ?? "";

    expect(selected()).toContain("Files");

    for (const label of ["Connections", "teenyapps", "Files"]) {
      const tab = segment(label);
      if (tab === undefined) throw new Error(`no ${label} segment on mobile`);
      await act(async () => tab.click());
      expect(selected()).toContain(label);
    }

    await view.unmount();
  });

  it("retains visited terminal panes while hiding inactive panes", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "terminal" },
      { id: 2, type: "claude" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const terminal = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]')!;
    expect(view.container.querySelectorAll('[data-testid="terminal-session"]')).toHaveLength(1);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    const claude = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="2"]',
    )!;
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(true);
    expect(claude.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(false);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());
    expect(view.container.querySelector('[data-testid="terminal-session"]')).toBe(terminal);
    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="2"]',
    )).toBe(claude);
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(false);
    expect(claude.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(true);
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it("drops a stored legacy chat tab on read and offers no chat session type", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "chat", chatProvider: "claude", chatSessionId: "chat-one" },
      { id: 2, type: "terminal" },
    ], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('.webapp-tab-cell[data-session-id="1"]')).toBeNull();
    expect(view.container.querySelector('.webapp-tab-cell[data-session-id="2"]')).not.toBeNull();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-new-tab-spawn",
    )?.click());
    const actions = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-agent-menu [role='menuitem']",
    )].map(({ textContent }) => textContent?.trim());
    expect(actions).toEqual(["Claude", "Codex", "Terminal"]);
    // Dropping the record on read is not an edit: a plain load never echoes a
    // write that could outrank another account's newer save.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(wire.putWorkspaceWebAppState).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("keeps file tabs out of the workspace session rail", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    // The rail lists the workspace's shared sessions; file tabs are personal.
    serverWorkspaceSessions.set("workspace-running", [
      sharedSession("session-1", "claude"),
      sharedSession("session-2", "terminal"),
    ]);
    saveTabs("workspace-running", [
      { id: 1, type: "claude", sessionId: "session-1" },
      { id: 2, type: "terminal", sessionId: "session-2" },
      { id: 3, type: "file", filePath: "getting-started.md" },
    ], 3);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(railSessionLabels(view.container)).toEqual(["Claude", "Terminal"]);
    expect(view.container.querySelector('.webapp-tab-cell[data-session-id="3"]')).not.toBeNull();

    await view.unmount();
  });

  it("keeps the visible agent session highlighted when a side-pane file has focus", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [sharedSession("session-1", "claude")]);
    saveTabs("workspace-running", [
      { id: 1, type: "claude", sessionId: "session-1" },
      { id: 2, type: "file", filePath: "test1.md", region: "side" },
    ], 1, 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Workspace side pane sessions"] [role="tab"]',
    )?.click());
    const railAgent = railSession(view.container, "Claude");
    expect(railAgent?.getAttribute("aria-current")).toBe("page");
    expect(railSessionLabels(view.container)).toEqual(["Claude"]);

    await view.unmount();
  });

  it("keeps Rename as the only managed-session context action", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "claude", title: "Release work" },
      { id: 2, type: "terminal" },
    ], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const sessionCell = () => view.container.querySelector<HTMLElement>(
      ".webapp-tab-cell[data-session-id='1']",
    );
    await act(async () => sessionCell()?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const actions = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )].map(({ textContent }) => textContent);
    expect(actions).toEqual(["Rename"]);
    expect(view.container.querySelector("[aria-label='Archived sessions']")).toBeNull();
    await view.unmount();
  });

  it("closes the active session tab, ending it and removing its shared rail record", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    serverWorkspaceSessions.set("workspace-running", [
      sharedSession("session-t", "terminal"),
      sharedSession("session-c", "claude"),
    ]);
    saveTabs("workspace-running", [
      { id: 1, type: "terminal", sessionId: "session-t" },
      { id: 2, type: "claude", sessionId: "session-c" },
    ], 1);
    const wire = runningClient();
    const view = await render(
      <CloudApp
        client={wire}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const first = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="session-t"]',
    )!;
    const firstMountId = first.dataset.mountId;
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="2"] [role="tab"]',
    )?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      '.webapp-tab-cell[data-session-id="1"] [role="tab"]',
    )?.click());

    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="session-t"]',
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
    expect(wire.archiveWorkspaceSession)
      .toHaveBeenCalledWith("workspace-running", "session-t", 1);
    expect(railSessionLabels(view.container)).toEqual(["Claude"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs)
      .toEqual([{ id: 2, type: "claude", sessionId: "session-c" }]);

    await view.unmount();
  });

  it("uses the standard empty pane after every tab is closed", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close Terminal"]',
    )?.click());
    expect(view.container.textContent).toContain("Empty pane");
    expect(view.container.textContent).not.toContain("Resume your session");
    expect(view.container.textContent).not.toContain("Start a session");
    expect(railSessionLabels(view.container)).toEqual([]);
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // No rail, no split: one strip holding only the session tabs, with the
    // panel living in the drawer the mobile layout already had.
    expect(view.container.querySelector('[aria-label="Workspace panels"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Workspace side pane sessions"]')).toBeNull();
    expect([...view.container.querySelectorAll(
      '[aria-label="Workspace sessions"] .webapp-tab-cell',
    )]).toHaveLength(1);
    const drawer = view.container.querySelector('[aria-label="Workspace drawer"]')!;
    const segments = [...drawer.querySelectorAll('[role="tab"]')]
      .map((tab) => tab.textContent);
    expect(segments).toEqual(["Files", "teenyapps", "Connections"]);
    expect(drawer.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("teenyapps");

    await view.unmount();
  });

  it("closes mobile workspace navigation before showing workspace details", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const openNavigation = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open workspace navigation"]',
    );
    await act(async () => openNavigation?.click());
    expect(navigationExpanded(view.container)).toBe("true");

    const detailsButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace details for workspace-running-name"]',
    );
    await act(async () => detailsButton?.click());
    expect(navigationExpanded(view.container)).toBe("false");
    expect(view.container.querySelector('[role="dialog"][aria-label^="Workspace details for"]')).not.toBeNull();

    await view.unmount();
  });

  it("resizes the side pane by dragging its handle, no narrower than the default", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "terminal" },
      { id: 2, type: "panel", panel: "files", region: "side" },
    ], 1, 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const panes = view.container.querySelector<HTMLElement>(".webapp-panes")!;
    const width = () => panes.style.getPropertyValue("--side-pane-width");
    const handle = view.container.querySelector<HTMLElement>(".webapp-pane-resizer");
    expect(handle).not.toBeNull();
    expect(width()).toBe("340px");

    // Mouse events only: the drag must not depend on pointer capture.
    await act(async () => handle?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 800 }),
    ));
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 })));
    expect(width()).toBe("440px");
    // Dragging past the default width stops at the default.
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 1000 })));
    expect(width()).toBe("340px");
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { clientX: 1000 })));
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600 })));
    expect(width()).toBe("340px");
    await view.unmount();
  });

  it("splits the tab area from the right icon strip and collapses it again", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [{ id: 1, type: "terminal" }], 1);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('[aria-label="Workspace side pane sessions"]')).toBeNull();
    const filesIcon = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Workspace panels"] button[aria-label="Files"]',
    )!;
    await act(async () => filesIcon.click());

    const sideStrip = view.container.querySelector<HTMLElement>(
      '[aria-label="Workspace side pane sessions"]',
    );
    expect(sideStrip?.querySelector('[role="tab"]')?.textContent).toContain("Files");
    expect(filesIcon.getAttribute("aria-pressed")).toBe("true");

    // Clicking the same icon while its tab is in front closes the panel, and
    // the side pane goes with it.
    await act(async () => filesIcon.click());
    expect(view.container.querySelector('[aria-label="Workspace side pane sessions"]')).toBeNull();
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
        resolver={standaloneResolver({ files: 7445 })}
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
      '[aria-label="Workspace sessions"] .webapp-tab-cell[data-session-id="1"] [role="tab"]',
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
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const first = view.container.querySelector<HTMLElement>('[data-testid="terminal-session"]')!;
    const firstMountId = first.dataset.mountId;
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="workspace-two-name"]',
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
