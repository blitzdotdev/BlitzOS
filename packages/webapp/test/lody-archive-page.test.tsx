/**
 * THE ARCHIVE PAGE: the one place an archived session can be seen again.
 *
 * A session could already be archived from the header menu — the "Archive
 * chat?" confirm, verified on canary — and BlitzOS then had nowhere to LIST an
 * archived session, no way to restore one, and no way to delete one for good.
 * Upstream ships that page; our mount stubbed its address to `EmptyRoute` and
 * hid the rail entry that leads to it.
 *
 * WHAT IS UNDER TEST IS THE MOUNT, NOT THE PAGE. Every row, every dialog and
 * both verbs are upstream's (§0's vendor-wholesale rule), so this file drives
 * the REAL `ArchiveView` through the REAL route tree and stubs only the two data
 * hooks a daemon would fill and the two cloud hooks a local workspace has no
 * answer for. The daemon half — that restore really returns a session to the
 * rail and delete really removes it — is `lody-archive-lifecycle.test.ts`, which
 * needs a daemon and therefore skips in CI.
 *
 * THE V1 CUTS ARE ASSERTED BOTH WAYS, which is `lody-v1-scope.test.tsx`'s rule
 * and for its reason: a test that only checks "the badge is absent" also passes
 * when the row stopped rendering at all.
 */
import { act } from "react";
import { Provider as JotaiProvider, createStore } from "jotai";
import { I18nextProvider } from "react-i18next";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCapabilitySet } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { initLodyI18n } from "../src/lody/i18n";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";

const WORKSPACE_SLUG = "blitz";
const WORKSPACE_ID = "lw_archive";
const USER_ID = "local:archive-user";

/**
 * What the two stubbed hooks answer, HOISTED.
 *
 * One module graph for the whole file, for `lody-rail-groups.test.tsx`'s reason:
 * the vendored archive page pulls most of `@lody/components`, and a
 * `vi.resetModules()` per case re-transforms all of it until every case times
 * out on the import rather than on anything it asserts.
 */
const daemon = vi.hoisted(() => ({
  archived: [] as Record<string, unknown>[],
  restored: [] as string[],
  deleted: [] as string[],
}));

vi.mock("@lody/components/hooks/use-visible-session-metas", () => ({
  useVisibleArchivedSessionMetas: () => ({
    archivedSessions: daemon.archived,
    visibleMachineIds: new Set(["m-1"]),
    visibleLocalProjectKeys: new Set<string>(),
    isLoading: false,
  }),
}));

vi.mock("@lody/components/hooks/use-session-actions", () => ({
  useSessionActions: () => ({
    restoreSession: async (sessionId: string) => {
      daemon.restored.push(sessionId);
    },
    deleteArchivedSession: async (sessionId: string) => {
      daemon.deleted.push(sessionId);
    },
  }),
  isArchivedLocalProjectRestoreUnavailableError: () => false,
}));

/** The cloud half of the page. A local workspace has one member and no
 * organization document, so the avatar lookup finds nobody — which is what the
 * real composition does too, just after a round trip that has no server. */
vi.mock("@lody/components/hooks/useOrganization", () => ({
  useOrganization: () => ({ activeOrganization: null }),
}));

/** The machine Flock rows the page reads to label a local project. Stubbed
 * empty: what this file drives is the list, the restore and the delete, and a
 * flock read needs the runtime the daemon suite mounts. */
vi.mock("@lody/components/hooks/use-machine-flock-rows", () => ({
  useMachineFlockRowsByMachineIds: () => new Map(),
}));

/**
 * `createLodySessionRouter` is loaded LATE, on purpose.
 *
 * The route tree names `SessionDetail`, which pulls Monaco, which decides at
 * MODULE LOAD whether it can register its clipboard commands and throws under
 * jsdom without `document.queryCommandSupported`. A static import here would be
 * hoisted above `installLodyDomStubs()` and take the whole file down — the trap
 * `lody-agent-signin.test.tsx` and `lody-session-surface.test.tsx` document.
 */
