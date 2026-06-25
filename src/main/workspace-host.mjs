// Shared workspace HOST — owns the active-workspace runtime: hydrate, persist (debounced), watch +
// reconcile external edits, switch (atomic, single-flight), list/create, and the last-seen thumbnail
// store. Used by BOTH preview/backend.mjs (server mode) AND src/main/osActions.ts (Electron) — there
// is ONE implementation, no second copy to drift. The serializer (workspace.mjs) does disk I/O; the
// per-transport bits (reaching renderers, realizing web surfaces) are adapter callbacks. This is the
// control-core.mjs / perception-core.mjs pattern: one feature, both modes.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, watch, statSync, realpathSync, existsSync } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  writeWorkspace,
  readWorkspace,
  readRuntimePanels,
  reconcileWorkspace,
  writeDroppedFile,
  writeDroppedFileAt,
  copyDroppedEntry,
  groupIntoFolder,
  createFolder,
  listDir,
  removeSurfaceFile,
  surfaceFileExists,
  removeAgentFiles,
  removeAgentAttachments,
  ensureSystemRenderer,
  readSystemRenderer,
  readSystemRendererInfo,
  writeSystemRenderer,
  readChatMessages,
  appendChatMessage,
  relocateLegacyChats,
  readConsent,
  writeConsent,
  wasSelfWrite,
  markWrite,
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  resolveWorkspace,
  safeName,
  readRootState,
  patchRootState,
  findSurfaceWorkspace,
  relocateSurface,
  renameFolder,
  moveIntoFolder,
  moveOutOfFolder,
  openFolderEntry
} from './workspace.mjs'
// The agent's volatile relay base url lives in a file the agent re-reads each call (self-heal across restarts).
import { writeRelayUrl } from './agent-runtime.mjs'
// Agent settings ride the same terminal meta.json the manager owns.
import { readTerminalMeta, setTerminalOrchestrators, writeTerminalMeta } from './terminal-manager.mjs'
import { sessionJsonlPath, lastAssistantStop, lastAssistantError } from './agent-transcript.mjs'
// The inbox is a runtime surface in osState; reconcileInboxItems keeps its items authoritative from the store.
import { reconcileInboxItems } from './action-items.mjs'

/**
 * @param {object} a
 * @param {string}   a.root         WORKSPACES_ROOT (holds many workspace folders)
 * @param {string}  [a.initialName] 'Home' default, or the basename of an explicit override
 * @param {() => any} a.getState    returns the current osState ({surfaces})
 * @param {(s:any) => void} a.setState  sets osState (the host owns it on hydrate/switch/reconcile)
 * @param {(obj:any) => void} a.broadcast  send a message to all connected renderers
 * @param {() => any[]} [a.getActionItems]  the authoritative action-items list (listActions()) — the inbox
 *        surface's items are reconciled against this on hydrate + onStatePush so a stale osState copy never wins.
 * @param {(surfaces:any[]) => (Promise<any>|void)} [a.onSurfaces]  realize web surfaces (server: spin/tear
 *        headless targets; Electron: no-op, WebContentsView host owns browser guests)
 * @param {boolean} [a.explicitInitial]  true when initialName was PINNED by the user (BLITZ_WORKSPACE):
 *        skip the boot-where-you-left-off preference and honor the pin.
 */
