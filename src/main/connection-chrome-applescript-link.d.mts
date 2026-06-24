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

export function makeChromeAppleScriptLink(opts: { connectionOps: ConnectionOps }): ChromeAppleScriptLink
