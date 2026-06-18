// The user's live activity, coalesced into batched "moments" an agent watches.
//
// SHARED, transport-agnostic perception kernel — imported by BOTH the Electron main
// (via events.ts, which re-exports this) and the server-mode backend (preview/
// backend.mjs), so the coalescer + sensors are ONE implementation, never duplicated.
// (Mirrors the control-core.mjs pattern.)
//
// BlitzOS is the PRODUCER: in-page sensors (INJECT below) feed raw signals here via
// ingestSignals(); this module coalesces them into framed snapshots ("moments") and a
// long-poll (waitForEvents) wakes a watching agent. Why moments, not a keystroke
// firehose: an autonomous agent should be WOKEN on meaningful change with enough
// context to act — so we batch routine activity (~15s) and flush immediately on a
// significant transition (navigation, or idle-after-activity). Perception is
// content-agnostic (dumb but rich); the AGENT decides significance + action.

const BATCH_MS = 15000

// Signals that represent the USER doing something (vs. background page churn).
// Only these wake the agent; content-only mutation just refreshes the snapshot.
const USER_TYPES = new Set(['key', 'click', 'input', 'pointer', 'select', 'nav', 'idle'])

// A short standing nudge BlitzOS ships on EVERY /events response (like a system
// reminder). The watcher surfaces it with each moment so the agent honors it on each
// wake: think about what the user should see next, and arrange the desktop for it.
export const EVENTS_REMINDER =
  'Reminder: after you act on this, manage the layout. Re-arrange or close surfaces so the user sees only what is relevant to their next step; you own the desktop.'

const pending = new Map()
const lastCtx = new Map()
const LOG = []
let seq = 0
const MAX = 1000
const waiters = []

// WORKSPACE scoping (v2 of the cross-workspace bleed fix): every moment is stamped with the workspace
// that was ACTIVE when it was emitted (the provider is registered by each transport's host wiring), and
// a waiter that declares its workspace only sees that workspace's moments. Agent ids repeat across
// workspaces ('0' everywhere), so without this a background workspace's agent answers the active one's
// chat. An unscoped waiter (no workspace declared — legacy callers, trusted local tools) sees everything.
let workspaceProvider = null
export function setWorkspaceProvider(fn) {
  workspaceProvider = typeof fn === 'function' ? fn : null
}
function currentWorkspace() {
  try { return workspaceProvider ? workspaceProvider() || null : null } catch { return null }
}

// Per-agent visibility (per agent): a chat 'message' moment is PRIVATE to its agent, so each
// agent only sees + answers ITS chat. All OTHER (activity/canvas) moments go to the PRIMARY
// agent ('0') only — the desktop-watcher — so spawning N chat agents doesn't wake them all on canvas
// churn. seq stays a single global counter, so an agent's `since` cursor advances past filtered moments.
function visibleTo(moment, agentId, workspace) {
  // A moment belongs to ONE workspace; an agent pinned to a workspace never sees another's moments.
  if (workspace && moment.workspace && String(moment.workspace) !== String(workspace)) return false
  const sid = String(agentId || '0')
  // A chat 'message' and an 'action' (e.g. an action-item the human resolved) are PRIVATE to the agent
  // they target — only that agent is woken. So a non-primary agent that called request_action
  // is woken when ITS item is resolved (the moment carries agentId; generic surface actions default to '0').
  if (moment.trigger === 'message' || moment.trigger === 'action') return String(moment.agentId || '0') === sid
  return sid === '0'
}

// ---- perception content consent (P0: the untrusted relay must not receive the
// CONTENT of a logged-in surface unless the human shared it). The localhost-trusted
// path (the trusted localhost) is never redacted. Default: not shared.
const contentShared = new Set()

/** The human toggled "let the agent read this surface" for a web surface. */
export function setContentShare(surfaceId, on) {
  if (!surfaceId) return
  if (on) contentShared.add(surfaceId)
  else contentShared.delete(surfaceId)
}
export function isContentShared(surfaceId) {
  return contentShared.has(surfaceId)
}
export function dropContentShare(surfaceId) {
  contentShared.delete(surfaceId)
}

/** Strip page-derived content from a moment, leaving only metadata the relay may see
 *  (surface identity + activity counts; url/title are already exposed via list_state).
 *  TODO(W2): redactMoment is currently UNCALLED repo-wide — no transport routes /events moments through it
 *  (the tick is relay-safe BY CONSTRUCTION: emitTick carries no scraped content, only ids/change-kind/title/
 *  status-edges/counts). Re-wiring this into the /events handler so EVERY relay-bound moment is redacted is a
 *  separate, non-W2 task; the 'tick' branch below stays correct for when it is re-wired. */
