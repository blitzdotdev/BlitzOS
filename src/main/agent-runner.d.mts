// Types for the agent runner/supervisor (agent-runner.mjs).

export interface AgentRunnerOpts {
  /** Returns the current agent-socket URL, or null/undefined until it is minted. */
  getUrl: () => string | null | undefined
  /** Agent binary to spawn (default 'claude'). */
  cmd?: string
  /** Log prefix. */
  label?: string
}

/** Spawn + auto-restart the brain process. Returns a stop function. */
export function startAgentRunner(opts: AgentRunnerOpts): () => void
