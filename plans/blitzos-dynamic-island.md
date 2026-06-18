# BlitzOS — Dynamic Island (notch HUD), RE'd from NotchNook

Status: PLAN. Reverse-engineered from `NotchNook.app` v1.5.5 (lo.cafe) on 2026-06-17 by dissecting the bundle + the universal Mach-O. Architecture + UI settled 2026-06-17: a PURE NATIVE Swift/AppKit HUD whose role is **launching and monitoring BlitzOS agent processes** at the notch, talking to the Electron app over a **WebSocket on BlitzOS's existing localhost control server**. Spawning a process is the per-agent **`orchestrators` (workflow) on/off toggle** from `blitzos-blitzscript.md`. We borrow NotchNook's WINDOW technique (the RE below) but NOT its UI (no nook/tray/airdrop tabs, no media/calendar live activities). Every RE claim is backed by a symbol/plist key found in the binary, noted inline as `evidence:`.

**Headline finding: NotchNook uses only PUBLIC AppKit** (no SkyLight/CGS/SLS private calls in the binary). The "native dynamic island" is a borderless `NSWindow` at a high level, positioned over the notched screen via `NSScreen.safeAreaInsets`, drawn as a custom black `NotchShape` with concave top corners, expanded on hover, with `NSVisualEffectView` glass. We can reproduce it cleanly.

**What our island IS (the product):** a compact, always-present HUD that is a shortcut for (1) **spawning** BlitzOS agent processes and (2) **browsing/checking status** of every alive one. ⌥Space toggles it fully open. It is the notch face of BlitzOS's agent runtime, not a system widget.

---

## How NotchNook works (RE'd) — we port the WINDOW, not the UI

**App shell.** Menu-bar agent: `LSUIElement = true`, `LSMinimumSystemVersion = 14.6` (evidence: Info.plist). Not App-Sandboxed (entitlements: apple-events automation + camera + mic + calendars + a Setapp mach-lookup), which is what permits global monitors + high-level windows. Repositions on display change via `applicationDidChangeScreenParameters:` + `windowDidChangeBackingProperties:`.

**The window (this is what we port).** A borderless `NSWindow` (evidence: `setBackgroundColor:`, `setHasShadow:`, `orderFrontRegardless`; no NSPanel symbol):
- always-on-top + over fullscreen via `setLevel:` + `setCollectionBehavior:` (evidence) at a status/screen-saver-class level, joining all Spaces + fullscreen-aux + stationary.
- non-activating: overrides `canBecomeKey` (evidence: `_canBecomeKey`, `CanBecomeKeyBindingKey`) so it never steals focus until a field inside needs typing.
- click-through outside the pill: `setIgnoresMouseEvents:` (evidence) toggled by region.
- shadow drawn in-content (`ShadowedNotchShapeView`), not by the window.

**Notch detection.** `NSScreen.safeAreaInsets` (evidence) for the top inset; `notchedScreens` tracking + `notchHeightFineTune` / `notchWidthFineTune` user nudges + `hiddenInNonNotchedScreens` (evidence: all four). The notch WIDTH comes from `auxiliaryTopLeftArea`/`auxiliaryTopRightArea` (the rects beside the notch; their gap = the notch).

**The shape.** A custom `Shape` named `NotchShape` with an `inverted` flag (evidence: `NotchShape`, `NotchShapeView`, `ShadowedNotchShapeView`, `inverted`, `setCornerRadius:`): an opaque black rounded rect whose TOP corners are concave so it tucks into the menu-bar corners and reads as a continuation of the physical notch.

**Hover + glass.** Hover via `addLocalMonitorForEventsMatchingMask:handler:` + a `NotchGesturer` (evidence). Expanded chrome uses `NSVisualEffectView` `setMaterial:`/`setBlendingMode:` (evidence: `So18NSVisualEffectViewC`, `NNSVisualEffectMaterial`).

**Drag (we keep the animation, drop the rest).** Classic AppKit drag destination: `registerForDraggedTypes:` + `draggingEntered:` + `performDragOperation:` reading file URLs off `NSPasteboard`, previews via `NSWorkspace.icon(forFile:)` (evidence: `iconForFile:`), QuickLook via `QLPreviewPanelDataSource` (evidence). **We diverge here:** keep the drag-in ANIMATION, but there is no Tray TAB and no Tray/AirDrop split partition (their hover-to-reveal AirDrop zone). Dropped files attach to the current process tab in one unified zone.

---

## How BlitzOS builds its own

### `BlitzIsland.app` — the native helper

