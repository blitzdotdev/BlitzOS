// agent-wake-watchdog.mjs — self-healing agent wake recovery (plans/blitzos-agent-wake-recovery.md).
//
// The OS guarantees a user/island message reaches its agent even when the agent's OWN wait-loop died. Wake-up is
// otherwise PULL-ONLY: each agent must keep a background `.blitzos/wait.sh` long-polling /events, and that is the
// only delivery path. If an agent's turn dies before it relaunches wait.sh (a rate-limit 429, a crash mid-turn,
// OOM), the agent goes deaf and the user's messages pile up unread — the island just shows "Idle". This watchdog
// detects that and physically types a catch-up nudge into the agent's tmux pane, so the agent re-reads /events
// and relaunches its loop. The user never has to touch tmux.
//
// PURE state machine: ALL I/O is injected (no electron/tmux import) so it is unit-testable. The host wires
// perception-core.setUndeliveredWakeHook(watchdog.onUndelivered) and supplies the deps below.

const GRACE_MS = 20_000      // after an undelivered message, give the agent's own loop this long to recover first
const SETTLE_MS = 1_200      // gap between the two pane captures that tell "working" (changing) from "stuck" (frozen)
const RECHECK_MS = 25_000    // after a nudge, how long to wait for the heartbeat to resume before retrying
const MAX_TRIES = 3          // nudges before giving up to 'error' (never spam the pane) — NON-rate-limit path only
const MAX_WATCH_MS = 600_000 // give up watching a never-resolving agent after 10 min (bounds the re-arm loop)
const SUBMIT_DELAY_MS = 450  // gap between typing the nudge text and the Enter so the TUI submits it (see nudgeSubmit)
const RATE_LIMIT_BACKOFF_MS = 90_000 // a rate-limited agent: how long to hold between probe-nudges (don't hammer the API)

// A rate-limited TUI is the DOMINANT deaf cause and a special case: you cannot type your way out of a 429 (the
// agent can't make any API call to process a nudge, and a submitted nudge just triggers another throttle). It heals
// only when the limit lifts — but a deaf agent's loop won't relaunch itself, so the OS must still wake it ONCE the
// limit clears. So on a rate-limit the watchdog HOLDS (no fast nudges), then PROBES on a long backoff, and never
// escalates to 'error' (it's transient). Read off the same pane the frozen-check already captures.
const RATE_LIMIT_RE = /rate.?limit|temporarily limiting|usage limit|overloaded|too many requests|\b(?:429|529)\b/i

// The catch-up directive typed into a deaf agent's pane. ONE line (no embedded newline). The Enter is sent
// SEPARATELY (see nudgeSubmit): Claude's TUI treats text+newline arriving in one burst as a PASTE, keeping the \r
// as a literal newline in the composer (the nudge silently stacks as unsubmitted draft). A distinct, slightly
// delayed Enter submits. Phrased in the agent's own bootstrap vocabulary so it self-heals via its /events ritual.
const NUDGE =
  '[BlitzOS] Your background event-wait (.blitzos/wait.sh) stopped, so you are not receiving messages. Recover now: read new events since your cursor via /events, handle anything waiting and reply, then relaunch .blitzos/wait.sh in the BACKGROUND so future messages reach you.'

/**
 * @param {object} deps
 *   - lastPollAt(agentId, workspace) => epoch-ms of the agent's last /events poll (its wait-loop heartbeat)
 *   - sendToTerminal(agentId, data) => inject keystrokes into the agent's pane
 *   - captureTerminal(agentId) => current rendered pane text (for the frozen-check)
 *   - isLive(agentId) => is the agent's pane wired this run?
 *   - setStatus(agentId, workspace, status|null) => island status override ('reconnecting' | 'error' | null)
 *   - log, now, setTimer, clearTimer, and the *Ms / maxTries overrides (for tests)
 */
