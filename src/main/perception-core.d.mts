// Types for the shared perception kernel (perception-core.mjs).

export interface BlitzMoment {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  trigger: 'batch' | 'nav' | 'idle' | 'action' | 'message' | 'select' | 'tick'
  windowMs: number
  signals: Record<string, number>
  user: string[]
  snapshot?: string
  action?: Record<string, unknown>
  /** the user's text, for trigger 'message' (the island chat) */
  message?: string
  /** target agent for a private moment (trigger 'message'/'action'/'connection'); defaults to '0'. */
  agentId?: string
  /** the workspace active when this moment was emitted (v2 scoping stamp). */
  workspace?: string
  /** the supervisor tick's material diff (trigger 'tick') — metadata only (agent status edges + terminal exits). */
  diff?: TickDiff
}

/** The agent snapshot the supervisor tick diffs each heartbeat (plans/blitzos-tick-diff-steer.md, status-only
 *  in V1: agents + terminals only, never surfaces — there is no canvas). */
export interface TickSnapshot {
  agentStatus?: Record<string, string>
  terminals?: Array<{ id: string; status?: string; exitCode?: number | null }>
  workspace?: string
}

/** The material delta a tick carries — content-agnostic transition-shape only (status-only: agent edges + terminal exits). */
export interface TickDiff {
  agents: Array<{ id: string; from: string | null; to: string | null | undefined }>
  terminals: Array<{ id: string; exitCode: number | null }>
}

export function setContentShare(surfaceId: string, on: boolean): void
export function isContentShared(surfaceId: string): boolean
export function dropContentShare(surfaceId: string): void
export function redactMoment(m: BlitzMoment): BlitzMoment
export function ingestSignals(surfaceId: string, raw: Array<Record<string, unknown>>): void
/** Telemetry seam: observe every emitted moment. No-op until set; never breaks the emit path. */
export function setMomentTap(fn: ((moment: Record<string, unknown>) => void) | null): void
export function latestSeq(): number
export function emitSurfaceAction(surfaceId: string, action: Record<string, unknown>): void
export function emitUserMessage(text: string, agentId?: string): void
export function emitConnectorChange(provider: string, connected: boolean): void
/** A connected external source (browser tab / macOS window) was connected, changed, or dropped. */
export function emitConnectionMoment(surfaceId: string, info?: { connId?: string; sourceId?: string; status?: string; verb?: string; summary?: string }): void
/** A hosted blitzscript workflow run finished (run:done) — wake the launching agent (agent-private). */
export function emitWorkflowMoment(runId: string, agentId?: string, info?: { ok?: boolean; resultPath?: string }): void
/** An OS-level event both inhabitants should know about (crash recovery, update, restore…). */
export function emitSystemMoment(kind: string, line: string, detail?: Record<string, unknown>): void
export function waitForEvents(since: number, maxMs: number, agentId?: string, workspace?: string | null): Promise<BlitzMoment[]>
/** Register a hook fired when a 'message' moment reaches NO live waiter (the target agent's wait-loop is dead).
 *  The Electron host wires the wake watchdog here. No-op until set; never breaks the emit path. */
export function setUndeliveredWakeHook(fn: ((moment: BlitzMoment) => void) | null): void
/** Last epoch-ms an agent ran a /events long-poll — its wait-loop liveness heartbeat. 0 = never seen. */
export function lastPollAt(agentId: string, workspace?: string | null): number
/** Register the active-workspace provider; every emitted moment is stamped with it (v2 bleed fix). */
export function setWorkspaceProvider(fn: (() => string | null | undefined) | null): void
/** Register the agent-snapshot provider for the supervisor tick (the transport wires it once). */
export function setTickSource(fn: (() => TickSnapshot | null | undefined) | null): void
/** Drop the tick diff baseline so the next emitTick RE-SEEDS instead of diffing — for a BULK transaction
 *  (workspace switch / hydrate / reconcile) where the whole agent set changes at once. */
export function resetTickBaseline(): void
/** Absorb the agent deltas of a tool op the agent just made (spawn/close), so the NEXT tick skips exactly
 *  those ids (per-delta, one-shot) and the supervisor isn't self-woken on its own op. Timing-independent
 *  (replaces the old setTickSuppressed time window). A concurrent genuine edge in the same tick still wakes.
 *  (`surfaces` is vestigial in island V1 — the status-only tick never reads it — but the field is kept so
 *  callers that still pass it compile unchanged.) */
export function absorbTickEcho(echo: { surfaces?: string[]; agents?: string[] }): void
/** Snapshot the agents, diff vs the prior tick, and emit ONE trigger:'tick' moment IFF the diff is material. */
export function emitTick(): void
export const EVENTS_REMINDER: string

/** In-page sensor installer — SERVER-MODE ONLY (the server backend's headless Chromium; island V1 has no
 *  Electron `web` surface). Evaluate in a web surface. */
export const INJECT: string
/** Drains + clears the in-page signal buffer (server-mode only). Evaluate in a web surface. */
export const DRAIN: string