A Developer-ID-signed Swift/AppKit helper modeled on `BlitzComputerUse.app` (`plans/blitzos-computer-use-helper.md`): `LSUIElement`, built + signed by `scripts/dist-mac.sh`, installed to `~/Library/Application Support/BlitzOS`, launched via LaunchServices (`open -n`), supervised by a small bridge in BlitzOS main. It renders 100% natively by porting the window technique above. VERIFIED RECIPE (read from the reference): an `NSPanel` with `level = .mainMenu + 3`; `collectionBehavior = [.fullScreenAuxiliary, .stationary, .canJoinAllSpaces, .ignoresCycle]`; `canBecomeKey`/`canBecomeMain = false` (never steals focus); `isOpaque=false` + clear background + `hasShadow=false`; and `hidesOnDeactivate = false` so it stays visible when another app is focused (the exact flag the launcher bug taught us). Notch rect from `safeAreaInsets`/`auxiliaryTopLeftArea`; the concave `NotchShape` is a top-concave (radius ~6 closed / ~19 open) + bottom-rounded (~14 / ~24) path (functional notch geometry). **ANTI-FLICKER RULE (the bug that produced a floating rectangle + massive flicker): the window is FIXED at `windowSize` (openNotch 640×190 + 20 shadow) and pinned top-center; it is NEVER resized. Resizing the window on hover made it grow under the cursor and thrash the hover tracking. Instead the SwiftUI CONTENT animates `notchSize` between the real closed notch and the open size via springs (open response 0.42/damping 0.8, close 0.45/1.0), `.onHover` opens and a debounced exit closes.** The open island is BLACK (matching the physical notch), not glass, faithful to the reference. Rendered via `NSHostingView` (SwiftUI), like the reference. Drag-in with `NSWorkspace` icons. It registers its OWN ⌥Space global hotkey to toggle itself.

### The island UI: one tab type = a "blitz process"

There is exactly ONE tab type. Each tab is a BlitzOS agent process with a per-tab state machine:
- **new → a chat bar.** Type a prompt (and optionally drop files), with a **workflow (orchestrators) on/off toggle**, to spawn a process. ON spawns the agent as an orchestrator (its duty is "for a real task, author + run a blitzscript workflow"); OFF spawns a plain agent that acts directly (a normal request). The toggle is the per-agent `orchestrators` switch from `blitzos-blitzscript.md`.
- **working → a concise message list.** The condensed, human-readable summary events the agent emits, sized for the small space.
- on new → working the tab **auto-names itself** from the work (like Ghostty/Claude-Code tabs).
- **every event is one line, click to expand.** Activity and chat/say events render truncated to a single line for the notch; clicking a line expands it in place to the full text.

Tabs = every alive process. Navigate by **swipe left/right** or **clicking the tab header**; a new-tab affordance opens a fresh chat bar. You can **keep messaging** a process from the island; messages from the island carry a "you are in the island, answer concisely" instruction **injected into the user's prompt** (confirmed). **Dropped files attach to the CURRENT tab's process** (confirmed), keeping the drag animation; no tray tab, no AirDrop split.

### Transport: WebSocket over the existing control server

BlitzOS already runs a localhost HTTP control server with a bearer token (`control-server.ts`). Add a **WebSocket upgrade route** (e.g. `/island`) on that same server, authenticated with the same token. The island is then just another authenticated client of the existing control plane, not a new socket surface.
- **Swift side:** `URLSessionWebSocketTask` (built into Foundation, no third-party dep). **Node side:** `ws` on the control server's existing http server.
- **Lifecycle:** BlitzOS launches + supervises the island (`open -n`, relaunch if the connection drops); the island auto-reconnects if BlitzOS restarts.
- **Durability = reconnect-and-resnapshot:** BlitzOS is the source of truth; on every (re)connect it sends the full process snapshot, so either app restarting self-heals. (Performance is a non-issue: localhost WS is sub-ms to low-ms, far under human-real-time.)
- The bridge logic lives in a new `src/main/island-bridge.ts` (the WS route + supervise + the mapping below).

### Message set — 5 core types, grounded in BlitzOS's existing event vocabulary

No new taxonomy: `state` reuses `agentStatus`; an event line reuses the existing `activity` shape `{at, text, agentId, tool}` (`activity.mjs`). JSON frames; commands carry a reply id.

- **island → BlitzOS (3)**
  - `hello {token}` — auth; the reply is the first `process.list`.
  - `process.spawn {prompt, paths[], orchestrators}` → `{id}` — `orchestrators` is the chat-bar workflow toggle.
  - `process.message {id, text, paths[]}` — BlitzOS injects the concise preamble; dropped files ride here as `paths`, so there is no separate attach command.
- **BlitzOS → island (2)**
  - `process.list {processes:[{id, title, state, recent:[activity]}]}` — the FULL snapshot, sent on connect AND on any change (idempotent; covers add / rename / state-change / remove with no incremental-merge logic). `state` = the existing `agentStatus` (running / idle / stopped / working / waiting / error) plus an island-local `new` for an un-spawned chat-bar tab; the **auto-name** is just `title` changing. `recent` = a short tail of `activity` events so a reconnect rehydrates each tab's message list.
  - `process.event {id, activity}` — append one `activity` line live.

