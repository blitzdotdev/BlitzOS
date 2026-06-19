# BlitzOS Dynamic Island — next phase (exploration spec)

Status: SPEC / EXPLORE (2026-06-18). Follows the MERGE (`plans/blitzos-dynamic-island.md`): the real BlitzOS UI window IS the notch (sandwich overlay + `#root-canvas` clip-grow). That shipped closed/hover/open + butter grow + black canvas. This doc is the NEXT phase: 5 features that each need real exploration before code. Do NOT jump to implementation. For each: audit what exists, study the named reference, PROTOTYPE to narrow the search space, then execute. Prototype in `/Users/minjunes/superapp/notch-spill-poc` (cheap, no BlitzOS risk) or behind a flag.

## Where we are (built, in code)
- `sandwich.ts` overlay mode: one frameless transparent full-display window, not parented, `setInteractive` toggles click-through.
- `App.tsx` notch state machine: `'closed' | 'panel' | 'open'`; `notchClipFor` (inset reveals); notch handle + entry DOM inside `#root-canvas`; hover hit-test; fade-to-black (`notchOpening`); GPU-texture lag fix; canvas hidden until `.notch-open`.
- `index.ts` notch IPC: `os:notch-interactive` / `os:notch-send` (Deep ON workflow / OFF agent) / `os:notch-geometry` / ⌥Space → `os:notch-toggle`. Bridge = `agentOS.notch` (preload).
- Grounding for below: agent status = `agentStatus` / `chatStatusSnapshot` / `CHAT_STATUSES` (mapped once in index.ts `islandStatusToState`). Sessions = agent `'0'` (primary) + `spawnAgent` peers (terminal-manager). Gestures = the capture-phase wheel handler in App.tsx already classifies deltaX vs deltaY (burst-aware). Native notch width = `NSScreen.safeAreaInsets` / `auxiliaryTopLeftArea` (still unread; `NOTCH_W` is hand-tuned).

## The state model this phase introduces (the spine)
Today hover and ⌥Space both land on ONE "panel". This phase SPLITS presentations, mirroring Apple Dynamic Island (minimal / compact / expanded + Live Activities) — study that first.
- **retracted** = just the notch, now with L/R status rails (item 1). The resting glanceable state.
- **overview** (hover) = a live surface of arbitrary BlitzOS widgets, a glance at what is running (item 4).
- **new-session** (⌥Space) = the "start something" widget (items 2, 3). Deliberate, not a hover.
- **entered** (⌥Space-Space, or click) = fullscreen real canvas (already built as `open`).
- Cross-cutting: swipe to switch agent-session tabs from overview or new-session (item 5).
Open question to settle FIRST: is this 4 discrete states or one continuous openness with stops? Prototype both feels before committing the state machine.

## Item 1 — Notch status rails (retracted state)
Goal: pad left and right of the physical notch with macOS-menu-bar-style status icons (e.g. "2 agents working", a live pulse).
- Have: full-display overlay already spans the menu-bar band; `agentStatus` gives live per-agent state.
- Unknowns: exact physical-notch geometry (need the native `safeAreaInsets`/`auxiliaryTopLeftArea` read, ~10 lines, currently faked by `NOTCH_W`); the status-icon vocabulary + how many fit; click behavior of an icon.
- Refs: macOS menu bar, NotchNook / iStat Menus notch rails, Apple Live Activities "minimal" leading/trailing.
- Prototype: static L/R rails with mock icons at the tuned notch width, THEN wire one real signal (agents-working count from `agentStatus`).

## Item 2 — ⌥Space opens new-session; ⌥Space-Space enters
Goal: tap ⌥Space → the new-session widget pops (does NOT enter). With Option still held, a second Space → enter BlitzOS.
- Have: ⌥Space is a `globalShortcut` → `os:notch-toggle` (today it toggles open/closed).
- Unknowns (the hard part): `globalShortcut` fires once per chord and cannot see "Option still held" or a double-tap. Detecting hold-Option + Space-Space needs either a timing window after the first fire (second `globalShortcut` within Nms = enter) or a native key tap (`iohook`-style) to read the modifier-held state. The hold-modifier-tap-to-advance pattern is exactly macOS ⌘Tab. Research which is robust without a focus-stealing key monitor.
- Refs: Raycast / Spotlight launch chord, macOS ⌘Tab hold-and-tab, the retired `launcher.ts` chord handling.
- Prototype: in the PoC, prove first-tap-vs-second-tap timing with `globalShortcut` alone; fall back to a minimal native modifier read only if timing is unreliable.

