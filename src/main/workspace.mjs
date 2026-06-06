// Workspace serializer — Phase 1 of the workspaces design (agent-os-workspaces.md).
//
// Projects the live desktop (osState pushed by the renderer) onto a workspace FOLDER:
//   <dir>/.blitzos/workspace.json   ← the one layout file: { version, id, kind, camera, mode, stack, nodes[] }
//   <dir>/<content files>           ← everything-is-a-file: note→.md, web/app→.weblink, srcdoc→.html
//
// Phase 1 is WRITE-ONLY: no hydrate, no watch, no reconcile, no deletion. It is purely
// additive (it never removes a file), so it cannot harm the running app — it just lets the
// canvas materialize on disk. Writes are atomic (temp + rename); content files are written
// only when their bytes change (so unchanged notes don't churn mtime/git). BlitzOS owns the
// layout file; content files are the source of truth for content.
//
// Shared module (the control-core.mjs / perception-core.mjs pattern): plain Node, importable
// by the server backend now and Electron main later.

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, sep, extname } from 'node:path'
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
function markWrite(absPath) {
  const now = Date.now()
  recentWrites.set(absPath, now)
  if (recentWrites.size > 400) for (const [k, v] of recentWrites) if (now - v > 3000) recentWrites.delete(k)
}
/** True if BlitzOS wrote this absolute path within the window (so a watch event is its own). */
export function wasSelfWrite(absPath, windowMs = 900) {
  const t = recentWrites.get(resolve(absPath))
  return t != null && Date.now() - t < windowMs
}

// Which surfaces become canvas NODES. The chat + agent-activity native panels are RUNTIME
// (they belong in .blitzos/state/*.jsonl, Phase 4), never nodes. Unknown kinds are skipped.
function nodeKind(s) {
  if (s.kind === 'web') return 'web'
  if (s.kind === 'app') return 'app'
  if (s.kind === 'srcdoc') return 'srcdoc'
  if (s.kind === 'native' && s.component === 'note') return 'note'
  return null
}

