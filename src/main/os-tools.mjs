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
import { waitForEvents, latestSeq, EVENTS_REMINDER } from './perception-core.mjs'

function parse(body) {
  let o
  try {
    o = body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
  // Tolerant alias: connect_tab / blitz_chrome_open RETURN `connId`, but the connection_* tools take `connection`.
  // A caller naturally passes back the id it was just handed, so accept `connId` as `connection` (a live agent hit
  // this). One fix covers the whole connection family.
  if (o && typeof o === 'object' && o.connId != null && o.connection == null) {
    o.connection = o.connId
    delete o.connId
  }
  return o
}

let _wfRunSeq = 0 // monotonic suffix so two run_workflow calls in the same ms never collide on runId

// Map a connection-op result ({error}/{ok}/{result}/{capability_unavailable}) to an HTTP-shaped tool return.
// A capability mismatch is a SOFT result (200) — the agent reads `capability_unavailable` and adapts, it is
// never a hard error (the connection doc's contract). A missing connection is a 404; other errors are 400.
function mapConnResult(out) {
  if (out && typeof out === 'object' && out.error && out.error !== 'capability_unavailable') {
    return { status: /^no connection/.test(out.error) ? 404 : 400, body: out }
  }
  return out
}

// Connecting / enumerating a NEW source (list_tabs/list_windows/connect_tab/connect_window) is USER-INITIATED:
// it must be reachable ONLY from the BlitzOS Connect UI (localhost), never the untrusted relay/server — else a
// remote/prompt-injected agent could connect the user's logged-in Gmail itself and read it with no consent.
// Driving an ALREADY-connected source (read/act/run_js) stays relay-reachable: the user consented by connecting.
const CONNECT_RELAY_DENIED = {
  status: 403,
  body: {
    error:
      'connecting a source is user-initiated — do it from the BlitzOS Connect UI (localhost), not over the relay. Once connected, you can read/act/run_js on it from here.'
  }
}

// Telemetry/tape seam: observers see every tool call across every transport. MULTI-subscriber (telemetry
// AND the session tape both bind it); each is a no-op until a host registers; must never break a tool call.
// The payload now carries the full args + result (the parsed ctx.body and the handler's out) so a recording
// tap can reconstruct the action AND its effect, not just timing.
const toolTaps = []
export function setToolTap(fn) {
  if (typeof fn === 'function') toolTaps.push(fn)
}
function instrument(t) {
  return {
    ...t,
    handler: async (ctx) => {
      const start = Date.now()
      let status = 200
      let out
      let ok = true
      try {
        out = await t.handler(ctx)
        if (out && typeof out === 'object' && typeof out.status === 'number' && 'body' in out) status = out.status
        ok = status < 400
        return out
      } catch (e) {
        status = 500
        ok = false
        out = { error: String((e && e.message) || e) }
        throw e
      } finally {
        if (toolTaps.length) {
          let args
          try { args = ctx && ctx.body ? JSON.parse(ctx.body) : undefined } catch { args = undefined }
          const info = { path: t.path, transport: ctx && ctx.transport, ms: Date.now() - start, status, ok, args, result: out }
          for (const tap of toolTaps) {
            try { tap(info) } catch { /* the tap must never break the tool */ }
          }
        }
      }
    }
  }
}

// The agent-facing view of state — surface essentials ONLY: an INDEX, not the content. srcdoc `html`
// and `props` are omitted (bloat; chat/activity props hold the full transcript). ONE definition so every
// transport (and the widget list_state tool) returns the IDENTICAL shape.
export function serializeStateForAgent(state) {
  const s = state || {}
  // WHITELIST (never spread `...s`): live state carries internal bookkeeping the agent must not see.
  // Project exactly the agent-facing fields, no more.
  return {
    workspace: s.workspace,
    workspace_path: s.workspace_path,
    surfaces: (s.surfaces || []).map((x) => {
      const out = {
        id: x.id, kind: x.kind, title: x.title, url: x.url, component: x.component,
        // A web surface is a BROWSER WINDOW: url/title above are its ACTIVE tab's; `tabs` lists all
        // of them. update_surface{url} / read_window / surface_control act on the active tab.
        ...(x.kind === 'web' && Array.isArray(x.tabs) && x.tabs.length ? { tabs: x.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })), activeTab: x.activeTab || 0 } : {}),
        // jsx/tsx widgets advertise their lang; a compile/runtime failure surfaces as lastError
        // (the confirm-a-drive read: fix the source, update_surface, re-check).
        ...(x.lang && x.lang !== 'html' ? { lang: x.lang } : {}),
        ...(x.props && x.props.lastError ? { lastError: x.props.lastError } : {})
      }
      // chat surfaces advertise which agent they host; a terminal surface advertises which
      // read_terminal(id) ids it holds (one entry per tab) so an agent can read each.
      if (x.agentId != null) out.agentId = x.agentId
      if (x.component === 'terminal') out.terminals = (x.tabs || []).map((t) => ({ id: t.terminalId, title: t.title }))
      return out
    })
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

const SHARE_APP_ICONS = new Set(['dashboard', 'report', 'table', 'checklist', 'form', 'share', 'browser', 'file'])
const SHARE_APP_TONES = new Set(['sky', 'mint', 'amber', 'violet', 'lime', 'rose'])

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizedShareAppUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return null
    if (!url.hostname.endsWith('.app.blitz.dev')) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

// The claim page lives on the APEX blitz.dev (today https://blitz.dev/claim/<slug>), NOT the *.app.blitz.dev
// preview host — so it gets its own validator: https + a blitz.dev host only (the Claim button opens it externally).
function normalizedClaimUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'blitz.dev' && !url.hostname.endsWith('.blitz.dev')) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

// new_app -> share_app bridge. The provision API returns claim_url separately from preview_url, but the agent calls
// share_app with only the preview_url. We cache { preview_url -> {claimUrl, expiresAt} } here so the island app card
// can show a "Claim app" button WITHOUT the agent threading claim_url through. Anon blitz.dev projects delete at
// ~12h unless claimed, so the card is the user's one-tap path to keep the app.
const claimByPreviewUrl = new Map()
const CLAIM_CACHE_MAX = 200
function rememberClaim(previewUrl, claimUrl, expiresAt) {
  const key = normalizedShareAppUrl(previewUrl)
  const claim = normalizedClaimUrl(claimUrl)
  if (!key || !claim) return
  if (claimByPreviewUrl.size >= CLAIM_CACHE_MAX) {
    const oldest = claimByPreviewUrl.keys().next().value // FIFO: the oldest provision is least likely still mid-share
    if (oldest !== undefined) claimByPreviewUrl.delete(oldest)
  }
  claimByPreviewUrl.set(key, { claimUrl: claim, expiresAt: expiresAt ? String(expiresAt) : '' })
}

