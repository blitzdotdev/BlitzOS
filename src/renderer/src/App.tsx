import { useEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useDesktop, homeRect, homeTransform, nextTerminalName, latticeFor, nearestFreeSlot, effectiveZ, type CreateSurfaceInput } from './store'
import { applyTheme, saveTheme, type Theme } from './theme'
import { pushTerminalData, pushTerminalExit } from './terminalStream'
import type { Surface, CanvasTransform } from './types'
import { isRuntimePanel } from './types'
import { Overview } from './components/Overview'
import { capturePrimaryThumb } from './capture'
import { SurfaceFrame, bgHolesClip, snapPreviewClip } from './components/SurfaceFrame'
import { AnnotationLayer } from './components/AnnotationLayer'
import { PrimarySpace } from './components/PrimarySpace'
import { Sidebar } from './components/Sidebar'
import { RadialSurfaceMenu, menuOrigin, MENU_SIZE } from './components/RadialSurfaceMenu'
import type { SurfaceLauncherKind } from './components/SurfaceLauncherButton'
import { IconChat, IconSparkle, IconCheck, IconInbox, IconSessions, IconTerminal } from './components/Icons'
import { FolderOverlay } from './components/FolderOverlay'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { shouldShowOnboarding, markOnboarded } from './onboarding/config'
import { ContextMenu } from './components/ContextMenu'

const SHOW_ADVANCED_TOOLBAR = false
const FOLDER_ENTRY_MIME = 'application/x-blitz-folder-entry'
type DockAnimationPhase = 'minimizing' | 'restoring'
type ToolbarTooltip = { text: string; left: number; top: number }
type AdvancedPopoverPosition = { left: number; top: number }
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
const THEME_STORAGE_KEY = 'blitzos.theme'
const HOME_TRANSFORM_EPS = 0.75
const HOME_SCALE_EPS = 0.006
const CANVAS_WHEEL_GESTURE_MS = 220
const HOME_DOUBLE_TAP_MS = 280
const CANVAS_GESTURE_BLOCK_SELECTOR = [
  '.sidebar',
  '.titlebar',
  '.toolbar-shell',
  '.advanced-popover',
  '.hud',
  '.overview',
  '.folder-overlay',
  '.context-menu',
  '.consent',
  '.onboarding'
].join(', ')

function systemTheme(): ThemeMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readInitialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'dark' || stored === 'light' ? stored : systemTheme()
}

function isCanvasGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (!target.closest('#root-canvas')) return false
  return !target.closest(`.window.is-active, ${CANVAS_GESTURE_BLOCK_SELECTOR}`)
}

function isCanvasGestureBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  if (!target.closest('#root-canvas')) return true
  return !!target.closest(CANVAS_GESTURE_BLOCK_SELECTOR)
}

function isActiveWindowTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.window.is-active')
}

function canMoveToRealFolder(s: Surface): boolean {
  if (s.minimized || s.groupId || s.role) return false
  if (s.kind === 'app' || s.kind === 'srcdoc') return true
  return s.kind === 'native' && (s.component === 'note' || s.component === 'file' || s.component === 'dir')
}

function isScrollableSurfaceTarget(target: EventTarget | null, deltaX: number, deltaY: number): boolean {
  if (!(target instanceof Element)) return false
  const activeWindow = target.closest('.window.is-active')
  if (!(activeWindow instanceof Element)) return false
  if (target.closest('textarea, input, select, [contenteditable="true"], [data-surface-scroll="true"]')) return true

  const wantsX = Math.abs(deltaX) > Math.abs(deltaY)
  for (let el: Element | null = target; el && el !== activeWindow; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue
    const style = window.getComputedStyle(el)
    const scrollsY = /auto|scroll|overlay/.test(style.overflowY) && el.scrollHeight > el.clientHeight
    const scrollsX = /auto|scroll|overlay/.test(style.overflowX) && el.scrollWidth > el.clientWidth
    if ((wantsX && scrollsX) || (!wantsX && scrollsY)) return true
  }
  return false
}

function isHomeTransform(a: CanvasTransform, b: CanvasTransform): boolean {
  return Math.abs(a.x - b.x) < HOME_TRANSFORM_EPS && Math.abs(a.y - b.y) < HOME_TRANSFORM_EPS && Math.abs(a.scale - b.scale) < HOME_SCALE_EPS
}

function preserveWorldCenterForViewport(t: CanvasTransform, fromVp: { w: number; h: number }, toVp: { w: number; h: number }): CanvasTransform {
  const scale = t.scale || 1
  const cx = (fromVp.w / 2 - t.x) / scale
  const cy = (fromVp.h / 2 - t.y) / scale
  return { scale, x: toVp.w / 2 - cx * scale, y: toVp.h / 2 - cy * scale }
}
type AnimationSourceRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
const WIDGET_PLACEHOLDER_HTML = `
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--blitz-surface);
    color: var(--blitz-text);
    font: 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .empty {
    width: min(320px, calc(100% - 44px));
    display: grid;
    gap: 12px;
    text-align: center;
  }
  .mark {
    width: 42px;
    height: 42px;
    margin: 0 auto;
    display: grid;
    place-items: center;
    border-radius: 12px;
    border: 1px solid var(--blitz-hairline);
    color: var(--blitz-accent);
    background: color-mix(in srgb, var(--blitz-accent) 10%, transparent);
    font-size: 20px;
  }
  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 650;
  }
  p {
    margin: 0;
    color: var(--blitz-text-dim);
    line-height: 1.45;
  }
</style>
<main class="empty">
  <div class="mark">&lt;/&gt;</div>
  <h1>Widget</h1>
  <p>A sandboxed mini-app can live here. Ask an agent to build one, or use it as a starting point for a custom workspace tool.</p>
</main>`

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function findByData(name: string, value: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${name}]`))) {
    if (el.getAttribute(name) === value) return el
  }
  return null
}

function sourceRectFromElement(el: Element | null): AnimationSourceRect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function animateDockMotionFromRect(
  el: HTMLElement,
  target: AnimationSourceRect,
  worldScale: number,
  phase: DockAnimationPhase
): Promise<(() => void) | null> {
  if (!el.animate) return null
  const from = el.getBoundingClientRect()
  const to = target
  if (!from.width || !from.height || !to.width || !to.height) return null

  const scale = Math.max(0.06, Math.min(0.18, Math.min(to.width / from.width, to.height / from.height)))
  const safeScale = Math.max(0.001, worldScale || 1)
  const dx = (to.left + to.width / 2 - (from.left + from.width / 2)) / safeScale
  const dy = (to.top + to.height / 2 - (from.top + from.height / 2)) / safeScale
  const dockTransform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`
  const shown = { transform: 'translate3d(0px, 0px, 0) scale(1)', opacity: 1 }
  const docked = { transform: dockTransform, opacity: 0.18 }
  const keyframes = phase === 'minimizing' ? [shown, docked] : [docked, shown]
  const first = keyframes[0]
  const previous = {
    transform: el.style.transform,
    opacity: el.style.opacity,
    transformOrigin: el.style.transformOrigin,
    willChange: el.style.willChange,
    pointerEvents: el.style.pointerEvents,
    zIndex: el.style.zIndex,
    visibility: el.style.visibility
  }

  // For restore, the real surface is mounted but hidden for measurement. Apply the docked
  // first frame while it is still hidden, then reveal it, so it cannot flash at full size.
  el.style.transform = String(first.transform)
  el.style.opacity = String(first.opacity)
  el.style.visibility = 'visible'
  el.style.transformOrigin = 'center center'
  el.style.willChange = 'transform, opacity'
  el.style.pointerEvents = 'none'
  el.style.zIndex = '3000000'

  const animation = el.animate(keyframes, {
    duration: phase === 'minimizing' ? 320 : 300,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards'
  })

  await new Promise<void>((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })

  return () => {
    animation.cancel()
    el.style.transform = previous.transform
    el.style.opacity = previous.opacity
    el.style.transformOrigin = previous.transformOrigin
    el.style.willChange = previous.willChange
    el.style.pointerEvents = phase === 'restoring' ? '' : previous.pointerEvents
    el.style.zIndex = previous.zIndex
    el.style.visibility = phase === 'restoring' ? '' : previous.visibility
  }
}

async function animateDockMotion(
  el: HTMLElement,
  dock: HTMLElement,
  worldScale: number,
  phase: DockAnimationPhase
): Promise<(() => void) | null> {
  const r = dock.getBoundingClientRect()
  return animateDockMotionFromRect(el, { left: r.left, top: r.top, width: r.width, height: r.height }, worldScale, phase)
}

type SurfaceRect = Pick<Surface, 'x' | 'y' | 'w' | 'h'>

