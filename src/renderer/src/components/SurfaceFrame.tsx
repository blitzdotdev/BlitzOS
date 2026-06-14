import { memo, useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, snapTargetFor, primaryRect, nextTerminalName, latticeFor, slotRect, slotOf, nearestFreeSlot, sizeForDims, webTabsOf, effectiveZ } from '../store'
import { BrowserNav } from './BrowserNav'
import { NoteWidget } from './NoteWidget'
import { ActivityPanel } from './ActivityPanel'
import { ChatPanel } from './ChatPanel'
import { TerminalView } from './TerminalView'
import { RuntimePanel } from './RuntimePanel'
import { InboxPanel } from './InboxPanel'
import { BRIDGE_SHIM } from '../widget-bridge'
import { UI_KIT } from '../widget-ui-kit'
import { useJsxWidget } from '../widget-jsx'
import { IconEye } from './Icons'
import { FolderWidget } from './FolderWidget'
import { FileWidget, DirWidget } from './FileWidget'
import { FileManager } from './FileManager'
import { UnlockWidget } from './UnlockWidget'
import { NOTE_PAPER } from '../paper'

type BridgeReply = { ok: boolean; data?: unknown; error?: string }

// Electron cursor-changed types → CSS. Most pass through verbatim; the two that disagree are the
// arrow ('pointer' in Chromium terms) and the link hand. Unknown values fall back to themselves
// (invalid CSS cursor = default), so new Chromium cursor types degrade safely.
const CURSOR_CSS: Record<string, string> = { pointer: 'default', hand: 'pointer', nodrop: 'no-drop', 'm-panning': 'move' }

// A browser frame's chrome rows above the page hole: window bar (34) + tab strip (28) + navbar (36).
// Slotted (widget-chrome) browsers drop the bar. Used by the clip-path pass to hole out EXACTLY the
// page area of a higher browser from DOM that sits under it — the chrome itself is DOM and stacks
// by z-index like everything else.
const WEB_CHROME_H = 34 + 28 + 36
const WEB_CHROME_H_SLOTTED = 28 + 36

/** 'HIDE' = the holes fully cover the element: skip clipping and hide it outright (a degenerate
 *  clip leaves an antialiased ghost outline of the element — the "widget outline" artifact). */
export type HolesClip = string | 'HIDE' | undefined

// The window corner radius (tokens.css --radius-window), read once — hole masks must follow the
// frame's rounded BOTTOM corners or the square native view pokes out past the curve.
const WINDOW_RADIUS = typeof document !== 'undefined' ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-window')) || 14 : 14

/** Build a holes clip as `path(…)` with SEPARATE SUBPATHS — never `polygon()`: a single even-odd
 *  polygon needs connector edges between rings, and their retraced pixels (plus outer-ring pixels
 *  hugging the element edge) don't antialias to zero, drawing hairline ghosts of the clipped
 *  element (the "widget outline" artifact). Subpaths have no connectors; the outer ring is PADDED
 *  beyond the element so its antialiasing never touches content; and the holes are wound OPPOSITE
 *  the outer ring (outer clockwise, holes counter-clockwise) so they cut under the default nonzero
 *  fill-rule — the `evenodd` keyword inside path() isn't parsed by every Chromium. Hole BOTTOM
 *  corners are rounded by `radius` (the frame's rounded corners; the top edge sits under the
 *  square chrome rows), so what shows through always matches the window shape. */
type Hole = { x1: number; y1: number; x2: number; y2: number }
const holesOverlap = (a: Hole, b: Hole): boolean => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2
/** Decompose (possibly overlapping) hole rects into NON-OVERLAPPING tiles covering the SAME union, by
 *  a vertical-strip sweep: cut at every rect x-edge, and within each strip merge the covered
 *  y-intervals. Load-bearing: under the nonzero fill-rule, two OVERLAPPING holes wind their overlap
 *  TWICE (+1 outer, -1, -1 = -1 ≠ 0), which flips it back to OPAQUE — so the intersection of two
 *  overlapping browsers paints the lower DOM/page through it (the "shows the widget / flat color
 *  beneath both" bleed). Disjoint tiles wind every covered point exactly once → one clean hole. */
function disjointHoles(holes: Hole[]): Hole[] {
  const xs = Array.from(new Set(holes.flatMap((r) => [r.x1, r.x2]))).sort((a, b) => a - b)
  const out: Hole[] = []
  for (let i = 0; i < xs.length - 1; i++) {
    const x1 = xs[i]
    const x2 = xs[i + 1]
    if (x2 - x1 < 0.01) continue
    const mid = (x1 + x2) / 2
    const ys = holes
      .filter((r) => r.x1 <= mid && mid <= r.x2)
      .map((r) => [r.y1, r.y2] as [number, number])
      .sort((a, b) => a[0] - b[0])
    if (!ys.length) continue
    let cy1 = ys[0][0]
    let cy2 = ys[0][1]
    for (let k = 1; k < ys.length; k++) {
      if (ys[k][0] <= cy2 + 0.01) cy2 = Math.max(cy2, ys[k][1])
      else {
        out.push({ x1, y1: cy1, x2, y2: cy2 })
        cy1 = ys[k][0]
        cy2 = ys[k][1]
      }
    }
    out.push({ x1, y1: cy1, x2, y2: cy2 })
  }
  return out
}
export function holesPath(w: number, h: number, holes: Hole[], radius = 0): HolesClip {
  if (!holes.length) return undefined
  if (holes.some((r) => r.x1 <= 0 && r.y1 <= 0 && r.x2 >= w && r.y2 >= h)) return 'HIDE'
  // Overlapping holes must become disjoint tiles first (see disjointHoles) or their intersection
  // re-fills opaque. When we decompose, drop the per-tile bottom rounding (internal tile edges would
  // notch); the common single / non-overlapping case keeps its rounded bottom corners unchanged.
  const overlapping = holes.some((a, i) => holes.some((b, j) => j > i && holesOverlap(a, b)))
  const cut = overlapping ? disjointHoles(holes) : holes
  const rad = overlapping ? 0 : radius
  // PAD pushes the outer ring's antialiasing off the element's content edge. The box-shadow no
  // longer needs covering here: surfaces overlapping a browser drop their shadow entirely
  // (SurfaceFrame overlapsWeb), so there is no shadow to hard-cut into a hairline.
  const PAD = 8
  const subs = cut
    .map((r) => {
      const rr = Math.max(0, Math.min(rad, (r.x2 - r.x1) / 2, (r.y2 - r.y1) / 2))
      if (rr < 0.5) return `M${r.x1} ${r.y1} V${r.y2} H${r.x2} V${r.y1} Z`
      // counter-clockwise: down the left, arc the bottom-left, along the bottom, arc the
      // bottom-right, up the right, close along the top (sweep 0 = CCW corner turns)
      return `M${r.x1} ${r.y1} V${r.y2 - rr} A${rr} ${rr} 0 0 0 ${r.x1 + rr} ${r.y2} H${r.x2 - rr} A${rr} ${rr} 0 0 0 ${r.x2} ${r.y2 - rr} V${r.y1} Z`
    })
    .join(' ')
  return `path("M${-PAD} ${-PAD} H${w + PAD} V${h + PAD} H${-PAD} Z ${subs}")`
}

/** The desktop base (.bg) keeps its opaque canvas color and gets SCREEN-SPACE holes cut per page —
 *  going fully transparent instead made every window box-shadow composite against glass (dark
 *  fringes pooling between windows). Recomputed per camera change (it renders per pan frame anyway). */
