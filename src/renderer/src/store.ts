import { create } from 'zustand'
import {
  CanvasTransform,
  Surface,
  SurfaceKind,
  Vec2,
  IntegrationStatus,
  GRID,
  WIDGET_W,
  WIDGET_H
} from './types'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
function snap(v: number): number {
  return Math.round(v / GRID) * GRID
}
function overlaps(a: Vec2, b: Vec2): boolean {
  return a.x < b.x + WIDGET_W && a.x + WIDGET_W > b.x && a.y < b.y + WIDGET_H && a.y + WIDGET_H > b.y
}

// Fixed-desktop chrome insets (px): the top titlebar, the left dock, the bottom toolbar, right pad.
const SIDEBAR = 52
const TITLEBAR = 32
const TOOLBAR = 64
const RIGHTPAD = 24

/** The primary workspace area in WORLD coords = the on-screen desktop region (below the titlebar,
 *  right of the dock, above the toolbar). At scale 1 it maps 1:1 to that region — so the area is
 *  "the same size as the screen" by default and windows render at natural size. */
export function primaryRect(vp: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.max(320, vp.w - SIDEBAR - RIGHTPAD)
  const h = Math.max(240, vp.h - TITLEBAR - TOOLBAR)
  return { x: -w / 2, y: -h / 2, w, h }
}
/** Clamp a window so it stays inside the primary area (its title bar therefore can't slide under
 *  the top titlebar in normal mode — #29). */
function desktopClamp(x: number, y: number, w: number, h: number, vp: { w: number; h: number }): Vec2 {
  const r = primaryRect(vp)
  return { x: clamp(x, r.x, Math.max(r.x, r.x + r.w - w)), y: clamp(y, r.y, Math.max(r.y, r.y + r.h - h)) }
}
/** Camera per mode. Normal = scale 1 centered on the area (screen-sized, natural windows). Control =
 *  zoomed out so the whole area sits in the middle with margin (the bird's-eye overview). */
export function viewTransform(mode: 'desktop' | 'canvas', vp: { w: number; h: number }): CanvasTransform {
  const r = primaryRect(vp)
  const cx = SIDEBAR + r.w / 2 // screen point of the area center (world origin)
  const cy = TITLEBAR + r.h / 2
  return { scale: mode === 'desktop' ? 1 : 0.62, x: cx, y: cy }
}
/** While dragging a window in normal mode, if the cursor (world coords) is near a primary-area edge,
 *  return the snap-target rect: full (top edge), left/right half (side edges), or a quarter (corner).
 *  Null = no snap. Mirrors macOS/Windows edge-snapping, but relative to the PRIMARY AREA. */
export function snapTargetFor(
  wx: number,
  wy: number,
  vp: { w: number; h: number }
): { x: number; y: number; w: number; h: number } | null {
  const r = primaryRect(vp)
  const nx = (wx - r.x) / r.w
  const ny = (wy - r.y) / r.h
  if (nx < -0.08 || nx > 1.08 || ny < -0.08 || ny > 1.08) return null // cursor well outside the area
  const E = 0.06
  const nearL = nx < E
  const nearR = nx > 1 - E
  const nearT = ny < E
  const nearB = ny > 1 - E
  // integer split points so adjacent halves/quarters tile with NO 1px seam on odd-width areas
  const x0 = Math.round(r.x)
  const y0 = Math.round(r.y)
  const W = Math.round(r.w)
  const H = Math.round(r.h)
  const halfW = Math.round(W / 2)
  const halfH = Math.round(H / 2)
  if (nearL && nearT) return { x: x0, y: y0, w: halfW, h: halfH } // corners → quarters
  if (nearL && nearB) return { x: x0, y: y0 + halfH, w: halfW, h: H - halfH }
  if (nearR && nearT) return { x: x0 + halfW, y: y0, w: W - halfW, h: halfH }
  if (nearR && nearB) return { x: x0 + halfW, y: y0 + halfH, w: W - halfW, h: H - halfH }
  if (nearT) return { x: x0, y: y0, w: W, h: H } // top edge → full
  if (nearL) return { x: x0, y: y0, w: halfW, h: H } // left half
  if (nearR) return { x: x0 + halfW, y: y0, w: W - halfW, h: H } // right half
  return null
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
}

interface DesktopState {
  transform: CanvasTransform
  viewport: { w: number; h: number }
  mode: 'desktop' | 'canvas'
  integrations: IntegrationStatus[]
  positions: Record<string, Vec2>
  surfaces: Surface[]
  layoutHistory: Surface[][]
  selection: string[]
  dragTarget: string | null
  snapPreview: { x: number; y: number; w: number; h: number } | null
  absorbing: string[]
  grabMode: boolean

  setViewport: (w: number, h: number) => void
  setMode: (m: 'desktop' | 'canvas') => void
  setTransform: (t: CanvasTransform) => void
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
  addToFolder: (folderId: string, ids: string[]) => void
  dropIntoFolder: (folderId: string, ids: string[]) => void
  setGrabMode: (on: boolean) => void

  setIntegrations: (list: IntegrationStatus[]) => void
  setPos: (id: string, x: number, y: number) => void
  commitPos: (id: string, prevX: number, prevY: number) => void

