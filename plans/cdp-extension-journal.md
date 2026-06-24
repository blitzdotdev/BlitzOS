# CDP minimal-extension path — running journal

Goal: trusted input + full read/write into CANVAS web apps (Google Docs, Figma) that osascript
and synthetic-DOM events cannot touch. Off-repo harness (uncommitted): `/Users/Shared/chrome-osa-verify/`
(`cdp-ext/`, `cdp-server.mjs`, evidence/).

## The minimal extension (`cdp-ext/`)
- `manifest.json`: MV3, `"permissions": ["debugger", "alarms"]` ONLY. No host_permissions, no
  scripting / userScripts / tabs / all_urls.
- `sw.js` (~55 lines): connects OUT to a localhost WS (the harness) and relays CDP via chrome.debugger:
  `listTargets` (chrome.debugger.getTargets), `attach`, `detach`, `cdp {tabId, method, params}`
  (chrome.debugger.sendCommand). That one `cdp` verb exposes ALL of CDP.
- Strictly smaller than the current connector AND more capable: CDP gives trusted input + Runtime.evaluate
  + DOM + Accessibility + screenshots. Could replace `scripting`+`userScripts`+`all_urls`+`tabs` entirely.

## The harness (`cdp-server.mjs`)
- localhost WS server (uses the repo's `ws` lib; node has no built-in WS server). RPC by id.
  Modes: `read | copytest | canvas | check | undo`.

## Findings (VERIFIED)
- WRITE into the Google Docs CANVAS works via CDP Input: `Input.insertText` (bulk + char-by-char) and
  `Input.dispatchKeyEvent` (Enter, Backspace). Granular run in "Copy of BlitzOS Testing Log" landed bulk
  text + "GRANULAR" char-by-char + Enter newline + typed text + 5×Backspace delete (evidence/cdp-copytest.png).
  osascript / synthetic-DOM CANNOT do this — the canvas ignores untrusted events.
- CDP input is TRUSTED + renderer-level → works on BACKGROUND tabs and does NOT change app/window focus
  (no focus steal; it is the architecture, not a trick).
- `Page.captureScreenshot` over CDP captures a BACKGROUND tab's rendered pixels (visual read with no foreground).
- DOM read of the canvas body is EMPTY (`.kix-appview-editor.innerText` = 0). Programmatic text read needs
  CDP `Accessibility.getFullAXTree` (Docs is screen-reader accessible). AX read NOT yet cleanly confirmed
  (a connection-storm bug timed the run out — now fixed; re-test pending).

## Gotchas (fixed)
- MV3 service worker EVICTION (~30s idle) stops the SW reconnecting. Fix: `chrome.alarms` keep-alive
  (periodInMinutes 0.5) that reconnects. Needs an extension reload to take effect.
- CONNECTION STORM: connect() fired from onInstalled+onStartup+top-level+alarms opened multiple sockets, so
  commands went to abandoned sockets and timed out. Fix: guard connect() (skip if readyState CONNECTING/OPEN)
  + server closes superseded sockets.
- The "<ext> started debugging this browser" BANNER shows while attached. Unavoidable from inside an extension
  (the suppression flag is launch-only). Mitigate: attach → act → detach quickly.

## Decision so far
- Cost = one `debugger` permission + the banner. For RICH Docs work (tables/styles/length) the Drive/Docs API
  is the comfortable path (proven: HTML-import `create_file` + `read_file_content` → structured markdown).
- So CDP is the FALLBACK for canvas TEXT + trusted input where no API exists (Figma, games, arbitrary canvas apps).

## Figma (canvas app) — CDP DOES drive it (verified)
- Read layers via DOM (Figma's panels are DOM; canvas is WebGL). Screenshot via CDP `Page.captureScreenshot`
  on the background tab. `Cmd+A` via CDP selected all 24 objects and the alignment panel populated → CDP
  reaches Figma's canvas + UI. (Tidy-up invocation via quick-actions Cmd+/ was the next step; not finished.)

## Canvas manipulation WITHOUT CDP?
Yes, but only WITH a focus steal. Trusted input also comes from OS-level CGEvent (cgtype.swift / cursor.swift /
osascript keystroke). It drives any canvas app (proved: typed the Docs BODY), BUT it goes to the FOREGROUND app,
so the app must be frontmost = focus stolen. CDP is the ONLY trusted-input path to a BACKGROUND tab with no focus
steal. Net: no-CDP = real input + focus steal; CDP = real input, no focus steal (cost = the banner).

## TODO: AI-only Chrome to hide the banner (user idea, 2026-06-22)
Run a SEPARATE Chrome the user never looks at, so the "<ext> started debugging this browser" banner (and the
"unsupported command-line flag" bar) stays off-screen. Two realizations:
- A dedicated AI PROFILE window driven by the cdp-ext extension — banner shows, but on a window the user isn't viewing.
- A separate Chrome INSTANCE with its own `--user-data-dir` + `--remote-debugging-port` → CDP with NO extension at
  all (Chrome 136+ allows the debug port only on a non-default user-data-dir).
Open question for both: the AI Chrome needs the user's logged-in sessions (log in once / import cookies), OR keep
account work on the MCP/API (Drive/Gmail/etc., which is better anyway) and use the AI Chrome only for canvas /
no-API sites (Figma, games). This also isolates the AI's actions from the user's live browsing.

## Per-agent profile + CDP debug-port — TESTED 2026-06-22 (PASS)
Real end-to-end test, harness `cdp-port.mjs`: launched a DEDICATED isolated profile
(`--user-data-dir=<fresh dir> --remote-debugging-port=9333`, NO extension), connected CDP over the port
from node (global WebSocket), and:
- Debug port came up on Chrome 149 with the fresh dir → the 136+ restriction is only on the DEFAULT
  profile; a custom user-data-dir is allowed. No extension ⇒ NO "started debugging this browser" banner.
  (The generic "unsupported command-line flag" bar may show, but on the AI window the user does not view.)
- Navigated the profile to mail.google.com → redirected to accounts.google.com sign-in, `needsLogin:true`.
  So the profile is ISOLATED + logged-out (the per-agent consent boundary), the agent DETECTS logged-out
  (URL / sign-in form), and it can `Page.captureScreenshot` the login page to show the user
  (evidence/cdp-port-gmail.png — the Google "Sign in" page). This is exactly where it pauses to ask the
  user to sign in.
- Trusted `Input.insertText` typed into a field and read back verbatim → trusted (canvas-capable) input
  works on this profile too.
- Killed the instance on exit.
CONCLUSION: the per-agent model works with NO extension at all (separate instance + debug port). Each agent
gets an isolated profile (own cookies/logins), any banner/flag is confined to the AI window, and login is
requested on-demand. Remaining to build: the "please sign in" UX (surface in BlitzOS chat, bring the AI
window forward, wait, resume) and the login-friction policy (share one AI profile, or sign the profile into
a Google account, or keep API services on the MCP). Harness: `cdp-port.mjs`.

## Per-agent WINDOWS in ONE profile — TESTED 2026-06-22 (PASS), harness `cdp-windows.mjs`
The headline architecture for "every chat agent gets its own browsing window under one AI profile":
- In ONE AI profile, created TWO background windows via CDP `Target.createTarget {newWindow:true,
  background:true}` and attached each with `Target.attachToTarget {flatten:true}` (per-window session).
- Drove each window INDEPENDENTLY with trusted `Input.insertText` — agent-A read back "agent A typed this",
  agent-B read back "agent B typed THAT" (concurrent multi-agent, isolated per window).
- **frontmost stayed `Finder` through window creation AND driving → ZERO focus steal.**
- `Browser.getWindowForTarget` returned each window's bounds (listWindows-with-bounds parity, via CDP).
So: one profile (shared login) + N background windows (one per agent) + trusted input + no focus steal — all
proven. The integration plan is `plans/cdp-browser-blitzos-plan.md`.
