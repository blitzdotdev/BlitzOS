import type { BlitzMoment } from '../perception-core.mjs'

export interface Observation {
  seq: number
  ts: number
  surfaceId: string
  url?: string
  title?: string
  summary: string
  significant: boolean
  reasoned: boolean
}

export interface Reasoner {
  summarize(m: BlitzMoment): Promise<string>
}

export function summarize(m: BlitzMoment): Observation
export function claudeReasoner(): Reasoner
