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
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
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

/**
 * Build the tool registry bound to a runtime's primitive operations.
 * @param {object} ops — { getState()->state, workspaceContext()->{workspace,workspace_path,siblings}, say(text),
 *   steer(text,agentId), userMessage(text,agentId), runWorkflow(spec)->{ok,runId}, setTheme({accent,accentDeep})->{ok},
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
        'List the workspace: its folder path (workspace_path) and the open surfaces (layout fields only — an INDEX; use get_surface for one surface\'s props). Local agents can author by writing files into workspace_path.',
      handler: () => serializeStateForAgent(ops.getState())
    },
    {
      path: '/new_app',
      description:
        "Provision a real blitz.dev app (SQLite+R2+auth, edge-deployed) for a DELIVERABLE the user will keep/ship (landing page, site, app, dashboard — even if v1 looks static). Returns { preview_url, claim_url, agents_md, slug }. Then author files and tell the user the claim URL. For N variations to compare, spawn one sub-agent per variation, each with its OWN app (never one app with N routes, never an in-app chooser). Speed-first: build what's asked, offer backends. Working rules in the doctrine's 'Build deliverables on blitz.dev'. Args { slug } (a-z 0-9 -).",
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
      path: '/events',
      description:
        "Long-poll the user's activity, coalesced into framed 'moments' (batched ~15s; flushed immediately on navigation or going idle after acting). Each moment carries a snapshot of the surface so you can react without a second read: {seq,surfaceId,url,title,trigger,signals,user[],snapshot}. THE AUTONOMY LOOP: start since=0, loop with since=latest and wait=25; on each moment decide whether to act, then build/arrange surfaces to help.",
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
        "Send a chat message to the USER (the island chat). Reply on a trigger:'message' moment, or proactively. RESPONSE STYLE: answer in ONE breath, then stop — open with the substance, no 'I found…' preamble; plain natural language, NEVER JSON/jargon/tool-speak shown to the user. For non-trivial tasks, say a one-line plan first, then short notes as you work — going dark is a failure. Keep it tight: never paste a diff, a code block, or a multi-paragraph wall into chat; if a result needs more than a couple of lines, write it to a deliverable (a file, or a blitz.dev app) and link it, putting the decision in `ask` buttons. To SHOW a visual, screenshot the real SOURCE in the user's connected browser (connection_read can return an image) and inline that in chat as ![what it is](data:image/png;base64,<base64>). A data: image ALWAYS renders; do NOT hotlink third-party image URLs (Yelp/Instagram/Google/CDN), they 403 or block embedding and arrive blank. Inline <svg> works too. Never claim a visual ('photo is up') unless you inlined a data: image in THIS message. For a DECISION / APPROVAL / ambiguous pick, do NOT ask in prose — use the `ask` tool (it renders real tappable buttons). Non-primary agents MUST pass {agent:'<your id>'} so it lands in YOUR chat.",
      input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, agent: { type: 'string' }, workspace: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const text = String(b.text || '')
        if (!text) return { status: 400, body: { error: 'text required' } }
        // `workspace` routes the message to the AGENT'S OWN workspace transcript (pinned via bootstrap),
        // so a background workspace's say never lands in whichever workspace happens to be active.
        ops.say(text, b.agent != null ? String(b.agent) : '0', b.workspace != null ? String(b.workspace) : undefined)
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
      path: '/spawn_agent',
      description:
        "Spawn a NEW agent — a fresh peer agent with its own chat thread in the shared Chat hub (`chat-<id>.md`) and its own visible terminal, reachable over this same relay. The new agent is independent: messages sent to its thread go only to it, and its `say`s land only in that thread (no cross-talk with you or other agents). Use this to spin up a parallel agent for a separate task/conversation. Args: {title?}. Returns { agent:{id,title} }.",
      input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        if (typeof ops.spawnAgent !== 'function') return { status: 501, body: { error: 'agents not supported on this transport' } }
        const agent = await ops.spawnAgent(a.title != null ? String(a.title) : undefined)
        return { agent }
      }
    },
    {
      path: '/start_workflow',
      description:
        "Start a WORKFLOW: spawn a fresh agent with the ORCHESTRATORS capability ON and hand it a task. Use this (instead of spawn_agent) for a substantial task you want a dedicated, workflow-capable agent to own — especially anything HARD, large, massively parallel, or adversarial (mining many sessions, ranking N items, verifying every claim in a doc, deep research, a tournament, a wide migration). The spawned agent boots with the orchestrator duty (it can AUTHOR and RUN blitzscript workflows via `.blitzos/blitz`) and receives your task as its first directive; it decides whether to write a workflow or just do the task directly. A trivial one-off you should handle in chat yourself. Args: {task, title?, contextRefs?}. Returns { agent:{id,title} }.",
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
        "Run a blitzscript workflow you authored, reporting its progress in chat as it runs. Use this INSTEAD of `bash .blitzos/blitz run` when you want the run managed for you. Returns IMMEDIATELY with { runId } — the run continues in the background, and writes its result to <workspace>/.blitzos/workflows/<runId>/result.json on completion. You are WOKEN via /events when the run finishes (no need to poll result.json — it is on disk before the wake), so read it then and `say` progress and the final synthesis to the user as it lands. Args: {file (path to a Claude-shaped workflow .js you authored + `blitz check`ed), args? (the workflow's `args` input), title?}.",
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
        "Toggle the ORCHESTRATORS capability on an agent. When ON, that agent may AUTHOR and RUN blitzscript workflows (plain-Node programs whose llm() spawns local agent 'leaves' over chunked data — Recursive Language Models on this machine) for genuinely HARD, large, massively parallel, or adversarial tasks: mining many sessions, ranking N items, verifying every claim, deep research, a tournament, a wide migration. Enabling WAKES the agent immediately with the how-to and PERSISTS across restarts; it gains the runner `.blitzos/blitz` (run `bash .blitzos/blitz capabilities` first, then `check`, then `run`), the duty doc `.blitzos/orchestrator.md`, and the built-ins (verify-job, supervise-tick). For trivial/one-shot work the agent still just answers directly. Use it to upgrade an agent (e.g. one you just spawned for a big task) into an orchestrator; turn it OFF to stop. Args: {agent, on?} — on defaults to true. Returns { ok, orchestrators } or { ok:false, error }.",
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
      path: '/close_agent',
      description:
        "Close an agent you previously spawned — stops it, removes its chat widget + terminal, and deletes its files. Args: {id}. The PRIMARY agent '0' (the user's main chat) cannot be closed. Returns { ok } or { ok:false, error }.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const id = String(parse(body).id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        if (id === '0') return { status: 400, body: { error: "cannot close the primary agent '0'" } }
        if (typeof ops.closeAgent !== 'function') return { status: 501, body: { error: 'agents not supported on this transport' } }
        return ops.closeAgent(id)
      }
    },
    {
      path: '/rename_agent',
      description: 'Rename an agent (cosmetic title shown in the widget + Terminals & Agents tray). Args: {id, title}. Returns { ok, title } or { ok:false, error }.',
      input_schema: { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const id = String(b.id || '')
        if (!id) return { status: 400, body: { error: 'id required' } }
        if (typeof ops.renameAgent !== 'function') return { status: 501, body: { error: 'agents not supported on this transport' } }
        return ops.renameAgent(id, String(b.title ?? ''))
      }
    },
    {
      path: '/open_terminal',
      description:
        "Open a TERMINAL — a real terminal running a command, persisted in this workspace and shown as a terminal surface. Use it for a shell, a coding agent (Codex/Claude), a build/test runner, or any long job. The terminal SURVIVES a restart (tmux-backed) and its transcript is saved under .blitzos/terminals/. Args: {command (e.g. 'bash', \"codex exec '…'\", or \"claude '…'\"), cwd?, title?, cols?, rows?}. Returns { terminal }.",
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
        "List CONNECTED external sources (the browser tabs / macOS windows the user connected into BlitzOS). Pass {agent: YOUR agent id} to see only YOUR chat's sources (the user attaches into the chat they're in); omit it to see all. Each: { connId, type:'tab'|'window', sourceId (a tab's origin host or a window's app bundle id), title, status, capabilities, surfaceId, agentId (the owning chat), savedTools, description }. A connection is a per-source TOOL PROVIDER — read/act on it with the other connection_* tools, passing its connId as `connection`. Empty until something is connected.",
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
        "List the user's open browser tabs that CAN be connected (via the BlitzOS Connector extension). Returns { tabs:[{tabId,title,url}] }. Then connection_connect_tab one of them. Errors if the extension isn't installed/connected yet.",
      handler: async () => {
        if (typeof ops.connectionListTabs !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        return mapConnResult(await ops.connectionListTabs())
      }
    },
    {
      path: '/connection_connect_tab',
      description:
        "Connect a browser tab (a tabId from connection_list_tabs) into BlitzOS as a per-source tool provider. Args: {tabId, title?}. Returns { connId, sourceId, savedTools, registryTools } — CHECK savedTools (already banked) and registryTools (vetted, available via connection_registry_add) BEFORE deriving JS: if one fits the task, call_tool/registry_add it instead of figuring it out from scratch.",
      input_schema: { type: 'object', required: ['tabId'], properties: { tabId: { type: ['number', 'string'] }, title: { type: 'string' }, agent: { type: 'string', description: 'your agent/session id — owns this connection (for connection_list scoping)' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionConnectTab !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.tabId == null) return { status: 400, body: { error: 'tabId required' } }
        return mapConnResult(await ops.connectionConnectTab(a.tabId, { title: a.title, agentId: a.agent != null ? String(a.agent) : '' }))
      }
    },
    {
      path: '/connection_list_windows',
      description:
        "List the user's open macOS app windows that CAN be connected (via the BlitzComputerUse helper — macOS + local only). Returns { windows:[{windowId,pid,app,bundleId,title}] }. Then connection_connect_window one of them.",
      handler: async () => {
        if (typeof ops.connectionListWindows !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        return mapConnResult(await ops.connectionListWindows())
      }
    },
    {
      path: '/connection_connect_window',
      description:
        "Connect a macOS app window (a windowId from connection_list_windows) into BlitzOS as a per-source tool provider. Read via its accessibility tree (or a screenshot when AX is thin); act via AXPress/set (background) or coordinate CGEvent (needs the window raised). Args: {windowId, title?}. Returns { connId, sourceId, savedTools, registryTools } — check savedTools/registryTools before deriving.",
      input_schema: { type: 'object', required: ['windowId'], properties: { windowId: { type: 'number' }, title: { type: 'string' }, agent: { type: 'string', description: 'your agent/session id — owns this connection (for connection_list scoping)' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionConnectWindow !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.windowId == null) return { status: 400, body: { error: 'windowId required' } }
        return mapConnResult(await ops.connectionConnectWindow(a.windowId, { title: a.title, agentId: a.agent != null ? String(a.agent) : '' }))
      }
    },
    {
      path: '/connection_install_extension',
      description:
        "Install the BlitzOS Connector Chrome extension (force-install) so the user's tabs can be connected. Prompts the user for admin ONCE (writes a Chrome managed policy; BlitzOS serves the extension locally). macOS + the BlitzOS app only. Returns { ok, note } or an error to relay. Only needed when connection_list_tabs reports the extension isn't connected.",
      handler: async () => {
        if (typeof ops.connectionInstallExtension !== 'function') return { status: 501, body: { error: 'extension install is available only in the BlitzOS app (macOS, local)' } }
        return mapConnResult(await ops.connectionInstallExtension())
      }
    },
    {
      path: '/connection_read',
      description:
        "Read a connected source — a TAB: DOM/text (pass a CSS `selector` to scope it); a WINDOW: its accessibility tree/value, or a `screenshot` when the structure is too thin to read. SCOPED + CAPPED by default (pass {max} bytes to read more) — never dump a whole tree into context. Args: {connection, selector?, screenshot?, max?}. Returns { result }.",
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
        "Act on a connected source: click / type / set — BY REF (a tab: CSS `selector`; a window: AXPress on a role/label — both work in the BACKGROUND) or BY COORDINATE ({x,y} — needs the window raised; macOS-local). Args: {connection, action:'click'|'type'|'set'|'key', selector?, x?, y?, text?, key?}. Returns { ok, effect } — the observed change, so you verify the act actually landed.",
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
        "Run JavaScript in a connected TAB's page (tab-only — a window returns capability_unavailable). `code` is a function body: use `return` to read a value; `args` are passed in as the argument. Args: {connection, code, args?, max?}. Returns { result }.",
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
        "Run a saved tool by name on a connection (see connection_list_tools). Args: {connection, name, args?}. Returns { ok, effect } — or { stale:true } when the saved tool no longer matches the page/app: read the source, then connection_save_tool — overwrite the same name if it is a stale selector on the same page-type, or save a distinctly-named variant if this is a different sub-type of the same source (e.g. Sheets vs Docs share docs.google.com).",
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
      description: 'List the saved tools for a connection (keyed on its sourceId): each { name, description, kind } + the source description. A fresh session calls this to inherit everything a past session already learned about the source. Args: {connection}.',
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
