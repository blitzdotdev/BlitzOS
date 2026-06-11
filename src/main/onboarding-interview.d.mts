// Types for the canned-interview core (onboarding-interview.mjs).

export interface CannedQuestion {
  id: string
  prompt: string
  options: string[]
  gap: RegExp
}

export interface CannedOps {
  say(text: string): void
  waitEvents(since: number, maxMs: number): Promise<{ seq?: number; trigger?: string; user?: string[] }[]>
  latestSeq(): number
  updateSurface(id: string, patch: Record<string, unknown>): unknown
  readBoard(): { ids: Record<string, string>; gapsItems?: { q?: string; done?: boolean }[] } | null
  readState(): { state?: string; answers?: Record<string, string> } | null
  writeState(obj: Record<string, unknown>): void
  writeProfile(md: string): void
  done(): void
}

export const STATIC_QUESTIONS: CannedQuestion[]
export function runCannedInterview(ops: CannedOps): Promise<Record<string, string>>
