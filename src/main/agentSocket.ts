import type { BrowserWindow } from 'electron'
import { startRelay } from './relay.mjs'
import { setRelay } from './sessionFile'
import { OS_TOOLS } from './electron-os-tools'
import { osNoteAgentActivity } from './osActions'
// Shared "Agent activity" feed — the SAME module the server uses; only `emit` differs (webContents.send here).
import { withActivity } from './activity.mjs'
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
 * and report each URL change so the agents' .blitzos/relay-url file is refreshed (they re-read it per call).
 */
export function startAgentSocket(getWindow: () => BrowserWindow | null, onUrlChange: (url: string) => void = () => {}): void {
  // Destruction-guarded renderer send. A bare getWindow()?.webContents.send THROWS "Render frame was
  // disposed before WebFrameMain could be accessed" once the renderer has crashed/gone (getWindow still
  // returns the window object, but its frame is dead). The relay status timer keeps firing onStatus after
  // a render-process-gone, so without this guard EVERY cycle threw during a GPU/renderer crash and spammed
  // the log on top of the crash. Drop the send when the frame is gone instead.
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return
    try {
      w.webContents.send(channel, payload)
    } catch {
      /* frame disposed between the check and the send (mid-crash) */
    }
  }
  startRelay(
    {
      appId: APP_ID,
      baseUrl: RELAY,
      appDescription: 'BlitzOS: an agent OS desktop. Open and arrange surfaces on an infinite canvas.',
      agentsMd: AGENTS_MD,
      label: 'blitzos',
      // The relay (untrusted) path of the SHARED tool registry — see os-tools.mjs (bound for Electron in
      // electron-os-tools.ts). Every tool runs with transport:'relay'. To add/change a tool, edit os-tools.mjs.
      // withActivity is the SAME shared wrapper the server uses — it publishes an activity event before each
      // action tool so the on-screen Agent-activity panel shows what the agent is doing (Electron emits it via
      // webContents.send; the server over SSE). This is what Electron was missing — the panel had no feed.
      tools: withActivity(
        OS_TOOLS.map((t) => ({
          path: t.path,
          description: t.description,
          ...(t.input_schema ? { input_schema: t.input_schema } : {}),
          handler: (ctx: { body?: string }) => t.handler({ body: ctx?.body ?? '', transport: 'relay' })
        })),
        (ev) => {
          osNoteAgentActivity(ev.agentId || '0', ev.tool === '/say' ? 'say' : 'tool')
          send('os:action', ev)
        }
      )
    },
    {
      onUrl: (url) => {
        currentUrl = url
        setRelay(url)
        onUrlChange(url) // refresh .blitzos/relay-url so reattached agents pick up the fresh base
        console.log('[agent-socket] paste this into an AI chat to drive BlitzOS:\n  ' + url)
        send('agentsocket:url', url)
      },
      // Tell the renderer whether the agent's relay link is up (drives the toolbar pill).
      onStatus: (online) =>
        send('os:action', { type: 'agentStatus', online, agentUrl: currentUrl, agent: !!process.env.BLITZ_AGENT })
    }
  )
}
