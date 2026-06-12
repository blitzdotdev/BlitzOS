import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface IntegrationStatus {
  id: string
  name: string
  color: string
  helpUrl: string
  helpText: string
  connected: boolean
  label: string | null
  configured: boolean
}

export interface ConnectResult {
  ok: boolean
  label?: string
  error?: string
  needsConfig?: boolean
}

export interface OsAction {
  type: 'create' | 'move' | 'update' | 'close' | 'focus' | 'goToPrimary' | 'chat' | 'activity' | 'group' | 'hydrate' | 'switch' | 'reconcile' | 'provider-approval' | 'permission-request' | 'surface-contextmenu' | 'agentStatus' | 'session-spawn' | 'session-data' | 'session-exit' | 'action-item' | 'action-item-removed' | 'set-theme'
  [k: string]: unknown
}

export interface OsState {
  surfaces: Array<{
    id: string
    kind: string
    x: number
    y: number
    w: number
    h: number
    z?: number
    zoom?: number
    title: string
    url?: string
    html?: string
    props?: Record<string, unknown>
    component?: string
    role?: string
    pinned?: boolean
  }>
  /** Screen size in px (so the agent knows what fits). */
  viewport?: { w: number; h: number }
  /** World-space rectangle the user can currently see (so new surfaces land on-screen). */
  view?: { x: number; y: number; w: number; h: number; cx: number; cy: number; scale: number }
  mode?: 'desktop' | 'canvas'
  /** Raw camera transform — persisted to workspace.json (Phase 1). */
  camera?: { x: number; y: number; scale: number }
  /** #45 workspace stages: count of tiled desktops (persisted), the active one, and its world rect (so
   *  the agent places surfaces in the stage the human is on). currentStage/currentStageRect are live-only. */
  stageCount?: number
  currentStage?: number
  currentStageRect?: { x: number; y: number; w: number; h: number }
  /** Which workspace this state belongs to — lets the backend drop a stale push after a switch. */
  workspace?: string
}

