# BlitzOS Stage — the slotted desktop (widgets in fixed slots, agent works backstage)

**Status:** design ratified 2026-06-10 in session (four forks answered, then fork 3 corrected against the real macOS recording). No code yet — this doc is the contract.
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

## Slot system

- Unit cell **U** derived from window size (the macOS small-widget square, ≈150px + gutter; exact metrics = spike 1). Sizes: **S=1×1U, M=2×1U, L=2×2U, XL=3×2U** (focus tile).
- A widget of size W×H occupies a rectangle of cells; **the placer only ever returns positions where every covered cell is free**. Non-overlap is enforced by the placer, not by policy.
- **Stage budget:** a soft cap (~8 S-equivalents, tune in spike 6) below the hard capacity. Past budget, placement returns `stage_full` + current occupants; the agent must evict explicitly or queue. It cannot overflow attention even with a bad policy.
- Slots remap on window resize by relative anchor (spike 4).

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

1. Exact macOS metrics: cell size, gutters, snap animation timing, outline style (measure from the recording).
2. File-displacement physics: nearest-free-cell settle, animation.
3. Focus-window rules: how many at once, does it dim the Stage, dismiss gesture.
4. Resize/multi-display slot remapping.
5. Backstage reveal: strip vs Mission-Control grid; promote affordance.
6. Budget default (start 8 S-equivalents).
7. Web-in-slot interaction model: click-through vs activate-first.

## Test plan (`scripts/test-*.mjs`, headless)

- `test-slot-placer.mjs`: pure placer — non-overlap invariant under fuzz, `stage_full` behavior, size fitting, deterministic assignment, resize remap.
- Parity: Electron + server bind the same placer; identical assignments for identical inputs.
- Doctrine: drive via control API; assert web `create_surface` lands Backstage and `place_widget` refuses occupied cells.
