# Plan: self-healing agent wake recovery + stuck-state visibility

## Problem (verified in code)

Agent wake-up is **pull-only and owned by the agent, not the OS**. A user/island message becomes a `trigger:'message'` moment in the in-process feed (`osActions.ts:521 osUserMessage` → `events emitUserMessage`), and the ONLY thing that turns it into an agent turn is the agent's own `.blitzos/wait.sh` long-poll. The bootstrap says wait.sh "is the only way the app delivers messages to you." BlitzOS never pushes.

So if an agent's turn dies before it relaunches wait.sh (rate-limit 429, crash mid-turn, OOM, any cause), the loop is gone, messages pile up unread in the feed + `chat-N.md`, and the agent is **permanently deaf with no OS-side recovery**. `steer` shares the flaw (it also just fires a `/events` moment, "triggers its /events loop"). `tmux-host.mjs write()` → `send-keys` already exists, so the OS CAN push into a pane; the wake path just doesn't use it. This also contradicts the project doctrine (OS owns the scheduler/wake; agent is policy).

Live repro: agent 21 hit `API Error: Server is temporarily limiting requests · Rate limited`, the turn ended, no wait.sh relaunched, process alive at 0% CPU, island shows bare "Idle". Four user messages went undelivered.

## Goal

User types in the island → the agent reliably wakes and replies, even if its wait.sh died. While it's stuck, the island shows the real state (reconnecting / rate-limited), not a bare gray "Idle". The user NEVER touches tmux.

Scope (approved): self-healing nudge (keep wait.sh as the fast path, add an OS recovery net) + bundle in the stuck-state visibility. OS-owned delivery is a possible later follow-up, out of scope here.

## Design — OS-side self-healing watchdog

**Detection (content-agnostic, OS-owned).** A healthy agent keeps a background wait.sh polling `/events` continuously (≤25s long-poll loops, even while working — verified in the bootstrap + `waitForEvents` 25s resolve). So BlitzOS sees a heartbeat poll from agent N every ≤25s. Signal: stamp `lastPollAt[agentId]` on every `waitForEvents` call. The loop is **dead** when an unconsumed message exists for N and `now - lastPollAt[N] > GRACE`. GRACE ~20s (> the 25s poll boundary needs slack; use ~20–30s) so a healthy agent (which re-polls within ~1s and picks the message straight out of the LOG) never trips it.

**Trigger.** On a `trigger:'message'`/`'steer'` moment for agent N that matches ZERO live waiters at `emit()` time, arm a recovery timer. On fire, re-check the dead condition; if still dead AND the process is alive → recover. If a poll arrived in the meantime → cancel (healthy, self-recovered).

**Recovery.** Inject a short, protocol-shaped nudge into agent N's pane via the EXISTING `sendToTerminal(agentId, nudge)` (`terminal-manager.mjs:209` → `host.write` → `send-keys`; agentId == terminal id, window names confirmed `0/20/21/22`). The nudge tells the agent to run its OWN `/events` catch-up and relaunch wait.sh — it self-heals through its existing bootstrap ritual. NO per-task text. The nudge is typed into the REPL only, never appended to chat.md, so it stays invisible plumbing (no fake user bubble).

**Safety / no-hacks.**
- Only inject when no live waiter (no double-delivery with a working loop).
- GRACE window covers the transient gap between wait.sh firing and the agent relaunching it.
- Backoff + cap (e.g. 3 tries, widening interval). If it still won't wake → set island status `error` and STOP (hand to the human/supervisor); never spam send-keys.
- "Process dead" (pane/claude exited, not just the loop) is terminal-manager auto-restart's job — the watchdog only handles "alive but deaf".
- Waiters are workspace-scoped; scope the watchdog per `(agentId, workspace)` identically.
- Clear recovery state when a poll/waiter reopens (agent confirmed back).

**Visibility (bundled — the original filed bug).** While in the dead/recovering state, push a distinct island status `reconnecting` (or `stalled`) instead of `idle`, via the existing status-upsert path. Optional enrichment: `capture-pane` the agent window and grep the `API Error: …` line to label the specific cause (rate-limited / overloaded / server down); fall back to a generic "reconnecting agent". Clear back to the agent's real status once a waiter reopens.

## Seams (verified, file:line)

- `perception-core.mjs`: `waiters[]` (37), `emit()` (189), `waitForEvents` (513), `emitUserMessage` (447). ADD: `lastPollAt[agentId]` stamped in `waitForEvents`; an `onUndeliveredWake(agentId, workspace)` callback fired from `emit()` when a message/steer moment matches no waiter; a `lastPollAt(agentId)` / `hasWaiter(agentId, ws)` accessor. Keep this module PURE (no Electron, no tmux).
- `agent-wake-watchdog.mjs` (NEW, Electron-side): the timer / backoff / inject / clear state machine. Injected deps `{ sendToTerminal, getStatus, setIslandStatus, lastPollAt, hasWaiter, capturePane? }`. No direct imports of tmux/electron internals — all via deps (testable).
- `index.ts`: wire `perception-core.onUndeliveredWake` → watchdog; give it terminal-manager `sendToTerminal`, the per-agent `statusMap` (chat.md tail, ~963/1028), and the island status-upsert. Status vocab at 859–864.
- `island-bridge.mjs` + `notch/IslandPanel.tsx`: add the `reconnecting`/`stalled` status render (distinct dot + label) and map it through `islandStatusToState`.
- `tmux-host.mjs` / `terminal-manager.mjs`: reuse `sendToTerminal` + an optional `capturePane` read; no changes beyond exposing capture if not already.

