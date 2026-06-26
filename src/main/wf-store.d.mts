// Types for wf-store.mjs (durable, event-sourced storage for the in-chat workflow kanban boards).
export interface WfStats {
  ms: number
  calls: number
  tokens: number
}
export interface WfIndexEntry {
  runId: string
  agentId: string
  file: string
  startedAt: number
  done: boolean
  ok: boolean
  memDir: string | null
  stats?: WfStats | null
}
export interface WfStoredRun extends WfIndexEntry {
  skeleton: unknown[]
}
export function workflowsDirOf(memDir: string | null): string | null
export function reconcileOrphanRuns(workflowsDir: string | null, isLive?: (runId: string) => boolean): number
export function readIndex(workflowsDir: string | null): Record<string, WfIndexEntry>
export function writeIndexEntry(workflowsDir: string | null, runId: string, patch: Partial<WfIndexEntry>): void
export function writeEventsLog(memDir: string | null, events: unknown[]): void
export function readEventsLog(memDir: string | null): unknown[]
export function writeSkeleton(memDir: string | null, skeletonEvents: unknown[]): void
export function readSkeleton(memDir: string | null): unknown[]
export function listAgentRuns(workflowsDir: string | null, agentId: string): WfStoredRun[]
