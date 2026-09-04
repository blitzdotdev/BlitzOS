/**
 * THE RAIL'S GROUPS: WHERE A SESSION FILES, AND WHAT ITS HEADING CAN DO.
 *
 * Five findings of the canary QA sweep, one surface. All five are about the
 * SessionList groups the rail draws, and none of them needed a new component:
 * four are props `SessionRailSidebar` did not pass, and the fifth is the one
 * vendor hunk (declared seam #9) that lets a row draw a glyph it already
 * carries the data for.
 *
 * | id | the sweep saw | what it was |
 * |---|---|---|
 * | RAIL-1 / WT-TERM-1 | a worktree session under "Chats" | `githubRepoFullName` never written (`workdir-default.ts` §2b, pinned by `lody-session-workdir.test.ts`) |
 * | WT-TERM-2 | 0 `[aria-label="Worktree"]` nodes, ever | `SessionList` never rendered `SessionRowWorktreeIndicator` |
 * | RAIL-2 | the Chats header navigates instead of collapsing | the rail passed `onNavigateToNewSession` to the chats list, and upstream prefers it over the toggle (`session-list.tsx:689`) |
 * | RAIL-4 | no "+" on a repo heading | `onNew` was never passed |
 * | RAIL-3 | no drag handle on a repo heading | `onMoveRepo` was never passed |
 *
 * DAEMON-FREE, AND THE COMPONENTS ARE REAL. `lody-session-rail.test.tsx` needs
 * a daemon because it drives the real session mirror; what is under test here
 * is the wiring between this rail and the vendored `SessionList`, so the two
 * DATA hooks are stubbed and everything that draws — `LoroSidebar`,
 * `SessionList`, the group header, the row — is the vendored tree itself. A
 * test that re-implemented the header could not have caught any of the five,
 * because in every one of them the header was upstream's and correct.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, settle } from "./dom.js";
import { repoRoot } from "./lody-daemon-harness.js";

/**
 * The mirror one case wants the rail to read.
 *
 * HOISTED, and the module graph is imported ONCE for the whole file. The
 * vendored sidebar pulls in most of `@lody/components`; a `vi.resetModules()`
 * per case re-transforms all of it and every case then times out on the
 * import rather than on anything it asserts.
 */
const mirror = vi.hoisted(() => ({ sessions: [] as Record<string, unknown>[] }));
/** Every session id the rail asked the (mocked) session actions to archive. */
const actions = vi.hoisted(() => ({ archived: [] as string[] }));

vi.mock("@lody/components/hooks/use-visible-session-metas", () => ({
  useVisibleSessionMetas: () => ({
    sessions: mirror.sessions,
    allActiveSessions: mirror.sessions,
    visibleMachineIds: new Set(["m-1"]),
    visibleLocalProjectKeys: new Set<string>(),
    isLoading: false,
  }),
}));

vi.mock("@lody/components/hooks/use-session-actions", () => ({
  useSessionActions: () => ({
    updateSessionTitle: async () => {},
    archiveSession: async (sessionId: string) => {
      actions.archived.push(sessionId);
    },
    setSessionPinned: () => {},
  }),
}));

import { runtimeAtom } from "@lody/components/atoms/runtime";
import { currentWorkspaceIdAtom } from "@lody/components/atoms/workspace-context";
import { userAtom } from "@lody/components/atoms";
import { repoOrderAtom, setRepoOrderAtom } from "@lody/components/atoms/sidebar-state";
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from "@lody/components/atoms/presence";
import { LodyFixtureProviders } from "./lody-fixture-surface.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { SessionRailSidebar } from "../src/lody/SessionRailSidebar.js";

// `use-mobile.ts` calls `window.matchMedia` in an effect, and jsdom has none.
installLodyDomStubs();

/** `ONLY_CHATS_KEY` (`session-list.tsx`), the group key `buildGroups` gives the
 * chat section. The sweep reported it by this name. */
