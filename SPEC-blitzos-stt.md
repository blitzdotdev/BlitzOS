# SPEC - Native Speech-to-Text (push-to-talk dictation) for BlitzOS

Target repo: `/Users/minjunes/superapp/teenybase/agent-os` (Electron + React).
Reference (read-only, do NOT copy Swift verbatim): `/Users/minjunes/FluidVoice` (SwiftPM macOS app).
Platform: macOS 15+ (Sequoia or newer), Apple Silicon (arm64) only. No-op cleanly everywhere else.

> Style: no em dashes anywhere in this file or in the code/comments it produces (house rule).

---

## 0. Read-before-you-build (resolve these unknowns first)

Three load-bearing facts in earlier drafts were asserted but are not verifiable from this machine. Resolve them with commands before writing `main.swift`, and treat the results as ground truth over anything in this spec:

1. **FluidAudio's real API is unverified.** There is NO local FluidAudio checkout (`/Users/minjunes/FluidVoice/.build/checkouts/FluidAudio` is absent) and the pin is a feature-branch fork (`github.com/altic-dev/FluidAudio.git`, branch `B/cohere-coreml-asr`, revision `ba6e4359fbb0d00b63e789354acc3f005641cfe4`, confirmed in `/Users/minjunes/FluidVoice/Package.resolved`). Branch-fork APIs drift. After `swift package resolve` (Step 2), grep the resolved checkout for the ACTUAL public symbols and adapt:
   ```sh
   rg -n "public (final )?class AsrManager|public struct AsrModels|func downloadAndLoad|public func transcribe|public struct ASRResult|enum .*Version|public init" \
     native/dictation-helper/.build/checkouts/FluidAudio/Sources
   ```
   The symbols this spec names (`AsrModels.downloadAndLoad(version:)`, `AsrManager(config:)`, `initialize(models:)`, `transcribe(_:source:) -> ASRResult{text,confidence}`) are the EXPECTED shape from FluidVoice's call sites, not a guarantee. If they differ, adapt the sidecar and keep the wire contract in section 2.1 stable (the renderer only ever sees `text`). Do not hard-fail the spec on a symbol rename; fix the call site.

2. **FluidAudio's runtime OS floor is 15, not 14.** `/Users/minjunes/FluidVoice/Package.swift` declares `platforms: [.macOS(.v15)]`. The existing BlitzOS helpers target 13, but this sidecar links FluidAudio, so it targets **`.macOS(.v15)`** with `LSMinimumSystemVersion=15.0`, and the whole feature is runtime-gated off below macOS 15 (section 3.7). After resolve, also grep the checkout for `@available(macOS 1[5-9]` to catch any higher symbol-level floor.

3. **SwiftPM resource-bundle resolution in a hand-assembled `.app` is the real risk, and `otool` does not test it.** `otool -L` only proves there is no external dylib/`@rpath`; it says nothing about whether `Bundle.module` finds FluidAudio's CoreML/vocab `*.bundle` at runtime. The objective proof is a `--selftest` mode that actually loads the model and transcribes a sample (Step 5 / acceptance). Note that the large CoreML weights are downloaded to `~/Library/Application Support/FluidAudio/Models/` at runtime (NOT bundled); the `*.bundle` resources are config/vocab only, which narrows the footgun but does not remove it.

---

## 1. Goal

Holding the **fn (Globe)** key starts recording from the mic; while held, a minimal pill at the bottom-center of the screen shows the **live transcribed text and nothing else**; the instant fn is **released**, recording stops and the final transcript is inserted into whatever text field is focused in any app. Transcription uses **FluidAudio's multilingual Parakeet (parakeet-tdt-0.6b-v3)**, **downloaded/installed in the background** with on-screen progress (outside the pill) so the feature works with effectively zero manual setup.

"Done" = on an Apple-Silicon Mac running macOS 15+, with the dictation sidecar granted Microphone + Input Monitoring and the existing `BlitzComputerUse.app` holding Accessibility:
- fn-hold (>250 ms) then speak then release reliably inserts the spoken text into the focused field of Notes / TextEdit / Chrome / Slack;
- the bottom pill mirrors the live transcript and only the transcript, then fades within ~1 s of release;
- the model downloads in the background on first run with a visible progress notification (never blocking the fn key), and is instant on every later launch;
- model state, permission prompts, and the fn-key conflict are surfaced through native notifications and System Settings, never through the pill;
- everything no-ops cleanly (no crash, one log line) off macOS-15-arm64.

---

## 2. Chosen approach

**A dedicated, stably-signed SwiftPM sidecar `BlitzDictation.app` that owns the fn-key tap, the mic, and Parakeet inference; text insertion is delegated to the EXISTING `BlitzComputerUse.app` helper's Accessibility grant via chunked `cg_type`; the bottom pill is a renderer-only body portal driven by `osBroadcast`; and all non-transcript feedback (model, permissions, fn conflict) is surfaced through native macOS notifications, not the pill.**

Why a separate SwiftPM sidecar:
- **FluidAudio is a SwiftPM dependency**, so the sidecar must be a `swift build` package. The existing helpers are single-file `swiftc main.swift` builds (`native/computer-use-helper/build.sh`, `native/island-helper/build.sh`), which cannot pull an SPM graph. Build FluidAudio from source via `swift build -c release`, pinned to the exact revision, statically linked.
- This rejects the fragile RPATH-link-into-`/Applications/FluidVoice.app` idea (breaks if FluidVoice is absent or version-bumped) and rejects adding the SPM dep to the CU helper's build (there is no Xcode project; re-architecting the CU helper risks its already-granted, load-bearing Accessibility/Screen TCC identity).
- **Insertion is delegated to the CU helper's `cg_type`**: Accessibility is the hardest grant and the CU helper already holds it. The dictation sidecar therefore needs only Microphone + Input Monitoring, never Accessibility. (Synthetic key events posted to other apps require the posting process to be Accessibility-trusted, which is exactly why we route insertion through the CU helper rather than posting keys from the sidecar.)
- **Reuse the `HelperManager` lifecycle** from `computer-use-helper.ts` (install-to-appData, launch via `open -n <app> --args --connect <sock>` for an independent TCC identity, Unix-socket newline-JSON `hello`/`reply`/`event` protocol, supervise + reconnect). Section 3.7 makes this a SHARED base module so the logic is not duplicated.
- **Preview = a renderer pill** (`createPortal` to `document.body`), driven by `osBroadcast({type:'dictation', ...})` -> existing preload `onAction` -> component. No new BrowserWindow, no new preload API.

Two corrections folded in from review:

