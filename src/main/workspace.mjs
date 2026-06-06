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

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const VERSION = 1

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
    idToPath.set(s.id, rel)
    writeIfChanged(join(dir, rel), c.body)
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
export function readWorkspace(dir) {
  const metaFile = join(dir, '.blitzos', 'workspace.json')
  let ws
  try {
    ws = JSON.parse(readFileSync(metaFile, 'utf8'))
  } catch {
    return null
  }
  if (!ws || !Array.isArray(ws.nodes)) return null

  // z from stack order (back→front); fall back to nodes order.
  const zByIdx = new Map((Array.isArray(ws.stack) ? ws.stack : []).map((id, i) => [id, i + 1]))
  const surfaces = []
  let seq = 1
  for (const n of ws.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.path !== 'string') continue
    let content
    try {
      content = readFileSync(join(dir, n.path), 'utf8')
    } catch {
      continue // missing content file — skip (reconcile handles "missing" in Phase 3)
    }
    const view = n.view && typeof n.view === 'object' ? n.view : {}
    const base = {
      id: n.id,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w: Number(n.w) || 240,
      h: Number(n.h) || 240,
      z: zByIdx.get(n.id) ?? seq,
      ...(n.zoom ? { zoom: Number(n.zoom) } : {})
    }
    seq++
    if (n.kind === 'note') {
      surfaces.push({ ...base, kind: 'native', component: 'note', title: titleFromPath(n.path), props: { text: content, ...(typeof view.color === 'string' ? { color: view.color } : {}) } })
    } else if (n.kind === 'web' || n.kind === 'app') {
      let url = ''
      try {
        url = String(JSON.parse(content).url || '')
      } catch {
        /* malformed .weblink — leave url empty */
      }
      surfaces.push({ ...base, kind: n.kind, url, title: typeof view.lastTitle === 'string' ? view.lastTitle : titleFromPath(n.path), props: {} })
    } else if (n.kind === 'srcdoc') {
      surfaces.push({ ...base, kind: 'srcdoc', html: content, title: titleFromPath(n.path), props: view.props && typeof view.props === 'object' ? view.props : {} })
    }
    // image/file/folder/widget kinds are not materialized in Phase 1/2 — skipped.
  }
  const camera = ws.camera && typeof ws.camera.scale === 'number' ? { x: Number(ws.camera.x) || 0, y: Number(ws.camera.y) || 0, scale: ws.camera.scale } : { x: 0, y: 0, scale: 1 }
  return { surfaces, camera, mode: ws.mode === 'desktop' ? 'desktop' : 'canvas' }
}
