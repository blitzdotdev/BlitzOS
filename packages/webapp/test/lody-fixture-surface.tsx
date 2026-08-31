/**
 * The vendored Lody leaves, rendered from fixture props with no daemon, no CRDT
 * and no network.
 *
 * This was `src/lody/SessionSurfaceSpike.tsx` in phase 0. Phase 3 mounted the
 * real `SessionSurface`, so the spike left `src/` — but its test did not lose
 * its value and this is where it moved to (plans/LODY-RUNTIME-DESIGN.md §4.5:
 * "their fixtures move to `packages/webapp/test/` as render fixtures").
 *
 * WHY IT IS STILL WORTH KEEPING. The phase-3 exit test drives the mounted
 * surface against a real `lody` daemon, so it SKIPS wherever the daemon is not
 * installed — which is CI. This harness needs none of that: it is a plain
 * component render, it gates every merge, and it is the thing that fails first
 * when an upstream merge changes a prop contract on the three components the
 * whole surface is built out of.
 */
import { useRef, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ArrowUp, Bot, Github } from "lucide-react";
import { createLocalPlatformProvider, createStaticStore } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { AuthenticatedConvexContext } from "@lody/components/hooks/use-authenticated-convex";
import { MessageRowView, SessionChatStreamView } from "@lody/components/components/ai-gui/view";
import { ChatComposer } from "@lody/components/components/chat/chat-composer";
import { ConversationColumn } from "@lody/components/components/shared/conversation-column";
import { LoroSidebar } from "@lody/components/components/loro-sidebar";
import { SessionList } from "@lody/components/components/session-list";
import { SidebarSectionHeader } from "@lody/components/components/sidebar-row-shared";
import { OptionSelector } from "@lody/components/components/shared/option-selector";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { Button } from "@lody/components/ui/button";
import { initLodyI18n } from "../src/lody/i18n";
import { SessionTypeIcon } from "../src/SessionTypeIcon";
import { LODY_SURFACE_CLASS } from "../src/lody/surface-class";
import type {
  AuthenticatedConvexValue,
  MessageRowArgs,
  OptionSelectorOption,
  SessionListRepoState,
} from "./lody-fixture-types";
import {
  FIXTURE_LAST_ASSISTANT_MESSAGE_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_SESSION_LIST_PROPS,
  FIXTURE_SIDEBAR_UPDATED_ITEMS,
  FIXTURE_STREAM_ITEMS,
} from "./lody-fixtures";
import "../src/lody/lody-surface.css";
import "./lody-fixture-surface.css";

const FIXTURE_USER_ID = "local:blitz-fixture";
const FIXTURE_WORKSPACE_ID = "lw_blitz_fixture";

const fixturePlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: "authenticated",
    user: { id: FIXTURE_USER_ID, name: "Fixture", image: null },
  }),
  workspaces: createStaticStore({
    status: "ready",
    workspaces: [{ id: FIXTURE_WORKSPACE_ID, name: "Fixture", slug: "fixture", role: "owner" }],
    activeWorkspaceId: FIXTURE_WORKSPACE_ID,
  }),
});

/** The settled signed-out Convex value their Storybook preview supplies. The
 * real provider supplies the same one; see `src/lody/platform.tsx`. */
const signedOutConvex: AuthenticatedConvexValue = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

// The vendored props type is `any` at our seam (see vendor-modules.d.ts), so
// this row renderer states its own contract instead of borrowing one.
const renderMessageRow = (row: MessageRowArgs) => (
  <MessageRowView message={row.message} sessionId={row.sessionId} />
);

const agentOptions: OptionSelectorOption<string>[] = [
  { value: "claude", label: "Claude Code", description: "my machine", startContent: <Bot className="h-4 w-4 opacity-70" /> },
  { value: "codex", label: "Codex", description: "my machine", startContent: <Bot className="h-4 w-4 opacity-70" /> },
];

const repoOptions: OptionSelectorOption<string>[] = [
  {
    value: "blitzdotdev/BlitzOS",
    label: "blitzdotdev/BlitzOS",
    description: "/workspace/BlitzOS",
    startContent: <Github className="h-4 w-4 opacity-70" />,
  },
];

