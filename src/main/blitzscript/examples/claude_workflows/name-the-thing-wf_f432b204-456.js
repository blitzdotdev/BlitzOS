export const meta = {
  name: 'name-the-thing',
  description: 'Brainstorm names to replace "workflows" (the blitzscript RLM capability), then run a seeded single-elimination tournament to pick a ranked top 3',
  phases: [
    { title: 'Generate', detail: '8 diverse naming lenses fan out a candidate pool' },
    { title: 'Score', detail: '3 judges score the whole pool to seed the bracket' },
    { title: 'Quarterfinals', detail: 'top-8 seeds, head-to-head' },
    { title: 'Semifinals', detail: '3-judge panels' },
    { title: 'Final', detail: '5-judge panel for 1st, 3-judge for 3rd place' },
    { title: 'Synthesize', detail: 'write the ranked top 3 report' },
  ],
}

// ---- shared concept brief: every agent names THIS exact thing ----
const BRIEF = `CONCEPT BRIEF — what we are naming.
BlitzOS is "an OS for an agent." We need a name for a new first-class capability that is currently called "workflows" — a placeholder we dislike (too generic; collides with Cloudflare Workflows, GitHub workflows, Temporal, n8n, Airflow).

What it ACTUALLY is: an AI agent AUTHORS A PROGRAM (plain Node/JS) and runs it via \`blitz run prog.mjs\`. The program orchestrates many LLM calls. The one injected primitive is \`llm(prompt, opts)\`, which shells out to a FULL local agent (\`claude -p\` / \`codex exec\`) on the user's own machine and auth. So the program fans out parallel sub-agents (\`Promise.all\` of \`llm()\`), chunks over-window data sitting on "disk", aggregates results in code (exact counts/dedup a summarizer would fumble), and persists state as real files. It is RLM (Recursive Language Models, MIT CSAIL) realized on the user's machine with NO sandbox: the agent writes code that recursively calls language models. A "job" (plan, execute, verify) becomes just ONE such program. The durable artifact is the program plus its memory dir.

We need ONE word/name that works for:
 (a) the UNIT an agent writes — reads well as "write a ___" and "a ___";
 (b) the capability/framework — "the ___ system", a per-agent "___ mode" toggle;
 (c) ideally the CLI verb-ish slot near \`blitz run\`.

VIBE: BlitzOS / blitz.dev brand — lightning, speed, low ceremony, hacker-native, terminal-native; OS/kernel metaphors welcome. The name must beat "workflows" on (1) distinctiveness and (2) evoking the essence: an agent writing a recursive, fan-out LLM-orchestration program.
HARD AVOID (too generic / taken): workflow, job, pipeline, task, script, flow, chain, agent. Prefer 1-3 syllables, easy to say and spell, ideally usable as a verb too.`

const LENSES = [
  { key: 'os-kernel', brief: 'LENS: operating-system / kernel / process metaphor. BlitzOS is an OS; the program is like a process the agent spawns and supervises. Mine: runtime, kernel, process, daemon, spawn, fork, exec, thread, fiber, batch, schedule. Coin compounds or repurpose one cleanly. Stay OUT of pure-magic, pure-music, and lightning territory.' },
  { key: 'recursion', brief: 'LENS: RLM / recursion / divide-and-conquer — the CS essence (a program that recursively calls language models, fans out, maps and reduces). Mine: recurse, fanout, cascade, fractal, branch, mapreduce, swarm, lattice. Capture the recursive-fan-out idea. Avoid OS-kernel and lightning territory.' },
  { key: 'blitz-bolt', brief: 'LENS: the blitz brand — lightning, speed, electricity, high voltage, hacker energy. Mine: bolt, spark, arc, surge, strike, flash, volt, charge, jolt, zap, blitz-compounds. Punchy and fast. Avoid OS-kernel and music territory.' },
  { key: 'craft', brief: 'LENS: craft / making — the agent CRAFTS and forges a program. Mine: forge, loom, weave, smith, foundry, kiln, anvil, mill, lathe, braid. Evoke building something by hand. Avoid lightning and magic territory.' },
  { key: 'ensemble', brief: 'LENS: performance / music / choreography — orchestrating many performers (the parallel leaf-agents). Mine: score, ensemble, chorus, troupe, baton, opus, movement, cadence, refrain, conduct. Evoke directing many voices. Avoid OS-kernel and lightning territory.' },
  { key: 'incant', brief: 'LENS: incantation / ritual / summoning — a written spell that summons many minds to work. Mine: spell, rite, incant, sigil, summon, conjure, glyph, ward, chant, invoke, grimoire. Make it feel like written words that call up power. Keep it tasteful, terminal-native. Avoid craft and music territory.' },
  { key: 'coined', brief: 'LENS: coined / phonotactic — pure brandable invented words, 1-2 syllables, ownable, techy, easy to say and spell. Invent words (they need not be real). Each must still gesture at orchestration/recursion/speed in feel. Avoid obvious real-word repurposing.' },
  { key: 'plainspoken', brief: 'LENS: plain-spoken hacker-native — the honest, descriptive name a developer would actually type in a terminal without a second thought. Short repurposed nouns or tight compounds that feel native next to `blitz run`. Clarity over cleverness. Avoid magic and music territory.' },
]

const GEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'the candidate name, lowercase unless a proper coinage' },
          pitch: { type: 'string', description: 'one tight line: what it evokes + how it reads as "a ___" and `blitz <x>`' },
          kind: { type: 'string', description: 'compound | coined | repurposed' },
          verbs: { type: 'boolean', description: 'does it also work as a verb' },
        },
        required: ['name', 'pitch'],
      },
    },
  },
  required: ['names'],
}

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          distinct: { type: 'number', description: '1-10: distinctiveness, low collision with workflows/jobs/pipelines/Temporal/n8n' },
          fit: { type: 'number', description: '1-10: evokes an agent authoring a recursive fan-out LLM-orchestration program (RLM)' },
          brand: { type: 'number', description: '1-10: fits BlitzOS / blitz.dev hacker-native, OS/lightning voice' },
          ergonomics: { type: 'number', description: '1-10: reads as "a ___", "the ___ system", and `blitz <x>`' },
          sound: { type: 'number', description: '1-10: memorability, easy to say and spell' },
          total: { type: 'number', description: 'sum of the five (max 50)' },
          note: { type: 'string' },
        },
        required: ['name', 'total'],
      },
    },
  },
  required: ['scores'],
}

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    winner: { type: 'string', description: 'EXACTLY one of the two contender name strings, copied verbatim' },
    reason: { type: 'string', description: 'one or two sentences on why it wins this head-to-head' },
    loserMerit: { type: 'string', description: 'the single best thing the loser had going for it' },
  },
  required: ['winner', 'reason'],
}

const norm = (s) => String(s || '').toLowerCase().trim()
const BANNED = new Set(['workflow', 'workflows', 'job', 'jobs', 'pipeline', 'pipelines', 'task', 'tasks', 'script', 'scripts', 'flow', 'flows', 'chain', 'chains', 'agent', 'agents'])

// ---------------- Phase 1: generate ----------------
phase('Generate')
log(`Fanning out ${LENSES.length} naming lenses over the blitzscript / workflows concept`)
const raw = await parallel(LENSES.map((lens) => () =>
  agent(
    `${BRIEF}\n\n${lens.brief}\n\nReturn 9 strong, DISTINCT candidate names through this lens. Each must be a plausible real name for the capability, not a description. No duplicates of the HARD-AVOID list. Favor names that survive being typed in a terminal a hundred times a day.`,
    { label: `gen:${lens.key}`, phase: 'Generate', schema: GEN_SCHEMA }
  )
))

// ---------------- dedupe into one pool ----------------
const pool = []
const seen = new Map()
for (const r of raw.filter(Boolean)) {
  for (const c of (r.names || [])) {
    const n = norm(c.name)
    if (!n || BANNED.has(n) || n.length > 24) continue
    if (seen.has(n)) { seen.get(n).hits++; continue }
    const entry = { name: String(c.name).trim(), pitch: String(c.pitch || '').trim(), kind: c.kind || '', verbs: !!c.verbs, hits: 1 }
    seen.set(n, entry)
    pool.push(entry)
  }
}
log(`Pool: ${pool.length} unique candidates after dedupe (from ${raw.filter(Boolean).length} lenses)`)

const listText = pool.map((c, i) => `${i + 1}. ${c.name} — ${c.pitch}`).join('\n')

