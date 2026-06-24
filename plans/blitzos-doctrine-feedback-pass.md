# Doctrine feedback pass + browser-path overhaul (pre-publish)

Applies the `doctrine-review.md` feedback (recovered from commit `d9b1135`) plus the browser-path decisions that
came out of testing with a live BlitzOS agent. **Base = fresh branch `bv1-doctrine-pass` off `origin/blitz-v1`**
(backup of prior local work at `wip/pre-doctrine-sync`).

## Decisions locked (with the user)
- **Blitz Chrome is the PRIMARY browser** (extension-free, CDP, background, per-agent window, persistent cookie jar).
- **The connector extension is DEPRECATED and NOT shipped.** Remove its tooling + force-install; stop recommending it.
- **Fallback = the user's own browser via the Apple-Events JS bridge** (extension-free): Safari already has it; build
  the Chrome equivalent. Add the one-time "Allow JavaScript from Apple Events" toggle as an onboarding step.
- **Peer cut:** remove `spawn_agent` / `broadcast` / `close_agent` / `rename_agent`; KEEP `steer` + the tick + agent
  `'0'` as supervisor (steer a stuck agent, as today). Keep the underlying spawn/close/rename ops for the island tabs.
- **Done already:** `EVENTS_REMINDER` rewritten canvas-free + em-dash-free.

## MUST-FIX: doctrine consistency (decided in review — do these FIRST; not browser)
These cause wrong agent behavior or reference cut things. All are agent-facing.

**Status (bv1-doctrine-pass):** DONE = no-greeting + reactive Identity + canonical Permissions (intro), same Permissions in
`orchestrator.md` + leaf metadata, `EVENTS_REMINDER` canvas cut, the reactive "Talk in chat" line, the `BLITZ_DUTY` reactive
rewrite (act only on request, + canonical permissions), the `/events` + `list_state` desc canvas cut, `set_orchestrators`
`llm()`→`agent()`, and the `open_terminal` + `connection_reveal` "surface" wording. Verified: os-tools imports, review doc
regenerates clean (16 surfaces), stale refs (get_surface / snapshot-of-the-surface / build-arrange-surfaces / llm()) all 0.
Surface 11 (`blitzos-onboarding.md`) DELETED. Browser-rule consolidation DONE by the feature build (manual line 48).
STILL DEFERRED (structural / other domain): the `list_state` `surfaces` SERIALIZER (`os-tools.mjs:93` — it projects LIVE
chat/terminal panels, not just dead canvas, so cutting needs a consumer check); removing the dead `connection_open_browser`
/ AI-Chrome tool (browser/feature-build domain — a tool+op removal, still present at `:615`); and the harmless always-false
`--prompt` ref to the deleted onboarding doc in `onboarding.ts:637`.

- **No greeting, ever.** Delete "Greet them in one line, then begin acting as BlitzOS." (`blitzos-agents.md:161`). The
  manual currently tells the agent to greet, which contradicts the resident duty (and caused the open-ended-greeting bug).
