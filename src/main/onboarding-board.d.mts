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

/** A surface as the lattice sees it (occupancy input): only slot fields matter. */
export interface StagedSurface {
  id: string
  slot?: { col: number; row: number; size: string }
  slotStage?: number
  minimized?: boolean
  groupId?: string
}

export interface BoardCard {
  role: string
  /** Library widget name; absent on the native unlock card. */
  widget?: string
  /** Native component name ('unlock') when the card is not a library widget. */
  native?: string
  title: string
  props: Record<string, unknown>
  /** Staged tile: the slot on the stage-0 lattice. */
  slot?: { col: number; row: number; size: string }
  slotStage?: number
  /** Lattice was full: parked below the stage frame at these world coords instead. */
  offstage?: boolean
  x?: number
  y?: number
  w?: number
  h?: number
}

export const UNLOCK_SIZE: string
export function unlockCardProps(appName: string): Record<string, unknown>
export function findUnlockSlot(surfaces: StagedSurface[] | null | undefined, viewport?: { w: number; h: number } | null): { slot: { col: number; row: number; size: string }; slotStage: number } | null
/** The hand-tuned Branch A fixed layout: role → {col,row,size}. `chat` is applied to the chat hub. */
export const BRANCH_A_LAYOUT: Record<string, { col: number; row: number; size: string }>
export function buildBoardPlan(
  scan: ScanJson,
  opts?: { surfaces?: StagedSurface[]; viewport?: { w: number; h: number } | null; layout?: Record<string, { col: number; row: number; size: string }> | null }
): BoardCard[]
