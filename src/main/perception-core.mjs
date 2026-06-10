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

// Per-session visibility (brain-as-session): a chat 'message' moment is PRIVATE to its session, so each
// session's agent only sees + answers ITS chat. All OTHER (activity/canvas) moments go to the PRIMARY
// session ('0') only — the desktop-watcher — so spawning N chat agents doesn't wake them all on canvas
// churn. seq stays a single global counter, so an agent's `since` cursor advances past filtered moments.
function visibleTo(moment, sessionId) {
  const sid = String(sessionId || '0')
  // A chat 'message' and an 'action' (e.g. an action-item the human resolved) are PRIVATE to the session
  // they target — only that session's agent is woken. So a non-primary session that called request_action
  // is woken when ITS item is resolved (the moment carries sessionId; generic surface actions default to '0').
  if (moment.trigger === 'message' || moment.trigger === 'action') return String(moment.sessionId || '0') === sid
  return sid === '0'
}

// ---- perception content consent (P0: the untrusted relay must not receive the
// CONTENT of a logged-in surface unless the human shared it). The localhost-trusted
// path (and the in-process resident brain) are never redacted. Default: not shared.
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
 *  (surface identity + activity counts; url/title are already exposed via list_state). */
export function redactMoment(m) {
  // A 'message' (in-canvas chat) or 'connector' (the user wired/removed an integration) moment is
  // consent by construction, not scraped page content, so it crosses the relay intact.
  if (m.trigger === 'message' || m.trigger === 'connector') return m
  return { seq: m.seq, ts: m.ts, surfaceId: m.surfaceId, url: m.url, title: m.title, trigger: m.trigger, windowMs: m.windowMs, signals: m.signals, user: [] }
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
    if (type === 'nav') p.significant = 'nav'
    else if (type === 'select' && p.significant !== 'nav') p.significant = 'select'
    else if (type === 'idle' && p.significant !== 'nav' && p.significant !== 'select') p.significant = 'idle'
  }
  lastCtx.set(surfaceId, ctx)
  if (p && p.significant) flush(surfaceId, p.significant)
}

/** Append a finished moment to the LOG and wake every long-poll waiter (each gets the slice it may
 *  see, per visibleTo). The ONE place moments enter the stream — every emitter funnels here so the
 *  ring cap + waiter wake can never drift between emitters. */
function emit(moment) {
  LOG.push(moment)
  if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX)
  for (const w of waiters.splice(0)) {
    clearTimeout(w.timer)
    w.resolve(LOG.filter((m) => m.seq > w.since && visibleTo(m, w.sessionId)))
  }
}

function flush(surfaceId, trigger) {
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

// Batch timer: emit a moment for any surface whose window has aged past BATCH_MS
// (significant transitions flush sooner, via ingestSignals).
setInterval(() => {
  const now = Date.now()
  for (const [surfaceId, p] of pending) {
    if (now - p.startTs >= BATCH_MS) flush(surfaceId, 'batch')
  }
}, 2000)

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
    // route this action to the session it targets (action-items carry the requesting session's id);
    // generic surface actions have none → '0' (the primary watcher), preserving prior behavior.
    sessionId: String((action && action.sessionId) || '0'),
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
export function emitUserMessage(text, sessionId = '0') {
  const msg = String(text || '').slice(0, 2000)
  const sid = String(sessionId || '0')
  emit({
    seq: ++seq,
    ts: Date.now(),
    surfaceId: sid === '0' ? 'chat' : `chat-${sid}`,
    sessionId: sid, // routes this message to ONLY this session's agent (visibleTo)
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

/** Long-poll for a session: resolve immediately if there are moments visible to `sessionId` after
 *  `since`, else wait up to maxMs. Each session only sees its own messages (+ activity for the primary). */
export function waitForEvents(since, maxMs, sessionId = '0') {
  const have = LOG.filter((m) => m.seq > since && visibleTo(m, sessionId))
  if (have.length > 0 || maxMs <= 0) return Promise.resolve(have)
  return new Promise((resolve) => {
    const w = {
      since,
      sessionId,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        resolve(LOG.filter((m) => m.seq > since && visibleTo(m, sessionId)))
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
  addEventListener('input', (e) => { act(); const t = e.target; push({ type: 'input', tag: t && t.tagName, val: ((t && t.value) || '').slice(0, 80) }); }, true);
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
