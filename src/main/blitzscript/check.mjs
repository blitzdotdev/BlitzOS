// blitz check <workflow> — a tsc-style validator for a blitzscript, BEFORE the agent runs it for real
// (which would spend real claude -p / codex exec calls). It:
//   1. SYNTAX-checks the file. DUAL-MODE (G3):
//      • Claude-shaped workflow (.js, no imports, top-level return): `node --check` is a FALSE PASS on
//        these (a bare .js is checked permissively as a SCRIPT, so an illegal top-level `return` passes).
//        The authoritative gate is COMPILING the wrapped body — new AsyncFunction(...globals..., body) —
//        in try/catch (this is exactly how the runtime loads it; it throws SyntaxError on a bad body).
//      • Legacy .mjs (import { llm }): real `node --check` (correctly catches `Illegal return statement`).
//   2. DRY-RUNS it with BLITZ_DRY_RUN=1 so agent() returns each call's stub (schema) / 3rd-arg fallback
//      (text) instead of spawning a real agent — under a wall-clock timeout + a dry-run call cap.
// That surfaces syntax errors, runtime errors, and infinite loops for free. Analogous to `tsc --noEmit`.

import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflow, makeWrappedFn } from './runtime.mjs'
import { isClaudeShaped } from './run.mjs'

const TIMEOUT_MS = Number(process.env.BLITZ_CHECK_TIMEOUT_MS || 15000)
const MAX_CALLS = Number(process.env.BLITZ_DRY_MAX_CALLS || 5000)

export async function check(workflowPath, args = []) {
  const file = resolve(workflowPath)
  const claudeShaped = isClaudeShaped(file)
  const report = { file, mode: claudeShaped ? 'workflow' : 'legacy', syntax: 'ok', dryRun: 'ok', ok: true, errors: [] }

  // 1) SYNTAX
  if (claudeShaped) {
    // Compile the WRAPPED body (the same AsyncFunction the runtime loads). Throws SyntaxError on a bad body.
    try {
      const { body } = loadWorkflow(file)
      makeWrappedFn(body)
    } catch (e) {
      report.syntax = 'error'; report.dryRun = 'skipped'; report.ok = false
      report.errors.push({ phase: 'syntax', message: (e && e.message ? e.message : 'syntax error').trim() })
      return report // can't dry-run a body that won't compile
    }
  } else {
    // Legacy module/script: real `node --check` (catches illegal top-level return etc.).
    const syn = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syn.status !== 0) {
      report.syntax = 'error'; report.dryRun = 'skipped'; report.ok = false
      report.errors.push({ phase: 'syntax', message: (syn.stderr || syn.stdout || 'syntax error').trim() })
      return report
    }
  }

  // 2) DRY RUN — execute in a CHILD via the runner so the dual-mode dispatch + env match a real `blitz run`,
  // with agent() returning stubs/fallbacks, a scratch mem dir, a call cap + a timeout.
  const mem = mkdtempSync(join(tmpdir(), 'blitz-check-'))
  const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url))
  const res = await new Promise((done) => {
    const child = spawn(process.execPath, [RUN, 'run', file, ...args.map(String)], {
      env: {
        ...process.env,
        BLITZ_DRY_RUN: '1',
        BLITZ_WS: process.env.BLITZ_WS || process.cwd(),
        BLITZ_MEM_DIR: mem,
        BLITZ_DEPTH: '0',
        BLITZ_DRY_MAX_CALLS: String(MAX_CALLS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = '', timedOut = false
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(t); done({ code, out, err, timedOut }) })
    child.on('error', (e) => { clearTimeout(t); done({ code: 1, out, err: String(e.message), timedOut }) })
  })

  if (res.timedOut) {
    report.dryRun = 'timeout'; report.ok = false
    report.errors.push({ phase: 'dry-run', kind: 'loop', message: `no exit within ${TIMEOUT_MS}ms — possible infinite loop` })
  } else if (res.code !== 0) {
    report.ok = false
    const msg = (res.err || res.out || `exited ${res.code}`).trim()
    const loop = /likely an unbounded loop/.test(msg)
    report.dryRun = loop ? 'loop' : 'error'
    report.errors.push({ phase: 'dry-run', kind: loop ? 'loop' : 'runtime', message: msg })
  }
  return report
}

// The short report the agent reads (like tsc output): pass/fail + the first error.
export function formatCheck(r) {
  const L = [`blitzcheck ${r.file}`]
  const synLabel = r.mode === 'workflow' ? 'syntax (compiled workflow body)' : 'syntax (node --check)'
  L.push(`  ${synLabel}:  ${r.syntax === 'ok' ? 'OK' : 'ERROR'}`)
  const dry = { ok: 'OK (no agent spawned; stubs/fallbacks returned)', error: 'RUNTIME ERROR', loop: 'INFINITE LOOP', timeout: 'TIMEOUT (possible infinite loop)', skipped: 'skipped (syntax failed)' }[r.dryRun] || r.dryRun
  L.push(`  dry-run: ${dry}`)
  for (const e of r.errors) L.push(`    [${e.phase}${e.kind ? ':' + e.kind : ''}] ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
  L.push(r.ok ? 'PASS' : 'FAIL')
  return L.join('\n')
}
