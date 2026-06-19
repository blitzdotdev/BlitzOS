// The CONNECTION layer — ONE shared module (like terminal-ops.mjs / action-items.mjs) so a connected
// external source (a browser TAB or a macOS WINDOW) is driven IDENTICALLY in Electron and server mode.
//
// A "connection" is a per-source TOOL PROVIDER, agent-socket-shaped: the agent reads + acts on the source
// through a small fixed verb set, saves reusable per-source scripts (a per-sourceId tools.json), and an
// agent-authored srcdoc "representation widget" is kept fresh as the source changes. NO streaming/mirroring.
//
// This module owns the REGISTRY + the per-source STORE + the DISPATCH. The only per-type code is a thin
// ADAPTER bound per connection: `{ call(verb, args) -> result, drop() }`, plus it reports "source changed"
// by calling connectionNotify(). Two adapters live elsewhere and bind through connectionBind():
//   - tab    = the Chrome extension link  (verbs: read / run_js / act)
//   - window = the BlitzComputerUse helper (verbs: read (AX/screenshot) / act (AXPress/CGEvent))
// Everything here is adapter-agnostic and unit-testable with a stub adapter (scripts/test-connections.mjs).
//
// Two ids (the doc's model): a `connId` per connection (this specific tab/window — the representation widget
// binds here) and a `sourceId` = a stable site/app identity (a tab's origin host `mail.google.com`, a
// window's bundle id `com.tinyspeck.slackmacgap`). The SAVED TOOLS key on sourceId (reused across instances
// and sessions); the connection + its widget are per-connId.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { markWrite as defaultMarkWrite } from './workspace.mjs'
import { emitConnectionMoment, setContentShare, dropContentShare } from './perception-core.mjs'

const READ_CAP = 8192 // default size cap on a read result — never dump a whole DOM/AX tree into context

// sourceId -> a filesystem-safe directory name (origin host / app bundle id are already safe-ish; harden anyway)
function safeSourceId(sourceId) {
  return String(sourceId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown'
}

// Scope + cap a read so a connection can never flood the agent's context with a whole DOM/AX tree.
function cap(value, max = READ_CAP) {
  if (value == null) return value
  let s
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s.length <= max) return value
  return { truncated: true, bytes: s.length, head: s.slice(0, max), note: `capped at ${max} bytes — narrow the selector/subtree or pass {max} to read more` }
}

/**
 * Build the connection ops bound to a runtime's surface primitives. Mirrors makeTerminalOps/makeActionItems:
 * one shared core, a tiny per-transport seam. Returned methods are Object.assign'd onto the transport's `ops`
 * (electronOps / serverOps) so the os-tools handlers + the widget bridge reach them identically.
 * @param {object} seam
 * @param {() => (string|null|undefined)} seam.getWorkspacePath  active workspace folder (store lives under it)
 * @param {(desc:object) => string} seam.createSurface           create the representation widget
 * @param {(p:string) => void} [seam.markWrite]                  workspace-watcher self-write suppression
 */
