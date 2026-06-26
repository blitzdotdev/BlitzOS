// browserGrantStore — the browser-connection mini-onboarding ("Let BlitzOS Automation work in Chrome/Safari"). Kept MODULE-LEVEL
// so it survives the AttachPanel remounting while the user is in System Settings (a useState there was lost on the
// remount — grant ① lands → panel remounts → state gone). Browser-parameterized: Chrome has 3 grant steps, Safari
// has 1 (automation only — Safari has no other path). The store is the SINGLE OWNER of the island veil: HIDE on a
// "Grant" click, REVEAL only when that grant actually lands (the prompt was allowed, or the Settings poll detected
// the toggle). That single ownership is the fix for the racy hide/reveal. (House rule: no zustand.)
import { useSyncExternalStore } from 'react'
import { setPickSuspended } from './pickSuspendStore'

export type Browser = 'chrome' | 'safari'
export type BrowserStep = { grant: string; label: string; instruction: string }

// The MASTER ordered steps per browser. openBrowserOnboard() filters this to ONLY the grants not yet held, so the
// live `steps` can be a subset (or, for Safari, a single row).
export const BROWSER_STEPS: Record<Browser, BrowserStep[]> = {
  chrome: [
    { grant: 'automation:systemevents', label: 'System Events', instruction: 'In Automation, find BlitzOS Automation, click ▸ to expand, then turn on System Events.' },
    { grant: 'automation:chrome', label: 'Google Chrome', instruction: 'In Automation, find BlitzOS Automation, click ▸ to expand, then turn on Google Chrome.' },
    { grant: 'allowjs:chrome', label: 'Allow JavaScript from Apple Events', instruction: "Blitz opens Chrome's View ▸ Developer menu — click the highlighted row." }
  ],
  // Safari: automation is the ONLY grant (no System Events, no Allow-JS path).
  safari: [
    { grant: 'automation:safari', label: 'Safari', instruction: 'In Automation, find BlitzOS Automation, click ▸ to expand, then turn on Safari.' }
  ]
}

const BROWSER_LABEL: Record<Browser, string> = { chrome: 'Chrome', safari: 'Safari' }
export function browserLabel(browser: Browser): string {
  return BROWSER_LABEL[browser]
}

export type BrowserOnboard = { browser: Browser; steps: BrowserStep[]; granted: number; windowId?: number; busy: boolean }
let state: BrowserOnboard | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

type Api = {
  onboarding?: {
    requestGrant?: (g: string) => Promise<unknown>
    setIslandVeil?: (on: boolean) => void
    onGrantChanged?: (cb: (m: { grant: string; granted: boolean }) => void) => () => void
    browserGrantStates?: (browser: string) => Promise<Record<string, boolean>>
    closeChromeJsStep?: (immediate?: boolean) => Promise<unknown>
  }
  pick?: { stop?: () => Promise<void> }
}
const agentOS = (): Api | undefined => (window as unknown as { agentOS?: Api }).agentOS
const veil = (on: boolean): void => agentOS()?.onboarding?.setIslandVeil?.(on)

// Veil safety: the island must NEVER stay hidden indefinitely (e.g. the user clicked Grant, Settings opened, then
// they walked away without toggling). If a grant has not landed within this window we REVEAL the island anyway and
// keep the card so they can retry — the underlying grant poll can still advance the card later if they come back.
const VEIL_SAFETY_MS = 30_000
let veilSafetyTimer: ReturnType<typeof setTimeout> | null = null
function clearVeilSafety(): void {
  if (veilSafetyTimer) {
    clearTimeout(veilSafetyTimer)
    veilSafetyTimer = null
  }
}
function armVeilSafety(): void {
  clearVeilSafety()
  veilSafetyTimer = setTimeout(() => {
    veilSafetyTimer = null
    veil(false)
    if (state?.busy) {
      state = { ...state, busy: false }
      emit()
    }
  }, VEIL_SAFETY_MS)
}

// Register the grant-changed advance + REVEAL ONCE, at module level, so it fires even while AttachPanel is unmounted
// (the user is in Settings). On the ACTIVE step's grant landing: reveal the island, then advance (or finish).
let inited = false
function ensureListener(): void {
  if (inited) return
  inited = true
  agentOS()?.onboarding?.onGrantChanged?.((m) => {
    if (!m.granted || !state) return
    if (state.steps[state.granted]?.grant !== m.grant) return // not this flow's active step
    clearVeilSafety()
    veil(false) // REVEAL: this step's grant actually landed
    const next = state.granted + 1
    if (next >= state.steps.length) {
      state = null
      setPickSuspended(false) // all done → re-arm the picker
    } else {
      state = { ...state, granted: next, busy: false }
    }
    emit()
  })
}

/** Open the mini-onboarding for a browser. Suspends the picker IMMEDIATELY (sync) so it can't grab a window during
 *  the probe, then asks main which grants are still missing and shows ONLY those rows. If nothing is missing there is
 *  nothing to onboard — re-arm and let the connector list refresh (the tabs appear on their own). */
export function openBrowserOnboard(browser: Browser, windowId?: number): void {
  ensureListener()
  setPickSuspended(true)
  void buildAndOpen(browser, windowId)
}

async function buildAndOpen(browser: Browser, windowId?: number): Promise<void> {
  const states: Record<string, boolean> =
    (await agentOS()?.onboarding?.browserGrantStates?.(browser).catch(() => ({}) as Record<string, boolean>)) || {}
  const steps = BROWSER_STEPS[browser].filter((s) => states[s.grant] !== true)
  if (!steps.length) {
    state = null
    setPickSuspended(false)
    emit()
    return
  }
  state = { browser, steps, granted: 0, windowId, busy: false }
  emit()
}

export function closeBrowserOnboard(): void {
  clearVeilSafety()
  // Tear down any open Chrome View ▸ Developer menu/helper if the user bailed mid Allow-JS step (no-op otherwise).
  void agentOS()?.onboarding?.closeChromeJsStep?.(true)
  state = null
  setPickSuspended(false) // card fully closed / dismissed → re-arm the picker
  veil(false)
  emit()
}

/** Click "Grant" on the active row. STOP the picker overlay FIRST (awaited) so a macOS prompt is clickable, HIDE the
 *  island so the prompt / System Settings is the focus, then fire that step's grant. The island stays hidden until
 *  the grant lands (the module listener reveals + advances) or the safety timer trips. */
export async function grantActiveStep(): Promise<void> {
  if (!state || state.busy) return
  const step = state.steps[state.granted]
  if (!step) return
  state = { ...state, busy: true }
  emit()
  await agentOS()?.pick?.stop?.() // overlay gone before any prompt fires
  veil(true) // HIDE: the macOS prompt or System Settings is what the user should focus on now
  armVeilSafety()
  void agentOS()?.onboarding?.requestGrant?.(step.grant)
  // Clear the button's "Waiting…" after a beat even if the grant is still pending (the Settings path has no inline
  // success signal until the user toggles it). The veil/advance is driven by os:grant-changed, NOT this.
  setTimeout(() => {
    if (state?.busy) {
      state = { ...state, busy: false }
      emit()
    }
  }, 3500)
}

export function useBrowserOnboard(): BrowserOnboard | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
