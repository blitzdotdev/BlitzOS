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
  /** Surface a sticky "Not signed in" chat error for a terminal-only auth 401 (never in the JSONL). */
  onAuthError?: (agentId: string, workspace: string | null) => void
  log?: (msg: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  graceMs?: number
  settleMs?: number
  recheckMs?: number
  maxTries?: number
  maxWatchMs?: number
  /** Gap (ms) between typing the nudge text and the separate Enter, so the TUI submits it (paste-vs-submit fix). */
  submitDelayMs?: number
  /** A rate-limited agent: how long to hold between probe-nudges (don't hammer the throttled API). */
  rateLimitBackoffMs?: number
  /** Wait this long PAST a parsed usage-limit reset time before resuming (so the limit is fully lifted). */
  resumeBufferMs?: number
  /** After a scheduled resume fires, how long to keep the sweep from re-arming the same agent (no storm). */
  resumeCooldownMs?: number
}

export interface WakeWatchdog {
  /** Wire to perception-core.setUndeliveredWakeHook — a message reached no live waiter for this agent. */
  onUndelivered(moment: { agentId?: string; workspace?: string | null }): void
  /** Periodic proactive peek: arm a scheduled resume for any live agent whose pane shows a usage limit with a
   *  reset time (a self-inflicted stall no message would surface). Pass agent ids or { agentId, workspace }. */
  sweep(agents: Array<string | { agentId: string; workspace?: string | null }>): void
  /** Tear down all timers (shutdown). */
  stop(): void
  _size(): number
}

export function createWakeWatchdog(deps: WakeWatchdogDeps): WakeWatchdog

/** Parse a Claude usage/session-limit reset time off the pane ("resets 6:40pm"); epoch-ms or null. */
export function parseResetAt(text: string, nowMs: number): number | null

/** Matches a usage/session-limit pane (the kind with a stated reset time). */
export const SESSION_LIMIT_RE: RegExp
