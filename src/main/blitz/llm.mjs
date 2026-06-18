// blitzscript — llm(): the ONE abstraction a workflow imports.
//
//   import { llm } from '.../blitz/llm.mjs'
//   const text = await llm('summarize this slice…', { harness: 'claude', model: 'haiku' })
//
// A workflow is otherwise plain Node (fs, Promise.all, strings); llm() is the single chokepoint
// the runtime owns. It SPAWNS a local headless agent (claude -p / codex exec — see harnesses.mjs)
// on this machine, captures its stdout, and returns the final assistant text as a string.
//
// Two guardrails live here (cost/recursion, NOT security — see plans/blitzos-blitzscript.md):
//   1. Depth is TOLD to the leaf, not gated. We APPEND a metadata block to the prompt stating the
//      leaf's depth, the no-recurse rule, and the act-vs-ask boundary, and set BLITZ_DEPTH on the
//      child env (propagation/labeling only). main does NOT refuse recursion; we observe instead.
//   2. Concurrency is self-capped by an internal async semaphore, so even a 200-wide Promise.all of
//      llm() calls never spawns more than ~cores-2 heavy agent processes at once.
//
// opts is THIN: { harness?, model?, effort? }. (maxTokens / schema / files / budget are FUTURE per
// the plan, not implemented now.) The spawner is INJECTABLE via _spawn so unit tests never hit a
// real LLM.

import { spawn } from 'node:child_process'
import os from 'node:os'
import { harnesses } from './harnesses.mjs'

// ── concurrency cap ───────────────────────────────────────────────────────────────────────────
// Each leaf is a heavy PROCESS (model/config startup costs seconds), not an API call, so a wide
// fan-out must be bounded on the RESOURCE. Default ~cores-2, floor 2.
const MAX_CONCURRENCY = Math.max(2, os.cpus().length - 2)

let _active = 0          // leaves currently running
let _calls = 0           // total llm() calls this process has made (simple counter, observability)
const _waiters = []      // FIFO queue of resolvers waiting for a free slot

function _acquire() {
  if (_active < MAX_CONCURRENCY) { _active++; return Promise.resolve() }
  return new Promise((resolve) => _waiters.push(resolve))
}
function _release() {
  const next = _waiters.shift()
  if (next) next()          // hand the slot straight to the next waiter (keeps _active steady)
  else _active--
}

/** Read-only counters, for tests + self-pacing. */
export function _stats() {
  return { active: _active, calls: _calls, waiting: _waiters.length, maxConcurrency: MAX_CONCURRENCY }
}

// ── the leaf-prompt metadata block (the plan's guardrail #1 + #5) ──────────────────────────────
// Appended to EVERY leaf prompt. The leaf is a capable instruction-follower, so being told its
// depth + the no-recurse rule should suffice (we watch rollouts/process-tree to confirm).
export function leafMetadata(depth) {
  return [
    '',
    '---',
    `[blitzscript runtime metadata — depth ${depth}]`,
    'You are a leaf agent inside a blitzscript workflow. Do NOT recurse: no `blitz run`, no spawning sub-agents. Answer the task directly.',
    'Act-vs-ask boundary: do reversible work on your own; ASK (do not act) before any irreversible outward act (send/post/delete/deploy/pay).',
    'Return a concise, structured result and stop.',
    '---',
  ].join('\n')
}

// The leaf's own depth = the orchestrator's depth + 1. BLITZ_DEPTH defaults to 0 at the root run.
function leafDepth() {
  const d = Number(process.env.BLITZ_DEPTH || 0)
  return (Number.isFinite(d) ? d : 0) + 1
}

// ── the injectable spawner ─────────────────────────────────────────────────────────────────────
// Resolves with the child's stdout string (rejects on spawn error / non-zero exit). Overridable so
// tests can assert what WOULD be spawned without launching a real agent. stdin is 'ignore' so codex
// (which appends piped stdin to the prompt) doesn't absorb the parent's stdin.
async function _defaultSpawn(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`blitz llm: failed to spawn ${cmd}: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`blitz llm: ${cmd} exited ${code}${err ? `\n${err.trim()}` : ''}`))
    })
  })
}

// Override point for tests. `_spawn(cmd, args, env) -> Promise<stdout string>`.
export let _spawn = _defaultSpawn
export function _setSpawn(fn) { _spawn = fn || _defaultSpawn }

/**
 * Run one leaf agent and return its final assistant text.
 *
 * @param {string} prompt       The task for the leaf (metadata is appended automatically).
 * @param {{harness?:string, model?:string, effort?:string}} [opts]
 *        harness: 'claude' (default) | 'codex' | 'pi'(stub) | 'opencode'(stub).
 *        model:   harness model alias/name -> --model (claude) / -c model= (codex). FUTURE: maxTokens/schema/files.
 *        effort:  reasoning effort -> --effort (claude) / -c model_reasoning_effort= (codex).
 * @returns {Promise<string>}
 */
export async function llm(prompt, opts = {}) {
  if (typeof prompt !== 'string') throw new Error('blitz llm: prompt must be a string')
  const harnessName = opts.harness || 'claude'
  const harness = harnesses[harnessName]
  if (!harness) {
    throw new Error(`blitz llm: unknown harness ${JSON.stringify(harnessName)} (known: ${Object.keys(harnesses).join(', ')})`)
  }

  const depth = leafDepth()
  const fullPrompt = prompt + leafMetadata(depth)

  // build() produces the spawn descriptor; merge the depth env so the child self-labels.
  const built = harness.build(fullPrompt, opts)
  const childEnv = { ...(built.env || {}), BLITZ_DEPTH: String(depth) }

  _calls++
  await _acquire()
  try {
    const stdout = await _spawn(built.cmd, built.args, childEnv)
    return harness.parse(stdout)
  } finally {
    _release()
  }
}

export default llm
