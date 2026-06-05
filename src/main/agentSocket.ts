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
  type SurfaceDescriptor
} from './osActions'
import type { ControlAction } from './cdp'
import { listWidgets, getWidgetSource, saveWidget, WIDGET_AUTHORING_MD } from './widget-catalog.mjs'
import type { SaveWidgetInput } from './widget-catalog.mjs'
import { integrationStatuses, connectedProviders } from './integrations'
import { waitForEvents, latestSeq, isContentShared, redactMoment } from './events'

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
- srcdoc — a sandboxed iframe of HTML you write inline; great for a quick tool/visualization (calculator, chart, timer). It has NO network/fetch — to show data from a connected integration, use a Widget (see below), which gets data over the \`window.blitz\` bridge.
- native — a built-in widget; component "note" = a post-it (props { text?, color?: yellow|pink|blue|green }).

## Tools (authoritative schemas at $BASE/tools.json)
- POST $BASE/open_window { url, x?, y?, w?, h?, title? } — open a website as a web surface; returns { id }.
- POST $BASE/create_surface { kind, x?, y?, w?, h?, title?, url?, html?, component?, props? } — create any kind.
- POST $BASE/move_surface { id, x, y }
- POST $BASE/update_surface { id, html?, props?, url?, title?, x?, y?, w?, h? } — patch a surface in place (append to a srcdoc panel, set a note's text, change url/geometry).
- POST $BASE/close_surface { id }
- POST $BASE/go_to_primary
- POST $BASE/list_state — the full layout (read before arranging): { viewport:{w,h}, view:{x,y,w,h,cx,cy,scale}, mode, surfaces:[{id,kind,x,y,w,h,z,title,url}] }. See "Window management" below.
- POST $BASE/read_window { id, script? } — read what is INSIDE a web surface (its DOM): url, title, where the user is typing, and visible text. Pass a JS expression as \`script\` to extract something specific.
- POST $BASE/surface_control { id, action: { action: "click"|"type"|"key"|"read"|"screenshot", selector?, x?, y?, text?, key? } } — act INSIDE a web surface (click/type/key, read text, screenshot). Use read_window or surface_control:read first to see the page.
- POST $BASE/events { since?, wait? } — the autonomy loop: long-poll the user's activity as framed "moments" (see "Watching the user" below).

## Widgets (integration-backed mini-apps)
A widget is a reusable, forkable sandboxed mini-app backed by the user's connected integrations (e.g. "your Discord servers", "your GitHub repos"). There is a library you browse, read, fork, and add to.
- POST $BASE/list_integrations — see which integrations are connected (so you know what has real data).
- POST $BASE/list_widgets — browse the library; each entry has { name, description, needs, needsMet }.
- POST $BASE/get_widget_source { name } — read a widget's exact HTML (to understand or fork it).
- POST $BASE/spawn_widget { name, x?, y?, w?, h?, title?, props? } — open a library widget live on the canvas (returns { id }; the user approves integration access once).
- POST $BASE/save_widget { name, html, description?, needs?, props?, forkedFrom? } — add a NEW or forked widget to the library.
- POST $BASE/get_widget_authoring — READ THIS before authoring a new widget: it explains the \`window.blitz\` data bridge (a sandboxed widget cannot fetch(); it gets integration data only via window.blitz.data(provider, resource)).
Typical flow: list_widgets → spawn_widget to use one; or get_widget_source → edit → save_widget to fork; or get_widget_authoring → write HTML → save_widget → spawn_widget to author new.

## Watching the user: the autonomy loop ($BASE/events)
BlitzOS watches the user for you and WAKES you on meaningful moments, so you behave like an always-on assistant without writing any polling logic. Run ONE long-poll loop:
- POST $BASE/events { since?, wait? } -> { events:[<moment>], latest }. Start since=0, then loop with since=latest and wait=25. It blocks until a moment is ready, then returns instantly.

A "moment" is a coalesced, framed snapshot, NOT a keystroke firehose. BlitzOS batches routine activity (~15s) and flushes immediately when the user navigates or goes idle after acting. Each moment:
  { seq, ts, surfaceId, url, title, trigger:'batch'|'nav'|'idle', windowMs, signals:{type:count}, user:[human-readable actions], snapshot:<text digest of the surface now> }

On each moment: DECIDE whether it warrants action (most don't). If it does, perceive more if needed (read_window / surface_control read), then ACT: build or rearrange surfaces to help (a coach panel, a summary, a tool, reorganize the desktop). The snapshot tells you what the user is doing on ANY site, so this is general: you decide how to help. Don't narrate every moment; act when you can add value, stay quiet otherwise.

## Talking with the user (chat)
A moment with \`trigger:"message"\` is the user typing to you directly in their in-canvas Chat (the text is in the moment's \`message\` field). ALWAYS respond to those — reply with:
- POST $BASE/say { text } — sends a chat message back to the user (appears in their Chat panel).
You can also \`say\` proactively (e.g. "I opened your repos on the right"). Keep replies short. Do what they ask using the other tools, then \`say\` what you did.

## Window management — you are the window manager (think before you open OR close)
You own the desktop arrangement. \`list_state\` gives you everything needed to reason spatially:
- \`viewport {w,h}\` — the user's screen size in px (what fits).
- \`view {x,y,w,h,cx,cy,scale}\` — the world-space rectangle the user can SEE right now (cx,cy = its center). A surface OUTSIDE \`view\` is off-screen to them — if you place a window there, they never see it. This is the #1 mistake; place inside \`view\`.
- each surface's \`x,y,w,h\` (geometry, world px), \`z\` (stacking; higher = on top), and \`component\`.
- The **Chat panel** (\`component:"chat"\`, \`pinned:true\`) is the user's channel to you and is ALWAYS ON TOP — NEVER place a window over it or hide it. It docks to the LEFT of \`view\`; put everything else to its right / in the free area beside it.

BEFORE opening / spawning a surface, plan the new arrangement:
1. Relevance — is it something the user should SEE now? If not, don't surface it.
2. Size — pick \`w,h\` for its content AND the viewport (a reading/article pane wants width + height; a note/timer/status chip is small). Don't exceed \`view\`.
3. Position — place it INSIDE \`view\` so it's actually visible (near \`view.cx/cy\`; or omit x/y to center in their view). Never let it land off-screen.
4. Make room — if it would overlap or hide something the user still needs, MOVE/RESIZE the existing windows first (\`move_surface\`, \`update_surface\` with w/h): tile side-by-side, shrink the now-secondary one, or close what's stale. Decide the whole layout, then apply it. Never just stack windows on top of each other.

BEFORE closing a surface: after \`close_surface\`, REFLOW the survivors to fill the gap (recenter or re-tile them within \`view\`) so the arrangement stays clean instead of leaving a hole.

Keep the view clean and readable: only what matters now, each with room. Arrange deliberately — don't pile up.

Coordinates are world pixels. Prefer srcdoc for things you can build inline; use open_window for real external sites. Note: update_surface replacing a srcdoc's html RELOADS it (in-widget state resets) — for live data use a widget's bridge, not html rewrites.
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
            const wait = Math.min(Math.max(Number(a.wait) || 25, 0), 25)
            const raw = await waitForEvents(since, wait * 1000)
            // Relay is untrusted: a moment's page content (snapshot/user/action) only
            // crosses for surfaces the user shared; others are reduced to metadata.
            const events = raw.map((m) => (isContentShared(m.surfaceId) ? m : redactMoment(m)))
            return { events, latest: latestSeq() }
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
