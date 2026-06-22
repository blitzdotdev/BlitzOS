// wf-store.mjs — durable, event-sourced storage for the in-chat workflow kanban boards.
//
// WHY THIS EXISTS: the board reducer (wfReduce) folds a stream of WfEvents (run:start / phase / agent:start /
// agent:done / run:done). Those events are emitted through the runtime's progress sink into the in-memory
// per-run bus (workflow-bus.mjs) and NOTHING used to persist them — so a finished board vanished when the bus
// dropped the run (30s after done) or on relaunch. (Note: <memDir>/journal.jsonl is the RESUME memo —
// {i,hash,result} per agent() call — NOT the event stream; replaying it through the reducer yields an empty
// board. That was a wrong premise in the original persistence plan.) This module is the fix: on run:done the
// host writes the full event buffer to events.jsonl; on reload the bus is hydrated from it and the SAME reducer
// renders an identical frozen board (the live render path is reused verbatim).
//
// On-disk layout, per run, under <ws>/.blitzos/workflows/:
//   <runId>/events.jsonl   append-once WfEvent stream (written when the run settles)   ← board source of truth
//   <runId>/skeleton.json  the dry-preflight skeleton events (TODO cards)              ← faithful queued/failed cards
//   <runId>/result.json    final {result,meta,stats}  (already written by the runtime)
//   <runId>/leaves/*.json  per-leaf Asked/Did/Returned (already written by captureLeaf) ← drill-in drawer
//   index.json             { [runId]: {runId,agentId,file,startedAt,done,ok,memDir} }  ← the per-agent run index
//
// Pure node (fs + path only), no Electron — headless-testable (scripts/tests/test-wf-store.mjs).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const INDEX_CAP = 200 // keep the most-recent N runs in index.json (bounds unbounded session growth)
const LIST_CAP = 30 // boards returned per agent on load (most-recent-first); older runs stay on disk

