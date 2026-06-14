# Agent OS Command Bar (Spotlight-style direct-to-agent input)

**Status:** Proposed (for review). Not started.
**Date:** 2026-06-06
**Parent:** `plans/agent-os-desktop-architecture.md` (a human -> agent attention bridge, the inverse of the agent -> human bridges in its §0).
**Related:** the autonomy waker / `/events` wake transport (the single, agent-agnostic wake channel).
**Code touched (proposed):** `src/main/events.ts`, `src/main/perception-core.mjs` (+ `.d.mts`), `src/main/osActions.ts`, `src/renderer/src/App.tsx`, a new `src/renderer/src/components/CommandBar.tsx`, `src/preload/index.ts`, `src/main/blitzos-agents.md`.

---

## 1. What and why

A macOS Spotlight-style floating bar in BlitzOS. The human hits a shortcut, types a quick instruction, and it is delivered **immediately** to the connected agent as a **high-priority, explicit directive**. It is the fast "do this now" channel, so the human does not have to find a chat window to redirect the agent.

The key distinction from a perception moment: a moment is something the agent must JUDGE for significance (most do not warrant action). A command is an explicit instruction the agent should ACT on. Same transport, different kind and priority.

## 2. Design principle: ride the one wake transport

The agent is woken only by `/events` (the single, agent-agnostic wake transport hardened in the waker work). A command must arrive there too, so the one waker delivers it and it works for any agent (local, relay, cloud).

A command is therefore a **moment with `trigger:'command'`** that:
- carries the verbatim user text,
- flushes the coalescer **immediately** (the highest-priority flush, ahead of nav/idle/select), so a waiting long-poll returns in well under a second,
- is flagged high priority so the agent treats it as a directive, not as perception to weigh.

Rejected alternative: a separate command endpoint the agent has to poll in addition to `/events`. That fragments the wake and breaks non-Claude and cloud agents. One transport.

## 3. Data flow

1. Renderer: a Spotlight overlay (React), toggled by a shortcut; the human types and presses Enter.
2. IPC `os:command { text }` to main (mirrors the existing surface-action path, `emitSurfaceAction`).
3. Main: `emitCommand(text)` in the perception module builds a command moment and flushes now.
4. `/events` (both `control-server.ts` and `agentSocket.ts`) returns it immediately; the waker prints it; the agent acts.

Moment shape:
```
{ seq, ts, trigger:'command', surfaceId:'os',
  command:"<verbatim text>",
  user:["command: \"<verbatim text>\""],
  priority:'high' }
```
No `snapshot` is needed; it is a directive, not a perception of a surface.

## 4. High priority, and never redacted

- The standing `reminder` and the `blitzos-agents.md` doc gain one line: a `command` moment is a direct, high-priority instruction from the human; act on it first, do not weigh its significance.
- Redaction: perception content is withheld over the relay unless the surface is shared, but a command is the user **intentionally** directing the agent, so command moments are **never redacted** (the user opted in by typing). `redactMoment` passes the command text through.
- Preemption: v1 delivers the command as the immediate next moment (the agent finishes its current tool call, then sees it at the top of the queue). True mid-action interruption is out of scope for v1; noted as a later decision.

## 5. The UI (Spotlight aesthetic)

- A centered floating input with a blurred backdrop, painted above everything as a renderer overlay (not a surface itself).
- "Is an agent actually listening?" BlitzOS knows whether a long-poll is currently open on `/events`. Show that state in the bar (a green "agent listening" vs a muted "no agent connected"). If no agent is polling, the command still queues in `/events` and is delivered when an agent next connects, but the human is told, so a command is never silently lost. This directly honors the request that it go to "the connected agent that is listening."
- Echo: the submitted text shows briefly (a toast, later the activity feed) so the human sees it was sent.
- Single-shot, not a chat. The agent responds by acting (surfaces, journal, a note); a conversational reply UI is a separate, later decision.

## 6. Integration with existing code

- `perception-core.mjs` / `events.ts`: add `emitCommand(text)` that builds the command moment, bypasses the significance gate, and flushes immediately. Add `'command'` to the trigger union (and `perception-core.d.mts`).
- `redactMoment`: let command text through unredacted.
- `osActions.ts` (the mutation chokepoint) or a small main handler: receive the `os:command` IPC and call `emitCommand`.
- Renderer: `CommandBar.tsx` overlay; the toggle keybind added next to the existing Cmd+Z layout-undo handler in `App.tsx`; IPC send exposed via `preload/index.ts`.
- `blitzos-agents.md` + the `blitzos` skill: document the `command` trigger as a high-priority directive. The waker needs no change; it already prints every moment and stays a dumb transport (correct).
- No new agent tool is required; commands arrive through the existing `/events` long-poll.

## 7. Open decisions (for your review)

1. **Trigger key.** Cmd+Space is Spotlight-authentic but collides with the system Spotlight when another app is focused. Since the bar only needs to fire when the BlitzOS window is focused, we can register it as an app-level accelerator (fires only on focus). My pick: **Cmd+K** (no conflict, established command-palette convention), with Cmd+Space available as a configurable option for users who run BlitzOS fullscreen as their primary surface.
2. **Response surface.** Toast only (v1) vs route into the planned activity feed vs a lightweight reply line in the bar. My pick: toast for v1.
3. **Preemption.** Immediate-next-moment (v1) vs interrupt the agent mid-action (later). My pick: immediate-next-moment for v1.
4. **Journaling.** Auto-journal human commands (an audit of directives) vs leave it to the agent. My pick: the agent journals what it acts on; BlitzOS does not need to.

## 8. Risks

- Keybind conflict with the system Spotlight, mitigated by the app-focus-only accelerator (decision 7.1).
- Commands lost when no agent is listening, mitigated by the "agent listening?" state and queue-until-connected behavior (§5).
- Over the relay, a command must not be dropped by content redaction; the unredacted-command rule (§4) covers it, and needs a test so a future redaction change does not silently swallow commands.
