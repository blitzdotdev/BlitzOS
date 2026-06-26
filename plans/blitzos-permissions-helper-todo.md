# TODO: permissions + connection-helper experience

Framing: JIT permissions removed the onboarding wall (good), but testing shows the **failure path is broken**. A missing grant surfaces as red jargon ("could not create event tap") or a silent agent failure; a denied grant is a dead end with no way back; the half-granted state (browser icon shows, tabs don't) is confusing; and the window helper wedges globally + is the wrong tool for web apps. Goal: every permission gap becomes a clear, recoverable, agent-surfaced ASK, and the helper becomes robust enough to trust.

Related: `plans/blitzos-jit-permissions.md` (the JIT mechanism this builds on).

## P0 — Permission failure UX (clear, recoverable, never a dead end)
> Increment 1 landed (foundation + left box + dropbox). Foundation: `connection-grants.mjs` (error→grant map + descriptors), `requestGrant(grant)` on the helper + `os:request-grant` / `os:grant-changed` IPCs, `pollAndApplyGrant` (relaunch the helper the moment a Settings-toggle grant lands). Remaining: the right-box browser rows + a full grant-state snapshot.
- [x] **Left box (window picker) error.** DONE — `pick_start`'s "could not create event tap" now carries a grant descriptor; the dropbox shows a clear card ("Let Blitz control your apps" + why + an **Enable Accessibility** button) instead of the red string. Enable → `requestGrant('accessibility')` raises the prompt + opens Privacy ▸ Accessibility; when the toggle lands the helper relaunches and the card clears (`os:grant-changed`).
- [x] **Right box (browser) when Automation is missing/denied.** DONE for BOTH browsers — the links' `listTabs` now surfaces per-browser state (`classifyBrowserState`: denied / allowjs / unreachable / helper) instead of swallowing it; `connectionListWindows` drops Chrome/Safari windows (no more "Google Chrome 7" in the window list); the connector list renders a dedicated `att-browser-grant` row per unreachable browser ("Connect Google Chrome" + the reason + a Grant button → fires the right grant). Also DONE: the dropbox drop gates on the same state — a denied browser shows the inline grant card instead of silently connecting as a window (the bug), scoped to the dropped browser so dropping Chrome never prompts for Safari.
- [ ] **Denied-grant recovery (the dead end).** macOS will NOT re-prompt a denied Automation/AX/Screen grant — once the user clicks Don't Allow it never reappears. The action button must detect denied-vs-never-asked and open the EXACT Settings pane (Privacy ▸ Automation / Accessibility / Screen Recording) when denied, or fire the prompt when never-asked. There must always be a way back.
- [ ] **Per-capability grant state.** Track granted / denied / unknown for: Chrome Automation, Safari Automation, Accessibility, Screen Recording, the browser "Allow JS from Apple Events" setting. This drives every UI branch (normal row vs grant-me row) and the agent error.
- [x] **Drag-into-dropbox without permission → inline grant screen in the dropbox.** DONE — a failed drop carries the grant descriptor; the dropbox shows **Give permission** / **Not now**. Give permission → `requestGrant`; when it lands we retry connecting THAT exact window so it then appears in the dropbox. Not now → cleared, nothing placed.
- [~] **Denied-grant recovery.** PARTIAL — `requestGrant` opens the exact Settings pane (AX/Screen always; Automation when the inline Allow doesn't land). Still TODO: a precise denied-vs-never-asked check so we prompt vs open-Settings deterministically (Automation has no cheap state read yet).
- [~] **Per-capability grant state.** PARTIAL — the card is driven by the error→grant map (reactive), which covers the failure path. A proactive granted/denied/unknown snapshot (needed to PRE-empt the right-box browser rows before any failure) is still TODO.

## P0 — Agent doctrine: permission-required → TCC choice card
- [ ] **Structured `permission_required` error.** Connection tools (`connection_read`/`act`/`run_js`/`list_tabs`/`navigate`) that hit a missing grant return `{error:'permission_required', grant, target}` — NEVER a silent error or a dropped connection.
- [ ] **TCC choice card.** On `permission_required`, the agent renders a special blitz-ui card that DEFINITELY triggers the grant (per `grant`): Automation → helper fires the benign Apple Event (the popup); AX/Screen → open the Settings pane; Allow-JS → the View ▸ Developer menu-drive. Must be deterministic for BOTH Safari and Chrome.
- [ ] **Map raw errors → grants:** `-1743` = Automation denied; `-3801` = Screen Recording declined; "could not create event tap" = Accessibility; "JavaScript through AppleScript" / "Allow JavaScript from Apple Events" = the browser Allow-JS setting.
- [ ] **Update `src/main/blitzos-agents.md`** with the protocol: a connection tool that needs a permission ALWAYS surfaces the choice card and asks the user; it never silently fails or gives up.

## P1 — Helper robustness (the wedge that made it unusable)
- [ ] **Global wedge: one stuck request freezes the whole helper.** After a burst, every read/act on BOTH Chrome AND Safari returns "helper timeout" through a 12s backoff. Isolate requests (concurrency / per-request deadline that doesn't block the socket); a slow AX walk must not block unrelated calls.
- [ ] **Timeout ambiguity (double-fire risk).** "helper timeout" means "no reply in time", NOT "didn't happen" — Cmd+T timed out yet opened a tab. Make ops idempotent or return a definitive applied/not-applied, so retries are safe and the agent isn't guessing.
- [ ] **Connection-change event storm.** `com.google.Chrome` fired dozens of identical "connection changed" events (same timestamp), flooding the agent loop and correlating with the wedge. Coalesce / dedupe / debounce them.
- [ ] **Helper health/RTT.** `connection_list` reports `status:"live"` + `act/vision:true` while every RPC fails. Add a real health/RTT probe; reflect responsiveness, not just "socket open".
- [ ] **Agent-side reset.** `connection_connect_window` is refused over the relay, so a relay agent can't reset a wedged helper. Add an agent-callable restart/reset op, or auto-recover the wedge.

## P1 — Helper AX read quality (the Notes failure)
- [ ] **Bound AX traversal by node-count/depth, not just output bytes.** The 1,544-note tree blows a fixed deadline; bigger `max` = more nodes walked = guaranteed timeout. Default read is nondeterministic because it sits right on the deadline.
- [ ] **Implement the advertised subtree/selector read.** `connection_read`'s own note says "narrow the selector/subtree" but it exposes only `{max}`. Add a selector/subtree param (read the focused element or a specific AXTable) so the static sidebar isn't re-walked every call.
- [ ] **Partial-on-deadline.** Return `{truncated:true, reason:"deadline"}` with what was walked, instead of a bare "helper timeout".
- [ ] **Cache static subtrees** (e.g., the Notes folder sidebar) across calls so each read doesn't re-walk them.

## P1 — Screen Recording, granted just-in-time for the helper
- [ ] **Detect `-3801`** (Screen Recording declined) → `permission_required` → the Screen Recording grant card.
- [ ] **Request Screen Recording JIT** when the helper first needs a screenshot (vision), via `helper.request('screen')` + Settings guidance.
- [ ] **Honest capability flags.** Don't advertise `vision:true` when Screen Recording is declined — `capabilities` must reflect the real grant.

## P2 — Connection strategy + relay gaps
- [ ] **Prefer tab/run_js over the window helper for web apps.** Google Docs is a canvas page; driving the window (Cmd+T, type "docs.new") is the wrong tool. Doctrine: for the user's browser use the tab Apple-Events/CDP path (Blitz Chrome, or the user's real Chrome/Safari tab); the window helper is a last resort for API-less native apps. (MCP is NOT supported — do not route through it.)
- [ ] **list_tabs / connect_tab over the relay.** They're user-initiated/localhost-only, so a relay agent is forced onto the flaky window helper. Decide the security posture: can a relay agent list/connect the user's tabs behind a user-approved TCC card?
- [ ] **navigate over type.** Prefer `connection_navigate` for URLs instead of typing into the omnibox — AX can't read the omnibox mid-type and the URL isn't committed until Return, so typed text is unverifiable (worse with screenshots blocked).

## Carried over from the JIT plan (still open)
- [ ] **Allow-JS at connect** — now folded into the choice-card doctrine above (it's one of the grants the card handles).
- [ ] **Primer card before the OS dialog** — the one-line "why" shown right before the macOS prompt.