export function redactMoment(m) {
  // A 'message' (in-canvas chat) or 'connector' (the user wired/removed an integration) moment is
  // consent by construction, not scraped page content, so it crosses the relay intact.
  if (m.trigger === 'message' || m.trigger === 'connector') return m
  // A 'tick' (W2 supervisor heartbeat) carries only OS METADATA — agent status edges, terminal exits, and
  // "surface X edited" FLAGS (the changed surface ids + a short title label) + counts — never the scraped
  // CONTENT of a surface (open/close are owned by the 'canvas' moment, not the tick). That metadata is
  // consent-safe (the user can already see their own desktop's agents/widgets via list_state), so it crosses
  // the relay intact, with the `user` labels kept and the structured `diff` (ids + change-kind + title only)
  // carried. The supervisor pulls full surface CONTENT separately via get_surface — the props snapshot is
  // deliberately NOT shipped in the tick. Mirrors the message/connector pass-through shape.
  if (m.trigger === 'tick') {
    return { seq: m.seq, ts: m.ts, surfaceId: m.surfaceId, trigger: m.trigger, windowMs: m.windowMs, signals: m.signals, user: m.user || [], ...(m.diff ? { diff: m.diff } : {}), ...(m.workspace ? { workspace: m.workspace } : {}) }
  }
  // keep the workspace stamp (v2 scoping): filtering is server-side, but the agent should still SEE
  // which workspace a moment belongs to (self-awareness + debugging), redacted or not.
  return { seq: m.seq, ts: m.ts, surfaceId: m.surfaceId, url: m.url, title: m.title, trigger: m.trigger, windowMs: m.windowMs, signals: m.signals, user: [], ...(m.workspace ? { workspace: m.workspace } : {}) }
}

/** A short human-readable line for a raw user signal (for the moment's `user` list). */
function describe(r) {
  switch (String(r.type ?? '')) {
    case 'click': {
      const txt = String(r.txt ?? '').trim()
      return `clicked ${r.tag ?? 'element'}${txt ? ` "${txt.slice(0, 40)}"` : ''}`
    }
    case 'input': {
      const val = String(r.val ?? '')
      return `typed in ${r.tag ?? 'field'}${val ? `: "${val.slice(0, 60)}"` : ''}`
    }
    case 'nav':
      return `navigated to ${String(r.url ?? '')}`
    case 'idle':
      return `paused (~${Math.round((Number(r.idleMs) || 0) / 1000)}s)`
    case 'select':
      return `highlighted: "${String(r.text ?? '').slice(0, 160)}"`
    default:
      return null
  }
}

/** Feed raw signals drained from a surface's page sensors; coalesce into moments. */
export function ingestSignals(surfaceId, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return
  const ctx = lastCtx.get(surfaceId) || {}
  let p = pending.get(surfaceId)
  for (const r of raw) {
    const type = String(r.type ?? 'event')
    // freshest known context for this surface (snapshot is decoupled from the batch)
    if (typeof r.url === 'string') ctx.url = r.url
    if (typeof r.title === 'string') ctx.title = r.title
    if (typeof r.digest === 'string' && r.digest) ctx.snapshot = r.digest
    if (!p) {
      p = { startTs: Number(r.t) || Date.now(), signals: {}, user: [], hasUser: false, significant: null }
      pending.set(surfaceId, p)
    }
    p.signals[type] = (p.signals[type] || 0) + 1
    if (USER_TYPES.has(type)) p.hasUser = true
    const line = describe(r)
    if (line) {
      if (p.user[p.user.length - 1] !== line) p.user.push(line) // drop consecutive dupes
      if (p.user.length > 8) p.user.splice(0, p.user.length - 8)
    }
    // Flush CLASSES (item 5a): nav + idle are genuine transitions → flush IMMEDIATELY. `select` is NOT —
    // a human highlighting text while reading fires a mouseup-select per phrase (measured: ~30 in 30s),
    // and flushing each one buried the agent in a firehose + rate-limited the watcher. So `select`
    // DEBOUNCES: a burst merges into ONE "looking at this" moment ~2.5s after the highlighting stops
    // (or sooner if a nav/idle flush carries it). Routine input/click still ride the ~15s batch.
    if (type === 'nav') p.significant = 'nav'
    else if (type === 'idle' && p.significant !== 'nav') p.significant = 'idle'
    else if (type === 'select') armSelectFlush(surfaceId)
  }
  lastCtx.set(surfaceId, ctx)
  if (p && p.significant) flush(surfaceId, p.significant) // nav/idle only — select rides its debounce
}

