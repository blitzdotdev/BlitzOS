// blitzscript example — Research workflow patterns, then extract the principal
// dimensions that explain variance across them (so we can give users control knobs).
//
//   node src/main/blitzscript/run.mjs run src/main/blitzscript/examples/workflow-patterns.mjs
//
// SHAPE (the canonical RLM fan-out → fan-in, no per-task code):
//   • 3 PARALLEL leaves (Promise.all), each enumerating + describing ONE family of
//     agent/LLM workflow patterns FROM ITS OWN KNOWLEDGE (no web → deterministic-ish).
//   • 1 fan-in SYNTHESIS leaf that reads the three catalogs and pulls out the PRINCIPAL
//     DIMENSIONS (depth, breadth, loop/iteration count, parallelism, critic/feedback,
//     …) that explain the variance, then proposes a small set of user CONTROL KNOBS.
//
// Total llm() calls = 4 (3 leaves + 1 synthesis) — under the hard cap of 6.
// Leaves run on the cheap/fast harness (claude -p, haiku) so the run stays quick.

import { llm } from '../llm.mjs'

// One cheap, fast leaf config reused everywhere. claude -p + haiku = the fastest model.
const LEAF = { harness: 'claude', model: 'claude-haiku-4-5' }

// The three pattern families to fan out over. Splitting the space across leaves keeps
// each prompt small and lets them run in parallel; the union is what we synthesize.
const FAMILIES = [
  {
    key: 'orchestration',
    title: 'Orchestration / control-flow patterns',
    hint: 'fan-out/fan-in (map-reduce, scatter-gather), sequential chaining/pipelines, ' +
          'routing/dispatch, parallel voting/ensembling, hierarchical orchestrator-worker.',
  },
  {
    key: 'iterative',
    title: 'Iterative / feedback patterns',
    hint: 'actor-critic, generator-evaluator / reflexion, self-refine / iterative revision loops, ' +
          'debate / multi-agent argument, plan-and-execute with replanning, ReAct (reason+act loops).',
  },
  {
    key: 'retrieval_tool',
    title: 'Retrieval- and tool-grounded patterns',
    hint: 'RAG (retrieve-then-generate), tool-use / function-calling agents, ' +
          'memory-augmented loops, deep-research (recursive search + synthesis), ' +
          'code-execution / self-test loops.',
  },
]

// A leaf prompt: enumerate a family and, crucially, RATE each pattern on the structural
// axes we care about — so the synthesis step has comparable signal, not just prose.
function leafPrompt(fam) {
  return [
    `You are cataloguing AGENT / LLM WORKFLOW PATTERNS for the family: "${fam.title}".`,
    `Patterns in scope (extend with any you know): ${fam.hint}`,
    '',
    'From your OWN knowledge (do NOT browse the web), list 5-7 named patterns in this family.',
    'For EACH pattern give one tight line in EXACTLY this format:',
    '  - <name>: <1-sentence what-it-is> | depth=<low|med|high> breadth=<low|med|high> ' +
    'loops=<none|bounded|until-converged> parallelism=<none|fan-out|ensemble> ' +
    'critic=<none|self|separate-judge> tool/retrieval=<none|tool|retrieval|both>',
    '',
    'Pick the depth/breadth/loops/parallelism/critic/tool ratings honestly per pattern — ' +
    'they are the structural fingerprint we will compare across families.',
    'Output ONLY the bullet list. No preamble, no closing remarks.',
  ].join('\n')
}

// The fan-in: hand all three catalogs to one leaf and ask it to do the actual job —
// find the axes that explain variance, then turn them into a SMALL knob set for users.
function synthesisPrompt(catalogs) {
  const corpus = catalogs
    .map((c) => `### ${c.title}\n${c.text.trim()}`)
    .join('\n\n')
  return [
    'You are given catalogs of agent/LLM workflow patterns, each pattern fingerprinted on ' +
    'structural axes (depth, breadth, loops, parallelism, critic, tool/retrieval).',
    '',
    'CORPUS:',
    corpus,
    '',
    'TASK — do PCA-in-spirit (no math needed), purely from the fingerprints above:',
    '1. PRINCIPAL DIMENSIONS: name the 4-6 axes that explain the MOST variance ACROSS all ' +
    'these patterns (the axes on which patterns most differ). For each: one line — the axis, ' +
    'what low vs high looks like, and 2 example patterns at the extremes.',
    '2. CONTROL KNOBS: propose a SMALL set (4-6) of user-facing knobs that map onto those ' +
    'dimensions. For each knob give: name, type (e.g. integer 1-N / enum / boolean), default, ' +
    'and the one-line effect on the running workflow.',
    '3. COLLAPSED/REDUNDANT: note any axes that move together (so we do NOT ship redundant knobs).',
    '',
    'Be concrete and terse. Use these three section headers verbatim: ' +
    '"PRINCIPAL DIMENSIONS", "CONTROL KNOBS", "REDUNDANCIES".',
  ].join('\n')
}

async function main() {
  const t0 = Date.now()

  // ── FAN-OUT: 3 parallel cheap leaves, one per family. ────────────────────────────────
  console.error(`[workflow-patterns] fan-out: ${FAMILIES.length} parallel leaves (${LEAF.model})…`)
  const catalogs = await Promise.all(
    FAMILIES.map(async (fam) => {
      const text = await llm(leafPrompt(fam), LEAF, 'Pattern A (depth 1, breadth N, no loop): desc. Pattern B (iterative critic loop): desc. (dry-run fallback)')
      console.error(`[workflow-patterns]   ✓ ${fam.key} (${text.length} chars)`)
      return { title: fam.title, text }
    }),
  )

  // Echo the raw leaf output so it's verifiable that REAL llm() text drove the result.
  console.log('================ LEAF CATALOGS (fan-out, from llm()) ================')
  for (const c of catalogs) {
    console.log(`\n## ${c.title}\n${c.text.trim()}`)
  }

  // ── FAN-IN: 1 synthesis leaf extracts the dimensions + proposes the knobs. ────────────
  console.error('[workflow-patterns] fan-in: synthesis leaf…')
  const synthesis = await llm(synthesisPrompt(catalogs), LEAF,
    'Dimensions: iteration-intensity, parallelism, breadth, verification, grounding. Knobs: max_cycles, parallel_mode, worker_count, external_verifier, knowledge_mode. (dry-run fallback)')

  console.log('\n\n================ SYNTHESIS — PRINCIPAL DIMENSIONS + CONTROL KNOBS ================\n')
  console.log(synthesis.trim())

  console.error(
    `\n[workflow-patterns] done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
    `— ${FAMILIES.length + 1} llm() calls (3 fan-out + 1 fan-in).`,
  )
}

main().catch((e) => {
  console.error('[workflow-patterns] FAILED:', e?.stack || e?.message || e)
  process.exit(1)
})
