#!/usr/bin/env node
// UNIFORM sessions (the user's 2026-06-12 call): the primary (agent '0') is NOT special — it resumes its
// claude session exactly like every spawned agent, so context PERSISTS across a BlitzOS restart unless the
// USER clears it. (This reverts the earlier "always-fresh primary" that auto-rotated the id every launch.)
// Effort is now UNIFORM too: every claude agent runs at RESIDENT_EFFORT (xhigh) — there is no onboarding
// interview anymore, so no low/medium split and no fast-model pin. The codex-serverless peer backend carries
// no effort knob here (medium by default). Pure: a temp sessionsDir.
import { ensureClaudeSessionId, prepareAgentLaunch, buildClaudeCommand, buildCodexServerlessCommand, setBootTaskProvider, RESIDENT_EFFORT } from '../../src/main/agent-runtime.mjs'
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
// Every Claude agent (primary or spawned) runs at RESIDENT_EFFORT (xhigh) so it decides well within the
// act/ask boundary; only EFFORT is raised — the user's own MODEL is kept (no fast-model pin anywhere).
ok(`primary with NO duty runs at RESIDENT effort (--effort ${RESIDENT_EFFORT}), user model kept`, prep.command.includes(`--effort ${RESIDENT_EFFORT}`) && !prep.command.includes('--model '))

// 2b) a standing duty does NOT change the effort/model — it is uniform RESIDENT_EFFORT regardless of the duty.
setBootTaskProvider((id) => (String(id) === '0' ? 'THE RESIDENT INITIATIVE DUTY. propose initiatives' : null))
const prepDuty = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md' })
ok(`a duty still runs at RESIDENT effort (--effort ${RESIDENT_EFFORT}), no model pin`, prepDuty.command.includes(`--effort ${RESIDENT_EFFORT}`) && !prepDuty.command.includes('--effort low') && !prepDuty.command.includes('--model '))
ok('duty launch writes --settings beating global effortLevel', prepDuty.command.includes('--settings') && prepDuty.command.includes(`"effortLevel":"${RESIDENT_EFFORT}"`))
ok('duty launch overrides global CLAUDE_CODE_EFFORT_LEVEL', prepDuty.command.includes(`"CLAUDE_CODE_EFFORT_LEVEL":"${RESIDENT_EFFORT}"`))
setBootTaskProvider(null)

// 3) spawned agent '1' behaves IDENTICALLY to the primary — resumes when established
seedMeta('1', { id: '1', kind: 'agent', claudeSessionId: 'SPAWNED-UUID', claudeEstablished: true })
const s = ensureClaudeSessionId(sessionsDir, '1')
ok('spawned agent keeps its persisted id', s.claudeSessionId === 'SPAWNED-UUID')
ok('spawned agent stays established (→ resume)', s.established === true)
const prep1 = prepareAgentLaunch({ sessionsDir, id: '1', url: 'http://127.0.0.1:1/agents.md' })
ok('spawned agent command uses --resume (same as primary)', prep1.command.includes('--resume SPAWNED-UUID'))
ok(`spawned agent ALSO runs at RESIDENT effort (--effort ${RESIDENT_EFFORT})`, prep1.command.includes(`--effort ${RESIDENT_EFFORT}`) && !prep1.command.includes('--model '))

// 4) a brand-new agent (no meta) creates fresh, then would resume next time — same for any id
const s2 = ensureClaudeSessionId(sessionsDir, '2')
ok('new agent starts unestablished (create), id assigned', s2.established === false && typeof s2.claudeSessionId === 'string')
const s0new = ensureClaudeSessionId(join(root, 'fresh-ws', '.blitzos', 'terminals'), '0')
ok('new primary (no meta) ALSO just creates fresh once, then persists', s0new.established === false && typeof s0new.claudeSessionId === 'string')

// 5) codex-serverless peer backend: same bootstrap/duty seam, no claude session metadata, ignores local config
const codexCmd = buildCodexServerlessCommand({ cmd: 'codex', bootstrapFile: '/x', lowThinking: true })
ok('codex serverless uses `codex exec`', codexCmd.startsWith('codex exec '))
ok('codex serverless applies low reasoning when requested', codexCmd.includes('model_reasoning_effort="low"'))
ok('codex serverless ignores local Codex policy/config', codexCmd.includes('--disable plugins') && codexCmd.includes('--ignore-user-config') && codexCmd.includes('--ignore-rules'))
ok('codex serverless is noninteractive + unsandboxed for the managed agent', codexCmd.includes('--dangerously-bypass-approvals-and-sandbox') && codexCmd.includes('--skip-git-repo-check'))
const codexDefaultCmd = buildCodexServerlessCommand({ cmd: 'codex', bootstrapFile: '/x' })
ok('codex serverless defaults to medium reasoning', codexDefaultCmd.includes('model_reasoning_effort="medium"'))
const prepCodex = prepareAgentLaunch({ sessionsDir, id: '0', url: 'http://127.0.0.1:1/agents.md', runtime: 'codex-serverless', cmd: 'codex' })
ok('codex backend is recorded in launch metadata', prepCodex.agentRuntime === 'codex-serverless')
ok('codex backend mints NO claude session metadata', !prepCodex.claudeSessionId && prepCodex.established === false)
ok('codex backend command uses `codex exec`', prepCodex.command.startsWith('codex exec '))
ok('codex backend carries no effort knob (defaults to medium reasoning)', prepCodex.command.includes('model_reasoning_effort="medium"'))

console.log(failed ? `\n${failed} FAILURES` : '\nall green — uniform sessions (primary == spawned) + uniform RESIDENT effort + codex backend')
process.exit(failed ? 1 : 0)