  createSurface: (input: CreateSurfaceInput) => string
  // Phase 2: adopt a persisted workspace (restore surfaces + camera + mode from disk).
  hydrate: (surfaces: Surface[], camera: CanvasTransform, mode: 'desktop' | 'canvas') => void
  moveSurface: (id: string, x: number, y: number) => void
  closeSurface: (id: string) => void
  focusSurface: (id: string) => void
  setZoom: (id: string, zoom: number) => void
  toggleMaximize: (id: string) => void
  minimizeSurface: (id: string) => void
  updateSurface: (id: string, patch: Partial<Surface>) => void
  updateSurfaceProps: (id: string, props: Record<string, unknown>) => void
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
  viewport: { w: window.innerWidth, h: window.innerHeight },
  mode: 'desktop',
  integrations: [],
  positions: {},
  surfaces: [],
  layoutHistory: [],
  selection: [],
  dragTarget: null,
  snapPreview: null,
  absorbing: [],
  grabMode: false,

  setViewport: (w, h) => set({ viewport: { w, h } }),
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
  setGrabMode: (on) => set({ grabMode: on }),

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

  panBy: (dx, dy) =>
    set((s) => ({ transform: { ...s.transform, x: s.transform.x + dx, y: s.transform.y + dy } })),

  zoomAt: (cursorX, cursorY, deltaY) =>
    set((s) => {
      const { x: tx, y: ty, scale } = s.transform
      const factor = Math.exp(-deltaY * 0.0045)
      const newScale = clamp(scale * factor, 0.2, 3)
      const wx = (cursorX - tx) / scale
      const wy = (cursorY - ty) / scale
      return { transform: { scale: newScale, x: cursorX - wx * newScale, y: cursorY - wy * newScale } }
    }),

  goToPrimary: () => set((s) => ({ transform: viewTransform(s.mode, s.viewport) })),

  // Bring a surface to the front. Desktop: raise z + clamp on-screen. Canvas: center at 1:1.
  focusAndZoom: (id) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      if (s.mode === 'desktop') {
        const p = desktopClamp(surf.x, surf.y, surf.w, surf.h, s.viewport)
        return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y, z: ++zCounter } : w)) }
      }
      const m = 56
      const fit = Math.min((s.viewport.w - m) / surf.w, (s.viewport.h - m) / surf.h)
      const scale = clamp(Math.min(1, fit), 0.2, 3)
      const cx = surf.x + surf.w / 2
      const cy = surf.y + surf.h / 2
      return {
        surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter } : w)),
        transform: { scale, x: s.viewport.w / 2 - cx * scale, y: s.viewport.h / 2 - cy * scale }
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
    // cascade if no explicit position (macOS-style stagger)
    const n = st.surfaces.length % 7
    let x = input.x ?? -w / 2 + n * 34 - 100
    let y = input.y ?? -h / 2 + n * 30 - 70
    if (st.mode === 'desktop') {
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
      component: input.component,
      props: input.props ?? {},
      shared: input.shared
    }
    set((s) => ({ surfaces: [...s.surfaces, surface] }))
    return id
  },

  hydrate: (surfaces, camera, mode) =>
    set((s) => {
      // Normalize incoming descriptors to full Surface objects (defaults for anything the
      // persisted node didn't carry), and lift the z-allocator above the restored max so
      // surfaces created after a restore land on top.
      const restored: Surface[] = surfaces.map((w) => ({
        zoom: 1,
        props: {},
        ...w,
        z: w.z ?? ++zCounter
      })) as Surface[]
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      // camera is the WORLD point at screen center + scale -> compute the transform that puts
      // that world point at the current viewport's center (viewport-independent restore).
      const sc = clamp(Number(camera.scale) || 1, 0.2, 3) // never a 0/Infinity/NaN scale (would wedge the canvas)
      // Normal mode always fits the primary area (view-locked); control mode restores the saved camera.
      const transform =
        mode === 'desktop'
          ? viewTransform('desktop', s.viewport)
          : { x: s.viewport.w / 2 - camera.x * sc, y: s.viewport.h / 2 - camera.y * sc, scale: sc }
      return { surfaces: restored, transform, mode, layoutHistory: [] }
    }),

  moveSurface: (id, x, y) => {
    get().snapshotLayout()
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      const p = s.mode === 'desktop' ? desktopClamp(x, y, surf.w, surf.h, s.viewport) : { x, y }
      return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y } : w)) }
    })
  },


  setZoom: (id, zoom) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) => (it.id === id ? { ...it, zoom: clamp(zoom, 0.3, 3) } : it))
    })),

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
      // fill the PRIMARY AREA (with a small inset), not the viewport — so 'zoom' means full-screen
      // inside the workspace area, consistent in both normal and control mode (#35).
      const r = primaryRect(s.viewport)
      const inset = 8
      const fill = { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 }
      return {
        surfaces: s.surfaces.map((w) =>
          w.id === id
            ? { ...w, restore: { x: w.x, y: w.y, w: w.w, h: w.h }, ...fill, z: ++zCounter }
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
