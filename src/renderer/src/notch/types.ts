// The contract the island panel implements. IslandPanel is PURE PRESENTATIONAL: NotchHost owns all state (current
// page, swipe-scroll, draft, whether the connectors view is open) and hands the panel data + callbacks. The tab
// strip is shared across every view: tab 0 is the new-session "+" tab, tabs 1..N are the agents. The body below the
// strip is the composer when page===0, the activity feed + steer bar otherwise. Each composer has an attach button
// (a circle "+") that opens the connectors view (a full-island takeover). It imports ChatInput for the composer.
import type { MockSession, MockMessage, MockActivity } from './mock'

export interface IslandPanelProps {
  sessions: MockSession[]
  page: number // 0 = the new-session ("+") tab; 1..N = the agent at page-1
  onSelectPage: (p: number) => void // select a tab (0 = new session, i = agent i-1)
  messages: MockMessage[] // transcript for the active agent (process view)
  activity: MockActivity[] // activity feed for the active agent (process view)
  onSend: (text: string) => void // visual-only: NotchHost appends a mock message
  menuBarH: number // notch height in px, for top alignment under the physical notch
  attachOpen: boolean // the attach "+" toggles the attachment panel INLINE above the message bar (island grows)
  onToggleAttach: () => void
}
