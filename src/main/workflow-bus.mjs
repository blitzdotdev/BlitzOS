// workflow-bus.mjs — the per-run event buffer + fan-out for live workflow externalization.
//
// A blitzscript workflow run in-process (workflow-host.mjs) emits WfEvents through the runtime's progress
// sink; the host installs ONE sink that calls publish(ev) here. Each run gets a buffer keyed by ev.runId.
// A widget subscribes by runId and is replayed the full backlog FIRST, then live events — so the view is
// event-sourced: it reconstructs identical state no matter WHEN it mounts (the generic widget at t=0, or an
// enriched widget swapped in mid-run). Events with no runId (off-host / nested workflows) are ignored.
//
// Pure: no Electron/Node-special deps beyond a clock, so it is headless-testable.

const _runs = new Map() // runId -> { events: WfEvent[], subs: Set<fn>, seq: number, done: boolean }
const MAX_EVENTS = 6000  // cap a runaway run's retained backlog (seq keeps counting past it)

export function ensureRun(runId) {
  if (runId == null) return null
  const key = String(runId)
  let r = _runs.get(key)
  if (!r) { r = { events: [], subs: new Set(), seq: 0, done: false }; _runs.set(key, r) }
  return r
}

/** Publish one WfEvent (must carry ev.runId). Stamps a monotonic seq + wall-clock ts, buffers, fans out. */
export function publish(ev) {
  if (!ev || ev.runId == null) return null // off-host / nested-workflow events have no run to route to
  const r = ensureRun(ev.runId)
  const stamped = { seq: r.seq++, ts: Date.now(), ...ev }
  // Always retain the terminal run:done even past the cap — it is the one event the reducer needs to mark a
  // replayed (late-subscriber or disk-hydrated) board 'done'. Without this a >MAX_EVENTS run would persist an
  // events.jsonl with no run:done and reload as perpetually 'running'.
  if (r.events.length < MAX_EVENTS || stamped.type === 'run:done') r.events.push(stamped)
  if (stamped.type === 'run:done') r.done = true
  for (const cb of r.subs) { try { cb(stamped) } catch { /* a bad subscriber must never break the run */ } }
  return stamped
}

/** Seed a COLD run's buffer from its persisted event stream (wf-store.readEventsLog) so a later subscribe
 *  replays the disk events and the board renders an identical frozen view. No-op if the run is already
 *  live/hydrated (events present) — never double-seeds. Does NOT fan out (no live subscribers yet); preserves
 *  the original `seq`/`ts` stamped at write time so a future live+disk overlap still de-dupes by seq. */
export function hydrate(runId, events) {
  if (runId == null || !Array.isArray(events) || !events.length) return false
  const r = ensureRun(runId)
  if (r.events.length) return false // already live or hydrated — don't double-seed
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    r.events.push(ev)
    if (typeof ev.seq === 'number' && ev.seq >= r.seq) r.seq = ev.seq + 1 // keep seq monotonic past the disk max
    if (ev.type === 'run:done') r.done = true
  }
  return true
}

/** How many live subscribers a run has (0 if unknown). The memory-eviction sweep uses this to avoid clearing a
 *  run whose board is currently mounted + watching. */
export function subCount(runId) {
  const r = runId == null ? null : _runs.get(String(runId))
  return r ? r.subs.size : 0
}

/** Subscribe to a run: REPLAY the buffered backlog synchronously, then receive live events. Returns unsubscribe. */
export function subscribe(runId, cb) {
  if (runId == null || typeof cb !== 'function') return () => {}
  const r = ensureRun(runId)
  for (const ev of r.events) { try { cb(ev) } catch { /* ignore */ } }
  r.subs.add(cb)
  return () => { r.subs.delete(cb) }
}

/** The current backlog for a run (a copy), or [] if unknown. */
export function snapshot(runId) {
  const r = runId == null ? null : _runs.get(String(runId))
  return r ? r.events.slice() : []
}

export function isDone(runId) {
  const r = runId == null ? null : _runs.get(String(runId))
  return !!(r && r.done)
}

/** Drop a run's buffer (call after the agent has consumed the result; the widget keeps its own state). */
export function clearRun(runId) { if (runId != null) _runs.delete(String(runId)) }

/** Test/debug: number of live runs. */
export function _runCount() { return _runs.size }
