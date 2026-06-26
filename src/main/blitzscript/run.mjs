#!/usr/bin/env node
// blitzscript runner — `blitz run [--resume] <workflow> [argsJSON]`, `blitz check <workflow>`, `blitz capabilities`.
//
// DUAL-MODE (see plans/blitzos-blitzscript-claude-interface.md §9):
//   • Claude-shaped workflow (`export const meta`, NO top-level import/require, a top-level return) →
//     loaded IN-PROCESS by runtime.mjs: the body is wrapped in an AsyncFunction with the globals injected
//     (agent/parallel/pipeline/phase/log/args/budget/workflow), its top-level `return` value IS the
//     result, printed as pretty JSON. A single JSON arg becomes the `args` global.
//   • Legacy script (`import { llm }`, e.g. examples/*.mjs + library/*.mjs) → run as a plain Node child
//     (`spawn(node, [file])`) so it keeps working unchanged with `process.argv` + `console.log` (its
//     stdout IS the result). Zero-break migration.
//
//   BLITZ_WS       workspace root      (default: cwd)
//   BLITZ_MEM_DIR  this run's memory   (<ws>/.blitzos/workflows/<id>/, mkdir -p) — RLM "data on disk"
//   BLITZ_DEPTH    0 at the root run   (agent() increments it on the leaf child env per leaf)
// There is intentionally NO depth gate: the leaf is TOLD its depth via agent()'s appended metadata.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const isMain = (() => { try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false } })()

// The shipped built-in library (verify-job, supervise-tick, …) lives next to this runner.
const BUILTIN_DIR = fileURLToPath(new URL('./library/', import.meta.url))
const LIB_DIRS_MSG = '(looked for a file path, then <ws>/.blitzos/blitzscripts, ~/.blitzos/blitzscripts, and the built-ins)'

// Resolve a workflow ARG to an absolute file: an existing PATH wins; else treat it as a LIBRARY NAME and
// look it up (with/without a .mjs/.js suffix) in the per-workspace lib, the machine-global lib, then the
// shipped built-ins. Returns the absolute path, or null when nowhere. EXPORTED so runtime.mjs's inline
// workflow() can resolve a sub-workflow by name without re-implementing the lookup.
export function resolveWorkflow(arg, ws) {
  const direct = resolve(arg)
  if (existsSync(direct)) return direct
  const dirs = [join(ws, '.blitzos', 'blitzscripts'), join(homedir(), '.blitzos', 'blitzscripts'), BUILTIN_DIR]
  // try the name as given, then with each known extension.
  const names = /\.[mc]?js$/.test(arg) ? [arg] : [`${arg}.js`, `${arg}.mjs`, arg]
  for (const d of dirs) for (const n of names) { const p = join(d, n); if (existsSync(p)) return p }
  return null
}

