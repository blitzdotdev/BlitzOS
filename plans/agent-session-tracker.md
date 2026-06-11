# Agent-Session Rebuild — Master Tracker

The living checklist for the BlitzOS agent-session work, so nothing is forgotten. Status: ✅ done · 🔧 in progress · ⬜ todo · 🔴 bug.

## The standing goal (/goal — active)
> every agent session should have a workspace area (like the primary one) associated with it. the agent terminal should be there and other windows agent opens for its work, so they dont interfere with the user's area. every agent should have a name/id so it can be used to resume it. serialization etc should work accordingly. plan for this and implement.

## Everything asked / told (in order) + status
1. ✅ **/goal area-per-session** — session N owns area N; chat + terminal + agent-opened windows land in area N; user's area 0 undisturbed. Planned (workflow) + implemented + chromium-verified. *(uncommitted)*
2. ✅ **"+ New" launcher button** — open a chat session from the UI. Committed `2bc0f59` (you pushed it).
3. ✅ **"i don't see a terminal in the agent workspace"** — diagnosed: the agent was headless. Offered options.
4. ✅ **Chose "Agent runs IN a terminal"** (Option A) — you watch claude work; it /says clean replies to the chat widget.
5. ✅ **"remove all the session and brain stuff and do it properly with all serialization"** — REBUILT: an agent = a claude in a visible tmux terminal in its area; deleted `agent-runner.mjs` + all headless wiring; new shared `agent-session.mjs`. Chromium-verified (terminal renders + /says + no cross-talk; restart reattaches survivors + --resumes a killed agent, no duplicates). *(uncommitted)*
6. ✅ **"is all old code removed?"** — runtime old code 100% gone (zero refs). Vestiges remain (see cleanup below).
7. 🔧 **"is all the UX done properly for user use?"** — assessment + fixes (see UX below).
8. 🔧 **"electron and server in sync? no divergence anywhere"** — launchAgent/boot-resume audited = equivalent; parity green (11 cores). Full adapter audit + Electron path review pending. Electron not live-testable here (no display).
9. 🔧 **"remove obsolete stuff and other brain references"** — cleanup pending (see below).
10. ✅/🔴 **"are all sessions given the agents.md link to fetch/prime/connect?"** — YES, every bootstrap has the url + fetch + /events connect (verified live). **BUT FOUND A BUG** → see 🔴 below.
11. ✅ **"list everything … so we don't forget"** — this file.
12. 🔧 **"and fix all systematically"** — in progress (this tracker drives it).

## 🔴 Bugs found → ✅ FIXED + verified
- ✅ **Stale relay URL on reattach** — the relay re-mints the URL each run; a reattached agent held a dead url → disconnected. **Fixed:** (a) the bootstrap now inlines `$(cat .blitzos/relay-url)` into every curl (BlitzOS writes that file on every url change) so a running agent self-heals mid-run; (b) on boot we **re-exec** every chat agent on the CURRENT url + `--resume` (reattach alone was unreliable — the agent gave up during downtime). Verified: agents reconnect + reply across 2 restarts, no duplicates.
- ✅ **`claudeEstablished` crash-loop** (review blocker, live-confirmed: `--session-id <existing>` → "already in use") — established was only set on a live exit, lost on a crash-while-down. **Fixed:** persist it proactively at 8s of healthy uptime + in `restore()`'s adopt-as-exited path → a re-exec always `--resume`s an established id. Verified.

## 🔧 Remove obsolete / brain references (asked)
- ⬜ `restartBrain` no-op seam — remove from relay.mjs / relay.d.mts / agentSocket.ts / backend.mjs / index.ts (the new url-file self-heal replaces its purpose).
- ⬜ `brain:` status flag (agentStatus + /api/health) + toolbar pill text "Brain connected/Brain link" → rename to "Agent".
- ⬜ `start-all.sh` dead `pkill 'blitz-brain-session'` / `'blitz-session-'` + "brains running" doctor line + comments (the tmux agents have no such marker and MUST survive restart).
- ⬜ `scripts/blitz-brain-poll.sh` — obsolete manual /events poller; remove.
- ⬜ Stale "brain" comments (perception-core, workspace.mjs, backend.mjs). *(workspace `.workspace/*` notes are agent DATA + gitignored — leave.)*

## 🔧 UX for real user use (assess + fix)
- ⬜ Name a session from "+ New" (today → "Chat N" / "Agent N"; goal wants named/resumable).
- ⬜ Close / delete a chat session from the UI (today append-only).
- ⬜ Sessions tray now lists agents + shells together — confirm Open/Resume/Stop are coherent for agents.
- ⬜ Discoverability: after "+ New" the camera follows to the new area — make returning obvious.
- ⬜ Default-off (BLITZ_AGENT unset): sessions persist but no claude runs — is that legible?

## 🔧 Electron ↔ server divergence (full audit)
- 🔧 launchAgent + boot-resume — audited equivalent.
- ⬜ Full audit: every new seam (getUrl, whenRestored, isSessionLive, spawnChatSession focus, the chat-session-spawn IPC vs route, preload vs shim) wired identically; BLITZ_AGENT gate present in BOTH.
- ⬜ Note: Electron mode can't be live-tested in this sandbox (no display) — verify by code parity + the server live test.

## Then
- ✅ Pre-commit review (`rebuild-review`) — found the claudeEstablished crash-loop (fixed) + warnings (folded in).
- ✅ typecheck + parity (11 cores) + build green; re-verified live (server) in chromium.
- ✅ Committed `2826e38` — "agent sessions are serialized tmux terminals in their own areas". USER runs `git push origin master` (ahead 1; 2bc0f59 already on origin).
- ⬜ Remaining: the UX enhancements above + the Electron live test (no display here — server path verified, Electron structurally identical).

## Persistent constraints (always)
NO git reset/checkout/stash · NO placeholders/secrets committed · Opus subagents only (except ultracode) · no drizzle/prisma · no SSH key here (user pushes) · no time estimates · don't say "let me be more honest" · tmux is a hard dep · run prod backup before any remote deploy · after compaction run scripts/extract-session-transcript.sh.