function normalizedShareAppSpec(raw) {
  const title = cleanText(raw?.title, 80)
  const url = normalizedShareAppUrl(raw?.url)
  if (!title) return { ok: false, error: 'title required' }
  if (!url) return { ok: false, error: 'url must be https://*.app.blitz.dev' }
  const subtitle = cleanText(raw?.subtitle, 140)
  const icon = SHARE_APP_ICONS.has(String(raw?.icon || '')) ? String(raw.icon) : 'dashboard'
  const tone = SHARE_APP_TONES.has(String(raw?.tone || '')) ? String(raw.tone) : 'sky'
  // preview: optional bespoke HTML the island renders as the card face (a sandboxed srcdoc iframe). Static
  // HTML/CSS only (no scripts run); when absent the card falls back to the icon+title+subtitle layout.
  const preview = typeof raw?.preview === 'string' && raw.preview.trim() ? String(raw.preview) : ''
  // Claim URL: prefer an explicit arg (e.g. a re-share after a restart, when the cache is cold), else auto-link
  // from the new_app cache by preview URL. expiresAt rides along for the card (display only).
  const cached = claimByPreviewUrl.get(url)
  const claimUrl = normalizedClaimUrl(raw?.claimUrl) || cached?.claimUrl || ''
  const expiresAt = cached?.expiresAt || ''
  return {
    ok: true,
    app: {
      type: 'app',
      title,
      url,
      ...(subtitle ? { subtitle } : {}),
      icon,
      tone,
      ...(preview ? { preview } : {}),
      ...(claimUrl ? { claimUrl } : {}),
      ...(claimUrl && expiresAt ? { expiresAt } : {})
    }
  }
}

function firstBlitzAppPreviewUrl(text) {
  const s = String(text || '')
  const match = s.match(/(?:https:\/\/)?([a-z0-9-]+\.app\.blitz\.dev(?:\/[^\s<)]*)?)/i)
  if (!match) return null
  return match[0].toLowerCase().startsWith('https://') ? match[0] : `https://${match[1]}`
}

/**
 * Build the tool registry bound to a runtime's primitive operations.
 * @param {object} ops — { getState()->state, workspaceContext()->{workspace,workspace_path,siblings}, say(text),
 *   shareApp(app,agentId,workspace), steer(text,agentId), listAgents()->string[] (live agent-id roster, powers /broadcast),
 *   userMessage(text,agentId), runWorkflow(spec)->{ok,runId}, setTheme({accent,accentDeep})->{ok},
 *   spawnAgent/closeAgent/renameAgent, startWorkflow, setOrchestrators, spawnTerminal/listTerminals/sendToTerminal/
 *   readTerminal/stopTerminal/removeTerminal, requestAction/listActions/resolveAction, and the connection_* ops }
 */
