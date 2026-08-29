/**
 * Pure geometry for the conversation outline rail.
 *
 * Kept out of the component so the magnification curve can be unit-tested and
 * so every pixel the rail uses has exactly one source. The rail's track width
 * is derived here rather than written down separately, because the strip is an
 * `overflow-y: auto` box — which the CSS spec makes `overflow-x: auto` too — so
 * a magnified tick wider than the track would start scrolling the rail
 * sideways instead of simply extending.
 */

/** Height of a tick's visible line. */
export const TICK_LINE_HEIGHT = 2;
/** Vertical distance between two ticks' lines. The hit area is this tall. */
export const TICK_PITCH = 8;
/** Resting widths by {@link ConversationOutlineEntry.weight}, lightest first. */
export const TICK_WIDTHS = [10, 13, 16, 20] as const;
/** The active round's bar. Wider than the widest resting tick so it covers it. */
export const ACTIVE_TICK_WIDTH = 24;

/** Length of the tick directly under the pointer, at full magnification. */
const BELL_PEAK_WIDTH = 38;
/** Length the bell decays to — about the middle of the resting range. */
const BELL_BASE_WIDTH = 15;
/**
 * Spread of the falloff, in ticks. 1.8 puts the half-height of the bell at
 * roughly two ticks out, so it reads as one smooth swell rather than a single
 * tick popping out (too narrow) or the whole rail inflating (too wide).
 */
const BELL_SIGMA = 1.8;
/** Past this distance the curve moves a tick under a pixel; stop paying for it. */
const BELL_RADIUS = 4;

/**
 * Normal distribution sampled per tick distance, precomputed at module scope:
 * the curve is fixed, and hovering must not run `Math.exp` once per tick per
 * pointer move.
 */
const BELL_BY_DISTANCE: readonly number[] = Array.from(
  { length: BELL_RADIUS + 1 },
  (_unused, distance) => Math.exp(-(distance * distance) / (2 * BELL_SIGMA * BELL_SIGMA))
);

/**
 * The unit bell, 1 at the cursor and 0 beyond the radius. The `?? 0` also
 * absorbs a non-integer or NaN distance, so no separate finite check is needed.
 */
function bellAt(distance: number): number {
  const absolute = Math.abs(distance);
  if (absolute > BELL_RADIUS) return 0;
  return BELL_BY_DISTANCE[absolute] ?? 0;
}

/** Resting width for a round's weight, clamped to the known buckets. */
export function outlineTickRestingWidth(weight: number): number {
  return TICK_WIDTHS[weight] ?? TICK_WIDTHS[0];
}

/**
 * Width of a tick given its resting width and its distance from the hovered
 * one.
 *
 * The bell is BLENDED IN, not added on. Adding it would keep each tick's
 * weight-driven length underneath, so a heavy neighbour could still outgrow the
 * tick under the cursor — the pointer's own tick has to be the longest, and the
 * run of them has to read as one normal distribution. Blending makes the
 * cursor's tick adopt the bell outright, its neighbours mostly so, and distant
 * ticks keep the resting texture untouched, so the swell melts back into the
 * rail instead of ending on a seam.
 */
export function outlineTickWidth(restingWidth: number, distance: number): number {
  const bell = bellAt(distance);
  if (bell === 0) return restingWidth;
  const target = BELL_BASE_WIDTH + (BELL_PEAK_WIDTH - BELL_BASE_WIDTH) * bell;
  // Weighting the blend by the same bell is what keeps the profile monotonic:
  // the closer a tick is, the more completely it takes the bell's width.
  return restingWidth * (1 - bell) + target * bell;
}

/**
 * Width of the tick at `index` while `hoveredIndex` is under the pointer. A
 * negative `hoveredIndex` means the pointer is off the rail: nothing magnifies.
 */
export function outlineTickWidthAt(
  restingWidth: number,
  index: number,
  hoveredIndex: number
): number {
  if (hoveredIndex < 0) return restingWidth;
  return outlineTickWidth(restingWidth, index - hoveredIndex);
}

/**
 * How far the active round's bar overhangs the tick beneath it, so the bright
 * bar always covers its own dim tick rather than letting a stub peek out.
 */
export const ACTIVE_BAR_OVERHANG = ACTIVE_TICK_WIDTH - Math.max(...TICK_WIDTHS);

/**
 * Width of the widest thing the rail can ever paint, and therefore the track
 * width: a fully magnified tick plus the active bar's overhang.
 */
export const RAIL_TRACK_WIDTH = Math.ceil(BELL_PEAK_WIDTH + ACTIVE_BAR_OVERHANG);

/** Gap between the pane edge and the start of the ticks. */
export const RAIL_TRACK_INSET = 8;

/** Total width the rail reserves, including its inset. */
export const RAIL_WIDTH = RAIL_TRACK_WIDTH + RAIL_TRACK_INSET;

/** Padding above/below the tick column inside the scrollable strip. */
export const RAIL_SCROLL_PADDING = 8;

/**
 * The tallest the tick column may grow, as a share of the conversation pane.
 *
 * A long session has more rounds than any pane has pixels, and letting the
 * column run edge to edge turned the rail into a full-height comb that read as
 * page chrome rather than a margin marker. Capping it keeps the rail a compact
 * object centred beside the conversation; past the cap the strip scrolls
 * internally and keeps the active round in view, which it already had to do for
 * genuinely long sessions anyway.
 */
export const RAIL_MAX_HEIGHT_RATIO = 0.5;

/** Distance from the top of the tick column to a tick's visible line. */
export function tickLineTopOffset(index: number): number {
  return index * TICK_PITCH + (TICK_PITCH - TICK_LINE_HEIGHT) / 2;
}

/**
 * Length of the fade at a scrollable edge of the strip, handed to the shared
 * `buildScrollEdgeFadeMask`.
 *
 * Six ticks' worth. Two was too subtle to read as "there is more here": across
 * so short a run each tick is only slightly dimmer than its neighbour, and on a
 * rail this low-contrast to begin with that difference disappears. A run long
 * enough to see the ticks thin out is what makes the edge say scrollable.
 */
export const RAIL_EDGE_FADE_LENGTH = TICK_PITCH * 6 + RAIL_SCROLL_PADDING;