// ---------------- Phase 2: score to seed ----------------
phase('Score')
const SCORERS = [
  'You are a skeptical product-naming critic. Punish collisions and vagueness hard.',
  'You are a developer-experience lead. Reward names that read naturally in code, docs, and the terminal.',
  'You are a brand strategist for a hacker-native OS. Reward distinctive, ownable, memorable names that still tell the truth about the concept.',
]
const scoreSets = await parallel(SCORERS.map((persona, i) => () =>
  agent(
    `${BRIEF}\n\n${persona}\n\nScore EVERY candidate below on the five criteria (1-10 each) and give total = their sum (max 50). Be discriminating: spread the scores, do not bunch them. Return the exact name string for each.\n\nCANDIDATES:\n${listText}`,
    { label: `score:${i}`, phase: 'Score', schema: SCORE_SCHEMA }
  )
))

// aggregate mean total + mean per-criterion
const agg = new Map()
for (const c of pool) agg.set(norm(c.name), { c, totals: [], distinct: [], fit: [], brand: [], ergonomics: [], sound: [] })
for (const set of scoreSets.filter(Boolean)) {
  for (const s of (set.scores || [])) {
    const k = norm(s.name)
    if (!agg.has(k)) continue
    const a = agg.get(k)
    if (typeof s.total === 'number') a.totals.push(s.total)
    for (const f of ['distinct', 'fit', 'brand', 'ergonomics', 'sound']) if (typeof s[f] === 'number') a[f].push(s[f])
  }
}
const mean = (xs) => xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0
const ranked = pool
  .map((c) => {
    const a = agg.get(norm(c.name))
    return {
      ...c,
      mean: mean(a.totals),
      crit: { distinct: mean(a.distinct), fit: mean(a.fit), brand: mean(a.brand), ergonomics: mean(a.ergonomics), sound: mean(a.sound) },
      nScores: a.totals.length,
    }
  })
  .sort((x, y) => y.mean - x.mean)

