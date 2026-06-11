// The CANNED interview — onboarding's no-model fallback tier (plans/onboarding-case-file.md P2).
// When no brain backend exists (no `claude` CLI, no gateway), the OS itself runs a short static
// interview through the SAME medium the real brain uses: blitz-ui choice cards in chat, answers
// arriving as trigger:'message' moments, the gaps card flipping done as it learns. Deterministic,
// zero LLM — and shaped exactly like the brain's loop so the upgrade path is swapping the policy.
//
// PURE CORE with injected ops (the repo's shared-core pattern) so the seed test scripts it:
//   ops = { say(text), waitEvents(since, maxMs)->Promise<moments[]>, latestSeq()->n,
//           updateSurface(id, patch), readBoard()->BoardFile|null,
//           readState()->{answers?}|null, writeState(obj), writeProfile(md), done() }

export const STATIC_QUESTIONS = [
  {
    id: 'focus',
    prompt: 'What should BlitzOS help you with first?',
    options: ['Triage my inbox', 'Plan my day', 'Research something', 'Build something', 'Just exploring'],
    gap: /worth doing|goals/i
  },
  {
    id: 'autonomy',
    prompt: 'When BlitzOS can act on its own, how much rope?',
    options: ['Act first, show me after', 'Propose first, I approve', 'Only when I ask'],
    gap: /autonomy|act vs|act on its own/i
  },
  {
    id: 'confirm',
    prompt: 'What must ALWAYS be confirmed with you first?',
    options: ['Anything sent as me', 'Money, deploys, deletes', 'All of those', 'Nothing, trust me'],
    gap: /risk|confirmed/i
  },
  {
    id: 'attention',
    prompt: 'When should it interrupt you?',
    options: ['Immediately, always', 'Batch quiet summaries', 'Only urgent things', 'I will check in myself'],
    gap: /interrupt|rhythm|focus blocks/i
  }
]

const card = (q) => '```blitz-ui\n' + JSON.stringify({ type: 'choice', prompt: q.prompt, options: q.options }) + '\n```'

/** Wait for the next human chat message after `since`; returns {text, seq} (never resolves until one arrives). */
async function nextAnswer(ops, since) {
  for (;;) {
    const evs = await ops.waitEvents(since, 25_000)
    for (const m of evs || []) {
      since = Math.max(since, m.seq || since)
      const texts = Array.isArray(m.user) ? m.user : []
      if (m.trigger === 'message' && texts.length) return { text: String(texts[texts.length - 1]).replace(/^User said:\s*/i, ''), seq: since }
    }
    if (evs && evs.length) since = Math.max(since, ...evs.map((m) => m.seq || 0))
  }
}

/** Flip gaps-card items matching answered questions to done (the visible "it learned" beat). */
function markGaps(ops, answered) {
  const board = ops.readBoard()
  const gapsId = board && board.ids && board.ids.gaps
  if (!gapsId || !board.gapsItems) return // gapsItems threaded via readBoard for prop rewrite
  const items = board.gapsItems.map((g) => {
    const hit = answered.some((q) => q.gap && q.gap.test(String(g.q || '')))
    return hit ? { ...g, done: true } : g
  })
  ops.updateSurface(gapsId, { props: { items } })
}

function profileMd(answers, finishedAt) {
  const lines = [
    '# Principal profile (canned onboarding; no model was available)',
    '',
    `Captured ${new Date(finishedAt).toISOString()} by the static interview tier. A resident brain should`,
    'treat these as the human’s literal words, fold them into its own model, and replace this file.',
    ''
  ]
  for (const q of STATIC_QUESTIONS) {
    const a = answers[q.id]
    if (a) {
      lines.push(`- **${q.prompt}**  `)
      lines.push(`  ${a}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Run the canned interview to completion. Resumable: previously saved answers are skipped, so an
 * app restart mid-interview continues where it left off.
 */
export async function runCannedInterview(ops) {
  const state = ops.readState() || {}
  const answers = { ...(state.answers || {}) }
  const pending = STATIC_QUESTIONS.filter((q) => !answers[q.id])
  if (pending.length === STATIC_QUESTIONS.length) {
    ops.say(
      'I put together this board from a local scan of your Mac. It is my working model of you, and every card is editable. No AI brain is connected yet, so I have just four fixed questions; a connected brain would ask sharper ones.'
    )
  } else if (pending.length) {
    ops.say('Picking the interview back up. ' + pending.length + ' question' + (pending.length > 1 ? 's' : '') + ' left.')
  }
  let since = ops.latestSeq()
  for (const q of pending) {
    ops.say(card(q))
    const a = await nextAnswer(ops, since)
    since = a.seq
    answers[q.id] = a.text
    ops.writeState({ state: 'pending', answers })
    markGaps(ops, STATIC_QUESTIONS.filter((x) => answers[x.id]))
  }
  const finishedAt = Date.now()
  ops.writeProfile(profileMd(answers, finishedAt))
  ops.writeState({ state: 'done', finishedAt, answers })
  ops.say(
    'What I learned: ' +
      STATIC_QUESTIONS.filter((q) => answers[q.id])
        .map((q) => `${q.prompt.replace(/\?$/, '')} → ${answers[q.id]}`)
        .join(' · ') +
      '. It is on the board and in .blitzos/onboarding/profile.md. Correct me anytime by editing the cards.'
  )
  ops.done()
  return answers
}
