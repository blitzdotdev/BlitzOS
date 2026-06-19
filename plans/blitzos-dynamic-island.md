# BlitzOS — Dynamic Island spec: "open Blitz anywhere"

Status: SPEC (2026-06-18). Supersedes the native-helper direction: the PoC (`/Users/minjunes/superapp/notch-spill-poc`) proved a pure-Electron window covers the notch + spills to fullscreen (`coversMenuBar=true`, zero native code). So the island becomes an in-BlitzOS Electron overlay, not a separate Swift app. This doc is the port plan + the product vision; the windowing reference is in the Appendix.

## Design: LOCKED (2026-06-18)
The 5-prototype design pass is over. We shipped ONE island and retired the rest.
- **Chassis is invariant.** Black `#000` + the original NotchShape (square top, 28px rounded bottom), owned by `.nh-chassis` (`notch/notch.css`). The interior never changes the bg color or shape. Ported verbatim from the old `.notch-entry`.
- **The one design** is `notch/IslandPanel.tsx` + `island.css` (the macOS Dynamic Island direction). Deliberately MINIMAL: no header row, no icons, no agent title/subtitle. Session view = the composer + a slim foot (Deep + recency). Process view = the tab strip (carries agent identity + status) over the activity feed, above the steer bar. White-on-black, SF Pro.
- **Retired:** the other 4 prototypes (rams / alcove / modern / expressive), the `_baseline` stub, the `notch/index.ts` registry, and the ⌥←/→ proto switcher in App.tsx. Research history stays in `island-proto-briefs.md`.
- Still visual-only (mock data in `notch/mock.ts`); live agent wiring is the next step. Test: `node scripts/test-island-window.mjs`.

## Naming (settle this)
- **Blitz** = the BRAIN. The main agent (what we were loosely calling "blitzos" the agent). ⌥Space "opens Blitz."
- **BlitzOS** = the OS / desktop: the infinite canvas, surfaces/widgets, the agent runtime. Blitz runs on BlitzOS.
- **"Workflow" needs a better user-facing name** — the on/off capability where a spawned agent runs a multi-step orchestrated pass (fan-out, deep work) vs a plain chat reply, the way you spin up a deep-research agent in ChatGPT / a Claude Code session, but for ANY task. Backend term is already `orchestrators` (`plans/blitzos-blitzscript.md`); we need the WORD users see. Candidates: **Deep** (lean — "spawn a Deep agent", toggle Deep on; matches "deep research"), Orchestrate, Crew, Swarm, Campaign, Mission, Pipeline. OPEN — your call.

## The one idea
**⌥Space opens Blitz anywhere** — over any app (the macOS notch island) or inside BlitzOS — showing the SAME basic entry interface in both. The island is a notch-anchored BlitzOS surface that grows on demand and can BECOME any widget.

## Interaction model (one openness, several stops)
A single "openness" drives ONE continuous grow, reusing the PoC clip-path + the current native island's NotchShape + spring timing:
- **closed** → the notch pill
- **hover near it** → expand to the panel (x%) = the current dynamic-island HUD, **pixel-matched to the native island** (this is just a partial stop of the same animation)
- **click** → fill to **fullscreen**
- **click again / Esc** → suck back

The native hover-expand and the click-to-fullscreen are the SAME animation at different stops. ⌥Space toggles open/closed from anywhere.

## The island IS a surface host (it becomes whatever widget is needed)
The open island is NOT a fixed HUD. It is arbitrary BlitzOS canvas space that hosts whatever widget the moment calls for — chat, a [Deep] dashboard, a timer, a graph, a menu button, a custom UI to do some work. Same surface/widget model as the rest of BlitzOS (`srcdoc`/`native`/`app` surfaces); the island is just another place a surface can live (the notch).
- **Default content (the ⌥Space entry)** = the **Blitz entry**: a prompt/chat bar + spawn controls, IDENTICAL in the island and in BlitzOS (one shared component).
- Blitz (or context) morphs the island into the right widget. No per-widget hardcoding — the generalization doctrine: BlitzOS supplies a generic surface host; the agent decides what it becomes.

