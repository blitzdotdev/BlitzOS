// Types for the pure onboarding board planner (onboarding-board.mjs).

/** The slice of scan.json the board consumes (see buildJson in scripts/onboarding-scan.mjs). */
export interface ScanJson {
  meta: { v: number; generatedAt: number; fda: boolean; spanDays: number; nText: number; nEvents: number; fdaLocked: string[] }
  identity: { name: string | null; handle: string | null; computer: string | null; locale: { locale?: string }; defaultBrowser: string | null }
  cadence: {
    peakHours: number[]
    activeWeekdays: string[]
    punch: Record<string, number>
    topApps: { app: string; secs: number }[]
    appLaunches: { app: string; n: number }[]
  }
  projects: { name: string; prompts: number }[]
  repos: string[]
  stack: { name: string; n: number }[]
  tooling: { tool: string; n: number }[]
  people: { label: string; n: number; kind: 'hashed' | 'domain' | 'name'; via?: string | null }[]
  calendar: { upcoming: { title: string; start: number; allDay: boolean; attendees: boolean }[]; meetingsPerWeek: number }
  census: { kind: string; n: number }[]
  web: { webFirst: boolean; visits: number; devSignals: number; workflow: { host: string; name: string; n: number; color?: string; integration?: string }[] }
  voice: { text: string; source: string }[]
  sessions: { title: string; agent: string; last: number; project: string | null }[]
  facts: { dock: string[]; installedApps: number; accounts: string[] }
  gaps: string[]
}

export interface BoardCard {
  role: string
  widget: string
  title: string
  x: number
  y: number
  w: number
  h: number
  props: Record<string, unknown>
}

export const UNLOCK_POS: { x: number; y: number; w: number; h: number }
export function unlockCardProps(appName: string): Record<string, unknown>
export function buildBoardPlan(scan: ScanJson): BoardCard[]
