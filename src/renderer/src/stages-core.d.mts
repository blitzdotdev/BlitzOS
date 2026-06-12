// Types for the shared stage-grid core (stages-core.mjs).
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export const DEFAULT_VP: { w: number; h: number }
export function primaryRect(vp: { w: number; h: number }): Rect
export function stageStride(vp: { w: number; h: number }): number
export function stageRect(i: number, vp: { w: number; h: number }): Rect
export function stageCenterX(i: number, vp: { w: number; h: number }): number
export function stageForAgent(agentId: string | number): number
export function stageOfX(centerX: number, vp: { w: number; h: number }): number
