export interface CanvasTransform {
  /** screen-space translation in px */
  x: number
  y: number
  /** zoom factor */
  scale: number
}

/** Window-plane item: a live web app. Free position in world px, own z, may overlap. */
export interface WinItem {
  id: string
  x: number
  y: number
  w: number
  h: number
  z: number
  title: string
  url: string
}

export interface Vec2 {
  x: number
  y: number
}

/** World-space rect for the primary space, centered on the origin. */
export const PRIMARY_W = 1440
export const PRIMARY_H = 900

/** Ground-plane grid cell size in world px. */
export const GRID = 20

/** Integration widget footprint (world px). */
export const WIDGET_W = 240
export const WIDGET_H = 168

export type { IntegrationStatus } from '../../preload'
