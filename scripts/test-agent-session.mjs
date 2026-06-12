#!/usr/bin/env node
// UNIFORM sessions (the user's 2026-06-12 call): the primary (agent '0') is NOT special — it resumes its
// claude session exactly like every spawned agent, so context PERSISTS across a BlitzOS restart unless the
// USER clears it. (This reverts the earlier "always-fresh primary" that auto-rotated the id every launch.)
// The interview boot-task still launches at reduced effort while the onboarding duty is pending — that's an
// onboarding-speed knob, not a context-clearing difference. Pure: a temp sessionsDir, no spawn.
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
const root = mkdtempSync(join(tmpdir(), 'blitz-session-'))
const sessionsDir = join(root, 'case-file', '.blitzos', 'terminals')
const metaOf = (id) => join(sessionsDir, String(id), 'meta.json')
const seedMeta = (id, m) => {
  mkdirSync(join(sessionsDir, String(id)), { recursive: true })
  writeFileSync(metaOf(id), JSON.stringify(m))
}

// 1) primary '0' with an established meta → RESUMES (same id, --resume) — NOT special, just like spawned
seedMeta('0', { id: '0', kind: 'agent', claudeSessionId: 'PRIMARY-UUID', claudeEstablished: true })
const a = ensureClaudeSessionId(sessionsDir, '0')
const b = ensureClaudeSessionId(sessionsDir, '0')
ok('primary keeps its persisted id (no auto-rotate)', a.claudeSessionId === 'PRIMARY-UUID')
ok('primary stays established (→ resume)', a.established === true)
ok('primary id is STABLE across calls (context persists)', a.claudeSessionId === b.claudeSessionId)
const cmd0 = buildClaudeCommand({ claudeSid: a.claudeSessionId, mode: a.established ? 'resume' : 'create', bootstrapFile: '/x' })
ok('primary command uses --resume (continues its session)', cmd0.includes('--resume PRIMARY-UUID') && !cmd0.includes('--session-id'))

// 2) prepareAgentLaunch surfaces established + a matching id (no meta/command divergence)
const prep = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md' })
ok('prepareAgentLaunch returns established=true for an established primary', prep.established === true)
ok('prepareAgentLaunch command resumes the persisted id', prep.command.includes('--resume PRIMARY-UUID'))
ok('primary with NO duty runs at default effort (no --effort)', !prep.command.includes('--effort'))

// 2b) the interview duty (onboarding-speed knob, NOT a context difference) still caps effort while pending
setBootTaskProvider((id) => (String(id) === '0' ? 'do the onboarding interview' : null))
const prepDuty = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md' })
ok('primary interview launches at reduced effort (--effort low)', prepDuty.command.includes('--effort low'))
ok('primary interview caps thinking budget (MAX_THINKING_TOKENS)', prepDuty.command.includes('MAX_THINKING_TOKENS='))
setBootTaskProvider(null)

// 3) spawned agent '1' behaves IDENTICALLY to the primary — resumes when established
seedMeta('1', { id: '1', kind: 'agent', claudeSessionId: 'SPAWNED-UUID', claudeEstablished: true })
const s = ensureClaudeSessionId(sessionsDir, '1')
ok('spawned agent keeps its persisted id', s.claudeSessionId === 'SPAWNED-UUID')
ok('spawned agent stays established (→ resume)', s.established === true)
const prep1 = prepareAgentLaunch({ sessionsDir, id: '1', url: 'http://127.0.0.1:1/agents.md' })
ok('spawned agent command uses --resume (same as primary)', prep1.command.includes('--resume SPAWNED-UUID'))

// 4) a brand-new agent (no meta) creates fresh, then would resume next time — same for any id
const s2 = ensureClaudeSessionId(sessionsDir, '2')
ok('new agent starts unestablished (create), id assigned', s2.established === false && typeof s2.claudeSessionId === 'string')
const s0new = ensureClaudeSessionId(join(root, 'fresh-ws', '.blitzos', 'terminals'), '0')
ok('new primary (no meta) ALSO just creates fresh once, then persists', s0new.established === false && typeof s0new.claudeSessionId === 'string')

console.log(failed ? `\n${failed} FAILURES` : '\nall green — sessions are uniform (primary == spawned)')
process.exit(failed ? 1 : 0)
