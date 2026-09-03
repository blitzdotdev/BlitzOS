/**
 * The vendored zone of the rail (plans/LODY-SESSIONS.md §0.3, §8).
 *
 * `shell/SessionRail.tsx` keeps `div.shell-rhead` native and hands the list
 * region to this component, which mounts Lody's own `LoroSidebar` body: their
 * Chats and GitHub Worktrees sections, their rows, their context menus, their
 * empty and loading states. Nothing about a session row is re-implemented here
 * — §0's bias rule — so what this file owns is exactly three things:
 *
 * 1. The DATA. `loro-app-sidebar.tsx` is 3003 lines because most of it is cloud:
 *    an organization member list, session sharing, PR polling, a Convex
 *    entitlement, an Electron updater banner, local-project management. What is
 *    left when those are removed is the pair below, and both are theirs:
 *    `useVisibleSessionMetas` reads the runtime's session mirror, and
 *    `buildSessionListRows` turns metas into rows. The Chats / GitHub Worktrees
 *    split is `repoFullName`, exactly as it is upstream (`:1600`).
 * 2. The NEW TAB control, in their footer through `footerLeadingContent` (seam
 *    patch 18), to the left of Archive. It used to head a Terminals section of
 *    our own rows under their `afterSessionListContent` slot; that section is
 *    gone (2026-09-03), because a terminal is a TAB of the surface and the
 *    surface's own strip already lists and closes it — the rail listed every
 *    tab twice. What stays is the one spawn affordance, as a terminal glyph.
 * 3. The SUPPRESSION. `hideHeader` is the prop phase 4 added at declared seam #2
 *    (`vendor/lody/BLITZ-PATCHES.md`); the header it hides is the workspace
 *    switcher `div.shell-rhead` already serves. The footer used to go with it,
 *    and seam #13 is why it no longer does: settings and help are BlitzOS's own
 *    chrome, but the ARCHIVE entry beside them is upstream's only affordance
 *    that leads to the archive page. `footerItems` keeps that one and drops the
 *    rest, so nothing about the entry point is ours.
 *
 * SECTION ORDER IS UPSTREAM'S, NOT THE PLAN'S SKETCH. §8 draws Chats above
 * GitHub Worktrees; `LoroSidebar` renders `sessionListProps` before
 * `afterSessionListContent`, and their own comment says why ("so Chats reads as
 * the last section"). Reordering means either a second seam patch or rebuilding
 * their scroll region, and §0's bias rule settles it: theirs wins, ours goes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { LoroSidebar } from "@lody/components/components/loro-sidebar";
import { SessionList } from "@lody/components/components/session-list";
import { SidebarSectionHeader } from "@lody/components/components/sidebar-row-shared";
import { repoOrderAtom, setRepoOrderAtom } from "@lody/components/atoms/sidebar-state";
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from "@lody/components/atoms/presence";
import { activeWorkspaceRuntimeAtom } from "@lody/components/atoms/runtime";
import { userAtom } from "@lody/components/atoms";
import { useVisibleSessionMetas } from "@lody/components/hooks/use-visible-session-metas";
import { useOnlineMachineIds } from "@lody/components/hooks/use-machine-online-status";
import { useSessionActions } from "@lody/components/hooks/use-session-actions";
import { buildSessionListRows } from "@lody/components/components/sessions/session-list-rows";
import { findFreshSessionPresenceState } from "@lody/shared";
import { SessionTypeIcon } from "../SessionTypeIcon.js";
import type { SharedSessionRow } from "./shared-sessions.js";

/**
 * The shell grid's rail column, in pixels (`drive-shell.css:119`).
 *
 * `LoroSidebar` sizes itself with an INLINE width because upstream it is the
 * window's own resizable sidebar. Here the shell grid owns that width, so the
 * three width props are pinned to it and `strip-rail.css` overrides the inline
 * value for the drag sash's sake. Keep the two in step.
 */
const RAIL_WIDTH = 252;

/** The one footer utility this rail keeps (seam patch 13). A module constant, so
 * the array identity does not change per render and re-memo the sidebar. */
const FOOTER_ITEMS = ["archive"] as const;

/** One row as `buildSessionListRows` returns it, narrowed to what this file
 * reads. Their `SessionListRow` cannot be imported as a type across the vendor
 * seam (`wire-types.ts`), and every other field travels through their own
 * components untouched. */
