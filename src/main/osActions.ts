import { BrowserWindow, ipcMain, webContents } from 'electron'
import { randomUUID } from 'crypto'
import { controlWindow, type ControlAction, type ControlResult } from './cdp'
import { dropConsent } from './widgets'
import { ingestSignals, emitSurfaceAction, setContentShare, dropContentShare, INJECT, DRAIN } from './events'

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
// surfaceId -> the webview guest's WebContents id (so we can read its DOM)
const webviewIds = new Map<string, number>()

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) cached = state
  })
  ipcMain.on('os:webview', (_e, m: { surfaceId: string; wcid: number }) => {
    if (m && m.surfaceId) {
      webviewIds.set(m.surfaceId, m.wcid)
      ensureCapture(m.surfaceId)
    }
  })
  // A srcdoc surface fired an action back (e.g. "approve" in a triage panel).
  // Strip the envelope and emit it into the agent's event stream.
  ipcMain.on('os:surface-action', (_e, payload: Record<string, unknown>) => {
    if (!payload || typeof payload !== 'object') return
    const { surfaceId, __blitz, ...action } = payload as { surfaceId?: unknown; __blitz?: unknown } & Record<string, unknown>
    void __blitz
    emitSurfaceAction(typeof surfaceId === 'string' ? surfaceId : 'unknown', action)
  })
  // The human toggled "let the agent read this surface" (P0 content consent).
  ipcMain.on('os:content-share', (_e, m: { surfaceId?: unknown; on?: unknown }) => {
    if (m && typeof m.surfaceId === 'string') setContentShare(m.surfaceId, !!m.on)
  })
}

// ---- perception (Electron): inject the shared in-page SENSORS (INJECT, from
// perception-core via events.ts) into each <webview> guest and drain them on a loop
// into the shared moment coalescer (ingestSignals). The sensor scripts + coalescer are
// the SAME ones server mode uses (preview/backend.mjs), so there is no drift.
// Re-injects on navigation (os:webview re-fires on each dom-ready); self-cleans when
// the guest is gone.

const captureIntervals = new Map<string, ReturnType<typeof setInterval>>()

function ensureCapture(surfaceId: string): void {
  // (re)install the listener; idempotent within a page, fresh after a navigation
  osReadWindow(surfaceId, INJECT).catch(() => {})
  if (captureIntervals.has(surfaceId)) return
  const iv = setInterval(async () => {
    try {
      const raw = (await osReadWindow(surfaceId, DRAIN)) as Array<Record<string, unknown>>
      ingestSignals(surfaceId, raw)
    } catch {
      clearInterval(iv)
      captureIntervals.delete(surfaceId)
    }
  }, 350)
  captureIntervals.set(surfaceId, iv)
}

const DEFAULT_READ = `(() => {
  const ae = document.activeElement;
  const txt = (document.body && document.body.innerText || '').replace(/\\n{2,}/g,'\\n').trim();
  return {
    url: location.href,
    title: document.title,
    typingIn: ae ? { tag: ae.tagName, id: ae.id || null, cls: (ae.className||'').slice(0,80) || null, type: ae.getAttribute && ae.getAttribute('type'), value: (ae.value || ae.textContent || '').slice(0,120) } : null,
    text: txt.slice(0, 1500)
  };
})()`

/** Run JS inside a web surface and return the (JSON-serializable) result. */
export async function osReadWindow(id: string, script?: string): Promise<unknown> {
  const wcid = webviewIds.get(id)
  if (wcid == null) throw new Error(`surface ${id} has no readable web content yet`)
  const wc = webContents.fromId(wcid)
  if (!wc || wc.isDestroyed()) throw new Error(`web content for ${id} is gone`)
  return wc.executeJavaScript(script && script.trim() ? script : DEFAULT_READ, true)
}

function send(type: string, payload: Record<string, unknown> = {}): void {
  getWin()?.webContents.send('os:action', { type, ...payload })
}

/** Create any surface kind. Returns its id. */
export function osCreateSurface(desc: SurfaceDescriptor): string {
  // srcdoc ids are server-minted: a consent grant is keyed by surface id, so an
  // untrusted caller must not be able to pick one and inherit a prior grant.
  const id = desc.kind === 'srcdoc' ? randomUUID() : desc.id ?? randomUUID()
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
/** Patch an existing surface (e.g. update a srcdoc's html, a note's text, geometry). */
export function osUpdateSurface(id: string, patch: Record<string, unknown>): void {
  send('update', { id, patch })
}
export function osCloseSurface(id: string): void {
  dropConsent(id)
  dropContentShare(id)
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
