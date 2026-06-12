import { create } from 'zustand'
import {
  CanvasTransform,
  Surface,
  SurfaceTab,
  SurfaceKind,
  Vec2,
  Annotation,
  Bookmark,
  IntegrationStatus,
  GRID,
  WIDGET_W,
  WIDGET_H,
  isRuntimePanel
} from './types'
// The stage-grid geometry (insets, primaryRect, stageStride, stageRect, stageCenterX, stageForAgent) lives
// in the shared stages-core so the renderer and the main-process cores share ONE definition (no divergence).
// Re-exported below so existing `from './store'` importers (capture/App/SurfaceFrame/PrimarySpace) don't churn.
import { primaryRect, stageStride, stageRect, stageCenterX, stageForAgent, stageOfX } from './stages-core.mjs'
export { primaryRect, stageStride, stageRect, stageCenterX, stageForAgent, stageOfX }
// Stage slot lattice (plans/blitzos-stage-slot-desktop.md): pure shared placer — tiles at integer
// cells, geometry derived; the SAME module places in main (place_widget) and snaps drags here.
import { latticeFor, slotRect, cardRect, slotOf, nearestFreeSlot, flowFiles, sizeForDims, occupancy, spanOf, SIZE_ORDER } from './stage-core.mjs'
export { latticeFor, slotRect, cardRect, slotOf, nearestFreeSlot, sizeForDims }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
function snap(v: number): number {
  return Math.round(v / GRID) * GRID
}
function overlaps(a: Vec2, b: Vec2): boolean {
  return a.x < b.x + WIDGET_W && a.x + WIDGET_W > b.x && a.y < b.y + WIDGET_H && a.y + WIDGET_H > b.y
}

// (stage-grid geometry moved to ./stages-core — imported + re-exported above)
// These two insets are still used by the camera anchor below (cx = SIDEBAR + r.w/2, cy = TITLEBAR + r.h/2).
const SIDEBAR = 52
const TITLEBAR = 32
/** Clamp a window so it stays inside its workspace stage (its title bar therefore can't slide under
 *  the top titlebar in normal mode — #29). `stage` defaults to 0, whose rect IS primaryRect, so the
 *  single-stage path is byte-identical to before. */
function desktopClamp(x: number, y: number, w: number, h: number, vp: { w: number; h: number }, stage = 0): Vec2 {
  const r = stage === 0 ? primaryRect(vp) : stageRect(stage, vp)
  return { x: clamp(x, r.x, Math.max(r.x, r.x + r.w - w)), y: clamp(y, r.y, Math.max(r.y, r.y + r.h - h)) }
}
/** Camera per mode. Normal = scale 1 locked to the CURRENT stage (its center maps to a fixed screen
 *  point, so every stage lands in the same on-screen desktop region). Control = a gentle zoom-out: a
 *  single stage uses controlScale (0.7); multiple stages fit the whole tiled row in the same on-screen
 *  span (so n===1 collapses to the single-stage controlScale). */
export function viewTransform(
  mode: 'desktop' | 'canvas',
  vp: { w: number; h: number },
  stage = 0,
  stageCount = 1
): CanvasTransform {
  const r = primaryRect(vp)
  const cx = SIDEBAR + r.w / 2 // screen point of stage 0's center (world origin) — today's anchor
  const cy = TITLEBAR + r.h / 2
  if (mode === 'desktop') {
    // lock to the current stage: put its center at the same (cx,cy) screen anchor. stage 0's center is
    // the world origin, so t = (cx,cy) — byte-identical to today; stage i shifts the camera by i*stride.
    const acx = stage === 0 ? 0 : stage * stageStride(vp)
    return { scale: 1, x: cx - acx, y: cy }
  }
  // CONTROL = a GENTLE zoom-out (controlScale 0.7; was a 0.31 wide bird's-eye, which was too much).
  // Single stage → 0.7. Multiple stages → scale so the union of all stages spans the same screen width
  // one stage did at 0.7, union center kept at the (cx,cy) anchor. Tune controlScale: 1 = no zoom-out.
  const controlScale = 0.7
  if (stageCount <= 1) return { scale: controlScale, x: cx, y: cy }
  const stride = stageStride(vp)
  const unionW = (stageCount - 1) * stride + r.w
  const scale = (controlScale * r.w) / unionW
  const ucx = ((stageCount - 1) * stride) / 2 // world x of the tiled row's center
  return { scale, x: cx - ucx * scale, y: cy }
}
/** While dragging a window, if the CURSOR (world coords) reaches a primary-stage edge, return the
 *  macOS tiling target: left/right half (a side edge) or a quarter (a corner). There is intentionally
 *  NO full-screen / top-half / bottom-half snap — macOS only tiles to halves and quarters, and the
 *  user explicitly does not want a window full-screening on a stray upward drag. Null = free drag.
 *  Mirrors macOS edge-tiling, relative to the PRIMARY AREA (so it works on the infinite canvas). */
