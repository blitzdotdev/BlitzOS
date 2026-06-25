// blitzscript — progress.mjs: the workflow EVENT sink + the fan-out group context.
//
// The runtime (runtime.mjs: run/phase/group lifecycle) and the leaf (agent.mjs: agent:start/done)
// emit SEMANTIC workflow events through emitProgress(); a host installs ONE sink (setProgressSink)
// that routes each event by ev.runId into a per-run buffer (src/main/workflow-bus.mjs). This lives in
// its own module so BOTH agent.mjs and runtime.mjs import it with NO circular dependency — progress.mjs
// imports nothing from them.
//
// Events are TELEMETRY, never journaled, so stamping/timing here is fine even though the workflow BODY
// bans Date.now (this module runs in the runtime layer, not the shadowed body scope). We carry the
// semantic fields + runId; the host bus assigns the monotonic seq + wall-clock ts on publish.
//
// Event shapes (see plans/blitzos-workflow-externalization.md "Event schema"):
//   { type:'run:start',   runId, name, description }
//   { type:'phase',       phaseId, title }
//   { type:'group:start', groupId, kind:'parallel'|'pipeline', phaseId?, size }
//   { type:'group:done',  groupId, ok, failed }
//   { type:'agent:start', nodeId, label?, phaseId?, groupId?, index?, model?, harness }
//   { type:'agent:done',  nodeId, status:'ok'|'error'|'null', ms, tokens?, preview?, message? }
//   { type:'log',         phaseId?, groupId?, message }
//   { type:'error',       nodeId?, message }
//   { type:'run:done',    ok, ms, calls, tokens, preview }

import { AsyncLocalStorage } from 'node:async_hooks'

// Default sink: mirror phase/log to stderr so `blitz run` in a terminal stays readable. A host overrides.
function _defaultSink(ev) {
  if (!ev) return
  if (ev.type === 'log') process.stderr.write(`[blitz] ${ev.message}\n`)
  else if (ev.type === 'phase') process.stderr.write(`[blitz] === ${ev.title} ===\n`)
}
let _sink = _defaultSink
export function setProgressSink(fn) { _sink = typeof fn === 'function' ? fn : _defaultSink }

/** Emit one semantic event, stamped with the active run's runId (from ctx). A sink must never throw. */
export function emitProgress(ctx, ev) {
  if (!ev) return
  try { _sink({ runId: ctx && ctx.runId != null ? ctx.runId : null, ...ev }) } catch { /* a sink must never break a workflow */ }
}

/** A short, single-line preview of any value for the agent:done / run:done event. */
export function previewOf(v, max = 280) {
  let s
  if (v == null) s = ''
  else if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v) } catch { s = String(v) } }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// ── group context (parallel/pipeline fan-out) — threaded via ALS so each agent() leaf learns its group ──
// A SEPARATE AsyncLocalStorage from the RunContext store, so both coexist: a leaf reads currentGroup()
// for its fan-out id without the parallel/pipeline wrapper having to mutate a shared ctx field per-thunk.
const _groupStore = new AsyncLocalStorage()
export function withGroup(groupId, fn) { return _groupStore.run(groupId, fn) }
export function currentGroup() { const g = _groupStore.getStore(); return g === undefined ? null : g }
