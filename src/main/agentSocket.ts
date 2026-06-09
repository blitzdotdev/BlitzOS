import type { BrowserWindow } from 'electron'
import { startRelay } from './relay.mjs'
import { setRelay } from './sessionFile'
import { OS_TOOLS } from './electron-os-tools'
// The single source of truth for the BlitzOS operating doc. Vite inlines the .md at
// build (the main bundle has no runtime fs access to it); the server preview reads the
// same file at runtime. Edit src/main/blitzos-agents.md, then relaunch.
import AGENTS_MD from './blitzos-agents.md?raw'

const RELAY = process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev'
const APP_ID = process.env.AGENT_SOCKET_APP_ID || 'as_app_anon'

let currentUrl: string | null = null

export function getAgentSocketUrl(): string | null {
  return currentUrl
}

/**
 * Connect the Electron main to the agent-socket relay via the SHARED relay lifecycle (relay.mjs) — the SAME
 * module the server (preview/backend.mjs) uses, so the connect/self-heal/watchdog/status can NEVER diverge.
 * This Electron path only supplies its tool registry + the adapter: publish the URL/status to the renderer
 * and restart the brain on a reconnect (so it doesn't keep a dead URL).
 */
export function startAgentSocket(getWindow: () => BrowserWindow | null, restartBrain: () => void = () => {}): void {
  startRelay(
    {
      appId: APP_ID,
      baseUrl: RELAY,
      appDescription: 'BlitzOS: an agent OS desktop. Open and arrange surfaces on an infinite canvas.',
      agentsMd: AGENTS_MD,
      label: 'blitzos',
      // The relay (untrusted) path of the SHARED tool registry — see os-tools.mjs (bound for Electron in
      // electron-os-tools.ts). Every tool runs with transport:'relay'. To add/change a tool, edit os-tools.mjs.
      tools: OS_TOOLS.map((t) => ({
        path: t.path,
        description: t.description,
        ...(t.input_schema ? { input_schema: t.input_schema } : {}),
        handler: (ctx: { body?: string }) => t.handler({ body: ctx?.body ?? '', transport: 'relay' })
      }))
    },
    {
      onUrl: (url) => {
        currentUrl = url
        setRelay(url)
        console.log('[agent-socket] paste this into an AI chat to drive BlitzOS:\n  ' + url)
        getWindow()?.webContents.send('agentsocket:url', url)
      },
      // Mirror the server: tell the renderer whether the brain's relay link is up (drives the toolbar pill).
      onStatus: (online) =>
        getWindow()?.webContents.send('os:action', { type: 'agentStatus', online, agentUrl: currentUrl, brain: !!process.env.BLITZ_AGENT }),
      restartBrain
    }
  )
}
