// Types for the agent runner/supervisor (agent-runner.mjs).

export interface AgentRunnerOpts {
  /** Returns the current agent-socket URL, or null/undefined until it is minted. */
  getUrl: () => string | null | undefined
  /** Agent binary to spawn (default 'claude'). */
  cmd?: string
  /** Log prefix. */
  label?: string
}

/** A handle to the running brain supervisor. */
export interface AgentRunnerHandle {
  /** Stop supervising and kill the brain. */
  stop: () => void
  /** Kill the current brain so it respawns immediately with the latest getUrl() (e.g. after a relay reconnect). */
  restart: () => void
}

/** Spawn + auto-restart the brain process. Returns a handle with stop()/restart(). */
export function startAgentRunner(opts: AgentRunnerOpts): AgentRunnerHandle
