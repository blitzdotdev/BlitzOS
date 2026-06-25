// Type declarations for workflow-bus.mjs.
import type { WfEvent } from './blitzscript/progress.mjs'

export type StampedEvent = WfEvent & { seq: number; ts: number }
export interface RunBuffer { events: StampedEvent[]; subs: Set<(ev: StampedEvent) => void>; seq: number; done: boolean }

export function ensureRun(runId: string | null | undefined): RunBuffer | null
export function publish(ev: Record<string, unknown> & { runId?: string | null }): StampedEvent | null
export function subscribe(runId: string, cb: (ev: StampedEvent) => void): () => void
export function snapshot(runId: string | null | undefined): StampedEvent[]
export function isDone(runId: string | null | undefined): boolean
export function hydrate(runId: string | null | undefined, events: unknown[]): boolean
export function subCount(runId: string | null | undefined): number
export function clearRun(runId: string | null | undefined): void
export function _runCount(): number
