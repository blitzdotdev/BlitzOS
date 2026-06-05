import { waitForEvents, latestSeq } from '../perception-core.mjs'
import { summarize, claudeReasoner } from './reasoner.mjs'

// The resident brain — P1: OBSERVE-ONLY. SHARED .mjs so the Electron main AND the
// server-mode backend run the same loop.
//
// A long-lived loop that consumes the in-process moment stream (perception-core, full
// content, trusted — same process, no relay round-trip / no redaction) and reasons each
// significant moment into an activity log. It imports NO control plane and hands the
// reasoner no tools, so it CANNOT mutate the desktop — this proves a resident perceive
// loop runs and "sees" without acting. The act tier is P2/P3.
//
// Modes (env BLITZ_BRAIN): 'deterministic' (default, zero-cost), 'claude' (enrich
// significant moments via a headless `claude -p`, no tools), 'off' (don't run).

const LOG = []
const MAX = 200
let running = false

/** Recent observations the loop has logged (inspect via the control server's /brain/log). */
export function getObservations(limit = 50) {
  return LOG.slice(-Math.max(1, Math.min(limit, MAX)))
}

/** Start the resident observe loop. `label` distinguishes electron vs server in logs.
 *  Returns a stop function. */
export function startBrain(label = 'brain') {
  const mode = (process.env.BLITZ_BRAIN || 'deterministic').toLowerCase()
  if (mode === 'off') {
    console.log(`[${label}] disabled (BLITZ_BRAIN=off)`)
    return () => {}
  }
  const reasoner = mode === 'claude' ? claudeReasoner() : null
  running = true
  let since = latestSeq() // start from now — don't replay history
  console.log(`[${label}] resident observe loop started (mode=${mode}, OBSERVE-ONLY — no desktop actions)`)
  ;(async () => {
    while (running) {
      let moments
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
        console.log(`[${label}] ${obs.significant ? '●' : '·'}${obs.reasoned ? '*' : ' '} ${obs.summary}`)
      }
    }
  })()
  return () => {
    running = false
  }
}
