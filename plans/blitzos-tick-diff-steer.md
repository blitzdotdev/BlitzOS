# BlitzOS — W2 (E2): Tick → Diff → Steer supervisor heartbeat (Option A)

Status: SPEC FOR REVIEW. Companion to `plans/blitzos-user-journey.md` (E2); feasibility verified on `agent-runtime-moments-brandon-spatial-merge`. Scope: `srcdoc` / `app` / `native` widgets only. The `web`/browser/CDP path is OUT (browsers are being removed); plan perception for our own surfaces.

## The model (plain)
Every ~N seconds a host-side heartbeat ("tick") snapshots the whole desktop (every widget's content + every agent's state), diffs it against the prior tick, and emits only what CHANGED as a perception moment that wakes a supervisor agent. The supervisor decides whether to nudge ("steer") a running Job. Canonical example: the user edits a textbox in the `srcdoc` plan widget, its content changes, the tick's diff carries it, the supervisor steers the agent implementing the plan.

## Option A boundary (load-bearing)
BlitzOS only ticks, diffs, and emits the material diff as a `trigger:'tick'` moment. The AGENT owns ALL steering judgment. ZERO per-task/stuck/threshold heuristics in the OS.

## What the tick diffs (one unified world snapshot)
The host (main) computes, each tick, a diff over:
- WIDGET CONTENT (the user-action half): each `srcdoc`/`app`/`native` surface's content, captured as a snapshot in `props` (see P0). A user edit shows up as a `props` delta. No `web` surfaces.
- AGENT STATE: per-agent status (`working/waiting/stopped/error`), terminal exit + `exitCode`, new/closed agents.
- GEOMETRY: surface open/close/move (the existing `diffCanvasOps` shape, `osActions.ts:663`, today geometry-only).
- CONTEXT: active workspace + focus (`activeSurfaceId`), **action-items** (pending human actions, `osActions.ts:864`), new chat messages.
- SESSION POINTERS: per agent, the path to its full session JSON so the supervisor can drill in (see below).
Materiality early-return: an empty or immaterial diff emits NOTHING (a quiet desktop never wakes the supervisor; mirrors `if (!p.hasUser) return`, `perception-core.mjs:213`), with a filter so animation / JS churn does not count.

## P0: get content out of a sandboxed widget by SNAPSHOT, not input-recording
A sandboxed `srcdoc` iframe cannot be read from outside (no same-origin; `iframe.contentDocument` throws), so a snapshot needs in-iframe code. Use a CONTENT SERIALIZER, not an event recorder:
- Extend the existing widget bridge (`widget-bridge.ts`) with a snapshot reporter: on change (a debounced MutationObserver + `input`), serialize the widget's content (form values + innerText) and push it into the surface's `props` via the bridge `setprops` op (`SurfaceFrame.tsx:577`).
- Cooperative widgets (the plan widget) already push content via `blitz.setProps`, so they are free.
- `native` (notes/chat): read content from the renderer/store; no injection.
- `app` iframes: the same bridge reporter (when same-origin/cooperative).
All widget content thus lives in `props`. Snapshot beats recording here: it captures the RESULT (the new content the supervisor needs to steer on), is content-agnostic (matches the dumb-but-rich doctrine), and catches JS/async changes a keystroke listener misses. (Same idea as the moment `snapshot` field already uses for content.)

## The diff is computed HOST-SIDE (load-bearing)
`props` are in `cached` (host-readable) but STRIPPED from the agent's `list_state` (`os-tools.mjs:101`). So the differ MUST run in main; an agent polling `list_state` would be blind to exactly the widget content. The agent only RECEIVES the host-computed diff, it never computes it.

