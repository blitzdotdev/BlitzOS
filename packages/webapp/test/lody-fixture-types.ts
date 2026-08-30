/**
 * Our side of the vendored-component contract, for the render harness.
 *
 * Everything imported from `@lody/*` is `any` here — see `vendor-modules.d.ts`
 * for why the vendor tree stays out of our typecheck. So the props we hand
 * their components are described locally instead: narrow, only the fields the
 * harness sets, and named after the upstream types they mirror so a reader can
 * follow them back.
 *
 * Field names come from:
 *   - `vendor/lody/packages/shared/src/schema.ts` (`SessionHistoryParsed`)
 *   - `vendor/lody/packages/components/src/components/ai-gui/view.tsx`
 *   - `vendor/lody/packages/components/src/components/session-list.tsx`
 *   - `vendor/lody/packages/components/src/components/sidebar-updated-session-list.tsx`
 *   - `vendor/lody/packages/components/src/components/shared/option-selector.tsx`
 *
 * A field they add upstream and we never set does not belong here; a field we
 * set that they rename shows up as a render failure in the harness test, which
 * is the signal we want out of an upstream merge.
 */
import type { ReactNode } from "react";

/** Upstream brands this string; the brand has no runtime effect. */
export type SessionId = string;

export interface SessionFileDiff {
  filePath: string;
  add: number;
  del: number;
}

export interface SessionMessageItem {
  type: string;
  text?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface SessionHistoryParsed {
  id: string;
  role: "user" | "assistant";
  timestamp: string;
  read: boolean;
  finished: boolean;
  endedAt?: number;
  fileDiff?: SessionFileDiff[];
  items: SessionMessageItem[];
}

export interface ChatStreamMessageItem {
  type: "message";
  sessionId: SessionId;
  message: SessionHistoryParsed;
}

export interface MessageRowArgs {
  message: SessionHistoryParsed;
  sessionId: SessionId;
}

export interface SessionListRepoState {
  repoFullName: string;
  collapsed: boolean;
}

export interface SessionListRow {
  sessionId: string;
  title: string;
  repoFullName: string | null;
  branchName: string;
  latestMessageAt: number;
  addedLines: number;
  deletedLines: number;
  isWorking: boolean;
  hasUnreadMessages: boolean;
  isOffline: boolean;
  isWaitingPermission: boolean;
  isWorktree?: boolean;
}

/** The subset of `SessionListProps` the sidebar harness drives. */
export interface SessionListProps {
  selectedSessionId: string;
  repos: SessionListRepoState[];
  sessions: SessionListRow[];
}

export interface SidebarUpdatedItem {
  id: string;
  kind: "chat" | "github" | "local";
  title: string;
  sectionLabel: string;
  subtitle: string | null;
  latestMessageAt: number;
  isWorking: boolean;
  hasUnreadMessages: boolean;
  isOffline: boolean;
  isWaitingPermission: boolean;
  openedBySessionId: string | null;
  openedByRowSessionId: string | null;
  isWorktree?: boolean;
  owner?: { name: string };
  addedLines?: number;
  deletedLines?: number;
}

export interface OptionSelectorOption<T> {
  value: T;
  label: string;
  description?: string;
  startContent?: ReactNode;
}

/**
 * The settled signed-out shape `useAuthenticatedConvex` expects, copied from
 * their Storybook preview's `storybookAuthValue`.
 */
export interface AuthenticatedConvexValue {
  authSessionId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isRecovering: boolean;
  confirmedUnauthenticated: boolean;
  claimAutomaticCommand: () => boolean;
  requestAuthRecovery: () => void;
}
