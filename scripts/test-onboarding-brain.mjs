#!/usr/bin/env node
// P2 interview test (plans/onboarding-case-file.md): drives the CANNED interview core
// (onboarding-interview.mjs — the no-model fallback tier) against scripted ops. Asserts the
// question cards land in chat, answers advance the loop, the gaps card flips done, the profile
// is written, and a restart resumes instead of restarting. No Electron, no model.
// Run: node scripts/test-onboarding-brain.mjs
import { runCannedInterview, STATIC_QUESTIONS } from '../src/main/onboarding-interview.mjs'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

function makeOps({ answers, state = null, gapsItems }) {
  const calls = { says: [], updates: [], states: [], profile: null, done: 0 }
  let seq = 100
  const queue = [...answers]
  return {
    calls,
    say: (t) => calls.says.push(t),
    // each wait yields exactly one scripted user answer (as a message moment)
    waitEvents: async (since) => {
      if (!queue.length) throw new Error('interview asked for more answers than scripted')
      const text = queue.shift()
      seq += 1
      return [{ seq, trigger: 'message', user: [`User said: ${text}`] }]
    },
    latestSeq: () => seq,
    updateSurface: (id, patch) => calls.updates.push({ id, patch }),
    readBoard: () => ({ ids: { gaps: 'gaps-1' }, gapsItems }),
    readState: () => state,
    writeState: (obj) => calls.states.push(JSON.parse(JSON.stringify(obj))),
    writeProfile: (md) => (calls.profile = md),
    done: () => calls.done++
  }
}

const GAPS = [
  { q: 'How much should BlitzOS act on its own vs. ask before acting?' },
  { q: 'Risk tolerance & what must always be confirmed' },
  { q: 'What is worth doing this quarter?' },
  { q: 'Daily rhythm & when NOT to interrupt' }
]

console.log('1) full run — four cards, answers recorded, gaps flip, profile written')
{
  const ops = makeOps({ answers: ['Build something', 'Propose first, I approve', 'All of those', 'Batch quiet summaries'], gapsItems: GAPS })
  const answers = await runCannedInterview(ops)
  const cards = ops.calls.says.filter((s) => s.includes('```blitz-ui'))
  ok(cards.length === STATIC_QUESTIONS.length, `every question is a blitz-ui card (${cards.length}/${STATIC_QUESTIONS.length})`)
  ok(
    cards.every((c) => {
      const j = JSON.parse(c.replace(/```blitz-ui\n?|\n?```/g, ''))
      return j.type === 'choice' && j.prompt && Array.isArray(j.options) && j.options.length >= 3
    }),
    'cards parse as {type:choice, prompt, options[]}'
  )
  ok(answers.autonomy === 'Propose first, I approve', 'answer text recorded verbatim (sans "User said:")')
  ok(ops.calls.states[0].answers && Object.keys(ops.calls.states[0].answers).length === 1, 'state persists progressively (resumable)')
  const last = ops.calls.states[ops.calls.states.length - 1]
  ok(last.state === 'done' && last.finishedAt > 0, 'final state is done')
  const lastGaps = ops.calls.updates[ops.calls.updates.length - 1]
  ok(lastGaps.id === 'gaps-1' && lastGaps.patch.props.items.filter((i) => i.done).length === 4, 'all four matched gaps flip to done')
  ok(ops.calls.profile && ops.calls.profile.includes('Propose first, I approve') && ops.calls.profile.includes('no model was available'), 'profile.md written with the answers, honestly labeled')
  ok(ops.calls.says[ops.calls.says.length - 1].startsWith('What I learned'), 'finishes with the What-I-learned summary')
  ok(ops.calls.done === 1, 'done() fires once')
  // strict prose rule (plans/siri-prompt.md): nothing the human reads contains an em dash
  ok(ops.calls.says.every((s) => !s.includes('—')) && !ops.calls.profile.includes('—'), 'no em dashes anywhere the human reads')
}

console.log('2) resume — two pre-answered questions are not re-asked')
{
  const ops = makeOps({
    answers: ['All of those', 'Only urgent things'],
    state: { state: 'pending', answers: { focus: 'Build something', autonomy: 'Only when I ask' } },
    gapsItems: GAPS
  })
  const answers = await runCannedInterview(ops)
  const cards = ops.calls.says.filter((s) => s.includes('```blitz-ui'))
  ok(cards.length === 2, `only the two unanswered questions are asked (got ${cards.length})`)
  ok(answers.focus === 'Build something' && answers.attention === 'Only urgent things', 'old + new answers merge')
  ok(ops.calls.says[0].includes('Picking the interview back up'), 'resume is announced, not restarted')
}

console.log('3) board-less run — no gaps card, no crash')
{
  const ops = makeOps({ answers: ['Plan my day', 'Act first, show me after', 'Nothing, trust me', 'I will check in myself'], gapsItems: undefined })
  ops.readBoard = () => null
  await runCannedInterview(ops)
  ok(ops.calls.updates.length === 0, 'no surface updates without a board')
  ok(ops.calls.profile !== null, 'profile still written')
}

if (failed) {
  console.error(`\n✗ ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ onboarding interview (canned tier) test passed')
