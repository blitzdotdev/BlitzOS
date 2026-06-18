// Types for the JOB model (job-model.mjs) — the one formalized unit of work in BlitzOS.
// A Job is stored as a `job` object on the per-agent meta.json (1:1 agent:job, Option 1).

export type JobStatus = 'proposed' | 'approved' | 'running' | 'done' | 'blocked'

export interface Job {
  status: JobStatus
  /** the job's objective (the agent's "/goal"). */
  goal: string
  /** cosmetic title (mirrors the spawning agent's title). */
  title?: string
  /** the editable plan widget surface id (W1 — not built yet). */
  planSurfaceId?: string
  /** the job-scoped staged plan file the execution phase reads. */
  planPath?: string
  /** opaque references the job was started with (paths, surface ids, urls). */
  contextRefs?: string[]
  createdAt: number
  updatedAt: number
}

/** All valid job statuses, in lifecycle order. */
export const JOB_STATUSES: JobStatus[]

/** The planning-phase standing duty (status proposed/approved): author a plan, present it, wait for approval. */
export const JOB_PLAN_DUTY: string
/** The execution-phase standing duty (status running): execute the approved plan to completion under /goal. */
export const JOB_EXECUTE_DUTY: string

/** The standing duty STRING for a job status, or null (done/blocked/unknown → no duty). Pure. */
export function dutyForJobStatus(status: string | null | undefined): string | null

/** Wire the active-workspace terminalsDir resolver (the transport calls this once during bootstrap). */
export function wireJobModel(deps?: { getTerminalsDir?: (() => string | null | undefined) | null }): void

/** Read an agent's Job record (the `job` on its meta.json), or null when there is none / no resolver. */
export function readJob(agentId: string): Job | null

/** Merge `patch` into an agent's Job (stamping updatedAt / createdAt) and persist onto its meta.json.
 *  Returns the merged job, or null when there is no resolver / no agent meta yet. */
export function writeJob(agentId: string, patch?: Partial<Job>): Job | null

/** Advance a Job's status (validated) and/or set whitelisted bind-fields (planSurfaceId / planPath). `status` is
 *  optional — omit it to set only `fields` (e.g. the W1 agent binding the plan widget). Returns { ok, job } or error. */
export function setJobStatus(
  agentId: string,
  status?: string | null,
  fields?: { planSurfaceId?: string; planPath?: string }
): { ok: true; job: Job } | { ok: false; error: string }

/** Build a fresh PROPOSED job object WITHOUT writing it (status 'proposed', with timestamps). The start_job path
 *  hands this to spawnAgent so addAgent stamps it onto the meta BEFORE the terminal launches (first bootstrap
 *  carries the planning duty, no post-spawn re-exec). */
export function makeJob(spec?: { goal?: string; title?: string; contextRefs?: string[] }): Job

/** Create + WRITE the initial Job record on an already-spawned agent (status 'proposed'). */
export function createJob(agentId: string, spec?: { goal?: string; title?: string; contextRefs?: string[] }): Job | null
