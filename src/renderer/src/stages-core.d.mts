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
// Stage splay lattice (plans/blitzos-stage-splay-lattice.md)
export function splayRows(layoutCount: number, numRows: number): number[]
export function stagePitchY(vp: { w: number; h: number }): number
export function splayLayout(count: number, vp: { w: number; h: number }): { rows: number[]; pitchX: number; pitchY: number; count: number }
export function splaySlotRect(orderIndex: number, count: number, vp: { w: number; h: number }): Rect
export function orderedStageRect(id: number, vp: { w: number; h: number }, order?: number[] | null, count?: number): Rect
export function addStageRect(vp: { w: number; h: number }, count: number): Rect
export function parkBandRect(id: number, vp: { w: number; h: number }, order?: number[] | null, count?: number): Rect
export function stageOfPoint(cx: number, cy: number, vp: { w: number; h: number }, order?: number[] | null, count?: number): number
export function surfaceStage(
  s: { x: number; y: number; w?: number; h?: number; slot?: unknown; slotStage?: number | null; role?: string; agentId?: string | number | null },
  vp: { w: number; h: number },
  order?: number[] | null,
  count?: number
): number
export function insertAt(order: number[], from: number, to: number): number[]
export function identityOrder(count: number): number[]
