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
}

export interface Vec2 {
  x: number
  y: number
}

export const PRIMARY_W = 1440
export const PRIMARY_H = 900
export const GRID = 20
export const WIDGET_W = 240
export const WIDGET_H = 168

export type { IntegrationStatus } from '../../preload'
