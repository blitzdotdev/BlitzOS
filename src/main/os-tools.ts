// Shared tool registry — the SINGLE source of truth for BlitzOS's agent tools. Both transports dispatch
// from this: the relay (agentSocket.ts, transport:'relay' — untrusted → page content gated, no raw eval)
// and the localhost control server (control-server.ts, transport:'localhost' — trusted → eval + unredacted).
// Add a tool here ONCE and it works on both paths; this is what unifies the two control planes and is why
// the localhost path can no longer drift stale behind the relay.
import {
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osUpdateSurface,
  osCloseSurface,
  osGoToPrimary,
  osGetState,
  osWorkspaceContext,
  osReadWindow,
  osControlSurface,
  osSay,
  osGroupIntoFolder,
  osListWorkspaces,
  osCreateWorkspace,
  osSwitchWorkspace,
  type SurfaceDescriptor
} from './osActions'
import type { ControlAction } from './cdp'
import { listWidgets, getWidgetSource, saveWidget, WIDGET_AUTHORING_MD } from './widget-catalog.mjs'
import type { SaveWidgetInput } from './widget-catalog.mjs'
import { integrationStatuses, connectedProviders } from './integrations'
import { runProviderCall } from './provider-bridge'
import { waitForEvents, latestSeq, isContentShared, redactMoment, EVENTS_REMINDER } from './events'

export type Transport = 'relay' | 'localhost'
export interface ToolCtx {
  body: string
  transport: Transport
}
/** A handler returns either a plain payload (→ HTTP 200) or { status, body } to set a non-200 status. */
export type ToolResult = { status: number; body: unknown } | Record<string, unknown> | unknown
export interface OsTool {
  path: string
  description: string
  input_schema?: Record<string, unknown>
  handler: (ctx: ToolCtx) => ToolResult | Promise<ToolResult>
}

