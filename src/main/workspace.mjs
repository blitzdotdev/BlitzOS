// Workspace serializer — the workspaces design (agent-os-workspaces.md), Phases 1–3.
//
// Maps the surface set <-> a workspace FOLDER, both ways (V1 island: the canvas camera/mode/stack/slot
// fields are CUT — the on-disk layout is the node/surface list only):
//   <dir>/.blitzos/workspace.json   ← the one layout file: { version, id, kind, nodes[], groups[] }
//   <dir>/<content files>           ← everything-is-a-file: note→.md, web→.weblink, srcdoc→.html
//
//   writeWorkspace()      project the live surfaces (osState) onto the folder.
//   readWorkspace()       reconstruct surface descriptors (hydrate on boot/connect).
//   reconcileWorkspace()  idempotent re-scan when the folder changes externally (reload content,
//                         auto-place new files, heal a rename, drop missing).
//
// BlitzOS owns the layout file; content files are the source of truth for content. Writes are
// atomic (temp + rename) and content is rewritten only when its bytes change. Every read/write
// is path-jailed inside the workspace, and every BlitzOS write is stamped so the backend's
// watcher (wasSelfWrite) reconciles only on EXTERNAL edits, never its own.
//
// Shared module (the control-core.mjs / perception-core.mjs pattern): plain Node, importable
// by the server backend now and Electron main later.

import { mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync, existsSync, readdirSync, statSync, lstatSync, copyFileSync, cpSync, unlinkSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, sep, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const VERSION = 1

// ---- path jail: a content path (read from a possibly hand-edited workspace.json, or a
// scanned dirent) must resolve INSIDE the workspace root. Rejects ../ traversal and absolute
// paths. (Full realpath/symlink jail is Phase 4 security; this stops the obvious traversal.)
function safeJoin(dir, rel) {
  if (typeof rel !== 'string' || !rel) return null
  const base = resolve(dir)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

// ---- self-write suppression: every file BlitzOS writes is stamped here so the workspace
// watcher (Phase 3) can ignore its own writes and only reconcile on EXTERNAL edits.
const recentWrites = new Map() // absPath -> ts
export function markWrite(absPath) {
  const now = Date.now()
  recentWrites.set(absPath, now)
  if (recentWrites.size > 400) for (const [k, v] of recentWrites) if (now - v > 3000) recentWrites.delete(k)
}
/** True if BlitzOS wrote this absolute path within the window (so a watch event is its own). */
export function wasSelfWrite(absPath, windowMs = 900) {
  const t = recentWrites.get(resolve(absPath))
  return t != null && Date.now() - t < windowMs
}

// Hardening helpers for the read/hydrate path — a workspace.json or content file can be
// hand-edited, corrupt, copied from elsewhere, or malicious; never trust it blindly.
const MAX_CONTENT = 2_000_000 // cap a content file we load whole into memory + ship to renderers
const MAX_META = 1_000_000 // cap workspace.json before reading it whole (a planted giant must not OOM the lister)
function clampScale(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0.2), 3) : 1
}
function safeUrl(u) {
  const s = String(u || '')
  return /^https?:\/\//i.test(s) ? s : '' // never hydrate javascript:/data:/file: into a web surface
}
// Which surfaces become canvas NODES. The chat + agent-activity native panels are RUNTIME
// (they belong in .blitzos/state/*.jsonl, Phase 4), never nodes. Unknown kinds are skipped.
function nodeKind(s) {
  if (s && s.role === 'chat') return null // the system chat is a srcdoc whose UI=blitz-chat.* + data=chat.md; never a node
  if (s && s.role === 'note') return 'note' // a note rendered via blitz-note.html still persists as its .md content file
  if (s.kind === 'web' || s.kind === 'app') return s.kind // both serialize to .weblink, but app needs its renderer kind preserved
  if (s.kind === 'srcdoc') return 'srcdoc'
  if (s.kind === 'native' && s.component === 'note') return 'note'
  if (s.kind === 'native' && s.component === 'file') return 'file' // a real file on disk (#37)
  if (s.kind === 'native' && s.component === 'dir') return 'dir' // a real subfolder on disk (#37)
  return null
}

// Generated root basenames that must never be reused for a content file.
const RESERVED_ROOT = new Set(['blitzos.md', '.gitignore'])

// The extensions of BlitzOS-OWNED content files (note→.md, web→.weblink, srcdoc→.html/.jsx/.tsx).
// Only these are deleted when their surface is closed — a real dropped file/dir/repo is never auto-removed.
const CONTENT_EXTS = new Set(['.md', '.weblink', '.html', '.jsx', '.tsx'])

// Raster image extensions — canvas file tiles render these inline; the file-manager flags them. One source.
const IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/

// #54 — a SPECIAL on-canvas folder is a real subdir whose name ends in `.board` (the macOS .app-bundle
// analogy: the kind is encoded in the name, so it survives copy/move + is greppable). Its direct children
// splay onto the canvas; capped so it can never explode (an over-full board falls back to a collapsed tile).
const BOARD_SUFFIX = '.board'
const BOARD_CAP = 24
function isBoard(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith(BOARD_SUFFIX)
}

function slug(str, fallback) {
  const base = String(str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // fold combining accents: café→cafe, Über→uber
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || fallback
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// The content file (extension, desired basename, body bytes) for a node kind.
// web and app share the .weblink payload, but remain distinct renderer kinds.
function contentFor(kind, s) {
  switch (kind) {
    case 'note':
      return { ext: 'md', name: slug(s.title, 'note'), body: String(s.props?.text ?? '') }
    case 'web':
    case 'app': {
      // A browser surface with materialized tabs persists them ({id,title,url} only — favicon/loading/
      // nav state are runtime). Single-tab windows keep the legacy {url} shape.
      const link = { url: s.url || '', kind }
      if (kind === 'web' && Array.isArray(s.tabs) && s.tabs.length) {
        link.tabs = s.tabs
          .filter((t) => t && t.id)
          .map((t) => ({ id: String(t.id), title: String(t.title || '').slice(0, 200), url: safeUrl(t.url) || '' }))
        link.activeTab = Number.isInteger(s.activeTab) ? Math.max(0, Math.min(s.activeTab, link.tabs.length - 1)) : 0
      }
      return { ext: 'weblink', name: slug(hostOf(s.url) || s.title, 'link'), body: JSON.stringify(link, null, 2) + '\n' }
    }
    case 'srcdoc':
      // The lang IS the extension (a jsx widget persists as a real .jsx file — greppable,
      // forkable, survives copy/move); `html` stays the source field for every lang.
      return { ext: s.lang === 'jsx' ? 'jsx' : s.lang === 'tsx' ? 'tsx' : 'html', name: slug(s.title, 'panel'), body: String(s.html ?? '') }
    default:
      return null
  }
}

// Per-kind view state for the node entry (small, cosmetic — content lives in the file). The
// title is persisted here (the authoritative display label) so it survives a restart + edits,
// instead of being lossily re-derived from the slugged filename.
function viewFor(kind, s) {
  const v = {}
  if (typeof s.title === 'string' && s.title) {
    if (kind === 'web' || kind === 'app') v.lastTitle = s.title
    else v.title = s.title
  }
  if (kind === 'note' && s.props && typeof s.props.color === 'string') v.color = s.props.color
  if (kind === 'srcdoc' && s.props && Object.keys(s.props).length) {
    // view must stay "small" (spec §3.3) — don't inline an unbounded props blob.
    try {
      if (JSON.stringify(s.props).length <= 8192) v.props = s.props
    } catch {
      /* non-serializable — drop */
    }
  }
  return v
}

function visualGroupsFromSurfaces(surfaces, nodeIds) {
  const groups = []
  const usedMembers = new Set()
  for (const s of surfaces) {
    if (!s || s.kind !== 'native' || s.component !== 'folder' || typeof s.id !== 'string' || !s.id) continue
    const raw = Array.isArray(s.props?.members) ? s.props.members : []
    const members = []
    for (const id of raw) {
      const sid = String(id || '')
      if (!sid || !nodeIds.has(sid) || usedMembers.has(sid)) continue
      members.push(sid)
    }
    if (members.length < 2) continue
    for (const id of members) usedMembers.add(id)
    groups.push({
      id: s.id,
      title: typeof s.title === 'string' && s.title ? s.title : 'Folder',
      x: Math.round(Number(s.x) || 0),
      y: Math.round(Number(s.y) || 0),
      w: Math.round(Number(s.w) || 232),
      h: Math.round(Number(s.h) || 248),
      z: Math.round(Number(s.z) || 0),
      members
    })
  }
  return groups
}

function visualGroupsFromMeta(groups, nodeIds) {
  const out = []
  const usedMembers = new Set()
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g.id !== 'string' || !g.id) continue
    const members = []
    for (const id of Array.isArray(g.members) ? g.members : []) {
      const sid = String(id || '')
      if (!sid || !nodeIds.has(sid) || usedMembers.has(sid)) continue
      members.push(sid)
    }
    if (members.length < 2) continue
    for (const id of members) usedMembers.add(id)
    out.push({
      id: g.id,
      title: typeof g.title === 'string' && g.title ? g.title : 'Folder',
      x: Math.round(Number(g.x) || 0),
      y: Math.round(Number(g.y) || 0),
      w: Math.max(40, Math.round(Number(g.w) || 232)),
      h: Math.max(40, Math.round(Number(g.h) || 248)),
      z: Math.round(Number(g.z) || 0),
      members
    })
  }
  return out
}

function applyVisualGroups(surfaces, groups) {
  if (!Array.isArray(groups) || !groups.length || !Array.isArray(surfaces) || !surfaces.length) return surfaces
  const surfaceIds = new Set(surfaces.map((s) => s && s.id).filter(Boolean))
  const memberToGroup = new Map()
  const folders = []
  for (const g of groups) {
    if (!g || typeof g.id !== 'string' || !g.id || surfaceIds.has(g.id)) continue
    const members = []
    for (const id of Array.isArray(g.members) ? g.members : []) {
      const sid = String(id || '')
      if (!sid || !surfaceIds.has(sid) || memberToGroup.has(sid)) continue
      members.push(sid)
    }
    if (members.length < 2) continue
    for (const id of members) memberToGroup.set(id, g.id)
    folders.push({
      id: g.id,
      kind: 'native',
      component: 'folder',
      x: Math.round(Number(g.x) || 0),
      y: Math.round(Number(g.y) || 0),
      w: Math.max(40, Math.round(Number(g.w) || 232)),
      h: Math.max(40, Math.round(Number(g.h) || 248)),
      z: Math.round(Number(g.z) || 0),
      title: typeof g.title === 'string' && g.title ? g.title : 'Folder',
      props: { members, open: false }
    })
  }
  if (!folders.length) return surfaces
  return [
    ...surfaces.map((s) => (memberToGroup.has(s.id) ? { ...s, groupId: memberToGroup.get(s.id), peek: false } : s)),
    ...folders
  ]
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
  markWrite(resolve(file)) // stamp for self-write suppression (Phase 3 watcher)
}

// Write a content file only if its bytes changed — avoids rewriting unchanged notes (no git
// churn, no needless mtime bump that a future watcher would have to suppress).
function writeIfChanged(file, data) {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === data) return false
  } catch {
    /* unreadable — fall through and write */
  }
  atomicWrite(file, data)
  return true
}

// Write workspace.json, keeping the previous copy as .bak so a crash mid-write or a corrupt
// file still has a last-good fallback to boot from (spec §3.1). Byte-identical content is NOT
// rewritten: the idle write loop (flush → watcher → reconcile → flush, 1.27 byte-identical
// writes/sec measured in the VM) is gated upstream by doReconcile's changed-check, but this
// keeps ANY future feedback path from churning the disk + .bak + watcher for a no-op.
function writeMeta(metaFile, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n'
  try {
    if (existsSync(metaFile) && readFileSync(metaFile, 'utf8') === next) return
  } catch {
    /* unreadable prior → write fresh */
  }
  try {
    if (existsSync(metaFile)) copyFileSync(metaFile, metaFile + '.bak')
  } catch {
    /* best-effort */
  }
  atomicWrite(metaFile, next)
}

// Read the prior workspace.json to recover (id → path) and the workspace id, so a node's
// content-file path stays STABLE across writes (editing a note's title must not rename its
// file) and the workspace id is minted once.
function readPrior(metaFile) {
  try {
    const ws = JSON.parse(readFileSync(metaFile, 'utf8'))
    const idToPath = new Map()
    for (const n of ws.nodes || []) if (n && n.id && n.path) idToPath.set(n.id, n.path)
    return { idToPath, wsId: typeof ws.id === 'string' ? ws.id : null }
  } catch {
    return { idToPath: new Map(), wsId: null }
  }
}