let createLodySessionRouter: typeof import("../src/lody/router")["createLodySessionRouter"];
let userAtom: typeof import("@lody/components/atoms")["userAtom"];
beforeAll(async () => {
  installLodyDomStubs();
  ({ createLodySessionRouter } = await import("../src/lody/router"));
  ({ userAtom } = await import("@lody/components/atoms"));
}, 120_000);

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup !== null) await cleanup();
  cleanup = null;
  daemon.archived = [];
  daemon.restored = [];
  daemon.deleted = [];
});

/** One archived session, as the mirror holds it.
 *
 * `userId` is the viewer's, because the page's "my" scope filters on it — a
 * session belonging to somebody else is correctly invisible here, and a fixture
 * that forgot the field would test an empty list. */
function archivedSession(options: {
  id: string;
  title: string;
  repoFullName?: string;
  prUrl?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: options.id,
    title: options.title,
    userId: USER_ID,
    machineId: "m-1",
    isArchived: true,
    createdAt: 1_756_000_000_000,
    lastMessageAt: 1_756_000_000_000,
    agentType: "claude",
    cliType: "builtin",
  };
  if (options.repoFullName !== undefined) {
    meta.repoFullName = options.repoFullName;
    meta.branchName = "lody/probe";
  }
  if (options.prUrl !== undefined) {
    meta.pullRequests = [{ url: options.prUrl, status: "open" }];
  }
  return meta;
}

/** The platform the surface really mounts with: the LOCAL capability set, which
 * is empty. A case that wants the GitHub surfaces back names the capability. */
function platformWith(capabilities: readonly string[]) {
  return {
    kind: "local",
    identity: {
      session: { get: () => ({ status: "unauthenticated" }), subscribe: () => () => {} },
      signOut: async () => {},
    },
    workspaces: {
      state: {
        get: () => ({ status: "ready", workspaces: [], activeWorkspaceId: null }),
        subscribe: () => () => {},
      },
      setActive: async () => {},
    },
    capabilities: createCapabilitySet(capabilities),
    cloudApi: null,
    sync: { mode: "local" },
  };
}

/** The archive address, mounted through the real route tree. */
async function mountArchive(options: { capabilities?: readonly string[] } = {}) {
  const store = createStore();
  store.set(userAtom, { id: USER_ID, email: "local@lody.local", name: "You", image: null });
  const router = createLodySessionRouter(WORKSPACE_SLUG, { workspaceId: WORKSPACE_ID });
  await act(async () => {
    await router.navigate({
      to: "/$workspaceName/archive",
      params: { workspaceName: WORKSPACE_SLUG },
    });
  });
  const i18n = initLodyI18n();
  const mounted = await render(
    <JotaiProvider store={store}>
      <PlatformContext.Provider value={platformWith(options.capabilities ?? []) as never}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </PlatformContext.Provider>
    </JotaiProvider>,
  );
  await settle();
  cleanup = mounted.unmount;
  return { ...mounted, router };
}

const buttons = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>("button"),
];

const byLabel = (root: HTMLElement, label: string): HTMLButtonElement | undefined =>
  buttons(root).find((button) => button.getAttribute("aria-label") === label);

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

describe("the archive route", () => {
  it("mounts upstream's page, not the empty stub it used to resolve to", async () => {
    daemon.archived = [archivedSession({ id: "s-1", title: "an archived chat" })];
    const view = await mountArchive();

    // The address resolved to the archive leaf, not to a 404 and not to chat.
    expect(view.router.state.location.pathname).toBe(`/${WORKSPACE_SLUG}/archive`);
    // Their own page header. Before this change the leaf was `EmptyRoute`, so
    // the container was empty and this was the assertion that failed.
    expect(view.container.textContent).toContain("Archive");
    expect(view.container.textContent).toContain("an archived chat");
  });

  it("lists every archived session the mirror holds, grouped by project", async () => {
    daemon.archived = [
      archivedSession({ id: "s-1", title: "a plain chat" }),
      archivedSession({ id: "s-2", title: "a worktree session", repoFullName: "blitzdotdev/BlitzOS" }),
      archivedSession({ id: "s-3", title: "another worktree", repoFullName: "blitzdotdev/BlitzOS" }),
    ];
    const view = await mountArchive();

    const text = view.container.textContent ?? "";
    for (const title of ["a plain chat", "a worktree session", "another worktree"]) {
      expect(text, title).toContain(title);
    }
    // The repo heading is upstream's grouping, and it is the same split the rail
    // draws: `repoFullName` decides Chats from GitHub Worktrees.
    expect(text).toContain("blitzdotdev/BlitzOS");
  });

  it("says so honestly when nothing has been archived", async () => {
    const view = await mountArchive();
    expect(view.container.textContent).toContain("No archived sessions");
  });
});