export function FixtureComposer() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("Move the rail over to Lody session rows.");
  const [agent, setAgent] = useState<string | null>("claude");
  const [repo, setRepo] = useState<string | null>("blitzdotdev/BlitzOS");

  // WRAPPED, because production wraps it. `SessionChatInputArea` renders the
  // composer inside a `ConversationColumn`
  // (`sessions/session-chat-input-area.tsx:2411`), which is the same 46rem
  // centred measure the stream rows use (`lib/conversation-layout.ts:31`) — the
  // band paints full-bleed and the CONTENT is the column. A harness that mounts
  // `ChatComposer` bare gets a composer as wide as the pane, which is a harness
  // artefact rather than anything the product does; without this the review page
  // would show a mismatch the live surface does not have.
  return (
    <ConversationColumn>
      <ChatComposer
        tone="light"
        variant="session"
        promptRef={promptRef}
        promptValue={prompt}
        onPromptChange={setPrompt}
        promptPlaceholder="Press '/' for commands, '@' for mentions."
        promptRows={3}
        autoResize
        maxRows={11}
        selector={
          <div className="flex flex-wrap items-center gap-2">
            <OptionSelector
              value={repo}
              options={repoOptions}
              onSelect={(option: OptionSelectorOption<string>) => setRepo(option.value)}
              placeholder="Select repo"
              placeholderIcon={Github}
              tone="light"
              contentClassName="w-72"
            />
            <OptionSelector
              value={agent}
              options={agentOptions}
              onSelect={(option: OptionSelectorOption<string>) => setAgent(option.value)}
              placeholder="Select agent"
              placeholderIcon={Bot}
              tone="light"
              contentClassName="w-64"
            />
          </div>
        }
        primaryAction={
          <Button type="button" size="icon" variant="ghost" aria-label="Send" className="h-6 w-6">
            <ArrowUp className="h-4 w-4" />
          </Button>
        }
      />
    </ConversationColumn>
  );
}

/** The rail column's width (`SessionRailSidebar.RAIL_WIDTH`). `LoroSidebar`
 * sizes its root with an INLINE width because upstream it is the window's own
 * resizable sidebar, so the product pins all three width props to the shell
 * grid's column. The harness pins the same number. */
const FIXTURE_RAIL_WIDTH = 252;

/**
 * The Terminals section: their section header, our rows.
 *
 * The REAL rows, not a placeholder. `SessionRailSidebar` injects exactly this
 * through `LoroSidebar`'s own `afterSessionListContent` slot (§0.3, and
 * `SessionRailSidebar.tsx:410`): terminal tabs are `webapp_state`, never
 * sessions, so they are drawn by us with `.shell-s` under one of their section
 * headers. It is the whole point of the convergence — these rows and the
 * vendored session rows above them sit in one list and must read as one
 * component — so a harness that stubs them out cannot show the thing it exists
 * to show.
 */
function FixtureTerminalsSection() {
  const [collapsed, setCollapsed] = useState(false);
  const rows = [
    { id: "term-1", label: "claude", type: "claude" as const },
    { id: "term-2", label: "blitz — zsh", type: "terminal" as const },
  ];
  return (
    <div className="session-rail-terminals">
      <SidebarSectionHeader
        label="Terminals"
        collapsed={collapsed}
        toggleLabel="Terminals"
        onToggleCollapsed={() => setCollapsed((previous) => !previous)}
      />
      {!collapsed &&
        rows.map((row) => (
          <button className="shell-s" type="button" key={row.id}>
            <span className="shell-g">
              <SessionTypeIcon type={row.type} className="shell-g__glyph" />
            </span>
            <span className="shell-s__t">{row.label}</span>
            <span className="shell-s__a" />
          </button>
        ))}
    </div>
  );
}

/**
 * `LoroSidebar`, mounted with the props the PRODUCT mounts it with.
 *
 * Every prop below is `SessionRailSidebar`'s (`src/lody/SessionRailSidebar.tsx:431`),
 * and three of them are load-bearing rather than cosmetic:
 *
 * - `hideHeader` / `hideFooter` are declared seam #4 (`vendor/lody/BLITZ-PATCHES.md`).
 *   The header they hide is the workspace switcher `div.shell-rhead` already
 *   serves; the footer is Settings / Help / Archive, which BlitzOS serves from
 *   its own chrome and which would otherwise draw a `border-t` band across the
 *   bottom of the rail.
 * - `className` drops their floating-window card chrome: inside the rail the
 *   shell already draws the column's border. `cn()` is tailwind-merge, so these
 *   override rather than stack.
 * - `topContent` carries the GitHub Worktrees heading, because the list below it
 *   is a sibling rather than a child (`loro-app-sidebar.tsx:2551`).
 *
 * The Chats / GitHub Worktrees split is `repoFullName`, exactly as upstream, so
 * the worktree rows go through `sessionListProps` and the chat rows through a
 * second `SessionList` in `afterSessionListContent`.
 */
