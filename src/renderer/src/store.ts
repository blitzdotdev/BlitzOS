import { create } from 'zustand'
import {
  CanvasTransform,
  Surface,
  SurfaceTab,
  SurfaceKind,
  Vec2,
  IntegrationStatus,
  GRID,
  WIDGET_W,
  WIDGET_H,
  isRuntimePanel
} from './types'
// The area-grid geometry (insets, primaryRect, areaStride, areaRect, areaCenterX, areaForSession) lives
// in the shared areas-core so the renderer and the main-process cores share ONE definition (no divergence).
// Re-exported below so existing `from './store'` importers (capture/App/SurfaceFrame/PrimarySpace) don't churn.
import { primaryRect, areaStride, areaRect, areaCenterX, areaForSession, areaOfX } from './areas-core.mjs'
export { primaryRect, areaStride, areaRect, areaCenterX, areaForSession, areaOfX }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
function snap(v: number): number {
  return Math.round(v / GRID) * GRID
}
function overlaps(a: Vec2, b: Vec2): boolean {
  return a.x < b.x + WIDGET_W && a.x + WIDGET_W > b.x && a.y < b.y + WIDGET_H && a.y + WIDGET_H > b.y
}

// (area-grid geometry moved to ./areas-core — imported + re-exported above)
// These two insets are still used by the camera anchor below (cx = SIDEBAR + r.w/2, cy = TITLEBAR + r.h/2).
const SIDEBAR = 52
const TITLEBAR = 32
/** Clamp a window so it stays inside its workspace area (its title bar therefore can't slide under
 *  the top titlebar in normal mode — #29). `area` defaults to 0, whose rect IS primaryRect, so the
 *  single-area path is byte-identical to before. */
function desktopClamp(x: number, y: number, w: number, h: number, vp: { w: number; h: number }, area = 0): Vec2 {
  const r = area === 0 ? primaryRect(vp) : areaRect(area, vp)
  return { x: clamp(x, r.x, Math.max(r.x, r.x + r.w - w)), y: clamp(y, r.y, Math.max(r.y, r.y + r.h - h)) }
}
/** Camera per mode. Normal = scale 1 locked to the CURRENT area (its center maps to a fixed screen
 *  point, so every area lands in the same on-screen desktop region). Control = a gentle zoom-out: a
 *  single area uses controlScale (0.7); multiple areas fit the whole tiled row in the same on-screen
 *  span (so n===1 collapses to the single-area controlScale). */
export function viewTransform(
  mode: 'desktop' | 'canvas',
  vp: { w: number; h: number },
  area = 0,
  areaCount = 1
): CanvasTransform {
  const r = primaryRect(vp)
  const cx = SIDEBAR + r.w / 2 // screen point of area 0's center (world origin) — today's anchor
  const cy = TITLEBAR + r.h / 2
  if (mode === 'desktop') {
    // lock to the current area: put its center at the same (cx,cy) screen anchor. area 0's center is
    // the world origin, so t = (cx,cy) — byte-identical to today; area i shifts the camera by i*stride.
    const acx = area === 0 ? 0 : area * areaStride(vp)
    return { scale: 1, x: cx - acx, y: cy }
  }
  // CONTROL = a GENTLE zoom-out (controlScale 0.7; was a 0.31 wide bird's-eye, which was too much).
  // Single area → 0.7. Multiple areas → scale so the union of all areas spans the same screen width
  // one area did at 0.7, union center kept at the (cx,cy) anchor. Tune controlScale: 1 = no zoom-out.
  const controlScale = 0.7
  if (areaCount <= 1) return { scale: controlScale, x: cx, y: cy }
  const stride = areaStride(vp)
  const unionW = (areaCount - 1) * stride + r.w
  const scale = (controlScale * r.w) / unionW
  const ucx = ((areaCount - 1) * stride) / 2 // world x of the tiled row's center
  return { scale, x: cx - ucx * scale, y: cy }
}
/** While dragging a window, if the CURSOR (world coords) reaches a primary-area edge, return the
 *  macOS tiling target: left/right half (a side edge) or a quarter (a corner). There is intentionally
 *  NO full-screen / top-half / bottom-half snap — macOS only tiles to halves and quarters, and the
 *  user explicitly does not want a window full-screening on a stray upward drag. Null = free drag.
 *  Mirrors macOS edge-tiling, relative to the PRIMARY AREA (so it works on the infinite canvas). */