function parse(body: string): Record<string, unknown> {
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// blitz.dev: provision a real backend in ONE unauthenticated POST (SQLite + R2 + auth + admin UI, edge-
// deployed, no signup, lasts 12h unless claimed). Returns the live preview URL + a per-project agents.md
// the agent follows to build it out (every file save auto-builds + deploys). The substrate BlitzOS runs on.
async function provisionBlitzApp(
  slug: string
): Promise<{ ok: boolean; status?: number; error?: string; preview_url?: string; claim_url?: string; agents_md?: string; project?: unknown }> {
  try {
    const res = await fetch(`https://blitz.dev/api/v1/new-project/${encodeURIComponent(slug)}?template=empty`, { method: 'POST' })
    const text = await res.text()
    let j: Record<string, unknown> = {}
    try {
      j = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) return { ok: false, status: res.status, error: (j.error as string) || text || `provision failed (${res.status})` }
    return {
      ok: true,
      preview_url: (j.preview_url as string) || `https://${slug}.app.blitz.dev`,
      claim_url: j.claim_url as string | undefined,
      agents_md: (j.agent_link as string) || (j.agents_md as string) || undefined,
      project: j
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const OS_TOOLS: OsTool[] = [
  {
    path: '/create_surface',
    description:
      'Create a surface (kind: web | app | srcdoc | native). web/app take url; srcdoc takes html; native takes component+props. Returns { id, workspace, workspace_path, siblings:[titles] }. NOTE for a LOCAL agent (you can see the filesystem): the folder IS the canvas — prefer authoring by writing a file INTO workspace_path (`<name>.html`=panel, `<name>.md`=note, `<name>.weblink`={"url":…}=web); it materializes as a surface in ~250ms, no escaping, no /tmp. Use THIS api when remote (relay, no file access) or when you need exact x/y/w/h placed in one shot. `siblings` tells you what is already on this desktop — if it is unrelated to your task, consider create_workspace first.',
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
      const id = osCreateSurface(a)
      // Hand back the workspace context AT THE POINT OF ACTION: where the folder is (so a local agent can
      // switch to file-authoring) and what ELSE is on this desktop (so it notices clutter it's piling onto).
      const ctx = osWorkspaceContext()
      return { id, workspace: ctx.workspace, workspace_path: ctx.workspace_path, siblings: ctx.siblings.filter((s) => s.id !== id).map((s) => s.title) }
    }
  },
  {
    path: '/open_window',
    description: 'Open a third-party website as a live web surface. Returns its id.',
    input_schema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' } }
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
    input_schema: { type: 'object', required: ['id', 'x', 'y'], properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
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
      properties: { id: { type: 'string' }, html: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, props: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
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
      'Group related surfaces into ONE REAL folder on disk: makes a subdirectory and MOVES the given surfaces\' files into it. kind:"folder" (default) → one collapsed tile (drill in to browse), best for many items / a repo. kind:"board" → the items stay SPLAYED on the canvas as a sub-board (best for a small curated set you want visible). A real filesystem folder either way, so it persists. Pass 2+ ids + a name.',
    input_schema: {
      type: 'object',
      required: ['ids', 'name'],
      properties: { ids: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, kind: { type: 'string', enum: ['folder', 'board'] }, x: { type: 'number' }, y: { type: 'number' } }
    },
    handler: ({ body }) => {
      const a = parse(body)
      const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : []
      if (!ids.length) return { status: 400, body: { error: 'group needs surface ids' } }
      return osGroupIntoFolder(a.name != null ? String(a.name) : 'Folder', ids, a.x != null ? Number(a.x) : undefined, a.y != null ? Number(a.y) : undefined, a.kind === 'board' ? 'board' : 'folder')
    }
  },
  {
    path: '/list_state',
    description:
      'List the canvas: the active workspace name + its absolute folder path (workspace_path) + the open surfaces. A LOCAL agent authors surfaces by writing files into workspace_path (the folder IS the canvas); check the surfaces here to judge whether new work belongs on THIS desktop or a fresh workspace.',
    handler: () => osGetState()
  },
  {
    path: '/list_workspaces',
    description:
      "List the user's workspaces (separate folder-backed desktops, like macOS Spaces but persistent — each is its own folder = its own memory). Returns { workspaces:[{name,nodeCount,updatedAt,path}], active, activePath, root }. CALL THIS FIRST: reason about WHERE the task belongs before building. A workspace holding UNRELATED surfaces is NOT a continuation — create_workspace + switch_workspace for a clean stage. activePath is the folder you author into.",
    handler: () => osListWorkspaces()
  },
  {
    path: '/create_workspace',
    description:
      'Create a NEW empty workspace (a fresh desktop) for an UNRELATED task, so you do not pile it onto whatever the user already has open. Returns { ok, name }. Follow with switch_workspace to move the user there.',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    handler: ({ body }) => {
      const name = String(parse(body).name || '').trim()
      if (!name) return { status: 400, body: { error: 'name required' } }
      return osCreateWorkspace(name)
    }
  },
  {
    path: '/switch_workspace',
    description:
      'Move the user to a workspace by name (their canvas swaps to that desktop). Use right after create_workspace to take them to the fresh space for a new task; the user can switch back themselves anytime. Returns { ok, active }.',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    handler: async ({ body }) => {
      const name = String(parse(body).name || '').trim()
      if (!name) return { status: 400, body: { error: 'name required' } }
      return osSwitchWorkspace(name)
    }
  },
  {
    path: '/new_app',
    description:
      'Provision a REAL blitz.dev app in one call (SQLite + R2 + auth + admin UI, edge-deployed, no signup). Use EAGERLY, up front, for any DELIVERABLE the user will keep or ship — a landing page, site, web app, tool, or shareable dashboard — EVEN IF v1 looks static (on blitz.dev it gets a live claimable URL, deploys on every save, and is one save from a backend). NOT for session scaffolding (plan notes, status widgets, one-off panels → those are srcdoc / workspace files). Returns { preview_url, claim_url, agents_md, slug }. THEN fetch agents_md and author files through it (each save auto-builds + deploys); open the preview_url as an `app` surface. Args { slug } (a-z 0-9 -, unique).',
    input_schema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', description: 'unique project slug, a-z 0-9 -' }, title: { type: 'string' } } },
    handler: async ({ body }) => {
      const a = parse(body)
      const slug = String(a.slug || '')
        .trim()
        .toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) return { status: 400, body: { error: 'slug must be a-z 0-9 - (2-49 chars, start alphanumeric)' } }
      const r = await provisionBlitzApp(slug)
      if (!r.ok) return { status: r.status || 400, body: { error: r.error } }
      return {
        ok: true,
        slug,
        preview_url: r.preview_url,
        claim_url: r.claim_url,
        agents_md: r.agents_md,
        next: 'Fetch agents_md, save a starter file (it auto-builds + deploys), then open the preview_url as an `app` surface. Tell the user the preview + claim URLs.'
      }
    }
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
      properties: { provider: { type: 'string' }, method: { type: 'string' }, path: { type: 'string', description: 'provider-relative, e.g. /user/repos' }, query: { type: 'object' }, body: {} }
    },
    handler: ({ body, transport }) => {
      const a = parse(body)
      return runProviderCall({ provider: String(a.provider || ''), method: a.method ? String(a.method) : undefined, path: String(a.path || ''), query: a.query as Record<string, unknown> | undefined, body: a.body }, transport)
    }
  },
  {
    path: '/read_window',
    description: 'Read what is INSIDE a web surface (its live DOM): url, title, the focused element (where the user is typing), and visible text. On the trusted localhost path you may pass a JS expression as `script` to extract anything.',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, script: { type: 'string' } } },
    handler: async ({ body, transport }) => {
      const a = parse(body)
      const id = String(a.id)
      // Reading a logged-in surface's DOM only crosses the relay if the user shared it. Localhost is trusted.
      if (transport === 'relay' && !isContentShared(id)) {
        return { status: 403, body: { error: 'content not shared — ask the user to enable "share with agent" on this surface', code: 'not_shared' } }
      }
      try {
        // No caller-supplied script over the relay (confused-deputy eval); allowed on trusted localhost.
        const script = transport === 'localhost' && typeof a.script === 'string' ? a.script : undefined
        const result = await osReadWindow(id, script)
        return { result }
      } catch (e) {
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
      }
    }
  },
  {
    path: '/surface_control',
    description: 'Act INSIDE a web surface (third-party site): click, type, press a key, read text, or screenshot. Only kind "web". Put the surface id in the body. Use read/screenshot first to see the page.',
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
    handler: async ({ body, transport }) => {
      const b = parse(body)
      const id = typeof b.id === 'string' ? b.id : ''
      const action = (b.action || {}) as { action?: string }
      if (!id || !action.action) return { status: 400, body: { error: 'id and action.action required' } }
      // Security: raw page eval is the trusted localhost path only (confused-deputy over a logged-in session).
      if (action.action === 'eval' && transport !== 'localhost') return { status: 403, body: { error: 'eval is not available over the relay' } }
      // Reading/screenshotting a logged-in surface only crosses the relay if shared; localhost is trusted.
      if (transport === 'relay' && (action.action === 'read' || action.action === 'screenshot') && !isContentShared(id)) {
        return { status: 403, body: { error: 'content not shared — enable "share with agent" on this surface to read or screenshot it', code: 'not_shared' } }
      }
      const r = await osControlSurface(id, action as unknown as ControlAction)
      if (!r.ok) return { status: 400, body: { error: r.error } }
      if (action.action === 'screenshot') return { image: r.result }
      if (action.action === 'read' || action.action === 'eval') return { text: r.result }
      return { ok: true }
    }
  },
  {
    path: '/list_widgets',
    description:
      'Browse the widget library: reusable, forkable mini-apps (sandboxed HTML) backed by the user’s connected integrations. Returns each widget’s name, description, and which integrations it needs (needsMet=true if connected). Use get_widget_source to read one, spawn_widget to open it.',
    handler: () => {
      const connected = connectedProviders()
      return { widgets: listWidgets().map((w) => ({ ...w, needsMet: w.needs.every((n) => connected.includes(n)) })), connected }
    }
  },
  {
    path: '/get_widget_source',
    description: 'Read the exact, forkable HTML source of a library widget by name (to understand or fork it). Returns { name, html, needs, props, version, origin }.',
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
      properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' }, props: { type: 'object' } }
    },
    handler: ({ body }) => {
      const a = parse(body)
      const w = getWidgetSource(String(a.name || ''))
      if (!w) return { status: 404, body: { error: `no widget named "${String(a.name)}"` } }
      const desc: SurfaceDescriptor = { kind: 'srcdoc', html: w.html, props: { ...w.props, ...((a.props as Record<string, unknown>) || {}) }, title: typeof a.title === 'string' ? a.title : w.name }
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
    description: 'Save a NEW or forked widget (sandboxed HTML using the window.blitz bridge) into the library so it can be browsed and reused. Call get_widget_authoring FIRST to learn the bridge. Returns { name, version }.',
    input_schema: {
      type: 'object',
      required: ['name', 'html'],
      properties: { name: { type: 'string', description: 'a-z 0-9 -, 2-49 chars' }, html: { type: 'string' }, description: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, props: { type: 'object' }, forkedFrom: { type: 'string' } }
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
    description: 'List the integrations (Discord, GitHub, Gmail, Jira, Slack) and whether each is connected — so you know which widgets can show real data and what to ask the user to connect.',
    handler: () => ({ integrations: integrationStatuses() })
  },
  {
    path: '/get_widget_authoring',
    description: 'Get the widget-authoring guide: how to write a widget that reads integration data via the sandboxed window.blitz bridge. Read this BEFORE authoring a new widget with save_widget.',
    handler: () => ({ markdown: WIDGET_AUTHORING_MD })
  },
  {
    path: '/events',
    description:
      "Long-poll the user's activity, coalesced into framed 'moments' (batched ~15s; flushed immediately on navigation or going idle after acting). Each moment carries a snapshot of the surface so you can react without a second read: {seq,surfaceId,url,title,trigger,signals,user[],snapshot}. THE AUTONOMY LOOP: start since=0, loop with since=latest and wait=25; on each moment decide whether to act, then build/arrange surfaces to help.",
    input_schema: { type: 'object', properties: { since: { type: 'number' }, wait: { type: 'number' } } },
    handler: async ({ body, transport }) => {
      const a = parse(body)
      const since = Number(a.since) || 0
      const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25) // default 25, but honor an explicit wait:0
      const raw = await waitForEvents(since, wait * 1000)
      // Relay is untrusted: a moment's page content (snapshot/user/action) only crosses for shared surfaces.
      // Localhost is trusted → moments pass through unredacted.
      const events = transport === 'localhost' ? raw : raw.map((m) => (isContentShared(m.surfaceId) ? m : redactMoment(m)))
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
]

/** Lookup by path (e.g. '/create_surface') for the localhost dispatcher. */
export const OS_TOOLS_BY_PATH: Record<string, OsTool> = Object.fromEntries(OS_TOOLS.map((t) => [t.path, t]))