export function makeConnectionOps({
  getWorkspacePath = () => null,
  createSurface = () => null,
  updateSurface = () => {},
  closeSurface = () => {},
  getSurfaces = () => [],
  isAgentAvailable = () => false,
  markWrite = defaultMarkWrite
} = {}) {
  // connId -> { connId, type:'tab'|'window', sourceId, title, capabilities, status, surfaceId, adapter }
  const registry = new Map()
  const bySurface = new Map() // surfaceId -> connId (for per-connId widget scoping)
  const rec = (connId) => registry.get(String(connId)) || null
  let tabLink = null // the tab link (connection-tab-link.mjs) registers itself via setTabLink
  let windowLink = null // the window link (connection-window-link.ts, Electron-only) registers via setWindowLink
  let safariLink = null // the Safari link (connection-safari-link.mjs, Apple Events) registers via setSafariLink
  let installer = null // the extension force-install (connection-install.ts, Electron-only) registers via setInstaller

  // ---- per-source tool store: <workspace>/.blitzos/connections/<sourceId>/{tools.json, description} ----
  function storeDir(sourceId) {
    const ws = getWorkspacePath()
    if (!ws) return null
    return join(ws, '.blitzos', 'connections', safeSourceId(sourceId))
  }
  function readTools(sourceId) {
    const dir = storeDir(sourceId)
    if (!dir) return []
    try {
      const f = join(dir, 'tools.json')
      const arr = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }
  function writeTools(sourceId, tools) {
    const dir = storeDir(sourceId)
    if (!dir) return false
    mkdirSync(dir, { recursive: true })
    markWrite(dir)
    const f = join(dir, 'tools.json')
    writeFileSync(f, JSON.stringify(tools, null, 2))
    markWrite(f)
    return true
  }
  function readDescription(sourceId) {
    const dir = storeDir(sourceId)
    if (!dir) return ''
    try {
      const f = join(dir, 'description')
      return existsSync(f) ? readFileSync(f, 'utf8') : ''
    } catch {
      return ''
    }
  }
  function writeDescription(sourceId, text) {
    const dir = storeDir(sourceId)
    if (!dir) return false
    mkdirSync(dir, { recursive: true })
    markWrite(dir)
    const f = join(dir, 'description')
    writeFileSync(f, String(text || ''))
    markWrite(f)
    return true
  }

  // ---- the representation widget: a placeholder srcdoc the agent then authors into ----
  // Shows the source's REAL identity immediately (title + sourceId + a live badge) so it's useful the moment
  // it spawns — not a dead "loading…" card. The agent replaces this with a real summary on the connection
  // moment; until then this states plainly that it's connected and waiting for the agent (no fake spinner).
  function placeholderHtml(sourceId, type, title) {
    const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    const sid = esc(sourceId || 'source')
    const t = esc(title || sourceId || (type === 'window' ? 'window' : 'tab'))
    const kind = type === 'window' ? 'window' : 'tab'
    let agent = false
    try {
      agent = !!isAgentAvailable()
    } catch {
      agent = false
    }
    // Honest about whether an agent is actually around to author the view — never imply something is
    // "generating" when nothing is. With an agent: it will build the view. Without one: say so + how to fix.
    const footer = agent
      ? `The agent is building a live view of this ${kind} — ask it about this ${kind} in chat, or it will summarize on its own.`
      : `<b style="color:var(--blitz-accent,#e31c30)">No AI agent is running</b>, so there's no live view yet. Connect an AI (the “Connect AI” button) or start a chat — the ${kind} is connected and its tools are ready the moment an agent is.`
    // Uses the injected design-kit tokens (the OS canvas is LIGHT) so it sits among the other widgets instead
    // of being a hardcoded-dark outlier; the agent then re-authors with the same kit. No <body bg> override.
    return `<div style="font:13px/1.55 var(--blitz-font,-apple-system,system-ui,sans-serif);color:var(--blitz-text,#1a1b1d);background:var(--blitz-surface,#fff);padding:18px;box-sizing:border-box;height:100%">
<div style="display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--blitz-text-dim,#797c7f)">
  <span style="width:7px;height:7px;border-radius:50%;background:#16a34a"></span>connected ${kind}</div>
<div style="margin-top:12px;font-size:17px;font-weight:600">${t}</div>
<div style="margin-top:3px;color:var(--blitz-text-dim,#797c7f);word-break:break-all">${sid}</div>
<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--blitz-hairline,rgba(0,0,0,.1));color:var(--blitz-text-dim,#797c7f);font-size:12px">${footer}</div>
</div>`
  }

  // ---- adapter binding: an adapter calls this when the user/agent connects a source ----
  // Returns { connId, surfaceId }. Auto-creates + binds the representation widget so the connId<->surfaceId
  // link is AUTHORITATIVE (a widget can't spoof which connection it drives) and marks it content-shared.
  function connectionBind({ type, sourceId, title, capabilities, adapter } = {}) {
    const connId = 'conn_' + randomUUID().slice(0, 8)
    const sid = String(sourceId || 'unknown')
    const kind = type === 'window' ? 'window' : 'tab'
    let surfaceId = null
    // ADOPT a lingering DEAD widget for the same source instead of piling up dead cards on reconnect: reuse
    // the most recent one, repaint it live, drop any stale registry entry, and close extra duplicates. "Dead"
    // = a connection widget for this source NOT currently backing a LIVE connection — covers both same-session
    // (disconnected, still in the registry) AND across-restart (persisted surface, no registry entry). Live
    // connections to the same source (e.g. two windows) are left untouched.
    const dead = deadWidgetsForSource(sid)
    if (dead.length) {
      surfaceId = dead[dead.length - 1]
      for (const [cid, x] of registry) {
        if (x.surfaceId && dead.includes(String(x.surfaceId))) registry.delete(cid)
      }
      for (const ds of dead) {
        bySurface.delete(ds)
        if (ds !== surfaceId) {
          try {
            closeSurface(ds)
          } catch {
            /* already gone */
          }
        }
      }
      try {
        updateSurface(String(surfaceId), { html: placeholderHtml(sid, kind, title), title: title || sid, props: { connection: connId, connType: kind, connSource: sid } })
      } catch {
        /* renderer gone */
      }
    }
    // Cascade each connection's representation widget so multiple connections don't stack at the same spot
    // (every widget landing at one fixed point is invisible-overlap; observed when connecting >1 source).
    const slot = registry.size % 6
    if (!surfaceId) {
      try {
        surfaceId = createSurface({ kind: 'srcdoc', html: placeholderHtml(sid, kind, title), title: title || sid, w: 380, h: 460, x: 90 + slot * 46, y: 90 + slot * 46, props: { connection: connId, connType: kind, connSource: sid } })
      } catch {
        surfaceId = null
      }
    }
    const record = {
      connId,
      type: kind,
      sourceId: sid,
      title: title || sid,
      capabilities: capabilities && typeof capabilities === 'object' ? capabilities : kind === 'window' ? { act: true, vision: true } : { run_js: true, act: true },
      status: 'live',
      surfaceId,
      adapter: adapter || null
    }
    registry.set(connId, record)
    if (surfaceId) {
      bySurface.set(String(surfaceId), connId)
      try {
        setContentShare(String(surfaceId), true)
      } catch {
        /* perception not wired (a bare test) */
      }
    }
    emitConnectionMoment(surfaceId || 'system', { connId, sourceId: sid, status: 'live', verb: 'connected' })
    return { connId, surfaceId }
  }

  // ---- a connected tab navigated CROSS-ORIGIN: re-key the connection to the new source identity, so the
  // agent's per-source tools (tools.json) track the page the tab is actually on — never run mail.google.com's
  // tools against the OAuth page it redirected to. Same connId + widget; different sourceId. Emits a moment so
  // the agent re-briefs to the new source. No-op if the host didn't change. ----
  function connectionRekey(connId, newSourceId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const sid = String(newSourceId || '')
    if (!sid || sid === r.sourceId) return { ok: true, changed: false }
    const from = r.sourceId
    r.sourceId = sid
    // the widget's stored connSource must follow (so adoption/rehydrate match the new source) — deep-merged.
    if (r.surfaceId) {
      try {
        updateSurface(String(r.surfaceId), { props: { connSource: sid } })
      } catch {
        /* renderer gone */
      }
    }
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: sid, status: r.status, verb: `navigated: ${from} → ${sid}` })
    return { ok: true, changed: true, from, to: sid }
  }

  // ---- adapter reports a source change: significant -> immediate agent wake; churn -> silent refresh ----
  function connectionNotify(connId, { significant = true, summary = 'changed', status } = {}) {
    const r = rec(connId)
    if (!r) return
    if (status) r.status = String(status)
    if (significant) emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: r.status, verb: summary })
  }

  // ---- adapter (or the source) went away: mark the connection dead but KEEP the widget + saved tools, and
  // repaint the widget to a clear "disconnected — reconnect" state so the user isn't left with a stale card ----
  function disconnectedHtml(sourceId, type, status) {
    const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    const kind = type === 'window' ? 'window' : 'tab'
    // Same light design-kit tokens as the placeholder (the OS canvas is light) — never a hardcoded-dark outlier.
    return `<div style="font:13px/1.55 var(--blitz-font,-apple-system,system-ui,sans-serif);color:var(--blitz-text,#1a1b1d);background:var(--blitz-surface,#fff);padding:18px;box-sizing:border-box;height:100%">
<div style="display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--blitz-text-dim,#797c7f)">
  <span style="width:7px;height:7px;border-radius:50%;background:#e0a23d"></span>${esc(status || 'disconnected')}</div>
<div style="margin-top:12px;font-size:15px;font-weight:600">${esc(sourceId)}</div>
<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--blitz-hairline,rgba(0,0,0,.1));color:var(--blitz-text-dim,#797c7f);font-size:12px">This ${kind} disconnected (closed or the link dropped). Its saved tools are kept — the agent re-attaches to everything it learned once you reconnect.</div>
<button id="blitz-reconnect" style="margin-top:14px;font:13px var(--blitz-font,system-ui);background:var(--blitz-accent,#e31c30);color:var(--blitz-accent-ink,#fff);border:0;border-radius:var(--blitz-radius-sm,7px);padding:8px 14px;cursor:pointer">Reconnect ${kind}</button>
<div id="blitz-reconnect-msg" style="margin-top:8px;font-size:12px;color:var(--blitz-text-dim,#797c7f)"></div>
<script>
  document.getElementById('blitz-reconnect').onclick = async function () {
    var b = this, m = document.getElementById('blitz-reconnect-msg');
    b.disabled = true; b.textContent = 'Reconnecting…';
    try {
      var r = await window.blitz.tool('connection_reconnect', {});
      if (r && r.error) { m.textContent = r.error; b.disabled = false; b.textContent = 'Reconnect ${kind}'; }
      else { m.textContent = 'Reconnected — the agent will refresh this view.'; }
    } catch (e) { m.textContent = String(e && e.message || e); b.disabled = false; b.textContent = 'Reconnect ${kind}'; }
  };
</script>
</div>`
  }
  function connectionUnbind(connId, { status = 'disconnected' } = {}) {
    const r = rec(connId)
    if (!r) return
    r.status = String(status)
    r.adapter = null
    if (r.surfaceId) {
      try {
        updateSurface(String(r.surfaceId), { html: disconnectedHtml(r.sourceId, r.type, r.status) })
      } catch {
        /* renderer may be gone */
      }
    }
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: r.status, verb: r.status })
  }

  function capable(r, verb) {
    if (!r) return false
    const c = r.capabilities || {}
    if (verb === 'run_js') return c.run_js !== false && r.type === 'tab'
    return c[verb] !== false
  }
  async function dispatch(r, verb, args) {
    if (!r.adapter || typeof r.adapter.call !== 'function') return { error: `connection ${r.connId} has no live adapter (status: ${r.status}) — reconnect the source`, status: r.status }
    try {
      return await r.adapter.call(verb, args || {})
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }

  // ================= agent-facing ops (called by the os-tools handlers) =================

  function connectionList() {
    return {
      connections: [...registry.values()].map((r) => ({
        connId: r.connId,
        type: r.type,
        sourceId: r.sourceId,
        title: r.title,
        status: r.status,
        capabilities: r.capabilities,
        surfaceId: r.surfaceId,
        // the per-connection briefing (agents.md analog): a fresh session learns what this source already knows
        savedTools: readTools(r.sourceId).map((t) => ({ name: t.name, description: t.description, kind: t.kind })),
        description: readDescription(r.sourceId) || undefined
      }))
    }
  }

  async function connectionRead(connId, args) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const out = await dispatch(r, 'read', args || {})
    if (out && out.error) return out
    const raw = out && typeof out === 'object' && 'result' in out ? out.result : out
    // a screenshot read (window vision) returns an image — surface it as {image} like surface_control, so an
    // image-capable transport renders it to the model, never base64-as-text.
    if (raw && typeof raw === 'object' && raw.png) return { image: raw.png, width: raw.width, height: raw.height, frame: raw.frame }
    return { result: cap(raw, Number(args && args.max) || READ_CAP) }
  }

  async function connectionAct(connId, args) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const out = await dispatch(r, 'act', args || {})
    if (out && out.error) return out
    // effect-verified: surface the observed change so the agent confirms the act landed in-band
    return out && typeof out === 'object' && 'effect' in out ? { ok: true, effect: cap(out.effect) } : { ok: true, ...(out && typeof out === 'object' ? out : {}) }
  }

  async function connectionRunJs(connId, args) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    if (!capable(r, 'run_js')) return { error: 'capability_unavailable', capability: 'run_js', note: 'run_js is tab-only' }
    const out = await dispatch(r, 'run_js', args || {})
    if (out && out.error) return out
    const raw = out && typeof out === 'object' && 'result' in out ? out.result : out
    return { result: cap(raw, Number(args && args.max) || READ_CAP) }
  }

  function connectionSaveTool(connId, tool) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    if (!tool || !tool.name) return { error: 'tool.name required' }
    const kind = tool.kind === 'act' ? 'act' : 'read'
    const entry = {
      name: String(tool.name),
      description: String(tool.description || ''),
      kind,
      // a TAB tool is JS run in the page; a WINDOW tool is a recipe of AX/coordinate steps the helper runs
      ...(r.type === 'window' ? { steps: tool.steps != null ? tool.steps : tool.code } : { code: String(tool.code || '') })
    }
    const tools = readTools(r.sourceId)
    const i = tools.findIndex((t) => t.name === entry.name)
    if (i >= 0) tools[i] = entry
    else tools.push(entry)
    if (!writeTools(r.sourceId, tools)) return { error: 'no active workspace to save the tool into' }
    return { ok: true, name: entry.name, count: tools.length }
  }

  function connectionListTools(connId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    return { sourceId: r.sourceId, tools: readTools(r.sourceId), description: readDescription(r.sourceId) || undefined }
  }

  async function connectionCallTool(connId, name, args) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const tool = readTools(r.sourceId).find((t) => t.name === String(name))
    if (!tool) return { error: `no saved tool "${name}" for ${r.sourceId} — list_tools to see what exists, or save_tool to add it` }
    let out
    if (r.type === 'tab') out = await dispatch(r, 'run_js', { code: tool.code, args: args || {} })
    else out = await dispatch(r, 'act', { steps: tool.steps, args: args || {} })
    // a failed/empty saved tool = STALE (a selector rotted): tell the agent to re-derive, never return wrong data silently
    if (out && out.error) return { error: out.error, stale: true, note: 'saved tool failed — re-derive it (read the source) + connection_save_tool to replace it' }
    const effect = out && typeof out === 'object' ? ('effect' in out ? out.effect : 'result' in out ? out.result : out) : out
    if (tool.kind === 'act' && (effect == null || effect === '')) {
      return { ok: false, stale: true, note: 'saved act tool produced no effect — likely a stale selector; re-derive + connection_save_tool' }
    }
    return { ok: true, name: tool.name, effect: cap(effect) }
  }

  async function connectionDrop(connId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    try {
      if (r.adapter && typeof r.adapter.drop === 'function') await r.adapter.drop()
    } catch {
      /* best-effort teardown */
    }
    if (r.surfaceId) {
      // delete from bySurface BEFORE closing the surface, so the surface-close hook (handleSurfaceClosed)
      // finds nothing and is a no-op — no double-drop recursion.
      bySurface.delete(String(r.surfaceId))
      try {
        dropContentShare(String(r.surfaceId))
      } catch {
        /* perception not wired */
      }
    }
    registry.delete(connId)
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: 'dropped', verb: 'disconnected' })
    // an explicit drop tears down the representation widget too (no orphaned dead card on the canvas).
    if (r.surfaceId) {
      try {
        closeSurface(String(r.surfaceId))
      } catch {
        /* already gone */
      }
    }
    return { ok: true }
  }

  function connectionSetDescription(connId, text) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    return writeDescription(r.sourceId, text) ? { ok: true } : { error: 'no active workspace' }
  }

  // ---- per-connId widget scoping: a representation widget may ONLY call tools for ITS OWN connection.
  // The widget bridge has no per-surface scoping, so we derive the connId from the CALLING surface and
  // ignore any connId the (untrusted) widget passes (see widget-tools.mjs connection_call_tool handler).
  function connectionForSurface(surfaceId) {
    return bySurface.get(String(surfaceId)) || null
  }

  // All "dead" connection widgets for a source: connection widgets (props.connection) for this sourceId that
  // are NOT currently the surface of a LIVE connection. Unions same-session (a registry entry gone non-live)
  // and across-restart (a persisted surface with no registry entry). connectionBind adopts one + cleans the rest.
  function deadWidgetsForSource(sid) {
    const live = new Set([...registry.values()].filter((x) => x.status === 'live' && x.surfaceId).map((x) => String(x.surfaceId)))
    const found = []
    const seen = new Set()
    const add = (id) => {
      const s = String(id || '')
      if (s && !seen.has(s) && !live.has(s)) {
        seen.add(s)
        found.push(s)
      }
    }
    for (const x of registry.values()) {
      if (x.sourceId === sid && x.status !== 'live' && x.surfaceId) add(x.surfaceId)
    }
    try {
      for (const s of getSurfaces() || []) {
        const p = s && s.props
        if (p && p.connection && String(p.connSource) === sid) add(s.id)
      }
    } catch {
      /* getSurfaces not wired in this transport */
    }
    return found
  }
  // Is this connId a live connection? Adapters use this to DEDUP — connecting the same tab/window twice should
  // re-attach to the existing live connection, not spawn a duplicate (+ duplicate widget).
  function connectionIsLive(connId) {
    const r = rec(connId)
    return !!(r && r.status === 'live' && r.adapter)
  }
  // The public shape of a connection (for an adapter's dedup return — re-attach to an existing connection).
  function connectionInfo(connId) {
    const r = rec(connId)
    return r ? { connId: r.connId, surfaceId: r.surfaceId, sourceId: r.sourceId, type: r.type, status: r.status, reused: true } : null
  }

  // On (re)hydrate — app restart or a workspace switch — a persisted connection widget whose connection is
  // NOT live should show a "disconnected — reconnect" state instead of a stale/loading card. Returns a
  // rewritten surface (new html) for such widgets, or null to leave the surface untouched. A connection that
  // IS still live (e.g. switching back to a workspace without restarting) is left as-is.
  function rewriteHydratedSurface(surface) {
    const p = surface && surface.props
    if (!p || !p.connection) return null
    if (registry.has(String(p.connection))) return null // still live → keep the agent-authored view
    return { ...surface, html: disconnectedHtml(p.connSource || surface.title || 'source', p.connType || 'tab', 'disconnected') }
  }

  // When the user CLOSES a connection's representation widget, the connection should go with it — otherwise
  // the live adapter/socket leaks with no widget to manage it. Wired into the surface-close path (both
  // transports). The surface is already closing, so this only tears down the adapter + deregisters (it does
  // NOT re-close the surface). No-op for a normal (non-connection) surface.
  async function handleSurfaceClosed(surfaceId) {
    const connId = bySurface.get(String(surfaceId))
    if (!connId) return
    const r = rec(connId)
    bySurface.delete(String(surfaceId))
    if (!r) return
    try {
      if (r.adapter && typeof r.adapter.drop === 'function') await r.adapter.drop()
    } catch {
      /* best-effort teardown */
    }
    registry.delete(connId)
    emitConnectionMoment('system', { connId, sourceId: r.sourceId, status: 'dropped', verb: 'disconnected (widget closed)' })
  }

  // ---- the tab link (connection-tab-link.mjs) registers itself here so the agent tools can list +
  // connect the user's browser tabs transport-agnostically (Electron + server bind the link the same way). ----
  function setTabLink(link) {
    tabLink = link
  }
  function setSafariLink(link) {
    safariLink = link
  }
  // Connectable tabs = Chrome (the extension) + Safari (Apple Events), tagged by `browser`.
  async function connectionListTabs() {
    const out = []
    if (tabLink && typeof tabLink.listTabs === 'function') {
      try {
        for (const t of (await tabLink.listTabs()) || []) out.push({ ...t, browser: 'chrome' })
      } catch {
        /* extension offline */
      }
    }
    if (safariLink && typeof safariLink.listTabs === 'function') {
      try {
        for (const t of (await safariLink.listTabs()) || []) out.push({ ...t, browser: 'safari' })
      } catch {
        /* Safari not scriptable yet */
      }
    }
    if (!tabLink && !safariLink) return { error: 'no tab link — install + connect the BlitzOS Connector extension (Chrome), or enable Safari Apple Events' }
    return { tabs: out }
  }
  async function connectionConnectTab(tabId, opts) {
    const safari = (opts && opts.browser === 'safari') || String(tabId).startsWith('safari:')
    if (safari) {
      if (!safariLink || typeof safariLink.connectTab !== 'function') return { error: 'Safari link not available' }
      return safariLink.connectTab(String(tabId), opts || {})
    }
    if (!tabLink || typeof tabLink.connectTab !== 'function') return { error: 'no tab link — install + connect the BlitzOS Connector extension first' }
    if (tabId == null) return { error: 'tabId required' }
    return tabLink.connectTab(Number(tabId), opts || {})
  }
  // ---- the window link (connection-window-link.ts) registers itself the same way; window connect is
  // macOS-and-local-only (it needs the BlitzComputerUse helper's AX/CGEvent/ScreenCaptureKit). ----
  function setWindowLink(link) {
    windowLink = link
  }
  async function connectionListWindows() {
    if (!windowLink || typeof windowLink.listWindows !== 'function') return { error: 'no window link — window connect needs the BlitzComputerUse helper (macOS, local only)' }
    return windowLink.listWindows()
  }
  async function connectionConnectWindow(windowId, opts) {
    if (!windowLink || typeof windowLink.connectWindow !== 'function') return { error: 'no window link — window connect needs the BlitzComputerUse helper (macOS, local only)' }
    if (windowId == null) return { error: 'windowId required' }
    return windowLink.connectWindow(Number(windowId), opts || {})
  }
  // Reconnect a source by its sourceId — the "Reconnect" affordance on a DISCONNECTED widget. Re-finds the
  // matching tab/window (by origin host for a tab, bundle id for a window) among what's currently connectable
  // and connects it (which adopts the disconnected widget). Returns a navigable error if the source isn't open.
  async function connectionReconnectSource(sourceId, type) {
    const sid = String(sourceId || '')
    if (!sid) return { error: 'sourceId required' }
    const wantWindow = type === 'window'
    if (!wantWindow && tabLink) {
      try {
        const tabs = (await tabLink.listTabs()) || []
        const match = tabs.find((t) => {
          try {
            return new URL(t.url).host === sid
          } catch {
            return false
          }
        })
        if (match) return tabLink.connectTab(match.tabId, {})
      } catch {
        /* fall through */
      }
    }
    if (!wantWindow && safariLink) {
      try {
        const stabs = (await safariLink.listTabs()) || []
        const match = stabs.find((t) => {
          try {
            return new URL(t.url).host === sid
          } catch {
            return false
          }
        })
        if (match) return safariLink.connectTab(match.tabId, {})
      } catch {
        /* fall through */
      }
    }
    if (wantWindow && windowLink) {
      try {
        const r = await windowLink.listWindows()
        const wins = (r && r.windows) || []
        const match = wins.find((w) => String(w.bundleId) === sid || String(w.app) === sid)
        if (match) return windowLink.connectWindow(match.windowId, {})
      } catch {
        /* fall through */
      }
    }
    return { error: `couldn't find an open ${wantWindow ? 'window' : 'tab'} for ${sid} to reconnect — open it, then reconnect`, notFound: true }
  }
  function setInstaller(fn) {
    installer = fn
  }
  async function connectionInstallExtension() {
    if (typeof installer !== 'function') return { error: 'extension install is available only in the BlitzOS app (macOS, local)' }
    return installer()
  }

  return {
    // tab + window link registration + the user/agent connect entries
    setTabLink,
    setSafariLink,
    connectionListTabs,
    connectionConnectTab,
    setWindowLink,
    connectionListWindows,
    connectionConnectWindow,
    connectionReconnectSource,
    setInstaller,
    connectionInstallExtension,
    // adapter / registry API (used by the tab + window adapters and by tests)
    connectionIsLive,
    connectionInfo,
    connectionRekey,
    handleSurfaceClosed,
    rewriteHydratedSurface,
    connectionBind,
    connectionNotify,
    connectionUnbind,
    connectionForSurface,
    // agent-facing ops (called by the os-tools.mjs handlers + the widget bridge)
    connectionList,
    connectionRead,
    connectionAct,
    connectionRunJs,
    connectionSaveTool,
    connectionListTools,
    connectionCallTool,
    connectionDrop,
    connectionSetDescription
  }
}
