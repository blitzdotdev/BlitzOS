// blitzscript example — naming-tournament.mjs
//
// A real BlitzOS user request, run as a blitzscript workflow:
//   "Read plans/blitzos-blitzscript.md. I need a better name than 'workflows'.
//    Brainstorm a bunch of options and run a tournament to pick the top 3."
//
// This is what an orchestrator agent (orchestrators toggle ON) would AUTHOR and then
// `blitz run`. It is PLAIN NODE — fs, Promise.all, string ops — and the ONLY injected
// abstraction is llm() (each call shells out to a real local `claude -p` leaf on the
// user's own auth; see plans/blitzos-blitzscript.md and src/main/blitzscript/llm.mjs).
//
// RLM shape: the doc is "data on disk" (a VARIABLE), the model never reads it whole-cloth
// in one mega-prompt; instead code fans the doc out to a few cheap leaves to brainstorm,
// dedups + scores in CODE, and only uses llm() for the JUDGMENTS. Aggregation (tallying
// scores, picking the bracket winners) is plain JS — exactly the part a single summarizer
// fumbles.
//
// Cost discipline (the plan's guardrails): cheap/fast leaves only (claude --model haiku),
// llm()'s internal semaphore bounds the fan-out, and the whole run is HARD-CAPPED at
// <= 8 llm() calls (3 brainstorm + up to 4 judges + 1 final rationale).

import { llm, _stats } from '../llm.mjs'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── locate + read the doc (RLM "data on disk") ──────────────────────────────────────────────────
// The user named the doc relative to the repo root. BLITZ_WS is the workspace root the runner
// sets; fall back to walking up from this file to the repo root so the example runs standalone too.
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.BLITZ_WS || resolve(__dirname, '../../../..') // …/blitzscript/examples -> repo root
const DOC_PATH = resolve(REPO_ROOT, 'plans/blitzos-blitzscript.md')

let doc
try {
  doc = readFileSync(DOC_PATH, 'utf8')
} catch (e) {
  console.error(`could not read ${DOC_PATH}: ${e.message}`)
  process.exit(1)
}

// The doc is small enough to hand a leaf whole; a bigger source would be chunked here. We trim to a
// generous slice so the cheap leaves stay fast and cheap (the plan: few large leaves, not many tiny).
const DOC_SLICE = doc.slice(0, 9000)

// The single concept under naming: the doc's "workflows" (orchestrators toggle) — agent-authored
// JS scripts an agent writes and runs on the user's own machine, where llm() recursively calls more
// local agents over chunked data. We pass this framing to every leaf so the names target the RIGHT thing.
const CONTEXT = [
  'CONCEPT TO NAME (currently called "workflows" in BlitzOS, and the user wants a better name):',
  'An agent-authored JS program the agent writes and then runs on the user\'s own machine to do a real',
  'task. It is plain Node with ONE special call, llm(), which spawns more local AI agents over chunked',
  'data and aggregates their answers in code (Recursive Language Models on your own filesystem, no',
  'sandbox). "workflows" is bland/overloaded (n8n, CI, Temporal all use it). We want a name for THIS.',
].join('\n')

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const CHEAP = { harness: 'claude', model: 'haiku' } // cheap/fast leaf per the plan's strong-root/cheap-leaf split

// Representative dry-run FALLBACKS (the llm() 3rd arg) so `blitz check` exercises the real parsing +
// tournament for FREE (no spawns). Each mimics the exact leaf output format the parsers expect.
const FB_BRAINSTORM = ['Cascade - work flows down through agent stages', 'Weave - interleaves parallel sub-agents', 'Conjure - summons a bespoke harness on demand', 'Forge - builds a program then runs it', 'Relay - passes data between leaf agents'].join('\n')
const FB_JUDGE = ['Cascade: 8', 'Weave: 7', 'Conjure: 9', 'Forge: 6', 'Relay: 5'].join('\n')
const FB_FINAL = ['Conjure - short and evocative, signals a bespoke harness', 'Cascade - staged flow without the workflow baggage', 'Weave - interlacing parallel agents, distinct from CI jobs', 'Forge - build then run in one word', 'Relay - passes data between leaves'].join('\n')

