# BlitzOS Stage — the slotted desktop (widgets in fixed slots, agent works backstage)

**Status:** design ratified 2026-06-10 (four forks answered, fork 3 corrected against the real macOS recording). **P1+P2 SHIPPED 2026-06-11**, then REVISED same day per user: **no separate backstage zone** — the stage IS the stage; off-stage = the open infinite canvas around it (web/app auto-park below the stage, geometric `isOffstage`, reveal = zoom out / control mode; the Backstage strip + toolbar button were built then deleted as clutter). Shipped: `stage-core.mjs` pure placer (180pt tiles, 8pt card inset, s/m/l/xl/tall, budget) + `place_widget`/`bring_to_stage`/`send_backstage` tools + slot persistence (`stageFields`) + renderer (tile drag = float+outline-ghost+spring-snap, ⌘-drag escape hatch, **window-bar grid toggle ⊞/⤢ + keybinds ⌘T (toggle) / ⇧⌘T (cycle size through s→m→l→tall→xl→xxl)** to snap any window in / pop any tile out with `preSnap` size restore; `xxl` 4×4 added, budget 16 (= one xxl), fluid file layer via `flowFiles`) + chat hub as a pinned `tall` tile + doctrine rewrite. Tests: `scripts/test-stage-core.mjs` (225) + `scripts/test-stage-e2e.mjs` (24). P3 visual tuning (animation vibes) is the user's to confirm in the GUI. Field-fix round (2026-06-11, from screen recordings): minimized/foldered tiles RELEASE their cells (the top-left dead zone) and re-place on restore; free-form windows FLOAT above the tile layer and reserve no cells (z-banded: desktop layer → free windows → focus → pinned) — superseding the earlier free-window blocker model.
**Companions:** `agent-os-desktop-architecture.md` §1/§5 (this supersedes the free-pan canvas as the *human-facing* model; the canvas survives only as invisible substrate), `onboarding-case-file.md` (its `onboarding-board.mjs` 3×3 SLOTS grid is the proto-slot-system this generalizes — the board becomes the first client of the shared placer), `agent-os-window-management.md` (cascade/clamp/z-stack policy dies with free-form).
**UX reference (watched frame-by-frame 2026-06-10):** `~/Desktop/Screen Recording 2026-06-10 at 7.23.04 PM.mov` — the native macOS widget system on this machine. Observed: a dragged widget floats under the cursor; a rounded-rect **outline previews the landing spot**; drop **spring-snaps**; **no other widget ever moves** through the whole clip; desktop **files flow out from under** a landed widget to nearby free icon cells; right-click gives **Small / Medium / Large + Remove Widget + Edit Widgets**. Copy this feel 100%.

## Why

Free-form x/y/w/h is the AI's single biggest spatial failure class: pixel stipulation it routinely gets wrong, overlap, and unbounded attention fragmentation (10 raw tabs dumped in your face). Remove the complexity entirely:

1. Agents choose **WHERE (a slot)**, never WHERE EXACTLY (pixels), with a hard non-overlap guarantee.
2. Agents do their work **off-screen by default** (scrolling 10 sites for leads cannot reasonably fit a desktop), and put on the human's desktop only distilled, interactive widgets (a triage queue), pulling in just enough surfaces when the human wants to collaborate.

## The model — two zones, four layers

**Stage** = what the human sees. A fixed, bounded desktop. No pan, no zoom (desert-fog and the view-lock workaround die together).

- **L0 wallpaper.**
- **L1 file layer** (phase 2): file/folder/note tiles on a fine icon grid. FLUID: they flow out of a widget's footprint like displaced liquid and settle in the nearest free cells. Files never sit under a widget; files never displace a widget.
- **L2 widget layer:** widgets in fixed, predetermined, non-overlappable slots. **NEVER reflows.** Nothing the system or the agent does ever moves a placed widget. Relocation happens only by (a) a direct human drag (macOS feel: float + outline preview + spring snap) or (b) an explicit agent move INTO A FREE SLOT.
- **L3 focus layer:** the single free-form exception. A human-pulled live page floats above the grid as a dismissable focus window. Human-initiated only.

**Backstage** = where the agent works. Invisible. **A pool, not a place** — surfaces there have no geometry at all. The 10 scraped sites, the long-running web drives, the staging panels all live here. Reached by an explicit "show the work" gesture (Exposé-style peek that reveals Backstage as a scrollable strip, with promote-to-Stage affordances).

## Ratified forks (2026-06-10)

1. **View:** slotted desktop, canvas hidden. Backstage off-screen, reached only by the show-work gesture.
2. **Slot citizens:** ANY surface kind may occupy a slot (web/app framed to slot size) — but see guardrails: web/app are *born backstage*, and budget + doctrine keep raw tabs off the Stage.
3. **Move feel (CORRECTED from the video; overrides the earlier auto-reflow pick):** widgets never reflow, period. Drag = float + outline preview at the nearest valid free position + spring snap. Files/folders are the fluid layer that moves out of the way (phase 2). Right-click on a widget: size picker (S/M/L) + Remove.
4. **Pull-in:** a live page the human pulls in appears as a free-form floating focus window (L3), not a tile.

