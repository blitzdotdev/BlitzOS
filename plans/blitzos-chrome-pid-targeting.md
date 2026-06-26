# Blitz Chrome / user-Chrome Apple Events collision — PID-pinned fix

## The bug (verified, 2026-06-25)
The user-Chrome tab bridge drives `tell application "Google Chrome"`, which resolves by bundle id
`com.google.Chrome`. Blitz Chrome (`blitz-chrome.ts`) launches a SECOND instance of the SAME bundle (`open -n`,
own `--user-data-dir`). With two same-bundle processes alive, the Apple Event routes to ONE of them, indeterminate
which. When it hit Blitz, the user's Gmail tab "vanished" from `connection_list_tabs` and `tab 10 of window 1`
threw `-1719` → the agent wrongly concluded the tab was closed.

Three root causes:
- A. **Identity collision** (the incident): Blitz shares `com.google.Chrome`, so the tell is ambiguous.
- B. **Positional addressing**: tabs keyed `chrome:<window>:<tab>` (z-order ordinals), re-resolved every call, so a
  focus/reorder/move silently re-points a live connection (can drive the WRONG tab, not just fail).
- C. **No re-resolve / false "closed"**: nothing distinguished "shadowed / wrong ordinal" from a real close.

## The fix: pin the Apple Event to the user's Chrome PID (ScriptingBridge)
Drive the user's tabs via `SBApplication(processIdentifier:)` in the helper instead of `tell application`. Pinning
the PID removes the ambiguity. TCC is UNCHANGED: Apple Events authorization is keyed by the TARGET bundle id, not
PID, so the helper's existing "control Google Chrome" Automation grant covers it with no new prompt.

Closes A directly; closes B by binding a connection to the Chrome tab's STABLE `id` (re-resolved by id, index
fallback); closes C because "no user Chrome" is now a distinct, honest result.

## Changes
- `native/computer-use-helper/main.swift`: `import ScriptingBridge`; Chrome SB protocols + error-catcher delegate;
  `userChromePid(excluding:)` (NSWorkspace, excludes Blitz's pid); `chromeListTabs` / `chromeExecJS` (by stable id,
  index fallback); RPCs `chrome_list_tabs`, `chrome_js`, `chrome_pid` (Automation-free pid probe, for verify).
- `native/computer-use-helper/build.sh`: add `-framework ScriptingBridge`.
- `src/main/blitz-chrome.ts`: expose `browserPid()` (the debug-port-resolved real pid).
- `src/main/connection-chrome-applescript-link.mjs`: route `listTabs` + tab JS through the new RPCs (not osascript);
  bind each connection to the stable Chrome id. Keep external ref `chrome:<w>:<t>` so the UI is untouched.
- `src/main/connection-chrome-applescript-link.d.mts`: `blitzPid` opt + `chromeId` field.
- `src/main/index.ts`: pass `blitzPid: () => blitzChrome().browserPid()`; TODO on `matchChromeTabByBounds` (same
  collision, lower stakes, drop-time only — follow-up).

## Verify — DONE (2026-06-25)
- `native/computer-use-helper/build.sh` compiles clean; `npm run check` (typecheck + parity + build) green.
- Existing `scripts/tests/test-computer-use-helper.mjs` still passes (no protocol regression).
- `scripts/tests/test-chrome-pid.mjs` passes against the REAL Chrome with TWO `com.google.Chrome` instances live
  (the exact collision scenario): exclusion picks the non-Blitz pid; `chrome_js` resolves a tab both by window/tab
  (connect path) and by stable `tabId` (the live-connection path) → same id.
- Bug the harness caught + fixed: the socket envelope reserves `id` for message correlation, so the tab id must ride
  `tabId` on the wire (else every by-id call resolves the wrong tab). Fixed in helper + adapter + test.

## Not done / follow-up
- `matchChromeTabByBounds` (index.ts) still uses `tell application "Google Chrome"` — same collision, drop-time only.
- Safari uses the same positional scheme but has no second-instance collision; left as-is.
- UI highlight matches by `chrome:<w>:<t>`, so a connected tab that MOVES won't show highlighted at its new slot
  (cosmetic; the connection still works via the stable id).
- Tiny race: in the sub-second after Blitz launches but before its pid resolves (`browserPid()===null` → excludePid
  -1), a user-Chrome list could pick Blitz IF the user's Chrome isn't frontmost. Mitigated because Blitz launches
  `open -g` (background, never `isActive`) so `userChromePid`'s active-preference avoids it; self-heals once the pid
  resolves. Closing fully would need excluding by the Blitz profile's user-data-dir (reading proc args).
