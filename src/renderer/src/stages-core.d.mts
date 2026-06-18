// Types for the shared home-grid geometry core (stages-core.mjs) — see
// plans/blitzos-single-canvas-navigation.md. ONE bounded region ("home") on the infinite canvas.
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export const DEFAULT_VP: { w: number; h: number }
export function homeRect(vp: { w: number; h: number }): Rect
export function parkBandRect(vp: { w: number; h: number }): Rect