## Apple's actual placement model (REVERSE-ENGINEERED 2026-06-10, definitive — spike 1 RESOLVED)

Recovered from this machine right after the reference video was recorded. The desktop widget layout is written by the NotificationCenter process (the desktop-widget renderer) to its sandbox container:
`~/Library/Containers/com.apple.notificationcenterui/Data/Library/Preferences/com.apple.notificationcenterui.plist`, key `widgets.DesktopWidgetPlacementStorage` (a nested bplist). The widget metrics come from chronod's store (`~/Library/Group Containers/group.com.apple.chronod/chronod/chrono.sql`, `HostConfigs` blob, classes `CHSWidgetConfiguration` / `CHSWidgetMetrics`).

**The data model (decoded verbatim from this Mac):**

```
NumberedDisplays[ {Number, Resolutions[ {Size:{1512,949}, Groups[
  { Origin:{135,127}, Items[
      {Identifier:<uuid>, Column:0, Row:1, Size:{Medium}, ZOrder:2},   // News
      {Identifier:<uuid>, Column:1, Row:0, Size:{Small},  ZOrder:3},   // Coinbase
      {Identifier:<uuid>, Column:2, Row:1, Size:{Large},  ZOrder:5},   // Photos
      {Identifier:<uuid>, Column:3, Row:3, Size:{Small},  ZOrder:0} ]},// ChatGPT
  { Origin:{758,72}, Items[
      {.. Column:0, Row:0, Small ..},                                  // Clock
      {.. Column:1, Row:0, Small ..} ]}                                // Copilot
]} ]} ]
```

**There are NO per-widget pixel positions.** The model is:

1. **Groups (islands), each with one pixel Origin.** Widgets inside a group sit at **integer Column/Row** cells. Dragging near an existing group snaps to the nearest free cell span IN that group (that is the outline preview); dropping far from every group starts a new group whose Origin is the drop point. That is why widgets align perfectly to neighbors yet clusters can live anywhere.
2. **Exact metrics, corrected implementation model (CHSWidgetMetrics + live CGWindowList cross-check):** the real unit is an **edge-to-edge 180pt tile** (widget *windows*: S 180×180, M 360×180, L 360×360, XL predicted 720×360) and the **visible card is the tile inset 8pt per side** (visible: 164×164 / 344×164 / 344×344 / 704×344, so the visible gap between neighbors is 16pt). Verified exactly on all six live windows: `global = (Origin.x + Column·180, menuBar(≈33) + Origin.y + Row·180)`. Content margins **18pt** inside the card; corner radius **27.88pt stored** (CHS), measured ≈30pt **continuous squircle** on current OS. Spans: S=1×1, M=2×1, L=2×2, XL=4×2 tiles. Build the clone on 180-tiles + 8pt inset, not on 164-cards + 16-gutters (same arithmetic, cleaner hit/drag frames).
3. **The grid is sparse** (ChatGPT sits at col 3 row 3 with empty cells between); occupied spans are simply invalid drop candidates, which is the whole never-reflow guarantee.
4. **Per display AND per resolution**: each display size remembers its own Groups (resize = a different `Resolutions` entry, no live reflow). Screen-edge margins are NOT enforced; group Origins are arbitrary floats.
5. **ZOrder is a global insertion-order counter** across groups (ordering, not stacking; widgets can never overlap).
6. Desktop **icons are a separate Finder system** that flows around widget frames (Finder defaults: `gridSpacing` 54, `iconSize` 64 are the starting knobs); widgets never store icon data.
7. **⌘-drag opts out of snapping entirely** (drop anywhere = force a new free group). The human free-form escape hatch is built into Apple's model.
8. Implementation hint: a hidden `onscreen:false`, lattice-aligned widget-sized window rides along during drags — the outline ghost is a real pre-positioned window, not a drawn overlay (speculative but observed).

**What BlitzOS adopts:** the 180pt-tile + 8pt-card-inset model (S/M/L/XL spans) scaled to our unit; the sparse-grid + invalid-occupied-span placer; outline-preview snap semantics; ⌘-drag as the future free-island escape hatch. **Simplification for the agent:** v1 models the Stage as ONE group whose Origin is the stage margin (a single fixed lattice, which is exactly what the agent API needs); human-dragged free islands (multiple Groups) are a later, purely-renderer-side addition that the same data model already supports.

**Build-vs-borrow (researched):** NO existing library implements the islands model — we will be first. Explicitly do NOT use `react-grid-layout`: it is the wrong model (it pushes/compacts neighbors, the exact behavior this design forbids); its placeholder-preview pattern is the only reusable idea. Best animation reference for grid feel: `JotaMelo/jSpringBoard` (iOS-10 SpringBoard reproduction). Behavior corroboration: MacStories Sonoma review + Six Colors ("Apple's just making it easy for adjacent widgets to look properly aligned" — i.e. islands, not a global grid).

## Slot system