const top10 = ranked.slice(0, 10)
log(`Seeds (by mean score /50): ${top10.slice(0, 8).map((c, i) => `#${i + 1} ${c.name} ${c.mean.toFixed(1)}`).join('  ')}`)

if (ranked.length < 8) {
  log(`Only ${ranked.length} candidates — skipping bracket, returning score ranking.`)
  return { note: 'pool too small for an 8-seed bracket', scoreRanking: top10 }
}

const seeds = ranked.slice(0, 8) // seed 0 = best

// ---------------- match helper: perspective-diverse panel, majority vote ----------------
const JUDGE_LENS = [
  'Weigh DISTINCTIVENESS (no collision with workflows/jobs/pipelines/Temporal/n8n) and CONCEPT-FIT (does it evoke an agent authoring a recursive, fan-out LLM-orchestration program?) above all.',
  'Weigh BRAND-FIT (BlitzOS / blitz.dev hacker-native, OS and lightning voice) and ERGONOMICS (reads as "a ___", "the ___ system", and `blitz <x>`).',
  'Weigh SOUND and MEMORABILITY: which is easier to say, spell, and recall a year from now, and which would you not get sick of typing?',
  'Take a holistic shipping view: which name would you actually put in the product and defend in a design review?',
  'Onboarding test: which name needs less explanation to a new engineer and ages better over five years?',
]
async function match(a, b, panelSize, phaseLabel) {
  const votes = await parallel(Array.from({ length: panelSize }, (_, k) => () =>
    agent(
      `${BRIEF}\n\nHEAD-TO-HEAD. Pick the better NAME for this capability.\nA) "${a.name}" — ${a.pitch}\nB) "${b.name}" — ${b.pitch}\n\n${JUDGE_LENS[k % JUDGE_LENS.length]}\n\nReturn winner as EXACTLY one of these two strings, copied verbatim: "${a.name}" or "${b.name}".`,
      { label: `${phaseLabel}:${a.name}-v-${b.name}#${k}`, phase: phaseLabel, schema: MATCH_SCHEMA }
    )
  ))
  let va = 0, vb = 0
  const reasons = []
  for (const v of votes.filter(Boolean)) {
    const w = norm(v.winner)
    let pick
    if (w === norm(a.name) || w.includes(norm(a.name))) pick = a
    else if (w === norm(b.name) || w.includes(norm(b.name))) pick = b
    else pick = a // unparseable vote defaults to A; rare
    if (pick === a) va++; else vb++
    reasons.push(`${pick.name}: ${v.reason}`)
  }
  const winner = va >= vb ? a : b
  const loser = winner === a ? b : a
  return { winner, loser, tally: `${a.name} ${va} - ${vb} ${b.name}`, reasons }
}

// ---------------- Phase 3: bracket ----------------
phase('Quarterfinals')
log('Quarterfinals: seeds 1v8, 4v5, 2v7, 3v6')
const qf = await parallel([
  () => match(seeds[0], seeds[7], 1, 'Quarterfinals'),
  () => match(seeds[3], seeds[4], 1, 'Quarterfinals'),
  () => match(seeds[1], seeds[6], 1, 'Quarterfinals'),
  () => match(seeds[2], seeds[5], 1, 'Quarterfinals'),
])
const [qf1, qf2, qf3, qf4] = qf
log(`QF: ${qf1.tally} | ${qf2.tally} | ${qf3.tally} | ${qf4.tally}`)

phase('Semifinals')
const sf = await parallel([
  () => match(qf1.winner, qf2.winner, 3, 'Semifinals'),
  () => match(qf3.winner, qf4.winner, 3, 'Semifinals'),
])
const [sf1, sf2] = sf
log(`SF: ${sf1.tally} | ${sf2.tally}`)

phase('Final')
const [final, bronze] = await parallel([
  () => match(sf1.winner, sf2.winner, 5, 'Final'),
  () => match(sf1.loser, sf2.loser, 3, 'Final'),
])
log(`FINAL: ${final.tally}  —  winner ${final.winner.name}`)
log(`3rd-place: ${bronze.tally}  —  bronze ${bronze.winner.name}`)

const first = final.winner
const second = final.loser
const third = bronze.winner

// ---------------- Phase 4: synthesize ----------------
phase('Synthesize')
const bracketStory = [
  `1st: ${first.name} (beat ${second.name} in the final, ${final.tally}). Final reasons: ${final.reasons.join(' | ')}`,
  `2nd: ${second.name} (lost the final). Reached final via SF.`,
  `3rd: ${third.name} (won the 3rd-place match, ${bronze.tally}). Reasons: ${bronze.reasons.join(' | ')}`,
  `Semifinal 1: ${sf1.tally} — ${sf1.reasons.join(' | ')}`,
  `Semifinal 2: ${sf2.tally} — ${sf2.reasons.join(' | ')}`,
].join('\n')
const scoreStory = top10.map((c, i) => `#${i + 1} ${c.name} — mean ${c.mean.toFixed(1)}/50 (distinct ${c.crit.distinct.toFixed(1)}, fit ${c.crit.fit.toFixed(1)}, brand ${c.crit.brand.toFixed(1)}, ergo ${c.crit.ergonomics.toFixed(1)}, sound ${c.crit.sound.toFixed(1)}) — ${c.pitch}`).join('\n')

const report = await agent(
  `${BRIEF}\n\nA naming tournament just ran over ${pool.length} unique candidates. Write the final recommendation for the BlitzOS author.\n\nBRACKET RESULT (decides the ranked top 3):\n${bracketStory}\n\nPANEL SCORE RANKING (independent cross-check, top 10):\n${scoreStory}\n\nWrite a tight markdown report with these sections:\n1. "## Top 3" — the ranked winners (1st=${first.name}, 2nd=${second.name}, 3rd=${third.name}). For EACH: the name as a heading, a one-line pitch, why it fits the RLM / agent-authored-recursive-program concept, how it reads as "a ___" / "the ___ system or mode" / "\`blitz <x>\`", why it beats "workflows", and one honest risk or caveat.\n2. "## Honorable mentions" — 4 to 6 names from the pool that scored well but did not medal, one line each.\n3. "## How it went" — 3 to 5 lines: the bracket path, and explicitly call out any place the bracket winner disagreed with the #1 panel-score name (and which you would actually trust).\n4. "## My pick" — one decisive sentence naming the single name you would ship and why.\n\nSTYLE: terminal-native, concrete, no fluff. CRITICAL: do NOT use em dashes anywhere; use commas, periods, or parentheses instead. Keep it skimmable.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  poolSize: pool.length,
  topThree: [first.name, second.name, third.name],
  bracket: { final: final.tally, bronze: bronze.tally, sf: [sf1.tally, sf2.tally], qf: [qf1.tally, qf2.tally, qf3.tally, qf4.tally] },
  scoreRankingTop10: top10.map((c) => ({ name: c.name, mean: Number(c.mean.toFixed(1)) })),
  report,
}