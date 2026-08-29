/**
 * Fixture props for the phase-0 render spike.
 *
 * Mirrored from the vendored Storybook stories, which are the upstream
 * statement of how each leaf is driven without a daemon:
 *   - `vendor/lody/packages/components/src/stories/AssistantTurnAlignment.stories.tsx`
 *     (`SessionChatStreamView` + `MessageRowView`)
 *   - `vendor/lody/packages/components/src/stories/LoroSidebar.stories.tsx`
 *   - `vendor/lody/packages/components/src/stories/ChatComposer.stories.tsx`
 *
 * No daemon, no network, no CRDT: these are plain objects.
 */
import type {
  ChatStreamMessageItem,
  SessionHistoryParsed,
  SessionId,
  SessionListProps,
  SessionListRow,
  SidebarUpdatedItem,
} from "./spike-types";

export const SPIKE_SESSION_ID: SessionId = "session-blitz-phase0-spike";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const MINUTE = 60 * 1000;

const streamingTurn: SessionHistoryParsed = {
  id: "spike-user-1",
  role: "user",
  timestamp: "2026-08-30T11:58:00.000Z",
  read: true,
  finished: true,
  items: [{ type: "text", text: "Swap the workspace rail over to Lody session rows." }],
};

const assistantTurn: SessionHistoryParsed = {
  id: "spike-assistant-1",
  role: "assistant",
  timestamp: "2026-08-30T11:58:20.000Z",
  read: true,
  finished: true,
  endedAt: Date.parse("2026-08-30T11:59:02.000Z"),
  fileDiff: [
    { filePath: "packages/webapp/src/shell/SessionRail.tsx", add: 84, del: 31 },
    { filePath: "packages/webapp/src/strip-rail.css", add: 12, del: 4 },
  ],
  items: [
    {
      type: "text",
      text: "I will mount the vendored sidebar body inside `div.shell-list` and keep `div.shell-rhead` native.",
    },
    {
      type: "tool_call",
      toolCallId: "spike-tool-1",
      title: "rg shell-list packages/webapp/src",
      kind: "search",
      status: "completed",
    },
    {
      type: "tool_call",
      toolCallId: "spike-tool-2",
      title: "Edit packages/webapp/src/shell/SessionRail.tsx",
      kind: "edit",
      status: "completed",
    },
    {
      type: "text",
      text: "The rail now renders **Chats** and **GitHub Worktrees** sections; terminals stay in their own section.",
    },
  ],
};

export const SPIKE_STREAM_ITEMS: ChatStreamMessageItem[] = [
  { type: "message", sessionId: SPIKE_SESSION_ID, message: streamingTurn },
  { type: "message", sessionId: SPIKE_SESSION_ID, message: assistantTurn },
];

export const SPIKE_LAST_ASSISTANT_MESSAGE_ID = assistantTurn.id;

const sessionRows: SessionListRow[] = [
  {
    sessionId: "spike-chat-1",
    title: "fix the login redirect",
    repoFullName: null,
    branchName: "",
    latestMessageAt: NOW - 4 * MINUTE,
    addedLines: 0,
    deletedLines: 0,
    isWorking: true,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    sessionId: "spike-chat-2",
    title: "yesterday's refactor",
    repoFullName: null,
    branchName: "",
    latestMessageAt: NOW - 26 * 60 * MINUTE,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    sessionId: "spike-worktree-1",
    title: "rail swap",
    repoFullName: "blitzdotdev/BlitzOS",
    branchName: "lody/ab12cd34ef56",
    isWorktree: true,
    latestMessageAt: NOW - 12 * MINUTE,
    addedLines: 96,
    deletedLines: 35,
    isWorking: false,
    hasUnreadMessages: true,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    sessionId: "spike-worktree-2",
    title: "gateway lody routes",
    repoFullName: "blitzdotdev/BlitzOS",
    branchName: "lody/99aa88bb77cc",
    isWorktree: true,
    latestMessageAt: NOW - 3 * 60 * MINUTE,
    addedLines: 41,
    deletedLines: 2,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: true,
  },
];

export const SPIKE_SESSION_LIST_PROPS: SessionListProps = {
  selectedSessionId: "spike-worktree-1",
  repos: [{ repoFullName: "blitzdotdev/BlitzOS", collapsed: false }],
  sessions: sessionRows,
};

export const SPIKE_SIDEBAR_UPDATED_ITEMS: SidebarUpdatedItem[] = sessionRows.map((row) =>
  row.repoFullName === null || row.repoFullName === undefined
    ? {
        id: row.sessionId,
        kind: "chat",
        title: row.title,
        sectionLabel: "Chats",
        subtitle: null,
        latestMessageAt: row.latestMessageAt,
        isWorking: row.isWorking,
        hasUnreadMessages: row.hasUnreadMessages,
        isOffline: row.isOffline,
        isWaitingPermission: row.isWaitingPermission,
        openedBySessionId: null,
        openedByRowSessionId: null,
      }
    : {
        id: row.sessionId,
        kind: "github",
        title: row.title,
        sectionLabel: row.repoFullName,
        subtitle: row.repoFullName,
        latestMessageAt: row.latestMessageAt,
        isWorking: row.isWorking,
        isWorktree: row.isWorktree,
        hasUnreadMessages: row.hasUnreadMessages,
        isOffline: row.isOffline,
        isWaitingPermission: row.isWaitingPermission,
        openedBySessionId: null,
        openedByRowSessionId: null,
        owner: { name: "blitz" },
        addedLines: row.addedLines,
        deletedLines: row.deletedLines,
      },
);
