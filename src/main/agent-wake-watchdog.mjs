// agent-wake-watchdog.mjs — self-healing agent wake recovery (plans/blitzos-agent-wake-recovery.md).
//
// The OS guarantees a user/island message reaches its agent even when the agent's OWN wait-loop died. Wake-up is
// otherwise PULL-ONLY: each agent must keep a background `.blitzos/wait.sh` long-polling /events, and that is the
// only delivery path. If an agent's turn dies before it relaunches wait.sh (a rate-limit 429, a crash mid-turn,
// OOM), the agent goes deaf and the user's messages pile up unread — the island just shows "Idle". This watchdog
// detects that and physically types a catch-up nudge into the agent's tmux pane, so the agent re-reads /events
// and relaunches its loop. The user never has to touch tmux.
//
// TWO arming sources:
//   - onUndelivered(moment): a user/island/steer 'message' reached NO live waiter (its loop is dead). REACTIVE.
//   - sweep(agents): a periodic peek at every live agent's pane. PROACTIVE — catches a SELF-INFLICTED stall that
//     no message would surface, the dominant one being a usage/session limit the agent hit on its own turn. A
//     usage limit clears at a STATED reset time, so for it the watchdog parses that time and schedules a precise
//     resume (you can neither type nor probe your way past it before then) instead of nudging blindly.
//
// PURE state machine: ALL I/O is injected (no electron/tmux import) so it is unit-testable. The host wires
// perception-core.setUndeliveredWakeHook(watchdog.onUndelivered), a setInterval → watchdog.sweep, and the deps below.

const GRACE_MS = 20_000      // after an undelivered message, give the agent's own loop this long to recover first
const SETTLE_MS = 1_200      // gap between the two pane captures that tell "working" (changing) from "stuck" (frozen)
const RECHECK_MS = 25_000    // after a nudge, how long to wait for the heartbeat to resume before retrying
const MAX_TRIES = 3          // nudges before giving up to 'error' (never spam the pane) — NON-rate-limit path only
const MAX_WATCH_MS = 600_000 // give up watching a never-resolving agent after 10 min (bounds the re-arm loop)
const SUBMIT_DELAY_MS = 450  // gap between typing the nudge text and the Enter so the TUI submits it (see nudgeSubmit)
const RATE_LIMIT_BACKOFF_MS = 90_000 // a rate-limited agent: how long to hold between probe-nudges (don't hammer the API)
const RESUME_BUFFER_MS = 20_000      // wait this long PAST a parsed reset time before resuming (so the limit is fully lifted)
const RESUME_COOLDOWN_MS = 300_000   // after a scheduled resume fires, don't let the sweep re-arm the same agent for this long (no storm)

// A rate-limited TUI is a DOMINANT deaf cause and a special case: you cannot type your way out of a 429 (the
// agent can't make any API call to process a nudge, and a submitted nudge just triggers another throttle). It heals
// only when the limit lifts — but a deaf agent's loop won't relaunch itself, so the OS must still wake it ONCE the
// limit clears. So on a TRANSIENT rate-limit (no stated reset time) the watchdog HOLDS, then PROBES on a long
// backoff, and never escalates to 'error'. Read off the same pane the frozen-check already captures.
const RATE_LIMIT_RE = /rate.?limit|temporarily limiting|overloaded|too many requests|\b(?:429|529)\b/i

// A USAGE / SESSION limit is the rate-limit's sibling but with a KNOWN reset time ("You've hit your session limit ·
// resets 6:40pm"). You can't type past it either, but you know EXACTLY when it lifts — so rather than probe blindly
// every 90s and give up after 10 min (useless for a multi-hour reset), the watchdog parses the reset time and
// schedules ONE precise resume for then. SESSION_LIMIT_RE confirms it IS a usage limit; parseResetAt extracts when.
const SESSION_LIMIT_RE = /(?:session|usage|weekly|daily)\s+limit|hit your[^\n]{0,24}limit|usage-credits/i

