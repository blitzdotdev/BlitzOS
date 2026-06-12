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
- ⬜ **Push** — 36 commits ahead of (cached) origin/master; user runs `git push origin master` (no SSH key here). If `agent-runtime-moments` has commits newer than the cached `b47dca1`, re-merge the delta.
- ⬜ Optional: simplify the chat widget (`widgets/system/chat.html`) — it still carries the pre-merge multi-session switcher sidebar; per the locked "per-agent widget, no hub" doctrine it could be a single-agent thread. (chat-control now works, so the switcher is functional, not broken — this is a UX call.)

## Persistent constraints (always)
NO git reset/checkout/stash · NO placeholders/secrets committed · Opus subagents only (except ultracode) · no drizzle/prisma · no SSH key here (user pushes) · no time estimates · don't say "let me be more honest" · tmux is a hard dep · run prod backup before any remote deploy · after compaction run `scripts/extract-session-transcript.sh`.