export function snapTargetFor(
  wx: number,
  wy: number,
  vp: { w: number; h: number },
  area = 0,
  mode: 'desktop' | 'canvas' = 'canvas'
): { x: number; y: number; w: number; h: number } | null {
  const r = area === 0 ? primaryRect(vp) : areaRect(area, vp)
  const nx = (wx - r.x) / r.w
  const ny = (wy - r.y) / r.h
  if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return null // cursor well outside the area
  // Edge/corner snap-intent zone per side. CONTROL mode (the zoomed-out bird's-eye, mode==='canvas') keeps
  // a GENEROUS zone for easy arranging; NORMAL mode (mode==='desktop') uses a thin zone so the cursor must
  // nearly TOUCH the area border to tile — otherwise nudging a window slightly kept firing an unwanted tile.
  const E = mode === 'desktop' ? 0.03 : 0.135
  const nearL = nx < E
  const nearR = nx > 1 - E
  const nearT = ny < E
  const nearB = ny > 1 - E
  // Only the LEFT/RIGHT edges (and their corners) tile — the top/bottom edges do nothing on their own,
  // so a window can never go full-screen and an upward drag just moves it freely (macOS-faithful).
  if (!nearL && !nearR) return null
  // integer split points so adjacent halves/quarters tile with NO 1px seam on odd-width areas
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
  /** tabbed windows (terminal): a session per tab. */
  tabs?: SurfaceTab[]
  activeTab?: number
  /** system runtime surface (e.g. a chat session widget: role:'chat', pinned). */
  role?: string
  pinned?: boolean
  /** the chat session this surface belongs to (a per-session chat widget). */
  sessionId?: string
  /** place this surface in a SPECIFIC workspace area (a session-scoped agent → its own area N); when
   *  omitted, it cascades into the current area. Derived from x afterward — never stored on the Surface. */
  area?: number
}

interface DesktopState {
  transform: CanvasTransform
  // The last camera the user had while IN control mode — restored on re-entry so control mode
  // "remembers" where you were panned/zoomed (instead of always snapping back to the default view).
  controlTransform: CanvasTransform | null
  viewport: { w: number; h: number }
  mode: 'desktop' | 'canvas'
  // Workspace areas (#45): bounded desktops tiled left→right. `areaCount` = how many (1 today),
  // `currentArea` = the active one (0 today). A surface's area is DERIVED from its world x; these two
  // fields drive which area's rect clamp/snap/maximize/camera operate on. At areaCount===1 everything
  // is byte-identical to the single-area model.
  areaCount: number
  currentArea: number
  integrations: IntegrationStatus[]
  positions: Record<string, Vec2>
  surfaces: Surface[]
  layoutHistory: Surface[][]
  selection: string[]
  dragTarget: string | null
  snapPreview: { x: number; y: number; w: number; h: number } | null
  editingId: string | null // surface the user is actively editing — its live content survives a reconcile (#47)
  absorbing: string[]
  grabMode: boolean
  /** View locked (⌘⌘): the infinite canvas is frozen at its current camera — pan/zoom are off
   *  and a background drag becomes marquee-select. Lets you work inside surfaces without the
   *  canvas drifting. Toggled by double-tapping ⌘ (or the toolbar lock button). */
  locked: boolean

  setViewport: (w: number, h: number) => void
  setMode: (m: 'desktop' | 'canvas') => void
  setTransform: (t: CanvasTransform) => void
  setControlTransform: (t: CanvasTransform | null) => void
  setCurrentArea: (i: number) => void
  setAreaCount: (n: number) => void
  addArea: () => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  goToPrimary: () => void
  focusAndZoom: (id: string) => void
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
  // Phase 2: adopt a persisted workspace (restore surfaces + camera + mode + area count from disk).
  hydrate: (surfaces: Surface[], camera: CanvasTransform, mode: 'desktop' | 'canvas', areaCount?: number) => void
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
  // Open (or focus) a session's terminal tab: activate it if it's already a tab, else add it to the
  // existing terminal window, else open the first terminal window. The one shared seam for the live
  // session-spawn action, resume-on-load, and the Sessions tray's "Open" — so a session is in one tab.
  openSession: (sessionId: string, title: string, area?: number | null) => void
  // Layout undo: the agent auto-applies layouts; the human reverts with Cmd+Z.
  snapshotLayout: () => void
  undoLayout: () => void
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
  areaCount: 1,
  currentArea: 0,
  integrations: [],
  positions: {},
  surfaces: [],
  layoutHistory: [],
  selection: [],
  dragTarget: null,
  snapPreview: null,
  editingId: null,
  absorbing: [],
  grabMode: false,
  locked: false,

