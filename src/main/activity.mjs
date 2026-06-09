// The "Agent activity" feed — ONE definition for BOTH transports, so the on-screen
// panel that shows what the agent is doing during reply latency can NEVER diverge
// again. It lived only in preview/backend.mjs (server), so the Electron relay emitted
// no activity at all — the same class of drift relay.mjs / os-tools.mjs already killed.
//
// withActivity wraps an SDK-shaped tool array and publishes one event BEFORE each
// action tool runs; the only per-transport difference is `emit` (server: SSE
// broadcast; Electron: webContents.send('os:action', …)). The renderer consumes the
// `{type:'activity'}` event identically in both modes (App.tsx). Mirrors the
// makeOsTools(ops) / startRelay(cfg, adapter) shared-core pattern.

// Tools whose calls are surfaced in the log, so the user can SEE what the agent is
// doing during reply latency. Polls/reads that are pure noise (/events, list_state,
// list_widgets) are deliberately excluded.
export const ACTIVITY_TOOLS = new Set([
  '/open_window', '/create_surface', '/update_surface', '/move_surface', '/close_surface',
  '/surface_control', '/read_window', '/spawn_widget', '/save_widget', '/say', '/go_to_primary',
  '/group', '/provider_call', '/new_app', '/customize_widget', '/create_workspace', '/switch_workspace'
])

/** A short human label for an agent tool call, for the activity feed. */
export function activityText(path, a) {
  a = a || {}
  const host = (u) => { try { return new URL(u).hostname } catch { return String(u || '').slice(0, 40) } }
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n) + '…' : t }
  switch (path) {
    case '/open_window': return `↗ opening ${host(a.url)}`
    case '/create_surface': return `+ ${a.kind || 'surface'}${a.url ? ' ' + host(a.url) : ''}${a.title ? ' · ' + clip(a.title, 24) : a.component ? ' ' + a.component : ''}`
    case '/update_surface': return `✎ updating${a.url ? ' → ' + host(a.url) : a.title ? ' · ' + clip(a.title, 24) : ''}`
    case '/move_surface': return '⇄ moving a window'
    case '/close_surface': return '✕ closing a window'
    case '/group': return `🗂 grouping into “${clip(a.name || 'folder', 24)}”`
    case '/surface_control': return `⌖ ${a.action?.action || 'acting'}${a.action?.text ? ' “' + clip(a.action.text, 20) + '”' : a.action?.selector ? ' ' + clip(a.action.selector, 20) : ''}`
    case '/read_window': return '👁 reading the page'
    case '/provider_call': return `🔌 ${a.provider || 'integration'} ${a.method || 'GET'} ${clip(a.path, 28)}`
    case '/spawn_widget': return `▣ opening widget ${a.name || ''}`
    case '/save_widget': return `💾 saving widget ${a.name || ''}`
    case '/new_app': return `🚀 provisioning app ${a.slug || ''}`
    case '/customize_widget': return `🎨 restyling ${a.name || 'widget'}`
    case '/create_workspace': return `🗃 new workspace “${clip(a.name, 20)}”`
    case '/switch_workspace': return `↪ switching to “${clip(a.name, 20)}”`
    case '/say': return `💬 ${clip(a.text, 52)}`
    case '/go_to_primary': return '⌂ recenter'
    default: return path.replace(/^\//, '')
  }
}

/**
 * Wrap action-tool handlers so each call publishes an activity event (before running)
 * for the on-screen Agent-activity panel. Non-action tools pass through untouched.
 * @param {Array<{path:string, description?:string, input_schema?:object, handler:(ctx:{body?:string})=>unknown}>} tools  SDK-shaped tool array
 * @param {(event:{type:'activity', at:number, text:string})=>void} emit  platform publish (server: SSE broadcast; Electron: webContents.send)
 * @returns the same array with action handlers wrapped
 */
export function withActivity(tools, emit) {
  return tools.map((t) => {
    if (!ACTIVITY_TOOLS.has(t.path)) return t
    const orig = t.handler
    return {
      ...t,
      handler: (ctx) => {
        let args = {}
        try { args = ctx && ctx.body ? JSON.parse(ctx.body) : {} } catch { args = {} }
        try { emit({ type: 'activity', at: Date.now(), text: activityText(t.path, args) }) } catch { /* best-effort UI ping */ }
        return orig(ctx)
      }
    }
  })
}
