import { create } from 'zustand'
import {
  CanvasTransform,
  Surface,
  SurfaceTab,
  SurfaceKind,
  Vec2,
  Annotation,
  Bookmark,
  isRuntimePanel
} from './types'
// The home-grid geometry (chrome insets, homeRect, parkBandRect) lives in the shared stages-core so the
// renderer and the main-process cores share ONE definition (no divergence). Single-canvas model
// (plans/blitzos-single-canvas-navigation.md): one bounded "home" region, no stages/splay.
// Re-exported below so existing `from './store'` importers (capture/App/SurfaceFrame/PrimarySpace) don't churn.
import { homeRect, parkBandRect, DEFAULT_VP } from './stages-core.mjs'
export { homeRect, parkBandRect, DEFAULT_VP }
// Home slot lattice (plans/blitzos-single-canvas-navigation.md): pure shared placer — tiles at integer
// cells, geometry derived; the SAME module places in main (place_widget) and snaps drags here.
import { latticeFor, slotRect, cardRect, slotOf, nearestFreeSlot, flowFiles, sizeForDims, occupancy, spanOf, SIZE_ORDER } from './stage-core.mjs'
export { latticeFor, slotRect, cardRect, slotOf, nearestFreeSlot, sizeForDims }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
function sameCamera(a: CanvasTransform, b: CanvasTransform): boolean {
  return Math.abs(a.x - b.x) < 0.75 && Math.abs(a.y - b.y) < 0.75 && Math.abs(a.scale - b.scale) < 0.006
}
// (home-grid geometry moved to ./stages-core — imported + re-exported above)
// These two insets are still used by the camera anchor below (cx = SIDEBAR + r.w/2, cy = TITLEBAR + r.h/2).
const SIDEBAR = 52
const TITLEBAR = 32
/** Clamp a window so it stays inside the home region (its title bar therefore can't slide under
 *  the top titlebar at the home frame — #29). Single-canvas model: there is only home, so this is a
 *  plain clamp into homeRect (plans/blitzos-single-canvas-navigation.md). */
function desktopClamp(x: number, y: number, w: number, h: number, vp: { w: number; h: number }): Vec2 {
  const r = homeRect(vp)
  return { x: clamp(x, r.x, Math.max(r.x, r.x + r.w - w)), y: clamp(y, r.y, Math.max(r.y, r.y + r.h - h)) }
}

/** The scale-1 HOME camera: home's center maps to a fixed on-screen anchor (right of the dock, below
 *  the titlebar), so home always lands in the same on-screen desktop region. There is no saved camera —
 *  go_to_primary / double-Shift fly here (plans/blitzos-single-canvas-navigation.md). Home's center IS
 *  the world origin, so this is just the screen anchor (cx,cy). */
export function homeTransform(vp: { w: number; h: number }): CanvasTransform {
  const r = homeRect(vp)
  const cx = SIDEBAR + r.w / 2
  const cy = TITLEBAR + r.h / 2
  return { scale: 1, x: cx - (r.x + r.w / 2), y: cy - (r.y + r.h / 2) }
}
/** While dragging a window, if the CURSOR (world coords) reaches a home-region edge, return the
 *  macOS tiling target: left/right half (a side edge) or a quarter (a corner). There is intentionally
 *  NO full-screen / top-half / bottom-half snap — macOS only tiles to halves and quarters, and the
 *  user explicitly does not want a window full-screening on a stray upward drag. Null = free drag.
 *  Mirrors macOS edge-tiling, relative to home (so it works on the infinite canvas). `tight` (the
 *  static-home default) uses a thin edge zone so nudging a window doesn't fire an unwanted tile; a
 *  panned/arranging canvas can pass `false` for a more generous zone. */
export function snapTargetFor(
  wx: number,
  wy: number,
  vp: { w: number; h: number },
  tight = true
): { x: number; y: number; w: number; h: number } | null {
  const r = homeRect(vp)
  const nx = (wx - r.x) / r.w
  const ny = (wy - r.y) / r.h
  if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return null // cursor well outside home
  // Edge/corner snap-intent zone per side. A panned/arranging canvas (tight=false) keeps a GENEROUS
  // zone for easy arranging; the static home (tight) uses a thin zone so the cursor must nearly TOUCH
  // the home border to tile — otherwise nudging a window slightly kept firing an unwanted tile.
  const E = tight ? 0.03 : 0.135
  const nearL = nx < E
  const nearR = nx > 1 - E
  const nearT = ny < E
  const nearB = ny > 1 - E
  // Only the LEFT/RIGHT edges (and their corners) tile — the top/bottom edges do nothing on their own,
  // so a window can never go full-screen and an upward drag just moves it freely (macOS-faithful).
  if (!nearL && !nearR) return null
  // integer split points so adjacent halves/quarters tile with NO 1px seam on odd-width stages
  const x0 = Math.round(r.x)
  const y0 = Math.round(r.y)
  const W = Math.round(r.w)
  const H = Math.round(r.h)
  const halfW = Math.round(W / 2)
  const halfH = Math.round(H / 2)
  if (nearL && nearT) return { x: x0, y: y0, w: halfW, h: halfH } // top-left quarter
  if (nearL && nearB) return { x: x0, y: y0 + halfH, w: halfW, h: H - halfH } // bottom-left quarter
  if (nearR && nearT) return { x: x0 + halfW, y: y0, w: W - halfW, h: halfH } // top-right quarter
  if (nearR && nearB) return { x: x0 + halfW, y: y0 + halfH, w: W - halfW, h: H - halfH } // bottom-right quarter
  if (nearL) return { x: x0, y: y0, w: halfW, h: H } // left half
  return { x: x0 + halfW, y: y0, w: W - halfW, h: H } // right half (nearR)
}

let zCounter = 10
let annCounter = 0 // monotonic annotation id source (item 5b)
// Quiet-period boundary (ms): layout changes closer than this coalesce into ONE undo step.
let lastSnapTs = 0

export interface CreateSurfaceInput {
  id?: string
  kind: SurfaceKind
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
  url?: string
  html?: string
  /** srcdoc source language — jsx/tsx compile at mount; absent/'html' renders verbatim. */
  lang?: 'html' | 'jsx' | 'tsx'
  component?: string
  props?: Record<string, unknown>
  /** P0: agent may read this surface's content over the relay (auto-true for agent-opened web/app). */
  shared?: boolean
  /** tabbed windows (terminal): a terminal per tab. */
  tabs?: SurfaceTab[]
  activeTab?: number
  /** system runtime surface (e.g. an agent chat widget: role:'chat', pinned). */
  role?: string
  pinned?: boolean
  /** the agent/thread this surface belongs to. */
  agentId?: string
  /** Legacy stage hint (single-canvas model: there is one home region). Accepted for back-compat but
   *  IGNORED — the surface cascades into / derives from the single home lattice. */
  stage?: number
  /** Born slotted: a tile on the home lattice — x/y/w/h are derived from it, never trusted. */
  slot?: { col: number; row: number; size: string }
  /** Born as the free-form focus floater (human pull-in). */
  focus?: boolean
  /** Place at the given x/y EXACTLY, skipping the home cascade clamp: the human created it at their
   *  cursor on the open canvas, which may be off-home (plans/blitzos-single-canvas-navigation.md). */
  free?: boolean
}