interface LodySessionRow {
  sessionId: string;
  repoFullName: string | null;
  isPinned?: boolean;
  /** What their row's context menu draws for the Share entry
   * (`session-list.tsx:820`). Upstream fills it from a cloud visibility flip;
   * BlitzOS fills it from §0.1's rule that a session is private until granted,
   * so `visibility` is always `'private'` — the entry is how you MANAGE the
   * grants, and a session with grants must still offer it. */
  sharing?: { visibility: "private"; canManage: boolean };
}

/** The row callbacks this rail hands `SessionList`. Stated on our side because
 * every `@lody/*` name is a namespace across the vendor type seam
 * (`wire-types.ts`). */
interface LodySessionRowActions {
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNavigateSessionTab: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, nextTitle: string) => Promise<void> | void;
  onTogglePinSession: (sessionId: string, nextPinned: boolean) => void;
  onShareSessionWithTeam?: (sessionId: string) => void;
}

/** `LodyPresenceStateMap` (`shared/src/presence.ts:50`), narrowed to what the
 * freshness helper reads. Stated on our side because `@lody/shared` is a
 * namespace across the vendor type seam (`wire-types.ts`). */
interface LodyPresenceStates {
  [instanceId: string]: { kind: string; sessionId?: string; updatedAt: number };
}

/** Their `SessionStatus` (`shared/src/session-status-machine.ts`), narrowed to the one
 * field a row reads: `requestPermission` draws the waiting hand, anything else
 * the working spinner. */
interface LodySessionStatus {
  type: string;
}

/** One repo drag, as `SessionList` reports it (`SessionListRepoMove`,
 * `session-list.tsx:159`). Only the reordered list is read here — the indices
 * and the two names describe the same move. */
interface LodyRepoMove {
  nextRepos: { repoFullName: string }[];
}

export interface SessionRailSidebarProps {
  /** The chat session the surface is showing, or `null` on the landing and on
   * the archive. */
  activeSessionId: string | null;
  /** `true` while the archive page is the surface's address. It is a separate
   * signal from `activeSessionId` because the archive names no session, so the
   * two states would otherwise both read as "the landing". */
  archiveActive?: boolean;
  /** `true` while the surface is the visible pane. */
  surfaceVisible: boolean;
  onSelectSession: (sessionId: string) => void;
  /** "+ New session": their `home` nav entry, relabelled. */
  onOpenLanding: () => void;
  /** The footer's Archive entry, which is upstream's own (seam patch 13). */
  onOpenArchive?: () => void;
  /**
   * The `New tab` control — Claude / Codex / terminal — drawn in the footer to
   * the left of Archive through `footerLeadingContent` (seam patch 18), so the
   * Claude / Codex / terminal entries keep a home in the rail. It is the only
   * spawn affordance a flag-on workspace has (plans/LODY-TERMINAL-TABS.md §4.1).
   */
  newTabControl?: ReactNode;
  /**
   * Right-click Share (plans/LODY-SESSIONS.md §0.1, LODY-SHARING.md §8).
   *
   * NO VENDOR HUNK. `SessionList` already draws a Share entry in its row
   * context menu, gated on the row carrying a `sharing` state and the list
   * carrying `onShareSessionWithTeam` (`session-list.tsx:1134`), and the "⋯"
   * button opens that same menu by synthesizing a `contextmenu` event
   * (`sidebar-row-shared.tsx:507`). So the whole affordance is two props.
   *
   * Absent with sharing off, which leaves the row's menu exactly as phase 4
   * shipped it.
   */
  onShareSession?: (sessionId: string) => void;
  /**
   * The sessions OTHER members shared with this one
   * (plans/LODY-SHARING.md §8 step 3).
   *
   * NATIVE ROWS, like Terminals, and for the same reason: they are not in this
   * runtime's session mirror and cannot be. They live on somebody else's
   * daemon, and this runtime is connected to exactly one box — its own. The
   * list is read by `CloudApp` from the control plane's `received` half and
   * titled off the owner's box, so nothing about it belongs inside the vendored
   * sidebar's data path.
   */
  sharedSessions?: SharedSessionRow[];
  /** The shared session the surface is showing, or `null`. */
  activeSharedSessionId?: string | null;
  onSelectSharedSession?: (row: SharedSessionRow) => void;
}

