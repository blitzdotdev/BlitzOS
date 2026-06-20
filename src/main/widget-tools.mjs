import { serializeStateForAgent } from './os-tools.mjs'

// The CLOSED set of OS tools a sandboxed widget may call via `blitz.tool` (gated under the `tools`
// capability). This is deliberately NOT the full relay tool set: raw `eval` / `surface_control` scripts
// are excluded. ONE source, imported by BOTH transports (Electron widgets.ts + server backend.mjs) so the
// allowlist can never drift apart.
export const WIDGET_TOOLS = [
  'create_surface',
  'open_window',
  'update_surface',
  'close_surface',
  'list_state',
  'set_theme',
  'connection_call_tool',
  'connection_reconnect'
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
 * @param {object} ops — same shape os-tools.mjs documents (createSurface->id, openWindow->id,
 *   updateSurface, closeSurface, getState).
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
    set_theme: (a) => {
      if (!ops.setTheme) return { ok: false, error: 'set_theme not available in this transport' }
      return ops.setTheme({ accent: a.accent, accentDeep: a.accentDeep })
    },
    list_state: () => serializeStateForAgent(ops.getState()),
    // A representation widget may run ITS OWN connection's saved tools — and ONLY its own. The widget
    // bridge has no per-surface scoping, so we derive the connId from the CALLING surface (ctx.surfaceId)
    // and IGNORE any connection id the (untrusted) widget passes. This is the one code-executing widget
    // tool, so the scoping is load-bearing.
    connection_call_tool: async (a, ctx = {}) => {
      if (typeof ops.connectionForSurface !== 'function' || typeof ops.connectionCallTool !== 'function') throw new Error('connections not available here')
      const connId = ops.connectionForSurface(ctx && ctx.surfaceId)
      if (!connId) throw new Error('this widget is not bound to a connection')
      const name = String((a && a.name) || '')
      if (!name) throw new Error('name required')
      return ops.connectionCallTool(connId, name, (a && a.args) || {})
    },
    // The "Reconnect" button on a DISCONNECTED connection widget. Derives the source from the CALLING surface's
    // own props (connSource/connType — set when the widget was created), so it reconnects ITS source only and
    // can't be pointed elsewhere. Works on a disconnected widget (no live connection needed — it reads the surface).
    connection_reconnect: async (a, ctx = {}) => {
      if (typeof ops.connectionReconnectSource !== 'function') throw new Error('connections not available here')
      const sid = ctx && ctx.surfaceId
      if (!sid) throw new Error('no calling surface')
      const st = ops.getState ? ops.getState() : {}
      const surf = ((st && st.surfaces) || []).find((s) => s && s.id === String(sid))
      const p = (surf && surf.props) || {}
      if (!p.connSource) throw new Error('this widget is not a connection widget')
      return ops.connectionReconnectSource(String(p.connSource), p.connType === 'window' ? 'window' : 'tab')
    }
  }
}