interface DesktopState {
  transform: CanvasTransform
  viewport: { w: number; h: number }
  // Single-canvas model (plans/blitzos-single-canvas-navigation.md): there is ONE bounded "home" region,
  // no stages/splay. `mode` is pinned to 'desktop' (the field is kept; removing it is a deferred cleanup).
  mode: 'desktop' | 'canvas'
  surfaces: Surface[]
  activeSurfaceId: string | null
  layoutHistory: Surface[][]
  selection: string[]
  /** Spatial annotations (item 5b): grounded references the human placed on surfaces. `annotationDraft`
   *  is the in-progress one (input open); `focusedAnnotation` is the one to flash open (e.g. recalled
   *  from a chat reference). */
  annotations: Annotation[]
  annotationDraft: { surfaceId: string; xPct: number; yPct: number } | null
  focusedAnnotation: string | null
  /** A pending "Ask the agent about this" right-click menu on a surface (screen px sx,sy + the point). */
  annotationMenu: { surfaceId: string; xPct: number; yPct: number; sx: number; sy: number } | null
  dragTarget: string | null
  snapPreview: { x: number; y: number; w: number; h: number } | null
  editingId: string | null // surface the user is actively editing — its live content survives a reconcile (#47)
  absorbing: string[]
  grabMode: boolean
  /** The live OS accent (hex), picked by the theme widget/agent. Folded into the props posted to
   *  srcdoc widgets that carry no own accent, so plain + future widgets follow the OS theme. */
  osAccent: string | null
  setOsAccent: (hex: string) => void
  /** Legacy compatibility flag for older lock UI/state. Gesture routing is cursor-aware now: surface
   *  content keeps its own gestures and empty canvas gestures move the camera. */
  locked: boolean
  /** A web surface whose active page is in HTML5 fullscreen (video requestFullscreen / YouTube button /
   *  agent `f`), or null. The geometry pass raises that view to fill the window and culls the rest; the
   *  renderer hides all chrome + forces mouse passthrough so the video's controls and Esc work. */
  pageFullscreenId: string | null
  setPageFullscreen: (id: string | null) => void

  setViewport: (w: number, h: number) => void
  /** Home tiles (slot lattice): commit a tile to a cell / pop it off / flow the file layer. */
  placeSurfaceSlot: (id: string, col: number, row: number, size?: string) => void
  clearSurfaceSlot: (id: string) => void
  parkFolderOffstage: (id: string) => void
  /** ⊞/⤢ + ⌃⌥Return: snap the window into the nearest free span / pop the tile out (preSnap restore). */
  toggleSurfaceSlot: (id: string) => void
  /** ⌃⌥=/−: cycle a tile through SIZE_ORDER, anchored at its cell when the new span fits, else nearest free. */
  cycleSurfaceSlotSize: (id: string, dir: 1 | -1) => void
  reflowFiles: (avoid?: { x: number; y: number; w: number; h: number } | null) => void
  setMode: (m: 'desktop' | 'canvas') => void
  setTransform: (t: CanvasTransform) => void
  /** Timestamp of the last BULK layout transaction (rides the os:state push so perception treats it as
   *  one gesture). Single-canvas model has no bulk transaction left, so this stays 0 (vestigial; kept so
   *  the os:state push compiles — removing it is part of the deferred mode/field cleanup). */
  lastBulkAt: number
  panBy: (dx: number, dy: number) => void
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  goToPrimary: () => void
  /** Single-⇧ from the LOCKED home screen: pull back 50% (anchored on home's screen center) and unfreeze,
   *  so the user can survey the surrounding canvas. One-shot; after this, ⇧ is the normal freeze toggle. */
  zoomOutFromHome: () => void
  focusAndZoom: (id: string) => void
  /** Mission-Control "splay": frame ALL free-form windows (not slotted widgets) by zooming the
   *  camera out just enough to show them all, no more. A pure camera move (reversible by pan/zoom). */
  splayWindows: () => void
  setSelection: (ids: string[]) => void
  clearSelection: () => void
  groupSelection: () => void
  group: (ids: string[], name?: string, x?: number, y?: number, folderId?: string) => string
  ungroupOne: (memberId: string, pos?: { x: number; y: number }) => void
  setDragTarget: (id: string | null) => void
  setSnapPreview: (r: { x: number; y: number; w: number; h: number } | null) => void
  setEditingId: (id: string | null) => void
  addToFolder: (folderId: string, ids: string[]) => void
  dropIntoFolder: (folderId: string, ids: string[]) => void
  setGrabMode: (on: boolean) => void
  toggleLock: () => void

  createSurface: (input: CreateSurfaceInput) => string
  // Adopt a persisted workspace (restore surfaces from disk). Single-canvas model: the boot camera is
  // always the computed home frame, so the legacy camera/mode + the two trailing legacy region args are
  // accepted (the host still passes them positionally) but ignored.
  hydrate: (surfaces: Surface[], camera?: CanvasTransform, mode?: 'desktop' | 'canvas', legacyA?: number, legacyB?: number[]) => void
  applyReconcile: (surfaces: Surface[]) => void
  moveSurface: (id: string, x: number, y: number) => void
  removeSurfacesFromCanvas: (ids: string[]) => void
  closeSurface: (id: string) => void
  focusSurface: (id: string) => void
  clearActiveSurface: () => void
  setZoom: (id: string, zoom: number) => void
  toggleMaximize: (id: string) => void
  minimizeSurface: (id: string) => void
  updateSurface: (id: string, patch: Partial<Surface>) => void
  updateSurfaceProps: (id: string, props: Record<string, unknown>) => void
  addTab: (id: string, tab: SurfaceTab) => void
  setActiveTab: (id: string, index: number) => void
  closeTab: (id: string, tabId: string) => void
  // Browser (web) tabs: a page per tab, one main-owned WebContentsView each. addWebTab materializes
  // the implicit single tab first (a plain {url} web surface IS one tab); applyWebTab ingests main's
  // per-tab page-state pushes (url/title/favicon/loading/canGoBack/canGoForward, tab death, popups).
  addWebTab: (id: string, url?: string) => void
  applyWebTab: (m: { surfaceId: string; tabId?: string; patch?: Partial<SurfaceTab>; removed?: boolean; openTab?: { url: string } }) => void
  // Machine-global browser bookmarks (root journal via main).
  bookmarks: Bookmark[]
  loadBookmarks: () => void
  toggleBookmark: (url: string, title: string) => void
  // Open (or focus) a terminal tab: activate it if it's already a tab, else add it to the
  // existing terminal window, else open the first terminal window. The one shared seam for the live
  // terminal-spawn action, resume-on-load, and the Runtime tray's "Open" — so a terminal is in one tab.
  openTerminal: (terminalId: string, title: string, stage?: number | null) => void
  // Prune any terminal window left with zero tabs (would render blank).
  pruneEmptyTerminals: () => void
  // Close a non-primary agent (stop it + remove its widget/files/stage, via the host) and drop
  // its chat surface + terminal tab locally. Rename updates the title live. Both no-op on the primary '0'.
  closeAgent: (agentId: string) => void
  renameAgent: (agentId: string, newTitle: string) => void
  // Layout undo: the agent auto-applies layouts; the human reverts with Cmd+Z.
  snapshotLayout: () => void
  undoLayout: () => void
  // Annotations (item 5b): start a draft at a point on a surface, commit it (with the human's text),
  // cancel, focus one (recall from a chat reference), or remove it.
  startAnnotation: (surfaceId: string, xPct: number, yPct: number) => void
  cancelAnnotation: () => void
  commitAnnotation: (text: string) => Annotation | null
  focusAnnotation: (id: string | null) => void
  recallAnnotation: (ref: Annotation) => void
  removeAnnotation: (id: string) => void
  openAnnotationMenu: (surfaceId: string, xPct: number, yPct: number, sx: number, sy: number) => void
  closeAnnotationMenu: () => void
}

