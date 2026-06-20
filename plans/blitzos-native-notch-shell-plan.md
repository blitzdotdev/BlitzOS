# BlitzOS Native Notch Shell Plan

Status: Deferred plan, written after the V1 overlay/Mission Control experiments.

## Summary

V1 can keep the Electron overlay. The current Electron notch UI is good enough for V1 product work, and the team is comfortable with the "Agent OS" overlay window appearing in Mission Control for now.

This plan is for the later path off the full-screen Electron overlay. The key conclusion from the investigation is:

- The windowing shell should become native AppKit/Swift.
- The product UI does not necessarily need to be fully rewritten in Swift.
- The native shell should own the macOS behavior: notch anchoring, all-Spaces behavior, focus/non-activation, hover and click tracking, hotkey ownership, and Mission Control cleanliness.
- The island UI can either be ported to SwiftUI or hosted as a small web/React view inside the native shell.

## Current State

There are two relevant implementations in the repo:

- React/Electron notch UI:
  - `src/main/notch-overlay.ts`
  - `src/main/index.ts` under `notchGated`
  - `src/renderer/src/notch/NotchHost.tsx`
  - `src/renderer/src/notch/IslandPanel.tsx`
  - `src/renderer/src/notch/IslandHome.tsx`
  - `src/renderer/src/notch/IslandSettings.tsx`
  - `src/renderer/src/notch/IslandTerminalPane.tsx`
- Native helper:
  - `native/island-helper/main.swift`
  - `src/main/island-bridge.mjs`
  - `src/main/island-membership.mjs`

The React/Electron path has the current product UI: Home, Chat, Settings, archived agents, debug terminal, active tab handling, and the newer notch interaction fixes.

The native helper has the better macOS shell behavior, but its UI is older. It currently shows the old SwiftUI island with the Workflow toggle, not the current React notch UI.

## What We Learned

Electron overlay behavior:

- The full-display transparent Electron window works for the live notch interaction.
- macOS still treats that window as a real app window.
- Mission Control shows the large "Agent OS" window thumbnail.
- `skipTransformProcessType: true` did not hide the notch from Mission Control.
- `setContentProtection(true)` did not hide the notch from Mission Control.
- There is no reliable public Electron event for "Mission Control is open" that we can use to hide only the notch at that exact moment.

Native helper behavior:

- A native `LSUIElement`/`NSPanel` style helper avoids the full-screen Electron overlay problem.
- It can behave more like a true menu-bar/notch resident.
- The issue is UI parity, not shell feasibility.

## Decision For V1

Do not block V1 on this rewrite.

For V1:

- Keep the Electron overlay path.
- Accept that Mission Control may show the Agent OS overlay window.
- Stop spending time on brittle Electron-only attempts to hide the notch in Mission Control.
- Keep the native-shell plan as a later cleanup/hardening path.

## Goal For The Native Shell

Replace the full-screen Electron overlay with a native notch shell that:

- Does not show a giant blank "Agent OS" window in Mission Control.
- Stays visually anchored to the hardware notch.
- Opens on hover/click/Option-Space without stealing focus.
- Works over other apps and full-screen Spaces.
- Keeps the current V1 island product behavior.
- Preserves the existing agent runtime, terminal/session backend, and chat/control semantics.

## Non-Goals

- Do not replace the agent runtime.
- Do not bring back canvas/surface language for V1.
- Do not reintroduce widget tooling as part of this shell migration.
- Do not rebuild the whole Electron app inside the native helper.
- Do not depend on private Mission Control APIs.

## Options

| Option | Description | Pros | Cons | Recommendation |
|---|---|---|---|---|
| Keep Electron overlay | Continue with full-display transparent Electron window | Current UI already works; lowest effort | Mission Control artifact remains; Electron focus/click quirks | Keep for V1 only |
| Bounded Electron window | Replace full-display overlay with a small top-center Electron window | Smaller Mission Control footprint; reuses React directly | May still appear in Mission Control; may not cover notch/menu-bar correctly; click-through edge cases | Prototype only if we want one more Electron experiment |
| Native SwiftUI port | Rebuild current island UI in SwiftUI inside `BlitzIsland.app` | Most native; best Mission Control/focus behavior; no web runtime | Highest rewrite cost; duplicates React UI work | Strong long-term option |
| Native shell + embedded web UI | Native AppKit shell hosts a small web/React island view | Keeps native windowing while reusing React UI patterns | More bridge/plumbing complexity; WKWebView packaging/dev loop to solve | Best first serious migration candidate |