async function animateSurfaceGeometryMotion(
  el: HTMLElement,
  from: SurfaceRect
): Promise<(() => void) | null> {
  if (!el.animate) return null
  if (!from.w || !from.h) return null

  const previous = {
    willChange: el.style.willChange,
    pointerEvents: el.style.pointerEvents,
    zIndex: el.style.zIndex
  }

  const to = {
    left: el.style.left,
    top: el.style.top,
    width: el.style.width,
    height: el.style.height
  }
  if (!to.left || !to.top || !to.width || !to.height) return null

  el.style.willChange = 'left, top, width, height'
  el.style.pointerEvents = 'none'
  el.style.zIndex = '3000000'

  const animation = el.animate(
    [
      { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px` },
      to
    ],
    { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
  )

  await new Promise<void>((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })

  return () => {
    animation.cancel()
    el.style.willChange = previous.willChange
    el.style.pointerEvents = previous.pointerEvents
    el.style.zIndex = previous.zIndex
  }
}

// The shared Notepad note BlitzOS keeps as working memory (human + agent r/w). Ensured after each
// hydrate so a fresh workspace gets one (it then persists as a file); idempotent on a restored board.
function ensureNotepad(): void {
  // Both transports get a Notepad (it persists as a file in the workspace folder = the agent's
  // memory; the manual + the dynamic-boot instruction both rely on it existing, incl. server mode).
  const st = useDesktop.getState()
  if (st.surfaces.some((s) => s.kind === 'native' && s.component === 'note' && s.title === 'Notepad')) return
  // Born SLOTTED (an s tile near home's bottom-right), never a free float over the middle of the
  // desktop; a packed lattice parks it below the home frame instead (single-canvas model).
  const lat = latticeFor(st.viewport)
  const r = homeRect(st.viewport)
  const slot = nearestFreeSlot(st.surfaces, lat, 's', r.x + r.w - 90, r.y + r.h - 90)
  st.createSurface({
    kind: 'native',
    component: 'note',
    title: 'Notepad',
    ...(slot ? { slot: { col: slot.col, row: slot.row, size: 's' } } : { x: Math.round(r.x + 40), y: Math.round(r.y + r.h + 360) }),
    props: {
      text: '# Notepad\n\nShared working memory for you and BlitzOS. The agent keeps context and notes here; you can edit it too.\n',
      color: 'yellow'
    }
  })
}

// Server-mode FOLDER drop: the browser exposes the dropped tree via webkitGetAsEntry(). Recurse it,
// upload each file with its in-folder subpath (reconcile deferred), then reconcile ONCE so the whole
// folder surfaces as a single tile. (Electron drops carry real OS paths and use a recursive copy instead.)
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}
async function uploadDroppedEntries(entries: FileSystemEntry[], wx: number, wy: number): Promise<void> {
  const uploads: Array<{ rel: string; getFile: () => Promise<File> }> = []
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fe = entry as FileSystemFileEntry
      uploads.push({ rel: prefix + entry.name, getFile: () => new Promise<File>((res, rej) => fe.file(res, rej)) })
    } else if (entry.isDirectory) {
      const kids = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const k of kids) await walk(k, prefix + entry.name + '/')
    }
  }
  for (const en of entries) if (en) await walk(en, '')
  const capped = uploads.slice(0, 2000) // safety cap — a drop this large is unusual
  for (const u of capped) {
    try {
      const buf = await (await u.getFile()).arrayBuffer()
      await fetch(`/api/os/upload?name=${encodeURIComponent(u.rel)}&reconcile=0`, { method: 'POST', body: buf })
    } catch {
      /* skip a file we couldn't read/upload */
    }
  }
  try {
    await fetch('/api/os/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: wx, y: wy }) })
  } catch {
    /* the watcher reconcile will still pick the files up shortly */
  }
}

function findChatHub(surfaces: Surface[]): Surface | undefined {
  return (
    surfaces.find((s) => s.role === 'chat' && s.kind === 'srcdoc') ??
    surfaces.find((s) => s.id === 'chat' && s.kind === 'srcdoc') ??
    surfaces.find((s) => s.role === 'chat')
  )
}

// ── The Notch (dynamic island) — THE MERGE: the real canvas window IS the notch. #root-canvas is clipped to a
// macOS-NotchShape and the clip GROWS to fullscreen, so the LIVE canvas expands out of the notch (no separate
// window, no plate). notchPath + the three stops (closed notch → hover panel → open fullscreen) are ported from
// the validated notch-spill PoC; the renderer's opaque .bg paints the canvas color the clip reveals.
const NOTCH_W = 200
const NOTCH_PANEL_W = 580
const NOTCH_PANEL_H = 160
// inset() (a rounded-rect reveal), NOT clip-path: path() with curves. inset interpolates as plain numbers, so the
// GROW is cheap and GPU-composited (with will-change) = butter-smooth; a path() with quadratics re-clipped the
// whole app on the MAIN THREAD every frame (the lag). The rounded-bottom rect IS the dynamic-island look (top
// flush with the screen edge, bottom rounded). vw/vh/notchH in CSS px.
function notchClipFor(state: 'closed' | 'panel' | 'open', vw: number, vh: number, notchH: number): string {
  if (state === 'open') return 'inset(0px round 0px)'
  if (state === 'panel') {
    const sx = Math.max(0, (vw - NOTCH_PANEL_W) / 2)
    return `inset(0px ${sx}px ${Math.max(0, vh - NOTCH_PANEL_H)}px ${sx}px round 0px 0px 28px 28px)`
  }
  const sx = Math.max(0, (vw - NOTCH_W) / 2)
  const h = Math.max(28, notchH)
  return `inset(0px ${sx}px ${Math.max(0, vh - h)}px ${sx}px round 0px 0px 16px 16px)`
}

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const locked = useDesktop((s) => s.locked)
  const surfaces = useDesktop((s) => s.surfaces)
  const grabMode = useDesktop((s) => s.grabMode)
  const snapPreview = useDesktop((s) => s.snapPreview)
  const selection = useDesktop((s) => s.selection)
  const createSurface = useDesktop((s) => s.createSurface)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)

  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advancedPosition, setAdvancedPosition] = useState<AdvancedPopoverPosition | null>(null)
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme())
  // Agent relay connection health, broadcast by the backend (server mode). null = unknown/not reported yet.
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [showOverview, setShowOverview] = useState(false)
  // Pair-level fullscreen (the sandwich parent): hide the shell titlebar — the attached child
  // window never enters native fullscreen, so its chrome would not auto-hide by itself.
  const [shellFullscreen, setShellFullscreen] = useState(false)
  useEffect(() => window.agentOS?.onShellFullScreen?.(setShellFullscreen), [])
  // HTML5 page fullscreen (a web surface's <video> went fullscreen — YouTube's button or the agent's `f`).
  // Main raises that view to fill the window + routes the keyboard to the page; here we bare ALL chrome
  // (page-fullscreen class), drive full-window geometry (the RAF below), and force mouse passthrough so
  // the video's own controls + Esc work. Without this the user is trapped: no controls, Esc can't exit.
  const pageFullscreenId = useDesktop((s) => s.pageFullscreenId)
  const pageFsRef = useRef<string | null>(null)
  useEffect(() => window.agentOS?.onWebFullscreen?.((m) => useDesktop.getState().setPageFullscreen(m.on ? m.id : null)), [])

  // ── The Notch (dynamic island). The real window IS the notch (sandwich overlay + main's notch wiring). We clip
  // #root-canvas to the NotchShape and grow it; main toggles the window click-through via os:notch-interactive as
  // we report the notch-hover. closed = black notch (the handle); panel = hover entry (Ask Blitz); open = the live
  // canvas, revealed as the clip grows (the opaque .bg paints the color, the world paints the widgets).
  const viewport = useDesktop((s) => s.viewport)
  const [notchOn, setNotchOn] = useState(false) // true once main pushes geometry (overlay mode only)
  const [notchState, setNotchState] = useState<'closed' | 'panel' | 'open'>('closed')
  const [notchMenuBarH, setNotchMenuBarH] = useState(38)
  const [notchDeep, setNotchDeep] = useState(false)
  const [notchPrompt, setNotchPrompt] = useState('')
  const [notchSending, setNotchSending] = useState(false)
  const [notchOpening, setNotchOpening] = useState(false) // brief: the island contents fade to black before the grow
  const [notchAnimating, setNotchAnimating] = useState(false) // during the clip grow/shrink: freeze widget MOTION (not visibility) so the texture is static
  // PINNED panel (item 2): a KEYBOARD-opened panel (⌥Space) stays open regardless of mouse position — the hover
  // mousemove handler must not auto-close it and must keep the window interactive while pinned. A HOVER-opened
  // (un-pinned) panel keeps the original follow-the-mouse behaviour. Cleared on enter / close / retract.
  const [notchPinned, setNotchPinned] = useState(false)
  const notchPinnedRef = useRef(false)
  const setNotchPinnedBoth = (on: boolean): void => {
    notchPinnedRef.current = on
    setNotchPinned(on)
  }
  const notchStateRef = useRef<'closed' | 'panel' | 'open'>('closed')
  const notchHandleRef = useRef<HTMLDivElement>(null)
  const notchLastIRef = useRef<boolean | null>(null)
  const setNotchInteractive = (on: boolean): void => {
    if (notchLastIRef.current === on) return
    notchLastIRef.current = on
    try {
      window.agentOS?.notch?.setInteractive(on)
    } catch {
      /* no bridge (non-overlay) */
    }
  }
  const applyNotchState = (s: 'closed' | 'panel' | 'open'): void => {
    notchStateRef.current = s
    setNotchState(s)
  }
  // Open = first FADE the island's own contents (peek dots + entry) so it goes SOLID BLACK, THEN grow the clip
  // (black notch → black canvas, seamless — the canvas .bg is black in notch mode too). Close = shrink back.
  const openNotch = (): void => {
    if (notchStateRef.current === 'open') return
    setNotchPinnedBoth(false) // entering: the panel-pin no longer applies (we leave the panel for fullscreen)
    setNotchInteractive(true)
    setNotchOpening(true) // fade peek + entry → solid black
    window.setTimeout(() => {
      setNotchAnimating(true) // freeze widget MOTION so the texture stays static while the clip grows (content stays visible)
      applyNotchState('open') // grow the clip — #root-canvas is a pre-rasterized texture, so the reveal is butter + REAL content
      setNotchOpening(false)
      try {
        window.agentOS?.uiFocus?.() // key the window so the expanded canvas takes keyboard (launch was showInactive)
      } catch {
        /* no bridge */
      }
    }, 170)
  }
  const closeNotch = (): void => {
    if (notchStateRef.current !== 'open') return
    setNotchPinnedBoth(false) // retracting clears the pin
    setNotchAnimating(true) // freeze motion during the shrink too (cheap insurance for low-power)
    applyNotchState('closed')
    notchLastIRef.current = null
    setNotchInteractive(false)
  }
  const toggleNotch = (): void => {
    if (notchStateRef.current === 'open') closeNotch()
    else openNotch()
  }
  // Focus the prompt textarea after the panel renders, so a keyboard-opened panel is type-ready immediately.
  const focusNotchPrompt = (): void => {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.notch-pq')
      el?.focus()
    }, 0)
  }
  // ⌥Space TOGGLE (item 2): ⌥Space simply shows/hides the dynamic island in the new-session state. It NEVER
  // enters fullscreen (entering is the handle click / Send). closed → panel (new-session, PINNED open, prompt
  // focused); anything shown (panel or open) → closed (hide). A pure toggle, no staircase.
  const notchToggleAtRef = useRef(0)
  const toggleNewSession = (): void => {
    // Swallow OS key auto-repeat: holding ⌥Space machine-guns the globalShortcut (~30ms apart), which would
    // flicker show/hide. A deliberate human re-tap is slower than this, so a 120ms floor keeps it.
    const now = performance.now()
    if (now - notchToggleAtRef.current < 120) return
    notchToggleAtRef.current = now
    if (notchStateRef.current === 'closed') {
      setNotchPinnedBoth(true) // a keyboard-opened panel stays open regardless of the mouse
      setNotchInteractive(true)
      applyNotchState('panel')
      focusNotchPrompt()
    } else {
      // hide (panel or open → closed)
      setNotchPinnedBoth(false)
      setNotchAnimating(true) // freeze widget motion during the collapse (smooth, esp. open → closed)
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
        setNotchOn(true)
      }),
    []
  )
  // ⌥Space toggles the new-session widget show/hide (closed ↔ panel). Never enters fullscreen.
  useEffect(() => window.agentOS?.notch?.onToggle?.(() => toggleNewSession()), [])
  // Hover → interactive region: collapsed = only the notch handle (then expand to the panel); open = full canvas.
  // The window is click-through (main set ignoreMouseEvents) so the renderer flips it via os:notch-interactive.
  useEffect(() => {
    if (!notchOn) return
    const onMove = (e: MouseEvent): void => {
      const st = notchStateRef.current
      if (st === 'open') {
        setNotchInteractive(true)
        return
      }
      // A PINNED panel (opened via ⌥Space) stays open regardless of the mouse and keeps the window interactive,
      // so the user can move the cursor away and still type. Only HOVER-opened panels follow the mouse below.
      if (st === 'panel' && notchPinnedRef.current) {
        setNotchInteractive(true)
        return
      }
      const r = notchHandleRef.current?.getBoundingClientRect()
      const overHandle = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      const cx = window.innerWidth / 2
      const inPanel =
        e.clientX >= cx - NOTCH_PANEL_W / 2 && e.clientX <= cx + NOTCH_PANEL_W / 2 && e.clientY >= 0 && e.clientY <= NOTCH_PANEL_H
      const focused = (document.activeElement as HTMLElement | null)?.classList?.contains('notch-pq') ?? false
      const want = overHandle || (st === 'panel' && (inPanel || focused))
      if (overHandle && st === 'closed') applyNotchState('panel')
      else if (st === 'panel' && !want) applyNotchState('closed')
      setNotchInteractive(want)
    }
    window.addEventListener('mousemove', onMove, true)
    return () => window.removeEventListener('mousemove', onMove, true)
  }, [notchOn])
  const onNotchSend = async (): Promise<void> => {
    const p = notchPrompt.trim()
    if (!p || notchSending) return
    setNotchSending(true)
    try {
      const r = await window.agentOS?.notch?.send(p, notchDeep)
      setNotchSending(false)
      if (r?.ok) {
        setNotchPrompt('')
        openNotch()
      }
    } catch {
      setNotchSending(false)
    }
  }
  const notchClip = notchOn
    ? notchClipFor(notchState, viewport.w || window.innerWidth, viewport.h || window.innerHeight, notchMenuBarH)
    : undefined
  useEffect(() => {
    pageFsRef.current = pageFullscreenId
    // Native-input path (default): make the WHOLE UI window click-through while fullscreen so the mouse
    // falls to the L0 video (its controls). On exit, drop it — the cursor-over-hole logic takes over.
    // TODO: the synthetic os:page-input path (BLITZ_NATIVE_INPUT=0) forwards from holes, which are hidden
    // in fullscreen, so controls would need a whole-window forwarder there. Native input is on by default.
    if (window.agentOS?.nativeInput) window.agentOS.nativePassthrough(!!pageFullscreenId)
  }, [pageFullscreenId])
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
      window.agentOS?.shellFullScreen?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shellFullscreen])
  // ESC = the workspace switcher overlay (plans/blitzos-single-canvas-navigation.md), the IDE-style
  // project switcher that replaces the old double-⇧ selector. Inactive in shell fullscreen (that ESC
  // exits fullscreen, above) or page video-fullscreen; over a text field ESC cancels the field.
  // openOverview self-guards when already open, and the overlay's own ESC closes it.
  useEffect(() => {
    if (shellFullscreen) return
    const onEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || useDesktop.getState().pageFullscreenId) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      void openOverview()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [shellFullscreen])
  // The home orb is hidden until the pointer nears the bottom-center screen edge. Hysteresis:
  // a thin edge strip reveals it, a taller zone around the revealed button keeps it shown.
  const [homeRevealed, setHomeRevealed] = useState(false)
  const homeRevealedRef = useRef(false)
  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent): void => {
      const cx = Math.abs(e.clientX - window.innerWidth / 2)
      const fromBottom = window.innerHeight - e.clientY
      const next = homeRevealedRef.current ? fromBottom <= 96 && cx <= 130 : fromBottom <= 28 && cx <= 110
      if (next !== homeRevealedRef.current) {
        homeRevealedRef.current = next
        setHomeRevealed(next)
      }
    }
    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [])
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
  // The fluid file layer: whenever the slotted-tile layout (or the viewport, or the file population)
  // changes, flow the file/dir tiles around the tiles. Signature-keyed so it runs exactly when needed;
  // live drag parting is handled by SurfaceFrame (reflowFiles(ghost)) — this settles the final layout.
  const slotSig = useDesktop((s) => {
    let sig = `${s.viewport.w}x${s.viewport.h}`
    let files = 0
    for (const x of s.surfaces) {
      if (x.slot) sig += `|${x.id}:${x.slot.col},${x.slot.row},${x.slot.size}`
      else if (x.kind === 'native' && (x.component === 'file' || x.component === 'dir') && !x.groupId && !x.minimized) files++
    }
    return sig + `#${files}`
  })
  useEffect(() => {
    if (hydrated.current) useDesktop.getState().reflowFiles()
  }, [slotSig])
  // Mirror showOverview into a ref so the ASYNC thumbnail capture reads the current value (not a stale
  // closure): it must never run while the overview overlay is mounted, or capturePage saves the gallery
  // itself AS the workspace's thumbnail (the screenshot-of-the-gallery-in-a-tile bug).
  const showOverviewRef = useRef(false)
  const overviewOpening = useRef(false)
  useEffect(() => {
    showOverviewRef.current = showOverview
  }, [showOverview])
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding())
  // Item 3: a web guest asked for a sensitive browser permission (camera, location, …) — show the human a
  // real Allow/Block prompt (browser parity), remembered per-origin.
  const [permissionPrompts, setPermissionPrompts] = useState<Array<{ id: string; origin: string; permission: string; surfaceId: string | null }>>([])
  // Right-click desktop menu. wx/wy = the world position to place the new folder.
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renamingDirPath, setRenamingDirPath] = useState<string | null>(null)
  const annotationMenu = useDesktop((s) => s.annotationMenu) // item 5b: surface right-click annotation menu
  const [dockAnimations, setDockAnimations] = useState<Record<string, DockAnimationPhase>>({})
  // Read in the geometry RAF below (a []-deps loop) without re-subscribing: mirror the latest into a ref.
  const dockAnimRef = useRef(dockAnimations)
  dockAnimRef.current = dockAnimations
  const isServer = !!window.agentOS?.serverMode
  const hasWorkspaces = !!window.agentOS?.workspaces // present in BOTH modes (Electron preload + server shim)
  // ! DEBUG: runtime switch state is intentionally UI-only; the selected value is persisted in main.
  const [agentRuntimeDebug, setAgentRuntimeDebug] = useState<AgentRuntimeDebugStatus | null>(null)
  const [agentRuntimePending, setAgentRuntimePending] = useState<AgentRuntimeChoice | null>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)
  const marquee = useRef<{ x0: number; y0: number } | null>(null)
  const dockAnimationIds = useRef<Set<string>>(new Set())
  const rectAnimationIds = useRef<Set<string>>(new Set())
  const pendingTerminalSource = useRef<{ rect: AnimationSourceRect; at: number } | null>(null)
  const pendingFolderSource = useRef<{ rect: AnimationSourceRect; at: number } | null>(null)
  const pendingChatSource = useRef<{ rect: AnimationSourceRect; at: number } | null>(null)
  const toolbarTipShowTimer = useRef<number | null>(null)
  const toolbarTipWarmTimer = useRef<number | null>(null)
  const toolbarTipWarm = useRef(false)
  const toolbarTipVisible = useRef(false)
  const toolbarTipSuppressFocus = useRef(false)
  const homeTapTimer = useRef<number | null>(null)
  const advancedButtonRef = useRef<HTMLButtonElement>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [toolbarTooltip, setToolbarTooltip] = useState<ToolbarTooltip | null>(null)

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
  // restored canvas before hydration arrives.
  const hydrated = useRef(false)
  // Shell titlebar drag origin (screen coords at pointerdown) — deltas stream to main, which moves
  // the sandwich's parent window (the UI child follows natively).
  const shellDragFrom = useRef<{ x: number; y: number } | null>(null)
  // The active workspace name, mirrored into a ref so the state-push closure (an effect with []
  // deps) reads the CURRENT value — each push is tagged with it so the backend can drop a stale
  // push that belongs to a workspace we already switched away from (else it corrupts the new folder).
  const activeWsRef = useRef<string | null>(null)
  const viewportReady = useRef(false)
  const canvasWheelGestureUntil = useRef(0)
  const pointerRef = useRef<{ x: number; y: number }>({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const [radialMenu, setRadialMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!showAi) setAiCopied(false)
  }, [showAi])

  useEffect(() => {
    setAiCopied(false)
  }, [aiUrl])

  useEffect(() => {
    return () => {
      if (toolbarTipShowTimer.current != null) window.clearTimeout(toolbarTipShowTimer.current)
      if (toolbarTipWarmTimer.current != null) window.clearTimeout(toolbarTipWarmTimer.current)
      if (homeTapTimer.current != null) window.clearTimeout(homeTapTimer.current)
    }
  }, [])

  function openToolbarTooltip(target: HTMLElement, text: string): void {
    if (toolbarTipWarmTimer.current != null) {
      window.clearTimeout(toolbarTipWarmTimer.current)
      toolbarTipWarmTimer.current = null
    }
    const r = target.getBoundingClientRect()
    toolbarTipWarm.current = true
    toolbarTipVisible.current = true
    setToolbarTooltip({ text, left: Math.round(r.left + r.width / 2), top: Math.round(r.top - 10) })
  }

  function closeToolbarTooltip(): void {
    if (toolbarTipShowTimer.current != null) {
      window.clearTimeout(toolbarTipShowTimer.current)
      toolbarTipShowTimer.current = null
    }
    if (!toolbarTipVisible.current) return
    toolbarTipVisible.current = false
    setToolbarTooltip(null)
    if (toolbarTipWarmTimer.current != null) window.clearTimeout(toolbarTipWarmTimer.current)
    toolbarTipWarmTimer.current = window.setTimeout(() => {
      toolbarTipWarm.current = false
      toolbarTipWarmTimer.current = null
    }, 2000)
  }

  function toolbarTip(text: string): {
    'aria-label': string
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void
    onPointerDown: () => void
    onPointerLeave: () => void
    onFocus: (e: FocusEvent<HTMLElement>) => void
    onBlur: () => void
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
  } {
    return {
      'aria-label': text,
      onPointerEnter: (e) => {
        if (toolbarTipShowTimer.current != null) window.clearTimeout(toolbarTipShowTimer.current)
        const target = e.currentTarget
        const show = (): void => {
          toolbarTipShowTimer.current = null
          openToolbarTooltip(target, text)
        }
        if (toolbarTipWarm.current || toolbarTipVisible.current) show()
        else toolbarTipShowTimer.current = window.setTimeout(show, 1000)
      },
      onPointerDown: () => {
        toolbarTipSuppressFocus.current = true
        closeToolbarTooltip()
      },
      onPointerLeave: closeToolbarTooltip,
      onFocus: (e) => {
        if (toolbarTipSuppressFocus.current) {
          toolbarTipSuppressFocus.current = false
          return
        }
        openToolbarTooltip(e.currentTarget, text)
      },
      onBlur: closeToolbarTooltip,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') closeToolbarTooltip()
      }
    }
  }

  async function copyAiUrl(): Promise<void> {
    if (!aiUrl) return
    await navigator.clipboard?.writeText(aiUrl)
    setAiCopied(true)
  }

  function chooseTheme(next: ThemeMode): void {
    setTheme(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }

  function openTerminalSession(source?: AnimationSourceRect | null): void {
    if (source) pendingTerminalSource.current = { rect: source, at: performance.now() }
    ;(window.agentOS as unknown as { terminalSpawn?: (o: object) => void })?.terminalSpawn?.({ command: 'bash', title: nextTerminalName() })
  }

  function positionAdvancedPopover(): AdvancedPopoverPosition | null {
    const r = advancedButtonRef.current?.getBoundingClientRect()
    if (!r) return null
    const popoverWidth = 286
    return {
      left: Math.max(12, Math.min(window.innerWidth - popoverWidth - 12, Math.round(r.left + r.width / 2 - popoverWidth / 2))),
      top: Math.max(44, Math.round(r.top - 146))
    }
  }

  function toggleAdvanced(): void {
    const nextPosition = positionAdvancedPopover()
    if (nextPosition) setAdvancedPosition(nextPosition)
    setShowAi(false)
    setShowAdvanced((v) => !v)
  }

  useEffect(() => {
    if (!showAdvanced) return
    const onResize = (): void => {
      const nextPosition = positionAdvancedPopover()
      if (nextPosition) setAdvancedPosition(nextPosition)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [showAdvanced])

  // The default Notepad is ensured after each hydrate (see the 'hydrate'/'switch' handlers below),
  // so it persists as a file in the active workspace instead of being recreated on each boot.

  useEffect(() => {
    const onResize = (): void => {
      const st = useDesktop.getState()
      const fromVp = st.viewport
      const toVp = { w: window.innerWidth, h: window.innerHeight }
      // At rest the camera sits at the computed home frame, so a viewport change just re-flies home;
      // a user-zoomed/panned canvas instead keeps the same world center (single-canvas model).
      const wasHome = viewportReady.current && isHomeTransform(st.transform, homeTransform(fromVp))
      const previous = st.transform
      st.setViewport(toVp.w, toVp.h)
      const next = useDesktop.getState()
      if (!viewportReady.current || wasHome) {
        next.goToPrimary()
      } else {
        next.setTransform(preserveWorldCenterForViewport(previous, fromVp, toVp))
      }
      viewportReady.current = true
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // A browser surface is a transparent HOLE: its own wheel listener (SurfaceFrame webHostRef,
      // bubble phase, SurfaceFrame.tsx) forwards the scroll into the WebContentsView. This
      // capture-phase listener must NOT stopPropagation here or that bubble listener never runs.
      // No preventDefault either: the canvas root is overflow:hidden (no native scroll to suppress)
      // and the hole listener already calls preventDefault. Let the event keep flowing to it.
      // EXCEPTION: a zoom gesture (ctrl/pinch) over a hole drives the CAMERA, not the page's own pinch —
      // don't hand it off; fall through to zoomAt below (the page magnifies via the folded zoomFactor).
      if (!e.ctrlKey && e.target instanceof Element && e.target.closest('.webcontents-host')) return
      // Route gestures by what is under the cursor: surface content keeps its native scroll/pinch,
      // while empty canvas gestures pan/zoom the Blitz camera. This listener runs in capture phase
      // because xterm and other custom scrollers can otherwise consume wheel events before the canvas
      // can preserve ownership of an already-started pan.
      const activeWindowTarget = isActiveWindowTarget(e.target)
      const isPanGesture = !e.ctrlKey
      // Trackpad wheel gestures are a burst, not one event. Once a burst begins as a canvas pan, keep it
      // owned by the canvas even if the cursor crosses a terminal or other custom scroll surface. Only the
      // UNFROZEN infinite canvas (single-⇧, !locked) pans — a frozen desktop never owns a pan burst.
      const unfrozen = !useDesktop.getState().locked
      const continuingCanvasPan =
        unfrozen &&
        isPanGesture &&
        canvasWheelGestureUntil.current > performance.now() &&
        !isCanvasGestureBlockedTarget(e.target)
      if (continuingCanvasPan) {
        e.preventDefault()
        e.stopPropagation()
        const w = useDesktop.getState()
        w.clearActiveSurface()
        canvasWheelGestureUntil.current = performance.now() + CANVAS_WHEEL_GESTURE_MS
        w.panBy(-e.deltaX, -e.deltaY)
        return
      }
      // Focus-aware zoom: a pinch over a NON-focused surface (or empty canvas) drives the Blitz CAMERA, so
      // you can zoom into any point. Over the FOCUSED window the gesture stays INSIDE it — a focused browser
      // zooms its own page, a focused widget zooms itself, nothing else moves.
      if (activeWindowTarget && e.ctrlKey) return
      if (activeWindowTarget && !e.ctrlKey && isScrollableSurfaceTarget(e.target, e.deltaX, e.deltaY)) return
      if (!activeWindowTarget && !isCanvasGestureTarget(e.target)) return
      const w = useDesktop.getState()
      if (activeWindowTarget || isPanGesture) w.clearActiveSurface()
      // Single-canvas model (plans/blitzos-single-canvas-navigation.md): cursor-anchored pinch-zoom into
      // ANY point, pan to roam the infinite canvas. The FREEZE lock is the gate — store panBy/zoomAt no-op
      // while frozen (a stray two-finger scroll on the static home does nothing); unfrozen, they roam free.
      // An unfrozen pan claims the gesture burst so crossing a custom scroller can't steal it mid-pan.
      e.preventDefault()
      e.stopPropagation()
      if (isPanGesture && unfrozen) canvasWheelGestureUntil.current = performance.now() + CANVAS_WHEEL_GESTURE_MS
      if (e.ctrlKey) w.zoomAt(e.clientX, e.clientY, e.deltaY)
      else w.panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // Sharp zoom ("auto scaling", like a PDF viewer or Chrome's pinch). will-change:transform keeps .world
  // on the GPU so a pan/zoom composites off the main thread — but it also PINS the layer's raster scale,
  // so a settled scale(2) just stretches the 1x bitmap and text/widgets blur (the resolution loss). So we
  // hold it only WHILE the camera moves and drop it ~200ms after it settles: Chromium then re-rasterizes
  // .world at the new scale and resolution snaps back. (Web surfaces re-render natively via the folded
  // zoomFactor, so they were already sharp — this brings the DOM/widgets up to the same fidelity.)
  useEffect(() => {
    const el = worldRef.current
    if (!el) return
    el.style.willChange = 'transform'
    const t = window.setTimeout(() => {
      if (worldRef.current) worldRef.current.style.willChange = 'auto'
    }, 200)
    return () => window.clearTimeout(t)
  }, [transform])

  // Coalesced page-geometry pass (plans/blitzos-compositor-hardening.md, pillar 2). ONE RAF reads
  // EVERY browser hole's rect + the full z-order together and pushes a single ordered message; main
  // applies all bounds and reorders the L0 page views ONCE. This replaces the N independent
  // per-surface RAFs (each forced a layout/style flush every frame and re-ran the global reorder with
  // a mix of fresh/stale z) — the engine of the multi-browser bleed-order race and the multi-widget
  // glitch. The RAF (not a render effect) is required because canvas pan/zoom moves the holes via a
  // CSS transform on .world without re-rendering the memoized frames. z is store.effectiveZ (no
  // getComputedStyle flush); the drag-lift is component-local but never changes browser-vs-browser
  // order, so it is irrelevant to the L0 page stacking computed here.
  useEffect(() => {
    if (!window.agentOS || window.agentOS.serverMode) return
    let raf = 0
    let last = ''
    const tick = (): void => {
      const st = useDesktop.getState()
      const anims = dockAnimRef.current
      const winW = window.innerWidth || 0
      const winH = window.innerHeight || 0
      // Page fullscreen: synthesize geometry — this view fills the whole window on top (z above every
      // other), every other page view is culled (visible:false) so nothing peeks, zoom 1 (screen-space,
      // camera-independent). We do NOT read the DOM holes here: the page-fullscreen class display:none's
      // the world, so the holes have no rect — the synthesized full-window bounds are the truth.
      const fsId = st.pageFullscreenId
      if (fsId && st.surfaces.some((s) => s.id === fsId && s.kind === 'web')) {
        const fsList = st.surfaces
          .filter((s) => s.kind === 'web')
          .map((s) =>
            s.id === fsId
              ? { id: s.id, rect: { x: 0, y: 0, width: winW, height: winH }, visible: true, z: 9_999_999, zoom: 1 }
              : { id: s.id, rect: { x: 0, y: 0, width: 0, height: 0 }, visible: false, z: 0, zoom: 1 }
          )
        const fsKey = `FS:${fsId}:${winW}x${winH}:${fsList.length}`
        if (fsKey !== last) {
          last = fsKey
          window.agentOS?.webGeometry?.(fsList)
        }
        raf = requestAnimationFrame(tick)
        return
      }
      // One querySelectorAll, then W getBoundingClientRect reads back-to-back (one layout flush).
      const holes = document.querySelectorAll<HTMLElement>('.webcontents-host[data-sid]')
      const byId = new Map<string, HTMLElement>()
      holes.forEach((h) => {
        const id = h.getAttribute('data-sid')
        if (id) byId.set(id, h)
      })
      const list: Array<{ id: string; rect: { x: number; y: number; width: number; height: number }; visible: boolean; z: number; zoom: number }> = []
      for (const s of st.surfaces) {
        if (s.kind !== 'web') continue
        const el = byId.get(s.id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        const visible =
          !s.minimized && anims[s.id] !== 'restoring' && r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < winW && r.top < winH
        list.push({
          id: s.id,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          visible,
          z: effectiveZ(s),
          // Fold the CAMERA scale into the page zoom. The host applies this as the WebContentsView's
          // zoomFactor, and because the view BOUNDS already grow with the camera (rect is the post-
          // transform screen rect), a matching zoomFactor magnifies the LIVE page with NO reflow — a
          // playing video keeps playing, just scaled, like the DOM widgets beside it. (Electron exposes
          // no native view-transform; folding zoomFactor into the camera-scaled bounds IS the mechanism.)
          zoom: (s.zoom ?? 1) * st.transform.scale
        })
      }
      const key = list
        .map((g) => `${g.id}:${Math.round(g.rect.x)},${Math.round(g.rect.y)},${Math.round(g.rect.width)},${Math.round(g.rect.height)},${g.visible ? 1 : 0},${g.z},${g.zoom}`)
        .join('|')
      if (key !== last) {
        last = key
        window.agentOS?.webGeometry?.(list)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ⌘T / ⇧⌘T — tile toggle + size cycle on the window the user means: the single selection if there
  // is one, else the front-most. No editable guard (a ⌘-chord types nothing; a focused note textarea
  // must not eat it). Reached via os:keybind from main (any focus) or the DOM fallback (server mode).
  function runTileKeybind(shift: boolean): void {
    const st = useDesktop.getState()
    const eligible = (x: Surface): boolean => !x.minimized && !x.groupId && !(x.kind === 'native' && (x.component === 'file' || x.component === 'dir' || x.component === 'folder'))
    const selected = st.selection.length === 1 ? st.surfaces.find((x) => x.id === st.selection[0] && eligible(x)) : undefined
    const top = selected ?? st.surfaces.reduce<Surface | null>((best, x) => (eligible(x) && (!best || x.z > best.z) ? x : best), null)
    if (!top) return
    if (shift) st.cycleSurfaceSlotSize(top.id, 1)
    else st.toggleSurfaceSlot(top.id)
  }
  useEffect(() => {
    const off = window.agentOS?.onKeybind?.((k) => {
      if (k.id === 'tile') runTileKeybind(!!k.shift)
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        useDesktop.getState().goToPrimary()
      } else if (e.ctrlKey && e.metaKey && e.key === 'ArrowUp') {
        // ⌃⌘↑ "splay out" — frame all free-form windows (Mission-Control intent). macOS reserves the
        // four-finger swipe-up and plain ⌃↑ for its OWN Mission Control (an app can't intercept them),
        // so this is the app-level equivalent. Slotted widgets stay put; only free windows are framed.
        e.preventDefault()
        useDesktop.getState().splayWindows()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        // Cmd+G: collapse the multi-selection into an iPhone-style folder you tap to open (in-memory
        // `component:'folder'` via groupSelection). Works for ANY surface kind — windows, widgets, notes
        // — whereas the file-based disk folder/board (the old Cmd+G path) silently no-ops on a widget
        // with no file to move. REAL persistent folders/boards stay on the right-click desktop menu and
        // the agent's `group` tool, so this keybind is purely the quick visual grouping.
        e.preventDefault()
        useDesktop.getState().groupSelection()
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)
        if (!editable) {
          const st = useDesktop.getState()
          const id = st.selection.length === 1 ? st.selection[0] : st.activeSurfaceId
          const dir = id ? st.surfaces.find((s) => s.id === id && s.kind === 'native' && s.component === 'dir') : null
          const path = dir?.props?.path
          if (typeof path === 'string' && path) {
            e.preventDefault()
            setRenamingDirPath(path)
          }
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        // layout undo (Cmd+Z) when nothing editable is focused; else let the browser text-undo win
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable) {
          e.preventDefault()
          useDesktop.getState().undoLayout()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete / ⌫ closes selected surfaces, except real folders: keyboard delete is a no-op for
        // filesystem folders. Their context-menu Move off screen is the explicit non-destructive removal.
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        const st = useDesktop.getState()
        if (!editable && st.selection.length) {
          e.preventDefault()
          const ids = [...st.selection]
          const byId = new Map(st.surfaces.map((s) => [s.id, s]))
          const keepSelected: string[] = []
          ids.forEach((id) => {
            const surface = byId.get(id)
            if (surface?.kind === 'native' && surface.component === 'dir') keepSelected.push(id)
            else st.closeSurface(id)
          })
          useDesktop.getState().setSelection(keepSelected)
        }
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyT' && !window.agentOS?.onKeybind) {
        // ⌘T/⇧⌘T DOM fallback for SERVER mode only — in Electron the bind arrives from main's
        // before-input-event (os:keybind), which works even when an iframe/browser guest holds focus.
        e.preventDefault()
        runTileKeybind(e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Hold Space, when not typing → "grab mode": drag any surface from anywhere to move it
  // (and select it); release to interact with content again. Option is reserved for the radial create menu.
  // NOTE: a key held while a browser guest has keyboard focus is delivered to that guest, not
  // here — so grab-mode may not engage until you click off a focused web page. A robust
  // fix is to forward Space from guests via main (like onShiftTap); deferred.
  useEffect(() => {
    const editable = (): boolean => {
      const ae = document.activeElement as HTMLElement | null
      return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === ' ' && !editable()) {
        e.preventDefault()
        useDesktop.getState().setGrabMode(true)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === ' ') useDesktop.getState().setGrabMode(false)
    }
    const clear = (): void => useDesktop.getState().setGrabMode(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useEffect(() => {
    const editable = (): boolean => {
      const ae = document.activeElement as HTMLElement | null
      return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    }
    const move = (e: globalThis.PointerEvent): void => {
      pointerRef.current = { x: e.clientX, y: e.clientY }
    }
    const openAt = (p: { x: number; y: number }): void => {
      if (editable() || showOverviewRef.current) return
      useDesktop.getState().setGrabMode(false)
      setRadialMenu(p)
    }
    // Electron: main forwards bare-Option holds via before-input-event (os:radial), which fires no
    // matter what holds keyboard focus — host DOM, an app/srcdoc iframe, or a browser guest — and
    // carries the TRUE cursor position (pointermove never fires over iframes, so pointerRef goes
    // stale there). The DOM keydown below is the server/browser-transport fallback only; in
    // Electron it stays inert so the two sources never double-fire.
    const offRadial = window.agentOS?.onRadialKey?.((m) => {
      if (m.phase === 'down') openAt(m.x != null && m.y != null ? { x: m.x, y: m.y } : pointerRef.current)
      else setRadialMenu(null)
    })
    const down = (e: KeyboardEvent): void => {
      if (offRadial || e.key !== 'Alt' || e.repeat) return
      e.preventDefault()
      openAt(pointerRef.current)
    }
    const up = (e: KeyboardEvent): void => {
      if (!offRadial && e.key === 'Alt') setRadialMenu(null)
    }
    const clear = (): void => setRadialMenu(null)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      offRadial?.()
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // ⇧ is the keyboard twin of the home orb (single-canvas model, plans/blitzos-single-canvas-navigation.md):
  // a single bare ⇧ tap is the FREEZE TOGGLE (freeze the current view as the static desktop / unfreeze into
  // the infinite canvas), a double tap flies HOME and freezes. Both route through the SAME handleHomePress
  // arbiter so the key and the orb never diverge — and because handleHomePress defers the single-tap action
  // one HOME_DOUBLE_TAP_MS, a double tap goes home WITHOUT first flashing a freeze toggle. No long-press.
  // (ESC is the separate workspace switcher.) A bare ⇧ tap from a focused WebContentsView arrives via
  // onShiftTap (main); plain keydown/keyup covers the browser/server transport.
  // GUARD: ⇧ is a typing/selection modifier, so a tap is suppressed whenever a renderer text field or
  // contenteditable holds focus (priming a capital must never move the camera). Combos (⇧⌘T, ⇧-click)
  // self-cancel via the keydown/pointer `sawOther` paths; browser-page typing leans on the same
  // "any other key cancels it" rule in main's before-input-event tracker.
  useEffect(() => {
    let shiftDown = false
    let sawOther = false
    const editable = (): boolean => {
      const ae = document.activeElement as HTMLElement | null
      return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') {
        // a ⇧ pressed while typing is not a gesture: pre-seed sawOther so the release won't count
        if (!e.repeat) {
          shiftDown = true
          sawOther = editable()
        }
      } else if (shiftDown) {
        sawOther = true
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') {
        if (shiftDown && !sawOther) handleHomePress() // single → freeze toggle, double → fly home + freeze
        shiftDown = false
      }
    }
    // ⇧ used with the mouse (⇧-click / ⇧-drag = additive select) is not a bare tap.
    const pointer = (): void => {
      if (shiftDown) sawOther = true
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('pointerdown', pointer, true)
    const off = window.agentOS?.onShiftTap(handleHomePress)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('pointerdown', pointer, true)
      off?.()
    }
  }, [])

  // Browser-tab page state pushed from main (url/title/favicon/loading/nav state, tab death,
  // popup-as-new-tab) + the machine-global bookmarks for the browser chrome's star/dropdown.
  useEffect(() => {
    useDesktop.getState().loadBookmarks()
    return window.agentOS?.onWebTab?.((m) => useDesktop.getState().applyWebTab(m))
  }, [])

  // Sandwich compositor: the opaque desktop base (.bg) gets screen-space clip holes where pages
  // are, so the live views below show through while window shadows keep compositing against solid
  // color (a fully transparent base made shadows render as dark pooling fringes).
  const bgClip = useDesktop((s) =>
    window.agentOS && !window.agentOS.serverMode ? bgHolesClip(s.surfaces, s.transform, s.viewport.w, s.viewport.h) : undefined
  )

  // The snap/tiling preview is .world DOM with no z; in the sandwich it would paint OVER a browser
  // page (z-index can't order DOM under a page). Cut a page-hole around any web surface so the live
  // page shows through where it covers the preview — same world-coords trick as a SurfaceFrame.
  const snapClip = useDesktop((s) =>
    s.snapPreview && window.agentOS && !window.agentOS.serverMode ? snapPreviewClip(s.snapPreview, s.surfaces) : undefined
  )

  // The radial create-menu is screen-space DOM that fringes over a browser page (the GLASS RULE,
  // see RadialSurfaceMenu). Detect whether the menu's screen rect overlaps any live browser by
  // mapping each web surface's WORLD rect through the live camera (x*scale+tx, as bgHolesClip does)
  // and intersecting the menu's clamped origin rect (286-box at the cursor). Only computed while
  // the menu is open; in server mode there is no page layer so it stays false.
  // True when the radial's center sits over a live browser page. elementsFromPoint is occlusion-
  // correct and needs NO camera math (the earlier world→screen mapping silently missed in this mode,
  // leaving the donut glassy + wired over the page). A page hole anywhere in the stack under the
  // donut center ⇒ it is over a page, so it must drop glass and paint solid (styles.css over-page).
  const radialOverWeb =
    radialMenu && window.agentOS && !window.agentOS.serverMode
      ? (() => {
          const o = menuOrigin(radialMenu)
          return document
            .elementsFromPoint(o.left + MENU_SIZE / 2, o.top + MENU_SIZE / 2)
            .some((el) => !!(el as Element).closest?.('.webcontents-host'))
        })()
      : false


  // Sandwich keyboard handoff, return path: a pointerdown anywhere on UI chrome (anything that is
  // not a page hole) takes the keyboard back from the pages window. The forward path lives on the
  // hole itself (SurfaceFrame onHoleDown → pageFocus).
  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent): void => {
      if (!(e.target as HTMLElement)?.closest?.('.webcontents-host')) window.agentOS?.uiFocus?.()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  // Native-input passthrough (SPIKE, plans/blitzos-native-input.md, default OFF). When on, make the UI
  // window click-through while the cursor is over a page hole so the human's mouse reaches the page as
  // a REAL trusted OS event (fixes the Turnstile checkbox + hover/drag/pinch), and opaque over chrome.
  // elementFromPoint is occlusion-correct: a widget or menu above a page returns that element, not the
  // hole, so the UI keeps the click. forward:true keeps mousemove flowing so we flip back off on exit.
  useEffect(() => {
    if (!window.agentOS?.nativeInput) return
    let over = false
    const onMove = (e: globalThis.MouseEvent): void => {
      // Page fullscreen forces passthrough ON for the whole window (the video owns the mouse); don't let
      // the cursor-over-hole logic fight it back off while a page is fullscreen.
      if (pageFsRef.current) return
      // A titlebar shell-drag (manual window move) must own the pointer for its whole duration. The
      // window trails the cursor by the IPC-delta latency, so mid-drag the cursor can sit over a page
      // hole — but flipping the UI click-through here would route the HELD-button stream to the page
      // below (setIgnoreMouseEvents), killing the captured pointermove and making the window stutter/
      // jump (the "drag sync" bug). Keep L1 opaque for the whole drag; re-evaluate on the next move.
      if (shellDragFrom.current) {
        if (over) { over = false; window.agentOS?.nativePassthrough?.(false) }
        return
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null
      const nowOver = !!el?.closest?.('.webcontents-host')
      if (nowOver !== over) {
        over = nowOver
        window.agentOS?.nativePassthrough?.(nowOver)
      }
    }
    window.addEventListener('mousemove', onMove, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.agentOS?.nativePassthrough?.(false)
    }
  }, [])

  // Control actions from main (local control server or agent-socket).
  useEffect(() => {
    return window.agentOS?.onAction((a) => {
      const st = useDesktop.getState()
      if (a.type === 'hydrate') {
        // FIRST hydrate wins: a live renderer is the source of truth mid-session, so an SSE
        // RECONNECT re-sending hydrate must not wholesale-replace (and wipe undo/camera/canvas).
        if (hydrated.current) return
        // Restore a persisted workspace from disk (Phase 2). Replaces the canvas wholesale.
        const surfs = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cam = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        // Single-canvas model: mode is pinned to 'desktop' and the boot camera is always the computed home
        // frame, so the persisted camera + any legacy stage fields are ignored by the store on hydrate.
        st.hydrate(surfs, cam, 'desktop')
        ensureNotepad()
        hydrated.current = true
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
      } else if (a.type === 'switch') {
        // FORCED re-hydrate on a workspace switch — wholesale swap the canvas. Bypasses the
        // first-hydrate-wins guard, but keeps hydrated.current true (never reset) so a racing SSE
        // reconnect's hydrate still can't clobber the new board.
        const sf = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
        const cm = (a.camera as { x: number; y: number; scale: number }) ?? { x: 0, y: 0, scale: 1 }
        st.hydrate(sf, cm, 'desktop')
        ensureNotepad()
        hydrated.current = true // a switch is also a valid first hydrate — don't depend on a prior 'hydrate'
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
        closeOverview()
      } else if (a.type === 'reconcile') {
        // External folder change (dropped/edited/removed files) — merge live, keeping the camera +
        // the runtime chat/activity panels. Only once we already have a canvas (post first hydrate).
        if (hydrated.current) {
          const incoming = Array.isArray(a.surfaces) ? (a.surfaces as Surface[]) : []
          const pending = pendingFolderSource.current
          const source = pending && performance.now() - pending.at < 5000 ? pending.rect : null
          if (source) pendingFolderSource.current = null
          if (source && !prefersReducedMotion()) {
            let createdId: string | null = null
            flushSync(() => {
              const before = new Set(useDesktop.getState().surfaces.map((s) => s.id))
              st.applyReconcile(incoming)
              const created = useDesktop.getState().surfaces.find((s) => !before.has(s.id) && s.kind === 'native' && s.component === 'dir')
              if (created) {
                createdId = created.id
                setDockAnimation(created.id, 'restoring')
              }
            })
            if (createdId) void animateSurfaceOpenFrom(createdId, source, true)
          } else {
            st.applyReconcile(incoming)
          }
        }
      } else if (a.type === 'create') {
        const surf = a.surface as CreateSurfaceInput
        // agent-opened web/app surfaces are readable by the agent (it chose the url) -> show 👁 on
        if (surf && (surf.kind === 'web' || surf.kind === 'app')) surf.shared = true
        if (!surf) return
        const pendingChat = pendingChatSource.current
        const chatSource = pendingChat && performance.now() - pendingChat.at < 5000 ? pendingChat.rect : null
        if (chatSource) pendingChatSource.current = null
        const existingSurface = surf.id ? st.surfaces.find((s) => s.id === surf.id) : undefined
        // Dedupe by id: a 'create' (e.g. a new agent) can race a hydrate that already brought it.
        // Exception: toolbar-restored chat can intentionally re-broadcast the existing hub; animate it.
        if (existingSurface) {
          if (chatSource && surf.role === 'chat') restoreOrFocusFromSource(existingSurface.id, chatSource)
          return
        }
        // Single-canvas model (plans/blitzos-single-canvas-navigation.md): there is one home region and no
        // per-agent stages, so a new agent's chat widget just cascades onto the home lattice like any other
        // surface. A user '+ Agent' (a.focus) is still flown-to/focused; a background agent's spawn never
        // yanks the user's view.
        const shouldAnimateChat = !!(chatSource && surf?.role === 'chat' && !prefersReducedMotion())
        let createdId = ''
        if (shouldAnimateChat) {
          flushSync(() => {
            createdId = st.createSurface(surf)
            setDockAnimation(createdId, 'restoring')
          })
          void animateSurfaceOpenFrom(createdId, chatSource, true)
        } else {
          createdId = st.createSurface(surf)
        }
        if (a.focus && createdId) useDesktop.getState().focusAndZoom(createdId)
      }
      else if (a.type === 'surface-contextmenu') {
        // Item 5b: a WEB guest's right-click (main intercepts it — the browser guest owns the page).
        // params x/y are guest-viewport CSS px; map to a percent of the surface so the annotation anchors,
        // and to screen px (via the live camera) so the menu opens at the cursor.
        const st = useDesktop.getState()
        const sid = String(a.surfaceId || '')
        const surf = st.surfaces.find((s) => s.id === sid)
        if (surf) {
          const gx = Number(a.x) || 0
          const gy = Number(a.y) || 0
          const xPct = surf.w ? gx / surf.w : 0.5
          const yPct = surf.h ? gy / surf.h : 0.5
          const { x: tx, y: ty, scale } = st.transform
          const sx = tx + (surf.x + gx) * scale
          const sy = ty + (surf.y + gy) * scale
          st.openAnnotationMenu(sid, xPct, yPct, sx, sy)
        }
      }
      else if (a.type === 'permission-request') {
        // A web guest requested a sensitive permission (item 3). Enqueue a real Allow/Block prompt.
        const id = a.id ? String(a.id) : ''
        if (id) setPermissionPrompts((q) => (q.some((p) => p.id === id) ? q : [...q, { id, origin: String(a.origin || ''), permission: String(a.permission || ''), surfaceId: a.surfaceId ? String(a.surfaceId) : null }]))
      }
      else if (a.type === 'move') st.moveSurface(String(a.id), Number(a.x), Number(a.y))
      else if (a.type === 'update') st.updateSurface(String(a.id), (a.patch ?? {}) as Partial<Surface>)
      else if (a.type === 'close') st.closeSurface(String(a.id))
      else if (a.type === 'focus') st.focusSurface(String(a.id))
      else if (a.type === 'goToPrimary') st.goToPrimary()
      else if (a.type === 'set-theme') {
        // Live OS accent (widget/agent picked it): recolor chrome now, persist for next boot. The
        // accent also reaches every srcdoc widget WITHOUT its own props.accent by bumping a token
        // SurfaceFrame folds into the props it posts (board cards keep their own palette accents).
        const theme = (a.theme ?? {}) as { accent?: string; accentDeep?: string }
        if (theme.accent) {
          applyTheme(theme as Theme)
          saveTheme(theme as Theme)
          st.setOsAccent(theme.accent)
        }
      }
      else if (a.type === 'chat') {
        // The OS owns every agent transcript and sends the hub props to the ONE primary Chat surface.
        // Legacy messages-only payloads are still accepted for older transports.
        const sid = a.agentId != null ? String(a.agentId) : '0'
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
      } else if (a.type === 'activity') {
        // A live feed of the agent's tool calls. It feeds an activity panel ONLY IF the user has one
        // open — it NEVER auto-creates one (the chat is the agent's interface; an auto-popping feed
        // clutters the stage — user, 2026-06-12). The feed is opt-in via the Runtime tray.
        const text = String(a.text ?? '')
        if (!text) return
        const evt = { at: Number(a.at) || Date.now(), text }
        const panel = st.surfaces.find((s) => s.kind === 'native' && s.component === 'activity')
        if (panel) {
          const evs = (panel.props?.events as Array<{ at: number; text: string }>) ?? []
          st.updateSurfaceProps(panel.id, { events: [...evs, evt].slice(-60) })
        }
      } else if (a.type === 'terminal-data') {
        // live tmux %output for a terminal -> its terminal surface (terminalStream routes by id)
        pushTerminalData(String(a.id), String(a.data ?? ''))
      } else if (a.type === 'terminal-exit') {
        pushTerminalExit(String(a.id), a.exitCode == null ? null : Number(a.exitCode))
      } else if (a.type === 'terminal-spawn') {
        // A terminal was created (by an agent or the user), or re-adopted on restore. Terminals live as
        // TABS in a terminal window — add this one as a tab (idempotent). Covers both live spawns and the
        // restore() replay that brings back tmux survivors after a restart. Agents auto-show too (an agent
        // IS a terminal you watch claude work in); plain terminals additionally animate from their launcher.
        const term = (a.terminal ?? {}) as { title?: string; stage?: number | null; area?: number | null; kind?: string }
        // Agents run HEADLESS in tmux; their visible interface is the chat widget, not the raw terminal,
        // so an agent's terminal NEVER auto-opens (it would clutter the stage — user, 2026-06-12). It's
        // opt-in via the Runtime tray. Only a PLAIN terminal the user spawned from a control opens, and
        // it animates from that control's rect.
        if (term.kind !== 'agent') {
          const pending = pendingTerminalSource.current
          const source = pending && performance.now() - pending.at < 5000 ? pending.rect : null
          if (source) pendingTerminalSource.current = null
          if (source && !prefersReducedMotion()) {
            let createdId: string | null = null
            flushSync(() => {
              const before = new Set(useDesktop.getState().surfaces.filter((s) => s.kind === 'native' && s.component === 'terminal').map((s) => s.id))
              ensureTerminalTab(String(a.id), term.title || 'Terminal', term.stage ?? term.area)
              const created = useDesktop.getState().surfaces.find((s) => s.kind === 'native' && s.component === 'terminal' && !before.has(s.id))
              if (created) {
                createdId = created.id
                setDockAnimation(created.id, 'restoring')
              }
            })
            if (createdId) void animateSurfaceOpenFrom(createdId, source, true)
          } else {
            ensureTerminalTab(String(a.id), term.title || 'Terminal', term.stage ?? term.area)
          }
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
        // An agent was deleted (host removed its widget via the 'close' broadcast + its files). Single-canvas
        // model: there are no per-agent stages to collapse — just drop the agent's terminal tab if it's
        // still around.
        const cur = useDesktop.getState()
        const rid = String(a.id)
        for (const w of cur.surfaces) {
          if (w.kind === 'native' && w.component === 'terminal' && w.tabs?.some((t) => t.terminalId === rid)) {
            const tab = w.tabs.find((t) => t.terminalId === rid)
            if (tab) st.closeTab(w.id, tab.id)
          }
        }
      }
    })
  }, [])

  // Ask main for the persisted canvas once our onAction listener (above) is mounted; Electron
  // replies with a 'hydrate' os:action. In server mode the SSE connect delivers it, so this no-ops.
  useEffect(() => {
    window.agentOS?.requestHydrate?.()
  }, [])

  // Resume terminals: terminal surfaces aren't serialized (they're runtime-only), so on load — and on
  // every workspace switch — we reconstruct a terminal tab for each terminal still ALIVE in this
  // workspace, INCLUDING agents (an agent is a terminal you watch claude work in). tmux keeps the process
  // across a BlitzOS/page restart; calling terminalList() also drives the backend's lazy restore()
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
        for (const s of list as Array<{ id?: string; title?: string; status?: string; kind?: string; stage?: number | null; area?: number | null }>) {
          if (!s || !s.id || s.status !== 'running') continue
          // Reconstruct a terminal tab for EVERY live terminal — plain shells AND agents. An agent IS a
          // terminal you watch claude work in, so its terminal is shown in ITS stage (find-or-create);
          // tabs are renderer-only (not serialized), so this is how they come back after a reload.
          ensureTerminalTab(String(s.id), s.title || (s.kind === 'agent' ? 'Agent' : 'Terminal'), s.stage ?? s.area)
        }
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

  // srcdoc surfaces (agent-authored UI) can fire actions back to the agent: a
  // sandboxed iframe postMessages {__blitz:'action', surfaceId, ...} to us and we
  // forward it to main, which emits it into the agent's event stream (the callback
  // half of interactive surfaces, e.g. an "approve" button in a triage panel).
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as Record<string, unknown> | null
      if (!d || typeof d !== 'object') return
      // Local UI action: navigate the shared "Sources" tab instantly, no agent round-trip.
      // Only http(s) — a sandboxed widget must not push javascript:/data:/file: URLs into a web surface.
      if (d.__blitz === 'navigate' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
        const st = useDesktop.getState()
        const tab = st.surfaces.find((s) => s.kind === 'web' && s.title === 'Sources')
        if (tab) st.updateSurface(tab.id, { url: d.url as string })
        else st.createSurface({ kind: 'web', url: d.url as string, title: 'Sources' })
        return
      }
      // Agent action: forward to the agent's event stream (approve, etc.). Cap the
      // payload so a hostile widget can't pump large/looping content through it.
      if (d.__blitz === 'action') {
        try {
          if (JSON.stringify(d).length <= 4000) window.agentOS?.surfaceAction(d)
        } catch {
          /* non-serializable payload — drop */
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Push desktop state to main (so list_state works). Includes the layout the agent
  // needs to arrange windows well: the viewport (screen size), the world-space rect the
  // user can actually SEE right now (so it never drops surfaces off-screen), per-surface
  // z (stacking), and the mode. Surface changes push immediately; camera/pan churn is
  // throttled so panning doesn't flood the channel.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      if (!hydrated.current) return // don't clobber a restoring canvas with our empty store
      const st = useDesktop.getState()
      const { scale, x: tx, y: ty } = st.transform
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
        // Home-lattice membership must survive the round-trip too: workspace.mjs stageFields persists
        // slot from THIS push — dropping it here silently demoted every tile to a free window on the next
        // flush (observed: the seeded case-file board lost its slots).
        slot: s.slot,
        // Browser tabs persist (.weblink) + surface in list_state from THIS push too — persistable
        // fields only ({id,title,url}; favicon/loading/nav state are runtime chrome).
        tabs: s.tabs?.map((t) => ({ id: t.id, title: t.title, url: t.url, terminalId: t.terminalId })),
        activeTab: s.activeTab,
        // Chat + Agent-activity panels are pinned always-on-top — the agent must not cover them
        pinned: isRuntimePanel(s)
      }))
      // The world-space rectangle currently visible on screen (screen = world*scale + t).
      const view = {
        x: Math.round(-tx / scale),
        y: Math.round(-ty / scale),
        w: Math.round(vw / scale),
        h: Math.round(vh / scale),
        cx: Math.round((vw / 2 - tx) / scale),
        cy: Math.round((vh / 2 - ty) / scale),
        scale: Math.round(scale * 100) / 100
      }
      // camera = the WORLD point at screen center + scale (viewport-independent, so it restores
      // correctly on a different screen size — view.cx/cy are exactly that world point). Single-canvas
      // model: no stage count/order/current-stage are pushed — the agent places onto the one home
      // region (list_state returns grid: gridSummary instead).
      window.agentOS?.sendState({
        workspace: activeWsRef.current ?? undefined,
        surfaces,
        viewport: { w: vw, h: vh },
        view,
        mode: st.mode,
        camera: { x: view.cx, y: view.cy, scale },
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
    let lastT = useDesktop.getState().transform
    let lastVp = useDesktop.getState().viewport
    let lastMode = useDesktop.getState().mode
    const scheduleCamera = (): void => {
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
      } else if (state.transform !== lastT || state.viewport !== lastVp || state.mode !== lastMode) {
        lastT = state.transform
        lastVp = state.viewport
        lastMode = state.mode
        scheduleCamera() // pan/zoom — coalesce bursts
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

  // Drag a file from the desktop onto the canvas → upload it into the workspace folder at the drop
  // world-position (server mode; Electron drag-drop uses file paths — a separate path). The tile
  // then appears via reconcile.
  function onDragOver(e: React.DragEvent): void {
    if (Array.from(e.dataTransfer?.types ?? []).includes(FOLDER_ENTRY_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      return
    }
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  function onDrop(e: React.DragEvent): void {
    const hasFolderEntry = Array.from(e.dataTransfer?.types ?? []).includes(FOLDER_ENTRY_MIME)
    const files = Array.from(e.dataTransfer?.files ?? [])
    const items = Array.from(e.dataTransfer?.items ?? [])
    if (!hasFolderEntry && !files.length && !items.length) return
    e.preventDefault()
    const t = useDesktop.getState().transform
    const wx = Math.round((e.clientX - t.x) / t.scale)
    const wy = Math.round((e.clientY - t.y) / t.scale)
    const api = window.agentOS
    if (hasFolderEntry) {
      e.preventDefault()
      let paths: string[] = []
      try {
        const payload = JSON.parse(e.dataTransfer.getData(FOLDER_ENTRY_MIME) || '{}')
        paths = Array.isArray(payload.paths) ? payload.paths.map(String) : []
      } catch {
        paths = []
      }
      if (paths.length) {
        void api?.moveOutOfFolder?.(paths, wx, wy).then((r) => {
          if (!r?.ok) return
          const returned = Array.isArray(r.surfaces) ? (r.surfaces as Surface[]) : []
          const existing = new Set(useDesktop.getState().surfaces.map((s) => s.id))
          for (const surface of returned) {
            if (!surface?.id) continue
            if (existing.has(surface.id)) updateSurface(surface.id, surface)
            else createSurface(surface as CreateSurfaceInput)
          }
          const focusId = Array.isArray(r.surfaceIds) ? r.surfaceIds[0] : returned[0]?.id
          if (focusId) window.setTimeout(() => focusAndZoom(String(focusId)), 0)
          window.dispatchEvent(new CustomEvent('blitz-folder-entry-moved', { detail: { paths: r.movedPaths || paths } }))
        }).catch(() => {})
      }
      return
    }
    // Electron: dropped files AND folders carry real OS paths → copy them into the workspace (a folder
    // copies recursively → ONE collapsed tile). This is the desktop-app path the old code skipped (bug).
    if (api && !api.serverMode && api.dropPaths && api.ingestPaths) {
      const paths = api.dropPaths(files)
      if (paths.length) {
        void api.ingestPaths(paths, wx, wy)
        return
      }
    }
    // Server: the browser has no FS path → upload bytes. A dropped FOLDER is recursed via webkitGetAsEntry
    // (each file uploaded with its in-folder subpath, then one reconcile) so it lands as a real subfolder.
    const entries = items.map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null)).filter((en): en is FileSystemEntry => !!en)
    if (entries.some((en) => en.isDirectory)) {
      void uploadDroppedEntries(entries, wx, wy)
      return
    }
    if (!files.length) return
    files.forEach(async (file, i) => {
      try {
        const buf = await file.arrayBuffer()
        await fetch(`/api/os/upload?name=${encodeURIComponent(file.name)}&x=${wx + i * 24}&y=${wy + i * 24}`, { method: 'POST', body: buf })
      } catch {
        /* ignore a failed upload */
      }
    })
  }

  // Right-click empty canvas → New Folder menu (the discoverable counterpart of Cmd+G).
  function onBgContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const t = useDesktop.getState().transform
    setFolderMenu(null)
    setMenu({ x: e.clientX, y: e.clientY, wx: Math.round((e.clientX - t.x) / t.scale), wy: Math.round((e.clientY - t.y) / t.scale) })
  }
  // New EMPTY folder at the click point. Board support remains for existing/internal flows while the
  // user-facing creation entry points are hidden.
  function makeFolder(kind: 'folder' | 'board', wx: number, wy: number, source?: AnimationSourceRect | null): void {
    if (source) pendingFolderSource.current = { rect: source, at: performance.now() }
    const req = window.agentOS?.newFolder?.(kind === 'board' ? 'Board' : 'Folder', kind, wx, wy)
    if (!req) pendingFolderSource.current = null
    void Promise.resolve(req).then((r) => {
      if (!r?.ok) pendingFolderSource.current = null
      else if (kind === 'folder' && r.folder) setRenamingDirPath(r.folder)
    })
  }
  // Group the current selection into a real folder (files) or board (windows/widgets stay live + splay).
  function groupSelectionInto(kind: 'folder' | 'board'): void {
    const ids = [...useDesktop.getState().selection]
    if (!ids.length) return
    void window.agentOS?.groupIntoFolder?.(kind === 'board' ? 'Board' : 'Folder', ids, kind)
    useDesktop.getState().clearSelection()
  }

  function onBgDown(e: React.PointerEvent): void {
    // Only the LEFT button pans / starts a marquee / clears the selection. A right-click is the context
    // menu (onBgContextMenu) — it must NOT clear the selection, or "New Folder with Selection (N)"
    // would never show (the right-click's pointerdown was wiping the very selection the menu groups).
    if (e.button !== 0) return
    const st = useDesktop.getState()
    st.clearActiveSurface()
    if (!st.locked) {
      // UNFROZEN infinite canvas (single-⇧): drag the background void to pan (single-canvas model).
      pan.current = { x: e.clientX, y: e.clientY }
    } else {
      // Frozen desktop: rubber-band (marquee) selection. Shift adds to the selection.
      if (!e.shiftKey) st.clearSelection()
      marquee.current = { x0: e.clientX, y0: e.clientY }
      setMarqueeRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* no pointer capture (e.g. synthetic events) — fine */
    }
  }
  function onBgMove(e: React.PointerEvent): void {
    if (pan.current) {
      useDesktop.getState().panBy(e.clientX - pan.current.x, e.clientY - pan.current.y)
      pan.current = { x: e.clientX, y: e.clientY }
      return
    }
    if (!marquee.current) return
    const { x0, y0 } = marquee.current
    const x = Math.min(x0, e.clientX)
    const y = Math.min(y0, e.clientY)
    const w = Math.abs(e.clientX - x0)
    const h = Math.abs(e.clientY - y0)
    setMarqueeRect({ x, y, w, h })
    // screen rect -> world rect (screen = world*scale + t), then AABB-intersect surfaces
    const st = useDesktop.getState()
    const t = st.transform
    const wr = { x: (x - t.x) / t.scale, y: (y - t.y) / t.scale, w: w / t.scale, h: h / t.scale }
    const hit = st.surfaces
      .filter((s) => wr.x < s.x + s.w && wr.x + wr.w > s.x && wr.y < s.y + s.h && wr.y + wr.h > s.y)
      .map((s) => s.id)
    st.setSelection(hit)
  }
  function onBgUp(e: React.PointerEvent): void {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    pan.current = null
    marquee.current = null
    setMarqueeRect(null)
  }

  // The Chat panel docks to the LEFT of whatever the user is currently looking at,
  // so it opens visible (and stays out of the stage where the agent puts windows).
  function chatSurfaceInput(messages: Array<{ role: string; text: string }>): CreateSurfaceInput {
    const st = useDesktop.getState()
    const { scale, x: tx, y: ty } = st.transform
    const W = 360
    const H = 460
    const x = Math.round(-tx / scale + 24) // 24 world-px from the left edge of the view
    const y = Math.round((st.viewport.h / 2 - ty) / scale - H / 2) // vertically centered
    return { kind: 'native', component: 'chat', title: 'Chat', w: W, h: H, x, y, props: { messages } }
  }

  // Open/focus a terminal tab (idempotent). Shared by the live terminal-spawn action, resume-on-load,
  // and the Runtime tray — the placement + add-tab-or-create logic lives in the store action so all
  // three callers stay in sync.
  function ensureTerminalTab(tid: string, title: string, stage?: number | null): void {
    useDesktop.getState().openTerminal(tid, title || 'Terminal', stage)
  }

  // The Action-items inbox docks TOP-RIGHT of the current view (out of the way of chat/activity which
  // dock left), so a pushed task is visible without covering the conversation.
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

  function addBrowser(source?: AnimationSourceRect | null, at?: { x: number; y: number } | null): void {
    // Option menu: center the 920x640 browser on the cursor, free of the home clamp. From the dock
    // (at == null) the store cascades + clamps it onto home.
    const pos = at ? { x: Math.round(at.x - 460), y: Math.round(at.y - 320), free: true } : {}
    createSurfaceFromSource({ kind: 'web', url: 'https://www.google.com', title: 'Google', ...pos }, source)
  }

  function visibleWorldCenter(): { x: number; y: number } {
    const st = useDesktop.getState()
    return {
      x: Math.round((st.viewport.w / 2 - st.transform.x) / st.transform.scale),
      y: Math.round((st.viewport.h / 2 - st.transform.y) / st.transform.scale)
    }
  }

  // World point under the Option radial menu (= the cursor when it opened; the Electron path forwards the
  // true cursor even over iframes). Null when createFromLauncher is invoked from the dock, so that path
  // keeps the home cascade.
  function radialWorldPos(): { x: number; y: number } | null {
    if (!radialMenu) return null
    const t = useDesktop.getState().transform
    return { x: Math.round((radialMenu.x - t.x) / t.scale), y: Math.round((radialMenu.y - t.y) / t.scale) }
  }

  function createFromLauncher(kind: SurfaceLauncherKind, source?: AnimationSourceRect | null): void {
    // The Option radial menu opens AT the cursor, so create the surface centered there and FREE of the
    // home clamp — it lands where the user pointed, even off-home. Invoked from the dock instead, `at` is
    // null and creation falls back to the home cascade (plans/blitzos-single-canvas-navigation.md).
    const at = radialWorldPos()
    const centered = (w: number, h: number): Partial<CreateSurfaceInput> =>
      at ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), free: true } : {}
    if (kind === 'browser') {
      addBrowser(source, at)
      return
    }
    if (kind === 'note') {
      createSurfaceFromSource({ kind: 'native', component: 'note', title: 'Note', w: 280, h: 260, props: { text: '', color: 'yellow' }, ...centered(280, 260) }, source)
      return
    }
    if (kind === 'chat') {
      // Single-canvas model (plans/blitzos-single-canvas-navigation.md): there is one home region and one
      // chat hub. If a chat surface already exists, select/restore it — never spawn a duplicate; otherwise
      // spawn a fresh agent + its chat widget (the host broadcasts the surface create, so it appears without
      // a refresh — Electron-only; the server shim has no agents).
      const st = useDesktop.getState()
      const existing = findChatHub(st.surfaces)
      if (existing) {
        if (existing.minimized) restoreOrFocusFromSource(existing.id, source)
        else st.focusSurface(existing.id)
        return
      }
      window.agentOS?.spawnAgent?.()
      return
    }
    if (kind === 'widget') {
      createSurfaceFromSource({ kind: 'srcdoc', title: 'Widget', w: 420, h: 300, html: WIDGET_PLACEHOLDER_HTML, ...centered(420, 300) }, source)
      return
    }
    const c = at ?? visibleWorldCenter()
    makeFolder(kind, c.x, c.y, source)
  }

  // Capture the CURRENT board's primary-stage snapshot and upload it as its workspace thumbnail
  // (best-effort, last-seen). Done before opening the overview and before switching away (while the
  // board we're leaving still has live streamed frames — they're torn down by the switch).
  async function captureCurrent(): Promise<void> {
    // Hard guard: the board is snapshotted in openOverview BEFORE the overlay mounts (the only moment the
    // canvas is the visible top layer). If the overview is already up, bail — capturePage would otherwise
    // save the overlay itself as this workspace's thumbnail.
    if (showOverviewRef.current) return
    const name = activeWsRef.current
    const ws = window.agentOS?.workspaces
    if (!name || !ws) return
    try {
      if (ws.captureThumb) {
        await ws.captureThumb(name) // Electron: main-side capturePage (real pixels, incl. WebContentsViews)
      } else if (ws.thumb) {
        const dataUrl = capturePrimaryThumb() // server: composite the streamed canvases + upload
        if (dataUrl) await ws.thumb(name, dataUrl)
      }
    } catch {
      /* best-effort snapshot */
    }
  }
  async function openOverview(capture = true): Promise<void> {
    if (overviewOpening.current || showOverviewRef.current) return
    overviewOpening.current = true
    if (capture) await captureCurrent() // refresh the active board's tile first
    if (!overviewOpening.current) return
    showOverviewRef.current = true
    setShowOverview(true)
    overviewOpening.current = false
  }
  function closeOverview(): void {
    overviewOpening.current = false
    showOverviewRef.current = false
    setShowOverview(false)
  }
  function handleHomeSingleTap(): void {
    closeToolbarTooltip()
    // If the workspace switcher is open, a tap just closes it.
    if (showOverviewRef.current || overviewOpening.current) {
      closeOverview()
      return
    }
    // One-shot, then toggle (plans/blitzos-single-canvas-navigation.md): a single ⇧ from the LOCKED home
    // screen pulls the camera back 50% and unfreezes (survey the canvas); after that ⇧ is the plain FREEZE
    // TOGGLE (flip the pan/zoom lock so the current viewport freezes into the static desktop, or unfreezes).
    const st = useDesktop.getState()
    if (st.locked && isHomeTransform(st.transform, homeTransform(st.viewport))) {
      st.zoomOutFromHome()
      return
    }
    st.toggleLock()
  }

  function handleHomeDoubleTap(): void {
    closeToolbarTooltip()
    if (showOverviewRef.current || overviewOpening.current) return
    // Double ⇧ = return to the home screen, static: fly the camera to the home frame and FREEZE it.
    useDesktop.getState().goToPrimary()
    useDesktop.setState({ locked: true })
  }

  function handleHomePress(): void {
    closeToolbarTooltip()
    if (homeTapTimer.current != null) {
      window.clearTimeout(homeTapTimer.current)
      homeTapTimer.current = null
      void handleHomeDoubleTap()
      return
    }
    homeTapTimer.current = window.setTimeout(() => {
      homeTapTimer.current = null
      handleHomeSingleTap()
    }, HOME_DOUBLE_TAP_MS)
  }
  async function switchWorkspace(name: string): Promise<{ ok: boolean; error?: string }> {
    // Don't capture here: this only runs from the OPEN overview, so the board we're leaving is obscured by
    // the overlay. openOverview already snapshotted it before the overlay mounted, and that thumb is still
    // current (the workspace can't change while you're sitting in the overview).
    const r = await window.agentOS?.workspaces?.switch(name)
    // success → the {type:'switch'} broadcast swaps the canvas + closes the overview; a 409 (lock) /
    // 404 / 500 resolves {error} (getJSON never throws) → signal it so the overview clears "opening…".
    return r?.ok ? { ok: true } : { ok: false, error: (r as { error?: string })?.error || 'could not switch' }
  }

  // The Runtime tray ("Terminals & Agents"): a glanceable list of every terminal + agent in the
  // workspace. Docks to the left of the current view (like Chat); focus it if it's already open.
  function openRuntime(source?: AnimationSourceRect | null): void {
    const st = useDesktop.getState()
    const existing = st.surfaces.find((s) => s.kind === 'native' && s.component === 'runtime')
    if (existing) {
      if (existing.minimized) restoreOrFocusFromSource(existing.id, source)
      else st.focusSurface(existing.id)
      return
    }
    const { scale, x: tx, y: ty } = st.transform
    const W = 380
    const H = 480
    const x = Math.round(-tx / scale + 24)
    const y = Math.round((st.viewport.h / 2 - ty) / scale - H / 2)
    createSurfaceFromSource({ kind: 'native', component: 'runtime', title: 'Terminals & Agents', w: W, h: H, x, y }, source)
  }

  // The Action-items inbox: focus it if open, else create it empty (the agent fills it via request_action).
  function openInbox(source?: AnimationSourceRect | null): void {
    const st = useDesktop.getState()
    const existing = st.surfaces.find((s) => s.kind === 'native' && s.component === 'inbox')
    if (existing) {
      if (existing.minimized) restoreOrFocusFromSource(existing.id, source)
      else st.focusSurface(existing.id)
    } else createSurfaceFromSource(inboxSurfaceInput([]), source)
  }

  function openChat(source?: AnimationSourceRect | null): void {
    const st = useDesktop.getState()
    // The chat is a host-hydrated role:'chat' srcdoc widget (blitz-chat.*). Just focus/center it; if a
    // very old board is still on the native chat, fall back to that.
    const existing = st.surfaces.find((s) => s.role === 'chat' || (s.kind === 'native' && s.component === 'chat'))
    if (existing) restoreOrFocusFromSource(existing.id, source)
    else createSurfaceFromSource(chatSurfaceInput([]), source)
  }

  function setDockAnimation(id: string, phase: DockAnimationPhase | null): void {
    if (phase) dockAnimationIds.current.add(id)
    else dockAnimationIds.current.delete(id)
    setDockAnimations((cur) => {
      const next = { ...cur }
      if (phase) next[id] = phase
      else delete next[id]
      return next
    })
  }

  async function animateSurfaceOpenFrom(id: string, source: AnimationSourceRect | null | undefined, alreadyMarked = false): Promise<void> {
    if (!source || prefersReducedMotion()) return
    if (!alreadyMarked && (dockAnimationIds.current.has(id) || rectAnimationIds.current.has(id))) return
    if (!alreadyMarked) setDockAnimation(id, 'restoring')
    await nextPaint()

    const el = findByData('data-sid', id)
    if (!el) {
      setDockAnimation(id, null)
      return
    }

    let cleanup: (() => void) | null = null
    try {
      cleanup = await animateDockMotionFromRect(el, source, useDesktop.getState().transform.scale, 'restoring')
    } finally {
      cleanup?.()
      setDockAnimation(id, null)
    }
  }

  function createSurfaceFromSource(input: CreateSurfaceInput, source?: AnimationSourceRect | null): string {
    if (!source || prefersReducedMotion()) return createSurface(input)
    let id = ''
    flushSync(() => {
      id = createSurface(input)
      setDockAnimation(id, 'restoring')
    })
    void animateSurfaceOpenFrom(id, source, true)
    return id
  }

  function restoreOrFocusFromSource(id: string, source?: AnimationSourceRect | null): void {
    const surf = useDesktop.getState().surfaces.find((s) => s.id === id)
    if (!surf) return
    if (!surf.minimized) {
      focusAndZoom(id)
      return
    }
    if (!source || prefersReducedMotion()) {
      updateSurface(id, { minimized: false })
      focusAndZoom(id)
      return
    }
    flushSync(() => {
      setDockAnimation(id, 'restoring')
      updateSurface(id, { minimized: false })
      focusAndZoom(id)
    })
    void animateSurfaceOpenFrom(id, source, true)
  }

  async function requestMinimize(id: string): Promise<void> {
    if (dockAnimationIds.current.has(id) || rectAnimationIds.current.has(id)) return
    const surf = useDesktop.getState().surfaces.find((s) => s.id === id)
    if (!surf || surf.minimized) return
    if (prefersReducedMotion()) {
      minimizeSurface(id)
      return
    }

    const el = findByData('data-sid', id)
    const dock = findByData('data-sidebar-sid', id)
    if (!el || !dock) {
      minimizeSurface(id)
      return
    }

    setDockAnimation(id, 'minimizing')
    let cleanup: (() => void) | null = null
    try {
      cleanup = await animateDockMotion(el, dock, useDesktop.getState().transform.scale, 'minimizing')
      minimizeSurface(id)
    } finally {
      cleanup?.()
      setDockAnimation(id, null)
    }
  }

  async function requestRestore(id: string): Promise<void> {
    if (dockAnimationIds.current.has(id) || rectAnimationIds.current.has(id)) return
    const surf = useDesktop.getState().surfaces.find((s) => s.id === id)
    if (!surf) return
    if (!surf.minimized) {
      focusAndZoom(id)
      return
    }
    if (prefersReducedMotion()) {
      updateSurface(id, { minimized: false })
      focusAndZoom(id)
      return
    }

    setDockAnimation(id, 'restoring')
    updateSurface(id, { minimized: false })
    focusAndZoom(id)
    await nextPaint()

    const el = findByData('data-sid', id)
    const dock = findByData('data-sidebar-sid', id)
    if (!el || !dock) {
      setDockAnimation(id, null)
      return
    }

    let cleanup: (() => void) | null = null
    try {
      cleanup = await animateDockMotion(el, dock, useDesktop.getState().transform.scale, 'restoring')
    } finally {
      cleanup?.()
      setDockAnimation(id, null)
    }
  }

  async function requestToggleMaximize(id: string): Promise<void> {
    if (dockAnimationIds.current.has(id) || rectAnimationIds.current.has(id)) return
    const surf = useDesktop.getState().surfaces.find((s) => s.id === id)
    if (!surf || surf.minimized) return
    if (prefersReducedMotion()) {
      toggleMaximize(id)
      return
    }

    const el = findByData('data-sid', id)
    if (!el) {
      toggleMaximize(id)
      return
    }

    rectAnimationIds.current.add(id)
    const from = { x: surf.x, y: surf.y, w: surf.w, h: surf.h }
    flushSync(() => toggleMaximize(id))

    const nextEl = findByData('data-sid', id)
    if (!nextEl) {
      rectAnimationIds.current.delete(id)
      return
    }

    let cleanup: (() => void) | null = null
    try {
      cleanup = await animateSurfaceGeometryMotion(nextEl, from)
    } finally {
      cleanup?.()
      rectAnimationIds.current.delete(id)
    }
  }

  const openFolder = surfaces.find((s) => s.kind === 'native' && s.component === 'folder' && s.props?.open)
  // Pending action-items count → the toolbar Inbox badge (so the human notices tasks even when the inbox is buried).
  const inboxPending = (() => {
    const p = surfaces.find((s) => s.kind === 'native' && s.component === 'inbox')
    return ((p?.props?.items as Array<{ status?: string }>) ?? []).filter((i) => i.status === 'pending').length
  })()
  return (
    <div
      id="root-canvas"
      ref={rootRef}
      className={[grabMode ? 'grab-mode' : null, pageFullscreenId ? 'page-fullscreen' : null, notchOn ? 'notch-mode' : null, notchAnimating ? 'notch-anim' : null, notchState === 'open' ? 'notch-open' : null].filter(Boolean).join(' ')}
      // THE MERGE: clip the whole live canvas to the NotchShape and GROW the clip to fullscreen — the real
      // content is revealed as the clip grows out of the notch. The transition + GPU promotion live in CSS
      // (#root-canvas.notch-mode) so the grow animates on the compositor (butter-smooth, not a main-thread re-clip).
      style={notchOn ? { clipPath: notchClip, WebkitClipPath: notchClip } : undefined}
      // The clip transition is done → unfreeze widget motion (notch-anim pauses animations during the grow/shrink
      // so the texture is static = pure GPU compositing). Only #root-canvas's OWN clip-path transition counts.
      onTransitionEnd={(e) => {
        if (notchOn && e.target === e.currentTarget && e.propertyName === 'clip-path') setNotchAnimating(false)
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDownCapture={() => {
        // Keyboard-focus reclaim: iframes/browser guests swallow window keydown while focused, killing every
        // app keybind (⌘T etc.). A pointerdown that reaches the HOST at all means the user is now
        // interacting OUTSIDE the guest — blur it so the next keystroke lands in the app again.
        const ae = document.activeElement as HTMLElement | null
        if (ae && ae.tagName === 'IFRAME') ae.blur()
      }}
    >
      {/* Shell title bar — MANUAL drag (pointer deltas → main moves the sandwich's parent window; CSS
          app-region would drag only the attached child and detach the layers). In APP fullscreen it stays
          mounted but slides OFF the top, returning on a top-edge hover like a native macOS fullscreen
          window so the traffic lights stay reachable; drag is disabled there (a fullscreen window can't
          move). In VIDEO fullscreen the page-fullscreen class hides it with the rest of the chrome. */}
      <div
        className={`titlebar${shellFullscreen ? ' fs' : ''}${shellFullscreen && titlebarRevealed ? ' fs-revealed' : ''}`}
        onPointerDown={(e) => {
          if (shellFullscreen || e.button !== 0) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          shellDragFrom.current = { x: e.screenX, y: e.screenY }
          window.agentOS?.shellDrag?.('start')
        }}
        onPointerMove={(e) => {
          const o = shellDragFrom.current
          if (o) window.agentOS?.shellDrag?.('move', e.screenX - o.x, e.screenY - o.y)
        }}
        onPointerUp={(e) => {
          shellDragFrom.current = null
          try {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
        }}
        onPointerCancel={() => {
          shellDragFrom.current = null
        }}
      >
        {/* Custom macOS traffic lights. The native ones are hidden (sandwich.ts) because the green light
            must drive the PAIR fullscreen — a child window can't enter native fullscreen without
            detaching from its parent and blanking the live pages. stopPropagation keeps a button click
            from also starting a titlebar window-drag. */}
        <div className="traffic titlebar-traffic is-active" onPointerDown={(e) => e.stopPropagation()}>
          <button className="tl tl-close" title="Close" onClick={() => window.agentOS?.shellClose?.()} />
          <button className="tl tl-min" title="Minimize" onClick={() => window.agentOS?.shellMinimize?.()} />
          <button className="tl tl-max" title="Toggle Full Screen" onClick={() => window.agentOS?.shellFullScreen?.()} />
        </div>
        <span className="titlebar-label">BlitzOS</span>
      </div>

      {/* THE NOTCH (dynamic island). The handle is the always-on-top black pill: closed it IS the notch; expanded
          it stays at top-center as the click-to-collapse handle. The entry (Ask Blitz) is the black hover panel.
          Both live INSIDE #root-canvas, so its clip reveals the LIVE canvas AROUND them as it grows out of the
          notch — no separate window, no plate. Only mounted in overlay mode (notchOn). */}
      {notchOn && (
        <>
          <div
            ref={notchHandleRef}
            className={`notch-handle${notchState !== 'closed' || notchOpening ? ' is-open' : ''}`}
            style={{ width: NOTCH_W, height: Math.max(28, notchMenuBarH) }}
            onClick={(e) => {
              e.stopPropagation()
              toggleNotch()
            }}
          >
            <div className="notch-peek">
              <i className="d1" />
              <i />
              <i />
              <i className="d2" />
            </div>
          </div>
          <div className={`notch-entry${notchState === 'panel' && !notchOpening ? ' show' : ''}${notchPinned ? ' pinned' : ''}`} style={{ paddingTop: Math.max(28, notchMenuBarH) + 12 }}>
            <textarea
              className="notch-pq"
              rows={1}
              placeholder="Ask Blitz, or describe a task"
              value={notchPrompt}
              onChange={(e) => setNotchPrompt(e.target.value)}
              onFocus={() => {
                if (notchStateRef.current !== 'open') applyNotchState('panel')
                setNotchInteractive(true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void onNotchSend()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  ;(e.target as HTMLTextAreaElement).blur()
                  setNotchPinnedBoth(false) // Esc dismisses a pinned (⌥Space) panel too
                  applyNotchState('closed')
                  setNotchInteractive(false)
                }
              }}
            />
            <div className="notch-ctl">
              <button
                className={`notch-deep${notchDeep ? ' on' : ''}`}
                onClick={() => setNotchDeep((v) => !v)}
                title="Deep = run as an orchestrated workflow"
              >
                <span className="notch-sw" />
                <span>Deep</span>
              </button>
              <span className="notch-sp" />
              <button className="notch-send" disabled={!notchPrompt.trim() || notchSending} onClick={() => void onNotchSend()}>
                Send
              </button>
            </div>
          </div>
        </>
      )}

      <div
        className="bg"
        style={bgClip === 'HIDE' ? { visibility: 'hidden' } : bgClip ? { clipPath: bgClip } : undefined}
        onPointerDown={onBgDown}
        onPointerMove={onBgMove}
        onPointerUp={onBgUp}
        onContextMenu={onBgContextMenu}
      />

      <Sidebar onRequestRestore={requestRestore} onCreateSurface={createFromLauncher} animating={dockAnimations} />

      <div
        ref={worldRef}
        className="world"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        <PrimarySpace />
        {snapPreview && (
          <div
            className="snap-preview"
            style={{
              left: snapPreview.x,
              top: snapPreview.y,
              width: snapPreview.w,
              height: snapPreview.h,
              ...(snapClip && snapClip !== 'HIDE' ? { clipPath: snapClip } : {}),
              ...(snapClip === 'HIDE' ? { display: 'none' } : {})
            }}
          />
        )}
        {surfaces.map((s) =>
          // folder members live only inside the folder — unless "peeked" open onto the desktop
          s.groupId && !s.peek ? null : (
            <SurfaceFrame
              key={s.id}
              surface={s}
              onRequestMinimize={requestMinimize}
              onRequestToggleMaximize={requestToggleMaximize}
              restoring={dockAnimations[s.id] === 'restoring'}
              renamingDirPath={renamingDirPath}
              onDirRenameDone={() => setRenamingDirPath(null)}
              onDirContextMenu={(id, x, y) => {
                setMenu(null)
                setFolderMenu({ id, x, y })
              }}
            />
          )
        )}
        {/* Item 5b: spatial annotations pin to surfaces (in-world so they pan/zoom with their surface). */}
        <AnnotationLayer />
      </div>

      {/* FREEZE state hint (plans/blitzos-single-canvas-navigation.md): present = unfrozen infinite canvas
          (pan/zoom live); absent = frozen static desktop. Inline-styled so this prototype slice touches no CSS. */}
      {!locked && (
        <div
          className="freeze-hint"
          style={{
            position: 'fixed',
            bottom: 18,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 6000,
            pointerEvents: 'none',
            padding: '6px 12px',
            borderRadius: 999,
            background: 'rgba(20,20,22,0.72)',
            color: 'rgba(255,255,255,0.92)',
            font: '12px -apple-system, system-ui, sans-serif',
            letterSpacing: '0.2px',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.25)'
          }}
        >
          Infinite canvas · ⇧ freeze here · ⇧⇧ home
        </div>
      )}

      {marqueeRect && (
        <div
          className="marquee"
          style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
        />
      )}

      {hasWorkspaces && (
        <div className={`toolbar-shell toolbar-shell-workspace${homeRevealed || showOverview || !locked ? ' revealed' : ''}`}>
          <div className="toolbar toolbar-nav toolbar-workspace">
            {/* The home orb (keyboard twin = bare ⇧, single-canvas model). Single tap = freeze toggle,
                double tap = fly home + freeze; active while the canvas is unfrozen or the switcher is open. */}
            <button
              className={`ws-home-btn${showOverview || !locked ? ' active' : ''}`}
              onClick={handleHomePress}
              aria-pressed={showOverview || !locked}
              title={showOverview ? 'Back to desktop' : !locked ? `Freeze here · ⇧⇧ home${activeWs ? ` · ${activeWs}` : ''}` : 'Home'}
              {...toolbarTip(showOverview ? 'Back to desktop' : 'Home')}
            />
          </div>
          {SHOW_ADVANCED_TOOLBAR && (
            <div className="toolbar toolbar-advanced">
              <button
                ref={advancedButtonRef}
                onClick={toggleAdvanced}
                {...toolbarTip('Advanced tools')}
              >
                Advanced
              </button>
            </div>
          )}
        </div>
      )}
      {toolbarTooltip &&
        createPortal(
          <div className="sidebar-tooltip toolbar-tooltip" style={{ left: toolbarTooltip.left, top: toolbarTooltip.top }}>
            {toolbarTooltip.text}
          </div>,
          document.body
        )}

      {/* ! DEBUG: temporary maintainer control for swapping future agent launches between Codex and Claude. */}
      {!isServer && agentRuntimeDebug && (
        <div className="agent-runtime-switch" aria-label="Agent backend">
          <span className="agent-runtime-debug-tag">DEBUG</span>
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
      )}

      {SHOW_ADVANCED_TOOLBAR && showAdvanced && (
        <div className="advanced-backdrop" onPointerDown={() => setShowAdvanced(false)}>
          <div
            className="advanced-popover"
            style={advancedPosition ? { left: advancedPosition.left, top: advancedPosition.top } : undefined}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              className="advanced-action"
              onClick={(e) => {
                const source = sourceRectFromElement(advancedButtonRef.current) ?? sourceRectFromElement(e.currentTarget)
                setShowAdvanced(false)
                openChat(source)
              }}
            >
              <IconChat size={17} />
              <span className="advanced-action-copy">
                <span className="advanced-action-title">Chat</span>
                <span className="advanced-action-sub">Primary agent conversation</span>
              </span>
            </button>
            <button
              className="advanced-action"
              onClick={(e) => {
                const source = sourceRectFromElement(advancedButtonRef.current) ?? sourceRectFromElement(e.currentTarget)
                setShowAdvanced(false)
                openInbox(source)
              }}
            >
              <IconInbox size={17} />
              <span className="advanced-action-copy">
                <span className="advanced-action-title">
                  Inbox
                  {inboxPending > 0 && <span className="inbox-badge">{inboxPending}</span>}
                </span>
                <span className="advanced-action-sub">Action items from your agent</span>
              </span>
            </button>
            <button
              className="advanced-action"
              onClick={() => {
                setShowAdvanced(false)
                setShowAi((v) => !v)
              }}
            >
              <span className="connect-ai-icon" style={{ color: aiUrl ? 'var(--positive, #3fb950)' : 'var(--text-muted)' }}>
                <IconSparkle size={17} />
              </span>
              <span className="advanced-action-copy">
                <span className="advanced-action-title">Connect AI</span>
                <span className="advanced-action-sub">
                  {isServer && agentOnline !== null ? (agentOnline ? 'Agent online' : 'Agent reconnecting…') : 'Connection URL for your agent'}
                </span>
              </span>
            </button>
            <button
              className="advanced-action"
              onClick={(e) => {
                const source = sourceRectFromElement(advancedButtonRef.current) ?? sourceRectFromElement(e.currentTarget)
                setShowAdvanced(false)
                openRuntime(source)
              }}
            >
              <IconSessions size={17} />
              <span className="advanced-action-copy">
                <span className="advanced-action-title">Terminals & Agents</span>
                <span className="advanced-action-sub">Every shell / agent in this workspace</span>
              </span>
            </button>
            <button
              className="advanced-action"
              onClick={(e) => {
                const source = sourceRectFromElement(advancedButtonRef.current) ?? sourceRectFromElement(e.currentTarget)
                setShowAdvanced(false)
                openTerminalSession(source)
              }}
            >
              <IconTerminal size={17} />
              <span className="advanced-action-copy">
                <span className="advanced-action-title">Terminal</span>
                <span className="advanced-action-sub">Open terminal session</span>
              </span>
            </button>
          </div>
        </div>
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

      <RadialSurfaceMenu center={radialMenu} onCreateSurface={createFromLauncher} onClose={() => setRadialMenu(null)} overWeb={radialOverWeb} />

      {hasWorkspaces && showOverview && <Overview onClose={closeOverview} onSwitch={switchWorkspace} theme={theme} onThemeChange={chooseTheme} />}

      {openFolder && <FolderOverlay folder={openFolder} />}

      {onboarding && (
        <OnboardingFlow
          onComplete={() => {
            markOnboarded()
            setOnboarding(false)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New Folder', onClick: () => makeFolder('folder', menu.wx, menu.wy) },
            // Board creation is being slowly deprecated from primary UI. Keep makeFolder('board') for
            // existing/internal flows, but hide the empty-stage menu entry for now.
            // { label: 'New Board', onClick: () => makeFolder('board', menu.wx, menu.wy) },
            // A selection of LIVE surfaces (windows/widgets/notes) → the iPhone-style collapsing folder you
            // tap to open (groupSelection — in-memory, works for ANY kind). Only a selection of REAL file/dir
            // tiles offers the disk folder, since collapsing live surfaces into a file-manager would just turn
            // them into bare file entries. (Real disk folders/boards stay the agent's `group` tool + drag-drop.)
            ...(selection.length
              ? (() => {
                  const sel = surfaces.filter((s) => selection.includes(s.id))
                  const allFileBacked = sel.length > 0 && sel.every(canMoveToRealFolder)
                  return allFileBacked
                    ? [{ label: `New Folder with Selection (${selection.length})`, onClick: () => groupSelectionInto('folder') }]
                    : [{ label: `Group into Folder (${selection.length})`, onClick: () => useDesktop.getState().groupSelection() }]
                })()
              : [])
          ]}
        />
      )}

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={[
            {
              label: 'Rename',
              onClick: () => {
                const dir = useDesktop.getState().surfaces.find((s) => s.id === folderMenu.id && s.kind === 'native' && s.component === 'dir')
                const path = dir?.props?.path
                if (typeof path === 'string' && path) setRenamingDirPath(path)
              }
            },
            {
              label: 'Move off stage',
              onClick: () => useDesktop.getState().parkFolderOffstage(folderMenu.id)
            }
          ]}
        />
      )}

      {/* Item 5b: right-click on a surface → "Ask the agent about this" at the clicked point. */}
      {annotationMenu && (
        <ContextMenu
          x={annotationMenu.sx}
          y={annotationMenu.sy}
          onClose={() => useDesktop.getState().closeAnnotationMenu()}
          items={[
            {
              label: '💬 Ask the agent about this',
              onClick: () => useDesktop.getState().startAnnotation(annotationMenu.surfaceId, annotationMenu.xPct, annotationMenu.yPct)
            }
          ]}
        />
      )}

      {/* Item 3: a web guest asked for a sensitive permission — browser-parity Allow/Block, remembered
          per-origin. Oldest first; answering pops it and reveals the next. */}
      {permissionPrompts.length > 0 && (() => {
        const p = permissionPrompts[0]
        const pop = (): void => setPermissionPrompts((q) => q.filter((x) => x.id !== p.id))
        const decide = (allow: boolean): void => { window.agentOS?.decidePermission?.(p.id, allow, true); pop() }
        const LABELS: Record<string, string> = { media: 'use your camera and microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'read your clipboard', midiSysex: 'use your MIDI devices', 'display-capture': 'capture your screen', 'window-management': 'manage your windows' }
        const what = LABELS[p.permission] || `use "${p.permission}"`
        const host = (() => { try { return new URL(p.origin).host } catch { return p.origin || 'A site' } })()
        return (
          <div className="consent" onPointerDown={(e) => e.stopPropagation()}>
            <div className="consent-card">
              <h4>Allow <b>{host}</b> to {what}?</h4>
              <p>This site is asking for a browser permission, like in a normal browser. Your choice is remembered for this site.{permissionPrompts.length > 1 ? ` (${permissionPrompts.length - 1} more pending)` : ''}</p>
              <div className="consent-actions">
                <button className="btn ghost" onClick={() => decide(false)}>Block</button>
                <button className="btn primary" onClick={() => decide(true)}>Allow</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