- **Insertion uses chunked, paced `cg_type`, not paste.** The CU helper's `cgKey` only maps a fixed set of non-modifier keys (`return/enter/tab/space/delete/backspace/escape/left/right/down/up`); it has no `v` and no modifier chords, so a Cmd-V paste is impossible without modifying the CU helper (out of scope, section 7). `cgType` posts per-character keyDown/keyUp in a tight loop with no pacing, which can drop/reorder characters when fed whole paragraphs into some Chromium/Electron targets. So insertion runs through a main-process `insertDictatedText()` that chunks grapheme-cluster-safely and paces between chunks, with a notified clipboard fallback (section 3.7).
- **The fn key conflict is reconciled, not blessed.** A lone fn press on a default Mac performs the user's `AppleFnUsageType` action (1 = Change Input Source, 2 = Show Emoji and Symbols, 3 = Start Dictation; 0 = Do Nothing). We keep the tap **observe-only** (swallowing fn `flagsChanged` would break fn-as-modifier globally: fn+F-row, fn+arrows, fn+delete all read the fn flag from the live event stream). We instead READ `AppleFnUsageType` and, when it is non-zero, surface a one-time reconciliation prompt (section 3.7). `AppleFnUsageType=3` is called out specifically because Apple Dictation grabs the SAME microphone and will contend with ours.

### 2.1 Shared event / command contract (used by sections 3.2, 3.7, 3.8)

Sidecar -> main, unsolicited `event` frames (newline-delimited JSON, `type:"event"`, `kind:"dictation"`). `seq` is a monotonically increasing integer per recording session so the main process can drop stale partials.

| `state` | payload | meaning |
|---|---|---|
| `partial` | `text`, `seq` | live preview text for the current hold |
| `final` | `text`, `seq` | one and only one per completed hold; triggers insertion |
| `idle` | (none) | recording ended, buffer cleared |
| `model` | `ready:bool`, `phase:"absent"\|"downloading"\|"loading"\|"ready"\|"error"`, `progress?:0..1`, `bytes?:int`, `total?:int`, `error?:string`, `retryable?:bool` | model lifecycle (NEVER shown in the pill) |
| `perm` | `need:"inputMonitoring"\|"microphone"`, `granted:bool` | permission needed/denied |
| `conflict` | `fnUsage:int` (1/2/3) | lone-fn action is set; reconciliation needed |

