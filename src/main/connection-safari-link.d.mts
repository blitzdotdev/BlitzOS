// Types for the Safari tab link (connection-safari-link.mjs).
import type { ConnectionOps } from './connection-ops.d.mts'

export interface SafariTabInfo {
  tabId: string
  window: number
  tab: number
  url: string
  title: string
  favIconUrl?: string
}

export interface SafariLink {
  listTabs(): Promise<SafariTabInfo[]>
  connectTab(tabId: string, opts?: { title?: string; sourceId?: string }): Promise<Record<string, unknown>>
}

export function makeSafariLink(opts: { connectionOps: ConnectionOps }): SafariLink
