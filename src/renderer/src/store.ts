import { create } from 'zustand'
import { CanvasTransform, Surface, SurfaceTab, SurfaceKind } from './types'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
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
  /** Born as the free-form focus floater (human pull-in). */
  focus?: boolean
}

interface DesktopState {
  transform: CanvasTransform
  viewport: { w: number; h: number }
  surfaces: Surface[]
  activeSurfaceId: string | null
  /** The live OS accent (hex), picked by the theme widget/agent. Folded into the props posted to
   *  srcdoc widgets that carry no own accent, so plain + future widgets follow the OS theme. */
  osAccent: string | null
  setOsAccent: (hex: string) => void
  /** A web surface whose active page is in HTML5 fullscreen (video requestFullscreen / YouTube button /
   *  agent `f`), or null. The renderer hides all chrome + forces mouse passthrough so the video's
   *  controls and Esc work. */
  pageFullscreenId: string | null
  /** Timestamp of the last BULK layout transaction (rides the os:state push so perception treats it as
   *  one gesture). Island-only V1 has no bulk transaction, so this stays 0 (vestigial; kept so the
   *  os:state push compiles). */
  lastBulkAt: number

  setViewport: (w: number, h: number) => void

  createSurface: (input: CreateSurfaceInput) => string
  // Adopt a persisted workspace (restore surfaces from disk). Island-only V1: the legacy camera/mode +
  // the two trailing legacy region args are accepted (the host still passes them positionally) but ignored.
  hydrate: (surfaces: Surface[], camera?: CanvasTransform, mode?: 'desktop' | 'canvas', legacyA?: number, legacyB?: number[]) => void
  focusSurface: (id: string) => void
  updateSurfaceProps: (id: string, props: Record<string, unknown>) => void
  addTab: (id: string, tab: SurfaceTab) => void
  setActiveTab: (id: string, index: number) => void
  closeTab: (id: string, tabId: string) => void
  // Open (or focus) a terminal tab: activate it if it's already a tab, else add it to the
  // existing terminal window, else open the first terminal window. The one shared seam for the live
  // terminal-spawn action, resume-on-load, and the Runtime tray's "Open" — so a terminal is in one tab.
  openTerminal: (terminalId: string, title: string, stage?: number | null) => void
  // Prune any terminal window left with zero tabs (would render blank).
  pruneEmptyTerminals: () => void
}

function defaultSize(kind: SurfaceKind): { w: number; h: number } {
  if (kind === 'native') return { w: 240, h: 240 }
  if (kind === 'srcdoc') return { w: 420, h: 320 }
  return { w: 920, h: 640 } // web, app
}

export const useDesktop = create<DesktopState>((set, get) => ({
  transform: { x: 0, y: 0, scale: 1 },
  viewport: { w: window.innerWidth, h: window.innerHeight },
  lastBulkAt: 0,
  surfaces: [],
  activeSurfaceId: null,
  osAccent: null,
  pageFullscreenId: null,

  setViewport: (w, h) => set({ viewport: { w, h } }),

  setOsAccent: (hex) => set({ osAccent: hex }),

  createSurface: (input) => {
    // Stable, unique id (Phase 0 of the workspaces design): survives serialization +
    // restart, so layout/consent can key off it. zCounter is now ONLY the surface
    // z-order allocator, never identity. (UUIDv4 here; ULID is a deferred sortable swap.)
    const id = input.id ?? crypto.randomUUID()
    const size = defaultSize(input.kind)
    const w = input.w ?? size.w
    const h = input.h ?? size.h
    const surface: Surface = {
      id,
      kind: input.kind,
      x: input.x ?? 0,
      y: input.y ?? 0,
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
  // island-only V1 has no infinite canvas.
  hydrate: (surfaces) =>
    set(() => {
      // Normalize incoming descriptors to full Surface objects (defaults for anything the
      // persisted node didn't carry), and lift the z-allocator above the restored max so
      // surfaces created after a restore land on top.
      const restored: Surface[] = surfaces.map((w) => ({ zoom: 1, props: {}, ...w, z: w.z ?? ++zCounter } as Surface))
      const maxZ = restored.reduce((m, w) => Math.max(m, w.z || 0), 0)
      zCounter = Math.max(zCounter, maxZ + 1)
      return { surfaces: restored, activeSurfaceId: null }
    }),

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

  // The legacy `stage` arg is ignored (island-only V1).
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
    // Dock into an existing terminal window if there is one, else open one.
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

  focusSurface: (id) =>
    set((s) => {
      if (!s.surfaces.some((w) => w.id === id)) return {}
      // The focused surface is the SINGLE frontmost window: raise it, flag it, and clear the flag on
      // whoever held it (only those refs change — others keep identity).
      return {
        surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, z: ++zCounter, focus: true } : w.focus ? { ...w, focus: false } : w)),
        activeSurfaceId: id
      }
    }),

  updateSurfaceProps: (id, props) =>
    set((s) => ({
      surfaces: s.surfaces.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...props } } : w))
    }))
}))
