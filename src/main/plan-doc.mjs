// plan-doc.mjs — the reader/parser for a JOB's plan.md (E1 continuation engine; plans/blitzos-user-journey.md
// E1, plans/blitzos-agent-autonomy-guardrails.md Phase 2). The execution phase of a Job (status 'running') is a
// do-not-stop-until-done loop: the host keeps the agent driving until plan.md is fully done. The two halves of the
// mechanism live here as PURE, headless functions (no IPC-bound imports), plus the host-side glue lives in
// agent-runtime.mjs:
//   • readPlan(agentId)         — parse the machine-readable status + per-stage checklist out of plan.md.
//   • continueDecision(state)   — the pure "continue vs stop" rule (+ the spin-guard), unit-testable.
//
// THE plan.md GRAMMAR (kept deliberately tiny so the SHELL Stop-hook can parse the SAME doc without a JS runtime —
// the hook is a self-contained POSIX sh, like wait.sh, since a packaged claude spawns it as a plain shell command
// with no access to this asar-internal module). The grammar — and ONLY this grammar — is the contract between this
// JS parser and continue-hook.sh; keep them in lock-step (the e2e test runs the real shell hook against fixtures to
// catch drift):
//   • STATUS: a `status:` line — either YAML front-matter (between leading `---` fences) or anywhere as a bare
//     header line `status: running`. First match wins. One of proposed|approved|running|done|blocked (else null).
//   • STAGES: GitHub-style task-list checkboxes, one per line:
//       `- [ ] Title`   → todo
//       `- [x] Title`   → done   (X case-insensitive)
//       `- [b] Title` / a trailing `(blocked)` / `[blocked]` on a `- [ ]` line → blocked
//     Ordered (`1.`) or unordered (`-`/`*`) bullets both count; indentation is ignored.
//   • complete = there is ≥1 stage AND every stage is done (an explicit top-level `status: done` ALSO sets it).
//   • blocked  = any stage is blocked, OR the top-level status is `blocked`.
// Mirrors onboarding.ts's markdown helpers (profileValue/markdownValue) in STYLE — small line regexes, no AST.
//
// THE jobs-dir RESOLVER: injected once at wiring time, the SAME DI seam job-model uses (wireJobModel). plan-doc is a
// pure .mjs that must NOT import the IPC-bound osActions.ts, so the transport (index.ts / backend.mjs) tells it where
// the active workspace's `.blitzos/jobs` dir is. The job-scoped plan lives at `<jobsDir>/<agentId>/plan.md` — the
// exact path JOB_EXECUTE_DUTY/JOB_PLAN_DUTY reference (`.blitzos/jobs/<your-agent-id>/plan.md`). Absent (not wired)
// ⇒ readPlan returns null (no plan visible), so an unwired host simply installs no continuation hook.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const PLAN_STATUSES = ['proposed', 'approved', 'running', 'done', 'blocked']
/** The spin-guard cap: this many consecutive continues that did NOT change plan.md ⇒ stop + flag 'stuck'. */
export const SPIN_GUARD_LIMIT = 3
/** The per-agent spin-counter filename (lives next to plan.md in the job dir; the shell hook writes the same file). */
export const SPIN_FILE = '.continue-spin'

let getJobsDir = null
/** Wire the active-workspace `.blitzos/jobs` dir resolver. The transport calls this once during bootstrap
 *  (mirrors wireJobModel({ getTerminalsDir })). */
export function wirePlanDoc({ getJobsDir: resolver } = {}) {
  getJobsDir = typeof resolver === 'function' ? resolver : null
}
function jobsDir() {
  try {
    return getJobsDir ? getJobsDir() : null
  } catch {
    return null
  }
}

/** Absolute path to a job's plan.md (`<jobsDir>/<agentId>/plan.md`), or null when there is no resolver. Exported so
 *  the host (agent-runtime) can hand the same path to the Stop-hook script. */
export function planPath(agentId) {
  const dir = jobsDir()
  return dir ? join(dir, String(agentId), 'plan.md') : null
}

