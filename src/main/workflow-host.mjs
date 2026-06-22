// workflow-host.mjs — run a blitzscript workflow IN-PROCESS so its live events reach the canvas.
//
// The orchestrator's `run_workflow` tool resolves a generic live widget onto home (in os-tools.mjs), then
// calls runWorkflowHosted(). We install ONE global progress sink (routing every WfEvent by runId into
// workflow-bus.mjs), start the workflow in the BACKGROUND (so the agent gets a runId immediately and the
// HTTP/relay call never blocks on a multi-minute run), and kick off the fresh enrichment agent in parallel.
// The widget subscribes to the bus by runId and renders the run live; result.json lands in the run's memDir.
//
// DI seam (wireWorkflowHost), like wireJobModel/wireLauncher: Electron injects the workspace path + the
// enrichment spawner from index.ts, so this module stays free of Electron imports and is headless-testable.

import { mkdirSync, existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { ensureRun, subscribe, snapshot, isDone } from './workflow-bus.mjs'
import * as bus from './workflow-bus.mjs'
import { writeEventsLog, writeSkeleton } from './wf-store.mjs'

let _deps = null
/** deps: { getWorkspacePath():string, spawnEnrichment?(info):void, broadcast?(action):void, onRunComplete?(info):void } */
export function wireWorkflowHost(deps) { _deps = deps || null }

let _runtimePromise = null
function loadRuntime() { return _runtimePromise || (_runtimePromise = import('./blitzscript/runtime.mjs')) }

// Install the ONE global sink exactly once: every WfEvent (already stamped with runId by the runtime) is
// routed by runId into the bus. Concurrent runs share this single sink; the bus demuxes by runId.
let _sinkInstalled = false
async function ensureSink() {
  if (_sinkInstalled) return
  const rt = await loadRuntime()
  rt.setProgressSink((ev) => { try { bus.publish(ev) } catch { /* never break a run */ } })
  _sinkInstalled = true
}

let _seq = 0
export function mintRunId() {
  // unique + sortable; Date.now is host-side (NOT the shadowed workflow body), so it's allowed here.
  return 'wf_' + Date.now().toString(36) + (_seq++).toString(36)
}

/** The on-disk memory dir for a run (journal.jsonl + result.json), under the active workspace. */
export function workflowMemDir(runId) {
  const ws = _deps && typeof _deps.getWorkspacePath === 'function' ? _deps.getWorkspacePath() : null
  return ws ? join(ws, '.blitzos', 'workflows', String(runId)) : null
}

/**
 * Start a hosted workflow run. Returns quickly (after the run STARTS) with { ok, runId, surfaceId };
 * the run itself completes in the background and writes result.json to its memDir.
 */
export async function runWorkflowHosted({ file, args, runId, surfaceId = null, view = 'graph', agentId = '0', dry = false } = {}) {
  if (!file) return { ok: false, error: 'run_workflow: file (a workflow .js path) is required' }
  // The agent authors workflow files relative to ITS workspace cwd (e.g. ".blitzos/blitzscripts/x.js"), but this
  // host runs in the MAIN process whose cwd is the app dir — so a relative `file` would resolve there and the
  // runtime's readFileSync would ENOENT *before* emitting any event (an empty run dir, a board that never fills).
  // Resolve a relative file against the active workspace, and FAIL FAST with a clear error (so the agent learns
  // the path is wrong instead of getting ok:true for a doomed background run).
  const wsPath = _deps && typeof _deps.getWorkspacePath === 'function' ? _deps.getWorkspacePath() : null
  file = !isAbsolute(file) && wsPath ? join(wsPath, file) : file
  if (!existsSync(file)) return { ok: false, error: `run_workflow: workflow file not found: ${file}` }
  const id = runId || mintRunId()
  await ensureSink()
  ensureRun(id) // make the buffer up front so a widget that subscribes before the first emit still attaches

  const memDir = workflowMemDir(id)
  if (memDir) { try { mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ } }

  // Kick off the fresh enrichment agent in parallel (best-effort; the generic widget already shows live).
  if (surfaceId && _deps && typeof _deps.spawnEnrichment === 'function') {
    try { _deps.spawnEnrichment({ runId: id, surfaceId, file, view, agentId, memDir }) } catch { /* never block the run */ }
  }

  const broadcast = _deps && typeof _deps.broadcast === 'function' ? _deps.broadcast : null
  const aid = String(agentId ?? '0')
  // Announce START immediately with an empty skeleton so the board mounts + the live run kicks off with NO
  // delay. The dry preflight (TODO cards) runs IN PARALLEL and re-broadcasts `started` with the skeleton once
  // it resolves; the board re-renders with TODO cards when it lands. This avoids blocking the real run on the
  // preflight (the prior version awaited the preflight before starting the run, stalling every run by up to 8s).
  try { broadcast({ type: 'workflow-run', agentId: aid, runId: id, file, started: true, skeleton: [], memDir }) } catch { /* best-effort */ }

  // Run in the BACKGROUND. The global sink streams events to the bus -> the subscribed widget; the runtime
  // writes result.json on completion. We do NOT await it (a workflow can run for minutes).
  // Persist the run's full WfEvent buffer to <memDir>/events.jsonl when it SETTLES (run:done has been published
  // to the bus by the time runWorkflow resolves). This is the durable source the board re-hydrates from after the
  // bus drops the run (memory eviction) or a relaunch — the SAME reducer renders an identical frozen board.
  // TODO(kanban-persistence): snapshot(id) is the BUS buffer, capped at MAX_EVENTS (6000) with only run:done kept
  // past the cap. A run that emits >6000 events (a massively-parallel fan-out) therefore persists a TRUNCATED
  // stream — on reload the frozen board is missing the dropped middle agent:done cards (live was complete). Fix
  // when it bites: append events to events.jsonl as they arrive (uncapped on disk) instead of one capped snapshot.
  const persistEvents = () => { try { if (memDir) writeEventsLog(memDir, snapshot(id)) } catch { /* best-effort */ } }
  // The run's final rolled-up stats live on the run:done event ({ms,calls,tokens}); carry them on the `done`
  // broadcast so the durable run record (index.json) holds them and a COLLAPSED board pill can show
  // "{ms} · {calls} agents · {tokens} tok" straight from the cheap record — no board mount/replay needed.
  const finalStats = () => { try { const rd = snapshot(id).find((e) => e && e.type === 'run:done'); return rd ? { ms: Number(rd.ms) || 0, calls: Number(rd.calls) || 0, tokens: Number(rd.tokens) || 0 } : null } catch { return null } }
  // WAKE the launching agent via /events on completion (bugs 2+3), right beside persistEvents so the durable
  // artifact and the wake are ONE seam. Injected (onRunComplete) so this module stays perception-free; index.ts
  // turns it into an agent-private 'workflow' moment. By the time this fires, result.json is on disk (the runtime
  // writes it before runWorkflow resolves) AND events.jsonl is too (persistEvents ran just above). Skip dry runs.
  const wake = (ok) => { if (dry) return; try { _deps && typeof _deps.onRunComplete === 'function' && _deps.onRunComplete({ runId: id, agentId: aid, ok, memDir }) } catch { /* best-effort */ } }
  const rt = await loadRuntime()
  Promise.resolve()
    .then(() => rt.runWorkflow(file, { args, memDir, runId: id, dry }))
    .then(() => { persistEvents(); wake(true); try { broadcast && broadcast({ type: 'workflow-run', agentId: aid, runId: id, done: true, ok: true, stats: finalStats() }) } catch { /* best-effort */ } })
    .catch((e) => {
      void e
      persistEvents() // an errored run still gets its (partial) board frozen on disk
      wake(false)
      try { broadcast && broadcast({ type: 'workflow-run', agentId: aid, runId: id, done: true, ok: false, stats: finalStats() }) } catch { /* best-effort */ }
    })

  // DRY PREFLIGHT (TODO cards): the full structural skeleton (every leaf, label + phase), instant + no LLM.
  // Per-run `dry` flag, so it never affects the real run. Best-effort + timeout — runs IN PARALLEL with the
  // real run so it never stalls it. On resolve, re-broadcasts `started` with the skeleton so the board adds
  // TODO cards. A dry run executes the workflow BODY (declares phases/fan-outs; no leaves spawn), so workflows
  // with top-level side effects (file writes, network) WILL see them twice — acceptable for declarative
  // workflows, and the lab does the same. TODO: guard body side effects if this ever bites.
  if (!dry && broadcast) {
    const skelId = mintRunId()
    ensureRun(skelId)
    Promise.resolve()
      .then(async () => {
        const rt0 = await loadRuntime()
        await Promise.race([
          rt0.runWorkflow(file, { args, memDir: null, runId: skelId, dry: true }),
          new Promise((r) => setTimeout(r, 8000))
        ])
        const skeleton = snapshot(skelId).filter((e) => e.type !== 'run:done')
        try { if (memDir) writeSkeleton(memDir, skeleton) } catch { /* best-effort: a reloaded board falls back to its real events */ }
        try { broadcast({ type: 'workflow-run', agentId: aid, runId: id, started: true, skeleton, memDir }) } catch { /* best-effort */ }
      })
      .catch(() => { /* preflight is best-effort */ })
      .finally(() => { try { bus.clearRun(skelId) } catch { /* best-effort */ } })
  }

  return { ok: true, runId: id, surfaceId, memDir }
}

// Re-export bus reads for the IPC subscribe path (the renderer bridge -> main -> here).
export { subscribe, snapshot, isDone }
