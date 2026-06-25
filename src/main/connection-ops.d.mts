// Types for the shared connection ops binding (connection-ops.mjs).

/** A per-connection backend ADAPTER — the only per-type code (tab = the Chrome extension link; window =
 *  the BlitzOS helper). It executes a verb and reports "source changed" out-of-band by calling
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
  /** The connectable's own id (chrome tab id / safari tabId / window id) — surfaced in connectionList so the
   *  renderer picker can mark the EXACT source as connected. */
  ref?: number | string
  /** The chat session that attached this source ('' = the new-session composer, reassigned on spawn). Owner-scopes
   *  connection_list per chat + targets the attach moment. */
  agentId?: string
  /** WHOSE source this is, surfaced in connectionList so the agent works in a user-attached source instead of
   *  defaulting to its own Blitz Chrome: 'user-chrome' | 'user-safari' = the user's own browser they connected;
   *  'window' = a native macOS app; 'blitz-chrome' = the agent's own browser. */
  origin?: 'user-chrome' | 'user-safari' | 'window' | 'blitz-chrome'
}

export interface ConnectionInfo {
  connId: string
  type: 'tab' | 'window'
  sourceId: string
  title: string
  status: string
  capabilities: Record<string, boolean>
  surfaceId: string | null
  ref?: number | string | null
  agentId?: string
  savedTools: Array<{ name: string; description: string; kind: string }>
  description?: string
}

/** A source's official integration that exists but has NOT been unlocked yet — surfaced under
 *  connection_list_tools' `unlock`. MCP-free: the agent just sees a source it can unlock for more tools. */
export interface ConnectionUnlock {
  source: string
  label: string
  prompt: string
}

/** The result of connection_list_tools: the merged, agent-facing toolkit. Provenance (banked-JS vs the hidden
 *  brokered integration) is never exposed; on a name collision the brokered tool wins. */
export interface ConnectionToolkit {
  sourceId: string
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  unlock?: ConnectionUnlock[]
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
  /** Re-key a connection to a new sourceId after a cross-origin nav (same connId+widget, new per-source tools). */
  connectionRekey(connId: string, newSourceId: string): Record<string, unknown>
  /** Called when a surface closes; if it's a connection's widget, drop the connection (no leaked adapter). */
  handleSurfaceClosed(surfaceId: string): Promise<void>
  /** On (re)hydrate: rewrite a persisted connection widget to a disconnected state if its connection isn't live; else null. */
  rewriteHydratedSurface(surface: Record<string, unknown>): Record<string, unknown> | null
  /** The tab link registers itself so connection_list_tabs / connection_connect_tab work. `openAgentWindow`
   *  (CDP/AI-browser) opens a per-agent background window in the dedicated AI Chrome. */
  setTabLink(
    link: {
      listTabs: () => Promise<unknown>
      connectTab: (tabId: number, opts?: any) => Promise<unknown>
      openAgentWindow?: (agentId: string, opts?: any) => Promise<unknown>
      isConnected?: () => boolean
    } | null
  ): void
  /** The Safari link (Apple Events) registers itself; its tabs merge into connection_list_tabs (browser:'safari'). */
  setSafariLink(link: { listTabs: () => Promise<unknown>; connectTab: (tabId: string, opts?: any) => Promise<unknown> } | null): void
  /** The Chrome Apple-Events link registers itself; its tabs merge into connection_list_tabs (browser:'chrome'). Replaces the deprecated connector extension. */
  setChromeAsLink(link: { listTabs: () => Promise<unknown>; connectTab: (tabId: string, opts?: any) => Promise<unknown> } | null): void
  connectionListTabs(): Promise<Record<string, unknown>>
  connectionConnectTab(tabId: number | string, opts?: { title?: string; sourceId?: string; agentId?: string; browser?: string }): Promise<Record<string, unknown>>
  /** The window link (Electron-only) registers itself so connection_list_windows / connection_connect_window work. */
  setWindowLink(link: { listWindows: () => Promise<unknown>; connectWindow: (windowId: number, opts?: any) => Promise<unknown> } | null): void
  connectionListWindows(): Promise<Record<string, unknown>>
  connectionConnectWindow(windowId: number, opts?: { title?: string; sourceId?: string; agentId?: string }): Promise<Record<string, unknown>>
  /** Reconnect a source by sourceId (the Reconnect button on a disconnected widget): re-finds + connects the tab/window. */
  connectionReconnectSource(sourceId: string, type?: 'tab' | 'window', opts?: { agentId?: string }): Promise<Record<string, unknown>>
  /** Boot / link-(re)connect auto-restore: re-bind every persisted-but-dead connection to its still-open tab/window
   *  (preserving the owning agent). Idempotent; sources whose tab/window is gone stay disconnected. */
  connectionRestoreAll(): Promise<{ restored: number; total: number; skipped?: string }>