export function createWorkspaceHost(a) {
  const root = resolve(a.root)
  const onSurfaces = a.onSurfaces || (() => {})
  mkdirSync(root, { recursive: true })
  // GORDIAN KNOT (TCC): HOME is frequently itself a git repo (~/.git dotfiles). Workspaces live UNDER ~ (e.g.
  // ~/Blitz), so an agent's startup `git status` (Claude Code / Codex both do this) resolves the repo root to
  // ~ and walks the ENTIRE home dir — ~/Pictures (Photos), ~/Library/Calendars, ~/Library/.../AddressBook,
  // Desktop/Documents/Downloads — each one a macOS TCC prompt charged to BlitzOS. Making the workspaces ROOT
  // its own git repo turns it into a hard boundary: git physically cannot climb past it to ~, so it never sees
  // the home repo. Structural, so unlike a GIT_CEILING_DIRECTORIES env it can't be lost across tmux/shell/agent.
  // Idempotent + best-effort: if git is absent the agent can't run git either (no walk), so nothing to fix.
  try {
    if (!existsSync(join(root, '.git'))) execFileSync('git', ['init', '-q', root], { stdio: 'ignore', timeout: 10000 })
  } catch { /* no git on PATH or init failed — the GIT_CEILING_DIRECTORIES env (index.ts) is the fallback */ }

  let initialName = a.initialName || 'Home'
  if (!safeName(initialName)) {
    console.error(`[workspace] initial name ${JSON.stringify(initialName)} invalid — using 'Home'`)
    initialName = 'Home'
  }
  // Boot where the user left off: the persisted last-active workspace wins over the default unless the
  // caller passed an EXPLICIT pin (BLITZ_WORKSPACE). Falls through to initialName if it no longer exists.
  if (!a.explicitInitial) {
    try {
      const last = readRootState(root).lastActiveWorkspace
      if (typeof last === 'string' && safeName(last) && resolveWorkspace(root, last, { mustExist: true })) initialName = last
    } catch {
      /* root state unreadable — the default stands */
    }
  }
  if (listWorkspaces(root).length === 0) {
    try {
      createWorkspace(root, initialName)
    } catch (e) {
      console.error('[workspace] first-run create failed:', e?.message || e)
    }
  }
  let activeWorkspace = resolveWorkspace(root, initialName, { mustExist: true }) || join(root, initialName)
  const rememberActive = () => {
    try {
      patchRootState(root, { lastActiveWorkspace: basename(activeWorkspace) })
    } catch {
      /* best-effort — boot preference only */
    }
  }
  rememberActive()

  let switching = false
  let writeTimer = null
  let reconcileTimer = null
  let watchers = []
  // The authoritative action-items list (listActions()), injected by the transport. The inbox surface's items
  // are reconciled against this so a stale osState copy never wins. Guarded — a missing/throwing provider → [].
  const actionItemsNow = () => { try { return (typeof a.getActionItems === 'function' ? a.getActionItems() : []) || [] } catch { return [] } }
  // id -> expiry ts: a surface we authoritatively closed. A still-connected renderer whose store hasn't
  // caught up can re-push the closed surface in its os:state; onStatePush rejects ids in here so the close
  // sticks instead of resurrecting (the junk-resurrection half of the runtime-surface-loss fragility).
  const recentlyClosed = new Map()
  // Runtime-only surfaces — NEVER serialized as workspace.json nodes (rebuilt on hydrate/switch from
  // terminals/action-items/runtime panels). MUST match store.ts applyReconcile's isRuntime predicate (the
  // two run the same reconcile contract; drift is exactly the divergence the parity guard exists to prevent).
  // Used by BOTH doReconcile (keep them across a disk reconcile) and onStatePush (skip them when re-asserting
  // glitch-dropped file-backed surfaces — they have no content file and are re-asserted separately above).
  const isRuntimeLike = (s) =>
    s.role === 'chat' ||
    s.role === 'activity' ||
    (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity' || s.component === 'folder' || s.component === 'files' || s.component === 'terminal' || s.component === 'runtime' || s.component === 'inbox' || s.component === 'unlock'))

  const active = () => basename(activeWorkspace)
  const blank = () => ({ surfaces: [] })

  function flush() {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    try {
      writeWorkspace(activeWorkspace, a.getState())
    } catch (e) {
      console.error('[workspace] write failed:', e?.message || e)
    }
  }
  function scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(flush, 500) // trailing debounce
  }
  // The reconcile body: re-scan the folder, merge with LIVE state, broadcast. `placeAt` is the world
  // point new files cascade around (the view center for a watch event, the drop point for an ingest).
  function doReconcile(placeAt) {
    if (switching) return // a switch owns the folder mid-flight
    try {
      const st = a.getState()
      const r = reconcileWorkspace(activeWorkspace, placeAt || {})
      if (!r) return
      // Nothing on disk changed → the renderer already has this exact state. Broadcasting anyway
      // re-sent the FULL surface array (props included) on every watcher blip. Skip; real changes
      // (new/renamed/dropped files) pass.
      if (!r.changed) return
      // Preserve LIVE state that disk doesn't represent, so a reconcile never destroys it:
      //  - runtime chat/activity panels + iPhone-style folder groupings (never persisted as nodes)
      //  - surfaces that exist in osState but aren't a workspace.json node yet (agent-created /
      //    in-flight). `r.knownIds` ARE the persisted node ids: an osState id NOT in knownIds and
      //    NOT in the reconciled set is genuinely un-persisted → keep it (a DELETED file's id IS a
      //    known node → it correctly drops). Re-apply group memberships to the disk surfaces too.
      // Runtime-only surfaces (isRuntimeLike, hoisted to host scope) are kept across a reconcile: terminal/
      // runtime/inbox/chat/activity are reconstructed from events on load, never workspace.json nodes.
      const reconciledIds = new Set(r.surfaces.map((s) => s.id))
      const keep = (st.surfaces || []).filter((s) => isRuntimeLike(s) || (!r.knownIds.has(s.id) && !reconciledIds.has(s.id)))
      const groupOf = new Map((st.surfaces || []).filter((s) => s.groupId).map((s) => [s.id, { groupId: s.groupId, peek: s.peek }]))
      const merged = [...r.surfaces.map((s) => { const g = groupOf.get(s.id); return g ? { ...s, groupId: g.groupId, peek: g.peek } : s }), ...keep]
      a.setState({ ...st, surfaces: merged })
      Promise.resolve(onSurfaces(merged)).catch(() => {})
      a.broadcast({ type: 'reconcile', surfaces: merged, workspace: active() })
    } catch (e) {
      console.error('[workspace] reconcile failed:', e?.message || e)
    }
  }
  function scheduleReconcile() {
    if (reconcileTimer) return
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      doReconcile({})
    }, 250)
  }
  /** Ingest a file the user DROPPED onto the canvas: write it into the active workspace, then
   *  reconcile AT the drop position so the tile appears where it was dropped (#43). */
  function ingestFile(name, buffer, x, y) {
    if (switching) return { error: 'switch in progress' }
    const w = writeDroppedFile(activeWorkspace, name, buffer)
    if (!w) return { error: 'could not write the file' }
    doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true, name: w.rel }
  }
  /** #52: group the given member surfaces into a REAL subdirectory (mkdir + mv their content files in).
   *  Flush first so every member has a content file on disk, then group, then reconcile so the new
   *  folder surfaces as one tile and the moved files leave the canvas root. */
  function group(name, memberIds, x, y, kind) {
    if (switching) return { error: 'switch in progress' }
    flush() // persist current state so every member's content file exists + workspace.json is current
    const r = groupIntoFolder(activeWorkspace, name, memberIds, kind)
    if (!r || !r.ok) return { error: (r && r.error) || 'could not group' }
    doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true, folder: r.folder, moved: r.moved }
  }
  /** Ingest real OS paths the user DROPPED (Electron: files AND folders, copied recursively into the
   *  workspace), then reconcile ONCE at the drop position so the tiles land where dropped (#43/#52). */
  function ingestPaths(paths, x, y) {
    if (switching) return { error: 'switch in progress' }
    const list = Array.isArray(paths) ? paths : []
    let copied = 0
    for (const p of list) {
      const r = copyDroppedEntry(activeWorkspace, p)
      if (r) copied++
    }
    if (!copied) return { error: 'nothing ingestable' }
    doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true, copied }
  }
  /** Server folder-drop: write ONE uploaded file at a relative in-folder subpath (jailed, mkdir -p).
   *  `reconcile:false` lets a multi-file folder upload defer to a single trailing reconcile (the client
   *  posts the files, then calls reconcileAt). A bare file upload reconciles immediately. */
  function ingestUpload(relPath, buffer, x, y, reconcile = true) {
    if (switching) return { error: 'switch in progress' }
    const w = String(relPath || '').match(/[\\/]/) ? writeDroppedFileAt(activeWorkspace, relPath, buffer) : writeDroppedFile(activeWorkspace, String(relPath || 'file'), buffer)
    if (!w) return { error: 'could not write the file' }
    if (reconcile) doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true, name: w.rel }
  }
  /** Reconcile at a point — used by the server folder-drop to surface the new folder after a deferred batch. */
  function reconcileAt(x, y) {
    if (switching) return { error: 'switch in progress' }
    doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true }
  }
  /** List a normal folder's contents for the file-manager overlay (jailed to the active workspace). */
  function listDirInWorkspace(rel) {
    return listDir(activeWorkspace, rel)
  }
  function refreshDirSurfaceCounts(surfaces) {
    return (surfaces || []).map((s) => {
      if (!(s?.kind === 'native' && s.component === 'dir')) return s
      const path = typeof s.props?.path === 'string' ? s.props.path : ''
      if (!path) return s
      const listing = listDir(activeWorkspace, path)
      if (!listing) return s
      const entries = Number(listing.total) || 0
      if (Number(s.props?.entries) === entries) return s
      return { ...s, props: { ...(s.props || {}), entries } }
    })
  }
  function renameFolderInWorkspace(rel, name) {
    if (switching) return { ok: false, error: 'switch in progress' }
    flush()
    const r = renameFolder(activeWorkspace, rel, name)
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'could not rename folder' }
    const st = a.getState()
    const oldRel = String(rel || '').replace(/^[/\\]+|[/\\]+$/g, '')
    const nextRel = r.path
    const oldPrefix = `${oldRel}/`
    const nextPrefix = `${nextRel}/`
    const surfaces = refreshDirSurfaceCounts((st.surfaces || []).map((s) => {
      const p = typeof s.props?.path === 'string' ? s.props.path : null
      const rp = typeof s.props?.rootPath === 'string' ? s.props.rootPath : null
      if (!p && !rp) return s
      const path = p === oldRel ? nextRel : p?.startsWith(oldPrefix) ? nextPrefix + p.slice(oldPrefix.length) : p
      const rootPath = rp === oldRel ? nextRel : rp?.startsWith(oldPrefix) ? nextPrefix + rp.slice(oldPrefix.length) : rp
      if (path === p && rootPath === rp) return s
      const displayPath = path || rootPath || ''
      const title = s.kind === 'native' && (s.component === 'dir' || s.component === 'files') ? basename(displayPath) || s.title : s.title
      return { ...s, title, props: { ...s.props, ...(path ? { path } : {}), ...(rootPath ? { rootPath } : {}), name: s.component === 'dir' && path ? basename(path) : s.props?.name } }
    }))
    a.setState({ ...st, surfaces })
    Promise.resolve(onSurfaces(surfaces)).catch(() => {})
    a.broadcast({ type: 'reconcile', surfaces, workspace: active() })
    flush()
    return { ok: true, path: nextRel }
  }
  function moveIntoFolderInWorkspace(folderPath, ids) {
    if (switching) return { ok: false, error: 'switch in progress' }
    flush()
    const r = moveIntoFolder(activeWorkspace, folderPath, ids)
    if (!r || !r.ok) return { ok: false, moved: r?.moved || 0, skipped: r?.skipped || 0, movedIds: r?.movedIds || [], skippedIds: r?.skippedIds || [], error: (r && r.error) || 'could not move into folder' }
    doReconcile({})
    return r
  }
  function moveOutOfFolderInWorkspace(paths, x, y) {
    if (switching) return { ok: false, error: 'switch in progress' }
    flush()
    const r = moveOutOfFolder(activeWorkspace, paths, { x, y })
    if (!r || !r.ok) return { ok: false, moved: r?.moved || 0, skipped: r?.skipped || 0, movedPaths: r?.movedPaths || [], skippedPaths: r?.skippedPaths || [], pathMoves: r?.pathMoves || [], surfaceIds: r?.surfaceIds || [], surfaces: r?.surfaces || [], updatedIds: r?.updatedIds || [], updatedSurfaces: r?.updatedSurfaces || [], error: (r && r.error) || 'could not move out of folder' }
    const st = a.getState()
    const returned = Array.isArray(r.surfaces) ? r.surfaces : []
    const updated = Array.isArray(r.updatedSurfaces) ? r.updatedSurfaces : []
    const moves = Array.isArray(r.pathMoves)
      ? r.pathMoves.filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string' && m.from && m.to)
      : []
    const rewriteMovedPath = (value) => {
      if (typeof value !== 'string' || !value) return value
      for (const m of moves) {
        if (value === m.from) return m.to
        const prefix = `${m.from}/`
        if (value.startsWith(prefix)) return `${m.to}/${value.slice(prefix.length)}`
      }
      return value
    }
    const byId = new Map([...updated, ...returned].map((s) => [s.id, s]))
    const seen = new Set()
    let surfaces = (st.surfaces || []).map((s) => {
      const next = byId.get(s.id)
      const base = next || s
      if (next) seen.add(s.id)
      const p = typeof base.props?.path === 'string' ? base.props.path : null
      const rp = typeof base.props?.rootPath === 'string' ? base.props.rootPath : null
      if (!p && !rp) return base
      let path = rewriteMovedPath(p)
      const rootPath = rewriteMovedPath(rp)
      // A file-manager rooted at the parent folder may have been browsing the moved child; clamp it
      // back to its unchanged root instead of pointing outside its bounded navigation tree.
      if (base.kind === 'native' && base.component === 'files' && path && rootPath && path !== rootPath && !path.startsWith(`${rootPath}/`)) path = rootPath
      if (path === p && rootPath === rp) return base
      const displayPath = path || rootPath || ''
      const title = base.kind === 'native' && (base.component === 'dir' || base.component === 'files') ? basename(displayPath) || base.title : base.title
      return { ...base, title, props: { ...(base.props || {}), ...(path ? { path } : {}), ...(rootPath ? { rootPath } : {}) } }
    })
    for (const s of returned) if (!seen.has(s.id)) surfaces.push(s)
    surfaces = refreshDirSurfaceCounts(surfaces)
    a.setState({ ...st, surfaces })
    Promise.resolve(onSurfaces(surfaces)).catch(() => {})
    a.broadcast({ type: 'reconcile', surfaces, workspace: active() })
    flush()
    return r
  }
  function openFolderEntryInWorkspace(rel, x, y) {
    if (switching) return { ok: false, error: 'switch in progress' }
    const path = String(rel || '')
    const existing = (a.getState().surfaces || []).find((s) => s?.props?.path === path)
    if (existing) return { ok: true, id: existing.id }
    const r = openFolderEntry(activeWorkspace, path, { x, y })
    if (!r || !r.ok || !r.surface) return { ok: false, error: (r && r.error) || 'could not open entry' }
    const st = a.getState()
    const existingById = (st.surfaces || []).find((s) => s.id === r.surface.id)
    if (existingById) return { ok: true, id: existingById.id, surface: existingById }
    const surfaces = [...(st.surfaces || []), r.surface]
    a.setState({ ...st, surfaces })
    Promise.resolve(onSurfaces(surfaces)).catch(() => {})
    a.broadcast({ type: 'create', surface: r.surface })
    flush()
    return { ok: true, id: r.surface.id, surface: r.surface }
  }
  /** CLOSE a surface = delete its backing content file (explicit by id; never inferred). The renderer
   *  calls this when the user closes a window so it doesn't resurrect on the next reconcile. */
  function closeSurfaceFile(id) {
    if (switching) return { ok: false, error: 'switch in progress' }
    const r = removeSurfaceFile(activeWorkspace, String(id))
    // Both close paths (the renderer's traffic-light X and the agent's close_surface tool) call this, so
    // recording here guards every authoritative close against a stale renderer re-push for ~8s (the echo
    // window) — after which the renderer's store has caught up and won't re-push it.
    if (r && r.ok) recentlyClosed.set(String(id), Date.now() + 8000)
    return r
  }

  // Item 4: which OTHER workspace holds this surface id (so an op on a non-active id can NAME where it is).
  function locateSurface(id) {
    return findSurfaceWorkspace(root, String(id), activeWorkspace)
  }
  // Item 4: BRING a surface from another workspace INTO the active one — the "I just want this one window
  // here" path. Moves its content file across folders (id preserved), inserts it into the live state, and
  // persists. Returns { ok, from, id } or { ok:false, notFound }.
  function bringSurfaceHere(id, x, y) {
    if (switching) return { ok: false, error: 'switch in progress' }
    const r = relocateSurface(root, activeWorkspace, String(id), { x, y })
    if (!r) return { ok: false, notFound: true }
    const st = a.getState()
    const surfaces = [...(st.surfaces || []), r.surface]
    a.setState({ ...st, surfaces })
    Promise.resolve(onSurfaces(surfaces)).catch(() => {})
    a.broadcast({ type: 'create', surface: r.surface })
    flush() // persist the destination now (durable) — the source already lost the file + node
    return { ok: true, from: r.fromName, id: r.surface.id }
  }

  // ---- The system Chat: ONE React-capable hub surface whose UI is blitz-chat.<html|jsx|tsx>
  // (customizable) and whose transcripts are chat[-<id>].md. Agent '0' is the primary thread. Additional
  // agents are managed backends running in tmux terminals; they keep separate transcript files, but the
  // hub renders every thread from one surface. Statuses are transient runtime state.
  const chatSurfaceId = (agentId = '0') => (!agentId || String(agentId) === '0' ? 'chat' : `chat-${agentId}`)
  const CHAT_STATUSES = new Set(['idle', 'starting', 'working', 'watching', 'waiting', 'stopped', 'error'])
  const CHAT_ACTIVE_STATUSES = new Set(['starting', 'working', 'waiting'])
  const CHAT_QUIET_MS = Math.max(0, Number(process.env.BLITZ_CHAT_STATUS_QUIET_MS) || 10000)
  const CHAT_TERMINAL_ACTIVITY_MS = Math.max(100, Number(process.env.BLITZ_CHAT_TERMINAL_ACTIVITY_THROTTLE_MS) || 1200)
  const CHAT_TERMINAL_WORK_MS = Math.max(CHAT_QUIET_MS, Number(process.env.BLITZ_CHAT_TERMINAL_WORK_MS) || CHAT_QUIET_MS * 6)
  const CHAT_POST_SAY_SETTLE_MS = Math.max(0, Number(process.env.BLITZ_CHAT_POST_SAY_SETTLE_MS) || 2500)
  const CHAT_POST_SAY_TERMINAL_WORK_MS = Math.max(
    CHAT_POST_SAY_SETTLE_MS,
    Number(process.env.BLITZ_CHAT_POST_SAY_TERMINAL_WORK_MS) || Math.min(CHAT_TERMINAL_WORK_MS, 8000)
  )
  const CHAT_CLAUDE_END_TURN_POLL_MS = Math.max(10, Number(process.env.BLITZ_CHAT_CLAUDE_END_TURN_POLL_MS) || 150)
  const chatStatuses = new Map()
  // Per-agent error DETAIL (id -> { cause, title, hint, retryable }) — the human-facing read of the last problem an
  // agent hit, so the island can show "Network error" + what to do instead of a bare "Problem". Kept in lockstep
  // with the 'error' chat status: set when we flip to 'error' (with a known cause), cleared on any move off 'error'.
  const chatErrors = new Map()
  const chatQuietTimers = new Map()
  const chatPostSaySettleTimers = new Map()
  const chatTerminalActivityAt = new Map()
  const chatTerminalWorkUntil = new Map()
  const chatUserTurnAt = new Map()
  const chatClaudeTurnStopOffset = new Map()
  // Independent post-say end_turn watcher (agent-status fix): a per-agent 1s JSONL poll that SURVIVES the settle
  // timer being cancelled by post-say terminal activity (the background wait.sh), so status flips to 'watching'
  // ~1s after the turn actually ends instead of waiting out the 10s quiet timer.
  const chatEndTurnWatchTimers = new Map()
  const chatWorkflowRuns = new Map()
  const pendingAutoTitles = new Set()
  /** The chat-bearing agents: always '0' (primary) + any .blitzos/terminals/<id> that is an AGENT (its
   *  terminal runs a BlitzOS agent backend → it has a chat thread). 'chat' is the legacy kind from before agents
   *  ran in terminals; 'agent' is the unified kind now. Plain 'terminal' shells are NOT agents.
   *  Read-tolerant of the legacy `.blitzos/sessions` dir: the engine migration (terminal-ops) renames it to
   *  `terminals` lazily on first launch/restore, which may not have run yet when we hydrate on boot — so
   *  fall back to the legacy dir if `terminals` is absent (no agent is lost on the first post-upgrade boot). */
  function agentDir() {
    const t = join(activeWorkspace, '.blitzos', 'terminals')
    if (existsSync(t)) return t
    const legacy = join(activeWorkspace, '.blitzos', 'sessions')
    return existsSync(legacy) ? legacy : t
  }
  function readAgentMetaFile(agentId) {
    const id = String(agentId ?? '0')
    return readTerminalMeta(agentDir(), id)
  }
  function listedAgentIds({ includeArchived = false, archivedOnly = false } = {}) {
    const ids = archivedOnly ? [] : ['0']
    const dir = agentDir()
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '0') continue
        try {
          const m = readAgentMetaFile(d.name)
          if (!m || (m.kind !== 'agent' && m.kind !== 'chat')) continue
          const archived = !!m.archived
          if (archivedOnly ? archived : includeArchived || !archived) ids.push(d.name)
        } catch { /* skip */ }
      }
    } catch { /* no terminals dir */ }
    return ids
  }
  function agentIds() { return listedAgentIds() }
  function allAgentIds() { return listedAgentIds({ includeArchived: true }) }
  function archivedAgentIds() { return listedAgentIds({ archivedOnly: true }) }
  function readAgentMeta(agentId) {
    const id = String(agentId ?? '0')
    const m = readAgentMetaFile(id)
    if (id === '0') return { id, ...(m && typeof m === 'object' ? m : {}), title: 'Blitz', kind: 'agent' }
    if (m && typeof m === 'object') return { id, ...m, ...(m.title ? { title: agentTitleText(m.title) } : {}) }
    return { id }
  }
  function writeAgentMeta(agentId, next) {
    const id = String(agentId)
    writeTerminalMeta(agentDir(), id, next)
  }
  function clearChatQuietTimer(agentId) {
    const id = String(agentId ?? '0')
    const timer = chatQuietTimers.get(id)
    if (timer) clearTimeout(timer)
    chatQuietTimers.delete(id)
  }
  function hasPostSaySettle(agentId) {
    return chatPostSaySettleTimers.has(String(agentId ?? '0'))
  }
  function clearPostSaySettle(agentId) {
    const id = String(agentId ?? '0')
    const timer = chatPostSaySettleTimers.get(id)
    if (timer) clearTimeout(timer)
    chatPostSaySettleTimers.delete(id)
  }
  // Cancel the independent end_turn watcher. CRITICAL: this is deliberately NOT called from clearPostSaySettle —
  // clearPostSaySettle fires on post-say terminal activity (noteAgentActivity 'terminal', line ~790), which is
  // exactly when the watcher must KEEP running. It is cleared only by a settled status, a new user turn, the 60s
  // cap, success, or a workspace teardown (see the call sites).
  function clearEndTurnWatch(agentId) {
    const id = String(agentId ?? '0')
    const t = chatEndTurnWatchTimers.get(id)
    if (t != null) clearTimeout(t)
    chatEndTurnWatchTimers.delete(id)
  }
  function clearChatRuntimeState() {
    for (const timer of chatQuietTimers.values()) clearTimeout(timer)
    for (const timer of chatPostSaySettleTimers.values()) clearTimeout(timer)
    for (const timer of chatEndTurnWatchTimers.values()) clearTimeout(timer)
    chatQuietTimers.clear()
    chatPostSaySettleTimers.clear()
    chatEndTurnWatchTimers.clear()
    chatTerminalActivityAt.clear()
    chatTerminalWorkUntil.clear()
    chatUserTurnAt.clear()
    chatClaudeTurnStopOffset.clear()
    chatWorkflowRuns.clear()
    chatStatuses.clear()
  }
  function hasActiveWorkflow(agentId) {
    const id = String(agentId ?? '0')
    return (chatWorkflowRuns.get(id)?.size || 0) > 0
  }
  function terminalWorkActive(agentId, now = Date.now()) {
    return (Number(chatTerminalWorkUntil.get(String(agentId ?? '0'))) || 0) > now
  }
  function clearTurnActivity(agentId) {
    const id = String(agentId ?? '0')
    chatUserTurnAt.delete(id)
    chatTerminalWorkUntil.delete(id)
    chatClaudeTurnStopOffset.delete(id)
  }
  function claudeAgentMeta(agentId) {
    const meta = readAgentMeta(agentId)
    if (!meta?.claudeSessionId) return null
    if (meta.agentRuntime && meta.agentRuntime !== 'claude') return null
    return meta
  }
  function claudeStopSignal(agentId) {
    const meta = claudeAgentMeta(agentId)
    if (!meta) return null
    return lastAssistantStop(sessionJsonlPath(activeWorkspace, meta.claudeSessionId))
  }
  function rememberClaudeTurnBaseline(agentId) {
    const id = String(agentId ?? '0')
    if (!claudeAgentMeta(id)) {
      chatClaudeTurnStopOffset.delete(id)
      return
    }
    const stop = claudeStopSignal(id)
    chatClaudeTurnStopOffset.set(id, Number.isFinite(stop?.offset) ? stop.offset : -1)
  }
  function hasClaudeTurnBaseline(agentId) {
    return chatClaudeTurnStopOffset.has(String(agentId ?? '0'))
  }
  function claudeTurnEndedClean(agentId) {
    const id = String(agentId ?? '0')
    const baseline = chatClaudeTurnStopOffset.get(id)
    if (baseline == null) return false
    const stop = claudeStopSignal(id)
    return !!(stop && stop.stopReason === 'end_turn' && Number(stop.offset) > baseline)
  }
  // The agent's LAST turn (after the current baseline) ended on a Claude Code API error — returns the error
  // signal { cause, errorText, offset, … } or null. Keys on `isApiErrorMessage`, NOT stop_reason: an API error
  // record carries a CLEAN stop_reason, so claudeTurnEndedClean can't see it (the BLI-40 gap). Offset-gated to
  // the current turn so a stale error from a prior turn never re-fires (a new user message re-baselines at 1079).
  function claudeTurnEndedError(agentId) {
    const id = String(agentId ?? '0')
    const baseline = chatClaudeTurnStopOffset.get(id)
    if (baseline == null) return null
    const meta = claudeAgentMeta(id)
    if (!meta) return null
    const err = lastAssistantError(sessionJsonlPath(activeWorkspace, meta.claudeSessionId))
    return err && Number(err.offset) > baseline ? err : null
  }
  // Map a classifyApiError() cause (connection / usage-limit / rate-limit / server-error / auth / …) to the
  // human-facing presentation the island shows: a short TITLE, a one-line HINT on what to do, and whether a plain
  // Retry makes sense (transient API failures) vs. needing a user action (auth, usage limit, full context). The
  // cause itself comes straight from Claude Code's own error text, so this is the agent reporting its real problem.
  function errorPresentation(cause) {
    switch (String(cause || 'error')) {
      case 'connection':
        return { title: 'Network error', hint: "Can't reach the API — check your connection. It retries on its own.", retryable: true }
      case 'usage-limit':
        return { title: 'Usage limit reached', hint: 'This account hit its Claude usage limit. It resumes when the limit resets.', retryable: false }
      case 'rate-limit':
        return { title: 'Rate limited', hint: 'Too many requests right now — it backs off and retries automatically.', retryable: true }
      case 'overloaded':
        return { title: 'Service overloaded', hint: "Anthropic's API is busy. Retrying shortly.", retryable: true }
      case 'server-error':
        return { title: 'Server error', hint: 'A temporary server-side error (5xx). Try again.', retryable: true }
      case 'auth':
        return { title: 'Not signed in', hint: "The agent's Claude login needs attention (re-auth or credits).", retryable: false }
      case 'input':
        return { title: 'Conversation too long', hint: 'The context is full — start a new chat or clear context.', retryable: false }
      case 'model':
        return { title: 'Model unavailable', hint: 'There is an issue with the selected model.', retryable: true }
      case 'refusal':
        return { title: 'Request declined', hint: 'The model declined to respond to the last request.', retryable: false }
      case 'crash':
        return { title: 'Agent stopped', hint: 'The agent process exited unexpectedly. Retry to wake it.', retryable: true }
      default:
        return { title: 'Problem', hint: 'Something went wrong on the last turn. Try again.', retryable: true }
    }
  }
  function agentErrorFor(cause) {
    return { cause: String(cause || 'error'), ...errorPresentation(cause) }
  }
  // Surface a fresh API-error turn as the sticky 'error' chat status (red dot) + its human-facing detail. Returns
  // true if it set it, so the settle paths can short-circuit. The status + detail clear naturally on the next user
  // message (setChatStatusLocal 'working' at the message handler). The wake-watchdog's island override still
  // presents 'reconnecting' on top while it is actively reviving a deaf/rate-limited agent.
  function applyClaudeTurnError(agentId) {
    const id = String(agentId ?? '0')
    const err = claudeTurnEndedError(id)
    if (!err) return false
    clearTurnActivity(id)
    chatErrors.set(id, agentErrorFor(err.cause))
    setChatStatusLocal(id, 'error', `api-error:${err.cause || 'error'}`)
    return true
  }
  function isBlitzUiChoiceText(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return false
    const fenceMatch = /^```blitz-ui\s*\n([\s\S]*?)\n?```\s*$/i.exec(trimmed)
    const jsonText = fenceMatch ? fenceMatch[1].trim() : trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : ''
    if (!jsonText) return false
    try {
      const spec = JSON.parse(jsonText)
      return !!(spec && typeof spec === 'object' && String(spec.prompt || '').trim() && Array.isArray(spec.options) && spec.options.length)
    } catch {
      return false
    }
  }
  function isIdleCompletionText(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
    if (!cleaned || isBlitzUiChoiceText(cleaned)) return false
    return /\b(?:i'?m|i am)\s+idle\b/i.test(cleaned) ||
      /\b(?:watching|waiting)\s+for\s+your\s+next\s+(?:message|request|task)\b/i.test(cleaned) ||
      /\bnothing\s+further\s+(?:needed|required)\b/i.test(cleaned) ||
      /\bno\s+further\s+(?:action|work)\s+(?:needed|required)\b/i.test(cleaned) ||
      /\bcomplete\s+and\s+delivered\b/i.test(cleaned)
  }
  function recentUserTurn(agentId, now = Date.now()) {
    const at = Number(chatUserTurnAt.get(String(agentId ?? '0'))) || 0
    return at > 0 && now - at <= CHAT_TERMINAL_WORK_MS
  }
  function extendTerminalWork(agentId, now = Date.now(), ms = CHAT_TERMINAL_WORK_MS) {
    chatTerminalWorkUntil.set(String(agentId ?? '0'), now + Math.max(0, ms))
  }
  function shortenTerminalWorkAfterSay(agentId, now = Date.now()) {
    if (terminalWorkActive(agentId, now)) extendTerminalWork(agentId, now, CHAT_POST_SAY_TERMINAL_WORK_MS)
  }
  function passiveChatStatus(agentId) {
    const id = String(agentId ?? '0')
    const meta = readAgentMeta(id)
    if (meta && meta.kind === 'agent' && meta.status === 'running') return 'watching'
    return 'idle'
  }
  function recomputeChatStatus(agentId, source = 'host') {
    const id = String(agentId ?? '0')
    const cur = chatStatuses.get(id)
    if (cur?.status === 'error' || cur?.status === 'stopped' || cur?.status === 'waiting' || cur?.status === 'starting') return cur.status
    if (hasActiveWorkflow(id)) return setChatStatusLocal(id, 'working', source)?.status || 'working'
    if (terminalWorkActive(id)) return setChatStatusLocal(id, 'working', source)?.status || 'working'
    return setChatStatusLocal(id, passiveChatStatus(id), source)?.status || 'idle'
  }
  function scheduleChatWatching(agentId, updatedAt) {
    const id = String(agentId ?? '0')
    clearChatQuietTimer(id)
    const timer = setTimeout(() => {
      chatQuietTimers.delete(id)
      const cur = chatStatuses.get(id)
      if (!cur || cur.updatedAt !== updatedAt || !CHAT_ACTIVE_STATUSES.has(cur.status)) return
      if (hasActiveWorkflow(id)) {
        setChatStatusLocal(id, 'working', 'workflow')
        updateChatHubState(id, true)
        return
      }
      if (applyClaudeTurnError(id)) {
        updateChatHubState(id, true)
        return
      }
      if (claudeTurnEndedClean(id)) {
        clearTurnActivity(id)
        setChatStatusLocal(id, 'watching', 'claude-end-turn')
        updateChatHubState(id, true)
        return
      }
      if (terminalWorkActive(id) || hasPostSaySettle(id)) {
        setChatStatusLocal(id, 'working', hasPostSaySettle(id) ? 'say-settle' : 'terminal-active')
        updateChatHubState(id, true)
        return
      }
      setChatStatusLocal(id, 'watching', 'quiet')
      updateChatHubState(id, true)
    }, CHAT_QUIET_MS)
    if (typeof timer.unref === 'function') timer.unref()
    chatQuietTimers.set(id, timer)
  }
  function setChatStatusLocal(agentId, status, source = 'host') {
    const id = String(agentId ?? '0')
    const s = String(status || 'idle')
    if (!CHAT_STATUSES.has(s)) return null
    const previousStatus = chatStatus(id)
    const rec = { status: s, updatedAt: Date.now(), source }
    chatStatuses.set(id, rec)
    if (s !== 'error') chatErrors.delete(id) // the error DETAIL lives only while the status is 'error'
    if (previousStatus !== s) {
      try { a.onChatStatusTransition?.({ agentId: id, previousStatus, status: s, source }) } catch { /* observers must not affect status */ }
    }
    if (s === 'working' || s === 'starting') scheduleChatWatching(id, rec.updatedAt)
    else {
      clearChatQuietTimer(id)
      clearEndTurnWatch(id) // settled (watching/waiting/idle/stopped/error) → the end_turn watcher's job is done
      if (s === 'waiting') clearPostSaySettle(id)
      if (s === 'idle' || s === 'stopped' || s === 'error') {
        clearPostSaySettle(id)
        chatUserTurnAt.delete(id)
        chatTerminalWorkUntil.delete(id)
        chatClaudeTurnStopOffset.delete(id)
      }
    }
    return rec
  }
  function chatStatus(agentId) {
    const id = String(agentId ?? '0')
    const v = chatStatuses.get(id)
    if (v?.status === 'error' || v?.status === 'stopped' || v?.status === 'waiting') return v.status
    if (hasActiveWorkflow(id)) return 'working'
    if (v?.status === 'starting') return v.status
    if (terminalWorkActive(id)) return 'working'
    if (CHAT_STATUSES.has(v?.status)) return v.status
    return passiveChatStatus(id)
  }
  /** A snapshot { id -> status } of EVERY chat-bearing agent's current status, for the W2 supervisor tick
   *  (plans/blitzos-tick-diff-steer.md). The transport (osActions/backend) feeds this to setTickSource so the
   *  tick can diff agent-status EDGES across the desktop. Built from the same chatStatuses the existing
   *  writers maintain, falling back through chatStatus() (so a running agent with no transient record still
   *  reports 'watching', not absent). agentIds() is the authority on WHICH agents exist (primary + on-disk). */
  function chatStatusSnapshot() {
    const out = {}
    for (const id of agentIds()) out[id] = chatStatus(id)
    return out
  }
  // Independent end_turn watcher (agent-status fix). Armed after a /say that keeps the agent 'working', it polls the
  // Claude session JSONL once a second for stop_reason:end_turn and flips to 'watching' ~1s after the turn ends.
  // It is its OWN timer chain so it SURVIVES the post-say terminal activity that cancels the settle poll (the
  // background wait.sh → noteAgentActivity 'terminal' → clearPostSaySettle). Claude-only: a Codex turn boundary is
  // an exit code, handled elsewhere. Self-clears on success or the 60s cap; otherwise cleared by a settled status
  // (setChatStatusLocal) or a new user turn (appendChat) — never by clearPostSaySettle.
  function scheduleEndTurnWatch(agentId) {
    const id = String(agentId ?? '0')
    if (!claudeAgentMeta(id)) return
    clearEndTurnWatch(id)
    let ticks = 0
    const MAX_TICKS = 60 // ~60s safety cap so a never-yielding turn can't leave a poller running forever
    const poll = () => {
      chatEndTurnWatchTimers.delete(id)
      if (++ticks > MAX_TICKS) return
      // Only the working→watching edge is ours to make: never clobber a status that legitimately supersedes — a
      // question's 'waiting', a surfaced 'error', 'stopped'/archived, a fresh 'starting'. Anything but 'working' = done.
      if (chatStatuses.get(id)?.status !== 'working') return
      if (claudeTurnEndedClean(id)) {
        clearTurnActivity(id)
        setChatStatusLocal(id, 'watching', 'end-turn-watch')
        updateChatHubState(id, true)
        return
      }
      const t = setTimeout(poll, 1000)
      if (typeof t.unref === 'function') t.unref()
      chatEndTurnWatchTimers.set(id, t)
    }
    const t = setTimeout(poll, 1000)
    if (typeof t.unref === 'function') t.unref()
    chatEndTurnWatchTimers.set(id, t)
  }
  function schedulePostSaySettle(agentId, text = '') {
    const id = String(agentId ?? '0')
    clearPostSaySettle(id)
    if (isBlitzUiChoiceText(text)) {
      clearTurnActivity(id)
      setChatStatusLocal(id, 'waiting', 'ask')
      return
    }
    if (hasActiveWorkflow(id)) {
      setChatStatusLocal(id, 'working', 'say')
      return
    }
    const cur = chatStatuses.get(id)
    if (cur?.status === 'waiting') return
    if (applyClaudeTurnError(id)) return
    if (isIdleCompletionText(text)) {
      clearTurnActivity(id)
      setChatStatusLocal(id, 'watching', 'say-final')
      return
    }
    if (claudeTurnEndedClean(id)) {
      clearTurnActivity(id)
      setChatStatusLocal(id, 'watching', 'claude-end-turn')
      return
    }
    const keepWorking = cur?.status === 'working' || cur?.status === 'waiting' || terminalWorkActive(id) || recentUserTurn(id)
    if (!keepWorking) {
      clearTurnActivity(id)
      setChatStatusLocal(id, 'watching', 'say')
      return
    }
    shortenTerminalWorkAfterSay(id)
    setChatStatusLocal(id, 'working', 'say')
    scheduleEndTurnWatch(id) // independent of the settle/terminal chain below — survives post-say terminal activity
    const startedAt = Date.now()
    const finishSettle = () => {
      chatPostSaySettleTimers.delete(id)
      if (hasActiveWorkflow(id)) {
        setChatStatusLocal(id, 'working', 'workflow')
      } else if (claudeTurnEndedClean(id)) {
        clearTurnActivity(id)
        setChatStatusLocal(id, 'watching', 'claude-end-turn')
      } else if (hasClaudeTurnBaseline(id) && Date.now() - startedAt < CHAT_POST_SAY_SETTLE_MS) {
        const nextDelay = Math.min(CHAT_CLAUDE_END_TURN_POLL_MS, Math.max(0, CHAT_POST_SAY_SETTLE_MS - (Date.now() - startedAt)))
        const nextTimer = setTimeout(finishSettle, nextDelay)
        if (typeof nextTimer.unref === 'function') nextTimer.unref()
        chatPostSaySettleTimers.set(id, nextTimer)
        return
      } else if (terminalWorkActive(id)) {
        setChatStatusLocal(id, 'working', 'terminal-post-say')
      } else {
        clearTurnActivity(id)
        setChatStatusLocal(id, 'watching', 'say-settle')
      }
      updateChatHubState(id, true)
    }
    const initialDelay = hasClaudeTurnBaseline(id) ? Math.min(CHAT_CLAUDE_END_TURN_POLL_MS, CHAT_POST_SAY_SETTLE_MS) : CHAT_POST_SAY_SETTLE_MS
    const timer = setTimeout(finishSettle, initialDelay)
    if (typeof timer.unref === 'function') timer.unref()
    chatPostSaySettleTimers.set(id, timer)
  }
  function noteAgentActivity(agentId, source = 'activity') {
    const id = String(agentId ?? '0')
    if (!agentIds().includes(id)) return { ok: false, error: 'unknown agent id' }
    if (source === 'say') {
      if (chatStatuses.get(id)?.status === 'waiting') return { ok: true, waiting: true }
      schedulePostSaySettle(id)
      updateChatHubState(id, true)
      return { ok: true }
    }
    if (chatStatuses.get(id)?.status === 'waiting') return { ok: true, waiting: true }
    if (source === 'terminal') {
      const now = Date.now()
      const postSayPending = hasPostSaySettle(id)
      const prev = Number(chatTerminalActivityAt.get(id)) || 0
      if (!postSayPending && now - prev < CHAT_TERMINAL_ACTIVITY_MS) return { ok: true, throttled: true }
      chatTerminalActivityAt.set(id, now)
      const cur = chatStatuses.get(id)
      if (cur?.status === 'starting') {
        setChatStatusLocal(id, 'starting', source)
        updateChatHubState(id, true)
        return { ok: true, warmup: true }
      }
      if (postSayPending) clearPostSaySettle(id)
      const postSayTerminal = postSayPending || cur?.source === 'terminal-post-say'
      if (hasActiveWorkflow(id) || postSayPending || cur?.status === 'working' || cur?.status === 'waiting' || terminalWorkActive(id, now) || recentUserTurn(id, now)) {
        extendTerminalWork(id, now, postSayTerminal ? CHAT_POST_SAY_TERMINAL_WORK_MS : CHAT_TERMINAL_WORK_MS)
      } else {
        return { ok: true, passive: true }
      }
      if (postSayTerminal) source = 'terminal-post-say'
    }
    if (source !== 'terminal') clearPostSaySettle(id)
    setChatStatusLocal(id, 'working', source)
    updateChatHubState(id, true)
    return { ok: true }
  }
  function noteWorkflowRun(agentId, runId, active) {
    const id = String(agentId ?? '0')
    const rid = String(runId || '')
    if (!rid) return { ok: false, error: 'missing run id' }
    if (!agentIds().includes(id)) return { ok: false, error: 'unknown agent id' }
    const set = chatWorkflowRuns.get(id) || new Set()
    if (active) {
      clearPostSaySettle(id)
      set.add(rid)
      chatWorkflowRuns.set(id, set)
      setChatStatusLocal(id, 'working', 'workflow')
    } else {
      set.delete(rid)
      if (set.size) chatWorkflowRuns.set(id, set)
      else chatWorkflowRuns.delete(id)
      recomputeChatStatus(id, 'workflow')
    }
    updateChatHubState(id, true)
    return { ok: true }
  }
  function previewText(messages) {
    const last = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null
    return last ? String(last.text || '').replace(/\s+/g, ' ').trim().slice(0, 96) : ''
  }
  function agentTitleText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
  }
  function defaultAgentTitle(id) {
    return 'New Agent'
  }
  function isDefaultAgentTitle(id) {
    const meta = readAgentMeta(id)
    const t = agentTitleText(meta.title || defaultAgentTitle(id))
    // 'New Agent' is the live default; also treat the legacy `Chat N` / `Agent N` defaults as un-named so
    // existing pre-rename sessions still get auto-titled by the haiku titler.
    return t === defaultAgentTitle(id) || t === `Chat ${id}` || t === `Agent ${id}`
  }
  function shouldAutoTitleAgent(id) {
    if (id === '0') return false
    if (!/^[0-9]+$/.test(id)) return false
    if (pendingAutoTitles.has(id)) return false
    if (typeof a.generateAgentTitle !== 'function') return false
    if (!isDefaultAgentTitle(id)) return false
    const messages = readChatMessages(activeWorkspace, 10000, id)
    return !messages.some((m) => m && m.role === 'user')
  }
  function scheduleAgentAutoTitle(id, text, workspacePath) {
    if (pendingAutoTitles.has(id)) return
    pendingAutoTitles.add(id)
    Promise.resolve()
      .then(() => a.generateAgentTitle({ agentId: id, text, workspacePath }))
      .then((title) => {
        const next = agentTitleText(title)
        if (!next) return
        if (activeWorkspace !== workspacePath) return
        if (!isDefaultAgentTitle(id)) return
        renameAgent(id, next)
      })
      .catch(() => {})
      .finally(() => {
        pendingAutoTitles.delete(id)
      })
  }
  function sessionSummary(id, meta, messages, sessionStatus) {
    return {
      id,
      title: id === '0' ? 'Blitz' : agentTitleText(meta.title || defaultAgentTitle(id)),
      status: sessionStatus,
      updatedAt: Math.max(Number(messages[messages.length - 1]?.ts) || 0, Number(chatStatuses.get(id)?.updatedAt) || 0),
      lastMessagePreview: previewText(messages),
      unread: false,
      ...(meta.archived ? { archivedAt: Number(meta.archivedAt) || 0 } : {})
    }
  }
  function chatHubProps(activeAgentId = '0') {
    const ids = agentIds()
    const archivedIds = archivedAgentIds()
    const threads = {}
    const status = {}
    const errors = {} // id -> { cause, title, hint, retryable } for any agent currently in 'error' (else absent)
    const sessions = ids.map((id) => {
      const meta = readAgentMeta(id)
      const messages = readChatMessages(activeWorkspace, 400, id)
      threads[id] = messages
      status[id] = chatStatus(id)
      const err = chatErrors.get(id)
      if (err) errors[id] = err
      return sessionSummary(id, meta, messages, status[id])
    })
    const archivedSessions = archivedIds.map((id) => {
      const meta = readAgentMeta(id)
      const messages = readChatMessages(activeWorkspace, 400, id)
      return sessionSummary(id, meta, messages, chatStatus(id))
    })
    const requestedActive = String(activeAgentId ?? '0')
    const active = ids.includes(requestedActive) ? requestedActive : '0'
    return {
      sessions,
      archivedSessions,
      threads,
      status,
      errors,
      activeAgentId: active,
      // Back-compat for old/custom chat UIs that still render a single messages array.
      messages: threads[active] || threads['0'] || [],
      agentId: active,
      sessionId: active
    }
  }
  function updateChatHubState(activeAgentId = '0', broadcast = false) {
    const props = chatHubProps(activeAgentId)
    const sid = chatSurfaceId('0')
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) {
        let found = false
        const surfaces = st.surfaces.map((s) => {
          if (s && (s.id === sid || (s.role === 'chat' && String(s.agentId ?? '0') === '0'))) {
            found = true
            return { ...s, props: { ...(s.props || {}), ...props } }
          }
          return s
        })
        a.setState({ ...st, surfaces: found ? surfaces : [...surfaces, buildAgentSurface('0')] })
      }
    } catch {
      /* getState/setState optional */
    }
    if (broadcast) a.broadcast({ type: 'chat', agentId: String(activeAgentId ?? '0'), ...props })
    return props
  }
  /** Build the shared chat hub surface (ensuring/recreating blitz-chat.* if missing). */
  function buildAgentSurface(agentId = '0') {
    ensureSystemRenderer(activeWorkspace, 'chat', '0')
    const primary = true
    const info = readSystemRendererInfo(activeWorkspace, 'chat', '0')
    const w = 360
    return {
      id: chatSurfaceId(agentId),
      kind: 'srcdoc',
      role: 'chat',
      pinned: primary,
      agentId: String(agentId),
      title: 'Blitz',
      x: -700,
      y: -210,
      w,
      h: 460,
      z: 5,
      html: info?.source || '',
      lang: info?.lang || 'html',
      props: chatHubProps(String(agentId ?? '0'))
    }
  }
  /** The one chat hub surface — built on hydrate/switch. */
  function buildAgentSurfaces() { return [buildAgentSurface('0')] }
  /** Re-open the primary chat widget after the human closes it. */
  function restoreChatHub() {
    const st = a.getState() || { surfaces: [] }
    const chat = buildAgentSurface('0')
    const surfaces = Array.isArray(st.surfaces) ? st.surfaces : []
    const matchesPrimaryChat = (s) => s && (s.id === chat.id || (s.role === 'chat' && String(s.agentId ?? '0') === '0'))
    const nextSurfaces = surfaces.some(matchesPrimaryChat)
      ? surfaces.map((s) => (
          matchesPrimaryChat(s)
            ? { ...chat, ...s, minimized: false, html: chat.html, lang: chat.lang, props: chat.props }
            : s
        ))
      : [...surfaces, chat]
    a.setState({ ...st, surfaces: nextSurfaces })
    a.broadcast({ type: 'create', surface: { ...chat, minimized: false }, focus: true })
    return { ok: true, id: chat.id }
  }
  /** Mint the next agent id: max existing integer id + 1 (primary '0' counts), so ids stay 1,2,3…
   *  Non-numeric ids (none today) are ignored for the max. */
  function newAgentId() {
    let max = 0
    for (const id of allAgentIds()) { const n = Number(id); if (Number.isInteger(n) && n > max) max = n }
    const id = String(max + 1)
    // IDs are REUSED: a closed agent frees its number (allAgentIds drops the deleted dir), so this fresh agent can be
    // reborn onto a previous agent's id. Wipe all leftover files for that id NOW so the new chat starts clean — the
    // chat file (chat-N.md) is the critical one: if a previous session crashed without calling closeAgent, the file
    // survives and the new agent inherits the old messages (the context-leak bug). removeAgentFiles also covers the
    // attachment snapshot + the terminal dir (a no-op if they don't exist). newAgentId is called ONLY for a brand-new
    // spawn (osSpawnAgent), never on boot reconstruction, so this never touches a live agent.
    removeAgentFiles(activeWorkspace, id)
    return id
  }
  /** Register a new agent: write its meta (kind:'agent'), refresh the chat hub's thread list, and launch
   *  its managed terminal. Idempotent — re-adding an existing agent just refreshes the hub/thread. */
  function addAgent(agentId, title, opts = {}) {
    const id = String(agentId)
    const name = title || (id === '0' ? 'Blitz' : defaultAgentTitle(id))
    // Persist the agent RECORD up front (kind:'agent') so the agent survives a restart even when no
    // backend is auto-launched. launchAgent (below) will overwrite this with the full live
    // meta when it spawns the terminal; both keep the same id/kind/title, so agentIds() finds it.
    // Single-canvas nav: every agent lives at HOME (stage 0); there are no per-agent stages anymore.
    try {
      const dir = join(agentDir(), id) // canonical `.blitzos/terminals`, or the legacy dir if migration hasn't run yet
      mkdirSync(dir, { recursive: true })
      const mp = join(dir, 'meta.json')
      let m = {}
      try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { /* fresh */ }
      // The ORCHESTRATORS toggle is stamped HERE, BEFORE launchAgent (below) builds the first bootstrap — so
      // bootTaskProvider reads it and the agent's first launch already carries the orchestrator duty (no re-exec).
      // `...m` already carries an on-disk orchestrators flag (idempotent re-add); opts.orchestrators sets it on a
      // new spawn. It is sticky: once set it is never unset via addAgent (the spread keeps it).
      writeFileSync(mp, JSON.stringify({ ...m, id, kind: 'agent', title: m.title || name, stage: 0, createdAt: m.createdAt || Date.now(), ...(opts.orchestrators ? { orchestrators: true } : {}) }, null, 2))
    } catch { /* best-effort: the surface still works in-memory this run */ }
    setChatStatusLocal(id, 'idle')
    updateChatHubState(id, true)
    // Launch the agent in a VISIBLE terminal at home (only when a launcher is wired — BLITZ_AGENT on).
    try { a.launchAgent?.(id, 0, name) } catch (e) { console.error('[workspace] launchAgent failed:', e?.message || e) }
    return { id, title: name, focus: !!opts.focus }
  }
  /** Toggle the ORCHESTRATORS (dynamic-workflows) capability on an agent: set/clear the durable flag on its
   *  meta.json. The boot-task provider reads it on every (re)launch (so the duty lands in bootstrap), and
   *  spawnTerminal carries it across re-exec. The LIVE wake (delivery B) is the caller's job (osActions). */
  function setAgentOrchestrators(agentId, on) {
    return setTerminalOrchestrators(agentDir(), String(agentId), !!on)
  }
  /** Boot: (re)launch EVERY agent with the CURRENT relay url and persisted backend metadata. We deliberately
   *  re-exec rather than reattach a survivor: the relay url is re-minted each run, so a survivor would hold a
   *  DEAD url and silently disconnect. spawnTerminal replaces any existing window, so there's no duplicate.
   *  No-op when launchAgent is unwired. */
  function resumeAgentsOnBoot() {
    if (typeof a.launchAgent !== 'function') return
    for (const id of agentIds()) {
      try {
        setChatStatusLocal(id, 'starting', 'resume')
        a.launchAgent(id, 0)
      } catch (e) { console.error('[workspace] resumeAgent failed for', id, e?.message || e) } // single home → stage 0
    }
  }
  function setAgentArchived(agentId, archived) {
    const id = String(agentId)
    if (id === '0') return { ok: false, error: 'cannot archive the primary agent' }
    if (!/^[0-9]+$/.test(id)) return { ok: false, error: 'invalid agent id' }
    if (switching) return { ok: false, error: 'switch in progress' }
    const meta = readAgentMeta(id)
    if (!meta || (meta.kind !== 'agent' && meta.kind !== 'chat')) return { ok: false, error: 'unknown agent id' }
    const next = { ...meta, id, kind: meta.kind || 'agent' }
    if (archived) {
      next.archived = true
      next.archivedAt = Date.now()
    } else {
      delete next.archived
      delete next.archivedAt
    }
    try {
      writeAgentMeta(id, next)
    } catch (e) {
      return { ok: false, error: e?.message || (archived ? 'archive failed' : 'restore failed') }
    }
    if (archived) {
      try { a.pauseAgent?.(id) } catch (e) { console.error('[workspace] pauseAgent failed for', id, e?.message || e) }
      clearChatQuietTimer(id)
      clearPostSaySettle(id)
      chatTerminalActivityAt.delete(id)
      chatTerminalWorkUntil.delete(id)
      chatUserTurnAt.delete(id)
      chatClaudeTurnStopOffset.delete(id)
      chatWorkflowRuns.delete(id)
      setChatStatusLocal(id, 'stopped', 'archive')
    } else {
      setChatStatusLocal(id, 'starting', 'restore')
      try {
        if (typeof a.restartAgent === 'function') a.restartAgent(id)
        else a.launchAgent?.(id, 0, next.title)
      } catch (e) {
        console.error('[workspace] restartAgent failed for', id, e?.message || e)
      }
    }
    updateChatHubState(archived ? '0' : id, true)
    return { ok: true, archived: !!archived }
  }
  function archiveAgent(agentId) { return setAgentArchived(agentId, true) }
  function unarchiveAgent(agentId) { return setAgentArchived(agentId, false) }
  /** Close a NON-primary agent: stop it (no auto-restart), remove its transcript/system renderer files +
   *  terminal metadata (chat-<id>.md, blitz-<id>-chat.*, .blitzos/terminals/<id>/), and drop its chat widget.
   *  Primary '0' is never closable. Idempotent. */
  function closeAgent(agentId) {
    const id = String(agentId)
    if (id === '0') return { ok: false, error: 'cannot close the primary agent' }
    // SECURITY: an agent id is always numeric (newAgentId). Reject anything else so a crafted id
    // (e.g. '..' or '../x') can't path-traverse in removeAgentFiles and delete the wrong tree —
    // close_agent is reachable from the UNTRUSTED relay agent.
    if (!/^[0-9]+$/.test(id)) return { ok: false, error: 'invalid agent id' }
    if (switching) return { ok: false, error: 'switch in progress' }
    try { a.stopAgent?.(id) } catch (e) { console.error('[workspace] stopAgent failed for', id, e?.message || e) } // sets stopping → no auto-restart
    removeAgentFiles(activeWorkspace, id) // delete the agent dir FIRST so agentIds() drops it
    clearChatQuietTimer(id)
    clearPostSaySettle(id)
    chatTerminalActivityAt.delete(id)
    chatTerminalWorkUntil.delete(id)
    chatUserTurnAt.delete(id)
    chatClaudeTurnStopOffset.delete(id)
    chatWorkflowRuns.delete(id)
    chatStatuses.delete(id)
    const sid = chatSurfaceId(id)
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) a.setState({ ...st, surfaces: st.surfaces.filter((s) => s && s.id !== sid) })
    } catch { /* adapter without getState/setState */ }
    a.broadcast({ type: 'close', id: sid }) // renderer drops the chat widget (+ its terminal tab — see store.closeAgent)
    a.broadcast({ type: 'agent-remove', id }) // tray re-lists
    updateChatHubState('0', true)
    return { ok: true }
  }
  /** Rename an agent (cosmetic — the id stays the file key). Updates meta + the widget title live. */
  function renameAgent(agentId, newTitle) {
    const id = String(agentId)
    const title = agentTitleText(newTitle)
    if (!title) return { ok: false, error: 'title required' }
    if (id === '0') return { ok: false, error: 'main agent cannot be renamed' }
    // SECURITY: numeric id only — else the meta.json write below (raw join on the id) path-escapes the
    // workspace (e.g. id '../../../../tmp/evil'). Untrusted-relay reachable via rename_agent.
    if (!/^[0-9]+$/.test(id)) return { ok: false, error: 'invalid agent id' }
    if (switching) return { ok: false, error: 'switch in progress' }
    try {
      const mp = join(agentDir(), id, 'meta.json')
      let m = {}
      try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { /* fresh */ }
      mkdirSync(join(mp, '..'), { recursive: true })
      writeFileSync(mp, JSON.stringify({ ...m, id, kind: m.kind || 'agent', title }, null, 2))
    } catch (e) { return { ok: false, error: e?.message || 'rename failed' } }
    const sid = chatSurfaceId(id)
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.id === sid ? { ...s, title } : s)) })
    } catch { /* adapter without getState/setState */ }
    a.broadcast({ type: 'update', id: sid, patch: { title } })
    a.broadcast({ type: 'agent-rename', id, title })
    updateChatHubState(id, true)
    return { ok: true, title }
  }
  /** Publish the CURRENT relay base url to <ws>/.blitzos/relay-url — the file every agent re-reads on each
   *  call, so a reattached agent self-heals onto the fresh url after BlitzOS restarts (no privileged brain to
   *  restart). Called on boot + on every relay url change by both transports. */
  function setRelayUrl(url) {
    const dir = join(activeWorkspace, '.blitzos')
    try { markWrite(join(dir, 'relay-url')) } catch { /* ignore */ } // our own write — the watcher must skip it
    writeRelayUrl(dir, url)
  }
  /** One-time: an OLD workspace kept the transcript in panels.json — seed chat.md from it so no history is lost. */
  function migrateChatToFile() {
    if (readChatMessages(activeWorkspace).length) return
    const chat = readRuntimePanels(activeWorkspace).find((p) => p.component === 'chat')
    const msgs = chat && chat.props && Array.isArray(chat.props.messages) ? chat.props.messages : []
    for (const m of msgs) appendChatMessage(activeWorkspace, m.role === 'user' ? 'user' : 'agent', String(m.text || ''))
  }
  /** Append a chat message to an AGENT's transcript and broadcast it so that agent's widget re-renders.
   *  role 'user' (the human typed) | 'agent' (a `say`). agentId defaults to '0' (the primary chat). */
  function appendChat(role, text, agentId = '0', meta) {
    const aid = String(agentId ?? '0')
    const shouldAutoTitle = role === 'user' && shouldAutoTitleAgent(aid)
    const workspacePath = activeWorkspace
    if (role === 'user') {
      clearPostSaySettle(aid)
      clearEndTurnWatch(aid) // new user turn: drop the prior turn's watcher (the agent's next say re-arms a fresh one)
      rememberClaudeTurnBaseline(aid)
      chatUserTurnAt.set(aid, Date.now())
      setChatStatusLocal(aid, 'working', 'user-message')
    }
    if (role === 'agent') {
      schedulePostSaySettle(aid, text)
    }
    appendChatMessage(activeWorkspace, role, text, aid, meta)
    const props = updateChatHubState(aid, true)
    if (shouldAutoTitle) scheduleAgentAutoTitle(aid, text, workspacePath)
    return props.threads?.[aid] || []
  }
  /** The agent customizes its widget UI by rewriting blitz-[<id>-]<name>.html, then we live-reload
   *  that one surface (the iframe reloads → re-earns its capabilities; transcript re-seeds from props). */
  function customizeWidget(name, html, agentId = '0', lang = 'html') {
    const targetAgentId = name === 'chat' ? '0' : agentId
    const r = writeSystemRenderer(activeWorkspace, name, html, targetAgentId, lang)
    if (!r.ok) return r
    if (name === 'chat') {
      const info = readSystemRendererInfo(activeWorkspace, 'chat', '0')
      const newHtml = info?.source || ''
      const sid = chatSurfaceId('0')
      try {
        const st = a.getState()
        if (st && Array.isArray(st.surfaces)) a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.id === sid ? { ...s, html: newHtml, lang: info?.lang || 'html' } : s)) })
      } catch {
        /* adapter without getState/setState */
      }
      a.broadcast({ type: 'update', id: sid, patch: { html: newHtml, lang: info?.lang || 'html' } })
      // Report the affected surface id so the transport can absorb it from the W2 tick (a tool-origin edit
      // must not self-wake the supervisor). doReconcile-path widgets (note) are a BULK transition the
      // transport already covers via resetTickBaseline, so they need no per-surface absorb id here.
      return { ...r, surfaceId: sid }
    } else if (name === 'note') {
      doReconcile({}) // re-materialize every note through the (now-present) blitz-note.html renderer
    }
    return r
  }
  /** Read a system widget's current UI source (workspace file, else the shipped default) — read-before-edit. */
  function systemUi(name) {
    return readSystemRenderer(activeWorkspace, name)
  }
  function systemUiInfo(name) {
    return readSystemRendererInfo(activeWorkspace, name)
  }
  function setChatStatus(agentId, status, cause) {
    const id = String(agentId ?? '0')
    // Stamp the human-facing detail BEFORE flipping the status (setChatStatusLocal only CLEARS it for non-error).
    if (status === 'error') chatErrors.set(id, agentErrorFor(cause))
    setChatStatusLocal(id, status, 'terminal')
    updateChatHubState(id, true)
    return { ok: true }
  }
  /** Make an EMPTY real folder ('New Folder') or '.board' on-canvas folder ('New Board'), then reconcile
   *  at (x,y) so a normal folder shows as one tile (an empty board has no children to splay yet). */
  function newFolder(name, kind, x, y) {
    if (switching) return { error: 'switch in progress' }
    const r = createFolder(activeWorkspace, name, kind)
    if (!r || !r.ok) return { error: (r && r.error) || 'could not create folder' }
    doReconcile({ cx: Number(x) || 0, cy: Number(y) || 0 })
    return { ok: true, folder: r.folder }
  }
  function startWatch() {
    try {
      mkdirSync(join(activeWorkspace, '.blitzos'), { recursive: true })
    } catch {
      /* ignore */
    }
    const onEvent = (sub) => (_evt, filename) => {
      if (!filename) return scheduleReconcile()
      if (/(^\.tmp)|(\.tmp(-[0-9a-f]+)?$)/.test(filename)) return // our atomic temp files
      // Inside .blitzos only workspace.json can change what the canvas shows — sessions/, state/
      // (thumbnails), tmux/, relay-url churn CONSTANTLY while a brain runs and were driving a
      // full folder re-scan + reconcile broadcast every ~0.8s (the storm telemetry caught in the VM).
      if (sub === '.blitzos' && String(filename) !== 'workspace.json') return
      if (wasSelfWrite(join(activeWorkspace, sub, filename))) return // our own write
      scheduleReconcile()
    }
    try {
      watchers.push(watch(activeWorkspace, onEvent('')))
      watchers.push(watch(join(activeWorkspace, '.blitzos'), onEvent('.blitzos')))
      console.log(`[workspace] watching ${activeWorkspace} for external edits`)
    } catch (e) {
      console.error('[workspace] watch failed:', e?.message || e)
    }
  }
  function stopWatch() {
    for (const timer of chatQuietTimers.values()) clearTimeout(timer)
    chatQuietTimers.clear()
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
    watchers = []
  }

  /** Boot: load the active workspace into osState (the caller broadcasts hydrate to renderers). */
  function hydrateOnBoot() {
    try {
      const h = readWorkspace(activeWorkspace)
      // The chat is now a srcdoc widget backed by blitz-chat.* + per-agent transcript files. The
      // activity feed still lives in .blitzos/state/panels.json. Merge both back on boot.
      relocateLegacyChats(activeWorkspace) // ISOLATION: move any root-resident transcript into its private per-agent dir BEFORE agents boot
      migrateChatToFile() // seed the transcript from an old panels.json one, once
      const panels = readRuntimePanels(activeWorkspace).filter((p) => p.component === 'activity')
      const base = h || { surfaces: [] }
      const surfaces = [...base.surfaces, ...buildAgentSurfaces(), ...panels]
      a.setState({ surfaces })
      if (surfaces.length) console.log(`[workspace] hydrated ${base.surfaces.length} surface(s) + ${panels.length} panel(s) from ${activeWorkspace}`)
    } catch (e) {
      console.error('[workspace] hydrate failed:', e?.message || e)
    }
  }

  /** The renderer pushed its state — persist it (with the stale-push guard) + realize surfaces. */
  function onStatePush(s) {
    if (!s || !Array.isArray(s.surfaces)) return
    // Drop a stale push: mid-switch, or tagged with a workspace we've switched away from (else it
    // clobbers osState and persists the OLD board into the NEW folder). Untagged pushes pass.
    if (switching || (typeof s.workspace === 'string' && s.workspace !== active())) return
    // (1) REJECT a stale re-push of a just-closed surface — else a still-connected renderer resurrects a
    // file-backed surface we authoritatively closed (the junk-resurrection bug).
    const now = Date.now()
    for (const [id, exp] of recentlyClosed) if (exp <= now) recentlyClosed.delete(id)
    let pushed = recentlyClosed.size ? s.surfaces.filter((x) => !(x && recentlyClosed.has(x.id))) : s.surfaces
    // (2) RE-ASSERT host-owned runtime surfaces. The host owns each agent's chat widget + the activity panel,
    // and NONE of them are serialized (they're rebuilt on hydrate/switch). A wholesale `setState` would let a
    // renderer push that DROPPED one (a mid-hydrate race, or a renderer that hadn't reconstructed it yet)
    // DELETE it from osState — and it would stay gone until the next hydrate/switch. That is the chat-widget-
    // loss bug. So rebuild any host-owned runtime surface missing from the push and add it back. Cheap —
    // compares ids first and only rebuilds the (usually zero) that are actually absent.
    const have = new Set(pushed.map((x) => x && x.id))
    const missing = []
    if (!have.has(chatSurfaceId('0'))) missing.push(buildAgentSurface('0'))
    for (const p of readRuntimePanels(activeWorkspace).filter((p) => p.component === 'activity')) if (!have.has(p.id)) missing.push(p)
    // (2b) RE-ASSERT a FILE-BACKED surface a GLITCHY push DROPPED — the same fragility as (2), for the
    // surfaces that ARE workspace.json nodes (srcdoc widgets, notes, web/app, file/dir tiles). onStatePush
    // does a wholesale setState, so a push that lost a live tile (a render-process-gone reload, a hydrate
    // race, an HMR remount) would persist the shrink to workspace.json on the next flush. writeWorkspace
    // never DELETES content files — only an explicit close does — so the dropped node's file ORPHANS, and the
    // next reconcile RESURRECTS it as a brand-new slotless, staggered tile with a fresh UUID: the "every
    // widget popped out and stacked after relaunch" bug (root cause + proof: scripts/repro-slot-orphan.mjs).
    // A genuine close is in recentlyClosed (its file already deleted); an external file delete leaves no file.
    // So: was in the PRIOR osState + absent from this push + NOT a close + its content file STILL on disk ⇒ a
    // glitch-drop, not a removal — keep it. Cheap: zero disk I/O on the common no-drop push; one workspace.json
    // parse + stat only per actually-dropped, non-runtime id.
    const priorState = a.getState()
    for (const p of (priorState && priorState.surfaces) || []) {
      if (!p || have.has(p.id) || recentlyClosed.has(p.id) || isRuntimeLike(p)) continue
      if (surfaceFileExists(activeWorkspace, p.id)) missing.push(p)
    }
    let surfaces = missing.length ? [...pushed, ...missing] : pushed
    // (3) RECONCILE the inbox: its items are runtime-only and a renderer can push a STALE copy (carried in
    // osState across page loads). Overwrite them with the authoritative store so osState — and every hydrate
    // read of it — shows EXACTLY listActions(), never phantom items the store no longer has.
    surfaces = reconcileInboxItems(surfaces, actionItemsNow())
    a.setState(surfaces === s.surfaces ? s : { ...s, surfaces })
    Promise.resolve(onSurfaces(surfaces)).catch(() => {})
    scheduleWrite()
  }

  /** The surfaces to send a CONNECTING renderer (its hydrate) — current osState surfaces with the inbox's
   *  items reconciled to the authoritative store. Both transports call this for the hydrate `surfaces` field
   *  so a fresh connect can never receive a stale inbox copy that osState happened to be carrying (the seed
   *  happens with no renderer attached → no onStatePush fires → osState would otherwise stay stale). */
  function hydrateSurfaces() {
    const st = a.getState() || {}
    return reconcileInboxItems(st.surfaces || [], actionItemsNow())
  }

  /** Atomic single-flight switch. Returns { status, body }. */
  async function performSwitch(rawName) {
    if (switching) return { status: 409, body: { error: 'switch in progress' } }
    const name = safeName(rawName)
    if (!name) return { status: 400, body: { error: 'invalid workspace name' } }
    const newPath = resolveWorkspace(root, name, { mustExist: true })
    if (!newPath) return { status: 404, body: { error: 'no such workspace' } }
    if (newPath === activeWorkspace) return { status: 200, body: { ok: true, active: name } } // no-op
    switching = true
    try {
      flush() // persist OLD → OLD; clears writeTimer
      if (reconcileTimer) {
        clearTimeout(reconcileTimer) // flush doesn't clear this — a queued reconcile would hit the new dir
        reconcileTimer = null
      }
      clearChatRuntimeState()
      stopWatch()
      activeWorkspace = newPath // load-bearing: AFTER flush (flush already persisted OLD's chat to OLD)
      const next = readWorkspace(newPath) || blank()
      // Per-workspace chat/activity: the DESTINATION's own chat (its blitz-chat.* + chat transcripts) and its
      // activity panel — never carry the previous workspace's over.
      relocateLegacyChats(newPath) // ISOLATION: relocate the destination's root-resident transcripts before its agents resume
      migrateChatToFile()
      const surfaces = [...next.surfaces, ...buildAgentSurfaces(), ...readRuntimePanels(newPath).filter((p) => p.component === 'activity')]
      a.setState({ surfaces })
      await Promise.resolve(onSurfaces(surfaces)) // awaited so an overlapping switch can't strand targets
      startWatch()
      rememberActive() // boot returns the user HERE, not to the default
      a.broadcast({ type: 'switch', surfaces, workspace: name })
      console.log(`[workspace] switched → ${name}`)
      return { status: 200, body: { ok: true, active: name } }
    } finally {
      switching = false
    }
  }

  // Last-seen thumbnail per workspace (.blitzos/state/thumb.jpg) — shared store; the per-transport
  // CAPTURE differs (server: renderer composites the streamed canvases; Electron: main capturePage).
  function thumbStateDir(name) {
    const dir = resolveWorkspace(root, name, { mustExist: true })
    return dir ? join(dir, '.blitzos', 'state') : null
  }
  function writeThumb(name, buf) {
    const dir = thumbStateDir(name)
    if (!dir) return false
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'thumb.jpg'), buf)
    return true
  }
  // Read a real file from the ACTIVE workspace for an image preview (#46, the Electron blitz-file://
  // counterpart of the server /api/os/file route) — same jail: realpath both, reject escapes +
  // .blitzos, cap size. Returns { buf, contentType } or null.
  function readWorkspaceFile(rel) {
    try {
      const root = realpathSync(resolve(activeWorkspace))
      const real = realpathSync(resolve(root, rel || ''))
      if (real !== root && !real.startsWith(root + sep)) return null
      if (/(^|[/\\])\.blitzos([/\\]|$)/i.test(real.slice(root.length))) return null
      const st = statSync(real)
      if (!st.isFile() || st.size > 25 * 1024 * 1024) return null
      const ext = (real.split('.').pop() || '').toLowerCase()
      const mime =
        { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' }[ext] ||
        'application/octet-stream'
      return { buf: readFileSync(real), contentType: mime }
    } catch {
      return null
    }
  }
  function readThumb(name) {
    const dir = thumbStateDir(name)
    if (!dir) return null
    try {
      return readFileSync(join(dir, 'thumb.jpg'))
    } catch {
      return null
    }
  }

  /** Delete a workspace + its folder. POLICY GUARDS live here (the serializer just removes the dir):
   *   - never the LAST workspace (the app must always have one to be in);
   *   - if it's the ACTIVE one, switch to another FIRST (newest other) so we never rm the live folder
   *     out from under the running host — only then delete the now-inactive dir.
   *  Returns { ok, active } or { error }. */
  async function removeWorkspace(rawName) {
    if (switching) return { ok: false, error: 'switch in progress' }
    const name = safeName(rawName)
    if (!name) return { ok: false, error: 'invalid workspace name' }
    const all = listWorkspaces(root)
    if (!all.some((w) => w.name === name)) return { ok: false, error: 'no such workspace' }
    if (all.length <= 1) return { ok: false, error: 'cannot delete the last workspace' }
    if (basename(activeWorkspace) === name) {
      const other = all.find((w) => w.name !== name) // listWorkspaces is newest-first → most-recent other
      const sw = await performSwitch(other.name)
      if (sw.status !== 200) return { ok: false, error: `could not switch away before delete: ${sw.body?.error || 'switch failed'}` }
    }
    try {
      deleteWorkspace(root, name)
    } catch (e) {
      return { ok: false, error: e?.message || 'delete failed' }
    }
    // Renderers re-list on their own (the Overview re-fetches), but broadcast so any other open view refreshes.
    try {
      a.broadcast({ type: 'workspaces-changed', active: basename(activeWorkspace) })
    } catch {
      /* best-effort */
    }
    return { ok: true, active: basename(activeWorkspace) }
  }

  return {
    active,
    activePath: () => activeWorkspace,
    ingestFile,
    ingestPaths,
    ingestUpload,
    reconcileAt,
    newFolder,
    listDir: listDirInWorkspace,
    renameFolder: renameFolderInWorkspace,
    moveIntoFolder: moveIntoFolderInWorkspace,
    moveOutOfFolder: moveOutOfFolderInWorkspace,
    openFolderEntry: openFolderEntryInWorkspace,
    closeSurfaceFile,
    locateSurface,
    bringSurfaceHere,
    appendChat,
    customizeWidget,
    systemUi,
    systemUiInfo,
    setChatStatus,
    noteAgentActivity,
    noteWorkflowRun,
    chatStatusSnapshot,
    chatHubProps,
    agentIds,
    restoreChatHub,
    newAgentId,
    addAgent,
    setAgentOrchestrators,
    archiveAgent,
    unarchiveAgent,
    closeAgent,
    renameAgent,
    resumeAgentsOnBoot,
    setRelayUrl,
    group,
    // #53: per-workspace consent persistence (read on boot/switch, write on a human grant). The write
    // MERGES (a caller may update just `surfaces` or just `providers` — e.g. the widget bridge vs the
    // sensitive-read gate — without clobbering the other).
    consent: () => readConsent(activeWorkspace),
    persistConsent: (c) => {
      const cur = readConsent(activeWorkspace)
      writeConsent(activeWorkspace, {
        surfaces: c && c.surfaces !== undefined ? c.surfaces : cur.surfaces,
        providers: c && c.providers !== undefined ? c.providers : cur.providers
      })
    },
    isSwitching: () => switching,
    hydrateOnBoot,
    onStatePush,
    hydrateSurfaces,
    performSwitch,
    flush,
    startWatch,
    stopWatch,
    list: () => listWorkspaces(root),
    create: (name) => createWorkspace(root, name),
    removeWorkspace,
    writeThumb,
    readThumb,
    readWorkspaceFile
  }
}