// A TRANSIENT API error (a 5xx, a dropped connection, a fetch failure) CRASHES the agent's current turn. Unlike a
// rate-limit, it has no reset time and is retryable immediately. The danger is the silent path: a message was
// DELIVERED to a live wait.sh waiter (so onUndelivered never fires), the agent woke, its turn died on the 5xx, and
// it never relaunched wait.sh — so the loop is dead, the message is consumed, and NOTHING re-delivers it. The agent
// goes permanently silent until a human types into it. The sweep catches exactly this (API-error pane + a DEAD
// heartbeat) and probes it back to life. 529/overloaded is intentionally left to RATE_LIMIT_RE (hold-first).
const API_ERROR_RE = /API Error:\s*(?:5(?:0\d|1\d|2[0-8])\b|connection error|fetch failed|network)|Internal server error/i
// An AUTH failure (not signed in / expired-or-revoked token / no credits). Claude Code reports it ONLY in its
// terminal TUI ("Please run /login · API Error: 401 Invalid authentication credentials") — it never writes an
// isApiErrorMessage record, so the JSONL-based status detector is blind to it (the island just sits on
// "Working…"). This is the pane's job to catch. It is NOT revivable by a nudge — a re-auth needs the user — so a
// match surfaces the "Not signed in" error and stops, never the rate-limit/api-error recovery ladder. The pane
// text is unambiguous (a healthy agent never prints it), so no heartbeat gate is needed to avoid false trips.
const AUTH_ERROR_RE = /run \/login|please sign in|not logged in|invalid authentication credentials|invalid x-api-key|oauth token (?:has )?expired|credit balance is too low/i
const HEARTBEAT_STALE_MS = 60_000 // wait.sh polls /events every ~25s; >2 missed cycles ⇒ the loop is genuinely dead

// The catch-up directive typed into a DEAF agent's pane (loop died, but the agent can still take a turn). ONE line
// (no embedded newline). The Enter is sent SEPARATELY (see nudgeSubmit): Claude's TUI treats text+newline arriving
// in one burst as a PASTE, keeping the \r as a literal newline in the composer (the nudge silently stacks as
// unsubmitted draft). A distinct, slightly delayed Enter submits. Phrased in the agent's own bootstrap vocabulary
// so it self-heals via its /events ritual.
const NUDGE =
  '[BlitzOS] Your background event-wait (.blitzos/wait.sh) stopped, so you are not receiving messages. Recover now: read new events since your cursor via /events, handle anything waiting and reply, then relaunch .blitzos/wait.sh in the BACKGROUND so future messages reach you.'

// The directive typed when a USAGE LIMIT has just reset — resume whatever was cut off and re-establish the loop.
const RESUME =
  '[BlitzOS] Your usage limit has reset. Resume now: read new events since your cursor via /events, finish anything left unfinished, then relaunch .blitzos/wait.sh in the BACKGROUND so future messages reach you.'

// Parse a Claude-Code usage/session-limit reset time off the pane ("resets 6:40pm (America/Los_Angeles)"). Claude
// renders the time in the MACHINE's local tz (the "(America/Los_Angeles)" tag === the host tz), so we parse the
// wall-clock as LOCAL and pick the candidate occurrence (yesterday/today/tomorrow) CLOSEST to now — that handles
// both the after-midnight wrap and the "the printed time already passed → resume now" case. Returns epoch-ms, or
// null when no reset time is present (e.g. a transient 429, which has no reset time). Exported for tests.
export function parseResetAt(text, nowMs) {
  const m = /reset(?:s|ting)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?/i.exec(text || '')
  if (!m) return null
  let hh = parseInt(m[1], 10)
  const mm = m[2] ? parseInt(m[2], 10) : 0
  const pm = m[3].toLowerCase() === 'p'
  if (hh === 12) hh = 0
  if (pm) hh += 12
  if (hh > 23 || mm > 59) return null
  const d = new Date(nowMs)
  d.setHours(hh, mm, 0, 0)
  const t0 = d.getTime()
  const DAY = 86_400_000
  let best = t0
  for (const c of [t0 - DAY, t0, t0 + DAY]) if (Math.abs(c - nowMs) < Math.abs(best - nowMs)) best = c
  return best
}

export { SESSION_LIMIT_RE, API_ERROR_RE }