  setViewport: (w, h) => set({ viewport: { w, h } }),
  setMode: (m) => set({ mode: m }),
  setTransform: (t) => set({ transform: t }),
  setControlTransform: (t) => set({ controlTransform: t }),
  // Pure state mutations (the camera animation on switch is wired by the caller in App.tsx).
  setCurrentArea: (i) => set((s) => ({ currentArea: clamp(Math.round(i), 0, s.areaCount - 1) })),
  setAreaCount: (n) => set((s) => ({ areaCount: Math.max(1, Math.round(n)), currentArea: clamp(s.currentArea, 0, Math.max(0, Math.round(n) - 1)) })),
  addArea: () => set((s) => ({ areaCount: s.areaCount + 1, currentArea: s.areaCount })),

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
      const transform = viewTransform(s.mode, s.viewport, s.currentArea, s.areaCount)
      return s.mode === 'canvas' ? { transform, controlTransform: transform } : { transform }
    }),

  // Bring a surface to the front. Desktop: raise z + clamp on-screen. Canvas: center at 1:1.
  focusAndZoom: (id) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      if (s.mode === 'desktop') {
        const p = desktopClamp(surf.x, surf.y, surf.w, surf.h, s.viewport, s.currentArea)
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
    // restart, so layout/consent can key off it. zCounter is now ONLY the session
    // z-order allocator, never identity. (UUIDv4 here; ULID is a deferred sortable swap.)
    const id = input.id ?? crypto.randomUUID()
    const size = defaultSize(input.kind)
    const w = input.w ?? size.w
    const h = input.h ?? size.h
    const st = get()
    // cascade if no explicit position (macOS-style stagger), centered on the TARGET area: input.area when
    // given (a session-scoped agent's surface → its own area, isolating it from the user) else currentArea.
    // area 0 ⇒ the world origin ⇒ byte-identical to before; a later area shifts the cascade by its offset.
    const targetArea = Number.isInteger(input.area) ? (input.area as number) : st.currentArea
    const n = st.surfaces.length % 7
    const ax = targetArea === 0 ? 0 : targetArea * areaStride(st.viewport)
    let x = input.x ?? ax - w / 2 + n * 34 - 100
    let y = input.y ?? -h / 2 + n * 30 - 70
    if (st.mode === 'desktop') {
      const p = desktopClamp(x, y, w, h, st.viewport, targetArea)
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
      // preserve system-surface fields so a broadcast 'create' (e.g. a new chat session) keeps its
      // role/pinned/sessionId — without these a created chat widget would lose role:'chat' and not render.
      ...(input.role ? { role: input.role } : {}),
      ...(input.pinned ? { pinned: input.pinned } : {}),
      ...(input.sessionId != null ? { sessionId: String(input.sessionId) } : {}),
      ...(input.tabs ? { tabs: input.tabs, activeTab: input.activeTab ?? 0 } : {})
    }
    set((s) => ({ surfaces: [...s.surfaces, surface] }))
    return id
  },

  hydrate: (surfaces, camera, mode, areaCount) =>
    set((s) => {
      // Normalize incoming descriptors to full Surface objects (defaults for anything the
      // persisted node didn't carry), and lift the z-allocator above the restored max so
      // surfaces created after a restore land on top.
      // Restore the persisted area count (default 1 for old folders / when omitted); currentArea always
      // boots to 0 (control mode + which area you're on are transient, never persisted).
      const nAreas = Number.isInteger(areaCount) && (areaCount as number) > 0 ? (areaCount as number) : 1
      const restored: Surface[] = surfaces.map((w) => {
        const base = { zoom: 1, props: {}, ...w, z: w.z ?? ++zCounter } as Surface
        // Runtime chat/activity panels persist absolute x/y. A per-session chat lives in ITS OWN area
        // (area N for session N); the activity feed + the primary chat live in area 0. Recompute a session
        // chat's x from its area using the renderer's REAL viewport (authoritative — the host may have
        // guessed a default vp), then clamp into that area. Single-area / primary case is byte-identical
        // (areaForSession('0')=0, areaCenterX(0)=0 → x=-700). The camera can reach any area (areaCount below).
        if (isRuntimePanel(base)) {
          const area = base.role === 'chat' && base.sessionId != null ? areaForSession(base.sessionId) : 0
          const x = base.role === 'chat' && base.sessionId != null ? Math.round(areaCenterX(area, s.viewport) - 700) : base.x
          const p = desktopClamp(x, base.y, base.w, base.h, s.viewport, area)
          return { ...base, x: p.x, y: p.y }
        }
        return base
      })
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      const sc = clamp(Number(camera.scale) || 1, 0.2, 3) // never a 0/Infinity/NaN scale (would wedge the canvas)
      // Normal mode always fits the current (area 0 on boot) area, view-locked; control mode restores the saved camera.
      const transform =
        mode === 'desktop'
          ? viewTransform('desktop', s.viewport, 0, nAreas)
          : { x: s.viewport.w / 2 - camera.x * sc, y: s.viewport.h / 2 - camera.y * sc, scale: sc }
      // A fresh board starts control mode from the default bird's-eye (no stale camera from a prior workspace).
      return { surfaces: restored, transform, mode, areaCount: nAreas, currentArea: 0, layoutHistory: [], controlTransform: null }
    }),

  // Apply an external folder reconcile (dropped/edited/removed files) to a LIVE canvas WITHOUT
  // resetting the camera or clobbering the runtime chat/activity panels (newer here than the
  // backend's osState). Replaces only the file-backed surfaces with the reconciled set.
  applyReconcile: (incoming) =>
    set((s) => {
      // Runtime-only surfaces NOT backed by a workspace file (nodeKind returns null for them), so they're
      // never in the reconciled `incoming` set — keep the LIVE ones or a reconcile would wipe them. Covers
      // the chat/activity panels, in-memory folders, AND the session surfaces (terminal windows + the
      // Sessions tray), which are reconstructed from live sessions, never persisted as nodes.
      const isRuntime = (w: Surface): boolean =>
        w.role === 'chat' ||
        w.role === 'activity' ||
        (w.kind === 'native' && (w.component === 'chat' || w.component === 'activity' || w.component === 'folder' || w.component === 'terminal' || w.component === 'sessions' || w.component === 'inbox'))
      const keepRuntime = s.surfaces.filter(isRuntime)
      const localById = new Map(s.surfaces.map((w) => [w.id, w]))
      // A reconcile's `incoming` can echo back runtime-only surfaces (the host keeps un-persisted state
      // like an open terminal/sessions/folder). Those are preserved via keepRuntime from the LIVE store,
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
            // For web/app the LIVE webview location is authoritative (the user/agent may have navigated
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
      // macOS-faithful free drag: a window may move freely OUTSIDE the area (off the left/right/bottom),
      // exactly like macOS — the ONLY constraint is the title bar can't slide above the area's top edge
      // (so it stays grabbable; the #29 invariant). All areas share the same top, so it's area-independent.
      // (Off-screen windows are recovered via the dock-click focus or control mode, which DO re-clamp.)
      const p = s.mode === 'desktop' ? { x, y: Math.max(primaryRect(s.viewport).y, y) } : { x, y }
      return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y } : w)) }
    })
  },


  setZoom: (id, zoom) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) => (it.id === id ? { ...it, zoom: clamp(zoom, 0.3, 3) } : it))
    })),

  // ---- tabbed windows (terminal windows hold a session per tab) ----
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
  openSession: (sessionId, title, area) => {
    const s = get()
    // Already a tab somewhere? activate it + raise its window (idempotent — no duplicate tab).
    for (const w of s.surfaces) {
      if (w.kind === 'native' && w.component === 'terminal') {
        const idx = (w.tabs || []).findIndex((t) => t.sessionId === sessionId)
        if (idx >= 0) {
          get().setActiveTab(w.id, idx)
          get().focusSurface(w.id)
          return
        }
      }
    }
    // Dock the session's terminal in ITS area: an agent's session carries an area (so its terminal stays
    // out of the user's area); a human spawn has none → the current area, today's behavior. Add to a
    // terminal window ALREADY in that area, else open one there (createSurface honors the `area` hint).
    const want = Number.isInteger(area) ? (area as number) : s.currentArea
    const term = s.surfaces.find(
      (w) => w.kind === 'native' && w.component === 'terminal' && areaOfX(w.x + (w.w || 0) / 2, s.viewport) === want
    )
    if (term) get().addTab(term.id, { id: sessionId, title, sessionId })
    else get().createSurface({ kind: 'native', component: 'terminal', title: 'Terminal', w: 620, h: 380, area: want, tabs: [{ id: sessionId, title, sessionId }], activeTab: 0 })
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
      // inside the workspace area, consistent in both normal and control mode (#35). Area 0 ⇒ primaryRect.
      const r = s.currentArea === 0 ? primaryRect(s.viewport) : areaRect(s.currentArea, s.viewport)
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
      surfaces: s.surfaces.map((it) =>
        it.id === id ? { ...it, ...patch, props: { ...it.props, ...(patch.props ?? {}) } } : it
      )
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
    })
}))

/** Default name for a UI-spawned terminal session — "Terminal N", N counting existing terminal tabs,
 *  so the "+ Terminal" toolbar button and the tab strip's "+" produce distinct, readable tab names
 *  instead of every tab reading "Terminal". (Agent/tool spawns name themselves from the command.) */
export function nextTerminalName(): string {
  const n = useDesktop
    .getState()
    .surfaces.filter((s) => s.kind === 'native' && s.component === 'terminal')
    .reduce((acc, s) => acc + (s.tabs?.length || 0), 0)
  return `Terminal ${n + 1}`
}