const CHATS_GROUP_KEY = "__only_chats__";
const WORKSPACE_ID = "lw_1";
const USER_ID = "u-1";
const MACHINE_ID = "m-1";
const REPO = "blitzdotdev/BlitzOS";
const OTHER_REPO = "blitzdotdev/lody-box";

afterEach(() => {
  mirror.sessions = [];
  window.localStorage.clear();
});

/**
 * One session meta, as the mirror holds it.
 *
 * `project.githubRepoFullName` is the whole of RAIL-1: `buildSessionListRows`
 * reads a row's `repoFullName` through `resolveProjectGitHubRepo`
 * (`shared/src/project.ts`), which for a `local` ref reads exactly that field.
 * A session that lacks it groups under Chats no matter which clone it runs in.
 */
function sessionMeta(options: {
  id: string;
  title: string;
  repoFullName?: string;
  isWorktree?: boolean;
  lastMessageAt?: number;
}): Record<string, unknown> {
  const project: Record<string, unknown> = {
    kind: "local",
    localProjectId: options.repoFullName === undefined ? "local-workspace" : "local-repo",
  };
  if (options.repoFullName !== undefined) {
    project.githubRepoFullName = options.repoFullName;
    project.useWorktree = true;
    project.branch = "main";
  }
  return {
    id: options.id,
    title: options.title,
    machineId: MACHINE_ID,
    userId: USER_ID,
    createdAt: 1,
    lastMessageAt: options.lastMessageAt ?? 2,
    isWorktree: options.isWorktree ?? false,
    project,
  };
}

const CHAT_SESSION = sessionMeta({ id: "s-chat", title: "a plain chat" });
const WORKTREE_SESSION = sessionMeta({
  id: "s-worktree",
  title: "a worktree session",
  repoFullName: REPO,
  isWorktree: true,
  lastMessageAt: 4,
});
/** Repo-backed and NOT in a worktree — the row that proves the glyph is a
 * statement about the session rather than about the group it sits in. */
const SHARED_DIR_SESSION = sessionMeta({
  id: "s-shared-dir",
  title: "a session in the clone itself",
  repoFullName: REPO,
  lastMessageAt: 3,
});
const OTHER_REPO_SESSION = sessionMeta({
  id: "s-other-repo",
  title: "a second repository",
  repoFullName: OTHER_REPO,
  isWorktree: true,
});

interface RailMount {
  container: HTMLElement;
  /** Every landing open the rail asked for, newest last. */
  landings: number;
  store: ReturnType<typeof createStore>;
  unmount(): Promise<void>;
}

/**
 * The real `SessionRailSidebar`, with the mirror and the session mutations
 * stubbed and nothing else.
 *
 * `useVisibleSessionMetas` is the runtime's session mirror and
 * `useSessionActions` is a Convex mutation pair; neither is reachable without a
 * daemon and neither is under test. The two atoms the rail reads are set the
 * way `SessionSurface` sets them in production: `runtimeAtom` plus
 * `currentWorkspaceIdAtom` is what makes `activeWorkspaceRuntimeAtom` resolve
 * `ready` (`atoms/runtime.ts:507`), and it is also what scopes `repoOrderAtom`.
 */
/** One `session` presence entry, as the presence room holds it
 * (`shared/src/presence.ts:18`): the owning machine's heartbeat for a session
 * with a live status, fresh for `LODY_PRESENCE_TTL_MS` (90 s). */
function sessionPresence(sessionId: string, updatedAt: number, statusType = "working") {
  return {
    kind: "session",
    sessionId,
    machineId: MACHINE_ID,
    instanceId: `presence-${sessionId}`,
    status: { type: statusType },
    updatedAt,
  };
}

