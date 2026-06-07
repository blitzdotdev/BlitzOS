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
  osSay,
  osGroupIntoFolder,
  type SurfaceDescriptor
} from './osActions'
import type { ControlAction } from './cdp'
import { listWidgets, getWidgetSource, saveWidget, WIDGET_AUTHORING_MD } from './widget-catalog.mjs'
import type { SaveWidgetInput } from './widget-catalog.mjs'
import { integrationStatuses, connectedProviders } from './integrations'
import { runProviderCall } from './provider-bridge'
import { waitForEvents, latestSeq, isContentShared, redactMoment, EVENTS_REMINDER } from './events'
// The single source of truth for the BlitzOS operating doc. Vite inlines the .md at
// build (the main bundle has no runtime fs access to it); the server preview reads the
// same file at runtime. Edit src/main/blitzos-agents.md, then relaunch.
import AGENTS_MD from './blitzos-agents.md?raw'

const RELAY = process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev'
const APP_ID = process.env.AGENT_SOCKET_APP_ID || 'as_app_anon'

function parse(body: string): Record<string, unknown> {
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}


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
          path: '/group',
          description:
            'Group related surfaces into ONE REAL folder on disk: makes a subdirectory and MOVES the given surfaces\' files into it. They collapse to one folder tile (drill in to browse) — a real filesystem folder that persists, and a many-file group stays one tile. Pass the ids of 2+ surfaces that share a purpose + a folder name.',
          input_schema: {
            type: 'object',
            required: ['ids', 'name'],
            properties: {
              ids: { type: 'array', items: { type: 'string' } },
              name: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' }
            }
          },
          handler: ({ body }) => {
            const a = parse(body)
            const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : []
            if (!ids.length) return { status: 400, body: { error: 'group needs surface ids' } }
            return osGroupIntoFolder(a.name != null ? String(a.name) : 'Folder', ids, a.x != null ? Number(a.x) : undefined, a.y != null ? Number(a.y) : undefined)
          }
        },
        {
          path: '/list_state',
          description: 'List the surfaces currently open on the canvas.',
          handler: () => osGetState()
        },
        {
          path: '/provider_call',
          description:
            'Make an authenticated request to a CONNECTED integration (provider) and get the JSON back — ' +
            'use it to build whatever the user needs (their unread mail, repos, issues, messages, …). The OS ' +
            'injects the credential server-side; you NEVER see the token. Reads (GET) are broad — pass any path ' +
            "under the provider's API. Writes (POST/PUT/PATCH/DELETE) pop a human approval card. A sensitive read " +
            '(message bodies, file contents) returns code:"consent_required" until the human approves once. ' +
            'Args: {provider, method?, path, query?, body?}. Connected providers are in list_integrations.',
          input_schema: {
            type: 'object',
            required: ['provider', 'path'],
            properties: {
              provider: { type: 'string' },
              method: { type: 'string' },
              path: { type: 'string', description: 'provider-relative, e.g. /user/repos' },
              query: { type: 'object' },
              body: {}
            }
          },
          handler: async ({ body }) => {
            const a = parse(body)
            return runProviderCall(
              { provider: String(a.provider || ''), method: a.method ? String(a.method) : undefined, path: String(a.path || ''), query: a.query as Record<string, unknown> | undefined, body: a.body },
              'relay'
            )
          }
        },
        {
          path: '/read_window',
          description:
            'Read what is INSIDE a web surface (its live DOM): url, title, the focused element (where the user is typing), and visible text.',
          input_schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } }
          },
          handler: async ({ body }) => {
            const a = parse(body)
            const id = String(a.id)
            // Reading a logged-in surface's DOM only crosses the relay if the user shared it.
            if (!isContentShared(id)) {
              return { status: 403, body: { error: 'content not shared — ask the user to enable "share with agent" on this surface', code: 'not_shared' } }
            }
            try {
              // No caller-supplied script over the relay (confused-deputy eval) — fixed safe DOM read.
              const result = await osReadWindow(id)
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
            // Reading/screenshotting a logged-in surface only crosses the relay if shared.
            if ((action.action === 'read' || action.action === 'screenshot') && !isContentShared(id)) {
              return { status: 403, body: { error: 'content not shared — enable "share with agent" on this surface to read or screenshot it', code: 'not_shared' } }
            }
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
          path: '/list_widgets',
          description:
            'Browse the widget library: reusable, forkable mini-apps (sandboxed HTML) backed by the user’s connected integrations. Returns each widget’s name, description, and which integrations it needs (needsMet=true if connected). Use get_widget_source to read one, spawn_widget to open it.',
          handler: () => {
            const connected = connectedProviders()
            return {
              widgets: listWidgets().map((w) => ({ ...w, needsMet: w.needs.every((n) => connected.includes(n)) })),
              connected
            }
          }
        },
        {
          path: '/get_widget_source',
          description:
            'Read the exact, forkable HTML source of a library widget by name (to understand or fork it). Returns { name, html, needs, props, version, origin }.',
          input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          handler: ({ body }) => {
            const name = String(parse(body).name || '')
            const w = getWidgetSource(name)
            if (!w) return { status: 404, body: { error: `no widget named "${name}"` } }
            return w
          }
        },
        {
          path: '/spawn_widget',
          description:
            'Open a library widget on the canvas as a live sandboxed surface. It fetches its data through the OS bridge; the user approves integration access once. Returns { id } (and needsConnect:[...] if a required integration is not connected). Use list_widgets for names.',
          input_schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              title: { type: 'string' },
              props: { type: 'object' }
            }
          },
          handler: ({ body }) => {
            const a = parse(body)
            const w = getWidgetSource(String(a.name || ''))
            if (!w) return { status: 404, body: { error: `no widget named "${String(a.name)}"` } }
            const desc: SurfaceDescriptor = {
              kind: 'srcdoc',
              html: w.html,
              props: { ...w.props, ...((a.props as Record<string, unknown>) || {}) },
              title: typeof a.title === 'string' ? a.title : w.name
            }
            if (typeof a.x === 'number') desc.x = a.x
            if (typeof a.y === 'number') desc.y = a.y
            if (typeof a.w === 'number') desc.w = a.w
            if (typeof a.h === 'number') desc.h = a.h
            const id = osCreateSurface(desc)
            const connected = connectedProviders()
            const needsConnect = w.needs.filter((n) => !connected.includes(n))
            return needsConnect.length ? { id, needsConnect } : { id }
          }
        },
        {
          path: '/save_widget',
          description:
            'Save a NEW or forked widget (sandboxed HTML using the window.blitz bridge) into the library so it can be browsed and reused. Call get_widget_authoring FIRST to learn the bridge. Returns { name, version }.',
          input_schema: {
            type: 'object',
            required: ['name', 'html'],
            properties: {
              name: { type: 'string', description: 'a-z 0-9 -, 2-49 chars' },
              html: { type: 'string' },
              description: { type: 'string' },
              needs: { type: 'array', items: { type: 'string' } },
              props: { type: 'object' },
              forkedFrom: { type: 'string' }
            }
          },
          handler: ({ body }) => {
            try {
              return saveWidget(parse(body) as unknown as SaveWidgetInput)
            } catch (e) {
              return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
            }
          }
        },
        {
          path: '/list_integrations',
          description:
            'List the integrations (Discord, GitHub, Gmail, Jira, Slack) and whether each is connected — so you know which widgets can show real data and what to ask the user to connect.',
          handler: () => ({ integrations: integrationStatuses() })
        },
        {
          path: '/get_widget_authoring',
          description:
            'Get the widget-authoring guide: how to write a widget that reads integration data via the sandboxed window.blitz bridge. Read this BEFORE authoring a new widget with save_widget.',
          handler: () => ({ markdown: WIDGET_AUTHORING_MD })
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
            const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25) // default 25, but honor an explicit wait:0 (the startup latest-read)
            const raw = await waitForEvents(since, wait * 1000)
            // Relay is untrusted: a moment's page content (snapshot/user/action) only
            // crosses for surfaces the user shared; others are reduced to metadata.
            const events = raw.map((m) => (isContentShared(m.surfaceId) ? m : redactMoment(m)))
            return { events, latest: latestSeq(), reminder: EVENTS_REMINDER }
          }
        },
        {
          path: '/say',
          description:
            "Send a chat message to the USER — it appears in their in-canvas Chat panel. Use this to reply when a moment has trigger:'message' (the user typed to you), or to proactively tell them something. Plain text.",
          input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
          handler: ({ body }) => {
            const text = String(parse(body).text || '')
            if (!text) return { status: 400, body: { error: 'text required' } }
            osSay(text)
            return { ok: true }
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
