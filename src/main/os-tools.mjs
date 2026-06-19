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
import { listWidgets, getWidgetSource, saveWidget, widgetAuthoringMd } from './widget-catalog.mjs'
import { waitForEvents, latestSeq, EVENTS_REMINDER } from './perception-core.mjs'
// Stage grid: agent N owns stage N (stageForAgent). When an agent-scoped call creates a surface, we tag it
// with {stage} so the renderer cascades it into that agent's stage — isolated from the user's primary (stage 0).
import { stageForAgent, orderedStageRect, stageOfPoint, parkBandRect, DEFAULT_VP } from '../renderer/src/stages-core.mjs'
// Stage slot lattice (plans/blitzos-stage-slot-desktop.md): the SAME pure placer the renderer uses,
// so an agent placement and a human drag-snap can never disagree about what is free.
import { latticeFor, cardRect, findSlot, budgetUsed, stageSummary, sizeForDims, spanOf, STAGE_BUDGET } from '../renderer/src/stage-core.mjs'

// OFF-STAGE = the open infinite canvas OUTSIDE the stage (the bounded per-workspace "stage" the user's
// desktop-mode camera frames). There is no separate hidden pool: a work surface parks below the stage,
// naturally off-screen at scale 1 and revealed when the user zooms out or enters Control Mode. Computed
// geometrically — a surface is offstage iff it has no slot and sits outside its stage's rect.
function isOffstage(s, vp, order, count) {
  if (!s || s.slot) return false
  const v = vp || DEFAULT_VP
  const cx = (Number(s.x) || 0) + (Number(s.w) || 0) / 2
  const ty = Number(s.y) || 0 // TOP probe: a parked window belongs to the stage it hangs from
  const r = orderedStageRect(stageOfPoint(cx, ty, v, order, count), v, order, count)
  return s.x + s.w <= r.x || s.x >= r.x + r.w || s.y + s.h <= r.y || s.y >= r.y + r.h
}

function parse(body) {
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
}

// Map a connection-op result ({error}/{ok}/{result}/{capability_unavailable}) to an HTTP-shaped tool return.
// A capability mismatch is a SOFT result (200) — the agent reads `capability_unavailable` and adapts, it is
// never a hard error (the connection doc's contract). A missing connection is a 404; other errors are 400.
function mapConnResult(out) {
  if (out && typeof out === 'object' && out.error && out.error !== 'capability_unavailable') {
    return { status: /^no connection/.test(out.error) ? 404 : 400, body: out }
  }
  return out
}

const NATIVE_COMPONENTS = new Set(['note', 'chat', 'activity', 'terminal', 'runtime', 'inbox', 'file', 'dir', 'files', 'unlock', 'folder'])

function nativeCatalogWidgetError(component) {
  const name = String(component || '').trim()
  if (!name || NATIVE_COMPONENTS.has(name)) return null
  if (!getWidgetSource(name)) return null
  return {
    status: 400,
    body: {
      error: `${name} is a library widget, not a native component. Use spawn_widget {"name":"${name}","props":{...}} instead of create_surface/place_widget with kind:"native".`
    }
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

// The agent-facing view of desktop state — layout fields ONLY (master's contract): an INDEX, not the
// content. srcdoc `html` and `props` are omitted (bloat; chat/activity props hold the full transcript).
// To VERIFY a specific widget's data landed (a srcdoc iframe can't be read_window'd), use the targeted
// `get_surface {id}` tool — pull one surface's props on demand instead of pushing everyone's every call.
// ONE definition so every transport (and the widget list_state tool) returns the IDENTICAL shape.
export function serializeStateForAgent(state) {
  const s = state || {}
  return {
    ...s,
    surfaces: (s.surfaces || []).map((x) => {
      const out = {
        id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, z: x.z, zoom: x.zoom, title: x.title, url: x.url, component: x.component, pinned: x.pinned,
        // A web surface is a BROWSER WINDOW: url/title above are its ACTIVE tab's; `tabs` lists all
        // of them. update_surface{url} / read_window / surface_control act on the active tab.
        ...(x.kind === 'web' && Array.isArray(x.tabs) && x.tabs.length ? { tabs: x.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })), activeTab: x.activeTab || 0 } : {}),
        // Stage desktop: a slotted surface is ON the user's stage; offstage = parked on the open canvas.
        ...(x.slot ? { slot: x.slot, ...(x.slotStage ? { slotStage: x.slotStage } : {}) } : {}),
        ...(isOffstage(x, s.viewport, s.stageOrder, Number(s.stageCount) || 1) ? { offstage: true } : {}),
        ...(x.focus ? { focus: true } : {}),
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
    }),
    // The user's desktop at a glance: the slot grid, what's tiled, the attention budget, and the
    // offstage pool (work parked on the canvas around the stage) — reason in slots, never pixels.
    stage: stageSummary(s.surfaces || [], s.viewport, 0),
    backstage: (s.surfaces || []).filter((x) => isOffstage(x, s.viewport, s.stageOrder, Number(s.stageCount) || 1)).map((x) => ({ id: x.id, kind: x.kind, title: x.title, url: x.url }))
  }
}

