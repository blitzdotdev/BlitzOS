export interface CanvasTransform {
  x: number
  y: number
  scale: number
}

export type SurfaceKind = 'native' | 'srcdoc' | 'web' | 'app'

/**
 * A surface on the canvas. One descriptor, four renderers:
 *  - web    : live <webview> (third-party sites, even framing-blockers)
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
  /** native: which built-in component to render */
  component?: string
  /** native: component props (e.g. { text, color }) */
  props?: Record<string, unknown>
  /** A system surface the OS owns (e.g. 'chat' — a srcdoc widget backed by blitz-chat.html + chat.md).
   *  Pinned + never serialized as a node. */
  role?: string
  /** Always-on-top (chat/activity) — kept above normal windows regardless of z. */
  pinned?: boolean
  /** content zoom factor (web: webview zoom; app/srcdoc: CSS scale). default 1 */
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
}

export interface Vec2 {
  x: number
  y: number
}

export const GRID = 20
export const WIDGET_W = 240
export const WIDGET_H = 168

export type { IntegrationStatus } from '../../preload'