function uniquePath(name, ext, taken) {
  let p = `${name}.${ext}`
  let i = 2
  while (taken.has(p)) p = `${name}-${i++}.${ext}`
  taken.add(p)
  return p
}

// ---- machine-global ROOT state (<root>/.blitzos/state.json) — the OS runtime journal. Holds what
// must survive a process death but belongs to NO single workspace: the last-active workspace (boot
// returns the user where they were) and the boot record (the dirty bit that detects a crash/kill on
// the next launch, plus the soft-lease data against two hosts sharing one root). Root-level .blitzos
// is deliberately OUTSIDE every per-workspace watcher, so the heartbeat can never trigger reconciles.
function rootStateFile(root) {
  return join(resolve(root), '.blitzos', 'state.json')
}
export function readRootState(root) {
  try {
    return JSON.parse(readFileSync(rootStateFile(root), 'utf8')) || {}
  } catch {
    return {}
  }
}
/** Shallow top-level merge + atomic write. Pass a whole sub-object to replace it (e.g. { boot: {…} }). */
export function patchRootState(root, patch) {
  const next = { ...readRootState(root), ...(patch || {}) }
  atomicWrite(rootStateFile(root), JSON.stringify(next, null, 2) + '\n')
  return next
}
// Per-origin browser permission decisions, machine-global (an origin's camera grant is not workspace-
// specific) — stored in the same root journal. Shape: { "<origin>": { "<permission>": "granted"|"denied" } }.
export function readPermissions(root) {
  const p = readRootState(root).permissions
  return p && typeof p === 'object' ? p : {}
}
export function getPermission(root, origin, permission) {
  const o = readPermissions(root)[origin]
  return o && typeof o === 'object' ? o[permission] || null : null
}
export function setPermission(root, origin, permission, decision) {
  if (!origin || !permission) return
  const all = readPermissions(root)
  const o = { ...(all[origin] || {}) }
  o[permission] = decision === 'granted' ? 'granted' : 'denied'
  patchRootState(root, { permissions: { ...all, [origin]: o } })
}
// Browser bookmarks, machine-global (same root journal — a bookmark belongs to the user, not a
// workspace). Flat list, keyed by url: [{ id, url, title, addedAt }]. Folders can come later;
// Chromium's Bookmarks JSON is the interop target if export is ever wanted.
export function readBookmarks(root) {
  const b = readRootState(root).bookmarks
  return Array.isArray(b) ? b.filter((x) => x && typeof x.url === 'string' && x.url) : []
}
/** Add the url if absent, remove it if present (the star toggle). Returns the updated list. */
export function toggleBookmark(root, { url, title }) {
  const u = safeUrl(url)
  if (!u) return readBookmarks(root)
  const cur = readBookmarks(root)
  const next = cur.some((b) => b.url === u)
    ? cur.filter((b) => b.url !== u)
    : [...cur, { id: randomUUID(), url: u, title: String(title || u).slice(0, 200), addedAt: Date.now() }]
  patchRootState(root, { bookmarks: next })
  return next
}

/** True if pid is a live process we can see (EPERM counts as alive; pid reuse is an accepted rare false-alive). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}
/**
 * Open the per-process boot journal: read the previous run's record (the dirty bit), then claim the
 * root with a fresh record + a 60s heartbeat. Call `markClean()` as the LAST step of a graceful quit —
 * "clean" means "state was flushed first". On the next boot:
 *   dirty      → the previous run died without a clean shutdown (crash / SIGKILL / power loss)
 *   concurrent → the previous record's pid is STILL ALIVE: not a crash — another BlitzOS (Electron or
 *                server) is running on this root right now. Callers must NOT report a crash then;
 *                whether to refuse to share a root is a pending product decision — today we detect
 *                and warn loudly, and our heartbeat yields if another process re-claims the record.
 */
export function openBootJournal(root, mode) {
  const prev = readRootState(root).boot || null
  // A record carrying OUR OWN pid is a double-open within this process — neither a crash nor a
  // concurrent owner (and never worth a false crash report).
  const self = !!(prev && prev.pid === process.pid)
  const concurrent = !!(prev && !self && prev.cleanShutdown !== true && pidAlive(prev.pid))
  const dirty = !!(prev && !self && prev.cleanShutdown !== true && !concurrent)
  const lastAliveAt = prev ? Number(prev.heartbeatAt || prev.bootedAt) || null : null
  const write = (rec) => {
    try {
      patchRootState(root, { boot: rec })
    } catch (e) {
      console.error('[boot-journal] write failed:', e?.message || e)
    }
  }
  write({ pid: process.pid, mode: String(mode || 'unknown'), bootedAt: Date.now(), heartbeatAt: Date.now(), cleanShutdown: false })
  const iv = setInterval(() => {
    const cur = readRootState(root).boot
    // only beat OUR record — if another process re-claimed the root, leave its record alone
    if (cur && cur.pid === process.pid) write({ ...cur, heartbeatAt: Date.now() })
  }, 60_000)
  if (iv.unref) iv.unref()
  let closed = false
  return {
    dirty,
    concurrent,
    lastAliveAt,
    prev,
    markClean() {
      if (closed) return
      closed = true
      clearInterval(iv)
      const cur = readRootState(root).boot
      if (cur && cur.pid === process.pid) write({ ...cur, cleanShutdown: true })
    }
  }
}

/**
 * Serialize osState into the workspace folder. Returns a small summary.
 * @param {string} dir absolute path to the workspace folder.
 * @param {object} osState the renderer's last pushed state ({surfaces}).
 */
export function writeWorkspace(dir, osState) {
  const metaDir = join(dir, '.blitzos')
  const metaFile = join(metaDir, 'workspace.json')
  const { idToPath, wsId } = readPrior(metaFile)
  // Seed `taken` with reserved generated basenames so a content file can never clobber them.
  const taken = new Set([...idToPath.values(), ...RESERVED_ROOT])
  const surfaces = Array.isArray(osState?.surfaces) ? osState.surfaces : []

  const nodes = []
  const seen = new Set() // dedupe: an agent-reused/duplicate id must not clobber another's file
  for (const s of surfaces) {
    if (!s || typeof s.id !== 'string' || !s.id) continue // never write a node with no/blank id
    if (seen.has(s.id)) continue
    const kind = nodeKind(s)
    if (!kind) continue
    // file/dir nodes are REAL files/subfolders already on disk — record layout only, never rewrite
    // their content. Their stable path comes from the prior workspace.json (reconcile assigned it).
    if (kind === 'file' || kind === 'dir') {
      const rel = idToPath.get(s.id)
      if (!rel || !safeJoin(dir, rel)) continue // can't locate the real file/dir → skip
      seen.add(s.id)
      const fview = kind === 'file' && typeof s.title === 'string' && s.title ? { title: s.title } : {}
      nodes.push({
        id: s.id,
        path: rel,
        kind,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: Math.round(s.w),
        h: Math.round(s.h),
        ...(Object.keys(fview).length ? { view: fview } : {})
      })
      continue
    }
    const c = contentFor(kind, s)
    if (!c) continue
    seen.add(s.id)
    // stable path: reuse the prior assignment for this id — but only if its extension still
    // matches this kind (a surface that changed kind must get a fresh, correct-extension path).
    let rel = idToPath.get(s.id)
    if (!rel || extname(rel).toLowerCase() !== '.' + c.ext) rel = uniquePath(c.name, c.ext, taken)
    const abs = safeJoin(dir, rel) // jail: a reused path from a hand-edited workspace.json can't escape
    if (!abs) continue
    idToPath.set(s.id, rel)
    writeIfChanged(abs, c.body)
    const view = viewFor(kind, s)
    nodes.push({
      id: s.id,
      path: rel,
      kind,
      x: Math.round(s.x),
      y: Math.round(s.y),
      w: Math.round(s.w),
      h: Math.round(s.h),
      ...(s.zoom && s.zoom !== 1 ? { zoom: s.zoom } : {}),
      ...(Object.keys(view).length ? { view } : {})
    })
  }
  const nodeIds = new Set(nodes.map((n) => n.id))
  const groups = visualGroupsFromSurfaces(surfaces, nodeIds)

  // Runtime panels (chat / agent-activity) aren't folder nodes, but their content (the chat
  // transcript, the activity feed) must survive a backend RESTART — persist them to
  // .blitzos/state/panels.json (machine-local) and merge them back in on boot (#38).
  // The chat hub is a srcdoc with role:'chat' (not native), so match BOTH the native activity panel and
  // the role-based chat.
  const runtimePanels = surfaces.filter(
    (s) => s && ((s.kind === 'native' && (s.component === 'chat' || s.component === 'activity')) || s.role === 'chat')
  )

  // Don't materialize an empty workspace.json (or scaffold) for a fresh, empty workspace — only
  // once there's something to persist (a node, a runtime panel, or an existing workspace to sync).
  if (nodes.length === 0 && runtimePanels.length === 0 && !existsSync(metaFile)) return { metaFile, nodeCount: 0 }

  // V1 island: the on-disk layout is the node/surface list (+ visual folder groups). The canvas
  // camera/mode/stack fields are CUT (no infinite plane, no z-stacking of free windows).
  const ws = {
    version: VERSION,
    id: wsId || randomUUID(),
    kind: 'blitzos.workspace',
    groups,
    nodes
  }
  writeMeta(metaFile, ws) // atomic + keeps workspace.json.bak
  scaffold(dir) // self-describing BLITZOS.md + .gitignore (once)
  writeRuntimePanels(dir, runtimePanels) // chat/activity → .blitzos/state (survives a restart)
  return { metaFile, nodeCount: nodes.length }
}

// Runtime panels (chat / agent-activity) aren't folder nodes — their content is machine-local
// session state, persisted under .blitzos/state so it survives a backend RESTART (that subdir
// isn't watched, so no self-write loop). Merged back into the canvas on boot (#38).
// Keep the persisted transcript/feed well under MAX_META (readRuntimePanels rejects a file over
// that): keep the MOST-RECENT items that fit a byte budget, dropping the oldest. Without this an
// unbounded chat writes fine yet is silently discarded on the next boot.
function slimByBudget(arr, budget) {
  if (!Array.isArray(arr)) return []
  const out = []
  let bytes = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    let len
    try {
      len = JSON.stringify(arr[i]).length
    } catch {
      continue
    }
    if (out.length && bytes + len > budget) break
    out.unshift(arr[i])
    bytes += len
  }
  return out
}
function writeRuntimePanels(dir, panels) {
  const stateDir = join(dir, '.blitzos', 'state')
  const file = join(stateDir, 'panels.json')
  try {
    const created = !existsSync(stateDir)
    mkdirSync(stateDir, { recursive: true })
    if (created) markWrite(resolve(stateDir)) // suppress the one spurious reconcile the state-dir create can fire
    const slim = (panels || []).map((s) => {
      const isAct = s.component === 'activity'
      const props = s.props && typeof s.props === 'object' ? s.props : {}
      // Bound the transcript/feed on WRITE so the file is always producible + readable (≤ MAX_META).
      const sp = isAct ? { ...props, events: slimByBudget(props.events, 150_000) } : { ...props, messages: slimByBudget(props.messages, 600_000) }
      return {
        id: s.id,
        component: isAct ? 'activity' : 'chat',
        x: Math.round(s.x) || 0,
        y: Math.round(s.y) || 0,
        w: Math.round(s.w) || (isAct ? 320 : 360),
        h: Math.round(s.h) || (isAct ? 200 : 460),
        z: s.z || 0,
        title: typeof s.title === 'string' ? s.title : s.component,
        props: sp
      }
    })
    atomicWrite(file, JSON.stringify({ version: VERSION, panels: slim }, null, 2) + '\n')
  } catch {
    /* best-effort: runtime panels are a convenience, never block a workspace write */
  }
}

/** Read the persisted runtime panels (chat/activity) back as surface descriptors (inverse of
 *  writeRuntimePanels). Empty array if absent/corrupt. Used by the host on boot. */
export function readRuntimePanels(dir) {
  try {
    const file = join(dir, '.blitzos', 'state', 'panels.json')
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    if (raw.length > MAX_META) return []
    const o = JSON.parse(raw)
    const list = Array.isArray(o?.panels) ? o.panels : []
    return list
      .filter((s) => s && (s.component === 'chat' || s.component === 'activity'))
      .slice(0, 4)
      .map((s) => ({
        id: String(s.id || (s.component === 'activity' ? 'activity' : 'chat')),
        kind: 'native',
        component: s.component === 'activity' ? 'activity' : 'chat',
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        w: Number(s.w) || (s.component === 'activity' ? 320 : 360),
        h: Number(s.h) || (s.component === 'activity' ? 200 : 460),
        z: Number(s.z) || 0,
        title: typeof s.title === 'string' ? s.title : s.component,
        props: s.props && typeof s.props === 'object' ? s.props : {}
      }))
  } catch {
    return []
  }
}

