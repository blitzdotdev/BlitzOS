import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { controlWindow, type ControlAction, type ControlResult } from './cdp'

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

/**
 * Act INSIDE a surface. The single dispatch core both transports (control server
 * + agent-socket) call. Keyed on surface.kind: only `web` (a <webview> guest) is
 * CDP-controllable; `app`/`srcdoc` (iframes) and `native` (React) would be driven
 * cooperatively (postMessage / store) and aren't wired yet.
 */
export function osControlSurface(id: string, action: ControlAction): Promise<ControlResult> {
  const surf = cached.surfaces.find((s) => s.id === id)
  if (surf && surf.kind !== 'web') {
    return Promise.resolve({
      ok: false,
      error: `in-window control not supported for kind "${surf.kind}" — only "web" surfaces (app/srcdoc via postMessage planned)`
    })
  }
  // web, or state not yet synced — CDP (controlWindow errors if no guest is registered)
  return controlWindow(id, action)
}
