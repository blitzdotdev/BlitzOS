// Types for the shared connection ops binding (connection-ops.mjs).

/** A per-connection backend ADAPTER — the only per-type code (tab = the Chrome extension link; window =
 *  the BlitzComputerUse helper). It executes a verb and reports "source changed" out-of-band by calling
 *  connectionNotify(connId, …) on the ops. `read`/`act`/`run_js` are the verbs the dispatcher uses. */
export interface ConnectionAdapter {
  call(verb: 'read' | 'act' | 'run_js' | string, args: Record<string, unknown>): Promise<unknown> | unknown
  drop?(): void | Promise<void>
}

export interface ConnectionBindSpec {
  type: 'tab' | 'window'
  sourceId: string
  title?: string
  capabilities?: Record<string, boolean>
  adapter: ConnectionAdapter
}

export interface ConnectionInfo {
  connId: string
  type: 'tab' | 'window'
  sourceId: string
  title: string
  status: string
  capabilities: Record<string, boolean>
  surfaceId: string | null
  savedTools: Array<{ name: string; description: string; kind: string }>
  description?: string
}

/** The agent-facing ops (Object.assign'd onto the transport's `ops`) + the adapter/registry API. */
export interface ConnectionOps {
  /** An adapter connects a source: auto-creates + binds the representation widget; returns the ids. */
  connectionBind(spec: ConnectionBindSpec): { connId: string; surfaceId: string | null }
  /** An adapter reports a source change: significant → immediate agent wake; churn → silent. */
  connectionNotify(connId: string, opts?: { significant?: boolean; summary?: string; status?: string }): void
  /** The adapter/source went away: mark the connection dead, keep the widget + saved tools. */
  connectionUnbind(connId: string, opts?: { status?: string }): void
  /** Resolve a representation widget's surface id → its connId (per-connId widget scoping). */
  connectionForSurface(surfaceId: string | null | undefined): string | null
  /** Is this connId a live connection? Adapters use it to dedup re-connects of the same tab/window. */
  connectionIsLive(connId: string): boolean
  /** Public shape of a connection (for an adapter's dedup return), or null. */
  connectionInfo(connId: string): Record<string, unknown> | null
  /** Called when a surface closes; if it's a connection's widget, drop the connection (no leaked adapter). */
  handleSurfaceClosed(surfaceId: string): Promise<void>
  /** On (re)hydrate: rewrite a persisted connection widget to a disconnected state if its connection isn't live; else null. */
  rewriteHydratedSurface(surface: Record<string, unknown>): Record<string, unknown> | null
  /** The tab link registers itself so connection_list_tabs / connection_connect_tab work. */
  setTabLink(link: { listTabs: () => Promise<unknown>; connectTab: (tabId: number, opts?: any) => Promise<unknown> } | null): void
  /** The Safari link (Apple Events) registers itself; its tabs merge into connection_list_tabs (browser:'safari'). */
  setSafariLink(link: { listTabs: () => Promise<unknown>; connectTab: (tabId: string, opts?: any) => Promise<unknown> } | null): void
  connectionListTabs(): Promise<Record<string, unknown>>
  connectionConnectTab(tabId: number | string, opts?: { title?: string; sourceId?: string }): Promise<Record<string, unknown>>
  /** The window link (Electron-only) registers itself so connection_list_windows / connection_connect_window work. */
  setWindowLink(link: { listWindows: () => Promise<unknown>; connectWindow: (windowId: number, opts?: any) => Promise<unknown> } | null): void
  connectionListWindows(): Promise<Record<string, unknown>>
  connectionConnectWindow(windowId: number, opts?: { title?: string; sourceId?: string }): Promise<Record<string, unknown>>
  /** Reconnect a source by sourceId (the Reconnect button on a disconnected widget): re-finds + connects the tab/window. */
  connectionReconnectSource(sourceId: string, type?: 'tab' | 'window'): Promise<Record<string, unknown>>
  /** Force-install the connector extension (Electron + macOS only); registered via setInstaller. */
  setInstaller(fn: (() => Promise<{ ok: boolean; error?: string; note?: string }>) | null): void
  connectionInstallExtension(): Promise<Record<string, unknown>>
  connectionList(): { connections: ConnectionInfo[] }
  connectionRead(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionAct(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionRunJs(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionSaveTool(connId: string, tool: { name: string; description?: string; kind?: string; code?: string; steps?: unknown }): Record<string, unknown>
  connectionListTools(connId: string): Record<string, unknown>
  connectionCallTool(connId: string, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionDrop(connId: string): Promise<Record<string, unknown>>
  connectionSetDescription(connId: string, text: string): Record<string, unknown>
}

export interface ConnectionOpsDeps {
  /** Active workspace folder (Electron: osWorkspaceContext().workspace_path; server: wsHost.activePath). */
  getWorkspacePath: () => string | null | undefined
  /** Create the representation widget; returns its surface id. */
  createSurface: (desc: any) => string
  /** Patch the representation widget (e.g. repaint to a disconnected state). */
  updateSurface?: (id: string, patch: Record<string, unknown>) => unknown
  /** Close the representation widget (clean teardown on an explicit drop). */
  closeSurface?: (id: string) => unknown
  /** Current surfaces (to find persisted connection widgets to adopt on reconnect across a restart). */
  getSurfaces?: () => Array<Record<string, unknown>>
  /** Whether an agent is running to author the view — for an honest placeholder (default: false). */
  isAgentAvailable?: () => boolean
  /** Workspace-watcher self-write suppression (defaults to workspace.mjs markWrite). */
  markWrite?: (p: string) => void
}

export function makeConnectionOps(deps: ConnectionOpsDeps): ConnectionOps
