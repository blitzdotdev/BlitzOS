import { serializeStateForAgent } from './os-tools.mjs'

// The CLOSED set of OS tools a sandboxed widget may call via `blitz.tool` (gated under the `tools`
// capability). This is deliberately NOT the full relay tool set: raw `eval` / `surface_control` scripts
// are excluded. ONE source, imported by BOTH transports (Electron widgets.ts + server backend.mjs) so the
// allowlist can never drift apart.
export const WIDGET_TOOLS = [
  'create_surface',
  'open_window',
  'move_surface',
  'update_surface',
  'close_surface',
  'go_to_primary',
  'list_state',
  'set_theme'
]

export function isWidgetTool(name) {
  return WIDGET_TOOLS.indexOf(String(name)) !== -1
}

/**
 * Build a widget-tool runner from a transport's handler map. Enforces the allowlist BEFORE dispatch,
 * normalizes the result to `{ ok, result? | error }`, and never throws. Each handler is `(args, ctx) =>
 * result` where ctx carries the originating `surfaceId` (for audit + per-surface effects). A name not in
 * WIDGET_TOOLS — or not wired in this transport — is rejected, so a widget can't reach a tool we didn't
 * intend to expose.
 */
export function makeWidgetToolRunner(handlers) {
  return async function runWidgetTool(name, args, ctx) {
    name = String(name || '')
    if (!isWidgetTool(name)) return { ok: false, error: `tool not allowed for widgets: ${name}` }
    const h = handlers[name]
    if (typeof h !== 'function') return { ok: false, error: `tool not available here: ${name}` }
    try {
      const result = await h(args && typeof args === 'object' ? args : {}, ctx || {})
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
}

/**
 * Build the widget-tool HANDLER MAP from the SAME runtime `ops` the agent registry (os-tools.mjs) binds.
 * ONE definition for both transports — Electron passes electronOps, the server passes serverOps — so the
 * widget `blitz.tool` contract (id-as-{id}, validation, list_state shape) can NOT drift
 * between desktop and server the way the two hand-written maps did. The closed allowlist is still enforced
 * by makeWidgetToolRunner; this only supplies the (subset of) handlers a widget is allowed to reach.
 * @param {object} ops — same shape os-tools.mjs documents (createSurface->id, openWindow->id, moveSurface,
 *   updateSurface, closeSurface, goToPrimary, getState).
 */
export function makeWidgetToolHandlers(ops) {
  return {
    create_surface: (a) => {
      if (!a.kind) throw new Error('kind required')
      return { id: ops.createSurface(a) }
    },
    open_window: (a) => {
      if (typeof a.url !== 'string') throw new Error('url required')
      return { id: ops.openWindow(a) }
    },
    move_surface: (a) => {
      const id = String(a.id || '')
      if (!id) throw new Error('id required')
      ops.moveSurface(id, Number(a.x) || 0, Number(a.y) || 0)
      return { ok: true }
    },
    update_surface: (a) => {
      const id = String(a.id || '')
      if (!id) throw new Error('id required')
      // accept either {id, patch:{…}} or a flat {id, url, html, …} — strip id either way
      let patch
      if (a.patch && typeof a.patch === 'object') {
        patch = a.patch
      } else {
        patch = { ...a }
        delete patch.id
      }
      ops.updateSurface(id, patch)
      return { ok: true }
    },
    close_surface: (a, ctx = {}) => {
      const explicitId = a.id != null && String(a.id)
      const id = String(explicitId || ctx.surfaceId || '')
      if (!id) throw new Error('id required')
      ops.closeSurface(id)
      return { ok: true }
    },
    go_to_primary: () => {
      ops.goToPrimary()
      return { ok: true }
    },
    set_theme: (a) => {
      if (!ops.setTheme) return { ok: false, error: 'set_theme not available in this transport' }
      return ops.setTheme({ accent: a.accent, accentDeep: a.accentDeep })
    },
    list_state: () => serializeStateForAgent(ops.getState())
  }
}