// The targeted verification read: ONE surface, props included — the pull complement to the lean
// list_state. Transcript-bearing surfaces (chat/activity) are refused: their props ARE the conversation.
export function serializeSurfaceForAgent(state, id) {
  const s = state || {}
  const x = (s.surfaces || []).find((w) => w && w.id === String(id))
  if (!x) return { error: `no surface ${id}` }
  if (x.role === 'chat' || x.role === 'activity' || x.component === 'chat' || x.component === 'activity') {
    return { error: 'transcript surfaces are not readable here — the chat history is yours already' }
  }
  return {
    surface: {
      id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, z: x.z, zoom: x.zoom, title: x.title, url: x.url, component: x.component, pinned: x.pinned,
      ...(x.kind === 'web' && Array.isArray(x.tabs) && x.tabs.length ? { tabs: x.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })), activeTab: x.activeTab || 0 } : {}),
      ...(x.props ? { props: x.props } : {})
    }
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
 *   readWindow(id,script?)->result, controlSurface(id,action)->{ok,result}, say(text),
 *   customizeWidget(name,html,agentId?,lang?)->{ok,rel}, systemUi(name)->html|null, systemUiInfo(name)->{source,lang}|null, groupIntoFolder(name,ids,x,y,kind)->{ok,...} }
 */