export function bgHolesClip(surfaces: Surface[], t: { x: number; y: number; scale: number }, vw: number, vh: number): HolesClip {
  const holes: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (const w of surfaces) {
    if (w.kind !== 'web' || w.minimized || (w.groupId && !w.peek)) continue
    const inset = slotOf(w) ? WEB_CHROME_H_SLOTTED : WEB_CHROME_H
    const x1 = Math.round(w.x * t.scale + t.x)
    const y1 = Math.round((w.y + inset) * t.scale + t.y)
    const x2 = Math.round((w.x + w.w) * t.scale + t.x)
    const y2 = Math.round((w.y + w.h) * t.scale + t.y)
    if (x2 <= 0 || y2 <= 0 || x1 >= vw || y1 >= vh || y2 <= y1) continue
    holes.push({ x1, y1, x2, y2 })
  }
  if (!holes.length) return undefined // no page on screen → no clip on the full-viewport .bg
  return holesPath(vw, vh, holes, WINDOW_RADIUS * t.scale)
}

/** The sandwich's page-over-DOM direction: pages live BELOW all DOM, so any DOM surface that should
 *  render UNDER a browser (lower effectiveZ, overlapping) gets its frame clipped around that
 *  browser's page hole — the live page shows through the cut. World coordinates, so camera pan/zoom
 *  never recomputes this; only layout/z changes do. */
function pageHolesClip(me: Surface, all: Surface[]): HolesClip {
  const meZ = effectiveZ(me)
  const holes: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (const w of all) {
    if (w.id === me.id || w.kind !== 'web' || w.minimized || (w.groupId && !w.peek)) continue
    if (effectiveZ(w) <= meZ) continue
    // If a higher-z browser's FULL window rect (chrome + page) entirely covers `me`, `me` is never
    // visible — hide it outright. The hole below uses the page rect (chrome inset), so a widget
    // straddling the chrome/page line would NOT trigger holesPath's HIDE and would get a degenerate
    // partial clip that ghosts its outline onto the page (the "widget outline" artifact). The full
    // window rect is the correct cover test (chrome is opaque DOM over the top; the page hole the rest).
    if (w.x <= me.x && w.y <= me.y && w.x + w.w >= me.x + me.w && w.y + w.h >= me.y + me.h) return 'HIDE'
    const inset = slotOf(w) ? WEB_CHROME_H_SLOTTED : WEB_CHROME_H
    const x1 = w.x - me.x
    const y1 = w.y + inset - me.y
    const x2 = w.x + w.w - me.x
    const y2 = w.y + w.h - me.y
    if (x2 <= 0 || y2 <= 0 || x1 >= me.w || y1 >= me.h || y2 <= y1) continue
    holes.push({ x1, y1, x2, y2 })
  }
  // No overlapping higher browser → no page hole → NO clip-path at all (the frame's own CSS
  // border-radius still rounds it). Returning undefined keeps non-overlapping widgets off the clip
  // layer entirely, so a browser over a field of widgets does not put every one on a repaint path.
  if (!holes.length) return undefined
  return holesPath(me.w, me.h, holes, WINDOW_RADIUS)
}

/** The tiling/snap PREVIEW is plain DOM in .world with no z (it is always desktop substrate below
 *  every browser), but in the sandwich z-index can't order DOM under a page — only a page-hole can.
 *  So mirror pageHolesClip for the preview rect `sp`, with NO z-test (it is unconditionally below all
 *  browsers), in the SAME world coords (preview and surfaces are both children of .world, which
 *  applies the camera via CSS transform) and the SAME un-scaled WINDOW_RADIUS. Returns 'HIDE' on full
 *  cover, undefined when there is no web surface to clip around. */
export function snapPreviewClip(sp: { x: number; y: number; w: number; h: number }, all: Surface[]): HolesClip {
  const holes: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (const w of all) {
    if (w.kind !== 'web' || w.minimized || (w.groupId && !w.peek)) continue
    // A browser's FULL window rect (chrome + page) entirely covering the preview means it is never
    // visible — hide it outright (a degenerate partial clip ghosts the preview's outline onto the
    // page). The hole below uses the page rect (chrome inset), matching pageHolesClip's cover test.
    if (w.x <= sp.x && w.y <= sp.y && w.x + w.w >= sp.x + sp.w && w.y + w.h >= sp.y + sp.h) return 'HIDE'
    const inset = slotOf(w) ? WEB_CHROME_H_SLOTTED : WEB_CHROME_H
    const x1 = w.x - sp.x
    const y1 = w.y + inset - sp.y
    const x2 = w.x + w.w - sp.x
    const y2 = w.y + w.h - sp.y
    if (x2 <= 0 || y2 <= 0 || x1 >= sp.w || y1 >= sp.h || y2 <= y1) continue
    holes.push({ x1, y1, x2, y2 })
  }
  if (!holes.length) return undefined
  return holesPath(sp.w, sp.h, holes, WINDOW_RADIUS)
}

function AppEmptyState(): JSX.Element {
  return (
    <div className="surface-empty">
      <div className="surface-empty-icon">▦</div>
      <h3>App</h3>
      <p>A Blitz app can appear here. Add a deployed app URL, or ask an agent to create one for this workspace.</p>
    </div>
  )
}

