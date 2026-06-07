// Workspace serializer — the workspaces design (agent-os-workspaces.md), Phases 1–3.
//
// Maps the canvas <-> a workspace FOLDER, both ways:
//   <dir>/.blitzos/workspace.json   ← the one layout file: { version, id, kind, camera, mode, stack, nodes[] }
//   <dir>/<content files>           ← everything-is-a-file: note→.md, web→.weblink, srcdoc→.html
//
//   writeWorkspace()      project the live desktop (osState) onto the folder.
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

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync, realpathSync } from 'node:fs'
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

// Hardening helpers for the read/hydrate path — a workspace.json or content file can be
// hand-edited, corrupt, copied from elsewhere, or malicious; never trust it blindly.
const MAX_CONTENT = 2_000_000 // cap a content file we load whole into memory + ship to renderers
const MAX_META = 1_000_000 // cap workspace.json before reading it whole (a planted giant must not OOM the lister)
function clampScale(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0.2), 3) : 1
}
function safeCamera(c) {
  if (!c || typeof c !== 'object') return { x: 0, y: 0, scale: 1 }
  const x = Number(c.x)
  const y = Number(c.y)
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, scale: clampScale(c.scale) }
}
function safeUrl(u) {
  const s = String(u || '')
  return /^https?:\/\//i.test(s) ? s : '' // never hydrate javascript:/data:/file: into a web surface
}

// Which surfaces become canvas NODES. The chat + agent-activity native panels are RUNTIME
// (they belong in .blitzos/state/*.jsonl, Phase 4), never nodes. Unknown kinds are skipped.
function nodeKind(s) {
  if (s.kind === 'web' || s.kind === 'app') return 'web' // app folds to web (both serialize to a .weblink; no distinct 'app' node kind)
  if (s.kind === 'srcdoc') return 'srcdoc'
  if (s.kind === 'native' && s.component === 'note') return 'note'
  return null
}

// Generated root basenames that must never be reused for a content file.
const RESERVED_ROOT = new Set(['blitzos.md', '.gitignore'])

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