## Agent visualization — the CROWN JEWEL (north star, start researching NOW)
The highest-leverage thing in BlitzOS is **how Blitz VISUALIZES its work**: how it composes widgets and what it shows inside them. This is the crown jewel and a PERMANENT direction, not a one-off feature. Every release should push further toward MORE:
- **more dynamism** — live, animated, reactive UI (not static cards),
- **more range** — the full widget vocabulary AND novel compositions of them,
- **more expressivity** — Blitz picks/builds the RIGHT representation for the moment (a timer, a graph, a dashboard, a chat, a menu, a bespoke control), and shows rich state inside it.

Ceiling: Blitz composes increasingly sophisticated, REAL apps as surfaces, backed by **blitz.dev** (data / auth / storage), not just widgets. The island's "becomes any widget" is the first instance of the SAME engine that drives the whole canvas.

Doctrine fit: a generic surface host + the agent decides what it becomes (no per-widget hardcoding) — the unknown-N generalization rule.

**Research agenda (basics first, begin now):**
- The design space + references to study: generative / agent-composed UI (Claude artifacts, ChatGPT canvas, Vercel AI SDK generative UI), agent-presence & liveness visualization, Apple Dynamic Island / Live Activities as expressivity references.
- The **composition grammar**: how the agent reliably CHOOSES, lays out, and animates widgets for a moment.
- The **authoring loop**: how an agent authors a `srcdoc`/jsx widget reliably + expressively, and escalates to a blitz.dev-backed app when the task needs real data/auth/storage.

This is CROSS-CUTTING (all of BlitzOS, not just the island) and should graduate to its own research doc + track as it grows.

## Agents + [Deep] spawn
⌥Space talks to **Blitz** (the main agent). From the entry you spawn sub-agents:
- **[Deep] ON** = an orchestrated agent: authors + runs a blitzscript workflow, fanning out for a real task (deep-research style, any task).
- **[Deep] OFF** = a plain chat agent that just converses.
Reuses the verified seams IN-PROCESS (no WebSocket): `startWorkflow` (on) / `spawnAgent` + `userMessage` (off) / `setOrchestrators` (toggle an existing tab) / `agentStatus` + `say` (status + replies). Spawned agents also appear on the BlitzOS canvas (they are real agents).

## Architecture (the port)
- An in-BlitzOS Electron **overlay window** using the PoC's proven config: `setAlwaysOnTop('screen-saver')` (above the menu bar), `setVisibleOnAllWorkspaces({visibleOnFullScreen:true})` (all Spaces + over other apps' fullscreen), `setBounds(display.bounds)` + `enableLargerThanScreen` (covers the menu-bar/notch band), `setIgnoreMouseEvents(true,{forward:true})` toggled (click-through except the notch). 100% Electron.
- It renders a **React surface host** that calls `osActions`/`electronOps` **in-process** — this RETIRES the native `BlitzIsland.app`, the WebSocket bridge (`island-bridge.mjs`), and the chat.md tail (all only existed to bridge a separate process).
- Port the **NotchShape + springs + panel layout** from the native island so the hover-expand is visually identical.
- The ONE genuinely native bit: read the exact **notch WIDTH** (`NSScreen.safeAreaInsets` / `auxiliaryTopLeftArea`); the height is free from Electron's `workArea`. ~10 lines, optional, with a fine-tune fallback.