export function makeOsTools(ops) {
  return [
    {
      path: '/set_theme',
      description: 'Set the OS accent color live. `accent` must be a #rrggbb hex. `accentDeep` (optional) is the pressed/hover variant; if omitted it is derived automatically. The change applies instantly to all chrome and persists across restarts.',
      input_schema: { type: 'object', required: ['accent'], properties: { accent: { type: 'string' }, accentDeep: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (!ops.setTheme) return { status: 400, body: { error: 'set_theme not available in this transport' } }
        const r = ops.setTheme({ accent: a.accent, accentDeep: a.accentDeep })
        return r.ok ? { ok: true } : { status: 400, body: { error: r.error } }
      }
    },
    {
      path: '/list_state',
      description:
        'List the workspace: its folder path (workspace_path) and an index of the open panels (chats, terminals; layout fields only, not content). Local agents can author by writing files into workspace_path.',
      handler: () => serializeStateForAgent(ops.getState())
    },
    {
      path: '/new_app',
      description:
        "Provision a real blitz.dev app (SQLite+R2+auth, edge-deployed) for a DELIVERABLE the user will keep/ship (landing page, site, app, dashboard — even if v1 looks static). Returns { preview_url, claim_url, agents_md, slug }. MANDATORY FINAL STEP after authoring files: generate a 460x300 static HTML/CSS preview that is a minified, glanceable representation of the app (minimum words, heavy visuals, the app's real color theme, beautiful and uncluttered, lightweight, self-contained inline CSS, no scripts) and call share_app with { url: preview_url, preview: <that html> } so the island shows it as the card face — ALWAYS pass preview, or the card falls back to a bland generic icon. Do not deliver the preview URL through say. The app card shows a Claim button automatically (it keeps the app past the ~12h anon expiry), so you do not need to surface the claim URL in chat. For N variations to compare, spawn one sub-agent per variation, each with its OWN app (never one app with N routes, never an in-app chooser). Speed-first: build what's asked, offer backends. Working rules in the doctrine's 'Build deliverables on blitz.dev'. Args { slug } (a-z 0-9 -).",
      input_schema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', description: 'unique project slug, a-z 0-9 -' }, title: { type: 'string' } } },
      handler: async ({ body }) => {
        const slug = String(parse(body).slug || '')
          .trim()
          .toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) return { status: 400, body: { error: 'slug must be a-z 0-9 - (2-49 chars, start alphanumeric)' } }
        const r = await provisionBlitzApp(slug)
        if (!r.ok) return { status: r.status || 400, body: { error: r.error } }
        rememberClaim(r.preview_url, r.claim_url, r.project?.expires_at) // so share_app auto-attaches a Claim button to the card
        return { ok: true, slug, preview_url: r.preview_url, claim_url: r.claim_url, agents_md: r.agents_md, next: "IS THIS ONE OF SEVERAL VARIATIONS/PARTS? Then STOP — do NOT author here. You are the orchestrator: provision the rest, put up a placeholder surface per part, and spawn ONE sub-agent per part (build NONE yourself — not even the 'reference'/canonical one, and don't 'prove the deploy on this one first'). SINGLE deliverable only: author files (relative imports auto-bundle, every save deploys — no bundler), offer backends, then MANDATORY FINAL STEP: generate a 460x300 static HTML/CSS preview that is a minified, glanceable representation of the app (minimum words, heavy visuals, real color theme, beautiful, uncluttered, lightweight) and call share_app {title,url:preview_url,preview:<that html>,subtitle?,icon?,tone?,agent?,workspace?} — ALWAYS pass preview (no preview = bland generic icon card). The task is incomplete until share_app succeeds. Do not paste the preview URL through say." }
      }
    },
    {
      path: '/events',
      description:
        "Long-poll the user's activity, coalesced into framed 'moments' (batched ~15s; flushed immediately on navigation or going idle after acting). Each moment carries a snapshot of the connected source so you can react without a second read: {seq,ts,url,title,trigger,signals,user[],snapshot}. THE AUTONOMY LOOP: start since=0, loop with since=latest and wait=25; on each moment decide whether to act.",
      input_schema: { type: 'object', properties: { since: { type: 'number' }, wait: { type: 'number' }, agent: { type: 'string' }, workspace: { type: 'string' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        const since = Number(a.since) || 0
        const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25)
        // `agent` scopes the stream to ONE agent's chat messages (default '0' = primary chat).
        // `workspace` pins the stream to ONE workspace's moments (agents are born pinned via bootstrap)
        // — a background workspace's agent must never see, or answer, another workspace's activity.
        const events = await waitForEvents(since, wait * 1000, a.agent != null ? String(a.agent) : '0', a.workspace != null ? String(a.workspace) : null)
        return { events, latest: latestSeq(), reminder: EVENTS_REMINDER }
      }
    },
    {
      path: '/say',
      description:
        "Send a chat message to the USER (the island chat). Reply on a trigger:'message' moment, or proactively. RESPONSE STYLE: answer in ONE breath, then stop — open with the substance, no 'I found…' preamble; plain natural language, NEVER JSON/jargon/tool-speak shown to the user. For non-trivial tasks, say a one-line plan first, then short notes as you work — going dark is a failure. Keep it tight: never paste a diff, a code block, or a multi-paragraph wall into chat; if a result needs more than a couple of lines, write it to a deliverable. For a generated blitz.dev app, do NOT paste the app URL here — this tool rejects *.app.blitz.dev preview URLs; call share_app first so the island renders a compact app card, then say only a brief summary without the URL. Put decisions in `ask` buttons. To SHOW a visual, screenshot the real SOURCE in Blitz Chrome (connection_read can return an image) and inline that in chat as ![what it is](data:image/png;base64,<base64>). A data: image ALWAYS renders; do NOT hotlink third-party image URLs (Yelp/Instagram/Google/CDN), they 403 or block embedding and arrive blank. Inline <svg> works too. Never claim a visual ('photo is up') unless you inlined a data: image in THIS message. For a DECISION / APPROVAL / ambiguous pick, do NOT ask in prose — use the `ask` tool (it renders real tappable buttons). Non-primary agents MUST pass {agent:'<your id>'} so it lands in YOUR chat.",
      input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, agent: { type: 'string' }, workspace: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const text = String(b.text || '')
        if (!text) return { status: 400, body: { error: 'text required' } }
        const appUrl = typeof ops.shareApp === 'function' ? firstBlitzAppPreviewUrl(text) : null
        if (appUrl) {
          return {
            status: 400,
            body: {
              error: `Do not paste Blitz app preview URLs through say. Call share_app with url=${appUrl}, then send a short summary without the URL.`
            }
          }
        }
        // `workspace` routes the message to the AGENT'S OWN workspace transcript (pinned via bootstrap),
        // so a background workspace's say never lands in whichever workspace happens to be active.
        ops.say(text, b.agent != null ? String(b.agent) : '0', b.workspace != null ? String(b.workspace) : undefined)
        return { ok: true }
      }
    },
    {
      path: '/share_app',
      description:
        "Share a generated blitz.dev app in the island chat as a compact interactive app card. Use this after new_app for deliverables, dashboards, visual reports, interactive tools, rich tables/charts, or anything the user should inspect/manipulate. This is the user-facing delivery step for app previews: call share_app, then use say only for a brief summary without the preview URL. Args: {title, url, preview?, subtitle?, icon?:'dashboard'|'report'|'table'|'checklist'|'form'|'share'|'browser'|'file', tone?:'sky'|'mint'|'amber'|'violet'|'lime'|'rose', agent?, workspace?}. url must be https://*.app.blitz.dev. For a blitz.dev app ALWAYS pass `preview`: a self-contained 460x300 static HTML/CSS card face that is a minified, glanceable representation of the app (minimum words, heavy visuals, the app's real color theme, beautiful and uncluttered, lightweight, inline CSS, no scripts/network). Without it the card is a bland generic icon. When the app was made via new_app the card shows a Claim button automatically (the claim URL is auto-linked by preview URL); pass claimUrl only to override that.",
      input_schema: {
        type: 'object',
        required: ['title', 'url'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          subtitle: { type: 'string' },
          icon: { type: 'string', enum: ['dashboard', 'report', 'table', 'checklist', 'form', 'share', 'browser', 'file'] },
          tone: { type: 'string', enum: ['sky', 'mint', 'amber', 'violet', 'lime', 'rose'] },
          preview: { type: 'string' },
          claimUrl: { type: 'string' },
          agent: { type: 'string' },
          workspace: { type: 'string' }
        }
      },
      handler: ({ body }) => {
        const b = parse(body)
        const normalized = normalizedShareAppSpec(b)
        if (!normalized.ok) return { status: 400, body: { error: normalized.error } }
        if (typeof ops.shareApp !== 'function') return { status: 501, body: { error: 'share_app not available in this transport' } }
        ops.shareApp(normalized.app, b.agent != null ? String(b.agent) : '0', b.workspace != null ? String(b.workspace) : undefined)
        return { ok: true }
      }
    },
    {
      path: '/steer',
      description:
        "STEER another agent: inject a short directive INTO agent N's chat that WAKES it (the W2 supervisor heartbeat). This is how a supervisor nudges a running agent mid-task — e.g. after a trigger:'tick' moment shows the work stalled, erred, or diverged from the goal (the supervise-tick workflow emits exactly this kind of steer/noop decision). Unlike `say` (which is agent->user and does NOT wake the target), `steer` lands in the target agent's chat as a fresh directive and triggers its `/events` loop, so it actually reacts. Use it to course-correct, hand over new context the user just produced, or unblock an agent — NOT for chatting with the user (that is `say`). Args: {agent, text}. `agent` is the target agent id (required; '0' is the primary). Returns { ok }.",
      input_schema: { type: 'object', required: ['agent', 'text'], properties: { agent: { type: 'string' }, text: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        if (typeof ops.steer !== 'function') return { status: 501, body: { error: 'steer not available in this transport' } }
        const agent = String(b.agent ?? '')
        const text = String(b.text || '')
        if (!agent) return { status: 400, body: { error: 'agent required (the target agent id to steer)' } }
        if (!text.trim()) return { status: 400, body: { error: 'text required' } }
        ops.steer(text, agent)
        return { ok: true }
      }
    },
    {
      path: '/user_say',
      description:
        "TEST/DEV syscall (localhost transport ONLY — rejected over the relay): enter a chat message AS THE USER through the exact same path as the human composer (appends '### user' to that agent's chat.md and wakes it with a message moment). Exists so a co-located test agent can drive BlitzOS like a real user; an external agent must never be able to forge user input. Args: {text, agent?}.",
      input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, agent: { type: 'string' } } },
      handler: ({ body, transport }) => {
        if (transport !== 'localhost') return { status: 403, body: { error: 'user_say is localhost-only (trusted co-located test path)' } }
        if (!ops.userMessage) return { status: 400, body: { error: 'user_say not available in this transport' } }
        const b = parse(body)
        const text = String(b.text || '')
        if (!text.trim()) return { status: 400, body: { error: 'text required' } }
        ops.userMessage(text, b.agent != null ? String(b.agent) : b.session != null ? String(b.session) : '0') // `session` accepted for back-compat (the VM rig's scripts)
        return { ok: true }
      }
    },
    {
      path: '/start_workflow',
      description:
        "Start a WORKFLOW: spawn a fresh agent with the ORCHESTRATORS capability ON and hand it a task. Use this for a substantial task you want a dedicated, workflow-capable agent to own — especially anything HARD, large, massively parallel, or adversarial (mining many sessions, ranking N items, verifying every claim in a doc, deep research, a tournament, a wide migration). The spawned agent boots with the orchestrator duty (it can AUTHOR and RUN blitzscript workflows via `.blitzos/blitz`) and receives your task as its first directive; it decides whether to write a workflow or just do the task directly. A trivial one-off you should handle in chat yourself. Args: {task, title?, contextRefs?}. Returns { agent:{id,title} }.",
      input_schema: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, title: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' } } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (typeof ops.startWorkflow !== 'function') return { status: 501, body: { error: 'workflows not supported on this transport' } }
        const task = String(a.task || '')
        if (!task.trim()) return { status: 400, body: { error: 'task required' } }
        const contextRefs = Array.isArray(a.contextRefs) ? a.contextRefs.map(String) : undefined
        const r = ops.startWorkflow({ title: a.title != null ? String(a.title) : undefined, task, contextRefs })
        if (!r || r.ok === false) return { status: 400, body: { error: (r && r.error) || 'could not start workflow' } }
        return { agent: r.agent }
      }
    },
    {
      path: '/run_workflow',
      description:
        "Run a blitzscript workflow you authored, reporting its progress in chat as it runs. Use this INSTEAD of `bash .blitzos/blitz run` when you want the run managed for you. This is also the right tool for a \"spawn N subagents\" fan-out: author a SINGLE-PHASE workflow (one `parallel([...])` of `agent()` leaves, no `phase()`) and run it here — it renders as one row per subagent. Returns IMMEDIATELY with { runId } — the run continues in the background, and writes its result to <workspace>/.blitzos/workflows/<runId>/result.json on completion. You are WOKEN via /events when the run finishes (no need to poll result.json — it is on disk before the wake), so read it then and `say` progress and the final synthesis to the user as it lands. Args: {file (path to a Claude-shaped workflow .js you authored + `blitz check`ed), args? (the workflow's `args` input), title?}.",
      input_schema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, args: {}, title: { type: 'string' }, agent: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.runWorkflow !== 'function') return { status: 501, body: { error: 'run_workflow not supported on this transport' } }
        const a = parse(body)
        const file = String(a.file || '')
        if (!file) return { status: 400, body: { error: 'file required (path to a Claude-shaped workflow .js)' } }
        const runId = 'wf_' + Date.now().toString(36) + (_wfRunSeq++).toString(36)
        const r = await ops.runWorkflow({ file, args: a.args, runId, agentId: a.agent != null ? String(a.agent) : '0' })
        if (!r || r.ok === false) return { status: 500, body: { error: (r && r.error) || 'run failed to start', runId } }
        return { ok: true, runId, note: `Progress reports in chat; you'll be WOKEN via /events when the run finishes, then read .blitzos/workflows/${runId}/result.json (it is on disk before the wake).` }
      }
    },
    {
      path: '/set_orchestrators',
      description:
        "Toggle the ORCHESTRATORS capability on an agent. When ON, that agent may AUTHOR and RUN blitzscript workflows (plain-Node programs whose agent() calls spawn local 'leaves' over chunked data, Recursive Language Models on this machine) for genuinely HARD, large, massively parallel, or adversarial tasks: mining many sessions, ranking N items, verifying every claim, deep research, a tournament, a wide migration. Enabling WAKES the agent immediately with the how-to and PERSISTS across restarts; it gains the runner `.blitzos/blitz` (run `bash .blitzos/blitz capabilities` first, then `check`, then `run`), the duty doc `.blitzos/orchestrator.md`, and the built-ins (verify-job, supervise-tick). For trivial/one-shot work the agent still just answers directly. Use it to upgrade an agent (e.g. one you just spawned for a big task) into an orchestrator; turn it OFF to stop. Args: {agent, on?} — on defaults to true. Returns { ok, orchestrators } or { ok:false, error }.",
      input_schema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, on: { type: 'boolean', description: 'enable (default true) or disable the orchestrators capability' } } },
      handler: ({ body }) => {
        const b = parse(body)
        if (typeof ops.setOrchestrators !== 'function') return { status: 501, body: { error: 'orchestrators not supported on this transport' } }
        const agent = String(b.agent || '')
        if (!agent) return { status: 400, body: { error: 'agent required' } }
        return ops.setOrchestrators(agent, b.on === undefined ? true : !!b.on)
      }
    },
    {
      path: '/open_terminal',
      description:
        "Open a TERMINAL — a real terminal running a command, persisted in this workspace and shown as a terminal panel. Use it for a shell, a coding agent (Codex/Claude), a build/test runner, or any long job. The terminal SURVIVES a restart (tmux-backed) and its transcript is saved under .blitzos/terminals/. Args: {command (e.g. 'bash', \"codex exec '…'\", or \"claude '…'\"), cwd?, title?, cols?, rows?}. Returns { terminal }.",
      input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, title: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        const terminal = await ops.spawnTerminal({ command: a.command, cwd: a.cwd, title: a.title, cols: a.cols, rows: a.rows })
        return { terminal }
      }
    },
    {
      path: '/ask',
      description:
        "Ask the user a DECISION as real tappable UI in chat — the RIGHT way to get a yes/no, a pick, or an approval (never bury the question in prose). kind: 'confirm' (a few inline buttons; put the recommended/affirmative option FIRST), 'choice' (a vertical list of options), or 'grid' (cards, each option {label, sub?, img?}). The user's tap returns to you as their next message (the chosen label), so just continue from it. Args: {kind?, prompt, options:[string|{label,sub?,img?}], agent?}. Keep `prompt` to one plain-language line.",
      input_schema: { type: 'object', required: ['prompt', 'options'], properties: { kind: { type: 'string', enum: ['confirm', 'choice', 'grid'] }, prompt: { type: 'string' }, options: { type: 'array' }, agent: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const prompt = String(b.prompt || '')
        const options = Array.isArray(b.options) ? b.options : []
        if (!prompt || !options.length) return { status: 400, body: { error: 'prompt and options required' } }
        const spec = { type: b.kind === 'choice' || b.kind === 'grid' ? b.kind : 'confirm', prompt, options }
        // The structured prompt rides in the say transcript as a fenced block; the chat widget renders it as a card.
        ops.say('```blitz-ui\n' + JSON.stringify(spec) + '\n```', b.agent != null ? String(b.agent) : '0')
        return { ok: true }
      }
    },
    {
      path: '/list_terminals',
      description: 'List the terminals in this workspace (running + persisted): id, kind, title, command, status, pid.',
      handler: () => ({ terminals: ops.listTerminals() })
    },
    {
      path: '/send_to_terminal',
      description: "Send input to a terminal — keystrokes/commands as raw text. Include a trailing newline to submit (e.g. data:'git status\\n'). Args: {id, data}.",
      input_schema: { type: 'object', required: ['id', 'data'], properties: { id: { type: 'string' }, data: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.sendToTerminal(String(a.id), String(a.data ?? '')) }
      }
    },
    {
      path: '/read_terminal',
      description: "Read a terminal's current output (scrollback) — to see what a shell/agent/build produced. Args: {id}. Returns { text }.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        return { text: ops.readTerminal(id) }
      }
    },
    {
      path: '/close_terminal',
      description: 'Stop (kill) a terminal by id — its program ends but it stays in the tray as RESUMABLE. To fully delete it (e.g. a throwaway you spawned for a finished job), use remove_terminal instead. Args: {id}.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.stopTerminal(id) }
      }
    },
    {
      path: '/remove_terminal',
      description: 'Permanently remove a terminal by id — kill it AND delete its saved record so it leaves the tray (NOT resumable). Use this to clean up a terminal you spawned for a job once you are done with it. The primary agent terminal cannot be removed. Args: {id}.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        return { ok: ops.removeTerminal(id) }
      }
    },
    {
      path: '/request_action',
      description:
        "Ask the HUMAN to do something only they can — sign in, scan a QR, approve a send, choose an option. Surfaces as a checkable card in their Action-items inbox (NOT a chat wall). Use this instead of /say for anything that needs a human action. When they tick it, you're woken via /events with trigger:'action' {kind:'action-resolved', id, title, resolution}. Args: {title, detail?, kind?:'task'|'signin'|'approve'|'choose'|'scan'|'info', agentId?, choices?:[string] (for kind:'choose'), id? (pass to UPDATE an existing item)}. Returns { item }.",
      input_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, detail: { type: 'string' }, kind: { type: 'string', enum: ['task', 'signin', 'approve', 'choose', 'scan', 'info'] }, agentId: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, id: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const item = ops.requestAction({ title: a.title, detail: a.detail, kind: a.kind, agentId: a.agentId, choices: a.choices, id: a.id })
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
    },
    {
      path: '/connection_list',
      description:
        "List CONNECTED external sources (the browser tabs / macOS windows the user connected into BlitzOS). Pass {agent: YOUR agent id} to see only YOUR chat's sources (the user attaches into the chat they're in); omit it to see all. Each: { connId, type:'tab'|'window', origin, sourceId (a tab's origin host or a window's app bundle id), title, status, capabilities, surfaceId, agentId (the owning chat), savedTools, description }. `origin` tells you WHOSE source it is, and it is decisive: 'user-chrome'/'user-safari' = the user's OWN browser that they connected on purpose, so DO THE WORK THERE in their live session, never open Blitz Chrome instead; 'window' = a native macOS app; 'blitz-chrome' = your own browser (the home for work you start on your own; when no source is attached, choose it vs the user's browser by where you are already signed in and what has worked with this user before). A connection is a per-source TOOL PROVIDER — read/act on it with the other connection_* tools, passing its connId as `connection`; its toolkit (and any extra tools it can unlock) come from connection_list_tools. Empty until something is connected.",
      input_schema: { type: 'object', properties: { agent: { type: 'string', description: 'your agent/session id — scopes the list to your chat' } } },
      handler: ({ body }) => {
        if (typeof ops.connectionList !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        return ops.connectionList(a.agent != null ? String(a.agent) : undefined)
      }
    },
    {
      path: '/connection_list_tabs',
      description:
        "List the user's open browser tabs that CAN be connected — Chrome + Safari, via Apple Events (extension-free). Returns { tabs:[{tabId,title,url,browser}] }. Then connection_connect_tab one of them. Needs \"Allow JavaScript from Apple Events\" enabled (Chrome: View ▸ Developer; Safari: Develop menu).",
      handler: async ({ transport }) => {
        if (transport !== 'localhost') return CONNECT_RELAY_DENIED
        if (typeof ops.connectionListTabs !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        return mapConnResult(await ops.connectionListTabs())
      }
    },
    {
      path: '/connection_connect_tab',
      description:
        "Connect a browser tab (a tabId from connection_list_tabs) into BlitzOS as a per-source tool provider. Args: {tabId, title?}. Returns { connId, sourceId, savedTools, registryTools } — CHECK savedTools (already banked) and registryTools (vetted, available via connection_registry_add) BEFORE deriving JS: if one fits the task, call_tool/registry_add it instead of figuring it out from scratch.",
      input_schema: { type: 'object', required: ['tabId'], properties: { tabId: { type: ['number', 'string'] }, title: { type: 'string' }, agent: { type: 'string', description: 'your agent/session id — owns this connection (for connection_list scoping)' } } },
      handler: async ({ body, transport }) => {
        if (transport !== 'localhost') return CONNECT_RELAY_DENIED
        if (typeof ops.connectionConnectTab !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.tabId == null) return { status: 400, body: { error: 'tabId required' } }
        return mapConnResult(await ops.connectionConnectTab(a.tabId, { title: a.title, agentId: a.agent != null ? String(a.agent) : '' }))
      }
    },
    {
      path: '/connection_list_windows',
      description:
        "List the user's open macOS app windows that CAN be connected (via the BlitzOS helper — macOS + local only). Returns { windows:[{windowId,pid,app,bundleId,title}] }. Then connection_connect_window one of them.",
      handler: async ({ transport }) => {
        if (transport !== 'localhost') return CONNECT_RELAY_DENIED
        if (typeof ops.connectionListWindows !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        return mapConnResult(await ops.connectionListWindows())
      }
    },
    {
      path: '/connection_connect_window',
      description:
        "Connect a macOS app window (a windowId from connection_list_windows) into BlitzOS as a per-source tool provider. Read via its accessibility tree, or a `screenshot` when AX is thin; act with connection_act — AXPress/set (background), keys/combos (action:'key', e.g. 'cmd+End'), a clipboard paste (action:'paste', best for a block of text into a canvas editor like Google Docs), or coordinate CGEvent (needs the window raised). Args: {windowId, title?}. Returns { connId, sourceId, savedTools, registryTools } — check savedTools/registryTools before deriving.",
      input_schema: { type: 'object', required: ['windowId'], properties: { windowId: { type: 'number' }, title: { type: 'string' }, agent: { type: 'string', description: 'your agent/session id — owns this connection (for connection_list scoping)' } } },
      handler: async ({ body, transport }) => {
        if (transport !== 'localhost') return CONNECT_RELAY_DENIED
        if (typeof ops.connectionConnectWindow !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.windowId == null) return { status: 400, body: { error: 'windowId required' } }
        return mapConnResult(await ops.connectionConnectWindow(a.windowId, { title: a.title, agentId: a.agent != null ? String(a.agent) : '' }))
      }
    },
    {
      path: '/connection_unlock',
      description:
        "Unlock a connected source's official integration. BlitzOS runs a one-time account approval (opens the login; the user approves once in their browser), then the source's extra tools appear in connection_list_tools — returns immediately. Use it when connection_list_tools shows the source under `unlock`, or when a call returns needsApproval. NEVER use claude mcp add / codex mcp / /mcp / a session restart. Args: {sourceId} (a site host like 'www.notion.com'). Returns {ok, status:'pending'|'live', source, authUrl?} — status:'pending' means tell the user to approve in their browser, then watch /events for the source's tools growing and retry; status:'live' means it was already approved and its tools are ready now. On {ok:false, error} the integration can't be unlocked automatically (use the browser path).",
      input_schema: { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string', description: "the source host, e.g. 'www.notion.com'" }, agent: { type: 'string', description: 'your agent/session id (for connection scoping)' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectMcp !== 'function') return { status: 501, body: { error: 'unlocking a source is not supported on this transport' } }
        const a = parse(body)
        const sourceId = String(a.sourceId || '').trim()
        if (!sourceId) return { status: 400, body: { error: 'sourceId required (a site host like www.notion.com)' } }
        const out = await ops.connectMcp({ sourceId, agentId: a.agent != null ? String(a.agent) : '' })
        // Whitelist the failure body — never leak internal jargon (dcr/available) or the hidden mcp_ connId to the agent.
        if (out && out.ok === false) return { status: 400, body: { ok: false, error: out.error, source: out.source || sourceId } }
        // pass through the MCP-free shape (the connId is the internal handle; the agent works off `source` + status)
        return { ok: true, status: out.status, source: out.source || sourceId, authUrl: out.authUrl, tools: out.tools }
      }
    },
    {
      path: '/connection_read',
      description:
        "Read a connected source — a TAB: DOM/text (pass a CSS `selector` to scope it); a WINDOW: its accessibility tree/value, or `screenshot:true` → { image:<base64 png>, width, height, frame } (a per-window shot for apps AX can't read; inline it in chat as ![](data:image/png;base64,<image>)). SCOPED + CAPPED by default (pass {max} bytes to read more) — never dump a whole tree into context. Args: {connection, selector?, screenshot?, max?}. Returns { result }.",
      input_schema: { type: 'object', required: ['connection'], properties: { connection: { type: 'string' }, selector: { type: 'string' }, screenshot: { type: 'boolean' }, max: { type: 'number' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionRead !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const { connection, ...args } = parse(body)
        if (!connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(await ops.connectionRead(String(connection), args))
      }
    },
    {
      path: '/connection_act',
      description:
        "Act on a connected source. FLAT shape {connection, action, …}. ONE call per action — click: {action:'click', selector:'button[aria-label=\"Send\"]'} (tab/window ref, BACKGROUND) or {action:'click', x, y} (window coordinate, needs the window raised); type: {action:'type', text:'hello'} (types at the focused field); set: {action:'set', selector:'#title', text:'replace value'}; key: {action:'key', key:'Cmd+End'} — a named key OR a modifier combo; key names are letters/digits, arrows, End/Home/PageUp/PageDown, F1–F12, Return/Tab/Space/Esc/Delete/ForwardDelete; modifiers Cmd/Shift/Alt/Ctrl (e.g. 'cmd+a', 'cmd+shift+v'); paste: {action:'paste', text?:'…'} — sets the clipboard to text (if given) then ⌘V into the focused field, the clean way to drop a BLOCK of text into a canvas editor (Google Docs) with no per-keystroke typing. For a WINDOW, type/key/paste/coord-click reach the FOCUSED window — connection_reveal it first if it is not frontmost. Returns { ok, effect } — the observed change, so you verify the act landed.",
      input_schema: { type: 'object', required: ['connection'], properties: { connection: { type: 'string' }, action: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionAct !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const { connection, ...args } = parse(body)
        if (!connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(await ops.connectionAct(String(connection), args))
      }
    },
    {
      path: '/connection_run_js',
      description:
        "Run JavaScript in a connected TAB's page (tab-only — a window returns capability_unavailable). `code` is a function BODY: end with a top-level `return` to read a value. A bare expression or an IIFE returns null while STILL running its side effects, so a paste/click silently fires twice — always `return`, never wrap in an IIFE. `args` are passed in as the argument. Args: {connection, code, args?, max?}. Returns { result }.",
      input_schema: { type: 'object', required: ['connection', 'code'], properties: { connection: { type: 'string' }, code: { type: 'string' }, args: { type: 'object' }, max: { type: 'number' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionRunJs !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        if (typeof a.code !== 'string') return { status: 400, body: { error: 'code (a JS function body) required' } }
        return mapConnResult(await ops.connectionRunJs(String(a.connection), { code: a.code, args: a.args, max: a.max }))
      }
    },
    {
      path: '/connection_navigate',
      description:
        'Navigate a connected TAB to a URL — a Blitz Chrome window or any connected Chrome/Safari tab. Args: {connection, url}. Returns { ok, effect }.',
      input_schema: { type: 'object', required: ['connection', 'url'], properties: { connection: { type: 'string' }, url: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionNavigate !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        if (!a.url) return { status: 400, body: { error: 'url required' } }
        return mapConnResult(await ops.connectionNavigate(String(a.connection), String(a.url)))
      }
    },

    // ---- Blitz Chrome (blitz-chrome.ts): a dedicated Chrome WE launch, driven over --remote-debugging-port
    // (CDP) with NO extension and NO manual setup. Each agent gets its own window in the shared "Blitz"
    // profile. Electron-only — these return 501 on the headless server transport.
    {
      path: '/blitz_chrome_open',
      description:
        "Launch (or get) THIS agent's window in the dedicated **Blitz Chrome** — a separate, isolated, EXTENSION-FREE Chrome we launch and drive over CDP, with NO extension and NO setup step. First call launches + brands the 'Blitz' profile. Returns a first-class TAB connection { connId, sourceId, url, title } that you then DRIVE with the unified connection_* toolset — connection_navigate / connection_read / connection_run_js / connection_act / connection_save_tool / connection_list_tools / connection_call_tool — exactly like any connected tab (real run_js + the saved-tools registry included). There is no separate blitz_chrome driving API. Pass {url} to also navigate first. Args: {agent?, url?}.",
      input_schema: { type: 'object', properties: { agent: { type: 'string', description: 'your agent/session id — owns this window (defaults to "default")' }, url: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.blitzChromeOpen !== 'function') return { status: 501, body: { error: 'the Blitz browser is available only in the BlitzOS app (macOS, local)' } }
        const a = parse(body)
        return mapConnResult(await ops.blitzChromeOpen(a.agent != null ? String(a.agent) : '', { url: a.url }))
      }
    },
    {
      path: '/blitz_chrome_status',
      description: 'Status of the Blitz Chrome (extension-free CDP browser): { available, running, connected, port, profileDir, windows }. Args: {agent?}.',
      input_schema: { type: 'object', properties: { agent: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.blitzChromeStatus !== 'function') return { status: 501, body: { error: 'the Blitz browser is available only in the BlitzOS app (macOS, local)' } }
        const a = parse(body)
        return await ops.blitzChromeStatus(a.agent != null ? String(a.agent) : undefined)
      }
    },
    {
      path: '/blitz_chrome_close',
      description: "Close THIS agent's Blitz Chrome window, or quit the whole Blitz Chrome with {quit:true}. Args: {agent?, quit?}. Returns { ok }.",
      input_schema: { type: 'object', properties: { agent: { type: 'string' }, quit: { type: 'boolean' } } },
      handler: async ({ body }) => {
        if (typeof ops.blitzChromeClose !== 'function') return { status: 501, body: { error: 'the Blitz browser is available only in the BlitzOS app (macOS, local)' } }
        const a = parse(body)
        return mapConnResult(await ops.blitzChromeClose(a.agent != null ? String(a.agent) : undefined, { quit: !!a.quit }))
      }
    },
    {
      path: '/blitz_chrome_show',
      description:
        "Bring the Blitz Chrome window to the FOREGROUND so the user can watch it — opt-in, user-initiated reveal ONLY (Blitz Chrome otherwise runs in the background and never steals focus). Pass {agent} to raise that agent's window. Use this only when the user explicitly asks to see the browser. Args: {agent?}. Returns { ok, shown }.",
      input_schema: { type: 'object', properties: { agent: { type: 'string', description: "the agent/session id whose window to reveal (defaults to 'default')" } } },
      handler: async ({ body }) => {
        if (typeof ops.blitzChromeShow !== 'function') return { status: 501, body: { error: 'the Blitz browser is available only in the BlitzOS app (macOS, local)' } }
        const a = parse(body)
        return mapConnResult(await ops.blitzChromeShow(a.agent != null ? String(a.agent) : undefined))
      }
    },
    {
      path: '/connection_reveal',
      description:
        'Bring the window or tab BEHIND a connection to the FOREGROUND so the user can see/use it (a Blitz Chrome window comes forward; a connected real tab gets activated). Opt-in / user-intent only. Args: {connection}. Returns { ok }.',
      input_schema: { type: 'object', required: ['connection'], properties: { connection: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionReveal !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(await ops.connectionReveal(String(a.connection)))
      }
    },
    {
      path: '/connection_save_tool',
      description:
        "Save a NAMED reusable tool for this source, keyed on its sourceId — so every connection to the same site/app reuses it, across sessions (the per-source tools.json). A TAB tool is JS (`code`, a function body); a WINDOW tool is a recipe of AX/coordinate `steps`. kind:'read' returns a value; kind:'act' MUST return its effect so a stale selector is detectable (a silent no-op is the enemy). Args: {connection, name, description?, kind?, code?|steps?}. Returns { ok, name, count }.",
      input_schema: { type: 'object', required: ['connection', 'name'], properties: { connection: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, kind: { type: 'string', enum: ['read', 'act'] }, code: { type: 'string' }, steps: {} } },
      handler: ({ body }) => {
        if (typeof ops.connectionSaveTool !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(ops.connectionSaveTool(String(a.connection), { name: a.name, description: a.description, kind: a.kind, code: a.code, steps: a.steps }))
      }
    },
    {
      path: '/connection_call_tool',
      description:
        "Run a tool by name on a connection (see connection_list_tools — a source's toolkit can mix tools you banked and tools from its unlocked official integration; you call them all the same way). Returns { ok, effect } (or { ok, text } / { ok:false, isError:true, text } for a tool that errored, relayed honestly, never a fake success) — or { stale:true } when a banked tool no longer matches the page/app: read the source, then connection_save_tool (overwrite the same name if it is a stale selector on the same page-type, or save a distinctly-named variant for a different sub-type, e.g. Sheets vs Docs share docs.google.com). If it returns { needsApproval:true, source, prompt }, the source has an official integration to unlock: connection_unlock { sourceId: source }, tell the user to approve once, then retry. Args: {connection, name, args?}.",
      input_schema: { type: 'object', required: ['connection', 'name'], properties: { connection: { type: 'string' }, name: { type: 'string' }, args: { type: 'object' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionCallTool !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection || !a.name) return { status: 400, body: { error: 'connection and name required' } }
        return mapConnResult(await ops.connectionCallTool(String(a.connection), String(a.name), a.args || {}))
      }
    },
    {
      path: '/connection_list_tools',
      description: "List a connection's toolkit. Returns { sourceId, tools:[{ name, description, ... }], unlock?, description? }. `tools` is everything callable now on this source (the tools you banked for its sourceId — a fresh session inherits them all — plus any from an official integration you've unlocked); run any with connection_call_tool {connection, name}. `unlock` (when present) lists official integrations this source HAS but you haven't unlocked yet (each { source, label, prompt }) — a source can be usable now AND have a richer integration to unlock; call connection_unlock { sourceId: source } to gain those tools (the user approves once). Args: {connection}.",
      input_schema: { type: 'object', required: ['connection'], properties: { connection: { type: 'string' } } },
      handler: ({ body }) => {
        if (typeof ops.connectionListTools !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(ops.connectionListTools(String(a.connection)))
      }
    },
    {
      path: '/connection_describe',
      description: "Write a one-line note about what a source is for (stored next to its tools.json; shown in connection_list + the per-connection briefing). Your own memory of why this connection exists. Args: {connection, description}.",
      input_schema: { type: 'object', required: ['connection', 'description'], properties: { connection: { type: 'string' }, description: { type: 'string' } } },
      handler: ({ body }) => {
        if (typeof ops.connectionSetDescription !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(ops.connectionSetDescription(String(a.connection), String(a.description || '')))
      }
    },
    {
      path: '/connection_drop',
      description: 'Disconnect a connection (tears down the live link). Its representation widget + saved tools persist for next time — reconnecting the same source re-attaches to them. Args: {connection}.',
      input_schema: { type: 'object', required: ['connection'], properties: { connection: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionDrop !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.connection) return { status: 400, body: { error: 'connection (connId) required' } }
        return mapConnResult(await ops.connectionDrop(String(a.connection)))
      }
    },
    {
      path: '/connection_registry_search',
      description:
        "Search the FIRST-PARTY tool registry (our vetted, hosted library of per-source tools) for a source. Returns metadata only ({ name, description, kind, version } — NO code), never runs anything. Before deriving an operation from scratch, search here AND connection_list_tools and prefer a vetted tool. Args: {connection?|sourceId?, query?} — pass a live connection (connId) to use its sourceId, or a sourceId (a site host like 'mail.google.com') directly.",
      input_schema: { type: 'object', properties: { connection: { type: 'string' }, sourceId: { type: 'string' }, query: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionRegistrySearch !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        return mapConnResult(await ops.connectionRegistrySearch({ connection: a.connection, sourceId: a.sourceId, query: a.query }))
      }
    },
    {
      path: '/connection_registry_get',
      description:
        'Get the full registry entry (incl. its code/steps) so you can inspect a vetted tool before adding it. Args: {sourceId, name}. Use connection_registry_add to install it into a connection.',
      input_schema: { type: 'object', required: ['sourceId', 'name'], properties: { sourceId: { type: 'string' }, name: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionRegistryGet !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.sourceId || !a.name) return { status: 400, body: { error: 'sourceId and name required' } }
        return mapConnResult(await ops.connectionRegistryGet({ sourceId: String(a.sourceId), name: String(a.name) }))
      }
    },
    {
      path: '/connection_registry_add',
      description:
        "Install a vetted registry tool into a source's tools.json (upsert by name, pinned by contentHash). It becomes an ordinary saved tool — run it later with connection_call_tool (effect-verified); it is NOT executed by this call. Args: {connection?|sourceId?, name}.",
      input_schema: { type: 'object', required: ['name'], properties: { connection: { type: 'string' }, sourceId: { type: 'string' }, name: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionRegistryAdd !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (!a.name) return { status: 400, body: { error: 'name required' } }
        return mapConnResult(await ops.connectionRegistryAdd({ connection: a.connection, sourceId: a.sourceId, name: String(a.name) }))
      }
    }
  ].map(instrument)
}

/** Build the registry + a path lookup for a runtime's ops (the localhost dispatcher needs the by-path map). */
export function makeOsToolsByPath(ops) {
  return Object.fromEntries(makeOsTools(ops).map((t) => [t.path, t]))
}
