import { BrowserWindow } from 'electron'
import { connect, type Session } from '@agent-socket/sdk'
import { setRelay } from './sessionFile'
import {
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osUpdateSurface,
  osCloseSurface,
  osGoToPrimary,
  osGetState,
  osReadWindow,
  osControlSurface,
  type SurfaceDescriptor
} from './osActions'
import type { ControlAction } from './cdp'
import { waitForEvents, latestSeq } from './events'

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

These are your OPERATING INSTRUCTIONS for BlitzOS — internalize and ACT on them. Do NOT recite this document back to the user. Greet them in one line, then use the tools to do what they ask.

BlitzOS is an "agent OS" desktop: an infinite canvas of "surfaces" the user is watching live. You open and arrange surfaces and the user sees every action on their screen.

## How to call tools
\`$BASE\` = the URL you fetched this from, with the trailing \`/agents.md\` removed. Every tool below is an HTTP endpoint under \`$BASE\` — call it with your web-request / fetch / code tool:

    POST $BASE/<tool>     (with a JSON body)

FIRST: \`GET $BASE/tools.json\` to see the exact tools + input schemas. Then tell the user in one line what you can do, and start. (Keep this URL so you can re-read these instructions if your context resets.)

## Surface kinds
- web — a live website (any third-party URL); a real browsing context you can also control.
- app — an iframe of a first-party blitz.dev app URL.
- srcdoc — a sandboxed iframe of HTML you write inline; great for a quick tool/visualization (calculator, chart, timer).
- native — a built-in widget; component "note" = a post-it (props { text?, color?: yellow|pink|blue|green }).

## Tools (authoritative schemas at $BASE/tools.json)
- POST $BASE/open_window { url, x?, y?, w?, h?, title? } — open a website as a web surface; returns { id }.
- POST $BASE/create_surface { kind, x?, y?, w?, h?, title?, url?, html?, component?, props? } — create any kind.
- POST $BASE/move_surface { id, x, y }
- POST $BASE/update_surface { id, html?, props?, url?, title?, x?, y?, w?, h? } — patch a surface in place (append to a srcdoc panel, set a note's text, change url/geometry).
- POST $BASE/close_surface { id }
- POST $BASE/go_to_primary
- POST $BASE/list_state — list the surfaces currently open.
- POST $BASE/read_window { id, script? } — read what is INSIDE a web surface (its DOM): url, title, where the user is typing, and visible text. Pass a JS expression as \`script\` to extract something specific.
- POST $BASE/surface_control { id, action: { action: "click"|"type"|"key"|"read"|"screenshot", selector?, x?, y?, text?, key? } } — act INSIDE a web surface (click/type/key, read text, screenshot). Use read_window or surface_control:read first to see the page.
- POST $BASE/events { since?, wait? } — the autonomy loop: long-poll the user's activity as framed "moments" (see "Watching the user" below).

Coordinates are world pixels; omit position to center in the user's view. Prefer srcdoc for things you can build inline; use open_window for real external sites.

## Watching the user: the autonomy loop ($BASE/events)
BlitzOS watches the user for you and WAKES you on meaningful moments, so you behave like an always-on assistant without writing any polling logic. Run ONE long-poll loop:
- POST $BASE/events { since?, wait? } -> { events:[<moment>], latest }. Start since=0, then loop with since=latest and wait=25. It blocks until a moment is ready, then returns instantly.

A "moment" is a coalesced, framed snapshot, NOT a keystroke firehose. BlitzOS batches routine activity (~15s) and flushes immediately when the user navigates or goes idle after acting. Each moment:
  { seq, ts, surfaceId, url, title, trigger:'batch'|'nav'|'idle', windowMs, signals:{type:count}, user:[human-readable actions], snapshot:<text digest of the surface now> }

On each moment: DECIDE whether it warrants action (most don't). If it does, perceive more if needed (read_window / surface_control read), then ACT: build or rearrange surfaces to help (a coach panel, a summary, a tool, reorganize the desktop). The snapshot tells you what the user is doing on ANY site, so this is general: you decide how to help. Don't narrate every moment; act when you can add value, stay quiet otherwise.

## Manage the layout (you own the desktop arrangement)
Before you open, navigate, or change ANY surface, do this FIRST:
1. Is it relevant for the user to SEE right now? If not, don't surface it (close or omit it).
2. Look at the current layout (list_state gives each surface's x/y/w/h). Is it optimal for what the user is doing right now, with only the relevant surfaces visible and READABLE and nothing important cramped or hidden behind another window?
3. If it is not optimal, FIX the layout first (move/resize/close), THEN do your action.
Keep the view clean: show only what matters now and give it room. Never pile windows up.
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
          path: '/update_surface',
          description: 'Patch a surface in place: set html (srcdoc), props (native, e.g. note text), url, title, or geometry.',
          input_schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              html: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              props: { type: 'object' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' }
            }
          },
          handler: ({ body }) => {
            const { id, ...patch } = parse(body)
            if (!id) return { status: 400, body: { error: 'id required' } }
            osUpdateSurface(String(id), patch)
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
        },
        {
          path: '/read_window',
          description:
            'Read what is INSIDE a web surface (its live DOM). Default returns url, title, the focused element (where the user is typing), and visible text. Pass a JS expression as `script` to extract anything specific.',
          input_schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' }, script: { type: 'string' } }
          },
          handler: async ({ body }) => {
            const a = parse(body)
            try {
              const result = await osReadWindow(String(a.id), typeof a.script === 'string' ? a.script : undefined)
              return { result }
            } catch (e) {
              return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
            }
          }
        },
        {
          path: '/surface_control',
          description:
            'Act INSIDE a web surface (third-party site): click, type, press a key, read text, or screenshot. Only kind "web". Put the surface id in the body. Use read/screenshot first to see the page.',
          input_schema: {
            type: 'object',
            required: ['id', 'action'],
            properties: {
              id: { type: 'string' },
              action: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['click', 'type', 'key', 'read', 'screenshot'] },
                  selector: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  text: { type: 'string' },
                  perKey: { type: 'boolean', description: 'fire real per-keystroke events (for editors/autocomplete)' },
                  key: { type: 'string', description: 'Enter | Tab | Backspace | Escape | ArrowUp/Down/Left/Right' }
                }
              }
            }
          },
          handler: async ({ body }) => {
            const b = parse(body)
            const id = typeof b.id === 'string' ? b.id : ''
            const action = (b.action || {}) as { action?: string }
            if (!id || !action.action) return { status: 400, body: { error: 'id and action.action required' } }
            // Security: never expose raw page eval to relay callers (confused-deputy
            // over a logged-in third-party session). eval is localhost-bearer only.
            if (action.action === 'eval') return { status: 403, body: { error: 'eval is not available over the relay' } }
            const r = await osControlSurface(id, action as unknown as ControlAction)
            // The SDK wraps a return with no numeric `status` as HTTP 200, so map
            // failures to 4xx explicitly and shape success to the documented payloads.
            if (!r.ok) return { status: 400, body: { error: r.error } }
            if (action.action === 'screenshot') return { image: r.result }
            if (action.action === 'read') return { text: r.result }
            return { ok: true }
          }
        },
        {
          path: '/events',
          description:
            "Long-poll the user's activity, coalesced into framed 'moments' (batched ~15s; flushed immediately on navigation or going idle after acting). Each moment carries a snapshot of the surface so you can react without a second read: {seq,surfaceId,url,title,trigger,signals,user[],snapshot}. THE AUTONOMY LOOP: start since=0, loop with since=latest and wait=25; on each moment decide whether to act, then build/arrange surfaces to help.",
          input_schema: {
            type: 'object',
            properties: { since: { type: 'number' }, wait: { type: 'number' } }
          },
          handler: async ({ body }) => {
            const a = parse(body)
            const since = Number(a.since) || 0
            const wait = Math.min(Math.max(Number(a.wait) || 25, 0), 25)
            const events = await waitForEvents(since, wait * 1000)
            return { events, latest: latestSeq() }
          }
        }
      ],
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