// Per-surface debounce so a run of selections collapses to one moment (5a).
const SELECT_DEBOUNCE_MS = 2500
const selectTimers = new Map()
function armSelectFlush(surfaceId) {
  const prev = selectTimers.get(surfaceId)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    selectTimers.delete(surfaceId)
    flush(surfaceId, 'select')
  }, SELECT_DEBOUNCE_MS)
  if (t.unref) t.unref()
  selectTimers.set(surfaceId, t)
}

// Telemetry/tape seam: observers see every emitted moment (the agent's eyes, recorded). MULTI-subscriber
// (telemetry AND the session tape); no-op until a host registers; must never break the emit path.
const momentTaps = []
export function setMomentTap(fn) {
  if (typeof fn === 'function') momentTaps.push(fn)
}

/** Append a finished moment to the LOG and wake every long-poll waiter (each gets the slice it may
 *  see, per visibleTo). The ONE place moments enter the stream — every emitter funnels here so the
 *  ring cap + waiter wake can never drift between emitters. */
function emit(moment) {
  for (const tap of momentTaps) {
    try {
      tap(moment)
    } catch {
      /* the tap must never break perception */
    }
  }
  if (!moment.workspace) {
    const ws = currentWorkspace()
    if (ws) moment.workspace = ws // stamp ONCE at the funnel — every emitter inherits the scoping
  }
  LOG.push(moment)
  if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX)
  // Wake ONLY the waiters that can SEE this moment — the rest keep sleeping (an invisible moment
  // must not early-resolve a pinned agent's long-poll with an empty slice).
  const keep = []
  for (const w of waiters.splice(0)) {
    if (visibleTo(moment, w.agentId, w.workspace)) {
      clearTimeout(w.timer)
      w.resolve(LOG.filter((m) => m.seq > w.since && visibleTo(m, w.agentId, w.workspace)))
    } else {
      keep.push(w)
    }
  }
  waiters.push(...keep)
}

function flush(surfaceId, trigger) {
  // any pending select-debounce is consumed by THIS flush (its selects are in the batch) — cancel it (5a)
  const st = selectTimers.get(surfaceId)
  if (st) {
    clearTimeout(st)
    selectTimers.delete(surfaceId)
  }
  const p = pending.get(surfaceId)
  if (!p) return
  pending.delete(surfaceId)
  // Content-only churn (a running clock, an animation) is context, not a reason to
  // wake the agent. Only emit a moment when the user actually did something.
  if (!p.hasUser) return
  const ctx = lastCtx.get(surfaceId) || {}
  const now = Date.now()
  emit({
    seq: ++seq,
    ts: now,
    surfaceId,
    url: ctx.url,
    title: ctx.title,
    trigger,
    windowMs: now - p.startTs,
    signals: p.signals,
    user: p.user,
    snapshot: ctx.snapshot
  })
}

// ---- canvas ops: the desktop's own geometry as perception (issues/open → the human's call:
// the brain SHOULD see window movement). Ops are COALESCED, never per-gesture: structural
// changes (open/close) settle ~2s then flush; pure move/resize rides the same ~15s batch as
// routine page input. Every op carries origin 'human' (a gesture) or 'tool' (a syscall) — the
// moment is delivered either way (accountability: the agent sees exactly what its syscalls did),
// and the operating doc tells the policy to ABSORB tool-origin ops, never re-react to itself.
// Canvas moments ride the default visibility (primary watcher only) + workspace stamping.
let canvasBatch = null
const CANVAS_SETTLE_MS = 2000
const CANVAS_MAX_OPS = 30

/** Ingest desktop-geometry ops: [{op:'open'|'close'|'move'|'resize', id, title?, kind?, x?,y?,w?,h?, origin:'human'|'tool'}] */
export function ingestCanvasOps(ops) {
  const list = Array.isArray(ops) ? ops.filter((o) => o && o.op && o.id) : []
  if (!list.length) return
  const now = Date.now()
  if (!canvasBatch) canvasBatch = { startTs: now, lastTs: now, ops: [], structural: false, dropped: 0 }
  const b = canvasBatch
  b.lastTs = now
  for (const o of list) {
    if (o.op === 'open' || o.op === 'close') b.structural = true
    if (o.op === 'move' || o.op === 'resize') {
      // a drag is ONE op: repeated geometry for the same surface keeps only the latest
      const prev = b.ops.find((p) => p.id === o.id && p.op === o.op && p.origin === o.origin)
      if (prev) {
        Object.assign(prev, o)
        continue
      }
    }
    if (b.ops.length < CANVAS_MAX_OPS) b.ops.push({ ...o })
    else b.dropped++
  }
}

