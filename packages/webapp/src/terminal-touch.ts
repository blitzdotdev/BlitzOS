export const TERMINAL_KEYBOARD_EVENT = 'blitz-terminal-keyboard';
export const TERMINAL_PASTE_EVENT = 'blitz-terminal-paste';

// Founder-review heuristic: the TUI input box is approximated as the terminal's
// bottom four rendered grid rows until the terminal protocol exposes prompt bounds.
export const MOBILE_PROMPT_REGION_ROWS = 4;

export type TerminalTouchWheelLines = {
  lines: number;
  remainder: number;
};

export type TerminalCell = {
  col: number;
  row: number;
};

export type TerminalWordBoundary = {
  start: number;
  length: number;
};

export type TerminalTextCell = {
  chars: string;
  width: number;
};

export type TerminalSelectionAnchor = {
  start: TerminalCell;
  end: TerminalCell;
};

export type TerminalSelectionRange = {
  start: TerminalCell;
  length: number;
};

export const TERMINAL_TOUCH_LONG_PRESS_MS = 500;
export const TERMINAL_TOUCH_MOVE_THRESHOLD_PX = 6;

// Keep touch word selection aligned with xterm's default word separators.
export const TERMINAL_WORD_SEPARATORS = ' ()[]{}\',"`\t';

export function isTouchInputDevice(): boolean {
  return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
}

export function isTerminalPromptTouch(
  clientY: number,
  screen: Pick<DOMRect, 'top' | 'bottom' | 'height'>,
  terminalRows: number,
): boolean {
  if (terminalRows <= 0 || screen.height <= 0 || clientY < screen.top || clientY > screen.bottom) {
    return false;
  }
  const rowHeight = screen.height / terminalRows;
  return clientY >= screen.bottom - rowHeight * MOBILE_PROMPT_REGION_ROWS;
}

export function accumulateTerminalTouchWheelLines(
  deltaY: number,
  rowHeight: number,
  remainder: number,
): TerminalTouchWheelLines {
  if (
    !Number.isFinite(deltaY)
    || !Number.isFinite(rowHeight)
    || rowHeight <= 0
    || !Number.isFinite(remainder)
  ) {
    return { lines: 0, remainder: 0 };
  }
  const total = remainder + deltaY / rowHeight;
  const lines = Math.trunc(total) || 0;
  return { lines, remainder: total - lines };
}

function isTerminalWordCell(cell: TerminalTextCell, separators: string): boolean {
  return cell.width === 0 || (cell.chars.length > 0 && !separators.includes(cell.chars));
}

export function terminalWordBoundary(
  cells: readonly TerminalTextCell[],
  column: number,
  separators = TERMINAL_WORD_SEPARATORS,
): TerminalWordBoundary | null {
  if (!Number.isInteger(column) || column < 0 || column >= cells.length) return null;

  let touched = column;
  while (touched > 0 && cells[touched]?.width === 0) touched -= 1;
  if (!isTerminalWordCell(cells[touched] ?? { chars: '', width: 1 }, separators)) return null;

  let start = touched;
  while (start > 0 && isTerminalWordCell(cells[start - 1]!, separators)) start -= 1;
  let end = touched + 1;
  while (end < cells.length && isTerminalWordCell(cells[end]!, separators)) end += 1;
  return { start, length: end - start };
}

function cellIndex(cell: TerminalCell, cols: number): number {
  return cell.row * cols + cell.col;
}

function cellAt(index: number, cols: number): TerminalCell {
  return { col: index % cols, row: Math.floor(index / cols) };
}

export function terminalSelectionRange(
  anchor: TerminalSelectionAnchor,
  extent: TerminalCell,
  cols: number,
): TerminalSelectionRange | null {
  if (!Number.isInteger(cols) || cols <= 0) return null;
  const anchorStart = cellIndex(anchor.start, cols);
  const anchorEnd = cellIndex(anchor.end, cols);
  const extentIndex = cellIndex(extent, cols);
  if (
    anchorStart < 0
    || anchorEnd < anchorStart
    || extentIndex < 0
    || anchor.start.col < 0
    || anchor.start.col >= cols
    || anchor.end.col < 0
    || anchor.end.col >= cols
    || extent.col < 0
    || extent.col >= cols
  ) return null;

  const startIndex = extentIndex < anchorStart ? extentIndex : anchorStart;
  const endIndex = extentIndex > anchorEnd ? extentIndex : anchorEnd;
  return { start: cellAt(startIndex, cols), length: endIndex - startIndex + 1 };
}