- Tile = **180×180 logical pt, edge-to-edge** (Apple's real model): the visible card is the tile **inset 8pt per side** (164×164 visible, 16pt visible gap), 18pt content margins, radius 27.88 stored / ≈30 measured squircle. Sizes: **S=1×1, M=2×1, L=2×2, XL=4×2** tiles.
- A widget occupies a span of cells; **the placer only ever returns spans whose every cell is free**. Non-overlap is enforced by the placer, not by policy. The grid may stay sparse (Apple's does).
- **Stage budget:** a soft cap (~8 S-equivalents, tune in spike 6) below the hard capacity. Past budget, placement returns `stage_full` + current occupants; the agent must evict explicitly or queue. It cannot overflow attention even with a bad policy.
- **Per-window-size layouts** like Apple: each window size remembers its own arrangement; no live reflow on resize (spike 4 reduces to remembering layouts per size bucket).

## Agent API (the guardrails)

- `place_widget { id|spec, size: s|m|l|xl, near?: <edge|widget-id>, priority? }` → `{slot}` or `{stage_full, occupants[]}`. **No x/y/w/h anywhere in the agent surface.**
- `create_surface`: web/app are **born Backstage, always**. srcdoc/native also default Backstage unless placed via `place_widget`.
- `bring_to_stage(id, size)` / `send_backstage(id)` — promotion/demotion are deliberate named verbs. `evict` is explicit, never implicit.
- `list_state` gains `stage {grid, free_cells, occupants, budget}` + `backstage []` so the agent reasons in slots, not pixels.
- Raw web in a slot is allowed (fork 2) but doctrine-default is ONE synthesized widget over N raw tabs; if testing shows tab-dumping, add the soft cap (max 1 raw web tile) — explicitly deferred, not silently decided.

## Doctrine (blitzos-agents.md rewrite, summarized)

- **Work Backstage; present on Stage.** Research, scraping, drafting happen off-screen.
- The Stage is the human's attention budget. One widget that lets the human ACT (triage, approve, pick) beats N raw surfaces.
- Pull a live site on-Stage only when the human asks, or will act on it right now.

## What dies / what survives

- **Dies (human-facing):** pan/zoom, the view lock + double-tap-⌘, marquee-on-lock, PrimarySpace marker, camera persistence as UX, `go_to_primary` (becomes focus-Stage no-op), all cascade/clamp window policy.
- **Survives:** workspaces (each = its own Stage + Backstage), all four surface kinds, the watched-folder-IS-the-canvas pipeline (files materialize into the L1 file layer), the chat hub (a permanently staged widget), perception/moments untouched.
- **Onboarding:** `onboarding-board.mjs` stops emitting world coords; each role maps to size+priority and the shared placer lays the board out. Same cards, no bespoke geometry.

## Phasing

- **P1 — the lattice.** Pure placer module (shared-core style, both transports) + `place_widget` + Stage/Backstage split + `list_state` slots + doctrine rewrite. Files render statically in the L1 grid (no displacement yet). Widgets-on-Stage by default for srcdoc/native via placer; web/app born Backstage.
- **P2 — the feel.** macOS drag (float, outline preview, spring snap), fluid file displacement, the focus window, the Backstage reveal gesture, right-click size/remove.
- **P3 — polish + tuning.** Budget number, raw-web cap decision, multi-display, promotion UX from the Backstage strip.

## Open spikes

1. ~~Exact macOS metrics~~ **RESOLVED** (see "Apple's actual placement model": 180pt tiles + 8pt card inset, r≈30 squircle, spans S/M/L/XL = 1×1/2×1/2×2/4×2, sparse grid, per-resolution layouts, ⌘-drag opt-out). Remaining slivers, with defaults to start from: snap-engagement threshold is unmeasured anywhere (start at **~90pt = half a tile** from a candidate span; matches reviewer descriptions), snap spring = WWDC23 `snappy` (response ~0.35–0.5s, damping ~0.85), icon-reflow spring = `smooth`. Manual 5-minute experiments still owed: group merge/split rules (when does dropping between two groups merge them), whether icons RETURN to their cells after a widget moves away, and the gallery's auto-placement policy (click-+ vs drag).
2. File-displacement physics: nearest-free-cell settle, animation (Finder owns this on macOS; ours is custom).
3. Focus-window rules: how many at once, does it dim the Stage, dismiss gesture.
4. ~~Resize/multi-display remap~~ reduced by the Apple model: remember a layout per window-size bucket (their `Resolutions[]`), no live reflow. Decide bucket granularity.
5. Backstage reveal: strip vs Mission-Control grid; promote affordance.
6. Budget default (start 8 S-equivalents).
7. Web-in-slot interaction model: click-through vs activate-first.

## Test plan (`scripts/test-*.mjs`, headless)

- `test-slot-placer.mjs`: pure placer — non-overlap invariant under fuzz, `stage_full` behavior, size fitting, deterministic assignment, resize remap.
- Parity: Electron + server bind the same placer; identical assignments for identical inputs.
- Doctrine: drive via control API; assert web `create_surface` lands Backstage and `place_widget` refuses occupied cells.
