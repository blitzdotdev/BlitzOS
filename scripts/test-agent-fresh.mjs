#!/usr/bin/env node
// Always-fresh primary (the user's 2026-06-12 call): agent '0' mints a NEW claude session id every
// launch (--session-id create, empty context — never trips the cyber classifier), recovering
// continuity from chat.md. Spawned agents ('1'+) keep --resume. Pure: a temp sessionsDir, no spawn.
import { ensureClaudeSessionId, prepareAgentLaunch, buildClaudeCommand, setBootTaskProvider } from '../src/main/agent-runtime.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}

// a workspace-shaped temp dir: <root>/<ws>/.blitzos/terminals
const root = mkdtempSync(join(tmpdir(), 'blitz-fresh-'))
const sessionsDir = join(root, 'case-file', '.blitzos', 'terminals')
const metaOf = (id) => join(sessionsDir, String(id), 'meta.json')
const seedMeta = (id, m) => {
  mkdirSync(join(sessionsDir, String(id)), { recursive: true })
  writeFileSync(metaOf(id), JSON.stringify(m))
}

// 1) primary '0': fresh + create EVERY call, even with an established meta
seedMeta('0', { id: '0', kind: 'agent', claudeSessionId: 'OLD-PRIMARY-UUID', claudeEstablished: true })
const a = ensureClaudeSessionId(sessionsDir, '0')
const b = ensureClaudeSessionId(sessionsDir, '0')
ok('primary ignores the persisted id', a.claudeSessionId !== 'OLD-PRIMARY-UUID')
ok('primary never established (→ create mode)', a.established === false)
ok('primary rotates a NEW id each call', a.claudeSessionId !== b.claudeSessionId)
const cmd0 = buildClaudeCommand({ claudeSid: a.claudeSessionId, mode: a.established ? 'resume' : 'create', bootstrapFile: '/x' })
ok('primary command uses --session-id, never --resume', cmd0.includes(`--session-id ${a.claudeSessionId}`) && !cmd0.includes('--resume'))

// 2) prepareAgentLaunch surfaces established + a matching id (no meta/command divergence)
const prep = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md' })
ok('prepareAgentLaunch returns established=false for primary', prep.established === false)
ok('prepareAgentLaunch command + id agree', prep.command.includes(`--session-id ${prep.claudeSessionId}`))
ok('primary with NO duty runs at default effort (no --effort)', !prep.command.includes('--effort'))

// 2b) with the interview duty active, the primary launches at reduced effort; spawned agents do not
setBootTaskProvider((id) => (String(id) === '0' ? 'do the onboarding interview' : null))
const prepDuty = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md' })
ok('primary interview launches at reduced effort (--effort low)', prepDuty.command.includes('--effort low'))
ok('primary interview caps thinking budget (MAX_THINKING_TOKENS)', prepDuty.command.includes('MAX_THINKING_TOKENS='))

// 3) spawned agent '1': UNCHANGED — resumes when established
seedMeta('1', { id: '1', kind: 'agent', claudeSessionId: 'SPAWNED-UUID', claudeEstablished: true })
const s = ensureClaudeSessionId(sessionsDir, '1')
ok('spawned agent keeps its persisted id', s.claudeSessionId === 'SPAWNED-UUID')
ok('spawned agent stays established (→ resume)', s.established === true)
const prep1 = prepareAgentLaunch({ sessionsDir, id: '1', url: 'http://127.0.0.1:1/agents.md' })
ok('spawned agent command uses --resume', prep1.command.includes('--resume SPAWNED-UUID'))
ok('spawned agent gets no effort cap (full thinking)', !prep1.command.includes('--effort'))
setBootTaskProvider(null)

// 4) a brand-new spawned agent (no meta) creates fresh, then would resume next time
const s2 = ensureClaudeSessionId(sessionsDir, '2')
ok('new spawned agent starts unestablished (create)', s2.established === false && typeof s2.claudeSessionId === 'string')

console.log(failed ? `\n${failed} FAILURES` : '\nall green')
process.exit(failed ? 1 : 0)