## Delivery (DECISION)
- (A, recommended) The OS emits a `trigger:'tick'` moment every N seconds (carrying the host diff) into `/events`; the EXISTING `wait.sh` delivers it. No new script; supervisor='0' routing is already free (`visibleTo`, `perception-core.mjs:52-60`).
- (B) A new `/tick` endpoint returns a richer host-computed payload (full content diff + agent list + session diffs + JSON paths) that the agent pulls on a timer.
- Monitor reference (to get it right): BlitzOS wakes the agent via Bash `run_in_background` (`wait.sh` exits-on-event, agent relaunches), NOT the Monitor tool (`agent-runtime.mjs:88`). For (B)'s fixed cadence the **Monitor tool** (a persistent `while …; sleep N; emit; done`, one stdout line per tick) is the cleaner primitive; a `run_in_background` `tick.sh` must `sleep N -> fetch -> print -> exit -> relaunch` each cycle. (A) needs neither.

## Agent list + session pointers (verified locations)
- Active agents + status: `/list_terminals` (id, title, status, `exitCode`, `agentRuntime`, stage) + per-agent `<ws>/.blitzos/terminals/<id>/meta.json` (`claudeSessionId`) + host `chatStatus`/`chatHubProps` (`sessions[]` with `lastMessagePreview`, `updatedAt`).
- Full session JSON: `~/.claude/projects/<workspacePath with / and . turned to ->/<claudeSessionId>.jsonl`; exporter `scripts/export-agent-session.mjs <sessionId>` writes `tmp/agent-sessions/<id>.md`; human-readable `<ws>/chat-<id>.md`; richest is the session tape `<root>/.blitzos/tape/`.
- Cheap per-tick session "diff": offset-tail `<ws>/.blitzos/terminals/<id>/transcript.jsonl` (the tape's `model.io` already reads by byte offset), or the `activity.mjs` feed (one line per meaningful action), or compare `chatHubProps` `updatedAt`/status between ticks. No full JSONL re-parse each tick.

## New pieces (the build)
The bridge content-snapshot reporter (P0); `emitTick()` + a `setTickSource(fn)` seam (host-side; perception-core never imports osActions, mirror `setWorkspaceProvider`); the host-side prop+status+context differ with the empty-diff early-return + materiality filter; a `chatStatusSnapshot()` host accessor; a `redactMoment` tick branch; a `/steer {agent,text}` -> `emitUserMessage` call-site; an echo/bulk self-reaction guard (reuse `canvasBulkAt`).

## Sign-off decisions
1. P0 mechanism: bridge content-serializer -> `props` (srcdoc/app) + store read (native). No web/CDP. Recommend.
2. Delivery: (A) OS-emit into `/events` (recommended) vs (B) a `/tick` endpoint + `tick.sh`/Monitor.
3. NEW perception primitive `setTickSource`+`emitTick`+`trigger:'tick'`. Recommend add.
4. Cadence `TICK_MS` (tunable; ~10s for steering, distinct from W3's 2-minute summary).
5. Host `chatStatusSnapshot()` accessor. Recommend yes.
6. `/steer {agent,text}` tool (`/say` does NOT wake the target; `/user_say` is relay-blocked). Recommend yes.
7. Does a tick carry edited CONTENT over the relay (then `redactMoment` must redact it) or only "surface X changed" flags + `get_surface`/session paths? Lean: flags + pull (relay-safe, metadata-light).

Risks: layering (inject, never import); spam (empty-diff early-return + materiality filter); self-reaction (steer-echo + bulk suppression); attribution (a snapshot cannot tell user-vs-JS, add a light event signal only if needed); privacy (content over the relay, decision 7).

Sequencing: P0 bridge snapshot reporter -> host status/content accessors -> `setTickSource`+`emitTick` -> the differ + materiality + early-return -> cadence -> redact branch -> echo guard -> `/steer`. Then pick delivery (A)/(B).

Cross-references: `plans/blitzos-user-journey.md` (E2) · `plans/blitzos-job-task-model.md` (the Job being steered) · `plans/blitzos-plan-widget.md` (the srcdoc plan widget whose edits drive steering) · `plans/blitzos-agent-autonomy-guardrails.md` (E1 self-drive) · `agent-os/CLAUDE.md` "Agent runtime" (its web-only perception is replaced here by the bridge snapshot over srcdoc/app/native).
