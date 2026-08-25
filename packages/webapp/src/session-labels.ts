import type { WorkspaceSessionKind } from '@blitzos/schema';

/** Product names for every shared-session kind, used wherever a session is
 * named to a person: the spawn menu, tab labels, and presence activity. */
export const SESSION_KIND_LABELS = {
  chat: 'Chat',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  kimi: 'Kimi',
  prime: 'Prime',
  terminal: 'Terminal',
} satisfies Record<WorkspaceSessionKind, string>;
