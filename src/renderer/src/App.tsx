import { useEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useDesktop, viewTransform, areaRect, areaForSession, areaCenterX, nextTerminalName, type CreateSurfaceInput } from './store'
import { pushSessionData, pushSessionExit } from './sessionStream'
import type { Surface, CanvasTransform } from './types'
import { isRuntimePanel } from './types'
import { IntegrationWidget } from './components/IntegrationWidget'
import { ConnectPanel } from './components/ConnectPanel'
import { Overview } from './components/Overview'
import { capturePrimaryThumb } from './capture'
import { SurfaceFrame } from './components/SurfaceFrame'
import { AnnotationLayer } from './components/AnnotationLayer'
import { PrimarySpace } from './components/PrimarySpace'
import { Sidebar } from './components/Sidebar'
import { SurfaceLauncherButton, type SurfaceLauncherKind } from './components/SurfaceLauncherButton'
import { IconChat, IconSparkle, IconGrid, IconChevronDown, IconCheck, IconInbox, IconSessions, IconTerminal } from './components/Icons'
import { FolderOverlay } from './components/FolderOverlay'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { shouldShowOnboarding, markOnboarded } from './onboarding/config'
import { ContextMenu } from './components/ContextMenu'

// Legacy always-on integration cards on the canvas (they stacked at origin and clutter the agent-driven
// desktop). Off by default — integrations now surface as agent-spawned widgets. Flip to re-enable.
const SHOW_INTEGRATION_CARDS = false
type DockAnimationPhase = 'minimizing' | 'restoring'
type ToolbarTooltip = { text: string; left: number; top: number }
type AdvancedPopoverPosition = { left: number; top: number }
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
  st.createSurface({
    kind: 'native',
    component: 'note',
    title: 'Notepad',
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

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const mode = useDesktop((s) => s.mode)
  const areaCount = useDesktop((s) => s.areaCount)
  const currentArea = useDesktop((s) => s.currentArea)
  const integrations = useDesktop((s) => s.integrations)
  const surfaces = useDesktop((s) => s.surfaces)
  const grabMode = useDesktop((s) => s.grabMode)
  const snapPreview = useDesktop((s) => s.snapPreview)
  const selection = useDesktop((s) => s.selection)
  const createSurface = useDesktop((s) => s.createSurface)
  const setIntegrations = useDesktop((s) => s.setIntegrations)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)

  const [connecting, setConnecting] = useState<string | null>(null)
  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advancedPosition, setAdvancedPosition] = useState<AdvancedPopoverPosition | null>(null)
  // Agent relay connection health, broadcast by the backend (server mode). null = unknown/not reported yet.
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [showOverview, setShowOverview] = useState(false)
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
  useEffect(() => {
    showOverviewRef.current = showOverview
  }, [showOverview])
  const [activeWs, setActiveWs] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding())
  // #51: pending write-approvals the agent requested (provider.call writes) — the human OKs or denies each.
  // A QUEUE (not a single slot) so concurrent writes don't overwrite each other's card (review fix); we
  // show the oldest and pop it on answer. Keyed by id, matching provider-bridge's pending Map.
  const [providerApprovals, setProviderApprovals] = useState<Array<{ id: string; summary: string; risk: string }>>([])
  // Item 3: a web guest asked for a sensitive browser permission (camera, location, …) — show the human a
  // real Allow/Block prompt (browser parity), remembered per-origin.
  const [permissionPrompts, setPermissionPrompts] = useState<Array<{ id: string; origin: string; permission: string; surfaceId: string | null }>>([])
  // Right-click desktop menu (New Folder / New Board). wx/wy = the world position to place the new folder.
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null)
  const annotationMenu = useDesktop((s) => s.annotationMenu) // item 5b: surface right-click annotation menu
  const [dockAnimations, setDockAnimations] = useState<Record<string, DockAnimationPhase>>({})
  const isServer = !!window.agentOS?.serverMode
  const hasWorkspaces = !!window.agentOS?.workspaces // present in BOTH modes (Electron preload + server shim)
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
  const advancedButtonRef = useRef<HTMLButtonElement>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [toolbarTooltip, setToolbarTooltip] = useState<ToolbarTooltip | null>(null)
  const [aiCopied, setAiCopied] = useState(false)
  // Phase 2: true once the backend has sent (or declined) a hydrate. The state-push is
  // gated on this so a freshly-loaded renderer can't post its empty store and clobber the
  // restored canvas before hydration arrives.
  const hydrated = useRef(false)
  // The active workspace name, mirrored into a ref so the state-push closure (an effect with []
  // deps) reads the CURRENT value — each push is tagged with it so the backend can drop a stale
  // push that belongs to a workspace we already switched away from (else it corrupts the new folder).
  const activeWsRef = useRef<string | null>(null)
  const animRef = useRef<number | null>(null)

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

  function openTerminalSession(source?: AnimationSourceRect | null): void {
    if (source) pendingTerminalSource.current = { rect: source, at: performance.now() }
    ;(window.agentOS as unknown as { sessionSpawn?: (o: object) => void })?.sessionSpawn?.({ command: 'bash', title: nextTerminalName() })
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

  // Smoothly tween the camera (used when entering/leaving control mode).
  function animateTransform(target: CanvasTransform, dur = 320): void {
    const from = useDesktop.getState().transform
    if (animRef.current) cancelAnimationFrame(animRef.current)
    const t0 = performance.now()
    const ease = (p: number): number => 1 - Math.pow(1 - p, 3) // cubic ease-out
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur)
      const k = ease(p)
      useDesktop.getState().setTransform({
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        scale: from.scale + (target.scale - from.scale) * k
      })
      animRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }
  // Double-tap ⌘ toggles "Control mode" (the zoomed-out bird's-eye): animate the camera to the
  // control viewport on enter and back to the locked primary-area view on exit. Both modes exist in
  // BOTH transports (Electron + server/Chrome); normal mode is the default everywhere.
  function toggleControlMode(): void {
    const st = useDesktop.getState()
    st.setSnapPreview(null) // a mode switch cancels any in-flight drag UI
    st.setDragTarget(null)
    const next = st.mode === 'desktop' ? 'canvas' : 'desktop'
    if (next === 'canvas') {
      // Entering control mode: ALWAYS the gentle default zoom-out (controlScale 0.7), never a stale
      // remembered camera — the human wants a consistent gentle bird's-eye, not whatever it was left at.
      const target = viewTransform('canvas', st.viewport, st.currentArea, st.areaCount)
      st.setMode('canvas')
      animateTransform(target)
    } else {
      // Leaving control mode: animate back to the view-locked CURRENT area. controlTransform was
      // already kept current by every pan/zoom/center in canvas mode, so there's nothing to capture
      // here (capturing st.transform now could grab a mid-animation frame — the ISSUE-3 trap).
      st.setMode('desktop')
      animateTransform(viewTransform('desktop', st.viewport, st.currentArea, st.areaCount))
    }
  }

  // Switch to an adjacent workspace area (#45). In normal mode the camera animates to the new area
  // (each area locks to the same on-screen desktop region); in control mode the bird's-eye already
  // shows every area, so we only move the highlight. No-op past the ends.
  function switchArea(delta: number): void {
    const st = useDesktop.getState()
    const next = Math.max(0, Math.min(st.areaCount - 1, st.currentArea + delta))
    if (next === st.currentArea) return
    st.setCurrentArea(next)
    if (st.mode === 'desktop') animateTransform(viewTransform('desktop', st.viewport, next, st.areaCount))
  }
  // Add a new (empty) area to the right and go to it (re-fits the bird's-eye in control mode).
  function addAreaAndGo(): void {
    useDesktop.getState().addArea()
    const now = useDesktop.getState()
    animateTransform(viewTransform(now.mode, now.viewport, now.currentArea, now.areaCount))
  }

  useEffect(() => {
    const refresh = (): void => {
      window.agentOS?.integrations.list().then(setIntegrations)
    }
    refresh()
    const off = window.agentOS?.integrations.onUpdated(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      off?.()
      window.removeEventListener('focus', refresh)
    }
  }, [setIntegrations])

  // The default Notepad is ensured after each hydrate (see the 'hydrate'/'switch' handlers below),
  // so it persists as a file in the active workspace instead of being recreated per session.

  useEffect(() => {
    const onResize = (): void => {
      useDesktop.getState().setViewport(window.innerWidth, window.innerHeight)
      useDesktop.getState().goToPrimary() // re-fit the camera to the new viewport in BOTH modes (control too)
    }
    onResize()
    useDesktop.getState().goToPrimary()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // pan/zoom only on an UNLOCKED canvas; when locked (⌘⌘) or in desktop mode,
      // let webviews/iframes scroll normally
      const w = useDesktop.getState()
      if (w.mode !== 'canvas' || w.locked) return
      e.preventDefault()
      const st = useDesktop.getState()
      if (e.ctrlKey) st.zoomAt(e.clientX, e.clientY, e.deltaY)
      else st.panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
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
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        // Cmd+G: collapse the multi-selection into an iPhone-style folder you tap to open (in-memory
        // `component:'folder'` via groupSelection). Works for ANY surface kind — windows, widgets, notes
        // — whereas the file-based disk folder/board (the old Cmd+G path) silently no-ops on a widget
        // with no file to move. REAL persistent folders/boards stay on the right-click desktop menu and
        // the agent's `group` tool, so this keybind is purely the quick visual grouping.
        e.preventDefault()
        useDesktop.getState().groupSelection()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        // layout undo (Cmd+Z) when nothing editable is focused; else let the browser text-undo win
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable) {
          e.preventDefault()
          useDesktop.getState().undoLayout()
        }
      } else if (e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Cmd + ← / → : switch BlitzOS workspace area (#45). Ctrl + ← / → is intentionally NOT bound — it's
        // the macOS "switch desktop/Space" shortcut, left free so the user can swap real desktops (their way
        // out of fullscreen). Skip when typing, and when there's only one area.
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable && useDesktop.getState().areaCount > 1) {
          e.preventDefault()
          switchArea(e.key === 'ArrowLeft' ? -1 : 1)
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        // Cmd/Ctrl + N : add a new workspace area and jump to it (#45). Skip when typing in a field.
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (!editable) {
          e.preventDefault()
          addAreaAndGo()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete / ⌫ closes the selected surfaces (when not typing in a field).
        const ae = document.activeElement as HTMLElement | null
        const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        const st = useDesktop.getState()
        if (!editable && st.selection.length) {
          e.preventDefault()
          const ids = [...st.selection]
          ids.forEach((id) => st.closeSurface(id))
          st.clearSelection()
        }
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyT' && !window.agentOS?.onKeybind) {
        // ⌘T/⇧⌘T DOM fallback for SERVER mode only — in Electron the bind arrives from main's
        // before-input-event (os:keybind), which works even when an iframe/webview holds focus.
        e.preventDefault()
        runTileKeybind(e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Hold ⌥ (or Space, when not typing) → "grab mode": drag any surface from anywhere to
  // move it (and select it); release to interact with content again.
  // NOTE: a key held while a <webview> has keyboard focus is delivered to that guest, not
  // here — so grab-mode may not engage until you click off a focused web page. A robust
  // fix is to forward ⌥/Space from guests via main (like onMetaTap); deferred.
  useEffect(() => {
    const editable = (): boolean => {
      const ae = document.activeElement as HTMLElement | null
      return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' || (e.key === ' ' && !editable())) {
        if (e.key === ' ') e.preventDefault()
        useDesktop.getState().setGrabMode(true)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' || e.key === ' ') useDesktop.getState().setGrabMode(false)
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

  // Double-tap ⌘ to toggle Control mode (the bird's-eye overview). A bare ⌘ tap from a focused
  // webview arrives via onMetaTap (main); plain keydown/keyup covers the browser/server transport.
  useEffect(() => {
    let metaDown = false
    let sawOther = false
    let lastTap = 0
    const registerTap = (): void => {
      const now = performance.now()
      if (now - lastTap < 450) {
        lastTap = 0
        toggleControlMode()
      } else {
        lastTap = now
      }
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (!e.repeat) {
          metaDown = true
          sawOther = false
        }
      } else if (metaDown) {
        sawOther = true
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (metaDown && !sawOther) registerTap()
        metaDown = false
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    const off = window.agentOS?.onMetaTap(registerTap)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      off?.()
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
        // Control mode is a transient view toggle, never persisted — always boot the normal desktop.
        st.hydrate(surfs, cam, 'desktop', Number(a.areaCount) || 1)
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
        st.hydrate(sf, cm, 'desktop', Number(a.areaCount) || 1)
        ensureNotepad()
        hydrated.current = true // a switch is also a valid first hydrate — don't depend on a prior 'hydrate'
        if (typeof a.workspace === 'string') {
          setActiveWs(a.workspace)
          activeWsRef.current = a.workspace
        }
        setShowOverview(false)
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
        const pendingChat = pendingChatSource.current
        const chatSource = pendingChat && performance.now() - pendingChat.at < 5000 ? pendingChat.rect : null
        if (chatSource) pendingChatSource.current = null
        const existingSurface = surf && surf.id ? st.surfaces.find((s) => s.id === surf.id) : undefined
        // Dedupe by id: a 'create' (e.g. a new chat session) can race a hydrate that already brought it.
        // Exception: toolbar-restored chat can intentionally re-broadcast the existing hub; animate it.
        if (existingSurface) {
          if (chatSource && surf.role === 'chat') restoreOrFocusFromSource(existingSurface.id, chatSource)
          return
        }
        // A NEW chat session owns its own area N. Recompute its x from the area with the renderer's REAL
        // viewport (the host may have used a default vp), so its widget lands precisely in area N.
        const isNewChat = hydrated.current && surf && surf.role === 'chat' && surf.sessionId != null
        const chatArea = isNewChat ? areaForSession(surf.sessionId as string) : 0
        if (isNewChat && chatArea > 0) {
          // area tags it for createSurface's clamp (else it clamps to the CURRENT area); x sets the precise
          // left-of-center spot in area N using the real viewport.
          surf.area = chatArea
          surf.x = Math.round(areaCenterX(chatArea, useDesktop.getState().viewport) - 700)
        }
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
        if (isNewChat && chatArea > 0) {
          // ALWAYS grow areaCount so the new area exists + is navigable (whether a user or an agent spawned it).
          const cur = useDesktop.getState()
          if (chatArea + 1 > cur.areaCount) cur.setAreaCount(chatArea + 1)
          // Follow the camera ONLY for a USER '+ New' (a.focus) — so "+ New" visibly opens the new agent's
          // workspace — never for an agent's spawn_chat_session (a background agent must not yank the user's view).
          if (a.focus) {
            const now = useDesktop.getState()
            now.setCurrentArea(chatArea)
            animateTransform(viewTransform(now.mode, now.viewport, chatArea, now.areaCount))
          }
        } else if (a.focus && createdId) {
          useDesktop.getState().focusAndZoom(createdId)
        }
      }
      else if (a.type === 'provider-approval') {
        // The agent asked to perform a WRITE on a connected provider (#51) — show the human a card.
        const req = a.request as { id?: string; summary?: string; risk?: string } | undefined
        if (req && req.id) {
          const card = { id: String(req.id), summary: String(req.summary || 'a provider write'), risk: String(req.risk || 'write') }
          setProviderApprovals((q) => (q.some((c) => c.id === card.id) ? q : [...q, card])) // enqueue (dedupe by id)
        }
      }
      else if (a.type === 'surface-contextmenu') {
        // Item 5b: a WEB guest's right-click (main intercepts it — the webview swallows React's onContextMenu).
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
      else if (a.type === 'goToPrimary') st.goToPrimary()
      else if (a.type === 'chat') {
        // ONE hub chat surface holds every session. The OS broadcasts a session's full transcript tagged
        // with sessionId; merge it into the hub's props.threads[sid] and refresh the sidebar (sessions) +
        // per-session status when included. The widget renders the active thread + a session sidebar.
        const sid = a.sessionId != null ? String(a.sessionId) : '0'
        const hub = findChatHub(st.surfaces) ?? st.surfaces.find((s) => s.kind === 'native' && s.component === 'chat')
        if (!hub) return
        const extra = a as { sessions?: unknown; status?: unknown }
        const prevThreads = (hub.props?.threads as Record<string, Array<{ role: string; text: string }>>) ?? {}
        const patch: Record<string, unknown> = {}
        if (Array.isArray(a.messages)) patch.threads = { ...prevThreads, [sid]: a.messages as Array<{ role: string; text: string }> }
        else {
          const text = String(a.text ?? '')
          if (text) patch.threads = { ...prevThreads, [sid]: [...(prevThreads[sid] ?? []), { role: 'agent', text }].slice(-200) }
        }
        if (extra.sessions) patch.sessions = extra.sessions
        if (extra.status) patch.status = extra.status
        if (Object.keys(patch).length) st.updateSurfaceProps(hub.id, patch)
      } else if (a.type === 'agentStatus') {
        // Backend heartbeat: is the agent's relay link up? Drives the toolbar status pill.
        setAgentOnline(!!a.online)
      } else if (a.type === 'activity') {
        // A live feed of what the agent is doing (its tool calls) -> the Agent-activity
        // panel (auto-created, pinned), so the user can see it working during latency.
        const text = String(a.text ?? '')
        if (!text) return
        const evt = { at: Number(a.at) || Date.now(), text }
        const panel = st.surfaces.find((s) => s.kind === 'native' && s.component === 'activity')
        if (panel) {
          const evs = (panel.props?.events as Array<{ at: number; text: string }>) ?? []
          st.updateSurfaceProps(panel.id, { events: [...evs, evt].slice(-60) })
        } else {
          st.createSurface(activitySurfaceInput([evt]))
        }
      } else if (a.type === 'session-data') {
        // live tmux %output for a session -> its terminal surface (sessionStream routes by id)
        pushSessionData(String(a.id), String(a.data ?? ''))
      } else if (a.type === 'session-exit') {
        pushSessionExit(String(a.id), a.exitCode == null ? null : Number(a.exitCode))
      } else if (a.type === 'session-spawn') {
        // A session was created (by an agent or the user), or re-adopted on restore. Sessions live as
        // TABS in a terminal window — add this one as a tab (idempotent). Covers both live spawns and
        // the restore() replay that brings back tmux survivors after a restart.
        const sess = (a.session ?? {}) as { title?: string; area?: number | null }
        const pending = pendingTerminalSource.current
        const source = pending && performance.now() - pending.at < 5000 ? pending.rect : null
        if (source) pendingTerminalSource.current = null
        if (source && !prefersReducedMotion()) {
          let createdId: string | null = null
          flushSync(() => {
            const before = new Set(useDesktop.getState().surfaces.filter((s) => s.kind === 'native' && s.component === 'terminal').map((s) => s.id))
            ensureTerminalTab(String(a.id), sess.title || 'Terminal', sess.area)
            const created = useDesktop.getState().surfaces.find((s) => s.kind === 'native' && s.component === 'terminal' && !before.has(s.id))
            if (created) {
              createdId = created.id
              setDockAnimation(created.id, 'restoring')
            }
          })
          if (createdId) void animateSurfaceOpenFrom(createdId, source, true)
        } else {
          ensureTerminalTab(String(a.id), sess.title || 'Terminal', sess.area)
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
      }
    })
  }, [])

  // Ask main for the persisted canvas once our onAction listener (above) is mounted; Electron
  // replies with a 'hydrate' os:action. In server mode the SSE connect delivers it, so this no-ops.
  useEffect(() => {
    window.agentOS?.requestHydrate?.()
  }, [])

  // Resume sessions: terminal surfaces aren't serialized (they're runtime-only), so on load — and on
  // every workspace switch — we reconstruct a terminal tab for each session still ALIVE in this
  // workspace. tmux keeps the process across a BlitzOS/page restart; calling sessionList() also drives
  // the backend's lazy restore() (re-adopting survivors). ensureTerminalTab is idempotent, so this
  // converges with the restore() session-spawn replay rather than double-creating. Keyed on the active
  // workspace because sessions are per-workspace (a switch wholesale-replaces the canvas first).
  useEffect(() => {
    if (!activeWs) return
    let cancelled = false
    const api = window.agentOS as unknown as { sessionList?: () => Promise<unknown[]> }
    Promise.resolve(api?.sessionList?.() ?? [])
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return
        for (const s of list as Array<{ id?: string; title?: string; status?: string; area?: number | null }>) {
          if (s && s.id && s.status === 'running') ensureTerminalTab(String(s.id), s.title || 'Terminal', s.area)
        }
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
        props: s.props,
        component: s.component,
        role: s.role,
        // Carry the chat session id so a per-session chat survives the round-trip (osState → a later
        // hydrate): without it the surface would lose its area on the next connect and snap back to area 0.
        sessionId: s.sessionId,
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
      // correctly on a different screen size — view.cx/cy are exactly that world point).
      // #45: also push the area count + which area is active + the CURRENT area's world rect, so the
      // agent (list_state) places surfaces in the area the human is looking at, not blindly at origin.
      const currentAreaRect = areaRect(st.currentArea, st.viewport)
      window.agentOS?.sendState({
        workspace: activeWsRef.current ?? undefined,
        surfaces,
        viewport: { w: vw, h: vh },
        view,
        mode: st.mode,
        camera: { x: view.cx, y: view.cy, scale },
        areaCount: st.areaCount,
        currentArea: st.currentArea,
        currentAreaRect
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
    let lastArea = useDesktop.getState().currentArea
    let lastAreaCount = useDesktop.getState().areaCount
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
      } else if (state.areaCount !== lastAreaCount || state.currentArea !== lastArea) {
        // an area switch / add changes which area the agent should target — reflect it at once
        lastArea = state.currentArea
        lastAreaCount = state.areaCount
        push()
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
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  function onDrop(e: React.DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? [])
    const items = Array.from(e.dataTransfer?.items ?? [])
    if (!files.length && !items.length) return
    e.preventDefault()
    const t = useDesktop.getState().transform
    const wx = Math.round((e.clientX - t.x) / t.scale)
    const wy = Math.round((e.clientY - t.y) / t.scale)
    const api = window.agentOS
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

  // Right-click empty canvas → New Folder / New Board menu (the discoverable counterpart of Cmd+G).
  function onBgContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const t = useDesktop.getState().transform
    setMenu({ x: e.clientX, y: e.clientY, wx: Math.round((e.clientX - t.x) / t.scale), wy: Math.round((e.clientY - t.y) / t.scale) })
  }
  // New EMPTY folder (files) or board (windows+widgets) at the click point.
  function makeFolder(kind: 'folder' | 'board', wx: number, wy: number, source?: AnimationSourceRect | null): void {
    if (source) pendingFolderSource.current = { rect: source, at: performance.now() }
    const req = window.agentOS?.newFolder?.(kind === 'board' ? 'Board' : 'Folder', kind, wx, wy)
    if (!req) pendingFolderSource.current = null
    void Promise.resolve(req).then((r) => {
      if (!r?.ok) pendingFolderSource.current = null
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
    // menu (onBgContextMenu) — it must NOT clear the selection, or "New Folder/Board with Selection (N)"
    // would never show (the right-click's pointerdown was wiping the very selection the menu groups).
    if (e.button !== 0) return
    const st = useDesktop.getState()
    if (st.mode === 'canvas' && !st.locked) {
      // unlocked canvas: drag the background to pan
      pan.current = { x: e.clientX, y: e.clientY }
    } else {
      // locked canvas (or desktop): rubber-band (marquee) selection. Shift adds to the selection.
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

  // The Agent-activity feed docks to the TOP-LEFT of the view (above the centered chat).
  function activitySurfaceInput(events: Array<{ at: number; text: string }>): CreateSurfaceInput {
    const st = useDesktop.getState()
    const { scale, x: tx, y: ty } = st.transform
    const W = 320
    const H = 200
    const x = Math.round(-tx / scale + 24)
    const y = Math.round(-ty / scale + 24)
    return { kind: 'native', component: 'activity', title: 'Agent activity', w: W, h: H, x, y, props: { events } }
  }

  // Open/focus a session's terminal tab (idempotent). Shared by the live session-spawn action,
  // resume-on-load, and the Sessions tray — the placement + add-tab-or-create logic lives in the
  // store action so all three callers stay in sync.
  function ensureTerminalTab(sid: string, title: string, area?: number | null): void {
    useDesktop.getState().openSession(sid, title || 'Terminal', area)
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

  function addBrowser(source?: AnimationSourceRect | null): void {
    // let the store cascade + clamp onto the desktop
    createSurfaceFromSource({ kind: 'web', url: 'https://www.google.com', title: 'Google' }, source)
  }

  function visibleWorldCenter(): { x: number; y: number } {
    const st = useDesktop.getState()
    return {
      x: Math.round((st.viewport.w / 2 - st.transform.x) / st.transform.scale),
      y: Math.round((st.viewport.h / 2 - st.transform.y) / st.transform.scale)
    }
  }

  function createFromLauncher(kind: SurfaceLauncherKind, source?: AnimationSourceRect | null): void {
    if (kind === 'browser') {
      addBrowser(source)
      return
    }
    if (kind === 'note') {
      createSurfaceFromSource({ kind: 'native', component: 'note', title: 'Note', w: 280, h: 260, props: { text: '', color: 'yellow' } }, source)
      return
    }
    if (kind === 'app') {
      createSurfaceFromSource({ kind: 'app', title: 'App', w: 520, h: 360 }, source)
      return
    }
    if (kind === 'widget') {
      createSurfaceFromSource({ kind: 'srcdoc', title: 'Widget', w: 420, h: 300, html: WIDGET_PLACEHOLDER_HTML }, source)
      return
    }
    const c = visibleWorldCenter()
    makeFolder(kind, c.x, c.y, source)
  }

  // Capture the CURRENT board's primary-area snapshot and upload it as its workspace thumbnail
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
        await ws.captureThumb(name) // Electron: main-side capturePage (real pixels, incl. <webview>s)
      } else if (ws.thumb) {
        const dataUrl = capturePrimaryThumb() // server: composite the streamed canvases + upload
        if (dataUrl) await ws.thumb(name, dataUrl)
      }
    } catch {
      /* best-effort snapshot */
    }
  }
  async function openOverview(): Promise<void> {
    await captureCurrent() // refresh the active board's tile first
    setShowOverview(true)
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

  // The Sessions tray: a glanceable list of every session in the workspace. Docks to the left of the
  // current view (like Chat); focus it if it's already open.
  function openSessions(source?: AnimationSourceRect | null): void {
    const st = useDesktop.getState()
    const existing = st.surfaces.find((s) => s.kind === 'native' && s.component === 'sessions')
    if (existing) {
      if (existing.minimized) restoreOrFocusFromSource(existing.id, source)
      else st.focusSurface(existing.id)
      return
    }
    const { scale, x: tx, y: ty } = st.transform
    const W = 380
    const H = 420
    const x = Math.round(-tx / scale + 24)
    const y = Math.round((st.viewport.h / 2 - ty) / scale - H / 2)
    createSurfaceFromSource({ kind: 'native', component: 'sessions', title: 'Sessions', w: W, h: H, x, y }, source)
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
    // The toolbar should always open the host-hydrated srcdoc chat hub (blitz-chat.html),
    // not the retired native ChatPanel fallback.
    const hub = findChatHub(st.surfaces)
    if (hub) {
      restoreOrFocusFromSource(hub.id, source)
      return
    }
    // If the user closed the runtime hub, ask main/workspace-host to rebuild the same srcdoc chat
    // surface boot/switch install. No native ChatPanel fallback.
    if (source) pendingChatSource.current = { rect: source, at: performance.now() }
    void window.agentOS?.restoreChatHub?.()
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

  const active = integrations.find((i) => i.id === connecting) ?? null
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
      className={grabMode ? 'grab-mode' : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDownCapture={() => {
        // Keyboard-focus reclaim: iframes/webviews swallow window keydown while focused, killing every
        // app keybind (⌘T etc.). A pointerdown that reaches the HOST at all means the user is now
        // interacting OUTSIDE the guest — blur it so the next keystroke lands in the app again.
        const ae = document.activeElement as HTMLElement | null
        if (ae && (ae.tagName === 'IFRAME' || ae.tagName === 'WEBVIEW')) ae.blur()
      }}
    >
      {/* draggable native-window title bar (macOS move/resize) */}
      <div className="titlebar">
        <span className="titlebar-label">BlitzOS</span>
      </div>

      <div className="bg" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} onContextMenu={onBgContextMenu} />

      <Sidebar onRequestRestore={requestRestore} animating={dockAnimations} />

      <div
        className="world"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {mode === 'canvas' && <PrimarySpace />}
        {snapPreview && (
          <div
            className="snap-preview"
            style={{ left: snapPreview.x, top: snapPreview.y, width: snapPreview.w, height: snapPreview.h }}
          />
        )}
        {/* Always-on integration connect cards are hidden — integrations surface as agent-spawned widgets
            (e.g. `spawn_widget discord-list`, which reads live data through the OS), not fixed canvas cards.
            Connection status + the OAuth flow still live in ConnectPanel (reachable from the dock). */}
        {SHOW_INTEGRATION_CARDS &&
          integrations.map((it) => <IntegrationWidget key={it.id} integration={it} onConnect={setConnecting} />)}
        {surfaces.map((s) =>
          // folder members live only inside the folder — unless "peeked" open onto the desktop
          s.groupId && !s.peek ? null : (
            <SurfaceFrame
              key={s.id}
              surface={s}
              onRequestMinimize={requestMinimize}
              onRequestToggleMaximize={requestToggleMaximize}
              restoring={dockAnimations[s.id] === 'restoring'}
            />
          )
        )}
        {/* Item 5b: spatial annotations pin to surfaces (in-world so they pan/zoom with their surface). */}
        <AnnotationLayer />
      </div>

      {mode === 'canvas' && (
        <div className="pan-overlay">
          <span className="pan-hint">Control mode · drag cards to rearrange · scroll or drag the void to pan · double-tap ⌘ to exit</span>
        </div>
      )}

      {marqueeRect && (
        <div
          className="marquee"
          style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
        />
      )}

      <div className="toolbar-shell">
        <div className="toolbar toolbar-nav">
          {hasWorkspaces && (
            <button className="ws-btn" onClick={() => void openOverview()} {...toolbarTip('Workspaces')}>
              <IconGrid size={14} />
              <span className="ws-name">{activeWs ?? '…'}</span>
              <IconChevronDown size={13} />
            </button>
          )}
          {/* Workspace areas (#45): the indicator appears once there's more than one. Create a new area
              with Cmd/Ctrl + N; switch areas with Cmd/Ctrl + ← →. */}
          {areaCount > 1 && (
            <span className="area-ctl" {...toolbarTip('Workspace areas')}>
              <button className="area-arrow" disabled={currentArea <= 0} onClick={() => switchArea(-1)} aria-label="Previous area">‹</button>
              <span className="area-ind">Area {currentArea + 1}/{areaCount}</span>
              <button className="area-arrow" disabled={currentArea >= areaCount - 1} onClick={() => switchArea(1)} aria-label="Next area">›</button>
            </span>
          )}
        </div>
        <div className="toolbar toolbar-main">
          <SurfaceLauncherButton onCreateSurface={createFromLauncher} buttonProps={toolbarTip('Create surface')} />
          <button onClick={(e) => openChat(sourceRectFromElement(e.currentTarget))} {...toolbarTip('Primary chat')}>
            <IconChat size={15} /> Chat
          </button>
          <button
            onClick={(e) => openInbox(sourceRectFromElement(e.currentTarget))}
            {...toolbarTip('Action items from your agent')}
          >
            <IconInbox size={15} /> Inbox
            {inboxPending > 0 && <span className="inbox-badge">{inboxPending}</span>}
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button onClick={() => { setShowAdvanced(false); setShowAi((v) => !v) }} {...toolbarTip('Connection URL for your agent')}>
            <span className="connect-ai-icon" style={{ color: aiUrl ? 'var(--positive, #3fb950)' : 'var(--text-muted)' }}>
              <IconSparkle size={17} />
            </span>
            Connect AI
          </button>
          {isServer && agentOnline !== null && (
            <span
              className={`agent-status${agentOnline ? ' online' : ''}`}
              title={agentOnline ? 'Agent connected — it can see your chat and the canvas' : 'Agent link is down — reconnecting…'}
            >
              <span className="agent-status-dot" />
              {agentOnline ? 'Agent online' : 'Agent reconnecting…'}
            </span>
          )}
        </div>
        <div className="toolbar toolbar-advanced">
          <button
            ref={advancedButtonRef}
            onClick={toggleAdvanced}
            {...toolbarTip('Advanced tools')}
          >
            Advanced
          </button>
        </div>
      </div>
      {toolbarTooltip &&
        createPortal(
          <div className="sidebar-tooltip toolbar-tooltip" style={{ left: toolbarTooltip.left, top: toolbarTooltip.top }}>
            {toolbarTooltip.text}
          </div>,
          document.body
        )}

      {showAdvanced && (
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
                openSessions(source)
              }}
            >
              <IconSessions size={17} />
              <span className="advanced-action-copy">
                <span className="advanced-action-title">Sessions</span>
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

      {hasWorkspaces && showOverview && <Overview onClose={() => setShowOverview(false)} onSwitch={switchWorkspace} />}
      {active && <ConnectPanel integration={active} onClose={() => setConnecting(null)} />}

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
            { label: 'New Board', onClick: () => makeFolder('board', menu.wx, menu.wy) },
            // A selection of LIVE surfaces (windows/widgets/notes) → the iPhone-style collapsing folder you
            // tap to open (groupSelection — in-memory, works for ANY kind). Only a selection of REAL file/dir
            // tiles offers the disk folder, since collapsing live surfaces into a file-manager would just turn
            // them into bare file entries. (Real disk folders/boards stay the agent's `group` tool + drag-drop.)
            ...(selection.length
              ? (() => {
                  const sel = surfaces.filter((s) => selection.includes(s.id))
                  const allFiles = sel.length > 0 && sel.every((s) => s.kind === 'native' && (s.component === 'file' || s.component === 'dir'))
                  return allFiles
                    ? [{ label: `New Folder with Selection (${selection.length})`, onClick: () => groupSelectionInto('folder') }]
                    : [{ label: `Group into Folder (${selection.length})`, onClick: () => useDesktop.getState().groupSelection() }]
                })()
              : [])
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

      {/* #51: the agent asked to perform a WRITE on a connected account — the human must approve it
          (per-call, request-bound). Reads never reach here. The OLDEST pending card shows; answering it
          pops it and reveals the next, so concurrent writes each get their own decision (review fix). */}
      {providerApprovals.length > 0 && (() => {
        const card = providerApprovals[0]
        const pop = (): void => setProviderApprovals((q) => q.filter((c) => c.id !== card.id))
        return (
          <div className="consent" onPointerDown={(e) => e.stopPropagation()}>
            <div className="consent-card">
              <h4>Allow the agent to {card.risk === 'destructive' ? <span style={{ color: 'var(--negative, #e5484d)' }}>make a destructive change</span> : 'make a change'} to your account?</h4>
              <p><code>{card.summary}</code></p>
              <p>This acts on your real connected account. It runs only if you allow it.{providerApprovals.length > 1 ? ` (${providerApprovals.length - 1} more pending)` : ''}</p>
              <div className="consent-actions">
                <button className="btn ghost" onClick={() => { window.agentOS?.denyProviderCall?.(card.id); pop() }}>Deny</button>
                <button className="btn primary" onClick={() => { window.agentOS?.approveProviderCall?.(card.id); pop() }}>Allow</button>
              </div>
            </div>
          </div>
        )
      })()}

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
