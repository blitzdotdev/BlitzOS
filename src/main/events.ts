// The user's live activity, coalesced into batched "moments" an agent watches.
//
// BlitzOS is the PRODUCER: in-page sensors (see osActions INJECT) feed raw signals
// here via ingestSignals(); this module coalesces them into framed snapshots
// ("moments") and pushes them to a long-polling agent over /events. This is the
// SCHEDULER half of "BlitzOS as an OS for an agent": perception in, woken turns out.
//
// Why moments, not a raw keystroke firehose: an autonomous agent should be WOKEN on
// meaningful change with enough context to act. So we
//   - batch routine activity (typing/clicking) on a ~15s cadence, and
//   - flush IMMEDIATELY on a significant transition: a navigation, or the user going
//     idle after activity (the general "they paused, good moment to react").
// Each moment carries a snapshot (a text digest of the surface) so the agent can
// usually react without a second read. Perception is content-agnostic (dumb but
// rich); the AGENT decides what's significant and what to do, so this generalizes
// to any task, not just the one we built it for.

export interface BlitzMoment {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  trigger: 'batch' | 'nav' | 'idle'
  windowMs: number
  signals: Record<string, number>
  user: string[]
  snapshot?: string
}

// Routine activity rides at most this long before a moment is emitted; significant
// transitions (nav/idle) flush sooner. Tuneable; the agent can still no-op a moment.
const BATCH_MS = 15000

interface Pending {
  startTs: number
  signals: Record<string, number>
  user: string[]
  hasUser: boolean
  significant: null | 'nav' | 'idle'
}

interface Ctx {
  url?: string
  title?: string
  snapshot?: string
}

// Signals that represent the USER doing something (vs. background page churn).
// Only these wake the agent; content-only mutation just refreshes the snapshot.
const USER_TYPES = new Set(['key', 'click', 'input', 'nav', 'idle'])

const pending = new Map<string, Pending>()
const lastCtx = new Map<string, Ctx>()
const LOG: BlitzMoment[] = []
let seq = 0
const MAX = 1000

interface Waiter {
  since: number
  resolve: (m: BlitzMoment[]) => void
  timer: ReturnType<typeof setTimeout>
}
const waiters: Waiter[] = []

/** A short human-readable line for a raw user signal (for the moment's `user` list). */
function describe(r: Record<string, unknown>): string | null {
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
    default:
      return null
  }
}

/** Feed raw signals drained from a surface's page sensors; coalesce into moments. */
export function ingestSignals(surfaceId: string, raw: Array<Record<string, unknown>>): void {
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
    else if (type === 'idle' && p.significant !== 'nav') p.significant = 'idle'
  }
  lastCtx.set(surfaceId, ctx)
  if (p && p.significant) flush(surfaceId, p.significant)
}

function flush(surfaceId: string, trigger: 'batch' | 'nav' | 'idle'): void {
  const p = pending.get(surfaceId)
  if (!p) return
  pending.delete(surfaceId)
  // Content-only churn (a running clock, an animation) is context, not a reason to
  // wake the agent. Only emit a moment when the user actually did something.
  if (!p.hasUser) return
  const ctx = lastCtx.get(surfaceId) || {}
  const now = Date.now()
  const moment: BlitzMoment = {
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
  }
  LOG.push(moment)
  if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX)
  for (const w of waiters.splice(0)) {
    clearTimeout(w.timer)
    w.resolve(LOG.filter((m) => m.seq > w.since))
  }
}

// Batch timer: emit a moment for any surface whose window has aged past BATCH_MS
// (significant transitions flush sooner, via ingestSignals).
setInterval(() => {
  const now = Date.now()
  for (const [surfaceId, p] of pending) {
    if (now - p.startTs >= BATCH_MS) flush(surfaceId, 'batch')
  }
}, 2000)

export function latestSeq(): number {
  return seq
}

/** Long-poll: resolve immediately if there are moments after `since`, else wait up to maxMs. */
export function waitForEvents(since: number, maxMs: number): Promise<BlitzMoment[]> {
  const have = LOG.filter((m) => m.seq > since)
  if (have.length > 0 || maxMs <= 0) return Promise.resolve(have)
  return new Promise((resolve) => {
    const w: Waiter = {
      since,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        resolve(LOG.filter((m) => m.seq > since))
      }, maxMs)
    }
    waiters.push(w)
  })
}
