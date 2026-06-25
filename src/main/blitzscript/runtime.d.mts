// Type declarations for blitzscript/runtime.mjs — the Claude Code Workflow loader + injected globals.

import { setProgressSink } from './progress.mjs'
export { setProgressSink }

export interface WorkflowMeta {
  name: string
  description?: string
  phases?: Array<{ title: string; detail?: string }>
  whenToUse?: string
  model?: string
  [k: string]: unknown
}

export interface LoadedWorkflow {
  meta: WorkflowMeta
  body: string
  file: string
}

/** Parse + strip `export const meta` (line numbers preserved); a missing meta synthesizes { name }. */
export function loadWorkflow(file: string): LoadedWorkflow
export function stripMeta(source: string, file?: string): { meta: WorkflowMeta; body: string }

/** Compile the workflow body into an injected async function (also the check.mjs syntax gate). */
export function makeWrappedFn(body: string): (...args: unknown[]) => Promise<unknown>

export interface RunWorkflowOpts {
  /** The workflow INPUT, bound to the `args` global. */
  args?: unknown
  /** This run's memory dir (journal.jsonl + result.json). */
  memDir?: string | null
  /** A token budget total (number) -> the `budget` global; absent/null = unbounded. */
  budget?: number | null
  /** Nesting depth (0 at the root run). */
  depth?: number
  /** The externalization run id — stamped on every WfEvent so a host sink can route by run. */
  runId?: string | null
}

export interface RunWorkflowResult {
  result: unknown
  meta: WorkflowMeta
  stats: { calls: number; tokensSpent: number; depth: number; jIndex: number }
}

/** Load + run a Claude-shaped workflow in-process with a FRESH RunContext; resolves to its top-level return. */
export function runWorkflow(file: string, opts?: RunWorkflowOpts): Promise<RunWorkflowResult>

/** parallel(thunks) — barrier over an array of functions; a throwing thunk -> null. */
export function parallel<T = unknown>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>>

/** pipeline(items, ...stages) — no inter-stage barrier; stage1(item), stageK(prev, item, index). */
export function pipeline(items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>): Promise<unknown[]>

/** A frozen { total, spent(), remaining() } over the run's tokensSpent. total:null = unbounded. */
export function makeBudget(total: number | null | undefined, ctx?: unknown): Readonly<{ total: number | null; spent: () => number; remaining: () => number }>

/** The injected global names, in the fixed order the wrapped function expects. */
export const GLOBAL_NAMES: string[]

declare const _default: {
  loadWorkflow: typeof loadWorkflow
  runWorkflow: typeof runWorkflow
  stripMeta: typeof stripMeta
  makeWrappedFn: typeof makeWrappedFn
  makeBudget: typeof makeBudget
  parallel: typeof parallel
  pipeline: typeof pipeline
  setProgressSink: typeof setProgressSink
  GLOBAL_NAMES: typeof GLOBAL_NAMES
}
export default _default