function flushCanvas() {
  const b = canvasBatch
  canvasBatch = null
  if (!b || !b.ops.length) return
  const signals = {}
  const user = []
  for (const o of b.ops) {
    signals[o.op] = (signals[o.op] || 0) + 1
    const name = o.title ? `'${o.title}'` : String(o.id).slice(0, 8)
    const by = o.origin === 'tool' ? ' [agent tool]' : ''
    if (o.op === 'move') user.push(`moved ${name} to ${Math.round(o.x)},${Math.round(o.y)}${by}`)
    else if (o.op === 'resize') user.push(`resized ${name} to ${Math.round(o.w)}×${Math.round(o.h)}${by}`)
    else if (o.op === 'open') user.push(`opened ${o.kind ? o.kind + ' ' : ''}${name}${by}`)
    else user.push(`${o.op}d ${name}${by}`)
  }
  if (b.dropped) user.push(`(+${b.dropped} more ops)`)
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: 'desktop',
    trigger: 'canvas',
    windowMs: Date.now() - b.startTs,
    signals,
    user,
    ops: b.ops
  })
}

// ---- the supervisor TICK (W2, plans/blitzos-tick-diff-steer.md): a host-side heartbeat that snapshots
// the WHOLE desktop (every agent's status + every terminal's exit + every surface's geometry/props), diffs
// it against the prior tick, and emits ONE trigger:'tick' moment carrying only what MATERIALLY changed — so
// a supervisor agent ('0') is woken to decide whether to STEER a running Job. Option A is load-bearing:
// BlitzOS only ticks/diffs/emits; the AGENT owns ALL steering judgment. ZERO per-task/stuck/threshold
// heuristics live here — materiality is CONTENT-AGNOSTIC transition-shape only (a status edge, a terminal
// exit, an agent added/closed, a widget's props changed). Surface PRESENCE (open/close) and GEOMETRY
// (move/resize) are deliberately NOT material here — they already ride the trigger:'canvas' moment (which
// also routes to '0'), so the tick would otherwise DOUBLE-WAKE the supervisor on a single open/close and
// re-react to its own structural ops. A quiet desktop emits NOTHING (mirrors `if (!p.hasUser) return`): an
// immaterial diff updates the baseline and returns with no emit, so the supervisor never wakes on churn.
// The host snapshot comes from a transport-registered source (setTickSource), mirroring setWorkspaceProvider
// — perception-core never imports the IPC-bound osActions.
let tickSource = null
/** Wire the host snapshot provider. The transport (osActions/index.ts for Electron, backend.mjs for the
 *  server) calls this once at bootstrap; it returns, on demand, the world snapshot the tick diffs:
 *  { agentStatus:{id->status}, terminals:[{id,status,exitCode?}], surfaces:[{id,kind,x,y,w,h,props?}], workspace? }. */
export function setTickSource(fn) {
  tickSource = typeof fn === 'function' ? fn : null
}
function tickSnapshot() {
  try {
    return tickSource ? tickSource() || null : null
  } catch {
    return null // a broken provider must never break perception
  }
}
let lastTickSnapshot = null // the prior tick's snapshot — the diff baseline (module-level, like canvasBatch)

// Statuses for which the agent is actively producing work. A transition OUT of one of these (working ->
// waiting/stopped/error) is the steerable edge; staying in/within them (working->working, working->watching,
// ramp-up starting->working) is NOT material. *->error is always material (a failure the supervisor must see).
const TICK_WORKING = new Set(['working'])
const TICK_TERMINAL_EDGE = new Set(['waiting', 'stopped', 'error'])

/** Deep structural equality for surface `props` (a small JSON object). A changed-props surface = a widget
 *  was edited (the user-action half), which IS material. Defensive: any throw → treat as UNequal (emit), so a
 *  diff is never silently swallowed. Order-independent for objects; positional for arrays. */
function propsEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== 'object' || typeof b !== 'object') return a === b
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!propsEqual(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!propsEqual(a[k], b[k])) return false
  }
  return true
}