## Decisions needing sign-off
1. **The [workflow] rename** (lean: Deep).
2. **Window:** a dedicated island overlay window (low risk, isolated from the sandwich) vs make BlitzOS's MAIN canvas window itself the notch overlay (cleaner "spill into the live app," but a bigger change to the sandwich compositor). Lean: dedicated first, merge later.
3. **What "fill" shows:** the real live BlitzOS home canvas (needs #2's merge) vs the island window rendering its own fullscreen surface for now. Lean: own surface first, wire to the real home after.
4. **Confirm retiring** the native `BlitzIsland.app` + the WS bridge (in-process Electron makes them unnecessary).

## Phases
1. **The dynamic island.** Overlay window (PoC config) + the exact closed↔hover-panel animation + a React surface host wired in-process. Default = the Blitz entry (chat + [Deep] toggle + spawn). One demo widget (chat). **[BUILT]**
2. **Spill.** Click-to-fill to fullscreen + suck-back (the same grow continued). **[BUILT]**
3. **Arbitrary widgets + polish.** The island can become any BlitzOS widget on demand (timer / graph / dashboard / custom). Native notch-width read for exact alignment. Retire the native app + WS bridge.

**Next phase (exploration spec): `plans/blitzos-dynamic-island-next.md`** — notch status rails, ⌥Space new-session vs ⌥Space-Space enter, a richer new-session widget, hover-overview-as-surface, swipe to switch agent-session tabs. Explore + prototype before building.

### Build notes (2026-06-18) — THE MERGE: the real canvas window IS the notch
The separate `island.ts` overlay window (and the native `BlitzIsland.app`) are RETIRED. Earlier attempts were all "fake": a second window painting a plate that grew, then handed off — a separate window can never clip the real canvas, so it covered (white/gray) then swapped at 100% (video note: "black screen expanding out and in, not the real canvas"). The fix is the merge, decided + built 2026-06-18 (user: "just build it", "fuck the sandwich, the browser will be nuked anyway").
- **Sandwich OVERLAY mode** (`createSandwich({ overlay: notchGated })`): ONE frameless transparent full-display window (`frame:false` + `enableLargerThanScreen`, covers the menu-bar/notch band), NOT parented to `pages` (the L0 browser backdrop stays hidden — the renderer's opaque `.bg` paints the canvas color), `screen-saver` + all-Spaces + `showInactive` (no focus steal) + `setIgnoreMouseEvents(true,{forward})` at launch. New `sandwich.setInteractive(on)` toggles the click-through. (`pages`/web surfaces don't render in overlay mode — the browser is being retired.)
- **The renderer clips the REAL canvas** (`App.tsx`): `#root-canvas` gets `clip-path: notchClip` (a `notchPath` NotchShape) with a `clip-path` transition, growing through 3 stops — closed (notch) → panel (hover entry) → open (fullscreen). Outside the clip the transparent window shows the desktop; the clip reveals the LIVE `.bg` + `.world` (real widgets) as it grows. The black notch HANDLE (the pill) + the black ENTRY panel (Ask Blitz + Deep + Send) live INSIDE `#root-canvas`, so the clip reveals the canvas AROUND them. This is the "edges become un-transparent" the user asked for — no second window, no plate, no handoff.
- **Main↔renderer**: `os:notch-interactive` → `setInteractive`; `os:notch-send` → spawn (Deep ON `startWorkflow` / OFF `spawnAgent`+`userMessage`); `os:notch-geometry` → menu-bar height (the notch height); ⌥Space → `os:notch-toggle`. Bridge = `agentOS.notch` (preload). Renderer flips click-through on notch-hover (real-element hit-test) and `uiFocus()`es on expand (keyboard).
- **Escape hatch**: `BLITZ_NO_NOTCH_GATE=1` (or `BLITZ_FULLSCREEN=1`) → normal sandwich (no overlay), recover if the overlay traps you.
- **Known/【flag for GUI】**: web (`web`) surfaces don't show in overlay mode (browser retiring); onboarding now appears when you enter (canvas hidden until the notch is clicked); the titlebar traffic lights are odd in overlay mode (the window can't move/native-fullscreen) — a follow-up.
- Verify: `npm run typecheck`, `node scripts/test-island-window.mjs` (23 source-asserts), `npm run build`.

## Appendix — windowing reference
- **The PoC** (`/Users/minjunes/superapp/notch-spill-poc`, pure Electron): notch overlay + clip-path spill, proven `coversMenuBar=true`. The recipe to port. Knobs: `NOTCH_W` (hand-tuned until the native read lands), the ease curve.
- **NotchNook teardown** (public AppKit, RE'd from the binary): borderless `NSWindow`, `level = .mainMenu+3`, `collectionBehavior = [.fullScreenAuxiliary,.stationary,.canJoinAllSpaces,.ignoresCycle]`, `canBecomeKey=false`, `hidesOnDeactivate=false`, a `NotchShape` with concave top corners, geometry from `safeAreaInsets`/`auxiliaryTopLeftArea`. Electron's `setAlwaysOnTop('screen-saver')` + `setVisibleOnAllWorkspaces` + `setIgnoreMouseEvents` replicate it (PoC-confirmed).
- **boring.notch** (`.repos/boring.notch`, GPL-3.0, STUDY-ONLY, reimplement clean): the `NotchShape` geometry + the hover-expand spring feel (open response 0.42/damping 0.8, close 0.45/1.0) + the fixed-window-with-animated-content anti-flicker rule.
- **blitzscript** (`plans/blitzos-blitzscript.md`): the `orchestrators` ([Deep]) model the spawn toggle drives.
