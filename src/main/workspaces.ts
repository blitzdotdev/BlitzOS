import { BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import {
  writeWorkspace,
  readWorkspace,
  reconcileWorkspace,
  wasSelfWrite,
  listWorkspaces,
  createWorkspace,
  resolveWorkspace,
  safeName
} from './workspace.mjs'

// Electron-side wiring of the SHARED workspace serializer (the server backend wires the same
// workspace.mjs in preview/backend.mjs). A ROOT folder holds many workspace folders; the active
// one is projected to <dir>/.blitzos/workspace.json + content files on every change, restored on
// boot, and watched for EXTERNAL edits. This mirrors backend.mjs's behavior, but pushes the canvas
// to the renderer with an os:action ('hydrate' | 'switch') instead of an SSE broadcast.
//
// Persistence is a desktop superset of the (now-removed) journal: memory is just files in the
// active workspace folder. ~/Blitz is the default root; override with BLITZ_WORKSPACES_ROOT (or
// BLITZ_WORKSPACE for a single explicit folder).

interface WsSurface {
  kind?: string
  component?: string
  [k: string]: unknown
}
interface WsState {
  surfaces: WsSurface[]
  camera?: { x: number; y: number; scale: number }
  mode?: 'desktop' | 'canvas'
  view?: { cx: number; cy: number }
  workspace?: string
}

const ROOT = process.env.BLITZ_WORKSPACES_ROOT
  ? resolve(process.env.BLITZ_WORKSPACES_ROOT)
  : process.env.BLITZ_WORKSPACE
    ? dirname(resolve(process.env.BLITZ_WORKSPACE))
    : join(homedir(), 'Blitz')
let initialWs = process.env.BLITZ_WORKSPACE ? basename(resolve(process.env.BLITZ_WORKSPACE)) : 'Home'
if (!safeName(initialWs)) initialWs = 'Home'

let getWin: () => BrowserWindow | null = () => null
let activeWorkspace = ''
let osState: WsState = { surfaces: [] }
let switching = false
let writeTimer: ReturnType<typeof setTimeout> | null = null
let reconcileTimer: ReturnType<typeof setTimeout> | null = null
let watchers: FSWatcher[] = []

function send(type: string, payload: Record<string, unknown>): void {
  getWin()?.webContents.send('os:action', { type, ...payload })
}
// Chat + Agent-activity panels are runtime-only (not files), so reconcile/switch (which read from
// disk) don't know about them; carry them across so an external edit or a switch never wipes them.
function runtimePanels(): WsSurface[] {
  return (osState.surfaces || []).filter((s) => s.kind === 'native' && (s.component === 'chat' || s.component === 'activity'))
}
function flush(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (!activeWorkspace) return
  try {
    writeWorkspace(activeWorkspace, osState)
  } catch (e) {
    console.error('[workspace] write failed:', e instanceof Error ? e.message : e)
  }
}
function scheduleWrite(): void {
  // Trailing debounce: persist 500ms after activity STOPS (so a burst writes only the final state).
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, 500)
}
function scheduleReconcile(): void {
  if (reconcileTimer) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    if (switching) return
    try {
      const v = osState.view
      const r = reconcileWorkspace(activeWorkspace, v ? { cx: v.cx, cy: v.cy } : {})
      if (!r) return
      const merged = [...r.surfaces, ...runtimePanels()]
      osState = { ...osState, surfaces: merged as WsSurface[], camera: r.camera, mode: r.mode }
      send('hydrate', { surfaces: merged, camera: r.camera, mode: r.mode, workspace: basename(activeWorkspace) })
    } catch (e) {
      console.error('[workspace] reconcile failed:', e instanceof Error ? e.message : e)
    }
  }, 250)
}
function startWatch(): void {
  try {
    mkdirSync(join(activeWorkspace, '.blitzos'), { recursive: true })
  } catch {
    /* ignore */
  }
  const onEvent = (sub: string) => (_evt: string, filename: string | null): void => {
    if (!filename) {
      scheduleReconcile()
      return
    }
    if (/(^\.tmp)|(\.tmp(-[0-9a-f]+)?$)/.test(filename)) return // our atomic temp files
    if (wasSelfWrite(join(activeWorkspace, sub, filename))) return // BlitzOS's own write — ignore
    scheduleReconcile()
  }
  try {
    watchers.push(watch(activeWorkspace, onEvent(''))) // root content files
    watchers.push(watch(join(activeWorkspace, '.blitzos'), onEvent('.blitzos'))) // hand edits of workspace.json
  } catch (e) {
    console.error('[workspace] watch failed:', e instanceof Error ? e.message : e)
  }
}
function stopWatch(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  watchers = []
}

