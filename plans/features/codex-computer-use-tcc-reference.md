# Codex Computer Use — TCC permission flow (reverse-engineered reference)

Extracted 2026-06-12 from `/Applications/Codex.app/Contents/Resources/app.asar` (main bundle
`.vite/build/main-BJ6Uf5yA.js`, renderer `webview/assets/chronicle-setup-state-*.js`) + a screen
recording of the live flow (seconds 10-20). This is the STABLE REFERENCE for BlitzOS's pre-board
permission sequence: port these primitives, do not reinvent. Codex calls the feature "Chronicle"
internally; the user-facing name is "Codex Computer Use".

## The observed flow (video)

1. A dedicated **"Enable Codex Computer Use"** card: branded icon, subtitle "Codex Computer Use
   needs these permissions to use apps on your Mac. These permissions are used when you ask Codex
   to perform tasks." Two permission rows, each with an **Allow** button:
   - **Accessibility** — "Allows Codex to access app interfaces"
   - **Screenshots** (Screen Recording) — "Codex uses screenshots to know where to click"
2. Click **Allow** on a row → that row flips to **"COMPLETE IN SYSTEM SETTINGS"**, System Settings
   opens to the exact pane, and the card **repositions to a narrow strip at the bottom-center of
   the screen** holding the **draggable app icon** + copy "Drag Codex Computer Use to the list
   above to allow Accessibility".
3. The card is a SEPARATE always-on-top window (the Codex main window with its chat sidebar stays
   visible on the left simultaneously). It floats over System Settings so the drag SOURCE (the
   icon in the strip) and the drag TARGET (the Settings list) are both on screen.
4. User drags the icon into the Settings list → macOS adds + enables the app. Main polls the
   permission; on grant the strip restores to the centered card with that row gone, next row
   remaining.
5. Both granted → done.

## The primitives (from the code — port verbatim)

**Deep links** (`shell.openExternal`):
- Accessibility: `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
- Screen Recording: `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
- Full Disk Access (other Codex path): `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`

**Status getters** (the poll — IPC `chronicle-permissions` returns `{accessibility, screenRecording}`):
- Accessibility: `systemPreferences.isTrustedAccessibilityClient(false)` → `'granted'|'denied'`
  (pass `false` so it never raises the system prompt — pure query; `true` would prompt).
- Screen Recording: `systemPreferences.getMediaAccessStatus('screen')` → `'granted'|'denied'|'restricted'|'not-determined'|'unknown'`.
- FDA: no Electron API — read-probe a protected file (TCC.db / Safari History.db), EPERM = denied.

**The drag** (`startPermissionSettingsAppDrag`, the load-bearing trick):
```js
const file = appBundlePath()                              // the .app bundle (macOS); r.w() in Codex
const icon = await app.getFileIcon(file, { size: 'normal' })
webContents.startDrag({ file, icon })                     // webContents = the floating strip's
```
Called from the renderer drag tile's `onDragStart`: `e.preventDefault(); ipc('startPermissionSettingsAppDrag')`.
macOS permission lists accept a dropped `.app`, so this adds the app to the list (covers the
"app isn't in the list" dead end the + button otherwise requires).

**The floating window** (Codex's mascot overlay uses the same window primitives; the permission
strip is the same family): a frameless, non-activating, always-on-top panel:
```js
win.setAlwaysOnTop(true, 'floating')
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
win.setMenuBarVisibility(false)
// focusable:false, show:false until ready-to-show; positioned bottom-center of the active display's workArea
```

## BlitzOS adaptation (what we build)

- BlitzOS pre-board requests, in order: **FDA** (the scan's personal layer) → **Screen Recording**
  + **Accessibility** (computer-use, user opted in 2026-06-12) → **browser import** (Automation
  consent prompt — NOT a drag list, stays the osascript prompt already built).
- Each drag-list permission (FDA, Accessibility, Screen Recording) uses ONE shared floating
  drag-helper window (`preboard-drag-helper`): spawned on the step's primary action, opens the
  matching deep link, sits bottom-center always-on-top over Settings, hosts the startDrag tile +
  "Drag <App> into the list to allow <Permission>", and is closed by main when the poll detects
  the grant (then the pre-board card celebrates + advances).
- Polls reuse the getters above; FDA already has `hasFDA()`. Add `isTrustedAccessibilityClient(false)`
  and `getMediaAccessStatus('screen')` probes.
- Dev caveat (carried): TCC attributes to the responsible process, so in dev the Electron binary
  inherits the terminal's grants and the steps self-skip — `BLITZ_PREBOARD_FORCE=1` shows them for
  visual testing; real grant-detection needs a packaged build.
