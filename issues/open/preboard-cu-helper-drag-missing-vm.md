# BUG: pre-board TCC drag tile never appears — BlitzOS Computer Use not draggable into Settings

Reported 2026-06-16 (fresh Mac VM, clean install from scratch).

## RESOLVED — build/packaging (2026-06-16)

The bundle is now guaranteed present everywhere the app runs, so `available()` is true and the drag fires:
- **Dev:** `package.json` `predev` → `scripts/ensure-helper.sh` builds `BlitzComputerUse.app` (via
  `native/computer-use-helper/build.sh`) the first time `npm run dev` runs on a checkout that lacks it.
  macOS-only, builds only when missing, never blocks dev. Verified: removing `build/` and running the
  hook rebuilds + signs it (Developer ID, `dev.blitz.os.computeruse`).
- **CI (`.github/workflows/release.yml`):** a new step builds the sidecar AFTER the cert import (so it
  signs with the same identity) and BEFORE packaging, cached on the sidecar source + signing mode so it
  only rebuilds when the sidecar code changes; a verify step refuses to package if the bundle is absent.
  Previously CI never built it, so every release shipped without the helper — the actual VM root cause.

STILL OPEN (smaller follow-up): the UX dead-end (defect 2 below). When the helper is genuinely
unavailable, the pre-board still shows an undraggable "drag it in" instruction with no surfaced error.
And per the design doc, the real packaged-signed-build behavior must be confirmed on a clean VM.

## Symptom

In the onboarding pre-board permission sequence, for ALL THREE TCC steps (Accessibility, Screen
Recording, Full Disk Access), the **"BlitzOS Computer Use" icon never appears and cannot be dragged**
into the System Settings permission list. The onboarding keeps instructing "Drag BlitzOS Computer Use
into the Accessibility list above. Then flip it on" and shows **0 OF 3 GRANTED**, but there is nothing
to drag, so the user is stuck and no grant can be made. (Screenshot: the Accessibility list shows
Badclaude / Codex / Codex Computer Use / Ghostty / Script Editor / Terminal — no BlitzOS Computer Use.)

## Root cause (code-traced)

The drag is being SUPPRESSED because the helper bundle is unavailable, not because the drag UI is broken.

1. `src/main/onboarding.ts:205` `const avail = computerUseHelper().available()`. `available()`
   (`computer-use-helper.ts:243`) is `process.platform === 'darwin' && existsSync(bundledHelperApp())` —
   i.e. it is TRUE only if the `BlitzComputerUse.app` helper bundle exists on disk.
2. When unavailable, `onboarding.ts:225` logs `HELPER UNAVAILABLE for <kind> (available=false) — drag
   suppressed; build native/computer-use-helper`, and `currentDragBundle` is left `null` (`:226`).
3. The drag handler `onboarding.ts:889` `ipcMain.on('onboarding:preboard-drag')` does
   `const bundle = currentDragBundle; if (!bundle) return` (`:893-895`) — so `startDrag` is never called
   and **no draggable icon is produced**. The log shows `DRAG fired → file=(none — suppressed)`.

So on this VM, `BlitzComputerUse.app` is missing from the install, so every step suppresses the drag.

## Why the bundle is missing (to confirm)

`bundledHelperApp()` (`computer-use-helper.ts:34-60`) looks for the bundle at, in order: packaged
`process.resourcesPath/BlitzComputerUse.app`, then dev `app.getAppPath()/native/computer-use-helper/
build/BlitzComputerUse.app`. It is shipped into a packaged app via `electron-builder.yml:30-31`
(`extraResources: native/computer-use-helper/build/BlitzComputerUse.app -> BlitzComputerUse.app`), and
that source is built + signed by `scripts/dist-mac.sh` BEFORE packaging.

Most likely the VM install was packaged WITHOUT the helper having been built (so
`native/computer-use-helper/build/BlitzComputerUse.app` did not exist at package time and extraResources
shipped nothing), OR the VM is running a dev build where the helper was never built. Either way
`available()` is false.

## Two distinct defects

1. **Packaging / build:** the shipped app on a fresh machine has no `BlitzComputerUse.app`. The build
   pipeline must guarantee the helper is built + signed + included (fail the package if it is missing,
   rather than silently shipping without it).
2. **UX dead-end:** when the helper is unavailable, the pre-board still shows the "drag it in" instruction
   and a stuck "0 OF 3 GRANTED" with NO surfaced error and NO path forward. It should detect
   `available()===false` and either self-build/install, or show an explicit "helper not installed" state
   with a real fallback, never an undraggable instruction.

## How to confirm on the VM

- Check the dev/app log for `[computer-use] HELPER UNAVAILABLE ... drag suppressed` and
  `DRAG fired → file=(none — suppressed)`.
- Check `ls "<BlitzOS.app>/Contents/Resources/BlitzComputerUse.app"` (packaged) or
  `native/computer-use-helper/build/BlitzComputerUse.app` (dev) on the VM — expected MISSING.

## Impact

Hard block: on a clean machine the entire TCC pre-board (Accessibility + Screen Recording + FDA) cannot
be completed, so computer-use is unavailable and onboarding's permission step dead-ends.

## Files

`src/main/onboarding.ts` (drag flow + suppression), `src/main/computer-use-helper.ts`
(`available`/`ensure`/`bundledHelperApp`/install), `electron-builder.yml` (extraResources),
`scripts/dist-mac.sh` (helper build/sign), `plans/blitzos-computer-use-helper.md` (design).

Note (from the design doc): TCC identity separation is only real in a SIGNED PACKAGED build; dev only
verifies build/launch/socket/relaunch mechanics. So the real fix must be validated against a packaged,
signed build on a clean VM, not dev.
