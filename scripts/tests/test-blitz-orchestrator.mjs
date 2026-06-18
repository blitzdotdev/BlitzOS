// test-blitz-orchestrator.mjs — the orchestrators toggle, end to end (no GUI, no real LLM call).
//
//  (1) orchestratorBootTask() carries the ORCHESTRATOR MODE duty + the absolute blitzscript/llm.mjs import path.
//  (2) writeBlitzShim() lays down an executable `blitz` runner (-> blitzscript/run.mjs) + the orchestrator.md duty doc.
//  (3) the index.ts boot-task provider, REPLICATED here, hands an orchestrators-flagged agent the duty and
//      leaves a plain peer / the primary unchanged.
//  (4) prepareAgentLaunch bakes that duty into the agent's bootstrap.txt; a re-spawn keeps the flag (carry-forward).
//
// HOME + CLAUDE_CONFIG_DIR are redirected to a tmp dir so the launch path never touches the real ~/.claude*.
// Run: node scripts/tests/test-blitz-orchestrator.mjs
import { writeBlitzShim, orchestratorBootTask, setBootTaskProvider, prepareAgentLaunch } from '../../src/main/agent-runtime.mjs'
import { readTerminalMeta, writeTerminalMeta, setTerminalOrchestrators } from '../../src/main/terminal-manager.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (n, c, x) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}`, x !== undefined ? JSON.stringify(x) : '') } }
const metaBase = (id) => ({ id, kind: 'agent', title: id, command: null, cwd: null, status: 'running', pid: null, exitCode: null, autonomy: 'auto', createdAt: 1, endedAt: null, cols: 80, rows: 24 })