// ---- self-reaction echo absorb (the TIMING-ROBUST replacement for the old setTickSuppressed time window).
// A tool op the AGENT performs (update_surface / customize_widget → a surface props-edit; spawn_agent /
// close_agent → an agent-set change) IS a tick delta the kernel would otherwise read as a fresh user/agent
// signal and self-wake the supervisor on. The transport registers the affected id here at the moment it
// applies the op; the NEXT tick's diff SKIPS exactly that id (per-delta, never a whole-tick veto) so a
// CONCURRENT genuine edge (e.g. another agent going working->stopped, a terminal exit, a USER's widget edit)
// in the SAME tick still wakes. Each Set is ONE-SHOT: emitTick clears it after the diff, so the absorb is
// consumed by exactly the next tick and a LATER non-absorbed change to the same id wakes normally. This is
// timing-INDEPENDENT (it does not matter WHEN the next tick fires, vs. the old Date.now()-window which only
// suppressed when the tick happened to fall inside CANVAS_BULK_WINDOW of the op). Workspace switches/bulk
// reconciles use resetTickBaseline() (below) instead — the whole world is re-seeded, never diffed.
const tickAbsorbSurfaces = new Set()
const tickAbsorbAgents = new Set()
/** The transport just applied a tool op of ITS OWN; absorb its surface/agent deltas in the NEXT tick only
 *  (so it can't self-wake the supervisor). Per-delta + one-shot — see the block comment above. */
export function absorbTickEcho({ surfaces = [], agents = [] } = {}) {
  for (const id of surfaces) if (id != null) tickAbsorbSurfaces.add(String(id))
  for (const id of agents) if (id != null) tickAbsorbAgents.add(String(id))
}
function clearTickAbsorb() {
  tickAbsorbSurfaces.clear()
  tickAbsorbAgents.clear()
}
/** Drop the diff baseline so the NEXT emitTick re-SEEDS instead of diffing — for a BULK transaction
 *  (workspace switch / hydrate / reconcile) where the whole world changes at once and a diff would read as
 *  a storm of phantom user/agent signals. Replaces the old canvasBulkAt time-window veto for the bulk case. */
export function resetTickBaseline() {
  lastTickSnapshot = null
}

/** Diff two host snapshots into the MATERIAL deltas (content-agnostic transition-shape). Returns
 *  { material:boolean, agents:[…], terminals:[…], surfaces:[…], signals:{}, user:[…] }. An empty/immaterial
 *  diff has material:false (no emit). Surface PRESENCE (open/close) and GEOMETRY (move/resize) are NOT
 *  material here — both already ride the 'canvas' moment (which also routes to the supervisor '0'), so the
 *  tick must not double-wake on them. The ONLY surface delta the tick owns is a props-EDIT (a widget edit),
 *  which the canvas moment does not carry. A surface/agent id in the one-shot absorb Sets (a tool op the
 *  agent just made) is SKIPPED per-delta — never counted material — so it can't self-wake the supervisor. */
function diffTickSnapshot(prev, next) {
  const signals = {}
  const user = []
  const agents = [] // [{id, from, to}]
  const terminals = [] // [{id, exitCode}]
  const surfaces = [] // [{id, change:'edited', kind?, title?}] — props-edit only (open/close own'd by 'canvas')
  const bump = (k) => { signals[k] = (signals[k] || 0) + 1 }

  // --- agent status edges (the agent-state half) ---
  const prevStatus = (prev && prev.agentStatus) || {}
  const nextStatus = (next && next.agentStatus) || {}
  for (const id of new Set([...Object.keys(prevStatus), ...Object.keys(nextStatus)])) {
    const from = prevStatus[id]
    const to = nextStatus[id]
    if (from === to) continue
    // an agent APPEARING (no prior status) or DISAPPEARING is itself material (added/closed agent) — UNLESS
    // it is the agent set-change of a tool op the agent just made (spawn_agent/close_agent), in which case
    // the transport absorbed that id for this one tick (a status EDGE below is never absorbed, only add/close).
    if (from == null) { if (!tickAbsorbAgents.has(id)) { agents.push({ id, from: null, to }); user.push(`agent ${id} started (${to})`); bump('agent_added') } continue }
    if (to == null) { if (!tickAbsorbAgents.has(id)) { agents.push({ id, from, to: null }); user.push(`agent ${id} closed`); bump('agent_closed') } continue }
    // a STATUS edge is material only for working -> {waiting,stopped,error} or *-> error. working->working,
    // working->watching, and ramp-up (starting->working) are NOT material (no steerable transition).
    const material = (TICK_WORKING.has(from) && TICK_TERMINAL_EDGE.has(to)) || to === 'error'
    if (material) { agents.push({ id, from, to }); user.push(`agent ${id}: ${from} -> ${to}`); bump('agent_status') }
  }

  // --- terminal exits (a new exitCode = a process ended) ---
  const prevTerm = new Map(((prev && prev.terminals) || []).map((t) => [String(t.id), t]))
  const nextTerm = new Map(((next && next.terminals) || []).map((t) => [String(t.id), t]))
  for (const [id, t] of nextTerm) {
    const p = prevTerm.get(id)
    const code = t && t.exitCode
    const hadCode = p && p.exitCode != null
    if (code != null && !hadCode) { terminals.push({ id, exitCode: code }); user.push(`terminal ${id} exited (code ${code})`); bump('terminal_exit') }
  }

  // --- surfaces: ONLY a props-EDIT (a widget was edited — the user-action half). Surface PRESENCE
  // (open/close) and GEOMETRY (move/resize) are intentionally NOT diffed here: the trigger:'canvas'
  // moment already owns ALL structural surface changes (open/close/move/resize) and already routes to
  // the supervisor '0', so diffing presence here would DOUBLE-WAKE the supervisor on one open/close (and
  // re-react to the supervisor's own open/close). The tick keeps only the props delta the canvas moment
  // does NOT carry. A surface that appears/disappears between ticks therefore contributes no tick delta. */
  const prevSurf = new Map(((prev && prev.surfaces) || []).map((s) => [String(s.id), s]))
  const nextSurf = new Map(((next && next.surfaces) || []).map((s) => [String(s.id), s]))
  for (const [id, s] of nextSurf) {
    const p = prevSurf.get(id)
    if (!p) continue // a surface OPEN is owned by the canvas moment — not a tick delta (no double-wake)
    // Absorb the props-edit of a tool op the agent just made (update_surface / customize_widget): the
    // transport registered this id for this one tick, so it does not self-wake the supervisor. A USER's
    // widget edit arrives via the renderer push (NOT a tool op), is never absorbed, and STILL wakes.
    if (tickAbsorbSurfaces.has(id)) continue
    if (!propsEqual(p.props, s.props)) { surfaces.push({ id, change: 'edited', kind: s.kind, title: s.title }); user.push(`surface edited: ${s.title || id}`); bump('surface_edited') }
  }
  // a surface CLOSE is likewise owned by the canvas moment — not diffed here (no double-wake / self-react).

  const material = agents.length > 0 || terminals.length > 0 || surfaces.length > 0
  return { material, agents, terminals, surfaces, signals, user }
}