## Item 3 — Improve the new-session widget
Goal: the ⌥Space widget is a real "new BlitzOS session" surface, not just a one-line prompt.
- Have: textarea + Deep toggle + Send (`os:notch-send`).
- Unknowns: what it should contain. Candidates: recent sessions to resume, context attachments (reuse the launcher's drag-drop file/folder/tab work), agent/model pick, Deep on/off, templates. Needs a content study, not a guess.
- Refs: Raycast root, ChatGPT/Claude new-chat entry, the earlier Blitz-bar launcher work (drag-drop attachments).
- Prototype: 2-3 static layouts (minimal vs rich) to choose the content set before wiring.

## Item 4 — Hover = overview surface (arbitrary widgets)
Goal: hovering the island shows arbitrary BlitzOS widgets, the island as a SURFACE host (the crown-jewel direction: agent-composed, live, expressive). A glance at the running session.
- Have: the merge already proves the island is the real canvas; surfaces are `srcdoc`/`native`/`app`.
- Unknowns: what the overview shows by default (running agents, recent activity, a live agent-viz widget?); is it a fixed HUD or a mini-canvas; how it is authored (reuse the widget model vs a bespoke overview). Tie to the agent-visualization research track (its own doc when it grows).
- Refs: Apple Dynamic Island expanded / Live Activities, `plans/blitzos-dynamic-island.md` "island IS a surface host", the crown-jewel memory.
- Prototype: render ONE live widget (agents summary from `agentStatus`) in the hover panel; judge whether arbitrary surfaces belong here before generalizing.

## Item 5 — Swipe to switch agent-session tabs
Goal: from overview or new-session, a trackpad finger-swipe switches between agent-session tabs (primary `'0'` + spawned peers).
- Have: the capture-phase wheel handler already separates horizontal (deltaX) bursts from vertical; `agentStatus` enumerates sessions.
- Unknowns: how sessions are presented as switchable "tabs" (a carousel of session cards?); making the island own a horizontal-swipe gesture without stealing the canvas pan; what "switch" changes (the focused agent the entry talks to, and the entered canvas).
- Refs: iOS app-switcher swipe, the existing App.tsx burst-gesture capture, terminal-manager session list.
- Prototype: a card carousel in the hover panel driven by mock deltaX, then bind to the real session list.

## Native-look reference (researched 2026-06-18 — Apple HIG + mac notch apps)
Make every state read as a real Dynamic Island. Sources: Apple HIG Live Activities, UIUX Trend / Infinum spec breakdowns, boring.notch / NotchNook.
- **Color:** pure `#000`, to blend into the physical notch + bezel (we already paint the canvas `#000`). Keep it.
- **Shape:** native pill corner radius ≈ **40px, all four corners**. The mac-NOTCH variant adds **concave top fillets** that tuck under the bezel + a rounded bottom (boring.notch `NotchShape`; our retired `island.ts` `notchPath` had this). We currently use `inset()` (bottom-only ~16-28px, square top) because it is butter; that is the trade-off. DECISION/prototype: can we get the concave native shape AND stay smooth (e.g. a pre-rasterized SVG mask, now that content is hidden-at-rest so there is less to re-clip)? At minimum push the bottom radius toward the native ~28-40px feel.
- **Sizes (points):** compact/resting height ≈ **36** (our notch = `menuBarH` ~37, good); icons **24**; text **15** / line-height 22; expanded **max 144** tall (truncates past ~160). Use these for the rails (item 1) and overview/new-session content density.
- **States map cleanly onto our items:** *minimal* (tiny dot, 2+ activities) → rails idle; *compact leading/trailing* (two views split around the camera that read as ONE) → item 1 L/R status rails; *expanded* with leading/trailing/center/bottom regions → item 4 overview + item 3 new-session layout.
- **Motion:** native morph is a **spring** (low stiffness, damping ~0.6) with a fluid/metaball merge, run on the compositor thread (transforms/scale, no main-thread layout). Ours is `cubic-bezier(0.22,1,0.36,1) 0.42s` ease-out (no overshoot). Prototype a slightly springy curve (small overshoot) that STAYS butter (keep the GPU-texture approach). Don't chase the literal metaball blob; the clip-grow reads fine if the timing is springy.
- **Content rule:** leading + trailing must read as one piece of info; never put detailed visuals in the compact/rail state (unreadable at 36px).

## How to attack (do not skip)
1. Settle the state model (discrete vs continuous) with a feel prototype, since items 1-5 all hang off it.
2. Land the native notch-width read (unblocks item 1 and exact alignment everywhere).
3. Then items in this order by dependency + risk: 1 (rails) → 4 (overview surface) → 3 (new-session content) → 2 (chord) → 5 (swipe). Each: prototype, narrow, then execute behind the existing `notchGated` path with the `BLITZ_NO_NOTCH_GATE` escape hatch.
4. Verify each in `scripts/test-island-window.mjs` + the GUI (the human owns the visual sign-off; the build is headless-blind).

## Decisions needing sign-off
- State model: 4 discrete states vs one continuous openness with stops.
- ⌥Space-Space mechanism: timing-window `globalShortcut` vs a native modifier read.
- New-session widget content set.
- Whether overview hosts arbitrary surfaces or a fixed agent-glance widget first.