// ── (1) the duty string ──────────────────────────────────────────────────────────────────────────────
console.log('orchestratorBootTask():')
{
  const duty = orchestratorBootTask()
  ok('contains "ORCHESTRATOR MODE"', /ORCHESTRATOR MODE/.test(duty))
  ok('teaches the Claude Code workflow style', /Claude Code workflow/.test(duty))
  ok('uses the INJECTED GLOBALS — export const meta + agent() — no import', /INJECTED GLOBALS \(NO imports\)/.test(duty) && /export const meta/.test(duty) && /agent\(prompt/.test(duty), duty.slice(0, 160))
  ok('names parallel/pipeline/phase/log + ends the file with return', /parallel/.test(duty) && /pipeline/.test(duty) && /phase/.test(duty) && /\blog\b/.test(duty) && /return <result>/.test(duty))
  ok('declares NO imports + no longer carries the llm.mjs path', /NO imports/.test(duty) && !/llm\.mjs/.test(duty))
  ok('names the three blitz subcommands (capabilities/check/run)', /capabilities/.test(duty) && /check/.test(duty) && /\brun\b/.test(duty))
}

// ── (2) the runner shim + duty doc ───────────────────────────────────────────────────────────────────
console.log('\nwriteBlitzShim():')
{
  const dir = mkdtempSync(join(tmpdir(), 'blitz-shim-'))
  writeBlitzShim(dir)
  const shim = join(dir, 'blitz')
  ok('writes <dir>/blitz', existsSync(shim))
  ok('blitz shim is executable (mode & 0o111)', existsSync(shim) && (statSync(shim).mode & 0o111) !== 0)
  const body = existsSync(shim) ? readFileSync(shim, 'utf8') : ''
  ok('blitz shim execs run.mjs via node', /exec node/.test(body) && /run\.mjs/.test(body), body)
  ok('copies orchestrator.md (the duty doc)', existsSync(join(dir, 'orchestrator.md')) && /orchestrator duty/i.test(readFileSync(join(dir, 'orchestrator.md'), 'utf8')))
  rmSync(dir, { recursive: true, force: true })
}

// ── (3) the boot-task provider routes by the meta flag (orchestrators > primary > none) ───────────────
console.log('\nboot-task provider routing:')
{
  const ws = mkdtempSync(join(tmpdir(), 'blitz-orch-ws-'))
  const terminals = join(ws, '.blitzos', 'terminals')
  mkdirSync(terminals, { recursive: true })
  writeTerminalMeta(terminals, 'orch', { ...metaBase('orch'), orchestrators: true })
  writeTerminalMeta(terminals, 'peer', metaBase('peer'))
  writeTerminalMeta(terminals, '0', metaBase('0'))
  // the EXACT provider index.ts installs (kept in lock-step; interviewBootTask() stubbed so we need no onboarding):
  const provider = (id) => {
    try { const td = terminals; if (td && readTerminalMeta(td, String(id))?.orchestrators) return orchestratorBootTask() } catch { /* fall through */ }
    return String(id) === '0' ? '__INTERVIEW__' : null
  }
  const duty = orchestratorBootTask()
  ok('orchestrators agent → the orchestrator duty', provider('orch') === duty)
  ok('plain peer → no duty (null)', provider('peer') === null)
  ok('primary 0 (no flag) → falls through (not the orchestrator duty)', provider('0') !== duty)
  rmSync(ws, { recursive: true, force: true })
}

// ── (3b) the LIVE toggle: setTerminalOrchestrators flips the durable flag, flipping the provider's duty ─
console.log('\nlive toggle (setTerminalOrchestrators flips the durable flag):')
{
  const ws = mkdtempSync(join(tmpdir(), 'blitz-orch-flip-'))
  const terminals = join(ws, '.blitzos', 'terminals')
  mkdirSync(terminals, { recursive: true })
  writeTerminalMeta(terminals, '5', metaBase('5'))
  const provider = (id) => { try { if (readTerminalMeta(terminals, String(id))?.orchestrators) return orchestratorBootTask() } catch { /* fall through */ } return null }
  const duty = orchestratorBootTask()
  ok('agent starts WITHOUT the duty', provider('5') === null)
  const on = setTerminalOrchestrators(terminals, '5', true)
  ok('flip ON → { ok, orchestrators:true } + meta flag set', on.ok && on.orchestrators === true && readTerminalMeta(terminals, '5')?.orchestrators === true, on)
  ok('provider now hands the orchestrator duty', provider('5') === duty)
  const off = setTerminalOrchestrators(terminals, '5', false)
  ok('flip OFF → flag cleared (absent, not false)', off.ok && off.orchestrators === false && readTerminalMeta(terminals, '5')?.orchestrators === undefined, { off, meta: readTerminalMeta(terminals, '5') })
  ok('provider falls through again after OFF', provider('5') === null)
  ok('flip on a MISSING agent → { ok:false }', setTerminalOrchestrators(terminals, 'nope', true).ok === false)
  rmSync(ws, { recursive: true, force: true })
}

// ── (4) prepareAgentLaunch bakes the duty into bootstrap.txt + the flag survives re-spawn ─────────────
console.log('\nprepareAgentLaunch bootstrap injection (HOME sandboxed):')
{
  const home = mkdtempSync(join(tmpdir(), 'blitz-orch-home-'))
  const prevHome = process.env.HOME, prevCfg = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  const ws = mkdtempSync(join(tmpdir(), 'blitz-orch-launch-'))
  const sessionsDir = join(ws, '.blitzos', 'terminals')
  mkdirSync(sessionsDir, { recursive: true })
  writeTerminalMeta(sessionsDir, '7', { ...metaBase('7'), orchestrators: true })
  writeTerminalMeta(sessionsDir, '8', metaBase('8'))
  setBootTaskProvider((id) => {
    try { if (readTerminalMeta(sessionsDir, String(id))?.orchestrators) return orchestratorBootTask() } catch { /* fall through */ }
    return null
  })
  prepareAgentLaunch({ sessionsDir, id: '7', url: 'wss://relay.example/x', runtime: 'claude' })
  const boot7 = readFileSync(join(sessionsDir, '7', 'bootstrap.txt'), 'utf8')
  ok('orchestrators agent bootstrap contains "ORCHESTRATOR MODE"', /ORCHESTRATOR MODE/.test(boot7))
  ok('orchestrators agent bootstrap carries the Claude-DSL workflow how-to (export const meta + agent())', /export const meta/.test(boot7) && /agent\(prompt/.test(boot7))
  ok('writeBlitzShim ran during launch (<ws>/.blitzos/blitz exists + executable)', existsSync(join(ws, '.blitzos', 'blitz')) && (statSync(join(ws, '.blitzos', 'blitz')).mode & 0o111) !== 0)
  prepareAgentLaunch({ sessionsDir, id: '8', url: 'wss://relay.example/x', runtime: 'claude' })
  const boot8 = readFileSync(join(sessionsDir, '8', 'bootstrap.txt'), 'utf8')
  ok('plain agent bootstrap has NO orchestrator duty', !/ORCHESTRATOR MODE/.test(boot8))
  setBootTaskProvider(null)
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg
  rmSync(ws, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz orchestrators toggle`)
process.exit(failures === 0 ? 0 : 1)
