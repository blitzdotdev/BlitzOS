// Types for the pure home slot placer (stage-core.mjs) — see plans/blitzos-single-canvas-navigation.md.

export interface Lattice {
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
  pinned?: boolean
  minimized?: boolean
  groupId?: string | null
}

export const TILE: number
export const CARD_INSET: number
export const HOME_BUDGET: number
export const SPANS: Record<string, { c: number; r: number }>
export const SIZE_ORDER: string[]

export function spanOf(size: unknown): { c: number; r: number }
export function sizePx(size: unknown): { w: number; h: number }
export function latticeFor(vp: { w: number; h: number } | null | undefined): Lattice
export function slotRect(lat: Lattice, col: number, row: number, size: string): Rect
export function cardRect(lat: Lattice, col: number, row: number, size: string): Rect
export function slotOf(s: unknown): Slot | null
export function occupancy(surfaces: SlottedLike[], excludeId?: string | null): Set<string>
export function budgetUsed(surfaces: SlottedLike[]): number
export function findSlot(surfaces: SlottedLike[], lat: Lattice, size: string, near?: string | null, excludeId?: string | null): SlotPos | null
export function nearestFreeSlot(surfaces: SlottedLike[], lat: Lattice, size: string, wx: number, wy: number, excludeId?: string | null): SlotPos | null
export function sizeForDims(w: number, h: number): string
export function gridSummary(surfaces: SlottedLike[], vp: { w: number; h: number } | null | undefined): Record<string, unknown>
export function flowFiles(files: Array<{ id: string; w?: number; h?: number }>, surfaces: SlottedLike[], vp: { w: number; h: number } | null | undefined, avoid?: Rect | null): Array<{ id: string; x: number; y: number }>
