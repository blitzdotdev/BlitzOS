import { BrowserWindow } from 'electron'
import { connect, type Session } from '@agent-socket/sdk'
import {
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osCloseSurface,
  osGoToPrimary,
  osGetState,
  type SurfaceDescriptor
} from './osActions'

const RELAY = process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev'
const APP_ID = process.env.AGENT_SOCKET_APP_ID || 'as_app_anon'

function parse(body: string): Record<string, unknown> {
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const AGENTS_MD = `# BlitzOS

BlitzOS is an "agent OS" desktop: an infinite canvas of surfaces the user is watching in real time. You open and arrange surfaces; the user sees every action on their screen. Coordinates are world pixels; omit position to center in the user's view.

A **surface** is one of four kinds:
- **web**: a live browser of any URL (third-party sites, e.g. Discord, Google). Use for real external sites.
- **app**: an iframe of a first-party blitz.dev app URL. Use for blitz.dev projects.
- **srcdoc**: a sandboxed iframe of HTML *you write inline* — no backend, no network. Use to invent a small tool/visualization (a calculator, a chart, a timer).
- **native**: a built-in widget by name. Currently component "note" = a post-it the user can type in (props: { text?, color?: yellow|pink|blue|green }).

## Tools
- POST /create_surface {kind, x?, y?, w?, h?, title?, url?, html?, component?, props?} -> creates a surface, returns {id}.
- POST /open_window {url, x?, y?, w?, h?, title?} -> shortcut for a web surface, returns {id}.
- POST /move_surface {id, x, y} -> move a surface.
- POST /close_surface {id} -> close a surface.
- POST /go_to_primary -> recenter on the primary workspace.
- POST /list_state -> {surfaces:[{id,kind,x,y,w,h,title,url}]} currently open.
`

let session: Session | null = null
let currentUrl: string | null = null

export function getAgentSocketUrl(): string | null {
  return currentUrl
}

async function publish(getWindow: () => BrowserWindow | null): Promise<void> {
  if (!session) return
  const link = await session.mintAgentToken({ label: 'blitzos' })
  currentUrl = link.url
  console.log('[agent-socket] paste this into an AI chat to drive BlitzOS:\n  ' + link.url)
  getWindow()?.webContents.send('agentsocket:url', link.url)
}

export async function startAgentSocket(getWindow: () => BrowserWindow | null): Promise<void> {
  try {
    session = await connect({
      appId: APP_ID,
      baseUrl: RELAY,
      appDescription: 'BlitzOS: an agent OS desktop. Open and arrange surfaces on an infinite canvas.',
      agentsMd: AGENTS_MD,
      tools: [
        {
          path: '/create_surface',
          description:
            'Create a surface (kind: web | app | srcdoc | native). web/app take url; srcdoc takes html; native takes component+props.',
          input_schema: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['web', 'app', 'srcdoc', 'native'] },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              title: { type: 'string' },
              url: { type: 'string' },
              html: { type: 'string' },
              component: { type: 'string' },
              props: { type: 'object' }
            }
          },
          handler: ({ body }) => {
            const a = parse(body) as unknown as SurfaceDescriptor
            if (!a.kind) return { status: 400, body: { error: 'kind required' } }
            return { id: osCreateSurface(a) }
          }
        },
        {
          path: '/open_window',
          description: 'Open a third-party website as a live web surface. Returns its id.',
          input_schema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              title: { type: 'string' }
            }
          },
          handler: ({ body }) => {
            const a = parse(body)
            if (typeof a.url !== 'string') return { status: 400, body: { error: 'url required' } }
            return { id: osOpenWindow(a as { url: string }) }
          }
        },
        {
          path: '/move_surface',
          description: 'Move a surface to (x, y) world pixels.',
          input_schema: {
            type: 'object',
            required: ['id', 'x', 'y'],
            properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }
          },
          handler: ({ body }) => {
            const a = parse(body)
            osMoveSurface(String(a.id), Number(a.x), Number(a.y))
            return { ok: true }
          }
        },
        {
          path: '/close_surface',
          description: 'Close a surface by id.',
          input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          handler: ({ body }) => {
            osCloseSurface(String(parse(body).id))
            return { ok: true }
          }
        },
        {
          path: '/go_to_primary',
          description: 'Recenter the view on the primary workspace.',
          handler: () => {
            osGoToPrimary()
            return { ok: true }
          }
        },
        {
          path: '/list_state',
          description: 'List the surfaces currently open on the canvas.',
          handler: () => osGetState()
        }
      ],
      onSessionChanged: (info) => {
        if (currentUrl) {
          const next = info.tokensRemapped.get(currentUrl)
          if (next) {
            currentUrl = next
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
