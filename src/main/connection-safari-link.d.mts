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
  listTabs(): Promise<{ tabs: SafariTabInfo[]; state: 'ok' | 'denied' | 'allowjs' | 'helper' | 'unreachable' }>
  connectTab(tabId: string, opts?: { title?: string; sourceId?: string }): Promise<Record<string, unknown>>
}

// The computer-use helper, used to route the AppleScript through it so the Automation grant lands on the helper.
export interface OsaHelperLike {
  call(cmd: string, args?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>
  connected(): boolean
  available?(): boolean
  ensure?(): Promise<{ ok: boolean; error?: string }>
}
export function makeSafariLink(opts: { connectionOps: ConnectionOps; helper?: OsaHelperLike }): SafariLink
