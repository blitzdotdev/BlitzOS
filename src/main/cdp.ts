import { ipcMain, webContents, type WebContents } from 'electron'
import { controlSession } from './control-core.mjs'
import type { CdpSession, ControlAction, ControlResult } from './control-core.mjs'

// Re-export so existing importers (osActions, control-server, agentSocket) are unchanged.
export type { ControlAction, ControlResult } from './control-core.mjs'

/**
 * Electron adapter for in-window control of `web` surfaces (`WebContentsView` guests).
 * The action vocabulary lives in the shared, transport-agnostic control-core.mjs;
 * this file only owns the Electron-specific bits: mapping a surface id to its guest
 * WebContents, and the single-client `webContents.debugger` lifecycle (lazy attach,
 * idle/close detach so we never lock the user out of DevTools).
 *
 * Server mode reuses control-core.mjs verbatim with a RemoteCdpSession instead.
 */

// surfaceId -> guest WebContents id (reported by the renderer in the legacy webview path,
// registered directly by the WebContentsView host in the current path)
const registry = new Map<string, number>()
// webContentsId -> idle-detach timer
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>()
const IDLE_DETACH_MS = 60_000

/** Register the IPC the renderer uses to report/withdraw web-surface guests. */
export function initCdp(): void {
  ipcMain.on('os:register-webview', (_e, surfaceId: string, webContentsId: number) => {
    registerCdpSurface(surfaceId, webContentsId)
  })
  ipcMain.on('os:unregister-webview', (_e, surfaceId: string) => {
    unregisterCdpSurface(surfaceId)
  })
}

export function registerCdpSurface(surfaceId: string, webContentsId: number): void {
  registry.set(surfaceId, webContentsId)
}

export function unregisterCdpSurface(surfaceId: string): void {
  const wcId = registry.get(surfaceId)
  registry.delete(surfaceId)
  if (wcId !== undefined) detachById(wcId)
}

function detachById(wcId: number): void {
  const t = idleTimers.get(wcId)
  if (t) {
    clearTimeout(t)
    idleTimers.delete(wcId)
  }
  const wc = webContents.fromId(wcId)
  try {
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    // already detached (e.g. user opened DevTools) — fine
  }
}

function guestFor(surfaceId: string): WebContents {
  const id = registry.get(surfaceId)
  if (id === undefined) throw new Error(`no web surface registered for "${surfaceId}" (only kind:'web' is CDP-controllable)`)
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) {
    registry.delete(surfaceId)
    throw new Error(`web surface "${surfaceId}" is no longer alive`)
  }
  return wc
}

function ensureAttached(wc: WebContents): void {
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)} — is DevTools open on this surface? close it to let the agent act`
      )
    }
    wc.debugger.once('detach', () => {
      const t = idleTimers.get(wc.id)
      if (t) clearTimeout(t)
      idleTimers.delete(wc.id)
    })
  }
  const prev = idleTimers.get(wc.id)
  if (prev) clearTimeout(prev)
  idleTimers.set(wc.id, setTimeout(() => detachById(wc.id), IDLE_DETACH_MS))
}

// CdpSession over a guest's debugger: lazily attach (and re-arm idle-detach) per send.
function electronSession(wc: WebContents): CdpSession {
  return {
    send: (method, params) => {
      ensureAttached(wc)
      return wc.debugger.sendCommand(method, params as Record<string, unknown> | undefined)
    }
  }
}

/** No-reflow PINCH zoom of a focused browser at (x,y) in page px (cursor-focal): Chromium re-renders the
 *  page at the new scale (SHARP), the layout never reflows, and it clamps at the page's minimum scale
 *  (1 for a desktop page) so you can't zoom out below 100%. scaleFactor>1 = zoom in. Used by the sandwich
 *  page-input router for ctrl+wheel over the FOCUSED web hole — sending the ctrl+wheel to the page instead
 *  would trigger Chromium's page-zoom, which REFLOWS the layout (not what "zoom" means). */
export async function pinchSurface(surfaceId: string, x: number, y: number, scaleFactor: number): Promise<void> {
  const wc = guestFor(surfaceId)
  ensureAttached(wc)
  await wc.debugger.sendCommand('Input.synthesizePinchGesture', { x, y, scaleFactor })
}

export async function controlWindow(surfaceId: string, action: ControlAction): Promise<ControlResult> {
  let wc: WebContents
  try {
    wc = guestFor(surfaceId)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return controlSession(electronSession(wc), action)
}
