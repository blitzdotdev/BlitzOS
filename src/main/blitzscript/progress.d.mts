// Type declarations for progress.mjs (hand-written; typecheck enforces a .d.mts sibling per .mjs).

export type WfEvent =
  | { runId: string | null; type: 'run:start'; name?: string; description?: string }
  | { runId: string | null; type: 'phase'; phaseId: string; title: string }
  | { runId: string | null; type: 'group:start'; groupId: string; kind: 'parallel' | 'pipeline'; phaseId?: string | null; size: number }
  | { runId: string | null; type: 'group:done'; groupId: string; ok: number; failed: number }
  | { runId: string | null; type: 'agent:start'; nodeId: number; label?: string | null; phaseId?: string | null; groupId?: string | null; index?: number; model?: string; harness: string }
  | { runId: string | null; type: 'agent:done'; nodeId: number; status: 'ok' | 'error' | 'null'; ms: number; tokens?: number; preview?: string; message?: string }
  | { runId: string | null; type: 'log'; phaseId?: string | null; groupId?: string | null; message: string }
  | { runId: string | null; type: 'error'; nodeId?: number; message: string }
  | { runId: string | null; type: 'run:done'; ok: boolean; ms: number; calls: number; tokens: number; preview?: string }

export type ProgressSink = (ev: WfEvent) => void

export function setProgressSink(fn: ProgressSink | null | undefined): void
export function emitProgress(ctx: { runId?: string | null } | null | undefined, ev: Record<string, unknown>): void
export function previewOf(v: unknown, max?: number): string
export function withGroup<T>(groupId: string, fn: () => T): T
export function currentGroup(): string | null
