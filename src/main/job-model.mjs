// job-model.mjs — the JOB object, the ONE formalized unit of work in BlitzOS (plans/blitzos-job-task-model.md,
// plans/blitzos-user-journey.md). The spine of the user-journey refactor.
//
// THE MODEL (single-Job, decided by the user — Option 1): there is NO separate jobs store and NO `mode` field.
// A Job is stored as a `job` object ON the per-agent meta.json (`.blitzos/terminals/<id>/meta.json`), 1:1 with the
// agent — so an agent either HAS a job (it is a "job agent": it plans, then executes under /goal with steering) or
// it does NOT (a plain peer = a "normal request" the agent just handles in chat, no plan, no continuation). Nothing
// new is built for normal requests; spawn_agent stays the bare-peer primitive.
//
// WHY this file reuses terminal-manager's meta helpers: the job rides the SAME meta.json the terminal owns, so it
// survives a restart through the existing terminal lifecycle (no third persistence path, no second serializer to
// keep in sync). We import terminal-manager's module-level readTerminalMeta/writeTerminalMeta (the single meta
// serializer) rather than inventing a parallel reader/writer. The shape MIRRORS onboarding's readInterview/
// writeInterview (a small typed JSON record + a status state-machine), generalizing interview.json.
//
// THE BOOT DUTY: the boot-task mapper (index.ts) maps agentId -> its job -> a standing duty STRING by status
// (proposed/approved -> author a plan and wait for approval; running -> execute the approved plan under /goal). This
// is the same policy-free seam onboarding uses for agent '0'; an agent with NO job falls through unchanged.
import { readTerminalMeta, writeTerminalMeta } from './terminal-manager.mjs'

// The Job lifecycle: proposed -> approved -> running -> done | blocked. A Job ALWAYS plans first (the W1 editable
// plan widget — not built yet), gets user approval, then runs (executes the approved plan under /goal until done,
// with W2 steering throughout). The agent advances status via the set_job_status tool; BlitzOS reacts to each edge.
export const JOB_STATUSES = ['proposed', 'approved', 'running', 'done', 'blocked']

/** Statuses for which the agent is still PLANNING (author the plan, do not execute yet). */
const PLAN_STATUSES = new Set(['proposed', 'approved'])
/** Statuses for which the agent should EXECUTE the approved plan. */
const EXECUTE_STATUSES = new Set(['running'])

// THE PLANNING DUTY (status proposed/approved). The W1 editable plan widget now EXISTS as an authoring IDIOM (see
// get_widget_authoring "Editable / interactive widgets" + the optional `plan` library template) plus a two-way
// RETURN CHANNEL: the user edits the widget, the widget setProps the full edited plan + a tiny sendMessage wakes
// this agent, and the agent reads it via get_surface and reconciles it into plan.md. The duty drives that round-trip
// and never marks the job running itself (the user approves; BlitzOS re-launches into execution).
export const JOB_PLAN_DUTY =
  'THIS IS A JOB IN ITS PLANNING PHASE. The user started a job; your goal is under "/goal" below. Do NOT execute the work yet — first PLAN it, present it, and get approval. Steps: ' +
  '(1) AUTHOR AN EDITABLE PLAN WIDGET the user can change. Read get_widget_authoring first (the "Editable / interactive widgets" section is the exact idiom + data contract); the fastest path is spawn_widget {name:"plan"} (the library plan template) and drive it with update_surface{props}, or author your own srcdoc/jsx widget with the same shape if the job wants a custom layout. Seed it with props:{mode:"edit", agentId:"<your-agent-id>", stages:[{id,title,detail,status:"todo"}], decisions:{}, comments:""}. The widget must let the user edit each stage (inline), reorder/remove stages, toggle any key decisions, leave comments, and tap Submit/Reject — it writes those edits into its own props (setProps) and, on Submit/Reject, sends you a tiny "plan approve"/"plan reject" message carrying its props.agentId. ' +
  '(2) BIND THE WIDGET TO THE JOB: call set_job_status {agent:"<your-agent-id>", planSurfaceId:"<the spawned widget id>"} to record the widget surface id on the job (this also lets the supervisor find the plan surface). You may pass planSurfaceId without changing status. ' +
  '(3) WRITE THE SAME STAGED PLAN to `.blitzos/jobs/<your-agent-id>/plan.md` (create the folder). Use the EXACT machine-readable grammar the execution phase parses: a top-level `status: proposed` line (front-matter between `---` fences, or a bare header line), then one GitHub task-list checkbox per stage — `- [ ] Stage title` for a todo stage, `- [x] …` for done, `- [b] …` for blocked. Keep the widget stages and the plan.md checkboxes in lock-step (same order, same titles). ' +
  '(4) PRESENT the plan in your chat and ASK the user to approve, edit, or reject (use the `ask` tool for the approve/edit/reject choice — it renders real buttons). ' +
  '(5) ON A USER EDIT (you get a trigger:"message" wake like "plan approve"/"plan reject"/"plan edit", or a trigger:"action" moment, or a plain chat request for changes): read the FULL edited plan with get_surface {id:"<planSurfaceId>"} (its props carry the user\'s stages/decisions/comments/decision — do NOT rely on the tiny message text for the payload), then RECONCILE BOTH SIDES — rewrite plan.md to match the edited stages in the grammar above, and push any normalization back to the widget with update_surface {id, props} (then re-check get_surface for props.lastError) — and re-present. If the decision is "reject", revise the plan per their comments and present again. ' +
  'Do NOT begin the actual work, do NOT take any irreversible action, and do NOT mark the job running yourself — only the user approves, and only THEN do you set status:"running" (set_job_status), which re-launches you into the execution phase. While planning you may do reversible research to make the plan concrete, but stage everything; nothing is sent, deployed, or committed during planning.'