/** Repo names in first-seen order — upstream's `getStableRepoFullNames`
 * (`loro-app-sidebar.tsx:449`), which is module-private there. */
function stableRepoFullNames(rows: LodySessionRow[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    const name = (row.repoFullName ?? "").trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

/** The saved order first, then whatever the member has not dragged yet —
 * upstream's `repos` memo (`loro-app-sidebar.tsx:2235`), which is the reading
 * `repoOrderAtom` is written for. */
function orderedRepoFullNames(present: string[], order: readonly string[]): string[] {
  const remaining = new Set(present);
  const ordered: string[] = [];
  for (const repoFullName of order) {
    if (!remaining.delete(repoFullName)) continue;
    ordered.push(repoFullName);
  }
  for (const repoFullName of present) {
    if (remaining.has(repoFullName)) ordered.push(repoFullName);
  }
  return ordered;
}

/** A shared session's own row. Ours, not `SessionList`'s, because the vendored
 * row is built from a `SessionMeta` this runtime does not hold — and because the
 * level is the one thing a grantee has to see before they click. */
function SharedSessionRows(props: {
  rows: SharedSessionRow[];
  activeSessionId: string | null;
  onSelect: (row: SharedSessionRow) => void;
}) {
  return (
    <>
      {props.rows.map((row) => {
        const selected = row.sessionId === props.activeSessionId;
        return (
          <button
            className={`shell-s${selected ? " shell-s--on" : ""}`}
            type="button"
            key={`${row.ownerMembershipId}:${row.sessionId}`}
            aria-current={selected ? "page" : undefined}
            title={`${row.ownerName} · ${row.level === "rw" ? "read-write" : "read-only"}`}
            onClick={() => props.onSelect(row)}
          >
            <span className="shell-g">
              <SessionTypeIcon type="terminal" className="shell-g__glyph" />
            </span>
            <span className="shell-s__t">{row.title ?? row.sessionId.slice(0, 8)}</span>
            <span className="shell-s__a session-rail-shared__level">
              {row.level === "rw" ? "RW" : "RO"}
            </span>
          </button>
        );
      })}
    </>
  );
}

export function SessionRailSidebar(props: SessionRailSidebarProps) {
  // The vendor seam erases every `@lody/*` export to `any`, so the generic is
  // where this file states what it reads — the same convention `SessionSurface`
  // uses for `runtimeAtom`. Both atoms are Lody's own, written by their own
  // code, and every value below travels straight back into their components.
  const runtime = useAtomValue<{ workspaceId?: string } | null>(activeWorkspaceRuntimeAtom);
  const workspaceId = runtime?.workspaceId ?? null;
  const user = useAtomValue<{ id?: string } | null>(userAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const { updateSessionTitle, archiveSession, setSessionPinned } = useSessionActions();

  // `enabled` gates every read: before the runtime exists the mirror is empty
  // and a row list built from it would flash "no sessions" at every mount.
  const { sessions, allActiveSessions, isLoading } = useVisibleSessionMetas({
    workspaceId,
    enabled: workspaceId !== null,
  });

  // THE WORKING SPINNER, from the same signal the session tab draws its own.
  //
  // A row spins only through `liveSessionStatuses` (`session-list-rows.ts`:
  // "sidebar working state is live presence only"), and upstream's sidebar
  // builds that map from the presence room — the freshest `session` presence
  // per id (`loro-app-sidebar.tsx:1537`). The tab bar reads the same room per
  // session through `sessionLiveStatusAtomFamily`, so a session whose tab
  // spins is exactly one whose row spins. This is their derivation, copied,
  // because the rail used to pass nothing here and no row ever spun (dogfood,
  // 2026-09-03).
  const presenceStates = useAtomValue<LodyPresenceStates>(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue<number>(lodyPresenceNowMsAtom);
  const liveSessionStatuses = useMemo(() => {
    const next = new Map<string, LodySessionStatus>();
    const metas: { id: string }[] = [...allActiveSessions, ...sessions];
    for (const session of metas) {
      if (next.has(session.id)) continue;
      const fresh: { status: LodySessionStatus } | undefined = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs,
      );
      if (fresh !== undefined) next.set(session.id, fresh.status);
    }
    return next;
  }, [allActiveSessions, presenceNowMs, presenceStates, sessions]);

  const rows: LodySessionRow[] = useMemo(
    () =>
      workspaceId === null
        ? []
        : buildSessionListRows(
            // NOT FILTERED, and that is the phase-5 change. Upstream drops
            // `project.kind === 'local'` here (`loro-app-sidebar.tsx:1565`)
            // because it draws those sessions in its own Local Projects
            // section, which this rail does not have — so the same filter here
            // hid every BlitzOS worktree session, whose `ProjectRef` is exactly
            // `{ kind: 'local', useWorktree: true }` (plan §6.4, worktree source
            // `local-shared`).
            //
            // Grouping still needs no code of ours: `buildSessionListRows` sets
            // a row's `repoFullName` from `resolveProjectGitHubRepo`
            // (`shared/src/project.ts:152`), which reads `githubRepoFullName`
            // off a local `ProjectRef`, and the daemon derives that field from
            // the clone's own remote (measured: `/workspace/BlitzOS` →
            // `blitzdotdev/BlitzOS`). So a worktree session lands under GitHub
            // Worktrees, grouped by repo, exactly as §6.4 says.
            //
            // A local project with no GitHub remote yields no `repoFullName`
            // and its sessions read as Chats. That is the honest degradation:
            // the alternative is upstream's, which is to hide them.
            sessions,
            {
              scope: "my",
              currentUserId: user?.id ?? null,
              defaultTitle: "New chat",
              onlineMachineIds,
              lineChangeScope: "all",
              liveSessionStatuses,
            },
            allActiveSessions,
          ),
    [allActiveSessions, liveSessionStatuses, onlineMachineIds, sessions, user?.id, workspaceId],
  );

  const { onSelectSession, onOpenLanding, onOpenArchive, onShareSession, onSelectSharedSession } =
    props;
  const sharedSessions = props.sharedSessions ?? [];
  // Every row is private and every row is the caller's own — the rail lists the
  // sessions on the caller's box, because that is the only daemon this runtime
  // is connected to — so `canManage` is simply "is the affordance offered".
  const shareableRows = useMemo(
    () =>
      onShareSession === undefined
        ? rows
        : rows.map((row: LodySessionRow) => ({
            ...row,
            sharing: { visibility: "private" as const, canManage: true },
          })),
    [onShareSession, rows],
  );
  const chats = useMemo(
    () => shareableRows.filter((row) => row.repoFullName === null || row.repoFullName === ""),
    [shareableRows],
  );
  const worktrees = useMemo(
    () => shareableRows.filter((row) => row.repoFullName !== null && row.repoFullName !== ""),
    [shareableRows],
  );
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  // THE MEMBER'S OWN ORDER, in the store upstream already keeps it in
  // (`atoms/sidebar-state.ts:102`): one localStorage key per workspace, keyed on
  // `currentWorkspaceIdAtom`, which `SessionSurface` publishes. Nothing new is
  // persisted for RAIL-3 — the rail simply reads and writes the order the
  // vendored sidebar has always had.
  const repoOrder = useAtomValue<readonly string[]>(repoOrderAtom);
  const setRepoOrder = useSetAtom(setRepoOrderAtom);
  const repoFullNames = useMemo(() => stableRepoFullNames(worktrees), [worktrees]);
  const repos = useMemo(
    () =>
      orderedRepoFullNames(repoFullNames, repoOrder).map((repoFullName) => ({
        repoFullName,
        collapsed: collapsedRepos[repoFullName] ?? false,
      })),
    [collapsedRepos, repoFullNames, repoOrder],
  );
  const toggleRepo = useCallback((repoFullName: string) => {
    setCollapsedRepos((current) => ({
      ...current,
      [repoFullName]: !(current[repoFullName] ?? false),
    }));
  }, []);
  // APPEND-ONLY, and the reason is upstream's (`loro-app-sidebar.tsx:2265`): a
  // repo drops out of the list whenever its last session is archived or the
  // mirror is mid-sync, and removing it here would lose its saved position and
  // let two neighbours swap every time one flickers.
  const repoOrderRef = useRef(repoOrder);
  repoOrderRef.current = repoOrder;
  useEffect(() => {
    if (isLoading || repoFullNames.length === 0) return;
    const known = new Set(repoOrderRef.current);
    const added = repoFullNames.filter((repoFullName) => !known.has(repoFullName));
    if (added.length === 0) return;
    setRepoOrder([...repoOrderRef.current, ...added]);
  }, [isLoading, repoFullNames, setRepoOrder]);
  const moveRepo = useCallback(
    (move: LodyRepoMove) => {
      // A drag reorders only the repos on screen. The ones that are not — a repo
      // whose sessions are all archived — keep their entries after the visible
      // ones so they come back where the member left them.
      const visible = move.nextRepos.map((repo) => repo.repoFullName);
      const onScreen = new Set(visible);
      const offScreen = repoOrderRef.current.filter((repoFullName) => !onScreen.has(repoFullName));
      setRepoOrder([...visible, ...offScreen]);
    },
    [setRepoOrder],
  );

  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [worktreesCollapsed, setWorktreesCollapsed] = useState(false);
  const [sharedCollapsed, setSharedCollapsed] = useState(false);

  const selectedSessionId = props.surfaceVisible ? props.activeSessionId : null;
  // THE ARCHIVE OUTRANKS "New session". Both are nav entries and the archive
  // names no session, so without this the footer's Archive entry would be dark
  // while the archive page is on screen and the "New session" row would be lit
  // instead — the rail would name a page the member is not looking at.
  const activeNav = !props.surfaceVisible
    ? null
    : props.archiveActive === true
      ? "archive"
      : props.activeSessionId === null
        ? "home"
        : null;
  const rowActions = useMemo(() => {
    const actions: LodySessionRowActions = {
      selectedSessionId,
      onSelectSession,
      onNavigateSessionTab: onSelectSession,
      onArchiveSession: (sessionId: string) => {
        void archiveSession(sessionId);
        // ARCHIVING THE SESSION ON SCREEN LEAVES IT, which is upstream's own
        // rule (`loro-app-sidebar.tsx:1397`: archive, then navigate to the
        // chat landing when the archived id is the selected one). Without it
        // the page kept showing the archived session and its tab in the strip
        // stayed put (dogfood, 2026-09-03). The landing is asked for through
        // the SHELL's navigator, as every rail click is, so the address moves
        // with the surface.
        if (sessionId === selectedSessionId) onOpenLanding();
      },
      onRenameSession: (sessionId: string, nextTitle: string) =>
        updateSessionTitle(sessionId, nextTitle),
      onTogglePinSession: (sessionId: string, nextPinned: boolean) => {
        void setSessionPinned(sessionId, nextPinned);
      },
    };
    // Absent, not undefined: their row draws the Share entry only when the
    // callback is present (`session-list.tsx:891`).
    if (onShareSession !== undefined) actions.onShareSessionWithTeam = onShareSession;
    return actions;
  }, [
    archiveSession,
    onOpenLanding,
    onSelectSession,
    onShareSession,
    selectedSessionId,
    setSessionPinned,
    updateSessionTitle,
  ]);

  const sessionListProps = useMemo(
    () => ({
      ...rowActions,
      sessions: worktreesCollapsed ? [] : worktrees,
      repos: worktreesCollapsed ? [] : repos,
      isLoading: worktreesCollapsed ? false : isLoading,
      onToggleRepoCollapsed: toggleRepo,
      // RAIL-4. `onNew` is what draws the hover "+" in a group header
      // (`session-list.tsx:595`), and upstream's own sidebar never passes it, so
      // the affordance the QA sweep looked for had nothing to render it. It
      // opens the landing rather than pre-selecting the repo: the landing's
      // project picker is the only place a BlitzOS session picks a clone, and
      // upstream's repo pre-selection addresses a `github` context this
      // composition does not serve.
      onNew: () => onOpenLanding(),
      // RAIL-3. The drag handle renders only when a reorder can be persisted
      // (`session-list.tsx:1410`), so passing the handler IS the affordance.
      onMoveRepo: moveRepo,
      // A repo header still navigates on click, which is upstream's own wiring
      // for this list (`loro-app-sidebar.tsx:2643`); its chevron button carries
      // the collapse.
      onNavigateToNewSession: () => onOpenLanding(),
    }),
    [isLoading, moveRepo, onOpenLanding, repos, rowActions, toggleRepo, worktrees, worktreesCollapsed],
  );

  // An EMPTY Lody section renders nothing at all, header included, and that is
  // upstream's rule rather than ours (`loro-app-sidebar.tsx:2095`): a heading
  // over no rows is a promise the sidebar cannot keep.
  const showWorktrees = isLoading || worktrees.length > 0;
  const showChats = isLoading || chats.length > 0;

  // Their own top slot carries the GitHub Worktrees heading, because the list
  // below it is a sibling rather than a child (`loro-app-sidebar.tsx:2551`).
  const topContent = showWorktrees ? (
    <SidebarSectionHeader
      label="GitHub Worktrees"
      collapsed={worktreesCollapsed}
      toggleLabel="GitHub Worktrees"
      onToggleCollapsed={() => setWorktreesCollapsed((collapsed) => !collapsed)}
    />
  ) : null;

  const afterSessionListContent = (
    <>
      {/* RAIL-2: NO `onNavigateToNewSession` HERE, which is upstream's own
          shape for this list (`loro-app-sidebar.tsx:2576`). The group header
          runs `onNavigateToNewSession` when it has one and `handleToggleGroup`
          only when it does not (`session-list.tsx:700`), and the "Chats" header
          draws its chevron as decoration rather than as a button — so a rail
          that passed both gave the section a chevron that could not collapse it
          and a click that left for the landing instead. */}
      {showChats && (
        <SessionList
          {...rowActions}
          className={chatsCollapsed ? "mb-1" : "mb-3"}
          // THE FULL LIST, COLLAPSED OR NOT, and that is the other half of
          // RAIL-2. `buildGroups` derives the Chats group FROM its sessions and
          // marks it `collapsed` from this flag (`session-list.tsx:381`), then
          // draws the header and skips the rows. Handing it an empty array
          // instead deletes the group — so the heading that had just been
          // collapsed disappeared with its own rows, and nothing was left to
          // click to bring them back.
          sessions={chats}
          repos={[]}
          isLoading={isLoading}
          chatsCollapsed={chatsCollapsed}
          onToggleChatsCollapsed={() => setChatsCollapsed((collapsed) => !collapsed)}
        />
      )}
      {/* Below Chats: a shared session IS a session, so it belongs with the
          sessions — and it stays below the grantee's own, because the rail is
          theirs first. An empty section renders nothing at all, upstream's
          rule, and here it is the honest one: a member with no grants has
          nothing to say about them. */}
      {sharedSessions.length > 0 && (
        <div className="session-rail-shared">
          <SidebarSectionHeader
            label="Shared with you"
            collapsed={sharedCollapsed}
            toggleLabel="Shared with you"
            onToggleCollapsed={() => setSharedCollapsed((collapsed) => !collapsed)}
          />
          {!sharedCollapsed && onSelectSharedSession !== undefined && (
            <SharedSessionRows
              rows={sharedSessions}
              activeSessionId={props.activeSharedSessionId ?? null}
              onSelect={onSelectSharedSession}
            />
          )}
        </div>
      )}
    </>
  );

  return (
    <LoroSidebar
      // Their card chrome is for a floating window sidebar; inside the rail the
      // shell already draws the column's border. `cn()` is tailwind-merge, so
      // these override rather than stack.
      className="rounded-none border-x-0 shadow-none"
      hideHeader
      // Seam patch 13. The footer's Settings and Help are surfaces BlitzOS
      // serves from its own chrome, and its mobile filter popover controls
      // organize modes this rail does not have. Archive is the one entry that
      // stays, because it is the only way upstream offers into the archive page.
      footerItems={FOOTER_ITEMS}
      // Seam patch 18. The New tab control sits at the start of that same row,
      // to the left of Archive: the footer is where a rail keeps the controls
      // that are not a list entry, and a spawn is one.
      {...(props.newTabControl === undefined
        ? {}
        : { footerLeadingContent: props.newTabControl })}
      workspaceName=""
      userEmail=""
      workspaces={[]}
      currentWorkspaceId={workspaceId ?? ""}
      defaultWidth={RAIL_WIDTH}
      minWidth={RAIL_WIDTH}
      maxWidth={RAIL_WIDTH}
      // "+ New session" is their `home` entry with our word on it: it is
      // literally the same action — go to the chat landing, which is the
      // create surface — and reusing it keeps the affordance theirs.
      labels={{ home: "New session" }}
      activeNav={activeNav}
      onHomeClicked={onOpenLanding}
      {...(onOpenArchive === undefined ? {} : { onArchiveClicked: onOpenArchive })}
      {...(topContent === null ? {} : { topContent })}
      sessionListProps={sessionListProps}
      afterSessionListContent={afterSessionListContent}
    />
  );
}

export default SessionRailSidebar;
