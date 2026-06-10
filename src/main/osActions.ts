import { BrowserWindow, ipcMain, webContents, app } from 'electron'
import { randomUUID } from 'crypto'
import { join, dirname, basename, resolve } from 'path'
import { controlWindow, type ControlAction, type ControlResult } from './cdp'
import { dropConsent } from './widgets'
import { ingestSignals, emitSurfaceAction, emitUserMessage, setContentShare, dropContentShare, INJECT, DRAIN } from './events'
import { createWorkspaceHost } from './workspace-host.mjs'
import { safeName } from './workspace.mjs'

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
  surfaces: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; title: string; url?: string; component?: string; z?: number; props?: Record<string, unknown> }>
  camera?: { x: number; y: number; scale: number }
  view?: { cx: number; cy: number }
  mode?: string
  // #45 workspace areas: how many tiled desktops + which is active + the current one's world rect (so
  // the agent places surfaces in the area the human is looking at, not blindly at the origin).
  areaCount?: number
  currentArea?: number
  currentAreaRect?: { x: number; y: number; w: number; h: number }
  workspace?: string
  // The active workspace's absolute folder path (~/Blitz/<name>). The filesystem IS the canvas: a LOCAL
  // agent authors surfaces by writing files INTO this folder (.html=panel, .md=note, .weblink=web) and the
  // host's watcher materializes them in ~250ms. Surfaced so the agent knows WHERE to write.
  workspace_path?: string
}