describe("restore and permanent delete", () => {
  it("restores one session through the daemon's own session action", async () => {
    daemon.archived = [archivedSession({ id: "s-1", title: "an archived chat" })];
    const view = await mountArchive();

    const restore = byLabel(view.container, "Restore session");
    expect(restore, "the row's Restore control").toBeDefined();
    await click(restore!);

    // `restoreSession` is upstream's, and it clears `isArchived` on the session
    // document — so the rail, which lists exactly the un-archived sessions,
    // gets the row back. That half is asserted against a real daemon in
    // `lody-archive-lifecycle.test.ts`.
    expect(daemon.restored).toEqual(["s-1"]);
    expect(daemon.deleted, "restore deletes nothing").toEqual([]);
  });

  it("asks before it deletes, and deletes only after the confirmation", async () => {
    daemon.archived = [archivedSession({ id: "s-1", title: "an archived chat" })];
    const view = await mountArchive();

    await click(byLabel(view.container, "Delete permanently")!);
    // THE CLICK ALONE MUST NOT DELETE. This is the whole reason the assertion
    // is in two halves: a permanent delete has no undo, and the row's trash
    // icon sits one pixel from Restore.
    expect(daemon.deleted, "the trash icon only opens the dialog").toEqual([]);
    expect(document.body.textContent).toContain("Delete permanently?");

    // The dialog is a Radix portal, so it is on `document.body` rather than in
    // the mount's container.
    const confirm = buttons(document.body).find((button) => button.textContent === "Delete");
    expect(confirm, "the dialog's Delete button").toBeDefined();
    await click(confirm!);
    expect(daemon.deleted).toEqual(["s-1"]);
    expect(daemon.restored, "delete restores nothing").toEqual([]);
  });
});

describe("the v1 scope cuts on the archive page (seam patch 14)", () => {
  const PR_URL = "https://github.com/blitzdotdev/BlitzOS/pull/162";

  it("draws no pull-request badge, because the local platform has no GitHub App", async () => {
    daemon.archived = [
      archivedSession({
        id: "s-1",
        title: "a worktree session",
        repoFullName: "blitzdotdev/BlitzOS",
        prUrl: PR_URL,
      }),
    ];
    const view = await mountArchive();
    expect(view.container.innerHTML).not.toContain("text-github-open");
  });

  it("draws it again once the capability is granted, so the gate is the reason", async () => {
    daemon.archived = [
      archivedSession({
        id: "s-1",
        title: "a worktree session",
        repoFullName: "blitzdotdev/BlitzOS",
        prUrl: PR_URL,
      }),
    ];
    const view = await mountArchive({ capabilities: ["githubIntegration"] });
    expect(view.container.innerHTML).toContain("text-github-open");
  });

  it("offers no My Tasks / All Tasks scope control", async () => {
    daemon.archived = [archivedSession({ id: "s-1", title: "an archived chat" })];
    const view = await mountArchive();
    // A local workspace has exactly one member, so both entries would list the
    // same sessions. `lody-v1-scope-sources.test.ts` pins that `router.tsx` is
    // what passes the suppression.
    expect(view.container.textContent).not.toContain("My Tasks");
    expect(view.container.textContent).not.toContain("All Tasks");
  });
});