Main -> sidecar commands (request/reply, mirrors the CU helper's `run` dispatch):

| cmd | reply | effect |
|---|---|---|
| `ping` | `{pong:true}` | liveness |
| `dictation_status` | `{modelReady, modelPhase, recording, fnUsage, tcc:{inputMonitoring,microphone}}` | full status snapshot |
| `prepare_model` | `{ok}` | kick background acquire/load (idempotent; `{force:true}` retries after error) |
| `tcc_status` | `{inputMonitoring, microphone}` | TCC snapshot |
| `request_perms` | `{tcc:{...}}` | call `CGRequestListenEventAccess()` / `AVCaptureDevice.requestAccess` |
| `quit` | `{ok:true}` then terminate | clean shutdown |

Main -> renderer, via `osBroadcast` (the existing `osBroadcast` in `osActions.ts` -> `os:action` -> preload `onAction`; the channel does not whitelist `type`, so a `dictation` payload passes). The pill ONLY ever receives transcript phases:

```
{ type:'dictation', phase:'partial'|'final'|'idle', text?:string }
```

`model` / `perm` / `conflict` are NEVER broadcast to the renderer; they are handled in the main process as native notifications and System Settings deep-links (section 3.7). This is what keeps the pill transcript-only (hard requirement #4) while still giving the user first-run and error feedback.

---

## 3. Changes (file-by-file)

### New native sidecar - `native/dictation-helper/`

1. **`native/dictation-helper/Package.swift`** (new) - SwiftPM executable target `BlitzDictation`.
   - `// swift-tools-version: 5.9`, `platforms: [.macOS(.v15)]` (matches FluidAudio's declared floor; see section 0.2).
   - FluidAudio dependency pinned by **revision** (not branch) for reproducibility. Default to the **Blitz-controlled mirror** to survive upstream force-push/deletion (section 3.15); if no mirror exists yet, the upstream fork is the temporary source:
     ```swift
     .package(url: "https://github.com/blitz-os/FluidAudio.git", // mirror; fall back to altic-dev/FluidAudio.git until mirrored
              revision: "ba6e4359fbb0d00b63e789354acc3f005641cfe4")
     ```
   - `targets: [.executableTarget(name: "BlitzDictation", dependencies: ["FluidAudio"])]`.
   - Commit the resulting `Package.resolved` (section 3.15).

2. **`native/dictation-helper/Sources/BlitzDictation/main.swift`** (new) - the sidecar. Behavior ported (re-implemented, not copied) from FluidVoice:

   - **Socket client**: a `HelperConnection` connecting to the Unix socket from `--connect <path>`, newline-delimited JSON, `send(_: [String:Any])` plus a background `run(handle:)` read loop. Mirror the `final class HelperConnection` / `func run(handle:)` structure in `native/computer-use-helper/main.swift`. On launch send `{"type":"hello","bundleId":...,"pid":...}`.

   - **App shell**: `NSApplication.shared`, `app.setActivationPolicy(.accessory)` (faceless, as the CU helper does), then `app.run()` to spin the run loop the CGEventTap needs.

   - **OS gate**: at startup, if `ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion:15, minorVersion:0, patchVersion:0))` is false, send `{state:"model",ready:false,phase:"error",error:"unsupportedOS"}` and exit 0 without creating taps. (The main process already gates launch in 3.7; this is defense in depth.)

   - **fn (Globe) press-and-hold**, ported from `GlobalHotkeyManager.swift`:
     - `CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: 1<<CGEventType.flagsChanged.rawValue, callback:…)`. Use `.defaultTap` (active) but **always pass the event through** (`return Unmanaged.passUnretained(event)`); never return `nil` for `flagsChanged` (returning nil swallows the event and would break fn-as-modifier system-wide, per the CU helper's own tap-callback note).
     - In the C callback read `event.flags.contains(.maskSecondaryFn)`. Act only on edges: rising (was up, now down) -> `startRecording()`; falling (was down, now up) -> `stopRecording()`. Ignore repeats while already recording.
     - Re-enable on `.tapDisabledByTimeout` / `.tapDisabledByUserInput` via `CGEvent.tapEnable(tap:enable:true)` (mirror the CU helper's `reenable()` and its tap-callback re-enable branch).
     - **fn conflict read**: at startup and on each `startRecording()`, read `AppleFnUsageType` from the global domain via `CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, kCFPreferencesAnyApplication)` (absent or `0` => no conflict). If non-zero, emit `{state:"conflict",fnUsage:<n>}` (debounced to once per launch unless the value changes). Do not attempt to change it from the sidecar (the main process owns that, with consent).

   - **Permissions — JUST-IN-TIME on first fn use, NEVER at onboarding/launch** (see §8 amendment; authoritative):
     - At launch the sidecar prompts for NOTHING. It does NOT call `CGRequestListenEventAccess()` and does NOT call `AVCaptureDevice.requestAccess()` on startup. It only reads non-prompting status: `CGPreflightListenEventAccess()` and `AVCaptureDevice.authorizationStatus(for:.audio)`, and reports them via `dictation_status`/`tcc_status`.
     - The fn tap is created listen-only at launch WITHOUT prompting. If Input Monitoring is already granted (returning user), fn works silently with no prompt ever shown again.
     - Microphone: requested lazily on the FIRST fn-hold that starts a recording — `startRecording()` calls `AVCaptureDevice.requestAccess(for:.audio)` the first time `authorizationStatus == .notDetermined`, so the mic prompt appears at the exact moment the user first holds fn. `.denied`/`.restricted` -> emit `{state:"perm",need:"microphone",granted:false}` (notification + Settings deep-link), do not start the engine.
     - Input Monitoring: by macOS design the tap cannot observe fn until this grant exists, so it is the one grant that must precede the first observable keypress. The sidecar calls `CGRequestListenEventAccess()` the first time it arms the tap on a fresh install (emitting `{state:"perm",need:"inputMonitoring",granted:false}` -> a single native notification "Hold fn to dictate - enable Input Monitoring"). This is still triggered by first use of the dictation sidecar, NOT bundled into BlitzOS onboarding. After either grant, relaunch the sidecar only (reuse the CU helper's relaunch-for-grant pattern) to pick it up.

   - **Mic capture (thread-safe)**: `AVAudioEngine`; install a tap on `inputNode` with its native format; convert to **16 kHz mono Float32** via `AVAudioConverter`. Ownership of the sample buffer is single-threaded:
     - One serial queue `let audioQueue = DispatchQueue(label:"dev.blitz.dictation.audio")` owns `var pcm:[Float]`.
     - The tap callback converts then `audioQueue.async { pcm.append(contentsOf: frame) }`. Nothing else touches `pcm` off this queue. This removes the data race between the tap thread and the partial timer.

   - **Parakeet (multilingual v3)**, ported from `FluidAudioProvider.swift` (adapt to the real API per section 0.1):
     - `prepareModel()` (idempotent, guarded by a state enum `absent/downloading/loading/ready/error`): `let models = try await AsrModels.downloadAndLoad(version: .v3)` (downloads to `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml` when missing), then `let mgr = AsrManager(config: .default); try await mgr.initialize(models: models)`. Emit `{state:"model",ready:false,phase:"downloading"}` on entry; if FluidAudio exposes a progress callback, forward `progress`/`bytes`/`total`; on load emit `{state:"model",ready:false,phase:"loading"}`; on success `{state:"model",ready:true,phase:"ready"}`.
     - **Download failure / retry**: wrap acquisition in retry-with-backoff (3 attempts, ~1 s / 4 s / 10 s). Classify the error (`network`/`disk`/`unknown`); after the final failure emit `{state:"model",ready:false,phase:"error",error:<class>,retryable:true}` and stop (do not spin). A later `prepare_model {force:true}` restarts the cycle. Before downloading, refuse and emit `{...,error:"disk",retryable:true}` if free space on the Models volume is under ~2 GB.

   - **Live partials (bounded, non-reentrant)**: a repeating ~0.4 s timer while recording. Each tick runs on `audioQueue`:
     - If `isTranscribing` is already true, skip (coalesce; no reentrancy).
     - Else set `isTranscribing=true`, take an immutable `snapshot = pcm` (copy under the serial queue), then dispatch the transcribe off-queue on the snapshot; clear `isTranscribing` on completion (back on `audioQueue`).
     - **Cost bound (avoid O(n^2) stalls on long holds)**: PARTIALS transcribe at most the trailing `PARTIAL_WINDOW = 30 s` of `snapshot` (`snapshot.suffix(30*16000)`); the FINAL transcribes the full buffer (up to the 120 s cap). This keeps partial latency roughly constant on long holds, at the cost of the preview text losing the earliest words on very long holds; the FINAL restores them. Emit `{state:"partial",text:<result.text>,seq:<n>}`.

   - **Final + exactly-once**: track `var recordingActive=false`. `startRecording()` sets it true (only if model `ready`; otherwise see Guards). `stopRecording()` runs only if `recordingActive`; it sets `recordingActive=false`, does one full-buffer `transcribe`, emits exactly one `{state:"final",text,seq}` (skipping empty/whitespace), clears `pcm`, then emits `{state:"idle"}`. The **120 s auto-stop** calls the SAME `stopRecording()` path, so it flips `recordingActive=false`; the subsequent real fn-release sees `recordingActive==false` and emits no second `final`. This guarantees exactly one final per hold even across an auto-stop.

   - **Command replies** in `run`'s dispatch (mirror the CU helper's `case` switch): `ping`, `dictation_status`, `prepare_model`, `tcc_status`, `request_perms`, `quit` per section 2.1.

   - **`--selftest` mode** (new; the real resource-bundle + API proof): if launched with `--selftest`, do not open sockets/taps; run `prepareModel()` (download if needed), transcribe a short bundled or synthesized PCM sample, print `SELFTEST OK text=<...>` to stdout and exit 0; on any failure print `SELFTEST FAIL <reason>` and exit non-zero; if the model is absent and `--selftest-no-download` is also passed, print `SELFTEST MODEL_ABSENT` and exit 2. Used by Step 5 and acceptance.

   - **Guards**: ignore fn holds shorter than 250 ms (rising-to-falling under 250 ms => no recording). Never emit a `final` for empty/whitespace text. Cap one recording at 120 s (auto-stop path above). If the model is not `ready` on fn-down: kick `prepareModel()` if idle, emit nothing to the pill, do NOT set `recordingActive`, and rely on the main process to show the "preparing" notification. Never block the fn key on a download.

3. **`native/dictation-helper/Info.plist`** (new) - model on `native/computer-use-helper/Info.plist`: `CFBundleIdentifier=dev.blitz.os.dictation`, `CFBundleExecutable=BlitzDictation`, `CFBundleName="BlitzOS Dictation"`, `CFBundleVersion=1`, `CFBundleShortVersionString=1.0`, `LSMinimumSystemVersion=15.0`, `LSUIElement=true`, `NSMicrophoneUsageDescription="BlitzOS transcribes your voice to text."`.

4. **`native/dictation-helper/entitlements.plist`** (new): `com.apple.security.device.audio-input = true`. Hardened runtime is applied via `codesign --options runtime`. (Input Monitoring and Accessibility are TCC grants, not entitlements; Accessibility is never requested by this sidecar.)

5. **`native/dictation-helper/build.sh`** (new, executable) - SwiftPM build, modeled on `native/island-helper/build.sh`:
   - `swift build -c release --arch arm64` from the package dir.
   - Assemble `build/BlitzDictation.app/Contents/{MacOS,Resources}`; copy `.build/release/BlitzDictation` -> `Contents/MacOS/`; copy `Info.plist`; brand the icon from `../../src/renderer/src/assets/aqua-bubble.png` (reuse the `sips`+`iconutil` block).
   - **Copy SwiftPM resource bundles next to the executable AND into Resources** (belt and suspenders for `Bundle.module` resolution in a hand-assembled app): `cp -R .build/release/*.bundle Contents/Resources/ 2>/dev/null || true` and `cp -R .build/release/*.bundle Contents/MacOS/ 2>/dev/null || true`. If the `--selftest` (Step 5) cannot find resources at runtime, that copy placement is the first thing to adjust.
   - **Signing identity (stable, TCC-critical)**: prefer `BLITZ_DICTATION_SIGN_IDENTITY` -> a Developer ID Application in the keychain -> a **persistent named self-signed identity** "BlitzOS Dev" -> ad-hoc `-` as a LAST resort. Sign nested bundles first, then the app, with `codesign --force --options runtime --timestamp --sign "$ID" --entitlements entitlements.plist "$BUNDLE"`, then `codesign --verify --verbose "$BUNDLE"`.
   - **Loud warning on unstable identity**: if the resolved identity is ad-hoc, print `"[dictation] WARNING: ad-hoc signing -> code identity changes every rebuild -> Microphone + Input Monitoring grants RESET on each rebuild. Use a stable identity for grant persistence."` The dev-stable recipe (documented in a build.sh comment) is a one-time self-signed cert:
     ```sh
     # one-time: create a reusable code-signing identity so TCC grants stick across rebuilds
     # (Keychain Access > Certificate Assistant > Create a Certificate: name "BlitzOS Dev",
     #  type "Code Signing", self-signed), then: export BLITZ_DICTATION_SIGN_IDENTITY="BlitzOS Dev"
     ```

6. **`native/dictation-helper/.gitignore`** (new): `build` and `.build`.

### Shared main-process helper base + new dictation module

7. **`src/main/helper-process.ts`** (new) + **`src/main/dictation.ts`** (new). Resolve the "verbatim `HelperManager` duplication" by extracting, not copying:

   - **`helper-process.ts`** holds the generic, app-agnostic machinery currently inside `computer-use-helper.ts`'s `HelperManager`: candidate-path resolution (`bundledHelperApp`/`installedHelperApp` style), install-to-appData, `open -n … --args --connect <sock>` launch, `hello` handshake/`ensure()`, newline-JSON socket, `call()` rpc, `onEvent()`, supervise/reconnect, `relaunchForGrant()`, `shutdown()`. It is parameterized by `{ bundleName, installDirName, envOverride, helloTimeoutMs }`.
   - **`computer-use-helper.ts`** is refactored to construct its `HelperManager` from this base (behavior-preserving; it keeps `computerUseHelper()`, `cg_type`, its existing `onEvent` wiring, and its Swift-side TCC identity untouched). This refactor is TS-only and does not touch the signed Swift bundle, so it cannot affect the CU helper's TCC identity; it MUST still pass the CU-helper smoke (onboarding TCC drag + a `cg_type` round-trip) before merge.
     - If the refactor is judged too risky to the CU path under time pressure, the explicit fallback is to COPY the base into `dictation.ts` with a header `// DUPLICATED FROM computer-use-helper.ts - keep in sync` and leave `computer-use-helper.ts` alone. Either path is acceptable; the shared base is preferred.
   - **`dictation.ts`** exports a `dictationHelper()` singleton built on the base with `{ bundleName:'BlitzDictation.app', installDirName:'BlitzOS', envOverride:'BLITZ_DICTATION_APP' }`, install dir `join(app.getPath('appData'),'BlitzOS','BlitzDictation.app')`. It also exports `handleDictationEvent` and owns:
     - **OS gate**: `ensure()` returns `{ok:false, reason:'requires macOS 15'}` (and never launches) when `process.platform!=='darwin'`, when the bundle is absent, or when the major from `process.getSystemVersion()` is < 15. One log line, no throw.
     - **`handleDictationEvent` mapping** (registered from index.ts, section 3.11):
       - `partial` -> `osBroadcast({type:'dictation',phase:'partial',text})`
       - `final` -> `await insertDictatedText(text)` (below), then `osBroadcast({type:'dictation',phase:'final',text})`
       - `idle` -> `osBroadcast({type:'dictation',phase:'idle'})`
       - `model` -> `updateModelNotification(payload)` (native `Notification`: a single progress/ready/error notification, deduped; NEVER broadcast to the pill). On `phase:'error'` include a Retry action that calls `dictationHelper().call('prepare_model',{force:true})`.
       - `perm` -> native `Notification` + `shell.openExternal` to the correct pane: Input Monitoring `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`, Microphone `…?Privacy_Microphone`.
       - `conflict` -> `reconcileFnConflict(fnUsage)` (below), throttled to once per app run.
     - **`insertDictatedText(text)`**:
       1. Trim; if empty/whitespace, no-op.
       2. Split into grapheme-cluster-safe chunks of <= 60 clusters (use `Intl.Segmenter(undefined,{granularity:'grapheme'})` so multilingual clusters/emoji are never split mid-codepoint).
       3. For each chunk: `await computerUseHelper().call('cg_type',{text:chunk})`; if the reply has `{error}` or the call rejects, break to the fallback. Sleep ~12 ms between chunks to pace the synthetic key burst.
       4. **Fallback** (CU helper not connected, Accessibility not granted, or a chunk failed): `clipboard.writeText(fullText)` and a native `Notification` "Could not type into this field - transcript copied; press Cmd-V to paste." (We intentionally leave the transcript on the clipboard; this is the only path that touches the clipboard, and it always notifies, so it never silently clobbers.)
       5. Known limitation: chunked `cg_type` can still drop characters in some Chromium/Electron fields under load. If acceptance criterion 14 fails there, the documented escalation is a single additive `cg_paste` command in the CU helper (an explicit, surgical section-7 exception), NOT a default.
     - **`reconcileFnConflict(fnUsage)`**: a one-time `dialog.showMessageBox` (main process): title "fn key is assigned to a system action", body naming the action (1 Change Input Source / 2 Show Emoji / 3 Start Dictation) and noting that 3 contends for the same microphone. Buttons: ["Open Keyboard Settings", "Set fn to Do Nothing", "Keep as-is"]. "Open Keyboard Settings" -> `shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')`. "Set fn to Do Nothing" -> run `defaults write -g AppleFnUsageType -int 0` (explicit user consent only; reversible) and notify that a sign-out/in may be required for it to take effect. Never change it without the user choosing that button.
     - **First-run model acquire policy** (`maybeAcquireModel()`, consent + guards, replaces silent boot prewarm): on `ensure()` success, if the v3 model dir exists and is non-empty, do nothing (instant-ready). If absent, default to auto-acquire WITH visible progress, guarded: only auto-start when free disk >= ~2 GB and the network is not known-metered (best-effort; if undetectable, proceed and rely on the progress notification + Cancel). Show a first-run notification "BlitzOS Dictation is downloading a ~600 MB speech model" with a Cancel action; Cancel sets an in-memory opt-out so it does not re-prompt this run, and acquisition then happens lazily on the first fn-hold instead. `BLITZ_DICTATION_NO_AUTODOWNLOAD=1` forces lazy-only.

### Renderer

8. **`src/renderer/src/notch/DictationPreview.tsx`** (new, ~40 lines) - self-subscribing, transcript-only:
   - `useEffect(() => window.agentOS?.onAction((a) => { if (a.type!=='dictation') return; … }), [])`.
   - State `{ text:string; visible:boolean }`. `phase:'partial'|'final'` -> `setText(a.text??''); setVisible(Boolean(a.text))`. `phase:'final'` -> after ~900 ms `setVisible(false)`. `phase:'idle'` -> `setVisible(false)`. There is no `model`/`perm`/`conflict` case because those are never broadcast (section 2.1); the component renders ONLY transcript text.
   - **Window-mode awareness (one-time log, not UI)**: on mount, if the renderer can observe a non-default window mode (a flag exposed by main, or `BLITZ_NATIVE_ISLAND`/`BLITZ_NO_NOTCH_GATE`/`BLITZ_FULLSCREEN` surfaced through an existing config object), `console.warn` once that the pill may be occluded outside the default notchGated overlay window. No visible change.
   - Render a single `<div className="dictation-preview" data-show={visible}>{text}</div>`. No icon, waveform, timer, buttons, mic glyph, or status text.

9. **`src/renderer/src/notch/island.css`** (edit) - append:
   ```css
   .dictation-preview{position:fixed;left:50%;bottom:48px;transform:translateX(-50%) translateY(8px);
     max-width:60vw;padding:10px 18px;border-radius:16px;background:rgba(20,20,22,.82);
     color:#fff;font-size:15px;line-height:1.35;backdrop-filter:blur(12px);pointer-events:none;
     opacity:0;transition:opacity .18s ease,transform .18s ease;z-index:2147483646;white-space:pre-wrap}
   .dictation-preview[data-show="true"]{opacity:1;transform:translateX(-50%) translateY(0)}
   ```
   `pointer-events:none` so it never steals focus/clicks (focus must stay in the user's target field).

10. **`src/renderer/src/App.tsx`** (edit) - add `import { DictationPreview } from './notch/DictationPreview'` next to the existing `import { NotchHost } from './notch/NotchHost'`, and render it as an **unconditional** body portal next to the existing `createPortal(<NotchHost …/>, document.body)` block: `{createPortal(<DictationPreview />, document.body)}`. Independent of `notchOn`/`notchState`.
    - **Why it floats over other apps (corrected rationale)**: it works because in the **default `notchGated` window mode** the BlitzOS window is a full-display, all-Spaces, always-on-top, click-through overlay, so a `bottom:48px` pill renders above other apps. This is a property of the WINDOW MODE, not of the notch being open/closed. Under `BLITZ_NATIVE_ISLAND=1` / `BLITZ_NO_NOTCH_GATE=1` / `BLITZ_FULLSCREEN=1` the host window is ordinary and the pill may be occluded by the focused app; that is a documented limitation (section 6), not a bug.

### Startup + shutdown wiring

11. **`src/main/index.ts`** (edit) - keep to <= 4 added lines plus the import:
    - Import `import { dictationHelper, handleDictationEvent } from './dictation'` near the existing `import { computerUseHelper } from './computer-use-helper'`.
    - In `app.whenReady().then(...)`, immediately after the existing `electronConnections.setWindowLink(makeWindowLink({ … helper: computerUseHelper() }))` call:
      ```ts
      dictationHelper().onEvent((m) => handleDictationEvent(m)) // maps events per section 3.7
      void dictationHelper().ensure().then((r) => { if (r.ok) void dictationHelper().maybeAcquireModel() })
      ```
      `maybeAcquireModel()` applies the consent + guard policy (section 3.7); it is NOT an unconditional `prepare_model`. All event mapping (insertion, notifications, conflict dialog) lives in `handleDictationEvent` inside `dictation.ts`, not in index.ts.
    - In the quit/cleanup path next to the existing `computerUseHelper().shutdown()`: `try { dictationHelper().shutdown() } catch { /* ignore */ }`.

### Build / packaging wiring

12. **`scripts/ensure-helper.sh`** (edit) - add a third block after the notch-geometry block, fail-soft, gated on `command -v swift` (SwiftPM, not just `swiftc`), rebuilding when the binary is missing or `Sources/BlitzDictation/main.swift` is newer:
    ```sh
    if command -v swift >/dev/null 2>&1; then
      DICT_EXE="native/dictation-helper/build/BlitzDictation.app/Contents/MacOS/BlitzDictation"
      if [[ ! -x "$DICT_EXE" || "native/dictation-helper/Sources/BlitzDictation/main.swift" -nt "$DICT_EXE" ]]; then
        bash native/dictation-helper/build.sh || echo "[ensure-helper] WARN: dictation helper build failed - dev continues without it" >&2
      fi
    else
      echo "[ensure-helper] swift (SwiftPM) not found - dev runs WITHOUT dictation" >&2
    fi
    ```

13. **`scripts/dist-mac.sh`** (edit) - after the island build, add:
    `BLITZ_DICTATION_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}" bash native/dictation-helper/build.sh || echo "[dist] WARN: dictation helper build failed - packaging without it"`.

14. **`electron-builder.yml`** (edit) - add to `extraResources`, after the `BlitzIsland.app` entry:
    ```yaml
    - from: native/dictation-helper/build/BlitzDictation.app
      to: BlitzDictation.app
    ```

15. **Supply-chain hardening** (new): mirror FluidAudio at the pinned revision into a Blitz-controlled GitHub org (`github.com/blitz-os/FluidAudio`) and point `Package.swift` at it (section 3.1). Commit `native/dictation-helper/Package.resolved` so the revision is locked. Belt-and-suspenders option if a mirror is not yet available: vendor a snapshot of the resolved source into `native/dictation-helper/vendor/FluidAudio` and use `.package(path:"vendor/FluidAudio")`. Either way the build must survive upstream force-push/deletion.

No new preload API and no `package.json` dependency changes are required.

---

## 4. Steps (ordered build plan)

1. **Scaffold** `native/dictation-helper/{Package.swift, Info.plist, entitlements.plist, build.sh, .gitignore}` and `Sources/BlitzDictation/main.swift` per 3.1-3.6. `chmod +x build.sh`. Set up the FluidAudio mirror/pin per 3.15.
2. **Resolve + verify the real API**: from `native/dictation-helper/`, `swift package resolve`. Then run the grep from section 0.1 against `.build/checkouts/FluidAudio/Sources` and reconcile the actual `AsrModels`/`AsrManager`/`transcribe`/result symbols. Grep for `@available(macOS 1[5-9]` to confirm the runtime floor (section 0.2). Adapt `main.swift` to whatever the symbols actually are. If `swift package resolve` fails on the platform floor, the package is already at v15; do not lower it.
3. **Write `main.swift` incrementally**: socket client + faceless app first; build and confirm it connects (Step 11 socket test). Then add the OS gate, JUST-IN-TIME permissions (no launch prompt; mic on first fn-hold, Input Monitoring on first tap-arm; §8), the fn tap (observe-only, edge + conflict read), thread-safe mic capture, the bounded non-reentrant partials, exactly-once final/auto-stop, and the Parakeet acquire/load with retry. Add `--selftest`.
4. **Build the sidecar**: `bash native/dictation-helper/build.sh`. Fix compile errors against the REAL API from Step 2 (do not trust the symbol names in this spec if they differ).
5. **Verify the bundle (link AND resources AND identity)**:
   - `codesign --verify --verbose build/BlitzDictation.app` passes.
   - `otool -L build/BlitzDictation.app/Contents/MacOS/BlitzDictation | grep -i FluidVoice` prints nothing (no `@rpath` into `/Applications/FluidVoice.app`).
   - `find build/BlitzDictation.app/Contents -name '*.bundle'` lists the FluidAudio resource bundle(s).
   - `build/BlitzDictation.app/Contents/MacOS/BlitzDictation --selftest` prints `SELFTEST OK text=…` (the real proof that `Bundle.module` resolves resources and the API matches at runtime). If it prints `SELFTEST FAIL`, fix the resource-copy placement in build.sh before proceeding.
6. **Add `src/main/helper-process.ts` + refactor `computer-use-helper.ts` + add `src/main/dictation.ts`** per 3.7; implement `handleDictationEvent`, `insertDictatedText`, `reconcileFnConflict`, `maybeAcquireModel`, `updateModelNotification`. Re-run the CU-helper smoke (TCC drag + `cg_type`) to confirm the refactor is behavior-preserving.
7. **Wire `src/main/index.ts`** per 3.11 (import, event handler + `ensure`/`maybeAcquireModel` after the window-link line, shutdown).
8. **Add the renderer** `DictationPreview.tsx` (3.8), the `island.css` rule (3.9), and the App.tsx portal (3.10).
9. **Wire packaging**: `ensure-helper.sh` (3.12), `dist-mac.sh` (3.13), `electron-builder.yml` (3.14); commit `Package.resolved` (3.15).
10. **Static checks**: `npm run typecheck` and `npm run build` both pass.
11. **Standalone sidecar smoke (no Electron)**: terminal A `nc -lU /tmp/blitzdict.sock` (or a tiny node `net.createServer`); terminal B `open -n native/dictation-helper/build/BlitzDictation.app --args --connect /tmp/blitzdict.sock`. Confirm a `{"type":"hello",…}` line; grant Microphone + Input Monitoring when prompted (relaunch after granting); hold fn > 250 ms, speak, release; confirm >=1 `partial` then exactly one `final`. Then test a >120 s hold and confirm exactly one `final` (auto-stop) with no second `final` on release.
12. **End-to-end in dev**: `npm run dev`. Ensure `BlitzComputerUse.app` has Accessibility (existing onboarding pre-board). With `AppleFnUsageType=0`, open TextEdit, focus the body, hold fn, say a short non-English phrase, release -> the text is typed into TextEdit and the pill mirrored it live then faded. Then set `AppleFnUsageType=3` and confirm the reconciliation dialog appears.

---

## 5. Acceptance criteria (checklist)

Build / static (objective commands):
- [ ] **(1)** `bash native/dictation-helper/build.sh` exits 0 and produces `native/dictation-helper/build/BlitzDictation.app/Contents/MacOS/BlitzDictation`.
- [ ] **(2)** `/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' …/Info.plist` prints `dev.blitz.os.dictation`.
- [ ] **(3)** `/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' …/Info.plist` prints `15.0`.
- [ ] **(4)** `codesign --verify --verbose …/BlitzDictation.app` reports valid; and `codesign -dvv …` shows a stable `Identifier=dev.blitz.os.dictation`. With a Developer ID or the named "BlitzOS Dev" self-signed identity, `Authority` is non-ad-hoc.
- [ ] **(5)** `otool -L …/MacOS/BlitzDictation | grep -i FluidVoice` prints nothing, AND `find …/Contents -name '*.bundle'` lists at least one FluidAudio resource bundle.
- [ ] **(6)** `…/MacOS/BlitzDictation --selftest` prints `SELFTEST OK text=<non-empty>` (real proof of API + resource-bundle resolution at runtime).
- [ ] **(7)** `plutil -extract NSMicrophoneUsageDescription raw …/Info.plist` prints a non-empty string.
- [ ] **(8)** `npm run typecheck` passes; `npm run build` passes.
- [ ] **(9)** `grep -q 'BlitzDictation.app' electron-builder.yml`, `grep -q 'dictation-helper' scripts/ensure-helper.sh`, and `grep -q "from './dictation'" src/main/index.ts` all succeed.
- [ ] **(10)** `native/dictation-helper/Package.resolved` is committed and contains revision `ba6e4359fbb0d00b63e789354acc3f005641cfe4`; `swift build -c release` succeeds against the Blitz mirror or vendored source with no network reach to the upstream fork (e.g. verified offline).

Behavioral (objective observables):
- [ ] **(11) OS gate**: on macOS < 15 (or with the `process.getSystemVersion` major forced < 15), `dictationHelper().ensure()` resolves `{ok:false, reason:'requires macOS 15'}`, the sidecar is never launched, no crash, one log line.
- [ ] **(12) Smoke**: a `{"type":"hello"}` frame is received; after granting Mic + Input Monitoring (and relaunch), an fn-hold > 250 ms emits >=1 `{"state":"partial"}` and exactly one `{"state":"final","text":…}`.
- [ ] **(13) Exactly-one-final across auto-stop**: a hold exceeding 120 s emits exactly one `final` (auto-stop) and the later fn-release emits NO second `final` and triggers NO second insertion.
- [ ] **(14) Long-hold stability + latency**: a 60 s continuous hold keeps emitting `partial` frames at least every ~4 s (no stall) and does not crash; the `final` transcript includes words spoken in the first ~5 s of the hold.
- [ ] **(15) Multilingual insertion**: speaking a non-English phrase types the correct text into a native field (TextEdit/Notes); a ~200-char paragraph reproduces with no dropped/reordered characters. If a Chromium/Electron field drops characters, the clipboard fallback engages and a notification is shown (criterion still passes via fallback).
- [ ] **(16) Background install + progress**: with the v3 model dir deleted, launching BlitzOS (>=2 GB free, non-metered) repopulates `~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml`, shows a progress notification, then a `ready:true` notification; a subsequent launch performs no download and reports ready effectively instantly. No action is required beyond (optionally) dismissing the first-run notice.
- [ ] **(17) Download failure path**: with the network offline and the model dir deleted, launch shows exactly one `model error` notification with a Retry action; the sidecar retries with backoff then stops (no spin, no crash); restoring the network and choosing Retry completes the download and yields `ready:true`.
- [ ] **(18) Pill purity**: during and after dictation the pill shows ONLY transcript text (visually confirm: no waveform, timer, mic icon, settings, buttons, or status text) and fades within ~1 s of release. No `model`/`perm`/`conflict` text ever appears in the pill.
- [ ] **(19) fn conflict reconciliation**: with `AppleFnUsageType != 0`, a one-time dialog/notification surfaces the conflict (naming 3 = Start Dictation as a mic conflict) and offers "Open Keyboard Settings" / "Set fn to Do Nothing" / "Keep as-is"; the value is never changed without the user choosing it. With `AppleFnUsageType == 0`, fn-hold dictation works and no lone-fn native action fires.
- [ ] **(20) fn as modifier preserved**: regardless of `AppleFnUsageType`, fn+F-row and fn+arrow combos keep working while the sidecar runs (the tap never returns `nil` for `flagsChanged`).
- [ ] **(21) Short tap**: an fn tap < 250 ms inserts nothing and starts no recording.
- [ ] **(22) Permission denial**: with Input Monitoring revoked for BlitzDictation, an fn-hold does not crash; a `perm` notification opens the Input Monitoring pane; after granting + relaunch, dictation works.
- [ ] **(23) Clipboard fallback notifies**: forcing insertion to fail (CU helper not connected) leaves the transcript on the clipboard AND shows a notification instructing the user to paste (never a silent clobber).
- [ ] **(24) Window-mode dependency documented**: the "floats over other apps" check passes in the default notchGated window mode; under `BLITZ_NATIVE_ISLAND=1`/`BLITZ_NO_NOTCH_GATE=1`/`BLITZ_FULLSCREEN=1` the pill may be occluded (expected), and the renderer logs a one-time warning in those modes.
- [ ] **(25) Supervisor**: killing the sidecar mid-recording triggers a relaunch; the pill auto-hides on `idle`; the next fn-hold works.

---

## 6. Edge cases

- **fn as a normal modifier**: the tap is observe-only (always passes the event through) and holds < 250 ms are ignored, so fn+F-keys, fn+arrows, and fn+delete are unaffected.
- **Lone-fn system action (`AppleFnUsageType` 1/2/3)**: read it; if non-zero, surface the one-time reconciliation dialog (3.7). `=3` (Start Dictation) is flagged because Apple Dictation grabs the same mic; recommend "Do Nothing". Never swallow fn to suppress it (that breaks fn-as-modifier).
- **Model not ready on fn-down**: kick `prepareModel()` if idle, skip that session (no `recordingActive`, no insert), and let the main process show a "preparing" notification. Never block the fn key on a download.
- **Model download fails / offline / low disk**: retry with backoff (3x), then emit a `model error` event; the main process shows a Retry notification; pre-check >= 2 GB free before downloading. No spin, no crash.
- **First-run consent / metered network**: default to auto-acquire with a visible progress notification and a Cancel action, guarded by disk space and a best-effort metered check; Cancel (or `BLITZ_DICTATION_NO_AUTODOWNLOAD=1`) defers to lazy acquisition on first use.
- **Empty / whitespace transcript**: never insert; emit `idle` only.
- **Insertion fails** (CU helper not connected, Accessibility not granted, or a chunk errors): fall back to `clipboard.writeText` and notify; the pill still showed the text.
- **Long paragraphs / multilingual bursts**: insert via grapheme-cluster-safe chunks (<= 60 clusters) paced ~12 ms apart to avoid synthetic-event drops; clipboard fallback if drops persist.
- **Sample-rate mismatch**: always convert the input node to 16 kHz mono Float32 via `AVAudioConverter` before feeding `transcribe`.
- **CGEventTap disabled by the system** (timeout/user input): re-enable in the callback (`CGEvent.tapEnable(tap:enable:true)`), mirroring the CU helper's `reenable()`.
- **fn mashing / key-repeat flagsChanged**: act only on rising/falling edges of `.maskSecondaryFn`; ignore repeats while recording.
- **Long holds**: cap at 120 s -> auto-stop -> single final via the shared `stopRecording()` path; the subsequent fn-release emits no second final (`recordingActive` guard).
- **Audio buffer thread-safety**: a single serial `audioQueue` owns the `[Float]` buffer; the partial timer works on an immutable snapshot with an `isTranscribing` reentrancy guard; partials transcribe at most a trailing 30 s window, the final the full buffer.
- **Sidecar crash mid-recording**: the helper base supervises and relaunches; the in-flight buffer is dropped (acceptable); the pill auto-hides on `idle`/timeout.
- **Non-Apple keyboard with no fn/Globe**: `.maskSecondaryFn` is never set, so dictation never triggers. Documented limitation; no error surfaced.
- **Focus theft**: the pill is `pointer-events:none` inside the click-through, non-activating overlay, and the sidecar is `.accessory` launched detached, so the user's target field keeps focus and `cg_type` lands there.
- **Non-default window mode**: under `BLITZ_NATIVE_ISLAND=1`/`BLITZ_NO_NOTCH_GATE=1`/`BLITZ_FULLSCREEN=1` the pill may be occluded by the focused app (the over-all-apps behavior depends on the default notchGated overlay window). Documented limitation; renderer logs once.
- **A grant that needs an app relaunch to take effect** (Input Monitoring, Microphone): reuse the CU helper's relaunch-for-grant pattern (quit + relaunch the sidecar only; BlitzOS untouched).
- **Unstable signing in dev**: ad-hoc signing changes the code identity each rebuild, resetting Mic + Input Monitoring grants; build.sh warns and documents the one-time "BlitzOS Dev" self-signed identity for grant persistence.

---

## 7. Out of scope (do not touch)

- The notch island state machine, `IslandPanel.tsx`, `NotchHost.tsx`, the Option-Space behavior, and any existing island UI; the pill is a separate, independent portal.
- `native/computer-use-helper/main.swift` and the signed `BlitzComputerUse.app`: reuse its `cg_type` as-is; do not modify or re-sign it (do not disturb its TCC identity). The only sanctioned exception, IF acceptance criterion 15 cannot be met with chunked `cg_type`, is adding a single additive `cg_paste` command, treated as a deliberate, separately-reviewed change.
- FluidVoice's other features: command mode, rewrite mode, meeting transcription, vocabulary boosting / CTC rescoring, Whisper/AppleSpeech providers, waveform, timer, settings, sounds.
- The streaming EOU model path (`StreamingEouAsrManager`, `parakeet-eou-streaming`): it is not the multilingual v3 model; use `AsrManager` + `AsrModels.downloadAndLoad(version: .v3)`.
- The agent-socket relay, workspaces, onboarding scan, and the localhost control server protocol.
- Windows/Linux/Intel and macOS < 15: the sidecar and `dictation.ts` no-op (guarded), never launched, no crash.
- No new preload (`src/preload/index.ts`) surface: `onAction` already carries the `dictation` events.

---

**Key grounding decisions worth flagging for review:**

1. **Verify the FluidAudio API before trusting this spec.** There is no local checkout and the pin is a feature-branch fork, so the named symbols (`downloadAndLoad`, `AsrManager`, `transcribe`, `ASRResult`) are an expected shape, not a fact. Step 2 resolves the package and greps the real symbols; the build compiling and `--selftest` passing are the real proofs.
2. **Target macOS 15, runtime-gated.** FluidAudio declares `.macOS(.v15)`; shipping a lower floor risks a runtime crash on 14.x. The sidecar targets v15, `LSMinimumSystemVersion=15.0`, and the feature no-ops below 15.
3. **The pill stays transcript-only; all other feedback moves to native notifications.** This resolves the tension between "just works on first use" and hard requirement #4: first-run download progress, permission prompts, model errors, and the fn conflict are surfaced as notifications and System Settings deep-links, never in the pill.
4. **The fn conflict is reconciled, not blessed.** We read `AppleFnUsageType` and prompt (with consent) to set "Do Nothing" rather than passively letting the OS emoji/input-source/dictation action fire on every hold; `=3` is flagged as a same-mic conflict. The tap stays observe-only because swallowing fn would break fn-as-modifier.
5. **Insertion is chunked, paced `cg_type` with a notified clipboard fallback**, because the CU helper's `cgKey` cannot produce a Cmd-V chord and per-character `cgType` drops paragraph-scale bursts. A surgical `cg_paste` in the CU helper is the documented escalation only if testing shows drops.
6. **Partials are bounded and race-free**: single-owner serial audio queue, immutable snapshots, an `isTranscribing` reentrancy guard, and a trailing-30 s partial window so long holds do not stall; the final uses the full buffer with exactly-once semantics across the 120 s auto-stop.
7. **Stable signing and a mirrored dependency** so TCC grants persist across rebuilds and the build survives upstream force-push/deletion. The shared `helper-process.ts` base removes the verbatim `HelperManager` duplication without touching the CU helper's signed bundle.

---

## 8. Amendment (user decisions, 2026-06-20) - AUTHORITATIVE over any earlier text

1. **Separate sidecar confirmed.** Keep the dedicated `BlitzDictation.app`; do not merge into the computer-use helper (it would force computer-use up to macOS 15 and risk resetting its Accessibility/Screen TCC grants). Insertion still delegates to the CU helper's `cg_type`.

2. **Permissions are JUST-IN-TIME, triggered by first use, never at onboarding or BlitzOS launch.** Replaces the old launch-time preflight (section 3.2):
   - Onboarding and BlitzOS startup request NOTHING dictation-related. No preflight prompt.
   - The sidecar launches passively and arms the fn tap listen-only WITHOUT prompting. If Input Monitoring is already granted, fn dictation just works, no prompt ever shown.
   - **Microphone**: requested the instant the user FIRST holds fn to record (`AVCaptureDevice.requestAccess` on the first `.notDetermined` `startRecording()`). The mic prompt appears on that first fn-hold and never again.
   - **Input Monitoring**: macOS cannot deliver the fn key to the tap until this grant exists, so it is the one permission that must precede the first observable keypress. The sidecar calls `CGRequestListenEventAccess()` the first time it arms the tap on a fresh install, paired with ONE native notification ("Hold fn to dictate - enable Input Monitoring"); after granting, the sidecar relaunches itself and fn works. This is still gated on first use of the dictation sidecar, not folded into onboarding.
   - Acceptance: launching BlitzOS on a fresh machine shows NO Mic/Input-Monitoring prompt until the user first engages dictation. (Supersedes the wording of criteria 12 and 22, which assumed grants were already in place.)

3. **Pill design is final** (`blitzos-stt-pill.html`): bottom-center glass pill, transcript text only; the optional streaming caret may stay or be dropped. No other changes.

5. **Rip-out-able layout (user decision).** The feature must be removable cleanly if it turns out bad. Consolidate ALL main-process TypeScript for dictation under a single folder `src/main/stt/` (e.g. `src/main/stt/dictation.ts`, `src/main/stt/helper-base.ts`). The dictation sidecar must be FULLY SELF-CONTAINED: do NOT refactor or couple `src/main/computer-use-helper.ts` to a shared module - leave the CU helper exactly as it was and give STT its OWN copy of any helper-process base inside `src/main/stt/`. The native sidecar stays isolated in `native/dictation-helper/` and the single renderer component in `src/renderer/src/notch/DictationPreview.tsx` (+ its one `island.css` block + one `App.tsx` portal line). Net result: the entire feature is removed by deleting `src/main/stt/`, `native/dictation-helper/`, and `DictationPreview.tsx`, then dropping 2 wiring lines (the `index.ts` import and the `App.tsx` portal) and the css block - with `computer-use-helper.ts` never touched. `src/main/index.ts` imports dictation from `./stt/dictation`.

4. **Automated build pass scope (this Codex run).** BlitzOS is RUNNING right now on this machine, so do NOT disrupt it: implement ALL the code (sidecar + main-process glue + renderer pill + packaging) and satisfy the build/static acceptance criteria (1-10). You MAY run `swift build` / `build.sh`, the `--selftest`, `npm run typecheck`, and `npm run build`. Do NOT run `npm run dev`, do NOT launch `BlitzDictation.app` or any helper that captures the mic / fn / Input Monitoring, and do NOT restart or rebuild the live BlitzOS app. The interactive behavioral criteria (11-25) are left for the user to verify manually afterward. Keep all edits inside `/Users/minjunes/superapp/teenybase/agent-os`; do not modify `native/computer-use-helper/` Swift or its signed bundle.
