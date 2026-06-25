export const meta = {
  name: 'mirror-benchmark',
  description: 'Blind dose-response benchmark: measure how much user-context (none/B/A/A+deep) lifts model "you-ness" across voice/adherence/predict tasks, with a judge panel + objective auto-scoring + active-learning harvest of new bits.',
  phases: [
    { title: 'Setup', detail: 'regen scans, build held-out item bank + ground truth + deep-bits dose' },
    { title: 'Generate', detail: 'each item x 4 doses (blank/B/A/A+deep), isolated agents' },
    { title: 'Judge', detail: 'blind 3-lens panel ranks shuffled dose outputs per item' },
    { title: 'Synthesize', detail: 'dose-response curve + adherence + active-learning questions + report files' }
  ]
}

const SCAN = '/Users/minjunes/superapp/teenybase/agent-os/scripts/onboarding-scan.mjs'

const SETUP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ctxB', 'ctxA', 'deepBits', 'rules', 'items'],
  properties: {
    ctxB: { type: 'string', description: 'full text of /tmp/dose-B.md (Branch B scan)' },
    ctxA: { type: 'string', description: 'full text of /tmp/dose-A.md (Branch A+B scan)' },
    deepBits: { type: 'string', description: 'concentrated signal: verbatim self-authored rules/memory + top ~12 directives + ~10 voice samples' },
    rules: { type: 'array', items: { type: 'string' }, description: 'known hard do-nots (e.g. no em dashes, no plan mode, minimal edits, no hype)' },
    items: {
      type: 'array', description: '12 benchmark tasks (4 voice, 4 adhere, 4 predict)',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'family', 'task', 'reference'],
        properties: {
          id: { type: 'string' },
          family: { type: 'string', enum: ['voice', 'adhere', 'predict'] },
          task: { type: 'string', description: 'the prompt to give a generator (a real situation requiring being this user)' },
          reference: { type: 'string', description: 'ground-truth answer key for judges: held-out real user voice / the explicit rule / the corpus-implied answer + why' }
        }
      }
    }
  }
}

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ranking', 'scores', 'note'],
  properties: {
    ranking: { type: 'array', items: { type: 'string', enum: ['X', 'Y', 'Z', 'W'] }, description: 'labels best->worst for being THIS user' },
    scores: {
      type: 'object', additionalProperties: false, required: ['X', 'Y', 'Z', 'W'],
      properties: { X: { type: 'number' }, Y: { type: 'number' }, Z: { type: 'number' }, W: { type: 'number' } }
    },
    note: { type: 'string', description: 'one line: what separated the best from the slop' }
  }
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reportPath', 'summary'],
  properties: {
    reportPath: { type: 'string' },
    newBitsPath: { type: 'string' },
    summary: { type: 'string', description: '4-6 line plain-text summary of the dose-response result' },
    topQuestions: { type: 'array', items: { type: 'string' } }
  }
}

// ---- Phase 1: setup ----
phase('Setup')
const setup = await agent(
  `You are setting up a PERSONALIZATION DOSE-RESPONSE BENCHMARK for the user (handle: minjunes / "Min"). Goal: measure how much knowing about the user improves a model's ability to BE them.

STEP 1 — regenerate two PURE context docs (the user-context only, NOT the onboarding prompt) via Bash:
  node ${SCAN} --no-fda --out /tmp/dose-B.md     # Branch B (no Full Disk Access)
  node ${SCAN} --out /tmp/dose-A.md              # Branch A+B (FDA is granted on this machine)
Verify both exist and are non-empty. Read /tmp/dose-A.md fully to understand the user.

STEP 2 — ground truth (held-out): via Bash, sample ~15 REAL user utterances from ~/.claude/history.jsonl (the .display field) and ~/.codex/history.jsonl (the .text field) — pick substantive ones (>40 chars, real instructions/opinions), and AVOID any that already appear verbatim in the dose-A.md "Voice samples" section (those must stay held-out). Redact any emails/tokens. These capture the user's true voice/register.

STEP 3 — build an ITEM BANK of exactly 12 tasks, grounded in the user's ACTUAL world (use their real projects/tools/domains from the scan), across 3 families:
  - 4 "voice": realistic situations where the user writes/instructs (e.g. "write the commit message for <a real change in their stack>", "reply to this PR review comment: <plausible>", "draft a one-line Slack update about shipping <their real project>"). reference = the held-out real utterances (the style key) + a 1-line note on their voice (terse, lowercase, zero hype, no em dashes).
  - 4 "adhere": tasks that TEMPT the user's known do-nots so a generic model will violate them (e.g. "write a README intro for <their project>", "write a PR description", "draft a feature announcement", "write release notes") — generic models love em dashes, hype words, emoji, over-engineering. reference = the explicit rules being tested.
  - 4 "predict": a concrete CHOICE/question where the scan implies the user's answer (e.g. "Rust vs Go vs TS for a new memory-safe CLI?", "ship a quick fix now or refactor first?", "which of these 3 should BlitzOS prioritize?", "deploy to prod on a Friday — yes/no?"). reference = the corpus-implied answer + WHY (cite the scan signal).

STEP 4 — extract "deepBits": the user's most concentrated signal as one string — their verbatim self-authored rules/memory (the "Self-authored preferences" section), the top ~12 observed directives, and ~10 voice samples. This is the richest dose.

STEP 5 — list the known hard rules (do-nots) as "rules".

Return JSON per the schema. ctxB/ctxA must be the FULL text of the two dose files.`,
  { schema: SETUP_SCHEMA, label: 'setup', phase: 'Setup' }
)

