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

// The agent-facing view of desktop state — layout fields + props, but NOT html. srcdoc `html` is omitted
// (bloat — you DRIVE a widget via props, never re-read its html). props ARE included so the agent can
// VERIFY a widget's data landed and read its Notepad text (`props.text`) — a srcdoc iframe can't be
// read_window'd, so list_state.props is the agent's ONLY confirmation path — EXCEPT the chat/activity
// panels, whose props hold the full transcript (don't leak / bloat). ONE definition so every transport
// (and the widget list_state tool) returns the IDENTICAL shape — ops.getState() returns raw full state.
export function serializeStateForAgent(state) {
  const s = state || {}
  const isTranscript = (x) => x.role === 'chat' || x.role === 'activity' || x.component === 'chat' || x.component === 'activity'
  return {
    ...s,
    surfaces: (s.surfaces || []).map((x) => ({
      id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, z: x.z, zoom: x.zoom, title: x.title, url: x.url, component: x.component, pinned: x.pinned,
      ...(isTranscript(x) || !x.props ? {} : { props: x.props })
    }))
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
        'Create a surface (web|app|srcdoc|native): web/app take url, srcdoc takes html, native takes component+props. SHAPED thinking/output — a set you rank or profile, a comparison/decision, a sequence, a multi-step process, relationships → use `spawn_widget` instead; a `note`/`.md` is for plain prose ONLY. Returns { id, workspace_path, siblings }. LOCAL agents: prefer writing a file into workspace_path (`.html`=panel, `.md`=note, `.weblink`=web) — surfaces in ~250ms, no /tmp; use this api when remote or for exact x/y/w/h. siblings = what is already here (unrelated → consider create_workspace).',
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
        'List the canvas: active workspace, its folder path (workspace_path), and the open surfaces. Local agents author by writing files into workspace_path; check surfaces to judge THIS desktop vs a fresh workspace.',
      handler: () => serializeStateForAgent(ops.getState())
    },
    {
      path: '/list_workspaces',
      description:
        "List the user's workspaces (separate persistent desktops; each folder = its own memory). Returns { workspaces:[{name,nodeCount,updatedAt,path}], active, activePath, root }. CALL FIRST to decide WHERE work belongs: a workspace with UNRELATED surfaces isn't a continuation → create_workspace + switch_workspace. activePath = the folder you author into.",
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
        "Provision a real blitz.dev app (SQLite+R2+auth, edge-deployed) for a DELIVERABLE the user will keep/ship (landing page, site, app, dashboard — even if v1 looks static); not for session scaffolding (→ srcdoc). Returns { preview_url, claim_url, agents_md, slug }. Then author files and PRESENT as one `app` surface per page/variation, tiled (canvas = the gallery, never an in-app chooser). Speed-first: build what's asked, offer backends. Working rules in the doctrine's 'Build deliverables on blitz.dev'. Args { slug } (a-z 0-9 -).",
      input_schema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', description: 'unique project slug, a-z 0-9 -' }, title: { type: 'string' } } },
      handler: async ({ body }) => {
        const slug = String(parse(body).slug || '')
          .trim()
          .toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) return { status: 400, body: { error: 'slug must be a-z 0-9 - (2-49 chars, start alphanumeric)' } }
        const r = await provisionBlitzApp(slug)
        if (!r.ok) return { status: r.status || 400, body: { error: r.error } }
        return { ok: true, slug, preview_url: r.preview_url, claim_url: r.claim_url, agents_md: r.agents_md, next: "IS THIS ONE OF SEVERAL VARIATIONS/PARTS? Then STOP — do NOT author here. You are the orchestrator: provision the rest, put up a placeholder surface per part, and spawn ONE sub-agent per part (build NONE yourself — not even the 'reference'/canonical one, and don't 'prove the deploy on this one first'). SINGLE deliverable only: author files (relative imports auto-bundle, every save deploys — no bundler), open as one `app` surface, offer backends, tell the user the preview + claim URLs." }
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
          // D (incremental-drive nudge woven into the work loop): reading a window is how the agent
          // gathers info — which is exactly the moment to reflect it on its live surface before moving on.
          return {
            result: await ops.readWindow(id, script),
            reminder:
              'If you gathered anything here worth showing (a finding, a candidate, a status), reflect it in your live surface NOW (update_surface{id,props}) before the next read — don’t batch updates to the end.'
          }
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
        'Open a library widget on the canvas as a live sandboxed surface — a thinking-widget is an INSTRUMENT you DRIVE, not a final render: update_surface{id,props} it after EACH step of progress, never once at the end. It fetches integration data through the OS bridge; the user approves access once. Returns { id, drive? } (and needsConnect:[...] if a required integration is not connected). Use list_widgets for names.',
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
        const out = needsConnect.length ? { id, needsConnect } : { id }
        // A (live-driving contract): a thinking-widget (no integration) is an INSTRUMENT, not a final
        // render. The #1 failure is spawning one with a skeleton then populating it once at the end, so
        // it sits frozen through the whole task. Return the contract at spawn time, mid-flow.
        if (!w.needs.length)
          out.drive =
            'This is a LIVE surface, not a final render. Call update_surface{id,props} after EACH step of progress (each item found, each phase advanced) so the user watches the work happen — leaving it on this initial state until you finish defeats its purpose.'
        return out
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
      input_schema: { type: 'object', properties: { since: { type: 'number' }, wait: { type: 'number' }, session: { type: 'string' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        const since = Number(a.since) || 0
        const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25)
        // `session` scopes the stream to ONE chat session's messages (default '0' = primary chat).
        const events = await waitForEvents(since, wait * 1000, a.session != null ? String(a.session) : '0')
        return { events, latest: latestSeq(), reminder: EVENTS_REMINDER }
      }
    },
    {
      path: '/say',
      description:
        "Send a chat message to the USER — it appears in their in-canvas Chat panel. Use this to reply when a moment has trigger:'message' (the user typed to you), or to proactively tell them something. Plain text. If you are a non-primary session, pass {session:'<your id>'} so it lands in YOUR chat.",
      input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, session: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const text = String(b.text || '')
        if (!text) return { status: 400, body: { error: 'text required' } }
        ops.say(text, b.session != null ? String(b.session) : '0')
        return { ok: true }
      }
    },
    {
      path: '/customize_widget',
      description:
        "Rewrite a built-in OS widget's UI — currently {name:'chat'}. The UI is a workspace file (blitz-chat.html) you fully replace; it live-reloads. Use the injected Blitz UI kit: <blitz-titlebar>/<blitz-list>/<blitz-message role=user|agent>/<blitz-input> + --blitz-* tokens + window.blitz (onProps(p=>render(p.messages)), sendMessage(text)). Read the current source with get_system_ui first. Args: {name, html, session? (which chat session's widget; default '0')}.",
      input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string' }, html: { type: 'string' }, session: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const r = ops.customizeWidget(String(b.name || ''), String(b.html || ''), b.session != null ? String(b.session) : '0')
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
    },
    {
      path: '/spawn_chat_session',
      description:
        "Open a NEW chat session — a fresh peer agent with its OWN chat widget (a `chat-<id>.md` transcript + window), reachable over this same relay. The new agent is independent: messages typed into ITS widget go only to it, and its `say`s land only in its widget (no cross-talk with you or other sessions). Use this to spin up a parallel agent for a separate task/conversation. Args: {title?}. Returns { session:{id,title} }.",
      input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        if (typeof ops.spawnChatSession !== 'function') return { status: 501, body: { error: 'chat sessions not supported on this transport' } }
        const session = await ops.spawnChatSession(a.title != null ? String(a.title) : undefined)
        return { session }
      }
    },
    {
      path: '/spawn_session',
      description:
        "Start a SESSION — a real terminal running a command, persisted in this workspace and shown as a terminal surface. Use it for a shell, a coding agent (claude/codex), a build/test runner, or any long job. The session SURVIVES a restart (tmux-backed) and its transcript is saved under .blitzos/sessions/. Args: {command (e.g. 'bash' or \"claude -p '…'\"), kind?:'pty'|'agent', cwd?, title?, cols?, rows?}. Returns { session }.",
      input_schema: { type: 'object', properties: { command: { type: 'string' }, kind: { type: 'string', enum: ['pty', 'agent'] }, cwd: { type: 'string' }, title: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        const session = await ops.spawnSession({ command: a.command, kind: a.kind, cwd: a.cwd, title: a.title, cols: a.cols, rows: a.rows })
        return { session }
      }
    },
    {
      path: '/list_sessions',
      description: 'List the sessions in this workspace (running + persisted): id, kind, title, command, status, pid.',
      handler: () => ({ sessions: ops.listSessions() })
    },
    {
      path: '/send_to_session',
      description: "Send input to a session's terminal — keystrokes/commands as raw text. Include a trailing newline to submit (e.g. data:'git status\\n'). Args: {id, data}.",
      input_schema: { type: 'object', required: ['id', 'data'], properties: { id: { type: 'string' }, data: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.sendToSession(String(a.id), String(a.data ?? '')) }
      }
    },
    {
      path: '/read_session',
      description: "Read a session's current terminal output (scrollback) — to see what a shell/agent/build produced. Args: {id}. Returns { text }.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        return { text: ops.readSession(id) }
      }
    },
    {
      path: '/stop_session',
      description: 'Stop (kill) a session by id. Args: {id}.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.stopSession(id) }
      }
    },
    {
      path: '/request_action',
      description:
        "Ask the HUMAN to do something only they can — sign in, scan a QR, approve a send, choose an option. Surfaces as a checkable card in their Action-items inbox (NOT a chat wall). Use this instead of /say for anything that needs a human action. When they tick it, you're woken via /events with trigger:'action' {kind:'action-resolved', id, title, resolution}. Args: {title, detail?, kind?:'task'|'signin'|'approve'|'choose'|'scan'|'info', sessionId?, choices?:[string] (for kind:'choose'), id? (pass to UPDATE an existing item)}. Returns { item }.",
      input_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, detail: { type: 'string' }, kind: { type: 'string', enum: ['task', 'signin', 'approve', 'choose', 'scan', 'info'] }, sessionId: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, id: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const item = ops.requestAction({ title: a.title, detail: a.detail, kind: a.kind, sessionId: a.sessionId, choices: a.choices, id: a.id })
        return item ? { item } : { status: 400, body: { error: 'title required (or no active workspace)' } }
      }
    },
    {
      path: '/list_actions',
      description: "List the human's action items (things YOU asked them to do). Args: {status?:'pending'|'done'|'dismissed'}. Returns { actions }. Check pending ones to see what's still blocking you.",
      input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'done', 'dismissed'] } } },
      handler: ({ body }) => ({ actions: ops.listActions(parse(body).status) })
    },
    {
      path: '/resolve_action',
      description: "Retract/resolve one of YOUR action items — e.g. you detected the human already did it, or it's no longer needed. The human normally resolves items themselves by ticking them. Args: {id, resolution?:'done'|'dismissed'}.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, resolution: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.resolveAction(String(a.id), a.resolution ? String(a.resolution) : 'done') }
      }
    }
  ]
}

/** Build the registry + a path lookup for a runtime's ops (the localhost dispatcher needs the by-path map). */
export function makeOsToolsByPath(ops) {
  return Object.fromEntries(makeOsTools(ops).map((t) => [t.path, t]))
}