// Cheap shape detection from the file HEAD: a Claude-shaped workflow has NO top-level import/require AND
// (an `export const meta` OR a top-level `return`). A legacy script imports something (llm) at the top.
// We read only the head (workflows put meta on line 1; legacy scripts import at the top).
function readHead(file, maxBytes = 8192) {
  let fd
  try { fd = openSync(file, 'r'); const b = Buffer.alloc(maxBytes); const n = readSync(fd, b, 0, maxBytes, 0); return b.toString('utf8', 0, n) }
  catch { try { return readFileSync(file, 'utf8').slice(0, maxBytes) } catch { return '' } }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } } }
}
export function isClaudeShaped(file) {
  const head = readHead(file)
  // strip line comments + block comments cheaply so a commented-out import doesn't fool us.
  const code = head.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const hasTopImport = /^\s*import\s/m.test(code) || /^\s*(?:const|let|var)\s+[^=]*=\s*require\s*\(/m.test(code)
  if (hasTopImport) return false // a top-level import (legacy: `import { llm }`) -> the legacy spawn path
  const hasMeta = /^\s*export\s+const\s+meta\s*=/m.test(code) // every corpus workflow has this on line 1
  const hasTopReturn = /^[ \t]*return\b/m.test(code)         // a column-0 (or indented) top-level return
  return hasMeta || hasTopReturn
}

// Parse the single workflow ARG into the `args` global: valid JSON -> the parsed value; else the raw
// string; absent -> undefined.
export function parseArgsJson(rest) {
  if (!rest || rest.length === 0) return undefined
  const raw = rest.length === 1 ? rest[0] : rest.join(' ')
  try { return JSON.parse(raw) } catch { return raw }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const [, , sub, ...rest] = process.argv

  // `blitz capabilities` — probe THIS machine for the harness/model/effort matrix.
  if (sub === 'capabilities' || sub === 'caps') {
    const { capabilities, formatCapabilities } = await import('./capabilities.mjs')
    const caps = await capabilities()
    try {
      const capsFile = process.env.BLITZ_CAPS_FILE || join(homedir(), '.blitzos', 'blitz-caps.json')
      mkdirSync(dirname(capsFile), { recursive: true })
      writeFileSync(capsFile, JSON.stringify(caps, null, 2))
    } catch { /* best-effort; the alias resolver falls back without it */ }
    console.log(formatCapabilities(caps))
    process.exit(0)
  }

  // `blitz check <workflow>` — syntax + dry-run validation BEFORE spending real agent() calls.
  if (sub === 'check') {
    if (rest.length === 0) { console.error('usage: blitz check <workflow.js|name> [argsJSON]'); process.exit(2) }
    const ws = process.env.BLITZ_WS || process.cwd()
    const wf = resolveWorkflow(rest[0], ws)
    if (!wf) { console.error(`blitz check: workflow not found: ${rest[0]} ${LIB_DIRS_MSG}`); process.exit(2) }
    const { check, formatCheck } = await import('./check.mjs')
    const report = await check(wf, rest.slice(1))
    console.log(formatCheck(report))
    process.exit(report.ok ? 0 : 1)
  }

  // `--resume` reuses a STABLE mem dir so the journal fast-forwards completed agent() calls.
  const resume = rest.includes('--resume')
  const wfArgs = rest.filter((a) => a !== '--resume')
  if (sub !== 'run' || wfArgs.length === 0) {
    console.error('usage: blitz run [--resume] <workflow.js> [argsJSON]\n       blitz check <workflow.js>\n       blitz capabilities')
    process.exit(2)
  }

  const ws = process.env.BLITZ_WS || process.cwd()
  const workflow = resolveWorkflow(wfArgs[0], ws)
  if (!workflow) { console.error(`blitz run: workflow not found: ${wfArgs[0]} ${LIB_DIRS_MSG}`); process.exit(2) }

  // Mem dir id: --resume -> the stable basename; else basename + a short timestamp so independent runs
  // don't collide. Greppable/resumable on disk under the workspace.
  const base = (wfArgs[0].split('/').pop() || wfArgs[0]).replace(/\.[^.]+$/, '')
  const id = resume ? base : `${base}-${Date.now().toString(36)}`
  const memDir = process.env.BLITZ_MEM_DIR || join(ws, '.blitzos', 'workflows', id)
  mkdirSync(memDir, { recursive: true })

  if (isClaudeShaped(workflow)) {
    // IN-PROCESS: a FRESH RunContext per run (G4/G6); the body's top-level return value IS the result.
    process.env.BLITZ_WS = ws
    process.env.BLITZ_MEM_DIR = memDir
    process.env.BLITZ_DEPTH = process.env.BLITZ_DEPTH || '0'
    const { runWorkflow } = await import('./runtime.mjs')
    const args = parseArgsJson(wfArgs.slice(1))
    const budget = process.env.BLITZ_BUDGET ? Number(process.env.BLITZ_BUDGET) : null
    try {
      const { result } = await runWorkflow(workflow, { args, memDir, budget, depth: 0 })
      process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n')
      process.exit(0)
    } catch (e) {
      console.error(`blitz run: ${e && e.message ? e.message : e}`)
      process.exit(1)
    }
  }

  // LEGACY: a plain Node child whose stdout is the result (full stdlib incl. Date.now, process.argv).
  const child = spawn(process.execPath, [workflow, ...wfArgs.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, BLITZ_WS: ws, BLITZ_MEM_DIR: memDir, BLITZ_DEPTH: '0' },
  })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
  child.on('error', (e) => { console.error(`blitz run: ${e.message}`); process.exit(1) })
}

if (isMain) main().catch((e) => { console.error(`blitz: ${e && e.message ? e.message : e}`); process.exit(1) })