function defaultSize(kind: SurfaceKind): { w: number; h: number } {
  if (kind === 'native') return { w: 240, h: 240 }
  if (kind === 'srcdoc') return { w: 420, h: 320 }
  return { w: 920, h: 640 } // web, app
}

export const useDesktop = create<DesktopState>((set, get) => ({
  transform: { x: 0, y: 0, scale: 1 },
  viewport: { w: window.innerWidth, h: window.innerHeight },
  mode: 'desktop',
  lastBulkAt: 0,
  surfaces: [],
  activeSurfaceId: null,
  layoutHistory: [],
  selection: [],
  annotations: [],
  annotationDraft: null,
  focusedAnnotation: null,
  annotationMenu: null,
  dragTarget: null,
  snapPreview: null,
  editingId: null,
  absorbing: [],
  grabMode: false,
  osAccent: null,
  // Boot LOCKED = work mode: the desktop is interactive at rest (click widgets, marquee on the
  // background), the camera frozen at the home frame. Single-tap ⇧ unlocks (the FREEZE gate) for
  // pan/zoom; the lock, not a mode, is the interact gate (plans/blitzos-single-canvas-navigation.md).
  locked: true,
  pageFullscreenId: null,

  setViewport: (w, h) =>
    set((s) => {
      // Slotted tiles are lattice-derived: a viewport change moves the lattice, so re-derive every
      // tile's x/y/w/h from its cell (Apple stores layouts per resolution; we re-anchor — same effect,
      // no reflow: cells never change, only the lattice origin shifts).
      const vp = { w, h }
      const lat = latticeFor(vp)
      let changed = false
      const surfaces = s.surfaces.map((sf) => {
        const sl = slotOf(sf)
        if (!sl) return sf
        const r = cardRect(lat, sl.col, sl.row, sl.size)
        if (r.x === sf.x && r.y === sf.y && r.w === sf.w && r.h === sf.h) return sf
        changed = true
        return { ...sf, x: r.x, y: r.y, w: r.w, h: r.h }
      })
      return changed ? { viewport: vp, surfaces } : { viewport: vp }
    }),

  /** Snap a tile to a home-lattice cell (drag drop / bar toggle / place_widget update). Geometry
   *  derives from the cell; never reflows neighbors — the placer only ever offers free spans, this just
   *  commits one. First snap remembers the free-form size in preSnap so popping out restores it
   *  (a slot size that squishes a widget must never be a one-way door). */
  placeSurfaceSlot: (id, col, row, size) =>
    set((s) => {
      const cur = s.surfaces.find((x) => x.id === id)
      if (!cur) return {}
      const sz = size || slotOf(cur)?.size || sizeForDims(cur.w, cur.h)
      const r = cardRect(latticeFor(s.viewport), col, row, sz)
      const keepFree = cur.slot ? cur.preSnap : { w: cur.w, h: cur.h }
      return {
        surfaces: s.surfaces.map((x) => (x.id === id ? { ...x, slot: { col, row, size: sz }, x: r.x, y: r.y, w: r.w, h: r.h, focus: undefined, ...(keepFree ? { preSnap: keepFree } : {}) } : x))
      }
    }),

  /** Pop a tile OFF the lattice (bar toggle / ⌘-drag escape hatch): free-form again, restoring its
   *  pre-slot size centered where the tile sat (clamped into home so it never lands off-screen). */
  clearSurfaceSlot: (id) =>
    set((s) => {
      const cur = s.surfaces.find((x) => x.id === id)
      if (!cur) return {}
      const free = cur.preSnap ?? { w: cur.w, h: cur.h }
      const cx = cur.x + cur.w / 2
      const cy = cur.y + cur.h / 2
      const p = desktopClamp(cx - free.w / 2, cy - free.h / 2, free.w, free.h, s.viewport)
      return {
        surfaces: s.surfaces.map((x) => (x.id === id ? { ...x, slot: undefined, preSnap: undefined, x: p.x, y: p.y, w: free.w, h: free.h } : x))
      }
    }),

  parkFolderOffstage: (id) => {
    get().snapshotLayout()
    set((s) => {
      const cur = s.surfaces.find((x) => x.id === id && x.kind === 'native' && x.component === 'dir')
      if (!cur) return {}
      const home = homeRect(s.viewport)
      const free = cur.preSnap ?? { w: cur.w, h: cur.h }
      const parked = s.surfaces.filter((x) => x.id !== id && x.kind === 'native' && x.component === 'dir' && !x.slot && x.y >= home.y + home.h)
      const idx = parked.length
      const x = Math.round(home.x + 40 + (idx % 6) * Math.min(free.w + 24, 220))
      const y = Math.round(home.y + home.h + 48 + Math.floor(idx / 6) * (free.h + 28))
      // Folder context-menu "Move off screen" keeps the real directory and its workspace node, clears
      // any slot, and parks the icon below home so reconcile cannot resurrect a duplicate.
      return {
        surfaces: s.surfaces.map((item) =>
          item.id === id
            ? { ...item, x, y, w: free.w, h: free.h, slot: undefined, preSnap: undefined, restore: undefined }
            : item
        ),
        selection: s.selection.filter((xid) => xid !== id),
        activeSurfaceId: s.activeSurfaceId === id ? null : s.activeSurfaceId
      }
    })
  },

  toggleSurfaceSlot: (id) => {
    const st = get()
    const cur = st.surfaces.find((x) => x.id === id)
    if (!cur || (cur.kind === 'native' && (cur.component === 'file' || cur.component === 'dir' || cur.component === 'folder'))) return
    if (slotOf(cur)) {
      st.clearSurfaceSlot(id)
    } else {
      // A crowded home must not make ⌘T a silent no-op: when the window's natural span has no
      // free cells, fall back through smaller spans until one fits (truly full → nothing happens,
      // matching the placer's contract that tiles never overlap).
      const start = SIZE_ORDER.indexOf(sizeForDims(cur.w, cur.h))
      for (let i = start; i >= 0; i--) {
        const size = SIZE_ORDER[i]
        const slot = nearestFreeSlot(st.surfaces, latticeFor(st.viewport), size, cur.x + cur.w / 2, cur.y + cur.h / 2, id)
        if (slot) {
          st.placeSurfaceSlot(id, slot.col, slot.row, size)
          break
        }
      }
    }
    st.reflowFiles()
  },

  cycleSurfaceSlotSize: (id, dir) => {
    const st = get()
    const cur = st.surfaces.find((x) => x.id === id)
    const sl = cur && slotOf(cur)
    if (cur && !sl) {
      // cycling a FREE window: first press snaps it into the grid (then further presses cycle) —
      // a no-op here read as "the keybind is broken".
      st.toggleSurfaceSlot(id)
      return
    }
    if (!cur || !sl) return
    const lat = latticeFor(st.viewport)
    const occ = occupancy(st.surfaces, id)
    const idx = SIZE_ORDER.indexOf(sl.size)
    const n = SIZE_ORDER.length
    // walk the cycle, SKIPPING sizes with no free span anywhere (a crowded home must not turn the
    // keybind into a silent no-op — blocked size -> land on whatever fits next).
    for (let step = 1; step < n; step++) {
      const next = SIZE_ORDER[(idx + (dir > 0 ? step : n - step)) % n]
      const sp = spanOf(next)
      // stay anchored at the tile's own cell when the new span fits there (self excluded) …
      let col = sl.col
      let row = sl.row
      let fits = col + sp.c <= lat.cols && row + sp.r <= lat.rows
      if (fits) {
        for (let c = col; c < col + sp.c && fits; c++) for (let r = row; r < row + sp.r && fits; r++) if (occ.has(c + ',' + r)) fits = false
      }
      // … else the nearest free span to its center — never overlap, never reflow neighbors.
      if (!fits) {
        const ns = nearestFreeSlot(st.surfaces, lat, next, cur.x + cur.w / 2, cur.y + cur.h / 2, id)
        if (!ns) continue // this size fits nowhere — skip to the next one
        col = ns.col
        row = ns.row
      }
      st.placeSurfaceSlot(id, col, row, next)
      st.reflowFiles()
      return
    }
  },

  /** The fluid file layer: flow file/dir tiles around the slotted widgets on home (macOS desktop-icon
   *  feel). `avoid` = the in-flight drag ghost's rect so files part around it live. */
  reflowFiles: (avoid) =>
    set((s) => {
      const isFile = (x: Surface): boolean => x.kind === 'native' && (x.component === 'file' || x.component === 'dir') && !x.groupId && !x.minimized
      const files = s.surfaces.filter(isFile)
      if (!files.length) return {}
      const placed = flowFiles(files, s.surfaces, s.viewport, avoid ?? null)
      const pos = new Map(placed.map((p) => [p.id, p]))
      let changed = false
      const surfaces = s.surfaces.map((x) => {
        const p = pos.get(x.id)
        if (!p || (p.x === x.x && p.y === x.y)) return x
        changed = true
        return { ...x, x: p.x, y: p.y }
      })
      return changed ? { surfaces } : {}
    }),
  setMode: (m) => set({ mode: m }),
  setTransform: (t) => set({ transform: t }),

  setSelection: (ids) => set({ selection: ids }),
  clearSelection: () => set({ selection: [] }),

  // Pack surfaces into an iPhone-style folder. Two callers share this:
  //  - groupSelection (Cmd+G): the human's multi-selection, centroid, default name.
  //  - the agent's `group` tool: explicit ids, a chosen name, an optional top-left
  //    position (x,y), and a main-minted folderId. Returns the folder id ('' if < 2 valid).
  group: (ids, name, x, y, folderId) => {
    const cur = get()
    const valid = ids.filter((id) => {
      const w = cur.surfaces.find((s) => s.id === id)
      return !!w && !w.groupId && w.component !== 'folder'
    })
    if (valid.length < 2) return ''
    cur.snapshotLayout()
    const members = cur.surfaces.filter((w) => valid.includes(w.id))
    const W = 232
    const H = 248
    const fx = x != null ? Math.round(x) : Math.round(members.reduce((a, m) => a + m.x + m.w / 2, 0) / members.length - W / 2)
    const fy = y != null ? Math.round(y) : Math.round(members.reduce((a, m) => a + m.y + m.h / 2, 0) / members.length - H / 2)
    const fid = folderId ?? `folder-${++zCounter}`
    const folder: Surface = {
      id: fid,
      kind: 'native',
      component: 'folder',
      x: fx,
      y: fy,
      w: W,
      h: H,
      z: ++zCounter,
      title: name && name.trim() ? name.trim() : 'Folder',
      props: { members: valid, open: false }
    }
    set((st) => ({
      surfaces: [...st.surfaces.map((w) => (valid.includes(w.id) ? { ...w, groupId: fid } : w)), folder],
      selection: []
    }))
    return fid
  },

  // Cmd+G: pack the current multi-selection into an iPhone-style folder at their centroid.
  groupSelection: () => {
    get().group(get().selection)
  },

  // Pop one surface out of its folder back onto the canvas (cleaning up an emptied folder).
  ungroupOne: (memberId, pos) =>
    set((st) => {
      const m = st.surfaces.find((w) => w.id === memberId)
      if (!m || !m.groupId) return {}
      const folderId = m.groupId
      let surfaces = st.surfaces.map((w) =>
        w.id === memberId ? { ...w, groupId: undefined, peek: false, z: ++zCounter, ...(pos ? { x: pos.x, y: pos.y } : {}) } : w
      )
      surfaces = surfaces.map((w) =>
        w.id === folderId
          ? { ...w, props: { ...w.props, members: ((w.props?.members as string[]) ?? []).filter((id) => id !== memberId) } }
          : w
      )
      const folder = surfaces.find((w) => w.id === folderId)
      if (folder && ((folder.props?.members as string[]) ?? []).length === 0) {
        surfaces = surfaces.filter((w) => w.id !== folderId)
      }
      return { surfaces }
    }),

  setDragTarget: (id) => set({ dragTarget: id }),
  setSnapPreview: (r) => set({ snapPreview: r }),
  setEditingId: (id) => set({ editingId: id }),
  setGrabMode: (on) => set({ grabMode: on }),
  setOsAccent: (hex) => set({ osAccent: hex }),
  toggleLock: () => set((s) => ({ locked: !s.locked })),

  // Add surfaces to an existing folder (drag-onto-folder). Skips folders; re-adding a
  // currently-peeked member just clears its peek so it hides back inside.
  addToFolder: (folderId, ids) =>
    set((st) => {
      const folder = st.surfaces.find((w) => w.id === folderId && w.component === 'folder')
      if (!folder) return {}
      const targets = ids.filter((id) => {
        const w = st.surfaces.find((s) => s.id === id)
        return !!w && w.id !== folderId && w.component !== 'folder'
      })
      if (!targets.length) return {}
      const existing = (folder.props?.members as string[]) ?? []
      const members = [...existing, ...targets.filter((id) => !existing.includes(id))]
      return {
        surfaces: st.surfaces.map((w) => {
          if (targets.includes(w.id)) return { ...w, groupId: folderId, peek: false }
          if (w.id === folderId) return { ...w, props: { ...w.props, members } }
          return w
        }),
        selection: []
      }
    }),

  // Drop a selection onto a folder: brief "absorb" animation, then commit membership.
  dropIntoFolder: (folderId, ids) => {
    set({ absorbing: ids })
    setTimeout(() => {
      get().addToFolder(folderId, ids)
      set({ absorbing: [], dragTarget: null })
    }, 220)
  },

  // The FREEZE gate is the single navigation rail (plans/blitzos-single-canvas-navigation.md): a
  // frozen desktop (locked) ignores empty-canvas pans entirely — the static home screen — while a
  // single-⇧ UNFREEZE (locked=false) pans the infinite canvas freely with no clamp.
  panBy: (dx, dy) =>
    set((s) => {
      if (s.locked) return {}
      return { transform: { ...s.transform, x: s.transform.x + dx, y: s.transform.y + dy } }
    }),

  zoomAt: (cursorX, cursorY, deltaY) =>
    set((s) => {
      // FREEZE gate (plans/blitzos-single-canvas-navigation.md): a frozen desktop (locked) is fully
      // static — empty-canvas zoom is a no-op too, not just pan, so the home screen never drifts. A
      // single-⇧ UNFREEZE (locked=false) = cursor-anchored zoom into ANY point, wide infinite-canvas
      // range, no clamp.
      if (s.locked) return {}
      const { x: tx, y: ty, scale } = s.transform
      const factor = Math.exp(-deltaY * 0.006)
      const wx = (cursorX - tx) / scale
      const wy = (cursorY - ty) / scale
      const newScale = clamp(scale * factor, 0.2, 3)
      return { transform: { scale: newScale, x: cursorX - wx * newScale, y: cursorY - wy * newScale } }
    }),

  // Fly to home: the computed scale-1 home frame (go_to_primary / double-Shift).
  goToPrimary: () => set((s) => ({ transform: homeTransform(s.viewport) })),

  // One-shot survey zoom (plans/blitzos-single-canvas-navigation.md): a single ⇧ from the locked home
  // screen pulls the camera straight back 50%, anchored on home's on-screen center (homeTransform's
  // cx,cy) so home shrinks in place, and UNFREEZES so the canvas can be panned. The 0.2 floor mirrors
  // zoomAt's wide-canvas minimum. Subsequent ⇧ taps are the plain freeze toggle.
  zoomOutFromHome: () =>
    set((s) => {
      const { x: tx, y: ty, scale } = s.transform
      const r = homeRect(s.viewport)
      const cx = SIDEBAR + r.w / 2
      const cy = TITLEBAR + r.h / 2
      const wx = (cx - tx) / scale
      const wy = (cy - ty) / scale
      const newScale = clamp(scale * 0.5, 0.2, 3)
      return { locked: false, transform: { scale: newScale, x: cx - wx * newScale, y: cy - wy * newScale } }
    }),

  // Bring a surface to the front: raise z + clamp it back inside home.
  focusAndZoom: (id) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      const p = desktopClamp(surf.x, surf.y, surf.w, surf.h, s.viewport)
      return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y, z: ++zCounter, focus: true } : w.focus ? { ...w, focus: false } : w)), activeSurfaceId: id }
    }),

  // "Splay out" (macOS Mission Control intent): show me ALL my free-form windows at once. Frees the
  // user from hunting a window they panned away from. We zoom the camera to fit the bounding box of
  // every FREE window (anything floating: web/app/srcdoc/note that is NOT a slotted home tile, NOT a
  // pinned chat/activity panel, NOT a file/folder desktop tile, NOT minimized/foldered). "Zoomed out
  // just enough but not more": scale = fit-to-bbox, capped at 1 so we never zoom IN past natural size.
  splayWindows: () =>
    set((s) => {
      const free = s.surfaces.filter(
        (w) =>
          !slotOf(w) &&
          !w.minimized &&
          !w.groupId &&
          w.role !== 'chat' &&
          w.role !== 'activity' &&
          !(w.kind === 'native' && (w.component === 'chat' || w.component === 'activity' || w.component === 'file' || w.component === 'dir' || w.component === 'folder' || w.component === 'terminal' || w.component === 'sessions' || w.component === 'inbox' || w.component === 'unlock'))
      )
      if (!free.length) return {}
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const w of free) {
        minX = Math.min(minX, w.x)
        minY = Math.min(minY, w.y)
        maxX = Math.max(maxX, w.x + w.w)
        maxY = Math.max(maxY, w.y + w.h)
      }
      const pad = 80 // breathing room around the splay (matches Mission Control's screen margin feel)
      const bw = maxX - minX
      const bh = maxY - minY
      const fit = Math.min((s.viewport.w - 2 * pad) / Math.max(bw, 1), (s.viewport.h - 2 * pad) / Math.max(bh, 1))
      const scale = clamp(Math.min(1, fit), 0.1, 1) // never zoom IN past 1 ("just enough, not more")
      const cx = minX + bw / 2
      const cy = minY + bh / 2
      const transform = { scale, x: s.viewport.w / 2 - cx * scale, y: s.viewport.h / 2 - cy * scale }
      return { transform }
    }),

  createSurface: (input) => {
    get().snapshotLayout()
    // Stable, unique id (Phase 0 of the workspaces design): survives serialization +
    // restart, so layout/consent can key off it. zCounter is now ONLY the surface
    // z-order allocator, never identity. (UUIDv4 here; ULID is a deferred sortable swap.)
    const id = input.id ?? crypto.randomUUID()
    const size = defaultSize(input.kind)
    const w = input.w ?? size.w
    const h = input.h ?? size.h
    const st = get()
    // cascade if no explicit position (macOS-style stagger), centered on home (single-canvas model:
    // there is one bounded region). The legacy `input.stage` hint is ignored — x/y is the
    // truth (plans/blitzos-single-canvas-navigation.md).
    const n = st.surfaces.length % 7
    const tr = homeRect(st.viewport)
    const ax = tr.x + tr.w / 2
    const ay = tr.y + tr.h / 2
    let x = input.x ?? ax - w / 2 + n * 34 - 100
    let y = input.y ?? ay - h / 2 + n * 30 - 70
    // The default cascade is clamped into the home frame so a no-position create stays on-screen; an
    // explicit FREE position (the human's cursor on the open canvas) is trusted as-is, even off-home.
    if (!input.free) {
      const p = desktopClamp(x, y, w, h, st.viewport)
      x = p.x
      y = p.y
    }
    const surface: Surface = {
      id,
      kind: input.kind,
      x,
      y,
      w,
      h,
      z: ++zCounter,
      title: input.title ?? input.url ?? input.component ?? input.kind,
      url: input.url,
      html: input.html,
      ...(input.lang && input.lang !== 'html' ? { lang: input.lang } : {}),
      component: input.component,
      props: input.props ?? {},
      shared: input.shared,
      // preserve system-surface fields so a broadcast 'create' (e.g. a new agent) keeps its
      // role/pinned/agentId — without these a created chat widget would lose role:'chat' and not render.
      ...(input.role ? { role: input.role } : {}),
      ...(input.pinned ? { pinned: input.pinned } : {}),
      ...(input.agentId != null ? { agentId: String(input.agentId) } : {}),
      ...(input.tabs ? { tabs: input.tabs, activeTab: input.activeTab ?? 0 } : {}),
      ...(input.focus ? { focus: true } : {})
    }
    // Born slotted: the tile's geometry is DERIVED from its home-lattice cell (stage-core), never the
    // cascade — so a place_widget create lands exactly on its slot, immune to clamp/stagger drift.
    if (input.slot && typeof input.slot === 'object') {
      const lat = latticeFor(st.viewport)
      const r = cardRect(lat, Number(input.slot.col) || 0, Number(input.slot.row) || 0, String(input.slot.size || 's'))
      surface.slot = { col: Number(input.slot.col) || 0, row: Number(input.slot.row) || 0, size: String(input.slot.size || 's') }
      surface.x = r.x
      surface.y = r.y
      surface.w = r.w
      surface.h = r.h
    }
    // A surface born focused becomes the single frontmost window — clear the flag on whoever held it.
    set((s) => ({
      surfaces: input.focus
        ? [...s.surfaces.map((w) => (w.focus ? { ...w, focus: false } : w)), surface]
        : [...s.surfaces, surface],
      activeSurfaceId: id
    }))
    return id
  },

  // Legacy `mode` + the two trailing region args are accepted (the host still passes them) but ignored —
  // single-canvas model has one home region and no saved camera (plans/blitzos-single-canvas-navigation.md).
  hydrate: (surfaces, _camera, _mode, _legacyA, _legacyB) =>
    set((s) => {
      // Normalize incoming descriptors to full Surface objects (defaults for anything the
      // persisted node didn't carry), and lift the z-allocator above the restored max so
      // surfaces created after a restore land on top. The boot camera is always the computed home
      // frame, never a saved one (the persisted-camera restore path was canvas-mode only and is gone).
      const restored: Surface[] = surfaces.map((w) => {
        const base = { zoom: 1, props: {}, ...w, z: w.z ?? ++zCounter } as Surface
        // A slotted tile's geometry derives from its home-lattice cell at THIS renderer's real viewport
        // (the persisted x/y may come from a different window size) — slots beat the legacy paths.
        const sl = slotOf(base)
        if (sl) {
          const r = cardRect(latticeFor(s.viewport), sl.col, sl.row, sl.size)
          return { ...base, x: r.x, y: r.y, w: r.w, h: r.h }
        }
        // Runtime chat/activity panels persist absolute x/y; clamp them back inside home at the
        // renderer's REAL viewport (the host may have guessed a default vp). A legacy per-agent chat
        // simply keeps its persisted x/y, then clamps — there is no per-agent stage anymore.
        if (isRuntimePanel(base)) {
          const p = desktopClamp(base.x, base.y, base.w, base.h, s.viewport)
          return { ...base, x: p.x, y: p.y }
        }
        return base
      })
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      // Always boot to the home frame; ad-hoc pinch zoom is live navigation, not persisted layout.
      return { surfaces: restored, activeSurfaceId: null, transform: homeTransform(s.viewport), mode: 'desktop', layoutHistory: [] }
    }),

  // Apply an external folder reconcile (dropped/edited/removed files) to a LIVE canvas WITHOUT
  // resetting the camera or clobbering the runtime chat/activity panels (newer here than the
  // backend's osState). Replaces only the file-backed surfaces with the reconciled set.
  applyReconcile: (incoming) =>
    set((s) => {
      // Runtime-only surfaces NOT backed by a workspace file (nodeKind returns null for them), so they're
      // never in the reconciled `incoming` set — keep the LIVE ones or a reconcile would wipe them. Covers
      // the chat/activity panels, in-memory folders, AND the runtime surfaces (terminal windows + the
      // Runtime tray), which are reconstructed from live terminals, never persisted as nodes.
      const isRuntime = (w: Surface): boolean =>
        w.role === 'chat' ||
        w.role === 'activity' ||
        (w.kind === 'native' && (w.component === 'chat' || w.component === 'activity' || w.component === 'folder' || w.component === 'files' || w.component === 'terminal' || w.component === 'runtime' || w.component === 'inbox' || w.component === 'unlock'))
      const keepRuntime = s.surfaces.filter(isRuntime)
      const localById = new Map(s.surfaces.map((w) => [w.id, w]))
      // A reconcile's `incoming` can echo back runtime-only surfaces (the host keeps un-persisted state
      // like an open terminal/runtime/folder). Those are preserved via keepRuntime from the LIVE store,
      // so they must be EXCLUDED from fileBacked here — otherwise the surface lands in `restored` twice
      // (once from incoming, once from keepRuntime), a duplicate React key. Worse, the duplicate is then
      // pushed back, re-echoed, and re-doubled on the next reconcile — an exponential blow-up that floods
      // the canvas and hangs the main thread. Filtering on the SAME isRuntime keeps them single-sourced.
      const fileBacked = incoming
        .filter((w) => !isRuntime(w))
        .map((w) => {
          const live = localById.get(w.id)
          // Brand-new surface (a just-dropped file, a folder the agent created): take its disk content,
          // but ALWAYS mint a fresh top z (the backend's z is a small dense stack-index that would bury
          // the new tile behind existing windows). ++zCounter keeps it monotonic and on top.
          if (!live) return { zoom: 1, props: {}, ...w, z: ++zCounter } as Surface
          // Actively-edited surface (the user is focused in its textarea): adopt disk content EXCEPT the
          // in-progress text, so an agent edit to a focused-but-untyped note still lands while unsaved
          // keystrokes aren't clobbered. (Last-writer on `text` is unavoidable without dirty-tracking.)
          if (w.id === s.editingId) {
            return {
              ...live,
              kind: w.kind,
              component: w.component,
              title: w.title,
              url: w.url,
              html: w.html,
              props: { ...live.props, ...(w.props ?? {}), text: live.props?.text }
            } as Surface
          }
          // Existing surface → KEEP the live geometry + interaction state (x/y/w/h/z/restore/minimized/
          // peek/groupId/preSnap). A reconcile reflects *content* changes on disk; it must never revert a
          // window the user (or agent) just moved/resized/focused — that was the "reverts to original
          // position" + drag/focus "previous-state" jerk. Adopt only the disk content fields.
          return {
            ...live,
            kind: w.kind,
            component: w.component,
            title: w.title,
            // For web/app the LIVE browser location is authoritative (the user/agent may have navigated
            // it); never let a lagging disk .weblink snap it back — the "typing on Google → back to HN"
            // race, when a reconcile fires before the new url is persisted.
            url: w.kind === 'web' || w.kind === 'app' ? (live.url ?? w.url) : w.url,
            html: w.html,
            props: { ...live.props, ...(w.props ?? {}) }
          } as Surface
        })
      const restored = [...fileBacked, ...keepRuntime]
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      return {
        surfaces: restored,
        activeSurfaceId: restored.some((w) => w.id === s.activeSurfaceId && !w.minimized) ? s.activeSurfaceId : null,
        // A fullscreen surface that vanished (closed/reconciled away) must release fullscreen, or the
        // chrome stays hidden with no page behind it (the main-side host fires leave too, this is the net).
        pageFullscreenId: s.pageFullscreenId && restored.some((w) => w.id === s.pageFullscreenId) ? s.pageFullscreenId : null
      }
    }),

  setPageFullscreen: (id) => set({ pageFullscreenId: id }),

  moveSurface: (id, x, y) => {
    get().snapshotLayout()
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      // At the home frame, keep the safety rail: the title bar can't slide above home's top edge. Once
      // the human has zoomed/panned the canvas, all sides are reachable, so free drag is truly free.
      const clampTop = sameCamera(s.transform, homeTransform(s.viewport))
      const p = clampTop ? { x, y: Math.max(homeRect(s.viewport).y, y) } : { x, y }
      return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y } : w)) }
    })
  },


  setZoom: (id, zoom) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) => (it.id === id ? { ...it, zoom: clamp(zoom, 0.3, 3) } : it))
    })),

  // ---- tabbed windows (terminal windows hold a terminal per tab) ----
  addTab: (id, tab) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => {
        if (w.id !== id) return w
        const tabs = w.tabs || []
        const at = tabs.findIndex((t) => t.id === tab.id)
        if (at >= 0) return { ...w, activeTab: at } // already a tab — just activate it
        return { ...w, tabs: [...tabs, tab], activeTab: tabs.length, z: ++zCounter }
      })
    })),
  setActiveTab: (id, index) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, activeTab: clamp(index, 0, (w.tabs?.length || 1) - 1) } : w))
    })),
  closeTab: (id, tabId) =>
    set((s) => {
      const w = s.surfaces.find((x) => x.id === id)
      if (!w || !w.tabs) return {}
      const tabs = w.tabs.filter((t) => t.id !== tabId)
      if (!tabs.length) {
        return {
          surfaces: s.surfaces.filter((x) => x.id !== id),
          activeSurfaceId: s.activeSurfaceId === id ? null : s.activeSurfaceId
        } // last tab closed → close the window
      }
      return { surfaces: s.surfaces.map((x) => (x.id === id ? { ...x, tabs, activeTab: clamp(w.activeTab || 0, 0, tabs.length - 1) } : x)) }
    }),

  // ---- browser tabs (web surfaces: one page per tab) ----
  addWebTab: (id, url) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => {
        if (w.id !== id || w.kind !== 'web') return w
        // A plain {url} browser IS one implicit tab — materialize it before appending, so the first
        // explicit tab op turns the legacy shape into a real tab list without losing the open page.
        const tabs = w.tabs?.length ? w.tabs : webTabsOf(w)
        const tab: SurfaceTab = { id: crypto.randomUUID(), title: url ? hostLabel(url) : 'New Tab', ...(url ? { url } : {}) }
        return { ...w, tabs: [...tabs, tab], activeTab: tabs.length, z: ++zCounter }
      })
    })),
  applyWebTab: (m) => {
    const { surfaceId, tabId, patch, removed, openTab } = m
    if (openTab?.url) return get().addWebTab(surfaceId, openTab.url)
    if (!tabId) return
    if (removed) return get().closeTab(surfaceId, tabId)
    if (!patch) return
    set((s) => ({
      surfaces: s.surfaces.map((w) => {
        if (w.id !== surfaceId || w.kind !== 'web') return w
        // Page-state pushes also materialize the implicit tab: once a page actually lives in this
        // window, its tabs are real (persisted as {id,title,url}; runtime fields never hit disk).
        const base = w.tabs?.length ? w.tabs : webTabsOf(w)
        if (!base.some((t) => t.id === tabId)) return w // state for a tab we no longer hold (race with close)
        return { ...w, tabs: base.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }
      })
    }))
  },

  // ---- bookmarks (machine-global, persisted by main in the root journal) ----
  bookmarks: [],
  loadBookmarks: () => {
    void window.agentOS?.bookmarksList?.().then((b) => set({ bookmarks: Array.isArray(b) ? b : [] }))
  },
  toggleBookmark: (url, title) => {
    void window.agentOS?.bookmarksToggle?.(url, title).then((b) => set({ bookmarks: Array.isArray(b) ? b : [] }))
  },
  // The legacy `stage` arg is ignored (single-canvas model: terminals live on home).
  openTerminal: (terminalId, title) => {
    const s = get()
    // Already a tab somewhere? activate it + raise its window (idempotent — no duplicate tab).
    for (const w of s.surfaces) {
      if (w.kind === 'native' && w.component === 'terminal') {
        const idx = (w.tabs || []).findIndex((t) => t.terminalId === terminalId)
        if (idx >= 0) {
          get().setActiveTab(w.id, idx)
          get().focusSurface(w.id)
          return
        }
      }
    }
    // Dock into an existing terminal window if there is one, else open one on home (createSurface
    // cascades it into the home frame).
    const term = s.surfaces.find((w) => w.kind === 'native' && w.component === 'terminal')
    if (term) get().addTab(term.id, { id: terminalId, title, terminalId })
    else get().createSurface({ kind: 'native', component: 'terminal', title: 'Terminal', w: 620, h: 380, tabs: [{ id: terminalId, title, terminalId }], activeTab: 0 })
  },

  // Drop terminal windows left with zero tabs (a removed terminal's leftover shell) — a tab-less terminal
  // window only ever renders as a blank pane, so it should never linger.
  pruneEmptyTerminals: () =>
    set((s) => {
      const next = s.surfaces.filter((w) => !(w.kind === 'native' && w.component === 'terminal' && (w.tabs || []).length === 0))
      return next.length === s.surfaces.length ? {} : { surfaces: next }
    }),

  closeAgent: (agentId) => {
    const id = String(agentId)
    if (id === '0') return // the primary chat is never closed
    // Tell the host to stop the agent + delete the agent's files/stage (it broadcasts a 'close' for the chat
    // widget + an 'agent-remove'). Optimistically drop the chat surface + the agent's terminal TAB locally
    // (the host can't reach a renderer-only tab) so the UI updates instantly.
    void (window.agentOS as unknown as { closeAgent?: (s: string) => Promise<unknown> })?.closeAgent?.(id)
    set((s) => {
      let surfaces = s.surfaces.filter((w) => !(w.role === 'chat' && String(w.agentId ?? '') === id))
      surfaces = surfaces
        .map((w) => {
          if (w.kind !== 'native' || w.component !== 'terminal' || !w.tabs) return w
          const tabs = w.tabs.filter((t) => t.terminalId !== id)
          return tabs.length === w.tabs.length ? w : { ...w, tabs, activeTab: clamp(w.activeTab || 0, 0, Math.max(0, tabs.length - 1)) }
        })
        .filter((w) => !(w.kind === 'native' && w.component === 'terminal' && w.tabs && w.tabs.length === 0)) // drop an emptied terminal window
      return { surfaces }
    })
  },
  renameAgent: (agentId, newTitle) => {
    const id = String(agentId)
    const title = String(newTitle || '').trim()
    if (!title) return
    void (window.agentOS as unknown as { renameAgent?: (s: string, t: string) => Promise<unknown> })?.renameAgent?.(id, title)
    set((s) => ({
      surfaces: s.surfaces.map((w) => {
        if (w.role === 'chat' && String(w.agentId ?? '') === id) return { ...w, title }
        if (w.kind === 'native' && w.component === 'terminal' && w.tabs) return { ...w, tabs: w.tabs.map((t) => (t.terminalId === id ? { ...t, title } : t)) }
        return w
      })
    }))
  },

  toggleMaximize: (id) => {
    get().snapshotLayout()
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      if (surf.restore) {
        const r = surf.restore
        return {
          surfaces: s.surfaces.map((w) =>
            w.id === id ? { ...w, x: r.x, y: r.y, w: r.w, h: r.h, restore: undefined, z: ++zCounter } : w
          ),
          activeSurfaceId: id
        }
      }
      // fill HOME (with a small inset), not the viewport — so 'zoom' means full-screen inside the home
      // region (#35).
      const r = homeRect(s.viewport)
      const inset = 8
      const fill = { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 }
      return {
        surfaces: s.surfaces.map((w) =>
          w.id === id
            ? // a maximized window is no longer "tiled" — drop preSnap so a later drag doesn't pop it
              // to a stale floating size (and clobber `restore`)
              { ...w, restore: { x: w.x, y: w.y, w: w.w, h: w.h }, ...fill, preSnap: undefined, z: ++zCounter }
            : w
        ),
        activeSurfaceId: id
      }
    })
  },

  minimizeSurface: (id) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      activeSurfaceId: s.activeSurfaceId === id ? null : s.activeSurfaceId
    })),

  updateSurface: (id, patch) => {
    // Only a geometry change is "layout"; html/props updates are not undoable via Cmd+Z.
    if (patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined) get().snapshotLayout()
    set((s) => ({
      surfaces: s.surfaces.map((it) => {
        if (it.id !== id) return it
        const next = { ...it, ...patch, props: { ...it.props, ...(patch.props ?? {}) } }
        // A url update on a tabbed browser drives its ACTIVE tab (agent update_surface{url} and the
        // address bar both land here) — the tab's url is what the host navigate effect watches.
        if (patch.url !== undefined && it.kind === 'web' && next.tabs?.length) {
          const at = clamp(next.activeTab || 0, 0, next.tabs.length - 1)
          next.tabs = next.tabs.map((t, i) => (i === at ? { ...t, url: patch.url } : t))
        }
        return next
      }),
      activeSurfaceId: patch.minimized === true && s.activeSurfaceId === id ? null : s.activeSurfaceId
    }))
    // Restore-from-dock of a SLOTTED tile: a minimized tile releases its cells (occupancy skips it),
    // so by the time it comes back its span may be taken — re-place it through the placer (nearest
    // free span), or pop it free-form if nothing fits. Never overlap, never reflow others.
    if (patch.minimized === false) {
      const st = get()
      const cur = st.surfaces.find((x) => x.id === id)
      const sl = cur && slotOf(cur)
      if (cur && sl) {
        const lat = latticeFor(st.viewport)
        const occ = occupancy(st.surfaces, id)
        const sp = spanOf(sl.size)
        let blocked = sl.col + sp.c > lat.cols || sl.row + sp.r > lat.rows
        if (!blocked) {
          for (let c = sl.col; c < sl.col + sp.c && !blocked; c++) for (let r = sl.row; r < sl.row + sp.r && !blocked; r++) if (occ.has(c + ',' + r)) blocked = true
        }
        if (blocked) {
          const ns = nearestFreeSlot(st.surfaces, lat, sl.size, cur.x + cur.w / 2, cur.y + cur.h / 2, id)
          if (ns) st.placeSurfaceSlot(id, ns.col, ns.row, sl.size)
          else st.clearSurfaceSlot(id) // home too full for its size — come back free-form, overlap-free
        }
        st.reflowFiles()
      }
    }
  },

  removeSurfacesFromCanvas: (ids) => {
    const gone = new Set(ids.map(String).filter(Boolean))
    if (!gone.size) return
    set((s) => ({
      surfaces: s.surfaces.filter((w) => !gone.has(w.id)),
      selection: s.selection.filter((id) => !gone.has(id)),
      activeSurfaceId: s.activeSurfaceId && gone.has(s.activeSurfaceId) ? null : s.activeSurfaceId
    }))
  },

  closeSurface: (id) => {
    get().snapshotLayout()
    // Close = delete the backing content file (note/web/srcdoc) so it doesn't pop back up on the next
    // reconcile. Explicit per-id (never inferred from a push), and a no-op for runtime panels / real
    // file tiles (the host skips anything that isn't a BlitzOS content file). Both transports.
    try {
      ;(window.agentOS as { closeSurfaceFile?: (id: string) => void } | undefined)?.closeSurfaceFile?.(id)
    } catch {
      /* best-effort */
    }
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      // Closing a folder disbands it: members pop back onto the canvas where they were.
      const members = surf?.component === 'folder' ? ((surf.props?.members as string[]) ?? []) : []
      return {
        surfaces: s.surfaces
          .filter((w) => w.id !== id)
          .map((w) => (members.includes(w.id) ? { ...w, groupId: undefined } : w)),
        selection: s.selection.filter((x) => x !== id),
        activeSurfaceId: s.activeSurfaceId === id ? null : s.activeSurfaceId
      }
    })
  },

  focusSurface: (id) =>
    set((s) => {
      if (!s.surfaces.some((w) => w.id === id)) return {}
      // The focused surface is the SINGLE frontmost window (effectiveZ's +2.5M top band): raise it,
      // flag it, and clear the flag on whoever held it (only those refs change — others keep identity).
      return {
        surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter, focus: true } : w.focus ? { ...w, focus: false } : w)),
        activeSurfaceId: id
      }
    }),

  clearActiveSurface: () => set({ activeSurfaceId: null }),

  updateSurfaceProps: (id, props) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...props } } : w))
    })),

  // Push the current arrangement onto the undo stack, coalescing a burst of changes (an
  // agent rearrange, a human drag) into ONE entry via a quiet-period boundary. Surfaces
  // are updated immutably, so a snapshot is just the array ref (cheap).
  snapshotLayout: () => {
    const now = Date.now()
    const newTxn = now - lastSnapTs > 600
    lastSnapTs = now
    if (!newTxn) return
    set((s) => {
      const hist = [...s.layoutHistory, s.surfaces]
      if (hist.length > 12) hist.shift()
      return { layoutHistory: hist }
    })
  },

  // Revert to the previous arrangement (Cmd+Z with nothing editable focused). Restores the
  // exact prior surface set + geometry by swapping back the snapshotted array.
  undoLayout: () =>
    set((s) => {
      if (!s.layoutHistory.length) return {}
      const hist = [...s.layoutHistory]
      const prev = hist.pop() as Surface[]
      return { layoutHistory: hist, surfaces: prev }
    }),

  // ---- Annotations (item 5b) ----
  openAnnotationMenu: (surfaceId, xPct, yPct, sx, sy) => set({ annotationMenu: { surfaceId, xPct: clamp(xPct, 0, 1), yPct: clamp(yPct, 0, 1), sx, sy } }),
  closeAnnotationMenu: () => set({ annotationMenu: null }),
  startAnnotation: (surfaceId, xPct, yPct) =>
    set({ annotationDraft: { surfaceId, xPct: clamp(xPct, 0, 1), yPct: clamp(yPct, 0, 1) }, annotationMenu: null, focusedAnnotation: null }),
  cancelAnnotation: () => set({ annotationDraft: null }),
  commitAnnotation: (text) => {
    const d = get().annotationDraft
    const body = String(text || '').trim()
    if (!d || !body) {
      set({ annotationDraft: null })
      return null
    }
    const ann: Annotation = { id: `a_${++annCounter}`, surfaceId: d.surfaceId, xPct: d.xPct, yPct: d.yPct, text: body, ts: Date.now() }
    // After SEND the on-canvas annotation vanishes (focusedAnnotation: null) — the chat message becomes the
    // grounded reference; the bubble re-appears only when the human clicks that message (recallAnnotation).
    set((s) => ({ annotations: [...s.annotations, ann], annotationDraft: null, focusedAnnotation: null }))
    return ann
  },
  focusAnnotation: (id) => set((s) => ({ focusedAnnotation: s.focusedAnnotation === id ? null : id })),
  // Recall from a chat reference: the message carries the full annotation (it survives a reload even though
  // the in-memory list doesn't), so ensure it's in the list, then toggle it open on its surface.
  recallAnnotation: (ref) =>
    set((s) => {
      const exists = s.annotations.some((a) => a.id === ref.id)
      const annotations = exists ? s.annotations : [...s.annotations, ref]
      return { annotations, focusedAnnotation: s.focusedAnnotation === ref.id ? null : ref.id }
    }),
  removeAnnotation: (id) =>
    set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id), focusedAnnotation: s.focusedAnnotation === id ? null : s.focusedAnnotation }))
}))

