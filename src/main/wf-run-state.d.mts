// Types for wf-run-state.mjs (the shared `workflow-run` upsert rule).
export interface WfStats {
  ms: number
  calls: number
  tokens: number
}
export interface WfRunRecord {
  runId: string
  agentId: string
  file: string
  startedAt: number
  done: boolean
  ok: boolean
  skeleton: unknown[]
  memDir: string | null
  stats?: WfStats | null
}
/** Fold one `workflow-run` broadcast into a single run record. `started` upserts (never un-finishes); `done`
 *  marks done/ok. Returns the new record, or the previous record unchanged for an irrelevant action. */
export function applyWfRun(
  prev: WfRunRecord | null | undefined,
  action: Record<string, unknown>,
  now?: number
): WfRunRecord | null
