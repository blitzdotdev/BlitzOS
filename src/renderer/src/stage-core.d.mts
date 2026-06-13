// Types for the pure stage placer (stage-core.mjs) — see plans/blitzos-stage-slot-desktop.md.

export interface Lattice {
  stage: number
  cols: number
  rows: number
  x: number
  y: number
}
export interface SlotPos {
  col: number
  row: number
}
export interface Slot extends SlotPos {
  size: string
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface SlottedLike {
  id?: string
  slot?: { col: number; row: number; size: string }
  slotStage?: number
  pinned?: boolean
}

export const TILE: number
export const CARD_INSET: number
export const STAGE_BUDGET: number
export const SPANS: Record<string, { c: number; r: number }>
export const SIZE_ORDER: string[]

export function spanOf(size: unknown): { c: number; r: number }
export function sizePx(size: unknown): { w: number; h: number }
export function latticeFor(vp: { w: number; h: number } | null | undefined, stage?: number, order?: number[] | null, count?: number): Lattice
export function slotRect(lat: Lattice, col: number, row: number, size: string): Rect
export function cardRect(lat: Lattice, col: number, row: number, size: string): Rect
export function slotOf(s: unknown): Slot | null
export function occupancy(surfaces: SlottedLike[], stage?: number, excludeId?: string | null): Set<string>
export function budgetUsed(surfaces: SlottedLike[], stage?: number): number
export function findSlot(surfaces: SlottedLike[], lat: Lattice, size: string, near?: string | null, stage?: number, excludeId?: string | null): SlotPos | null
export function nearestFreeSlot(surfaces: SlottedLike[], lat: Lattice, size: string, wx: number, wy: number, stage?: number, excludeId?: string | null): SlotPos | null
export function sizeForDims(w: number, h: number): string
export function stageSummary(surfaces: SlottedLike[], vp: { w: number; h: number } | null | undefined, stage?: number): Record<string, unknown>
export function flowFiles(files: Array<{ id: string; w?: number; h?: number }>, surfaces: SlottedLike[], vp: { w: number; h: number } | null | undefined, stage?: number, avoid?: Rect | null, order?: number[] | null, count?: number): Array<{ id: string; x: number; y: number }>
