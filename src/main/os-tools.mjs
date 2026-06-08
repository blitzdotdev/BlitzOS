// The ONE shared tool registry for ALL THREE transports — Electron relay (agentSocket.ts), Electron
// localhost (control-server.ts), AND the server (preview/backend.mjs). Plain .mjs so the server (run by
// node directly) can import it too — that's what makes "no difference between Electron and server" hold:
// there is exactly ONE definition of every tool's path, description, schema, AND handler logic. The only
// thing that differs per runtime is the set of PRIMITIVE operations (`ops`) the handler calls — IPC+CDP on
// Electron vs broadcast+headless-Chromium on the server — injected by each transport. Add or change a tool
// HERE, once, and every transport gets it identically.
//
// `transport` ('relay' | 'localhost' | 'server') is threaded into each handler so the few security-relevant
// branches (raw eval / reading a logged-in surface across an untrusted path) behave the same everywhere:
// localhost is trusted; relay + server are untrusted (gate page content to surfaces the user shared).
import { listWidgets, getWidgetSource, saveWidget, WIDGET_AUTHORING_MD } from './widget-catalog.mjs'
import { waitForEvents, latestSeq, EVENTS_REMINDER } from './perception-core.mjs'

function parse(body) {
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
}

// The agent-facing view of desktop state — layout fields ONLY. srcdoc `html` and native `props` (which hold
// the chat transcript) ride the renderer state push for SERIALIZATION, but the agent's list_state must not be
// bloated with full HTML / leak the transcript. ONE definition so every transport (and the widget list_state
// tool) returns the IDENTICAL shape — ops.getState() returns raw full state, this whittles it down.
export function serializeStateForAgent(state) {
  const s = state || {}
  return {
    ...s,
    surfaces: (s.surfaces || []).map((x) => ({ id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, z: x.z, zoom: x.zoom, title: x.title, url: x.url, component: x.component, pinned: x.pinned }))
  }
}

