import { ipcMain, webContents, type WebContents } from 'electron'
import { controlSession } from './control-core.mjs'
import type { CdpSession, ControlAction, ControlResult } from './control-core.mjs'

// Re-export so existing importers (osActions, control-server, agentSocket) are unchanged.
export type { ControlAction, ControlResult } from './control-core.mjs'

/**
 * Electron adapter for in-window control of `web` surfaces (`<webview>` guests).
 * The action vocabulary lives in the shared, transport-agnostic control-core.mjs;
 * this file only owns the Electron-specific bits: mapping a surface id to its guest
 * WebContents, and the single-client `webContents.debugger` lifecycle (lazy attach,
 * idle/close detach so we never lock the user out of DevTools).
 *
 * Server mode reuses control-core.mjs verbatim with a RemoteCdpSession instead.
 */

// surfaceId -> guest <webview> webContents id (reported by the renderer)
const registry = new Map<string, number>()
// webContentsId -> idle-detach timer
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>()
const IDLE_DETACH_MS = 60_000

/** Register the IPC the renderer uses to report/withdraw web-surface guests. */
export function initCdp(): void {
  ipcMain.on('os:register-webview', (_e, surfaceId: string, webContentsId: number) => {
    registry.set(surfaceId, webContentsId)
  })
  ipcMain.on('os:unregister-webview', (_e, surfaceId: string) => {
    const wcId = registry.get(surfaceId)
    registry.delete(surfaceId)
    if (wcId !== undefined) detachById(wcId)
  })
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

export async function controlWindow(surfaceId: string, action: ControlAction): Promise<ControlResult> {
  let wc: WebContents
  try {
    wc = guestFor(surfaceId)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return controlSession(electronSession(wc), action)
}