// Workspace launcher / Mission-Control API. ONE shape for both transports: server (shim) provides
// `thumb` (the renderer composites + uploads); Electron provides `captureThumb` (main capturePage) —
// hence both are optional. list/create/switch/thumbUrl exist in both.
export interface WorkspacesApi {
  list(): Promise<{ workspaces: Array<{ name: string; nodeCount: number; updatedAt: number; thumbTs: number }>; active: string }>
  create(name: string): Promise<{ ok: boolean; name?: string; error?: string }>
  switch(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
  delete(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
  thumbUrl(name: string, ts?: number): string
  thumb?(name: string, dataUrl: string): Promise<{ ok?: boolean; error?: string }>
  captureThumb?(name: string): Promise<{ ok: boolean; error?: string }>
}

const api = {
  /** Control actions from main (local control server or agent-socket) -> renderer. */
  onAction(cb: (a: OsAction) => void): () => void {
    const listener = (_e: unknown, a: OsAction): void => cb(a)
    ipcRenderer.on('os:action', listener)
    return () => ipcRenderer.removeListener('os:action', listener)
  },
  /** Renderer pushes current desktop state so main can answer list_state. */
  sendState(state: OsState): void {
    ipcRenderer.send('os:state', state)
  },
  /** Legacy webview path: renderer reports a guest WebContents id so main can read its DOM. */
  reportWebview(surfaceId: string, wcid: number): void {
    ipcRenderer.send('os:webview', { surfaceId, wcid })
  },
  /** Session terminal I/O — the user typing/resizing/repainting a SessionTerminal (mirrors sendState). */
  sessionInput(id: string, data: string): void {
    ipcRenderer.send('os:session-input', { id, data })
  },
  sessionResize(id: string, cols: number, rows: number): void {
    ipcRenderer.send('os:session-resize', { id, cols, rows })
  },
  sessionRead(id: string): Promise<string> {
    return ipcRenderer.invoke('os:session-read', id) as Promise<string>
  },
  /** Open a new session from the UI (a "+ Terminal" button) — the backend emits session-spawn which auto-opens its terminal. */
  sessionSpawn(opts: { command?: string; title?: string }): void {
    ipcRenderer.send('os:session-spawn', opts)
  },
  /** Open a NEW chat session from the UI (a "+ Chat" button) — a fresh peer agent + its own chat widget.
   *  The host broadcasts a `create` for the new chat surface, so it appears without a refresh. */
  spawnChatSession(title?: string): void {
    ipcRenderer.send('os:chat-session-spawn', { title })
  },
  /** List every session in the active workspace (running + persisted) — for the Sessions tray. */
  sessionList(): Promise<unknown[]> {
    return (ipcRenderer.invoke('os:session-list') as Promise<unknown[]>).catch(() => [])
  },
  /** Stop (kill) a session by id. */
  sessionStop(id: string): void {
    ipcRenderer.send('os:session-stop', id)
  },
  /** Re-spawn a dead session from its persisted meta (one-click resume) — emits session-spawn. */
  sessionRestart(id: string): void {
    ipcRenderer.send('os:session-restart', id)
  },
  /** Action-items inbox (human side): list / resolve (tick) / clear a resolved item. */
  actionList(status?: string): Promise<unknown[]> {
    return (ipcRenderer.invoke('os:action-list', status) as Promise<unknown[]>).catch(() => [])
  },
  actionResolve(id: string, resolution?: string): void {
    ipcRenderer.send('os:action-resolve', { id, resolution })
  },
  actionClear(id: string): void {
    ipcRenderer.send('os:action-clear', id)
  },
  /** The agent-socket paste URL (for the "Connect AI" affordance). */
  onAgentSocketUrl(cb: (url: string) => void): () => void {
    const listener = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on('agentsocket:url', listener)
    return () => ipcRenderer.removeListener('agentsocket:url', listener)
  },
  /** App keybinds forwarded from main's before-input-event — they fire regardless of which guest
   *  (iframe/WebContentsView) holds keyboard focus. id 'tile': ⌘T toggle / ⇧⌘T cycle size. */
  onKeybind(cb: (k: { id: string; shift: boolean }) => void): () => void {
    const listener = (_e: unknown, k: { id: string; shift: boolean }): void => cb(k)
    ipcRenderer.on('os:keybind', listener)
    return () => ipcRenderer.removeListener('os:keybind', listener)
  },
  /** A bare ⌘ tap forwarded from a focused browser guest (for double-tap-⌘ pan toggle). */
  onMetaTap(cb: () => void): () => void {
    const listener = (): void => cb()
    ipcRenderer.on('os:metatap', listener)
    return () => ipcRenderer.removeListener('os:metatap', listener)
  },

  /** Legacy webview path: report a live guest webContents id so main can CDP-drive it. */
  registerWebview(windowId: string, webContentsId: number): void {
    ipcRenderer.send('os:register-webview', windowId, webContentsId)
  },
  unregisterWebview(windowId: string): void {
    ipcRenderer.send('os:unregister-webview', windowId)
  },
  /** Electron-only: main owns live web surfaces as WebContentsViews (one per browser TAB); the
   *  renderer declares the tab list + reports layout, main pushes per-tab page state back. */
  webContentsViewSync(payload: { id: string; tabs: Array<{ id: string; url?: string }>; active: string | null; zoom?: number }): void {
    ipcRenderer.send('os:webcontents-view:sync', payload)
  },
  webContentsViewBounds(payload: { id: string; rect: { x: number; y: number; width: number; height: number }; visible: boolean; z: number; zoom?: number }): void {
    ipcRenderer.send('os:webcontents-view:bounds', payload)
  },
  webContentsViewNavigate(id: string, tabId: string | null, url: string): void {
    ipcRenderer.send('os:webcontents-view:navigate', { id, tabId, url })
  },
  /** Browser chrome buttons → the surface's active tab. */
  webContentsViewNavAction(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
    ipcRenderer.send('os:webcontents-view:nav-action', { id, action })
  },
  /** Sandwich input router: forward a pointer/wheel event landing on a browser HOLE to its page.
   *  Coordinates are view-local CSS px; wheel deltas are the DOM's (main negates for Electron). */
  pageInput(id: string, ev: { type: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: number; clicks?: number; dx?: number; dy?: number; modifiers?: string[] }): void {
    ipcRenderer.send('os:page-input', { id, ev })
  },
  /** Keyboard handoff: typing target is this page (pages window becomes key, stays under the UI). */
  pageFocus(id: string): void {
    ipcRenderer.send('os:page-focus', id)
  },
  /** Keyboard back to the UI window (any pointerdown on UI chrome). */
  uiFocus(): void {
    ipcRenderer.send('os:ui-focus')
  },
  /** Titlebar drag: 'start' latches the window origin, 'move' applies screen deltas (main moves the
   *  parent window of the sandwich; CSS app-region cannot be used on the attached child). */
  shellDrag(op: 'start' | 'move', dx = 0, dy = 0): void {
    ipcRenderer.send('os:shell-drag', { op, dx, dy })
  },
  /** The page's cursor changed (text beam over inputs, hand over links) — mirror it onto the hole. */
  onPageCursor(cb: (m: { surfaceId: string; cursor: string }) => void): () => void {
    const listener = (_e: unknown, m: { surfaceId: string; cursor: string }): void => cb(m)
    ipcRenderer.on('os:page-cursor', listener)
    return () => ipcRenderer.removeListener('os:page-cursor', listener)
  },
  webContentsViewFocus(id: string): void {
    ipcRenderer.send('os:webcontents-view:focus', id)
  },
  webContentsViewClose(id: string): void {
    ipcRenderer.send('os:webcontents-view:close', id)
  },
  /** Per-tab page state pushed from main: {patch} = url/title/favicon/loading/canGoBack/canGoForward;
   *  {removed} = the tab's webContents died; {openTab} = a popup wants a new tab in this surface. */
  onWebTab(
    cb: (m: {
      surfaceId: string
      tabId?: string
      patch?: { url?: string; title?: string; favicon?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean }
      removed?: boolean
      openTab?: { url: string }
    }) => void
  ): () => void {
    const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
    ipcRenderer.on('os:web-tab', listener)
    return () => ipcRenderer.removeListener('os:web-tab', listener)
  },
  /** Machine-global browser bookmarks (root journal). */
  bookmarksList(): Promise<Array<{ id: string; url: string; title: string; addedAt: number }>> {
    return (ipcRenderer.invoke('os:bookmarks') as Promise<Array<{ id: string; url: string; title: string; addedAt: number }>>).catch(() => [])
  },
  bookmarksToggle(url: string, title: string): Promise<Array<{ id: string; url: string; title: string; addedAt: number }>> {
    return (ipcRenderer.invoke('os:bookmarks-toggle', { url, title }) as Promise<Array<{ id: string; url: string; title: string; addedAt: number }>>).catch(() => [])
  },
  /** A srcdoc surface (agent-authored UI) fired an action back to the agent. */
  surfaceAction(payload: Record<string, unknown>): void {
    ipcRenderer.send('os:surface-action', payload)
  },
  /** Human consent: let the agent read this web surface's content over the relay (P0). */
  setContentShare(surfaceId: string, on: boolean): void {
    ipcRenderer.send('os:content-share', { surfaceId, on })
  },
  /** Capture a web surface's current frame as a data URL (for folder previews). */
  captureSurface(surfaceId: string): Promise<string | null> {
    return ipcRenderer.invoke('surface:capture', surfaceId)
  },
  /** Best-effort: the user's macOS wallpaper as a downscaled data URL (frosted onboarding backdrop). */
  getWallpaper(): Promise<string | null> {
    return ipcRenderer.invoke('os:wallpaper')
  },
  /** The user typed a message to a chat session's agent (sessionId '0' = the primary chat). */
  sendMessage(text: string, sessionId = '0'): void {
    ipcRenderer.send('os:user-message', { text, sessionId })
  },
  /** Item 5b: the human placed a spatial annotation on a surface + asked about that point. Lands in chat
   *  + wakes the agent with a surface-anchored moment carrying the point. */
  annotate(p: { id: string; surfaceId: string; text: string; xPct: number; yPct: number }): void {
    ipcRenderer.send('os:annotate', p)
  },
  /** The chat hub manages its sessions: op 'new' → { id } of a fresh session; 'rename' → set its title. */
  chatControl(op: string, args: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('os:chat-control', { op, args })
  },
  /** Ask main to (re)send the persisted canvas as a hydrate, once our onAction listener is up. */
  requestHydrate(): void {
    ipcRenderer.send('workspace:request-hydrate')
  },

  /** Relay a sandboxed srcdoc widget's data request to main (consent-gated; token stays in main). */
  widgetRequest(req: {
    surfaceId: string
    op: 'data'
    provider: string
    resource: string
  }): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }> {
    return ipcRenderer.invoke('widget:req', req)
  },
  /** A sandboxed widget calls an OS tool via blitz.tool (gated by the `tools` capability; CLOSED allowlist). */
  widgetTool(surfaceId: string, name: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return ipcRenderer.invoke('widget:tool', { surfaceId, name, args })
  },
  /** Record the human's one-time consent for (surface, provider). */
  grantConsent(surfaceId: string, provider: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('widget:consent', surfaceId, provider)
  },
  /** Drop all consent for a surface (its widget code changed → re-approval required). */
  revokeConsent(surfaceId: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('widget:consent:revoke', surfaceId)
  },

  // #51 provider-access: the renderer answers a write-approval card + grants sensitive-read consent.
  approveProviderCall(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('os:provider-approve', id)
  },
  denyProviderCall(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('os:provider-deny', id)
  },
  grantProviderConsent(provider: string, allow: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('os:provider-consent', provider, allow)
  },
  // Item 3: the human answered a web guest's Allow/Block permission prompt (geolocation, camera, …).
  decidePermission(id: string, allow: boolean, remember: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('os:permission-decide', id, allow, remember)
  },
  // #52: group surfaces into a REAL folder on disk (mkdir + mv). Server mode overrides this in the shim.
  // kind:'board' → a '.board' on-canvas folder (windows/widgets splay live); else a normal file folder.
  groupIntoFolder(name: string, ids: string[], kind?: 'board' | 'folder'): Promise<{ ok: boolean; folder?: string; moved?: number; error?: string }> {
    return ipcRenderer.invoke('os:group', name, ids, kind)
  },
  // Drag-drop: resolve dropped File objects to absolute OS paths (Electron only — the browser has none),
  // then copy them into the workspace (folders recursively). Server mode uploads bytes instead.
  dropPaths(files: File[]): string[] {
    const out: string[] = []
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f)
        if (p) out.push(p)
      } catch {
        /* not a real OS file (e.g. a synthetic drag) */
      }
    }
    return out
  },
  ingestPaths(paths: string[], x: number, y: number): Promise<{ ok: boolean; copied?: number; error?: string }> {
    return ipcRenderer.invoke('os:ingest-paths', paths, x, y)
  },
  // "New Folder" (files) / "New Board" (windows+widgets) — the right-click desktop action.
  newFolder(name: string, kind: 'board' | 'folder', x: number, y: number): Promise<{ ok: boolean; folder?: string; error?: string }> {
    return ipcRenderer.invoke('os:new-folder', name, kind, x, y)
  },
  // List a normal folder's contents for the file-manager overlay (server shim fetches /api/os/dir instead).
  listDir(path: string): Promise<{ path: string; entries: unknown[]; total: number; truncated: boolean } | null> {
    return ipcRenderer.invoke('os:dir', path)
  },
  // Close = delete the closed window's backing content file so it doesn't resurrect on the next reconcile.
  closeSurfaceFile(id: string): Promise<{ ok: boolean; removed?: string }> {
    return ipcRenderer.invoke('os:close-surface-file', id)
  },

  // Workspaces (one feature, both modes). Electron thumbnails are captured main-side (capturePage)
  // and served over the blitz-thumb:// protocol; switching is the shared host's atomic switch.
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    switch: (name: string) => ipcRenderer.invoke('workspace:switch', name),
    delete: (name: string) => ipcRenderer.invoke('workspace:delete', name),
    captureThumb: (name: string) => ipcRenderer.invoke('workspace:capture', name),
    thumbUrl: (name: string, ts?: number) => `blitz-thumb://t/?name=${encodeURIComponent(name)}${ts ? `&t=${ts}` : ''}`
  } as WorkspacesApi,

  // Onboarding (P1 director): start the scan+board flow, stream real scan progress to the boot
  // screen, and drive the FDA tutorial-unlock card.
  onboarding: {
    start(): Promise<{ ok: boolean; cached?: boolean }> {
      return ipcRenderer.invoke('onboarding:start')
    },
    fdaStatus(): Promise<{ fda: boolean; appName: string }> {
      return ipcRenderer.invoke('onboarding:fda-status')
    },
    openFdaSettings(): Promise<{ ok: boolean; appName: string }> {
      return ipcRenderer.invoke('onboarding:open-fda-settings')
    },
    dismissUnlock(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('onboarding:dismiss-unlock')
    },
    onProgress(cb: (p: Record<string, unknown>) => void): () => void {
      const listener = (_e: unknown, p: Record<string, unknown>): void => cb(p)
      ipcRenderer.on('onboarding:progress', listener)
      return () => ipcRenderer.removeListener('onboarding:progress', listener)
    }
  },

  integrations: {
    list(): Promise<IntegrationStatus[]> {
      return ipcRenderer.invoke('integrations:list')
    },
    connect(id: string): Promise<ConnectResult> {
      return ipcRenderer.invoke('integrations:connect', id)
    },
    disconnect(id: string): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('integrations:disconnect', id)
    },
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke('integrations:openExternal', url)
    },
    onUpdated(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on('integrations:updated', listener)
      return () => ipcRenderer.removeListener('integrations:updated', listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentOS', api)

export type AgentOSApi = typeof api
