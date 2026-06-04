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
  integrations: IntegrationStatus[]
  positions: Record<string, Vec2>
  surfaces: Surface[]

  setViewport: (w: number, h: number) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (cursorX: number, cursorY: number, deltaY: number) => void
  goToPrimary: () => void

  setIntegrations: (list: IntegrationStatus[]) => void
  setPos: (id: string, x: number, y: number) => void
  commitPos: (id: string, prevX: number, prevY: number) => void

  createSurface: (input: CreateSurfaceInput) => string
  moveSurface: (id: string, x: number, y: number) => void
  closeSurface: (id: string) => void
  focusSurface: (id: string) => void
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
  integrations: [],
  positions: {},
  surfaces: [],

  setViewport: (w, h) => set({ viewport: { w, h } }),

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
      const pad = 80
      const sx = (s.viewport.w - pad * 2) / PRIMARY_W
      const sy = (s.viewport.h - pad * 2) / PRIMARY_H
      const scale = clamp(Math.min(sx, sy), 0.2, 3)
      return { transform: { scale, x: s.viewport.w / 2, y: s.viewport.h / 2 } }
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
    const surface: Surface = {
      id,
      kind: input.kind,
      x: input.x ?? -size.w / 2,
      y: input.y ?? -size.h / 2,
      w: input.w ?? size.w,
      h: input.h ?? size.h,
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
    set((s) => ({ surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, x, y } : w)) })),

  closeSurface: (id) => set((s) => ({ surfaces: s.surfaces.filter((w) => w.id !== id) })),

  focusSurface: (id) =>
    set((s) => ({ surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter } : w)) })),

  updateSurfaceProps: (id, props) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...props } } : w))
    }))
}))
