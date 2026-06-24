# Extension-free Chrome control (OSA adapter) — capabilities, limits, decisions

Status: verified live 2026-06-22. Harness (off-repo, uncommitted): `/Users/Shared/chrome-osa-verify/`
(cdrive.mjs, tasks.mjs, cgtype/cursor/coachmark, evidence/).

## What it is
Drive the user's REAL Chrome with NO extension, via Apple Events `execute javascript` (osascript) —
same adapter shape as `src/main/connection-safari-link.mjs`. A transport behind the connection
vocabulary (read / act / run_js).

## Setup (one-time, per machine)
- Automation TCC grant (BlitzOS → Google Chrome): live prompt, no app restart.
- ONE human toggle: View → Developer → Allow JavaScript from Apple Events. HARDENED against synthetic
  input (click / AXPress / keyboard / real-HID all no-op — proven by a control test where the same HID
  click DID fire "View Source"). A human must click it once; there is NO Chrome managed policy for it.
  (Onboarding coachmark prototype built to guide this: `coachmark.swift`, arrow on the exact row.)
- NOT needed: "Allow user scripts" (that is extension-only, for `chrome.userScripts`).

## Works (tested on X, Gmail, Docs, LinkedIn; background tabs; no focus)
- read, click, type into inputs + contenteditables (Gmail compose), DOM build (createElement / textContent / .value).
- `eval` + `new Function`: WORK on all four incl. strict-CSP X/LinkedIn. The OSA injection is NOT bound
  by page CSP for code execution (like Safari `do JavaScript`). So no eval capability is lost.

## Concrete limits
1. Trusted Types (Gmail, Docs, LinkedIn): `el.innerHTML="<string>"` and injecting a `<script>` tag are
   blocked. Use createElement/textContent/.value (X has no such block). Minor.
2. Canvas editors (Google Docs BODY, Figma): NO injected JS writes them (synthetic events are untrusted).
   Needs real OS keystrokes (CGEvent) → Chrome foreground → focus steal. Speed 116 chars/s @7ms (~5s/100
   words); clipboard paste ~instant. Docs body DOM reads are unreliable (canvas-rendered).
3. Focus-gated commits (Docs title Enter): the JS runs but commits ONLY when the doc tab is the foreground
   tab (`document.hasFocus()` true / `visibilityState` visible). Background = silent no-op. (The registry
   `rename_doc` echoes `{renamed}` without verifying → dishonest; should read back `document.title`.)

## Doctrine: prefer MCP/API over the browser
For services with an MCP/API (Drive, Gmail, Calendar) use it → server-side, no tab/DOM/canvas/focus.
Proven: agent 35 made + wrote a Doc via the Drive MCP (no focus stolen); agent 36 used the browser for
Gmail only because the Gmail MCP is unauthenticated. The browser/OSA route is the FALLBACK for API-less
sites (x.com, arbitrary apps).

## Focus-without-stealing (researched + tested 2026-06-22)
- Focus-gated commits (e.g. Docs title): SOLVED without an app-focus steal. Make the doc the ACTIVE tab in
  its Chrome window (`set active tab index` — VERIFIED it does NOT bring Chrome to the front: Finder stayed
  frontmost across the switch), run the synthetic commit, then switch the tab back. The commit lands with
  ANOTHER app frontmost (verified). Only side effect: that window's active tab changes momentarily. Caveat:
  needs the Chrome window on-screen — a minimized/occluded window reports `visibilityState:'hidden'` and may not commit.
- In-page spoof of `document.hasFocus`/`visibilityState` does NOT work — Docs uses the real visible/active
  state, not the JS-readable signals (tested: spoofed both true, commit still failed).
- Canvas body typing (Docs body): the tab trick does NOT help — it needs TRUSTED key events. Robust path =
  CDP `Input.dispatchKeyEvent`/`insertText` (trusted, no focus; how Playwright drives background tabs), but
  needs the extension's `chrome.debugger` (shows a banner) OR Chrome launched with `--remote-debugging-port`
  on a NON-default `user-data-dir` (Chrome 136+ blocks it on the default profile). `CGEventPostToPid` (deliver
  keys to the background Chrome process) is a maybe — forums report it flaky for some apps; untested here.
