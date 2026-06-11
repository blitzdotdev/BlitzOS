# Agent-Session (Terminal/Agent) Rebuild — Master Tracker

> **VOCABULARY (current):** the primitive is a **Terminal**; an **Agent** = a Terminal running `claude` + a chat widget. "session" is the OLD word (renamed deeply: `session-manager`→`terminal-manager`, `spawn_chat_session`→`spawn_agent`, kind `pty`→`terminal`). "areas" were renamed to **stages** (`areaForSession`→`stageForAgent`, `areaCount`→`stageCount`). All renames are EXECUTED + committed — see `plans/terminal-agent-rename.md` and `plans/merge-stages-reconcile.md`.

Living checklist. Status: ✅ done · 🔧 in progress · ⬜ todo · 🔴 bug.

## The standing goal (delivered)
> every agent owns a workspace stage; its terminal + the windows it opens live there (not the user's stage); every agent has a name/id and resumes; serialization round-trips a restart.

All of the above is **done, committed, and chromium-verified** (server mode). Electron runs the identical shared-core code but has no display here to test pixels.

## Everything asked / told (in order) — final status
1. ✅ **Stage-per-agent** — agent N owns stage N; chat + terminal + agent-opened windows land there; user's stage 0 undisturbed. (committed)
2. ✅ **"+ Agent" launcher + "+ Terminal"** — open an agent (claude+chat) or a plain shell, separately, from the toolbar + the tray. (committed `2bc0f59` + later)
3. ✅ **Agent runs IN a visible tmux terminal** (you watch claude work; interactive TUI, no `-p`); /says clean replies to its chat widget. (`4c0c641`)
4. ✅ **Removed all brain/headless code, rebuilt on tmux** — `agent-runner.mjs`/`session-dispatch.mjs` deleted; new shared `agent-runtime.mjs`; full serialization (reattach survivors + `--resume` dead agents, no duplicates). (`2826e38`)
5. ✅ **All old code removed** — zero refs to `startAgentRunner`/`BRAIN_MARKER`/`chatRunners`/`restartBrain`/`session-manager`/`areas-core`/`spawnChatSession` (grep-verified 2026-06-11).
6. ✅ **UX for real use** — separate +Terminal/+Agent; **Terminals & Agents tray** (two groups, Open/Stop/Resume/Remove/Delete); inline **rename**; **close/delete** (primary '0' guarded everywhere); resume-on-reload. (`08bbd85`, `ae0bc3a`, `cd19983`, `a5ffbb6`)
7. ✅ **Electron ↔ server: no divergence** — every runtime seam (launchAgent/stopAgent/setRelayUrl/resumeAgentsOnBoot/whenRestored/setBootTaskProvider, spawn/close/rename agent, removeTerminal, the slot tools, action-items) wired in BOTH transports; parity green (11 cores). Re-audited 2026-06-11 (28-agent adversarial sweep): 0 structural breaks. **Caveat:** Electron can't be live-tested here (no display) — verified by code parity + the live server path.
8. ✅ **Remove obsolete/brain references** — `restartBrain` seam gone; `brain:` status flag → `agent:`; `start-all.sh` dead pkills + `blitz-brain-poll.sh` removed; stale code comments scrubbed.
9. ✅ **Sessions get the agents.md link + connect** — every agent's `bootstrap.txt` carries the manual url + fetch + `/events` connect loop; the relay url is a self-healing file (`.blitzos/relay-url`) re-read per curl. Verified live.
10. ✅ **Stage-slot desktop merge** (`agent-runtime-moments`) — stages vocabulary + slot lattice (`place_widget`/`bring_to_stage`/`send_backstage`) + per-agent chat widget (no hub). (`e83f7c4`)

## 🔴 Bugs found → ✅ FIXED + verified
- ✅ Blank terminal (`-p` silent) → interactive TUI.
- ✅ Stale relay URL on reattach → re-exec on current url + `--resume` + the relay-url self-heal file.
- ✅ `claudeEstablished` crash-loop ("already in use") → persist proactively (8s) + in `restore()`.
- ✅ Agent died + stayed dead → auto-restart with backoff (`4611bb5`).
- ✅ **"still dont see anything in the term"** (`332b4b2`) — reproduced live: claude WAS drawing its TUI in tmux, but the terminal SURFACE was blank because terminal tabs are renderer-only (not in osState) and AGENTS were skipped in both reconstruction paths (terminal-spawn replay + boot reconcile) — so an opened agent terminal came back tab-less/blank on reload. Fix: reconstruct a tab for EVERY live terminal incl agents (an agent IS a terminal you watch work) via the proven openTerminal path; `pruneEmptyTerminals()` drops any leftover blank window. Verified live: both agents' claude TUIs auto-show + survive reloads. drive-terminals/drive-tabs updated for the new model.

## 🔧 ACTIVE — runtime-surface-loss fragility (fixing now)
- **Runtime surfaces can be clobbered out of osState.** During heavy live test churn (15+ reloads) the primary **chat WIDGET surface** ("chat") vanished from Home's osState (the chat DATA was safe — `chat.md` intact). Worse: it bit the Home cleanup — `close_surface` on the junk panels kept losing to an osState re-sync race (each round removed ~3, then they reappeared), so the junk only cleared via a full stop→clean-on-disk→start. Root cause: a renderer `sendState` (`os:state`) overwrites osState, and a renderer that hasn't reconstructed the runtime surfaces (chat/activity/terminal/inbox — they're never serialized) pushes a list WITHOUT them → the host adopts it and they're gone until the next hydrate/switch (which rebuilds via `buildAgentSurfaces`). **Fix plan:** on every renderer state-push, the host must RE-ASSERT its runtime surfaces (never let an inbound push delete a chat/activity/terminal/inbox surface the host owns) — the same isRuntime predicate already used by the reconcile invariant. Verify: a page reload / state-push can never drop the chat widget; `close_surface` of a file-backed surface sticks (no re-sync resurrection).
- ✅ **Home test-junk cleared** (this turn) — 13 junk srcdoc panels + the test agent "Chat 1" removed via a stop→clean-on-disk→fresh-start; primary `chat.md`/Notepad preserved; agent 0 `--resume`d + replied `PONG-FRESH-9090` in 5s; its terminal auto-shows claude on the clean board. (The restart was forced BY this fragility — the cleanup proves the fix is needed.)

## 2026-06-11 review pass (this session) — verified + fixed
Ran a full verified audit (gates + 5/6 live drive tests + a 28-agent adversarial sweep). Green baseline: typecheck · parity (11) · build · `test-stage-core` 238/0 · `test-stage-e2e` 24/0 · `drive-terminals`/`drive-stages`/`drive-tabs`/`drive-newchat`/`verify-real` all PASS live. Real findings fixed:
- ✅ **`electronOps.say` dropped the `workspace` arg** the shared handler passes (server honored it) → threaded it (`osSay` already supported it). [divergence]
- ✅ **`os:chat-control` had no handler/shim** — `blitz.chat('new'/'rename')` in the chat widget was dead in BOTH transports → wired to `osSpawnAgent`/`osRenameAgent` (Electron `ipcMain.handle('os:chat-control')` + shim `chatControl`). [broken-code]
- ✅ **Electron hydrate `mode` fallback was `'desktop'`** vs server `'canvas'` (both hosts canvas-first) → `'canvas'`. [divergence]
- ✅ **`claudeEstablished` narrow create-mode race** (survivor restarted in the <8s window) → deterministic backstop: `ensureClaudeSessionId` also treats the agent as established when claude's conversation jsonl already exists on disk (encoding verified against the live store). [correctness]
- ✅ **`InboxPanel` ActionItem type said `sessionId`** but the producer emits `agentId` → renamed (was never read). [vocabulary]

## ⬜ Remaining (not blocking)
- ⬜ **Electron live test** — needs `npm run dev` on a Mac (no display in this sandbox). Code is parity-identical to the verified server path.
- ⬜ **Name-on-create prompt** for +Terminal/+Agent (today: auto-named + rename-after). Optional UX.
- ✅ **`drive-inbox` is now self-contained** — it resets the live inbox, seeds 2 items via the real relay `request_action` path, verifies resume/badge/Done/choose/Clear, and resets to empty. PASS live; leaves Home clean. The whole drive suite (terminals/stages/tabs/newchat/inbox + verify-real) is green everytime.
- ✅ **Stale plan docs handled** — `onboarding-case-file.md` (live-code spec) had its deleted-seam names corrected to `agent-runtime.mjs`/`setBootTaskProvider`/`terminal-manager.mjs`; the aspirational docs (`guardian-angel-blitzos.md`, `blitzos-visceral-loop.md`, `session-tape-and-daydreaming.md`) and the pre-rename `multiple-workspace-areas*.md` got a dated ⚠️ banner mapping `agent-runner.mjs`/"areas" onto the current model. `working-stream.md` left as a dated historical log (it self-corrects).
- ⬜ **Push** — user runs `git push origin master` (no SSH key here). If `agent-runtime-moments` has commits newer than the cached `b47dca1`, re-merge the delta.
- ⬜ Optional: simplify the chat widget (`widgets/system/chat.html`) — it still carries the pre-merge multi-session switcher sidebar; per the locked "per-agent widget, no hub" doctrine it could be a single-agent thread. (chat-control now works, so the switcher is functional, not broken — this is a UX call.)
- ⬜ **Decision: primary agent's terminal** — `332b4b2` auto-shows EVERY agent's terminal incl the primary (0), so its raw claude TUI now sits in the user's home stage 0 alongside the chat. That's what makes "see the terminal" work, but it can clutter the primary view — if unwanted, keep primary opt-in and auto-show only sub-agents (id≠0). Awaiting the user's call.

## Persistent constraints (always)
NO git reset/checkout/stash · NO placeholders/secrets committed · Opus subagents only (except ultracode) · no drizzle/prisma · no SSH key here (user pushes) · no time estimates · don't say "let me be more honest" · tmux is a hard dep · run prod backup before any remote deploy · after compaction run `scripts/extract-session-transcript.sh`.
