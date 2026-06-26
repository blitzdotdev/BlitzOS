// action-items.mjs — the SHARED core for the Action-items inbox: the structured way an agent tells
// the human "here is a thing only YOU can do" (sign in, scan a QR, approve a send, pick an option) —
// instead of burying it in a wall of chat. The human sees a checkable list; ticking an item wakes the
// agent (a perception moment) so it can continue. Items are file-backed under
//   <workspace>/.blitzos/state/action-items.json
// so they survive a restart. Like terminal-ops, this lives ONCE and both transports bind the SAME core
// (only the seams differ: emit = SSE broadcast / webContents.send; emitMoment = perception wake).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { markWrite as defaultMarkWrite } from './workspace.mjs'

const KINDS = new Set(['task', 'signin', 'approve', 'choose', 'scan', 'info'])

/**
 * @param {{ getWorkspacePath: () => (string|null|undefined), emit?: (ev:object)=>void,
 *           emitMoment?: (action:object)=>void, markWrite?: (p:string)=>void }} deps
 *   emit       — push a UI update to the renderer (server: SSE broadcast; Electron: os:action).
 *   emitMoment — wake the watching agent when the human resolves an item (perception emitSurfaceAction).
 */
export function makeActionItems({ getWorkspacePath, emit = () => {}, emitMoment = () => {}, markWrite = defaultMarkWrite } = {}) {
  // workspacePath -> { items: Map<id,item>, loaded: true }. Keyed by workspace so a switch is clean.
  const byWs = new Map()

  function fileFor(wsPath) { return join(wsPath, '.blitzos', 'state', 'action-items.json') }

  function stateFor() {
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    if (!wsPath) return null
    // Keep ONLY the active workspace cached — evict the rest, so re-activating a workspace reloads its
    // items from disk (an agent may have written to .blitzos/state/action-items.json while we were on
    // another workspace). Mirrors terminal-ops.mjs's mgrFor eviction; without it a switch serves stale items.
    for (const p of [...byWs.keys()]) if (p !== wsPath) byWs.delete(p)
    let st = byWs.get(wsPath)
    if (!st) {
      st = { wsPath, items: new Map() }
      // Load any persisted items (survive a restart).
      try {
        const raw = JSON.parse(readFileSync(fileFor(wsPath), 'utf8'))
        if (Array.isArray(raw)) for (const it of raw) if (it && it.id) st.items.set(it.id, it)
      } catch { /* no file yet */ }
      byWs.set(wsPath, st)
    }
    return st
  }

  function persist(st) {
    try {
      const dir = join(st.wsPath, '.blitzos', 'state')
      mkdirSync(dir, { recursive: true }); markWrite(dir)
      const f = fileFor(st.wsPath)
      writeFileSync(f, JSON.stringify([...st.items.values()], null, 2)); markWrite(f)
    } catch { /* best-effort */ }
  }

  /** Agent pushes an action the human must do. opts: { id?, title, detail?, kind?, agentId?, choices? } */
  function requestAction(opts = {}) {
    const st = stateFor()
    if (!st) return null
    const title = String(opts.title || '').trim()
    if (!title) return null
    const id = opts.id ? String(opts.id) : randomUUID() // pass an existing id to UPDATE that item in place
    const prev = st.items.get(id)
    const kind = KINDS.has(opts.kind) ? opts.kind : 'task'
    const choices = Array.isArray(opts.choices) ? opts.choices.map(String).slice(0, 12) : undefined
    const item = {
      id,
      title: title.slice(0, 240),
      detail: opts.detail != null ? String(opts.detail).slice(0, 2000) : (prev?.detail ?? undefined),
      kind,
      agentId: opts.agentId != null ? String(opts.agentId) : (prev?.agentId ?? undefined),
      ...(choices ? { choices } : prev?.choices ? { choices: prev.choices } : {}),
      status: 'pending',
      createdAt: prev?.createdAt ?? Date.now(),
      resolvedAt: null,
      resolution: null
    }
    st.items.set(id, item)
    persist(st)
    emit({ type: 'action-item', item })
    return item
  }

  /** All items (default) or filtered by status. */
  function listActions(status) {
    const st = stateFor()
    if (!st) return []
    const all = [...st.items.values()]
    const filtered = status ? all.filter((i) => i.status === status) : all
    // pending first, then most-recent
    return filtered.sort((a, b) => (a.status === 'pending' && b.status !== 'pending' ? -1 : b.status === 'pending' && a.status !== 'pending' ? 1 : (b.createdAt || 0) - (a.createdAt || 0)))
  }

  /** Resolve an item (the human ticked it, or an agent retracts it). resolution: 'done'|'dismissed'|<a chosen option>. */
  function resolveAction(id, resolution = 'done') {
    const st = stateFor()
    if (!st) return false
    const item = st.items.get(String(id))
    if (!item || item.status !== 'pending') return false
    item.status = resolution === 'dismissed' ? 'dismissed' : 'done'
    item.resolution = String(resolution).slice(0, 240) // cap — the agent's resolve_action resolution is free text
    item.resolvedAt = Date.now()
    st.items.set(item.id, item)
    persist(st)
    emit({ type: 'action-item', item })
    // Wake the watching agent: a perception moment carrying what the human did (no chat pollution).
    try { emitMoment({ kind: 'action-resolved', id: item.id, title: item.title, resolution: item.resolution, agentId: item.agentId }) } catch { /* best-effort */ }
    return true
  }

  /** Drop a resolved item from the list (UI "clear"). Pending items must be resolved, not cleared. */
  function clearAction(id) {
    const st = stateFor()
    if (!st) return false
    const item = st.items.get(String(id))
    if (!item || item.status === 'pending') return false
    st.items.delete(item.id)
    persist(st)
    emit({ type: 'action-item-removed', id: item.id })
    return true
  }

  return { requestAction, listActions, resolveAction, clearAction }
}

/** Make the Action-items inbox surface AUTHORITATIVE: overwrite any inbox surface's `props.items` with the
 *  CURRENT store items. The inbox is a runtime surface that lives in osState (a renderer creates it + pushes
 *  it back), so its item list can drift — a stale copy carried in osState gets re-broadcast on hydrate and
 *  shows items the store no longer has (the drive-inbox phantom-items bug). Reconciling at every read point
 *  (hydrate + onStatePush) against listActions() guarantees the inbox shows EXACTLY the store, never a stale
 *  cache. Pure; returns the SAME array reference when there's no inbox surface (cheap no-op). */
export function reconcileInboxItems(surfaces, items) {
  if (!Array.isArray(surfaces)) return surfaces
  const authoritative = Array.isArray(items) ? items : []
  let changed = false
  const out = surfaces.map((s) => {
    if (s && s.kind === 'native' && s.component === 'inbox') {
      changed = true
      return { ...s, props: { ...(s.props || {}), items: authoritative } }
    }
    return s
  })
  return changed ? out : surfaces
}
