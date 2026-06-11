// Shared workspace HOST — owns the active-workspace runtime: hydrate, persist (debounced), watch +
// reconcile external edits, switch (atomic, single-flight), list/create, and the last-seen thumbnail
// store. Used by BOTH preview/backend.mjs (server mode) AND src/main/osActions.ts (Electron) — there
// is ONE implementation, no second copy to drift. The serializer (workspace.mjs) does disk I/O; the
// per-transport bits (reaching renderers, realizing web surfaces) are adapter callbacks. This is the
// control-core.mjs / perception-core.mjs pattern: one feature, both modes.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, watch, statSync, realpathSync } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
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
  ensureSystemRenderer,
  readSystemRenderer,
  writeSystemRenderer,
  readChatMessages,
  appendChatMessage,
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
  relocateSurface
} from './workspace.mjs'
// Stage grid: a chat session N owns stage N (stageForSession), so its chat widget + the windows its agent
// opens land in stage N — isolated from the user's primary (stage 0). Shared with the renderer (one grid).
import { stageForSession, stageCenterX, DEFAULT_VP } from '../renderer/src/stages-core.mjs'
// The agent's volatile relay base url lives in a file the agent re-reads each call (self-heal across restarts).
import { writeRelayUrl } from './agent-session.mjs'

/**
 * @param {object} a
 * @param {string}   a.root         WORKSPACES_ROOT (holds many workspace folders)
 * @param {string}  [a.initialName] 'Home' default, or the basename of an explicit override
 * @param {() => any} a.getState    returns the current osState ({surfaces,camera,mode,view})
 * @param {(s:any) => void} a.setState  sets osState (the host owns it on hydrate/switch/reconcile)
 * @param {(obj:any) => void} a.broadcast  send a message to all connected renderers
 * @param {(surfaces:any[]) => (Promise<any>|void)} [a.onSurfaces]  realize web surfaces (server: spin/tear
 *        headless targets; Electron: no-op, the renderer owns <webview>s)
 * @param {'canvas'|'desktop'} [a.defaultMode]  blank-workspace mode (server: canvas, Electron: desktop)
 * @param {boolean} [a.explicitInitial]  true when initialName was PINNED by the user (BLITZ_WORKSPACE):
 *        skip the boot-where-you-left-off preference and honor the pin.
 */
