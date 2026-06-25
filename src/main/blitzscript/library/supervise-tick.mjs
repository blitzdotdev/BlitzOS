#!/usr/bin/env node
// blitzscript BUILT-IN — supervise-tick: the W2 supervisor heartbeat as ONE blitzscript.
//
//   blitz run supervise-tick <workerAgentId> [tickDiffJsonOrFile]
//   blitz check supervise-tick                  # dry-run validates the pipeline against fallbacks
//
// On a supervisor TICK, BlitzOS hands us WHAT CHANGED in the world (Option A: the OS ticks + diffs + emits;
// the AGENT owns all steering judgment, with zero per-task heuristics in the OS — see CLAUDE.md "Agent
// runtime" + plans/blitzos-tick-diff-steer.md). This workflow turns that diff into ONE decision: NOOP, or
// STEER the worker with a concrete directive. The calling agent executes the decision via the `steer` tool.
//
// SHAPE — fan-out over the plan, reduce to one action:
//   • parse the worker's OPEN plan stages in CODE (the `- [ ] Stage` grammar).
//   • MAP: for each open stage, a cheap leaf judges — given the diff — is it advancing / stalled / blocked /
//     off-track, and what's the concern? (no plan stages -> one judgment over the whole goal + diff.)
//   • REDUCE: one strong leaf picks a SINGLE action {noop | steer, text}. Default NOOP — steer ONLY on a
//     real stall, block, or divergence (a normal in-progress tick must not nag the worker).
//
// Inputs:
//   argv[0]  worker agent id (the steer target).
//   argv[1]  the tick DIFF: inline JSON/text, or a path to a JSON file BlitzOS wrote for this tick. Falls
//            back to <mem>/tick.json if present, else an empty diff (=> noop).
//   argv[2]  the worker's PLAN or GOAL: inline text, or a path to a file. A staged plan (the `- [ ] Stage`
//            grammar) is fanned out over its open stages; otherwise the whole text is treated as one goal.
// Output (stdout = the result): STRICT JSON { action:"noop"|"steer", agent, text, why }.

import { llm } from '../llm.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const mem = process.env.BLITZ_MEM_DIR || '.'
const DRY = process.env.BLITZ_DRY_RUN === '1'

const agentId = process.argv[2] || (DRY ? 'dry' : null)
const diffArg = process.argv[3] || null
const planArg = process.argv[4] || null
if (!agentId) { console.error('usage: blitz run supervise-tick <workerAgentId> [tickDiffJsonOrFile] [planOrGoalTextOrFile]'); process.exit(2) }

// ── gather context (mechanical, in CODE) ─────────────────────────────────────────────────────────
const loadFrom = (arg) => (arg ? (existsSync(arg) ? readFileSync(arg, 'utf8') : arg) : '') // a path, else inline text
function loadDiff() {
  if (diffArg) return loadFrom(diffArg)
  const f = join(mem, 'tick.json')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

let planText = loadFrom(planArg)
let diff = loadDiff().trim()
// DRY-RUN self-fixture (blitz check): synthesize a plan/goal + a tiny diff so the full map -> reduce flow runs.
if (DRY) { planText = planText || 'Draft and send the weekly update.'; if (!diff) diff = JSON.stringify({ changed: { surfaces: ['note-3 edited'], agents: { [agentId]: 'idle 40s' } } }) }

// Parse the staged-plan grammar: `- [ ] todo`, `- [x] done`, `- [b] blocked`. No stages -> the text is one goal.
const stages = [...planText.matchAll(/^[ \t]*[-*]\s*\[([ xXbB])\]\s+(.+?)\s*$/gm)]
  .map((m) => ({ status: m[1].toLowerCase() === 'x' ? 'done' : m[1].toLowerCase() === 'b' ? 'blocked' : 'todo', title: m[2] }))
const open = stages.filter((s) => s.status !== 'done')
const goal = stages.length ? '' : planText

// ── MAP: judge each open stage (or the whole goal) against this tick's change, in parallel ────────
const FB_STAGE = JSON.stringify({ state: 'advancing', concern: '' })
const targets = open.length ? open : [{ title: goal || 'the overall task', status: 'todo' }]
const views = await Promise.all(targets.map((s) =>
  llm(
    `You supervise a worker agent. Its current goal/stage: "${s.title}".\n` +
    `WHAT JUST CHANGED this tick (a diff of the workspace):\n${diff || '(no changes this tick)'}\n\n` +
    `Judge ONLY this stage against that change. Reply STRICT JSON ` +
    `{"state":"advancing|stalled|blocked|off-track","concern":"<one sentence, or empty if advancing>"}.`,
    { model: 'cheap' }, FB_STAGE,
  ).then((r) => ({ stage: s.title, r })),
))

// ── REDUCE: one strong leaf -> a SINGLE action. Default noop; steer only on a real problem ─────────
const FB_DECIDE = JSON.stringify({ action: 'noop', agent: agentId, text: '', why: 'dry-run fallback' })
const decision = await llm(
  `You are the supervisor for worker agent ${agentId}. Decide ONE action. DEFAULT to "noop" — only "steer" on a ` +
  `real stall, block, or divergence from the goal; a normal in-progress tick is noop (do not nag).\n` +
  `Goal/plan:\n${goal || planText || '(see stages)'}\n\nPer-stage views this tick:\n${JSON.stringify(views)}\n\n` +
  `If you steer, write a SHORT, specific directive the worker can act on immediately. Reply STRICT JSON ` +
  `{"action":"noop"|"steer","agent":"${agentId}","text":"<directive if steer, else empty>","why":"<one sentence>"}.`,
  { model: 'strong' }, FB_DECIDE,
)
console.log(typeof decision === 'string' ? decision.trim() : JSON.stringify(decision))