const items = (setup.items || []).slice(0, 12)
log(`setup: ${items.length} items, ${setup.rules?.length || 0} rules, ctxA=${Math.round((setup.ctxA || '').length / 4)}t, deep=${Math.round((setup.deepBits || '').length / 4)}t`)

const DOSES = [
  { id: 'D0', label: 'blank', ctx: 'You have ZERO information about this user. Do NOT read any files or look anything up about them. Produce the natural, default output.' },
  { id: 'D1', label: 'Branch B', ctx: `Here is everything you know about the user (a local scan of their machine, Branch B):\n\n${setup.ctxB}` },
  { id: 'D2', label: 'Branch A+B', ctx: `Here is everything you know about the user (a richer local scan, Branch A+B):\n\n${setup.ctxA}` },
  { id: 'D3', label: 'A+deep', ctx: `Here is everything you know about the user (richer scan, Branch A+B):\n\n${setup.ctxA}\n\n--- Plus their concentrated, verbatim self-authored signal (honor it EXACTLY) ---\n${setup.deepBits}` }
]

// ---- objective auto-scoring (judge-independent) ----
const HYPE = /\b(unleash|elevate|seamless|robust|cutting-edge|game-?chang|delve|leverage|supercharge|effortless|powerful|revolutioniz|elevate|unlock|empower|harness|transform your|dive in|in today's|fast-paced)\b/gi
function autoViolations(text) {
  const t = String(text || '')
  return {
    emDash: (t.match(/—/g) || []).length,
    emoji: (t.match(/\p{Extended_Pictographic}/gu) || []).length,
    hype: (t.match(HYPE) || []).length,
    chars: t.length
  }
}

// ---- Phase 2+3: generate (4 doses/item) then blind-judge (3 lenses/item), pipelined ----
const PERM = [[0, 1, 2, 3], [2, 0, 3, 1], [1, 3, 0, 2], [3, 2, 1, 0]]
const LABS = ['X', 'Y', 'Z', 'W']
const LENSES = [
  'VOICE/STYLE: does it sound like THIS user (per the reference voice)? Match tone, length, casing, vocabulary. Penalize generic assistant-voice.',
  'VALUES/DECISIONS: would this user endorse it? Does it reflect their priorities and honor their hard rules?',
  'SLOP DETECTION: is it generic — could it be replaced by its prompt with no loss, or be from anyone? Reward specific, "colored" output; punish default-model slop.'
]

const judgedRows = await pipeline(
  items,
  // stage 1: generate at all 4 doses (parallel, isolated)
  async (item) => {
    const outs = await parallel(DOSES.map((d) => () =>
      agent(`${d.ctx}\n\n=== TASK ===\nDo this AS this user. Output ONLY the deliverable itself — no preamble, no explanation, no markdown fences:\n${item.task}`,
        { label: `gen:${item.id}:${d.id}`, phase: 'Generate' })
    ))
    return { item, outputs: DOSES.map((d, i) => ({ dose: d.id, text: outs[i] || '' })) }
  },
  // stage 2: blind 3-lens panel on shuffled outputs
  async (g, _item, idx) => {
    const perm = PERM[idx % 4]
    const shuffled = perm.map((di, pos) => ({ label: LABS[pos], dose: g.outputs[di].dose, text: g.outputs[di].text }))
    const labelToDose = Object.fromEntries(shuffled.map((s) => [s.label, s.dose]))
    const blindBlock = shuffled.map((s) => `### Candidate ${s.label}\n${s.text}`).join('\n\n')
    const verdicts = await parallel(LENSES.map((lens) => () =>
      agent(`You are a BLIND judge in a personalization benchmark. Authorship of the candidates is hidden.

GROUND-TRUTH about the user (the answer key): ${g.item.reference}
The user's known hard rules: ${(setup.rules || []).join(' | ')}
The task they were asked to do: ${g.item.task}

Four candidate outputs:
${blindBlock}

Judge ONLY through this lens: ${lens}
Rank X/Y/Z/W from best->worst at being THIS specific user, and score each 0-100 (100 = unmistakably them; <30 = generic slop). Be harsh: do not reward length or polish, reward being-this-user. Return JSON.`,
        { label: `judge:${g.item.id}`, phase: 'Judge', schema: JUDGE_SCHEMA })
    ))
    return { id: g.item.id, family: g.item.family, task: g.item.task, reference: g.item.reference, outputs: g.outputs, labelToDose, verdicts: verdicts.filter(Boolean) }
  }
)

// ---- deterministic aggregation in JS (un-blind + curve + auto-scores) ----
const rows = judgedRows.filter(Boolean).map((j) => {
  const byDose = {}
  for (const v of j.verdicts) {
    for (const lab of LABS) {
      const dose = j.labelToDose[lab]; const sc = v.scores ? Number(v.scores[lab]) : NaN
      if (!dose || !isFinite(sc)) continue
      ;(byDose[dose] ||= []).push(sc)
    }
  }
  const meanByDose = {}
  for (const d of Object.keys(byDose)) meanByDose[d] = +(byDose[d].reduce((a, b) => a + b, 0) / byDose[d].length).toFixed(1)
  const autoByDose = {}
  for (const o of j.outputs) autoByDose[o.dose] = autoViolations(o.text)
  return { id: j.id, family: j.family, task: j.task, reference: j.reference, meanByDose, autoByDose, outputs: j.outputs }
})

const ALL = ['D0', 'D1', 'D2', 'D3']
const curve = {}
for (const d of ALL) {
  const xs = rows.map((r) => r.meanByDose[d]).filter((n) => typeof n === 'number')
  curve[d] = xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null
}
const adherence = {}
for (const d of ALL) {
  const v = rows.map((r) => r.autoByDose[d]).filter(Boolean)
  adherence[d] = {
    emDash: v.reduce((a, b) => a + b.emDash, 0),
    emoji: v.reduce((a, b) => a + b.emoji, 0),
    hype: v.reduce((a, b) => a + b.hype, 0)
  }
}
log(`curve (you-ness 0-100): D0=${curve.D0} D1=${curve.D1} D2=${curve.D2} D3=${curve.D3}`)
log(`em-dash violations by dose: D0=${adherence.D0.emDash} D1=${adherence.D1.emDash} D2=${adherence.D2.emDash} D3=${adherence.D3.emDash}`)

// ---- Phase 4: synthesize report + active-learning + new bits ----
phase('Synthesize')
const perFamily = {}
for (const fam of ['voice', 'adhere', 'predict']) {
  perFamily[fam] = {}
  for (const d of ALL) {
    const xs = rows.filter((r) => r.family === fam).map((r) => r.meanByDose[d]).filter((n) => typeof n === 'number')
    perFamily[fam][d] = xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null
  }
}
const compact = rows.map((r) => ({
  id: r.id, family: r.family, task: r.task, reference: r.reference,
  scores: r.meanByDose, autoEmDashHype: { D0: r.autoByDose.D0, D2: r.autoByDose.D2 },
  outputs: r.outputs
}))

const report = await agent(
  `You are writing the report for a PERSONALIZATION DOSE-RESPONSE BENCHMARK (the "Mirror" test) for the user Min. It measured how much user-context lifts a model's "you-ness", blind-judged 0-100 across 4 doses: D0=no context, D1=Branch-B scan, D2=Branch-A+B scan, D3=A + concentrated verbatim signal.

OVERALL you-ness curve (mean blind score): ${JSON.stringify(curve)}
Per-family curve: ${JSON.stringify(perFamily)}
Objective rule-violations by dose (lower=better adherence): ${JSON.stringify(adherence)}
Per-item data (scores per dose, auto em-dash/hype counts, and the 4 dose outputs): ${JSON.stringify(compact)}

Do this:
1. Compute marginal lifts: D1-D0, D2-D1, D3-D2 (overall + note where the biggest jump is). State the learning-to-compress reading: each lift = how many usable "bits about Min" that dose added; a flat segment = that dose's data isn't being used.
2. Adherence story: how em-dash/hype/emoji violations drop as dose rises (the visceral proof that bits-about-the-user change the output).
3. Pick the 2 most striking items and quote D0 (slop) vs D2/D3 (them) SIDE BY SIDE so Min can FEEL the gap.
4. Active learning (collect more info): identify the items where the doses BARELY separated or D3 still scored low — those are where the model is blind to Min. Turn them into the 4-6 highest-information questions to ask Min next (each unguessable + behavior-changing).
5. New bits: list concretely inferred-and-confirmed facts about Min this run surfaced (from where high doses won), formatted as PRINCIPAL.md-style lines.

WRITE two files via Bash (use a real timestamp: STAMP=$(date +%Y%m%d-%H%M)):
  (a) /Users/minjunes/superapp/teenybase/agent-os/plans/mirror-benchmark-$STAMP.md — the full report: a dose-response table (overall + per family), the marginal-lift + adherence analysis, the 2 side-by-side examples, the active-learning questions, and a short "how to read this" intro.
  (b) /Users/minjunes/superapp/teenybase/agent-os/plans/mirror-newbits-$STAMP.md — the new PRINCIPAL.md-style bits + the active-learning questions, ready to fold into onboarding.
Both are private/local (the plans/ dir; mirror-* will be gitignored separately). Return the reportPath, newBitsPath, a 4-6 line summary, and topQuestions.`,
  { schema: REPORT_SCHEMA, label: 'synthesize', phase: 'Synthesize' }
)

return { curve, perFamily, adherence, items: rows.length, report }
