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
// opts is THIN: { harness?, model?, effort?, cwd?, retries? }. (schema / files / budget are FUTURE per the
// plan.) cwd runs the leaf in a dir (e.g. a git worktree); retries re-attempts a transient leaf failure.
// The spawner is INJECTABLE via _spawn so unit tests never hit a real LLM.
//
// RESUME / memoization: under `blitz run` (BLITZ_MEM_DIR set), each llm() RESULT is journaled by its
// invocation index + a hash of (harness,model,effort,prompt). A re-run over the same mem dir FAST-FORWARDS
// the longest unchanged prefix (cached results, no spawn); a changed/absent call + everything after re-runs.
// A FAILED call is never journaled, so it re-runs on resume.

import { spawn } from 'node:child_process'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

// ── journaling (edge-result memoization for resume) ─────────────────────────────────────────────
// Under `blitz run`, BLITZ_MEM_DIR points at this run's memory dir. Each llm() call is keyed by its
// INVOCATION INDEX (assigned synchronously at call entry, so Promise.all is deterministic) + a hash of
// (harness, model, effort, prompt). On SUCCESS we record {i,hash,result} into <mem>/journal.jsonl. A
// re-run over the SAME mem dir fast-forwards the longest unchanged PREFIX (returns the cached result, no
// spawn); the first changed/absent call and everything after it re-run (positional-prefix invalidation,
// the signed-off keying). A failed call is never recorded, so it re-runs on resume. OFF when no BLITZ_MEM_DIR.
let _jIndex = 0                  // next invocation index this process (sync, deterministic in Promise.all)
let _journal = null              // lazily-loaded: _journal[i] = { hash, result } | undefined
let _divergedAt = Infinity       // first index that diverged from the journal -> it + everything after re-run

const _memDir = () => process.env.BLITZ_MEM_DIR || null
const _journalPath = () => { const d = _memDir(); return d ? join(d, 'journal.jsonl') : null }

function _loadJournal() {
  if (_journal !== null) return
  _journal = []
  const p = _journalPath()
  if (!p || !existsSync(p)) return
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim(); if (!s) continue
      const e = JSON.parse(s)
      if (e && Number.isInteger(e.i) && typeof e.hash === 'string') _journal[e.i] = { hash: e.hash, result: e.result }
    }
  } catch { /* a corrupt journal -> treat as empty (safe: everything re-runs) */ }
}

const _hashCall = (harness, opts, prompt) =>
  createHash('sha256').update(`${harness}\0${opts.model || ''}\0${opts.effort || ''}\0${prompt}`).digest('hex')

// Sync fast-forward decision (at call entry, before any spawn). Returns the cached entry or null; a
// miss/mismatch marks the divergence point so this index + every later one re-run.
function _journalHit(i, hash) {
  if (!_memDir()) return null
  _loadJournal()
  if (i < _divergedAt && _journal[i] && _journal[i].hash === hash) return _journal[i]
  if (i < _divergedAt) _divergedAt = i
  return null
}

// Record a SUCCESSFUL result. Written SYNCHRONOUSLY so it is durable before llm() resolves (an interrupt
// right after a leaf completes still has it journaled). TODO: append-only + compaction for huge fan-outs.
function _journalRecord(i, hash, result) {
  if (!_memDir()) return
  _journal[i] = { hash, result }
  try {
    const lines = []
    for (let k = 0; k < _journal.length; k++) { const e = _journal[k]; if (e) lines.push(JSON.stringify({ i: k, hash: e.hash, result: e.result })) }
    writeFileSync(_journalPath(), lines.length ? lines.join('\n') + '\n' : '')
  } catch { /* best-effort persistence */ }
}