export function snapTargetFor(
  wx: number,
  wy: number,
  vp: { w: number; h: number },
  stage = 0,
  mode: 'desktop' | 'canvas' = 'canvas'
): { x: number; y: number; w: number; h: number } | null {
  const r = stage === 0 ? primaryRect(vp) : stageRect(stage, vp)
  const nx = (wx - r.x) / r.w
  const ny = (wy - r.y) / r.h
  if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return null // cursor well outside the stage
  // Edge/corner snap-intent zone per side. CONTROL mode (the zoomed-out bird's-eye, mode==='canvas') keeps
  // a GENEROUS zone for easy arranging; NORMAL mode (mode==='desktop') uses a thin zone so the cursor must
  // nearly TOUCH the stage border to tile — otherwise nudging a window slightly kept firing an unwanted tile.
  const E = mode === 'desktop' ? 0.03 : 0.135
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
  /** the agent this surface belongs to (a per-agent chat widget). */
  agentId?: string
  /** place this surface in a SPECIFIC workspace stage (an agent → its own stage N); when
   *  omitted, it cascades into the current stage. Derived from x afterward — never stored on the Surface. */
  stage?: number
  /** Born slotted: a tile on the stage lattice — x/y/w/h are derived from it, never trusted. */
  slot?: { col: number; row: number; size: string }
  slotStage?: number
  /** Born as the free-form focus floater (human pull-in). */
  focus?: boolean
}

interface DesktopState {
  transform: CanvasTransform
  // The last camera the user had while IN control mode — restored on re-entry so control mode
  // "remembers" where you were panned/zoomed (instead of always snapping back to the default view).
  controlTransform: CanvasTransform | null
  viewport: { w: number; h: number }
  mode: 'desktop' | 'canvas'
  // Workspace stages (#45): bounded desktops tiled left→right. `stageCount` = how many (1 today),
  // `currentStage` = the active one (0 today). A surface's stage is DERIVED from its world x; these two
  // fields drive which stage's rect clamp/snap/maximize/camera operate on. At stageCount===1 everything
  // is byte-identical to the single-stage model.
  stageCount: number
  currentStage: number
  integrations: IntegrationStatus[]
  positions: Record<string, Vec2>
  surfaces: Surface[]
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
  /** View locked (⌘⌘): the infinite canvas is frozen at its current camera — pan/zoom are off
   *  and a background drag becomes marquee-select. Lets you work inside surfaces without the
   *  canvas drifting. Toggled by double-tapping ⌘ (or the toolbar lock button). */
  locked: boolean

  setViewport: (w: number, h: number) => void
  /** Stage tiles (slot lattice): commit a tile to a cell / pop it off / flow the file layer. */
  placeSurfaceSlot: (id: string, col: number, row: number, size?: string, stage?: number) => void
  clearSurfaceSlot: (id: string) => void
  /** ⊞/⤢ + ⌃⌥Return: snap the window into the nearest free span / pop the tile out (preSnap restore). */
  toggleSurfaceSlot: (id: string) => void
  /** ⌃⌥=/−: cycle a tile through SIZE_ORDER, anchored at its cell when the new span fits, else nearest free. */
  cycleSurfaceSlotSize: (id: string, dir: 1 | -1) => void
  reflowFiles: (avoid?: { x: number; y: number; w: number; h: number } | null) => void
  setMode: (m: 'desktop' | 'canvas') => void
  setTransform: (t: CanvasTransform) => void
  setControlTransform: (t: CanvasTransform | null) => void
  setCurrentStage: (i: number) => void
  setStageCount: (n: number) => void
  /** Jump the camera to a workspace stage (set currentStage + retarget the view) — e.g. the Runtime tray's "Stage N". */
  goToStage: (area: number) => void
  addArea: () => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  goToPrimary: () => void
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