// The content file (extension, desired basename, body bytes) for a node kind. nodeKind folds
// 'app' into 'web', so only note/web/srcdoc reach here.
function contentFor(kind, s) {
  switch (kind) {
    case 'note':
      return { ext: 'md', name: slug(s.title, 'note'), body: String(s.props?.text ?? '') }
    case 'web':
      return { ext: 'weblink', name: slug(hostOf(s.url) || s.title, 'link'), body: JSON.stringify({ url: s.url || '' }, null, 2) + '\n' }
    case 'srcdoc':
      return { ext: 'html', name: slug(s.title, 'panel'), body: String(s.html ?? '') }
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
// file still has a last-good fallback to boot from (spec §3.1).
function writeMeta(metaFile, obj) {
  try {
    if (existsSync(metaFile)) copyFileSync(metaFile, metaFile + '.bak')
  } catch {
    /* best-effort */
  }
  atomicWrite(metaFile, JSON.stringify(obj, null, 2) + '\n')
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
  // Seed `taken` with reserved generated basenames so a content file can never clobber them.
  const taken = new Set([...idToPath.values(), ...RESERVED_ROOT])
  const surfaces = Array.isArray(osState?.surfaces) ? osState.surfaces : []

  const nodes = []
  const order = [] // { id, z } for the stack, built from the SAME kept nodes (no divergent pass)
  const seen = new Set() // dedupe: an agent-reused/duplicate id must not clobber another's file
  for (const s of surfaces) {
    if (!s || typeof s.id !== 'string' || !s.id) continue // never write a node with no/blank id
    if (seen.has(s.id)) continue
    const kind = nodeKind(s)
    if (!kind) continue
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
    order.push({ id: s.id, z: s.z || 0 })
  }

  // Don't materialize an empty workspace.json (or scaffold) for a fresh, empty canvas — only
  // once there's something to persist (or a workspace already exists to keep in sync).
  if (nodes.length === 0 && !existsSync(metaFile)) return { metaFile, nodeCount: 0 }

  // z-order: node ids back→front, from the kept nodes only.
  const stack = order
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((o) => o.id)

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
  writeMeta(metaFile, ws) // atomic + keeps workspace.json.bak
  scaffold(dir) // self-describing BLITZOS.md + .gitignore (once)
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
    return { ...base, kind: 'native', component: 'note', title, props: { text: content, ...(typeof view.color === 'string' ? { color: view.color } : {}) } }
  }
  if (n.kind === 'web' || n.kind === 'app') {
    let url = ''
    try {
      url = safeUrl(JSON.parse(content).url) // scheme-filtered: no javascript:/data:/file:
    } catch {
      /* malformed .weblink — leave url empty */
    }
    return { ...base, kind: n.kind, url, title, props: {} }
  }
  if (n.kind === 'srcdoc') {
    return { ...base, kind: 'srcdoc', html: content, title, props: view.props && typeof view.props === 'object' ? view.props : {} }
  }
  return null // image/file/folder/widget not materialized yet
}

/**
 * Reconstruct surface descriptors from a workspace folder (inverse of writeWorkspace) —
 * Phase 2 hydrate. Returns { surfaces, camera, mode } or null if there is no workspace.json.
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
  const stack = Array.isArray(ws.stack) ? ws.stack : []
  const zByIdx = new Map(stack.map((id, i) => [id, i + 1]))
  const surfaces = []
  let seq = stack.length + 1 // seed fallback z ABOVE all stacked nodes (no collision)
  for (const n of ws.nodes) {
    const s = nodeToSurface(dir, n, zByIdx.get(n?.id) ?? seq)
    seq++
    if (s) surfaces.push(s)
  }
  return { surfaces, camera: safeCamera(ws.camera), mode: ws.mode === 'desktop' ? 'desktop' : 'canvas' }
}

// Which loose root files auto-surface as new nodes on reconcile, and as what kind. Conservative
// in Phase 3: only the unambiguous text/invented kinds — a dropped binary, .html, image, or
// folder is left alone (the spec's passive-file/bundle handling isn't built yet). Dotfiles,
// the .blitzos dir, and temp files never surface.
// Well-known workspace meta files that must NEVER auto-surface as canvas nodes.
const META_FILES = new Set(['blitzos.md', '.gitignore'])
function autoKind(name) {
  if (name.startsWith('.') || /\.tmp(-[0-9a-f]+)?$/.test(name) || META_FILES.has(name.toLowerCase())) return null
  const ext = extname(name).toLowerCase()
  if (ext === '.weblink') return 'web'
  if (ext === '.md') return 'note'
  return null
}

const BLITZOS_MD = `# This folder is a BlitzOS workspace

BlitzOS shows this folder as a spatial canvas. Every loose file here is a node you can see and
arrange; edit the files and the canvas updates live. The board IS this folder.

## File kinds
- \`*.md\` — a note (the markdown text is the file).
- \`*.weblink\` — a web window: \`{ "url": "https://…" }\`.
- \`*.html\` — an agent-authored panel.
- a plain folder — a collapsed tile; its contents are NOT on the canvas (good for grouping +
  cloned repos, so a repo is one tile, not thousands of nodes).
- images / other files — a tile.

## Layout
\`.blitzos/workspace.json\` holds the spatial layout: for each node, its \`id\`, file \`path\`,
\`x/y/w/h\`, the z-order in \`stack\`, and the \`camera\`. BlitzOS owns this file — edit a node's
\`x\`/\`y\` to move it, reorder \`stack\` to restack.

## For an agent
Operate this workspace with plain file tools — no API needed:
- new note → write a \`.md\`; open a site → write a \`.weblink\`; move/resize → edit the node in
  \`.blitzos/workspace.json\`; delete → remove the file; group → move files into a subfolder.
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
  const camera = safeCamera(ws.camera)
  const mode = ws.mode === 'desktop' ? 'desktop' : 'canvas'

  if (changed) {
    const out = { version: VERSION, id: typeof ws.id === 'string' ? ws.id : randomUUID(), kind: 'blitzos.workspace', camera, mode, stack: surfaces.map((s) => s.id), nodes: alive }
    writeMeta(metaFile, out) // atomic + keeps workspace.json.bak
  }
  return { surfaces, camera, mode, changed }
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
    out.push({ name: e.name, path: p, nodeCount, updatedAt })
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