async function mountRail(options: {
  sessions: Record<string, unknown>[];
  repoOrder?: string[];
  /** The session the surface is showing, as the shell reports it. */
  activeSessionId?: string;
  /** The presence room's `session` entries and the clock they are judged
   * against, exactly the two atoms upstream's sidebar reads for its spinner. */
  presence?: { states: Record<string, ReturnType<typeof sessionPresence>>; nowMs: number };
}): Promise<RailMount> {
  mirror.sessions = options.sessions;

  const store = createStore();
  store.set(runtimeAtom, { workspaceId: WORKSPACE_ID });
  store.set(currentWorkspaceIdAtom, WORKSPACE_ID);
  store.set(userAtom, { id: USER_ID });
  if (options.repoOrder !== undefined) store.set(setRepoOrderAtom, options.repoOrder);
  if (options.presence !== undefined) {
    store.set(lodyPresenceStatesAtom, options.presence.states);
    store.set(lodyPresenceNowMsAtom, options.presence.nowMs);
  }

  const mount: RailMount = {
    container: document.createElement("div"),
    landings: 0,
    store,
    unmount: async () => {},
  };
  const view = await render(
    <JotaiProvider store={store}>
      <LodyFixtureProviders>
        {/* The class the rail's portal host carries in production
            (`strip-rail.css:306`). */}
        <div className="session-list session-list--vendor">
          <SessionRailSidebar
            activeSessionId={options.activeSessionId ?? null}
            surfaceVisible
            onSelectSession={() => {}}
            onOpenLanding={() => {
              mount.landings += 1;
            }}
          />
        </div>
      </LodyFixtureProviders>
    </JotaiProvider>,
  );
  await settle();
  mount.container = view.container;
  mount.unmount = view.unmount;
  return mount;
}

/** A group heading, by the key `buildGroups` gave it: a repo's own full name,
 * or `__only_chats__`. This is the CLICKABLE element — the row's `+` is its
 * sibling, so `headerRow` is what holds both. */
function groupHeader(container: HTMLElement, key: string): HTMLElement {
  const header = container.querySelector<HTMLElement>(`[data-sidebar-group-key="${key}"]`);
  if (header === null) throw new Error(`no group header for ${key}`);
  return header;
}

/** The whole heading line: the clickable label, then the trailing controls
 * (`session-list.tsx:662`). */
function headerRow(container: HTMLElement, key: string): HTMLElement {
  const parent = groupHeader(container, key).parentElement;
  if (parent === null) throw new Error(`no heading row for ${key}`);
  return parent;
}

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

/** Archive a row through ITS OWN context menu and upstream's own "Archive
 * chat?" confirmation — the affordance a member uses, not a call of ours. */
async function archiveFromRow(row: HTMLElement): Promise<void> {
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  });
  await settle();
  const entry = await until("the Archive entry in the row menu", () =>
    [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((node) =>
      /archive/iu.test(node.textContent ?? ""),
    ),
  );
  await click(entry);
  const confirm = await until("the archive confirmation", () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      /^archive$/iu.test(button.textContent ?? ""),
    ),
  );
  await click(confirm);
}

