// Types for the self-healing agent wake watchdog (agent-wake-watchdog.mjs).

export interface WakeWatchdogDeps {
  /** Agent's last /events poll time (its wait-loop heartbeat) — perception-core.lastPollAt. */
  lastPollAt: (agentId: string, workspace?: string | null) => number
  /** Inject keystrokes into the agent's tmux pane — terminalOps.sendToTerminal. */
  sendToTerminal: (agentId: string, data: string) => boolean | void
  /** Current rendered pane text for the frozen-check — terminalOps.captureTerminal. */
  captureTerminal?: (agentId: string) => string
  /** Is the agent's pane wired this run — terminalOps.isTerminalLive. */
  isLive?: (agentId: string) => boolean
  /** Push an island status override while recovering ('reconnecting' | 'error') or clear it (null). */
  setStatus?: (agentId: string, workspace: string | null, status: string | null) => void
  log?: (msg: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  graceMs?: number
  settleMs?: number
  recheckMs?: number
  maxTries?: number
  maxWatchMs?: number
}

export interface WakeWatchdog {
  /** Wire to perception-core.setUndeliveredWakeHook — a message reached no live waiter for this agent. */
  onUndelivered(moment: { agentId?: string; workspace?: string | null }): void
  /** Tear down all timers (shutdown). */
  stop(): void
  _size(): number
}

export function createWakeWatchdog(deps: WakeWatchdogDeps): WakeWatchdog
