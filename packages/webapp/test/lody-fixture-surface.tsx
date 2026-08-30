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
import { useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { ArrowUp, Bot, Github } from "lucide-react";
import { createLocalPlatformProvider, createStaticStore } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { AuthenticatedConvexContext } from "@lody/components/hooks/use-authenticated-convex";
import { MessageRowView, SessionChatStreamView } from "@lody/components/components/ai-gui/view";
import { ChatComposer } from "@lody/components/components/chat/chat-composer";
import { LoroSidebar } from "@lody/components/components/loro-sidebar";
import { OptionSelector } from "@lody/components/components/shared/option-selector";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { Button } from "@lody/components/ui/button";
import { initLodyI18n } from "../src/lody/i18n";
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

function FixtureComposer() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("Move the rail over to Lody session rows.");
  const [agent, setAgent] = useState<string | null>("claude");
  const [repo, setRepo] = useState<string | null>("blitzdotdev/BlitzOS");

  return (
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
  );
}

function FixtureSidebar() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    FIXTURE_SESSION_LIST_PROPS.selectedSessionId ?? null,
  );
  const [repos, setRepos] = useState<SessionListRepoState[]>(FIXTURE_SESSION_LIST_PROPS.repos);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);

  return (
    <LoroSidebar
      workspaceName="Fixture workspace"
      userEmail="fixture@blitz.dev"
      repoSections={[]}
      chats={[]}
      workspaces={[{ id: FIXTURE_WORKSPACE_ID, name: "Fixture workspace" }]}
      currentWorkspaceId={FIXTURE_WORKSPACE_ID}
      activeNav="home"
      organizeMode="workspace"
      chatScope="my"
      pinnedItems={[]}
      updatedItems={FIXTURE_SIDEBAR_UPDATED_ITEMS}
      updatedSelectedItemId={selectedSessionId}
      updatedBucketsCollapsed={{}}
      sessionListProps={{
        sessions: FIXTURE_SESSION_LIST_PROPS.sessions,
        repos,
        chatsCollapsed,
        selectedSessionId,
        onSelect: setSelectedSessionId,
        onToggleRepoCollapsed: (repoFullName: string) =>
          setRepos((previous) =>
            previous.map((repo) =>
              repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo,
            ),
          ),
        onToggleChatsCollapsed: () => setChatsCollapsed((previous) => !previous),
      }}
      afterSessionListContent={
        <div className="px-3 py-2 text-xs opacity-70">Terminals (native rows land here)</div>
      }
      onInviteClicked={() => {}}
      onLinkRepoClicked={() => {}}
      onSettingsClicked={() => {}}
      onRequestCollapse={() => {}}
    />
  );
}

/**
 * The fixture surface. Everything Lody renders is nested under
 * `.lody-surface`, which is the boundary the containment test probes.
 */
export function LodyFixtureSurface() {
  const i18n = initLodyI18n();
  return (
    <PlatformContext.Provider value={fixturePlatform}>
      <AuthenticatedConvexContext.Provider value={signedOutConvex}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider>
            <div className={`${LODY_SURFACE_CLASS} lody-fixture-layout`}>
              <aside className="lody-fixture-rail">
                <FixtureSidebar />
              </aside>
              <section className="lody-fixture-pane">
                <div className="lody-fixture-stream">
                  <SessionChatStreamView
                    items={FIXTURE_STREAM_ITEMS}
                    sessionId={FIXTURE_SESSION_ID}
                    renderMessageRow={renderMessageRow}
                    lastAssistantMessageId={FIXTURE_LAST_ASSISTANT_MESSAGE_ID}
                    lastCompletedAssistantMessageId={FIXTURE_LAST_ASSISTANT_MESSAGE_ID}
                  />
                </div>
                <div className="lody-fixture-composer">
                  <FixtureComposer />
                </div>
              </section>
            </div>
          </TooltipProvider>
        </I18nextProvider>
      </AuthenticatedConvexContext.Provider>
    </PlatformContext.Provider>
  );
}
