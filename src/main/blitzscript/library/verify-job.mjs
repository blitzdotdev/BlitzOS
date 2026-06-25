#!/usr/bin/env node
// blitzscript BUILT-IN — verify-job: an INDEPENDENT LLM verifier that a worker agent TRULY finished its work.
//
//   blitz run verify-job <workerAgentId> [criteriaTextOrFile]
//   blitz check verify-job                      # dry-run validates the whole pipeline against fallbacks
//
// This is the original "independent verifier in the loop" realized as ONE blitzscript (plans/
// blitzos-blitzscript.md, user-journey Pass 2 item 1). It is the stronger gate OVER the deterministic
// plan.md Stop hook: a separate model, given the worker's RAW session, decides "did they actually do it".
//
// SHAPE — RLM map-reduce + verify-the-verifier (so it beats a single context window):
//   • gather evidence in CODE: the completion CRITERIA + the worker's raw terminal session.
//   • MAP: chunk the session and verify EACH chunk against the criteria IN PARALLEL (cheap leaves).
//   • REDUCE: a single STRONG meta-leaf reconciles the per-chunk verdicts into a final, skeptical verdict.
// No per-task heuristics live here — the OS gathers evidence; the model judges significance.
//
// Inputs:
//   argv[0]  the worker agent's id. Its session is <ws>/.blitzos/terminals/<id>/transcript.jsonl (raw pty,
//            written for BOTH claude + codex agents), so this is harness-agnostic.
//   argv[1]  the completion CRITERIA: inline text, OR a path to a file (e.g. a goal/spec the orchestrator wrote).
// Output (stdout = the result): STRICT JSON { pass, confidence, reasons[], gaps[] }.

import { llm } from '../llm.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.BLITZ_WS || process.cwd()
const mem = process.env.BLITZ_MEM_DIR || '.'
const DRY = process.env.BLITZ_DRY_RUN === '1'
const CHUNK = Number(process.env.VERIFY_CHUNK || 120000) // chars per session chunk (a chunk ≈ one leaf's read)

const agentId = process.argv[2] || (DRY ? 'dry' : null)
const criteriaArg = process.argv[3] || null
if (!agentId) { console.error('usage: blitz run verify-job <workerAgentId> [criteriaTextOrFile]'); process.exit(2) }

const emit = (v) => { console.log(JSON.stringify(v)); process.exit(0) }

// ── gather the evidence (mechanical, in CODE) ────────────────────────────────────────────────────
// 1) the completion CRITERIA: inline text, or a path to a file (e.g. a goal/spec the orchestrator wrote).
function loadCriteria() {
  if (criteriaArg && existsSync(criteriaArg)) return readFileSync(criteriaArg, 'utf8')
  if (criteriaArg) return criteriaArg
  return ''
}
// 2) the worker's RAW session: read transcript.jsonl ({at,data} per line), concat the pty `data`, strip ANSI.
function loadSession() {
  const tp = join(ws, '.blitzos', 'terminals', agentId, 'transcript.jsonl')
  let raw = ''
  if (existsSync(tp)) for (const line of readFileSync(tp, 'utf8').split('\n')) {
    if (!line) continue
    try { raw += JSON.parse(line).data || '' } catch { /* skip a torn last line */ }
  }
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '') // strip ANSI escapes + CRs (mechanical)
}

let criteria = loadCriteria().trim()
let session = loadSession()
// DRY-RUN self-fixture (blitz check): with no real worker on disk, synthesize a tiny criteria + session so
// the FULL chunk -> verify -> reduce control flow + JSON parsing actually execute against llm() fallbacks.
if (DRY && (!criteria || !session.trim())) {
  criteria = criteria || 'Ship feature X: code written, tests pass, change committed.'
  session = session.trim() ? session : '$ npm test\nPASS  12 passed\n$ git commit -m "feat: X"\n[main abc1234] feat: X\n 2 files changed\n'
}
if (!criteria) emit({ pass: false, confidence: 0, reasons: ['no completion criteria given — pass the criteria as inline text or a file path (argv[1])'], gaps: [] })
if (!session.trim()) emit({ pass: false, confidence: 0, reasons: [`no session transcript for agent ${agentId} at .blitzos/terminals/${agentId}/transcript.jsonl`], gaps: [] })

const chunks = session.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`, 'g')) || []

// ── MAP: verify each chunk independently, in parallel (RLM fan-out; cheap leaves) ─────────────────
const FB_CHUNK = JSON.stringify({ supports: 'unknown', evidence: 'dry-run fallback', against: '' })
const verdicts = await Promise.all(chunks.map((c, i) =>
  llm(
    `You are an INDEPENDENT verifier. A worker agent was asked to satisfy these completion CRITERIA:\n` +
    `<criteria>\n${criteria}\n</criteria>\n\n` +
    `Below is part ${i + 1} of ${chunks.length} of the worker's RAW terminal session. Judge ONLY from evidence you ` +
    `actually see in THIS part — do not assume work happened off-screen. Quote concrete evidence (commands run, ` +
    `files written, tests passing, diffs, outputs). Reply as STRICT JSON ` +
    `{"supports":"yes|partial|no|unknown","evidence":"<quoted facts>","against":"<contradicting facts or empty>"}.\n\n` +
    `<session-part>\n${c}\n</session-part>`,
    { model: 'cheap' }, FB_CHUNK,
  ).then((r) => ({ i, r })),
))
try { writeFileSync(join(mem, 'chunk-verdicts.json'), JSON.stringify(verdicts, null, 2)) } catch { /* best-effort: RLM data-on-disk for --resume */ }

// ── REDUCE + verify-the-verifier: one STRONG meta-leaf reconciles the per-chunk verdicts ──────────
const FB_FINAL = JSON.stringify({ pass: true, confidence: 0.5, reasons: ['dry-run fallback'], gaps: [] })
const final = await llm(
  `You are the META verifier. Reconcile these per-chunk verdicts on whether a worker satisfied the criteria. ` +
  `Be SKEPTICAL: a chunk claiming "yes" with no concrete evidence does NOT pass; any contradicting evidence ` +
  `lowers confidence; partial coverage is not done.\n\n<criteria>\n${criteria}\n</criteria>\n\n` +
  `Per-chunk verdicts (JSON array):\n${JSON.stringify(verdicts.map((v) => v.r))}\n\n` +
  `Reply as STRICT JSON {"pass":true|false,"confidence":0..1,"reasons":["..."],"gaps":["what is missing if not pass"]}.`,
  { model: 'strong' }, FB_FINAL,
)
console.log(typeof final === 'string' ? final.trim() : JSON.stringify(final))
