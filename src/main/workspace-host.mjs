// Shared workspace HOST — owns the active-workspace runtime: hydrate, persist (debounced), watch +
// reconcile external edits, switch (atomic, single-flight), list/create, and the last-seen thumbnail
// store. Used by BOTH preview/backend.mjs (server mode) AND src/main/osActions.ts (Electron) — there
// is ONE implementation, no second copy to drift. The serializer (workspace.mjs) does disk I/O; the
// per-transport bits (reaching renderers, realizing web surfaces) are adapter callbacks. This is the
// control-core.mjs / perception-core.mjs pattern: one feature, both modes.
import { mkdirSync, writeFileSync, readFileSync, watch, statSync, realpathSync } from 'node:fs'
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
  readChatMessages,
  appendChatMessage,
  readConsent,
  writeConsent,
  wasSelfWrite,
  listWorkspaces,
  createWorkspace,
  resolveWorkspace,
  safeName
} from './workspace.mjs'

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
  if (listWorkspaces(root).length === 0) {
    try {
      createWorkspace(root, initialName)
    } catch (e) {
      console.error('[workspace] first-run create failed:', e?.message || e)
    }
  }
  let activeWorkspace = resolveWorkspace(root, initialName, { mustExist: true }) || join(root, initialName)

  let switching = false
  let writeTimer = null
  let reconcileTimer = null
  let watchers = []

  const active = () => basename(activeWorkspace)
  const blank = () => ({ surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: defaultMode, areaCount: 1 })

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
      const isRuntimeLike = (s) => s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity' || s.component === 'folder'))
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

  // ---- The system Chat: a srcdoc widget whose UI is the workspace file blitz-chat.html (customizable)
  // and whose transcript is chat.md (the OS appends each message; the widget just renders props.messages).
  /** Build the chat surface from its workspace files (ensuring/recreating blitz-chat.html if missing). */
  function buildChatSurface() {
    ensureSystemRenderer(activeWorkspace, 'chat') // recreate the default UI if it was deleted
    return {
      id: 'chat',
      kind: 'srcdoc',
      role: 'chat',
      pinned: true,
      title: 'Chat',
      x: -700,
      y: -210,
      w: 360,
      h: 460,
      z: 5,
      html: readSystemRenderer(activeWorkspace, 'chat') || '',
      props: { messages: readChatMessages(activeWorkspace) }
    }
  }
  /** One-time: an OLD workspace kept the transcript in panels.json — seed chat.md from it so no history is lost. */
  function migrateChatToFile() {
    if (readChatMessages(activeWorkspace).length) return
    const chat = readRuntimePanels(activeWorkspace).find((p) => p.component === 'chat')
    const msgs = chat && chat.props && Array.isArray(chat.props.messages) ? chat.props.messages : []
    for (const m of msgs) appendChatMessage(activeWorkspace, m.role === 'user' ? 'user' : 'agent', String(m.text || ''))
  }
  /** Append a chat message to chat.md and broadcast the new transcript so the chat widget re-renders.
   *  role 'user' (the human typed) | 'agent' (a `say`). Returns the full message list. */
  function appendChat(role, text) {
    appendChatMessage(activeWorkspace, role, text)
    const messages = readChatMessages(activeWorkspace)
    // Keep osState's chat surface current so a FRESH hydrate (a page refresh / a new SSE connect) shows
    // the up-to-date transcript, not the boot-time snapshot — live renderers also get the broadcast below.
    try {
      const st = a.getState()
      if (st && Array.isArray(st.surfaces)) {
        a.setState({ ...st, surfaces: st.surfaces.map((s) => (s && s.role === 'chat' ? { ...s, props: { ...(s.props || {}), messages } } : s)) })
      }
    } catch {
      /* getState/setState optional on some adapters */
    }
    a.broadcast({ type: 'chat', messages })
    return messages
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
      const base = h || { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'canvas', areaCount: 1 }
      const surfaces = [...base.surfaces, buildChatSurface(), ...panels]
      // Set state UNCONDITIONALLY (even with zero surfaces) so a persisted areaCount > 1 isn't lost on an
      // empty workspace — the hydrate senders read cached.areaCount, which would otherwise stay undefined→1.
      a.setState({ surfaces, camera: base.camera, mode: base.mode, areaCount: base.areaCount ?? 1 })
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
      const surfaces = [...next.surfaces, buildChatSurface(), ...readRuntimePanels(newPath).filter((p) => p.component === 'activity')]
      a.setState({ surfaces, camera: next.camera, mode: next.mode, areaCount: next.areaCount ?? 1, view: { cx: next.camera.x, cy: next.camera.y } })
      await Promise.resolve(onSurfaces(surfaces)) // awaited so an overlapping switch can't strand targets
      startWatch()
      a.broadcast({ type: 'switch', surfaces, camera: next.camera, mode: next.mode, areaCount: next.areaCount ?? 1, workspace: name })
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
    appendChat,
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
    writeThumb,
    readThumb,
    readWorkspaceFile
  }
}
