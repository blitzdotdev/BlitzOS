# Transcript audit — 2026-06-07

A 201-agent dynamic workflow re-scanned **every** user ask across the session transcripts (199 distinct
asks) and cross-checked each against the committed code. It flagged **74** items as not-done / partial /
built-but-unverified. Raw machine output: `transcript-audit-2026-06-07.json` (this dir).

Most of the 74 are **duplicates** (the same ask logged from several transcript points) or **already built
this session** (the spatial-model work) and flagged only because there's **no display in the sandbox** to
GUI-verify. Deduplicated and triaged below. The honest split: a handful of real, actionable items; the
rest are your-machine-only confirmations, your-side config, things you already decided otherwise, or the
known feature backlog.

## A. Fixed in this pass (2026-06-07)
- **Agent-link pasted into a plain chat just summarizes instead of acting** (audit #3, #12 — a bug you hit:
  *"those tools aren't available to me in this chat"*). Root cause: the tools are HTTP POST endpoints, so an
  agent with no Bash/curl/code/fetch tool (plain Claude.ai / ChatGPT web chat) can't call them, and the
  README + in-app "Connect AI" panel told you to paste there. **Fixed:** corrected the copy in
  `README.md` + the Connect-AI HUD (`App.tsx`) to say "a tool-capable agent (Claude Code, or `claude -p`)",
  and added a capability-check + graceful fallback line to `blitzos-agents.md` ("Open this link in a
  tool-capable agent…" instead of reciting the doc).
- **"Typing on Google took me back to HackerNews"** (audit #5). Root cause (same class as the geometry
  revert): `surface.url` was never synced when the user navigates a `<webview>`, so the stale url got
  persisted and a reconcile reloaded the page back to HN. **Fixed:** the webview `src` is now set once
  (uncontrolled) so React can't reload it; `did-navigate`/`did-navigate-in-page` fold the live location
  into the store; agent/programmatic nav goes through `loadURL` only when the store diverges; and
  `applyReconcile` keeps the live url for web/app. Headless-proven in `scripts/test-window-system.sh`.

## B. Your action — I can't do these from here
- **Push / re-sync to origin** (audit #1, #2, #11). No SSH key in this sandbox (`git@github.com … Permission
  denied (publickey)`); commits are local-only until you `git push origin master` from your machine.
- **Discord OAuth "invalid oauth2 redirect uri"** (audit #10, #22). The redirect URI is fixed at
  `http://127.0.0.1:8723/callback` (use `127.0.0.1`, not `localhost`) — it must be registered on the Discord
  app's OAuth settings. This is provider-side config, not a code bug.
- **cloudflared service install** (audit #41) — a one-time host setup you ran with your tunnel token.

## C. Not a gap — you already decided otherwise
- **Zero-copy streaming to the mission-control preview cells** (audit #9, #18, #56). You asked, weighed it,
  then said **"do screenshots"** — screenshots is the chosen implementation, not a missing feature.

## D. Built this session — awaiting your Mac GUI to confirm the *feel*
There's no display in the sandbox, so I prove logic headlessly but can't see pixels. All of these are built
and typecheck/build-clean; they need `npm run dev` on your Mac to confirm:
- Control mode (own viewport, animated enter/exit, **remembers its viewport** now), drag-cards-not-interact,
  blue indicator position/z/thickness, control-mode zoom level (audit #59–63, #69–70).
- Window snapping = macOS halves + quarters, **no full-screen** (the rewrite), resize from all sides/corners,
  no bottom-right grip arrow (audit #62, and this session's #49).
- Eye/share button prominence (#66, #74), chat text user-select (#64, #72), primary area = screen-size (#65,
  #73), Chrome back/forward gesture suppressed via `overscroll-behavior:none` (#71), window-management as an
  agent prompt + chat pinned on top (#67).
- Mission-control "only one workspace covers the screen" + create-input not hidden by the top bar (#57, #68)
  — partially addressed; worth a GUI pass.

## E. Feature backlog — discussed, not yet built (need your go-ahead / priority)
- **Multiple workspace areas** (macOS Spaces). Design in `plans/multiple-workspace-areas.md`. Task #45.
- **Multiple folder kinds** — a normal folder vs a special `.app`-style folder whose subitems live on the
  canvas (audit #7, #16).
- **Persist consent** (you said "yes") — lands in agent-read-denied `.blitzos/state/consent.json` (audit #8,
  #17).
- **Message data resources** — `gmail/messages`, `discord/messages` in the widget `PROVIDER_DATA` allowlist so
  the agent can actually build an "unread messages" widget (today only `discord/guilds` + `github/repos`
  exist) (audit #4, #44). You said "nevermind" at the time, but it's the obvious next data resource.

## F. Process / ongoing (not discrete deliverables)
"Stop deferring", "look for duplication/inconsistencies", "verify your work", "update working-stream",
"compare to claude-mono", "research more professions" — these are working-style asks, largely satisfied and
ongoing (the professions catalog exists; working-stream is updated each chunk; the merge-cleanup was done).
