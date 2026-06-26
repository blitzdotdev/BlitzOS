// Types for the Chrome Apple-Events tab link (connection-chrome-applescript-link.mjs).
import type { ConnectionOps } from './connection-ops.d.mts'

export interface ChromeTabInfo {
  tabId: string
  window: number
  tab: number
  chromeId?: number // the tab's STABLE Chrome id (what a connection binds to, robust to reorder/move)
  url: string
  title: string
  favIconUrl?: string
}

export interface ChromeAppleScriptLink {
  listTabs(): Promise<{ tabs: ChromeTabInfo[]; state: 'ok' | 'denied' | 'allowjs' | 'helper' | 'unreachable' }>
  connectTab(tabId: string, opts?: { title?: string; sourceId?: string; agentId?: string }): Promise<Record<string, unknown>>
}

// The computer-use helper: the Chrome RPCs (chrome_js / chrome_list_tabs) route through it so the Automation grant
// lands on the helper, and the no-prompt automationGranted() gates the prompting list.
export interface OsaHelperLike {
  call(cmd: string, args?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>
  connected(): boolean
  available?(): boolean
  ensure?(): Promise<{ ok: boolean; error?: string }>
  automationGranted?(bundleId: string): Promise<string>
}
// blitzPid: Blitz Chrome's real browser pid to EXCLUDE from the user-Chrome enumeration (so it never shadows the
// user's Chrome via the shared com.google.Chrome bundle id). See plans/blitzos-chrome-pid-targeting.md.
export function makeChromeAppleScriptLink(opts: { connectionOps: ConnectionOps; helper?: OsaHelperLike; blitzPid?: () => number | null }): ChromeAppleScriptLink
