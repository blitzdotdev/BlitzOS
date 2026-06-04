import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'

export type SurfaceKind = 'native' | 'srcdoc' | 'web' | 'app'

export interface SurfaceDescriptor {
  id?: string
  kind: SurfaceKind
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
  url?: string
  html?: string
  component?: string
  props?: Record<string, unknown>
}

export interface OsState {
  surfaces: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; title: string; url?: string }>
}

let getWin: () => BrowserWindow | null = () => null
let cached: OsState = { surfaces: [] }

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) cached = state
  })
}

function send(type: string, payload: Record<string, unknown> = {}): void {
  getWin()?.webContents.send('os:action', { type, ...payload })
}

/** Create any surface kind. Returns its id. */
export function osCreateSurface(desc: SurfaceDescriptor): string {
  const id = desc.id ?? randomUUID()
  send('create', { surface: { ...desc, id } })
  return id
}

/** Convenience: open a third-party site as a web surface. */
export function osOpenWindow(p: {
  url: string
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
}): string {
  return osCreateSurface({ kind: 'web', ...p })
}

export function osMoveSurface(id: string, x: number, y: number): void {
  send('move', { id, x, y })
}
export function osCloseSurface(id: string): void {
  send('close', { id })
}
export function osGoToPrimary(): void {
  send('goToPrimary')
}
export function osGetState(): OsState {
  return cached
}
