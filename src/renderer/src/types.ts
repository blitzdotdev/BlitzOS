export interface CanvasTransform {
  x: number
  y: number
  scale: number
}

export type SurfaceKind = 'native' | 'srcdoc' | 'web' | 'app'

/** A tab inside a tabbed window. Terminal windows hold one TERMINAL per tab; web (browser) windows
 *  hold one PAGE per tab (a main-owned WebContentsView each). */
export interface SurfaceTab {
  id: string
  title: string
  /** terminal tab → the terminal id it renders */
  terminalId?: string
  /** browser tab → its page url (persisted; favicon/loading/nav state below are runtime-only) */
  url?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

/**
 * A surface on the canvas. One descriptor, four renderers:
 *  - web    : live WebContentsView hosted by Electron main (third-party sites, even framing-blockers)
 *  - app    : <iframe src> (first-party blitz.dev apps)
 *  - srcdoc : sandboxed <iframe srcdoc> (agent-authored HTML, no backend)
 *  - native : built-in React component (post-its, tiles) by `component` name
 */
export interface Surface {
  id: string
  kind: SurfaceKind
  x: number
  y: number
  w: number
  h: number
  z: number
  title: string
  /** web, app */
  url?: string
  /** srcdoc */
  html?: string
  /** srcdoc source language. 'jsx'/'tsx' compile at mount (React + curated imports via the
   *  runtime registry); absent/'html' renders verbatim. Persists as the content file's extension. */
  lang?: 'html' | 'jsx' | 'tsx'
  /** native: which built-in component to render */
  component?: string
  /** native: component props (e.g. { text, color }) */
  props?: Record<string, unknown>
  /** A system surface the OS owns (e.g. 'chat' — a srcdoc widget backed by blitz-chat.html + chat.md).
   *  Pinned + never serialized as a node. */
  role?: string
  /** the agent this surface belongs to (a per-agent chat widget); agent N lives in stage N. */
  agentId?: string
  /** Always-on-top (chat/activity) — kept above normal windows regardless of z. */
  pinned?: boolean
  /** content zoom factor (web: WebContentsView zoom; app/srcdoc: CSS scale). default 1 */
  zoom?: number
  /** saved geometry when maximized, for restore */
  restore?: { x: number; y: number; w: number; h: number }
  /** macOS-style tiling: the floating size to pop back to when this window is dragged out of a snap. */
  preSnap?: { w: number; h: number }
  /** P0: agent may read this surface's content over the relay (default off; auto-on for agent-opened web/app). */
  shared?: boolean
  /** macOS-style minimize: hidden from the canvas (kept alive), restored from the dock. */
  minimized?: boolean
  /** Member of an iPhone-style folder (the folder surface's id). Hidden from the main canvas. */
  groupId?: string
  /** A folder member temporarily "opened" onto the desktop (still a member; not ungrouped). */
  peek?: boolean
  /** Tabbed window: content tabs in one frame (terminal windows hold a terminal per tab). Absent = a normal single window. */
  tabs?: SurfaceTab[]
  /** Active tab index (default 0). */
  activeTab?: number
  /** Stage desktop (plans/blitzos-stage-slot-desktop.md). Slotted tile: integer cell on the stage lattice. x/y/w/h are DERIVED from it (stage-core slotRect)
   *  so rendering/persistence stay unchanged; a viewport change re-derives. Absent = free-form window. */
  slot?: { col: number; row: number; size: string }
  /** Which workspace stage's lattice the slot lives on (default 0 = the primary). */
  slotStage?: number
  /** Focus window (L3): a human-pulled free-form floater above the tile grid; the one free-form exception. */
  focus?: boolean
}

export interface Vec2 {
  x: number
  y: number
}

/** A browser bookmark — machine-global (root journal), flat list keyed by url. */
export interface Bookmark {
  id: string
  url: string
  title: string
  addedAt: number
}

/** A spatial annotation (item 5b): the human right-clicks a POINT on a surface and asks the agent about
 *  it. Anchored by PERCENT of the surface (xPct/yPct) so it tracks the surface across move/resize. The
 *  question is sent to the agent (a surface-anchored moment); the bubble persists on the canvas as a
 *  grounded reference you can click to re-read. `pending` = drafting (input open, not yet sent). */
export interface Annotation {
  id: string
  surfaceId: string
  xPct: number
  yPct: number
  text: string
  ts: number
  pending?: boolean
}

export const GRID = 20
export const WIDGET_W = 240
export const WIDGET_H = 168

/** A runtime OS panel (the in-canvas Chat / Agent-activity): pinned above normal windows and never
 *  serialized as a workspace node. Centralizes the predicate previously copy-pasted across the renderer
 *  (store hydrate/reconcile, App push, SurfaceFrame z-band). */
export function isRuntimePanel(s: Pick<Surface, 'role' | 'kind' | 'component'>): boolean {
  return s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity'))
}

export type { IntegrationStatus } from '../../preload'
