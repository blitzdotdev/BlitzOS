/**
 * Wheel → horizontal scroll for the Kanban board.
 *
 * The board is the only horizontally scrolling surface in the app, and a plain
 * mouse wheel only produces `deltaY`. Browsers do not translate that delta for
 * us here, so a wheel over the board gutter or header strip would otherwise do
 * nothing. We remap it — but only when the pointer is *outside* every column.
 *
 * A column under the pointer owns the wheel for the whole event: vertical
 * scrolling stays vertical even after the column hits its top or bottom. That
 * keeps overscroll from yanking the whole board sideways.
 */

/** The board's own horizontal scroll geometry. */
export type BoardWheelViewport = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

/**
 * Sub-pixel slack. Fractional device pixel ratios leave `scrollWidth` a hair
 * above `clientWidth` on surfaces that visually do not scroll; treating that
 * as "can consume" would trap the wheel at the end of the board.
 */
const SCROLL_EPSILON = 1;

const canScrollHorizontally = (board: BoardWheelViewport, delta: number): boolean =>
  delta < 0
    ? board.scrollLeft > SCROLL_EPSILON
    : board.scrollWidth - board.clientWidth - board.scrollLeft > SCROLL_EPSILON;

/**
 * How far to scroll the board horizontally for one wheel event, or `null` to
 * leave the event to the browser.
 *
 * @param insideColumn whether the pointer is over a board column (header,
 *   card list, or the gap between them).
 */
export function resolveBoardWheelScroll(input: {
  deltaX: number;
  deltaY: number;
  insideColumn: boolean;
  board: BoardWheelViewport;
}): number | null {
  const { deltaX, deltaY, insideColumn, board } = input;
  // A horizontal delta (trackpad swipe, shift+wheel on most platforms) is
  // already what the board wants — the browser applies it correctly.
  if (deltaX !== 0) return null;
  if (deltaY === 0) return null;
  if (insideColumn) return null;
  if (!canScrollHorizontally(board, deltaY)) return null;
  return deltaY;
}
