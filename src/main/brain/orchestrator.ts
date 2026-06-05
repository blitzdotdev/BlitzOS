import { waitForEvents, latestSeq } from '../events'
import { summarize, claudeReasoner, type Observation, type Reasoner } from './reasoner'

// The resident brain — P1: OBSERVE-ONLY.
//
// A long-lived loop that consumes the in-process moment stream (events.ts, full
// content, trusted — same process, so no relay round-trip and no redaction) and
// reasons each significant moment into an activity log. It imports NO osActions and
// hands the reasoner no tools, so it CANNOT mutate the desktop — this proves a
// resident perceive loop runs and "sees" without acting. The act tier (focus/follow,
// suggested-reply send, write-confirm gate) is P2/P3.
//
// Modes (env BLITZ_BRAIN): 'deterministic' (default, zero-cost), 'claude' (enrich
// significant moments via a headless `claude -p`, no tools), 'off' (don't run).
// Where the brain ultimately runs is an open architecture decision (§7); this loop is
// the substrate either reasoner plugs into.

const LOG: Observation[] = []
const MAX = 200
let running = false

/** Recent observations the loop has logged (for inspection — see control-server GET /brain/log). */
export function getObservations(limit = 50): Observation[] {
  return LOG.slice(-Math.max(1, Math.min(limit, MAX)))
}

/** Start the resident observe loop. Returns a stop function. */
export function startBrain(): () => void {
  const mode = (process.env.BLITZ_BRAIN || 'deterministic').toLowerCase()
  if (mode === 'off') {
    console.log('[brain] disabled (BLITZ_BRAIN=off)')
    return () => {}
  }
  const reasoner: Reasoner | null = mode === 'claude' ? claudeReasoner() : null
  running = true
  let since = latestSeq() // start from now — don't replay history
  console.log(`[brain] resident observe loop started (mode=${mode}, OBSERVE-ONLY — no desktop actions)`)
  ;(async () => {
    while (running) {
      let moments: Awaited<ReturnType<typeof waitForEvents>>
      try {
        moments = await waitForEvents(since, 25000)
      } catch {
        moments = []
      }
      if (!running) break
      for (const m of moments) {
        since = Math.max(since, m.seq)
        let obs = summarize(m)
        // Only escalate to the (costly) LLM reasoner on significant moments.
        if (reasoner && obs.significant) {
          try {
            obs = { ...obs, summary: await reasoner.summarize(m), reasoned: true }
          } catch {
            /* reasoner unavailable/timed out — keep the deterministic observation */
          }
        }
        LOG.push(obs)
        if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX)
        console.log(`[brain] ${obs.significant ? '●' : '·'}${obs.reasoned ? '*' : ' '} ${obs.summary}`)
      }
    }
  })()
  return () => {
    running = false
  }
}