  setIntegrations: (list: IntegrationStatus[]) => void
  setPos: (id: string, x: number, y: number) => void
  commitPos: (id: string, prevX: number, prevY: number) => void

  createSurface: (input: CreateSurfaceInput) => string
  // Phase 2: adopt a persisted workspace (restore surfaces + camera + mode + stage count from disk).
  hydrate: (surfaces: Surface[], camera: CanvasTransform, mode: 'desktop' | 'canvas', stageCount?: number) => void
  applyReconcile: (surfaces: Surface[]) => void
  moveSurface: (id: string, x: number, y: number) => void
  closeSurface: (id: string) => void
  focusSurface: (id: string) => void
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
  controlTransform: null,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  mode: 'desktop',
  stageCount: 1,
  currentStage: 0,
  integrations: [],
  positions: {},
  surfaces: [],
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
  // background), the camera frozen at the stage frame. Double-tap ⌘ unlocks for pan/zoom/arrange.
  // (Canvas-first made 'canvas' the permanent mode, so the lock — not the mode — is the interact gate.)
  locked: true,

  setViewport: (w, h) =>
    set((s) => {
      // Slotted tiles are lattice-derived: a viewport change moves the lattice, so re-derive every
      // tile's x/y/w/h from its cell (Apple stores layouts per resolution; we re-anchor — same effect,
      // no reflow: cells never change, only the lattice origin shifts).
      const vp = { w, h }
      const lats = new Map<number, ReturnType<typeof latticeFor>>()
      const latOf = (a: number): ReturnType<typeof latticeFor> => {
        let l = lats.get(a)
        if (!l) {
          l = latticeFor(vp, a)
          lats.set(a, l)
        }
        return l
      }
      let changed = false
      const surfaces = s.surfaces.map((sf) => {
        const sl = slotOf(sf)
        if (!sl) return sf
        const r = cardRect(latOf(sf.slotStage ?? 0), sl.col, sl.row, sl.size)
        if (r.x === sf.x && r.y === sf.y && r.w === sf.w && r.h === sf.h) return sf
        changed = true
        return { ...sf, x: r.x, y: r.y, w: r.w, h: r.h }
      })
      return changed ? { viewport: vp, surfaces } : { viewport: vp }
    }),

  /** Snap a tile to a lattice cell (drag drop / bar toggle / place_widget update). Geometry derives
   *  from the cell; never reflows neighbors — the placer only ever offers free spans, this just
   *  commits one. First snap remembers the free-form size in preSnap so popping out restores it
   *  (a slot size that squishes a widget — the chat — must never be a one-way door). */
  placeSurfaceSlot: (id, col, row, size, stageArg) =>
    set((s) => {
      const cur = s.surfaces.find((x) => x.id === id)
      if (!cur) return {}
      const sz = size || slotOf(cur)?.size || sizeForDims(cur.w, cur.h)
      const stage = Number.isInteger(stageArg) ? (stageArg as number) : (cur.slotStage ?? 0)
      const r = cardRect(latticeFor(s.viewport, stage), col, row, sz)
      const keepFree = cur.slot ? cur.preSnap : { w: cur.w, h: cur.h }
      return {
        surfaces: s.surfaces.map((x) => (x.id === id ? { ...x, slot: { col, row, size: sz }, ...(stage > 0 ? { slotStage: stage } : { slotStage: undefined }), x: r.x, y: r.y, w: r.w, h: r.h, focus: undefined, ...(keepFree ? { preSnap: keepFree } : {}) } : x))
      }
    }),