export function createWorkspaceHost(a) {
  const root = resolve(a.root)
  const onSurfaces = a.onSurfaces || (() => {})
  const defaultMode = a.defaultMode === 'desktop' ? 'desktop' : 'canvas'
  mkdirSync(root, { recursive: true })

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

  const active = () => basename(activeWorkspace)
  const blank = () => ({ surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: defaultMode, stageCount: 1 })

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
      // Preserve LIVE state that disk doesn't represent, so a reconcile never destroys it:
      //  - runtime chat/activity panels + iPhone-style folder groupings (never persisted as nodes)
      //  - surfaces that exist in osState but aren't a workspace.json node yet (agent-created /
      //    in-flight). `r.knownIds` ARE the persisted node ids: an osState id NOT in knownIds and
      //    NOT in the reconciled set is genuinely un-persisted → keep it (a DELETED file's id IS a
      //    known node → it correctly drops). Re-apply group memberships to the disk surfaces too.
      // Runtime-only surfaces (never serialized as workspace.json nodes). This MUST match the renderer's
      // isRuntime predicate in store.ts applyReconcile — the two run the same reconcile contract and any
      // drift is exactly the divergence the parity guard exists to prevent. terminal/sessions/inbox are
      // reconstructed from session/action-item events on load, so they're kept across a reconcile here too.
      const isRuntimeLike = (s) => s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity' || s.component === 'folder' || s.component === 'terminal' || s.component === 'sessions' || s.component === 'inbox' || s.component === 'unlock'))
      const reconciledIds = new Set(r.surfaces.map((s) => s.id))
      const keep = (st.surfaces || []).filter((s) => isRuntimeLike(s) || (!r.knownIds.has(s.id) && !reconciledIds.has(s.id)))
      const groupOf = new Map((st.surfaces || []).filter((s) => s.groupId).map((s) => [s.id, { groupId: s.groupId, peek: s.peek }]))
      const merged = [...r.surfaces.map((s) => { const g = groupOf.get(s.id); return g ? { ...s, groupId: g.groupId, peek: g.peek } : s }), ...keep]
      a.setState({ ...st, surfaces: merged, camera: r.camera, mode: r.mode })
      Promise.resolve(onSurfaces(merged)).catch(() => {})
      a.broadcast({ type: 'reconcile', surfaces: merged, camera: r.camera, mode: r.mode, workspace: active() })
    } catch (e) {
      console.error('[workspace] reconcile failed:', e?.message || e)
    }
  }
  function scheduleReconcile() {
    if (reconcileTimer) return
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      const v = a.getState().view
      doReconcile(v ? { cx: v.cx, cy: v.cy } : {})
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
  /** CLOSE a surface = delete its backing content file (explicit by id; never inferred). The renderer
   *  calls this when the user closes a window so it doesn't resurrect on the next reconcile. */
  function closeSurfaceFile(id) {
    if (switching) return { ok: false, error: 'switch in progress' }
    return removeSurfaceFile(activeWorkspace, String(id))
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

  // ---- The system Chat: a srcdoc widget per SESSION whose UI is blitz-[<id>-]chat.html (customizable)
  // and whose transcript is chat[-<id>].md. Session '0' is the primary chat (legacy names, pinned). Each
  // session is an AGENT — a claude running in its own tmux terminal (launchAgent) that /says into ITS
  // transcript. The OS appends each message and broadcasts {type:'chat', sessionId, messages}.
  // The chat UI is ONE hub surface ('chat') holding EVERY session — a sidebar switches threads
  // client-side (this branch's model; master briefly had a chat surface per session+stage). Agents
  // themselves still get per-session STAGES for their windows/terminals.
  const CHAT_HUB_ID = 'chat'
  const chatSurfaceId = () => CHAT_HUB_ID
  const chatStatus = {} // sessionId -> '' | 'thinking' (true while the agent is working that session)
  /** A session's display title: its meta.json title, else a default ('0' = the primary, named "Main"). */
  function sessionTitle(id) {
    try { const m = JSON.parse(readFileSync(join(activeWorkspace, '.blitzos', 'sessions', String(id), 'meta.json'), 'utf8')); if (m && m.title) return String(m.title) } catch { /* no meta */ }
    return !id || String(id) === '0' ? 'Main' : `Chat ${id}`
  }
  /** The chat-bearing sessions: always '0' (primary) + any .blitzos/sessions/<id> that is an AGENT (its
   *  terminal runs a BlitzOS claude → it has a chat thread). 'chat' is the legacy kind from before agents
   *  ran in terminals; 'agent' is the unified kind now. Plain 'pty' shells are NOT chat sessions. */
  function chatSessionIds() {
    const ids = ['0']
    try {
      for (const d of readdirSync(join(activeWorkspace, '.blitzos', 'sessions'), { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '0') continue
        try { const m = JSON.parse(readFileSync(join(activeWorkspace, '.blitzos', 'sessions', d.name, 'meta.json'), 'utf8')); if (m && (m.kind === 'agent' || m.kind === 'chat')) ids.push(d.name) } catch { /* skip */ }
      }
    } catch { /* no sessions dir */ }
    return ids
  }
  /** The viewport last pushed by a renderer (for stage-math placement); a default until the first push. */
  function viewportOf() {
    try { const st = a.getState(); if (st && st.viewport && st.viewport.w) return st.viewport } catch { /* no state */ }
    return DEFAULT_VP
  }
  /** The hub's props: the session list (id + title + status) + every session's recent transcript, so the
   *  widget can render a sidebar and switch threads with zero round-trips. */
  function chatHubProps() {
    const ids = chatSessionIds()
    const threads = {}
    for (const id of ids) threads[id] = readChatMessages(activeWorkspace, 200, id)
    return {
      sessionId: '0',
      activeSessionId: '0',
      messages: threads['0'] || [], // compat: simple per-session renderers (chat-session.html) read this
      sessions: ids.map((id) => ({ id, title: sessionTitle(id), status: chatStatus[id] || '' })),
      threads,
      status: { ...chatStatus }
    }
  }
  /** Re-push the hub props (sessions + threads + status) into osState + to live renderers. */
  function pushChatHub() {
    const props = chatHubProps()
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.id === CHAT_HUB_ID ? { ...s, props: { ...(s.props || {}), ...props } } : s)) })
    } catch { /* optional adapter */ }
    a.broadcast({ type: 'chat', sessionId: '0', messages: props.threads['0'] || [], sessions: props.sessions, status: props.status })
  }
  /** Build the SINGLE hub chat surface: UI = blitz-chat.html, data = all sessions (chatHubProps). */
  function buildChatSurface() {
    ensureSystemRenderer(activeWorkspace, 'chat', '0')
    return {
      id: CHAT_HUB_ID,
      kind: 'srcdoc',
      role: 'chat',
      pinned: true,
      sessionId: '0',
      title: 'Chat',
      // Stage desktop: the hub is a TALL tile (2×3 cells) anchored top-left of the slot lattice —
      // the renderer derives exact x/y/w/h from the slot at ITS real viewport (these are fallbacks).
      slot: { col: 0, row: 0, size: 'tall' },
      preSnap: { w: 520, h: 600 }, // pop-out (slot-toggle) restores the chat's designed free-form size
      x: -720,
      y: -260,
      w: 520,
      h: 600,
      z: 5,
      html: readSystemRenderer(activeWorkspace, 'chat', '0') || '',
      props: chatHubProps()
    }
  }
  /** The minimum stageCount needed for every chat session to have its stage (max chat-session id + 1) —
   *  agents' windows/terminals live in per-session stages even though the chat UI is one hub. */
  function maxChatStageCount() {
    let max = 1
    for (const id of chatSessionIds()) max = Math.max(max, stageForSession(id) + 1)
    return max
  }
  /** The chat surfaces in this workspace — exactly ONE hub (it holds every session's thread). */
  function buildChatSurfaces() { return [buildChatSurface()] }
  /** Mint the next chat-session id: max existing integer id + 1 (primary '0' counts), so ids stay 1,2,3…
   *  Non-numeric ids (none today) are ignored for the max. */
  function newChatSessionId() {
    let max = 0
    for (const id of chatSessionIds()) { const n = Number(id); if (Number.isInteger(n) && n > max) max = n }
    return String(max + 1)
  }
  /** Register a new chat session: write its meta (kind:'agent', its stage), grow stageCount so its stage
   *  exists, launch its claude terminal (launchAgent seam, when wired), and re-push the hub so it appears
   *  in the sidebar. Idempotent — re-adding an existing session just refreshes meta + hub. opts.focus is
   *  accepted for parity with the per-surface model (the hub switches threads client-side, so no camera move). */
  function addChatSession(sessionId, title, opts = {}) {
    void opts
    const id = String(sessionId)
    const stage = stageForSession(id)
    const name = title || (id === '0' ? 'Chat' : `Chat ${id}`)
    // Persist the session RECORD up front (kind:'agent') so the chat session survives a restart even when no
    // claude is auto-launched (BLITZ_AGENT off). launchAgent (below) will overwrite this with the full live
    // meta when it spawns the terminal; both keep the same id/kind/title/stage, so chatSessionIds() finds it.
    try {
      const dir = join(activeWorkspace, '.blitzos', 'sessions', id)
      mkdirSync(dir, { recursive: true })
      const mp = join(dir, 'meta.json')
      let m = {}
      try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { /* fresh */ }
      writeFileSync(mp, JSON.stringify({ ...m, id, kind: 'agent', title: m.title || name, stage, createdAt: m.createdAt || Date.now() }, null, 2))
    } catch { /* best-effort: the session still works in-memory this run */ }
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) {
        // Grow stageCount so this session's stage exists + is navigable (persisted via writeWorkspace) —
        // the agent's terminal + windows land there even though its chat thread lives in the hub.
        const stageCount = Math.max(Number(st.stageCount) || 1, stage + 1)
        a.setState({ ...st, stageCount })
      }
    } catch { /* adapter without getState/setState */ }
    pushChatHub()
    // Launch the agent in a VISIBLE terminal in its stage (only when a launcher is wired — BLITZ_AGENT on).
    try { a.launchAgent?.(id, stage, name) } catch (e) { console.error('[workspace] launchAgent failed:', e?.message || e) }
    return { id }
  }
  /** Set a session's title (the agent auto-names; the human can rename) and re-push the hub sidebar. */
  function renameChatSession(sessionId, title) {
    const id = String(sessionId)
    const t = String(title || '').trim().slice(0, 40)
    if (!t) return { ok: false, error: 'empty title' }
    try {
      const dir = join(activeWorkspace, '.blitzos', 'sessions', id)
      mkdirSync(dir, { recursive: true })
      const mp = join(dir, 'meta.json')
      let m = {}
      try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { /* fresh */ }
      writeFileSync(mp, JSON.stringify({ ...m, id, kind: m.kind || 'agent', title: t, updatedAt: 0 }, null, 2))
    } catch { /* best-effort */ }
    pushChatHub()
    return { ok: true, id, title: t }
  }
  /** Stop a session (the human hit Stop): clear its 'thinking' status and re-push the hub so the indicator
   *  drops at once. The actual agent-process kill is the TRANSPORT's job (osActions → session ops); this is
   *  the shared state/UI half. The transcript + session stay — the next message relaunches the agent. */
  function stopChatSession(sessionId) {
    const sid = String(sessionId)
    chatStatus[sid] = ''
    pushChatHub()
    return { ok: true, id: sid }
  }
  /** Boot: (re)launch the claude terminal for EVERY chat session with the CURRENT relay url + --resume of its
   *  persisted session id. We deliberately re-exec rather than reattach a survivor: the relay url is re-minted
   *  each run, so a survivor would hold a DEAD url and silently disconnect — re-exec'ing on the fresh url (with
   *  --resume keeping the conversation) is the only reliable reconnect. spawnSession replaces any existing
   *  window, so there's no duplicate. No-op when launchAgent is unwired (BLITZ_AGENT off). */
  function resumeAgentsOnBoot() {
    if (typeof a.launchAgent !== 'function') return
    for (const id of chatSessionIds()) {
      try { a.launchAgent(id, stageForSession(id)) } catch (e) { console.error('[workspace] resumeAgent failed for', id, e?.message || e) }
    }
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
  /** Append a chat message to a SESSION's transcript and broadcast it so that session's widget re-renders.
   *  role 'user' (the human typed) | 'agent' (a `say`). sessionId defaults to '0' (the primary chat). */
  function appendChat(role, text, sessionId = '0', meta) {
    const sid = String(sessionId)
    appendChatMessage(activeWorkspace, role, text, sid, meta)
    // Status: the human typing means the agent is now thinking; an agent `say` clears it. Drives the
    // "thinking…" indicator with zero extra plumbing (every message already flows through here).
    chatStatus[sid] = role === 'user' ? 'thinking' : ''
    const messages = readChatMessages(activeWorkspace, 200, sid)
    const props = chatHubProps()
    props.threads[sid] = messages // freshest for the session we just touched
    // Keep osState's hub current so a FRESH hydrate shows up-to-date threads; live renderers also get the broadcast.
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) {
        a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.id === CHAT_HUB_ID ? { ...s, props: { ...(s.props || {}), ...props } } : s)) })
      }
    } catch {
      /* getState/setState optional on some adapters */
    }
    a.broadcast({ type: 'chat', sessionId: sid, messages, sessions: props.sessions, status: props.status })
    return messages
  }
  /** The agent customizes a session's widget UI by rewriting blitz-[<id>-]<name>.html, then we live-reload
   *  that one surface (the iframe reloads → re-earns its capabilities; transcript re-seeds from props). */
  function customizeWidget(name, html, sessionId = '0') {
    const r = writeSystemRenderer(activeWorkspace, name, html, sessionId)
    if (!r.ok) return r
    if (name === 'chat') {
      const newHtml = readSystemRenderer(activeWorkspace, 'chat', sessionId) || ''
      const sid = chatSurfaceId(sessionId)
      try {
        const st = a.getState()
        if (st && Array.isArray(st.surfaces)) a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.id === sid ? { ...s, html: newHtml } : s)) })
      } catch {
        /* adapter without getState/setState */
      }
      a.broadcast({ type: 'update', id: sid, patch: { html: newHtml } })
    } else if (name === 'note') {
      doReconcile({}) // re-materialize every note through the (now-present) blitz-note.html renderer
    }
    return r
  }
  /** Read a system widget's current UI source (workspace file, else the shipped default) — read-before-edit. */
  function systemUi(name) {
    return readSystemRenderer(activeWorkspace, name)
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
      // The chat is now a srcdoc widget backed by blitz-chat.html + chat.md (the transcript file). The
      // activity feed still lives in .blitzos/state/panels.json. Merge both back on boot.
      migrateChatToFile() // seed chat.md from an old panels.json transcript, once
      const panels = readRuntimePanels(activeWorkspace).filter((p) => p.component === 'activity')
      const base = h || { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'canvas', stageCount: 1 }
      const surfaces = [...base.surfaces, ...buildChatSurfaces(), ...panels]
      // Set state UNCONDITIONALLY (even with zero surfaces) so a persisted stageCount > 1 isn't lost on an
      // empty workspace — the hydrate senders read cached.stageCount, which would otherwise stay undefined→1.
      // stageCount self-heals to fit every chat session's stage (max chat id + 1), so an old workspace whose
      // stageCount wasn't bumped — or a hand-added session — still lands its widget in a reachable stage.
      const stageCount = Math.max(base.stageCount ?? 1, maxChatStageCount())
      a.setState({ surfaces, camera: base.camera, mode: base.mode, stageCount })
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
    a.setState(s)
    Promise.resolve(onSurfaces(s.surfaces)).catch(() => {})
    scheduleWrite()
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
      stopWatch()
      activeWorkspace = newPath // load-bearing: AFTER flush (flush already persisted OLD's chat to OLD)
      const next = readWorkspace(newPath) || blank()
      // Per-workspace chat/activity: the DESTINATION's own chat (its blitz-chat.html + chat.md) and its
      // activity panel — never carry the previous workspace's over.
      migrateChatToFile()
      const surfaces = [...next.surfaces, ...buildChatSurfaces(), ...readRuntimePanels(newPath).filter((p) => p.component === 'activity')]
      const stageCount = Math.max(next.stageCount ?? 1, maxChatStageCount()) // self-heal for the destination's chat sessions
      a.setState({ surfaces, camera: next.camera, mode: next.mode, stageCount, view: { cx: next.camera.x, cy: next.camera.y } })
      await Promise.resolve(onSurfaces(surfaces)) // awaited so an overlapping switch can't strand targets
      startWatch()
      rememberActive() // boot returns the user HERE, not to the default
      a.broadcast({ type: 'switch', surfaces, camera: next.camera, mode: next.mode, stageCount, workspace: name })
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
    closeSurfaceFile,
    locateSurface,
    bringSurfaceHere,
    appendChat,
    customizeWidget,
    systemUi,
    chatSessionIds,
    newChatSessionId,
    addChatSession,
    renameChatSession,
    stopChatSession,
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
