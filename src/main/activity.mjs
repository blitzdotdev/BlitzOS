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
  '/new_app', '/share_app', '/customize_widget', '/create_workspace', '/switch_workspace',
  '/connection_read', '/connection_act', '/connection_run_js', '/connection_call_tool', '/connection_save_tool', '/connection_drop'
])

/** A short human label for an agent tool call, for the activity feed. */
export function activityText(path, a) {
  a = a || {}
  const host = (u) => { try { return new URL(u).hostname } catch { return String(u || '').slice(0, 40) } }
  const text = (t) => String(t || '').replace(/\s+/g, ' ').trim()
  const safeText = (t, n = 1000) => {
    t = text(t)
    if (!t) return ''
    if (/data:image\/[a-zA-Z+.-]+;base64,/i.test(t)) return '[sent an inline image]'
    return t.length > n ? `${t.slice(0, n)} [truncated ${t.length - n} chars]` : t
  }
  switch (path) {
    case '/open_window': return `↗ opening ${host(a.url)}`
    case '/create_surface': return `+ ${a.kind || 'surface'}${a.url ? ' ' + host(a.url) : ''}${a.title ? ' · ' + safeText(a.title) : a.component ? ' ' + a.component : ''}`
    case '/update_surface': return `✎ updating${a.url ? ' → ' + host(a.url) : a.title ? ' · ' + safeText(a.title) : ''}`
    case '/move_surface': return '⇄ moving a window'
    case '/close_surface': return '✕ closing a window'
    case '/surface_control': return `⌖ ${a.action?.action || 'acting'}${a.action?.text ? ' “' + safeText(a.action.text) + '”' : a.action?.selector ? ' ' + safeText(a.action.selector) : ''}`
    case '/read_window': return '👁 reading the page'
    case '/spawn_widget': return `▣ opening widget ${safeText(a.name || '')}`
    case '/save_widget': return `💾 saving widget ${safeText(a.name || '')}`
    case '/new_app': return `🚀 provisioning app ${safeText(a.slug || '')}`
    case '/share_app': return `sharing app ${safeText(a.title || '')}`
    case '/customize_widget': return `🎨 restyling ${a.name || 'widget'}`
    case '/create_workspace': return `🗃 new workspace “${safeText(a.name)}”`
    case '/switch_workspace': return `↪ switching to “${safeText(a.name)}”`
    case '/say': return `💬 ${safeText(a.text, 4000)}`
    case '/go_to_primary': return '⌂ recenter'
    case '/connection_read': return '👁 reading a connected source'
    case '/connection_act': return `⌖ ${a.action || 'acting'} on a connected source`
    case '/connection_run_js': return '⌖ running JS in a connected tab'
    case '/connection_call_tool': return `▸ ${safeText(a.name || 'tool')} on a connection`
    case '/connection_save_tool': return `💾 saving connection tool ${safeText(a.name || '')}`
    case '/connection_drop': return '🔌 disconnecting a source'
    default: return path.replace(/^\//, '')
  }
}

function activityAgentId(a) {
  if (!a || typeof a !== 'object') return '0'
  if (a.agent != null) return String(a.agent)
  if (a.agentId != null) return String(a.agentId)
  if (a.sessionId != null) return String(a.sessionId)
  return '0'
}

/**
 * Wrap action-tool handlers so each call publishes an activity event (before running)
 * for the on-screen Agent-activity panel. Non-action tools pass through untouched.
 * @param {Array<{path:string, description?:string, input_schema?:object, handler:(ctx:{body?:string})=>unknown}>} tools  SDK-shaped tool array
 * @param {(event:{type:'activity', at:number, text:string, agentId?:string, tool?:string})=>void} emit  platform publish (server: SSE broadcast; Electron: webContents.send)
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
        try { emit({ type: 'activity', at: Date.now(), text: activityText(t.path, args), agentId: activityAgentId(args), tool: t.path }) } catch { /* best-effort UI ping */ }
        return orig(ctx)
      }
    }
  })
}