## Slices

1. **perception-core signal** — `lastPollAt` + `onUndeliveredWake` + accessors. Pure, unit-testable. No behavior change yet.
2. **watchdog + wiring** — `agent-wake-watchdog.mjs` + index.ts: detect → grace → inject nudge → backoff/cap. The core fix.
3. **visibility** — `reconnecting`/`stalled` status end to end (bridge + IslandPanel), cleared on recovery.
4. **(optional) cause label** — capture-pane → specific rate-limited/overloaded/server-down text.

## Tests

- Unit: emit a message for an agent with stale `lastPollAt` (no waiter) → watchdog arms → after GRACE, `sendToTerminal` called ONCE with the nudge (mock host.write, assert text + agent id).
- Unit: healthy agent (fresh `lastPollAt`) → no injection.
- Unit: transient gap (poll arrives within GRACE) → timer cancels, no injection.
- Unit: backoff cap — after N failed tries, status `error`, no further injects.
- Live: kill agent 21's wait.sh, type in the island, confirm it wakes and replies with NO manual tmux. Confirm the island showed `reconnecting` during the gap, then the reply.

## Implementation record (built 2026-06-21)

Slices 1-3 built; `npm run check` green (typecheck + parity + build); watchdog markers confirmed in `out/`.

- **Slice 1 (perception-core.mjs):** `lastPoll` map stamped on every `waitForEvents` (the heartbeat); `lastPollAt(agentId, workspace)` accessor; `setUndeliveredWakeHook(fn)` fired from `emit()` when a `trigger:'message'` moment matches ZERO live waiters. Pure (no electron/tmux). Types in perception-core.d.mts (+ `agentId`/`workspace` added to `BlitzMoment`).
- **capture chain:** `tmux-host.capture(id)` (capture-pane -p) → `terminal-manager.capturePane(id)` → `terminal-ops.captureTerminal(id)` (+ 3 .d.mts). Validated on the live stuck agent 21: an idle claude pane is byte-identical across the settle window; a working one changes.
- **Slice 2 (agent-wake-watchdog.mjs, NEW):** pure state machine. onUndelivered → arm GRACE(20s) → if no poll since the message + pane FROZEN across SETTLE(1.2s) + isLive → `sendToTerminal(id, NUDGE+CR)` → set status 'reconnecting' → RECHECK(25s) → retry; cap MAX_TRIES(3) → 'error'; MAX_WATCH(5m) bound. Coalesces per (ws,id). All I/O injected. `agent-wake-watchdog.d.mts`.
- **Slice 3 (index.ts + IslandPanel.tsx):** `wakeOverride` map + `applyWakeOverride` (self-clears once `lastPollAt` resumes) applied to the `os:agents-snapshot` handler + a `pushIslandStatus` live `os:action{type:'chat',status}` broadcast. `setUndeliveredWakeHook` wired to the watchdog; `before-quit` stops it. Renderer: `statusLabel`/`dotStatus` learn `reconnecting` (pulsing dot + "Reconnecting", not a gray "Idle").
- **Test:** `scripts/tests/test-wake-watchdog.mjs` — 13/13 assertions (nudge on dead+frozen, no nudge when healthy / working / dead-process, backoff cap → error, coalesce).
- **Live proof of the nudge mechanism:** injected the exact NUDGE into the real stuck agent 21's pane → CPU 0.1%→15%, `Ss+`→`Rs+`, it answered the user in chat-21.md, and relaunched its `/events` loop (live 25s long-poll). Build-independent, so it stands in for slice 2's inject step.

