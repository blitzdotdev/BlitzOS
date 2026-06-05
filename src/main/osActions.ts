import { BrowserWindow, ipcMain, webContents } from 'electron'
import { randomUUID } from 'crypto'
import { controlWindow, type ControlAction, type ControlResult } from './cdp'
import { ingestSignals } from './events'

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
}

// ---- perception: inject passive SENSORS into each web surface and drain them on a
// loop into the moments coalescer (events.ts). Beyond input (key/click/input) we
// sense navigation, content change (a MutationObserver — this is what catches drag
// interactions and async loads that fire no click), and idle-after-activity. Each
// signal carries a `digest` (a text snapshot) where useful. Re-injects on navigation
// (os:webview re-fires on each dom-ready). Self-cleans when the guest is gone.

const INJECT = `(() => {
  if (window.__blitzCap) return 'present';
  window.__blitzCap = true;
  window.__blitzEvents = [];
  let lastAct = Date.now(), idleSent = true, lastHref = location.href, mt = null;
  const push = (o) => { try { o.url = location.href; o.t = Date.now(); window.__blitzEvents.push(o); if (window.__blitzEvents.length > 300) window.__blitzEvents.splice(0, 150); } catch (e) {} };
  const digest = () => { try { const m = document.querySelector('main') || document.body; return ((m && m.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 600); } catch (e) { return ''; } };
  const act = () => { lastAct = Date.now(); idleSent = false; };
  addEventListener('keydown', (e) => { act(); push({ type: 'key', key: e.key, meta: (e.metaKey || e.ctrlKey) || undefined }); }, true);
  addEventListener('click', (e) => { act(); const t = e.target; push({ type: 'click', tag: t && t.tagName, txt: ((t && t.innerText) || '').trim().slice(0, 40) }); }, true);
  addEventListener('input', (e) => { act(); const t = e.target; push({ type: 'input', tag: t && t.tagName, val: ((t && t.value) || '').slice(0, 80) }); }, true);
  // navigation (SPA pushState / hash, and full nav once re-injected on dom-ready)
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; push({ type: 'nav', title: document.title, digest: digest() }); } }, 600);
  // content change (coalesced): the general "the page changed" sensor
  try { new MutationObserver(() => { if (mt) return; mt = setTimeout(() => { mt = null; push({ type: 'content', title: document.title, digest: digest() }); }, 1200); }).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  // idle after activity: the general "user paused, good moment to react" sensor
  setInterval(() => { if (!idleSent && Date.now() - lastAct > 5000) { idleSent = true; push({ type: 'idle', idleMs: Date.now() - lastAct, title: document.title, digest: digest() }); } }, 1500);
  push({ type: 'content', title: document.title, digest: digest() }); // baseline snapshot
  return 'installed';
})()`
const DRAIN = `(window.__blitzEvents && window.__blitzEvents.splice(0)) || []`

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
/** Patch an existing surface (e.g. update a srcdoc's html, a note's text, geometry). */
export function osUpdateSurface(id: string, patch: Record<string, unknown>): void {
  send('update', { id, patch })
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
