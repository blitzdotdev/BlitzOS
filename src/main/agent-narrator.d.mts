export interface Milestone {
  id: string
  ts: number
  kind: 'step' | 'ask' | 'result'
  text: string
}
export interface NarratorDeps {
  listAgents: () => string[]
  wsRoot: () => string | null
  claudeSidFor: (id: string) => string | null
  broadcast: (ev: Record<string, unknown>) => void
  intervalMs?: number
}
export interface Narrator {
  stop(): void
  milestones(id: string): Milestone[]
  tickNow(): Promise<void>
}
export function startNarrator(deps: NarratorDeps): Narrator