// #53 — per-workspace CONSENT, persisted to .blitzos/state/consent.json so the human's grants survive a
// restart instead of needing re-approval every session. Under .blitzos (which the file route + reconcile
// never expose), so it's agent-read-denied. `surfaces` = ["surfaceId:provider"] widget grants;
// `providers` = providers the human approved for the agent's SENSITIVE reads.
export function writeConsent(dir, consent) {
  const stateDir = join(dir, '.blitzos', 'state')
  const file = join(stateDir, 'consent.json')
  try {
    const created = !existsSync(stateDir)
    mkdirSync(stateDir, { recursive: true })
    if (created) markWrite(resolve(stateDir))
    const surfaces = Array.isArray(consent?.surfaces) ? [...new Set(consent.surfaces.filter((s) => typeof s === 'string'))].slice(0, 500) : []
    const providers = Array.isArray(consent?.providers) ? [...new Set(consent.providers.filter((s) => typeof s === 'string'))].slice(0, 100) : []
    atomicWrite(file, JSON.stringify({ version: VERSION, surfaces, providers }, null, 2) + '\n')
  } catch {
    /* best-effort: consent persistence is a convenience, never block a workspace write */
  }
}
export function readConsent(dir) {
  try {
    const file = join(dir, '.blitzos', 'state', 'consent.json')
    if (!existsSync(file)) return { surfaces: [], providers: [] }
    const raw = readFileSync(file, 'utf8')
    if (raw.length > MAX_META) return { surfaces: [], providers: [] }
    const o = JSON.parse(raw)
    return {
      surfaces: Array.isArray(o?.surfaces) ? o.surfaces.filter((s) => typeof s === 'string') : [],
      providers: Array.isArray(o?.providers) ? o.providers.filter((s) => typeof s === 'string') : []
    }
  } catch {
    return { surfaces: [], providers: [] }
  }
}

// A human-ish title from a content-file path ("grocery-list.md" -> "Grocery list").
function titleFromPath(p) {
  const base = String(p)
    .replace(/^.*\//, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'untitled'
}

/**
 * Reconstruct surface descriptors from a workspace folder (inverse of writeWorkspace) —
 * Phase 2 hydrate. Reads .blitzos/workspace.json's nodes + each content file. A node whose
 * content file is missing is skipped (Phase 3 reconcile will mark it "missing"). Returns
 * { surfaces } or null if there is no workspace.json.
 * @param {string} dir absolute path to the workspace folder.
 */
// Reconstruct ONE surface descriptor from a node + its (jail-confined) content file.
// Returns null if the path escapes the workspace or the file is unreadable.
function nodeToSurface(dir, n, z) {
  if (!n || typeof n.id !== 'string' || typeof n.path !== 'string') return null
  const abs = safeJoin(dir, n.path)
  if (!abs) return null // JAIL: a hand-edited workspace.json path can't escape the workspace
  // file/dir nodes reference a REAL file/subfolder — never read it into memory (it may be a large
  // binary); stat for metadata and let the renderer fetch image bytes over the jailed file route (#37).
  if (n.kind === 'file' || n.kind === 'dir') {
    let st
    try {
      st = statSync(abs)
    } catch {
      return null // vanished
    }
    const name = basename(n.path)
    const base = { id: n.id, x: Number(n.x) || 0, y: Number(n.y) || 0, w: Number(n.w) || 200, h: Number(n.h) || (n.kind === 'dir' ? 170 : 200), z }
    if (n.kind === 'dir') {
      let entries = 0
      try {
        entries = readdirSync(abs).filter((e) => !e.startsWith('.')).length
      } catch {
        /* unreadable dir */
      }
      return { ...base, kind: 'native', component: 'dir', title: name, props: { dir: true, name, path: n.path, entries } }
    }
    const view = n.view && typeof n.view === 'object' ? n.view : {}
    const title = typeof view.title === 'string' && view.title ? view.title : name
    const ext = extname(name).toLowerCase().replace(/^\./, '')
    const isImage = IMAGE_EXT.test(ext)
    return { ...base, kind: 'native', component: 'file', title, props: { name, path: n.path, ext, bytes: st.size, isImage } }
  }
  let content
  try {
    if (statSync(abs).size > MAX_CONTENT) return null // don't load a giant file whole into memory
    content = readFileSync(abs, 'utf8')
  } catch {
    return null // missing/unreadable content file
  }
  const view = n.view && typeof n.view === 'object' ? n.view : {}
  // title is the authoritative display label (persisted in view); the filename is just a stable
  // path. Fall back to deriving it from the filename only for older/hand-written nodes.
  const title = typeof view.title === 'string' ? view.title : typeof view.lastTitle === 'string' ? view.lastTitle : titleFromPath(n.path)
  const base = {
    id: n.id,
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    w: Number(n.w) || 240,
    h: Number(n.h) || 240,
    z,
    ...(n.zoom ? { zoom: clampScale(n.zoom) } : {})
  }
  if (n.kind === 'note') {
    const noteProps = { text: content, ...(typeof view.color === 'string' ? { color: view.color } : {}) }
    // OPT-IN custom UI: if the workspace has a blitz-note.html (the user/agent customized it), render the
    // note through that srcdoc widget (role:'note', still persisted as this .md); otherwise the built-in
    // native post-it — so the default is unchanged.
    const noteUi = safeJoin(dir, 'blitz-note.html')
    if (noteUi && existsSync(noteUi)) {
      return { ...base, kind: 'srcdoc', role: 'note', title, html: readSystemRenderer(dir, 'note') || '', props: noteProps }
    }
    return { ...base, kind: 'native', component: 'note', title, props: noteProps }
  }
  if (n.kind === 'web' || n.kind === 'app') {
    let url = ''
    let tabs
    let activeTab
    try {
      const link = JSON.parse(content)
      url = safeUrl(link.url) // scheme-filtered: no javascript:/data:/file:
      // Restore browser tabs (web only). Each tab url is scheme-filtered like the main one.
      if (n.kind === 'web' && Array.isArray(link.tabs)) {
        tabs = link.tabs
          .filter((t) => t && typeof t.id === 'string' && t.id)
          .map((t) => ({ id: t.id, title: String(t.title || 'Tab').slice(0, 200), ...(safeUrl(t.url) ? { url: safeUrl(t.url) } : {}) }))
        if (tabs.length) activeTab = Math.max(0, Math.min(Number(link.activeTab) || 0, tabs.length - 1))
        else tabs = undefined
      }
    } catch {
      /* malformed .weblink — leave url empty */
    }
    return { ...base, kind: n.kind, url, title, props: {}, ...(tabs ? { tabs, activeTab } : {}) }
  }
  if (n.kind === 'srcdoc') {
    // lang rides the content file's extension (.jsx/.tsx compile at mount; .html renders verbatim).
    const ext = extname(n.path).toLowerCase()
    const lang = ext === '.jsx' ? 'jsx' : ext === '.tsx' ? 'tsx' : undefined
    return { ...base, kind: 'srcdoc', html: content, title, ...(lang ? { lang } : {}), props: view.props && typeof view.props === 'object' ? view.props : {} }
  }
  return null // image/file/folder/widget not materialized yet
}

/**
 * Reconstruct surface descriptors from a workspace folder (inverse of writeWorkspace) —
 * Phase 2 hydrate. Returns { surfaces } or null if there is no workspace.json.
 */
function parseMeta(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readWorkspace(dir) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  // fall back to the last-good copy if the live file is corrupt/truncated (spec §3.1 safety net).
  const ws = parseMeta(metaFile) ?? parseMeta(metaFile + '.bak')
  if (!ws || !Array.isArray(ws.nodes)) return null
  // V1 island: no canvas z-stack is written. A legacy file may still carry a `stack` array — honor it for
  // stable z if present (back-compat), else assign sequential z. New files have none; the field defaults absent.
  const stack = Array.isArray(ws.stack) ? ws.stack : []
  const zByIdx = new Map(stack.map((id, i) => [id, i + 1]))
  const surfaces = []
  let seq = stack.length + 1 // seed fallback z ABOVE all (legacy-)stacked nodes (no collision)
  for (const n of ws.nodes) {
    const s = nodeToSurface(dir, n, zByIdx.get(n?.id) ?? seq)
    seq++
    if (s) surfaces.push(s)
  }
  const groupedSurfaces = applyVisualGroups(surfaces, ws.groups)
  return { surfaces: groupedSurfaces }
}

/** Ground truth: is surface `id` STILL a real on-disk node of `dir` — i.e. its persisted workspace.json
 *  node's content file exists? onStatePush uses this to tell a GLITCH-dropped file-backed surface (file
 *  present ⇒ a render-process-gone reload / hydrate race / HMR remount lost it from the live set ⇒
 *  RE-ASSERT it, never persist the shrink) from a genuine removal (close/relocate/external delete ⇒ file
 *  gone ⇒ let it drop). Without this, a shrunk push persists workspace.json without the node while
 *  writeWorkspace leaves its content file (only an explicit close deletes files); the orphan is then
 *  RESURRECTED by reconcile as a fresh slotless, staggered tile with a new UUID — the "every widget popped
 *  out and stacked after relaunch" bug (scripts/repro-slot-orphan.mjs). Cheap: one workspace.json parse +
 *  one stat, and onStatePush calls it only for the (rare) ids a push actually dropped. */
export function surfaceFileExists(dir, id) {
  if (!id) return false
  try {
    const ws = parseMeta(join(dir, '.blitzos', 'workspace.json'))
    const node = ws && Array.isArray(ws.nodes) ? ws.nodes.find((n) => n && n.id === id && typeof n.path === 'string') : null
    if (!node) return false
    const abs = safeJoin(dir, node.path)
    return !!abs && existsSync(abs)
  } catch {
    return false
  }
}

// Which loose root files auto-surface as new nodes on reconcile, and as what kind. Conservative
// in Phase 3: only the unambiguous text/invented kinds — a dropped binary, .html, image, or
// folder is left alone (the spec's passive-file/bundle handling isn't built yet). Dotfiles,
// the .blitzos dir, and temp files never surface.
// Well-known workspace meta files that must NEVER auto-surface as canvas nodes.
const META_FILES = new Set(['blitzos.md', '.gitignore'])
function autoKind(name) {
  if (name.startsWith('.') || /\.tmp(-[0-9a-f]+)?$/.test(name) || META_FILES.has(name.toLowerCase())) return null
  if (isSystemFile(name)) return null // blitz-chat.* (the chat UI) + chat.md (transcript) are OS-managed, not plain tiles
  const ext = extname(name).toLowerCase()
  if (ext === '.weblink') return 'web'
  if (ext === '.md') return 'note'
  if (ext === '.html' || ext === '.htm') return 'srcdoc'
  if (ext === '.jsx' || ext === '.tsx') return 'srcdoc' // a jsx/tsx widget (compiled at mount)
  return 'file' // images, pdfs, archives, code, anything else → a file tile on the canvas (#37)
}

const BLITZOS_MD = `# This folder is a BlitzOS workspace

BlitzOS shows this folder as a spatial canvas. Every loose file here is a node you can see and
arrange; edit the files and the canvas updates live. The workspace IS this folder.

## File kinds
- \`*.md\` — a note (the markdown text is the file).
- \`*.weblink\` — a web window: \`{ "url": "https://…" }\`. A tabbed browser window may use
  \`{ "url": "https://…", "tabs": [{ "id": "t1", "title": "Tab", "url": "https://…" }], "activeTab": 0 }\`.
- \`*.html\` — an agent-authored panel.
- \`*.jsx\` / \`*.tsx\` — a React widget compiled inside the sandboxed surface.
- images / other files — a tile.

## Layout
\`.blitzos/workspace.json\` holds the layout: for each node, its \`id\`, file \`path\`, and
\`x/y/w/h\`. BlitzOS owns this file — edit a node's \`x\`/\`y\` to move it.

## For an agent
Operate this workspace with plain file tools — no API needed:
- new note → write a \`.md\`; open a site → write a \`.weblink\`; move/resize → edit the node in
  \`.blitzos/workspace.json\`; delete → remove the file.
- before writing or replacing \`.html\`, \`.jsx\`, or \`.tsx\` widget source, self-review it against
  the BlitzOS widget rules: sandbox/bridge use, interaction, tokens, scroll safety, copy, imports,
  and \`needs\`. Fix basics before creating it on the user's canvas.
- after creating or updating widget source, verify with \`list_state\`/\`get_surface\`; for JSX/TSX,
  \`lastError\` must be absent before you treat the widget as done.
- multiple web pages in the same research lane -> MUST be ONE tabbed \`.weblink\` with \`tabs\`; create
  separate \`.weblink\` files only for genuinely different lanes.
- A node's content = its file. \`.blitzos/state/\` is BlitzOS runtime state — do not read or edit it.
`

// Scaffold the self-describing doc + a .gitignore (state/ is machine-local) once per workspace.
function scaffold(dir) {
  const md = join(dir, 'BLITZOS.md')
  if (!existsSync(md)) atomicWrite(md, BLITZOS_MD)
  const gi = join(dir, '.gitignore')
  if (!existsSync(gi)) atomicWrite(gi, '# BlitzOS runtime state (machine-local, not part of the workspace)\n.blitzos/state/\n')
}
function defaultSizeFor(kind) {
  if (kind === 'note') return { w: 240, h: 240 }
  if (kind === 'file') return { w: 200, h: 200 }
  if (kind === 'dir') return { w: 200, h: 170 }
  return { w: 920, h: 640 }
}

/**
 * Reconcile the surface set with the folder on disk (Phase 3). Idempotent re-scan: reads the nodes
 * (fresh content), auto-places NEW loose .md/.weblink files, heals a single unambiguous rename,
 * drops nodes whose file vanished, and writes back workspace.json only if the node set changed.
 * Returns { surfaces, changed, knownIds } or null if there is no workspace.json.
 * @param {string} dir workspace folder
 * @param {{cx?:number, cy?:number}} [placeAt] world-space center to cascade new nodes around
 */
/**
 * Write a file the user DROPPED onto the canvas into the workspace folder (#37 / #43). Sanitizes the
 * basename (strips path + leading dots, keeps the extension), picks a unique non-reserved name,
 * jails the write to the workspace dir, and stamps it as a self-write so the watcher doesn't also
 * reconcile it (the caller reconciles explicitly, at the drop position). Returns { rel } or null.
 */
export function writeDroppedFile(dir, name, buffer) {
  const raw = String(name || 'file').replace(/[/\\]/g, '_').replace(/^\.+/, '').trim()
  const ext = extname(raw)
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]+/g, '').slice(0, 12)
  const stem =
    (raw.slice(0, raw.length - ext.length) || 'file')
      .replace(/[^a-zA-Z0-9._ -]+/g, '_')
      .slice(0, 80)
      .trim() || 'file'
  let base = stem + cleanExt
  if (RESERVED_ROOT.has(base.toLowerCase()) || base.startsWith('.')) base = 'file' + cleanExt
  let rel = base
  let abs = safeJoin(dir, rel)
  let i = 2
  while (abs && existsSync(abs)) {
    rel = `${stem}-${i++}${cleanExt}`
    abs = safeJoin(dir, rel)
  }
  if (!abs) return null
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, buffer)
    markWrite(resolve(abs))
    return { rel }
  } catch {
    return null
  }
}