/** Renderer pushed new desktop state -> persist it to the active workspace (debounced). Drops a
 *  STALE push (mid-switch, or tagged with a workspace we already left) so it can't corrupt the new
 *  folder. */
export function workspaceOnState(state: unknown): void {
  const s = state as WsState
  if (!s || !Array.isArray(s.surfaces)) return
  const stale = switching || (typeof s.workspace === 'string' && s.workspace !== basename(activeWorkspace))
  if (stale) return
  osState = s
  scheduleWrite()
}

function list(): {
  workspaces: Array<{ name: string; nodeCount: number; updatedAt: number; thumbTs: number }>
  active: string
} {
  return {
    workspaces: listWorkspaces(ROOT).map(({ name, nodeCount, updatedAt, thumbTs }) => ({ name, nodeCount, updatedAt, thumbTs })),
    active: basename(activeWorkspace)
  }
}
function create(rawName: unknown): { ok: boolean; name?: string; error?: string } {
  try {
    const r = createWorkspace(ROOT, String(rawName ?? ''))
    return { ok: true, name: r.name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'create failed' }
  }
}
// Atomic SWITCH: persist the OLD board, stop watching it, load the NEW one, re-arm, then tell the
// renderer to swap the canvas. The `switching` lock makes the in-flight stale-push guard fire.
function switchTo(rawName: unknown): { ok: boolean; active?: string; error?: string } {
  if (switching) return { ok: false, error: 'switch in progress' }
  const name = safeName(rawName)
  if (!name) return { ok: false, error: 'invalid workspace name' }
  const newPath = resolveWorkspace(ROOT, name, { mustExist: true })
  if (!newPath) return { ok: false, error: 'no such workspace' }
  if (newPath === activeWorkspace) return { ok: true, active: name } // already here
  switching = true
  try {
    flush() // persist OLD osState -> OLD activeWorkspace (clears the pending write)
    if (reconcileTimer) {
      clearTimeout(reconcileTimer)
      reconcileTimer = null
    }
    stopWatch()
    const runtime = runtimePanels()
    activeWorkspace = newPath // load-bearing: AFTER flush (which wrote the old dir)
    const next = readWorkspace(newPath) || { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' as const }
    const surfaces = [...next.surfaces, ...runtime]
    osState = { surfaces: surfaces as WsSurface[], camera: next.camera, mode: next.mode, view: { cx: next.camera.x, cy: next.camera.y } }
    startWatch()
    send('switch', { surfaces, camera: next.camera, mode: next.mode, workspace: name })
    return { ok: true, active: name }
  } finally {
    switching = false
  }
}

// The renderer requests this once its onAction listener is mounted (avoids a boot race where a
// hydrate would fire before the listener exists). Empty workspace still reports its name so the
// toolbar shows it and the renderer's hydrate guard releases.
function sendHydrate(): void {
  send('hydrate', {
    surfaces: osState.surfaces || [],
    camera: osState.camera || { x: 0, y: 0, scale: 1 },
    mode: osState.mode || 'desktop',
    workspace: basename(activeWorkspace)
  })
}

export function initWorkspaces(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  mkdirSync(ROOT, { recursive: true })
  if (listWorkspaces(ROOT).length === 0) {
    try {
      createWorkspace(ROOT, initialWs) // first run: a default board so the user always lands somewhere
    } catch (e) {
      console.error('[workspace] first-run create failed:', e instanceof Error ? e.message : e)
    }
  }
  activeWorkspace = resolveWorkspace(ROOT, initialWs, { mustExist: true }) || join(ROOT, initialWs)
  try {
    const h = readWorkspace(activeWorkspace) // restore the persisted canvas (Phase 2)
    if (h) osState = { surfaces: h.surfaces as WsSurface[], camera: h.camera, mode: h.mode }
  } catch (e) {
    console.error('[workspace] boot read failed:', e instanceof Error ? e.message : e)
  }
  startWatch()
  ipcMain.on('workspace:request-hydrate', () => sendHydrate())
  ipcMain.handle('workspaces:list', () => list())
  ipcMain.handle('workspaces:create', (_e, name) => create(name))
  ipcMain.handle('workspaces:switch', (_e, name) => switchTo(name))
  console.log(`[workspace] root=${ROOT} active=${basename(activeWorkspace)}`)
}

/** Flush any pending write synchronously (call on app quit so the last edits aren't lost). */
export function flushWorkspaceOnQuit(): void {
  flush()
}
