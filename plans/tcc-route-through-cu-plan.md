# TCC: route privileged ops through the CU helper (fix + test plan)

Goal: no macOS permission popup ever attaches to the main Electron app (`dev.blitz.os`) during normal usage. Every TCC-gated op runs through the CU helper (`dev.blitz.os.computeruse`), which holds the grants; fall back to Electron only when the helper is absent. NO agent doctrine change (everything is below the connection verb boundary; `os-tools.mjs` + `blitzos-agents.md` untouched).

Source: workflow `tcc-electron-sweep` (17 triggers, 9 new). Dedup is by CONSENT CLASS, not file: one grant is shared across several call sites, so only the first call of a class ever prompts.

## Consent classes
| Class | Sites | When it pops | Fix |
|---|---|---|---|
| A. Control Chrome (Automation) | connection-chrome-applescript-link.mjs; index.ts:1703 (matchChromeTabByBounds); onboarding.ts:389,879 | NORMAL usage (high) + onboarding | route through new helper `osa` op |
| B. Control Safari (Automation) | connection-safari-link.mjs; onboarding.ts:879 | NORMAL usage (high) | route through `osa` |
| C. Control System Events (Automation) | blitz-chrome.ts:748 (show→frontmost); onboarding-scan.mjs:420 (login items) | normal (blitz-chrome) + onboarding | ELIMINATE: blitz-chrome → helper `activate`; scan login-items → helper or drop |
| D. Screen Recording | wallpaper.ts:59 (screencapture child) + :54 (CGWindowList enum) | DORMANT (no renderer caller today) | route through helper screenshot/window_screenshot/list_windows |
| E. Full Disk Access (silent, no popup) | onboarding.ts:976 (scan fallback under Electron); onboarding.ts:44-55 (hasFDA self-probe) | onboarding | primary already routes via helper (961); tighten fallback; probe→tcc_status (optional) |
| F. Camera/Mic/Location/display-capture | guest-capabilities.ts:93,128 | vestigial (web webviews cut) | NOT CU-routable (live stream ≠ newline-JSON socket); deny for guests in V1 / document |

NOT leaks (do not touch): index.ts:947 Accessibility already routes through the helper (the reference pattern); `webContents.capturePage()` (telemetry/index/osActions/launcher) snapshots the app's OWN window via the compositor, no Screen-Recording grant.

## The linchpin: one new helper op
`native/computer-use-helper/main.swift`: add `case "osa"` — exec `/usr/bin/osascript` with `args:[String]`, capture STDOUT+stderr, reply `{ok, stdout, stderr}`. Note: the existing `scan`/`runScan` ALREADY runs osascript under the helper (onboarding.ts:482/685 do), which proves the consent-redirect works; but it streams stderr and DISCARDS stdout, so a connection READ cannot get its result back. Hence a dedicated synchronous op. No new entitlement: osascript is the Apple-Events sender and the helper is the responsible process (verify on a packaged build).

## Workstreams (prefer-helper, fallback-Electron)
1. Helper `osa` op (above). Reuse the existing `activate` op (main.swift:774) for class C.
2. Shared wrapper `runOsa(args)` = `helper.connected() ? helper.call('osa',{args}) : execFile('/usr/bin/osascript',args)`. Fall back ONLY when the helper is absent, never when present-but-denied (that surfaces "grant the helper", never an Electron popup).
3. Apply the wrapper: connection-chrome-applescript-link.mjs, connection-safari-link.mjs, index.ts:1703, onboarding.ts:389/879.
4. Class C eliminate: blitz-chrome.ts:748 → `helper.call('activate',{pid})` (helper holds Accessibility / uses NSRunningApplication, so no System-Events Automation on Electron); onboarding-scan.mjs:420 → route through helper or drop login-items (already best-effort).
5. Class D (dormant): wallpaper.ts:54/59 → helper window_screenshot/screenshot + list_windows. Cheap true "just route"; also removes the fragile `xcrun swift` prod dependency.
6. Onboarding pre-grant step (after the Allow-JS step, onboarding.ts ~1333): read `scan.facts.defaultBrowser`; if Chrome or Safari, the helper fires a benign AE at it via `osa` → user grants the helper Automation→browser ONCE. Pre-seeds class A or B so normal usage never pops. Verify the grant landed (re-fire) before advancing. Class C is eliminated, so no pre-grant needed there.
7. Low/defer: tighten onboarding.ts:976 so a packaged build never reads TCC files under BlitzOS identity; optionally route hasFDA() to `tcc_status`; decide guest-media policy (deny in V1, since only OAuth popups remain).

## Test plan
Prereqs: signed PACKAGED build (TCC identity is only real when signed); run `scripts/vm-wipe-onboarding.sh` first (scoped TCC reset + wipe + force onboarding).
0. Mechanical (no GUI): a node test calls the helper `osa` op with a trivial script and asserts stdout came back (extend `scripts/tests/test-computer-use-helper.mjs`).
1. Onboarding pre-grant: complete the new step, accept the "BlitzOS wants to control <browser>" prompt, confirm the step verifies the grant before advancing.
2. DECISIVE (normal usage, zero popup): an agent drives the user's real Chrome/Safari via a connection (`connection_read`/`run_js`/`act`) → works, NO popup. Connect a Chrome tab by window (matchChromeTabByBounds) → no extra popup. Trigger BlitzChrome.show → NO "control System Events" popup.
3. CONTROL: quit the helper, drive a connection → it falls back to Electron → a popup appears on BlitzOS → proves routing was active when the helper was up.
4. Identity (Terminal with FDA): `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select client,indirect_object_identifier,service from access where service='kTCCServiceAppleEvents'"` → the grant row is `client = dev.blitz.os.computeruse` controlling the browser, NOT `dev.blitz.os`; confirm `dev.blitz.os` has no AppleEvents row.
5. Regression / no-doctrine: `scripts/test-connections.mjs` passes (verbs + return shapes unchanged).
6. Wallpaper: only if the frosted backdrop gets wired in V1; else N/A (dormant).