/**
 * Copy a real file OR directory the user DROPPED (by absolute OS path — the Electron path; the browser
 * has no FS path so server mode uploads bytes instead) into the workspace root. A file copies 1:1; a
 * directory copies RECURSIVELY, so a dropped repo lands as ONE real subdir → one collapsed tile (the
 * reconcile is non-recursive, so even a 10k-file repo stays a single folder tile). Picks a unique,
 * non-reserved basename, jails the dest inside the workspace, and REFUSES to copy the workspace into
 * itself (src == root or src inside root → would recurse / dup-storm). Returns { rel, isDir } or null.
 */
export function copyDroppedEntry(dir, srcPath) {
  if (typeof srcPath !== 'string' || !srcPath) return null
  let srcReal, st
  try {
    srcReal = realpathSync(srcPath) // resolve symlinks up front so the self-copy guard can't be fooled
    st = lstatSync(srcReal)
  } catch {
    return null // vanished / unreadable
  }
  const root = (() => {
    try {
      return realpathSync(dir)
    } catch {
      return resolve(dir)
    }
  })()
  if (srcReal === root || srcReal.startsWith(root + sep)) return null // never copy the workspace into itself
  const isDir = st.isDirectory()
  const raw = basename(srcReal).replace(/^\.+/, '').trim() || (isDir ? 'folder' : 'file')
  const ext = isDir ? '' : extname(raw)
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]+/g, '').slice(0, 12)
  const stem =
    (raw.slice(0, raw.length - ext.length) || (isDir ? 'folder' : 'file'))
      .replace(/[^a-zA-Z0-9._ -]+/g, '_')
      .slice(0, 80)
      .trim() || (isDir ? 'folder' : 'file')
  let base = stem + cleanExt
  if (RESERVED_ROOT.has(base.toLowerCase()) || base.startsWith('.')) base = (isDir ? 'folder' : 'file') + cleanExt
  let rel = base
  let abs = safeJoin(dir, rel)
  let i = 2
  while (abs && existsSync(abs)) {
    rel = isDir ? `${stem}-${i++}` : `${stem}-${i++}${cleanExt}`
    abs = safeJoin(dir, rel)
  }
  if (!abs) return null
  try {
    if (isDir) cpSync(srcReal, abs, { recursive: true, errorOnExist: false, dereference: false })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      copyFileSync(srcReal, abs)
    }
    markWrite(resolve(abs))
    return { rel, isDir }
  } catch {
    return null
  }
}

/**
 * Write a dropped file at a RELATIVE subpath under the workspace (server folder-drop: the browser
 * recurses the dropped directory's entries via webkitGetAsEntry and uploads each file with its
 * in-folder path, e.g. "myrepo/src/app.js"). Sanitizes EVERY segment — strips leading dots (so a
 * segment can never become `.blitzos`/`.git`) and separators, drops ''/'.'/'..' — then jails the
 * final path and mkdir -p's the parents. Returns { rel } or null.
 */
export function writeDroppedFileAt(dir, relPath, buffer) {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((p) =>
      p
        .replace(/^\.+/, '')
        .replace(/[^a-zA-Z0-9._ -]+/g, '_')
        .slice(0, 80)
        .trim()
    )
    .filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) return null
  const rel = parts.join('/')
  if (RESERVED_ROOT.has(rel.toLowerCase())) return null // a single-segment drop can't clobber BLITZOS.md/.gitignore
  const abs = safeJoin(dir, rel)
  if (!abs) return null
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, buffer)
    markWrite(resolve(abs))
    return { rel }
  } catch {
    return null
  }
}

export function reconcileWorkspace(dir, placeAt = {}) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  let ws
  try {
    ws = JSON.parse(readFileSync(metaFile, 'utf8'))
  } catch {
    return null
  }
  if (!ws || !Array.isArray(ws.nodes)) return null
  const nodes = ws.nodes.filter((n) => n && typeof n.id === 'string' && typeof n.path === 'string')
  const known = new Set(nodes.map((n) => n.path))
  const knownIds = new Set(nodes.map((n) => n.id)) // persisted node ids — lets a caller tell an un-persisted surface from a deleted one

  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    /* unreadable workspace dir */
  }
  const newFiles = entries.filter((e) => e.isFile() && autoKind(e.name) && !known.has(e.name) && safeJoin(dir, e.name)).map((e) => e.name)
  // A NORMAL subfolder surfaces as ONE collapsed 'dir' tile (#37). A SPECIAL '.board' folder (#54 — the
  // macOS .app-bundle analogy) instead splays its DIRECT children onto the canvas as a sub-board. Skip
  // dot-dirs (.blitzos/.git).
  const topDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && safeJoin(dir, e.name)).map((e) => e.name)
  const newDirs = topDirs.filter((n) => !isBoard(n) && !known.has(n))
  const boards = topDirs.filter(isBoard)

  let changed = false
  // single-rename heal: a node's file is gone AND exactly one NEW file of the same kind exists.
  // NOT for file/dir nodes — BlitzOS never renames the user's own files, so a rename-pair guess
  // there would wrongly re-bind an unrelated dropped file (#37).
  const usedNew = new Set()
  for (const n of nodes) {
    const abs = safeJoin(dir, n.path)
    if (abs && existsSync(abs)) continue
    const cand =
      n.kind === 'file' || n.kind === 'dir'
        ? []
        : newFiles.filter((f) => !usedNew.has(f) && (autoKind(f) === n.kind || (n.kind === 'app' && autoKind(f) === 'web')))
    if (cand.length === 1) {
      n.path = cand[0]
      usedNew.add(cand[0])
      changed = true
    }
  }
  // drop nodes whose file is still gone
  const alive = nodes.filter((n) => {
    const abs = safeJoin(dir, n.path)
    return abs && existsSync(abs)
  })
  if (alive.length !== nodes.length) changed = true

  // auto-place the still-unclaimed new files
  const cx = Number(placeAt.cx) || 0
  const cy = Number(placeAt.cy) || 0
  let i = 0
  for (const f of newFiles) {
    if (usedNew.has(f)) continue
    const kind = autoKind(f)
    const sz = defaultSizeFor(kind)
    alive.push({ id: randomUUID(), path: f, kind, x: Math.round(cx - sz.w / 2 + (i % 6) * 28), y: Math.round(cy - sz.h / 2 + (i % 6) * 24), w: sz.w, h: sz.h })
    i++
    changed = true
  }
  for (const d of newDirs) {
    const sz = defaultSizeFor('dir')
    alive.push({ id: randomUUID(), path: d, kind: 'dir', x: Math.round(cx - sz.w / 2 + (i % 6) * 28), y: Math.round(cy - sz.h / 2 + (i % 6) * 24), w: sz.w, h: sz.h })
    i++
    changed = true
  }
  // #54: a '.board' folder splays its DIRECT children onto the canvas (one level only — a child subdir is
  // itself one collapsed tile, so a board can't recurse-explode). Over BOARD_CAP children → fall back to a
  // single collapsed tile (scale guard, like a repo). Children persist their own layout as nested nodes.
  for (const b of boards) {
    const babs = safeJoin(dir, b)
    let kids = []
    try {
      kids = readdirSync(babs, { withFileTypes: true })
    } catch {
      /* unreadable board */
    }
    const children = kids
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || autoKind(e.name)))
      .map((e) => ({ rel: `${b}/${e.name}`, kind: e.isDirectory() ? 'dir' : autoKind(e.name) }))
    if (children.length > BOARD_CAP) {
      if (!known.has(b)) {
        const sz = defaultSizeFor('dir')
        alive.push({ id: randomUUID(), path: b, kind: 'dir', x: Math.round(cx - sz.w / 2 + (i % 6) * 28), y: Math.round(cy - sz.h / 2 + (i % 6) * 24), w: sz.w, h: sz.h })
        i++
        changed = true
      }
      continue
    }
    let j = 0
    for (const c of children) {
      if (!c.kind || known.has(c.rel)) {
        j++
        continue
      }
      const sz = defaultSizeFor(c.kind)
      alive.push({ id: randomUUID(), path: c.rel, kind: c.kind, x: Math.round(cx - sz.w / 2 + (j % 4) * (sz.w + 16)), y: Math.round(cy - sz.h / 2 + Math.floor(j / 4) * (sz.h + 16)), w: sz.w, h: sz.h })
      j++
      changed = true
    }
  }

  // V1 island: no canvas z-stack is written. A legacy file may still carry a `stack` array — honor it for
  // stable z if present (back-compat), else assign sequential z.
  const stackPrev = Array.isArray(ws.stack) ? ws.stack : []
  const zByIdx = new Map(stackPrev.map((id, idx) => [id, idx + 1]))
  let seq = stackPrev.length + 1
  const surfaces = []
  for (const n of alive) {
    const s = nodeToSurface(dir, n, zByIdx.get(n.id) ?? seq++)
    if (s) surfaces.push(s)
  }

  if (changed) {
    // The rewrite drops any leftover camera/mode/stack/slot from an old file — they simply fall away.
    const groups = visualGroupsFromMeta(ws.groups, new Set(alive.map((n) => n.id)))
    const out = { version: VERSION, id: typeof ws.id === 'string' ? ws.id : randomUUID(), kind: 'blitzos.workspace', groups, nodes: alive }
    writeMeta(metaFile, out) // atomic + keeps workspace.json.bak
  }
  return { surfaces, changed, knownIds }
}

// ---- cross-workspace surface addressing (item 4): a surface id lives in exactly one workspace folder.
// findSurfaceWorkspace locates it (so an op on a non-active id can NAME where it is); relocateSurface
// MOVES it into the active workspace (the "I just want this one window here" path) by carrying its
// content file across folders and preserving the id — the everything-is-a-file model makes this a plain
// file move + a node transfer.

/** Find which workspace under `root` holds surface `id` (scanning each workspace.json). `exceptDir` skips
 *  the active one. Returns { name, dir, node } or null. Read-only + size-capped. */
