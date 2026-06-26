// Regression guard for the agent-status end_turn watcher (workspace-host.mjs scheduleEndTurnWatch).
//
// The bug: after a /say, the agent's next action is launching the background wait.sh poll, whose terminal output
// cancels the 2.5s settle poll that was watching for stop_reason:end_turn (clearPostSaySettle at the terminal path).
// Status then sat on 'working' until the 10s quiet timer — a ~10-12s lag after the agent actually went idle.
//
// The fix: an INDEPENDENT 1s poller, armed on the keep-working /say, that survives that terminal activity (it is NOT
// cleared by clearPostSaySettle) and flips to 'watching' ~1s after end_turn lands. This test reproduces the exact
// say → post-say-terminal → end_turn sequence and asserts the fast flip, plus that it never clobbers a 'waiting'
// question. Run: node scripts/tests/test-agent-status-endturn.mjs
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SID = 'test-session-endturn-0000'
const cfgDir = mkdtempSync(join(tmpdir(), 'aos-claude-cfg-'))
process.env.CLAUDE_CONFIG_DIR = cfgDir // where sessionJsonlPath looks for <encoded-cwd>/<sid>.jsonl

// One assistant record line for the session JSONL. lastAssistantStop keys on type:'assistant' + message.stop_reason.
const assistantLine = (stop, text = '...') =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: stop, content: [{ type: 'text', text }] }, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'

function jsonlPathFor(ws) {
  const encoded = String(ws).replace(/[/.]/g, '-') // matches sessionJsonlPath's cwd encoding
  return join(cfgDir, 'projects', encoded, `${SID}.jsonl`)
}

// A fresh host on a temp root with agent '0' wired as a Claude agent and a session JSONL that starts mid-turn.
function setupHost() {
  const root = mkdtempSync(join(tmpdir(), 'aos-status-'))
  const adapter = { root, initialName: 'Home', getState: () => ({ surfaces: [] }), setState: () => {}, broadcast: () => {}, defaultMode: 'desktop' }
  const h = createWorkspaceHost(adapter)
  const ws = h.activePath()
  mkdirSync(join(ws, '.blitzos', 'terminals', '0'), { recursive: true })
  writeFileSync(
    join(ws, '.blitzos', 'terminals', '0', 'meta.json'),
    JSON.stringify({ id: '0', kind: 'agent', status: 'running', agentRuntime: 'claude', claudeSessionId: SID }, null, 2)
  )
  const jp = jsonlPathFor(ws)
  mkdirSync(dirname(jp), { recursive: true })
  writeFileSync(jp, assistantLine('tool_use', 'starting')) // mid-turn: the user-message baseline anchors here
  return { root, h, jp }
}

console.log('end_turn watcher survives post-say terminal activity and flips to watching ~1s after end_turn:')
{
  const { root, h, jp } = setupHost()
  h.appendChat('user', 'do a long multi-step task', '0') // user turn: baseline = the tool_use offset, status 'working'
  h.noteAgentActivity('0', 'terminal') // real tool work
  h.appendChat('agent', 'On it — working through the steps.', '0') // keep-working /say arms the end_turn watcher
  h.noteAgentActivity('0', 'terminal') // the background wait.sh: cancels the settle poll; the watcher must SURVIVE
  appendFileSync(jp, assistantLine('end_turn', 'all done')) // the turn actually ends

  await sleep(500)
  const mid = h.chatStatusSnapshot()['0']
  ok('still working at +0.5s (nothing flipped it instantly; the 1s watcher has not ticked)', mid === 'working', mid)

  await sleep(1000) // ~+1.5s total: the watcher (1s) has ticked and seen end_turn
  const after = h.chatStatusSnapshot()['0']
  ok('flips to watching within ~1.5s of end_turn (NOT the 10s quiet timer)', after === 'watching', after)

  h.stopWatch?.()
  rmSync(root, { recursive: true, force: true })
}

console.log('\nthe watcher never clobbers a question: a blitz-ui choice stays waiting even after end_turn:')
{
  const { root, h, jp } = setupHost()
  h.appendChat('user', 'help me pick', '0')
  h.noteAgentActivity('0', 'terminal')
  h.appendChat('agent', 'Working on it.', '0') // arms the watcher
  h.noteAgentActivity('0', 'terminal') // watcher survives
  const choice = '```blitz-ui\n{"prompt":"Which option?","options":[{"label":"A"},{"label":"B"}]}\n```'
  h.appendChat('agent', choice, '0') // a question → 'waiting', which must CLEAR the watcher
  appendFileSync(jp, assistantLine('end_turn', 'asked')) // the question turn ends

  await sleep(1500)
  const st = h.chatStatusSnapshot()['0']
  ok("a 'waiting' question is preserved (not overwritten with watching)", st === 'waiting', st)

  h.stopWatch?.()
  rmSync(root, { recursive: true, force: true })
}

rmSync(cfgDir, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
