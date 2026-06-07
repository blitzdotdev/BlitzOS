// The CLOSED set of OS tools a sandboxed widget may call via `blitz.tool` (consent-gated under the
// `tools` capability). This is deliberately NOT the full relay tool set: raw `eval` / `surface_control`
// scripts are excluded, and `provider_call` WRITES still hit the human approval card. ONE source, imported
// by BOTH transports (Electron widgets.ts + server backend.mjs) so the allowlist can never drift apart.
export const WIDGET_TOOLS = [
  'create_surface',
  'open_window',
  'move_surface',
  'update_surface',
  'close_surface',
  'group',
  'go_to_primary',
  'list_state',
  'provider_call'
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