export function findSurfaceWorkspace(root, id, exceptDir) {
  let rootReal
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    return null
  }
  if (!id) return null
  const except = exceptDir ? resolve(exceptDir) : null
  let ents = []
  try {
    ents = readdirSync(rootReal, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of ents) {
    if (!e.isDirectory() || !safeName(e.name)) continue
    const dir = join(rootReal, e.name)
    if (except && resolve(dir) === except) continue
    const metaFile = join(dir, '.blitzos', 'workspace.json')
    try {
      const ms = statSync(metaFile)
      if (ms.size > MAX_META) continue
      const m = JSON.parse(readFileSync(metaFile, 'utf8'))
      const node = Array.isArray(m.nodes) ? m.nodes.find((n) => n && n.id === id) : null
      if (node) return { name: e.name, dir, node }
    } catch {
      /* unreadable workspace.json — skip */
    }
  }
  return null
}

/**
 * Move surface `id` from whatever OTHER workspace holds it INTO `destDir`: copy its content file across,
 * delete it + drop its node from the source workspace.json, and return the reconstructed surface
 * descriptor (SAME id, placed at `placeAt`) for the caller to insert into the live destination state.
 * Single-file kinds only (note/web/srcdoc/file — a recursive folder move is out of scope). Returns
 * { surface, fromName } or null if the id isn't in another workspace / is unmovable.
 */
