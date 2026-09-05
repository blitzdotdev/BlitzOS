import type { WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudApp from "../src/CloudApp.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { standaloneResolver } from "../src/resolver.js";
import {
  decodeWorkspaceWebAppStateResponse,
  defaultWorkspaceFiles,
  defaultWorkspaceWebAppState,
  type WorkspaceWebAppStateV1,
} from "../src/storage.js";
import { deferred, render, settle } from "./dom.js";
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

/**
 * THE RAIL IS THE TAB LIST ON THIS BUILD.
 *
 * These cases run with `VITE_BLITZ_LODY_SESSIONS` off, and the native tab strip
 * they used to drive is deleted (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"). A
 * member selects a tab with a rail row and closes one with the `×` in that row's
 * trailing slot. The subjects below did not change — persistence, pane
 * retention, the rail's own record — only the control that reaches them.
 *
 * A ROW IS NO LONGER A BUTTON. It wraps two of them, so the row's own text is
 * the label plus the close glyph; the label is read from `.shell-s__t`.
 */
function railSessions(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label^="Sessions in "] .shell-s')];
}

function railSessionLabels(container: HTMLElement): string[] {
  return railSessions(container).map(
    (row) => row.querySelector(".shell-s__t")?.textContent ?? "",
  );
}

function railSession(container: HTMLElement, label: string): HTMLElement | undefined {
  return railSessions(container).find(
    (row) => row.querySelector(".shell-s__t")?.textContent === label,
  );
}

/* Org switching and creation live on Settings → Profile now that the strip
 * lost its org mark (owner annotation 2026-09-01). */
function createOrgButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(
    'section[aria-label="Organizations"] button',
  )].find((item) => item.textContent === "Create organization");
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
  }, {
    membership: { id: "membership-side", role: "member" as const, status: "active" as const },
    org: { id: "org-two", slug: "side", name: "Side", vmLimit: 10 },
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
  listAgentRules: vi.fn(async () => ({ rules: [] })),
  putAgentRule: vi.fn(async () => { throw new Error("unused"); }),
  deleteAgentRule: vi.fn(async () => undefined),
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
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
    getWorkspaceWebAppState: vi.fn(async (workspaceId) => decodeWorkspaceWebAppStateResponse(
      JSON.stringify({
        doc: serverWorkspaceStates.get(workspaceId) ?? null,
        updatedAt: serverWorkspaceStates.has(workspaceId) ? 1 : null,
      }),
    )),
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
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error("unused"); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listOrgCredentials: vi.fn(async () => ({ credentials: [] })),
    putOrgCredential: vi.fn(async () => { throw new Error("unused"); }),
    revokeOrgCredential: vi.fn(async () => undefined),
    replaceOrgCredentialGrants: vi.fn(async () => { throw new Error("unused"); }),
    importOrgCredentials: vi.fn(async () => ({ results: [], linesRead: 0 })),
    listGrantProposals: vi.fn(async () => ({ proposals: [] })),
    resolveGrantProposal: vi.fn(async () => { throw new Error("unused"); }),
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

type Rendered = { container: HTMLElement };

const railRow = (view: Rendered, id: string): HTMLButtonElement | null =>
  view.container.querySelector<HTMLButtonElement>(
    `.session-list .shell-s[data-session-id="${id}"] .shell-s__open`,
  );

const railClose = (view: Rendered, id: string): HTMLButtonElement | null =>
  view.container.querySelector<HTMLButtonElement>(
    `.session-list .shell-s[data-session-id="${id}"] .shell-s__close`,
  );

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

  it("renders the real workspace after /me", async () => {
    // The org name no longer prints in the shell chrome — since the strip
    // lost its org mark, it lives on Settings → Profile, which the
    // profile-panel test below pins.
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('button[aria-label="workspace-running-name"]')).not.toBeNull();
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

  it("restores identity-only organization creation with its draft after rejection", async () => {
    const creation = deferred<Awaited<ReturnType<ControlPlaneClient["createOrg"]>>>();
    const wire = {
      ...runningClient(),
      me: vi.fn(async () => ({ ...tenantMe, membership: null, org: null })),
      createOrg: vi.fn(() => creation.promise),
    };
    const view = await render(
      <CloudApp client={wire} resolver={standaloneResolver({ files: 7445 })} />,
    );
    await settle();

    const input = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
    await typeInto(input, "Personal lab");
    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect.soft(view.container.querySelector('[aria-label="Loading webApp"]')).not.toBeNull();
    expect.soft(view.container.querySelector('input[name="name"]')).toBeNull();

    await act(async () => creation.reject(new Error("create refused")));
    await settle();

    expect(view.container.querySelector<HTMLInputElement>('input[name="name"]')?.value)
      .toBe("Personal lab");
    expect(view.container.querySelector(".webapp-notice[role=alert]")?.textContent)
      .toContain("Could not create “Personal lab”: create refused");
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

  it("keeps the strip to workspace tiles: no org control outside settings", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    expect(view.container.querySelector('button[aria-label="Organization: Example"]')).toBeNull();
    expect(view.container.querySelector('[role="menu"][aria-label="Organizations"]')).toBeNull();
    await view.unmount();
  });

  it("signs out immediately, then restores the signed-in shell after a 500", async () => {
    const logout = deferred<void>();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), logout: vi.fn(() => logout.promise) }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const signOut = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Sign out");
    await click(signOut);

    expect.soft(view.container.querySelector('a[href="/auth/google/start"]')).not.toBeNull();
    expect.soft(view.container.querySelector('section[aria-label="Profile"]')).toBeNull();

    await act(async () => logout.reject(new ApiRequestError("logout refused", 500, null)));
    await settle();

    expect(view.container.querySelector('section[aria-label="Profile"]')).not.toBeNull();
    expect(view.container.querySelector(".webapp-notice[role=alert]")?.textContent)
      .toContain("Could not sign out: logout refused");
    await view.unmount();
  });

  it("keeps the optimistic signed-out shell when logout reports 401", async () => {
    const logout = deferred<void>();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), logout: vi.fn(() => logout.promise) }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const signOut = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Sign out");
    await click(signOut);
    expect.soft(view.container.querySelector('a[href="/auth/google/start"]')).not.toBeNull();

    await act(async () => logout.reject(new ApiRequestError("already signed out", 401, null)));
    await settle();

    expect(view.container.querySelector('a[href="/auth/google/start"]')).not.toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await view.unmount();
  });

  it("switches organization from the profile panel and reloads into it", async () => {
    const switchOrg = vi.fn(async () => undefined);
    const reload = stubReload();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), switchOrg }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // Where it sits, before what it does. The section is inside the Profile
    // panel, it is a `.cfg-section` beside another one so the settings system
    // draws its one divider, and its title is the `cfg-` heading rather than a
    // seventh treatment (settings-surface.css anchors 2 and 4).
    const profile = view.container.querySelector('section[aria-label="Profile"]');
    const organizations = profile?.querySelector('section[aria-label="Organizations"]');
    expect(organizations).not.toBeNull();
    expect(organizations?.classList.contains("cfg-section")).toBe(true);
    expect(organizations?.querySelector(".cfg-title")?.textContent).toBe("Organizations");
    expect(organizations?.previousElementSibling?.classList.contains("cfg-section")).toBe(true);

    const rows = organizations!.querySelectorAll("article");
    expect([...rows].map((row) => row.querySelector("h3")?.textContent)).toEqual(["Example", "Side"]);
    expect(rows[0]?.textContent).toContain("current");

    const switchButton = [...rows[1]!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Switch");
    await click(switchButton);
    await settle();

    expect(switchOrg).toHaveBeenCalledWith("org-two");
    expect(reload).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("restores the previous organization when a switch is rejected", async () => {
    const switching = deferred<void>();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), switchOrg: vi.fn(() => switching.promise) }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const sideRow = [...view.container.querySelectorAll<HTMLElement>(
      'section[aria-label="Organizations"] article',
    )].find((row) => row.querySelector("h3")?.textContent === "Side");
    await click(sideRow?.querySelector<HTMLButtonElement>("button"));

    expect.soft(view.container.querySelector('[aria-label="Loading webApp"]')).not.toBeNull();
    expect.soft(view.container.querySelector('section[aria-label="Profile"]')).toBeNull();

    await act(async () => switching.reject(new Error("switch refused")));
    await settle();

    const organizations = view.container.querySelector('section[aria-label="Organizations"]');
    expect(organizations?.querySelector("article")?.textContent).toContain("Example");
    expect(view.container.querySelector(".webapp-notice[role=alert]")?.textContent)
      .toContain("Could not switch to “Side”: switch refused");
    await view.unmount();
  });

  it("creates a second organization from the profile panel", async () => {
    const createOrg = vi.fn(async () => ({
      org: { id: "org-two", slug: "side", name: "Side", vmLimit: 10 },
      membership: { id: "membership-two", role: "admin" as const, status: "active" as const },
    }));
    const reload = stubReload();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), createOrg }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    const create = createOrgButton(view.container);
    expect(create).not.toBeUndefined();
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

  it("restores the create-organization dialog with its draft after rejection", async () => {
    const creation = deferred<Awaited<ReturnType<ControlPlaneClient["createOrg"]>>>();
    window.history.replaceState({}, "", "/settings");
    const view = await render(
      <CloudApp
        client={{ ...runningClient(), createOrg: vi.fn(() => creation.promise) }}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    await click(createOrgButton(view.container));
    const dialog = document.querySelector<HTMLElement>('[aria-label="Create organization"]')!;
    await typeInto(dialog.querySelector<HTMLInputElement>('input[name="name"]')!, "Side project");
    await act(async () => {
      dialog.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect.soft(view.container.querySelector('[aria-label="Loading webApp"]')).not.toBeNull();
    expect.soft(document.querySelector('[aria-label="Create organization"]')).toBeNull();

    await act(async () => creation.reject(new Error("create refused")));
    await settle();

    const restored = document.querySelector<HTMLElement>('[aria-label="Create organization"]');
    expect(restored?.querySelector<HTMLInputElement>('input[name="name"]')?.value)
      .toBe("Side project");
    expect(view.container.querySelector(".webapp-notice[role=alert]")?.textContent)
      .toContain("Could not create “Side project”: create refused");
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

  it("restores the previous organization when leaving is rejected", async () => {
    const leaving = deferred<void>();
    window.history.replaceState({}, "", "/settings/members");
    const view = await render(
      <CloudApp
        client={{
          ...runningClient(),
          leaveOrg: vi.fn(() => leaving.promise),
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

    await click(leaveButton(view.container));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(
      ".webapp-confirmation-actions button",
    )].find((button) => button.textContent === "Yes, leave");
    await click(confirm);

    expect.soft(view.container.querySelector('[aria-label="Loading webApp"]')).not.toBeNull();
    expect.soft(view.container.querySelector('section[aria-label="Members"]')).toBeNull();

    await act(async () => leaving.reject(new Error("leave refused")));
    await settle();

    expect(view.container.querySelector('section[aria-label="Members"]')?.textContent)
      .toContain("Leave Example");
    expect(view.container.querySelector(".webapp-notice[role=alert]")?.textContent)
      .toContain("Could not leave “Example”: leave refused");
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

    expect(railSessionLabels(view.container)).toEqual(["Terminal"]);
    // The rail's `+` is the only spawn affordance left, in both its shapes.
    expect(view.container.querySelector('button[aria-label="New tab"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Loading workspace"]')).toBeNull();
    expect(serverWorkspaceStates.get("workspace-running")?.tabs).toEqual({
      version: 1,
      tabs: [{ id: 1, type: "terminal" }],
      activeId: 1,
      nextId: 2,
    });
    await view.unmount();
  });

  it("does not re-send the shared doc when the workspace poll re-renders it", async () => {
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

    // The default tab set is Claude alone in the main pane (the Files panel
    // that used to ride in the side pane is retired). Remote control runs
    // detached with no tab of its own, so there is no default terminal tab
    // any more.
    const sessionTabs = railSessionLabels(view.container);
    expect(sessionTabs).toHaveLength(1);
    expect(sessionTabs[0] ?? "").toMatch(/claude/i);
    expect(vi.mocked(wire.putWorkspaceWebAppState)).not.toHaveBeenCalled();
    expect(serverWorkspaceStates.size).toBe(0);

    await view.unmount();
  });

  it("routes workspace files through the control plane", async () => {
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

    // A preview is not a rail session and there is no strip to name it in, so
    // what says it is the active tab is the pane that draws it: tab 2's body is
    // the visible one and tab 1's is hidden behind it.
    const panes = [...view.container.querySelectorAll<HTMLElement>(".webapp-workspace-session")];
    const visible = panes.filter((pane) => !pane.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.querySelector("iframe")?.getAttribute("title") ?? "")
      .toContain("3000");
    await view.unmount();
  });

  /** THE MOBILE SHEET IS GONE WITH CONNECTIONS. It hosted one section, and a
   * workspace's connections are a tab of the workspace-details dialog now —
   * reachable on a phone from the rail's workspace row, the same as on the
   * desktop. So the statusline keeps the terminal controls and nothing else. */
  it("draws no connections sheet and no statusline button for one on mobile", async () => {
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

    expect(view.container.querySelector(".webapp-statusline__files")).toBeNull();
    expect(view.container.querySelector("#webapp-workspace-drawer")).toBeNull();
    expect(view.container.querySelector(".files-drawer-scrim")).toBeNull();
    // The statusline itself stays: it is the touch terminal's chrome.
    expect(view.container.querySelector(".webapp-statusline")).not.toBeNull();

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

    await act(async () => railRow(view, "2")?.click());
    const claude = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="2"]',
    )!;
    expect(terminal.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(true);
    expect(claude.closest<HTMLElement>(".webapp-workspace-session")?.hidden).toBe(false);

    await act(async () => railRow(view, "1")?.click());
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

    expect(railRow(view, "1")).toBeNull();
    expect(railRow(view, "2")).not.toBeNull();
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="New tab"]',
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

  it("keeps preview tabs out of the workspace session rail", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "claude" },
      { id: 2, type: "terminal" },
      { id: 3, type: "preview", port: 3000 },
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
    // The file tab is still OPEN — it is just not a rail session. Its pane body
    // is where it lives now that there is no strip to list it in.
    expect(railRow(view, "3")).toBeNull();
    expect(view.container.querySelector('.webapp-workspace-session[data-region="main"]'))
      .not.toBeNull();

    await view.unmount();
  });

  it("keeps the visible agent session highlighted when a side-pane preview has focus", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs("workspace-running", [
      { id: 1, type: "claude" },
      { id: 2, type: "preview", port: 3000, region: "side" },
    ], 1, 2);
    const view = await render(
      <CloudApp
        client={runningClient()}
        resolver={standaloneResolver({ files: 7445 })}
      />,
    );
    await settle();
    await settle();

    // The side pane's own strip is deleted with the main one, so the file tab
    // is simply the side pane's active tab, which is how it was stored.
    const railAgent = railSession(view.container, "Claude");
    expect(railAgent?.getAttribute("aria-current")).toBe("page");
    expect(railSessionLabels(view.container)).toEqual(["Claude"]);

    await view.unmount();
  });


  it("closes the active session tab and removes its workspace-rail record", async () => {
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

    const first = view.container.querySelector<HTMLElement>(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )!;
    const firstMountId = first.dataset.mountId;
    await act(async () => railRow(view, "2")?.click());
    await act(async () => railRow(view, "1")?.click());

    expect(view.container.querySelector(
      '[data-testid="terminal-session"][data-session-key="1"]',
    )).toBe(first);
    expect(first.dataset.mountId).toBe(firstMountId);
    expect(webAppHarness.mounts).toHaveBeenCalledTimes(2);

    // THE CLOSE MOVED TO THE ROW. `WebAppHeader`'s `×` was the only one there
    // was, and it is deleted with the strip; without a replacement a member
    // could open a terminal and never end its tmux session.
    await act(async () => railClose(view, "1")?.click());
    expect(first.isConnected).toBe(false);
    expect(webAppHarness.unmounts).toHaveBeenCalledWith("terminal", firstMountId);
    expect(view.container.querySelectorAll('[data-testid="terminal-session"]')).toHaveLength(1);
    expect(railRow(view, "1")).toBeNull();
    expect(railSessionLabels(view.container)).toEqual(["Claude"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(serverWorkspaceStates.get("workspace-running")?.tabs.tabs)
      .toEqual([{ id: 2, type: "claude" }]);

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

  it("keeps one tab strip and no panel pane on mobile", async () => {
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
        { id: 2, type: "panel", panel: "connections", region: "side" },
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

    // No rail, no split, and no strip at all: the native one is deleted
    // (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"). The session lives in the
    // rail inside the navigation drawer.
    expect(view.container.querySelector('[aria-label="Workspace panels"]')).toBeNull();
    expect(view.container.querySelector(".webapp-tabstrip")).toBeNull();
    expect(view.container.querySelector(".webapp-pane-strip")).toBeNull();
    expect(railSessionLabels(view.container)).toHaveLength(1);
    // A `panel` tab a layout persisted before connections left the panes is
    // filtered out below the breakpoint, exactly as it always was, and the
    // sheet that used to host one is gone.
    expect(view.container.querySelector('[aria-label="Workspace drawer"]')).toBeNull();

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
      { id: 2, type: "panel", panel: "connections", region: "side" },
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

  /** THE STRIP OPENS NO PANE. Connections was the one panel it ever put in the
   * side column, and it is a tab of the workspace-details dialog now; the four
   * buttons left are panels of a SESSION, which Lody's own side panel hosts.
   * What survives is the split as a PLACEMENT: a `panel` tab a layout
   * persisted before the change still lands in the second column. */
  it("keeps a persisted panel tab in the side pane and offers no strip button for one", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    saveTabs(
      "workspace-running",
      [
        { id: 1, type: "terminal" },
        { id: 2, type: "panel", panel: "connections", region: "side" },
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

    // The split is a PLACEMENT now: the per-pane strips are deleted
    // (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"), so what says the side pane
    // opened is the pane itself, not a second strip.
    expect(view.container.querySelector<HTMLElement>(
      '.webapp-workspace-session[data-region="side"]',
    )).not.toBeNull();
    expect(view.container.querySelector(".webapp-panes--split")).not.toBeNull();
    // And nothing on the strip can make another one.
    const strip = view.container.querySelector('[aria-label="Workspace panels"]');
    expect(strip).not.toBeNull();
    expect(strip?.querySelector('button[aria-label="Connections"]')).toBeNull();
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

/**
 * THE 409 ON OPEN (Brandon, 2026-09-03).
 *
 * The control plane projects a member's STOPPED machine as workspace phase
 * `ready`, and the shell read `ready` as running: it dialled the box for the
 * terminal, the capability probe and every poller, and each call answered 409
 * "your machine in this workspace is not running". The workspace opened to a
 * spinner over a wall of refusals, and the only way out was the "My machine"
 * dialog. Now the viewer's own row in `members` decides, the shell dials
 * nothing, and the main pane offers Start.
 */
describe("a workspace whose own machine is stopped", () => {
  const stoppedMine: WorkspaceView = workspaceViewFixture({
    id: "workspace-stopped",
    name: "workspace-stopped-name",
    phase: "ready",
    members: [{
      membershipId: "membership-one",
      name: "Person",
      avatarUrl: null,
      role: "member",
      machine: {
        id: "machine-one",
        state: "stopped",
        machineTypeId: "cx23@fsn1",
        volumeId: "volume-one",
        volumeUsedPercent: null,
        membershipId: "membership-one",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
    }],
  });
  const startedMine: WorkspaceView = {
    ...stoppedMine,
    phase: "creating",
    retryAction: "poll",
    members: [{
      ...stoppedMine.members[0]!,
      machine: { ...stoppedMine.members[0]!.machine!, state: "provisioning" },
    }],
  };

  it("dials no box, offers Start, and starts the viewer's own machine", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-stopped");
    const wire = {
      ...client(),
      me: vi.fn(async () => tenantMe),
      poll: vi.fn(async () => ({ workspaces: [stoppedMine] })),
      startMachine: vi.fn(async () => ({ machine: startedMine.members[0]!.machine! })),
    };
    const view = await render(
      <CloudApp client={wire} resolver={standaloneResolver({ files: 7445 })} />,
    );
    await settle();
    await settle();

    const start = view.container.querySelector<HTMLButtonElement>(
      ".workspace-stopped-state button",
    );
    expect(start?.textContent).toBe("Start machine");
    expect(view.container.textContent).toContain("is stopped");
    // Nothing reached for the box: no terminal, no probe, no port poll.
    const boxCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).includes("/webapp/"),
    );
    expect(boxCalls).toEqual([]);

    // Start is the member's own verb, and the refresh is what moves the pane
    // on: the record comes back `creating` and the loading pane takes over.
    wire.poll.mockResolvedValue({ workspaces: [startedMine] });
    await click(start);
    await settle();
    await settle();
    expect(wire.startMachine).toHaveBeenCalledWith("machine-one");
    expect(view.container.querySelector(".workspace-stopped-state")).toBeNull();
    // The loading pane names the phase in its label and the stage in its text.
    // The loading pane prints its stage; "Creating workspace" is only its label.
    expect(view.container.textContent).toContain("allocating · cx23@fsn1");
    expect(view.container.textContent).toContain("allocating ·");
    await view.unmount();
  });
});

const workspaceCreateMachine = {
  id: "cx23@fsn1",
  providerId: "hetzner",
  supportsVolumes: true,
  name: "CX23",
  cpuCores: 2,
  memGb: 4,
  diskGb: 40,
  arch: "x86" as const,
  location: "fsn1",
  monthlyPrice: { amount: 6.49, currency: "USD" },
};

async function submitWorkspaceCreate(view: Rendered, name: string): Promise<void> {
  if (view.container.querySelector('form[aria-label="Create workspace"]') === null) {
    await click(view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Create workspace"]',
    ));
  }
  await settle();
  await settle();
  const form = view.container.querySelector<HTMLFormElement>(
    'form[aria-label="Create workspace"]',
  );
  if (form === null) throw new Error("create workspace form did not open");
  await typeInto(form.querySelector<HTMLInputElement>('input[name="name"]')!, name);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe("optimistic workspace creation", () => {
  it("closes the dialog and shows an active loading rail entry before create resolves", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const creation = deferred<{ workspace: WorkspaceView }>();
    const wire = {
      ...runningClient(),
      create: vi.fn(() => creation.promise),
      listMachineTypes: vi.fn(async () => ({
        machineTypes: [workspaceCreateMachine],
        failures: [],
      })),
    };
    const view = await render(
      <CloudApp client={wire} resolver={standaloneResolver({ files: 7445 })} />,
    );
    await settle();
    await settle();

    await submitWorkspaceCreate(view, "Draft workspace");

    expect(wire.create).toHaveBeenCalledWith({
      defaultMachineTypeId: "cx23@fsn1",
      name: "Draft workspace",
    });
    expect(view.container.querySelector('form[aria-label="Create workspace"]') === null).toBe(true);
    const tile = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Draft workspace"]',
    );
    expect(tile?.getAttribute("aria-current")).toBe("page");
    expect(view.container.querySelector('[role="status"][aria-label="Creating workspace"]'))
      .not.toBeNull();
    expect(window.location.pathname).toMatch(
      /^\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await view.unmount();
  });

  it("replaces the placeholder and route without persisting or retaining its id", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const creation = deferred<{ workspace: WorkspaceView }>();
    const putGlobalWebAppState = vi.fn(async (doc) => ({ doc, updatedAt: 1 }));
    const getWorkspaceWebAppState = vi.fn(async (workspaceId: string) => (
      decodeWorkspaceWebAppStateResponse(JSON.stringify({
        doc: serverWorkspaceStates.get(workspaceId) ?? null,
        updatedAt: null,
      }))
    ));
    const baseResolver = standaloneResolver({ files: 7445 });
    const resolve = vi.fn(baseResolver.resolve);
    const wire = {
      ...runningClient(),
      create: vi.fn(() => creation.promise),
      listMachineTypes: vi.fn(async () => ({
        machineTypes: [workspaceCreateMachine],
        failures: [],
      })),
      putGlobalWebAppState,
      getWorkspaceWebAppState,
    };
    const view = await render(<CloudApp client={wire} resolver={{ ...baseResolver, resolve }} />);
    await settle();
    await settle();

    await submitWorkspaceCreate(view, "Draft workspace");
    const temporaryId = decodeURIComponent(window.location.pathname.split("/").at(-1)!);
    const historyLength = window.history.length;
    await act(async () => new Promise((resolveWait) => setTimeout(resolveWait, 200)));
    const canonical = workspaceViewFixture({
      id: "workspace-canonical",
      name: "Canonical workspace",
      phase: "creating",
      retryAction: "poll",
      ownerMembershipId: "membership-one",
      members: [],
    });
    await act(async () => creation.resolve({ workspace: canonical }));
    await settle();
    await act(async () => new Promise((resolveWait) => setTimeout(resolveWait, 200)));

    expect(view.container.querySelector('button[aria-label="Draft workspace"]')).toBeNull();
    const canonicalTile = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Canonical workspace"]',
    );
    expect(canonicalTile?.getAttribute("aria-current")).toBe("page");
    expect(window.location.pathname).toBe("/workspaces/workspace-canonical");
    expect(window.history.length).toBe(historyLength);
    expect(getWorkspaceWebAppState).toHaveBeenCalledWith("workspace-canonical");
    expect(putGlobalWebAppState.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      activeWorkspaceId: "workspace-canonical",
      order: ["workspace-canonical", "workspace-running"],
    });
    const observableState = JSON.stringify({
      html: view.container.innerHTML,
      globalWrites: putGlobalWebAppState.mock.calls,
      workspaceReads: getWorkspaceWebAppState.mock.calls,
      workspaceWrites: vi.mocked(wire.putWorkspaceWebAppState).mock.calls,
      localStorage: [...deviceStorageValues],
      workspaceDocuments: [...serverWorkspaceStates],
      resolvedRecords: resolve.mock.calls,
    });
    expect(observableState).not.toContain(temporaryId);
    await view.unmount();
  });

  it("removes a rejected placeholder and raises the failure outside the closed dialog", async () => {
    window.history.replaceState({}, "", "/workspaces/workspace-running");
    const creation = deferred<{ workspace: WorkspaceView }>();
    const wire = {
      ...runningClient(),
      create: vi.fn(() => creation.promise),
      listMachineTypes: vi.fn(async () => ({
        machineTypes: [workspaceCreateMachine],
        failures: [],
      })),
    };
    const view = await render(
      <CloudApp client={wire} resolver={standaloneResolver({ files: 7445 })} />,
    );
    await settle();
    await settle();
    await submitWorkspaceCreate(view, "Rejected workspace");

    await act(async () => creation.reject(new Error("capacity exhausted")));
    await settle();

    expect(view.container.querySelector('button[aria-label="Rejected workspace"]')).toBeNull();
    expect(view.container.querySelector('form[aria-label="Create workspace"]') === null).toBe(true);
    const alert = view.container.querySelector<HTMLElement>(".webapp-notice[role=alert]");
    expect(alert?.textContent).toContain(
      "Could not create “Rejected workspace”: capacity exhausted",
    );
    await view.unmount();
  });

  it("replaces a failed first-workspace route with a route that exists", async () => {
    const creation = deferred<{ workspace: WorkspaceView }>();
    const wire = {
      ...client(),
      me: vi.fn(async () => tenantMe),
      poll: vi.fn(async () => ({ workspaces: [] })),
      create: vi.fn(() => creation.promise),
      listMachineTypes: vi.fn(async () => ({
        machineTypes: [workspaceCreateMachine],
        failures: [],
      })),
    };
    const view = await render(
      <CloudApp client={wire} resolver={standaloneResolver({ files: 7445 })} />,
    );
    await settle();
    await settle();
    await submitWorkspaceCreate(view, "Only workspace");
    expect(view.container.querySelector('[role="status"][aria-label="Creating workspace"]'))
      .not.toBeNull();
    expect(window.location.pathname).toMatch(
      /^\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await act(async () => creation.reject(new Error("create failed")));
    await settle();

    expect(window.location.pathname).toBe("/");
    expect(view.container.querySelector('button[aria-label="Only workspace"]')).toBeNull();
    expect(view.container.querySelector('[aria-current="page"].shell-wtile')).toBeNull();
    expect(view.container.querySelector(".webapp-notice[role=alert]")).not.toBeNull();
    await view.unmount();
  });
});
