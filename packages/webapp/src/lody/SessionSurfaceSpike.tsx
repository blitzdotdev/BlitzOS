/**
 * Phase-0 render spike (plans/LODY-SESSIONS.md §10, phase 0).
 *
 * Proves that three vendored Lody leaves — `SessionChatStreamView`, the
 * `ChatComposer`, and the `LoroSidebar` body — mount and render inside our
 * webapp shell from fixture props, with no daemon, no CRDT, and no network.
 * It mirrors the upstream Storybook stories named in `spike-fixtures.ts`.
 *
 * It is NOT the `SessionSurface` of §7.1: there is no runtime, no router
 * bridge and no theme overlay here. Those arrive in phases 2 and 3. Everything
 * in this directory lives OUTSIDE `vendor/`, per the §5.3 patch policy.
 */
import { useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { ArrowUp, Bot, Github } from "lucide-react";
import { MessageRowView, SessionChatStreamView } from "@lody/components/components/ai-gui/view";
import { ChatComposer } from "@lody/components/components/chat/chat-composer";
import { LoroSidebar } from "@lody/components/components/loro-sidebar";
import { OptionSelector } from "@lody/components/components/shared/option-selector";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { Button } from "@lody/components/ui/button";
import { initLodyI18n } from "./i18n";
import type {
  MessageRowArgs,
  OptionSelectorOption,
  SessionListRepoState,
} from "./spike-types";
import { LodySpikePlatformProvider } from "./spike-platform";
import {
  SPIKE_LAST_ASSISTANT_MESSAGE_ID,
  SPIKE_SESSION_ID,
  SPIKE_SESSION_LIST_PROPS,
  SPIKE_SIDEBAR_UPDATED_ITEMS,
  SPIKE_STREAM_ITEMS,
} from "./spike-fixtures";
import "./lody-surface.css";
import "./lody-spike.css";

/** The class the containment test treats as the session surface boundary. */
export const LODY_SURFACE_CLASS = "lody-surface";

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

function SpikeComposer() {
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

function SpikeSidebar() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    SPIKE_SESSION_LIST_PROPS.selectedSessionId ?? null,
  );
  const [repos, setRepos] = useState<SessionListRepoState[]>(SPIKE_SESSION_LIST_PROPS.repos);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);

  return (
    <LoroSidebar
      workspaceName="Phase 0 spike"
      userEmail="phase0@blitz.dev"
      repoSections={[]}
      chats={[]}
      workspaces={[{ id: "lw_blitz_phase0", name: "Phase 0 spike" }]}
      currentWorkspaceId="lw_blitz_phase0"
      activeNav="home"
      organizeMode="workspace"
      chatScope="my"
      pinnedItems={[]}
      updatedItems={SPIKE_SIDEBAR_UPDATED_ITEMS}
      updatedSelectedItemId={selectedSessionId}
      updatedBucketsCollapsed={{}}
      sessionListProps={{
        sessions: SPIKE_SESSION_LIST_PROPS.sessions,
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
 * The spike surface. Everything Lody renders is nested under
 * `.lody-surface`, which is the boundary the containment test probes.
 */
export function SessionSurfaceSpike() {
  const i18n = initLodyI18n();
  return (
    <LodySpikePlatformProvider>
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <div className={`${LODY_SURFACE_CLASS} lody-spike-layout`}>
            <aside className="lody-spike-rail">
              <SpikeSidebar />
            </aside>
            <section className="lody-spike-pane">
              <div className="lody-spike-stream">
                <SessionChatStreamView
                  items={SPIKE_STREAM_ITEMS}
                  sessionId={SPIKE_SESSION_ID}
                  renderMessageRow={renderMessageRow}
                  lastAssistantMessageId={SPIKE_LAST_ASSISTANT_MESSAGE_ID}
                  lastCompletedAssistantMessageId={SPIKE_LAST_ASSISTANT_MESSAGE_ID}
                />
              </div>
              <div className="lody-spike-composer">
                <SpikeComposer />
              </div>
            </section>
          </div>
        </TooltipProvider>
      </I18nextProvider>
    </LodySpikePlatformProvider>
  );
}