let getWin: () => BrowserWindow | null = () => null
let cached: OsState = { surfaces: [] }
// The SHARED workspace host (created in initOsActions, once app paths exist) — the SAME module the
// server backend uses, so workspaces are ONE feature across both modes. Electron adapter: broadcast =
// os:action IPC; web surfaces are <webview>s the renderer owns (onSurfaces no-op); mode 'desktop'.
let wsHost: ReturnType<typeof createWorkspaceHost> | null = null
// surfaceId -> the webview guest's WebContents id (so we can read its DOM)
const webviewIds = new Map<string, number>()

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow

  // The shared workspace host. Root honors BLITZ_WORKSPACES_ROOT / BLITZ_WORKSPACE (parity with the
  // server backend), defaulting to ~/Blitz (user-browseable folders). SAME module as the server.
  const root = process.env.BLITZ_WORKSPACES_ROOT
    ? resolve(process.env.BLITZ_WORKSPACES_ROOT)
    : process.env.BLITZ_WORKSPACE
      ? dirname(resolve(process.env.BLITZ_WORKSPACE))
      : join(app.getPath('home'), 'Blitz')
  let initialName = process.env.BLITZ_WORKSPACE ? basename(resolve(process.env.BLITZ_WORKSPACE)) : 'Home'
  if (!safeName(initialName)) initialName = 'Home'
  wsHost = createWorkspaceHost({
    root,
    initialName,
    getState: () => cached,
    setState: (s) => {
      cached = s as OsState
    },
    broadcast: (obj) => getWin()?.webContents.send('os:action', obj),
    onSurfaces: () => {}, // the renderer owns its <webview>s in Electron
    defaultMode: 'canvas' // BlitzOS is canvas-first: new Electron boards open on the infinite canvas
  })
  wsHost.hydrateOnBoot()
  wsHost.startWatch()

  // Workspace launcher / Mission-Control IPC — mirrors the server's /api/os/workspace* routes.
  ipcMain.handle('workspace:list', () => ({
    workspaces: wsHost!.list().map(({ name, nodeCount, updatedAt, thumbTs }) => ({ name, nodeCount, updatedAt, thumbTs })),
    active: wsHost!.active()
  }))
  ipcMain.handle('workspace:create', (_e, name: string) => {
    try {
      return { ok: true, name: wsHost!.create(name).name }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'create failed' }
    }
  })
  ipcMain.handle('workspace:switch', async (_e, name: string) => {
    const r = await wsHost!.performSwitch(name)
    return r.status === 200 ? { ok: true, active: r.body.active } : { ok: false, error: r.body.error }
  })
  ipcMain.handle('workspace:capture', (_e, name: string) => osCaptureThumb(name))
  // The renderer pulls its hydrate once its onAction listener is mounted (race-free; absorbs the
  // teammate's request-hydrate, replacing the old main-push on did-finish-load).
  ipcMain.on('workspace:request-hydrate', () => osSendHydrate())

  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) wsHost?.onStatePush(state)
  })
  ipcMain.on('os:webview', (_e, m: { surfaceId: string; wcid: number }) => {
    if (m && m.surfaceId) {
      webviewIds.set(m.surfaceId, m.wcid)
      ensureCapture(m.surfaceId)
      ensureNavEmitter(m.surfaceId, m.wcid)
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
  // The human typed a message to the agent in the in-canvas Chat.
  ipcMain.on('os:user-message', (_e, text: unknown) => {
    if (typeof text === 'string' && text.trim()) {
      wsHost?.appendChat('user', text) // write to chat.md + echo to the chat widget
      emitUserMessage(text) // wake the agent (trigger:'message')
    }
  })
  // Capture a web surface's current frame (capturePage — no debugger) for folder previews.
  ipcMain.handle('surface:capture', async (_e, surfaceId: string) => {
    const wcid = webviewIds.get(surfaceId)
    if (wcid == null) return null
    const wc = webContents.fromId(wcid)
    if (!wc || wc.isDestroyed()) return null
    try {
      const img = await wc.capturePage()
      return img.toDataURL()
    } catch {
      return null
    }
  })
}

// ---- perception (Electron): inject the shared in-page SENSORS (INJECT, from
// perception-core via events.ts) into each <webview> guest and drain them on a loop
// into the shared moment coalescer (ingestSignals). The sensor scripts + coalescer are
// the SAME ones server mode uses (preview/backend.mjs), so there is no drift.
// Re-injects on navigation (os:webview re-fires on each dom-ready); self-cleans when
// the guest is gone.

const captureIntervals = new Map<string, ReturnType<typeof setInterval>>()

// Host-side hard-navigation sensor. A real CROSS-DOCUMENT navigation destroys the page — and
// with it the in-page sensor and its undrained signal buffer — before the 600ms href poll can
// report it; the sensor re-injected on the new page initializes lastHref to the NEW url, so
// in-page detection only ever catches SAME-document (SPA) route changes. Main is the authority
// for cross-document navs: emit the nav signal from did-navigate so "flush immediately on
// navigation" holds for ordinary link clicks too. Registration arrives on dom-ready — after the
// initial load's did-navigate — so every event seen here is a real subsequent navigation (link,
// redirect, reload), never the boot load. The pre-nav buffer (e.g. the causing click) dies with
// the page: accepted — the nav moment records the transition, and the re-injected sensor's
// baseline `content` push refreshes the snapshot on the next drain.
const navWired = new Set<number>()
function ensureNavEmitter(surfaceId: string, wcid: number): void {
  if (navWired.has(wcid)) return
  const wc = webContents.fromId(wcid)
  if (!wc || wc.isDestroyed()) return
  navWired.add(wcid)
  wc.on('did-navigate', (_e, url) => ingestSignals(surfaceId, [{ type: 'nav', url, t: Date.now() }]))
  wc.once('destroyed', () => navWired.delete(wcid))
}

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
  if (wcid == null) {
    const kind = cached.surfaces.find((s) => s.id === id)?.kind
    if (kind === 'srcdoc' || kind === 'native')
      throw new Error(
        `surface ${id} is a sandboxed ${kind} widget — read_window only works on \`web\` surfaces. To verify a widget's data, read its props from list_state, not its DOM.`
      )
    throw new Error(`surface ${id} has no readable web content yet`)
  }
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
  // Always OS-mint the id (parity with the relay backend): honoring a caller-supplied id let
  // two surfaces collide on one content-file path -> clobber on serialize.
  const id = randomUUID()
  // The agent opened this surface itself (it chose the url), so reading it back leaks
  // nothing the agent didn't pick — auto-share web/app so it can read/control what it
  // opened. Surfaces the USER opens stay private until they share (the P0 gate).
  if (desc.kind === 'web' || desc.kind === 'app') setContentShare(id, true)
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
/** Agent → user: append a chat message to chat.md and broadcast the transcript to the chat widget. */
export function osSay(text: string): void {
  wsHost?.appendChat('agent', text)
}
/** The agent customizes a built-in widget's UI (blitz-<name>.html) — currently 'chat'. Live-reloads. */
export function osCustomizeWidget(name: string, html: string): { ok: boolean; rel?: string; error?: string } {
  return wsHost ? wsHost.customizeWidget(String(name), String(html)) : { ok: false, error: 'no workspace host' }
}
/** Read a built-in widget's current UI source (workspace file or shipped default) — read-before-edit. */
export function osSystemUi(name: string): string | null {
  return wsHost ? wsHost.systemUi(String(name)) : null
}
/** #52: group surfaces into a REAL folder on disk (mkdir + mv their files into a subdir), via the shared
 *  workspace host. Returns the host result. The reconcile that follows surfaces the new folder as a tile. */
export function osGroupIntoFolder(name: string, ids: string[], x?: number, y?: number, kind?: 'board' | 'folder'): { ok: boolean; folder?: string; moved?: number; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.group(String(name || 'Folder'), Array.isArray(ids) ? ids.map(String) : [], Number(x) || 0, Number(y) || 0, kind === 'board' ? 'board' : 'folder')
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** Drop real OS paths (files AND folders) onto the canvas — the Electron drag-drop path. Copies each
 *  into the active workspace folder (a folder copies RECURSIVELY → one collapsed tile) and reconciles
 *  at the drop point so the tiles land where dropped. The browser has no FS path, so server mode uploads
 *  bytes via /api/os/upload instead. */
export function osIngestPaths(paths: string[], x: number, y: number): { ok: boolean; copied?: number; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.ingestPaths(Array.isArray(paths) ? paths.map(String) : [], Number(x) || 0, Number(y) || 0)
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** "New Folder" / "New Board" (the right-click desktop action): make an EMPTY real folder in the active
 *  workspace and reconcile at (x,y). kind:'board' → a '.board' on-canvas folder (#54). */
export function osNewFolder(name: string, kind: 'board' | 'folder' | undefined, x: number, y: number): { ok: boolean; folder?: string; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.newFolder(String(name || 'Folder'), kind === 'board' ? 'board' : 'folder', Number(x) || 0, Number(y) || 0)
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** List a normal folder's contents for the file-manager overlay (the Electron counterpart of the server
 *  /api/os/dir route — same shared host.listDir, jailed to the active workspace). */
export function osListDir(rel: string): { path: string; entries: unknown[]; total: number; truncated: boolean } | null {
  return wsHost ? wsHost.listDir(String(rel || '')) : null
}
/** CLOSE a surface = delete its backing content file (explicit by id) so it doesn't resurrect on the next
 *  reconcile. The renderer calls this from store.closeSurface for every close (user, agent, Delete key). */
export function osCloseSurfaceFile(id: string): { ok: boolean; removed?: string } {
  return wsHost ? wsHost.closeSurfaceFile(String(id)) : { ok: false }
}
/** Agent-facing workspace control (Mission-Control parity): list / create / switch the user's folder-backed
 *  workspaces (separate desktops, each its own folder = its own memory). Lets the agent give an UNRELATED
 *  task its own clean workspace and move the user there instead of polluting the current one — the SAME
 *  shared host the human's launcher uses. */
export function osListWorkspaces(): {
  workspaces: Array<{ name: string; nodeCount: number; updatedAt: number; path: string }>
  active: string
  activePath: string
  root: string
} {
  if (!wsHost) return { workspaces: [], active: '', activePath: '', root: '' }
  // activePath = ~/Blitz/<active>; its parent is the workspaces root, so every workspace's folder is
  // join(root, name). The agent uses these absolute paths to author by writing files into a workspace.
  const activePath = wsHost.activePath()
  const root = activePath ? dirname(activePath) : ''
  return {
    workspaces: wsHost.list().map(({ name, nodeCount, updatedAt }) => ({ name, nodeCount, updatedAt, path: root ? join(root, name) : '' })),
    active: wsHost.active(),
    activePath,
    root
  }
}
/** Active workspace identity + absolute folder path + a light inventory (surface titles/kinds). Threaded
 * into create_surface's RETURN so the agent sees, at the point of action: which desktop it's on, WHERE the
 * folder is (a local agent authors by writing files into it), and what's already there (clutter-vs-
 * continuation). Content-agnostic — just the inventory; the agent decides significance. */
export function osWorkspaceContext(): { workspace: string; workspace_path: string; siblings: Array<{ id: string; title: string; kind: string }> } {
  return {
    workspace: wsHost ? wsHost.active() : cached.workspace || '',
    workspace_path: wsHost ? wsHost.activePath() : '',
    siblings: (cached.surfaces || []).map((s) => ({ id: s.id, title: s.title, kind: s.kind }))
  }
}
export function osCreateWorkspace(name: string): { ok: boolean; name?: string; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  try {
    return { ok: true, name: wsHost.create(String(name || '')).name }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'create failed' }
  }
}
export async function osSwitchWorkspace(name: string): Promise<{ ok: boolean; active?: string; error?: string }> {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = await wsHost.performSwitch(String(name || ''))
  return r.status === 200
    ? { ok: true, active: r.body.active as string | undefined }
    : { ok: false, error: r.body.error as string | undefined }
}
/** #53: per-workspace consent persistence for the Electron transports (widget grants + sensitive-read
 *  providers), via the shared host. Load on boot, persist (merge) on each grant. */
export function osLoadConsent(): { surfaces: string[]; providers: string[] } {
  return wsHost ? wsHost.consent() : { surfaces: [], providers: [] }
}
export function osPersistConsent(c: { surfaces?: string[]; providers?: string[] }): void {
  wsHost?.persistConsent(c)
}
export function osGetState(): OsState {
  // Thread the active workspace identity + absolute folder PATH into every state read, so the agent always
  // knows which desktop it's on and WHERE to write files to author surfaces (the filesystem is the canvas).
  return { ...cached, workspace: wsHost ? wsHost.active() : cached.workspace, workspace_path: wsHost ? wsHost.activePath() : undefined }
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

/** Send the active workspace's hydrate to the renderer (index.ts calls this on did-finish-load). */
export function osSendHydrate(): void {
  if (!wsHost) return
  send('hydrate', { surfaces: cached.surfaces || [], camera: cached.camera || { x: 0, y: 0, scale: 1 }, mode: cached.mode || 'desktop', areaCount: cached.areaCount || 1, workspace: wsHost.active() })
}
/** Serve a workspace thumbnail by name (the blitz-thumb:// protocol handler in index.ts calls this). */
export function osReadThumb(name: string): Buffer | null {
  return wsHost ? wsHost.readThumb(name) : null
}
/** Read a real workspace file for an image preview (blitz-file:// → the active workspace, jailed). */
export function osReadWorkspaceFile(rel: string): { buf: Buffer; contentType: string } | null {
  return wsHost ? wsHost.readWorkspaceFile(rel) : null
}
/** Flush a pending workspace write + stop the folder watchers on quit. */
export function osFlushWorkspace(): void {
  wsHost?.flush()
  wsHost?.stopWatch()
}
/** Capture the primary area (1440x900, centered) of the current board → store as `name`'s thumbnail. */
async function osCaptureThumb(name: string): Promise<{ ok: boolean; error?: string }> {
  const win = getWin()
  if (!win || !wsHost) return { ok: false }
  try {
    const [w, h] = win.getContentSize()
    const pw = Math.min(1440, w)
    const ph = Math.min(900, h)
    const rect = { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2), width: pw, height: ph }
    const img = await win.webContents.capturePage(rect)
    wsHost.writeThumb(name, img.resize({ width: 480, height: 300, quality: 'good' }).toJPEG(72))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'capture failed' }
  }
}