// memo: the camera tween (⌘⌘ zoom-out, pan/zoom) re-renders App ~60×/sec, which re-creates every
// SurfaceFrame element. Their `surface` prop keeps a stable reference when only the transform changes,
// so memo lets React skip re-running each browser-bearing frame per animation tick. A surface's own
// store subscriptions (z/selection/drag) still re-render it independently — memo only gates the
// parent-driven churn (brandon-ui's dock-animation props ride along; they only change per-gesture).
export const SurfaceFrame = memo(function SurfaceFrame({
  surface,
  onRequestMinimize,
  onRequestToggleMaximize,
  restoring = false
}: {
  surface: Surface
  onRequestMinimize?: (id: string) => void
  onRequestToggleMaximize?: (id: string) => void
  restoring?: boolean
}): JSX.Element {
  const moveSurface = useDesktop((s) => s.moveSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const closeAgent = useDesktop((s) => s.closeAgent)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  const setActiveTab = useDesktop((s) => s.setActiveTab)
  const closeTab = useDesktop((s) => s.closeTab)
  const addWebTab = useDesktop((s) => s.addWebTab)
  // Prefer explicit active-surface tracking; fall back to highest-z for initial hydrate before focus.
  const activeSurfaceId = useDesktop((s) => s.activeSurfaceId)
  const maxZ = useDesktop((s) => s.surfaces.reduce((m, w) => Math.max(m, w.z), -Infinity))
  const isActive = activeSurfaceId ? activeSurfaceId === surface.id : surface.z === maxZ
  const isSelected = useDesktop((s) => s.selection.includes(surface.id))
  const isDropTarget = useDesktop((s) => s.dragTarget === surface.id)
  const isAbsorbing = useDesktop((s) => s.absorbing.includes(surface.id))
  const grabMode = useDesktop((s) => s.grabMode)
  // Control view = the UNLOCKED canvas (pan/zoom/arrange: drag cards from anywhere, don't interact).
  // The view lock (single-tap ⇧ / toolbar) flips to work mode: the overlay drops and clicks reach the
  // surface content. `mode === 'canvas'` alone broke when canvas became the DEFAULT mode — it covered
  // every widget with the drag overlay permanently ("can't even click the theme picker").
  const isControl = useDesktop((s) => s.mode === 'canvas' && !s.locked)
  const osAccent = useDesktop((s) => s.osAccent)
  const [isDragging, setIsDragging] = useState(false)
  // The props a srcdoc widget receives: its OWN props, but the GLOBAL OS accent folded in when the
  // widget declares none (board cards carry their own palette accent and keep it). So plain + future
  // widgets follow the OS theme automatically.
  const widgetProps = (): Record<string, unknown> => {
    const p = (surface.props ?? {}) as Record<string, unknown>
    if (!osAccent || p.accent) return p
    const n = parseInt(osAccent.slice(1), 16)
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
    return { accent: osAccent, accentInk: lum > 150 ? '#1a1b1d' : '#ffffff', ...p }
  }

  const drag = useRef<{
    startX: number
    startY: number
    items: Array<{ id: string; ox: number; oy: number; ow: number; oh: number }>
    single: boolean
    grabFracX: number // where along the window the pointer grabbed (0..1) — for pop-out repositioning
    grabFracY: number
    startPreSnap?: { w: number; h: number } // floating size if this window started the drag already tiled
    poppedOut: boolean // a tiled window has been dragged back out to floating this gesture
  } | null>(null)
  const resize = useRef<{ startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; dir: string } | null>(null)
  // Slotted-tile drag: the candidate lattice span under the outline ghost (committed on drop).
  const slotGhost = useRef<{ col: number; row: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const webHostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const serverMode = !!window.agentOS?.serverMode
  // SPIKE (plans/blitzos-native-input.md), default OFF: when on, the human's mouse reaches the page
  // NATIVELY (App.tsx makes the UI click-through over a hole), so the synthetic hole-forwarding below
  // is skipped — the real OS event goes straight to L0 (trusted), and keyboard focus is native too.
  const nativeInput = !!window.agentOS?.nativeInput
  const [draft, setDraft] = useState(surface.url ?? '') // address-bar draft text (app / server-web)
  const zoom = surface.zoom ?? 1
  // jsx/tsx widgets compile at mount (inert {active:false} for everything else). The composed
  // srcdoc (or error card) arrives async; the iframe mounts only once it's ready.
  const jsxWidget = useJsxWidget(surface)
  // Bookmarks dropdown — plain DOM. The sandwich compositor (plans/blitzos-sandwich-compositor.md)
  // puts ALL UI in the transparent top window, physically above the live pages below, so a dropdown
  // simply paints over the page. No capture, no freeze, no placeholder.
  const [bmOpen, setBmOpen] = useState(false)
  // The page's cursor (text beam, link hand), mirrored from main — the UI window owns the OS cursor.
  const [pageCursor, setPageCursor] = useState('default')
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) return
    return window.agentOS?.onPageCursor?.((m) => {
      if (m.surfaceId === surface.id) setPageCursor(CURSOR_CSS[m.cursor] ?? m.cursor)
    })
  }, [surface.kind, surface.id, serverMode])

  // If this surface unmounts mid-drag (the agent closes it, a reconcile removes its file, a folder
  // absorbs it), onBarUp never fires — so clear any ghost snap-preview / drop-target it left behind.
  useEffect(() => {
    return () => {
      if (drag.current) {
        const st = useDesktop.getState()
        st.setSnapPreview(null)
        st.setDragTarget(null)
      }
    }
  }, [])

  // Electron web surfaces are main-owned WebContentsViews — ONE PER BROWSER TAB. React owns the
  // chrome/layout and DECLARES the tab list; main reconciles live views to it. The declaration is
  // idempotent and the host defers teardown one beat, so StrictMode's mount→close→mount churn never
  // orphans a view (the bug that left a page floating detached from its frame).
  const webTabs = surface.kind === 'web' && !serverMode ? webTabsOf(surface) : null
  const activeWebTabIdx = webTabs ? Math.min(Math.max(surface.activeTab || 0, 0), webTabs.length - 1) : 0
  const activeWebTab = webTabs ? webTabs[activeWebTabIdx] : null
  const webTabsKey = webTabs ? webTabs.map((t) => t.id).join('\n') : ''
  const webNavKey = webTabs ? webTabs.map((t) => `${t.id} ${t.url ?? ''}`).join('\n') : ''
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) return
    const cur = useDesktop.getState().surfaces.find((s) => s.id === surface.id) ?? surface
    window.agentOS?.webContentsViewSync?.({
      id: surface.id,
      tabs: webTabsOf(cur).map((t) => ({ id: t.id, url: t.url })),
      active: activeWebTab?.id ?? null,
      zoom
    })
    // Re-declare on tab-list/active/zoom changes only — a tab's URL changing is a NAVIGATION
    // (the effect below), not a reason to re-sync the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.kind, surface.id, serverMode, webTabsKey, activeWebTab?.id, zoom])
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) return
    return () => window.agentOS?.webContentsViewClose?.(surface.id)
  }, [surface.kind, surface.id, serverMode])

  // The body rectangle is reported to main by a SINGLE coalesced RAF in App.tsx (pillar 2), which
  // reads every browser hole by its `data-sid` and pushes one ordered geometry message. The old
  // per-surface RAF (one forced-layout loop per browser, each reordering against stale cross-surface
  // z) lived here; it was the multi-browser/multi-widget glitch. See blitzos-compositor-hardening.md.

  // --- sandwich input forwarding: pointer/wheel events landing on the hole go to the page. The
  // view sits at exactly the hole's screen rect, so view-local = client - rect origin (no descale).
  const holePoint = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const el = webHostRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const holeMods = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string[] => {
    const m: string[] = []
    if (e.shiftKey) m.push('shift')
    if (e.ctrlKey) m.push('control')
    if (e.altKey) m.push('alt')
    if (e.metaKey) m.push('meta')
    return m
  }
  const holeMoveRaf = useRef(0)
  function onHoleDown(e: React.PointerEvent): void {
    if (nativeInput) return // native mode: the real OS click already fell through to the page
    const p = holePoint(e)
    if (!p) return
    window.agentOS?.pageInput?.(surface.id, { type: 'down', ...p, button: e.button, clicks: e.detail || 1, modifiers: holeMods(e) })
    // no stopPropagation: the bubble reaches focusHere on the frame and raises this window
  }
  function onHoleUp(e: React.PointerEvent): void {
    if (nativeInput) return // native mode: native click handles input + key focus
    const p = holePoint(e)
    if (!p) return
    window.agentOS?.pageInput?.(surface.id, { type: 'up', ...p, button: e.button, clicks: e.detail || 1, modifiers: holeMods(e) })
    // Keyboard handoff is CONDITIONAL (main probes what the click focused): flipping the key window
    // on every page click grayed the UI chrome — only an editable target needs native keys/IME.
    window.agentOS?.pageFocus?.(surface.id)
  }
  function onHoleMove(e: React.PointerEvent): void {
    if (nativeInput) return // native mode: real moves reach the page; App.tsx tracks the cursor
    if (holeMoveRaf.current) return
    const { clientX, clientY } = e
    const m = holeMods(e)
    holeMoveRaf.current = requestAnimationFrame(() => {
      holeMoveRaf.current = 0
      const p = holePoint({ clientX, clientY })
      if (p) window.agentOS?.pageInput?.(surface.id, { type: 'move', ...p, modifiers: m })
    })
  }
  // Wheel needs preventDefault (the canvas pan/zoom handlers live above) → native non-passive listener.
  // In native-input mode the real wheel passes through to L0 (ignore:true forwards it), so skip this.
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode || nativeInput) return
    const el = webHostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const r = el.getBoundingClientRect()
      window.agentOS?.pageInput?.(surface.id, { type: 'wheel', x: e.clientX - r.left, y: e.clientY - r.top, dx: e.deltaX, dy: e.deltaY, modifiers: holeMods(e) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.kind, surface.id, serverMode])

  // Any tab's url change navigates ITS view: the BrowserNav address bar and agent update_surface{url}
  // both fold into the active tab's url (store), bookmark clicks too; popup tabs arrive with one. Main
  // reports real navigations back per tab and the host no-ops an already-current url, so the
  // push-echo never loops.
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) return
    const cur = useDesktop.getState().surfaces.find((s) => s.id === surface.id) ?? surface
    for (const t of webTabsOf(cur)) if (t.url) window.agentOS?.webContentsViewNavigate?.(surface.id, t.id, t.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.kind, surface.id, serverMode, webNavKey])

  // Keep the app/server address-bar draft in sync with the stored url (Electron web surfaces moved to
  // BrowserNav, which holds per-tab drafts with a focus clobber-guard).
  useEffect(() => setDraft(surface.url ?? ''), [surface.url])

  function normalizeUrl(s: string): string {
    const t = s.trim()
    if (!t || /^https?:\/\//i.test(t)) return t
    return 'https://' + t
  }
  // Address-bar submit for app (iframe src via the store) and server-mode web (headless browser).
  function go(e: React.FormEvent): void {
    e.preventDefault()
    const u = normalizeUrl(draft)
    if (!u) return
    setDraft(u)
    if (surface.kind === 'app') {
      useDesktop.getState().updateSurface(surface.id, { url: u })
      return
    }
    if (serverMode) {
      window.agentOS?.serverNavigate?.(surface.id, u)
      let title = u
      try {
        title = new URL(u).hostname || u
      } catch {
        /* keep u */
      }
      useDesktop.getState().updateSurface(surface.id, { url: u, title })
    }
  }

  // Server mode: mount the streamed <canvas> for this web surface (draws screencast
  // frames, forwards pointer/wheel/key to the server browser via the stream WS).
  useEffect(() => {
    if (surface.kind !== 'web' || !serverMode) return
    const c = canvasRef.current
    const mount = window.agentOS?.mountServerSurface
    if (!c || !mount) return
    return mount(c, surface.id, { w: surface.w, h: surface.h })
  }, [surface.kind, surface.id, surface.w, surface.h, serverMode])

  // srcdoc widget bridge: relay the widget's blitz:req (data from a connected
  // integration) to the OS, gated by a one-time consent prompt; reply over
  // postMessage. The sender is authenticated by object identity (event.source ===
  // our iframe.contentWindow) — origin is the unusable "null" for a sandboxed frame.
  // Deliver a reply ONLY to the generation that asked: an html reload swaps the
  // iframe's contentWindow, so a stale held reply for the old document must never
  // land on the new one (would cross-deliver consented data to different code).
  function postRes(win: Window, reqId: string, r: BridgeReply): void {
    if (iframeRef.current?.contentWindow === win) win.postMessage({ type: 'blitz:res', reqId, ...r }, '*')
  }
  // The widget bridge runs every op IMMEDIATELY — no consent gate, no card, no held queue (removed: the OS
  // draws no distinction here and a connected agent already has full power; widgets are first-class). Each
  // serve* does the work and replies to the SAME generation that asked (postRes is contentWindow-checked, so
  // a reply for the old document can't land on a reloaded iframe).
  function serveData(win: Window, reqId: string, provider: string, resource: string): Promise<void> {
    const api = window.agentOS
    if (!api?.widgetRequest) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget data bridge unavailable here' }))
    return api
      .widgetRequest({ surfaceId: surface.id, op: 'data', provider, resource })
      .then(
        (res) => postRes(win, reqId, res?.ok ? { ok: true, data: res.data } : { ok: false, error: res?.error || 'request failed' }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }
  // blitz.tool — the widget calls an OS tool (create_surface/open_window/group/provider_call/…). CLOSED
  // allowlist enforced main/server-side (widget-tools.mjs).
  function serveTool(win: Window, reqId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const api = window.agentOS
    if (!api?.widgetTool) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget tool bridge unavailable here' }))
    return api
      .widgetTool(surface.id, name, args)
      .then(
        (res) => postRes(win, reqId, res?.ok ? { ok: true, data: res.result } : { ok: false, error: res?.error || 'tool failed' }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }
  // blitz.sendMessage — the widget sends a message to ITS agent. The agent id rides from the surface
  // (props.agentId, set by the host per agent) so each chat widget routes to its own agent.
  function serveMessage(win: Window, reqId: string, text: string): Promise<void> {
    window.agentOS?.sendMessage?.(String(text), String(surface.props?.agentId ?? '0'))
    return Promise.resolve(postRes(win, reqId, { ok: true }))
  }
  // blitz.chat — a per-agent chat widget manages itself (op 'new' → a fresh agent's id; 'rename' → its title).
  // Returns the result (e.g. the new agent id). This is the per-agent control API, NOT a session hub.
  function serveChat(win: Window, reqId: string, op: string, args: Record<string, unknown>): Promise<void> {
    const api = window.agentOS as { chatControl?: (op: string, args: Record<string, unknown>) => Promise<unknown> } | undefined
    if (!api?.chatControl) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'chat control unavailable here' }))
    return api.chatControl(String(op), args).then(
      (r) => postRes(win, reqId, { ok: true, data: r }),
      (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
    )
  }
  // blitz.listDir — the widget lists a workspace folder (the file-manager widget).
  function serveListDir(win: Window, reqId: string, path: string): Promise<void> {
    const api = window.agentOS
    if (!api?.listDir) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget files bridge unavailable here' }))
    return api
      .listDir(String(path))
      .then(
        (r) => postRes(win, reqId, { ok: true, data: r }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }

  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    const onMessage = (e: MessageEvent): void => {
      const win = iframeRef.current?.contentWindow
      if (!win || e.source !== win) return // only OUR widget (origin is unusable "null")
      const m = e.data as { type?: string; reqId?: string; op?: string; provider?: string; resource?: string; tool?: string; args?: unknown; text?: string; path?: string; chatOp?: string }
      if (!m || typeof m !== 'object') return
      if (m.type === 'blitz:hello') {
        win.postMessage({ type: 'blitz:init', props: widgetProps() }, '*')
      } else if (m.type === 'blitz:contextmenu') {
        // Item 5b: a srcdoc widget forwarded a right-click (its iframe swallowed it). Open the annotation
        // menu at that point — EXCEPT on runtime panels (chat/activity), where annotating makes no sense.
        const isPanel = surface.role === 'chat' || surface.role === 'activity'
        const el = iframeRef.current
        if (!isPanel && el) {
          const r = el.getBoundingClientRect()
          const z = surface.zoom ?? 1
          const cw = r.width / z
          const ch = r.height / z // content px (the iframe is CSS-scaled by zoom)
          const cx = Number((m as { x?: number }).x) || 0
          const cy = Number((m as { y?: number }).y) || 0
          if (cw > 0 && ch > 0) {
            useDesktop.getState().openAnnotationMenu(surface.id, cx / cw, cy / ch, r.left + cx * z, r.top + cy * z)
          }
        }
      } else if (m.type === 'blitz:annotation') {
        // Item 5b: a chat widget's grounded reference was clicked → recall the annotation bubble on its
        // surface (fire-and-forget; the ref carries the full annotation so it works after a reload).
        const ref = (m as { ref?: unknown }).ref as { id?: unknown; surfaceId?: unknown; xPct?: unknown; yPct?: unknown; text?: unknown } | undefined
        if (ref && ref.id && ref.surfaceId) {
          useDesktop.getState().recallAnnotation({ id: String(ref.id), surfaceId: String(ref.surfaceId), xPct: Number(ref.xPct) || 0, yPct: Number(ref.yPct) || 0, text: String(ref.text ?? ''), ts: 0 })
        }
      } else if (m.type === 'blitz:jsxerr') {
        // A jsx widget's bootstrap caught a runtime failure (bad import, mount throw, unhandled
        // rejection). Fold it into props.lastError so the agent reads it from list_state; the
        // bootstrap already painted the in-widget overlay for the human.
        const msg = String((m as { error?: unknown }).error ?? 'widget runtime error').slice(0, 500)
        if (surface.props?.lastError !== msg) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: msg })
      } else if (m.type === 'blitz:jsxok') {
        // The widget mounted clean — clear a stale lastError from a previous broken generation.
        if (surface.props?.lastError) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: undefined })
      } else if (m.type === 'blitz:req' && typeof m.reqId === 'string') {
        if (m.op === 'data') void serveData(win, m.reqId, String(m.provider ?? ''), String(m.resource ?? ''))
        else if (m.op === 'tool') void serveTool(win, m.reqId, String(m.tool ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'msg') void serveMessage(win, m.reqId, String(m.text ?? ''))
        else if (m.op === 'chat') void serveChat(win, m.reqId, String(m.chatOp ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'listdir') void serveListDir(win, m.reqId, String(m.path ?? ''))
        else if (m.op === 'setprops') {
          // A widget persists its OWN state (e.g. a note's text) — own-surface only, so no consent gate.
          const patch = (m as { patch?: unknown }).patch
          useDesktop.getState().updateSurfaceProps(surface.id, (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>)
          postRes(win, m.reqId, { ok: true })
        } else postRes(win, m.reqId, { ok: false, error: `unsupported op: ${String(m.op)}` })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // surface.props intentionally in deps: a hello after a prop change re-seeds fresh props
  }, [surface.kind, surface.id, surface.props])

  // Live prop changes reach the widget without reloading it (html stays put). Also re-posts when
  // the global OS accent changes so plain widgets (no own props.accent) recolor immediately.
  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:props', props: widgetProps() }, '*')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.kind, surface.props, osAccent])

  function onBarDown(e: React.PointerEvent): void {
    e.stopPropagation()
    focusSurface(surface.id)
    // Capture on currentTarget (the bar / drag-overlay) so move+up always land here even if the
    // pointer leaves the window — the clean-capture fix for "stuck mouse events / can't unsnap".
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore (synthetic events) */
    }
    setIsDragging(true)
    const st = useDesktop.getState()
    // drag the whole selection if this surface is part of a multi-selection; else just this one.
    // A Space "grab" of a single surface also selects it.
    let ids: string[]
    if (st.selection.includes(surface.id) && st.selection.length > 1) {
      ids = st.selection
    } else {
      ids = [surface.id]
      if (st.grabMode) st.setSelection([surface.id])
    }
    const items = ids
      .map((id) => st.surfaces.find((w) => w.id === id))
      .filter((w): w is Surface => !!w)
      .map((w) => ({ id: w.id, ox: w.x, oy: w.y, ow: w.w, oh: w.h }))
    const single = items.length === 1
    // Grab fraction along THIS window (so a tiled window pops out under the cursor at the same spot).
    const t = st.transform
    const wx = (e.clientX - t.x) / t.scale
    const wy = (e.clientY - t.y) / t.scale
    const grabFracX = surface.w ? Math.min(1, Math.max(0, (wx - surface.x) / surface.w)) : 0.5
    const grabFracY = surface.h ? Math.min(1, Math.max(0, (wy - surface.y) / surface.h)) : 0
    drag.current = { startX: e.clientX, startY: e.clientY, items, single, grabFracX, grabFracY, startPreSnap: surface.preSnap, poppedOut: false }
  }
  function onBarMove(e: React.PointerEvent): void {
    const d = drag.current
    if (!d) return
    const st = useDesktop.getState()
    const t = st.transform
    const wx = (e.clientX - t.x) / t.scale
    const wy = (e.clientY - t.y) / t.scale
    // macOS "pop-out": dragging a tiled window past a small threshold un-tiles it back to its floating
    // size, re-centered under the cursor at the same grab spot, then it follows the pointer normally.
    if (d.single && !d.poppedOut && d.startPreSnap && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) {
      const fw = d.startPreSnap.w
      const fh = d.startPreSnap.h
      const nx = Math.round(wx - d.grabFracX * fw)
      const ny = Math.round(wy - d.grabFracY * fh)
      st.updateSurface(d.items[0].id, { x: nx, y: ny, w: fw, h: fh, preSnap: undefined, restore: undefined })
      // rebase the drag so subsequent deltas apply from the floating rect
      d.startX = e.clientX
      d.startY = e.clientY
      d.items = [{ id: d.items[0].id, ox: nx, oy: ny, ow: fw, oh: fh }]
      d.poppedOut = true
      // Drop any snap preview captured BEFORE the pop-out (the cursor may still sit in the edge zone) so
      // releasing right after popping out doesn't instantly re-tile the window. A later move re-evaluates.
      st.setSnapPreview(null)
      return
    }
    const dx = (e.clientX - d.startX) / t.scale
    const dy = (e.clientY - d.startY) / t.scale
    for (const it of d.items) moveSurface(it.id, it.ox + dx, it.oy + dy)
    // Slotted tile drag (stage desktop, macOS widget feel): the tile floats under the cursor while an
    // OUTLINE previews the nearest free span of the lattice — other tiles NEVER move; only the file
    // layer parts fluidly around the outline. ⌘-drag skips snapping entirely (Apple's escape hatch:
    // release pops the tile off the lattice, free-form). Edge-tiling is suppressed for tiles.
    if (d.single && isSlotted && !e.metaKey) {
      const me = d.items[0]
      const sl = slotOf(surface)
      const stage = surface.slotStage ?? 0
      const lat = latticeFor(st.viewport, stage, st.stageOrder, st.stageCount)
      const ghost = nearestFreeSlot(st.surfaces, lat, sl ? sl.size : 's', me.ox + dx + me.ow / 2, me.oy + dy + me.oh / 2, stage, surface.id)
      slotGhost.current = ghost
      const gr = ghost && sl ? slotRect(lat, ghost.col, ghost.row, sl.size) : null
      st.setSnapPreview(gr)
      st.reflowFiles(gr) // fluid: files flow out of the outline's way live
      st.setDragTarget(null)
      return
    }
    if (d.single && isSlotted) {
      // ⌘ held: free drag, no ghost — the escape hatch out of the lattice.
      slotGhost.current = null
      st.setSnapPreview(null)
      return
    }
    // highlight a folder under the cursor as an add-to-folder drop target
    const dragged = new Set(d.items.map((it) => it.id))
    const folder = st.surfaces.find(
      (w) => w.component === 'folder' && !dragged.has(w.id) && wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h
    )
    st.setDragTarget(folder ? folder.id : null)
    // Snap preview (BOTH modes, #42): dragging a single window so the cursor reaches a primary-stage
    // side/corner shows where it will tile on release (left|right half / quarter — never full-screen).
    // Suppressed over a folder target and for file/dir tiles (they aren't windows).
    st.setSnapPreview(d.single && !folder && !isFolder && !isFileTile ? snapTargetFor(wx, wy, st.viewport, st.currentStage, st.mode, st.stageOrder, st.stageCount) : null)
  }
  function onBarUp(e: React.PointerEvent): void {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setIsDragging(false)
    const d = drag.current
    drag.current = null
    const st = useDesktop.getState()
    const target = st.dragTarget
    const snap = st.snapPreview
    st.setDragTarget(null)
    st.setSnapPreview(null)
    // Slotted tile drop: ⌘-release pops it OFF the lattice (free-form, Apple's escape hatch); a normal
    // release spring-snaps into the outlined span (or back to its own cells — self is excluded from
    // occupancy, so "didn't really move" is always a valid drop). Files reflow to the settled layout.
    if (d && d.single && isSlotted) {
      const sl = slotOf(surface)
      if (e.metaKey) {
        st.clearSurfaceSlot(surface.id)
      } else {
        const g = slotGhost.current
        if (g && sl) st.placeSurfaceSlot(surface.id, g.col, g.row, sl.size)
        else if (sl) st.placeSurfaceSlot(surface.id, sl.col, sl.row, sl.size) // nothing free under the drag — settle home
      }
      slotGhost.current = null
      st.reflowFiles()
      return
    }
    if (d && target) st.dropIntoFolder(target, d.items.map((it) => it.id))
    // Apply the tile; remember the floating size in `preSnap` so a later drag pops it back out
    // (macOS). `restore` is cleared so a previously-maximized window's green-zoom isn't stale.
    else if (d && snap && d.single && !isFileTile) {
      const floating = d.startPreSnap ?? { w: d.items[0].ow, h: d.items[0].oh }
      st.updateSurface(d.items[0].id, { ...snap, preSnap: floating, restore: undefined })
    }
  }

  // macOS-style resize from any side/corner. `dir` is a combination of n/s/e/w; a side handle
  // resizes that edge and moves the opposite edge's position. Works in control mode too (the
  // handles sit above the drag-overlay).
  // Grid toggle (stage desktop): pop a slotted tile OUT to free-form (pre-slot size restored), or
  // snap a free window INTO the nearest free span sized to fit it. The discoverable counterpart of
  // ⌘-drag — this is how a note (or the chat) enters and leaves the lattice.
  function toggleSlot(): void {
    useDesktop.getState().toggleSurfaceSlot(surface.id)
  }

  function onResizeDown(e: React.PointerEvent, dir: string): void {
    e.stopPropagation()
    focusSurface(surface.id)
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* synthetic event */
    }
    resize.current = { startX: e.clientX, startY: e.clientY, origX: surface.x, origY: surface.y, origW: surface.w, origH: surface.h, dir }
  }
  function onResizeMove(e: React.PointerEvent): void {
    const r = resize.current
    if (!r) return
    const scale = useDesktop.getState().transform.scale
    const dxw = (e.clientX - r.startX) / scale
    const dyw = (e.clientY - r.startY) / scale
    const MINW = 160
    const MINH = 120
    let nx = r.origX
    let ny = r.origY
    let nw = r.origW
    let nh = r.origH
    if (r.dir.includes('e')) nw = r.origW + dxw
    if (r.dir.includes('s')) nh = r.origH + dyw
    if (r.dir.includes('w')) {
      nw = r.origW - dxw
      nx = r.origX + dxw
    }
    if (r.dir.includes('n')) {
      nh = r.origH - dyw
      ny = r.origY + dyw
    }
    if (nw < MINW) {
      if (r.dir.includes('w')) nx = r.origX + r.origW - MINW // keep the right edge anchored
      nw = MINW
    }
    if (nh < MINH) {
      if (r.dir.includes('n')) ny = r.origY + r.origH - MINH // keep the bottom edge anchored
      nh = MINH
    }
    // macOS-faithful resize: a window may extend freely BEYOND the stage (off the sides/bottom), just
    // like free dragging — the ONLY constraint in normal mode is that a top-edge (n/nw/ne) resize can't
    // push the title bar above the stage's top (so it stays grabbable — the #29 invariant). All stages
    // share the same top, so it's stage-independent.
    const st0 = useDesktop.getState()
    if (st0.mode === 'desktop') {
      const topY = primaryRect(st0.viewport).y
      if (ny < topY) {
        nh -= topY - ny
        ny = topY
      }
      nh = Math.max(MINH, nh)
    }
    // A manual resize takes the window out of any tiled state (so it won't pop to a stale floating size).
    useDesktop.getState().updateSurface(surface.id, { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh), preSnap: undefined })
  }
  function onResizeUp(e: React.PointerEvent): void {
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    resize.current = null
  }

  const stop = (e: React.PointerEvent): void => e.stopPropagation()
  const isNote = surface.kind === 'native' && surface.component === 'note'
  const isFolder = surface.kind === 'native' && surface.component === 'folder'
  const isFileTile = surface.kind === 'native' && (surface.component === 'file' || surface.component === 'dir') // a real file/dir, not a window
  const isSlotted = !!slotOf(surface) // a stage tile: lattice-snapped, fixed-size, never edge-tiles
  // Cut a higher browser's page hole out of this frame (string-equality selector: recomputes per
  // store change, re-renders only when the polygon actually changes; world coords, camera-free).
  const clipPath = useDesktop((s) => (serverMode ? undefined : pageHolesClip(surface, s.surfaces)))
  // A DOM box-shadow can't composite cleanly against a browser's page HOLE in EITHER direction:
  // clipped UNDER a browser the clip hard-cuts it to a hairline; floating OVER a browser it pools
  // dark over the transparent hole (the page shows through, darkened). So whenever this surface
  // overlaps a live browser, drop its shadow — no shadow, no fringe. (web surfaces don't shadow
  // each other this way; only DOM surfaces vs the page layer.)
  // True when THIS surface overlaps any OTHER live browser, so it must drop its box-shadow (the
  // --hairline inset border + the drop shadow) which would otherwise fringe/hairline against the page
  // composite. Now includes browser-over-browser (the `kind === 'web'` exclusion is gone): a focused
  // browser over another kept its drop shadow + border and cast the dark edge the user saw. The red
  // focus ring is an OUTLINE (.window.is-active), NOT a box-shadow, so it survives this drop.
  const overlapsWeb = useDesktop((s) =>
    serverMode
      ? false
      : s.surfaces.some(
          (w) =>
            w.kind === 'web' &&
            w.id !== surface.id &&
            !w.minimized &&
            !(w.groupId && !w.peek) &&
            w.x < surface.x + surface.w &&
            surface.x < w.x + w.w &&
            w.y < surface.y + surface.h &&
            surface.y < w.y + w.h
        )
  )
  // System panels (the pinned chat/activity hubs) keep the full window bar even when slotted —
  // hiding it would cost their close/minimize controls. Everything else slotted gets WIDGET chrome:
  // no bar at all, just an invisible top drag-grip + the pop-out toggle in the far right corner.
  const isSystemPanel = surface.role === 'chat' || surface.role === 'activity' || (surface.kind === 'native' && (surface.component === 'chat' || surface.component === 'activity'))
  const widgetChrome = isSlotted && !isSystemPanel
  const needsFocusCatcher = !isActive && !isControl && (surface.kind === 'app' || surface.kind === 'srcdoc')
  // A direct click/focus means THIS is the window the user is acting on: raise it AND drop any stale
  // marquee selection that doesn't include it — ⌘T/⇧⌘T target "the single selection else the
  // front-most", so a forgotten selection would silently hijack the keybind to an old window.
  // Clicking a selected member keeps the multi-selection (mac behavior).
  const focusHere = (): void => {
    focusSurface(surface.id)
    const st = useDesktop.getState()
    if (st.selection.length && !st.selection.includes(surface.id)) st.clearSelection()
  }
  const paper = isNote ? (NOTE_PAPER[(surface.props?.color as string) || 'coral'] ?? NOTE_PAPER.coral) : undefined

  function body(): JSX.Element {
    const fill = { width: '100%', height: '100%', border: 'none', display: 'block' } as const
    // CSS content-zoom for iframes (web uses native setZoomFactor instead)
    const iframeZoom =
      zoom === 1
        ? fill
        : { ...fill, width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: '0 0' as const }
    switch (surface.kind) {
      case 'web':
        // Server mode: the site lives in a server-side headless browser, streamed
        // here as a <canvas> (mountServerSurface draws frames + forwards input).
        // Electron: THE HOLE — transparent; the live page (a WebContentsView in the sandwich's
        // pages window) shows through from underneath. Pointer/wheel forward to it; keyboard rides
        // the pageFocus handoff from onHoleDown.
        if (serverMode) return <canvas ref={canvasRef} style={fill} />
        return (
          <div
            ref={webHostRef}
            className="webcontents-host"
            data-sid={surface.id} // the App-level coalesced geometry pass (pillar 2) reads every hole's rect by id
            // containment inside the focus ring comes from the frame's 1px padding (.window.browser)
            style={{ ...fill, cursor: pageCursor }}
            onPointerDown={onHoleDown}
            onPointerMove={onHoleMove}
            onPointerUp={onHoleUp}
          />
        )
      case 'app':
        if (!surface.url) return <AppEmptyState />
        return (
          <iframe
            title={surface.title}
            src={surface.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={iframeZoom}
          />
        )
      case 'srcdoc': {
        // Prepend the OS<->widget bridge shim (window.blitz) + the Blitz UI kit (design tokens +
        // <blitz-*> web components) so every widget shares ONE component library; the stored html stays
        // clean (forkable). onLoad seeds props after the document (incl. the shim) has parsed.
        // jsx/tsx widgets: the body is the compiled composition (import map + bootstrap) — same
        // shim/kit prepend, same iframe, same bridge. Until the compile resolves, render a shell
        // (NOT an iframe) so the widget document loads exactly once.
        if (jsxWidget.active && jsxWidget.srcdoc === null) return <div className="jsx-compiling" style={fill} />
        const srcdocBody = jsxWidget.active ? jsxWidget.srcdoc! : surface.html ?? ''
        return (
          <iframe
            ref={iframeRef}
            title={surface.title}
            sandbox="allow-scripts"
            srcDoc={BRIDGE_SHIM + UI_KIT + srcdocBody}
            style={iframeZoom}
            onLoad={() =>
              iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:init', props: widgetProps() }, '*')
            }
          />
        )
      }
      case 'native':
        if (surface.component === 'note') return <NoteWidget surface={surface} />
        if (surface.component === 'chat') return <ChatPanel surface={surface} />
        if (surface.component === 'activity') return <ActivityPanel surface={surface} />
        if (surface.component === 'terminal') {
          const tabs = surface.tabs || []
          const active = tabs[Math.min(Math.max(surface.activeTab || 0, 0), Math.max(0, tabs.length - 1))]
          const tid = active?.terminalId || (surface.props?.terminalId as string) || ''
          // key by terminal id so switching tabs remounts the view onto the new terminal (scrollback re-fetched)
          return <TerminalView key={tid} surface={{ ...surface, props: { terminalId: tid } }} />
        }
        if (surface.component === 'runtime') return <RuntimePanel surface={surface} />
        if (surface.component === 'inbox') return <InboxPanel surface={surface} />
        if (surface.component === 'file') return <FileWidget surface={surface} />
        if (surface.component === 'dir') return <DirWidget surface={surface} />
        if (surface.component === 'files') return <FileManager surface={surface} />
        if (surface.component === 'unlock') return <UnlockWidget surface={surface} />
        return <div className="native-fallback">unknown widget: {surface.component}</div>
    }
  }

  if (isFolder) {
    return (
      <div
        className={`window folder${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isDropTarget ? ' drop-target' : ''}`}
        style={{
          left: surface.x,
          top: surface.y,
          width: surface.w,
          height: surface.h,
          zIndex: surface.z,
          ...(clipPath && clipPath !== 'HIDE' ? { clipPath } : {}),
          ...(overlapsWeb || (clipPath && clipPath !== 'HIDE') ? { boxShadow: 'none' } : {}),
          ...(clipPath === 'HIDE' ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : {})
        }}
        onPointerDown={focusHere}
      >
        <FolderWidget surface={surface} onDragDown={onBarDown} onDragMove={onBarMove} onDragUp={onBarUp} />
      </div>
    )
  }

  return (
    <div
      ref={frameRef}
      data-sid={surface.id}
      className={`window${isNote ? ' note' : ''}${surface.kind === 'web' && !serverMode ? ' browser' : ''}${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isAbsorbing ? ' absorbing' : ''}`}
      style={{
        left: surface.x,
        top: surface.y,
        width: surface.w,
        height: surface.h,
        // The sandwich's page-over-DOM direction: a higher browser's page hole is CUT out of this
        // frame so the live page (below all DOM) shows through where it should cover us. 'HIDE' =
        // fully covered: hide outright (a degenerate clip ghosts the element's outline).
        ...(clipPath && clipPath !== 'HIDE' ? { clipPath } : {}),
        // Overlapping a browser: drop the box-shadow so it can't fringe against the page hole.
        ...(overlapsWeb || (clipPath && clipPath !== 'HIDE') ? { boxShadow: 'none' } : {}),
        ...(surface.minimized ? { display: 'none' } : {}),
        // Slotted tiles spring-snap into their span (the macOS settle); suspended while dragging so
        // the tile tracks the cursor 1:1, and resumed on drop for the snap animation. File tiles get
        // the smooth glide of the fluid layer (they part around tiles like displaced liquid).
        ...(isSlotted && !isDragging ? { transition: 'left 0.32s cubic-bezier(0.32, 1.23, 0.42, 1), top 0.32s cubic-bezier(0.32, 1.23, 0.42, 1), width 0.32s ease, height 0.32s ease' } : {}),
        ...(isFileTile && !isDragging ? { transition: 'left 0.4s cubic-bezier(0.22, 1, 0.36, 1), top 0.4s cubic-bezier(0.22, 1, 0.36, 1)' } : {}),
        // brandon-ui dock restore: the surface is mounted (for measurement) but hidden while the
        // genie animation plays a clone from the dock; unhidden when the phase ends.
        ...(restoring || clipPath === 'HIDE' ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : {}),
        ...(paper ? { background: paper.bg, color: paper.ink } : {}),
        // Layered desktop (macOS model) — bands live in store.effectiveZ (one source, shared with
        // the browser occlusion test): tiles/icons raw z → free windows +500k → focus +1.5M →
        // pinned chat/activity +2M. A slotted tile being DRAGGED lifts above the window band so it
        // never disappears under one mid-gesture (transient, component-local).
        zIndex: effectiveZ(surface) + (isSlotted && isDragging ? 1_200_000 : 0)
      }}
      onPointerDown={focusHere}
      onFocus={focusHere} // a click INTO an iframe focuses the guest, not the host — still raise this window front-most so keybinds target it
      onContextMenu={(e) => {
        // Item 5b: right-click a native surface (note/tile/frame chrome) → annotation menu at that point.
        // web is handled in main (the WebContentsView owns the browser); srcdoc's sandboxed iframe also swallows it.
        if (surface.kind === 'web') return
        const r = e.currentTarget.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        e.preventDefault()
        useDesktop.getState().openAnnotationMenu(surface.id, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.clientX, e.clientY)
      }}
    >
      {widgetChrome ? (
        <>
          {/* macOS-widget chrome: the tile IS the widget — no window bar. An invisible grip strip
              along the top keeps the full drag gesture set (move, ⌘-drag, drag-to-pop-out all ride
              the same bar handlers), and the pop-in/out toggle floats in the far right corner. */}
          <div className="tile-grip" onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
          <button className="tile-toggle" title="Pop out of the grid — free-form, restores its size (⌘T; ⇧⌘T cycles size)" onClick={toggleSlot} onPointerDown={stop}>
            ⤢
          </button>
        </>
      ) : (
        <div
          className="window-bar"
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
        >
          {/* macOS traffic lights: red=close, yellow=minimize, green=zoom. Colored only when active. */}
          <div className="traffic" onPointerDown={stop}>
            {/* file/dir tiles are real files — "close"/"minimize" would just re-surface on the next
                reconcile (the file still exists), so only offer zoom; delete the file to remove it.
                A NON-primary chat widget's red light DELETES its agent (stop it + delete its chat +
                files/stage); the PRIMARY chat ('0') is pinned + never deletable → no close button. */}
            {surface.role === 'chat'
              ? surface.agentId && String(surface.agentId) !== '0'
                ? <button className="tl tl-close" title="Delete agent" onClick={() => closeAgent(String(surface.agentId))} />
                : null
              : !isFileTile && <button className="tl tl-close" title="Close" onClick={() => closeSurface(surface.id)} />}
            {!isFileTile && <button className="tl tl-min" title="Minimize" onClick={() => (onRequestMinimize ? onRequestMinimize(surface.id) : minimizeSurface(surface.id))} />}
            <button className="tl tl-max" title="Zoom" onClick={() => (onRequestToggleMaximize ? onRequestToggleMaximize(surface.id) : toggleMaximize(surface.id))} />
          </div>
          {surface.kind === 'app' || (surface.kind === 'web' && serverMode) ? (
            <form className="window-url" onSubmit={go} onPointerDown={stop}>
              <input
                value={draft}
                spellCheck={false}
                placeholder="url…"
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={stop}
              />
            </form>
          ) : surface.kind === 'web' ? (
            // Electron browser window: the address lives in the BrowserNav below; the bar shows the
            // page title like every other window (and stays the drag handle).
            <div className="window-title">{activeWebTab?.title || surface.title}</div>
          ) : (
            <div className="window-bar-fill" />
          )}
          {/* the snap/pop toggle lives at the RIGHT END of the bar (it mirrors the widget-chrome
              corner toggle, so the control is always in the same place). */}
          {!isFileTile && (
            <button className={`slot-toggle${isSlotted ? ' on' : ''}`} title={isSlotted ? 'Pop out of the grid — free-form, restores its size (⌘T; ⇧⌘T cycles size)' : 'Snap into the widget grid (⌘T)'} onClick={toggleSlot} onPointerDown={stop}>
              {isSlotted ? '⤢' : '⊞'}
            </button>
          )}
        </div>
      )}
      {webTabs && (
        <>
          {/* Browser tab strip — one page per tab (a main-owned WebContentsView each). Always shown
              (the + is how a second tab is born); closing the last tab closes the window. */}
          <div className="window-tabs" onPointerDown={stop}>
            {webTabs.map((t, i) => (
              <div
                key={t.id}
                className={`wtab${i === activeWebTabIdx ? ' active' : ''}`}
                title={t.url || t.title}
                onClick={() => setActiveTab(surface.id, i)}
              >
                {t.favicon ? (
                  <img className={`wtab-fav${t.loading ? ' loading' : ''}`} src={t.favicon} alt="" draggable={false} />
                ) : (
                  <span className={`wtab-dot${t.loading ? ' loading' : ''}`} />
                )}
                <span className="wtab-title">{t.title || 'New Tab'}</span>
                <button
                  className="wtab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    // the implicit single tab isn't materialized in the store — closing it closes the window
                    if (surface.tabs?.length) closeTab(surface.id, t.id)
                    else closeSurface(surface.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="wtab-add" title="New tab" onClick={() => addWebTab(surface.id)}>
              +
            </button>
          </div>
          {bmOpen && (
            <div
              className="bm-backdrop"
              onPointerDown={(e) => {
                e.stopPropagation()
                setBmOpen(false)
              }}
            />
          )}
          <BrowserNav surface={surface} bmOpen={bmOpen} setBmOpen={setBmOpen} />
        </>
      )}
      {surface.component === 'terminal' && surface.tabs && (
        <div className="window-tabs" onPointerDown={stop}>
          {surface.tabs.map((t, i) => (
            <div
              key={t.id}
              className={`wtab${i === (surface.activeTab || 0) ? ' active' : ''}`}
              title={t.title}
              onClick={() => setActiveTab(surface.id, i)}
            >
              <span className="wtab-title">{t.title}</span>
              <button
                className="wtab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  if (t.terminalId) (window.agentOS as unknown as { terminalStop?: (id: string) => void })?.terminalStop?.(t.terminalId)
                  closeTab(surface.id, t.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="wtab-add"
            title="New terminal tab"
            onClick={() => (window.agentOS as unknown as { terminalSpawn?: (o: object) => void })?.terminalSpawn?.({ command: 'bash', title: nextTerminalName() })}
          >
            +
          </button>
        </div>
      )}
      <div
        className="window-body"
        style={{ position: 'relative', ...(isNote ? { background: 'transparent' } : {}) }}
      >
        {body()}
        {needsFocusCatcher && <div className="window-focus-catcher" onPointerDown={focusHere} />}
      </div>
      {/* macOS-style resize from all sides + corners; above the drag-overlay so it works in control
          mode too (#41). The handles avoid the title-bar controls (traffic lights / eye).
          Slotted tiles have FIXED slot sizes (s/m/l/xl/tall) — no free resize; re-place to change. */}
      {!isSlotted &&
        (['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const).map((dir) => (
        <div
          key={dir}
          className={`rsz rsz-${dir}`}
          onPointerDown={(e) => onResizeDown(e, dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      ))}
      {/* Space grab-mode or selected → drag the surface from anywhere on its body. Always
          mounted (so an in-flight drag survives releasing the key); inert otherwise. */}
      <div
        className={`drag-overlay${isSelected || grabMode || isDragging || isControl ? ' active' : ''}${isControl ? ' control' : ''}`}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
      />
    </div>
  )
})