// blitz.dev: provision a real backend in ONE unauthenticated POST (SQLite + R2 + auth + admin UI, edge-
// deployed, no signup). Returns the live preview URL + a per-project agents.md. Pure fetch — runtime-agnostic.
async function provisionBlitzApp(slug) {
  try {
    const res = await fetch(`https://blitz.dev/api/v1/new-project/${encodeURIComponent(slug)}?template=empty`, { method: 'POST' })
    const text = await res.text()
    let j = {}
    try {
      j = text ? JSON.parse(text) : {}
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) return { ok: false, status: res.status, error: j.error || text || `provision failed (${res.status})` }
    return { ok: true, preview_url: j.preview_url || `https://${slug}.app.blitz.dev`, claim_url: j.claim_url, agents_md: j.agent_link || j.agents_md, project: j }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Build the tool registry bound to a runtime's primitive operations.
 * @param {object} ops — { createSurface(desc)->id, openWindow(a)->id, moveSurface(id,x,y), updateSurface(id,patch),
 *   closeSurface(id), goToPrimary(), getState()->state, workspaceContext()->{workspace,workspace_path,siblings},
 *   listWorkspaces()->{...}, createWorkspace(name)->{ok,name}, switchWorkspace(name)->{ok,active},
 *   readWindow(id,script?)->result, controlSurface(id,action)->{ok,result}, say(text), customizeWidget(name,html)->{ok,rel},
 *   systemUi(name)->html|null, groupIntoFolder(name,ids,x,y,kind)->{ok,...}, providerCall(descriptor,transport)->result,
 *   integrationStatuses()->[...], connectedProviders()->[...] }
 */
export function makeOsTools(ops) {
  return [
    {
      path: '/create_surface',
      description:
        'Create a surface (kind: web | app | srcdoc | native). web/app take url; srcdoc takes html; native takes component+props. Returns { id, workspace, workspace_path, siblings:[titles] }. NOTE for a LOCAL agent (you can see the filesystem): the folder IS the canvas — prefer authoring by writing a file INTO workspace_path (`<name>.html`=panel, `<name>.md`=note, `<name>.weblink`={"url":…}=web); it materializes as a surface in ~250ms, no escaping, no /tmp. Use THIS api when remote (relay, no file access) or when you need exact x/y/w/h placed in one shot. `siblings` tells you what is already on this desktop — if it is unrelated to your task, consider create_workspace first.',
      input_schema: {
        type: 'object',
        required: ['kind'],
        properties: { kind: { type: 'string', enum: ['web', 'app', 'srcdoc', 'native'] }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' }, url: { type: 'string' }, html: { type: 'string' }, component: { type: 'string' }, props: { type: 'object' } }
      },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.kind) return { status: 400, body: { error: 'kind required' } }
        const id = ops.createSurface(a)
        const ctx = ops.workspaceContext()
        return { id, workspace: ctx.workspace, workspace_path: ctx.workspace_path, siblings: (ctx.siblings || []).filter((s) => s.id !== id).map((s) => s.title) }
      }
    },
    {
      path: '/open_window',
      description: 'Open a third-party website as a live web surface. Returns its id.',
      input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (typeof a.url !== 'string') return { status: 400, body: { error: 'url required' } }
        return { id: ops.openWindow(a) }
      }
    },
    {
      path: '/move_surface',
      description: 'Move a surface to (x, y) world pixels.',
      input_schema: { type: 'object', required: ['id', 'x', 'y'], properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
      handler: ({ body }) => {
        const a = parse(body)
        ops.moveSurface(String(a.id), Number(a.x), Number(a.y))
        return { ok: true }
      }
    },
    {
      path: '/update_surface',
      description: 'Patch a surface in place: set html (srcdoc), props (native, e.g. note text), url, title, or geometry.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, html: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, props: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
      handler: ({ body }) => {
        const { id, ...patch } = parse(body)
        if (!id) return { status: 400, body: { error: 'id required' } }
        ops.updateSurface(String(id), patch)
        return { ok: true }
      }
    },
    {
      path: '/close_surface',
      description: 'Close a surface by id.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        ops.closeSurface(String(parse(body).id))
        return { ok: true }
      }
    },
    {
      path: '/go_to_primary',
      description: 'Recenter the view on the primary workspace.',
      handler: () => {
        ops.goToPrimary()
        return { ok: true }
      }
    },
    {
      path: '/group',
      description:
        'Group related surfaces into ONE REAL folder on disk: makes a subdirectory and MOVES the given surfaces\' files into it. kind:"folder" (default) → one collapsed tile (drill in to browse), best for many items / a repo. kind:"board" → the items stay SPLAYED on the canvas as a sub-board (best for a small curated set you want visible). A real filesystem folder either way, so it persists. Pass 2+ ids + a name.',
      input_schema: { type: 'object', required: ['ids', 'name'], properties: { ids: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, kind: { type: 'string', enum: ['folder', 'board'] }, x: { type: 'number' }, y: { type: 'number' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const ids = Array.isArray(a.ids) ? a.ids.map(String) : []
        if (!ids.length) return { status: 400, body: { error: 'group needs surface ids' } }
        return ops.groupIntoFolder(a.name != null ? String(a.name) : 'Folder', ids, a.x != null ? Number(a.x) : undefined, a.y != null ? Number(a.y) : undefined, a.kind === 'board' ? 'board' : 'folder')
      }
    },
    {
      path: '/list_state',
      description:
        'List the canvas: the active workspace name + its absolute folder path (workspace_path) + the open surfaces. A LOCAL agent authors surfaces by writing files into workspace_path (the folder IS the canvas); check the surfaces here to judge whether new work belongs on THIS desktop or a fresh workspace.',
      handler: () => serializeStateForAgent(ops.getState())
    },
    {
      path: '/list_workspaces',
      description:
        "List the user's workspaces (separate folder-backed desktops, like macOS Spaces but persistent — each is its own folder = its own memory). Returns { workspaces:[{name,nodeCount,updatedAt,path}], active, activePath, root }. CALL THIS FIRST: reason about WHERE the task belongs before building. A workspace holding UNRELATED surfaces is NOT a continuation — create_workspace + switch_workspace for a clean stage. activePath is the folder you author into.",
      handler: () => ops.listWorkspaces()
    },
    {
      path: '/create_workspace',
      description: 'Create a NEW empty workspace (a fresh desktop) for an UNRELATED task, so you do not pile it onto whatever the user already has open. Returns { ok, name }. Follow with switch_workspace to move the user there.',
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      handler: ({ body }) => {
        const name = String(parse(body).name || '').trim()
        if (!name) return { status: 400, body: { error: 'name required' } }
        return ops.createWorkspace(name)
      }
    },
    {
      path: '/switch_workspace',
      description: 'Move the user to a workspace by name (their canvas swaps to that desktop). Use right after create_workspace to take them to the fresh space for a new task; the user can switch back themselves anytime. Returns { ok, active }.',
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      handler: async ({ body }) => {
        const name = String(parse(body).name || '').trim()
        if (!name) return { status: 400, body: { error: 'name required' } }
        const r = await ops.switchWorkspace(name)
        return r && r.ok ? { ok: true, active: r.active } : { status: 404, body: { error: (r && r.error) || 'switch failed' } }
      }
    },
    {
      path: '/new_app',
      description:
        'Provision a REAL blitz.dev app in one call (SQLite + R2 + auth + admin UI, edge-deployed, no signup). Use EAGERLY, up front, for any DELIVERABLE the user will keep or ship — a landing page, site, web app, tool, or shareable dashboard — EVEN IF v1 looks static (on blitz.dev it gets a live claimable URL, deploys on every save, and is one save from a backend). NOT for session scaffolding (plan notes, status widgets, one-off panels → those are srcdoc / workspace files). Returns { preview_url, claim_url, agents_md, slug }. THEN fetch agents_md and author files through it (each save auto-builds + deploys); open the preview_url as an `app` surface. Args { slug } (a-z 0-9 -, unique).',
      input_schema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', description: 'unique project slug, a-z 0-9 -' }, title: { type: 'string' } } },
      handler: async ({ body }) => {
        const slug = String(parse(body).slug || '')
          .trim()
          .toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) return { status: 400, body: { error: 'slug must be a-z 0-9 - (2-49 chars, start alphanumeric)' } }
        const r = await provisionBlitzApp(slug)
        if (!r.ok) return { status: r.status || 400, body: { error: r.error } }
        return { ok: true, slug, preview_url: r.preview_url, claim_url: r.claim_url, agents_md: r.agents_md, next: 'Fetch agents_md, save a starter file (it auto-builds + deploys), then open the preview_url as an `app` surface. Tell the user the preview + claim URLs.' }
      }
    },
    {
      path: '/provider_call',
      description:
        'Make an authenticated request to a CONNECTED integration (provider) and get the JSON back — use it to build whatever the user needs (their unread mail, repos, issues, messages, …). The OS injects the credential server-side; you NEVER see the token. Reads (GET) are broad — pass any path under the provider\'s API. Writes (POST/PUT/PATCH/DELETE) pop a human approval card. A sensitive read (message bodies, file contents) returns code:"consent_required" until the human approves once. Args: {provider, method?, path, query?, body?}. Connected providers are in list_integrations.',
      input_schema: { type: 'object', required: ['provider', 'path'], properties: { provider: { type: 'string' }, method: { type: 'string' }, path: { type: 'string', description: 'provider-relative, e.g. /user/repos' }, query: { type: 'object' }, body: {} } },
      handler: ({ body, transport }) => {
        const a = parse(body)
        return ops.providerCall({ provider: String(a.provider || ''), method: a.method ? String(a.method) : undefined, path: String(a.path || ''), query: a.query, body: a.body, approvalToken: a.approvalToken }, transport)
      }
    },
    {
      path: '/read_window',
      description: 'Read what is INSIDE a web surface (its live DOM): url, title, the focused element (where the user is typing), and visible text. On the trusted localhost path you may pass a JS expression as `script` to extract anything.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, script: { type: 'string' } } },
      handler: async ({ body, transport }) => {
        const a = parse(body)
        const id = String(a.id)
        try {
          const script = transport === 'localhost' && typeof a.script === 'string' ? a.script : undefined
          return { result: await ops.readWindow(id, script) }
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
        properties: { id: { type: 'string' }, action: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['click', 'type', 'key', 'read', 'screenshot'] }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, perKey: { type: 'boolean' }, key: { type: 'string' } } } }
      },
      handler: async ({ body, transport }) => {
        const b = parse(body)
        const id = typeof b.id === 'string' ? b.id : ''
        const action = b.action || {}
        if (!id || !action.action) return { status: 400, body: { error: 'id and action.action required' } }
        if (action.action === 'eval' && transport !== 'localhost') return { status: 403, body: { error: 'eval is not available over the relay' } }
        const r = await ops.controlSurface(id, action)
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
        const connected = ops.connectedProviders()
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
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' }, props: { type: 'object' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const w = getWidgetSource(String(a.name || ''))
        if (!w) return { status: 404, body: { error: `no widget named "${String(a.name)}"` } }
        const desc = { kind: 'srcdoc', html: w.html, props: { ...w.props, ...(a.props || {}) }, title: typeof a.title === 'string' ? a.title : w.name }
        if (typeof a.x === 'number') desc.x = a.x
        if (typeof a.y === 'number') desc.y = a.y
        if (typeof a.w === 'number') desc.w = a.w
        if (typeof a.h === 'number') desc.h = a.h
        const id = ops.createSurface(desc)
        const needsConnect = w.needs.filter((n) => !ops.connectedProviders().includes(n))
        return needsConnect.length ? { id, needsConnect } : { id }
      }
    },
    {
      path: '/save_widget',
      description: 'Save a NEW or forked widget (sandboxed HTML using the window.blitz bridge) into the library so it can be browsed and reused. Call get_widget_authoring FIRST to learn the bridge. Returns { name, version }.',
      input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string', description: 'a-z 0-9 -, 2-49 chars' }, html: { type: 'string' }, description: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, props: { type: 'object' }, forkedFrom: { type: 'string' } } },
      handler: ({ body }) => {
        try {
          return saveWidget(parse(body))
        } catch (e) {
          return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
        }
      }
    },
    {
      path: '/list_integrations',
      description: 'List the integrations (Discord, GitHub, Gmail, Jira, Slack) and whether each is connected — so you know which widgets can show real data and what to ask the user to connect.',
      handler: () => ({ integrations: ops.integrationStatuses() })
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
      handler: async ({ body }) => {
        const a = parse(body)
        const since = Number(a.since) || 0
        const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25)
        // No content-share redaction (removed): every transport gets the full moment, snapshot included.
        const events = await waitForEvents(since, wait * 1000)
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
        ops.say(text)
        return { ok: true }
      }
    },
    {
      path: '/customize_widget',
      description:
        "Rewrite a built-in OS widget's UI — currently {name:'chat'}. The UI is a workspace file (blitz-chat.html) you fully replace; it live-reloads. Use the injected Blitz UI kit: <blitz-titlebar>/<blitz-list>/<blitz-message role=user|agent>/<blitz-input> + --blitz-* tokens + window.blitz (onProps(p=>render(p.messages)), sendMessage(text)). Read the current source with get_system_ui first. Args: {name, html}.",
      input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string' }, html: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const r = ops.customizeWidget(String(b.name || ''), String(b.html || ''))
        return r.ok ? { ok: true, file: r.rel } : { status: 400, body: { error: r.error || 'failed' } }
      }
    },
    {
      path: '/get_system_ui',
      description: "Read a built-in widget's current UI source before editing it (the fork pattern). Args: {name:'chat'}. Returns {html}.",
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      handler: ({ body }) => {
        const html = ops.systemUi(String(parse(body).name || ''))
        return html == null ? { status: 404, body: { error: 'unknown widget' } } : { html }
      }
    }
  ]
}

/** Build the registry + a path lookup for a runtime's ops (the localhost dispatcher needs the by-path map). */
export function makeOsToolsByPath(ops) {
  return Object.fromEntries(makeOsTools(ops).map((t) => [t.path, t]))
}