function sessionRow(container: HTMLElement, sessionId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-sidebar-session-id="${sessionId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

describe("where a session files (RAIL-1, WT-TERM-1)", () => {
  it("puts a session that names a repository under that repository's heading", async () => {
    const mount = await mountRail({ sessions: [CHAT_SESSION, WORKTREE_SESSION] });

    // The defect the sweep saw was the OPPOSITE of this: `s-worktree` under
    // `__only_chats__`, with `[data-repo-full-name]` null on its row.
    const repoGroup = groupHeader(mount.container, REPO);
    expect(repoGroup.textContent).toContain(REPO);
    expect(sessionRow(mount.container, "s-worktree")).not.toBeNull();

    const chatsGroup = groupHeader(mount.container, CHATS_GROUP_KEY);
    expect(chatsGroup.textContent).toContain("Chats");
    expect(sessionRow(mount.container, "s-chat")).not.toBeNull();

    await mount.unmount();
  });

  it("leaves a session with no repository under Chats", async () => {
    // The honest degradation: a clone with no GitHub remote has no heading to
    // file under, and inventing one would name a repository that does not exist.
    const mount = await mountRail({ sessions: [CHAT_SESSION] });

    expect(mount.container.querySelector(`[data-sidebar-group-key="${REPO}"]`)).toBeNull();
    expect(sessionRow(mount.container, "s-chat")).not.toBeNull();

    await mount.unmount();
  });
});

describe("the worktree glyph on a rail row (WT-TERM-2)", () => {
  it("draws the indicator on a worktree-backed row", async () => {
    const mount = await mountRail({ sessions: [WORKTREE_SESSION] });

    const row = sessionRow(mount.container, "s-worktree");
    expect(row).not.toBeNull();
    expect(row?.querySelector('[aria-label="Worktree"]')).not.toBeNull();

    await mount.unmount();
  });

  it("draws nothing on a repo row that is not a worktree", async () => {
    // Seam #9's hunk 4 renders the indicator unconditionally and the component
    // itself returns `null` for a falsy `isWorktree`, so this is the case that
    // proves the hunk added an indicator rather than a decoration.
    const mount = await mountRail({ sessions: [SHARED_DIR_SESSION] });

    const row = sessionRow(mount.container, "s-shared-dir");
    expect(row).not.toBeNull();
    expect(row?.querySelector('[aria-label="Worktree"]')).toBeNull();

    await mount.unmount();
  });
});

describe("seam patch 9 is declared where a merge agent reads it", () => {
  it("names the file it touches and the component it renders", () => {
    // The glyph is the one fix here that needed a vendor hunk. A merge agent
    // re-anchors from this section, so the section is part of the fix.
    const patches = readFileSync(join(repoRoot(), "vendor/lody/BLITZ-PATCHES.md"), "utf8");
    expect(patches).toContain("### 9. `SessionList` rows lost the worktree glyph");
    expect(patches).toContain("components/session-list.tsx");
    expect(patches).toContain("SessionRowWorktreeIndicator");
  });
});

describe("the Chats heading (RAIL-2)", () => {
  it("collapses its section on a click, and does not leave for the landing", async () => {
    const mount = await mountRail({ sessions: [CHAT_SESSION, WORKTREE_SESSION] });
    expect(sessionRow(mount.container, "s-chat")).not.toBeNull();

    await click(groupHeader(mount.container, CHATS_GROUP_KEY));

    expect(sessionRow(mount.container, "s-chat")).toBeNull();
    // The whole of the report: the click used to navigate, so the row count
    // never moved and the address went to `/chat`.
    expect(mount.landings).toBe(0);
    // The repo section is a different group and must not have followed.
    expect(sessionRow(mount.container, "s-worktree")).not.toBeNull();

    await click(groupHeader(mount.container, CHATS_GROUP_KEY));
    expect(sessionRow(mount.container, "s-chat")).not.toBeNull();

    await mount.unmount();
  });
});

describe("the repo heading's affordances (RAIL-3, RAIL-4)", () => {
  it("offers a new session from the heading", async () => {
    const mount = await mountRail({ sessions: [WORKTREE_SESSION] });

    const plus = headerRow(mount.container, REPO).querySelector<HTMLElement>(
      'button[aria-label="New session"]',
    );
    expect(plus).not.toBeNull();

    await click(plus as HTMLElement);

    // The landing is where a BlitzOS session picks its clone, so the "+" opens
    // it rather than pre-selecting the repo.
    expect(mount.landings).toBe(1);

    await mount.unmount();
  });

  it("offers a drag handle once a second repository exists", async () => {
    const mount = await mountRail({
      sessions: [WORKTREE_SESSION, OTHER_REPO_SESSION],
    });

    // `canReorderRepos` is `onMoveRepo` AND more than one repo group
    // (`session-list.tsx:1413`), so passing the handler IS the affordance.
    expect(mount.container.querySelectorAll('[aria-label="Reorder repo"]')).toHaveLength(2);

    await mount.unmount();
  });

  it("draws no handle for a workspace with one repository", async () => {
    const mount = await mountRail({ sessions: [WORKTREE_SESSION] });

    expect(mount.container.querySelectorAll('[aria-label="Reorder repo"]')).toHaveLength(0);

    await mount.unmount();
  });

  it("records every repository it discovers, in the order it found them", async () => {
    const mount = await mountRail({ sessions: [WORKTREE_SESSION, OTHER_REPO_SESSION] });

    // SAFETY: upstream declares `atom<readonly string[], [readonly string[]],
    // void>` (`atoms/sidebar-state.ts:102`). The vendor type seam erases every
    // `@lody/*` export, so the element type is restated here, exactly as
    // `SessionRailSidebar` restates it on its own read.
    const saved = mount.store.get(repoOrderAtom) as readonly string[];

    // Discovery is APPEND-ONLY, and it is what gives a drag something to
    // reorder: `repoOrderAtom` starts empty on a fresh box.
    expect([...saved]).toEqual([REPO, OTHER_REPO]);

    await mount.unmount();
  });

  it("draws the repositories in the member's saved order", async () => {
    const mount = await mountRail({
      sessions: [WORKTREE_SESSION, OTHER_REPO_SESSION],
      repoOrder: [OTHER_REPO, REPO],
    });

    const keys = [...mount.container.querySelectorAll("[data-sidebar-group-key]")].map((node) =>
      node.getAttribute("data-sidebar-group-key"),
    );
    expect(keys.filter((key) => key !== CHATS_GROUP_KEY)).toEqual([OTHER_REPO, REPO]);

    await mount.unmount();
  });

  /**
   * THE WORKING SPINNER (dogfood, 2026-09-03). A session whose tab spins in the
   * strip drew a blank leading slot in its rail row: the row spins only through
   * `liveSessionStatuses` (`session-list-rows.ts`, "live presence only"), and
   * the rail passed none. It now builds that map from the presence room the way
   * upstream's sidebar does, so the two agree.
   */
  it("spins the row of a session with fresh presence, and no other", async () => {
    const now = 1_000_000;
    const mount = await mountRail({
      sessions: [CHAT_SESSION, WORKTREE_SESSION, SHARED_DIR_SESSION],
      presence: {
        states: {
          // Fresh: the owning machine reported within the TTL.
          fresh: sessionPresence("s-chat", now - 10_000),
          // Stale: a heartbeat older than the 90 s TTL is a machine that
          // stopped reporting, not a session still working.
          stale: sessionPresence("s-worktree", now - 120_000),
        },
        nowMs: now,
      },
    });

    const spinner = (sessionId: string): Element | null =>
      mount.container.querySelector(
        `[data-sidebar-session-id="${sessionId}"] [data-session-working-spinner]`,
      );
    expect(spinner("s-chat"), "the fresh session's row").not.toBeNull();
    expect(spinner("s-worktree"), "the stale session's row").toBeNull();
    expect(spinner("s-shared-dir"), "a session with no presence at all").toBeNull();

    await mount.unmount();
  });

  /**
   * ARCHIVING THE SESSION ON SCREEN LEAVES IT (dogfood, 2026-09-03): the page
   * kept showing the archived session, tab and all. Upstream's sidebar
   * archives and then navigates to the landing when the archived id is the
   * selected one (`loro-app-sidebar.tsx:1397`); the rail now asks the shell for
   * the same landing, and for nobody else's row.
   */
  it("asks for the landing when the archived row is the session on screen, and only then", async () => {
    actions.archived.length = 0;
    const mount = await mountRail({
      sessions: [CHAT_SESSION, SHARED_DIR_SESSION],
      activeSessionId: "s-chat",
    });

    const other = sessionRow(mount.container, "s-shared-dir");
    if (other === null) throw new Error("no row for s-shared-dir");
    await archiveFromRow(other);
    expect(actions.archived).toEqual(["s-shared-dir"]);
    expect(mount.landings, "another row's archive moves nothing").toBe(0);

    const shown = sessionRow(mount.container, "s-chat");
    if (shown === null) throw new Error("no row for s-chat");
    await archiveFromRow(shown);
    expect(actions.archived).toEqual(["s-shared-dir", "s-chat"]);
    expect(mount.landings, "the shown session's archive asks for the landing").toBe(1);

    await mount.unmount();
  });
});
