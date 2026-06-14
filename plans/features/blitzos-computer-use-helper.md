# BlitzOS Computer Use helper — separate-app TCC architecture

Status: **slices A+B+C shipped 2026-06-12** (helper builds+signs+protocol-tested; lifecycle manager; pre-board retargeted; bundled+signed in dist). Live TCC-identity + grant verification is on a packaged build (the user's). Below is the as-built design. Subplan of `plans/onboarding-case-file.md` (pre-board permissions)
and the eventual computer-use feature. Anchored on the reverse-engineered Codex Computer Use
structure (`plans/codex-computer-use-tcc-reference.md`).

## Why a separate app (the insight)

macOS TCC grants for **Accessibility** and **Screen Recording** require the granted process to
**quit and reopen** to take effect. If those grants sit on the main BlitzOS (Electron) app, granting
them forces BlitzOS to restart mid-session — killing the onboarding board, the agents, everything.

Codex solves this by NOT putting those permissions on the Codex UI app. It ships a separate,
separately-signed background app — **"Codex Computer Use.app"** (`com.openai.sky.CUAService`, a
native arm64 `LSUIElement` binary, Developer-ID signed, ~51MB because it bundles their CUA agent) —
that holds Accessibility + Screen Recording and does the actual screen-capture + clicking, talking to
Codex over IPC. "Quit and reopen" restarts the HELPER; the Codex UI never restarts.

BlitzOS gets the same: a small native helper **`BlitzComputerUse.app`** (`dev.blitz.os.computeruse`,
Team `4GS43493GL`, `LSUIElement`, Developer-ID signed) that holds the computer-use TCC grants and
exposes screen-capture + accessibility actions over a local socket. BlitzOS supervises it and can
relaunch it freely; BlitzOS itself never restarts for a grant.

## The make-or-break detail: the helper's TCC IDENTITY

macOS attributes a TCC request to the **responsible process**. A naively spawned child inherits the
PARENT's identity (this is exactly why BlitzOS's scan child inherits BlitzOS's/the terminal's FDA).
If the helper inherited BlitzOS's identity, the whole separation would be void.

The helper gets its OWN identity only if it is launched as an independent, responsible process:
- **Chosen mechanism: LaunchServices** — launch via `/usr/bin/open -a BlitzComputerUse.app --args …`
  (or `NSWorkspace.openApplication`). A LaunchServices-launched app is ALWAYS its own responsible
  process, so its Accessibility/Screen-Recording prompts and grants attribute to
  `dev.blitz.os.computeruse`, never to BlitzOS/Electron. (Codex spawns its binary directly with the
  responsibility-disclaim spawn attribute — a private SPI not reachable from Node; LaunchServices is
  the robust, public-API equivalent and is what we use.)
- Consequence: no inherited stdio across a LaunchServices launch, so IPC is a **Unix domain socket**
  (not stdio). BlitzOS owns/listens on a socket in its userData; the helper connects on launch with
  `--connect <path>`. (Codex uses a named pipe + app-group container; a plain Unix socket is the
  non-sandboxed equivalent and needs no app-group entitlement since BlitzOS is not app-sandboxed.)
- **The relaunch ("quit & reopen"):** to apply a just-granted permission, BlitzOS tells the helper to
  `quit`, waits for exit, and `open`s it again. New process, same bundle identity, picks up the grant.
  BlitzOS is untouched. This realizes the insight.

## Components

1. **Native helper** `native/computer-use-helper/` — Swift, builds `BlitzComputerUse.app`:
   - `Info.plist`: `LSUIElement true`, bundle id `dev.blitz.os.computeruse`, `LSMinimumSystemVersion`
     13.0, `NSAppleEventsUsageDescription`.
   - Connects to the `--connect <socketPath>` Unix socket; newline-delimited JSON protocol:
     - `hello` (emitted on connect): bundle id, pid, tcc status.
     - `tcc_status` → `{accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess()}`.
     - `request_accessibility` → `AXIsProcessTrustedWithOptions([prompt:true])` (raises the prompt + lists the app).
     - `request_screen` → `CGRequestScreenCaptureAccess()` (raises the prompt + lists the app).
     - `screenshot` → `CGDisplayCreateImage` → base64 PNG (PROOF the Screen-Recording grant works on
       the helper; ScreenCaptureKit is the real executor path later).
     - `ping`/`quit`.
   - `build.sh`: `swiftc` → bundle → `codesign` with the Developer ID Application cert (hardened
     runtime, the apple-events entitlement). Output `native/computer-use-helper/build/BlitzComputerUse.app`.
2. **Lifecycle manager** (BlitzOS main, `src/main/computer-use-helper.ts`): resolve the bundled
   helper, install/migrate to `~/Library/Application Support/BlitzOS/BlitzComputerUse.app` (stable
   TCC identity across app updates — Codex's installer pattern), `open -a` launch, socket server,
   supervise (relaunch on crash), `relaunchForGrant()`, `status()`/`request(kind)` RPCs.
3. **Pre-board retarget**: the Accessibility + Screen Recording steps drive the HELPER — open the
   pane, `request_*` (lists the helper), drag tile drags `BlitzComputerUse.app` (not BlitzOS), poll
   the helper's reported `tcc_status`, relaunch the helper on grant. FDA stays on BlitzOS (FDA has
   no executor-process issue + the scan child reads it live, no restart). Browser stays Automation.
4. **Packaging**: `electron-builder.yml` `extraResources` ships the signed `BlitzComputerUse.app`
   (tmux pattern); `dist-mac.sh` signs it; the manager installs it to Application Support on first run.

## Slices

- **A (this turn):** native helper source + build/sign script; compiled + Developer-ID signed +
  socket protocol smoke-tested headlessly. Proves the foundational, uncertain piece. The live "the
  prompt names BlitzComputerUse, not Electron" check is the user's (needs display + a real grant).
- **B:** BlitzOS lifecycle manager (install/migrate, open-launch, socket, supervise, relaunchForGrant).
- **C:** pre-board retarget to the helper + packaging (bundle + sign in dist) + plan/doc updates.

## Honest constraints

- **Dev vs packaged:** in `npm run dev` BlitzOS is the unsigned stock Electron binary; the helper is
  signed, but TCC attribution + the separation are only fully real in a signed/notarized packaged
  build. Dev verifies build/launch/socket/relaunch mechanics; the live TCC identity + grant test is
  on a packaged build (the user's).
- **No executor consumer yet:** BlitzOS has no computer-use agent, so the helper's screenshot/a11y
  actions have no caller beyond the proof until that feature lands. The helper + its grants are the
  groundwork the feature will plug into; the immediate payoff is the restart-free permission flow.
