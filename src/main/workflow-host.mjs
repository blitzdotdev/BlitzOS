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

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureRun, subscribe, snapshot, isDone } from './workflow-bus.mjs'
import * as bus from './workflow-bus.mjs'

let _deps = null
/** deps: { getWorkspacePath():string, spawnEnrichment?(info):void } */
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
  const id = runId || mintRunId()
  await ensureSink()
  ensureRun(id) // make the buffer up front so a widget that subscribes before the first emit still attaches

  const memDir = workflowMemDir(id)
  if (memDir) { try { mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ } }

  // Kick off the fresh enrichment agent in parallel (best-effort; the generic widget already shows live).
  if (surfaceId && _deps && typeof _deps.spawnEnrichment === 'function') {
    try { _deps.spawnEnrichment({ runId: id, surfaceId, file, view, agentId, memDir }) } catch { /* never block the run */ }
  }

  // Run in the BACKGROUND. The global sink streams events to the bus -> the subscribed widget; the runtime
  // writes result.json on completion. We do NOT await it (a workflow can run for minutes).
  const rt = await loadRuntime()
  Promise.resolve()
    .then(() => rt.runWorkflow(file, { args, memDir, runId: id, dry }))
    .catch((e) => { /* run:done(ok:false) was already emitted by runWorkflow; nothing else to do */ void e })

  return { ok: true, runId: id, surfaceId, memDir }
}

// Re-export bus reads for the IPC subscribe path (the renderer bridge -> main -> here).
export { subscribe, snapshot, isDone }
