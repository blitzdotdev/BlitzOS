// journal.mjs — BlitzOS memory as a sandboxed virtual filesystem of markdown docs.
//
// Memory is exposed to agents as FS-native verbs (ls/cat/write/append/mkdir/rm/mv/grep)
// over paths, so an agent uses it the way it already uses a filesystem (in-distribution,
// no bespoke API to learn) while the bytes stay OS-owned. The wire is HTTP; the mental
// model is a filesystem. This Electron backend stores files under ~/.blitzos/journal; a
// cloud build swaps this module for a D1/R2-backed one exposing the SAME verbs, so the
// agent never knows or cares where the bytes live.
//
// It is a SANDBOXED filesystem, NOT a shell: every path is confined under one root, and
// shFs() accepts only file commands (no exec, pipes, chaining, or substitution).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, renameSync, statSync, existsSync } from 'fs'
import { join, normalize, dirname } from 'path'
import { homedir } from 'os'

// The agent's sandboxed home (its virtual FS root). The journal lives at journal/ inside
// it; session.json (and its relay token) stays a sibling OUTSIDE the sandbox. Electron =
// ~/.blitzos/fs; a cloud build points this at a per-tenant prefix in D1/R2.
const ROOT = join(homedir(), '.blitzos', 'fs')

// Resolve a virtual path under ROOT; reject any escape (.. or absolute breakout).
function resolvePath(p) {
  const v = normalize(String(p == null ? '' : p)).replace(/^([/\\])+/, '')
  if (v.split(/[/\\]/).some((seg) => seg === '..')) throw new Error('path escapes journal root: ' + p)
  const abs = join(ROOT, v)
  if (abs !== ROOT && !abs.startsWith(ROOT + '/') && !abs.startsWith(ROOT + '\\')) {
    throw new Error('path escapes journal root: ' + p)
  }
  return abs
}

export function ls(p = '') {
  mkdirSync(ROOT, { recursive: true })
  const abs = resolvePath(p)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [{ name: String(p), type: 'file', size: statSync(abs).size }]
  return readdirSync(abs).map((name) => {
    const s = statSync(join(abs, name))
    return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : 0 }
  })
}

export function cat(p) {
  const abs = resolvePath(p)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('no such file: ' + p)
  return readFileSync(abs, 'utf8')
}

export function write(p, content) {
  const abs = resolvePath(p)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, String(content == null ? '' : content))
  return { ok: true, path: String(p) }
}

export function append(p, text) {
  const abs = resolvePath(p)
  mkdirSync(dirname(abs), { recursive: true })
  appendFileSync(abs, String(text == null ? '' : text))
  return { ok: true, path: String(p) }
}

export function mkdir(p) {
  mkdirSync(resolvePath(p), { recursive: true })
  return { ok: true, path: String(p) }
}

export function rm(p) {
  rmSync(resolvePath(p), { recursive: true, force: true })
  return { ok: true, path: String(p) }
}

export function mv(from, to) {
  const a = resolvePath(from)
  mkdirSync(dirname(resolvePath(to)), { recursive: true })
  renameSync(a, resolvePath(to))
  return { ok: true }
}

export function grep(pattern, p = '') {
  const re = new RegExp(pattern, 'i')
  const out = []
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return
    const s = statSync(abs)
    if (s.isFile()) {
      readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line)) out.push({ path: rel, line: i + 1, text: line.slice(0, 200) })
      })
    } else if (s.isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name), rel ? rel + '/' + name : name)
    }
  }
  walk(resolvePath(p), p ? String(p).replace(/^[/\\]+/, '') : '')
  return out.slice(0, 200)
}

/** Structured dispatch used by the HTTP tool handlers on both transports. */
export function fsOp(op, args = {}) {
  switch (op) {
    case 'ls': return { entries: ls(args.path || '') }
    case 'cat': return { content: cat(args.path) }
    case 'write': return write(args.path, args.content)
    case 'append': return append(args.path, args.text)
    case 'mkdir': return mkdir(args.path)
    case 'rm': return rm(args.path)
    case 'mv': return mv(args.from, args.to)
    case 'grep': return { matches: grep(args.pattern, args.path || '') }
    default: throw new Error('unknown fs op: ' + op)
  }
}

function unquote(s) {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/** Parse a single, SAFE file command string (the most in-distribution surface). */
export function shFs(cmd) {
  const s = String(cmd == null ? '' : cmd).trim()
  if (/[|;&`]|\$\(/.test(s)) throw new Error('only simple file commands allowed (no pipes, chaining, or substitution)')
  let m
  if ((m = s.match(/^echo\s+(.+?)\s*(>>?)\s*(\S+)\s*$/))) {
    const text = unquote(m[1]) + '\n'
    return m[2] === '>>' ? append(m[3], text) : write(m[3], text)
  }
  if (/[<>]/.test(s)) throw new Error('unsupported redirect (only: echo TEXT >|>> PATH)')
  const parts = s.split(/\s+/)
  switch (parts[0]) {
    case 'ls': return { entries: ls(parts[1] || '') }
    case 'cat': return { content: cat(parts[1]) }
    case 'grep': return { matches: grep(parts[1], parts[2] || '') }
    case 'mkdir': return mkdir(parts[1])
    case 'rm': return rm(parts[1])
    case 'mv': return mv(parts[1], parts[2])
    default: throw new Error('unsupported command: ' + (parts[0] || '(empty)'))
  }
}