- **One proactivity stance: act ONLY on a user request.** The doctrine pulls four ways; collapse to one. Remove
  "continuously and proactively" (identity, `:164`), the resident-duty "propose work the user did not ask for / start an
  initiative immediately" language (item 8), and "Don't sit idle waiting for a moment" (`:183`). Keep: do what the user
  asked, then stay quiet (the autonomy loop's "most moments don't warrant action" is correct). Canonical line ≈ the
  bootstrap's "don't act unless the user asked," reworded positively.
- **One permissions stance: default to DO everything; ask ONLY before a destructive / irreversible act.** Reversible
  work (research, drafting, staging, file edits) needs NO permission. Ask only before: messaging/posting to another
  human, force push, delete, deploy, spend, account actions. Replace the THREE divergent act-vs-ask lists (leaf
  metadata `:792`, `orchestrator.md:653`, the resident duty) and the manual veto line with this ONE phrasing.
- **`/events`: KEEP, fix the stale description.** It is the core wake loop (the on-connect read + `wait.sh` long-polls
  it). Only its tool desc (`os-tools.mjs:258`) is stale: strip "snapshot of the surface", "surfaceId", and "build/arrange
  surfaces to help"; match the manual's correct moment shape (`{seq,ts,url,title,trigger,signals,user[],snapshot}`).
- **Canvas: cut COMPLETELY.** Hard (cut-canvas concept / cut tools):
  - `list_state` (`os-tools.mjs:84-95` serializer + comments, and desc `:236`): drop the `surfaces` array and every
    reference to `get_surface` / `update_surface` / `read_window` / `surface_control` / `create_surface` / `open_window`
    (all cut). `list_state` returns the workspace path; it should not advertise a canvas.
  - `/events` desc (above) and `orchestrator.md:103` "file/surface edits".
  - Reword off "canvas/surface": "canvas-app" (`blitzos-agents.md:68`, `connection_open_browser:676`), "terminal surface"
    (`open_terminal:461`), "surface BEHIND a connection" (`connection_reveal:747`, `request_handoff:759`) → window / tab / panel.
  - LEAVE the verb "surface" = to bring up (`request_action` "Surfaces as a card", "Surface nothing unprompted", "surface
    the claim URL"). That is not the canvas.

## Non-critical cleanup (stale + redundancy) — one sequential pass AFTER the feature build settles
The working tree is hot (the feature build has ~18 files modified, the Chrome adapter built, `interview.md` deleted), so
do not co-edit. These are recorded for a clean follow-on pass.

### Stale / deprecated
- `list_state` "use `get_surface`" + "open surfaces" + the `surfaces` serializer, and `/events` "surfaces/surfaceId/
  build-arrange surfaces" → already in the MUST-FIX canvas cut. `orchestrator.md` "file/surface edits" → DONE.
- `set_orchestrators` desc (`os-tools.mjs:398`): "plain-Node programs whose **llm()** spawns…" → rename `llm()` to
  `agent()` (llm is the legacy alias). Minor wording.
- **Retire surface 11 (`blitzos-onboarding.md`) — DONE (deleted).** Removed the file + its entry in
  `build-doctrine-review.mjs` (review doc regenerates clean: 16 surfaces). The scan tolerates the missing file
  (`--prompt` is optional; `onboarding.ts:637` guards it with `existsSync`). Residual: that guarded reference in
  `onboarding.ts` is now always-false dead code — harmless, clean it in the sequential pass (contested file).

### Redundancy — DECISION (user): consolidate the BROWSER RULES ONLY
- **DO: the browser/connection discipline** (JS-world, `run_js`, bank tools, never click/AX a web page). Centralize ONE
  canonical block (the "Your browser is Blitz Chrome" section) and have the connection tool descs POINT to it ("same
  discipline as your browser"). This is the real drift hazard (the browser flip touched ~6 places). Fold into the
  feature-build's browser restructure, which is already moving these exact lines (it has flipped the section to primary).
- **LEAVE duplicated (user's call):** the show-me / screenshot block, the "run_workflow not blitz run" rule, the
  never-go-dark one-liners, share_app/no-URL, concurrency-cap-8. They stay fully written in each spot.

## Work (ordered)

### 1. Build the Chrome Apple-Events JS adapter (`connection-chrome-applescript-link.mjs`)
Mirror `connection-safari-link.mjs`. FOCUS-SAFETY IS THE WHOLE POINT (empirically measured by a live agent):
- `execute javascript` for read / run_js: 0/50 stole focus. Enumerate tabs via `tabs of windows`: clean.
- **Navigate via `execute javascript "location.href=…"`, NEVER AppleScript `set URL` / `make new tab` / `open`**
  (those stole focus ~14/46 ≈ 30%). location.href injection was 0/55 and loads the page fine.
- Cold-start caveat: opening a site with NO existing tab needs `make new tab`/`open`, which steals. Pattern: reuse an
  existing tab + navigate via JS; treat a cold tab-open as a one-time explicit foreground action (document it).
- Pass JS as an osascript ARGUMENT (item 1 of argv), like the Safari link, so there is no escaping to get wrong.
- Wire it in `index.ts` next to the Safari link; surface Chrome tabs through `connection_list_tabs` (browser tag) so
  `connection_connect_tab` / `connection_run_js` work on Chrome extension-free.

### 2. Onboarding step — enable Chrome "Allow JavaScript from Apple Events"
Add to the permission/TCC onboarding sequence (`onboarding.ts` + `IslandOnboarding.tsx`): Chrome ▸ View ▸ Developer ▸
"Allow JavaScript from Apple Events" + the Automation grant, same class as Safari's Develop-menu toggle.

### 3. Audit the Safari link for the same latent focus-steal
Check whether `connection-safari-link.mjs` navigates via `set URL of current tab` (likely steals) vs `do JavaScript`.
If it uses `set URL`, route navigation through `do JavaScript "location.href=…"` too. Verify with frontmost sampling.

### 4. Browser doctrine flip (`blitzos-agents.md` + a few files)  [prose already signed off, minus the fixed fallback]
- New primary section "Your browser is Blitz Chrome" promoted above Connections.
- Identity line → Blitz Chrome. Fold "Web research" into the Blitz Chrome section.
- Handoff bullet: `request_handoff` pops the card, `resolve_handoff` confirms + dismisses it.
- "Get the user signed into their work apps in Blitz Chrome once" nudge.
- FALLBACK section (now TRUE): the user's own browser via `connection_connect_tab` (Apple-Events JS bridge, Safari +
  Chrome, extension-free); drop the false "window variant" for a browser (window = native apps only). No extension.
- Flip the `say` tool description + the bootstrap web fragment (`agent-runtime.mjs`) from "user's browser" to Blitz Chrome.

### 5. Deprecate the connector extension (code + doctrine)
Remove/retire: `connection_install_extension` tool, the `connection-install.ts` force-install, the extension `tabLink`
in `index.ts`. Repoint `connection_list_tabs` / `connect_tab` to the Apple-Events links (Safari + Chrome). Stop bundling
the `extension/` dir. Scrub the extension from doctrine.
- **BUG (user-reported): dragging Chrome into the attach dropbox ERRORS when the extension is absent.** The
  drag-to-connect path assumes the connector. Remove ALL extension-dependent logic from the attach/drag flow and
  fall back to the Chrome Apple-Events adapter (item 1): a dragged Chrome window/tab must connect via AppleScript,
  never hard-fail on a missing extension. (Trace the drag-drop handler + `connection-window-link` / the picker that
  feeds the dropbox.)

### 6. Peer cut
Remove tools `spawn_agent` / `broadcast` / `close_agent` / `rename_agent` (os-tools.mjs). KEEP `steer` + tick + the
supervisor paragraph (reworded, no spawn). Keep the underlying ops for the island tabs + `start_workflow`. Drop the
"instead of / not spawn_agent" refs in `start_workflow` + `orchestrator.md`. `supervise-tick` builtin stays (steer stays).

### 7. Dedup the orchestrator paragraph
Collapse the duplicated "PURE ORCHESTRATOR / build ZERO parts" block (in "Keep the user posted" + "Build deliverables")
into one pointer to the Workflows section; reword "spawn N sub-agents" → "author a `run_workflow` fan-out."

### 8. Onboarding merge (resident-only)
One resident-only `BLITZ_DUTY` (no interview / cards / greeting / chat switching) + the Blitz Chrome login nudge;
`interviewBootTask()` returns it. Delete `blitzos-interview.md` + its `electron-builder.yml` entries. `agent-runtime.mjs`
resident effort only. Carry the `messageParts.ts` card-parser fix + the `fresh-onboarding-dev.sh` clean-slate hardening.

## Verify (the gate)
`npm run check` (typecheck + parity + build); `test-agent-session`; `test-notch-hit-window`; a Chrome-adapter focus test
(frontmost sampling while read/navigate); regenerate `doctrine-review.md`; headless boot smoke. Visual sign-off is the user's.

## Additional bugs found (doctrine review pass — flag only, fold into the steps above)
- **N0 (user-reported, see item 5): drag Chrome into the attach dropbox with no extension → errors.** Strip extension
  dependence from the drag/attach path; route to the Chrome Apple-Events adapter.
- **N1. TWO overlapping agent-browser tools.** `connection_open_browser` ("AI Chrome", os-tools.mjs:634, op
  `connectionOpenBrowser` → `connection-tab-link.mjs` `openAgentWindow`) needs a CONNECTOR loaded (returns
  `{needsSetup}`) and overlaps `blitz_chrome_open` ("Blitz Chrome", 663, extension-free). An agent sees both in
  tools.json and can pick the dead one. REMOVE `connection_open_browser` + the AI-Chrome path; Blitz Chrome is the
  only agent browser. Fix `connection_navigate` desc (647 "the AI-browser window"). `connection-tab-link.mjs` (the
  extension link serving BOTH user tabs AND AI Chrome) goes with the extension (item 5).
- **N2. `connection_list_tabs` desc stale** (os-tools.mjs:531): "via the BlitzOS Connector extension … Errors if the
  extension isn't installed." Repoint to the Apple-Events links (Safari + the new Chrome adapter), extension-free.
- **N3. `blitzos-agents.md:53` stale**: "Chrome needs the connector — `connection_install_extension`." Remove; Chrome
  connects via the Apple-Events adapter.
- **N4. "Show me" / screenshot capability gap** (`blitzos-agents.md:135` + `say` tool desc os-tools.mjs:235): both say
  "screenshot the SOURCE in the user's connected browser (connection_read can return an image)." (a) Flip to Blitz
  Chrome; (b) screenshots work on CDP (Blitz Chrome) only — the Apple-Events fallback (Safari/Chrome adapters) is
  TEXT-only, no screenshot. Say "show" goes through Blitz Chrome; note the AppleScript fallback cannot screenshot.
- **N5. "canvas-app" wording** (`blitzos-agents.md:58, 68`): "Screenshots/AX are the canvas-app fallback." Reword to
  "a graphical app with no page API" — per the remove-all-canvas rule (avoid confusing it with the cut desktop canvas).
- **N6. `blitzos-orchestrator.md:103` references the cut "surface"**: "reversible work … (research, drafting,
  file/surface edits)." Drop "surface" — V1 has no surfaces.
- **N7. Bootstrap web fragment** (`agent-runtime.mjs:122`): "do it in the user's connected browser … open every source
  … in the connected browser (connection_read / connection_act)." Flip to Blitz Chrome (this is the item-4 bootstrap flip).
- **N8. "spawn N sub-agents" reads like the removed `spawn_agent`** (`blitzos-agents.md:33, 42`): after the peer cut,
  make explicit these are `run_workflow` leaves, not peer agents (folds into the dedup, item 7). Same `spawn_agent`
  cross-ref in `blitzos-orchestrator.md:43` ("not `spawn_agent` peers") — reword (folds into item 6).
- **N9. The boot duties route through "the connector"** (`onboarding.ts` INTERVIEW + RESIDENT duties, e.g. :636 "connect
  that tool through the connector"): stale (connector deprecated). The merged resident `BLITZ_DUTY` (item 8) must say
  Blitz Chrome (have the user open + sign into work apps there), never "the connector."
- Clean: no lingering hard V1-cut tools in the registry (no `place_widget`/`create_surface`/`open_window`/
  `switch_workspace`/widget tools); the cut was thorough. Orchestrator doc is otherwise solid.
