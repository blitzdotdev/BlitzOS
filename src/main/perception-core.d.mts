// Types for the shared perception kernel (perception-core.mjs).

export interface BlitzMoment {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  trigger: 'batch' | 'nav' | 'idle' | 'action' | 'select'
  windowMs: number
  signals: Record<string, number>
  user: string[]
  snapshot?: string
  action?: Record<string, unknown>
}

export function setContentShare(surfaceId: string, on: boolean): void
export function isContentShared(surfaceId: string): boolean
export function dropContentShare(surfaceId: string): void
export function redactMoment(m: BlitzMoment): BlitzMoment
export function ingestSignals(surfaceId: string, raw: Array<Record<string, unknown>>): void
export function latestSeq(): number
export function emitSurfaceAction(surfaceId: string, action: Record<string, unknown>): void
export function waitForEvents(since: number, maxMs: number): Promise<BlitzMoment[]>
export const EVENTS_REMINDER: string

/** In-page sensor installer (evaluate in a web surface). */
export const INJECT: string
/** Drains + clears the in-page signal buffer (evaluate in a web surface). */
export const DRAIN: string