export function makeOsTools(ops) {
  // Stage placement (shared by place_widget / bring_to_stage / auto-placed creates): budget-check,
  // find a free span on the agent-stage's lattice, derive the tile's world rect. Returns either
  // { slot, slotStage, rect } or { full } (budget or space) with the occupants so the agent can evict.
  const placeOnStage = (sizeArg, near, agentId, dims, pinned) => {
    const st = ops.getState() || {}
    const surfaces = st.surfaces || []
    const stage = agentId != null ? stageForAgent(agentId) : 0
    const size = typeof sizeArg === 'string' && sizeArg ? sizeArg.toLowerCase() : sizeForDims(dims?.w, dims?.h)
    const sp = spanOf(size)
    if (!pinned && budgetUsed(surfaces, stage) + sp.c * sp.r > STAGE_BUDGET) {
      return { full: { error: 'stage_full', reason: 'attention budget', ...stageSummary(surfaces, st.viewport, stage) } }
    }
    const lat = latticeFor(st.viewport, stage, st.stageOrder, Math.max(Number(st.stageCount) || 1, stage + 1))
    const slot = findSlot(surfaces, lat, size, near || null, stage)
    if (!slot) return { full: { error: 'stage_full', reason: 'no free span for ' + size, ...stageSummary(surfaces, st.viewport, stage) } }
    return { slot: { col: slot.col, row: slot.row, size }, slotStage: stage, rect: cardRect(lat, slot.col, slot.row, size) }
  }
  // Park a work surface OFF-STAGE: on the open canvas just below the agent's stage — outside the
  // user's desktop-mode frame, in plain view when they zoom out. Cascaded so parked windows fan out.
  const parkOffstage = (agentId) => {
    const st = ops.getState() || {}
    const vp = st.viewport || DEFAULT_VP
    const stage = agentId != null ? stageForAgent(agentId) : 0
    const count = Math.max(Number(st.stageCount) || 1, stage + 1)
    // The stage's own park band: the gutter strip below ITS splay cell (never another stage's row).
    const band = parkBandRect(stage, vp, st.stageOrder, count)
    const parked = (st.surfaces || []).filter(
      (s) => s && !s.slot && s.y >= band.y && s.y < band.y + band.h && s.x + (s.w || 0) > band.x && s.x < band.x + band.w
    ).length % 8
    return { x: Math.round(band.x + 60 + parked * 64), y: Math.round(band.y + 24 + parked * 24) }
  }
  return [
    {
      path: '/create_surface',
      description:
        'Create a surface (web|app|srcdoc|native): web/app take url, srcdoc takes html (+ lang:"jsx"|"tsx" for a React widget — see get_widget_authoring), native takes component+props. Before passing authored srcdoc/JSX/TSX source, self-review it against get_widget_authoring, fix obvious issues, then verify after mount. SHAPED thinking/output — a set you rank or profile, a comparison/decision, a sequence, a multi-step process, relationships → use `spawn_widget` instead; a `note`/`.md` is for plain prose ONLY. Returns { id, workspace_path, siblings }. LOCAL agents: prefer writing a file into workspace_path (`.html`=panel, `.jsx`=React widget, `.md`=note, `.weblink`=web) — surfaces in ~250ms, no /tmp; use this api when remote or for exact x/y/w/h. siblings = what is already here (unrelated → consider create_workspace). If you are a non-primary agent, pass {agent:"<your id>"} so it opens in YOUR stage (do NOT also pass x/y unless repositioning within your stage).',
      input_schema: {
        type: 'object',
        required: ['kind'],
        properties: { kind: { type: 'string', enum: ['web', 'app', 'srcdoc', 'native'] }, lang: { type: 'string', enum: ['html', 'jsx', 'tsx'] }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' }, url: { type: 'string' }, html: { type: 'string' }, component: { type: 'string' }, props: { type: 'object' }, agent: { type: 'string' } }
      },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.kind) return { status: 400, body: { error: 'kind required' } }
        if (a.kind === 'native') {
          const widgetError = nativeCatalogWidgetError(a.component)
          if (widgetError) return widgetError
        }
        // An agent-scoped surface lands in ITS stage (the renderer cascades by `stage` when no
        // explicit x is given); the primary agent '0' → stage 0 = today's behavior.
        if (a.agent != null) a.stage = stageForAgent(a.agent)
        // Stage desktop: web/app are WORK surfaces — born OFF-STAGE (parked on the canvas below the
        // user's stage frame), never on the desktop uninvited; bring_to_stage is the deliberate act
        // that stages something. srcdoc/native widgets auto-take a free slot (a created widget the
        // user can't see is useless) and park offstage when the stage is full — the reply says which.
        let staged = null
        let offstage = false
        if (a.kind === 'web' || a.kind === 'app') {
          if (a.x == null && a.y == null) Object.assign(a, parkOffstage(a.agent))
          offstage = true
        } else if (!a.slot && !a.role && !a.pinned) {
          const p = placeOnStage(a.size, a.near, a.agent, { w: a.w, h: a.h }, false)
          if (p.slot) {
            a.slot = p.slot
            a.slotStage = p.slotStage
            staged = p.slot
          } else {
            Object.assign(a, parkOffstage(a.agent))
            offstage = true
          }
        }
        const id = ops.createSurface(a)
        const ctx = ops.workspaceContext()
        return {
          id,
          ...(staged ? { slot: staged } : offstage ? { offstage: true, hint: a.kind === 'web' || a.kind === 'app' ? 'parked on the canvas below the stage — bring_to_stage {id} only when the user should SEE it' : 'stage was full — parked below it; bring_to_stage later or evict' } : {}),
          workspace: ctx.workspace,
          workspace_path: ctx.workspace_path,
          siblings: (ctx.siblings || []).filter((s) => s.id !== id).map((s) => s.title)
        }
      }
    },
    {
      path: '/open_window',
      description:
        'Open a third-party website as a live web surface. This is the default way to make public/current web evidence visible in Blitz, then drive it with surface_control/read_window. Internal web search is allowed only as a discovery index for candidate URLs/query angles; every source you rely on must be opened in Blitz before you present findings. For open-ended research, use multiple query angles when useful rather than doing one visible search. Tab rule: do not call open_window repeatedly for sources in the SAME research lane when you can write/update one tabbed .weblink in workspace_path; use open_window for a single source, the first page in a lane, or a genuinely separate lane. It opens OFF-STAGE (parked on the canvas just below the user\'s desktop frame), visible when they zoom out to watch you work. Call bring_to_stage {id} only when they should look at it. Returns { id, offstage:true }. Non-primary agents pass {agent:"<your id>"}.',
      input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, title: { type: 'string' }, agent: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (typeof a.url !== 'string') return { status: 400, body: { error: 'url required' } }
        if (a.agent != null) a.stage = stageForAgent(a.agent) // open in the agent's own stage
        Object.assign(a, parkOffstage(a.agent)) // work surface: off the stage, on the open canvas
        return { id: ops.openWindow(a), offstage: true }
      }
    },
    {
      path: '/place_widget',
      description:
        "Put a widget on the user's desktop (the STAGE — a slot grid that never overlaps and never reflows). You pick a SIZE + optional position HINT; the OS picks the exact free slot — there is NO x/y. size: s (1x1 square) | m (2x1 wide) | l (2x2 big) | xl (4x2 hero) | tall (2x3, chat-shaped) | xxl (4x4 full-focus — alone it IS the stage). near: 'top-left'|'top-right'|'bottom-left'|'bottom-right'|'center' or another surface's id (lands adjacent). Pass an EXISTING surface id to stage it, OR kind+html/component/props to create directly into the slot. Before creating from authored srcdoc/JSX/TSX source, self-review it against get_widget_authoring and fix obvious issues. Returns { id, slot } or { error:'stage_full', tiles, budget } — then evict (send_backstage) or queue. The stage is the user's ATTENTION: one widget that lets them act beats N raw windows.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          size: { type: 'string', enum: ['s', 'm', 'l', 'xl', 'tall', 'xxl'] },
          near: { type: 'string' },
          agent: { type: 'string' },
          kind: { type: 'string', enum: ['srcdoc', 'native', 'web', 'app'] },
          html: { type: 'string' },
          url: { type: 'string' },
          component: { type: 'string' },
          props: { type: 'object' },
          title: { type: 'string' }
        }
      },
      handler: ({ body }) => {
        const a = parse(body)
        const st = ops.getState() || {}
        if (a.id) {
          const cur = (st.surfaces || []).find((s) => s && s.id === String(a.id))
          if (!cur) return { status: 404, body: { error: `no surface ${a.id}` } }
          const p = placeOnStage(a.size, a.near, a.agent ?? cur.agentId, { w: cur.w, h: cur.h }, !!cur.pinned)
          if (p.full) return { status: 409, body: p.full }
          const r = ops.updateSurface(String(a.id), { slot: p.slot, slotStage: p.slotStage, focus: null, x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h })
          return r && r.ok === false ? { status: 404, body: { error: r.error } } : { id: String(a.id), slot: p.slot }
        }
        if (!a.kind) return { status: 400, body: { error: 'pass an existing id, or kind(+html/component/url) to create into the slot' } }
        if (a.kind === 'native') {
          const widgetError = nativeCatalogWidgetError(a.component)
          if (widgetError) return widgetError
        }
        const p = placeOnStage(a.size, a.near, a.agent, { w: a.w, h: a.h }, false)
        if (p.full) return { status: 409, body: p.full }
        const id = ops.createSurface({ kind: a.kind, html: a.html, url: a.url, component: a.component, props: a.props, title: a.title, slot: p.slot, slotStage: p.slotStage, x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, ...(a.agent != null ? { stage: stageForAgent(a.agent) } : {}) })
        return { id, slot: p.slot }
      }
    },
    {
      path: '/bring_to_stage',
      description:
        "Promote an off-stage surface onto the user's desktop, into a free slot (size defaults to fit; same slot system as place_widget). The deliberate act of asking for the user's attention — do it when they should SEE or ACT on the surface, not for every working window. Args: {id, size?, near?}. Returns { id, slot } or stage_full.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l', 'xl', 'tall', 'xxl'] }, near: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const st = ops.getState() || {}
        const cur = (st.surfaces || []).find((s) => s && s.id === String(a.id))
        if (!cur) return { status: 404, body: { error: `no surface ${a.id}` } }
        const p = placeOnStage(a.size, a.near, cur.agentId, { w: cur.w, h: cur.h }, !!cur.pinned)
        if (p.full) return { status: 409, body: p.full }
        const r = ops.updateSurface(String(a.id), { slot: p.slot, slotStage: p.slotStage, focus: null, x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h })
        return r && r.ok === false ? { status: 404, body: { error: r.error } } : { id: String(a.id), slot: p.slot }
      }
    },
    {
      path: '/send_backstage',
      description:
        "Move a surface OFF the user's stage: it parks on the open canvas just below their desktop frame (still alive — keep driving it; they see it when they zoom out; bring_to_stage returns it). Use to free stage budget or tidy after a task. Args: {id}.",
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const st = ops.getState() || {}
        const cur = (st.surfaces || []).find((s) => s && s.id === String(a.id))
        if (!cur) return { status: 404, body: { error: `no surface ${a.id}` } }
        const r = ops.updateSurface(String(a.id), { slot: null, focus: null, ...parkOffstage(cur.agentId) })
        return r && r.ok === false ? { status: 404, body: { error: r.error } } : { ok: true, offstage: true }
      }
    },
    {
      path: '/move_surface',
      description:
        'Move a surface to (x, y) world pixels. If the id lives in ANOTHER workspace, this BRINGS it into the active one and places it (keeping its id) — use it to pull just that one window here; switch_workspace instead when you want its whole desktop.',
      input_schema: { type: 'object', required: ['id', 'x', 'y'], properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
      handler: ({ body }) => {
        const a = parse(body)
        // 2C: ops return {ok:false,error} for an unknown id — surface it as a real error, not a silent ok.
        const r = ops.moveSurface(String(a.id), Number(a.x), Number(a.y))
        return r && r.ok === false ? { status: 404, body: { error: r.error } } : { ok: true }
      }
    },
    {
      path: '/update_surface',
      description: 'Patch a surface in place: set html (srcdoc; pass lang too when switching a widget between html and jsx/tsx), props (native, e.g. note text), url, title, or geometry. For task-progress widgets, call this as steps start/finish/block; do not wait until the final answer to update the visible plan. Before replacing widget source, self-review against get_widget_authoring; after JSX/TSX updates, check list_state/get_surface for lastError and fix before calling it done.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, html: { type: 'string' }, lang: { type: 'string', enum: ['html', 'jsx', 'tsx'] }, url: { type: 'string' }, title: { type: 'string' }, props: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
      handler: ({ body }) => {
        const { id, ...patch } = parse(body)
        if (!id) return { status: 400, body: { error: 'id required' } }
        const r = ops.updateSurface(String(id), patch)
        return r && r.ok === false ? { status: 404, body: { error: r.error } } : { ok: true }
      }
    },
    {
      path: '/close_surface',
      description: 'Close a surface by id. From inside a widget via window.blitz.tool, omitting id closes that calling widget itself; task-start progress widgets use this to disappear after completion.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const r = ops.closeSurface(String(parse(body).id))
        return r && r.ok === false ? { status: 404, body: { error: r.error } } : { ok: true }
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
        'List the canvas: active workspace, its folder path (workspace_path), and the open surfaces (layout fields only — an INDEX; use get_surface for one surface\'s props). Local agents author by writing files into workspace_path; check surfaces to judge THIS desktop vs a fresh workspace.',
      handler: () => serializeStateForAgent(ops.getState())
    },
    {
      path: '/get_surface',
      description:
        'Fetch ONE surface in full (layout + props; html still omitted) — the targeted verification read after an update_surface, and the only way to read a srcdoc widget\'s data (its iframe can\'t be read_window\'d). Transcript surfaces (chat/activity) are refused. Args: {id}.',
      input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      handler: ({ body }) => {
        const a = parse(body)
        if (!a.id) return { status: 400, body: { error: 'id required' } }
        const r = serializeSurfaceForAgent(ops.getState(), String(a.id))
        return r.error ? { status: 404, body: r } : r
      }
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
        "Provision a real blitz.dev app (SQLite+R2+auth, edge-deployed) for a DELIVERABLE the user will keep/ship (landing page, site, app, dashboard — even if v1 looks static); not for scratch scaffolding (→ srcdoc). Returns { preview_url, claim_url, agents_md, slug }. Then author files and PRESENT as one `app` surface per page/variation, tiled (canvas = the gallery, never an in-app chooser). Speed-first: build what's asked, offer backends. Working rules in the doctrine's 'Build deliverables on blitz.dev'. Args { slug } (a-z 0-9 -).",
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
      description: 'Act INSIDE a web surface (third-party site): click, type, press a key, read text, or screenshot. Only kind "web". Put the surface id in the body. Use read/screenshot first to see the page. A screenshot returns base64 PNG — to SHOW it to the user, inline it in `say` as ![](data:image/png;base64,…) (the reliable way; never hotlink the site\'s own image URLs, they 403/blank). Frame first (scroll so the thing fills the surface), then shoot.',
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
        // 2B: surface the action's observed effect (field value after type, url/dom change after
        // click/key) so the agent can verify in-band that the act actually landed.
        return r.effect ? { ok: true, effect: r.effect } : { ok: true }
      }
    },
    {
      path: '/list_widgets',
      description:
        'Browse the widget library: reusable, forkable mini-apps (sandboxed HTML or React via lang:"jsx"/"tsx"). Returns each widget’s name, description, and lang. Use get_widget_source to read one, spawn_widget to open it.',
      handler: () => ({ widgets: listWidgets() })
    },
    {
      path: '/get_widget_source',
      description: 'Read the exact, forkable source of a library widget by name: HTML, or JSX/TSX when lang says so. Use this to understand or fork it. Returns { name, html, lang?, needs, props, version, origin }.',
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
        'Open a library widget on the canvas as a live sandboxed surface. For any non-trivial user task, `pipeline` is the default first visible progress surface: spawn it before hidden work with props.items exactly like {items:[{label,sub?,status:"active"|"queued"|"done"}]}; do not use props.steps. Then drive it with update_surface{id,props:{items}} as items move. The default task-start pipeline auto-closes after every item is done; keep final output in a separate note/widget/surface, or pass props.autoClose=false only when the pipeline itself is the durable artifact. A thinking-widget is an INSTRUMENT you DRIVE, not a final render: update it after EACH step of progress, never once at the end. Prefer widgets with useful interaction (filter/sort/expand/open source/chat action) unless the content is truly atomic. Returns { id, drive? }. Use list_widgets for names.',
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' }, props: { type: 'object' } } },
      handler: ({ body }) => {
        const a = parse(body)
        const w = getWidgetSource(String(a.name || ''))
        if (!w) return { status: 404, body: { error: `no widget named "${String(a.name)}"` } }
        const desc = { kind: 'srcdoc', html: w.html, ...(w.lang && w.lang !== 'html' ? { lang: w.lang } : {}), props: { ...w.props, ...(a.props || {}) }, title: typeof a.title === 'string' ? a.title : w.name }
        if (typeof a.x === 'number') desc.x = a.x
        if (typeof a.y === 'number') desc.y = a.y
        if (typeof a.w === 'number') desc.w = a.w
        if (typeof a.h === 'number') desc.h = a.h
        const id = ops.createSurface(desc)
        // A (live-driving contract): a thinking-widget is an INSTRUMENT, not a final render. The #1
        // failure is spawning one with a skeleton then populating it once at the end, so it sits frozen
        // through the whole task. Return the contract at spawn time, mid-flow.
        return {
          id,
          drive:
            'This is a LIVE surface, not a final render. If this is your task-start pipeline, its progress rows must be in props.items, not props.steps: update_surface{id,props:{items:[{label,sub?,status:"active"|"queued"|"done"}]}}. Update it before and during the work, not after the fact. A completed task-start pipeline auto-closes, so put final results somewhere else before finishing.'
        }
      }
    },
    {
      path: '/save_widget',
      description: 'Save a NEW or forked widget (sandboxed HTML, or React via lang:"jsx"/"tsx", using the window.blitz bridge) into the library so it can be browsed and reused. Call get_widget_authoring FIRST, then self-review the source with its checklist and fix obvious issues before saving; most saved widgets should expose a useful action, not just static content. Returns { name, version }.',
      input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string', description: 'a-z 0-9 -, 2-49 chars' }, html: { type: 'string' }, lang: { type: 'string', enum: ['html', 'jsx', 'tsx'] }, description: { type: 'string' }, needs: { type: 'array', items: { type: 'string' } }, props: { type: 'object' }, forkedFrom: { type: 'string' } } },
      handler: ({ body }) => {
        try {
          return saveWidget(parse(body))
        } catch (e) {
          return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
        }
      }
    },
    {
      path: '/get_widget_authoring',
      description: 'Get the widget-authoring guide: how to write HTML or JSX/TSX widgets that expose useful actions via the sandboxed window.blitz bridge, including the required pre-create review checklist. Read this BEFORE authoring a new widget with save_widget.',
      handler: () => ({ markdown: widgetAuthoringMd() })
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
        "Send a chat message to the USER (their in-canvas Chat). Reply on a trigger:'message' moment, or proactively. RESPONSE STYLE: answer in ONE breath, then stop — open with the substance, no 'I found…' preamble; plain natural language, NEVER JSON/jargon/tool-speak shown to the user. For non-trivial tasks, saying you are working is not enough: create/update a live progress widget (usually pipeline) before hidden work, then use say only for concise milestones or final synthesis. A substantial result, a fix, a diff, or a how-it-works explanation is a VISUAL-FIRST widget (lead with a diagram or before/after, built on the design kit), NOT a chat dump: never paste a diff, a code block, or a multi-paragraph explanation into chat; point to the widget in one line and put the decision in `ask` buttons. To SHOW a visual, do BOTH: keep the real SOURCE open as a web surface (the live page it's from), AND screenshot it (surface_control {action:'screenshot'} returns base64 PNG) and inline that in chat as ![what it is](data:image/png;base64,<base64>). A data: image ALWAYS renders; do NOT hotlink third-party image URLs (Yelp/Instagram/Google/CDN), they 403 or block embedding and arrive blank. Inline <svg> works too. Never claim a visual ('photo is up') unless you inlined a data: image in THIS message. For a DECISION / APPROVAL / ambiguous pick, do NOT ask in prose — use the `ask` tool (it renders real tappable buttons). Non-primary agents MUST pass {agent:'<your id>'} so it lands in YOUR chat.",
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
        "STEER another agent: inject a short directive INTO agent N's chat that WAKES it (the W2 supervisor heartbeat). This is how a supervisor nudges a running Job mid-flight — e.g. after a trigger:'tick' moment shows the user edited the plan, or the job stalled/erred. Unlike `say` (which is agent->user and does NOT wake the target), `steer` lands in the target agent's chat as a fresh directive and triggers its `/events` loop, so it actually reacts. Use it to course-correct, hand over new context the user just produced, or unblock an agent — NOT for chatting with the user (that is `say`). Args: {agent, text}. `agent` is the target agent id (required; '0' is the primary). Returns { ok }.",
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
      path: '/customize_widget',
      description:
        "Rewrite a built-in OS widget's UI — currently {name:'chat'}. The default chat is a React/TSX hub, but html/jsx/tsx are supported; it live-reloads. Preserve required chat behavior: render sessions/threads/status, send with window.blitz.sendMessage(text, activeSessionId), create/rename/clear with window.blitz.chat(...), and keep markdown/images/blitz-ui card behavior if replacing it. Read the current source with get_system_ui first, self-review the replacement against get_widget_authoring, then customize. Args: {name, html, lang?:'html'|'jsx'|'tsx', agent?}. Chat customization is global to the hub.",
      input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string' }, html: { type: 'string' }, lang: { type: 'string', enum: ['html', 'jsx', 'tsx'] }, agent: { type: 'string' } } },
      handler: ({ body }) => {
        const b = parse(body)
        const r = ops.customizeWidget(String(b.name || ''), String(b.html || ''), b.agent != null ? String(b.agent) : '0', b.lang != null ? String(b.lang) : undefined)
        return r.ok ? { ok: true, file: r.rel, lang: r.lang } : { status: 400, body: { error: r.error || 'failed' } }
      }
    },
    {
      path: '/get_system_ui',
      description: "Read a built-in widget's current UI source before editing it (the fork pattern). Args: {name:'chat'}. Returns {html, source, lang, file}; html is kept for backward compatibility.",
      input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      handler: ({ body }) => {
        const name = String(parse(body).name || '')
        const info = typeof ops.systemUiInfo === 'function' ? ops.systemUiInfo(name) : null
        if (info) return { html: info.source, source: info.source, lang: info.lang, file: info.rel }
        const html = ops.systemUi(name)
        return html == null ? { status: 404, body: { error: 'unknown widget' } } : { html, source: html, lang: 'html', file: null }
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
      path: '/start_job',
      description:
        "Start a JOB — the formalized unit of work in BlitzOS (it PLANS first, gets the user's approval, then EXECUTES the approved plan to completion). Use this (instead of spawn_agent) when the work is substantial enough to warrant a plan the user reviews: a multi-step task, something with an irreversible outward step, anything the user should approve before it runs. A normal one-off request you should just handle in chat — do NOT start a job for it. This spawns a fresh agent dedicated to the job, gives it the planning duty, and records the job (status 'proposed') on that agent. The job agent will author an editable plan and ask the user to approve; on approval, advance it with set_job_status status:'running'. Args: {title, goal, contextRefs?}. Returns { agent:{id,title}, job }.",
      input_schema: { type: 'object', required: ['goal'], properties: { title: { type: 'string' }, goal: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' } } } },
      handler: async ({ body }) => {
        const a = parse(body)
        if (typeof ops.startJob !== 'function') return { status: 501, body: { error: 'jobs not supported on this transport' } }
        const goal = String(a.goal || '')
        if (!goal.trim()) return { status: 400, body: { error: 'goal required' } }
        const contextRefs = Array.isArray(a.contextRefs) ? a.contextRefs.map(String) : undefined
        const r = await ops.startJob({ title: a.title != null ? String(a.title) : undefined, goal, contextRefs })
        if (!r || r.ok === false) return { status: 400, body: { error: (r && r.error) || 'could not start job' } }
        return { agent: r.agent, job: r.job }
      }
    },
    {
      path: '/set_job_status',
      description:
        "Advance a JOB's lifecycle and/or bind its plan surface. STATUS: proposed -> approved -> running -> done | blocked. The agent owns its own job's status. The load-bearing edge is approved -> running: set status:'running' once the user APPROVES the plan, and BlitzOS re-launches the job agent into its EXECUTION phase (run the approved plan to completion under /goal). Mark 'done' when the whole plan is complete, or 'blocked' when stuck waiting on the user. BIND THE PLAN WIDGET: during planning, pass planSurfaceId:'<the editable plan widget's surface id>' to record it on the job (so the supervisor can find the plan); you may pass planSurfaceId WITHOUT a status (just binding), or together with a status. Args: {agent, status?, planSurfaceId?} — at least one of status/planSurfaceId. Returns { ok, job } or { ok:false, error }.",
      input_schema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, status: { type: 'string', enum: ['proposed', 'approved', 'running', 'done', 'blocked'] }, planSurfaceId: { type: 'string', description: "the editable plan widget's surface id (binds the plan surface to the job)" } } },
      handler: ({ body }) => {
        const b = parse(body)
        if (typeof ops.setJobStatus !== 'function') return { status: 501, body: { error: 'jobs not supported on this transport' } }
        const agent = String(b.agent || '')
        const status = b.status != null ? String(b.status) : ''
        const fields = b.planSurfaceId != null ? { planSurfaceId: String(b.planSurfaceId) } : {}
        if (!agent) return { status: 400, body: { error: 'agent required' } }
        if (!status && !fields.planSurfaceId) return { status: 400, body: { error: 'pass status and/or planSurfaceId' } }
        return ops.setJobStatus(agent, status, fields)
      }
    },
    {
      path: '/close_agent',
      description:
        "Close an agent you previously spawned — stops it, removes its chat widget + terminal, deletes its files, and frees its workspace stage. Args: {id}. The PRIMARY agent '0' (the user's main chat) cannot be closed. Returns { ok } or { ok:false, error }.",
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
        "Open a TERMINAL — a real terminal running a command, persisted in this workspace and shown as a terminal surface. Use it for a shell, a coding agent (Codex/Claude), a build/test runner, or any long job. The terminal SURVIVES a restart (tmux-backed) and its transcript is saved under .blitzos/terminals/. If you are a non-primary agent, pass {agent:\"<your id>\"} so the terminal opens in YOUR stage, not the user's. Args: {command (e.g. 'bash', \"codex exec '…'\", or \"claude '…'\"), cwd?, title?, cols?, rows?, agent?}. Returns { terminal }.",
      input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, title: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' }, agent: { type: 'string' } } },
      handler: async ({ body }) => {
        const a = parse(body)
        // An agent-scoped terminal opens in ITS stage; an unscoped call leaves stage undefined so
        // the renderer opens it in the current stage (today's behavior for the primary agent + human spawns).
        const stage = a.agent != null ? stageForAgent(a.agent) : undefined
        const terminal = await ops.spawnTerminal({ command: a.command, cwd: a.cwd, title: a.title, cols: a.cols, rows: a.rows, stage })
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
        "List CONNECTED external sources (the browser tabs / macOS windows the user connected into BlitzOS). Each: { connId, type:'tab'|'window', sourceId (a tab's origin host or a window's app bundle id), title, status:'live'|'disconnected'|'reconnecting', capabilities, surfaceId (its representation widget), savedTools, description }. A connection is a per-source TOOL PROVIDER — read/act on it with the other connection_* tools, passing its connId as `connection`. Empty until something is connected.",
      handler: () => {
        if (typeof ops.connectionList !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        return ops.connectionList()
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
        "Connect a browser tab (a tabId from connection_list_tabs) into BlitzOS as a per-source tool provider, and spawn its representation widget. This is the agent-initiated 'connect the user's Gmail tab' path. Args: {tabId, title?}. Returns { connId, surfaceId, sourceId }.",
      input_schema: { type: 'object', required: ['tabId'], properties: { tabId: { type: ['number', 'string'] }, title: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionConnectTab !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.tabId == null) return { status: 400, body: { error: 'tabId required' } }
        return mapConnResult(await ops.connectionConnectTab(a.tabId, { title: a.title }))
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
        "Connect a macOS app window (a windowId from connection_list_windows) into BlitzOS as a per-source tool provider, and spawn its representation widget. Read via its accessibility tree (or a screenshot when AX is thin); act via AXPress/set (background) or coordinate CGEvent (needs the window raised). Args: {windowId, title?}. Returns { connId, surfaceId, sourceId }.",
      input_schema: { type: 'object', required: ['windowId'], properties: { windowId: { type: 'number' }, title: { type: 'string' } } },
      handler: async ({ body }) => {
        if (typeof ops.connectionConnectWindow !== 'function') return { status: 501, body: { error: 'connections not supported on this transport' } }
        const a = parse(body)
        if (a.windowId == null) return { status: 400, body: { error: 'windowId required' } }
        return mapConnResult(await ops.connectionConnectWindow(a.windowId, { title: a.title }))
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
        "Run a saved tool by name on a connection (see connection_list_tools). Args: {connection, name, args?}. Returns { ok, effect } — or { stale:true } when the saved selector no longer matches the page/app (re-derive it: connection_read, then connection_save_tool to replace it).",
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
    }
  ].map(instrument)
}

/** Build the registry + a path lookup for a runtime's ops (the localhost dispatcher needs the by-path map). */
export function makeOsToolsByPath(ops) {
  return Object.fromEntries(makeOsTools(ops).map((t) => [t.path, t]))
}
