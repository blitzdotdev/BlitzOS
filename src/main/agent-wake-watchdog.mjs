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
const MAX_TRIES = 3          // nudges before giving up to 'error' (never spam the pane)
const MAX_WATCH_MS = 300_000 // give up watching a never-resolving agent after 5 min (bounds the re-arm loop)

// The catch-up directive typed into a deaf agent's pane. ONE line (no embedded newline) + a trailing CR to
// submit. Phrased in the agent's own bootstrap vocabulary so it self-heals through its existing /events ritual.
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
    maxWatchMs = MAX_WATCH_MS
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
    // STUCK and deaf → wake it.
    rec.tries++
    log(`wake-watchdog: agent ${agentId} (${workspace || 'default'}) deaf — nudge ${rec.tries}/${maxTries}`)
    setStatus(agentId, workspace, 'reconnecting')
    try { sendToTerminal(agentId, NUDGE + '\r') } catch (e) { log('wake-watchdog inject failed: ' + ((e && e.message) || e)) }
    rec.timer = setTimer(() => {
      if (lastPollAt(agentId, workspace) >= msgTs) return done(k)                                  // recovered — the nudge worked
      if (rec.tries >= maxTries) { setStatus(agentId, workspace, 'error'); return done(k) }         // give up — surface + stop
      void check(k)                                                                                // retry: re-confirm frozen, nudge again
    }, recheckMs)
  }

  function done(k) { const rec = recs.get(k); if (rec) { clearTimer(rec.timer); recs.delete(k) } }
  function safeCapture(id) { try { return String(captureTerminal(id) || '') } catch { return '' } }
  function sleep(ms) { return new Promise((r) => setTimer(r, ms)) }

  /** Tear down all timers (shutdown). */
  function stop() { for (const k of [...recs.keys()]) done(k) }
  return { onUndelivered, stop, _size: () => recs.size }
}