/**
 * @param {object} deps
 *   - lastPollAt(agentId, workspace) => epoch-ms of the agent's last /events poll (its wait-loop heartbeat)
 *   - sendToTerminal(agentId, data) => inject keystrokes into the agent's pane
 *   - captureTerminal(agentId) => current rendered pane text (for the frozen-check + limit-detect)
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
    onAuthError = () => {}, // (agentId, workspace) => surface a sticky "Not signed in" error (terminal-only auth 401)
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
    rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS,
    resumeBufferMs = RESUME_BUFFER_MS,
    resumeCooldownMs = RESUME_COOLDOWN_MS,
    heartbeatStaleMs = HEARTBEAT_STALE_MS
  } = deps
  if (typeof lastPollAt !== 'function' || typeof sendToTerminal !== 'function') {
    throw new Error('createWakeWatchdog: lastPollAt + sendToTerminal are required')
  }

  const recs = new Map() // key -> { agentId, workspace, msgTs, firstTs, tries, timer, source, preResume }
  const cooldownUntil = new Map() // key -> epoch-ms before which the sweep must not re-arm (post-resume quiet window)
  const authSurfaced = new Set() // keys we've already surfaced an auth error for; cleared once the pane recovers
  const key = (a, w) => `${w == null ? '' : w} ${a}`

  /** Surface a terminal-only auth failure ONCE per episode (deduped on `k`); cleared when the pane recovers. */
  function surfaceAuth(agentId, workspace, k) {
    if (authSurfaced.has(k)) return
    authSurfaced.add(k)
    log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) NOT SIGNED IN (pane auth error) — surfacing`)
    try {
      onAuthError(agentId, workspace)
    } catch {
      /* never break the sweep/recovery on a surfacing failure */
    }
  }

  /** perception-core hook: a 'message'/'steer' moment reached NO live waiter for this agent. */
  function onUndelivered(moment) {
    if (!moment) return
    const agentId = String(moment.agentId == null ? '0' : moment.agentId)
    const workspace = moment.workspace == null ? null : String(moment.workspace)
    arm(agentId, workspace, 'message')
  }

  /** Periodic proactive peek: arm a scheduled resume for any live agent whose pane shows a usage limit with a
   *  reset time. `agents` is an array of agent ids or { agentId, workspace }. Cheap (one capture + two regexes per
   *  agent); the real frozen-confirm + scheduling happens in check(). Skips agents already watched or in cooldown. */
  function sweep(agents) {
    if (!Array.isArray(agents)) return
    const t = now()
    for (const e of agents) {
      const agentId = String(e && e.agentId != null ? e.agentId : e)
      if (!agentId || agentId === 'undefined' || agentId === 'null') continue
      const workspace = e && e.workspace != null ? String(e.workspace) : null
      const k = key(agentId, workspace)
      if (recs.has(k)) continue                          // already watching this agent
      if ((cooldownUntil.get(k) || 0) > t) continue      // just resumed it — don't storm
      if (!isLive(agentId)) continue
      const p = safeCapture(agentId)
      if (!p) continue
      // (a0) AUTH failure (not signed in / expired token / no credits) — terminal-only, NOT revivable. Surface the
      // "Not signed in" error and move on (highest priority; no heartbeat gate — the pane text is definitive).
      if (AUTH_ERROR_RE.test(p)) { surfaceAuth(agentId, workspace, k); continue }
      authSurfaced.delete(k) // pane no longer shows an auth error → a future auth episode may re-surface
      // (a) usage-limit-with-reset → schedule a precise resume.
      if (SESSION_LIMIT_RE.test(p) && parseResetAt(p, t) != null) {
        arm(agentId, workspace, 'sweep')
        log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) usage-limited (pane sweep) — arming scheduled resume`)
        continue
      }
      // (b) a CRASHED TURN whose wait-loop heartbeat is already dead: a transient API error (or a rate-limit) felled
      // the turn AFTER its message was delivered+consumed, so onUndelivered never fired and nobody re-delivers it.
      // The dead heartbeat (no /events poll in heartbeatStaleMs) is what separates this from a healthy idle agent
      // (whose wait.sh keeps polling) — arm a recovery so check() probes it back to life instead of silent-forever.
      if ((API_ERROR_RE.test(p) || RATE_LIMIT_RE.test(p)) && t - (lastPollAt(agentId, workspace) || 0) > heartbeatStaleMs) {
        arm(agentId, workspace, 'apierror')
        log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) crashed turn + dead heartbeat (pane sweep) — arming recovery`)
      }
    }
  }

  function arm(agentId, workspace, source) {
    const k = key(agentId, workspace)
    if (recs.has(k)) return // already recovering — coalesce (one wake heals every pending message)
    const t = now()
    const rec = { agentId, workspace, msgTs: t, firstTs: t, tries: 0, timer: null, source }
    // A pane-state arm (sweep / apierror) goes straight to the frozen-confirm (short delay); a message arm gives the
    // agent's own loop GRACE to self-recover first (a healthy loop re-polls within ~1s and delivers it from the log).
    rec.timer = setTimer(() => { void check(k) }, source === 'message' ? graceMs : settleMs)
    recs.set(k, rec)
  }

  async function check(k) {
    const rec = recs.get(k); if (!rec) return
    const { agentId, workspace, msgTs, source } = rec
    // Healthy (message arm only): a poll arrived AT/AFTER the message → wait.sh is alive and already received it
    // (the message is in the event LOG, so any re-poll delivers it). A sweep arm has no pending message — its
    // trigger is the PANE state, and a usage-limited agent can keep a live wait.sh heartbeat while its turn is dead,
    // so the heartbeat must NOT short-circuit it; the pane decides.
    if (source !== 'sweep' && lastPollAt(agentId, workspace) >= msgTs) { setStatus(agentId, workspace, null); return done(k) }
    // Process gone (pane not wired) → terminal-manager auto-restart owns that, not us.
    if (!isLive(agentId)) return done(k)
    // Confirm the pane is FROZEN (stuck at a prompt), not actively working, before deciding. A working agent's
    // spinner/output changes across the settle window; a stuck one is byte-identical (verified on a live agent).
    const a = safeCapture(agentId)
    await sleep(settleMs)
    if (!recs.has(k)) return // cleared while settling
    if (source !== 'sweep' && lastPollAt(agentId, workspace) >= msgTs) { setStatus(agentId, workspace, null); return done(k) } // recovered during settle
    const b = safeCapture(agentId)
    const frozen = !!a && !!b && a === b
    // USAGE / SESSION LIMIT with a known reset time → schedule a precise resume (source-agnostic, highest priority).
    // Must be frozen: never schedule against a moving pane (a reset line scrolled into a working agent's history).
    if (frozen && SESSION_LIMIT_RE.test(b)) {
      const resetAt = parseResetAt(b, now())
      if (resetAt != null) { scheduleResume(k, resetAt); return }
    }
    // From here the recovery is the message-driven nudge ladder. A sweep arm that is no longer a usage-limit (limit
    // cleared, or now working) is not a state we own → drop it; the next sweep re-arms if it stalls again.
    if (source === 'sweep') return done(k)
    // Bound the watch: a never-resolving agent (perpetually changing pane, never polls) is abnormal; stop quietly.
    if (now() - rec.firstTs > maxWatchMs) { log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) gave up after ${Math.round(maxWatchMs / 1000)}s`); return done(k) }
    if (!frozen) { // producing output (or no capture) → treat as working; keep watching, don't inject
      rec.timer = setTimer(() => { void check(k) }, graceMs)
      return
    }
    // STUCK and deaf. WHY it's stuck decides the recovery.
    // AUTH failure first: a 401 / not-signed-in can't be nudged past — surface "Not signed in" and STOP (no ladder).
    if (AUTH_ERROR_RE.test(b)) { surfaceAuth(agentId, workspace, k); return done(k) }
    setStatus(agentId, workspace, 'reconnecting')
    const apiErr = !RATE_LIMIT_RE.test(b) && API_ERROR_RE.test(b)
    if (RATE_LIMIT_RE.test(b) || apiErr) {
      // Transient rate-limit (no reset time): a nudge can't be processed under a 429 and would just re-throttle.
      // HOLD, then PROBE on a long backoff — the first time we only wait (the limit was just hit); after a full
      // backoff we send ONE nudge to test whether it cleared (if so it submits + the agent relaunches its loop; if
      // not it re-dies and we wait again). A transient API error (5xx / dropped connection) is the same shape but
      // retryable IMMEDIATELY (no throttle to wait out), so probe on the FIRST sighting too. Either way NEVER
      // escalate to 'error' — both are transient; keep probing on the backoff until the API recovers.
      const probing = apiErr || rec.rlSeen === true
      if (probing) nudgeSubmit(agentId)
      rec.rlSeen = true
      log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) ${apiErr ? 'API error' : 'rate-limited'} — ${probing ? 'probe nudge' : 'holding'} (backoff ${Math.round(rateLimitBackoffMs / 1000)}s)`)
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

  // Schedule ONE resume for when a usage limit lifts. delay = (reset - now) + buffer, so the limit is fully
  // effective when we type. NOT bounded by maxWatchMs (a multi-hour wait is legitimate, not a pathology).
  function scheduleResume(k, resetAt) {
    const rec = recs.get(k); if (!rec) return
    rec.kind = 'session'
    setStatus(rec.agentId, rec.workspace, 'reconnecting')
    const delay = Math.max(0, resetAt - now()) + resumeBufferMs
    log(`wake-watchdog: agent ${rec.agentId} (${rec.workspace || 'default'}) usage-limited until ${new Date(resetAt).toLocaleTimeString()} — resume in ${Math.round(delay / 1000)}s`)
    rec.timer = setTimer(() => resumeAfterReset(k), delay)
  }

  // The reset time arrived: submit the RESUME directive, then one recheck. If the pane reacted (took a turn) clear
  // the status override. One-shot per arm — the periodic sweep re-arms (after a cooldown) if it is somehow STILL a
  // usage-limit + idle, so there is no tight retry loop here and no per-rec retry bookkeeping.
  function resumeAfterReset(k) {
    const rec = recs.get(k); if (!rec) return
    if (!isLive(rec.agentId)) return done(k)
    cooldownUntil.set(key(rec.agentId, rec.workspace), now() + resumeCooldownMs)
    rec.preResume = safeCapture(rec.agentId)
    log(`wake-watchdog: agent ${rec.agentId} (${rec.workspace || 'default'}) usage-limit reset — submitting resume`)
    nudgeSubmit(rec.agentId, RESUME)
    rec.timer = setTimer(() => {
      const r = recs.get(k); if (!r) return
      const after = safeCapture(r.agentId)
      const tookTurn = !!after && !!r.preResume && after !== r.preResume        // pane changed → the agent reacted
      const polled = lastPollAt(r.agentId, r.workspace) > r.firstTs             // its wait-loop heartbeat resumed
      if (tookTurn || polled) setStatus(r.agentId, r.workspace, null)           // recovered → drop the override
      done(k)
    }, recheckMs)
  }

  // Submit a directive as TWO steps: type the text, then send Enter as a SEPARATE keypress after a short delay.
  // Claude's TUI treats a burst of text-then-newline as a PASTE and keeps the \r as a literal newline (the nudge
  // stacks as unsubmitted draft); a distinct, slightly-delayed Enter is read as a real submit. Verified live: a
  // combined `text+\r` write stacked 3 unsent drafts, while separate text then a delayed Enter submits.
  function nudgeSubmit(id, text = NUDGE) {
    try {
      sendToTerminal(id, text)
      setTimer(() => { try { sendToTerminal(id, '\r') } catch { /* ignore */ } }, submitDelayMs)
    } catch (e) { log('wake-watchdog inject failed: ' + ((e && e.message) || e)) }
  }

  function done(k) { const rec = recs.get(k); if (rec) { clearTimer(rec.timer); recs.delete(k) } }
  function safeCapture(id) { try { return String(captureTerminal(id) || '') } catch { return '' } }
  function sleep(ms) { return new Promise((r) => setTimer(r, ms)) }

  /** Tear down all timers (shutdown). */
  function stop() { for (const k of [...recs.keys()]) done(k) }
  return { onUndelivered, sweep, stop, _size: () => recs.size }
}