// Pull bare candidate names out of a leaf's free-text. Leaves are told to emit one "Name — why" per
// line; we parse the leading token before the dash. Robust to bullets/numbering/quotes/backticks.
function parseCandidates(text) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    line = line.replace(/^[-*\d.)\]\s]+/, '') // strip bullets / "1)" / "1." / leading junk
    // take the part before the first dash/colon separator (the NAME), drop the rationale
    const m = line.split(/\s+[—\-:]\s+|\s+[—-]\s+|:\s+/)[0]
    let name = (m || '').replace(/^["'`*]+|["'`*]+$/g, '').trim()
    if (!name) continue
    // a plausible product name: 1-3 words, letters/digits/.+, not a sentence
    if (name.split(/\s+/).length > 3) continue
    if (name.length < 2 || name.length > 28) continue
    if (!/[A-Za-z]/.test(name)) continue
    out.push(name)
  }
  return out
}

// Case-insensitive dedup that keeps the first-seen surface form.
function dedup(names) {
  const seen = new Map()
  for (const n of names) {
    const k = n.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (k && !seen.has(k)) seen.set(k, n)
  }
  return [...seen.values()]
}

// Parse one judge's scores. We ask the judge for strict "Name: <score 1-10>" lines and map them back
// onto OUR candidate list (so a judge can't smuggle in new names or skip the schema).
function parseScores(text, candidates) {
  const byKey = new Map(candidates.map((c) => [c.toLowerCase().replace(/[^a-z0-9]/g, ''), c]))
  const scores = new Map()
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^[\s\-*\d.)\]]*["'`]?(.+?)["'`]?\s*[:=]\s*(\d{1,2})(?:\s*\/\s*10)?\b/)
    if (!m) continue
    const key = m[1].toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!byKey.has(key)) continue
    const val = Math.max(1, Math.min(10, parseInt(m[2], 10)))
    scores.set(byKey.get(key), val)
  }
  return scores
}

// ── 1) BRAINSTORM: fan out 3 parallel cheap leaves ───────────────────────────────────────────────
// Each leaf reads the (sliced) doc + the concept framing and proposes ~5 names from a different
// ANGLE, so we get spread instead of three near-identical lists. Aggregation/dedup is in code.
const ANGLES = [
  'Angle: evocative / metaphorical (a vivid one-word noun that captures "an agent writing & running its own program over your data").',
  'Angle: technical / precise (names that nod to recursion, scripts, local agents, or RLM — credible to an engineer).',
  'Angle: short, brandable, friendly (a verb or playful noun a non-technical user would happily say out loud).',
]

const brainstormPrompts = ANGLES.map((angle) => [
  'You are naming a software concept for BlitzOS. Here is the concept and a slice of the design doc.',
  '',
  CONTEXT,
  '',
  angle,
  '',
  'DESIGN DOC (excerpt):',
  '"""',
  DOC_SLICE,
  '"""',
  '',
  'Propose EXACTLY 5 candidate names for this concept. One per line, formatted strictly as:',
  'Name — a 4-8 word reason it fits',
  'Rules: each Name is 1-2 words, no numbering, no preamble, no closing remarks. Just the 5 lines.',
].join('\n'))

console.error(`[naming-tournament] read ${DOC_PATH} (${doc.length} chars); fanning out ${brainstormPrompts.length} brainstorm leaves…`)

const brainstormRaw = await Promise.all(brainstormPrompts.map((p) => llm(p, CHEAP, FB_BRAINSTORM)))
const allNames = brainstormRaw.flatMap(parseCandidates)
let candidates = dedup(allNames)

console.error(`[naming-tournament] ${allNames.length} raw names -> ${candidates.length} unique candidates`)
console.error(`[naming-tournament] candidates: ${candidates.join(', ')}`)

if (candidates.length < 3) {
  console.error('[naming-tournament] fewer than 3 candidates parsed from the leaves; aborting (need a real pool).')
  process.exit(1)
}

// Keep the pool ~12 (the user asked for "a bunch", and judges score better over a focused list).
candidates = candidates.slice(0, 12)

