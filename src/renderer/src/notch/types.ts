// The contract IslandPanel implements. NotchHost owns all state (current page, attach-open, and the REAL agent
// sessions/threads/status it pulls from the chat channel) and hands the panel data + callbacks. The tab strip is
// shared: tab 0 is the new-session tab, tabs 1..N are the live agents. The body is the new-session composer when
// page===0, else the active agent's transcript + steer bar.

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
}

// A summarized step from the narrator (Haiku): one plain past-tense line of what the agent did.
export interface IslandMilestone {
  id: string
  ts: number
  kind: 'step' | 'ask' | 'result'
  text: string
}

export interface IslandTerminalMeta {
  id: string
  title: string
  status: string
  kind: string
}

export interface IslandPanelProps {
  sessions: IslandSession[]
  page: number // 0 = the new-session (pen) tab; 1..N = the agent at page-1
  onSelectPage: (p: number) => void
  messages: IslandMessage[] // the active session's transcript (process view)
  milestones: IslandMilestone[] // the active session's summarized step timeline (narrator)
  status: string // the active session's raw host status (process view)
  activeId?: string // the active session id (the Details expand + the peek now-playing)
  peek: boolean // peek: keep the tab bar, but the area BELOW becomes the active agent's "now playing"
  onSend: (text: string) => void // page 0 = spawn a new session; an agent tab = steer it
  menuBarH: number // notch height in px, for top alignment under the physical notch
  attachOpen: boolean // the attach "+" toggles the attachment panel INLINE (island grows)
  onToggleAttach: () => void
  debugTerminalEnabled: boolean // debug-only: show the active agent's tmux terminal inside the chat app
  activeTerminal?: IslandTerminalMeta // metadata for activeId's managed terminal; activeId remains the terminal id
  onArchiveAgent: (id: string) => void
}
