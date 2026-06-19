// Types for the tab link (connection-tab-link.mjs).
import type { ConnectionOps } from './connection-ops.d.mts'

export const CONNECTOR_EXTENSION_ID: string
export const DEFAULT_TAB_LINK_PORT: number

export interface TabInfo {
  tabId: number
  title: string
  url: string
  windowId?: number
  active?: boolean
}

export interface TabLink {
  /** Start the localhost WS server (probes a small port range if taken). */
  start(bindPort?: number): Promise<{ ok: boolean; port?: number | null; error?: string }>
  stop(): void
  /** Connectable browser tabs reported by the extension. */
  listTabs(): Promise<TabInfo[]>
  /** Connect a tab → bind a connection with a WS-backed adapter. */
  connectTab(tabId: number, opts?: { sourceId?: string; title?: string }): Promise<{ connId: string; surfaceId: string | null; sourceId: string; tab: TabInfo } | { error: string }>
  isConnected(): boolean
  readonly extensionId: string
  readonly port: number
}

export interface TabLinkOpts {
  connectionOps: ConnectionOps
  port?: number
  token?: string
  onStatus?: (s: { ok: boolean; port?: number; connected?: boolean; error?: string }) => void
}

export function makeTabLink(opts: TabLinkOpts): TabLink