/** Read a plan.md's raw text, or null if it does not exist / is unreadable. */
function readPlanText(agentId) {
  const p = planPath(agentId)
  if (!p) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Pull the machine-readable `status:` out of plan.md text (front-matter or a bare header line). Returns one of
 *  PLAN_STATUSES, or null. First match wins. PURE (text in → status out) so tests can parse a literal string. */
export function parsePlanStatus(text) {
  if (typeof text !== 'string' || !text) return null
  const m = text.match(/^\s*status:\s*([A-Za-z]+)\s*$/m)
  if (!m) return null
  const s = m[1].toLowerCase()
  return PLAN_STATUSES.includes(s) ? s : null
}

/** Pull the per-stage checklist out of plan.md text → [{title, status:'done'|'todo'|'blocked'}]. PURE. A line is a
 *  stage iff it is a markdown task-list item (`- [ ]` / `- [x]` / `* [ ]` / `1. [ ]`, any indentation). */
export function parsePlanStages(text) {
  if (typeof text !== 'string' || !text) return []
  const stages = []
  for (const raw of text.split('\n')) {
    // [ \t]* indent, then a bullet (-, *, or `N.`), then a `[mark]` box, then the title.
    const m = raw.match(/^[ \t]*(?:[-*]|\d+\.)\s+\[([ xXbB])\]\s*(.*)$/)
    if (!m) continue
    const mark = m[1].toLowerCase()
    const title = m[2].trim()
    let status
    if (mark === 'x') status = 'done'
    else if (mark === 'b') status = 'blocked'
    else if (/\(blocked\)|\[blocked\]/i.test(title)) status = 'blocked' // an unchecked box explicitly tagged blocked
    else status = 'todo'
    stages.push({ title, status })
  }
  return stages
}

/** Read + parse a job's plan.md → { status, stages, complete, blocked }, or null when there is no plan.md (or no
 *  resolver). `complete` = ≥1 stage and all stages done (or top-level status:done). `blocked` = any stage blocked
 *  or top-level status:blocked. The execution loop reads THIS every wake to decide whether the plan is fully done. */
export function readPlan(agentId) {
  const text = readPlanText(agentId)
  if (text == null) return null
  const status = parsePlanStatus(text)
  const stages = parsePlanStages(text)
  const allStagesDone = stages.length > 0 && stages.every((s) => s.status === 'done')
  const complete = allStagesDone || status === 'done'
  const blocked = status === 'blocked' || stages.some((s) => s.status === 'blocked')
  return { status, stages, complete, blocked }
}

/** Write a plan.md (used by tests + any host writer). Creates the job dir. Returns the path, or null with no resolver. */
export function writePlan(agentId, text) {
  const p = planPath(agentId)
  if (!p) return null
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, String(text))
    return p
  } catch {
    return null
  }
}

// ---- the spin-guard counter (a file in the job dir; the shell hook maintains the SAME file) ------------------
/** Path to a job's spin-counter file (`<jobDir>/.continue-spin`), or null with no resolver. */
export function spinPath(agentId) {
  const p = planPath(agentId)
  return p ? join(dirname(p), SPIN_FILE) : null
}
/** Read the current consecutive-no-change continue count (0 if missing/unreadable). */
export function readSpin(agentId) {
  const p = spinPath(agentId)
  if (!p || !existsSync(p)) return 0
  try {
    const n = parseInt(readFileSync(p, 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
/** Persist the spin count. Best-effort. */
export function writeSpin(agentId, n) {
  const p = spinPath(agentId)
  if (!p) return
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, String(Math.max(0, n | 0)))
  } catch {
    /* best-effort — a lost counter just resets the spin-guard, never blocks the agent */
  }
}

/** THE continuation DECISION (pure, unit-testable). Given the current plan state + the spin-guard counter, decide
 *  whether to FORCE the agent to keep going (continue) or let it stop. Mirrors the guardrails-doc rule:
 *    continue  ⇔  status ∈ {approved, running}  AND  !complete  AND  !blocked  AND  spin-guard not tripped.
 *  THE SPIN-GUARD: `spinCount` counts CONSECUTIVE continues whose plan.md did not change. When a fresh continue is
 *  about to be the (SPIN_GUARD_LIMIT)-th such no-change continue, we STOP and flag 'stuck' instead — a stalled agent
 *  that keeps yielding without advancing the plan must not loop forever. `planChangedSinceLastContinue` resets it.
 *
 *  @param planStatus  the plan.md top-level status (proposed|approved|running|done|blocked|null)
 *  @param complete    every stage done (or status:done)
 *  @param blocked     any stage blocked (or status:blocked)
 *  @param spinCount   consecutive no-change continues SO FAR (the persisted counter, pre-this-decision)
 *  @param planChangedSinceLastContinue  did plan.md change since the previous continue? (resets the spin-guard)
 *  @returns { continue:boolean, reason:string, message?:string } — `message` is the text fed back to the agent on a
 *           continue (the next-step nudge the Stop hook emits); `reason` is the machine-readable why for logs/tests.
 */
export function continueDecision({ planStatus, complete, blocked, spinCount = 0, planChangedSinceLastContinue = true } = {}) {
  if (complete) return { continue: false, reason: 'complete' }
  if (blocked) return { continue: false, reason: 'blocked' }
  // Only an APPROVED-or-RUNNING plan is in its execution phase. A proposed/done/blocked/absent plan does not drive.
  if (planStatus !== 'approved' && planStatus !== 'running') {
    return { continue: false, reason: planStatus ? `status:${planStatus}` : 'no-plan' }
  }
  // Spin-guard: if this continue would NOT have changed plan.md and we've already spun (SPIN_GUARD_LIMIT-1) times
  // with no change, the NEXT no-change continue trips the cap → stop + flag stuck.
  const nextSpin = planChangedSinceLastContinue ? 0 : spinCount + 1
  if (nextSpin >= SPIN_GUARD_LIMIT) {
    return { continue: false, reason: 'stuck', message: `Stopping: the plan has not advanced in ${SPIN_GUARD_LIMIT} consecutive turns (spin-guard). Re-read plan.md and either make concrete progress, mark the blocking stage blocked, or ask the user.` }
  }
  return {
    continue: true,
    reason: 'continue',
    message:
      'Keep going — the approved plan in `.blitzos/jobs/<your-agent-id>/plan.md` is not fully done yet. Re-read plan.md, find the next incomplete stage, do it, and update the stage status (mark it done) + your progress widget. Do all reversible work automatically; ask only before an irreversible outward act. When every stage is done, mark the job done (set_job_status status:"done").'
  }
}