// (The old setTickSuppressed predicate — a Date.now()-vs-CANVAS_BULK_WINDOW veto on the WHOLE tick — was
// removed: it only suppressed when the next tick happened to fall inside a few seconds of the op, so with a
// ~10s tick cadence a lone tool op landed in the unsuppressed window most of the time and self-woke the
// supervisor. The timing-robust replacement is the per-delta absorbTickEcho Sets (tool ops) +
// resetTickBaseline (bulk transactions) above — both timing-INDEPENDENT.)

/** Heartbeat: snapshot the host world, diff against the prior tick, and emit ONE trigger:'tick' moment IF
 *  (and only if) the diff is MATERIAL. Driven from the sweepTimer at a TICK_MS sub-cadence — never its own
 *  always-on interval. Funnels through emit() so it inherits the ring cap + waiter wake + workspace stamp;
 *  surfaceId 'desktop' + no agentId ⇒ visibleTo() routes it to the primary supervisor '0'. The one-shot
 *  absorb Sets (a tool op the agent just made) are CLEARED here after the diff — consumed by exactly this
 *  one tick, never leaking to the next (a later non-absorbed change to the same id then wakes normally). */
export function emitTick() {
  const snap = tickSnapshot()
  if (!snap) return // no provider wired yet (boot) — nothing to diff
  // First tick after boot/switch (incl. after resetTickBaseline on a bulk transaction): seed the baseline,
  // never emit (the whole world would read as "new"). A pending absorb is moot once re-seeded — clear it so
  // it can never leak past this tick either.
  if (!lastTickSnapshot) { lastTickSnapshot = snap; clearTickAbsorb(); return }
  const diff = diffTickSnapshot(lastTickSnapshot, snap)
  clearTickAbsorb() // one-shot: an absorb is consumed by exactly THIS tick's diff, whether material or not
  // Advance the baseline regardless (a material AND an immaterial diff both settle the world), so the next
  // tick diffs against now — exactly the `if (!p.hasUser) return` discipline (update + return, no wake).
  lastTickSnapshot = snap
  if (!diff.material) return // quiet desktop — never wake the supervisor
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: 'desktop',
    trigger: 'tick',
    windowMs: 0,
    signals: diff.signals,
    user: diff.user,
    diff: { agents: diff.agents, terminals: diff.terminals, surfaces: diff.surfaces },
    ...(snap.workspace ? { workspace: String(snap.workspace) } : {})
  })
}

// Drive the tick from the EXISTING sweepTimer at a coarser sub-cadence (no second always-on interval).
const TICK_MS = Math.max(2000, Number(process.env.BLITZ_TICK_MS) || 10000)
let lastTickAt = 0

