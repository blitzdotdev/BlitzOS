# Fix: connector snapshot gets clipped in chat

The frozen connector snapshot (`.isl-msg-tray`, see [blitzos-attachment-snapshot.md](blitzos-attachment-snapshot.md))
shows up cut off at the top in the transcript. Root cause confirmed by a headless repro of the exact CSS chain
(matches the user screenshot pixel-for-pixel). Two independent clip sites, both because the snapshot lives inside
`overflow:auto` boxes with no guard against a top cut.

## Root cause (proven)

**SITE 1 — the feed clips it (the screenshot).** The snapshot is the TOPMOST row of each exchange, rendered as a
separate flex child above the user bubble (`IslandPanel.tsx:731`) inside `.isl-feed` — an `overflow-y:auto` box
(`island.css:1243`) whose panel is capped at `max-height:72vh` (`island.css:35`). The moment the transcript exceeds
the island height (i.e. as soon as the agent replies with any real text), the feed scrolls, and the
auto-scroll-to-bottom effect (`IslandPanel.tsx:279`, fired on the `attachOpen` change when you "come back to chat")
pins the latest content to the bottom. The snapshot, being the top of its exchange, lands at/above the feed's top
edge and is sliced. Repro: feed `content=205 > height=188` → scrolled `16.5px` → tray top sits `9px` above the
visible top → connector cut. With NO scroll the snapshot is fully visible, so the clip is purely overflow-driven.

**SITE 2 — the tray clips itself.** `.isl-msg-tray { max-height:104px; overflow-y:auto }` (`island.css:2208`) hides
the top connector group within a single message once its content passes 104px (3+ connector groups, or a Chrome
pill whose tabs wrap to 3+ rows). A single Messages window (~40px) is under the cap, so this is NOT the screenshot,
but it is the same bug class and must die too.

## The fix (principle: a connector snapshot must never render as a partially-cut floating chip)

**Fix A — SITE 2: make the in-chat snapshot a single short horizontal strip, never a vertical stack.**
- `attachTray.tsx`: add a `strip` mode (used by the read-only in-chat render) that lays ALL groups out in ONE row
  (tab pills + window chips side by side) instead of the column stack.
- `island.css` `.isl-msg-tray`: drop `max-height:104px` + `overflow-y:auto`; the inner row gets `overflow-x:auto`
  (sideways scroll, hidden scrollbar) with a fixed compact height of one 28px tile row. Many connectors scroll
  sideways; nothing is ever cut off the top. This also keeps the snapshot ~1 row tall, which shrinks SITE 1.

**Fix B — SITE 1: bind the snapshot to its message as one scroll unit.**
- `IslandPanel.tsx`: wrap `[snapshot strip, MarkdownMessage]` for a user turn in one `align-self:flex-end` group
  (`.isl-msg-group`) with the strip FLUSH atop the bubble (no gap, shared right edge, a subtle connected look). The
  feed's `gap:8px` then sits BETWEEN turns, not between a snapshot and its own bubble.
- Effect: the snapshot scrolls as part of its message. When a tall exchange overflows, a partial clip at the very
  top edge now reads as "this message is scrolled" (iMessage behavior), not a broken chip floating above a complete
  bubble. The isolated-clipped-chip look is gone.

Honest residual: an exchange taller than the island will still clip at the top edge when pinned to the bottom — that
is inherent to any scroll container and is exactly how iMessage scrolls. Fix B makes it read as normal scrolling;
it does not (and cannot) make a too-tall exchange show its top while pinned to the bottom.

## Files
- `src/renderer/src/notch/attachTray.tsx` — add the single-row `strip` layout for the read-only render.
- `src/renderer/src/notch/island.css` — `.isl-msg-tray`: remove vertical cap/scroll, add horizontal strip + flush
  grouping; add `.isl-msg-group`.
- `src/renderer/src/notch/IslandPanel.tsx` — wrap each user turn's snapshot + bubble in `.isl-msg-group` (the map at
  `:719`). No store/data changes — capture + persistence (sentTrayStore) are untouched.

## Decision needed (your call before I touch the locked island layout)
1. **Strip vs keep stack:** single horizontal scroll strip (recommended — kills SITE 2, minimizes SITE 1) vs keep
   the vertical stack but just remove the cap (simpler, but a many-connector message gets tall and worsens SITE 1).
2. **Snapshot placement:** flush-grouped onto the bubble (recommended) vs a compact inline attachment pill INSIDE
   the bubble (smallest footprint, furthest from any clip, but loses the big glass-pill look the feature shipped).

## Verification
- Re-run the headless CSS repro (`/tmp/clip-repro3.html` pattern) after the change: assert the connector strip is
  `fully visible` (clip `0px`) for a single connector across no-scroll AND scrolled-to-bottom, and that 4+ connectors
  scroll sideways with no top cut.
- Live: drop a connector, send, let the agent reply (force overflow), close attach → confirm no cut chip; screenshot
  for the user to eyeball the grouped look (visual sign-off is theirs).
