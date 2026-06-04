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
  type: 'create' | 'move' | 'update' | 'close' | 'goToPrimary'
  [k: string]: unknown
}

export interface OsState {
  surfaces: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; title: string; url?: string }>
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
