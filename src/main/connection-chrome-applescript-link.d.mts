// Types for the Chrome Apple-Events tab link (connection-chrome-applescript-link.mjs).
import type { ConnectionOps } from './connection-ops.d.mts'

export interface ChromeTabInfo {
  tabId: string
  window: number
  tab: number
  url: string
  title: string
  favIconUrl?: string
}

export interface ChromeAppleScriptLink {
  listTabs(): Promise<ChromeTabInfo[]>
  connectTab(tabId: string, opts?: { title?: string; sourceId?: string; agentId?: string }): Promise<Record<string, unknown>>
}

// The computer-use helper, used to route the AppleScript through it so the Automation grant lands on the helper.
export interface OsaHelperLike {
  call(cmd: string, args?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>
  connected(): boolean
  available?(): boolean
  ensure?(): Promise<{ ok: boolean; error?: string }>
}
export function makeChromeAppleScriptLink(opts: { connectionOps: ConnectionOps; helper?: OsaHelperLike }): ChromeAppleScriptLink
