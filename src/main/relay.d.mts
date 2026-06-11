// Types for the shared agent-socket relay lifecycle (relay.mjs).

export interface RelayConfig {
  appId: string
  baseUrl: string
  appDescription: string
  agentsMd: string
  /** The SDK-shaped tool array (path/description/input_schema?/handler). */
  tools: Array<{ path: string; description: string; input_schema?: Record<string, unknown>; handler: (ctx: { body?: string }) => unknown }>
  label?: string
}

export interface RelayAdapter {
  /** Publish the (possibly remapped) agent URL — Electron: webContents.send; server: SSE broadcast. */
  onUrl?: (url: string) => void
  /** Publish online/offline so the UI can show it. */
  onStatus?: (online: boolean, url: string | null) => void
}

export interface RelayHandle {
  getUrl: () => string | null
  isOnline: () => boolean
  stop: () => void
}

/** Connect to the agent-socket relay and keep it healthy forever (self-heal + watchdog). One impl, both modes. */
export function startRelay(cfg: RelayConfig, adapter?: RelayAdapter): RelayHandle