// Batch timer: emit a moment for any surface whose window has aged past BATCH_MS
// (significant transitions flush sooner, via ingestSignals).
const sweepTimer = setInterval(() => {
  const now = Date.now()
  for (const [surfaceId, p] of pending) {
    if (now - p.startTs >= BATCH_MS) flush(surfaceId, 'batch')
  }
  // canvas: flush once ops stop arriving (settle) — immediately for structural batches,
  // at the routine batch age for pure move/resize churn.
  if (canvasBatch && now - canvasBatch.lastTs >= CANVAS_SETTLE_MS && (canvasBatch.structural || now - canvasBatch.startTs >= BATCH_MS)) {
    flushCanvas()
  }
  // supervisor tick: at the TICK_MS sub-cadence, snapshot+diff+(maybe)emit. Gated by elapsed time, not a
  // separate interval, so it shares the sweeper's unref'd lifecycle (a quiet node test still exits cleanly).
  if (now - lastTickAt >= TICK_MS) {
    lastTickAt = now
    emitTick()
  }
}, 2000)
// A background sweeper must never keep the PROCESS alive — node test scripts that import this
// module (e.g. test-perception-scope) hang at exit otherwise. Unref'd timers still fire normally
// while anything else is running.
if (sweepTimer.unref) sweepTimer.unref()

export function latestSeq() {
  return seq
}

/**
 * A srcdoc surface (agent-authored UI) fired an action back to the agent (e.g. an
 * "approve" click). Emitted into the SAME moment stream so /events delivers it and
 * the watching agent is woken to act.
 */
export function emitSurfaceAction(surfaceId, action) {
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId,
    // route this action to the agent it targets (action-items carry the requesting agent's id);
    // generic surface actions have none → '0' (the primary watcher), preserving prior behavior.
    agentId: String((action && action.agentId) || '0'),
    trigger: 'action',
    windowMs: 0,
    signals: { action: 1 },
    user: ['UI action: ' + JSON.stringify(action).slice(0, 180)],
    action
  })
}

/**
 * The user typed a message to the agent in the in-canvas Chat. Injected into the SAME
 * moment stream (trigger 'message') so a watching agent is woken and reads it — a
 * direct message ALWAYS warrants a response (unlike passive activity moments). Not
 * redacted over the relay (the user authored it for the agent).
 */
export function emitUserMessage(text, agentId = '0') {
  const msg = String(text || '').slice(0, 2000)
  const sid = String(agentId || '0')
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: sid === '0' ? 'chat' : `chat-${sid}`,
    agentId: sid, // routes this message to ONLY this agent (visibleTo)
    trigger: 'message',
    windowMs: 0,
    signals: { message: 1 },
    user: [`user message: "${msg.slice(0, 400)}"`],
    message: msg
  })
}

/** A connector (integration) was wired up or removed — wake the agent so it learns live. Like a chat
 *  message this is consent-by-construction (the user clicked connect), so it crosses the relay intact. */
export function emitConnectorChange(provider, connected) {
  const name = String(provider || 'a connector')
  const verb = connected ? 'connected' : 'disconnected'
  emit({ seq: ++seq, ts: Date.now(), surfaceId: 'system', trigger: 'connector', windowMs: 0, signals: { connector: 1 }, user: [`connector ${verb}: ${name}`] })
}

/** The human placed a spatial ANNOTATION on a surface and asked the agent about that exact spot (item
 *  5b). A direct, surface-anchored question — ALWAYS warrants a response (like a chat message), carrying
 *  the surface id + the point (xPct/yPct) + a snapshot, so the agent can answer about precisely what the
 *  human pointed at. Consent-by-construction (the human authored it for the agent) → crosses the relay. */
export function emitAnnotation(surfaceId, text, anchor, snapshot) {
  const msg = String(text || '').slice(0, 2000)
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: String(surfaceId || ''),
    trigger: 'annotation',
    windowMs: 0,
    signals: { annotation: 1 },
    user: [`annotated this surface: "${msg.slice(0, 200)}"`],
    message: msg,
    anchor: anchor && typeof anchor === 'object' ? { xPct: Number(anchor.xPct) || 0, yPct: Number(anchor.yPct) || 0 } : undefined,
    snapshot: snapshot ? String(snapshot).slice(0, 600) : undefined
  })
}

/** An OS-level event both inhabitants should know about — today a crash recovery; later an update,
 *  a restore, a relay re-mint. Content-agnostic: BlitzOS reports WHAT happened, the agent decides
 *  significance. Routed like connector moments (the primary watcher); `say`/chat.md carries it to
 *  the human and into every brain's boot memory. */