// THE EXECUTION DUTY (status running). The Job was approved; run the written plan to completion under /goal (the E1
// continuation engine — not built yet; plans/blitzos-agent-autonomy-guardrails.md). Until the continuation engine
// lands, this duty alone keeps the agent driving toward "the plan is fully done".
export const JOB_EXECUTE_DUTY =
  'THIS IS AN APPROVED JOB IN ITS EXECUTION PHASE. The user approved the plan; your goal is under "/goal" below. EXECUTE the approved plan now and keep going until the WRITTEN plan is fully done — do not stop after one step. Read `.blitzos/jobs/<your-agent-id>/plan.md` (the approved staged plan) first, then work through it step by step, keeping a visible progress widget updated as each step moves to done (and updating the plan widget / plan.md status as you complete steps). Narrate progress in your chat as you go. Continue across re-invokes from `/events`: on each wake, re-read plan.md, see what is still incomplete, and resume — you are not finished until every step in the plan is complete. Stay inside the user boundaries: do ALL reversible work automatically (research, drafting, staging, file/surface edits, board updates), and ask ONLY before an irreversible outward act (sending, posting, deploying, spending money, using credentials, account actions, destructive changes). When the whole plan is complete, mark the job done (set_job_status status:"done") and post a short summary of what you did.'

/** The standing duty STRING for a job status, or null when the job needs no duty (done/blocked, or no/invalid job).
 *  Pure — the boot-task mapper (index.ts) and tests both call it. */
export function dutyForJobStatus(status) {
  const s = String(status || '')
  if (PLAN_STATUSES.has(s)) return JOB_PLAN_DUTY
  if (EXECUTE_STATUSES.has(s)) return JOB_EXECUTE_DUTY
  return null // done | blocked | unknown — no standing duty (the agent is finished or stuck on the user)
}

// The terminalsDir resolver — injected once at wiring time (mirrors agent-runtime's setBootTaskProvider /
// osActions' setLaunchAgent). job-model is a pure .mjs that must NOT import the IPC-bound osActions.ts (cycle +
// transport coupling), so the transport (index.ts for Electron, backend.mjs for the server) tells it where the
// active workspace's `.blitzos/terminals` dir is. Absent (not yet wired) ⇒ job ops are inert no-ops.
let getTerminalsDir = null
/** Wire the active-workspace terminalsDir resolver. The transport calls this once during bootstrap. */
export function wireJobModel({ getTerminalsDir: resolver } = {}) {
  getTerminalsDir = typeof resolver === 'function' ? resolver : null
}
function terminalsDir() {
  try {
    return getTerminalsDir ? getTerminalsDir() : null
  } catch {
    return null
  }
}

