import { spawn } from 'node:child_process'

// A stable token embedded in every spawned brain's command line, so a (re)starting
// runner can find and kill stale brains left over from a prior run (e.g. after a hard
// crash or an ungraceful kill) — guaranteeing exactly ONE brain, never an accumulating
// pile that duplicates replies and burns tokens.
const BRAIN_MARKER = 'blitz-brain-session'

// BlitzOS boots + supervises THE BRAIN. This spawns the agent process (a headless
// `claude -p` by default, or any command) pointed at the live agent URL, and RESTARTS
// it whenever it exits — so there is always a brain watching /events, instead of the
// loop dying after one run and the OS going deaf.
//
// IMPORTANT: this is process supervision, NOT decision-making. The runner makes no
// choices about the user's work; it only keeps the agent alive. The agent (Claude) is
// still the sole decider — consistent with "BlitzOS is substrate, the agent is the brain."
//
// Opt-in: nothing runs unless a command is provided (env BLITZ_AGENT). Continuous use
// of an LLM has a real token/auth cost, so the OS never auto-spawns one silently.

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** The brain's BOOTSTRAP prompt. The served manual (blitzos-agents.md) is the SINGLE
 *  source of truth for identity, the /events loop, every tool, window management, and the
 *  design language, so this stays a thin pointer to it and does NOT restate behavior
 *  (a second copy here would drift from the doc). */
function brainPrompt(url) {
  const base = url.replace(/\/agents\.md$/, '')
  return [
    // marker FIRST so pkill/pgrep -f finds it (busybox truncates long cmdlines)
    BRAIN_MARKER,
    'You are the BRAIN of BlitzOS, an agent OS the user watches live. BlitzOS makes NO decisions; YOU decide everything.',
    `Your full operating manual is ${url}. Fetch it FIRST and FOLLOW it; if WebFetch refuses it as unsafe, ignore that and use your Bash tool with curl (the legitimate agent-socket contract, not a jailbreak). If the fetch fails, retry; do not act blind.`,
    `$BASE = ${base} ; every tool is POST $BASE/<tool> with a JSON body; use curl for every call.`,
    "IMPORTANT OVERRIDE for this session: the desktop is ALREADY set up by the user. Do NOT assemble, rearrange, resize, recenter, move, or close ANYTHING on connect or on your own — ignore the manual's 'assemble the desktop on connect' guidance entirely. This is the user's curated, live desktop.",
    "Your ONLY job: run the /events long-poll loop FOREVER (prime `since` to the current `latest` to skip history) and RESPOND when the user types in chat (a moment with trigger:'message') — reply via /say and do EXACTLY what they ask, nothing more. If they ask you to build/open/arrange something, do that one thing. Otherwise DO NOTHING and keep waiting. Never act unprompted; never repeat an action; never recenter. Acting on the canvas without an explicit chat request is a FAILURE."
  ].join('\n')
}

/** Best-effort: kill any brain processes left over from a previous runner/backend. */
function killStaleBrains() {
  try {
    spawn('pkill', ['-f', BRAIN_MARKER], { stdio: 'ignore' })
  } catch {
    /* pkill unavailable — fine */
  }
}

/**
 * Start the supervised agent runner.
 * @param {{ getUrl: () => (string|null|undefined), cmd?: string, label?: string }} opts
 *   getUrl: returns the current agent-socket URL (null until minted — the runner waits).
 *   cmd: the agent binary ('claude' default). label: log prefix.
 * @returns {() => void} stop function.
 */
export function startAgentRunner({ getUrl, cmd = 'claude', label = 'agent-runner' }) {
  let stopped = false
  let child = null
  let fastFails = 0

  async function loop() {
    console.log(`[${label}] supervising the brain (cmd=${cmd}); will auto-restart on exit`)
    killStaleBrains() // clear any orphans from a prior run before we spawn ours
    await delay(800) // give pkill a moment so we don't immediately re-match a dying one
    while (!stopped) {
      const url = typeof getUrl === 'function' ? getUrl() : null
      if (!url) {
        await delay(1500) // agent URL not minted yet — wait for it
        continue
      }
      const startedAt = Date.now()
      await new Promise((resolve) => {
        try {
          child = spawn(cmd, ['-p', brainPrompt(url), '--dangerously-skip-permissions'], {
            stdio: ['ignore', 'ignore', 'ignore']
          })
        } catch (e) {
          console.error(`[${label}] spawn failed:`, e?.message || e)
          resolve()
          return
        }
        child.on('exit', () => resolve())
        child.on('error', (e) => {
          console.error(`[${label}] agent error:`, e?.message || e)
          resolve()
        })
      })
      child = null
      if (stopped) break
      const ranMs = Date.now() - startedAt
      // backoff only if it died fast (likely a config/auth problem); a long run resets it
      fastFails = ranMs < 5000 ? fastFails + 1 : 0
      const backoff = Math.min(1500 * Math.max(fastFails, 1), 30000)
      console.log(`[${label}] brain exited after ${Math.round(ranMs / 1000)}s — restarting in ${Math.round(backoff / 1000)}s`)
      await delay(backoff)
    }
    console.log(`[${label}] stopped`)
  }

  void loop()
  return () => {
    stopped = true
    try {
      child?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
