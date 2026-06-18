// Types for the JOB plan.md reader/parser + continuation decision (plan-doc.mjs) — the E1 continuation engine.

export type PlanStatus = 'proposed' | 'approved' | 'running' | 'done' | 'blocked'
export type StageStatus = 'done' | 'todo' | 'blocked'

export interface PlanStage {
  title: string
  status: StageStatus
}

export interface Plan {
  /** the machine-readable top-level status, or null when no `status:` line is present. */
  status: PlanStatus | null
  /** the per-stage checklist, in document order. */
  stages: PlanStage[]
  /** every stage done (≥1 stage), or top-level status:done. */
  complete: boolean
  /** any stage blocked, or top-level status:blocked. */
  blocked: boolean
}

export interface ContinueState {
  planStatus: PlanStatus | null | undefined
  complete: boolean
  blocked: boolean
  /** consecutive no-change continues so far (the persisted spin counter). Default 0. */
  spinCount?: number
  /** did plan.md change since the previous continue? Resets the spin-guard. Default true. */
  planChangedSinceLastContinue?: boolean
}

export interface ContinueResult {
  continue: boolean
  /** machine-readable why (complete | blocked | stuck | no-plan | status:<s> | continue) — for logs/tests. */
  reason: string
  /** the next-step nudge fed back to the agent on a continue (or the stuck message). */
  message?: string
}

/** All valid plan statuses, in lifecycle order. */
export const PLAN_STATUSES: PlanStatus[]
/** The spin-guard cap (consecutive no-change continues before stop+stuck). */
export const SPIN_GUARD_LIMIT: number
/** The per-agent spin-counter filename (sibling of plan.md). */
export const SPIN_FILE: string

/** Wire the active-workspace `.blitzos/jobs` dir resolver (the same DI seam wireJobModel uses). */
export function wirePlanDoc(deps?: { getJobsDir?: (() => string | null | undefined) | null }): void

/** Absolute path to a job's plan.md (`<jobsDir>/<agentId>/plan.md`), or null with no resolver. */
export function planPath(agentId: string): string | null

/** Parse the machine-readable status out of plan.md text (front-matter or a header line), or null. PURE. */
export function parsePlanStatus(text: string): PlanStatus | null

/** Parse the per-stage checklist out of plan.md text. PURE. */
export function parsePlanStages(text: string): PlanStage[]

/** Read + parse a job's plan.md, or null when there is no plan.md / no resolver. */
export function readPlan(agentId: string): Plan | null

/** Write a job's plan.md (creates the job dir). Returns the path, or null with no resolver. */
export function writePlan(agentId: string, text: string): string | null

/** Path to a job's spin-counter file, or null with no resolver. */
export function spinPath(agentId: string): string | null
/** Read the current consecutive-no-change continue count (0 if missing). */
export function readSpin(agentId: string): number
/** Persist the spin count. Best-effort. */
export function writeSpin(agentId: string, n: number): void

/** The pure continuation decision (+ spin-guard). */
export function continueDecision(state?: ContinueState): ContinueResult
