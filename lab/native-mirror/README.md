# native-mirror — full-live-use spike

Goal: **use any native macOS app inside BlitzOS**, with the streamed app rendered as real native
content (not the DOM sandwich), full live input, and multi-window (menus, completion popups, tool
windows). JetBrains is the motivating case.

This folder is the standalone proof of the hard mechanics, deliberately OUTSIDE BlitzOS core so it
can fail safely. It runs as its own tiny AppKit app.

## The constraint that shapes everything

The bottom of the BlitzOS "sandwich" (the L0 `pages` window) holds `WebContentsView`s, which work only
because they are **in-process** Chromium views (`contentView.addChildView`). A foreign app like
JetBrains is a **separate process with its own WindowServer connection**, and macOS does not let you
reparent another process's `NSWindow` into your view tree. There is no public API; the private one
(XPC view-bridging) needs the other app to cooperate, which JetBrains won't. yabai-style tools
move/resize foreign windows but never embed them.

So "put the native app in L0 like a WebContentsView" is impossible. The viable mechanism is a **local
single-app mirror**: capture the app's window pixels and composite them as a native layer we own, and
synthesize input back to the app. It is remote-desktop mechanics aimed at a local process, and it
fits BlitzOS because the Computer Use helper already holds the two grants this needs (Screen
Recording for capture, Accessibility for input).

## What this spike proves (and what it does not, yet)

Proves:
- Capturing **every window** of a target app via ScreenCaptureKit (one `SCStream` per window,
  zero-copy `IOSurface` frames) and displaying each as a live mirror window.
- Multi-window tracking: popups/menus/tool-windows that appear or move are mirrored within ~250ms.
- Full live input forwarded to the real app via `CGEventPostToPid` (mouse, drag, right-click, scroll,
  keyboard), with view-local -> source-window coordinate mapping.

Does NOT yet (tracked, intentional):
- **Hide the source.** v1 shows the real app where it is and the mirror offset beside it, so you can
  watch input on the copy drive the original. Hiding the source off-screen (the real product shape)
  is the next step and couples to off-screen-liveness, below.
- **BlitzOS integration.** No L0 IOSurface sharing, no `nativeapp` surface kind. This is a separate
  AppKit app on purpose. Phase 2 moves the capture+input engine into the Computer Use helper and
  shares the IOSurface into the BlitzOS `pages` window via a native node addon.
- **IME / dead keys.** Keyboard goes as virtual-keycode + flags (good for typing and shortcuts);
  full Unicode/IME input is a follow-up (`CGEventKeyboardSetUnicodeString`).

## Known risks being measured here (be honest about these)

1. **Off-screen liveness.** When we eventually hide the source, some apps throttle rendering when not
   visible. SCK captures occluded windows, but per-app throttling is the #1 unknown. Measure before
   committing to the helper integration.
2. **Input fidelity without focus.** We keep our window key and post to the source's pid so BlitzOS
   chrome never grays out. Cocoa apps usually accept this; JetBrains (JVM event handling) may want its
   window frontmost to take synthetic keys. If keys don't land, that finding drives phase 2's focus
   model.
3. **Hover.** `postToPid` does not move the real cursor, so apps that read the global cursor for hover
   may not highlight. Measure; may need a HID-tap + warp variant for hover only.

## Run

The target app must already be running.

```bash
./build.sh
./run.sh --name "IntelliJ" --debug          # match by app name (substring), or:
./run.sh --app com.google.Chrome --debug    # match by bundle id
# options: --offset <dx> <dy>  (default 0 0 — mirror sits ON the source; recursion is excluded
#                                via sharingType, so no offset is needed; pass one to separate them)
#          --fps <n>           (default 60)   --debug (log AX status + each click/key)
```

`build.sh` signs with your Developer ID when present, so the TCC grants survive rebuilds (ad-hoc
signing changed the code hash every build and silently invalidated the Accessibility grant, which
killed input). If the signing identity ever changes, you re-grant Accessibility once, then it sticks.

**TWO grants are needed, and they are different:**

- **Screen Recording** powers capture. You already have this if you see the mirror at all.
- **Accessibility** powers input. Synthesized clicks/keys (`CGEventPostToPid`) **silently no-op**
  without it. This is the usual cause of "the mirror shows but I can't click anything."

Because `run.sh` execs the binary from your terminal, BOTH grants attach to your **terminal app**
(Terminal/iTerm). So: System Settings > Privacy & Security > **Accessibility** > enable your terminal,
then re-run. On launch the app prints `Accessibility: true/false` so you can confirm. (To give the
mirror its own TCC identity instead, launch the `.app` via `open` — see the bottom of `run.sh`.)

The clear proof: `--offset 700 0`, then click / scroll / type on the shifted **copy** and watch the
real window react and the copy update. With `--debug`, every forwarded click/key prints to the
terminal, so you can see whether the handler fired and where it was posted.

## Phase 2 sketch (after this holds up) — into BlitzOS

1. Move the SCStream capture + CGEvent input into `native/computer-use-helper/main.swift` (it already
   holds both grants), behind new socket RPCs: `mirror_start {bundleId|pid}`, `mirror_input {...}`,
   `mirror_stop`. The helper emits per-window `{windowId, frame, ioSurfaceId}` events.
2. Share each `IOSurface` to BlitzOS main (global `IOSurfaceID` lookup, or a small mach/XPC
   side-channel since plain Unix sockets cannot carry mach ports).
3. New native node addon in BlitzOS main puts the IOSurface on a `CALayer` inside the `pages` window's
   `contentView`, positioned/z-ordered by the **existing** `applyWebGeometry` pipeline.
4. New `nativeapp` surface kind `{pid|bundleId, windowId}` flowing through `osActions` -> store ->
   host like a `web` surface, so move/resize/stage/persist come for free.
5. Hide the source off-screen via AX once liveness is verified; map input to the stashed coords.