// Atomic write (tmp + rename) — the repo convention (workspace.mjs / widget-catalog.mjs). A reader NEVER sees a
// half-written or torn-tail file: the prior file stays intact until the rename (atomic on the same fs), and a
// crash mid-write only leaves a stray .tmp- that no reader opens. Without this, a crash truncating the final
// run:done line of events.jsonl would reload a finished board as perpetually 'running'. The caller mkdir's first.
let _tmpSeq = 0
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${_tmpSeq++}`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/** The workflows dir that owns a run's memDir (memDir = <workflows>/<runId>, so its parent IS <workflows>). */
export function workflowsDirOf(memDir) {
  return memDir ? dirname(String(memDir)) : null
}

export function readIndex(workflowsDir) {
  try {
    if (!workflowsDir) return {}
    const p = join(String(workflowsDir), 'index.json')
    if (!existsSync(p)) return {}
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {} // a corrupt/missing index degrades to empty (no boards, never a throw)
  }
}

/** Merge ONE run entry into index.json (read-modify-write). Called on the `started` and `done` transitions.
 *  Best-effort + never throws. Prunes to INDEX_CAP most-recent by startedAt so the file can't grow forever. */
export function writeIndexEntry(workflowsDir, runId, patch) {
  try {
    const id = String(runId || '')
    if (!id || !workflowsDir) return
    mkdirSync(String(workflowsDir), { recursive: true })
    const idx = readIndex(workflowsDir)
    idx[id] = { ...(idx[id] || {}), ...(patch || {}), runId: id }
    const keys = Object.keys(idx)
    if (keys.length > INDEX_CAP) {
      // Drop the oldest (smallest startedAt) beyond the cap; the just-written id is always kept.
      const ordered = keys.sort((a, b) => (Number(idx[b].startedAt) || 0) - (Number(idx[a].startedAt) || 0))
      for (const k of ordered.slice(INDEX_CAP)) if (k !== id) delete idx[k]
    }
    atomicWrite(join(String(workflowsDir), 'index.json'), JSON.stringify(idx, null, 2))
  } catch {
    /* best-effort persistence — a board failing to persist must never break a run */
  }
}

/** Boot/load-time heal: a hosted workflow run is IN-PROCESS, so at the next process start NO prior-session run can
 *  still be alive — every `done:false` index entry is therefore ORPHANED (the app died, clean-quit or crash, before
 *  the run's `done` was written). Flip each to {done:true, ok:false} so a reloaded board reads 'workflow failed'
 *  instead of a phantom 'workflow running' spinner forever. `isLive(runId)` shields any run live in THE CURRENT
 *  session's registry (so a genuinely-running run is never force-failed). Returns the count healed. Idempotent. */
export function reconcileOrphanRuns(workflowsDir, isLive) {
  try {
    if (!workflowsDir) return 0
    const idx = readIndex(workflowsDir)
    let changed = 0
    for (const id of Object.keys(idx)) {
      const e = idx[id]
      if (e && !e.done && !(typeof isLive === 'function' && isLive(id))) {
        // The run may actually have SETTLED (its events.jsonl carries run:done) and only missed the index
        // done-write (the app died in the tiny window between persistEvents and the done broadcast). In that case
        // recover the TRUE ok from the event stream so a SUCCEEDED run is not mislabeled 'failed'. If there is no
        // run:done, it is a genuine orphan (died mid-run) → failed.
        let ok = false
        let stats = e.stats ?? null
        try {
          const rd = readEventsLog(e.memDir).find((x) => x && x.type === 'run:done')
          if (rd) { ok = !!rd.ok; stats = { ms: Number(rd.ms) || 0, calls: Number(rd.calls) || 0, tokens: Number(rd.tokens) || 0 } }
        } catch {
          /* no event stream → genuine orphan */
        }
        idx[id] = { ...e, done: true, ok, stats }
        changed++
      }
    }
    if (changed) atomicWrite(join(String(workflowsDir), 'index.json'), JSON.stringify(idx, null, 2))
    return changed
  } catch {
    return 0
  }
}

/** Write the full WfEvent buffer for a run (called once when the run settles). One JSON object per line. */
export function writeEventsLog(memDir, events) {
  try {
    if (!memDir || !Array.isArray(events)) return
    mkdirSync(String(memDir), { recursive: true })
    const body = events.map((e) => JSON.stringify(e)).join('\n')
    atomicWrite(join(String(memDir), 'events.jsonl'), events.length ? body + '\n' : '')
  } catch {
    /* best-effort */
  }
}

/** Read a run's persisted WfEvent stream (for bus hydration). A corrupt line is skipped, not fatal. */
export function readEventsLog(memDir) {
  try {
    if (!memDir) return []
    const p = join(String(memDir), 'events.jsonl')
    if (!existsSync(p)) return []
    const out = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s))
      } catch {
        /* skip a torn/partial line (e.g. a crash mid-write) */
      }
    }
    return out
  } catch {
    return []
  }
}

/** Persist the dry-preflight skeleton (TODO cards) so a reloaded board shows queued/never-run leaves faithfully. */
export function writeSkeleton(memDir, skeletonEvents) {
  try {
    if (!memDir || !Array.isArray(skeletonEvents)) return
    mkdirSync(String(memDir), { recursive: true })
    atomicWrite(join(String(memDir), 'skeleton.json'), JSON.stringify(skeletonEvents))
  } catch {
    /* best-effort */
  }
}

export function readSkeleton(memDir) {
  try {
    if (!memDir) return []
    const p = join(String(memDir), 'skeleton.json')
    if (!existsSync(p)) return []
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

/** List an agent's runs from the index, most-recent-first, capped at LIST_CAP, each shaped like an IslandWfRun
 *  (skeleton loaded from skeleton.json). The live registry merges/overrides these in osActions (live wins). */
export function listAgentRuns(workflowsDir, agentId) {
  const idx = readIndex(workflowsDir)
  const aid = String(agentId || '0')
  const rows = []
  for (const id of Object.keys(idx)) {
    const e = idx[id]
    if (!e || String(e.agentId) !== aid) continue
    rows.push({
      runId: id,
      agentId: aid,
      file: String(e.file || ''),
      startedAt: Number(e.startedAt) || 0,
      done: !!e.done,
      ok: !!e.ok,
      memDir: e.memDir ? String(e.memDir) : null,
      stats: e.stats && typeof e.stats === 'object' ? e.stats : null // final {ms,calls,tokens} for the collapsed pill (no board mount)
    })
  }
  rows.sort((a, b) => b.startedAt - a.startedAt)
  const top = rows.slice(0, LIST_CAP) // older runs stay on disk; reading every skeleton.json would be wasteful
  for (const r of top) r.skeleton = readSkeleton(r.memDir)
  return top
}