export function FixtureSidebar() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    FIXTURE_SESSION_LIST_PROPS.selectedSessionId ?? null,
  );
  const [repos, setRepos] = useState<SessionListRepoState[]>(FIXTURE_SESSION_LIST_PROPS.repos);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [worktreesCollapsed, setWorktreesCollapsed] = useState(false);

  const isChat = (row: { repoFullName: string | null }): boolean =>
    row.repoFullName === null || row.repoFullName === "";
  const chats = FIXTURE_SESSION_LIST_PROPS.sessions.filter(isChat);
  const worktrees = FIXTURE_SESSION_LIST_PROPS.sessions.filter((row) => !isChat(row));
  const rowActions = {
    selectedSessionId,
    onSelectSession: setSelectedSessionId,
    onSelect: setSelectedSessionId,
  };

  return (
    <LoroSidebar
      className="rounded-none border-x-0 shadow-none"
      hideHeader
      hideFooter
      workspaceName=""
      userEmail=""
      workspaces={[]}
      currentWorkspaceId={FIXTURE_WORKSPACE_ID}
      defaultWidth={FIXTURE_RAIL_WIDTH}
      minWidth={FIXTURE_RAIL_WIDTH}
      maxWidth={FIXTURE_RAIL_WIDTH}
      labels={{ home: "New session" }}
      activeNav={null}
      organizeMode="workspace"
      chatScope="my"
      pinnedItems={[]}
      updatedItems={FIXTURE_SIDEBAR_UPDATED_ITEMS}
      updatedSelectedItemId={selectedSessionId}
      updatedBucketsCollapsed={{}}
      topContent={
        <SidebarSectionHeader
          label="GitHub Worktrees"
          collapsed={worktreesCollapsed}
          toggleLabel="GitHub Worktrees"
          onToggleCollapsed={() => setWorktreesCollapsed((collapsed) => !collapsed)}
        />
      }
      sessionListProps={{
        ...rowActions,
        sessions: worktreesCollapsed ? [] : worktrees,
        repos: worktreesCollapsed ? [] : repos,
        onToggleRepoCollapsed: (repoFullName: string) =>
          setRepos((previous) =>
            previous.map((repo) =>
              repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo,
            ),
          ),
      }}
      afterSessionListContent={
        <>
          <SessionList
            {...rowActions}
            className={chatsCollapsed ? "mb-1" : "mb-3"}
            sessions={chatsCollapsed ? [] : chats}
            repos={[]}
            chatsCollapsed={chatsCollapsed}
            onToggleChatsCollapsed={() => setChatsCollapsed((collapsed) => !collapsed)}
          />
          <FixtureTerminalsSection />
        </>
      }
      onHomeClicked={() => {}}
      onRequestCollapse={() => {}}
    />
  );
}

/**
 * The fixture surface. Everything Lody renders is nested under
 * `.lody-surface`, which is the boundary the containment test probes.
 */
export function LodyFixtureSurface() {
  return (
    <LodyFixtureProviders>
      <div className={`${LODY_SURFACE_CLASS} lody-fixture-layout`}>
        {/* `session-list--vendor` is the class the rail's portal host carries in
            production (`strip-rail.css:306`), and it is one of the three
            selectors the generated Blitz theme sheet and `blitz-skin.css` scope
            to. The harness carries it so the fixture renders under the same
            rules the product does. */}
        <aside className="lody-fixture-rail session-list--vendor">
          <FixtureSidebar />
        </aside>
        <section className="lody-fixture-pane">
          <div className="lody-fixture-stream">
            <FixtureStream />
          </div>
          <div className="lody-fixture-composer">
            <FixtureComposer />
          </div>
        </section>
      </div>
    </LodyFixtureProviders>
  );
}

/** The chat stream, from the same fixture the render test asserts on. */
export function FixtureStream() {
  return (
    <SessionChatStreamView
      items={FIXTURE_STREAM_ITEMS}
      sessionId={FIXTURE_SESSION_ID}
      renderMessageRow={renderMessageRow}
      lastAssistantMessageId={FIXTURE_LAST_ASSISTANT_MESSAGE_ID}
      lastCompletedAssistantMessageId={FIXTURE_LAST_ASSISTANT_MESSAGE_ID}
    />
  );
}

/**
 * The provider stack the three leaves need, and nothing else.
 *
 * Exported because the theme review page (`test/theme-review.tsx`) composes the
 * same leaves into the rail's real chrome instead of the harness layout, and a
 * second copy of this stack would be a second thing to keep in step.
 */
export function LodyFixtureProviders(props: { children: ReactNode }) {
  const i18n = initLodyI18n();
  return (
    <PlatformContext.Provider value={fixturePlatform}>
      <AuthenticatedConvexContext.Provider value={signedOutConvex}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider>{props.children}</TooltipProvider>
        </I18nextProvider>
      </AuthenticatedConvexContext.Provider>
    </PlatformContext.Provider>
  );
}