## Recommended Path

Use a native AppKit shell with either:

1. A SwiftUI implementation of the current island UI, if we want maximum native behavior and are comfortable porting UI.
2. A small embedded web UI, if we want to preserve the current React notch work and move faster.

Default recommendation: start with the hybrid native shell plus embedded web island view. It gives us native windowing without forcing an immediate full UI rewrite. If the embedded view gets awkward, fall back to a SwiftUI port with the same bridge contract.

## Architecture Sketch

Electron remains the hidden host:

- Boots the app backend.
- Owns agent runtime, terminal lifecycle, transcripts, archive metadata, and connection/computer-use APIs.
- Starts the local control server.
- Launches/supervises the native island shell.

Native shell owns:

- Notch window placement.
- NSPanel/LSUIElement lifecycle.
- Option-Space hotkey.
- Hover/click tracking.
- Non-activation/focus behavior.
- All-Spaces/full-screen behavior.
- Presentation container for the island UI.

Bridge owns:

- Session list.
- Active session selection.
- Chat transcript tail/snapshot.
- User message send.
- Agent spawn/archive/unarchive/delete.
- Settings state.
- Terminal debug state if retained.

## Bridge Direction

The existing `src/main/island-bridge.mjs` already proves a native helper can connect over `/island` and receive process snapshots/events. For parity with the React notch UI, the bridge needs to grow from process tabs into a broader island protocol.

Suggested message families:

- `island.snapshot`
  - sessions
  - archivedSessions
  - activeId
  - settings
  - status map
  - transcript slices
- `island.event`
  - session upsert/remove
  - transcript append
  - status change
  - terminal output append
  - settings change
- `island.command`
  - open chat
  - select session
  - send message
  - spawn session
  - archive session
  - unarchive session
  - delete session
  - set debug terminal
  - request terminal scrollback

Keep the bridge vocabulary island/chat-oriented. Avoid canvas, surface, stage, slot, workspace, or window-on-canvas language.

## UI Parity Checklist

Before replacing the Electron overlay, the native shell must support:

- Collapsed notch pill with status/peek affordance.
- Home view with Chat and Settings entry.
- Chat app/session view.
- New-session composer.
- Agent tab strip.
- Active session transcript.
- Markdown rendering or equivalent rich text display.
- Composer auto-grow.
- Stop/retry/error states if present in React at migration time.
- Details/tool rows if present in React at migration time.
- Settings view.
- Yellow DEBUG flag for debug-only settings.
- Show active agent terminal toggle.
- Active-agent terminal pane if retained.
- Archived agents list.
- Restore archived agent.
- Delete archived agent with confirmation.
- Tab reset behavior when entering Chat from Home.
- Hover/click behavior without the tab hover bugs previously fixed in React.

## Implementation Phases

### Phase 0: Preserve V1 Overlay

Keep the current Electron overlay working while this plan is parked.

Acceptance:

- `BLITZ_NATIVE_ISLAND=0 npm run dev` still runs the React/Electron notch overlay.
- Existing notch tests stay green.
- V1 product work continues in React notch files.

### Phase 1: Define Native Shell Contract

Write a short protocol spec for the native island shell.

Files likely involved:

- `src/main/island-bridge.mjs`
- `src/main/island-bridge.d.mts`
- `src/main/index.ts`
- `native/island-helper/main.swift`
- new tests under `scripts/`

Acceptance:

- Protocol can represent active sessions, archived sessions, settings, transcript slices, and terminal debug state.
- Protocol explicitly excludes canvas/surface vocabulary.
- Existing process-list behavior remains backward-compatible until the UI migrates.

### Phase 2: Native Shell Skeleton

Update `BlitzIsland.app` shell behavior before porting UI.

Acceptance:

