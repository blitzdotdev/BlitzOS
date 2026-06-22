// wf-run-state.mjs — the ONE pure rule for applying a `workflow-run` broadcast to a single run record.
//
// Both the main-process registry (osActions.osNoteWfRun) and the renderer (NotchHost) fold every broadcast
// through THIS function, so the two sides can never drift. That drift was the root of the "second started" bug:
// the run starts with an empty skeleton broadcast, then a parallel dry preflight re-broadcasts `started` with the
// real skeleton. Hand-written copies handled that second `started` differently — main overwrote (resetting
// done:false), the renderer de-duped (dropping the skeleton) — so live boards lost their TODO cards and a fast
// run could show as perpetually running. The rule below makes `started` an UPSERT that never un-finishes a run.
//
// Rule:
//  - `started` for a NEW run        → create {done:false, ok:false, skeleton, startedAt:now}.
//  - `started` for an EXISTING run  → keep done/ok/startedAt; refresh file/memDir; adopt the incoming skeleton
//    ONLY when it is non-empty (the first `started` carries [], the preflight later carries the real one).
//  - `done` for an existing run     → mark {done:true, ok}.
//  - anything else                  → unchanged.
//
// Pure + no imports → unit-testable in node (scripts/tests/test-wf-run-state.mjs) and bundlable into either side.
// `now` is injectable so tests are deterministic; callers omit it (defaults to Date.now, a host clock — allowed
// here, this is not the blitzscript-shadowed workflow body).

export function applyWfRun(prev, action, now) {
  const runId = String((action && action.runId) || '')
  if (!runId) return prev || null
  const ts = typeof now === 'number' ? now : Date.now()
  if (action.started) {
    const incoming = Array.isArray(action.skeleton) ? action.skeleton : []
    if (prev) {
      // UPSERT an existing run: never reset done/ok/startedAt; adopt a non-empty (preflight) skeleton.
      return {
        ...prev,
        file: action.file != null && action.file !== '' ? String(action.file) : prev.file,
        memDir: action.memDir == null ? prev.memDir : String(action.memDir),
        skeleton: incoming.length ? incoming : prev.skeleton
      }
    }
    return {
      runId,
      agentId: String(action.agentId ?? '0'),
      file: String(action.file || ''),
      startedAt: ts,
      done: false,
      ok: false,
      skeleton: incoming,
      memDir: action.memDir == null ? null : String(action.memDir),
      stats: null // rolled-up {ms,calls,tokens}; filled on the `done` transition (from the run:done event)
    }
  }
  // `done` carries the run's final stats (from the run:done event) so a COLLAPSED pill can show
  // "{ms} · {calls} agents · {tokens} tok" straight from the durable record — no board mount/replay needed.
  if (action.done && prev) {
    return { ...prev, done: true, ok: !!action.ok, stats: action.stats && typeof action.stats === 'object' ? action.stats : (prev.stats ?? null) }
  }
  return prev || null
}