  /** Pop a tile OFF the lattice (bar toggle / ⌘-drag escape hatch): free-form again, restoring its
   *  pre-slot size centered where the tile sat (clamped into the stage so it never lands off-screen). */
  clearSurfaceSlot: (id) =>
    set((s) => {
      const cur = s.surfaces.find((x) => x.id === id)
      if (!cur) return {}
      const free = cur.preSnap ?? { w: cur.w, h: cur.h }
      const cx = cur.x + cur.w / 2
      const cy = cur.y + cur.h / 2
      const p = desktopClamp(cx - free.w / 2, cy - free.h / 2, free.w, free.h, s.viewport, cur.slotStage ?? 0)
      return {
        surfaces: s.surfaces.map((x) => (x.id === id ? { ...x, slot: undefined, preSnap: undefined, x: p.x, y: p.y, w: free.w, h: free.h } : x))
      }
    }),

  toggleSurfaceSlot: (id) => {
    const st = get()
    const cur = st.surfaces.find((x) => x.id === id)
    if (!cur || (cur.kind === 'native' && (cur.component === 'file' || cur.component === 'dir' || cur.component === 'folder'))) return
    if (slotOf(cur)) {
      st.clearSurfaceSlot(id)
    } else {
      const stage = stageOfX(cur.x + cur.w / 2, st.viewport)
      // A crowded stage must not make ⌘T a silent no-op: when the window's natural span has no
      // free cells, fall back through smaller spans until one fits (truly full → nothing happens,
      // matching the placer's contract that tiles never overlap).
      const start = SIZE_ORDER.indexOf(sizeForDims(cur.w, cur.h))
      for (let i = start; i >= 0; i--) {
        const size = SIZE_ORDER[i]
        const slot = nearestFreeSlot(st.surfaces, latticeFor(st.viewport, stage), size, cur.x + cur.w / 2, cur.y + cur.h / 2, stage, id)
        if (slot) {
          st.placeSurfaceSlot(id, slot.col, slot.row, size, stage)
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
    const stage = cur.slotStage ?? 0
    const lat = latticeFor(st.viewport, stage)
    const occ = occupancy(st.surfaces, stage, id)
    const idx = SIZE_ORDER.indexOf(sl.size)
    const n = SIZE_ORDER.length
    // walk the cycle, SKIPPING sizes with no free span anywhere (a crowded stage must not turn the
    // keybind into a silent no-op — e.g. chat tall -> xl blocked -> land on whatever fits next).
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
        const ns = nearestFreeSlot(st.surfaces, lat, next, cur.x + cur.w / 2, cur.y + cur.h / 2, stage, id)
        if (!ns) continue // this size fits nowhere — skip to the next one
        col = ns.col
        row = ns.row
      }
      st.placeSurfaceSlot(id, col, row, next, stage)
      st.reflowFiles()
      return
    }
  },

  /** The fluid file layer: flow file/dir tiles around the slotted widgets (macOS desktop-icon feel).
   *  `avoid` = the in-flight drag ghost's rect so files part around it live. Stage 0 only (workspace
   *  files are root tiles; agent stages hold windows, not files). */
  reflowFiles: (avoid) =>
    set((s) => {
      const isFile = (x: Surface): boolean => x.kind === 'native' && (x.component === 'file' || x.component === 'dir') && !x.groupId && !x.minimized
      const files = s.surfaces.filter(isFile)
      if (!files.length) return {}
      const placed = flowFiles(files, s.surfaces, s.viewport, 0, avoid ?? null)
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
  setControlTransform: (t) => set({ controlTransform: t }),
  // Pure state mutations (the camera animation on switch is wired by the caller in App.tsx).
  setCurrentStage: (i) => set((s) => ({ currentStage: clamp(Math.round(i), 0, s.stageCount - 1) })),
  setStageCount: (n) => set((s) => ({ stageCount: Math.max(1, Math.round(n)), currentStage: clamp(s.currentStage, 0, Math.max(0, Math.round(n) - 1)) })),
  goToStage: (area) =>
    set((s) => {
      const a = clamp(Math.round(area), 0, s.stageCount - 1)
      return { currentStage: a, transform: viewTransform(s.mode, s.viewport, a, s.stageCount) }
    }),
  addArea: () => set((s) => ({ stageCount: s.stageCount + 1, currentStage: s.stageCount })),

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

  // Every user-driven camera move in CONTROL mode also updates controlTransform, so the remembered
  // bird's-eye position is always a settled value — this is what makes "enter/exit returns to the same
  // position" hold even across a resize, a Center, or a fast toggle (no mid-animation capture needed).
  panBy: (dx, dy) =>
    set((s) => {
      const transform = { ...s.transform, x: s.transform.x + dx, y: s.transform.y + dy }
      return s.mode === 'canvas' ? { transform, controlTransform: transform } : { transform }
    }),

  zoomAt: (cursorX, cursorY, deltaY) =>
    set((s) => {
      const { x: tx, y: ty, scale } = s.transform
      const factor = Math.exp(-deltaY * 0.0045)
      const newScale = clamp(scale * factor, 0.2, 3)
      const wx = (cursorX - tx) / scale
      const wy = (cursorY - ty) / scale
      const transform = { scale: newScale, x: cursorX - wx * newScale, y: cursorY - wy * newScale }
      return s.mode === 'canvas' ? { transform, controlTransform: transform } : { transform }
    }),

  goToPrimary: () =>
    set((s) => {
      const transform = viewTransform(s.mode, s.viewport, s.currentStage, s.stageCount)
      return s.mode === 'canvas' ? { transform, controlTransform: transform } : { transform }
    }),

  // Bring a surface to the front. Desktop: raise z + clamp on-screen. Canvas: center at 1:1.
  focusAndZoom: (id) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      if (s.mode === 'desktop') {
        const p = desktopClamp(surf.x, surf.y, surf.w, surf.h, s.viewport, s.currentStage)
        return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y, z: ++zCounter } : w)) }
      }
      const m = 56
      const fit = Math.min((s.viewport.w - m) / surf.w, (s.viewport.h - m) / surf.h)
      const scale = clamp(Math.min(1, fit), 0.2, 3)
      const cx = surf.x + surf.w / 2
      const cy = surf.y + surf.h / 2
      const transform = { scale, x: s.viewport.w / 2 - cx * scale, y: s.viewport.h / 2 - cy * scale }
      return {
        surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter } : w)),
        transform,
        controlTransform: transform // a dock-focus in control mode is a settled camera to remember
      }
    }),

  // "Splay out" (macOS Mission Control intent): show me ALL my free-form windows at once. Frees the
  // user from hunting a window they panned away from. We zoom the camera to fit the bounding box of
  // every FREE window (anything floating: web/app/srcdoc/note that is NOT a slotted stage tile, NOT a
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
      return s.mode === 'canvas' ? { transform, controlTransform: transform } : { transform }
    }),

  setIntegrations: (list) =>
    set((s) => {
      const gap = 28
      const total = list.length * WIDGET_W + (list.length - 1) * gap
      const startX = -total / 2
      const positions = { ...s.positions }
      list.forEach((it, i) => {
        if (!positions[it.id]) positions[it.id] = { x: startX + i * (WIDGET_W + gap), y: -120 }
      })
      return { integrations: list, positions }
    }),

  setPos: (id, x, y) => set((s) => ({ positions: { ...s.positions, [id]: { x, y } } })),

  commitPos: (id, prevX, prevY) =>
    set((s) => {
      const cur = s.positions[id]
      if (!cur) return {}
      const candidate = { x: snap(cur.x), y: snap(cur.y) }
      const collides = Object.entries(s.positions).some(([oid, p]) => oid !== id && overlaps(candidate, p))
      return { positions: { ...s.positions, [id]: collides ? { x: prevX, y: prevY } : candidate } }
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
    // cascade if no explicit position (macOS-style stagger), centered on the TARGET stage: input.stage when
    // given (an agent's surface → its own stage, isolating it from the user) else currentStage.
    // stage 0 ⇒ the world origin ⇒ byte-identical to before; a later stage shifts the cascade by its offset.
    const targetStage = Number.isInteger(input.stage) ? (input.stage as number) : st.currentStage
    const n = st.surfaces.length % 7
    const ax = targetStage === 0 ? 0 : targetStage * stageStride(st.viewport)
    let x = input.x ?? ax - w / 2 + n * 34 - 100
    let y = input.y ?? -h / 2 + n * 30 - 70
    if (st.mode === 'desktop') {
      const p = desktopClamp(x, y, w, h, st.viewport, targetStage)
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
    // Born slotted: the tile's geometry is DERIVED from its lattice cell (stage-core), never the
    // cascade — so a place_widget create lands exactly on its slot, immune to clamp/stagger drift.
    if (input.slot && typeof input.slot === 'object') {
      const sa = Number.isInteger(input.slotStage) ? (input.slotStage as number) : targetStage
      const lat = latticeFor(st.viewport, sa)
      const r = cardRect(lat, Number(input.slot.col) || 0, Number(input.slot.row) || 0, String(input.slot.size || 's'))
      surface.slot = { col: Number(input.slot.col) || 0, row: Number(input.slot.row) || 0, size: String(input.slot.size || 's') }
      if (sa > 0) surface.slotStage = sa
      surface.x = r.x
      surface.y = r.y
      surface.w = r.w
      surface.h = r.h
    }
    set((s) => ({ surfaces: [...s.surfaces, surface] }))
    return id
  },

  hydrate: (surfaces, camera, mode, stageCount) =>
    set((s) => {
      // Normalize incoming descriptors to full Surface objects (defaults for anything the
      // persisted node didn't carry), and lift the z-allocator above the restored max so
      // surfaces created after a restore land on top.
      // Restore the persisted stage count (default 1 for old folders / when omitted); currentStage always
      // boots to 0 (control mode + which stage you're on are transient, never persisted).
      const nAreas = Number.isInteger(stageCount) && (stageCount as number) > 0 ? (stageCount as number) : 1
      const restored: Surface[] = surfaces.map((w) => {
        const base = { zoom: 1, props: {}, ...w, z: w.z ?? ++zCounter } as Surface
        // A slotted tile's geometry derives from its lattice cell at THIS renderer's real viewport
        // (the persisted x/y may come from a different window size) — slots beat the legacy paths.
        const sl = slotOf(base)
        if (sl) {
          const stage = base.slotStage ?? 0
          const lat0 = latticeFor(s.viewport, stage)
          const r = cardRect(lat0, sl.col, sl.row, sl.size)
          return { ...base, x: r.x, y: r.y, w: r.w, h: r.h }
        }
        // Runtime chat/activity panels persist absolute x/y. A per-agent chat lives in ITS OWN stage
        // (stage N for agent N); the activity feed + the primary chat live in stage 0. Recompute an agent
        // chat's x from its stage using the renderer's REAL viewport (authoritative — the host may have
        // guessed a default vp), then clamp into that stage. Single-stage / primary case is byte-identical
        // (stageForAgent('0')=0, stageCenterX(0)=0 → x=-700). The camera can reach any stage (stageCount below).
        if (isRuntimePanel(base)) {
          const stage = base.role === 'chat' && base.agentId != null ? stageForAgent(base.agentId) : 0
          const x = base.role === 'chat' && base.agentId != null ? Math.round(stageCenterX(stage, s.viewport) - 700) : base.x
          const p = desktopClamp(x, base.y, base.w, base.h, s.viewport, stage)
          return { ...base, x: p.x, y: p.y }
        }
        return base
      })
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      const sc = clamp(Number(camera.scale) || 1, 0.2, 3) // never a 0/Infinity/NaN scale (would wedge the canvas)
      // Normal mode always fits the current (stage 0 on boot) stage, view-locked; control mode restores the saved camera.
      const transform =
        mode === 'desktop'
          ? viewTransform('desktop', s.viewport, 0, nAreas)
          : { x: s.viewport.w / 2 - camera.x * sc, y: s.viewport.h / 2 - camera.y * sc, scale: sc }
      // A fresh board starts control mode from the default bird's-eye (no stale camera from a prior workspace).
      return { surfaces: restored, transform, mode, stageCount: nAreas, currentStage: 0, layoutHistory: [], controlTransform: null }
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
        (w.kind === 'native' && (w.component === 'chat' || w.component === 'activity' || w.component === 'folder' || w.component === 'terminal' || w.component === 'runtime' || w.component === 'inbox' || w.component === 'unlock'))
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
      return { surfaces: restored }
    }),

  moveSurface: (id, x, y) => {
    get().snapshotLayout()
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      // macOS-faithful free drag: a window may move freely OUTSIDE the stage (off the left/right/bottom),
      // exactly like macOS — the ONLY constraint is the title bar can't slide above the stage's top edge
      // (so it stays grabbable; the #29 invariant). All stages share the same top, so it's stage-independent.
      // (Off-screen windows are recovered via the dock-click focus or control mode, which DO re-clamp.)
      const p = s.mode === 'desktop' ? { x, y: Math.max(primaryRect(s.viewport).y, y) } : { x, y }
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
      if (!tabs.length) return { surfaces: s.surfaces.filter((x) => x.id !== id) } // last tab closed → close the window
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
  openTerminal: (terminalId, title, stage) => {
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
    // Dock the terminal in ITS stage: an agent's terminal carries a stage (so it stays out of the user's
    // stage); a human spawn has none → the current stage, today's behavior. Add to a
    // terminal window ALREADY in that stage, else open one there (createSurface honors the `stage` hint).
    const want = Number.isInteger(stage) ? (stage as number) : s.currentStage
    const term = s.surfaces.find(
      (w) => w.kind === 'native' && w.component === 'terminal' && stageOfX(w.x + (w.w || 0) / 2, s.viewport) === want
    )
    if (term) get().addTab(term.id, { id: terminalId, title, terminalId })
    else get().createSurface({ kind: 'native', component: 'terminal', title: 'Terminal', w: 620, h: 380, stage: want, tabs: [{ id: terminalId, title, terminalId }], activeTab: 0 })
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
          )
        }
      }
      // fill the CURRENT AREA (with a small inset), not the viewport — so 'zoom' means full-screen
      // inside the workspace stage, consistent in both normal and control mode (#35). Stage 0 ⇒ primaryRect.
      const r = s.currentStage === 0 ? primaryRect(s.viewport) : stageRect(s.currentStage, s.viewport)
      const inset = 8
      const fill = { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 }
      return {
        surfaces: s.surfaces.map((w) =>
          w.id === id
            ? // a maximized window is no longer "tiled" — drop preSnap so a later drag doesn't pop it
              // to a stale floating size (and clobber `restore`)
              { ...w, restore: { x: w.x, y: w.y, w: w.w, h: w.h }, ...fill, preSnap: undefined, z: ++zCounter }
            : w
        )
      }
    })
  },

  minimizeSurface: (id) =>
    set((s) => ({ surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, minimized: true } : w)) })),

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
      })
    }))
    // Restore-from-dock of a SLOTTED tile: a minimized tile releases its cells (occupancy skips it),
    // so by the time it comes back its span may be taken — re-place it through the placer (nearest
    // free span), or pop it free-form if nothing fits. Never overlap, never reflow others.
    if (patch.minimized === false) {
      const st = get()
      const cur = st.surfaces.find((x) => x.id === id)
      const sl = cur && slotOf(cur)
      if (cur && sl) {
        const stage = cur.slotStage ?? 0
        const lat = latticeFor(st.viewport, stage)
        const occ = occupancy(st.surfaces, stage, id)
        const sp = spanOf(sl.size)
        let blocked = sl.col + sp.c > lat.cols || sl.row + sp.r > lat.rows
        if (!blocked) {
          for (let c = sl.col; c < sl.col + sp.c && !blocked; c++) for (let r = sl.row; r < sl.row + sp.r && !blocked; r++) if (occ.has(c + ',' + r)) blocked = true
        }
        if (blocked) {
          const ns = nearestFreeSlot(st.surfaces, lat, sl.size, cur.x + cur.w / 2, cur.y + cur.h / 2, stage, id)
          if (ns) st.placeSurfaceSlot(id, ns.col, ns.row, sl.size, stage)
          else st.clearSurfaceSlot(id) // stage too full for its size — come back free-form, overlap-free
        }
        st.reflowFiles()
      }
    }
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
        selection: s.selection.filter((x) => x !== id)
      }
    })
  },

  focusSurface: (id) =>
    set((s) => ({ surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter } : w)) })),

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
 *  occlusion test use this): tiles/icons at raw z → free windows +500k → focus floater +1.5M →
 *  pinned chat/activity +2M. (A slotted tile being DRAGGED gets a transient +1.2M lift on top,
 *  component-local — callers add it where the gesture state lives.) */
export function effectiveZ(s: Surface): number {
  const isPanel = s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity'))
  if (isPanel) return 2_000_000 + s.z
  if (s.focus) return 1_500_000 + s.z
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