- Native panel appears anchored to the notch.
- Option-Space opens/closes.
- Hover open/close works without flicker.
- Panel does not steal focus unless an editable field intentionally requests focus.
- Mission Control does not show a giant full-screen Agent OS overlay.
- No duplicate hotkey ownership with Electron overlay mode.

### Phase 3A: Hybrid Web Island Prototype

Prototype a native `NSPanel` shell hosting a small web island UI.

Possible approaches:

- Bundle a minimal HTML/JS island app and load it into `WKWebView`.
- Serve the island UI from the local control server in dev and from bundled files in prod.
- Use the native shell as window/chrome only; let the web view render UI.

Acceptance:

- Home/Chat/Settings render inside native panel.
- User can spawn/send/select sessions.
- Archived agents render and restore/delete works.
- Basic CSS matches current React notch closely enough to compare.
- Mission Control behavior is clean enough to justify continuing.

### Phase 3B: SwiftUI Parity Prototype

Only do this if hybrid web view is too awkward.

Acceptance:

- SwiftUI version reaches parity on the UI checklist.
- Chat transcript and settings remain backed by the Electron/main runtime.
- No duplicated agent/session persistence logic in Swift.

### Phase 4: Migration Switch

Add a clean launch switch:

- `BLITZ_NATIVE_ISLAND=1` or default macOS launch uses native shell.
- `BLITZ_NATIVE_ISLAND=0` keeps Electron overlay for fallback/dev.
- `BLITZ_SHOW_DESKTOP=1` reveals the hidden Electron host only for debugging.

Acceptance:

- Native shell can be dogfooded for a full session.
- Electron overlay remains available as fallback.
- No normal user path opens a blank Electron canvas window.

### Phase 5: Retire Overlay If Native Wins

After the native shell is stable:

- Move Electron overlay to legacy/debug.
- Remove dead native-helper UI paths that no longer match product.
- Keep bridge tests and launch-mode tests.

Acceptance:

- V1/V1.1 product UI runs in native shell.
- Mission Control no longer shows a giant Agent OS overlay for the normal path.
- Fallback env var remains for at least one release cycle.

## Test Plan

Static/source tests:

- Native shell launch path does not show the Electron host window.
- Electron overlay fallback still works.
- The native bridge exposes session/archive/settings protocol messages.
- No `store.openTerminal`/canvas terminal surfaces are used for island debug terminal.
- No canvas/surface/stage/workspace terms appear in user-facing native island strings.

Runtime/manual:

- Launch native shell.
- Open/close with Option-Space.
- Hover open and close repeatedly.
- Open Chat from Home and verify it starts on new-session composer.
- Select Agent 1/2/3 and verify active tab behavior.
- Archive, restore, and delete an agent.
- Toggle debug terminal and switch agents.
- Enter Mission Control and verify no full-screen Agent OS overlay thumbnail.
- Test over a full-screen app Space.
- Test on a non-notched display.
- Test with multiple displays.

Commands:

```bash
node scripts/test-island-bridge.mjs
node scripts/test-notch-hit-window.mjs
npm run typecheck
git diff --check
npm run build
```

## Risks

- Hybrid `WKWebView` may make dev iteration or asset bundling annoying.
- SwiftUI port may drift from the React UI unless one implementation becomes canonical.
- Focus behavior for text input is the hardest native-shell detail.
- Terminal debug pane may be too heavy for native shell and could remain dev-only.
- Having both native and Electron overlay paths can create hotkey duplication if launch gating is sloppy.

## Open Questions

- Is the native shell intended for V1.1, or a post-V1 hardening pass?
- Do we want the island UI source of truth to be React or SwiftUI?
- If hybrid, should the web island be loaded from bundled static assets or local dev server/control server?
- Should debug terminal ship in the native shell, or stay behind the Electron overlay/debug path?
- Do we still want a bounded Electron window prototype before starting native work?

## Current Recommendation

Ship V1 on the Electron overlay. Later, build the native shell as a focused windowing migration, not as a product redesign.

When the team returns to this:

1. Start with the hybrid native shell plus embedded web island prototype.
2. Keep all agent/runtime/session logic in Electron/main.
3. Expand `island-bridge.mjs` only as much as needed to represent the current island UI.
4. Fall back to a SwiftUI port only if the web island creates more complexity than it saves.