  /** Force-install the connector extension (Electron + macOS only); registered via setInstaller. */
  setInstaller(fn: (() => Promise<{ ok: boolean; error?: string; note?: string }>) | null): void
  connectionInstallExtension(): Promise<Record<string, unknown>>
  /** Ensure the dedicated AI Chrome is running (ai-browser.ts, Electron + macOS only); registered via setBrowserLauncher. */
  setBrowserLauncher(fn: (() => Promise<unknown>) | null): void
  /** Open (or get) an agent's dedicated background window in the AI Chrome — a CDP-driven tab connection. */
  connectionOpenBrowser(agentId: string, opts?: { url?: string; title?: string; sourceId?: string }): Promise<Record<string, unknown>>
  /** Navigate a connected tab (the AI-browser window or any Chrome tab) to a URL. */
  connectionNavigate(connId: string, url: string): Promise<Record<string, unknown>>
  /** All connections, or only `forAgent`'s (self-reported scoping; undefined = all, '' = the new-session bucket). */
  connectionList(forAgent?: string): { connections: ConnectionInfo[] }
  /** Reassign every source owned by `fromAgent` (default '') to `toAgent`; returns what moved (for the spawn brief). */
  connectionReassign(toAgent: string, fromAgent?: string): Array<{ connId: string; type: string; sourceId: string; title: string }>
  /** Transfer ONE connection to a chat (the dedup re-attach path: a re-attached live source follows to the chat
   *  now attaching it, so it lists under THIS chat instead of vanishing). Last attacher wins; wakes the new owner. */
  connectionSetOwner(connId: string, agentId?: string): { ok?: boolean; changed?: boolean; error?: string }
  connectionRead(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionAct(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Bring the surface behind a connection to the foreground (connection_reveal). */
  connectionReveal(connId: string): Promise<Record<string, unknown>>
  connectionRunJs(connId: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionSaveTool(connId: string, tool: { name: string; description?: string; kind?: string; code?: string; steps?: unknown }): Record<string, unknown>
  /** A connection's merged toolkit (banked-JS UNIONed with the hidden brokered integration's tools) + any `unlock`.
   *  SYNC (reads the detection cache); fires detection fire-and-forget when the cache is cold. Or { error }. */
  connectionListTools(connId: string): ConnectionToolkit | { error: string }
  /** Run a tool on a connection: routes invisibly to the hidden brokered integration or the page. Returns the real
   *  effect/text, { stale } for a rotten banked tool, or { needsApproval, source, prompt } when the source has an
   *  integration to unlock. Or { error }. */
  connectionCallTool(connId: string, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  connectionDrop(connId: string): Promise<Record<string, unknown>>
  connectionSetDescription(connId: string, text: string): Record<string, unknown>
  /** The op behind /connection_unlock — unlock a source's official integration as an INVISIBLE tool provenance.
   *  Idempotent per sourceId (a live hidden connection is reused). detect (DCR-eligible only) → if a stored token
   *  bundle exists, REUSE it (no human step, tools appear immediately) → else bind the loopback port first, DCR
   *  register with that exact redirect_uri, arm the authorize URL, open the browser, and register a HIDDEN 'pending'
   *  connection (filtered from connectionList). RETURNS IMMEDIATELY ({ ok, status:'pending'|'live', source, authUrl? });
   *  the human approval resolves on a separate path (persist tokens → handshake → flip the hidden record to
   *  'live'/'error' + emit a connection moment, so the source's tools enter connection_list_tools). Or { ok:false,
   *  error, source }. NEVER blocks up to the loopback timeout. All agent-facing text is MCP-free. */
  connectMcp(opts: { sourceId: string; agentId?: string; workspaceDir?: string }): Promise<Record<string, unknown>>
  /** Prime the `unlock` affordance: detect (once, deduped, cached) whether a sourceId has a DCR-eligible official
   *  integration, so connection_list_tools can synchronously decide to surface `unlock`. Fired fire-and-forget on
   *  every tab/window connect. Returns the cached detection entry. */
  ensureMcpDetected(sourceId: string): Promise<{ available: boolean; dcr: boolean; endpoint?: string; asMeta?: unknown; scopes?: string[]; at: number } | null>
  /** Boot/workspace rehydrate for the HIDDEN brokered connections (no representation surface): re-establish every
   *  previously-approved source from the encrypted token store, minting from the kept refresh_token with no human
   *  step; the restored connections stay hidden. Idempotent; a source whose refresh fails lands 'error'/'reauth'. */
  mcpRestoreAll(): Promise<{ restored: number; total: number; skipped?: string }>
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
  /** First-party tool-registry base URL (defaults to BLITZ_TOOL_REGISTRY_URL). */
  registryUrl?: string
  /** Injectable fetch (tests; defaults to global fetch). */
  fetchImpl?: typeof fetch
  /** Curated MCP detection registry base (sourceId→endpoint map); defaults to BLITZ_MCP_REGISTRY_URL || BLITZ_TOOL_REGISTRY_URL. */
  mcpRegistryUrl?: string
  /** Open the one-time MCP OAuth authorize URL in the user's browser (Electron: shell.openExternal; server: no-op). */
  openExternal?: (url: string) => void
}

export function makeConnectionOps(deps: ConnectionOpsDeps): ConnectionOps