export function createWakeWatchdog(deps = {}) {
  const {
    lastPollAt,
    sendToTerminal,
    captureTerminal = () => '',
    isLive = () => true,
    setStatus = () => {},
    log = () => {},
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    graceMs = GRACE_MS,
    settleMs = SETTLE_MS,
    recheckMs = RECHECK_MS,
    maxTries = MAX_TRIES,
    maxWatchMs = MAX_WATCH_MS,
    submitDelayMs = SUBMIT_DELAY_MS,
    rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS
  } = deps
  if (typeof lastPollAt !== 'function' || typeof sendToTerminal !== 'function') {
    throw new Error('createWakeWatchdog: lastPollAt + sendToTerminal are required')
  }

  const recs = new Map() // key -> { agentId, workspace, msgTs, firstTs, tries, timer }
  const key = (a, w) => `${w == null ? '' : w} ${a}`

  /** perception-core hook: a 'message'/'steer' moment reached NO live waiter for this agent. */
  function onUndelivered(moment) {
    if (!moment) return
    const agentId = String(moment.agentId == null ? '0' : moment.agentId)
    const workspace = moment.workspace == null ? null : String(moment.workspace)
    const k = key(agentId, workspace)
    if (recs.has(k)) return // already recovering this agent — coalesce (one wake heals every pending message)
    const t = now()
    const rec = { agentId, workspace, msgTs: t, firstTs: t, tries: 0, timer: null }
    rec.timer = setTimer(() => { void check(k) }, graceMs)
    recs.set(k, rec)
  }

  async function check(k) {
    const rec = recs.get(k); if (!rec) return
    const { agentId, workspace, msgTs } = rec
    // Healthy: a poll arrived AT/AFTER the message → wait.sh is alive and already received it (the message is in
    // the event LOG, so any re-poll delivers it). Done.
    if (lastPollAt(agentId, workspace) >= msgTs) return done(k)
    // Process gone (pane not wired) → terminal-manager auto-restart owns that, not us.
    if (!isLive(agentId)) return done(k)
    // Bound the watch: a never-resolving agent (perpetually changing pane, never polls) is abnormal; stop quietly.
    if (now() - rec.firstTs > maxWatchMs) { log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) gave up after ${Math.round(maxWatchMs / 1000)}s`); return done(k) }
    // Confirm the pane is FROZEN (stuck at a prompt), not actively working, before injecting. A working agent's
    // spinner/output changes across the settle window; a stuck one is byte-identical (verified on a live agent).
    const a = safeCapture(agentId)
    await sleep(settleMs)
    if (!recs.has(k)) return // cleared while settling
    if (lastPollAt(agentId, workspace) >= msgTs) return done(k) // recovered during settle
    const b = safeCapture(agentId)
    if (!a || !b || a !== b) { // producing output (or no capture) → treat as working; keep watching, don't inject
      rec.timer = setTimer(() => { void check(k) }, graceMs)
      return
    }
    // STUCK and deaf. WHY it's stuck decides the recovery.
    setStatus(agentId, workspace, 'reconnecting')
    if (RATE_LIMIT_RE.test(b)) {
      // Rate-limited: a nudge can't be processed under a 429 and would just re-throttle. HOLD, then PROBE on a long
      // backoff — the first time we only wait (the limit was just hit); after a full backoff we send ONE nudge to
      // test whether it cleared (if so it submits + the agent relaunches its loop; if not it re-dies and we wait
      // again). Never escalate to 'error' — a throttle is transient and the agent is not actually broken.
      const probing = rec.rlSeen === true
      if (probing) nudgeSubmit(agentId)
      rec.rlSeen = true
      log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) rate-limited — ${probing ? 'probe nudge' : 'holding'} (backoff ${Math.round(rateLimitBackoffMs / 1000)}s)`)
      rec.timer = setTimer(() => { void check(k) }, rateLimitBackoffMs)
      return
    }
    // Genuinely frozen for another reason (a crashed turn): nudge promptly, quick retries, give up to 'error'.
    rec.rlSeen = false
    rec.tries++
    log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) deaf (frozen) — nudge ${rec.tries}/${maxTries}`)
    nudgeSubmit(agentId)
    rec.timer = setTimer(() => {
      if (lastPollAt(agentId, workspace) >= msgTs) return done(k)                                  // recovered — the nudge worked
      if (rec.tries >= maxTries) { setStatus(agentId, workspace, 'error'); return done(k) }         // give up — surface + stop
      void check(k)                                                                                // retry: re-confirm frozen, nudge again
    }, recheckMs)
  }

  // Submit a nudge as TWO steps: type the text, then send Enter as a SEPARATE keypress after a short delay.
  // Claude's TUI treats a burst of text-then-newline as a PASTE and keeps the \r as a literal newline (the nudge
  // stacks as unsubmitted draft); a distinct, slightly-delayed Enter is read as a real submit. Verified live: a
  // combined `text+\r` write stacked 3 unsent drafts, while separate text then a delayed Enter submits.
  function nudgeSubmit(id) {
    try {
      sendToTerminal(id, NUDGE)
      setTimer(() => { try { sendToTerminal(id, '\r') } catch { /* ignore */ } }, submitDelayMs)
    } catch (e) { log('wake-watchdog inject failed: ' + ((e && e.message) || e)) }
  }

  function done(k) { const rec = recs.get(k); if (rec) { clearTimer(rec.timer); recs.delete(k) } }
  function safeCapture(id) { try { return String(captureTerminal(id) || '') } catch { return '' } }
  function sleep(ms) { return new Promise((r) => setTimer(r, ms)) }

  /** Tear down all timers (shutdown). */
  function stop() { for (const k of [...recs.keys()]) done(k) }
  return { onUndelivered, stop, _size: () => recs.size }
}