function slug(str, fallback) {
  const base = String(str || '')
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
function contentFor(kind, s) {
  switch (kind) {
    case 'note':
      return { ext: 'md', name: slug(s.title, 'note'), body: String(s.props?.text ?? '') }
    case 'web':
    case 'app':
      return { ext: 'weblink', name: slug(hostOf(s.url) || s.title, 'link'), body: JSON.stringify({ url: s.url || '' }, null, 2) + '\n' }
    case 'srcdoc':
      return { ext: 'html', name: slug(s.title, 'panel'), body: String(s.html ?? '') }
    default:
      return null
  }
}

// Per-kind view state for the node entry (small, cosmetic — content lives in the file).
function viewFor(kind, s) {
  if (kind === 'note' && s.props && typeof s.props.color === 'string') return { color: s.props.color }
  if ((kind === 'web' || kind === 'app') && s.title) return { lastTitle: s.title }
  if (kind === 'srcdoc' && s.props && Object.keys(s.props).length) return { props: s.props }
  return {}
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

/**
 * Serialize osState into the workspace folder. Returns a small summary.
 * @param {string} dir absolute path to the workspace folder.
 * @param {object} osState the renderer's last pushed state ({surfaces, camera, mode}).
 */
export function writeWorkspace(dir, osState) {
  const metaDir = join(dir, '.blitzos')
  const metaFile = join(metaDir, 'workspace.json')
  const { idToPath, wsId } = readPrior(metaFile)
  const taken = new Set(idToPath.values())
  const surfaces = Array.isArray(osState?.surfaces) ? osState.surfaces : []

  const nodes = []
  for (const s of surfaces) {
    const kind = nodeKind(s)
    if (!kind) continue
    const c = contentFor(kind, s)
    if (!c) continue
    // stable path: reuse the prior assignment for this id, else mint + dedupe.
    let rel = idToPath.get(s.id)
    if (!rel) rel = uniquePath(c.name, c.ext, taken)
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

  // z-order: node ids back→front by their session z.
  const stack = surfaces
    .filter((s) => nodeKind(s))
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((s) => s.id)
    .filter((id) => nodes.some((n) => n.id === id))

  const cam = osState?.camera
  const camera =
    cam && typeof cam.scale === 'number'
      ? { x: Math.round(cam.x || 0), y: Math.round(cam.y || 0), scale: Math.round(cam.scale * 1000) / 1000 }
      : { x: 0, y: 0, scale: 1 }

  const ws = {
    version: VERSION,
    id: wsId || randomUUID(),
    kind: 'blitzos.workspace',
    camera,
    mode: osState?.mode === 'desktop' ? 'desktop' : 'canvas',
    stack,
    nodes
  }
  atomicWrite(metaFile, JSON.stringify(ws, null, 2) + '\n')
  return { metaFile, nodeCount: nodes.length }
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
 * { surfaces, camera, mode } or null if there is no workspace.json.
 * @param {string} dir absolute path to the workspace folder.
 */
// Reconstruct ONE surface descriptor from a node + its (jail-confined) content file.
// Returns null if the path escapes the workspace or the file is unreadable.
function nodeToSurface(dir, n, z) {
  if (!n || typeof n.id !== 'string' || typeof n.path !== 'string') return null
  const abs = safeJoin(dir, n.path)
  if (!abs) return null // JAIL: a hand-edited workspace.json path can't escape the workspace
  let content
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    return null // missing content file
  }
  const view = n.view && typeof n.view === 'object' ? n.view : {}
  const base = {
    id: n.id,
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    w: Number(n.w) || 240,
    h: Number(n.h) || 240,
    z,
    ...(n.zoom ? { zoom: Number(n.zoom) } : {})
  }
  if (n.kind === 'note') {
    return { ...base, kind: 'native', component: 'note', title: titleFromPath(n.path), props: { text: content, ...(typeof view.color === 'string' ? { color: view.color } : {}) } }
  }
  if (n.kind === 'web' || n.kind === 'app') {
    let url = ''
    try {
      url = String(JSON.parse(content).url || '')
    } catch {
      /* malformed .weblink — leave url empty */
    }
    return { ...base, kind: n.kind, url, title: typeof view.lastTitle === 'string' ? view.lastTitle : titleFromPath(n.path), props: {} }
  }
  if (n.kind === 'srcdoc') {
    return { ...base, kind: 'srcdoc', html: content, title: titleFromPath(n.path), props: view.props && typeof view.props === 'object' ? view.props : {} }
  }
  return null // image/file/folder/widget not materialized yet
}

/**
 * Reconstruct surface descriptors from a workspace folder (inverse of writeWorkspace) —
 * Phase 2 hydrate. Returns { surfaces, camera, mode } or null if there is no workspace.json.
 */
export function readWorkspace(dir) {
  let ws
  try {
    ws = JSON.parse(readFileSync(join(dir, '.blitzos', 'workspace.json'), 'utf8'))
  } catch {
    return null
  }
  if (!ws || !Array.isArray(ws.nodes)) return null
  const zByIdx = new Map((Array.isArray(ws.stack) ? ws.stack : []).map((id, i) => [id, i + 1]))
  const surfaces = []
  let seq = 1
  for (const n of ws.nodes) {
    const s = nodeToSurface(dir, n, zByIdx.get(n?.id) ?? seq)
    seq++
    if (s) surfaces.push(s)
  }
  const camera = ws.camera && typeof ws.camera.scale === 'number' ? { x: Number(ws.camera.x) || 0, y: Number(ws.camera.y) || 0, scale: ws.camera.scale } : { x: 0, y: 0, scale: 1 }
  return { surfaces, camera, mode: ws.mode === 'desktop' ? 'desktop' : 'canvas' }
}

// Which loose root files auto-surface as new nodes on reconcile, and as what kind. Conservative
// in Phase 3: only the unambiguous text/invented kinds — a dropped binary, .html, image, or
// folder is left alone (the spec's passive-file/bundle handling isn't built yet). Dotfiles,
// the .blitzos dir, and temp files never surface.
function autoKind(name) {
  if (name.startsWith('.') || /\.tmp(-[0-9a-f]+)?$/.test(name)) return null
  const ext = extname(name).toLowerCase()
  if (ext === '.weblink') return 'web'
  if (ext === '.md') return 'note'
  return null
}
function defaultSizeFor(kind) {
  return kind === 'note' ? { w: 240, h: 240 } : { w: 920, h: 640 }
}

/**
 * Reconcile the canvas with the folder on disk (Phase 3). Idempotent re-scan: reads the nodes
 * (fresh content), auto-places NEW loose .md/.weblink files, heals a single unambiguous rename,
 * drops nodes whose file vanished, and writes back workspace.json only if the node set changed.
 * Returns { surfaces, camera, mode, changed } or null if there is no workspace.json.
 * @param {string} dir workspace folder
 * @param {{cx?:number, cy?:number}} [placeAt] world-space center to cascade new nodes around
 */
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

  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    /* unreadable workspace dir */
  }
  const newFiles = entries.filter((e) => e.isFile() && autoKind(e.name) && !known.has(e.name) && safeJoin(dir, e.name)).map((e) => e.name)

  let changed = false
  // single-rename heal: a node's file is gone AND exactly one NEW file of the same kind exists.
  const usedNew = new Set()
  for (const n of nodes) {
    const abs = safeJoin(dir, n.path)
    if (abs && existsSync(abs)) continue
    const cand = newFiles.filter((f) => !usedNew.has(f) && (autoKind(f) === n.kind || (n.kind === 'app' && autoKind(f) === 'web')))
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

  const stackPrev = Array.isArray(ws.stack) ? ws.stack : []
  const zByIdx = new Map(stackPrev.map((id, idx) => [id, idx + 1]))
  let seq = stackPrev.length + 1
  const surfaces = []
  for (const n of alive) {
    const s = nodeToSurface(dir, n, zByIdx.get(n.id) ?? seq++)
    if (s) surfaces.push(s)
  }
  const camera = ws.camera && typeof ws.camera.scale === 'number' ? { x: Number(ws.camera.x) || 0, y: Number(ws.camera.y) || 0, scale: ws.camera.scale } : { x: 0, y: 0, scale: 1 }
  const mode = ws.mode === 'desktop' ? 'desktop' : 'canvas'

  if (changed) {
    const out = { version: VERSION, id: typeof ws.id === 'string' ? ws.id : randomUUID(), kind: 'blitzos.workspace', camera, mode, stack: surfaces.map((s) => s.id), nodes: alive }
    atomicWrite(metaFile, JSON.stringify(out, null, 2) + '\n')
  }
  return { surfaces, camera, mode, changed }
}