### Not done / follow-ups
- **Slice 4 (optional cause label):** shows generic "Reconnecting", NOT the specific cause (rate-limited / overloaded / server-down) read off the pane. Deferred.
- **Automated end-to-end is unproven on the LIVE instance:** the running BlitzOS predates this build, so the fully-automatic path (kill a wait-loop, type in the island, auto-heal with zero manual steps) activates only after a BlitzOS restart. The mechanism + the logic are proven; the wiring takes effect next launch.
- **Live-status flicker (minor):** a `reconnecting` override can be briefly overwritten by an unrelated `os:action{type:'chat'}` broadcast (another agent's activity) until the next nudge re-pushes. The override would need to ride every chat broadcast (an osActions seam) to be flicker-free. Acceptable for V1.

## Fixes after live testing (2026-06-21) — two real bugs found on agent 27

A second deaf agent (27, rate-limited) surfaced two bugs in the first cut; both verified on its live pane and fixed:

- **The nudge never submitted.** `sendToTerminal(id, NUDGE + '\r')` sent the text and CR in ONE write. Claude's TUI treats a text+newline burst as a PASTE, so the `\r` became a literal newline and the nudge stacked as unsubmitted draft (3 piled up on agent 27). Fix (`nudgeSubmit`): type the text, then send Enter as a SEPARATE write after `SUBMIT_DELAY_MS` (450ms). Verified live: a standalone `send-keys -H 0d` submits; the combined write does not.
- **Nudging is wrong for a rate-limit (the dominant deaf cause).** You can't type out of a 429: the agent can't process the nudge under the limit, and submitting just re-throttles. But a deaf agent's loop won't relaunch itself either, so the OS must still wake it once the limit lifts. Fix: `RATE_LIMIT_RE` reads the (already-captured) pane; on a rate-limit the watchdog HOLDS, then PROBES one nudge per `RATE_LIMIT_BACKOFF_MS` (90s), and NEVER escalates to `error` (transient). The non-rate-limit frozen path keeps the fast nudge + `error`-on-give-up. `maxWatchMs` raised to 10 min.

Tests: `test-wake-watchdog.mjs` now 18 assertions (submit = text + separate Enter; rate-limit holds-then-probes, never errors; rate-limit-clears recovers). Live-proven by reviving agent 27.

## Usage/session-limit auto-resume (2026-06-21) — the self-inflicted-stall gap

Two gaps surfaced on agent 31, which hit a **session limit** ("You've hit your session limit · resets 6:40pm") on its OWN turn while finishing a task, then idled. The watchdog never acted, because:

1. **Arming was reactive-only.** It armed solely via `onUndelivered` (a message that reached no waiter). A self-inflicted limit produces NO undelivered message, so nothing armed it. A usage-limited agent can even keep a live `wait.sh` heartbeat (the background poll survives the dead turn), so the heartbeat check would have *cancelled* recovery anyway.
2. **A session limit isn't a transient 429.** `RATE_LIMIT_RE` matched "usage limit" but not "session limit", and even the rate-limit path (probe every 90s, give up after `maxWatchMs` 10 min) is useless for a multi-hour reset. It never parsed the stated reset time and never typed a resume.

**Fix (general, content-agnostic, OS-owned scheduler).**
- **`parseResetAt(pane, now)`** parses the reset wall-clock ("resets 6:40pm") as the machine-local tz (Claude renders it local) and picks the occurrence closest to now (handles the after-midnight wrap + the already-passed→resume-now case). `SESSION_LIMIT_RE` confirms it IS a usage limit; a parseable reset time is what distinguishes it from a transient 429.
- **Scheduled-resume branch** in `check()`: when the FROZEN pane shows a usage limit with a reset time (source-agnostic, highest priority), schedule ONE resume for `reset + RESUME_BUFFER_MS` (NOT bounded by `maxWatchMs` — a multi-hour wait is legitimate). At fire, submit the `RESUME` directive via the same two-step `nudgeSubmit` (text, then a separate Enter), then one recheck that clears the `reconnecting` override if the pane reacted. Never escalates to `error`.
- **`sweep(agents)`** (new, PROACTIVE): the host calls it every 45s (`index.ts`, enumerating `osAgentStatus()` ids × active ws); it peeks each live agent's pane and arms a scheduled resume for any usage-limit-with-reset that no message would surface. A `RESUME_COOLDOWN_MS` (5 min) per-agent quiet window after a resume prevents a storm; the sweep is also the safety net that re-arms anything still stuck. Reactive `onUndelivered` is unchanged; a usage-limit pane reaching it routes through the same scheduled-resume branch instead of the old blind hold/probe.

Tests: `test-wake-watchdog.mjs` now 33 assertions (parseResetAt edges; session limit → scheduled resume submits at reset, never errors; sweep arms a self-limited idle agent + ignores a healthy one; post-resume cooldown; limit-line-in-a-working-pane → no resume). `npm run check` green.

**Live prototype proven on agent 31 (branched session 2136bc34):** a standalone watcher (`/tmp/blitz-autoresume/watch.mjs`, same regex+parser) detected the limit on the live `blitz:31` pane, parsed the 6:40pm reset, and a composer-probe confirmed the keystroke path lands + clears. It is armed (detached) to submit the resume at 6:40:20pm. The model turn itself cannot run before the account-wide limit lifts (a synthetic zero-token "No response requested." confirmed the block at 16:33); the watcher fires the moment it does. Same as the original watchdog, the in-app fix takes effect on the next BlitzOS launch.

**Related gap (noted, not yet fixed):** `agent-interrupt.wasInterrupted` treats `stop_sequence` as a CLEAN stop, but the "You've hit your session limit" assistant message ends on `stop_sequence` — so a restart during a limit window would NOT auto-continue that agent via the boot seam. The sweep covers it instead (a resumed-then-re-limited agent shows the limit pane and gets re-armed), so this is belt-and-suspenders, not load-bearing.

## Open questions

- GRACE exact value (20s vs 30s) — tune against the 25s poll boundary live.
- `reconnecting` vs reusing `error` for the island state — `reconnecting` reads better while the watchdog is actively retrying; reserve `error` for give-up.
- Should the watchdog also cover agent `'0'` the same way (it should — same mechanism, no special-case).