/** The layered-desktop z bands (one source — SurfaceFrame's stacking style AND the browser
 *  occlusion test use this): tiles/icons at raw z → free windows +500k → pinned chat/activity +2M →
 *  the FOCUSED window +2.5M. Focus is the TOP band so the window the human is actively using (a
 *  dragged/clicked browser) comes ABOVE the otherwise-always-on-top chat; an idle chat still floats
 *  over idle free windows, so it stays visible until you reach for another window. `focus` marks the
 *  SINGLE frontmost surface — focusSurface/focusAndZoom/createSurface keep that invariant (set it on
 *  the target, clear it on every other). (A slotted tile being DRAGGED gets a transient +1.2M lift,
 *  component-local — callers add it where the gesture state lives.) */
export function effectiveZ(s: Surface): number {
  if (s.focus) return 2_500_000 + s.z
  const isPanel = s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity'))
  if (isPanel) return 2_000_000 + s.z
  if (slotOf(s)) return s.z
  if (s.kind === 'native' && (s.component === 'file' || s.component === 'dir' || s.component === 'folder')) return s.z
  return 500_000 + s.z
}

/** A short human label for a url (the tab-title default until the page reports its own). */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** A browser surface's tabs, with the legacy plain-{url} window seen as ONE implicit tab. The
 *  implicit id is constant ('t0', scoped per surface) so the host's declarative view sync is stable
 *  across renders; materializing (addWebTab / first page-state push) keeps that id. */
export function webTabsOf(s: Surface): SurfaceTab[] {
  if (s.tabs?.length) return s.tabs
  return [{ id: 't0', title: s.title || (s.url ? hostLabel(s.url) : 'New Tab'), ...(s.url ? { url: s.url } : {}) }]
}

/** Default name for a UI-spawned terminal — "Terminal N", N counting existing terminal tabs,
 *  so the "+ Terminal" toolbar button and the tab strip's "+" produce distinct, readable tab names
 *  instead of every tab reading "Terminal". (Agent/tool spawns name themselves from the command.) */
export function nextTerminalName(): string {
  const n = useDesktop
    .getState()
    .surfaces.filter((s) => s.kind === 'native' && s.component === 'terminal')
    .reduce((acc, s) => acc + (s.tabs?.length || 0), 0)
  return `Terminal ${n + 1}`
}
