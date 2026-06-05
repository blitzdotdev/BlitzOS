import { create } from 'zustand'
import {
  CanvasTransform,
  Surface,
  SurfaceKind,
  Vec2,
  IntegrationStatus,
  PRIMARY_W,
  PRIMARY_H,
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

// Fixed-desktop chrome insets (px) + how much of a window's title bar must stay reachable.
const SIDEBAR = 52
const TITLEBAR = 32
const TOOLBAR = 64
const KEEP = 120
const TITLE_H = 34

/** Clamp a window (world coords, scale 1, origin centered) so its title bar stays grabbable. */
function desktopClamp(x: number, y: number, w: number, vp: { w: number; h: number }): Vec2 {
  const left = -vp.w / 2 + SIDEBAR
  const right = vp.w / 2
  const top = -vp.h / 2 + TITLEBAR
  const bottom = vp.h / 2 - TOOLBAR
  return { x: clamp(x, left + KEEP - w, right - KEEP), y: clamp(y, top, bottom - TITLE_H) }
}

let zCounter = 10

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
}

interface DesktopState {
  transform: CanvasTransform
  viewport: { w: number; h: number }
  mode: 'desktop' | 'canvas'
  integrations: IntegrationStatus[]
  positions: Record<string, Vec2>
  surfaces: Surface[]

  setViewport: (w: number, h: number) => void
  setMode: (m: 'desktop' | 'canvas') => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  goToPrimary: () => void
  focusAndZoom: (id: string) => void

  setIntegrations: (list: IntegrationStatus[]) => void
  setPos: (id: string, x: number, y: number) => void
  commitPos: (id: string, prevX: number, prevY: number) => void

  createSurface: (input: CreateSurfaceInput) => string
  moveSurface: (id: string, x: number, y: number) => void
  resizeSurface: (id: string, w: number, h: number) => void
  closeSurface: (id: string) => void
  focusSurface: (id: string) => void
  setZoom: (id: string, zoom: number) => void
  toggleMaximize: (id: string) => void
  updateSurface: (id: string, patch: Partial<Surface>) => void
  updateSurfaceProps: (id: string, props: Record<string, unknown>) => void
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

  setViewport: (w, h) => set({ viewport: { w, h } }),
  setMode: (m) => set({ mode: m }),

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

  goToPrimary: () =>
    set((s) => {
      // desktop mode: real 1:1, origin centered (the fixed screen)
      if (s.mode === 'desktop') {
        return { transform: { scale: 1, x: s.viewport.w / 2, y: s.viewport.h / 2 } }
      }
      const pad = 80
      const sx = (s.viewport.w - pad * 2) / PRIMARY_W
      const sy = (s.viewport.h - pad * 2) / PRIMARY_H
      const scale = clamp(Math.min(sx, sy, 1), 0.2, 3)
      return { transform: { scale, x: s.viewport.w / 2, y: s.viewport.h / 2 } }
    }),

  // Bring a surface to the front. Desktop: raise z + clamp on-screen. Canvas: center at 1:1.
  focusAndZoom: (id) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      if (s.mode === 'desktop') {
        const p = desktopClamp(surf.x, surf.y, surf.w, s.viewport)
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
    const id = input.id ?? `srf-${zCounter}`
    const size = defaultSize(input.kind)
    const w = input.w ?? size.w
    const h = input.h ?? size.h
    const st = get()
    // cascade if no explicit position (macOS-style stagger)
    const n = st.surfaces.length % 7
    let x = input.x ?? -w / 2 + n * 34 - 100
    let y = input.y ?? -h / 2 + n * 30 - 70
    if (st.mode === 'desktop') {
      const p = desktopClamp(x, y, w, st.viewport)
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
      props: input.props ?? {}
    }
    set((s) => ({ surfaces: [...s.surfaces, surface] }))
    return id
  },

  moveSurface: (id, x, y) =>
    set((s) => {
      const surf = s.surfaces.find((w) => w.id === id)
      if (!surf) return {}
      const p = s.mode === 'desktop' ? desktopClamp(x, y, surf.w, s.viewport) : { x, y }
      return { surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x: p.x, y: p.y } : w)) }
    }),

  resizeSurface: (id, w, h) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) =>
        it.id === id ? { ...it, w: Math.max(160, w), h: Math.max(120, h) } : it
      )
    })),

  setZoom: (id, zoom) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) => (it.id === id ? { ...it, zoom: clamp(zoom, 0.3, 3) } : it))
    })),

  toggleMaximize: (id) =>
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
      // fill the current viewport (in world coords) with a small margin
      const m = 22
      const { transform: t, viewport: vp } = s
      const fill = {
        x: (m - t.x) / t.scale,
        y: (m - t.y) / t.scale,
        w: (vp.w - 2 * m) / t.scale,
        h: (vp.h - 2 * m) / t.scale
      }
      return {
        surfaces: s.surfaces.map((w) =>
          w.id === id
            ? { ...w, restore: { x: w.x, y: w.y, w: w.w, h: w.h }, ...fill, z: ++zCounter }
            : w
        )
      }
    }),

  updateSurface: (id, patch) =>
    set((s) => ({
      surfaces: s.surfaces.map((it) =>
        it.id === id ? { ...it, ...patch, props: { ...it.props, ...(patch.props ?? {}) } } : it
      )
    })),

  closeSurface: (id) => set((s) => ({ surfaces: s.surfaces.filter((w) => w.id !== id) })),

  focusSurface: (id) =>
    set((s) => ({ surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter } : w)) })),

  updateSurfaceProps: (id, props) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...props } } : w))
    }))
}))
