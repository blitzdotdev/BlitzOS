import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDesktop, type CreateSurfaceInput } from './store'
import { applyTheme, saveTheme, type Theme } from './theme'
import { pushTerminalData, pushTerminalExit } from './terminalStream'
import type { Surface } from './types'
import { isRuntimePanel } from './types'
import { NotchHost } from './notch/NotchHost'
import { GlanceBar, type GlancePeek } from './notch/GlanceBar'
import { markDone, clearDone, reconcileDone } from './notch/doneStore'
import { isOnboardingHoverLocked } from './notch/onboardingHoverLock'
import { requestIslandView } from './notch/islandNavStore'
import type { IslandAppMessagePart, IslandView } from './notch/types'
import { ConnectPicker } from './components/ConnectPicker'
import { IconCheck } from './components/Icons'
import { shouldShowOnboarding, markOnboarded } from './onboarding/config'
import { CinematicIntro } from './CinematicIntro'
import { triggerCinematic, doneCinematic, isCinematicActive, useCinematicActive } from './cinematicStore'

type ThemeMode = 'light' | 'dark'
// ! DEBUG: temporary bottom-right agent backend selector.
type AgentRuntimeChoice = 'codex-serverless' | 'claude'
type AgentRuntimeDebugStatus = {
  ok: boolean
  runtime: string | null
  label: string | null
  available: { codex: boolean; claude: boolean }
  error?: string
}
type TerminalListEntry = { id?: string; title?: string; status?: string; kind?: string; stage?: number | null; area?: number | null }
const THEME_STORAGE_KEY = 'blitzos.theme'
const NOTCH_HOVER_OPEN_GRACE_MS = 220
const NOTCH_HOVER_CLOSE_DELAY_MS = 90
const NOTCH_HOVER_RESCHEDULE_PAD_MS = 30
const NOTCH_CHASSIS_KEEPALIVE_MS = 180
// Turning the attach panel OFF holds the island open this long even if the cursor has already left it, so closing
// attach never yanks the island shut under the user. DO NOT REMOVE this heuristic (pinned in agent-os/CLAUDE.md).
const NOTCH_ATTACH_CLOSE_HOLD_MS = 1500

function systemTheme(): ThemeMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readInitialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'dark' || stored === 'light' ? stored : systemTheme()
}

