// The WINDOW adapter (Electron + macOS-local only): connects a macOS app WINDOW into BlitzOS through the
// BlitzOS helper — AX read/act on BACKGROUND windows, plus per-window ScreenCaptureKit screenshots
// and CGEvent coordinate input for apps AX can't read. Mirrors the browser tab links: list → connect → bind a
// connection whose ADAPTER forwards verbs to the helper. The helper holds the Accessibility + Screen-Recording
// TCC grants. Window connect is intentionally Electron+local only (a remote server would need a local
// companion on the user's Mac — deferred per the design).
import { clipboard } from 'electron'
import type { ConnectionOps } from './connection-ops.mjs'

interface HelperLike {
  ensure(): Promise<{ ok: boolean; error?: string }>
  connected(): boolean
  call(cmd: string, args?: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>>
  onEvent(fn: ((m: Record<string, unknown>) => void) | null): void
}

type WindowAdapter = {
  call: (verb: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  drop?: () => void
}

export interface WindowLink {
  listWindows(): Promise<Record<string, unknown>>
  connectWindow(windowId: number, opts?: { title?: string; sourceId?: string; agentId?: string }): Promise<Record<string, unknown>>
}

export function makeWindowLink({ connectionOps, helper }: { connectionOps: ConnectionOps; helper: HelperLike }): WindowLink {
  const pidToConns = new Map<number, Set<string>>()
  const windowToConn = new Map<number, string>() // dedup: this exact window → its connection

  // an AXObserver fired for an app (pid) → wake every connection bound to that app's windows
  helper.onEvent((m) => {
    if (m && m.kind === 'ax_changed' && typeof m.pid === 'number') {
      const set = pidToConns.get(m.pid)
      if (set) for (const connId of set) connectionOps.connectionNotify(connId, { significant: true, summary: 'changed' })
    }
  })

  async function ready(): Promise<{ ok: boolean; error?: string }> {
    if (helper.connected()) return { ok: true }
    return helper.ensure()
  }

  async function listWindows(): Promise<Record<string, unknown>> {
    const e = await ready()
    if (!e.ok) return { error: e.error || 'the BlitzOS helper is not available' }
    // The helper provides the REAL macOS app icon per window (NSRunningApplication.icon → base64 PNG): it is the
    // one GUI-session process that can read it — Electron's app.getFileIcon returns a generic placeholder in dev.
    const r = await helper.call('list_windows')
    return r.error ? { error: String(r.error) } : { windows: r.windows }
  }

  async function connectWindow(windowId: number, opts: { title?: string; sourceId?: string; agentId?: string } = {}): Promise<Record<string, unknown>> {
    // DEDUP: this exact window is already connected (and live) → re-attach, don't spawn a duplicate.
    const existing = windowToConn.get(Number(windowId))
    if (existing && typeof connectionOps.connectionIsLive === 'function' && connectionOps.connectionIsLive(existing)) {
      const ops = connectionOps as unknown as {
        connectionInfo: (id: string) => Record<string, unknown> | null
        connectionSetOwner?: (id: string, agentId?: string) => unknown
      }
      const info = ops.connectionInfo(existing)
      if (info) {
        // re-attaching an already-live window from a (possibly different) chat → transfer ownership so it lists in
        // THIS chat's dropbox + wakes this chat's agent, instead of staying owned by the first chat and vanishing.
        if (typeof ops.connectionSetOwner === 'function') ops.connectionSetOwner(existing, opts.agentId)
        return { ...info, window: { windowId: Number(windowId) } }
      }
    }
    const e = await ready()
    if (!e.ok) return { error: e.error || 'the BlitzOS helper is not available' }
    const list = await helper.call('list_windows')
    const wins = Array.isArray(list.windows) ? (list.windows as Array<Record<string, unknown>>) : []
    const win = wins.find((w) => Number(w.windowId) === Number(windowId))
    if (!win) return { error: `window ${windowId} not found (is it still open?)` }
    const pid = Number(win.pid)
    const sourceId = opts.sourceId || String(win.bundleId || win.app || 'window')
    const title = opts.title || String(win.title || win.app || 'window')

    const adapter: WindowAdapter = {
      call: async (verb, args) => {
        const a = args || {}
        if (verb === 'read') {
          if (a.screenshot) return helper.call('window_screenshot', { windowId: Number(windowId) }, 15000)
          const r = await helper.call('ax_read', { pid, maxDepth: a.maxDepth ?? 12, limit: a.max ?? 600 })
          return r.error ? r : { result: r.tree }
        }
        if (verb === 'act') {
          if (a.action === 'type') return helper.call('cg_type', { text: String(a.text ?? '') })
          if (a.action === 'key') return helper.call('cg_key', { key: String(a.key ?? '') })
          // paste: put text on the system clipboard (if given) then ⌘V via the helper — sidesteps per-char cg_type
          // and AX entirely; the focused field consumes the clipboard (best for a block of text into a canvas editor)
          if (a.action === 'paste') {
            if (a.text != null) { try { clipboard.writeText(String(a.text)) } catch { /* clipboard unavailable */ } }
            return helper.call('cg_key', { key: 'cmd+v' })
          }
          // coordinate click (needs the window raised): {x,y} global points, or {px,py}+windowId pixel-in-shot
          if (a.x != null || a.px != null) return helper.call('cg_click', { windowId: Number(windowId), x: a.x, y: a.y, px: a.px, py: a.py, button: a.button })
          // ref act (background-capable): AX press / setValue on a role+title match
          const find = (a.find as Record<string, unknown>) || { role: a.role, title: a.title ?? a.selector }
          return helper.call('ax_act', { pid, find, action: a.action === 'set' ? 'setValue' : 'press', value: a.text })
        }
        if (verb === 'reveal') return helper.call('activate', { pid })
        return { error: `verb "${verb}" is not supported for a window connection` }
      }
    }

    const bound = connectionOps.connectionBind({ type: 'window', sourceId, title, capabilities: { act: true, vision: true }, adapter, ref: windowId, agentId: opts.agentId, origin: 'window' })
    if (!pidToConns.has(pid)) pidToConns.set(pid, new Set())
    pidToConns.get(pid)!.add(bound.connId)
    windowToConn.set(Number(windowId), bound.connId)
    adapter.drop = () => {
      const set = pidToConns.get(pid)
      if (set) {
        set.delete(bound.connId)
        if (!set.size) pidToConns.delete(pid)
      }
      if (windowToConn.get(Number(windowId)) === bound.connId) windowToConn.delete(Number(windowId))
    }
    // start watching for changes (the helper's AXObserver → ax_changed events → connectionNotify)
    void helper.call('ax_observe', { pid }).catch(() => {})
    return { connId: bound.connId, surfaceId: bound.surfaceId, sourceId, window: { windowId: Number(windowId), pid, app: win.app, title } }
  }

  return { listWindows, connectWindow }
}