/** Test hook: clear in-process journal/counter state to simulate a fresh process (the journal FILE persists). */
export function _resetJournal() { _jIndex = 0; _journal = null; _divergedAt = Infinity; _calls = 0; _active = 0; _waiters.length = 0 }

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
async function _defaultSpawn(cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      cwd: cwd || undefined,            // opts.cwd — run the leaf in a given dir (e.g. a git worktree)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`blitz llm: failed to spawn ${cmd}: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) return resolve(out)
      // Surface BOTH streams on failure: claude prints its error JSON on stdout (--output-format json)
      // and codex reports an inaccessible-model 400 as a JSONL error event on STDOUT, so stderr alone
      // gives the uninformative "exited 1". Include a trimmed tail of each so callers get the real reason.
      const tail = (s) => { s = String(s).trim(); return s.length > 1200 ? '…' + s.slice(-1200) : s }
      const detail = [err && tail(err), out && tail(out)].filter(Boolean).join('\n')
      reject(new Error(`blitz llm: ${cmd} exited ${code}${detail ? `\n${detail}` : ''}`))
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
 * @param {{harness?:string, model?:string, effort?:string, cwd?:string, retries?:number}} [opts]
 *        harness: 'claude' (default) | 'codex' | 'pi'(stub) | 'opencode'(stub).
 *        model:   harness model alias/name -> --model (claude) / -c model= (codex). FUTURE: schema/files.
 *        effort:  reasoning effort -> --effort (claude) / -c model_reasoning_effort= (codex).
 *        cwd:     run the leaf in this dir (e.g. a git worktree, to isolate parallel mutating leaves).
 *        retries: re-attempt a transient leaf failure this many times before throwing (default 0).
 * @param {*} [fallback]         The value returned INSTEAD of spawning under `blitz check` (BLITZ_DRY_RUN).
 *        ALWAYS pass a representative one so the dry-run exercises real control flow + parsing.
 * @returns {Promise<string>}
 */
export async function llm(prompt, opts = {}, fallback = undefined) {
  if (typeof prompt !== 'string') throw new Error('blitz llm: prompt must be a string')
  const harnessName = opts.harness || 'claude'
  const harness = harnesses[harnessName]
  if (!harness) {
    throw new Error(`blitz llm: unknown harness ${JSON.stringify(harnessName)} (known: ${Object.keys(harnesses).join(', ')})`)
  }

  const depth = leafDepth()
  const fullPrompt = prompt + leafMetadata(depth)

  // build() produces the spawn descriptor; merge the depth env so the child self-labels. It also
  // VALIDATES the flags (e.g. claude effort), so bad opts throw here — in dry-run too.
  const built = harness.build(fullPrompt, opts)
  const childEnv = { ...(built.env || {}), BLITZ_DEPTH: String(depth) }

  // Stable invocation index (sync, so Promise.all is deterministic) — the positional half of the journal key.
  const i = _jIndex++
  _calls++

  // DRY RUN (`blitz check`): return the fallback, no spawn, no journal.
  if (process.env.BLITZ_DRY_RUN) {
    const cap = Number(process.env.BLITZ_DRY_MAX_CALLS || 5000)
    if (_calls > cap) throw new Error(`blitz check: llm() called ${_calls} times (> ${cap}) — likely an unbounded loop`)
    return fallback !== undefined ? fallback : '[blitz dry-run fallback: this llm() call had no 3rd-arg fallback]'
  }

  // RESUME fast-forward: a matching unchanged-prefix journal entry returns its cached result, no spawn.
  const hash = _hashCall(harnessName, opts, fullPrompt)
  const cached = _journalHit(i, hash)
  if (cached) return cached.result

  // SPAWN, retrying a transient failure up to opts.retries. Record ONLY on success, so a failed call is
  // not memoized and re-runs on resume.
  const retries = Math.max(0, Number(opts.retries) || 0)
  await _acquire()
  try {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const stdout = await _spawn(built.cmd, built.args, childEnv, opts.cwd)
        const result = harness.parse(stdout)
        _journalRecord(i, hash, result)
        return result
      } catch (e) { lastErr = e } // retry until attempts exhausted, then rethrow the last error
    }
    throw lastErr
  } finally {
    _release()
  }
}

export default llm
