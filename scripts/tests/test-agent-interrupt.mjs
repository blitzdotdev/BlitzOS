// Unit tests for the per-backend "was this agent cut off mid-turn?" seam (agent-interrupt.mjs) + the Claude
// signal reader (agent-transcript.lastAssistantStopReason). Plain node; temp JSONL files, no real backend.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastAssistantStop, lastAssistantStopReason } from '../../src/main/agent-transcript.mjs'
import { wasInterrupted } from '../../src/main/agent-interrupt.mjs'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'blitz-interrupt-'))
const asst = (stop, blocks = [{ type: 'text', text: 'hi' }]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks, stop_reason: stop } })
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const toolUse = [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
function jsonl(name, lines) {
  const p = join(tmp, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

// ---- lastAssistantStopReason (the Claude signal) ----
t('end_turn is read as the last stop_reason', () => {
  assert.equal(lastAssistantStopReason(jsonl('a.jsonl', [user('q'), asst('end_turn')])), 'end_turn')
})
t('lastAssistantStop returns the stop_reason with its file offset', () => {
  const stop = lastAssistantStop(jsonl('a-stop.jsonl', [user('q'), asst('tool_use', toolUse), asst('end_turn')]))
  assert.equal(stop.stopReason, 'end_turn')
  assert.equal(typeof stop.offset, 'number')
  assert.ok(stop.offset > 0)
})
t('tool_use is read as the last stop_reason', () => {
  assert.equal(lastAssistantStopReason(jsonl('b.jsonl', [user('q'), asst('tool_use', toolUse)])), 'tool_use')
})
t('finds the LAST assistant, skipping trailing user/system lines', () => {
  assert.equal(lastAssistantStopReason(jsonl('c.jsonl', [asst('end_turn'), user('next'), JSON.stringify({ type: 'system', subtype: 'hook' })])), 'end_turn')
})
t('a torn/truncated final line is skipped, the prior assistant is used', () => {
  const p = join(tmp, 'd.jsonl')
  writeFileSync(p, asst('tool_use', toolUse) + '\n' + '{"type":"assistant","message":{"content":[{"type":"text",') // killed mid-write
  assert.equal(lastAssistantStopReason(p), 'tool_use')
})
t('no assistant message yet → null', () => {
  assert.equal(lastAssistantStopReason(jsonl('e.jsonl', [user('q')])), null)
})
t('missing file → null', () => {
  assert.equal(lastAssistantStopReason(join(tmp, 'nope.jsonl')), null)
})

// ---- wasInterrupted: codex (exit-code) ----
t('codex exited 0 → clean (false)', () => {
  assert.equal(wasInterrupted({ agentRuntime: 'codex-serverless', status: 'exited', exitCode: 0 }), false)
})
t('codex exited non-zero → interrupted (true)', () => {
  assert.equal(wasInterrupted({ agentRuntime: 'codex-serverless', status: 'exited', exitCode: 137 }), true)
})
t('codex still running (survivor) → leave it (false)', () => {
  assert.equal(wasInterrupted({ agentRuntime: 'codex-serverless', status: 'running', exitCode: null }), false)
})

// ---- wasInterrupted: unknown / not-a-managed-agent ----
t('unknown backend → null (never auto-continue blind)', () => {
  assert.equal(wasInterrupted({ agentRuntime: 'pi-llama-42', status: 'running' }), null)
  assert.equal(wasInterrupted({}), null)
  assert.equal(wasInterrupted(null), null)
})

// ---- wasInterrupted: claude (via the real sessionJsonlPath, redirected with CLAUDE_CONFIG_DIR) ----
process.env.CLAUDE_CONFIG_DIR = tmp
const wsRoot = '/Users/test/ws'
const encoded = wsRoot.replace(/[/.]/g, '-')
const projDir = join(tmp, 'projects', encoded)
mkdirSync(projDir, { recursive: true })
const sidFile = (sid) => join(projDir, sid + '.jsonl')

t('claude mid-tool-use → interrupted (true)', () => {
  writeFileSync(sidFile('s-busy'), asst('tool_use', toolUse) + '\n')
  assert.equal(wasInterrupted({ agentRuntime: 'claude', claudeSessionId: 's-busy' }, { wsRoot }), true)
})
t('claude clean end_turn → not interrupted (false)', () => {
  writeFileSync(sidFile('s-idle'), user('q') + '\n' + asst('end_turn') + '\n')
  assert.equal(wasInterrupted({ agentRuntime: 'claude', claudeSessionId: 's-idle' }, { wsRoot }), false)
})
t('backend resolves to claude from claudeSessionId when agentRuntime is absent', () => {
  writeFileSync(sidFile('s-implicit'), asst('tool_use', toolUse) + '\n')
  assert.equal(wasInterrupted({ claudeSessionId: 's-implicit' }, { wsRoot }), true)
})
t('claude with no transcript → false (nothing to resume)', () => {
  assert.equal(wasInterrupted({ agentRuntime: 'claude', claudeSessionId: 's-never-ran' }, { wsRoot }), false)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed`)
