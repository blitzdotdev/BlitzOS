// blitz check <workflow.mjs> — a tsc-style validator for a blitzscript, BEFORE the agent runs it for
// real (which would spend real claude -p / codex exec calls). It:
//   1. SYNTAX-checks the file with `node --check` (parses, does not execute).
//   2. DRY-RUNS it with BLITZ_DRY_RUN=1 so llm() returns each call's 3rd-arg FALLBACK instead of
//      spawning a real agent — under a wall-clock timeout + an llm()-call cap.
// That surfaces syntax errors, runtime errors (TypeError, bad parsing, etc.), and infinite loops for
// free, and returns a short report to the agent. Analogous to `tsc --noEmit` / `svelte-check`.
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const TIMEOUT_MS = Number(process.env.BLITZ_CHECK_TIMEOUT_MS || 15000)
const MAX_CALLS = Number(process.env.BLITZ_DRY_MAX_CALLS || 5000)

export async function check(workflowPath, args = []) {
  const file = resolve(workflowPath)
  const report = { file, syntax: 'ok', dryRun: 'ok', ok: true, errors: [] }

  // 1) SYNTAX — `node --check` parses the file without executing it.
  const syn = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (syn.status !== 0) {
    report.syntax = 'error'; report.ok = false
    report.errors.push({ phase: 'syntax', message: (syn.stderr || syn.stdout || 'syntax error').trim() })
    return report // can't dry-run a file that won't parse
  }

  // 2) DRY RUN — execute with llm() returning fallbacks, a scratch mem dir, a call cap + a timeout.
  const mem = mkdtempSync(join(tmpdir(), 'blitz-check-'))
  const res = await new Promise((done) => {
    const child = spawn(process.execPath, [file, ...args.map(String)], {
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
  L.push(`  syntax:  ${r.syntax === 'ok' ? 'OK' : 'ERROR'}`)
  const dry = { ok: 'OK (no llm spawned; fallbacks returned)', error: 'RUNTIME ERROR', loop: 'INFINITE LOOP', timeout: 'TIMEOUT (possible infinite loop)' }[r.dryRun] || r.dryRun
  L.push(`  dry-run: ${dry}`)
  for (const e of r.errors) L.push(`    [${e.phase}${e.kind ? ':' + e.kind : ''}] ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
  L.push(r.ok ? 'PASS' : 'FAIL')
  return L.join('\n')
}