// ── The Notch (dynamic island) — THE MERGE: the real canvas window IS the notch. #root-canvas is clipped to a
// macOS-NotchShape. notchPath + the two stops (closed notch → hover panel) are ported from the validated
// notch-spill PoC; the renderer's opaque .bg paints the canvas color the clip reveals.
const NOTCH_W = 200
// Hover/click zone around the nudge: a small box centered on the notch (where the peek pill sits), NOT the whole
// notch. Keep in sync with NOTCH_HIT_W/H in main/notch-overlay.ts (the native hit-window uses the same).
const NOTCH_HIT_W = 44
const NOTCH_HIT_H = 22
// Pull the VISIBLE nudge pill up this many px so it tucks toward the notch instead of hanging low. Visual only — the
// hover/click zone is compensated below so it stays centered on the notch where the cursor actually goes.
const NOTCH_NUDGE_DY = 24
// inset() (a rounded-rect reveal), NOT clip-path: path() with curves. inset interpolates as plain numbers, so the
// clip is cheap and GPU-composited (with will-change). The rounded-bottom rect IS the dynamic-island look (top
// flush with the screen edge, bottom rounded). vw/vh/notchH in CSS px.
function notchClipFor(state: 'closed' | 'panel', vw: number, vh: number, notchH: number, notchW: number = NOTCH_W): string {
  // V1 (island-only, no canvas): closed AND panel both clip #root-canvas to the bare notch pill. The island UI is
  // the NotchHost body-portal, rendered OUTSIDE #root-canvas, so the clip only ever shows the pill. (The old 'open'
  // state grew the clip to reveal the infinite canvas — cut with the canvas.)
  const sx = Math.max(0, (vw - notchW) / 2)
  const h = Math.max(28, notchH)
  return `inset(0px ${sx}px ${Math.max(0, vh - h)}px ${sx}px round 0px 0px 16px 16px)`
}

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)

  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme())
  // Agent relay connection health, broadcast by the backend (server mode). null = unknown/not reported yet.
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  // Native fullscreen hides the custom titlebar (macOS auto-hides the traffic lights).
  const [shellFullscreen, setShellFullscreen] = useState(false)

  // ── The Notch (dynamic island). The real window IS the notch. We clip #root-canvas to the NotchShape; main
  // toggles the window click-through via os:notch-interactive as we report the notch-hover. closed = black notch
  // (the handle); panel = hover entry (the island chassis).
  const viewport = useDesktop((s) => s.viewport)
  const [notchOn, setNotchOn] = useState(false) // true once main pushes geometry (overlay mode only)
  const [notchState, setNotchState] = useState<'closed' | 'panel'>('closed')
  const [notchMenuBarH, setNotchMenuBarH] = useState(38)
  // The EXACT physical notch (from the native CLI via os:notch-geometry): width drives the visual pill + the clip;
  // hasNotch gates the pill (no notch → no click band, ⌥Space only). The toggle CLICK + hover come from the always-
  // interactive notch hit-window (main), so they are bulletproof + constant in every state (no click-through race).
  const [notchWidth, setNotchWidth] = useState(NOTCH_W)
  const [hasNotch, setHasNotch] = useState(false)
  // The island RESTORES its last view + tab on EVERY open (hover OR ⌥Space), instead of resetting to Home. NotchHost
  // reports its view+page via onStateChange; we stash them in refs and feed them back as initialView/initialPage on
  // the next open (NotchHost remounts per open). Refs, not state, so updating them never re-renders App.
  const islandViewRef = useRef<IslandView>('session')
  const islandPageRef = useRef(1) // default to the first agent tab (Blitz '0'); page 0 (the old composer) is retired
  // Also remember the attach panel (open/closed) so reopening the island restores it, not just the view+tab. (The
  // per-chat staging TRAY lives in stagingStore — a module store that survives the remount on its own.)
  const islandAttachOpenRef = useRef(false)
  const islandActiveAppRef = useRef<IslandAppMessagePart | null>(null)
  const [islandKeepMounted, setIslandKeepMounted] = useState(false)
  const onIslandStateChange = (
    view: IslandView,
    page: number,
    attachOpen: boolean,
    activeApp: IslandAppMessagePart | null
  ): void => {
    const previousView = islandViewRef.current
    islandViewRef.current = view
    islandPageRef.current = page
    islandAttachOpenRef.current = attachOpen
    islandActiveAppRef.current = activeApp
    setIslandKeepMounted(Boolean(activeApp))
    if (previousView !== view) {
      window.agentOS?.activity?.track('island.view_changed', { view, previousView, source: 'renderer' })
      if (view === 'settings') window.agentOS?.activity?.track('settings.opened', { source: 'renderer' })
    }
  }
  const overChassisRef = useRef(false) // cursor over the chat chassis (overlay mousemove) — keeps the panel open
  const notchOverRef = useRef(false) // cursor over the physical notch (reported by the hit-window's hover)
  const notchHoverGraceRef = useRef(0) // close grace so a notch→chassis transit does not flicker the panel shut
  const [notchAnimating, setNotchAnimating] = useState(false) // during the panel collapse: freeze widget MOTION (not visibility) so the texture is static
  // PINNED panel (item 2): a KEYBOARD-opened panel (⌥Space) stays open regardless of mouse position — the hover
  // mousemove handler must not auto-close it and must keep the window interactive while pinned. A HOVER-opened
  // (un-pinned) panel keeps the original follow-the-mouse behaviour. Cleared on enter / close / retract.
  const [notchPinned, setNotchPinned] = useState(false)
  const notchPinnedRef = useRef(false)
  // Aggregate agent activity for the COLLAPSED notch's live compact presentation (working / needs-you / total).
  // GlancePeek also carries the per-agent list so the glance bar shows one avatar per active agent.
  const [notchPeek, setNotchPeek] = useState<GlancePeek>({ working: 0, attn: 0, err: 0, total: 0, agents: [] })
  // Previous per-agent status from the last chat broadcast — lets the broadcast handler spot the working→idle edge
  // ("this agent just finished") and raise its DONE pip in the glance bar (doneStore). Renderer-only, not persisted.
  const prevAgentStatusRef = useRef<Map<string, string>>(new Map())
  const setNotchPinnedBoth = (on: boolean): void => {
    notchPinnedRef.current = on
    setNotchPinned(on)
  }
  const notchStateRef = useRef<'closed' | 'panel'>('closed')
  const notchHandleRef = useRef<HTMLDivElement>(null)
  const notchLastIRef = useRef<boolean | null>(null)
  // Grace timestamp: hold the island open (skip the hover auto-close) until this time. Set when the chassis
  // RESIZES (attach panel / peek toggle) so a shrink can't pull the chassis out from under the cursor and make
  // the hover handler immediately hide the whole island. NotchHost stamps it via onChassisResize.
  const notchHoldUntilRef = useRef(0)
  // The attach panel (the macOS window picker) is open → keep the island OPEN + interactive (an extra pin source,
  // like ⌥Space) so the cursor can leave the chassis to hover/drag other windows without the island retracting.
  const notchAttachOpenRef = useRef(false)
  const glanceOverRef = useRef(false) // cursor in the glance-bar zone (the menu-bar band near the notch) — keeps the island open
  // VEIL (onboarding drag step): the island is hidden (opacity 0 via body.island-veiled) but stays MOUNTED, so the
  // drag-helper window it owns is never torn down. While veiled it must be fully click-through so System Settings is
  // usable through it, so this is the chokepoint that forces interactive off regardless of what any hover path wants.
  const notchVeiledRef = useRef(false)
  // SYNTHETIC (VM) MODE: main detected a notch-less hypervisor display where the hit-window can't exist and hover
  // can't open the island. When on, the island is pinned OPEN + interactive and retraction is disabled (the pin
  // already blocks both retract paths); the close / toggle-hide paths are no-ops so it can never get stranded shut.
  const syntheticRef = useRef(false)
  const setNotchInteractive = (on: boolean): void => {
    if (notchVeiledRef.current) on = false
    if (notchLastIRef.current === on) return
    notchLastIRef.current = on
    try {
      window.agentOS?.notch?.setInteractive(on)
    } catch {
      /* no bridge (non-overlay) */
    }
  }
  const applyNotchState = (s: 'closed' | 'panel'): void => {
    const previous = notchStateRef.current
    notchStateRef.current = s
    setNotchState(s)
    if (previous !== s) window.agentOS?.activity?.track(s === 'panel' ? 'island.opened' : 'island.closed', { source: 'renderer' })
  }
  const scheduleNotchHoverClose = (delay = NOTCH_HOVER_CLOSE_DELAY_MS): void => {
    if (notchHoverGraceRef.current) clearTimeout(notchHoverGraceRef.current)
    notchHoverGraceRef.current = window.setTimeout(() => {
      notchHoverGraceRef.current = 0
      // Onboarding TCC permission step locks hover retraction at the CHOKEPOINT: every hover-close caller (the
      // notch hit-window hover-out, the glance bar, the mousemove handler) funnels through here, so checking the
      // lock here is what actually keeps the island open while the user drags the icon out to Settings. ⌥Space /
      // Esc close directly (not via this path), so they still work.
      if (notchPinnedRef.current || notchAttachOpenRef.current || isOnboardingHoverLocked() || notchStateRef.current !== 'panel') return
      if (notchOverRef.current || overChassisRef.current || glanceOverRef.current) return
      const holdRemaining = notchHoldUntilRef.current - performance.now()
      if (holdRemaining > 0) {
        scheduleNotchHoverClose(Math.min(holdRemaining + NOTCH_HOVER_RESCHEDULE_PAD_MS, NOTCH_HOVER_OPEN_GRACE_MS))
        return
      }
      applyNotchState('closed')
      setNotchInteractive(false)
    }, delay)
  }
  const setChassisHover = (on: boolean): void => {
    overChassisRef.current = on
    if (on) {
      if (notchHoverGraceRef.current) {
        clearTimeout(notchHoverGraceRef.current)
        notchHoverGraceRef.current = 0
      }
      if (notchStateRef.current === 'panel') {
        notchHoldUntilRef.current = performance.now() + NOTCH_CHASSIS_KEEPALIVE_MS
        setNotchInteractive(true)
      }
    } else {
      scheduleNotchHoverClose()
    }
  }
  // The attach panel (macOS window picker) opened/closed. While OPEN the island is pinned open + interactive so the
  // cursor can leave the chassis to hover/drag other windows; on CLOSE, resume normal hover (retract if already away).
  const onIslandAttachChange = (open: boolean): void => {
    notchAttachOpenRef.current = open
    if (open) {
      if (notchHoverGraceRef.current) {
        clearTimeout(notchHoverGraceRef.current)
        notchHoverGraceRef.current = 0
      }
      setNotchInteractive(true)
    } else {
      // Heuristic (DO NOT REMOVE — pinned in agent-os/CLAUDE.md): turning attach OFF holds the island open for
      // ~1.5s even if the cursor has already left it, so collapsing the attach panel never yanks the island shut
      // under the user. notchHoldUntilRef defers the hover auto-close (scheduleNotchHoverClose respects it).
      notchHoldUntilRef.current = performance.now() + NOTCH_ATTACH_CLOSE_HOLD_MS
      if (!overChassisRef.current && !notchOverRef.current && !notchPinnedRef.current) scheduleNotchHoverClose()
    }
  }
  // ⌥Space TOGGLE: the generic "show/hide the dynamic island" keybind. closed → panel (PINNED open, RESTORED to the
  // last view+tab — not forced to a new session); anything shown → closed (hide). A pure toggle, no staircase.
  const notchToggleAtRef = useRef(0)
  const toggleIsland = (): void => {
    // Swallow OS key auto-repeat: holding ⌥Space machine-guns the globalShortcut (~30ms apart), which would
    // flicker show/hide. A deliberate human re-tap is slower than this, so a 120ms floor keeps it.
    const now = performance.now()
    if (now - notchToggleAtRef.current < 120) return
    notchToggleAtRef.current = now
    // A deliberate ⌥Space always clears the onboarding veil: the user wants the island back, visible + interactive.
    if (notchVeiledRef.current) {
      notchVeiledRef.current = false
      document.body.classList.remove('island-veiled')
    }
    if (notchStateRef.current === 'closed') {
      setNotchPinnedBoth(true) // a keyboard-opened panel stays open regardless of the mouse
      setNotchInteractive(true)
      applyNotchState('panel') // opens to the LAST view+tab (islandViewRef/islandPageRef), not a forced new session
    } else if (!syntheticRef.current) {
      // hide (panel → closed) — but in VM/synthetic mode the island stays put (⌥Space can't reliably reopen it)
      setNotchPinnedBoth(false)
      setNotchAnimating(true) // freeze widget motion during the collapse (smooth)
      applyNotchState('closed')
      notchLastIRef.current = null
      setNotchInteractive(false)
    }
  }
  // Geometry (the menu-bar height = the notch height) + enable the notch (overlay mode only).
  useEffect(
    () =>
      window.agentOS?.notch?.onGeometry?.((g) => {
        setNotchMenuBarH(g.menuBarH > 0 ? g.menuBarH : 38)
        setNotchWidth(g.hasNotch ? (g.notchWidth && g.notchWidth > 0 ? g.notchWidth : NOTCH_W) : 0)
        setHasNotch(!!g.hasNotch)
        setNotchOn(true)
        // VM / notch-less: pin the island OPEN + interactive so it is reachable without a hit-window or hover.
        if (g.synthetic && !syntheticRef.current) {
          syntheticRef.current = true
          setNotchPinnedBoth(true)
          applyNotchState('panel')
          setNotchInteractive(true)
        }
      }),
    []
  )
  // Collapse the island (panel → closed). Shared by Esc and the main-driven os:notch-close.
  const closeIsland = (): void => {
    if (syntheticRef.current) return // VM/synthetic: the island never closes (no hit-window/hover to reopen it)
    if (notchVeiledRef.current) {
      notchVeiledRef.current = false
      document.body.classList.remove('island-veiled')
    }
    if (notchStateRef.current === 'closed') return
    setNotchPinnedBoth(false)
    setNotchAnimating(true) // freeze widget motion during the collapse (smooth)
    applyNotchState('closed')
    notchLastIRef.current = null
    setNotchInteractive(false)
  }
  // ⌥Space toggles the island show/hide (closed ↔ panel), restoring the last view+tab.
  useEffect(() => window.agentOS?.notch?.onToggle?.(() => toggleIsland()), [])
  // Main asks us to collapse — an outbound link in an app preview just opened in the real browser.
  useEffect(() => window.agentOS?.notch?.onClose?.(() => closeIsland()), [])
  // Native menu bar "Settings… ⌘," → open + pin the island and navigate it to the Settings view. islandViewRef
  // covers the case where the island is CLOSED (NotchHost reads it as initialView on its next mount);
  // requestIslandView covers the case where it is ALREADY OPEN (pushes setView into the live NotchHost). The chat
  // tab (NotchHost `page`) + the half-typed draft (draftStore, keyed by agent id) survive the round-trip untouched.
  const openIslandSettings = (): void => {
    if (notchVeiledRef.current) {
      notchVeiledRef.current = false
      document.body.classList.remove('island-veiled')
    }
    islandViewRef.current = 'settings'
    if (notchStateRef.current === 'closed') {
      setNotchPinnedBoth(true) // a menu-opened panel stays open (like ⌥Space) so Settings doesn't hover-retract
      setNotchInteractive(true)
      applyNotchState('panel')
    } else {
      setNotchPinnedBoth(true)
      setNotchInteractive(true)
    }
    requestIslandView('settings')
  }
  useEffect(() => window.agentOS?.notch?.onShowSettings?.(() => openIslandSettings()), [])
  // Main asks us to VEIL the island (onboarding drag step) or unveil it. Veil = invisible + click-through but still
  // MOUNTED (a collapse here would unmount onboarding and close its drag-helper). On veil, immediately go
  // click-through; on unveil, the next hover restores interactivity.
  useEffect(
    () =>
      window.agentOS?.notch?.onVeil?.((on) => {
        notchVeiledRef.current = on
        document.body.classList.toggle('island-veiled', on)
        if (on) setNotchInteractive(false)
        else if (syntheticRef.current) setNotchInteractive(true) // synthetic: no hover to restore interactivity after a veil
      }),
    []
  )
  // The notch HIT-WINDOW (the always-interactive transparent window over the physical notch) drives the toggle +
  // hover, so the notch is clickable in EVERY state with no click-through→arm race. CLICK → toggle the island panel.
  // Brandon's guard (only fire when closed → a stray click can't toggle the open panel shut) + the generic
  // toggleIsland (restores the last view+tab, not a forced new session).
  useEffect(
    () =>
      window.agentOS?.notch?.onHandleClick?.(() => {
        if (notchStateRef.current === 'closed') toggleIsland()
      }),
    []
  )
  // HOVER → open the chat panel (peek), like the old hover-the-notch behavior, but reported by the hit-window since
  // it sits on top of the notch. The overlay mousemove keeps it open while over the chassis; a grace covers the
  // notch→chassis transit so it does not flicker shut.
  useEffect(
    () =>
      window.agentOS?.notch?.onHandleHover?.((on) => {
        notchOverRef.current = on
        if (on) {
          if (notchHoverGraceRef.current) {
            clearTimeout(notchHoverGraceRef.current)
            notchHoverGraceRef.current = 0
          }
          notchHoldUntilRef.current = performance.now() + NOTCH_HOVER_OPEN_GRACE_MS
          if (notchStateRef.current === 'closed' && !isOnboardingHoverLocked()) {
            applyNotchState('panel') // restores the LAST view+tab (islandViewRef/islandPageRef), not always Home
          }
          setNotchInteractive(true)
        } else {
          scheduleNotchHoverClose()
        }
      }),
    []
  )
  // While the island is shown, Esc closes it (capture phase, preventDefault) so it never falls through to a surface.
  useEffect(() => {
    if (!notchOn) return
    const onKey = (e: KeyboardEvent): void => {
      if (notchStateRef.current === 'closed') return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeIsland()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [notchOn])
  // Hover → interactive region: collapsed = only the notch handle (then expand to the panel).
  // The window is click-through (main set ignoreMouseEvents) so the renderer flips it via os:notch-interactive.
  useEffect(() => {
    if (!notchOn) return
    const onMove = (e: MouseEvent): void => {
      const st = notchStateRef.current
      const r = notchHandleRef.current?.getBoundingClientRect()
      // hover-open hugs the nudge: a small box centered on the notch (the peek pill is centered there), NOT the full
      // handle — so hovering the empty notch around the nudge no longer opens the island. Visual pill is unchanged.
      // +NOTCH_NUDGE_DY cancels the pill's visual lift so the hover box stays centered on the notch, not the pill.
      const overHandle =
        !!r &&
        Math.abs(e.clientX - (r.left + r.right) / 2) <= NOTCH_HIT_W / 2 &&
        Math.abs(e.clientY - ((r.top + r.bottom) / 2 + NOTCH_NUDGE_DY)) <= NOTCH_HIT_H / 2
      // The shown panel is the NotchHost portal (the .nh-chassis shell) — measure ITS real rect (+ a small slop and a
      // DOM hit-test) so a hover-opened panel stays open while the cursor is anywhere over it (its size varies).
      const panelEl = document.querySelector('.nh-chassis') as HTMLElement | null
      const pr = panelEl?.getBoundingClientRect()
      const panelHitSlop = 10
      const inPanelRect =
        !!pr &&
        e.clientX >= pr.left - panelHitSlop &&
        e.clientX <= pr.right + panelHitSlop &&
        e.clientY >= pr.top - panelHitSlop &&
        e.clientY <= pr.bottom + panelHitSlop
      const hitEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const inPanelDom = !!hitEl?.closest?.('.nh-chassis')
      const inPanel = inPanelRect || inPanelDom
      overChassisRef.current = inPanel
      // OVER THE ISLAND = over the physical notch handle/notch, or over the open chassis. This ALONE drives
      // click-through: ONLY the island's own pixels capture the mouse, so the rest of the full-display overlay stays
      // click-through and the rest of macOS is clickable everywhere else — even while the island is PINNED open
      // (⌥Space) or the attach panel is up. "Keep open" (pin / attach / grace) is a VISIBILITY decision, fully
      // decoupled from capture below; nothing ever forces the whole window interactive off the island.
      const want = overHandle || notchOverRef.current || (st === 'panel' && inPanel)
      if (want && notchHoverGraceRef.current) {
        clearTimeout(notchHoverGraceRef.current)
        notchHoverGraceRef.current = 0
      }
      if ((overHandle || notchOverRef.current) && st === 'closed' && !isOnboardingHoverLocked()) {
        applyNotchState('panel') // hovering the notch opens the panel (restores the LAST view+tab, not always Home)
      } else if (st === 'panel' && !want) {
        // The cursor left the island. RETRACT only if nothing is holding it open: a ⌥Space pin, the attach panel, the
        // post-resize / attach-close grace window, or the onboarding TCC permission step (the user drags the icon out
        // to Settings, so hover must not retract the island there). A held panel stays VISIBLE but still goes
        // click-through (setNotchInteractive(want) below), so the Dock / menu bar / other apps stay clickable off it.
        const heldOpen = notchPinnedRef.current || notchAttachOpenRef.current || performance.now() < notchHoldUntilRef.current || isOnboardingHoverLocked()
        if (!heldOpen) scheduleNotchHoverClose(120)
      }
      setNotchInteractive(want)
    }
    window.addEventListener('mousemove', onMove, true)
    return () => window.removeEventListener('mousemove', onMove, true)
  }, [notchOn])
  // HOVER-TO-OPEN from the GLANCE BAR: the overlay forwards mousemove even while closed/click-through, so when the
  // cursor enters either glance bar (the menu-bar band hugging the notch) we open the island — same as hovering the
  // notch. Registered AFTER the notch-hover effect so its setNotchInteractive(true) wins while over a bar; the close
  // path is held off by glanceOverRef (set here, checked in scheduleNotchHoverClose). Bail unless in the top band.
  useEffect(() => {
    if (!notchOn) return
    const onMove = (e: MouseEvent): void => {
      const inZone =
        e.clientY <= Math.max(28, notchMenuBarH) + 6 && Math.abs(e.clientX - window.innerWidth / 2) <= notchWidth / 2 + 300
      glanceOverRef.current = inZone
      if (notchStateRef.current === 'closed') {
        if (!inZone) return
        // OPEN only when actually over a visible bar (not the empty zone / the notch itself, which the hit-window owns).
        const x = e.clientX
        const y = e.clientY
        const overBar = ['.glance-left', '.glance-right'].some((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect()
          return !!r && x >= r.left - 4 && x <= r.right + 4 && y >= r.top && y <= r.bottom + 6
        })
        if (!overBar) return
        if (notchHoverGraceRef.current) {
          clearTimeout(notchHoverGraceRef.current)
          notchHoverGraceRef.current = 0
        }
        notchHoldUntilRef.current = performance.now() + NOTCH_HOVER_OPEN_GRACE_MS
        if (!isOnboardingHoverLocked()) applyNotchState('panel')
        setNotchInteractive(true)
        return
      }
      // Already open: keep it alive while anywhere in the zone; leaving it schedules a close (overChassisRef wins).
      if (inZone) {
        if (notchHoverGraceRef.current) {
          clearTimeout(notchHoverGraceRef.current)
          notchHoverGraceRef.current = 0
        }
        notchHoldUntilRef.current = performance.now() + NOTCH_HOVER_OPEN_GRACE_MS
        setNotchInteractive(true)
      } else {
        scheduleNotchHoverClose()
      }
    }
    window.addEventListener('mousemove', onMove, true)
    return () => window.removeEventListener('mousemove', onMove, true)
  }, [notchOn, notchMenuBarH, notchWidth])
  const notchClip = notchOn
    ? notchClipFor(notchState, viewport.w || window.innerWidth, viewport.h || window.innerHeight, notchMenuBarH, notchWidth)
    : undefined
  // Native-fullscreen chrome reveal: in APP (shell) fullscreen the title bar slides off the top and
  // returns when the pointer hits the very top edge — exactly like a native macOS fullscreen window, so
  // the traffic lights (and the green EXIT light) are always one gesture away. The revealed bar sits just
  // below the macOS menu bar that overlays the top on hover. Esc exits too (a convenience on top of it).
  const [titlebarRevealed, setTitlebarRevealed] = useState(false)
  const titlebarRevealedRef = useRef(false)
  useEffect(() => {
    if (!shellFullscreen) {
      if (titlebarRevealedRef.current) {
        titlebarRevealedRef.current = false
        setTitlebarRevealed(false)
      }
      return
    }
    const onMove = (e: globalThis.PointerEvent): void => {
      // reveal at the very top edge; keep it shown while the pointer stays within the revealed bar (hysteresis)
      const next = titlebarRevealedRef.current ? e.clientY <= 70 : e.clientY <= 2
      if (next !== titlebarRevealedRef.current) {
        titlebarRevealedRef.current = next
        setTitlebarRevealed(next)
      }
    }
    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [shellFullscreen])
  useEffect(() => {
    if (!shellFullscreen) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || useDesktop.getState().pageFullscreenId) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return // Esc cancels the field, not fullscreen
      // Native window-fullscreen exit is via the green light / Ctrl+Cmd+F; the os:shell-fullscreen IPC bridge
      // was removed with the sandwich (the notch never native-fullscreens — its "fullscreen" is the clip-grow).
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shellFullscreen])
  // Fallback shell-fullscreen detection for the NORMAL (non-notch) window only — the notch overlay is always
  // full-display, so window.innerHeight === screen.height would false-positive. The notch never enters native
  // fullscreen (its "fullscreen" is the renderer clip-grow), so guarding on !notchOn is correct.
  useEffect(() => {
    if (notchOn) return
    const sync = (): void => setShellFullscreen(!!document.fullscreenElement || window.innerHeight === screen.height)
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [notchOn])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (): void => {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
      if (stored !== 'dark' && stored !== 'light') setTheme(mq.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding())
  const cinematicActive = useCinematicActive()
  // While the cinematic plays, bars are held tucked into the notch (is-open). At spring-settle we
  // flip to false → the existing CSS transition slides them out. Overrides the normal notchState-based open.
  const [cinematicGlanceOpen, setCinematicGlanceOpen] = useState(false)
  const isServer = !!window.agentOS?.serverMode

  // Onboarding auto-OPENS on launch so the first slide is visible without hovering the notch — but it is NOT pinned:
  // normal hover behaviour (hover the notch to peek, glide away to dismiss, ⌥Space) all work. The hold below keeps it
  // up long enough to notice; slide changes (which resize the chassis) re-stamp the hold via onIslandHoldOpen so a
  // step never yanks the island shut under the cursor — a genuine hover-away still closes it after the hold.
  useEffect(() => {
    if (!onboarding || isServer || !notchOn) return
    // Pre-stage the island view so it's ready when the cinematic hands off.
    islandViewRef.current = 'onboarding'
    islandPageRef.current = 1
    islandAttachOpenRef.current = false
    islandActiveAppRef.current = null
    setIslandKeepMounted(false)
    setNotchInteractive(true)
    notchHoldUntilRef.current = performance.now() + NOTCH_ATTACH_CLOSE_HOLD_MS
    // Play the cinematic intro instead of opening the island directly.
    // The cinematic's onComplete callback calls applyNotchState('panel') after the animation.
    setNotchPeek({ working: 0, attn: 0, err: 0, total: 3, agents: [
      { id: '0', status: 'working' },
      { id: '5', status: 'working' },
      { id: '1', status: 'working' },
    ]})
    setCinematicGlanceOpen(true)
    triggerCinematic()
  }, [onboarding, isServer, notchOn])

  const completeIslandOnboarding = (): void => {
    markOnboarded()
    setOnboarding(false)
    islandViewRef.current = 'session' // land straight in Blitz's chat, not the home grid
    islandPageRef.current = 1
    islandAttachOpenRef.current = false
    islandActiveAppRef.current = null
    setIslandKeepMounted(false)
    setNotchInteractive(true)
    applyNotchState('panel')
  }

  // ! DEBUG: runtime switch state is intentionally UI-only; the selected value is persisted in main.
  const [agentRuntimeDebug, setAgentRuntimeDebug] = useState<AgentRuntimeDebugStatus | null>(null)
  const [agentRuntimePending, setAgentRuntimePending] = useState<AgentRuntimeChoice | null>(null)

  useEffect(() => {
    if (isServer) return
    let alive = true
    window.agentOS?.agentRuntimeGet?.().then((status) => {
      if (alive) setAgentRuntimeDebug(status)
    }).catch(() => {
      if (alive) setAgentRuntimeDebug(null)
    })
    return () => { alive = false }
  }, [isServer])

  const chooseAgentRuntime = async (runtime: AgentRuntimeChoice): Promise<void> => {
    if (agentRuntimePending || agentRuntimeDebug?.runtime === runtime) return
    setAgentRuntimePending(runtime)
    try {
      const status = await window.agentOS?.agentRuntimeSet?.(runtime)
      if (status) setAgentRuntimeDebug(status)
    } finally {
      setAgentRuntimePending(null)
    }
  }
  const [aiCopied, setAiCopied] = useState(false)
  // Phase 2: true once the backend has sent (or declined) a hydrate. The state-push is
  // gated on this so a freshly-loaded renderer can't post its empty store and clobber the
  // restored state before hydration arrives.
  const hydrated = useRef(false)
  // The active workspace name, mirrored into a ref so the state-push closure (an effect with []
  // deps) reads the CURRENT value — each push is tagged with it so the backend can drop a stale
  // push that belongs to a workspace we already switched away from (else it corrupts the new folder).
  const activeWsRef = useRef<string | null>(null)
  const [connectPicker, setConnectPicker] = useState(false) // the "Connect a tab/window" picker overlay

  useEffect(() => {
    if (!showAi) setAiCopied(false)
  }, [showAi])

  useEffect(() => {
    setAiCopied(false)
  }, [aiUrl])

  async function copyAiUrl(): Promise<void> {
    if (!aiUrl) return
    await navigator.clipboard?.writeText(aiUrl)
    setAiCopied(true)
  }

  function chooseTheme(next: ThemeMode): void {
    setTheme(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }

  useEffect(() => {
    const onResize = (): void => {
      useDesktop.getState().setViewport(window.innerWidth, window.innerHeight)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Open/focus a terminal tab (idempotent). Shared by the live terminal-spawn action and resume-on-load —
  // the placement + add-tab-or-create logic lives in the store action so callers stay in sync.
  function ensureTerminalTab(tid: string, title: string, stage?: number | null): void {
    useDesktop.getState().openTerminal(tid, title || 'Terminal', stage)
  }

  // Hiding an agent terminal is only a renderer/tab concern. It must never stop tmux, kill the agent,
  // or remove the terminal record; the chat widget remains the normal agent interface.
  function closeAgentTerminalTabs(agentIds: Set<string>): void {
    if (!agentIds.size) return
    const st = useDesktop.getState()
    for (const w of [...st.surfaces]) {
      if (w.kind !== 'native' || w.component !== 'terminal' || !w.tabs?.length) continue
      for (const tab of w.tabs) {
        if (tab.terminalId && agentIds.has(tab.terminalId)) st.closeTab(w.id, tab.id)
      }
    }
  }

  // The Action-items inbox docks TOP-RIGHT of the current view, so a pushed task is visible.
  function inboxSurfaceInput(items: Array<Record<string, unknown>>): CreateSurfaceInput {
    const st = useDesktop.getState()
    const { scale, x: tx, y: ty } = st.transform
    const W = 320
    const H = 300
    const x = Math.round((st.viewport.w - tx) / scale - W - 24)
    const y = Math.round(-ty / scale + 24)
    return { kind: 'native', component: 'inbox', title: 'Action items', w: W, h: H, x, y, props: { items } }
  }

  // Merge an action item into the Inbox surface (create it if absent); a new PENDING item raises the
  // inbox so the human notices. Items are keyed by id (an update replaces the prior copy).
  function ensureInboxItem(item: Record<string, unknown> & { id: string; status: string }): void {
    const st = useDesktop.getState()
    const panel = st.surfaces.find((s) => s.kind === 'native' && s.component === 'inbox')
    if (panel) {
      const its = ((panel.props?.items as Array<{ id: string }>) ?? []).filter((x) => x.id !== item.id)
      st.updateSurfaceProps(panel.id, { items: [...its, item].slice(-100) })
      if (item.status === 'pending') st.focusSurface(panel.id)
    } else {
      st.createSurface(inboxSurfaceInput([item]))
    }
  }

  // Control actions from main (local control server or agent-socket).
  useEffect(() => {
    return window.agentOS?.onAction((a) => {
      const st = useDesktop.getState()
      if (a.type === 'hydrate') {
        // FIRST hydrate wins: a live renderer is the source of truth mid-session, so an SSE
        // RECONNECT re-sending hydrate must not wholesale-replace.
        if (hydrated.current) return
        // Restore a persisted workspace from disk (Phase 2).
        const surfs = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cam = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        st.hydrate(surfs, cam, 'desktop')
        hydrated.current = true
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
      } else if (a.type === 'switch') {
        // FORCED re-hydrate on a workspace switch. Bypasses the first-hydrate-wins guard, but keeps
        // hydrated.current true (never reset) so a racing SSE reconnect's hydrate still can't clobber.
        const sf = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cm = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        st.hydrate(sf, cm, 'desktop')
        hydrated.current = true // a switch is also a valid first hydrate — don't depend on a prior 'hydrate'
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
      } else if (a.type === 'create') {
        const surf = a.surface as CreateSurfaceInput
        if (!surf) return
        // Dedupe by id: a 'create' (e.g. a new agent) can race a hydrate that already brought it.
        const existingSurface = surf.id ? st.surfaces.find((s) => s.id === surf.id) : undefined
        if (existingSurface) return
        st.createSurface(surf)
      } else if (a.type === 'set-theme') {
        // Live OS accent (widget/agent picked it): recolor chrome now, persist for next boot. The
        // accent also reaches every srcdoc widget WITHOUT its own props.accent by bumping a token
        // SurfaceFrame folds into the props it posts (board cards keep their own palette accents).
        const theme = (a.theme ?? {}) as { accent?: string; accentDeep?: string }
        if (theme.accent) {
          applyTheme(theme as Theme)
          saveTheme(theme as Theme)
          st.setOsAccent(theme.accent)
        }
      } else if (a.type === 'chat') {
        // The OS owns every agent transcript and sends the hub props to the ONE primary Chat surface.
        // Legacy messages-only payloads are still accepted for older transports.
        const sid = a.agentId != null ? String(a.agentId) : '0'
        // Keep the collapsed notch's live compact glance current: tally working / needs-you across the roster.
        // Computed BEFORE the chat-surface guard so the closed-notch dot stays live even with no Chat surface open.
        {
          const sessions = Array.isArray(a.sessions) ? (a.sessions as Array<{ id?: unknown; status?: unknown }>) : null
          const statusMap = a.status && typeof a.status === 'object' ? (a.status as Record<string, string>) : null
          // Build the per-agent {id,status} list so the glance bar can render one avatar per active agent.
          const agents = sessions
            ? sessions.map((s) => ({ id: String(s?.id ?? ''), status: String(s?.status ?? 'idle') })).filter((x) => x.id)
            : statusMap
              ? Object.entries(statusMap).map(([id, status]) => ({ id: String(id), status: String(status) }))
              : []
          if ((agents.length || sessions) && !isCinematicActive()) {
            const working = agents.filter((x) => x.status === 'working' || x.status === 'starting' || x.status === 'reconnecting').length
            const attn = agents.filter((x) => x.status === 'waiting').length
            const err = agents.filter((x) => x.status === 'error').length
            setNotchPeek({ working, attn, err, total: agents.length, agents })
            // DONE-pip edges. These are the RAW host statuses (see notch/types.ts): an agent that just finished its
            // turn settles to 'watching' (turn ended clean, after the host's ~10s quiet debounce) or 'idle' (no live
            // terminal) — NOT a per-tool-call flicker. Mark that working→finished edge so the at-rest glance bar
            // shows the quiet green DONE mark until the user views that agent (NotchHost clears it). Any move back
            // into an active status supersedes the mark; reconcile drops marks for agents that left the roster so a
            // mark never outlives its agent.
            const prev = prevAgentStatusRef.current
            const liveIds = new Set<string>()
            for (const { id, status } of agents) {
              liveIds.add(id)
              if (prev.get(id) === 'working' && (status === 'watching' || status === 'idle')) markDone(id)
              else if (status === 'working' || status === 'starting' || status === 'waiting' || status === 'reconnecting' || status === 'error') clearDone(id)
              prev.set(id, status)
            }
            for (const id of [...prev.keys()]) if (!liveIds.has(id)) prev.delete(id)
            reconcileDone((id) => liveIds.has(id))
          }
        }
        const chat = st.surfaces.find((s) => s.id === 'chat') || st.surfaces.find((s) => s.role === 'chat' || (s.kind === 'native' && s.component === 'chat'))
        if (!chat) return
        if (a.sessions || a.threads || a.status) {
          st.updateSurfaceProps(chat.id, {
            sessions: a.sessions,
            threads: a.threads,
            status: a.status,
            activeAgentId: a.activeAgentId != null ? String(a.activeAgentId) : sid,
            messages: Array.isArray(a.messages) ? a.messages : undefined,
            agentId: sid,
            sessionId: sid
          })
        } else if (Array.isArray(a.messages)) {
          st.updateSurfaceProps(chat.id, { messages: a.messages as Array<{ role: string; text: string }>, agentId: sid, sessionId: sid })
        } else {
          const text = String(a.text ?? '')
          if (text) {
            const prev = (chat.props?.messages as Array<{ role: string; text: string }>) ?? []
            st.updateSurfaceProps(chat.id, { messages: [...prev, { role: 'agent', text }].slice(-200), agentId: sid, sessionId: sid })
          }
        }
      } else if (a.type === 'agentStatus') {
        // Backend heartbeat: is the agent's relay link up? Drives the toolbar status pill.
        setAgentOnline(!!a.online)
      } else if (a.type === 'terminal-data') {
        // live tmux %output for a terminal -> its terminal surface (terminalStream routes by id)
        pushTerminalData(String(a.id), String(a.data ?? ''))
      } else if (a.type === 'terminal-exit') {
        pushTerminalExit(String(a.id), a.exitCode == null ? null : Number(a.exitCode))
      } else if (a.type === 'terminal-spawn') {
        // Plain terminals still open as tabs. Managed agent terminals stay in the native chat/notch debug path;
        // do not resurrect the canvas-era terminal surface for them.
        const term = (a.terminal ?? {}) as TerminalListEntry
        if (term.kind !== 'agent') {
          ensureTerminalTab(String(a.id), term.title || 'Terminal', term.stage ?? term.area)
        }
      } else if (a.type === 'action-item') {
        // An agent pushed (or updated/resolved) an action item the human must do → the Inbox surface.
        const item = a.item as { id?: string; status?: string } | undefined
        if (item && item.id) ensureInboxItem(item as Record<string, unknown> & { id: string; status: string })
      } else if (a.type === 'action-item-removed') {
        const id = String(a.id)
        const panel = st.surfaces.find((s) => s.kind === 'native' && s.component === 'inbox')
        if (panel) {
          const its = (panel.props?.items as Array<{ id: string }>) ?? []
          st.updateSurfaceProps(panel.id, { items: its.filter((x) => x.id !== id) })
        }
      } else if (a.type === 'agent-remove') {
        // An agent was deleted (host removed its widget via the 'close' broadcast + its files). Drop the
        // agent's terminal tab if it's still around.
        const cur = useDesktop.getState()
        const rid = String(a.id)
        for (const w of cur.surfaces) {
          if (w.kind === 'native' && w.component === 'terminal' && w.tabs?.some((t) => t.terminalId === rid)) {
            const tab = w.tabs.find((t) => t.terminalId === rid)
            if (tab) st.closeTab(w.id, tab.id)
          }
        }
      } else if (a.type === 'cinematic') {
        // Seed 3 scripted onboarding avatars: Blitz blue ('0'), rose-red ('5', hue 327.5°), green ('1', hue 137.5°).
        // working:0 so no "N working" status text appears — just the three circles.
        setNotchPeek({ working: 0, attn: 0, err: 0, total: 3, agents: [
          { id: '0', status: 'working' },
          { id: '5', status: 'working' },
          { id: '1', status: 'working' },
        ]})
        setCinematicGlanceOpen(true) // bars tucked in; will flip at spring-settle
        triggerCinematic()
      }
    })
  }, [])

  // Ask main for the persisted state once our onAction listener (above) is mounted; Electron
  // replies with a 'hydrate' os:action. In server mode the SSE connect delivers it, so this no-ops.
  useEffect(() => {
    window.agentOS?.requestHydrate?.()
  }, [])

  // Resume terminals: terminal surfaces aren't serialized (they're runtime-only), so on load — and on
  // every workspace switch — we reconstruct a terminal tab for each plain terminal still ALIVE in this
  // workspace. Managed agent terminals stay hidden here; the notch owns the read-only debug view. tmux keeps
  // the process across a BlitzOS/page restart; calling terminalList() also drives the backend's lazy restore()
  // (re-adopting survivors). ensureTerminalTab is idempotent, so this converges with the restore()
  // terminal-spawn replay rather than double-creating, and pruneEmptyTerminals drops any window a removed
  // terminal left blank. Keyed on the active workspace (a switch wholesale-replaces the canvas first).
  useEffect(() => {
    if (!activeWs) return
    let cancelled = false
    const api = window.agentOS as unknown as { terminalList?: () => Promise<unknown[]> }
    Promise.resolve(api?.terminalList?.() ?? [])
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return
        const st = useDesktop.getState()
        const agentIds = new Set<string>()
        for (const s of list as TerminalListEntry[]) {
          if (!s || !s.id || s.status !== 'running') continue
          if (s.kind === 'agent') agentIds.add(String(s.id))
          // Reconstruct terminal tabs for live plain shells only. Agent terminals are the chat/notch debug pane.
          if (s.kind === 'agent') continue
          ensureTerminalTab(String(s.id), s.title || (s.kind === 'agent' ? 'Agent' : 'Terminal'), s.stage ?? s.area)
        }
        closeAgentTerminalTabs(agentIds)
        st.pruneEmptyTerminals() // a terminal window left with no live tab only renders blank — drop it
      })
      .catch(() => {})
    // Reconstruct the Action-items inbox: if this workspace has any PENDING items (agent asked, human
    // hasn't done them yet), bring the inbox back so the task isn't lost across a restart. The inbox
    // surface is runtime-only (not serialized), so it's rebuilt from the persisted action-items.json.
    const ax = window.agentOS as unknown as { actionList?: (s?: string) => Promise<unknown[]> }
    Promise.resolve(ax?.actionList?.('pending') ?? [])
      .then((items) => {
        if (cancelled || !Array.isArray(items) || !items.length) return
        for (const it of items as Array<{ id?: string; status?: string }>) {
          if (it && it.id) ensureInboxItem(it as Record<string, unknown> & { id: string; status: string })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeWs])

  // Push desktop state to main (so list_state works). Surface changes push immediately; viewport churn is
  // coalesced so a resize doesn't flood the channel.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      if (!hydrated.current) return // don't clobber a restoring state with our empty store
      const st = useDesktop.getState()
      const vw = st.viewport.w
      const vh = st.viewport.h
      const surfaces = st.surfaces.map((s) => ({
        id: s.id,
        kind: s.kind,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: s.w,
        h: s.h,
        z: s.z,
        zoom: s.zoom,
        title: s.title,
        url: s.url,
        html: s.html,
        // srcdoc lang must survive the round-trip: workspace.mjs contentFor picks the content
        // file's EXTENSION from it (.jsx/.tsx) — dropping it here would persist jsx source into
        // a .html file and rehydrate it as garbage markup on the next boot.
        lang: s.lang,
        props: s.props,
        component: s.component,
        role: s.role,
        // Carry the agent id so a per-agent chat surface survives the round-trip (osState → a later hydrate).
        agentId: s.agentId,
        // Browser tabs persist (.weblink) + surface in list_state from THIS push too — persistable
        // fields only ({id,title,url}; favicon/loading/nav state are runtime chrome).
        tabs: s.tabs?.map((t) => ({ id: t.id, title: t.title, url: t.url, terminalId: t.terminalId })),
        activeTab: s.activeTab,
        // Chat + Agent-activity panels are pinned always-on-top — the agent must not cover them
        pinned: isRuntimePanel(s)
      }))
      window.agentOS?.sendState({
        workspace: activeWsRef.current ?? undefined,
        surfaces,
        viewport: { w: vw, h: vh },
        bulkAt: st.lastBulkAt || undefined
      })
    }
    push()
    // SERVER mode always delivers a hydrate on SSE connect, so we wait for it (no fallback) —
    // a fallback there could fire before a slow hydrate, which the first-hydrate-wins guard
    // would then ignore, never restoring. Electron has no server hydrate, so it gets a grace
    // timer to start pushing (and only if it actually has surfaces, to never push an empty store).
    const hydrateFallback = isServer
      ? null
      : setTimeout(() => {
          if (!hydrated.current) {
            hydrated.current = true
            if (useDesktop.getState().surfaces.length) push()
          }
        }, 1500)
    let lastS = useDesktop.getState().surfaces
    let lastVp = useDesktop.getState().viewport
    const scheduleViewport = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        push()
      }, 250)
    }
    const unsub = useDesktop.subscribe((state) => {
      if (state.surfaces !== lastS) {
        lastS = state.surfaces
        push() // surface set changed — reflect it at once
      } else if (state.viewport !== lastVp) {
        lastVp = state.viewport
        scheduleViewport() // viewport changed — coalesce bursts
      }
    })
    return () => {
      if (hydrateFallback) clearTimeout(hydrateFallback)
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [])

  useEffect(() => {
    return window.agentOS?.onAgentSocketUrl((url) => setAiUrl(url))
  }, [])

  return (
    <div
      id="root-canvas"
      ref={rootRef}
      className={[notchOn ? 'notch-mode' : null, notchAnimating ? 'notch-anim' : null].filter(Boolean).join(' ')}
      // THE MERGE: clip the whole live canvas to the NotchShape. The GPU promotion lives in CSS
      // (#root-canvas.notch-mode) so the clip composites cleanly (not a main-thread re-clip).
      style={notchOn ? { clipPath: notchClip, WebkitClipPath: notchClip } : undefined}
      // The clip transition is done → unfreeze widget motion (notch-anim pauses animations during the grow/shrink
      // so the texture is static = pure GPU compositing). Only #root-canvas's OWN clip-path transition counts.
      onTransitionEnd={(e) => {
        if (notchOn && e.target === e.currentTarget && e.propertyName === 'clip-path') setNotchAnimating(false)
      }}
      onPointerDownCapture={() => {
        // Keyboard-focus reclaim: iframes/browser guests swallow window keydown while focused, killing every
        // app keybind. A pointerdown that reaches the HOST at all means the user is now interacting
        // OUTSIDE the guest — blur it so the next keystroke lands in the app again.
        const ae = document.activeElement as HTMLElement | null
        if (ae && ae.tagName === 'IFRAME') ae.blur()
      }}
    >
      {/* Draggable title bar — windowed mode only (never shown when the island is active). */}
      {!notchOn && !shellFullscreen && (
        <div className="titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          <span className="titlebar-label">BlitzOS</span>
        </div>
      )}

      {/* THE NOTCH (dynamic island) handle — the always-on-top black pill: closed it IS the notch; expanded it
          stays at top-center as the click-to-toggle handle (a click opens/closes the island panel).
          PORTALED to document.body so it lives in the SAME top layer as the island chassis (.nhost). Why this is
          load-bearing: #root-canvas is GPU-promoted in notch mode (transform: translateZ(0)), which makes it a
          stacking context that TRAPS a fixed child — so an in-canvas handle (z 100000) can never out-stack the
          body-portal chassis (z 2147483000), and the instant the island opened on hover the chassis covered the
          handle and ate every click (the "notch isn't clickable" regression). As a body portal at z ABOVE .nhost,
          the handle is always the top hit-target. Only mounted in overlay mode (notchOn). */}
      {notchOn && hasNotch &&
        createPortal(
          <div
            ref={notchHandleRef}
            className={`notch-handle${notchState !== 'closed' ? ' is-open' : ''}`}
            style={{ width: notchWidth, height: Math.max(28, notchMenuBarH), top: -NOTCH_NUDGE_DY }}
          >
            <div
              className="notch-peek"
              data-state={
                notchPeek.err > 0
                  ? 'error'
                  : notchPeek.working > 0
                    ? 'working'
                    : notchPeek.attn > 0
                      ? 'attn'
                      : notchPeek.total > 0
                        ? 'idle'
                        : 'empty'
              }
              aria-hidden
            >
              <span className="notch-peek-dot" />
              {notchPeek.total > 0 && <span className="notch-peek-count">{notchPeek.total}</span>}
            </div>
          </div>,
          document.body
        )}
      {/* The GLANCE BAR — the at-rest, menu-bar-line summary flanking the notch (BlitzOS icon + statuses LEFT, agent
          avatars RIGHT). Always mounted while overlay+notch; `open` collapses the bars INTO the notch when the island
          opens, so the island appears to grow out of / shrink back to the bar. Body portal, display-only — App's
          mousemove drives hover-to-open. */}
      {notchOn && hasNotch &&
        createPortal(
          <GlanceBar peek={notchPeek} notchWidth={notchWidth} menuBarH={notchMenuBarH} open={cinematicActive ? cinematicGlanceOpen : notchState === 'panel'} />,
          document.body
        )}
      {/* The island chassis (the locked NotchHost design) — also a body portal so it ESCAPES the #root-canvas clip
          + the hide-canvas-at-rest rule. Shown while the island is in the panel/opening state; the handle above
          sits ON TOP of it (higher z) so the notch stays clickable while the chat is open. App previews stay mounted
          while hidden so their iframe does not reload on hover-away / hover-back. */}
      {notchOn &&
        (notchState === 'panel' || islandKeepMounted) &&
        createPortal(
          <NotchHost
            menuBarH={notchMenuBarH}
            visible={notchState === 'panel'}
            initialView={islandViewRef.current}
            initialPage={islandPageRef.current}
            initialAttachOpen={islandAttachOpenRef.current}
            initialActiveApp={islandActiveAppRef.current}
            onStateChange={onIslandStateChange}
            onChassisHoverChange={setChassisHover}
            onChassisResize={() => {
              notchHoldUntilRef.current = performance.now() + NOTCH_HOVER_OPEN_GRACE_MS
              setNotchInteractive(true)
            }}
            onAttachChange={onIslandAttachChange}
            onOnboardingComplete={completeIslandOnboarding}
            onIslandHoldOpen={() => {
              notchHoldUntilRef.current = performance.now() + NOTCH_ATTACH_CLOSE_HOLD_MS
            }}
          />,
          document.body
        )}

      {showAi && (
        <div className="hud-backdrop" onPointerDown={() => setShowAi(false)}>
          <div className="hud" onPointerDown={(e) => e.stopPropagation()}>
            <div className="hud-head">Drive BlitzOS from an AI chat</div>
            {aiUrl ? (
              <>
                <p className="hud-sub">
                  Paste this URL into a <strong>tool-capable</strong> AI agent — Claude Code, or <code>claude -p</code> — and ask
                  it to open windows, post-its, etc. (It needs to make HTTP calls, so a plain Claude.ai / ChatGPT chat can only
                  read the link, not drive BlitzOS.)
                </p>
                <div className="hud-row">
                  <input className="hud-input" readOnly value={aiUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button className={`btn primary hud-copy${aiCopied ? ' copied' : ''}`} onClick={() => void copyAiUrl()} aria-label={aiCopied ? 'Copied' : 'Copy URL'}>
                    {aiCopied ? <IconCheck size={18} /> : 'Copy'}
                  </button>
                </div>
              </>
            ) : (
              <p className="hud-sub">Connecting to the agent-socket relay…</p>
            )}
          </div>
        </div>
      )}

      {connectPicker && <ConnectPicker onClose={() => setConnectPicker(false)} />}

      {/* DEBUG agent-backend switch (Codex/Claude) — a leftover bottom-right overlay from the old visual-OS build.
          COMMENTED OUT so users never see it (uncomment to restore for maintainer debugging):
      {!isServer && agentRuntimeDebug && (
        <div className="agent-runtime-switch" aria-label="Agent backend">
          <span className="agent-runtime-debug-tag">DEBUG</span>
          <div className="agent-runtime-switch-group" aria-label="AI backend">
            <span className="agent-runtime-switch-label">AI</span>
            <button
              className={agentRuntimeDebug.runtime === 'codex-serverless' ? 'active' : ''}
              disabled={!agentRuntimeDebug.available.codex || !!agentRuntimePending}
              onClick={() => { void chooseAgentRuntime('codex-serverless') }}
            >
              Codex
            </button>
            <button
              className={agentRuntimeDebug.runtime === 'claude' ? 'active' : ''}
              disabled={!agentRuntimeDebug.available.claude || !!agentRuntimePending}
              onClick={() => { void chooseAgentRuntime('claude') }}
            >
              Claude
            </button>
          </div>
        </div>
      )}
      */}
      {cinematicActive && (
        <CinematicIntro
          onSettle={() => setCinematicGlanceOpen(false)}
          onComplete={() => {
            doneCinematic()
            // Bars slide out in 0.34s; give them time to extend before the island pulls them back in.
            // Then clear the scripted fake agents — real agent data owns notchPeek from here on.
            window.setTimeout(() => {
              applyNotchState('panel')
              setNotchPeek({ working: 0, attn: 0, err: 0, total: 0, agents: [] })
            }, 400)
          }}
        />
      )}
    </div>
  )
}
