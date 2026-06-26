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
//   - window = the BlitzOS helper (verbs: read (AX/screenshot) / act (AXPress/CGEvent))
// Everything here is adapter-agnostic and unit-testable with a stub adapter (scripts/test-connections.mjs).
//
// Two ids (the doc's model): a `connId` per connection (this specific tab/window — the representation widget
// binds here) and a `sourceId` = a stable site/app identity (a tab's origin host `mail.google.com`, a
// window's bundle id `com.tinyspeck.slackmacgap`). The SAVED TOOLS key on sourceId (reused across instances
// and sessions); the connection + its widget are per-connId.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { markWrite as defaultMarkWrite } from './workspace.mjs'
import { emitConnectionMoment, setContentShare, dropContentShare } from './perception-core.mjs'
import { detectMcp } from './mcp-detect.mjs'
import { dcrRegister, startLoopback, refresh as mcpRefresh, mcpInitialize, mcpListTools, mcpCallTool } from './mcp-broker.mjs'
import { saveTokens, loadTokens, clearTokens, listSources as listMcpSources } from './mcp-token-store.mjs'

const READ_CAP = 8192 // default size cap on a read result — never dump a whole DOM/AX tree into context

// sourceId -> a filesystem-safe directory name. A readable prefix + a hash of the RAW id, so: (1) the result
// can NEVER be a path-traversal segment ('..', '.', '', or contain '/') — the hash suffix guarantees a valid
// non-empty name with no dots; and (2) distinct sources never COLLIDE onto one tools.json (e.g. 'a/b' vs 'a_b'
// both sanitize to 'a_b' but get different hashes). Don't reuse '.' in the dir name at all (dots -> '_').
function safeSourceId(sourceId) {
  const raw = String(sourceId || 'unknown')
  const prefix = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'src'
  return prefix + '-' + createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

// Scope + cap a read so a connection can never flood the agent's context with a whole DOM/AX tree.
function cap(value, max = READ_CAP) {
  if (value == null) return value
  const note = `capped at ${max} bytes — narrow the selector/subtree or pass {max} to read more`
  // A plain string (e.g. run_js returning text): return a clean text prefix.
  if (typeof value === 'string') {
    return value.length <= max ? value : { truncated: true, bytes: value.length, text: value.slice(0, max), note }
  }
  let s
  try {
    s = JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s.length <= max) return value
  // A structured read ({url,title,text} or {...,text}) that's too big: truncate the TEXT field IN PLACE so the
  // agent still gets clean structure (url/title/role intact), not a half-JSON blob — BUT only if the non-text
  // fields alone fit. If a non-text field (a huge url/href/attribute) is itself over the cap, truncating text
  // can't help, so fall through to the labeled preview rather than returning a still-oversized object.
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    const overhead = s.length - value.text.length // bytes of everything EXCEPT the text field's content
    if (overhead <= max) {
      const keep = Math.max(0, value.text.length - (s.length - max))
      return { ...value, text: value.text.slice(0, keep), truncated: true, bytes: s.length, note }
    }
  }
  // Any other too-big object (a deep AX/DOM tree, or a structured read whose non-text fields blow the cap):
  // a LABELED preview string — never a `head` that looks like it should be parsed as data, and ALWAYS within
  // the cap. The agent narrows the read instead of trusting a truncated dump.
  return { truncated: true, bytes: s.length, preview: s.slice(0, max), note }
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
  markWrite = defaultMarkWrite,
  // the first-party tool registry (plans/connection-tool-registry.md): a standalone HTTP service we host,
  // open-read. Configured via BLITZ_TOOL_REGISTRY_URL; unset = the registry tools report "not configured".
  registryUrl = process.env.BLITZ_TOOL_REGISTRY_URL || '',
  fetchImpl = (...a) => globalThis.fetch(...a),
  // the MCP detection registry (plans/blitzos-mcp-connections.md): a curated sourceId->endpoint map for
  // sites that don't self-advertise /.well-known/mcp.json. Unset = only the well-known tier-1 probe runs.
  mcpRegistryUrl = process.env.BLITZ_MCP_REGISTRY_URL || process.env.BLITZ_TOOL_REGISTRY_URL || '',
  // Open a URL in the user's browser for the ONE-TIME MCP OAuth approval (Electron: shell.openExternal). BlitzOS
  // owns this UX — connectMcp opens the authorize URL itself, then awaits the loopback catch. Default no-op so
  // server mode / tests don't try to spawn a browser; the authUrl is ALSO returned so the UI can surface it.
  openExternal = () => {}
} = {}) {
  // connId -> { connId, type:'tab'|'window', sourceId, title, capabilities, status, surfaceId, adapter }
  const registry = new Map()
  const bySurface = new Map() // surfaceId -> connId (for per-connId widget scoping)
  const registryCache = new Map() // sourceId -> [{name,description,kind}] available in the first-party registry
  const rec = (connId) => registry.get(String(connId)) || null
  let windowLink = null // the window link (connection-window-link.ts, Electron-only) registers via setWindowLink
  let safariLink = null // the Safari link (connection-safari-link.mjs, Apple Events) registers via setSafariLink
  let chromeAsLink = null // the Chrome Apple-Events link (connection-chrome-applescript-link.mjs) — Chrome tabs, extension-free

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
  function connectionBind({ type, sourceId, title, capabilities, adapter, ref, agentId, origin } = {}) {
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
        updateSurface(String(surfaceId), { html: placeholderHtml(sid, kind, title), title: title || sid, props: { connection: connId, connType: kind, connSource: sid, connAgent: agentId != null ? String(agentId) : '' } })
      } catch {
        /* renderer gone */
      }
    }
    // Cascade each connection's representation widget so multiple connections don't stack at the same spot
    // (every widget landing at one fixed point is invisible-overlap; observed when connecting >1 source).
    const slot = registry.size % 6
    if (!surfaceId) {
      try {
        surfaceId = createSurface({ kind: 'srcdoc', html: placeholderHtml(sid, kind, title), title: title || sid, w: 380, h: 460, x: 90 + slot * 46, y: 90 + slot * 46, props: { connection: connId, connType: kind, connSource: sid, connAgent: agentId != null ? String(agentId) : '' } })
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
      adapter: adapter || null,
      // the connectable's id (chrome tab id / safari tabId / window id) — lets the renderer mark the EXACT source connected
      ref: ref ?? null,
      // the chat session that attached this source ('' = attached on the new-session composer, reassigned on spawn).
      // The owner scopes connection_list per chat + targets the attach moment (self-reported, like /events + /say).
      agentId: agentId != null ? String(agentId) : '',
      // origin = WHOSE source this is, so the agent works in a source the USER attached instead of defaulting to its
      // own Blitz Chrome: 'user-chrome'/'user-safari' = the user's own browser they connected (act in THEIR session);
      // 'window' = a native macOS app; 'blitz-chrome' = the agent's own browser (only when the user gave it no source).
      origin: origin || (kind === 'window' ? 'window' : undefined)
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
    emitConnectionMoment(surfaceId || 'system', { connId, sourceId: sid, status: 'live', verb: 'connected', agentId: record.agentId || '0' })
    // Warm the registry-availability cache (fire-and-forget) so the agent's connection_list briefing SHOWS the
    // vetted tools that exist for this source — instead of the registry being invisible-until-queried (the
    // reason agents re-derive from scratch). If tools exist, it wakes the agent once with the names.
    void refreshRegistryForSource(sid, connId)
    // Probe whether this freshly-connected source has an official integration to UNLOCK. When detection LANDS a
    // lockable one, WAKE the connecting agent with a moment so it can offer to unlock it — never blocks the connect,
    // and crucially does NOT rely on the agent polling connection_list_tools, which races the network probe (the
    // reason a freshly-connected Figma/Notion tab showed no `unlock` and the agent just drove the page). The cache
    // also still feeds `unlock` on a later list_tools. MCP-FREE verb; skipped if already unlocked (live). Promise.resolve
    // normalizes ensureMcpDetected's return (a fresh cache hit is a plain object, a cold/stale probe is a promise).
    Promise.resolve(ensureMcpDetected(sid))
      .then((d) => {
        if (d && d.available && d.dcr && !liveMcpForSource(sid)) {
          emitConnectionMoment(surfaceId || 'system', { connId, sourceId: sid, status: 'live', verb: `has an official integration — connection_unlock { sourceId: '${sid}' } to unlock its tools`, agentId: record.agentId || '0' })
        }
      })
      .catch(() => { /* a detection failure already caches a negative; nothing to surface */ })
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
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: sid, status: r.status, verb: `navigated: ${from} → ${sid}`, agentId: r.agentId || '0' })
    void refreshRegistryForSource(sid, connId) // the new host may have its own vetted registry tools
    return { ok: true, changed: true, from, to: sid }
  }

  // ---- adapter reports a source change: significant -> immediate agent wake; churn -> silent refresh ----
  function connectionNotify(connId, { significant = true, summary = 'changed', status } = {}) {
    const r = rec(connId)
    if (!r) return
    if (status) r.status = String(status)
    if (significant) emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: r.status, verb: summary, agentId: r.agentId || '0' })
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
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: r.status, verb: r.status, agentId: r.agentId || '0' })
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

  // ============ MCP broker connections — an INVISIBLE tool provenance (plans/blitzos-mcp-connections.md) ============
  // MCP is NOT an agent-visible connection kind. A source's "official integration" is brokered through a HIDDEN
  // kind:'mcp' connection (BlitzOS is the upstream MCP client + OAuth owner); the agent only ever sees the source's
  // toolkit (connection_list_tools merges the banked-JS tools with this hidden connection's upstream tools) and an
  // optional `unlock` affordance. The hidden mcp connection is FILTERED OUT of connectionList. Exactly ONE hidden
  // mcp connection exists per sourceId (idempotent). The OAuth tokens live in the encrypted per-(workspace,sourceId)
  // token store; BlitzOS refreshes them silently. The record carries the OAuth metadata it needs to refresh
  // (asMeta + clientId + clientSecret), never written into context.

  // The persisted token bundle for an MCP source (the broker's auth state). The agent NEVER sees this — it is
  // loaded only to mint a live access token for an upstream call. Re-detect would re-discover asMeta, but we
  // store it so a refresh never needs the network detection round-trip (and works if the source briefly 404s).
  function mcpDir() {
    return getWorkspacePath() || null
  }

  // The HIDDEN mcp connection for a sourceId, if one exists. There is at most one (the connect path is idempotent
  // per sourceId). Used to merge its upstream tools into connection_list_tools and to route connection_call_tool.
  function mcpConnForSource(sid) {
    const want = String(sid || '')
    for (const r of registry.values()) {
      if (r.kind === 'mcp' && r.sourceId === want) return r
    }
    return null
  }
  // A LIVE hidden mcp connection (handshake done, upstream tools cached) for a sourceId. A pending/error/reauth one
  // exists but has no usable tools yet — treated as "not live" for both the merge and the lockable check.
  function liveMcpForSource(sid) {
    const r = mcpConnForSource(sid)
    return r && r.status === 'live' ? r : null
  }

  // ---- detection cache (the `unlock` affordance) -------------------------------------------------------------
  // A per-sourceId cache of detectMcp() so connection_list_tools can SYNCHRONOUSLY decide whether a source has an
  // official integration to unlock, without re-probing the network on every list. `ensureMcpDetected` runs the
  // detection once, dedupes concurrent calls per sourceId (a single in-flight promise), and stores the result. A
  // sourceId is "lockable" iff it advertises a DCR-eligible integration AND no LIVE hidden mcp connection exists
  // for it yet (once unlocked, its tools move into `tools` and the unlock entry disappears).
  const DETECT_CACHE_TTL_MS = 10 * 60 * 1000 // re-probe a source at most every 10 min (detectMcp itself also TTLs) so
  // a source that GAINS an integration mid-session, or a transient detection failure, isn't stuck on a negative for
  // the whole process lifetime — bounded staleness, not permanent.
  const detectCache = new Map() // sourceId -> { available, dcr, endpoint, asMeta, scopes, at }
  const detectInFlight = new Map() // sourceId -> Promise (dedupe concurrent detection)
  async function ensureMcpDetected(sourceId) {
    const sid = String(sourceId || '').trim()
    if (!sid) return null
    const hit = detectCache.get(sid)
    if (hit && Date.now() - hit.at < DETECT_CACHE_TTL_MS) return hit
    if (detectInFlight.has(sid)) return detectInFlight.get(sid)
    const p = (async () => {
      let entry
      try {
        // NO registryUrl — the runtime cascade (well-known → exceptions → mcp.<domain> convention) resolves the
        // common providers with zero curated data; the optional remote registry is only for connectMcp's explicit flow.
        const det = await detectMcp(sid)
        entry = { available: !!(det && det.available), dcr: !!(det && det.dcr), endpoint: det && det.endpoint, asMeta: det && det.asMeta, scopes: det && det.scopes, at: Date.now() }
      } catch {
        // A detection failure caches a negative so we don't re-probe a dead/slow host on every list_tools; a real
        // unlock attempt (connection_unlock) re-runs detectMcp fresh and surfaces the true error there.
        entry = { available: false, dcr: false, at: Date.now() }
      }
      detectCache.set(sid, entry)
      detectInFlight.delete(sid)
      return entry
    })()
    detectInFlight.set(sid, p)
    return p
  }
  // SYNC: is this sourceId lockable per the cache? available + dcr (an integration we can self-register for) and no
  // LIVE hidden mcp connection yet. Returns false when the cache has no entry (the caller fires ensureMcpDetected).
  function isLockableCached(sid) {
    const e = detectCache.get(String(sid || ''))
    if (!e || !e.available || !e.dcr) return false
    return !liveMcpForSource(sid)
  }

  // Mint a live access token for an MCP connection: load the stored tokens, refresh if expired (rotating the
  // stored refresh_token when the AS issues a new one), and return the bearer string. Returns { error } when
  // there are no tokens (re-auth needed) or a refresh fails — NEVER a stale/empty token silently.
  //
  // `force` drives a REACTIVE refresh (from the 401 path below): an upstream that 401s with a non-expired (or
  // unknown-expiry) token has had it revoked/invalidated server-side, so we refresh regardless of expires_at.
  async function mcpLiveToken(r, { force = false } = {}) {
    const ws = mcpDir()
    if (!ws) return { error: `no active workspace to read ${r.sourceId} access from` }
    const tok = loadTokens(ws, r.sourceId)
    if (!tok || !tok.access_token) return { error: `${r.sourceId} isn't approved — connection_unlock { sourceId: '${r.sourceId}' } to approve it`, reauth: true }
    // Refresh PROACTIVELY when expires_at has passed (absolute epoch-ms, shaved 60s by the broker), OR
    // REACTIVELY when forced (a 401 came back, so the token is dead even if not nominally expired). When expiry
    // is unknown (no expires_in was issued) we don't refresh proactively — we try the token and let a 401 drive
    // the reactive path. We need a refresh_token to refresh at all.
    const expired = typeof tok.expires_at === 'number' && Date.now() >= tok.expires_at
    if (expired || force) {
      if (!tok.refresh_token) return { error: `${r.sourceId} access expired and can't auto-renew — connection_unlock { sourceId: '${r.sourceId}' } to re-approve`, reauth: true }
      let fresh
      try {
        // RFC 8707: carry the resource (the MCP endpoint) so the refreshed token keeps the same audience binding.
        fresh = await mcpRefresh({ asMeta: tok.asMeta || r.asMeta, clientId: tok.client_id || r.clientId, clientSecret: tok.client_secret || r.clientSecret, refresh_token: tok.refresh_token, resource: tok.endpoint || r.endpoint })
      } catch (e) {
        return { error: `${r.sourceId} access expired — connection_unlock { sourceId: '${r.sourceId}' } to re-approve: ${String((e && e.message) || e)}`, reauth: true }
      }
      const merged = {
        ...tok,
        access_token: fresh.access_token,
        // rotation: keep the new refresh_token when the AS rotated it, else retain the old (still valid) one
        refresh_token: fresh.refresh_token || tok.refresh_token,
        expires_at: fresh.expires_at
      }
      const saved = saveTokens(ws, r.sourceId, merged)
      if (saved && saved.error) return { error: `couldn't save renewed ${r.sourceId} access: ${saved.error}` }
      return { access_token: merged.access_token, refreshed: true }
    }
    return { access_token: tok.access_token }
  }

  // Build the in-memory MCP registry record (shared by the live-connect, post-auth, and rehydrate paths). The
  // OAuth metadata (asMeta + clientId + clientSecret) rides along so a later refresh never needs the network
  // detection round-trip; it is NEVER returned to the agent (connectionList projects only safe fields).
  function makeMcpRecord({ connId, sid, det, reg, status, tools = [], agentId }) {
    return {
      connId,
      type: 'mcp',
      kind: 'mcp',
      sourceId: sid,
      title: sid,
      endpoint: det.endpoint,
      authServer: det.authServer,
      asMeta: det.asMeta,
      clientId: reg.client_id,
      clientSecret: reg.client_secret,
      scopes: det.scopes,
      status,
      surfaceId: null,
      capabilities: { mcp: true },
      // a cached copy of the upstream tool list for connection_list_tools (refreshed live on each call_tool)
      tools,
      ref: null,
      agentId: agentId != null ? String(agentId) : ''
    }
  }

  // initialize + tools/list against the upstream MCP server with a live token, returning the REAL tool set
  // (never a guessed/empty list). Throws on a handshake failure so the caller can mark the connection 'error'.
  async function mcpHandshakeTools(endpoint, accessToken) {
    const init = await mcpInitialize(endpoint, accessToken)
    const upstreamTools = await mcpListTools(endpoint, accessToken, init.session)
    // Defensive: drop nameless tools and de-dupe by name. The MCP spec mandates unique names, but a malformed server
    // must not inject a {name:undefined} the agent can't call, nor a duplicate that could shadow a banked JS tool.
    const seen = new Set()
    return (Array.isArray(upstreamTools) ? upstreamTools : [])
      .filter((t) => t && typeof t.name === 'string' && t.name && !seen.has(t.name) && seen.add(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }

  // Finalize a connection from STORED tokens: mint a live token (refreshing if needed), handshake, and register
  // the record. Returns { ok, connId, status, tools } or { ok:false, ... }. Used by the token-reuse short-circuit,
  // the post-auth resolution, and boot rehydrate — so all three land an identical 'live' (or 'error') record.
  // `connId` may be supplied (to fill a pending record in place) or minted fresh. Moment verbs are MCP-FREE — the
  // hidden connection is invisible to the agent, so its moments read as the SOURCE'S toolkit unlocking, never "MCP".
  async function finalizeMcpFromTokens({ sid, det, reg, agentId, connId, verb = `unlocked ${sid} tools` }) {
    const cid = connId || 'mcp_' + randomUUID().slice(0, 8)
    const probe = makeMcpRecord({ connId: cid, sid, det, reg, status: 'live', tools: [], agentId })
    const tok = await mcpLiveToken(probe)
    if (tok.error) {
      const rec = makeMcpRecord({ connId: cid, sid, det, reg, status: tok.reauth ? 'reauth' : 'error', tools: [], agentId })
      registry.set(cid, rec)
      emitConnectionMoment('system', { connId: cid, sourceId: sid, status: rec.status, verb: rec.status === 'reauth' ? `${sid} needs approval again` : `couldn't unlock ${sid} tools`, agentId: rec.agentId || '0' })
      return { ok: false, connId: cid, status: rec.status, error: tok.error, reauth: !!tok.reauth }
    }
    let tools
    try {
      tools = await mcpHandshakeTools(det.endpoint, tok.access_token)
    } catch (e) {
      // Valid tokens but the handshake failed — keep the tokens (a retry won't re-auth) and surface the real
      // error. Registered 'error' so connection_list_tools' merge simply omits it (still hidden) and a retry works.
      const rec = makeMcpRecord({ connId: cid, sid, det, reg, status: 'error', tools: [], agentId })
      registry.set(cid, rec)
      emitConnectionMoment('system', { connId: cid, sourceId: sid, status: 'error', verb: `couldn't unlock ${sid} tools`, agentId: rec.agentId || '0' })
      return { ok: false, connId: cid, status: 'error', error: `unlocking ${sid} tools failed: ${String((e && e.message) || e)}` }
    }
    const rec = makeMcpRecord({ connId: cid, sid, det, reg, status: 'live', tools, agentId })
    registry.set(cid, rec)
    emitConnectionMoment('system', { connId: cid, sourceId: sid, status: 'live', verb, agentId: rec.agentId || '0' })
    return { ok: true, connId: cid, status: 'live', tools }
  }

  // connectMcp — the UNDERLYING op behind the agent-facing /connection_unlock. NON-BLOCKING two-phase OAuth
  // (plans/blitzos-mcp-connections.md). Idempotent per sourceId: if a LIVE hidden mcp connection already exists,
  // return it (its tools are already in the toolkit). Else detect -> if a stored token bundle exists, REUSE it (no
  // DCR, no human step, the tools appear immediately) -> else bind the loopback port FIRST, DCR with that EXACT
  // redirect_uri, arm the authorize URL, register a HIDDEN 'pending' record, and RETURN { ok, status, authUrl,
  // source } IMMEDIATELY so the island can render the "approve <Source>" card and server mode can surface the URL
  // while approval is still pending. The human approval resolves on a SEPARATE path (waitForTokens): it persists
  // the tokens, handshakes, flips the record to 'live' (or 'error'/'reauth'), and emits a connection moment so the
  // agent learns its toolkit grew via /events. The call NEVER blocks up to LOOPBACK_TIMEOUT_MS. All agent-facing
  // text here is MCP-FREE (the hidden connection is invisible) — errors/verbs talk about the SOURCE's integration.
  async function connectMcp({ sourceId, agentId, workspaceDir } = {}) {
    const sid = String(sourceId || '').trim()
    if (!sid) return { ok: false, error: 'sourceId required (a site host like www.notion.com)', source: sid }
    const ws = workspaceDir != null && String(workspaceDir) ? String(workspaceDir) : mcpDir()
    if (!ws) return { ok: false, error: `no active workspace to store ${sid} access into`, source: sid }

    // 0) IDEMPOTENT — a LIVE hidden connection for this source already brokers its integration; its tools are in the
    // toolkit. Nothing to do (no second OAuth, no second hidden connection). The agent just keeps using its tools.
    {
      const existing = mcpConnForSource(sid)
      if (existing && existing.status === 'live') return { ok: true, connId: existing.connId, status: 'live', tools: existing.tools || [], source: sid, reused: true }
      // A PENDING flow is already in progress (the doctrine has the agent retry while pending) — return THAT same
      // flow's authUrl, never start a second OAuth (no duplicate browser tab / loopback / orphaned record). A
      // timed-out or denied pending has already flipped to 'error' via the waitForTokens .catch, so it falls through.
      if (existing && existing.status === 'pending') return { ok: true, connId: existing.connId, status: 'pending', authUrl: existing.authUrl, source: sid, reused: true }
    }

    // 1) detect — only proceed for a DCR-eligible official integration (the broker can't self-register otherwise).
    let det
    try {
      det = await detectMcp(sid, mcpRegistryUrl ? { registryUrl: mcpRegistryUrl } : {})
    } catch (e) {
      return { ok: false, error: `couldn't check ${sid}'s official integration: ${String((e && e.message) || e)}`, source: sid }
    }
    // Keep the detection cache in step with this fresh probe so the `unlock` affordance stays consistent.
    detectCache.set(sid, { available: !!(det && det.available), dcr: !!(det && det.dcr), endpoint: det && det.endpoint, asMeta: det && det.asMeta, scopes: det && det.scopes, at: Date.now() })
    if (!det || !det.available) return { ok: false, error: `${sid} has no official integration we can unlock`, available: false, source: sid }
    if (!det.dcr || !det.asMeta || !det.asMeta.registration_endpoint) {
      // Honest, specific failure — not a silent no-op. Non-DCR providers (e.g. Google) are deferred until
      // BlitzOS ships a pre-registered verified app (see the plan's scope).
      return { ok: false, error: `${sid}'s official integration can't be unlocked automatically yet (use the browser/connection_run_js path instead)`, available: true, dcr: false, source: sid }
    }

    // 2) TOKEN REUSE — if this source was already approved (a stored bundle with a usable token/refresh exists),
    // skip DCR + the browser entirely: mint a token (refreshing if needed), handshake, register 'live'. This is
    // what makes the encrypted token store actually pay off — a reconnect of an approved source needs NO human
    // step and reuses the kept refresh_token instead of registering a brand-new DCR client.
    {
      const tok = loadTokens(ws, sid)
      if (tok && (tok.refresh_token || tok.access_token)) {
        // Reuse the stored DCR client_id/secret (so refresh authenticates as the same client the token was issued to).
        const reg = { client_id: tok.client_id, client_secret: tok.client_secret }
        const det2 = { ...det, endpoint: tok.endpoint || det.endpoint, asMeta: tok.asMeta || det.asMeta }
        const out = await finalizeMcpFromTokens({ sid, det: det2, reg, agentId, verb: `unlocked ${sid} tools` })
        // A live reuse (or a clean error/reauth that the agent can act on) is the answer. Only fall through to a
        // fresh OAuth flow when there were tokens but they're unusable AND non-refreshable (reauth) — handled by
        // returning the reauth result so the agent can re-run connect (which then re-auths below on next call).
        if (out.ok) return { ok: true, connId: out.connId, status: 'live', tools: out.tools, source: sid, reused: true }
        if (!out.reauth) return { ok: false, connId: out.connId, status: out.status, error: out.error, source: sid }
        // reauth: tokens are dead beyond refresh — clear them and fall through to a fresh approval.
        try {
          clearTokens(ws, sid)
        } catch {
          /* best-effort; the fresh flow overwrites them anyway */
        }
      }
    }

    // 3) FRESH FLOW. Bind the loopback port FIRST so the registered redirect_uri EXACTLY matches the one used at
    // authorize + exchange (RFC 8252 §7.3 only RECOMMENDS port-insensitive loopback matching; strict ASes do
    // exact matching). startLoopback() returns the concrete http://127.0.0.1:<port>/ to register.
    let lb
    try {
      lb = await startLoopback()
    } catch (e) {
      return { ok: false, error: `could not start the approval flow for ${sid}: ${String((e && e.message) || e)}`, source: sid }
    }

    // 4) DCR — register a fresh client with the EXACT bound redirect_uri.
    let reg
    try {
      reg = await dcrRegister(det.asMeta, { clientName: 'BlitzOS', redirectUri: lb.redirectUri, scopes: det.scopes })
    } catch (e) {
      try {
        lb.cancel()
      } catch {
        /* listener teardown best-effort */
      }
      return { ok: false, error: `could not set up ${sid} access: ${String((e && e.message) || e)}`, source: sid }
    }
    if (!reg || !reg.client_id) {
      try {
        lb.cancel()
      } catch {
        /* ignore */
      }
      return { ok: false, error: `could not set up ${sid} access (the provider returned no client id)`, source: sid }
    }

    // 5) ARM the authorize URL (built against the same redirect_uri) and start the human-approval clock.
    let authUrl
    try {
      authUrl = lb.armAuthorize({ asMeta: det.asMeta, clientId: reg.client_id, clientSecret: reg.client_secret, scopes: det.scopes, resource: det.endpoint })
    } catch (e) {
      try {
        lb.cancel()
      } catch {
        /* ignore */
      }
      return { ok: false, error: `could not build the approval link for ${sid}: ${String((e && e.message) || e)}`, source: sid }
    }

    // 6) Register a HIDDEN PENDING record now (the island reads it to render the approval card; it is FILTERED OUT
    // of connectionList so the agent never sees a connection appear), and RETURN immediately. The agent learns the
    // outcome via the connection moment (its toolkit growing) + connection_list_tools picking up the new tools.
    const connId = 'mcp_' + randomUUID().slice(0, 8)
    const pendingRec = makeMcpRecord({ connId, sid, det, reg, status: 'pending', tools: [], agentId })
    pendingRec.authUrl = authUrl // a retry while pending returns THIS same flow's link (idempotency, step 0)
    registry.set(connId, pendingRec)
    emitConnectionMoment('system', { connId, sourceId: sid, status: 'pending', verb: `awaiting your approval for ${sid}`, agentId: agentId != null ? String(agentId) : '0' })

    // BlitzOS owns the approval UX: open the browser at the authorize URL now (the user approves once). Best-effort
    // — if openExternal throws or is a no-op (server/tests), the authUrl is still returned so the UI/agent/operator
    // can surface it for a manual open. NEVER log the URL (it carries state+PKCE).
    try {
      openExternal(authUrl)
    } catch {
      /* the URL is still returned for a manual open */
    }

    // 7) Resolve the human approval on a SEPARATE path — this is what unblocks server mode (the operator opens the
    // returned URL; the loopback catch completes the flow and wakes the agent). Persist tokens, handshake, flip the
    // pending record to live/error/reauth, and emit a moment. No await here: the tool call has already returned.
    lb.waitForTokens()
      .then(async (tokens) => {
        if (!tokens || !tokens.access_token) {
          const rec = makeMcpRecord({ connId, sid, det, reg, status: 'error', tools: [], agentId })
          registry.set(connId, rec)
          emitConnectionMoment('system', { connId, sourceId: sid, status: 'error', verb: `${sid} approval didn't complete`, agentId: rec.agentId || '0' })
          return
        }
        // Persist the full bundle (encrypted) so refresh works headlessly forever, INCLUDING the raw sourceId
        // (the envelope carries it unencrypted) so boot rehydrate can re-establish this connection by sourceId.
        const bundle = {
          endpoint: det.endpoint,
          authServer: det.authServer,
          asMeta: det.asMeta,
          scopes: det.scopes,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          token_type: tokens.token_type
        }
        const saved = saveTokens(ws, sid, bundle)
        if (saved && saved.error) {
          const rec = makeMcpRecord({ connId, sid, det, reg, status: 'error', tools: [], agentId })
          registry.set(connId, rec)
          emitConnectionMoment('system', { connId, sourceId: sid, status: 'error', verb: `approved ${sid} but couldn't save it: ${saved.error}`, agentId: rec.agentId || '0' })
          return
        }
        // Handshake + flip to live (reuses the same finalize path; tokens are now on disk). The agent's toolkit grows.
        await finalizeMcpFromTokens({ sid, det, reg, agentId, connId, verb: `unlocked ${sid} tools` })
      })
      .catch((e) => {
        // Approval denied / timed out / loopback error — flip the hidden pending record to 'error' (the merge then
        // omits it; the source's `unlock` reappears) so a re-run of connection_unlock retries cleanly.
        const rec = makeMcpRecord({ connId, sid, det, reg, status: 'error', tools: [], agentId })
        registry.set(connId, rec)
        emitConnectionMoment('system', { connId, sourceId: sid, status: 'error', verb: `${sid} approval didn't complete: ${String((e && e.message) || e)}`, agentId: rec.agentId || '0' })
      })

    return { ok: true, connId, authUrl, status: 'pending', tools: [], source: sid }
  }

  // Boot / workspace rehydrate for the HIDDEN mcp connections: scan the encrypted token store for every
  // previously-approved source and re-establish each as a live HIDDEN connection WITHOUT a human step (mint from the
  // kept refresh_token), so its tools are back in the toolkit silently on the next connection_list_tools. Mirrors
  // connectionRestoreAll (tabs/windows) — a hidden mcp record has no representation surface, so it can't be rebuilt
  // from getSurfaces(); the token store IS its persistence. The restored connections stay HIDDEN (filtered from
  // connectionList). Idempotent: a source already live is skipped; one whose refresh fails lands 'error'/'reauth'.
  let mcpRestoreInFlight = false
  async function mcpRestoreAll() {
    if (mcpRestoreInFlight) return { restored: 0, total: 0, skipped: 'in-flight' }
    mcpRestoreInFlight = true
    try {
      const ws = mcpDir()
      if (!ws) return { restored: 0, total: 0 }
      let sources = []
      try {
        sources = listMcpSources(ws) || []
      } catch {
        sources = []
      }
      // Skip sources already represented by a live/pending MCP record (e.g. a workspace switch without a restart).
      const haveLive = new Set([...registry.values()].filter((r) => r.kind === 'mcp' && r.status !== 'error' && r.status !== 'dropped').map((r) => r.sourceId))
      let restored = 0
      let total = 0
      for (const sid of sources) {
        if (haveLive.has(sid)) continue
        total++
        const tok = loadTokens(ws, sid)
        if (!tok || (!tok.refresh_token && !tok.access_token)) continue
        // Build det/reg from the STORED bundle (no network detection needed — asMeta+endpoint are persisted).
        const det = { endpoint: tok.endpoint, authServer: tok.authServer, asMeta: tok.asMeta, scopes: tok.scopes }
        const reg = { client_id: tok.client_id, client_secret: tok.client_secret }
        try {
          const out = await finalizeMcpFromTokens({ sid, det, reg, agentId: '', verb: `restored ${sid} tools` })
          if (out.ok) restored++
        } catch {
          /* a source that won't re-establish stays unregistered/error; never throws out of rehydrate */
        }
      }
      return { restored, total }
    } finally {
      mcpRestoreInFlight = false
    }
  }

  // Flatten an MCP tools/call result's content array into a single text string for the agent (the MCP content
  // model is an array of {type:'text'|'image'|...}). We join the text parts; non-text parts are noted by type so
  // the agent knows there was richer content (the full structured result is also returned alongside).
  function mcpResultText(result) {
    const content = result && Array.isArray(result.content) ? result.content : null
    if (!content) {
      if (result && typeof result.text === 'string') return result.text
      return ''
    }
    const parts = []
    for (const c of content) {
      if (c && typeof c === 'object') {
        if (typeof c.text === 'string') parts.push(c.text)
        else if (c.type) parts.push(`[${c.type}]`)
      }
    }
    return parts.join('\n')
  }

  // ================= agent-facing ops (called by the os-tools handlers) =================

  // Self-reported scoping (like /events + /say): pass `forAgent` to see only THAT chat's sources. undefined = all
  // (back-compat — the primary/'0' watcher + any caller that omits an id). '' = the pre-spawn (new-session) bucket.
  // The HIDDEN mcp connections are FILTERED OUT — MCP is an invisible tool provenance, never a connection the agent
  // sees. Its tools surface only through the owning source's connection_list_tools (merged) + connection_call_tool.
  function connectionList(forAgent) {
    const owner = forAgent === undefined ? null : String(forAgent)
    return {
      connections: [...registry.values()]
        .filter((r) => r.kind !== 'mcp')
        .filter((r) => owner == null || String(r.agentId || '') === owner)
        .map((r) => ({
          connId: r.connId,
          type: r.type,
          origin: r.origin || undefined,
          sourceId: r.sourceId,
          title: r.title,
          status: r.status,
          capabilities: r.capabilities,
          surfaceId: r.surfaceId,
          ref: r.ref ?? null,
          agentId: r.agentId || '',
          // the per-connection briefing (agents.md analog): a fresh session learns what this source already knows.
          savedTools: readTools(r.sourceId).map((t) => ({ name: t.name, description: t.description, kind: t.kind })),
          // vetted tools available in the first-party registry for this source (warmed on connect) — so the agent
          // SEES them in its briefing and connection_registry_add's one, instead of re-deriving from scratch.
          registryTools: registryCache.get(r.sourceId) || [],
          description: readDescription(r.sourceId) || undefined
        }))
    }
  }

  // Reassign sources to a chat — used when a NEW agent spawns and inherits the windows the user attached on the
  // new-session composer (owner ''). Returns the reassigned [{connId, type, sourceId, title}] so the spawn can tell
  // the agent what it now has. fromAgent defaults to '' (the pre-spawn bucket).
  function connectionReassign(toAgent, fromAgent = '') {
    const moved = []
    for (const r of registry.values()) {
      if (String(r.agentId || '') === String(fromAgent)) {
        r.agentId = String(toAgent)
        moved.push({ connId: r.connId, type: r.type, sourceId: r.sourceId, title: r.title })
        // wake the inheriting agent about each source it now owns (its first /events poll picks these up)
        emitConnectionMoment(r.surfaceId || 'system', { connId: r.connId, sourceId: r.sourceId, status: r.status, verb: 'attached', agentId: String(toAgent) })
      }
    }
    return moved
  }

  // Transfer ONE existing connection to a chat. The dedup path (connectTab/connectWindow re-attaching an
  // already-LIVE source) calls this so a source re-attached from a different chat FOLLOWS to the chat now
  // attaching it — otherwise it stays owned by the first chat, so connection_list(thisChat) omits it and the
  // dropbox shows it for ~0.5s then prunes it (the "disappears, but works on another chat" bug). Last attacher
  // wins (single-owner model, matches the per-chat dropbox). Wakes the new owner; no-op if already the owner.
  function connectionSetOwner(connId, agentId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const owner = agentId != null ? String(agentId) : ''
    if (String(r.agentId || '') === owner) return { ok: true, changed: false }
    r.agentId = owner
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: r.status, verb: 'attached', agentId: owner })
    return { ok: true, changed: true }
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

  // Bring the surface BEHIND a connection to the foreground (connection_reveal). Each
  // adapter implements the 'reveal' verb its own way (Blitz Chrome → its window; a real tab → activate the tab; a
  // macOS window → bring the app forward). Adapters that don't handle it just return the dispatcher's error.
  async function connectionReveal(connId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const out = await dispatch(r, 'reveal', {})
    if (out && out.error) return out
    return { ok: true, ...(out && typeof out === 'object' ? out : {}) }
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

  // Call ONE upstream tool through a LIVE hidden mcp connection (the broker path), honestly. Mint a token
  // (proactively refreshing on a known expiry), initialize, call; a 401 (revoked/invalid token) drives ONE
  // reactive refresh-and-retry. Returns the agent-facing shape: { ok, name, text } / { ok:false, isError, name,
  // text } for a tool-level error / { error, reauth? } for a transport/token failure. MCP-FREE text throughout
  // (the connection is invisible) — a reauth points the agent at connection_unlock. The cap is READ_CAP (the
  // same context-flood guard every read path enforces); we do NOT also return the raw result (would bypass it).
  async function callMcpTool(m, name, args) {
    const callOnce = async ({ force = false } = {}) => {
      const tok = await mcpLiveToken(m, { force })
      if (tok.error) return { tokenError: tok }
      const init = await mcpInitialize(m.endpoint, tok.access_token)
      const result = await mcpCallTool(m.endpoint, tok.access_token, init.session, String(name), args || {})
      return { result }
    }
    let result
    try {
      const out = await callOnce()
      if (out.tokenError) return { error: out.tokenError.error, reauth: !!out.tokenError.reauth }
      result = out.result
    } catch (e) {
      if (e && e.status === 401) {
        try {
          const retry = await callOnce({ force: true })
          if (retry.tokenError) return { error: retry.tokenError.error, reauth: true }
          result = retry.result
        } catch (e2) {
          if (e2 && e2.status === 401) return { error: `${m.sourceId} rejected the request even after re-approving — connection_unlock { sourceId: '${m.sourceId}' } to approve again`, reauth: true }
          return { error: `${name} on ${m.sourceId} failed: ${String((e2 && e2.message) || e2)}` }
        }
      } else {
        return { error: `${name} on ${m.sourceId} failed: ${String((e && e.message) || e)}` }
      }
    }
    const text = cap(mcpResultText(result), Number(args && args.max) || READ_CAP)
    const isError = !!(result && result.isError)
    return isError ? { ok: false, isError: true, name: String(name), text } : { ok: true, name: String(name), text }
  }

  // The merged, agent-facing toolkit for a connection. SYNC (reads the detection cache): the banked-JS/vetted tools
  // (the per-source tools.json, kept WHOLE — their existing fields like kind/source/contentHash/code are preserved,
  // unchanged from before) UNIONED with the LIVE hidden mcp connection's upstream tools for the same sourceId (added
  // as {name, description, inputSchema}). PROVENANCE IS NOT EXPOSED: neither set carries a provider tag, so the agent
  // can't tell which is brokered — it just sees one toolkit. On a name collision the MCP tool wins (server-side,
  // robust) and the JS duplicate is dropped. Plus `unlock` IFF the sourceId is lockable per the cache (a DCR-eligible
  // official integration with no live hidden connection yet). When the cache has no entry, fire detection
  // fire-and-forget and return WITHOUT unlock this call (the next list surfaces it once detection lands).
  function connectionListTools(connId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const sid = r.sourceId
    // banked JS/vetted tools (the per-source tools.json) — kept WHOLE (same shape the agent already relies on).
    const jsTools = readTools(sid)
    // the live hidden mcp connection's upstream tools (cached at unlock; re-fetched on every call_tool anyway).
    const m = liveMcpForSource(sid)
    const mcpTools = m ? (m.tools || []) : []
    const mcpNames = new Set(mcpTools.map((t) => t.name))
    const tools = [
      // MCP first (collision-prefer MCP); then the banked tools that DON'T collide with an MCP name (kept whole).
      ...mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...jsTools.filter((t) => !mcpNames.has(t.name))
    ]
    const out = { sourceId: sid, tools }
    const desc = readDescription(sid)
    if (desc) out.description = desc
    // the `unlock` affordance: an official integration this source has but hasn't unlocked yet.
    // Surface the last-known unlock affordance now; (deduped + TTL-gated) refresh detection in the background so a
    // cold source is primed for the next list and a stale negative is eventually re-probed — never blocks this call.
    if (isLockableCached(sid)) out.unlock = [{ source: sid, label: sid, prompt: `Approve ${sid} access to unlock its tools` }]
    ensureMcpDetected(sid)
    return out
  }

  async function connectionCallTool(connId, name, args) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    if (!name) return { error: 'name required (the tool to run — see connection_list_tools)' }
    const sid = r.sourceId
    const wanted = String(name)
    // 1) a LIVE hidden mcp connection for this source that exposes `name` → route through the broker (invisible).
    const m = liveMcpForSource(sid)
    if (m && (m.tools || []).some((t) => t.name === wanted)) {
      return callMcpTool(m, wanted, args)
    }
    // 2) a banked JS/vetted tool → run it in the page/app (the existing effect-verified path).
    const tool = readTools(sid).find((t) => t.name === wanted)
    if (tool) {
      let out
      if (r.type === 'tab') out = await dispatch(r, 'run_js', { code: tool.code, args: args || {} })
      else out = await dispatch(r, 'act', { steps: tool.steps, args: args || {} })
      // a failed/empty saved tool = STALE (a selector rotted): tell the agent to re-derive, never return wrong data silently
      if (out && out.error) return { error: out.error, stale: true, note: 'saved tool failed — read the source, then connection_save_tool: overwrite the same name if it is a stale selector on the same page-type, or save a distinctly-named variant if this is a different sub-type of the same source' }
      const effect = out && typeof out === 'object' ? ('effect' in out ? out.effect : 'result' in out ? out.result : out) : out
      if (tool.kind === 'act' && (effect == null || effect === '')) {
        return { ok: false, stale: true, note: 'saved act tool produced no effect (likely a stale selector, or a different sub-type of the same source) — read the source, then connection_save_tool (overwrite if same page-type, else a distinctly-named variant)' }
      }
      return { ok: true, name: tool.name, effect: cap(effect) }
    }
    // 3) no such tool yet, but this source has an official integration to UNLOCK → the approval affordance (the
    // island pops the approve card). MCP-FREE: the agent just sees a source it can unlock to gain more tools.
    if (isLockableCached(sid)) {
      return { needsApproval: true, source: sid, prompt: `Approve ${sid} access to unlock its tools (connection_unlock { sourceId: '${sid}' })` }
    }
    // Refresh detection in the background (deduped + TTL-gated) so a retry can surface the unlock for a source whose
    // integration appeared (or recovered) after the last probe — don't block this call.
    ensureMcpDetected(sid)
    // 4) nothing matched → the existing "no saved tool" error.
    return { error: `no saved tool "${wanted}" for ${sid} — list_tools to see what exists, or save_tool to add it` }
  }

  async function connectionDrop(connId) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    // HIDDEN mcp connection: no adapter + no representation widget. Drop it from the registry AND clear the stored
    // tokens (this re-locks the source — its `unlock` affordance reappears and re-approval re-runs the flow). The
    // detection cache stays so the source is still known to be lockable. Invisible to the agent (verb is MCP-free).
    if (r.kind === 'mcp') {
      registry.delete(connId)
      const ws = mcpDir()
      let cleared = { ok: true }
      if (ws) cleared = clearTokens(ws, r.sourceId) || { ok: true }
      emitConnectionMoment('system', { connId, sourceId: r.sourceId, status: 'dropped', verb: `re-locked ${r.sourceId} tools`, agentId: r.agentId || '0' })
      return cleared.error ? { ok: false, error: cleared.error } : { ok: true }
    }
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
    emitConnectionMoment(r.surfaceId || 'system', { connId, sourceId: r.sourceId, status: 'dropped', verb: 'disconnected', agentId: r.agentId || '0' })
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
    emitConnectionMoment('system', { connId, sourceId: r.sourceId, status: 'dropped', verb: 'disconnected (widget closed)', agentId: r.agentId || '0' })
  }

  // ---- the browser links (Safari + Chrome, both Apple Events) register themselves here so the agent tools can
  // list + connect the user's browser tabs transport-agnostically (Electron + server bind the same way). ----
  function setSafariLink(link) {
    safariLink = link
  }
  function setChromeAsLink(link) {
    chromeAsLink = link
  }
  // Connectable tabs = Chrome + Safari, both via Apple Events, tagged by `browser`.
  // `only` ('chrome'|'safari') scopes the enumeration to ONE browser — the drop path passes it so dropping Chrome
  // never runs a Safari Apple Event (which would spuriously prompt for Safari). No arg = both (the connector list).
  async function connectionListTabs(only) {
    const out = []
    // P0: carry each browser's coarse reachability state ('ok' | 'denied' | 'allowjs' | 'unreachable' | 'helper')
    // so the connector list can show a dedicated grant row for a browser it can't reach, instead of just hiding it.
    const browsers = {}
    if (only !== 'safari' && chromeAsLink && typeof chromeAsLink.listTabs === 'function') {
      try {
        const cr = await chromeAsLink.listTabs()
        for (const t of (cr && cr.tabs) || []) out.push({ ...t, browser: 'chrome' })
        browsers.chrome = (cr && cr.state) || 'unreachable'
      } catch {
        browsers.chrome = 'unreachable'
      }
    }
    if (only !== 'chrome' && safariLink && typeof safariLink.listTabs === 'function') {
      try {
        const sr = await safariLink.listTabs()
        for (const t of (sr && sr.tabs) || []) out.push({ ...t, browser: 'safari' })
        browsers.safari = (sr && sr.state) || 'unreachable'
      } catch {
        browsers.safari = 'unreachable'
      }
    }
    if (!chromeAsLink && !safariLink) return { error: 'no browser link — enable "Allow JavaScript from Apple Events" in Chrome (View ▸ Developer) or Safari (Develop)' }
    return { tabs: out, browsers }
  }
  // Enrich a connect result with the source's BRIEFING — savedTools (banked here) + registryTools (vetted,
  // available to add) — so the agent SEES reusable tools in the very response it gets on connect, before it
  // decides to act. (connection_list also carries these, but the agent's connect→act flow can skip it.)
  async function attachBriefing(res) {
    if (!res || res.error || !res.connId) return res
    const sid = res.sourceId || (rec(res.connId) && rec(res.connId).sourceId)
    if (sid) {
      try {
        await refreshRegistryForSource(sid, res.connId) // await so registryTools is ready in the result
      } catch {
        /* registry offline */
      }
      res.savedTools = readTools(sid).map((t) => ({ name: t.name, description: t.description, kind: t.kind }))
      res.registryTools = registryCache.get(sid) || []
    }
    return res
  }

  async function connectionConnectTab(tabId, opts) {
    const safari = (opts && opts.browser === 'safari') || String(tabId).startsWith('safari:')
    if (safari) {
      if (!safariLink || typeof safariLink.connectTab !== 'function') return { error: 'Safari link not available' }
      return attachBriefing(await safariLink.connectTab(String(tabId), opts || {}))
    }
    // Chrome via Apple Events (the connector extension is deprecated). Ids are chrome:<window>:<tab>.
    if (!chromeAsLink || typeof chromeAsLink.connectTab !== 'function') return { error: 'Chrome link not available — enable "Allow JavaScript from Apple Events" in Chrome (View ▸ Developer)' }
    if (tabId == null) return { error: 'tabId required' }
    return attachBriefing(await chromeAsLink.connectTab(String(tabId), opts || {}))
  }
  // ---- the window link (connection-window-link.ts) registers itself the same way; window connect is
  // macOS-and-local-only (it needs the BlitzOS helper's AX/CGEvent/ScreenCaptureKit). ----
  function setWindowLink(link) {
    windowLink = link
  }
  // P0: Chrome/Safari are connected as TABS (Apple Events), never as generic windows — so their windows must NOT
  // appear in the app-window list (they showed up as "Google Chrome 7", confusing). The connector list shows a
  // dedicated browser row instead.
  const isBrowserWindow = (w) => {
    const b = String((w && w.bundleId) || '').toLowerCase()
    if (b) return b === 'com.google.chrome' || b.startsWith('com.google.chrome.') || b === 'com.apple.safari'
    const app = String((w && w.app) || '').toLowerCase()
    return /\bgoogle chrome\b/.test(app) || app === 'safari'
  }
  async function connectionListWindows() {
    if (!windowLink || typeof windowLink.listWindows !== 'function') return { error: 'no window link — window connect needs the BlitzOS helper (macOS, local only)' }
    const r = await windowLink.listWindows()
    if (r && Array.isArray(r.windows)) return { ...r, windows: r.windows.filter((w) => !isBrowserWindow(w)) }
    return r
  }
  async function connectionConnectWindow(windowId, opts) {
    if (!windowLink || typeof windowLink.connectWindow !== 'function') return { error: 'no window link — window connect needs the BlitzOS helper (macOS, local only)' }
    if (windowId == null) return { error: 'windowId required' }
    return attachBriefing(await windowLink.connectWindow(Number(windowId), opts || {}))
  }
  // Reconnect a source by its sourceId — the "Reconnect" affordance on a DISCONNECTED widget. Re-finds the
  // matching tab/window (by origin host for a tab, bundle id for a window) among what's currently connectable
  // and connects it (which adopts the disconnected widget). Returns a navigable error if the source isn't open.
  async function connectionReconnectSource(sourceId, type, opts = {}) {
    const sid = String(sourceId || '')
    if (!sid) return { error: 'sourceId required' }
    const co = opts && opts.agentId != null ? { agentId: opts.agentId } : {}
    const wantWindow = type === 'window'
    if (!wantWindow && chromeAsLink) {
      try {
        const tabs = (await chromeAsLink.listTabs()) || []
        const match = tabs.find((t) => {
          try {
            return new URL(t.url).host === sid
          } catch {
            return false
          }
        })
        if (match) return chromeAsLink.connectTab(match.tabId, co)
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
        if (match) return safariLink.connectTab(match.tabId, co)
      } catch {
        /* fall through */
      }
    }
    if (wantWindow && windowLink) {
      try {
        const r = await windowLink.listWindows()
        const wins = (r && r.windows) || []
        const match = wins.find((w) => String(w.bundleId) === sid || String(w.app) === sid)
        if (match) return windowLink.connectWindow(match.windowId, co)
      } catch {
        /* fall through */
      }
    }
    return { error: `couldn't find an open ${wantWindow ? 'window' : 'tab'} for ${sid} to reconnect — open it, then reconnect`, notFound: true }
  }

  // Boot / link-(re)connect auto-restore: re-bind every persisted-but-dead connection widget to its still-open
  // tab/window, preserving the owning agent — so a BlitzOS restart doesn't make the agent lose its tab and ask
  // the user to reconnect. Idempotent: a connection that's already live is skipped (connectTab/connectWindow
  // dedup re-attaches anyway); a source whose tab/window is gone stays disconnected (no error surfaced).
  let restoreInFlight = false
  async function connectionRestoreAll() {
    if (restoreInFlight) return { restored: 0, total: 0, skipped: 'in-flight' }
    restoreInFlight = true
    try {
      let surfaces = []
      try {
        surfaces = getSurfaces() || []
      } catch {
        surfaces = []
      }
      const liveSurfaces = new Set([...registry.values()].filter((x) => x.status === 'live' && x.surfaceId).map((x) => String(x.surfaceId)))
      const seen = new Set()
      const targets = []
      for (const s of surfaces) {
        const p = s && s.props
        if (!p || !p.connection) continue
        if (liveSurfaces.has(String(s.id))) continue // already live (e.g. workspace switch without a restart)
        const tsid = String(p.connSource || '')
        const ttype = p.connType === 'window' ? 'window' : 'tab'
        const key = ttype + ':' + tsid
        if (!tsid || seen.has(key)) continue
        seen.add(key)
        targets.push({ sid: tsid, type: ttype, agentId: p.connAgent != null ? String(p.connAgent) : '' })
      }
      let restored = 0
      for (const t of targets) {
        try {
          const r = await connectionReconnectSource(t.sid, t.type, { agentId: t.agentId })
          if (r && !r.error) restored++
        } catch {
          /* a source that won't reconnect (tab/window gone) just stays disconnected */
        }
      }
      return { restored, total: targets.length }
    } finally {
      restoreInFlight = false
    }
  }
  // Navigate a connected TAB to a URL.
  async function connectionNavigate(connId, url) {
    const r = rec(connId)
    if (!r) return { error: `no connection ${connId}` }
    const out = await dispatch(r, 'navigate', { url: String(url || '') })
    if (out && out.error) return out
    return out && typeof out === 'object' && 'effect' in out ? { ok: true, effect: cap(out.effect) } : { ok: true, ...(out && typeof out === 'object' ? out : {}) }
  }

  // ================= the first-party TOOL REGISTRY (plans/connection-tool-registry.md) =================
  // A standalone HTTP service we host + vet. The agent SEARCHES it, GETS an entry, and ADDS it to its own
  // tools.json — the registry is a CANDIDATE SOURCE, never an execution path (execution stays on the
  // effect-verified connectionCallTool). Contract v1: GET /v1/tools?sourceId=&q= ; GET /v1/tool?sourceId=&name= .

  // Resolve the target sourceId from either a live connId or an explicit sourceId string.
  function registrySid({ connection, sourceId }) {
    if (connection != null) {
      const r = rec(connection)
      if (r) return r.sourceId
    }
    return sourceId != null && String(sourceId) !== '' ? String(sourceId) : null
  }
  async function registryFetch(path) {
    if (!registryUrl) return { error: 'tool registry not configured (set BLITZ_TOOL_REGISTRY_URL)' }
    let res
    try {
      res = await fetchImpl(registryUrl.replace(/\/+$/, '') + path, { headers: { accept: 'application/json' } })
    } catch (e) {
      return { error: `tool registry unreachable: ${String((e && e.message) || e)}` }
    }
    if (res && res.status === 404) return { error: 'not found', status: 404 }
    if (!res || !res.ok) return { error: `tool registry error (status ${res ? res.status : '?'})` }
    try {
      return { body: await res.json() }
    } catch {
      return { error: 'tool registry returned invalid JSON' }
    }
  }

  // Warm registryCache for a source (fire-and-forget on connect/rekey) so connection_list can SHOW vetted tools
  // exist for it — the registry was pull-only/invisible-until-queried, which is why agents re-derived from
  // scratch. If tools are found, wake the agent once with their names so it can connection_registry_add them.
  // Best-effort; never throws (a missing/offline registry just means no hint).
  async function refreshRegistryForSource(sourceId, connId) {
    if (!registryUrl || !sourceId) return
    try {
      const r = await connectionRegistrySearch({ sourceId })
      const tools = r && Array.isArray(r.entries) ? r.entries.map((e) => ({ name: e.name, description: e.description, kind: e.kind })) : []
      registryCache.set(sourceId, tools)
      if (tools.length && connId) {
        const r0 = rec(connId)
        if (r0 && r0.sourceId === sourceId) {
          emitConnectionMoment(r0.surfaceId || 'system', { connId, sourceId, status: r0.status, verb: `${tools.length} vetted registry tool(s) available — connection_registry_add to use: ${tools.map((t) => t.name).join(', ')}`, agentId: r0.agentId || '0', registryTools: tools })
        }
      }
    } catch {
      /* registry offline — no hint, agents still work */
    }
  }

  // search: metadata only (no code/steps) — discovery is cheap, bodies are a deliberate second fetch.
  async function connectionRegistrySearch({ connection, sourceId, query } = {}) {
    const sid = registrySid({ connection, sourceId })
    if (!sid) return { error: 'a connection (connId) or sourceId is required' }
    const qs = `?sourceId=${encodeURIComponent(sid)}${query ? `&q=${encodeURIComponent(String(query))}` : ''}`
    const r = await registryFetch('/v1/tools' + qs)
    if (r.error) return r
    const entries = Array.isArray(r.body && r.body.entries) ? r.body.entries : []
    return { sourceId: sid, entries }
  }

  // get: the full entry incl. code/steps, for the agent to inspect before adding.
  async function connectionRegistryGet({ sourceId, name } = {}) {
    const sid = sourceId != null ? String(sourceId) : null
    if (!sid || !name) return { error: 'sourceId and name are required' }
    const r = await registryFetch(`/v1/tool?sourceId=${encodeURIComponent(sid)}&name=${encodeURIComponent(String(name))}`)
    if (r.error) return r.status === 404 ? { error: `no registry tool "${name}" for ${sid}` } : r
    const entry = r.body && r.body.entry
    if (!entry || !entry.name) return { error: 'tool registry returned a malformed entry' }
    return { entry }
  }

  // add: fetch a vetted entry and write it into THIS source's tools.json (upsert by name), pinned by
  // contentHash. It becomes an ordinary saved tool — run later via connectionCallTool, never executed here.
  async function connectionRegistryAdd({ connection, sourceId, name } = {}) {
    const sid = registrySid({ connection, sourceId })
    if (!sid) return { error: 'a connection (connId) or sourceId is required' }
    if (!name) return { error: 'name is required' }
    const got = await connectionRegistryGet({ sourceId: sid, name })
    if (got.error) return got
    const e = got.entry
    // never let an entry fetched for one source be written under another
    if (e.sourceId != null && String(e.sourceId) !== sid) return { error: `registry entry is for ${e.sourceId}, not ${sid}` }
    const kind = e.kind === 'act' ? 'act' : 'read'
    const hasBody = e.code != null || e.steps != null
    if (!hasBody) return { error: 'registry entry has no code/steps' }
    const saved = {
      name: String(e.name),
      description: String(e.description || ''),
      kind,
      ...(e.steps != null ? { steps: e.steps } : { code: String(e.code || '') }),
      source: 'registry',
      version: e.version != null ? String(e.version) : undefined,
      contentHash: e.contentHash != null ? String(e.contentHash) : undefined
    }
    const tools = readTools(sid)
    const i = tools.findIndex((t) => t.name === saved.name)
    if (i >= 0) tools[i] = saved
    else tools.push(saved)
    if (!writeTools(sid, tools)) return { error: 'no active workspace to save the tool into' }
    return { ok: true, name: saved.name, sourceId: sid, version: saved.version, count: tools.length }
  }

  return {
    // tab + window link registration + the user/agent connect entries
    setSafariLink,
    setChromeAsLink,
    connectionListTabs,
    connectionConnectTab,
    setWindowLink,
    connectionListWindows,
    connectionConnectWindow,
    connectionReconnectSource,
    connectionRestoreAll,
    connectionNavigate,
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
    connectionReassign,
    connectionSetOwner,
    connectionRead,
    connectionAct,
    connectionReveal,
    connectionRunJs,
    connectionSaveTool,
    connectionListTools,
    connectionCallTool,
    connectionDrop,
    connectionSetDescription,
    // MCP as an INVISIBLE tool provenance: connectMcp is the op behind /connection_unlock (the only agent-facing
    // surface); ensureMcpDetected primes the `unlock` affordance (also fired on every connect); mcpRestoreAll
    // rehydrates the hidden connections at boot. The agent reaches unlocked tools through connection_list_tools /
    // connection_call_tool — it never sees an mcp connection (filtered from connectionList) or the word "MCP".
    connectMcp,
    ensureMcpDetected,
    mcpRestoreAll,
    // first-party tool registry
    connectionRegistrySearch,
    connectionRegistryGet,
    connectionRegistryAdd
  }
}
