#!/usr/bin/env node
// blitzscript runner — `blitz run <workflow.mjs>`.
//
// Runs an agent-authored workflow file as plain Node (NO sandbox, full machine access) with the
// three env vars the workflow + llm() rely on, and streams the workflow's stdout straight through
// (its stdout IS the result — RLM's FINAL). There is intentionally NO depth gate here: the leaf is
// TOLD its depth via llm()'s appended metadata; main never refuses recursion (see the plan).
//
//   BLITZ_WS       workspace root      (default: cwd)
//   BLITZ_MEM_DIR  this run's memory   (<ws>/.blitzos/workflows/<id>/, mkdir -p) — RLM "data on disk"
//   BLITZ_DEPTH    0 at the root run   (llm() increments it to 1 on the child env per leaf)

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , sub, ...rest] = process.argv

// The shipped built-in library (verify-job, supervise-tick, …) lives next to this runner.
const BUILTIN_DIR = fileURLToPath(new URL('./library/', import.meta.url))
const LIB_DIRS_MSG = '(looked for a file path, then <ws>/.blitzos/blitzscripts, ~/.blitzos/blitzscripts, and the built-ins)'
// Resolve a workflow ARG to an absolute file: an existing PATH wins; else treat it as a LIBRARY NAME and
// look it up (with/without a .mjs/.js suffix) in the per-workspace lib, the machine-global lib, then the
// shipped built-ins. Returns the absolute path, or null when it is nowhere. So `blitz run verify-job` and
// `blitz run ./my/workflow.mjs` both work, and a built-in can be read as a TEMPLATE the agent adapts.
function resolveWorkflow(arg, ws) {
  const direct = resolve(arg)
  if (existsSync(direct)) return direct
  const name = /\.[mc]?js$/.test(arg) ? arg : `${arg}.mjs`
  for (const d of [join(ws, '.blitzos', 'blitzscripts'), join(homedir(), '.blitzos', 'blitzscripts'), BUILTIN_DIR]) {
    const p = join(d, name)
    if (existsSync(p)) return p
  }
  return null
}

// `blitz capabilities` — probe THIS machine for the harness/model/effort matrix the orchestrator
// agent needs to author llm() calls (which CLIs are installed + their models/effort). See capabilities.mjs.
if (sub === 'capabilities' || sub === 'caps') {
  const { capabilities, formatCapabilities } = await import('./capabilities.mjs')
  const caps = await capabilities()
  // Cache the matrix so llm() can resolve the cheap/strong model ALIASES to THIS machine's picks (the
  // duty tells the agent to prefer `cheap`). Best-effort — llm()'s resolver has a built-in fallback.
  try {
    const capsFile = process.env.BLITZ_CAPS_FILE || join(homedir(), '.blitzos', 'blitz-caps.json')
    mkdirSync(dirname(capsFile), { recursive: true })
    writeFileSync(capsFile, JSON.stringify(caps, null, 2))
  } catch { /* best-effort; the alias resolver falls back without it */ }
  console.log(formatCapabilities(caps))
  process.exit(0)
}

// `blitz check <workflow.mjs>` — tsc-style validation: syntax + a DRY RUN (llm() returns fallbacks,
// no real spawns) catching runtime errors + infinite loops, BEFORE spending real llm calls. See check.mjs.
if (sub === 'check') {
  if (rest.length === 0) { console.error('usage: blitz check <workflow.mjs|name> [args…]'); process.exit(2) }
  const ws = process.env.BLITZ_WS || process.cwd()
  const wf = resolveWorkflow(rest[0], ws)
  if (!wf) { console.error(`blitz check: workflow not found: ${rest[0]} ${LIB_DIRS_MSG}`); process.exit(2) }
  const { check, formatCheck } = await import('./check.mjs')
  const report = await check(wf, rest.slice(1)) // forward any extra args to the dry-run, for representative validation
  console.log(formatCheck(report))
  process.exit(report.ok ? 0 : 1)
}

// `--resume` reuses a STABLE mem dir per workflow so the journal fast-forwards completed llm() calls;
// without it each run gets a fresh timestamped dir. BLITZ_MEM_DIR (if set) overrides either.
const resume = rest.includes('--resume')
const wfArgs = rest.filter((a) => a !== '--resume')
if (sub !== 'run' || wfArgs.length === 0) {
  console.error('usage: blitz run [--resume] <workflow.mjs> [args…]\n       blitz check <workflow.mjs>\n       blitz capabilities')
  process.exit(2)
}

const ws = process.env.BLITZ_WS || process.cwd()
const workflow = resolveWorkflow(wfArgs[0], ws)
if (!workflow) { console.error(`blitz run: workflow not found: ${wfArgs[0]} ${LIB_DIRS_MSG}`); process.exit(2) }
// Mem dir id: --resume -> the stable basename (a re-run reuses the journal); else basename + a short
// timestamp so independent runs don't collide. Greppable/resumable on disk under the workspace.
const base = (wfArgs[0].split('/').pop() || wfArgs[0]).replace(/\.[^.]+$/, '')
const id = resume ? base : `${base}-${Date.now().toString(36)}`
const memDir = process.env.BLITZ_MEM_DIR || join(ws, '.blitzos', 'workflows', id)
mkdirSync(memDir, { recursive: true })

const child = spawn(process.execPath, [workflow, ...wfArgs.slice(1)], {
  stdio: 'inherit', // stream the workflow's stdout/stderr through; its stdout is the result
  env: { ...process.env, BLITZ_WS: ws, BLITZ_MEM_DIR: memDir, BLITZ_DEPTH: '0' },
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
child.on('error', (e) => { console.error(`blitz run: ${e.message}`); process.exit(1) })