export function relocateSurface(root, destDir, id, placeAt = {}) {
  const found = findSurfaceWorkspace(root, id, destDir)
  if (!found) return null
  const { name: fromName, dir: srcDir, node } = found
  if (node.kind === 'dir') return null // recursive folder move not supported yet
  const srcRel = typeof node.path === 'string' ? node.path : null
  const srcAbs = srcRel ? safeJoin(srcDir, srcRel) : null
  if (!srcAbs || !existsSync(srcAbs)) return null
  let bytes
  try {
    bytes = readFileSync(srcAbs)
  } catch {
    return null
  }
  // write into dest (uniquify the basename against existing dest files), then remove from source
  const base = basename(srcRel)
  const dot = base.lastIndexOf('.')
  let destRel = base
  for (let i = 2; existsSync(join(destDir, destRel)); i++) destRel = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`
  const destAbs = safeJoin(destDir, destRel)
  if (!destAbs) return null
  try {
    mkdirSync(dirname(destAbs), { recursive: true })
    writeFileSync(destAbs, bytes)
    markWrite(resolve(destAbs))
    unlinkSync(srcAbs)
    markWrite(resolve(srcAbs))
  } catch {
    return null
  }
  // drop the node from the source workspace.json so it doesn't linger / resurrect there
  try {
    const srcMeta = join(srcDir, '.blitzos', 'workspace.json')
    const m = JSON.parse(readFileSync(srcMeta, 'utf8'))
    m.nodes = (m.nodes || []).filter((n) => n.id !== id)
    delete m.stack // V1 island: the canvas z-stack is gone; drop any legacy field on rewrite
    writeMeta(srcMeta, m)
  } catch {
    /* source json untouched — the moved file is gone, so it won't resurface there on reconcile anyway */
  }
  // reconstruct the descriptor in the destination, preserving id + placing it at the requested point
  const px = Number(placeAt.x)
  const py = Number(placeAt.y)
  const destNode = { ...node, path: destRel, x: Math.round(Number.isFinite(px) ? px : node.x || 0), y: Math.round(Number.isFinite(py) ? py : node.y || 0) }
  const surface = nodeToSurface(destDir, destNode, 1)
  return surface ? { surface, fromName } : null
}

/**
 * #52 — "group into a folder" is a REAL filesystem operation: make a subdirectory and MOVE the chosen
 * members' content files into it. Not an in-memory membership list — the folder is a real directory, so
 * it persists, drill-in browses its real contents, and a grouped 50-file set is ONE tile (the reconcile
 * is non-recursive, so even a 10k-file repo grouped in stays one folder tile). Member content paths come
 * from the current workspace.json (flush() first so every member has a file). Returns
 * { ok, folder:<relpath>, moved }. The caller reconciles after so the new subdir surfaces as a folder
 * tile and the moved files leave the canvas root.
 */
export function groupIntoFolder(dir, name, memberIds, kind) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const { idToPath } = readPrior(metaFile)
  const ids = Array.isArray(memberIds) ? memberIds : []
  let existing = new Set()
  try {
    existing = new Set(readdirSync(dir, { withFileTypes: true }).map((e) => e.name.toLowerCase()))
  } catch {
    /* unreadable */
  }
  // a real, unique subdir name from the chosen title. kind:'board' → a '.board' on-canvas folder (#54)
  // whose children splay; otherwise a normal collapsed folder (#52).
  const sfx = kind === 'board' ? BOARD_SUFFIX : ''
  const stem = slug(name, 'folder') || 'folder'
  let folderName = stem + sfx
  let i = 2
  while (existing.has(folderName.toLowerCase()) || RESERVED_ROOT.has(folderName.toLowerCase())) folderName = `${stem}-${i++}${sfx}`
  const folderAbs = safeJoin(dir, folderName)
  if (!folderAbs) return { ok: false, error: 'bad folder name' }
  try {
    mkdirSync(folderAbs, { recursive: true })
  } catch {
    return { ok: false, error: 'could not create folder' }
  }
  markWrite(resolve(folderAbs))
  let moved = 0
  for (const id of ids) {
    const rel = idToPath.get(id)
    if (!rel) continue // member has no content file (e.g. a runtime panel) — nothing to move
    if (rel.includes('/') || rel.includes(sep)) continue // only ROOT-level items move (don't re-nest)
    const srcAbs = safeJoin(dir, rel)
    if (!srcAbs || !existsSync(srcAbs)) continue
    const baseName = rel.split(/[\\/]/).pop()
    let destRel = `${folderName}/${baseName}`
    let dn = 2
    while (existsSync(safeJoin(dir, destRel) || dir)) {
      const dot = baseName.lastIndexOf('.')
      destRel = dot > 0 ? `${folderName}/${baseName.slice(0, dot)}-${dn++}${baseName.slice(dot)}` : `${folderName}/${baseName}-${dn++}`
    }
    const destAbs = safeJoin(dir, destRel)
    if (!destAbs) continue
    try {
      renameSync(srcAbs, destAbs) // a real mv — works for files AND subdirs (a grouped repo just nests)
      markWrite(resolve(srcAbs))
      markWrite(resolve(destAbs))
      moved++
    } catch {
      /* skip a member we couldn't move */
    }
  }
  return { ok: true, folder: folderName, moved }
}

/**
 * Make an EMPTY real folder in the workspace root — the "New Folder" / "New Board" desktop action
 * (the user-facing counterpart to the agent's /group). kind:'board' → a '.board' on-canvas folder
 * (#54) whose children splay; otherwise a normal collapsed folder (#52). Unique, non-reserved,
 * jailed name. Returns { ok, folder } or { ok:false, error }. The caller reconciles after so a
 * normal folder surfaces as one tile (an empty board has no children to splay yet).
 */
export function createFolder(dir, name, kind) {
  let existing = new Set()
  try {
    existing = new Set(readdirSync(dir, { withFileTypes: true }).map((e) => e.name.toLowerCase()))
  } catch {
    /* unreadable */
  }
  const sfx = kind === 'board' ? BOARD_SUFFIX : ''
  const stem = slug(name, kind === 'board' ? 'board' : 'folder') || 'folder'
  let folderName = stem + sfx
  let i = 2
  while (existing.has(folderName.toLowerCase()) || RESERVED_ROOT.has(folderName.toLowerCase())) folderName = `${stem}-${i++}${sfx}`
  const abs = safeJoin(dir, folderName)
  if (!abs) return { ok: false, error: 'bad folder name' }
  try {
    mkdirSync(abs, { recursive: true })
    markWrite(resolve(abs))
    return { ok: true, folder: folderName }
  } catch {
    return { ok: false, error: 'could not create folder' }
  }
}

function cleanFolderName(name) {
  const n = String(name || '').normalize('NFC').trim().slice(0, 80)
  if (!n || n.startsWith('.') || /[/\\]/.test(n)) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(n)) return null
  if (RESERVED_ROOT.has(n.toLowerCase())) return null
  return n
}

function uniqueDirName(dir, desired, oldRel = '') {
  const clean = cleanFolderName(desired)
  if (!clean) return null
  const oldLower = String(oldRel || '').split(/[\\/]/).pop()?.toLowerCase()
  let existing = new Set()
  try {
    existing = new Set(readdirSync(dir, { withFileTypes: true }).map((e) => e.name.toLowerCase()))
  } catch {
    /* unreadable */
  }
  let name = clean
  let i = 2
  while ((existing.has(name.toLowerCase()) && name.toLowerCase() !== oldLower) || RESERVED_ROOT.has(name.toLowerCase())) {
    name = `${clean}-${i++}`
  }
  return name
}

function readMetaFile(metaFile) {
  try {
    const ws = JSON.parse(readFileSync(metaFile, 'utf8'))
    return ws && Array.isArray(ws.nodes) ? ws : null
  } catch {
    return null
  }
}

function nodeWithPath(n, path) {
  const next = { ...n, path }
  if (n.kind === 'dir') {
    const view = n.view && typeof n.view === 'object' ? { ...n.view } : {}
    delete view.title
    if (Object.keys(view).length) next.view = view
    else delete next.view
  }
  return next
}

function cleanNestedEntryPath(path) {
  const rel = String(path || '').replace(/^[/\\]+/g, '').split('\\').join('/')
  const parts = rel.split('/').filter(Boolean)
  if (parts.length < 2) return null
  if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) return null
  if (/(^|[/\\])\.blitzos([/\\]|$)/i.test(rel)) return null
  return parts.join('/')
}

function uniqueRootEntryPath(dir, baseName, taken) {
  const clean = String(baseName || '').trim()
  if (!clean || clean.startsWith('.')) return null
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''
  let name = clean
  let i = 2
  while (taken.has(name.toLowerCase()) || RESERVED_ROOT.has(name.toLowerCase()) || existsSync(safeJoin(dir, name) || dir)) {
    name = `${stem}-${i++}${ext}`
  }
  taken.add(name.toLowerCase())
  return name
}

function rewriteNodePathPrefix(ws, oldRel, nextRel) {
  const oldPrefix = `${oldRel}/`
  const nextPrefix = `${nextRel}/`
  let changed = false
  ws.nodes = (ws.nodes || []).map((n) => {
    if (!n || typeof n.path !== 'string') return n
    if (n.path === oldRel) {
      changed = true
      return nodeWithPath(n, nextRel)
    }
    if (n.path.startsWith(oldPrefix)) {
      changed = true
      return nodeWithPath(n, nextPrefix + n.path.slice(oldPrefix.length))
    }
    return n
  })
  return changed
}

/**
 * Rename a REAL folder in the active workspace. This renames the directory itself and rewrites any
 * workspace nodes whose backing path is that folder or a descendant. Returns the final unique path.
 */
export function renameFolder(dir, rel, name) {
  const oldRel = String(rel || '').replace(/^[/\\]+|[/\\]+$/g, '')
  if (!oldRel || oldRel.startsWith('.') || oldRel.includes('..')) return { ok: false, error: 'bad folder path' }
  const oldAbs = safeJoin(dir, oldRel)
  if (!oldAbs) return { ok: false, error: 'bad folder path' }
  try {
    if (!statSync(oldAbs).isDirectory()) return { ok: false, error: 'not a folder' }
  } catch {
    return { ok: false, error: 'folder not found' }
  }
  const parentRel = oldRel.split('/').slice(0, -1).join('/')
  const parentAbs = safeJoin(dir, parentRel || '.')
  if (!parentAbs) return { ok: false, error: 'bad folder path' }
  const nextName = uniqueDirName(parentAbs, name, oldRel)
  if (!nextName) return { ok: false, error: 'bad folder name' }
  const nextRel = parentRel ? `${parentRel}/${nextName}` : nextName
  if (nextRel === oldRel) return { ok: true, path: oldRel }
  const nextAbs = safeJoin(dir, nextRel)
  if (!nextAbs) return { ok: false, error: 'bad folder name' }
  try {
    renameSync(oldAbs, nextAbs)
    markWrite(resolve(oldAbs))
    markWrite(resolve(nextAbs))
  } catch {
    return { ok: false, error: 'could not rename folder' }
  }
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const ws = readMetaFile(metaFile)
  if (ws && rewriteNodePathPrefix(ws, oldRel, nextRel)) writeMeta(metaFile, ws)
  return { ok: true, path: nextRel }
}

/**
 * Move existing workspace-backed surfaces into an EXISTING real folder. The surfaces disappear from
 * the root canvas after reconcile; their files remain browseable/openable from the folder.
 */
export function moveIntoFolder(dir, folderRel, memberIds) {
  const targetRel = String(folderRel || '').replace(/^[/\\]+|[/\\]+$/g, '')
  if (!targetRel || targetRel.startsWith('.') || targetRel.includes('..')) return { ok: false, error: 'bad folder path' }
  const targetAbs = safeJoin(dir, targetRel)
  if (!targetAbs) return { ok: false, error: 'bad folder path' }
  try {
    if (!statSync(targetAbs).isDirectory()) return { ok: false, error: 'not a folder' }
  } catch {
    return { ok: false, error: 'folder not found' }
  }
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const ws = readMetaFile(metaFile)
  const idToNode = new Map()
  for (const n of ws?.nodes || []) {
    if (n && typeof n.id === 'string' && typeof n.path === 'string') idToNode.set(n.id, n)
  }
  const movableKinds = new Set(['note', 'app', 'srcdoc', 'file', 'dir'])
  const ids = Array.isArray(memberIds) ? memberIds.map(String) : []
  let moved = 0
  let skipped = 0
  const movedIds = []
  const skippedIds = []
  const skip = (id) => {
    skipped++
    if (id) skippedIds.push(id)
  }
  for (const id of ids) {
    const node = idToNode.get(id)
    const rel = node?.path
    if (!node || !rel) {
      skip(id)
      continue
    }
    if (!movableKinds.has(node.kind)) {
      skip(id)
      continue
    }
    if (rel === targetRel || targetRel.startsWith(`${rel}/`) || rel.startsWith(`${targetRel}/`)) {
      skip(id)
      continue
    }
    const srcAbs = safeJoin(dir, rel)
    if (!srcAbs || !existsSync(srcAbs)) {
      skip(id)
      continue
    }
    const baseName = basename(rel)
    let destRel = `${targetRel}/${baseName}`
    let dn = 2
    while (existsSync(safeJoin(dir, destRel) || dir)) {
      const dot = baseName.lastIndexOf('.')
      destRel = dot > 0 ? `${targetRel}/${baseName.slice(0, dot)}-${dn++}${baseName.slice(dot)}` : `${targetRel}/${baseName}-${dn++}`
    }
    const destAbs = safeJoin(dir, destRel)
    if (!destAbs) {
      skip(id)
      continue
    }
    try {
      renameSync(srcAbs, destAbs)
      markWrite(resolve(srcAbs))
      markWrite(resolve(destAbs))
      moved++
      movedIds.push(id)
    } catch {
      skip(id)
    }
  }
  return { ok: moved > 0, moved, skipped, movedIds, skippedIds, ...(moved > 0 ? {} : { error: 'nothing movable' }) }
}

/**
 * Move entries OUT of a real folder and into the workspace root. Unlike moveIntoFolder, this is path-
 * based because a folder-browser entry may not already be an open surface id.
 */
export function moveOutOfFolder(dir, paths, placeAt = {}) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const ws = readMetaFile(metaFile)
  if (!ws) return { ok: false, moved: 0, skipped: 0, movedPaths: [], skippedPaths: [], pathMoves: [], surfaceIds: [], surfaces: [], updatedIds: [], updatedSurfaces: [], error: 'workspace not ready' }
  let existing = new Set()
  try {
    existing = new Set(readdirSync(dir, { withFileTypes: true }).map((e) => e.name.toLowerCase()))
  } catch {
    /* unreadable root */
  }
  const requested = Array.isArray(paths) ? paths.map(String) : []
  const movedPaths = []
  const skippedPaths = []
  const pathMoves = []
  const surfaces = []
  const surfaceIds = []
  const updatedSurfaces = []
  const updatedIds = []
  let moved = 0
  let skipped = 0
  const skip = (p) => {
    skipped++
    skippedPaths.push(String(p || ''))
  }
  // V1 island: no canvas z-stack. z is just a per-surface render field — hand each moved/updated surface
  // a fresh incrementing z; the legacy `stack` array is dropped on rewrite (delete below).
  let zSeq = (ws.nodes || []).length + 1
  const cx = Number(placeAt.x)
  const cy = Number(placeAt.y)

  for (const raw of requested) {
    const srcRel = cleanNestedEntryPath(raw)
    if (!srcRel) {
      skip(raw)
      continue
    }
    const srcAbs = safeJoin(dir, srcRel)
    if (!srcAbs || !existsSync(srcAbs)) {
      skip(raw)
      continue
    }
    const kind = entryKindForPath(srcAbs, srcRel)
    if (!kind) {
      skip(raw)
      continue
    }
    const destRel = uniqueRootEntryPath(dir, basename(srcRel), existing)
    const destAbs = destRel ? safeJoin(dir, destRel) : null
    if (!destRel || !destAbs) {
      skip(raw)
      continue
    }
    try {
      renameSync(srcAbs, destAbs)
      markWrite(resolve(srcAbs))
      markWrite(resolve(destAbs))
    } catch {
      skip(raw)
      continue
    }

    const prefix = `${srcRel}/`
    const nextPrefix = `${destRel}/`
    const sz = defaultSizeFor(kind)
    const offset = moved % 6
    let node = (ws.nodes || []).find((n) => n && n.path === srcRel)
    if (node) {
      node.path = destRel
      node.kind = kind
      node.w = Math.round(Number(node.w) || sz.w)
      node.h = Math.round(Number(node.h) || sz.h)
      node.x = Math.round(Number.isFinite(cx) ? cx - node.w / 2 + offset * 24 : Number(node.x) || 0)
      node.y = Math.round(Number.isFinite(cy) ? cy - node.h / 2 + offset * 20 : Number(node.y) || 0)
      if (node.kind === 'dir') {
        const next = nodeWithPath(node, destRel)
        Object.assign(node, next)
        if (!('view' in next)) delete node.view
      }
    } else {
      node = {
        id: randomUUID(),
        path: destRel,
        kind,
        x: Math.round(Number.isFinite(cx) ? cx - sz.w / 2 + offset * 24 : 0),
        y: Math.round(Number.isFinite(cy) ? cy - sz.h / 2 + offset * 20 : 0),
        w: sz.w,
        h: sz.h
      }
      ws.nodes.push(node)
    }
    for (const n of ws.nodes || []) {
      if (n && typeof n.path === 'string' && n.path.startsWith(prefix)) {
        const next = nodeWithPath(n, nextPrefix + n.path.slice(prefix.length))
        Object.assign(n, next)
        if (!('view' in next)) delete n.view
        const updated = nodeToSurface(dir, n, zSeq++)
        if (updated) {
          updatedSurfaces.push(updated)
          updatedIds.push(updated.id)
        }
      }
    }
    const surface = nodeToSurface(dir, node, zSeq++)
    if (surface) {
      surfaces.push(surface)
      surfaceIds.push(surface.id)
    }
    moved++
    movedPaths.push(destRel)
    pathMoves.push({ from: srcRel, to: destRel })
  }

  if (moved > 0) {
    delete ws.stack // V1 island: drop any legacy canvas z-stack on rewrite
    writeMeta(metaFile, ws)
  }
  return { ok: moved > 0, moved, skipped, movedPaths, skippedPaths, pathMoves, surfaceIds, surfaces, updatedIds, updatedSurfaces, ...(moved > 0 ? {} : { error: 'nothing movable' }) }
}

function entryKindForPath(abs, rel) {
  let st
  try {
    st = statSync(abs)
  } catch {
    return null
  }
  if (st.isDirectory()) return 'dir'
  const ext = extname(rel).toLowerCase()
  if (ext === '.md') return 'note'
  if (ext === '.html' || ext === '.jsx' || ext === '.tsx') return 'srcdoc'
  if (ext === '.weblink') {
    try {
      const link = JSON.parse(readFileSync(abs, 'utf8'))
      return link && link.kind === 'app' ? 'app' : 'web'
    } catch {
      return 'web'
    }
  }
  return 'file'
}

/**
 * Register/open a folder entry as its real Blitz surface type. Nested entries become explicit
 * workspace nodes, so their id/path is stable while open; closing a nested node removes the node
 * but keeps the underlying file.
 */
export function openFolderEntry(dir, rel, placeAt = {}) {
  const path = String(rel || '').replace(/^[/\\]+/g, '')
  if (!path || path.startsWith('.') || /(^|[/\\])\.blitzos([/\\]|$)/i.test(path)) return { ok: false, error: 'bad path' }
  const abs = safeJoin(dir, path)
  if (!abs || !existsSync(abs)) return { ok: false, error: 'not found' }
  const kind = entryKindForPath(abs, path)
  if (!kind) return { ok: false, error: 'could not open entry' }
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const ws = readMetaFile(metaFile)
  if (!ws) return { ok: false, error: 'workspace not ready' }
  let node = ws.nodes.find((n) => n && n.path === path)
  if (!node) {
    const sz = defaultSizeFor(kind)
    const cx = Number(placeAt.x)
    const cy = Number(placeAt.y)
    node = {
      id: randomUUID(),
      path,
      kind,
      x: Math.round(Number.isFinite(cx) ? cx - sz.w / 2 : 0),
      y: Math.round(Number.isFinite(cy) ? cy - sz.h / 2 : 0),
      w: sz.w,
      h: sz.h
    }
    ws.nodes.push(node)
    delete ws.stack // V1 island: drop any legacy canvas z-stack on rewrite
    writeMeta(metaFile, ws)
  }
  // V1 island: no canvas z-stack — hand the surface a top-of-set z (it's a render-only field now).
  const surface = nodeToSurface(dir, node, (ws.nodes || []).length + 1)
  return surface ? { ok: true, id: surface.id, surface } : { ok: false, error: 'could not open entry' }
}

/**
 * CLOSE a surface = delete its backing content file, EXPLICITLY by id (never inferred from a push — so a
 * partial or empty state push can NEVER mass-delete the folder). Without this a closed note/web/srcdoc
 * leaves its file on disk and the next reconcile re-materializes it ("I closed the window and it popped
 * right back up"). Only a BlitzOS-owned content file (.md/.weblink/.html) is removed — NEVER a real
 * dropped file/dir/repo. Jailed + self-write-stamped so the watcher ignores the unlink. Returns
 * { ok, removed } or { ok:false }.
 */
export function removeSurfaceFile(dir, id) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  const { idToPath } = readPrior(metaFile)
  const rel = idToPath.get(String(id))
  if (!rel) return { ok: false } // no backing file (a runtime panel, or already gone)
  if (rel.includes('/') || rel.includes(sep)) {
    const rootSegment = rel.split(/[\\/]/)[0]
    // Folder-browser entries are opened as temporary canvas nodes; closing that node should not
    // delete the actual file. `.board` children predate this flow and keep their existing close=delete behavior.
    if (!isBoard(rootSegment)) {
      const ws = readMetaFile(metaFile)
      if (ws) {
        ws.nodes = (ws.nodes || []).filter((n) => n && n.id !== String(id))
        delete ws.stack // V1 island: drop any legacy canvas z-stack on rewrite
        writeMeta(metaFile, ws)
      }
      return { ok: true, removed: rel, keptFile: true }
    }
  }
  if (!CONTENT_EXTS.has(extname(rel).toLowerCase())) return { ok: false, skipped: 'not-content' } // never a real file/dir
  const abs = safeJoin(dir, rel)
  if (!abs || !existsSync(abs)) return { ok: false }
  try {
    markWrite(resolve(abs))
    unlinkSync(abs)
    return { ok: true, removed: rel }
  } catch {
    return { ok: false }
  }
}

/**
 * Delete everything an AGENT owns when it's closed: its transcript (chat-<id>.md), its (possibly
 * agent-customized) widget UI (blitz-<id>-chat.*), and its agent dir (.blitzos/terminals/<id>/ —
 * meta.json + transcript.jsonl + bootstrap.txt). removeSurfaceFile can't do this (a chat surface has no
 * idToPath entry). Every delete is markWrite-stamped so the folder watcher skips its own writes. Never
 * called for primary '0' (the caller guards) — but chatFileName/sysRendererName branch on '0' anyway.
 */
export function removeAgentFiles(dir, agentId) {
  const id = String(agentId)
  // SECURITY: an agent id is numeric. Refuse anything else (esp. '..'/separators) — a crafted id would
  // resolve to a valid-but-wrong path INSIDE the workspace (safeJoin only blocks escapes OUT of it) and
  // rmSync the wrong tree (e.g. id '..' → the whole .blitzos dir). '0' is the primary — never deleted here.
  if (!/^[1-9][0-9]*$/.test(id)) return
  for (const rel of [chatFileName(id), ...sysRendererNames('chat', id)]) {
    const abs = safeJoin(dir, rel)
    if (abs && existsSync(abs)) { try { markWrite(resolve(abs)); unlinkSync(abs) } catch { /* best-effort */ } }
  }
  // The agent record dir lives under .blitzos/terminals (the engine renamed it from the legacy .blitzos/sessions);
  // clean up BOTH locations in case the migration hasn't run (agent runtime off ⇒ no terminal-ops, no rename).
  // .blitzos/agents/<id> holds the now-private transcript (chatFileName) — drop the whole dir so a re-minted id
  // can't inherit a stale chat.
  for (const sub of ['terminals', 'sessions', 'agents']) {
    const sdir = safeJoin(dir, join('.blitzos', sub, id))
    if (sdir && existsSync(sdir)) { try { markWrite(resolve(sdir)); rmSync(sdir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
  removeAgentAttachments(dir, id) // the per-message attachment snapshots are a per-agent artifact too — drop them
}

/** Delete an agent's frozen per-message attachment snapshots (`.blitzos/attachments/<id>.json`, written by the
 *  renderer over IPC). A per-agent artifact like the chat file: removed on close, AND again when the id is re-minted.
 *  WHY both: agent ids are reused (newAgentId hands out max(live ids)+1, so a closed agent's number is handed back),
 *  so a fresh agent can be reborn onto a previous agent's id and would otherwise inherit its frozen dropbox. Numeric
 *  ids only (matches newAgentId / the closeAgent guard) so a crafted id can never path-traverse. */
export function removeAgentAttachments(dir, agentId) {
  if (!dir) return // no active workspace → nothing to clean (newAgentId can run before one is set)
  const id = String(agentId)
  if (!/^[0-9]+$/.test(id)) return
  const abs = safeJoin(dir, join('.blitzos', 'attachments', id + '.json'))
  if (abs && existsSync(abs)) { try { markWrite(resolve(abs)); unlinkSync(abs) } catch { /* best-effort */ } }
}

// ===========================================================================================
// System widgets — the OS UI as workspace files. A built-in renderer (the chat UI) lives in a
// VISIBLE workspace file `blitz-<role>.<html|jsx|tsx>` (a shipped default, copied in if missing — recreated
// after a delete — and freely editable to customize). The chat TRANSCRIPT is its own file `chat.md`
// (structured + human-readable): the OS appends each message, the widget just renders what's there.
// ===========================================================================================
const SYS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'widgets', 'system')
const SYSTEM_RENDERERS = ['chat', 'note'] // roles that ship a default renderer (blitz-<role>.<html|jsx|tsx>)
const SYSTEM_DEFAULT_LANG = { chat: 'tsx', note: 'html' }
const SYSTEM_LANGS = ['tsx', 'jsx', 'html']
const SYSTEM_PREFIX = 'blitz-'
const CHAT_FILE = 'chat.md'

// Per-agent chat transcript path (workspace-root RELATIVE). ISOLATION (the cross-agent context leak,
// plans/blitzos-agent-chat-isolation.md): transcripts used to be sibling files in the workspace ROOT
// (chat.md / chat-<id>.md), where any agent that listed the folder could `cat` another agent's
// conversation and absorb its task. They now live in a PRIVATE per-agent dir under .blitzos (OS-internal,
// hidden from a plain `ls`, never descended by the file manager): `.blitzos/agents/<id>/chat.md`. The id
// is sanitized (no separators/dots) so a crafted id can never traverse out of the agent dir. `chat-<id>.md`
// in the root is still recognized as a system file for the one-time relocateLegacyChats() migration.
export function chatFileName(sessionId = '0') {
  const raw = String(sessionId ?? '0')
  // Empty / null → the primary, preserving the legacy contract (a falsy sessionId meant agent '0').
  if (!raw) return join('.blitzos', 'agents', '0', 'chat.md')
  // Agent ids are numeric here ('0' primary, positive ints for peers). A filesystem-safe id is its own bucket;
  // a MALFORMED id (e.g. a relay agent passing '1.5' / '0 ' / 'foo/bar' on say/steer — both take an
  // unconstrained string) gets a JAILED, collision-resistant bucket. It must NEVER silently funnel onto '0':
  // that would be a cross-agent WRITE into the primary's private chat — the exact bleed this file prevents.
  const id = /^[a-z0-9_-]+$/i.test(raw) ? raw : `x-${Buffer.from(raw).toString('hex')}`
  return join('.blitzos', 'agents', id, 'chat.md')
}
/** One-time migration: move any ROOT-resident transcript (chat.md, chat-<id>.md) into its private
 *  per-agent dir, so the shared workspace root exposes no sibling chat for another agent to read. Runs
 *  at workspace-open and defensively before every agent launch; idempotent and history-preserving. If
 *  the destination already exists, the stale root copy is deleted (it must never be left readable). */
export function relocateLegacyChats(dir) {
  let base
  try { base = resolve(dir) } catch { return }
  let names = []
  try { names = readdirSync(base) } catch { return }
  for (const name of names) {
    // The CANONICAL legacy names only: chat.md → id '0', chat-<id>.md (id ≠ '0') → that peer. A stray
    // chat-0.md is NOT a real live transcript (the primary always used chat.md), so skip it — folding it onto
    // id '0' would make it race chat.md for the same destination and one would clobber the other.
    let id = null
    if (name === CHAT_FILE) id = '0'
    else {
      const m = name.match(/^chat-([a-z0-9_-]+)\.md$/i)
      if (m && m[1] !== '0') id = m[1]
    }
    if (id == null) continue
    const src = join(base, name)
    try { if (!lstatSync(src).isFile()) continue } catch { continue }
    const dest = safeJoin(base, chatFileName(id))
    if (!dest || resolve(dest) === resolve(src)) continue
    try {
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) {
        // The private transcript already exists (a prior migration). NEVER destroy the root copy and never
        // leave it readable in the root: move it aside, preserved, INSIDE the private agent dir for forensics.
        const aside = join(dirname(dest), `chat.legacy-${randomUUID().slice(0, 8)}.md`)
        markWrite(resolve(src)); markWrite(resolve(aside))
        renameSync(src, aside)
      } else {
        markWrite(resolve(src)); markWrite(resolve(dest))
        renameSync(src, dest)
      }
    } catch { /* best-effort; a failed move leaves the root file, but no agent is pointed at it anymore */ }
  }
}
function systemLang(lang, fallback = 'html') {
  const v = String(lang || fallback).toLowerCase()
  return SYSTEM_LANGS.includes(v) ? v : fallback
}
function sysRendererNameForLang(role, sessionId = '0', lang = 'html') {
  const ext = systemLang(lang)
  return sessionId && String(sessionId) !== '0' ? `${SYSTEM_PREFIX}${sessionId}-${role}.${ext}` : `${SYSTEM_PREFIX}${role}.${ext}`
}
export function sysRendererName(role, sessionId = '0') { return sysRendererNameForLang(role, sessionId, 'html') }
function sysRendererNames(role, sessionId = '0') {
  return SYSTEM_LANGS.map((lang) => sysRendererNameForLang(role, sessionId, lang))
}
/** The role a `blitz-[<sessionId>-]<role>.<html|jsx|tsx>` name encodes (the LAST dash-segment), or null. */
function rendererRoleOf(name) {
  const n = String(name || '').toLowerCase()
  const m = n.match(/^blitz-(.+)\.(html|jsx|tsx)$/)
  if (!m) return null
  const mid = m[1] // 'chat' or '<sessionId>-chat'
  const role = mid.includes('-') ? mid.slice(mid.lastIndexOf('-') + 1) : mid
  return SYSTEM_RENDERERS.indexOf(role) !== -1 ? role : null
}

/** The recognized system files (the chat renderers + their transcripts) — never auto-surfaced as plain tiles. */
export function isSystemFile(name) {
  const n = String(name || '').toLowerCase()
  if (n === CHAT_FILE || /^chat-[a-z0-9_-]+\.md$/.test(n)) return true
  return rendererRoleOf(n) !== null
}
/** If a workspace renderer file is recognized, return its role (chat | …), else null. */
export function systemRoleOf(name) {
  return rendererRoleOf(name)
}

function shippedSystemRenderer(role) {
  const lang = systemLang(SYSTEM_DEFAULT_LANG[role], 'html')
  const candidates = [join(SYS_DIR, `${role}.${lang}`), join(SYS_DIR, `${role}.html`)]
  for (const abs of candidates) {
    try {
      if (existsSync(abs)) return { source: readFileSync(abs, 'utf8'), lang: abs.endsWith('.tsx') ? 'tsx' : abs.endsWith('.jsx') ? 'jsx' : 'html' }
    } catch {
      /* try next */
    }
  }
  return null
}

function readSystemRendererFile(dir, role, sessionId = '0') {
  const found = []
  for (const rel of sysRendererNames(role, sessionId)) {
    const abs = safeJoin(dir, rel)
    if (abs && existsSync(abs)) {
      try { found.push({ rel, abs, mtime: statSync(abs).mtimeMs, lang: rel.endsWith('.tsx') ? 'tsx' : rel.endsWith('.jsx') ? 'jsx' : 'html' }) } catch { /* try next */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || SYSTEM_LANGS.indexOf(a.lang) - SYSTEM_LANGS.indexOf(b.lang))
  for (const f of found) {
    try {
      return { rel: f.rel, source: readFileSync(f.abs, 'utf8'), lang: f.lang }
    } catch {
      /* try next */
    }
  }
  return null
}

/** Ensure `blitz-<role>.<html|jsx|tsx>` exists in the workspace — copy the shipped default if MISSING (so a deleted
 *  renderer is recreated). Never overwrites a real customization. EXCEPTION: a chat renderer that predates
 *  the session HUB and is clearly one of our old shipped defaults can be refreshed to the shipped default.
 *  A renderer written against the hub
 *  (uses `blitz.chat` / `props.threads`) is a genuine customization and is left untouched. */
export function ensureSystemRenderer(dir, role, sessionId = '0') {
  if (SYSTEM_RENDERERS.indexOf(role) === -1) return null
  const existing = readSystemRendererFile(dir, role, sessionId)
  if (existing) {
    if (role === 'chat') {
      try {
        const cur = existing.source
        const shipped = shippedSystemRenderer('chat')
        const hubAware = cur.indexOf('blitz.chat(') !== -1 || cur.indexOf('props.threads') !== -1 || cur.indexOf('p.threads') !== -1
        const preHub = /p\.messages|onProps\(render\)/.test(cur)
        const defaultishCopy = cur.indexOf('The DEFAULT chat UI') !== -1 || cur.indexOf('DEFAULT chat UI') !== -1
        const shippedTsxCopy = existing.lang === 'tsx' && cur.indexOf('export default function ChatHub') !== -1
        const shippedLegacyCopy = existing.lang === 'html' && defaultishCopy
        // System-widget UPDATE propagation: a workspace holds its OWN copy of blitz-chat.*, so a shipped
        // feature (here: item 5b annotation references) never reaches existing desktops. Refresh a SHIPPED
        // copy that lags the shipped feature set; a copy the human CUSTOMIZED (writeSystemRenderer) is left
        // alone — it carries the `blitz-chat-custom` opt-out marker. (Pre-hub copies still migrate as before.)
        // Sentinel = the NEWEST shipped feature marker (bump it when chat.* gains a feature existing
        // desktops must receive). Existing shipped copies refresh; customized copies carry blitz-chat-custom.
        const marker = 'chat-watching-state-v5'
        const featureLag = shipped?.source?.indexOf(marker) !== -1 && cur.indexOf(marker) === -1 && (shippedTsxCopy || shippedLegacyCopy)
        const customized = cur.indexOf('blitz-chat-custom') !== -1
        if (shipped && ((!hubAware && preHub && !customized && defaultishCopy) || (!customized && shippedLegacyCopy) || (hubAware && featureLag && !customized))) {
          const rel = sysRendererNameForLang(role, sessionId, shipped.lang)
          const dest = safeJoin(dir, rel)
          if (!dest) return null
          atomicWrite(dest, shipped.source)
          for (const other of sysRendererNames(role, sessionId)) {
            if (other === rel) continue
            const abs = safeJoin(dir, other)
            if (abs && existsSync(abs)) { try { markWrite(resolve(abs)); unlinkSync(abs) } catch { /* best-effort */ } }
          }
          return { rel, created: false, refreshed: true, lang: shipped.lang }
        }
      } catch {
        /* leave it as-is */
      }
    }
    return { rel: existing.rel, created: false, lang: existing.lang }
  }
  try {
    const shipped = shippedSystemRenderer(role)
    if (!shipped) return null
    const rel = sysRendererNameForLang(role, sessionId, shipped.lang)
    const dest = safeJoin(dir, rel)
    if (!dest) return null
    atomicWrite(dest, shipped.source) // per-session widgets default to the SAME shipped UI
    return { rel, created: true, lang: shipped.lang }
  } catch {
    return null
  }
}
/** Write a system renderer (the agent customizing the chat UI) → blitz-<role>.<html|jsx|tsx>, jailed +
 *  self-write-stamped. The role must be a known system widget. Returns { ok, rel } or { ok:false }. */
export function writeSystemRenderer(dir, role, html, sessionId = '0', lang = 'html') {
  if (SYSTEM_RENDERERS.indexOf(role) === -1) return { ok: false, error: `unknown system widget: ${role}` }
  const outLang = systemLang(lang, 'html')
  const rel = sysRendererNameForLang(role, sessionId, outLang)
  const dest = safeJoin(dir, rel)
  if (!dest) return { ok: false, error: 'bad path' }
  try {
    // Stamp customized copies so ensureSystemRenderer never auto-refreshes over a human/agent customization
    // (system-widget update propagation only refreshes UN-customized shipped copies).
    let out = String(html == null ? '' : html)
    if (out.indexOf('blitz-chat-custom') === -1) {
      out = outLang === 'html' ? `<!--blitz-chat-custom-->\n${out}` : `/* blitz-chat-custom */\n${out}`
    }
    atomicWrite(dest, out)
    for (const other of sysRendererNames(role, sessionId)) {
      if (other === rel) continue
      const abs = safeJoin(dir, other)
      if (abs && existsSync(abs)) { try { markWrite(resolve(abs)); unlinkSync(abs) } catch { /* best-effort */ } }
    }
    return { ok: true, rel, lang: outLang }
  } catch {
    return { ok: false, error: 'write failed' }
  }
}
/** Resolve a system renderer's source + language: this session's file if present, else the workspace's
 *  shared blitz-<role>.* (so a new session inherits the workspace's customized look), else shipped default. */
export function readSystemRendererInfo(dir, role, sessionId = '0') {
  const own = readSystemRendererFile(dir, role, sessionId)
  if (own) return own
  if (String(sessionId) !== '0') {
    const shared = readSystemRendererFile(dir, role, '0')
    if (shared) return shared
  }
  const shipped = shippedSystemRenderer(role)
  return shipped ? { rel: sysRendererNameForLang(role, '0', shipped.lang), source: shipped.source, lang: shipped.lang } : null
}
/** Resolve a system renderer's source (legacy helper for older callers/tests). */
export function readSystemRenderer(dir, role, sessionId = '0') {
  return readSystemRendererInfo(dir, role, sessionId)?.source ?? null
}

// ---- chat transcript file (chat.md) — the OS owns the serialization; the widget just renders it.
// Format: a readable markdown log, one block per message: `### <role> · <ts>` then the text. Parseable
// + human-readable + the agent can read it as plain markdown. Append-only (O(1) per message).
function chatAbs(dir, sessionId = '0') {
  return safeJoin(dir, chatFileName(sessionId))
}
/** Append a chat message to a session's transcript (recreating the file if missing). role: 'user' | 'agent'. */
export function appendChatMessage(dir, role, text, sessionId = '0', meta) {
  const abs = chatAbs(dir, sessionId)
  if (!abs) return { ok: false }
  try {
    if (!existsSync(abs)) atomicWrite(abs, '# Chat\n')
    // Optional structured ref (item 5b: a grounded annotation) rides the header as base64 JSON, so the
    // transcript stays plain-text + human-readable and old messages without it parse unchanged.
    let tag = ''
    if (meta && typeof meta === 'object') {
      try {
        tag = ` · a:${Buffer.from(JSON.stringify(meta)).toString('base64')}`
      } catch {
        /* non-serializable meta — drop the tag */
      }
    }
    const block = `\n### ${role === 'user' ? 'user' : 'agent'} · ${Date.now()}${tag}\n${String(text == null ? '' : text)}\n`
    appendFileSync(abs, block)
    markWrite(resolve(abs))
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
/** Parse a session's transcript into [{role,text,ts}] (last `cap`). Inverse of appendChatMessage. */
export function readChatMessages(dir, cap = 400, sessionId = '0') {
  const abs = chatAbs(dir, sessionId)
  if (!abs || !existsSync(abs)) return []
  let raw = ''
  try {
    if (statSync(abs).size > MAX_CONTENT) return []
    raw = readFileSync(abs, 'utf8')
  } catch {
    return []
  }
  const marks = []
  // optional ` · a:<base64>` carries a structured ref (item 5b: a grounded annotation) on the header
  const re = /^### (user|agent)(?: · (\d+))?(?: · a:([A-Za-z0-9+/=]+))?[ \t]*$/gm
  let m
  while ((m = re.exec(raw))) marks.push({ role: m[1], ts: Number(m[2]) || 0, metaB64: m[3] || null, start: m.index, end: re.lastIndex })
  const msgs = []
  // absUserIdx counts user messages across the FULL transcript (before the cap slice) so attachment-snapshot
  // keys survive the 400-message window: the windowed slice preserves userIdx, the positional ordinal does not.
  let absUserIdx = 0
  for (let i = 0; i < marks.length; i++) {
    const body = raw.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : raw.length).replace(/^\n+|\n+$/g, '')
    const msg = { role: marks[i].role, text: body, ts: marks[i].ts }
    if (marks[i].metaB64) {
      try {
        const meta = JSON.parse(Buffer.from(marks[i].metaB64, 'base64').toString('utf8'))
        if (Array.isArray(meta?.parts)) msg.parts = meta.parts
        msg.ref = { ...meta, text: body }
      } catch {
        /* corrupt ref — fall back to a plain message */
      }
    }
    if (msg.role === 'user') msg.userIdx = absUserIdx++
    msgs.push(msg)
  }
  return msgs.slice(-cap)
}

const LISTDIR_CAP = 1000
/**
 * List a normal folder's contents for the file-manager overlay (#44) — the SAME jailed, capped,
 * sorted listing for BOTH transports (server /api/os/dir + Electron os:dir IPC route here, one impl).
 * realpath-jailed to the workspace, never .blitzos, dotfiles hidden, capped at LISTDIR_CAP with an
 * honest { total, truncated } so the UI can say "showing first 1000 of N" (a normal folder can hold
 * thousands of files — it stays ONE collapsed tile and you browse it here, never splayed). Returns
 * { path, entries[], total, truncated } or null.
 */
export function listDir(dir, rel) {
  let root, real
  try {
    root = realpathSync(resolve(dir))
    real = realpathSync(resolve(root, String(rel || '')))
  } catch {
    return null
  }
  if (real !== root && !real.startsWith(root + sep)) return null // jail
  if (/(^|[/\\])\.blitzos([/\\]|$)/i.test(real.slice(root.length))) return null // never the metadata dir
  try {
    if (!statSync(real).isDirectory()) return null
  } catch {
    return null
  }
  const relBase = real
    .slice(root.length)
    .replace(/^[/\\]+/, '')
    .split(sep)
    .join('/')
  let all = []
  try {
    all = readdirSync(real, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
  } catch {
    return null
  }
  const total = all.length
  const entries = all
    .slice(0, LISTDIR_CAP)
    .map((e) => {
      let size = 0
      let entries = 0
      try {
        const abs = join(real, e.name)
        if (e.isFile()) size = statSync(abs).size
        else if (e.isDirectory()) entries = readdirSync(abs).filter((name) => !name.startsWith('.')).length
      } catch {
        /* unreadable entry */
      }
      const ext = e.isFile() ? (e.name.split('.').pop() || '').toLowerCase() : ''
      return { name: e.name, dir: e.isDirectory(), ext, size, entries, isImage: IMAGE_EXT.test(ext), path: relBase ? `${relBase}/${e.name}` : e.name }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { path: String(rel || ''), entries, total, truncated: total > entries.length }
}

// ===========================================================================================
// Multi-workspace: a ROOT folder holds many workspace folders (the launcher lists/creates/
// switches between them). Names are validated on RAW input with a strict allow-list BEFORE any
// path join — safeJoin (above) is only a traversal backstop, it still passes '.blitzos', 'a/b',
// and reserved device names like 'con'. The switch/list paths additionally realpath-jail under
// the root so a symlinked workspace can't escape to e.g. the cookie profile or tokens.
// ===========================================================================================

// 1..64 chars; must start alphanumeric (no leading space/dash/dot); only space, dash, underscore
// otherwise — so no separators, no dotfiles, no extensions.
const WS_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/
const WS_RESERVED = new Set([
  '.blitzos', 'blitzos.md', '.gitignore', '.git', '.', '..', 'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/** Validate a RAW workspace name. Returns the NFC-normalized name, or null if invalid. */
export function safeName(name) {
  if (typeof name !== 'string') return null
  const n = name.normalize('NFC')
  if (n !== n.trim()) return null // no leading/trailing whitespace
  if (!WS_NAME.test(n)) return null
  if (WS_RESERVED.has(n.toLowerCase())) return null
  return n
}

/**
 * Resolve a workspace name to an absolute path under `root`, realpath-jailed (NOT a string
 * startsWith — defeats symlink escapes). `mustExist:true` (switch) requires an existing dir whose
 * realpath is exactly the jailed target; `mustExist:false` (create) requires it NOT to exist yet.
 * Returns the absolute path or null.
 */
export function resolveWorkspace(root, name, { mustExist }) {
  const safe = safeName(name)
  if (!safe) return null
  let rootReal
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    return null
  }
  const target = join(rootReal, safe)
  if (mustExist) {
    let real
    try {
      real = realpathSync(target)
    } catch {
      return null
    }
    if (real !== target) return null // a symlink pointing outside the jail — reject
    try {
      if (!statSync(real).isDirectory()) return null
    } catch {
      return null
    }
    return real
  }
  // create: the path must NOT already exist
  if (existsSync(target)) return null
  return target
}

/** List the workspace folders under `root` (newest-edited first). Skips non-dirs, invalid
 *  names, and symlinks escaping the jail. Each: { name, path, nodeCount, updatedAt }. */
export function listWorkspaces(root) {
  let rootReal
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    return []
  }
  let ents = []
  try {
    ents = readdirSync(rootReal, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory() || !safeName(e.name)) continue
    const p = join(rootReal, e.name)
    try {
      if (realpathSync(p) !== p) continue // escaping symlink — skip
    } catch {
      continue
    }
    const metaFile = join(p, '.blitzos', 'workspace.json')
    let nodeCount = 0
    let updatedAt = 0
    try {
      const ms = statSync(metaFile)
      updatedAt = ms.mtimeMs
      if (ms.size <= MAX_META) {
        const m = JSON.parse(readFileSync(metaFile, 'utf8')) // size-capped: never read a planted giant meta whole
        if (Array.isArray(m.nodes)) nodeCount = m.nodes.length
      }
    } catch {
      try {
        updatedAt = statSync(p).mtimeMs
      } catch {
        /* unreadable — leave 0 */
      }
    }
    let thumbTs = 0 // mtime of the cached primary-stage thumbnail (0 = none) — used to cache-bust the tile
    try {
      thumbTs = statSync(join(p, '.blitzos', 'state', 'thumb.jpg')).mtimeMs
    } catch {
      /* no thumbnail captured yet */
    }
    out.push({ name: e.name, path: p, nodeCount, updatedAt, thumbTs })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200) // newest-first, THEN cap (never drop the newest)
}

/** Create a new workspace folder under `root` + scaffold it. Throws Error with .code
 *  'EINVAL' (bad name / bad root) or 'EEXIST' (already exists). Returns { name, path }. */
export function createWorkspace(root, name) {
  const safe = safeName(name)
  if (!safe) {
    const e = new Error('invalid workspace name')
    e.code = 'EINVAL'
    throw e
  }
  let rootReal
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    const e = new Error('invalid workspaces root')
    e.code = 'EINVAL'
    throw e
  }
  const target = join(rootReal, safe)
  if (existsSync(target)) {
    const e = new Error('workspace already exists')
    e.code = 'EEXIST'
    throw e
  }
  mkdirSync(target, { recursive: false }) // recursive:false → EEXIST backstop if it races
  scaffold(target) // self-describing BLITZOS.md + .gitignore (private fn above)
  return { name: safe, path: target }
}

/** Delete a workspace folder under `root` — rm -rf its dir and EVERYTHING in it (incl. .blitzos). Realpath-
 *  jailed via resolveWorkspace: only an existing dir whose realpath is exactly <root>/<safeName> is removed,
 *  so a crafted name or an escaping symlink can never delete outside the jail. Throws Error with .code
 *  'EINVAL' (bad name/root) or 'ENOENT' (not found). Returns { name }. The HOST is responsible for the
 *  policy guards (never the active workspace, never the last one) — this just does the destructive removal. */
export function deleteWorkspace(root, name) {
  const safe = safeName(name)
  if (!safe) {
    const e = new Error('invalid workspace name')
    e.code = 'EINVAL'
    throw e
  }
  const target = resolveWorkspace(root, safe, { mustExist: true }) // realpath-jailed to <rootReal>/<safe>, must be a real dir
  if (!target) {
    const e = new Error('workspace not found')
    e.code = 'ENOENT'
    throw e
  }
  rmSync(target, { recursive: true, force: true })
  return { name: safe }
}
