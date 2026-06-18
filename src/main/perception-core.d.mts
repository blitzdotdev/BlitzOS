// Types for the shared perception kernel (perception-core.mjs).

export interface BlitzMoment {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  trigger: 'batch' | 'nav' | 'idle' | 'action' | 'message' | 'select' | 'canvas' | 'tick'
  windowMs: number
  signals: Record<string, number>
  user: string[]
  snapshot?: string
  action?: Record<string, unknown>
  /** the user's text, for trigger 'message' (the in-canvas chat) */
  message?: string
  /** the W2 supervisor tick's material diff (trigger 'tick') — metadata only (ids + change-kind + status edges). */
  diff?: TickDiff
}

/** The host snapshot the W2 supervisor tick diffs each heartbeat (plans/blitzos-tick-diff-steer.md). */
export interface TickSnapshot {
  agentStatus?: Record<string, string>
  terminals?: Array<{ id: string; status?: string; exitCode?: number | null }>
  surfaces?: Array<{ id: string; kind?: string; x?: number; y?: number; w?: number; h?: number; title?: string; props?: Record<string, unknown> }>
  workspace?: string
}

/** The material delta a tick carries — content-agnostic transition-shape only (ids, change-kind, status edges). */
export interface TickDiff {
  agents: Array<{ id: string; from: string | null; to: string | null | undefined }>
  terminals: Array<{ id: string; exitCode: number | null }>
  surfaces: Array<{ id: string; change: 'opened' | 'closed' | 'edited'; kind?: string; title?: string }>
}

export function setContentShare(surfaceId: string, on: boolean): void
export function isContentShared(surfaceId: string): boolean
export function dropContentShare(surfaceId: string): void
export function redactMoment(m: BlitzMoment): BlitzMoment
export function ingestSignals(surfaceId: string, raw: Array<Record<string, unknown>>): void
/** Telemetry seam: observe every emitted moment. No-op until set; never breaks the emit path. */
export function setMomentTap(fn: ((moment: Record<string, unknown>) => void) | null): void
/** Desktop-geometry ops (window open/close/move/resize) → coalesced 'canvas' moments for the
 *  primary watcher. origin 'human' = a gesture; 'tool' = a syscall (the policy absorbs its own). */
export function ingestCanvasOps(ops: Array<{ op: 'open' | 'close' | 'move' | 'resize'; id: string; title?: string; kind?: string; x?: number; y?: number; w?: number; h?: number; origin: 'human' | 'tool' }>): void
export function latestSeq(): number
export function emitSurfaceAction(surfaceId: string, action: Record<string, unknown>): void
export function emitUserMessage(text: string, agentId?: string): void
export function emitConnectorChange(provider: string, connected: boolean): void
/** The human placed a spatial annotation on a surface + asked the agent about that point (item 5b). */
export function emitAnnotation(surfaceId: string, text: string, anchor?: { xPct: number; yPct: number }, snapshot?: string): void
/** An OS-level event both inhabitants should know about (crash recovery, update, restore…). */
export function emitSystemMoment(kind: string, line: string, detail?: Record<string, unknown>): void
export function waitForEvents(since: number, maxMs: number, agentId?: string, workspace?: string | null): Promise<BlitzMoment[]>
/** Register the active-workspace provider; every emitted moment is stamped with it (v2 bleed fix). */
export function setWorkspaceProvider(fn: (() => string | null | undefined) | null): void
/** Register the host world-snapshot provider for the W2 supervisor tick (the transport wires it once). */
export function setTickSource(fn: (() => TickSnapshot | null | undefined) | null): void
/** Drop the tick diff baseline so the next emitTick RE-SEEDS instead of diffing — for a BULK transaction
 *  (workspace switch / hydrate / reconcile) where the whole world changes at once. */
export function resetTickBaseline(): void
/** Absorb the surface/agent deltas of a tool op the agent just made, so the NEXT tick skips exactly those
 *  ids (per-delta, one-shot) and the supervisor isn't self-woken on its own op. Timing-independent (replaces
 *  the old setTickSuppressed time window). A concurrent genuine edge in the same tick still wakes. */
export function absorbTickEcho(echo: { surfaces?: string[]; agents?: string[] }): void
/** Snapshot the host world, diff vs the prior tick, and emit ONE trigger:'tick' moment IFF the diff is material. */
export function emitTick(): void
export const EVENTS_REMINDER: string

/** In-page sensor installer (evaluate in a web surface). */
export const INJECT: string
/** Drains + clears the in-page signal buffer (evaluate in a web surface). */
export const DRAIN: string
