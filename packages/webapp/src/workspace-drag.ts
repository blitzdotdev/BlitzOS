import type { WorkspaceRegion } from './storage';

/** IntelliJ's `ide.tabbedPane.dragToSplitRatio`: the outer fifth of a pane on
 * either side splits, the inner three fifths insert as a tab. There is no
 * top/bottom band — panes here are side-by-side columns, and a half-height
 * hint would promise a layout the drop handler cannot produce. */
export const SPLIT_RATIO = 0.2;

export type DropSide = 'left' | 'right' | null;

export type PaneDropTarget =
  | { kind: 'tab'; region: WorkspaceRegion; beforeId: number | null }
  | { kind: 'split'; region: WorkspaceRegion };

export type TabCellBox = {
  id: number;
  left: number;
  width: number;
};

export function dropSideFor(
  rect: { left: number; width: number },
  clientX: number,
): DropSide {
  if (rect.width <= 0) return null;
  const fraction = (clientX - rect.left) / rect.width;
  if (fraction <= SPLIT_RATIO) return 'left';
  if (1 - fraction <= SPLIT_RATIO) return 'right';
  return null;
}

/** The tab the insertion bar sits in front of: the first cell whose midpoint
 * the pointer has not passed. `null` means "after the last tab". */
export function insertionBeforeId(
  cells: readonly TabCellBox[],
  clientX: number,
  draggedId: number,
): number | null {
  const target = cells.find(
    (cell) => cell.id !== draggedId && clientX < cell.left + cell.width / 2,
  );
  return target?.id ?? null;
}

/** Panes render left to right, so an edge drop always names the column it
 * points at: the left band is the main pane, the right band is the side pane.
 * The landing rectangle is drawn from the same answer, so the hint and the
 * drop can never disagree. */
export function paneDropTarget(
  region: WorkspaceRegion,
  side: DropSide,
  cells: readonly TabCellBox[],
  clientX: number,
  draggedId: number,
): PaneDropTarget {
  if (side === 'left') return { kind: 'split', region: 'main' };
  if (side === 'right') return { kind: 'split', region: 'side' };
  return { kind: 'tab', region, beforeId: insertionBeforeId(cells, clientX, draggedId) };
}

export type Box = { left: number; top: number; width: number; height: number };

/** Geometry of the translucent landing rectangle, relative to the pane
 * container. `existing` is the column the tab will land in when that column is
 * already on screen; a split that has to create a column claims the half of
 * the container on its own side. Every rectangle runs the full height below
 * the tab strips — only the width it claims changes. */
export function landingBox(
  target: PaneDropTarget,
  container: Box,
  existing: Box | null,
  bodyTop: number,
): Box {
  const top = bodyTop - container.top;
  const height = container.top + container.height - bodyTop;
  if (existing !== null) {
    return { left: existing.left - container.left, top, width: existing.width, height };
  }
  const half = container.width / 2;
  return {
    left: target.kind === 'split' && target.region === 'side' ? half : 0,
    top,
    width: half,
    height,
  };
}