// ── 2) TOURNAMENT: a few JUDGE leaves score the pool; the bracket/tally is in CODE ────────────────
// We run independent judges with DIFFERENT rubrics, each returning a 1-10 score per candidate. The
// aggregation — averaging across judges, breaking ties — is plain JS (the part an LLM fumbles). This
// is a round-robin "tournament" by aggregate score rather than pairwise byes, which is far more
// llm()-call-efficient (3 judges cover the whole field vs O(n) head-to-head matches).
const RUBRICS = [
  { id: 'memorability', desc: 'MEMORABILITY & SOUND: is it punchy, easy to say, easy to remember, not generic?' },
  { id: 'fit', desc: 'CONCEPT FIT: does it capture "an agent authoring & running its own recursive program over your data"?' },
  { id: 'distinct', desc: 'DISTINCTIVENESS: is it un-overloaded (NOT colliding with n8n/CI/Temporal "workflows", "jobs", "tasks", "scripts")?' },
]

const list = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')

const judgePrompts = RUBRICS.map((r) => [
  `You are judging candidate NAMES for a BlitzOS concept on ONE axis: ${r.desc}`,
  '',
  CONTEXT,
  '',
  'CANDIDATES:',
  list,
  '',
  `Score EVERY candidate from 1 (poor) to 10 (excellent) on the "${r.id}" axis ONLY.`,
  'Output one line per candidate, strictly:  Name: <score>',
  'No commentary, no ties-explanation, just the scored lines for all candidates.',
].join('\n'))

console.error(`[naming-tournament] running ${judgePrompts.length} judge leaves over ${candidates.length} candidates…`)

const judgeRaw = await Promise.all(judgePrompts.map((p) => llm(p, CHEAP, FB_JUDGE)))
const judgeScores = judgeRaw.map((t) => parseScores(t, candidates))

// Tally in CODE: average each candidate's score across the judges that scored it.
const tally = candidates.map((name) => {
  const vals = judgeScores.map((m) => m.get(name)).filter((v) => typeof v === 'number')
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  const per = RUBRICS.map((r, i) => `${r.id}=${judgeScores[i].get(name) ?? '-'}`)
  return { name, avg, votes: vals.length, per }
})

// Sort by average score; tie-break by how many judges scored it (broader agreement wins), then name.
tally.sort((a, b) => b.avg - a.avg || b.votes - a.votes || a.name.localeCompare(b.name))

console.error('[naming-tournament] full ranking:')
for (const t of tally) {
  console.error(`  ${t.avg.toFixed(2)}  ${t.name}  (${t.per.join(', ')})`)
}

const top3 = tally.slice(0, 3)

// ── 3) FINAL: one cheap leaf writes a crisp one-line rationale for the 3 winners ──────────────────
// (Pure presentation over CODE-decided winners — the bracket result is NOT delegated to the LLM.)
let rationale = new Map()
const finalPrompt = [
  'These 3 names WON a scored tournament to rename the BlitzOS "workflows" concept.',
  '',
  CONTEXT,
  '',
  'WINNERS (in rank order):',
  top3.map((t, i) => `${i + 1}. ${t.name}`).join('\n'),
  '',
  'For EACH winner, write ONE punchy line (<= 14 words) on why it is a strong name for this concept.',
  'Output strictly one line per winner:  Name — rationale',
  'No preamble, no numbering, no closing remarks.',
].join('\n')

try {
  const finalText = await llm(finalPrompt, CHEAP, FB_FINAL)
  for (const raw of finalText.split('\n')) {
    const line = raw.replace(/^[-*\d.)\]\s]+/, '').trim()
    if (!line) continue
    const m = line.match(/^["'`]?(.+?)["'`]?\s+[—\-:]\s+(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase().replace(/[^a-z0-9]/g, '')
    rationale.set(key, m[2].trim())
  }
} catch (e) {
  console.error(`[naming-tournament] rationale leaf failed (${e.message}); printing scores only.`)
}

// ── RESULT: stdout IS the deliverable (the runner captures it) ────────────────────────────────────
console.log('')
console.log('Top 3 names to replace "workflows":')
console.log('')
top3.forEach((t, i) => {
  const why = rationale.get(t.name.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
    `won on score (avg ${t.avg.toFixed(1)}/10 across ${t.votes} judges: ${t.per.join(', ')})`
  console.log(`${i + 1}. ${t.name} — ${why}`)
  console.log(`   score: avg ${t.avg.toFixed(2)}/10  [${t.per.join(', ')}]`)
})
console.log('')

const s = _stats()
console.error(`[naming-tournament] done. total llm() calls = ${s.calls} (cap 8); candidates judged = ${candidates.length}`)
