// Types for the shared area-grid core (areas-core.mjs).
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export const DEFAULT_VP: { w: number; h: number }
export function primaryRect(vp: { w: number; h: number }): Rect
export function areaStride(vp: { w: number; h: number }): number
export function areaRect(i: number, vp: { w: number; h: number }): Rect
export function areaCenterX(i: number, vp: { w: number; h: number }): number
export function areaForAgent(agentId: string | number): number
export function areaOfX(centerX: number, vp: { w: number; h: number }): number
