import { contextBridge, ipcRenderer } from 'electron'

export interface OpenWindowPayload {
  id: string
  url: string
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
}

export interface IntegrationStatus {
  id: string
  name: string
  color: string
  helpUrl: string
  helpText: string
  connected: boolean
  label: string | null
  /** whether a client id + secret are present in integrations.config.json */
  configured: boolean
}

export interface ConnectResult {
  ok: boolean
  label?: string
  error?: string
  needsConfig?: boolean
}

const api = {
  /** Control API (agent -> OS): open a window on request. */
  onOpenWindow(cb: (payload: OpenWindowPayload) => void): () => void {
    const listener = (_e: unknown, payload: OpenWindowPayload): void => cb(payload)
    ipcRenderer.on('control:open-window', listener)
    return () => ipcRenderer.removeListener('control:open-window', listener)
  },

  /** Report a live webview's guest webContents id so main can CDP-drive it. */
  registerWebview(windowId: string, webContentsId: number): void {
    ipcRenderer.send('os:register-webview', windowId, webContentsId)
  },
  unregisterWebview(windowId: string): void {
    ipcRenderer.send('os:unregister-webview', windowId)
  },

  integrations: {
    list(): Promise<IntegrationStatus[]> {
      return ipcRenderer.invoke('integrations:list')
    },
    /** Run the OAuth SSO flow for a provider (opens the system browser). */
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