Deferred (not core): `process.close {id}` (tab close → stop) and `process.focus {id}` (open in BlitzOS), added only when tab-management / open-in-app is wired.

Durability: full-state `process.list` on every change + on reconnect is self-healing across either app restarting (no deltas to lose).

### Reuse (mostly glue, not new agent machinery)

- `process.spawn` → mint an agent with the `orchestrators` toggle set (blitzscript's `start_workflow`); `process.message` → `emitUserMessage` (the same delivery `/steer` uses) with the concise preamble prepended; `process.event` → the agent's existing `activity` feed (`activity.mjs`); `process.list`/title/state → the agent/terminal manager (`agentStatus`) + the workflow run. New code is the WS route + mapping in `island-bridge.ts`.

### Token parity

The native island reimplements the look from token VALUES (accent `#e31c30`, radii, type). Export a tiny shared `tokens.json` subset both the renderer and the island read, so the look stays in sync without hand-copying hex.

---

## Decisions needing sign-off

1. **Spawn = an agent with the `orchestrators` (workflow) toggle** (RESOLVED: the chat bar exposes the on/off). DEPENDENCY: this rides on the blitzscript `orchestrators` toggle + `start_workflow` landing (`blitzos-blitzscript.md` sequencing steps 3-4, not yet built; only the `blitz` runner + `llm()` are built so far). Until that lands the island can spawn a plain agent and treat the toggle as a no-op.
2. **Auto-name source:** reuse the existing agent/process title vs a tiny title generator when none exists. Lean: reuse, generate only if absent.
3. **⌥Space fully replaces the Electron launcher** (remove its `globalShortcut`; the island owns the chord). Confirmed; noted here so the launcher change ships with P0.
4. **Notch geometry:** native `safeAreaInsets`/`auxiliaryTopLeftArea` + a fine-tune slider fallback (as NotchNook ships).

## Phased plan

- **Prereq — study the reference.** Clone **Boring Notch** (`TheBoredTeam/boring.notch`, SwiftUI, GPL-3.0) into `.repos/` and STUDY its `NotchShape` geometry / window setup / hover to reimplement cleanly. LICENSING: GPL-3.0, so learn the technique and reimplement, do NOT copy its code into BlitzOS. Template the helper lifecycle/agent-policy on our own `native/computer-use-helper/main.swift` instead.
- **P0 — shell + WS + ⌥Space.** `BlitzIsland.app` stub: borderless always-on NSWindow at the notch (concave black `NotchShape`, hover-expand to an empty glass panel) showing one empty process tab (a chat bar). `island-bridge.ts` adds the `/island` WS route + token handshake; a `ping`/`pong` round-trips. Rebind ⌥Space (remove the launcher hotkey; the island registers its own) to toggle the island.
- **P1 — spawn + attach from the island.** Chat bar (with the workflow toggle) → `process.spawn` → `start_workflow` (mint an agent with the `orchestrators` toggle set); the tab flips to working, auto-names, and streams `process.event` lines. Drag files attach to the current tab (keep the animation, one unified zone, no tray tab / no AirDrop split).
- **P2 — multi-tab monitor.** `process.list` (full snapshot) populates and live-updates every tab; swipe / click-header navigation; keep-messaging a process (concise preamble); single-line events with click-to-expand.
- **P3 — polish.** Drag-out (file promises), QuickLook on spacebar, notch fine-tune sliders, multi-monitor reposition (`applicationDidChangeScreenParameters:`), Lottie open/close + drag animations.

## References
- The RE evidence above (symbol grep of `NotchNook.app/Contents/MacOS/NotchNook`).
- **Boring Notch** — open-source notch HUD to study the window/shape/hover technique from (theboring.name; GitHub `TheBoredTeam/boring.notch`, GPL-3.0 — reimplement clean, do not copy). Alt reference: `monuk7735/mew-notch`. Clone into `.repos/`.
- `native/computer-use-helper/main.swift` + `build.sh` — the faceless-agent + JSON-command-loop + swiftc/codesign template `BlitzIsland.app` clones (swapping the Unix socket for `URLSessionWebSocketTask`).
- `plans/blitzos-computer-use-helper.md` — the signed-native-helper + LaunchServices + supervise pattern.
- `src/main/control-server.ts` — the localhost control server + bearer token the `/island` WebSocket route hangs off.
- `plans/blitzos-blitzscript.md` — the per-agent `orchestrators` (workflow) on/off toggle the chat bar exposes; spawn = `start_workflow`.
- Journey `Pass 2 item 2` (`blitzos-user-journey.md`) — attaching a macOS app or browser tab to the current island process (browser tab → agent-socket, other app → computer-use). A planned capability of a process tab, owned jointly by this doc + the computer-use helper + agent-socket.
- `src/main/launcher.ts` — the Electron tray POC that is the UX spec for the native drag-in.