/** Read an agent's Job record (the `job` object on its meta.json), or null when there is none / no resolver. */
export function readJob(agentId) {
  const dir = terminalsDir()
  if (!dir) return null
  const meta = readTerminalMeta(dir, String(agentId))
  return meta && meta.job && typeof meta.job === 'object' ? meta.job : null
}

/** Merge `patch` into an agent's Job, stamping updatedAt (and createdAt on first write). Persists onto the agent's
 *  meta.json (the SAME record the terminal owns, so it survives a restart). Returns the merged job, or null when
 *  there is no resolver / no agent meta yet. Mirrors onboarding's writeInterview (a small JSON record write). */
export function writeJob(agentId, patch = {}) {
  const dir = terminalsDir()
  if (!dir) return null
  const id = String(agentId)
  const meta = readTerminalMeta(dir, id)
  if (!meta) return null // no terminal record for this id — nothing to attach a job to
  const now = Date.now()
  const prev = meta.job && typeof meta.job === 'object' ? meta.job : null
  const job = {
    ...(prev || {}),
    ...patch,
    createdAt: prev?.createdAt || patch.createdAt || now,
    updatedAt: now
  }
  writeTerminalMeta(dir, id, { ...meta, job })
  return job
}

/** Advance a Job's status (validated against JOB_STATUSES) and/or set bind-fields on it. Returns { ok, job } or
 *  { ok:false, error }. The caller (the set_job_status tool) handles the approved->running re-exec into the execution
 *  duty separately. `status` is OPTIONAL: pass it to advance the lifecycle, or omit it (empty/null) to set only
 *  `fields` — e.g. the W1 planning agent binding the plan widget with { planSurfaceId } before any status change.
 *  `fields` is the whitelisted set of non-status Job props the agent may set (planSurfaceId / planPath); anything
 *  else is ignored so a tool call can never clobber status/goal/timestamps out of band. */
export function setJobStatus(agentId, status, fields = {}) {
  const s = String(status || '')
  const hasStatus = s !== ''
  if (hasStatus && !JOB_STATUSES.includes(s)) return { ok: false, error: `status must be one of ${JOB_STATUSES.join(', ')}` }
  const patch = {}
  if (hasStatus) patch.status = s
  if (fields && typeof fields === 'object') {
    if (fields.planSurfaceId != null) patch.planSurfaceId = String(fields.planSurfaceId)
    if (fields.planPath != null) patch.planPath = String(fields.planPath)
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to set: pass status and/or planSurfaceId' }
  const existing = readJob(agentId)
  if (!existing) return { ok: false, error: 'agent has no job' }
  const job = writeJob(agentId, patch)
  return job ? { ok: true, job } : { ok: false, error: 'could not write job' }
}

/** Build a fresh PROPOSED job object WITHOUT writing it (status 'proposed', with timestamps). The start_job path
 *  hands this to spawnAgent so addAgent stamps it onto the agent's meta BEFORE the terminal launches — so the FIRST
 *  bootstrap already carries the planning duty (bootTaskProvider reads it), with no post-spawn re-exec. createJob
 *  (below) is the write-after-spawn variant (kept for any write path + tests). */
export function makeJob({ goal, title, contextRefs } = {}) {
  const now = Date.now()
  return {
    status: 'proposed',
    goal: goal != null ? String(goal) : '',
    ...(title != null ? { title: String(title) } : {}),
    ...(Array.isArray(contextRefs) ? { contextRefs: contextRefs.map(String) } : {}),
    createdAt: now,
    updatedAt: now
  }
}

/** Create + WRITE the initial Job record on an already-spawned agent (status 'proposed'). Returns the job, or null
 *  when there is no resolver / agent meta. The start_job tool now uses makeJob + a pre-launch stamp instead. */
export function createJob(agentId, { goal, title, contextRefs } = {}) {
  return writeJob(agentId, {
    status: 'proposed',
    goal: goal != null ? String(goal) : '',
    ...(title != null ? { title: String(title) } : {}),
    ...(Array.isArray(contextRefs) ? { contextRefs: contextRefs.map(String) } : {})
  })
}
