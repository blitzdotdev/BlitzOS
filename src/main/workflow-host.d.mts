// Type declarations for workflow-host.mjs.
import type { StampedEvent } from './workflow-bus.mjs'

export interface WorkflowHostDeps {
  getWorkspacePath(): string | null
  spawnEnrichment?(info: { runId: string; surfaceId: string; file: string; view: string; agentId: string; memDir: string | null }): void
}
export function wireWorkflowHost(deps: WorkflowHostDeps | null): void
export function mintRunId(): string
export function workflowMemDir(runId: string): string | null

export interface RunWorkflowHostedOpts {
  file: string
  args?: unknown
  runId?: string
  surfaceId?: string | null
  view?: string
  agentId?: string
}
export function runWorkflowHosted(opts: RunWorkflowHostedOpts): Promise<{ ok: boolean; runId?: string; surfaceId?: string | null; memDir?: string | null; error?: string }>

export function subscribe(runId: string, cb: (ev: StampedEvent) => void): () => void
export function snapshot(runId: string | null | undefined): StampedEvent[]
export function isDone(runId: string | null | undefined): boolean
