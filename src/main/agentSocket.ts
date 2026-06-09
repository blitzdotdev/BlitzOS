import { BrowserWindow } from 'electron'
import { connect, type Session } from '@agent-socket/sdk'
import { setRelay } from './sessionFile'
import { OS_TOOLS } from './electron-os-tools'
// The single source of truth for the BlitzOS operating doc. Vite inlines the .md at
// build (the main bundle has no runtime fs access to it); the server preview reads the
// same file at runtime. Edit src/main/blitzos-agents.md, then relaunch.
import AGENTS_MD from './blitzos-agents.md?raw'
import { injectConnectors } from './integrations'

const RELAY = process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev'
const APP_ID = process.env.AGENT_SOCKET_APP_ID || 'as_app_anon'

let session: Session | null = null
let currentUrl: string | null = null

export function getAgentSocketUrl(): string | null {
  return currentUrl
}

async function publish(getWindow: () => BrowserWindow | null): Promise<void> {
  if (!session) return
  const link = await session.mintAgentToken({ label: 'blitzos' })
  currentUrl = link.url
  setRelay(link.url)
  console.log('[agent-socket] paste this into an AI chat to drive BlitzOS:\n  ' + link.url)
  console.log('[agent-socket] session written to ~/.blitzos/session.json')
  getWindow()?.webContents.send('agentsocket:url', link.url)
}

export async function startAgentSocket(getWindow: () => BrowserWindow | null): Promise<void> {
  try {
    session = await connect({
      appId: APP_ID,
      baseUrl: RELAY,
      appDescription: 'BlitzOS: an agent OS desktop. Open and arrange surfaces on an infinite canvas.',
      agentsMd: injectConnectors(AGENTS_MD), // {{CONNECTORS}} → live wired/unwired line at connect
      // The relay (untrusted) path of the SHARED tool registry — see os-tools.mjs (bound for Electron in
      // electron-os-tools.ts). Every tool runs with transport:'relay' here (page content is gated to surfaces
      // the user shared, raw eval is blocked). The localhost control server dispatches the SAME registry with
      // transport:'localhost' (trusted), and the server (preview/backend.mjs) builds it from its own ops.
      // To add or change a tool, edit os-tools.mjs once and ALL THREE transports get it.
      tools: OS_TOOLS.map((t) => ({
        path: t.path,
        description: t.description,
        ...(t.input_schema ? { input_schema: t.input_schema } : {}),
        handler: (ctx: { body?: string }) => t.handler({ body: ctx?.body ?? '', transport: 'relay' })
      })),
      onSessionChanged: (info) => {
        if (currentUrl) {
          const next = info.tokensRemapped.get(currentUrl)
          if (next) {
            currentUrl = next
            setRelay(next)
            getWindow()?.webContents.send('agentsocket:url', next)
          }
        }
      }
    })
    await publish(getWindow)
  } catch (e) {
    console.error('[agent-socket] connect failed:', e instanceof Error ? e.message : e)
  }
}