export function emitSystemMoment(kind, line, detail) {
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: 'system',
    trigger: 'system',
    windowMs: 0,
    signals: { system: 1 },
    user: [String(line || kind || 'system event')],
    system: { kind: String(kind || 'event'), ...(detail && typeof detail === 'object' ? detail : {}) }
  })
}

/** Long-poll for an agent: resolve immediately if there are moments visible to `agentId` after
 *  `since`, else wait up to maxMs. Each agent only sees its own messages (+ activity for the primary).
 *  `workspace` (optional) pins the waiter: it then sees ONLY that workspace's moments. */
export function waitForEvents(since, maxMs, agentId = '0', workspace = null) {
  const have = LOG.filter((m) => m.seq > since && visibleTo(m, agentId, workspace))
  if (have.length > 0 || maxMs <= 0) return Promise.resolve(have)
  return new Promise((resolve) => {
    const w = {
      since,
      agentId,
      workspace,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        resolve(LOG.filter((m) => m.seq > since && visibleTo(m, agentId, workspace)))
      }, maxMs)
    }
    waiters.push(w)
  })
}

// ---- in-page SENSORS, injected into every web surface (Electron via
// webContents.executeJavaScript; server via CDP Runtime.evaluate). Beyond input
// (key/click/input/pointerdown — pointerdown so DRAG interactions like chess moves
// count as activity even with no click) we sense navigation, content change (a
// MutationObserver: async loads + DOM updates), and idle-after-activity. Each signal
// carries a `digest` (text snapshot) where useful. Idempotent per page (re-injectable
// after navigation); self-cleans when drained by a gone surface.
//
// NOTE on navigation: the in-page href poll below only ever catches SAME-document (SPA)
// route changes — a CROSS-document navigation destroys the page (and its undrained signal
// buffer) before the poll/drain can run, and the sensor re-injected on the new page boots
// with lastHref already at the new URL. Hard navs are therefore emitted HOST-side into the
// same coalescer by each runtime: Electron from `did-navigate` (osActions.ts
// ensureNavEmitter), server from `Page.frameNavigated` (browser-host.mjs onNavigated).
export const INJECT = `(() => {
  if (window.__blitzCap) return 'present';
  window.__blitzCap = true;
  window.__blitzEvents = [];
  let lastAct = Date.now(), idleSent = true, lastHref = location.href, mt = null;
  const push = (o) => { try { o.url = location.href; o.t = Date.now(); window.__blitzEvents.push(o); if (window.__blitzEvents.length > 300) window.__blitzEvents.splice(0, 150); } catch (e) {} };
  const digest = () => { try { const m = document.querySelector('main') || document.body; return ((m && m.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 600); } catch (e) { return ''; } };
  const act = () => { lastAct = Date.now(); idleSent = false; };
  addEventListener('keydown', (e) => { act(); push({ type: 'key', key: e.key, meta: (e.metaKey || e.ctrlKey) || undefined }); }, true);
  addEventListener('click', (e) => { act(); const t = e.target; push({ type: 'click', tag: t && t.tagName, txt: ((t && t.innerText) || '').trim().slice(0, 40) }); }, true);
  addEventListener('input', (e) => { act(); const t = e.target; const secret = t && (t.type === 'password' || t.autocomplete === 'one-time-code' || t.autocomplete === 'current-password' || t.autocomplete === 'new-password'); push({ type: 'input', tag: t && t.tagName, val: secret ? '' : ((t && t.value) || '').slice(0, 80) }); }, true);
  addEventListener('pointerdown', (e) => { act(); push({ type: 'pointer', tag: e.target && e.target.tagName, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0) }); }, true);
  // text selection: the human highlighting a passage is a deliberate "look at this" gesture
  addEventListener('mouseup', () => { try { const s = String((window.getSelection && getSelection()) || '').replace(/\\s+/g, ' ').trim(); if (s.length > 2) { act(); push({ type: 'select', text: s.slice(0, 500) }); } } catch (e) {} }, true);
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; push({ type: 'nav', title: document.title, digest: digest() }); } }, 600);
  try { new MutationObserver(() => { if (mt) return; mt = setTimeout(() => { mt = null; push({ type: 'content', title: document.title, digest: digest() }); }, 1200); }).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  setInterval(() => { if (!idleSent && Date.now() - lastAct > 5000) { idleSent = true; push({ type: 'idle', idleMs: Date.now() - lastAct, title: document.title, digest: digest() }); } }, 1500);
  push({ type: 'content', title: document.title, digest: digest() }); // baseline snapshot
  return 'installed';
})()`
export const DRAIN = `(window.__blitzEvents && window.__blitzEvents.splice(0)) || []`
