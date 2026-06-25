// Type declarations for blitzscript/agent.mjs — the leaf + resource layer (renamed from llm.mjs).

export interface AgentOpts {
  /** 'claude' (default) | 'codex' | 'pi'(stub) | 'opencode'(stub). */
  harness?: string
  /** A concrete model id, or the portable alias 'cheap' | 'strong' | 'default'. */
  model?: string
  /** Reasoning effort: low | medium | high | xhigh | max (claude) / passed to codex. */
  effort?: string
  /** Run the leaf in this dir (e.g. a git worktree). */
  cwd?: string
  /** Re-attempt a transient leaf failure this many times before throwing (default 0). */
  retries?: number
  /** JSON-Schema for structured output. With it, agent() returns a validated object (or null). */
  schema?: Record<string, unknown>
  /** Re-prompt this many times on an invalid/missing structured result (default 1, clamped 1..3). */
  schemaRetries?: number
  /** Display label for the progress sink. */
  label?: string
  /** Phase grouping for the progress sink (overrides the ambient phase). */
  phase?: string
  /** A known agent type: 'Explore' | 'general-purpose' (claude --agents/--agent; codex system block). */
  agentType?: string
  /** 'worktree' runs the leaf in a fresh `git worktree` under the run's memDir. */
  isolation?: string
}

/** Run one leaf agent. Returns text (no schema), a validated object (schema), or null (schema retries exhausted). */
export function agent(prompt: string, opts?: AgentOpts, fallback?: unknown): Promise<string | Record<string, unknown> | null>

/** Deprecated alias for agent() (back-compat for `import { llm }`). */
export const llm: typeof agent
export default agent

/** The process-global concurrency ceiling: min(16, max(2, cpus-2)). */
export const MAX_CONCURRENCY: number

/** Per-run state. runtime.runWorkflow creates a fresh one per run; nested workflow() gets its own. */
export class RunContext {
  constructor(init?: { memDir?: string | null; depth?: number; args?: unknown; budget?: unknown; phase?: string | null; defaultModel?: string; runId?: string | null })
  memDir: string | null
  depth: number
  args: unknown
  budget: unknown
  defaultModel?: string
  phase: string | null
  runId: string | null
  groupSeq: number
  jIndex: number
  journal: Array<{ hash: string; result: unknown }> | null
  divergedAt: number
  calls: number
  dryCalls: number
  tokensSpent: number
  journalPath(): string | null
  loadJournal(): void
  journalHit(i: number, hash: string): { hash: string; result: unknown } | null
  journalRecord(i: number, hash: string, result: unknown): void
  stats(): { calls: number; tokensSpent: number; depth: number; jIndex: number }
}

/** Run `fn` with `ctx` as the ambient RunContext (used by runtime.runWorkflow / workflow()). */
export function withRunContext<T>(ctx: RunContext, fn: () => T): T
/** Read the active RunContext (or the lazily-created default). */
export function getRunContext(): RunContext

/** Thrown by agent() when a set budget is exceeded; parallel/pipeline turn it into a null slot. */
export class WorkflowBudgetExceededError extends Error {}

/** Read-only counters for tests + self-pacing. */
export function _stats(): { active: number; calls: number; waiting: number; maxConcurrency: number }
/** Test hook: reset the DEFAULT context (the journal FILE persists). */
export function _resetJournal(): void
/** Test hook: inject (obj) or clear (undefined) the in-process capabilities cache. */
export function _setCaps(obj: unknown): void
/** Override the injectable spawner (tests). */
export function _setSpawn(fn: ((cmd: string, args: string[], env: Record<string, string>, cwd?: string) => Promise<string>) | null): void
export let _spawn: (cmd: string, args: string[], env: Record<string, string>, cwd?: string) => Promise<string>
/** The leaf-prompt metadata block appended to every leaf prompt. */
export function leafMetadata(depth: number): string
