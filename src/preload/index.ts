import { contextBridge, ipcRenderer } from 'electron'

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
  type: 'create' | 'move' | 'update' | 'close' | 'goToPrimary' | 'chat' | 'activity' | 'group' | 'hydrate' | 'switch' | 'reconcile'
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
    pinned?: boolean
  }>
  /** Screen size in px (so the agent knows what fits). */
  viewport?: { w: number; h: number }
  /** World-space rectangle the user can currently see (so new surfaces land on-screen). */
  view?: { x: number; y: number; w: number; h: number; cx: number; cy: number; scale: number }
  mode?: 'desktop' | 'canvas'
  /** Raw camera transform — persisted to workspace.json (Phase 1). */
  camera?: { x: number; y: number; scale: number }
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
  /** Renderer reports a web surface's guest WebContents id so main can read its DOM. */
  reportWebview(surfaceId: string, wcid: number): void {
    ipcRenderer.send('os:webview', { surfaceId, wcid })
  },
  /** The agent-socket paste URL (for the "Connect AI" affordance). */
  onAgentSocketUrl(cb: (url: string) => void): () => void {
    const listener = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on('agentsocket:url', listener)
    return () => ipcRenderer.removeListener('agentsocket:url', listener)
  },
  /** A bare ⌘ tap forwarded from a focused webview (for double-tap-⌘ pan toggle). */
  onMetaTap(cb: () => void): () => void {
    const listener = (): void => cb()
    ipcRenderer.on('os:metatap', listener)
    return () => ipcRenderer.removeListener('os:metatap', listener)
  },

  /** Report a live webview's guest webContents id so main can CDP-drive it. */
  registerWebview(windowId: string, webContentsId: number): void {
    ipcRenderer.send('os:register-webview', windowId, webContentsId)
  },
  unregisterWebview(windowId: string): void {
    ipcRenderer.send('os:unregister-webview', windowId)
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
  /** The user typed a message to the agent in the in-canvas Chat. */
  sendMessage(text: string): void {
    ipcRenderer.send('os:user-message', text)
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
  /** Record the human's one-time consent for (surface, provider). */
  grantConsent(surfaceId: string, provider: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('widget:consent', surfaceId, provider)
  },
  /** Drop all consent for a surface (its widget code changed → re-approval required). */
  revokeConsent(surfaceId: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('widget:consent:revoke', surfaceId)
  },

  // Workspaces (one feature, both modes). Electron thumbnails are captured main-side (capturePage)
  // and served over the blitz-thumb:// protocol; switching is the shared host's atomic switch.
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    switch: (name: string) => ipcRenderer.invoke('workspace:switch', name),
    captureThumb: (name: string) => ipcRenderer.invoke('workspace:capture', name),
    thumbUrl: (name: string, ts?: number) => `blitz-thumb://t/?name=${encodeURIComponent(name)}${ts ? `&t=${ts}` : ''}`
  } as WorkspacesApi,

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
