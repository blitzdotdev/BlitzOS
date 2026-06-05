import type { Observation } from './reasoner.mjs'

export function getObservations(limit?: number): Observation[]
export function startBrain(label?: string): () => void
