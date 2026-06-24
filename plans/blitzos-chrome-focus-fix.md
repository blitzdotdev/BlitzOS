# Plan — Blitz Chrome: visible, watchable, never steals focus

Source spec: `~/Blitz/Home/blitz-chrome-focus-fix.md`. File: `src/main/blitz-chrome.ts` (+ one tool in `os-tools.mjs`).
Target branch: **blitz-v1** (the 686L refactored `blitz-chrome.ts` is now on origin/blitz-v1 via `98fe3d5`; the spec's `connect-in-island` ref is stale). Implementation NOT started — this is the plan only.

## Goal (what we want)
Blitz Chrome stays a **real, visible, non-headless** Chrome window the user can watch on demand (Mission Control swipe-up / Cmd-Tab / its own Space), but it **never** takes keyboard or window focus. Not on launch, not on new-window creation, not while the agent clicks/types. The user keeps typing in their editor and nothing jumps in front.

## The insight (verified against the code)
On macOS only the **frontmost app** owns keyboard focus. The agent drives Chrome with CDP `Input.*` at the renderer level, which works on a **background, unfocused** window. Verified: `blitz-chrome.ts` has **zero** `Page.bringToFront` / `Target.activateTarget` calls. So the ONLY focus thief is the Chrome app becoming frontmost, which happens because we launch it in a way that activates it. Fix the launch and the rest follows. Headless is wrong (removes the window, nothing to watch).

## Verified current state
- Launch: `spawn(bin, this.launchArgs(port), { detached:false, stdio:'ignore' })` — line 194. Direct GUI-app spawn → activates → focus steal.
- Lifecycle is tied to the child **PID**: `isRunning()` (131) = `!!this.child && exitCode==null && !killed`; relaunch hangs off `child.on('exit')` (199 → 216, supervise + 1200ms backoff); `shutdown()` (642) calls `this.child?.kill()` (654).
- New agent window: `Target.createTarget {url:'about:blank', newWindow:true}` — line 391. No `background` flag.
- Tools: `blitz_chrome_open` (663) / `_status` (674) / `_close` (684) in os-tools.mjs → `ops.blitzChromeOpen/Status/Close`. Wired in index.ts: `blitzChrome().setConnectionOps(...)` (1438), `blitzChrome().shutdown()` on quit (1448).

## Implementation

### Fix 1 — Non-activating launch + re-base lifecycle on the debug endpoint (PRIMARY, the real work)
Swap the spawn for a background LaunchServices open:
```ts
const appBundle = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '')   // /Applications/Google Chrome.app
spawn('open', ['-g','-n','-a', appBundle, '--args', ...this.launchArgs(port)], { stdio:'ignore' })
```
`-g` = background (never frontmost, the key flag). `-n` = new instance (our `--user-data-dir` already isolates the profile).

**Mandatory consequence (not optional):** `open` is a launcher whose PID **exits immediately** — it is NOT Chrome's PID. So `this.child` no longer tracks Chrome, and the existing `child.on('exit')` relaunch would fire **instantly → a relaunch storm**. Re-base the whole lifecycle on the CDP/debug connection:
- **Liveness (`isRunning`):** "the browser CDP WS is open" (and/or `/json/version` answers), not the child handle. ensure() already waits for the port to come up after launch — keep that retry.
- **Death detection / self-heal:** react to the browser-level WS `close` event (event-driven, reliable for a local Chrome) as primary; optional slow `/json/version` poll (~2s) as backstop. On an unexpected drop while `supervise && !wantQuit` → `ensure()` again (keep the 1200ms backoff). Remove the PID-based `child.on('exit')` relaunch.
- **Shutdown:** `try { await this.send('Browser.close') } catch {}` instead of `child.kill()` (no PID needed, clean quit; guard because Chrome may already be gone). Set `wantQuit=true; supervise=false` FIRST so the watcher doesn't relaunch.
- Move cleanup (unbindAll, windows.clear, ws.close, port=null) out of the `exit` handler into the WS-close/liveness path.

**Fallback (only if the supervision rework is deferred):** keep `spawn(bin,…)`, then immediately re-focus BlitzOS (`app.focus({steal:true})`). Keeps the PID + all existing logic, but causes a ~100-300ms forward-flash flicker and is race-prone (Chrome activates async). `open -g` is cleaner; prefer it.

### Fix 2 — Create each agent window in the background
Line 391: add `background:true` → `Target.createTarget {url:'about:blank', newWindow:true, background:true}`. Honoring is Chrome-version-dependent but harmless; Fix 1 is the real guarantee.

### Fix 3 — Keep auto-activation impossible + opt-in reveal
- Invariant comment guards near `session()`/`act()`: never auto-call `bringToFront`/`activateTarget`; `act` stays on CDP `Input.*` (no focus needed).
- Optional new lifecycle tool `blitz_chrome_show {agent}` (alongside open/status/close in os-tools.mjs → new `ops.blitzChromeShow`): DOES `Target.activateTarget` + brings the app forward. Opt-in "bring the window to me," never automatic.

## Watchability
Stays non-headless and visible. User reaches it via Mission Control (3-finger up), Cmd-Tab to the Blitz Chrome profile, or — best — pinning Blitz Chrome to its own Space (one-time manual: dock icon → Options → Assign To → a Desktop; programmatic Space assignment isn't reliable, document it).

## Risks / edge cases to handle
- **Relaunch storm** if Fix 1 ships without the lifecycle rework (above) — this is the #1 trap.
- `Browser.close` when Chrome already died → guard with try/catch.
- `open -n` with an already-running same-profile Chrome → `-n` + isolated `--user-data-dir` makes our instance distinct; verify no port collision.
- WS `close` from a transient hiccup vs real death → for a local Chrome, treat WS close as death; the 1200ms backoff + re-ensure absorbs a spurious one.

## Prereq before implementing
Sync the main checkout (currently blitz-v1 @ 3feb7b8, no browser code) to origin/blitz-v1 (98fe3d5, has the 686L file) without disturbing the active site-agent. The 4 local BLI commits auto-drop on rebase (identical patch-ids).

## Verification (human-in-the-loop — focus/watch needs eyes)
1. Launch focus-steal: type in another app while calling `blitz_chrome_open {agent:'t1', url}` → typing never interrupted, no window jumps forward.
2. New-window focus-steal: `agent:'t2'` (exercises createTarget) → same.
3. Drive-while-unfocused: keep focus in the editor, run `connection_run_js`/act → works, focus never moves.
4. Watch: swipe up → window present + live; optionally pin to a Space.
5. Self-heal: kill Chrome → re-ensures, still no focus steal on relaunch.
6. Shutdown: `blitz_chrome_close {quit:true}` → `Browser.close` quits cleanly, no orphan.
