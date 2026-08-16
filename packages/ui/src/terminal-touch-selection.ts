import {
  terminalSelectionRange,
  type TerminalCell,
  type TerminalSelectionAnchor,
} from './terminal-touch.js';

type TerminalGridGeometry = {
  cols: number;
  rows: number;
  bufferLength: number;
  viewportY: number;
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
};

type SelectionPanelGeometry = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

export type TerminalSelectionChipPosition = {
  x: number;
  y: number;
};

export function terminalCellAtPoint(
  clientX: number,
  clientY: number,
  geometry: TerminalGridGeometry,
): TerminalCell | null {
  const { cols, rows, bufferLength, viewportY, rect } = geometry;
  if (
    cols <= 0
    || rows <= 0
    || rect.width <= 0
    || rect.height <= 0
    || clientX < rect.left
    || clientX > rect.right
    || clientY < rect.top
    || clientY > rect.bottom
  ) return null;
  const col = Math.min(
    cols - 1,
    Math.floor((clientX - rect.left) / rect.width * cols),
  );
  const viewportRow = Math.min(
    rows - 1,
    Math.floor((clientY - rect.top) / rect.height * rows),
  );
  return {
    col,
    row: Math.min(bufferLength - 1, viewportY + viewportRow),
  };
}

export function terminalSelectionChipPosition(
  clientX: number,
  clientY: number,
  panel: SelectionPanelGeometry,
): TerminalSelectionChipPosition {
  return {
    x: Math.max(72, Math.min(panel.width - 72, clientX - panel.left)),
    y: Math.max(4, Math.min(panel.height - 38, clientY - panel.top - 42)),
  };
}

export function terminalSelectionContainsCell(
  anchor: TerminalSelectionAnchor,
  extent: TerminalCell,
  cell: TerminalCell,
  cols: number,
): boolean {
  const selection = terminalSelectionRange(anchor, extent, cols);
  if (!selection) return false;
  const start = selection.start.row * cols + selection.start.col;
  const point = cell.row * cols + cell.col;
  return point >= start && point < start + selection.length;
}
