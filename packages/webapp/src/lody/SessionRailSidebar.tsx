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
 * 2. The TERMINALS section, injected through their own `afterSessionListContent`
 *    slot. These rows are `webapp_state` tabs, not sessions — they never enter
 *    the CRDT and the daemon never sees them — so they are ours, drawn with our
 *    `.shell-s` markup and `SessionTypeIcon` glyphs, under their section header
 *    so the three headings match.
 * 3. The SUPPRESSION. `hideHeader` and `hideFooter` are the props phase 4 added
 *    at declared seam #4 (`vendor/lody/BLITZ-PATCHES.md`); the header they hide
 *    is the workspace switcher `div.shell-rhead` already serves, and the footer
 *    is settings/help/archive, which BlitzOS serves from its own chrome.
 *
 * SECTION ORDER IS UPSTREAM'S, NOT THE PLAN'S SKETCH. §8 draws Chats above
 * GitHub Worktrees; `LoroSidebar` renders `sessionListProps` before
 * `afterSessionListContent`, and their own comment says why ("so Chats reads as
 * the last section"). Reordering means either a second seam patch or rebuilding
 * their scroll region, and §0's bias rule settles it: theirs wins, ours goes.
 * Terminals then reads last, below Chats.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { LoroSidebar } from "@lody/components/components/loro-sidebar";
import { SessionList } from "@lody/components/components/session-list";
import { SidebarSectionHeader } from "@lody/components/components/sidebar-row-shared";
import { activeWorkspaceRuntimeAtom } from "@lody/components/atoms/runtime";
import { userAtom } from "@lody/components/atoms";
import { useVisibleSessionMetas } from "@lody/components/hooks/use-visible-session-metas";
import { useOnlineMachineIds } from "@lody/components/hooks/use-machine-online-status";
import { useSessionActions } from "@lody/components/hooks/use-session-actions";
import { buildSessionListRows } from "@lody/components/components/sessions/session-list-rows";
import { SessionTypeIcon } from "../SessionTypeIcon.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";

/**
 * The shell grid's rail column, in pixels (`drive-shell.css:119`).
 *
 * `LoroSidebar` sizes itself with an INLINE width because upstream it is the
 * window's own resizable sidebar. Here the shell grid owns that width, so the
 * three width props are pinned to it and `strip-rail.css` overrides the inline
 * value for the drag sash's sake. Keep the two in step.
 */
const RAIL_WIDTH = 252;

/** One row as `buildSessionListRows` returns it, narrowed to what this file
 * reads. Their `SessionListRow` cannot be imported as a type across the vendor
 * seam (`wire-types.ts`), and every other field travels through their own
 * components untouched. */
interface LodySessionRow {
  sessionId: string;
  repoFullName: string | null;
  isPinned?: boolean;
}

export interface SessionRailSidebarProps {
  /** Every terminal tab the rail used to list, unchanged. */
  terminals: DriveRailSession[];
  /** The terminal tab that owns the panes, or `''` for "the first one". */
  activeTerminalId: string;
  /** The chat session the surface is showing, or `null` on the landing. */
  activeSessionId: string | null;
  /** `true` while the surface is the visible pane. A terminal row that is
   * selected while the surface is up must not stay highlighted. */
  surfaceVisible: boolean;
  onSelectTerminal: (tabId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** "+ New session": their `home` nav entry, relabelled. */
  onOpenLanding: () => void;
  /** The `+ New tab` control, rendered in the Terminals section header so the
   * Claude / Codex / terminal entries keep a home in the rail. */
  terminalsAction?: ReactNode;
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

/** Today's rail rows, kept byte-for-byte: same classes, same glyphs, same
 * click. They are tabs, so they are drawn by us and not by `SessionList`. */
function TerminalRows(props: {
  terminals: DriveRailSession[];
  activeTerminalId: string;
  active: boolean;
  onSelect: (tabId: string) => void;
}) {
  return (
    <>
      {props.terminals.map((session, index) => {
        const selected =
          props.active &&
          (session.id === props.activeTerminalId ||
            (props.activeTerminalId === "" && index === 0));
        return (
          <button
            className={`shell-s${selected ? " shell-s--on" : ""}`}
            type="button"
            key={session.id}
            aria-current={selected ? "page" : undefined}
            onClick={() => props.onSelect(session.id)}
          >
            <span className="shell-g">
              <SessionTypeIcon
                type={session.agent}
                className="shell-g__glyph"
                filePath={session.filePath}
              />
            </span>
            <span className="shell-s__t">{session.label}</span>
            <span className="shell-s__a" />
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

  const rows: LodySessionRow[] = useMemo(
    () =>
      workspaceId === null
        ? []
        : buildSessionListRows(
            // A local project is a phase-5 concept; until then a session that
            // claims one is not ours to draw. Upstream filters the same way
            // (`loro-app-sidebar.tsx:1565`) and then renders those sessions in
            // its Local Projects section, which this rail does not have.
            sessions.filter(
              (session: { project?: { kind?: string } | null }) =>
                session.project?.kind !== "local",
            ),
            {
              scope: "my",
              currentUserId: user?.id ?? null,
              defaultTitle: "New chat",
              onlineMachineIds,
              lineChangeScope: "all",
            },
            allActiveSessions,
          ),
    [allActiveSessions, onlineMachineIds, sessions, user?.id, workspaceId],
  );

  const chats = useMemo(
    () => rows.filter((row) => row.repoFullName === null || row.repoFullName === ""),
    [rows],
  );
  const worktrees = useMemo(
    () => rows.filter((row) => row.repoFullName !== null && row.repoFullName !== ""),
    [rows],
  );
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const repos = useMemo(
    () =>
      stableRepoFullNames(worktrees).map((repoFullName) => ({
        repoFullName,
        collapsed: collapsedRepos[repoFullName] ?? false,
      })),
    [collapsedRepos, worktrees],
  );
  const toggleRepo = useCallback((repoFullName: string) => {
    setCollapsedRepos((current) => ({
      ...current,
      [repoFullName]: !(current[repoFullName] ?? false),
    }));
  }, []);

  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [worktreesCollapsed, setWorktreesCollapsed] = useState(false);
  const [terminalsCollapsed, setTerminalsCollapsed] = useState(false);

  const { onSelectSession, onOpenLanding } = props;
  const selectedSessionId = props.surfaceVisible ? props.activeSessionId : null;
  const rowActions = useMemo(
    () => ({
      selectedSessionId,
      onSelectSession,
      onNavigateSessionTab: onSelectSession,
      onArchiveSession: (sessionId: string) => {
        void archiveSession(sessionId);
      },
      onRenameSession: (sessionId: string, nextTitle: string) =>
        updateSessionTitle(sessionId, nextTitle),
      onTogglePinSession: (sessionId: string, nextPinned: boolean) => {
        void setSessionPinned(sessionId, nextPinned);
      },
      onNavigateToNewSession: () => onOpenLanding(),
    }),
    [archiveSession, onOpenLanding, onSelectSession, selectedSessionId, setSessionPinned, updateSessionTitle],
  );

  const sessionListProps = useMemo(
    () => ({
      ...rowActions,
      sessions: worktreesCollapsed ? [] : worktrees,
      repos: worktreesCollapsed ? [] : repos,
      isLoading: worktreesCollapsed ? false : isLoading,
      onToggleRepoCollapsed: toggleRepo,
    }),
    [isLoading, repos, rowActions, toggleRepo, worktrees, worktreesCollapsed],
  );

  // An EMPTY Lody section renders nothing at all, header included, and that is
  // upstream's rule rather than ours (`loro-app-sidebar.tsx:2095`): a heading
  // over no rows is a promise the sidebar cannot keep. Terminals is the
  // exception, because it is ours and a workspace with no terminal tab is a
  // state the member can act on from the `+` in its header.
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
      {showChats && (
        <SessionList
          {...rowActions}
          className={chatsCollapsed ? "mb-1" : "mb-3"}
          sessions={chatsCollapsed ? [] : chats}
          repos={[]}
          isLoading={chatsCollapsed ? false : isLoading}
          chatsCollapsed={chatsCollapsed}
          onToggleChatsCollapsed={() => setChatsCollapsed((collapsed) => !collapsed)}
        />
      )}
      <div className="session-rail-terminals">
        <SidebarSectionHeader
          label="Terminals"
          collapsed={terminalsCollapsed}
          toggleLabel="Terminals"
          onToggleCollapsed={() => setTerminalsCollapsed((collapsed) => !collapsed)}
          action={props.terminalsAction}
        />
        {!terminalsCollapsed && (
          <TerminalRows
            terminals={props.terminals}
            activeTerminalId={props.activeTerminalId}
            active={!props.surfaceVisible}
            onSelect={props.onSelectTerminal}
          />
        )}
      </div>
    </>
  );

  return (
    <LoroSidebar
      // Their card chrome is for a floating window sidebar; inside the rail the
      // shell already draws the column's border. `cn()` is tailwind-merge, so
      // these override rather than stack.
      className="rounded-none border-x-0 shadow-none"
      hideHeader
      hideFooter
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
      activeNav={props.surfaceVisible && props.activeSessionId === null ? "home" : null}
      onHomeClicked={onOpenLanding}
      {...(topContent === null ? {} : { topContent })}
      sessionListProps={sessionListProps}
      afterSessionListContent={afterSessionListContent}
    />
  );
}

export default SessionRailSidebar;
