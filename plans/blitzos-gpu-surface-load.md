# Investigation: BlitzOS freezes under desktop load (GPU compositing)

Status: investigated 2026-06-16. Stopgaps shipped; the proper fix is a decision (see end).
Scope of this doc: what actually freezes the desktop, which systems contribute, and the real options.

## Symptom

The whole desktop freezes: no window is clickable. The control API (main process) still answers, so
"main is alive but the UI is dead." In the sandwich compositor the **renderer is the window that owns all
mouse input**, so when the renderer dies and is not reloaded, every click goes nowhere.

## Mechanism (the actual chain)

1. The GPU process hits `tile memory limits exceeded` and crashes (`GPU process exited, exit_code=15`).
2. That takes the **renderer** process down with it (`render-process-gone`).
3. Nothing reloads the renderer (Electron does not auto-recover it), so the UI window stays frozen.
4. Earlier it was worse: `crashReporter.start()` in dev wedged Crashpad in a FATAL loop
   (`mach_port_request_notification: invalid capability`), turning a recoverable crash into a hard hang.

So the trigger is **GPU tile-memory exhaustion**; the freeze is the lack of recovery.

## What composites GPU memory (the systems, ranked)

The GPU tile budget is consumed by everything being composited across the **two sandwich windows**
(L0 "pages" = browser views; L1 "UI" = the whole renderer: canvas + widgets + chrome). Both composite at
the display's DPI (retina ~2x = ~4x the pixels = ~4x tiles).

1. **Browser surfaces (`web`) are the hog.** Each is a main-owned `WebContentsView` in L0. A heavy page
   (Gmail with 8,427 messages, a bank statement, Google Docs) is a large layer tree and eats tiles.
   - **Tabs are LAZY** (`webcontents-view-host.ts` syncWebContentsViewTabs): only the **active** tab of a
     surface materializes; background tabs have no view/process/load until first clicked, then persist.
     So the "30-tab import browser" is **1 live view**, not 30. Measured live: 3 web surfaces declaring
     45 tabs total, but only ~3 active views materialized.
   - Inactive tabs of a surface are **parked offscreen** (`-32000,-32000`, still attached) but, being
     lazy, usually don't exist at all until clicked.
2. **The L1 desktop itself.** The renderer composites the full-screen canvas + every `srcdoc` widget +
   chrome as one big surface at retina. This is a fixed, large cost independent of browsers.
3. **`srcdoc` widgets are minor.** They are sandboxed **iframes inside the L1 renderer** (not separate
   processes), each a small card. Measured: 9 widgets. Light relative to one heavy web page.
4. **`native` (notes) are negligible** (plain DOM).

Measured live load at the time of the freeze: 14 surfaces = 3 web + 9 srcdoc + 2 notes; ~6 renderer/GPU
helper processes totaling **~1 GB RSS**. RSS is RAM, not GPU tiles, but it tracks the same heaviness.

## Scope — the questions you asked

- **Across workspaces? NO leak.** Switching workspaces unmounts the old workspace's React surface frames,
  and each web frame's unmount calls `webContentsViewClose` → the host destroys its views (80ms grace).
  Live views are **bounded to the ACTIVE workspace**. Multiple workspaces do not accumulate GPU load.
- **Stages / off-stage? Does NOT isolate GPU.** Off-stage / parked surfaces keep their `WebContentsView`
  **alive** with `backgroundThrottling: false` (deliberate, for agent liveness), so their process + JS
  keep running (RAM/CPU). GPU-compositing-wise, a view panned fully off-window is mostly not tiled by
  Chromium, so the dominant GPU cost is the **on-screen** set, but stages give no GPU relief by design.
- **Tabs? Self-limiting.** Lazy materialization already caps this; only tabs you actually open cost
  anything, and they then persist for the session.
- **Widgets vs browsers?** Browsers dominate. Widgets are a rounding error next to one Gmail tab.

So the load is: **a handful of heavy live web pages + the full retina desktop canvas, composited across
two windows, against Chromium's conservative default tile budget.** It does not take 40 tabs; ~3 heavy
pages (Gmail especially) + the canvas at retina is enough on a busy board.

## Stopgaps already shipped (in `src/main/index.ts`, uncommitted)

1. `crashReporter.start()` gated to `app.isPackaged` — no more dev Crashpad FATAL wedge.
2. `render-process-gone` now **reloads** the window (4-in-60s loop guard) — a crash self-heals instead of
   freezing forever. (It previously only logged.)
3. `force-gpu-mem-available-mb=6144` + `disable-gpu-process-crash-limit` — raises the tile budget so the
   current load fits (verified: clean boot, zero tile/GL errors, 20s stable). NOT
   `disableHardwareAcceleration` — that failed GL context creation here (`kFatalFailure`) and was reverted.

These raise the ceiling and make a crash recoverable. They do **not** bound the load.

## The real fix — options (your decision)

| Option | What | Frees | Cost / risk |
|---|---|---|---|
| A. Raise GPU budget (shipped) | more tile memory | nothing; raises ceiling | none; a band-aid, will recur on a heavier board |
| B. Cull off-screen views | detach (`removeChildView`) any web view fully outside the viewport; re-attach on return | the most GPU, keeps tabs | the macOS `setVisible` blank-wedge the host avoids; re-attach repaint cost |
| C. Cap live web views (LRU) | keep N most-recent web views live; suspend the rest (blank + reload on focus) | bounds the worst case hard | a backgrounded page loses live state until refocused |
| D. Throttle off-stage | `backgroundThrottling: true` (or page freeze) for off-stage surfaces | CPU/RAM, some GPU | conflicts with "off-screen agent liveness" — agent work on a parked page slows/pauses |
| E. Seed less | onboarding opens fewer tabs; don't auto-open a 30-tab Chrome snapshot | the initial spike | a product/onboarding choice, not an engine fix |
| F. Lower off-screen DPI | composite parked/off-screen views at 1x | GPU on parked views | blurry on first reveal until re-rastered |

## Recommendation

B + C together are the durable engine fix: only composite what is on-screen, and hard-cap live web views
with LRU suspension. E (seed fewer tabs) removes the most common trigger cheaply. D trades away the
agent-liveness guarantee, so only choose it deliberately. A (shipped) buys time meanwhile.

Lowest-risk path to "solved": **E now** (stop auto-opening 30 tabs) + **C** (LRU cap, e.g. 6 live web
views), leaving B as a follow-up if the on-screen heavy-page case (Gmail) alone still exhausts tiles.
