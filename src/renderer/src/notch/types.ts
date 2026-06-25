// The contract IslandPanel implements. NotchHost owns all state (current page, attach-open, and the REAL agent
// sessions/threads/status it pulls from the chat channel) and hands the panel data + callbacks. The tab strip is
// shared: tab 0 is the new-session tab, tabs 1..N are the live agents. The body is the new-session composer when
// page===0, else the active agent's transcript + steer bar.

export type IslandView = 'settings' | 'session' | 'onboarding'

// One agent session as the island needs it. `status` is the raw host status (working/starting/watching/waiting/
// idle/stopped/error); IslandPanel maps it to the dot + a label.
export interface IslandSession {
  id: string
  title: string
  status: string
  lastMessagePreview?: string
  archivedAt?: number
}

export interface IslandMessage {
  role: 'user' | 'agent'
  text: string
  ts?: number
  // absolute user-message index across the FULL transcript (set by readChatMessages before the 400-cap slice)
  // so attachment-snapshot keys stay valid even after the window shifts past 400 messages.
  userIdx?: number
  parts?: IslandMessagePart[]
}

export interface IslandChoiceOption {
  label: string
  sub?: string
  img?: string
}

export type IslandAppIcon = 'dashboard' | 'report' | 'table' | 'checklist' | 'form' | 'share' | 'browser' | 'file'
export type IslandAppTone = 'sky' | 'mint' | 'amber' | 'violet' | 'lime' | 'rose'

export interface IslandAppPart {
  type: 'app'
  title: string
  url: string
  subtitle?: string
  icon?: IslandAppIcon
  tone?: IslandAppTone
  preview?: string
  // The blitz.dev claim page (https://blitz.dev/claim/<slug>) — present when the app was provisioned via new_app.
  // Anon projects delete at ~12h unless claimed, so the expanded card shows a Claim button when this is set.
  claimUrl?: string
  expiresAt?: string
}

export type IslandMessagePart =
  | { type: 'text'; text: string }
  | { type: 'choice'; layout: 'confirm' | 'choice' | 'grid'; prompt: string; options: IslandChoiceOption[] }
  | IslandAppPart
  | { type: 'tool'; title: string; state: 'preparing' | 'awaiting-permission' | 'running' | 'output' | 'error' | 'denied'; output?: string; error?: string }
  | { type: 'attachment'; title: string; sourceType?: string }
  | { type: 'status'; text: string; tone?: 'info' | 'working' | 'warning' | 'error' }
  | { type: 'error'; text: string }

export type IslandChoicePart = Extract<IslandMessagePart, { type: 'choice' }>
export type IslandAppMessagePart = Extract<IslandMessagePart, { type: 'app' }>

// A summarized step from the narrator (Haiku): one plain past-tense line of what the agent did.
export interface IslandMilestone {
  id: string
  ts: number
  kind: 'step' | 'ask' | 'result'
  text: string
}

// A live workflow run, for the inline kanban board in chat. Mirrors the main-side IslandWfRun.
export interface IslandWfRun {
  runId: string
  agentId: string
  file: string
  startedAt: number
  done: boolean
  ok: boolean
  skeleton: unknown[]
  memDir: string | null
  stats?: { ms: number; calls: number; tokens: number } | null // final rolled-up stats (on done) → collapsed pill caption, no board mount
}

export interface IslandTerminalMeta {
  id: string
  title: string
  status: string
  kind: string
}

// The active agent's last problem, as reported by Claude Code (classifyApiError) → a human-facing read the island
// shows in the inline status line: a short title, a one-line "what to do" hint, and whether a plain Retry applies.
export interface AgentError {
  cause: string
  title: string
  hint: string
  retryable: boolean
}

export interface IslandPanelProps {
  sessions: IslandSession[]
  page: number // 1..N = the agent at page-1 (Blitz '0' is page 1); the pen is a spawn button, not a page
  onSelectPage: (p: number) => void
  onNewAgent: () => void // the pen button: spawn a brand-new agent immediately and enter its tab
  messages: IslandMessage[] // the active session's transcript (process view)
  milestones: IslandMilestone[] // the active session's summarized step timeline (narrator)
  runs: IslandWfRun[] // the active session's live workflow runs (inline kanban boards)
  status: string // the active session's raw host status (process view)
  errorDetail?: AgentError // the active session's last problem (only present while its status is 'error')
  onRetry?: () => void // nudge the active agent to retry after a (retryable) error
  activeId?: string // the active session id (the Details expand + the peek now-playing)
  peek: boolean // peek: keep the tab bar, but the area BELOW becomes the active agent's "now playing"
  onSend: (text: string) => void // send to the ACTIVE agent (Blitz '0' or a peer); never spawns
  menuBarH: number // notch height in px, for top alignment under the physical notch
  attachOpen: boolean // the attach "+" toggles the attachment panel INLINE (island grows)
  onToggleAttach: () => void
  activeApp: IslandAppMessagePart | null // generated app currently opened in the expanded island preview
  onActiveAppChange: (app: IslandAppMessagePart | null) => void
  onAppViewerToggle?: (open: boolean) => void
  debugTerminalEnabled: boolean // debug-only: show the active agent's tmux terminal inside the chat app
  activeTerminal?: IslandTerminalMeta // metadata for activeId's managed terminal; activeId remains the terminal id
  onArchiveAgent: (id: string) => void
  onRenameAgent: (id: string, title: string) => Promise<boolean>
  onHoldOpen?: () => void // stamp App's keep-open hold (e.g. while the native tab menu is up, so the island can't retract)
  alwaysShowWorkflow: boolean // when on, each workflow run renders EXPANDED by default (vs the collapsed status pill)
}
